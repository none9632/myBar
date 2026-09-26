import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import {
  createBinding,
  createComputed,
  createState,
  For,
  onCleanup,
  type Accessor,
  type Setter,
} from "gnim"
import GLib from "gi://GLib"
import Gtk4LayerShell from "gi://Gtk4LayerShell?version=1.0"
import Hyprland from "gi://AstalHyprland?version=0.1"

// Workspace switch indicator: an accent square that slides behind the active
// workspace as a full background fill. GTK4 CSS has no transforms, so the slide
// is driven here — we tween the fill's margin-start + width on the frame clock
// toward the active button's measured bounds (works for any button width).
//
// Easing matches Hyprland's workspace animation: bezier "macos"
// (cubic-bezier(0.25, 1.0, 0.5, 1.0)) at speed 5 → 500ms (Hyprland's speed unit
// is 100ms).
const WS_ANIM_MS = 500

// Workspaces come and go — an empty one is destroyed as you leave it, a new one
// is created as you switch into it — so chips fade and grow their slot open or
// shut instead of popping in and out. They run on the fill's own duration and
// curve, from the same moment, so a chip moves as the fill travels rather than
// after it.
const WS_CHIP_MS = WS_ANIM_MS

// CSS-style cubic-bezier easing with P0=(0,0), P3=(1,1). Given the time fraction
// x, solve for the curve parameter (Newton, then bisection) and return y.
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    let t = x
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x
      if (Math.abs(dx) < 1e-5) return sampleY(t)
      const d = slopeX(t)
      if (Math.abs(d) < 1e-6) break
      t -= dx / d
    }
    let lo = 0
    let hi = 1
    t = x
    for (let i = 0; i < 24; i++) {
      const dx = sampleX(t) - x
      if (Math.abs(dx) < 1e-5) break
      if (dx > 0) hi = t
      else lo = t
      t = (lo + hi) / 2
    }
    return sampleY(t)
  }
}
const easeMacos = cubicBezier(0.25, 1.0, 0.5, 1.0)

// Hyprland 0.55 moved the config — and the IPC — to Lua: `dispatch <payload>`
// is evaluated as `hl.dispatch(<payload>)`, so the old string dispatchers
// ("workspace 3", "focuswindow address:…") are now Lua syntax errors that fail
// silently apart from a line in the log. Astal's `client.dispatch()` still
// builds that old form, so this sends a raw message carrying a Lua expression
// instead. The dispatcher API is `hl.dsp.*` — see
// /usr/share/hypr/stubs/hl.meta.lua, and config/hypr/hyprland.lua in
// mydotfiles for examples.
//
// The null callback is required: this binding is not promisified, so calling it
// with one argument throws. Nothing here needs the reply — hyprland reports
// "error: …" in-band anyway.
const dispatch = (hypr: Hyprland.Hyprland, lua: string) =>
  hypr.message_async(`dispatch ${lua}`, null)

// Per-chip animation handles. The real row and its lit copy bind the very same
// accessors, so the two can never measure differently while a chip animates.
type ChipAnim = {
  width: Accessor<number> // -1 = natural
  setWidth: Setter<number>
  opacity: Accessor<number>
  setOpacity: Setter<number>
  // While a chip animates in or out its size is driven from here, so the css
  // minimum has to step aside.
  sizing: Accessor<boolean>
  setSizing: Setter<boolean>
  // A chip that took over another chip's slot draws the outgoing number on top
  // of its own and hands over to it. `swap` is that number; the two numbers
  // trade opacity *and* slide past each other in the direction of the switch, so
  // the handover carries the same sense of travel as the fill does when it moves
  // between chips. Outside a swap `self` is 1 at centre and `swap` is null.
  swap: Accessor<number | null>
  setSwap: Setter<number | null>
  selfOpacity: Accessor<number>
  setSelfOpacity: Setter<number>
  swapOpacity: Accessor<number>
  setSwapOpacity: Setter<number>
  // GTK4 css has no transforms, and a margin cannot go negative — but a label's
  // xalign slides its text across the whole width it is given, which is the chip,
  // and costs nothing. 0 = hard left, 0.5 = centred, 1 = hard right.
  selfAlign: Accessor<number>
  setSelfAlign: Setter<number>
  swapAlign: Accessor<number>
  setSwapAlign: Setter<number>
}

// The number on a chip. It sits in the *overlay* slot of an overlay whose main
// child is empty, and gtk does not measure overlay children — so the chip is
// sized by its css alone and the digit never pins it open. That is what lets
// the slot be animated shut with the number still on screen, fading, instead of
// having to yank the number out first (the button clips it, see `overflow`).
//
// The outgoing number of a swap is a second overlay child, so it sits exactly on
// top of this one and the two simply trade opacity — no reflow, nothing beside
// the chip, just the digit changing.
function ChipNumber({ id, anim }: { id: number; anim: ChipAnim }) {
  return (
    <overlay>
      <box />
      <label $type="overlay" label={`${id}`} opacity={anim.selfOpacity} xalign={anim.selfAlign} />
      <label
        $type="overlay"
        label={anim.swap.as((from) => (from == null ? "" : `${from}`))}
        opacity={anim.swapOpacity}
        xalign={anim.swapAlign}
      />
    </overlay>
  )
}

function Workspaces() {
  const hypr = Hyprland.get_default()
  if (!hypr) return <box cssName="workspaces" />

  // Ids, not astal's Workspace objects: those get recycled. Destroying an empty
  // workspace and creating another hands the same object back under the new id,
  // so a chip outliving its workspace would quietly renumber itself — and
  // collide with the key of the workspace that took the number (leaving 5 for a
  // fresh 6 briefly showed two 6s). A plain number cannot do that.
  const liveIds = createBinding(hypr, "workspaces").as((wss) =>
    [...new Set([...wss].map((ws) => ws.id).filter((id) => id > 0))].sort((a, b) => a - b),
  )
  const focusedId = createBinding(hypr, "focusedWorkspace").as((fw) => fw?.id)

  // What the row actually shows: hyprland's list plus any chip still playing its
  // exit. Driving the rows off this instead of off hyprland directly is also
  // what keeps the fill's origin alive — the chip it sits on outlives the
  // workspace just long enough for the slide to start from it.
  const [shown, setShown] = createState(liveIds.peek())

  // Created on demand and dropped with the chip, so a workspace that comes back
  // later starts from a clean state.
  const anims = new Map<number, ChipAnim>()
  const chipAnim = (id: number): ChipAnim => {
    let a = anims.get(id)
    if (!a) {
      const [width, setWidth] = createState(-1)
      const [opacity, setOpacity] = createState(1)
      const [sizing, setSizing] = createState(false)
      const [swap, setSwap] = createState<number | null>(null)
      const [selfOpacity, setSelfOpacity] = createState(1)
      const [swapOpacity, setSwapOpacity] = createState(0)
      const [selfAlign, setSelfAlign] = createState(0.5)
      const [swapAlign, setSwapAlign] = createState(0.5)
      a = {
        width,
        setWidth,
        opacity,
        setOpacity,
        sizing,
        setSizing,
        swap,
        setSwap,
        selfOpacity,
        setSelfOpacity,
        swapOpacity,
        setSwapOpacity,
        selfAlign,
        setSelfAlign,
        swapAlign,
        setSwapAlign,
      }
      anims.set(id, a)
    }
    return a
  }

  const btns = new Map<number, Gtk.Widget>()
  let overlay: Gtk.Widget | null = null
  let row: Gtk.Widget | null = null
  let pill: Gtk.Widget | null = null
  let clip: Gtk.ScrolledWindow | null = null
  let tick = 0
  let tickFor: number | null = null // the chip the running tween is aimed at
  let placed = false

  // One clock for the whole of a switch. The fill sliding and a chip opening or
  // closing are kicked off by two different notifies — the focus and the
  // workspace list — and astal does not deliver them on the same frame: the list
  // arrives about a frame ahead of the focus. An animation timing itself from
  // its own first frame therefore ends up ~18ms away from the one running beside
  // it. Across one slot of travel that is invisible; across two (3→1, 4→1) it is
  // the fill visibly running ahead of the chip it is leaving. So the first
  // animation to reach a frame sets the epoch, and anything starting on its
  // heels shares it and picks up at the progress already reached — which is the
  // step the other one is taking that very frame, so nothing jumps.
  const EPOCH_GRACE_US = 50_000
  let epoch = 0
  const sharedT0 = (frameTime: number) => {
    if (frameTime - epoch > EPOCH_GRACE_US) epoch = frameTime
    return epoch
  }

  // How long a chip takes to open or close, as a fraction of WS_CHIP_MS.
  //
  // A chip always has exactly one slot to cover, while the fill covers however
  // many slots the switch spans. On a shared duration their speeds are therefore
  // in the ratio of those distances, at every instant: for a one-slot switch
  // (3→2) the two edges move together and look locked, but for a two-slot one
  // (3→1, 4→1) the fill runs at twice the speed of the chip closing behind it,
  // and the pair visibly comes apart. Scaling the chip's duration down by the
  // fill's distance puts both back on the same speed — the chip simply finishes
  // sooner, having less ground to cover — and leaves the fill's own timing
  // alone, which is what matches hyprland's workspace animation.
  const MIN_CHIP_SCALE = 0.3 // never snappier than 150ms, however long the jump
  let chipScale = 1
  const scaleChipsTo = (span: number, slot: number) => {
    chipScale = span > slot && slot > 0 ? Math.max(MIN_CHIP_SCALE, slot / span) : 1
  }

  // The numbers sit in the overlay, on top of the sliding fill. Tell the overlay
  // to measure itself to that row so the fill track underneath stretches to full
  // width (otherwise it collapses to the fill's own size).
  const linkMeasure = () => {
    if (overlay && row) (overlay as Gtk.Overlay).set_measure_overlay(row, true)
  }

  // Where the mask is aimed. A scrolledwindow clamps the scroll offset to the
  // size its child had at its *last* allocation, so a value set while the row is
  // still growing (a chip animating open at the end of it) comes out short: the
  // lit copy sits left of the fill and the number under it keeps the idle
  // colour — white on the accent. Remember what we asked for and put it back the
  // moment the adjustment's bounds catch up (see the "changed" hookup below).
  let maskX = 0
  const applyMaskScroll = () => {
    if (!clip) return
    const adj = clip.get_hadjustment()
    if (adj.get_value() !== maskX) adj.set_value(maskX)
  }

  // Keep the mask on the fill. The numbers are rendered twice: the row below in
  // the idle colour, and a second, dark copy on top clipped to exactly this
  // rectangle. So a number is repainted precisely as far as the fill has covered
  // it — the ones the fill only passes over recolour and change back mid-slide,
  // instead of staying light on top of the accent. Called from the same frame
  // callback that moves the fill, so the two can never drift apart.
  const syncMask = (x: number, w: number) => {
    if (!clip || !row) return
    // Window position and size…
    clip.margin_start = Math.round(x)
    clip.width_request = Math.round(w)
    // …and the copy scrolled by the same amount, so what shows through the window
    // is the numbers at their real positions rather than the start of the row.
    maskX = Math.round(x)
    applyMaskScroll()
    // The copy is only as wide as the chips currently in it, and that is what
    // the scrolledwindow clamps the offset to. That bites twice over: the fill
    // is aimed at a *slot* (see `slotOf`) and can reach past a chip that is
    // still growing, and `upper` only catches up with a width-request at the
    // *next* layout — a frame after this callback sets it. Padding to the fill's
    // own right edge is therefore always one frame short while the fill travels
    // right, and the lit numbers lag the real ones by one step of the animation:
    // a white ghost of the number trailing the dark one, widest at the start of
    // the slide where the curve is steepest.
    //
    // So pad to the width the row will settle at instead. It is wide enough from
    // the first frame, and it does not change for the length of a transition, so
    // the offset is never clamped. Padding moves nothing: a box packs its
    // children at the start and leaves the slack at the end.
    const live = settledIds()
    const end = live.length ? slotOf(live[live.length - 1]) : null
    const need = Math.max(Math.round(x + w), end ? Math.round(end[0] + end[1]) : 0)
    if (litRow.width_request !== need) litRow.width_request = need
    // The copy is allocated its natural height inside the viewport, while the
    // real row stretches to the overlay. Left alone it comes out 4px shorter and
    // its numbers sit that much higher, which reads as a jitter the moment the
    // fill slides over them.
    const h = row.get_height()
    if (h > 0 && litRow.height_request !== h) litRow.height_request = h
  }

  const boundsOf = (btn: Gtk.Widget): [number, number] | null => {
    if (!row) return null
    const [ok, rect] = btn.compute_bounds(row)
    if (!ok || rect.size.width <= 0) return null
    return [rect.origin.x, rect.size.width]
  }

  // The workspaces that will still be there once hyprland has caught up.
  // Hyprland destroys an empty workspace the moment the focus leaves it, but it
  // sends the focus *first* and the destroy a few milliseconds later — sometimes
  // inside the same frame, sometimes not, which is why one and the same switch
  // animated differently from one go to the next. So a chip with no windows on
  // it and no focus is read as already gone: its slot belongs to whatever comes
  // next.
  //
  // This is what makes 5→6 behave like 5→4. Ranked against the raw list, the
  // chip being born sits after the one that is dying whenever its id is higher,
  // so the fill set off for the slot one to the right and was hauled back when
  // the destroy finally landed. Ranked against this one, the newborn takes the
  // dying chip's slot either way round and the fill has nowhere to travel.
  //
  // (There are no persistent or rule-bound workspaces in this config. One of
  // those would sit empty and unfocused without being doomed, and would have to
  // be kept here.)
  const settledIds = () =>
    [
      ...new Set(
        [...hypr.get_workspaces()]
          .filter(
            (ws) => ws.id > 0 && (ws.id === focusedId.peek() || ws.get_clients().length > 0),
          )
          .map((ws) => ws.id),
      ),
    ].sort((a, b) => a - b)

  // Where a chip will sit once every animation in the row has finished. Chips
  // are interchangeable — the css pins min-width to $content-height and the
  // number lives in an unmeasured overlay — so the row is a plain grid and one
  // settled chip fixes all of it.
  //
  // Switching between two *empty* workspaces destroys one chip and creates
  // another in the same breath: hyprland sends createworkspace, workspace,
  // destroyworkspace about 5ms apart, so the focus lands while the new chip is
  // still 0px wide and its neighbour is about to start collapsing into it.
  // Aimed at that chip's instantaneous box the fill dived to a few pixels and
  // swung sideways for half a second before settling. Aimed at the slot it just
  // stays put: the pair of chips shares one slot-width the whole way through, so
  // the fill has nowhere to go while the number under it changes over.
  const slotOf = (id: number): [number, number] | null => {
    const live = settledIds()
    const i = live.indexOf(id)
    if (i < 0) return null
    // The reference has to be a chip with nothing but settled chips to its left,
    // otherwise its own x is mid-reflow too — so only the first one in the row
    // will do, and only if it is holding still.
    const [refId] = shown.peek()
    if (refId == null || ticks.has(refId) || leaving.has(refId)) return null
    const j = live.indexOf(refId)
    const ref = btns.get(refId)
    const b = ref ? boundsOf(ref) : null
    if (j < 0 || !b) return null
    return [b[0] + (i - j) * b[1], b[1]]
  }

  // A workspace created by the switch being played does not open its slot on a
  // clock of its own — the fill uncovers it. The chip is only ever as wide as
  // the fill's leading edge has reached past where that chip will sit, so the
  // chip's right edge *is* the fill's right edge for the whole of the slide.
  //
  // Going 1→3 across an occupied 2, that means the row holds still while the
  // fill crosses 2, and chip 3 then grows out from nothing exactly as the fill
  // moves on past it — instead of the slot springing open at the far end and
  // the fill travelling towards a chip that is already sitting there.
  //
  // `at` is where the chip's slot starts, `full` the width it settles at.
  let reveal: { id: number; at: number; full: number } | null = null

  const applyFill = (x: number, w: number) => {
    if (!pill) return
    pill.margin_start = Math.round(x)
    pill.width_request = Math.round(w)
    if (reveal) {
      const open = Math.max(0, Math.min(reveal.full, Math.round(x + w - reveal.at)))
      const a = chipAnim(reveal.id)
      a.setWidth(open)
      // The number fades up with the slot, as it does when a chip opens on its
      // own clock.
      a.setOpacity(reveal.full > 0 ? open / reveal.full : 1)
    }
    syncMask(x, w)
  }

  // Put the fill on a chip and keep it there. The target is re-read every frame,
  // never aimed at once: while a chip collapses out of the row every chip to its
  // right slides left, and the list can change again mid-slide (the destroy
  // event trails the focus event). Once the eased part is over the fill stays on
  // the target until the chip has stopped animating, plus a few frames for the
  // layout that follows `settle()` to land. Without that tail the fill froze at
  // whatever the target was on its last frame.
  //
  // `snap` places the fill immediately (first placement, or after it was parked)
  // instead of sliding.
  const driveFill = (id: number, btn: Gtk.Widget | null | undefined, snap: boolean) => {
    if (!pill) return
    // Already sliding to this chip: leave the tween be. It re-reads its target
    // every frame, so it has nothing to gain from a restart — and a restart
    // costs a whole frame, because removing a widget's last tick callback stops
    // its frame clock and adding one back only takes effect a frame later. That
    // frame was the entire desync between the fill and a chip closing beside it:
    // both the focus and the destroy notify call `aim`, so the fill was being
    // restarted just as the chip's collapse was being started, and the collapse
    // got under way ~18ms ahead of it. Unnoticeable over one slot of travel,
    // plainly visible over two (3→1, 4→1), where the same 18ms is twice the
    // distance.
    if (!snap && tick && tickFor === id) return
    // The slot is the real target; a chip's own box is only the fallback for a
    // row too unsettled to read a grid off (and never for a chip whose workspace
    // is already gone — `gone` in `aim` parks the fill before that).
    const aimAt = () => slotOf(id) ?? (btn ? boundsOf(btn) : null)
    let to = aimAt()
    if (!to) return
    if (tick) {
      pill.remove_tick_callback(tick)
      tick = 0
    }
    const fromX = snap ? to[0] : pill.margin_start
    const fromW = snap ? to[1] : pill.width_request > 0 ? pill.width_request : to[1]
    // The chips of this switch pace themselves off how far the fill is going.
    scaleChipsTo(snap ? 0 : Math.abs(to[0] - fromX), to[1])
    // Hand a chip this switch is creating over to the fill (see `reveal`), but
    // only when the fill is really travelling towards it: an empty→empty swap
    // leaves the fill standing still, and a leftward switch grows the chip at
    // the head of the row, where every other chip shifts along to make room and
    // the fill's edge is no measure of the gap at all.
    endReveal(false)
    if (!snap && to[0] > fromX && isOpening(id)) reveal = { id, at: to[0], full: to[1] }
    if (snap) applyFill(to[0], to[1])
    let t0 = -1
    let idle = 0
    tickFor = id
    tick = pill.add_tick_callback((_w, clock) => {
      if (t0 < 0) t0 = sharedT0(clock.get_frame_time())
      const p = snap ? 1 : Math.min(1, (clock.get_frame_time() - t0) / (WS_ANIM_MS * 1000))
      to = aimAt() ?? to // mid-reflow: keep the last known target
      if (p < 1) {
        const e = easeMacos(p)
        applyFill(fromX + (to[0] - fromX) * e, fromW + (to[1] - fromW) * e)
        return true
      }
      applyFill(to[0], to[1])
      endReveal(true) // arrived: the chip it uncovered is full size
      // The chip's own animation runs on the same frame clock and may well have
      // been serviced before this callback, so `ticks` clearing does not yet mean
      // the layout after it has happened — bounds are only up to date on the next
      // frame. Hold for a few quiet frames rather than stopping on the first one.
      if (ticks.has(id)) idle = 0
      else if (++idle > 3) {
        tick = 0
        tickFor = null
        return false
      }
      return true
    })
    // The fill having somewhere to go is proof this switch is not the swap the
    // reconcile is holding back for, so there is nothing left to wait on — and a
    // chip cannot be uncovered before it has been built. Last, because reconcile
    // can reach back into `aim` (a chip dropped without an exit), and a second
    // `driveFill` landing in the middle of this one would strand its callback.
    if (reveal?.id === id) flushReconcile()
  }

  // Chips animate in and out on the row's frame clock, on the fill's own curve
  // and duration, so a workspace appearing or disappearing reads as one movement
  // with the fill rather than a jump next to it. `ticks` holds whichever
  // animation a chip is playing, `leaving` marks the chips that outlive their
  // workspace.
  const ticks = new Map<number, number>()
  const leaving = new Set<number>()

  const stopAnim = (id: number) => {
    const cb = ticks.get(id)
    if (cb && row) row.remove_tick_callback(cb)
    ticks.delete(id)
  }

  // Feeds `frame` an eased 0→1 progress every frame, then calls `done`.
  const animate = (id: number, frame: (e: number) => void, done: () => void) => {
    stopAnim(id)
    if (!row) {
      done()
      return
    }
    let t0 = -1
    const cb = row.add_tick_callback((_w, clock) => {
      if (t0 < 0) t0 = sharedT0(clock.get_frame_time())
      const p = Math.min(1, (clock.get_frame_time() - t0) / (WS_CHIP_MS * chipScale * 1000))
      frame(easeMacos(p))
      if (p < 1) return true
      ticks.delete(id)
      done()
      return false
    })
    ticks.set(id, cb)
  }

  // Hand the chip back to the css once it has finished animating.
  const settle = (id: number) => {
    const a = anims.get(id)
    if (!a) return
    a.setWidth(-1)
    a.setOpacity(1)
    a.setSizing(false)
  }

  const dropChip = (id: number) => {
    leaving.delete(id)
    anims.delete(id)
    setShown((prev) => prev.filter((shownId) => shownId !== id))
    aim() // the row just reflowed — put the fill back where it belongs
  }

  // `from` / `to` are widths measured by the caller *before* the row was
  // rebuilt: For drops and re-appends every child on a list change, so bounds
  // read after that are not there yet.
  const startExit = (id: number, from: number | null) => {
    if (reveal?.id === id) reveal = null // going out again, not coming in
    leaving.add(id)
    const a = chipAnim(id)
    a.setSizing(true)
    // Nothing measurable to collapse (never laid out, or the row is gone): take
    // the chip out right away rather than animate from a guess.
    if (!from) {
      dropChip(id)
      return
    }
    animate(
      id,
      (e) => {
        // One eased progress for both: the number thins out exactly as fast as
        // its slot closes, and both track the fill's slide.
        a.setWidth(Math.round(from * (1 - e)))
        a.setOpacity(1 - e)
      },
      () => dropChip(id),
    )
  }

  // The mirror image, for a workspace that just appeared — and for one that
  // came back while its chip was collapsing, which grows again from wherever
  // the exit had got to.
  const startEnter = (id: number, to: number | null) => {
    const a = chipAnim(id)
    if (!to) {
      settle(id)
      return
    }
    const from = Math.max(0, a.width.peek())
    const fromOpacity = a.opacity.peek()
    animate(
      id,
      (e) => {
        a.setWidth(Math.round(from + (to - from) * e))
        a.setOpacity(fromOpacity + (1 - fromOpacity) * e)
      },
      () => settle(id),
    )
  }

  // Has the row still to open this chip? Either it has not been built at all —
  // the reconcile that creates it is yet to run — or it is mid-growth.
  const isOpening = (id: number) => {
    if (leaving.has(id)) return false
    if (!shown.peek().includes(id)) return true
    return ticks.has(id) && (anims.get(id)?.sizing.peek() ?? false)
  }

  // Stop driving a chip from the fill. `arrived` is the fill reaching its
  // target, where the chip is by definition full size and only wants handing
  // back to the css. Anything else cut the reveal short — another switch — so a
  // chip already in the row finishes opening on its own clock from wherever it
  // had got to, and one not built yet is left to the reconcile, which will now
  // animate it normally.
  const endReveal = (arrived: boolean) => {
    if (!reveal) return
    const { id, full } = reveal
    reveal = null
    if (arrived) settle(id)
    else if (shown.peek().includes(id) && !leaving.has(id)) startEnter(id, full)
  }

  // The empty→empty switch: hyprland destroys the workspace you left and creates
  // the one you went to, so one chip has to replace another in the very same
  // slot. Collapsing one slot while opening another is wrong for that — it makes
  // a second chip appear beside the first and the fill walk over to it. Instead
  // the newcomer takes the slot outright, at full width, and paints the outgoing
  // number over its own while the two trade opacity: the row never changes size,
  // nothing appears to either side, and the number simply turns into the other
  // one where it stands.
  const startSwap = (id: number, from: number) => {
    if (reveal?.id === id || reveal?.id === from) reveal = null
    const previous = anims.get(from)
    // Mid-swap already (a fast there-and-back): pick the two numbers up where
    // they are actually being drawn rather than snapping them back to the edges.
    const wasOutgoing = previous?.swap.peek() === id
    const fromOpacity = previous ? previous.selfOpacity.peek() : 1
    const selfFrom = wasOutgoing ? previous!.swapOpacity.peek() : 0
    // Which way the row would have moved: a higher id sits to the right, so its
    // number comes in from the right edge and pushes the old one out to the
    // left. A lower id does the mirror image. Same sense of travel as the fill
    // sliding from one chip to the next, and the same curve and duration.
    const inEdge = id > from ? 1 : 0
    const outEdge = 1 - inEdge
    const fromAlign = previous ? previous.selfAlign.peek() : 0.5
    const selfFromAlign = wasOutgoing ? previous!.swapAlign.peek() : inEdge

    const a = chipAnim(id)
    a.setSwap(from)
    a.setSelfOpacity(selfFrom)
    a.setSwapOpacity(fromOpacity)
    a.setSelfAlign(selfFromAlign)
    a.setSwapAlign(fromAlign)

    stopAnim(from)
    leaving.delete(from)
    anims.delete(from)

    animate(
      id,
      (e) => {
        a.setSelfOpacity(selfFrom + (1 - selfFrom) * e)
        a.setSwapOpacity(fromOpacity * (1 - e))
        a.setSelfAlign(selfFromAlign + (0.5 - selfFromAlign) * e)
        a.setSwapAlign(fromAlign + (outEdge - fromAlign) * e)
      },
      () => {
        a.setSwap(null)
        a.setSelfOpacity(1)
        a.setSwapOpacity(0)
        a.setSelfAlign(0.5)
        a.setSwapAlign(0.5)
      },
    )
  }

  // Fold hyprland's list into what the row shows: keep chips whose workspace
  // disappeared until their exit has played, grow the ones that just appeared,
  // and take a chip back if its workspace returns mid-flight.
  const reconcile = () => {
    const live = liveIds.peek()
    const previous = shown.peek()
    // Nothing is sliding: whatever the last switch scaled the chips to does not
    // apply here. A fill tween started for *this* switch — in either notify
    // order — overwrites this again before the first frame.
    if (!tick) chipScale = 1

    const regrown: number[] = []
    for (const id of [...leaving]) {
      if (live.includes(id)) {
        stopAnim(id)
        leaving.delete(id)
        regrown.push(id)
      }
    }

    const ghosts = previous.filter((id) => !live.includes(id))
    const starting = ghosts.filter((id) => !leaving.has(id))
    const fresh = live.filter((id) => !previous.includes(id))

    // Exactly one workspace out, one in, and the newcomer lands in the slot the
    // old one is vacating — that is the empty→empty switch, and the whole change
    // to the row is the number on one chip. Ghosts still playing out an earlier
    // switch are not part of the comparison, so a fast run of switches keeps
    // swapping rather than falling back halfway through.
    if (starting.length === 1 && fresh.length === 1) {
      const out = starting[0]
      const into = fresh[0]
      const settled = previous.filter((id) => !leaving.has(id))
      if (live.indexOf(into) === settled.indexOf(out)) {
        startSwap(into, out)
        setShown([...live, ...ghosts.filter((id) => id !== out)].sort((a, b) => a - b))
        return
      }
    }

    // Measure before the rebuild (see above). A chip is whatever the css makes
    // it, so any chip that is not itself mid-animation gives the size a new one
    // grows into.
    const widths = new Map<number, number | null>()
    for (const id of starting) {
      const btn = btns.get(id)
      widths.set(id, (btn ? boundsOf(btn)?.[1] : null) ?? null)
    }
    let full: number | null = null
    for (const [id, btn] of btns) {
      if (ticks.has(id) || leaving.has(id)) continue
      const w = boundsOf(btn)?.[1]
      if (w) {
        full = w
        break
      }
    }

    // Seed the new chips collapsed *before* they are built, so their first frame
    // is the start of the animation and not a flash at full width.
    for (const id of fresh) {
      const a = chipAnim(id)
      a.setSizing(true)
      if (reveal?.id === id) continue // the fill is already sizing this one
      a.setWidth(0)
      a.setOpacity(0)
    }

    setShown([...live, ...ghosts].sort((a, b) => a - b))

    for (const id of starting) startExit(id, widths.get(id) ?? null)
    for (const id of [...fresh, ...regrown]) {
      if (reveal?.id === id) continue // opened by the fill, not by a clock
      startEnter(id, full)
    }
  }

  // Aim the fill at the currently focused workspace. Its button may not exist yet
  // (switching to an empty workspace creates it a frame or two later) or may be
  // mid-reflow (leaving an empty workspace removes it and shifts the rest), so we
  // poll until its bounds are real, then snap on first placement or slide from
  // the current position. `seq` lets a newer aim cancel an older poll, so rapid
  // switches neither fight nor leave the fill stranded.
  let seq = 0
  const aim = () => {
    const mine = ++seq
    let tries = 0
    const step = (): boolean => {
      if (mine !== seq) return GLib.SOURCE_REMOVE // a newer aim took over
      const id = focusedId.peek()
      // The focus has landed on a workspace hyprland has not listed yet — the
      // create and the focus are separate messages, and they do not always fall
      // on the same side of a frame. Leave the fill exactly where it is and wait
      // for the list: it is aimed at a *slot*, so standing still costs nothing,
      // whereas hiding it and snapping it back (which is what this used to do,
      // from the days when it tracked a chip that was about to be destroyed)
      // blinked the indicator off for a frame on every switch.
      // Special workspaces are never in the list, so they must not count as
      // gone — the fill stays on the regular workspace underneath them.
      const gone = id != null && id > 0 && !liveIds.peek().includes(id)
      if (gone) return ++tries > 80 ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE
      const btn = id != null ? btns.get(id) : null
      // Not `boundsOf(btn)`: a chip created a moment ago is still 0px wide and
      // would read as "not laid out" for a frame, holding the fill back exactly
      // when it is wanted. Its slot is known as soon as the workspace is live.
      const tb = id != null ? slotOf(id) ?? (btn ? boundsOf(btn) : null) : null
      // pill/row not built yet, or the button isn't laid out (just created /
      // mid-reflow) — keep polling, but don't spin forever (e.g. a special ws).
      if (!pill || !tb) return ++tries > 80 ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE
      // `id` is non-null here — `tb` was computed from it.
      if (!placed) {
        pill.visible = true
        if (clip) clip.visible = true
        driveFill(id!, btn, true)
        placed = true
      } else {
        driveFill(id!, btn, false)
      }
      return GLib.SOURCE_REMOVE
    }
    if (step()) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8, step)
  }

  // The masked copy of the numbers. Same widgets, same CSS — so it measures
  // identically to the row below and the two line up — but painted in the on-fill
  // colour and not clickable.
  const litRow = (
    <box cssName="workspaces" class="lit">
      <For each={shown} id={(id) => id}>
        {(id) => {
          const a = chipAnim(id)
          return (
            <button
              cssName="workspace-btn"
              class={a.sizing.as((on) => (on ? "sizing" : ""))}
              widthRequest={a.width}
              opacity={a.opacity}
              overflow={Gtk.Overflow.HIDDEN}
            >
              <ChipNumber id={id} anim={a} />
            </button>
          )
        }}
      </For>
    </box>
  ) as Gtk.Widget

  // hyprland announces a switch in three messages a few milliseconds apart —
  // createworkspace, then the focus, then destroyworkspace — and astal turns
  // each one into its own notify. Reconciling on the first of them is what made
  // the new chip open a slot of its own before the old one had even begun to
  // close, and whether that happened at all came down to which side of a frame
  // the destroy landed on — the same switch animating differently from one go to
  // the next. Hold for a couple of frames so the whole switch arrives as one
  // change; too slow a destroy just falls back to the open/close animation.
  const RECONCILE_COALESCE_MS = 40
  let pending = 0
  // Run a held-back reconcile now. Used when the fill has shown the change to
  // be a plain create rather than a swap, so waiting can only delay the chip.
  const flushReconcile = () => {
    if (!pending) return
    GLib.source_remove(pending)
    pending = 0
    reconcile()
  }

  const scheduleReconcile = () => {
    if (pending) return
    pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECONCILE_COALESCE_MS, () => {
      pending = 0
      reconcile() // ws added / starting to leave → rebuild what the row shows
      aim() // …then reflow + slide
      return GLib.SOURCE_REMOVE
    })
  }

  focusedId.subscribe(aim) // focus change → slide to it
  liveIds.subscribe(() => {
    // Only an *addition* is worth waiting on: the destroy trails the create, so
    // a chip that has just appeared may still turn out to be replacing another.
    // A removal is the end of that sequence — there is nothing more to wait for,
    // and holding it back for the rest of the window left the chip being left
    // behind standing at full width, a dark block to the right of the fill that
    // only started closing a couple of frames after the fill had set off.
    const live = liveIds.peek()
    const removes = shown.peek().some((id) => !live.includes(id) && !leaving.has(id))
    if (removes) {
      if (pending) {
        GLib.source_remove(pending)
        pending = 0
      }
      reconcile()
    } else {
      scheduleReconcile()
    }
    aim() // the fill is aimed at slots, not chips, so it need not wait for the row
  })
  aim() // initial placement

  return (
    <overlay
      $={(self: Gtk.Widget) => {
        overlay = self
        linkMeasure()
      }}
    >
      {/* Main child: full-width track holding the sliding accent fill. */}
      <box cssName="ws-track">
        <box
          cssName="ws-pill"
          halign={Gtk.Align.START}
          canTarget={false}
          visible={false}
          $={(self: Gtk.Widget) => (pill = self)}
        />
      </box>
      {/* Overlay (on top): the numbers, over the fill. Buttons are transparent. */}
      <box
        cssName="workspaces"
        $type="overlay"
        $={(self: Gtk.Widget) => {
          row = self
          linkMeasure()
        }}
      >
        <For each={shown} id={(id) => id}>
          {(id) => {
            const a = chipAnim(id)
            return (
              <button
                cssName="workspace-btn"
                class={createComputed(() =>
                  [focusedId() === id ? "active" : "", a.sizing() ? "sizing" : ""]
                    .filter(Boolean)
                    .join(" "),
                )}
                widthRequest={a.width}
                opacity={a.opacity}
                overflow={Gtk.Overflow.HIDDEN}
                onClicked={() => dispatch(hypr, `hl.dsp.focus({ workspace = ${id} })`)}
                $={(self: Gtk.Widget) => {
                  btns.set(id, self)
                  onCleanup(() => btns.delete(id))
                }}
              >
                <ChipNumber id={id} anim={a} />
              </button>
            )
          }}
        </For>
      </box>
      {/* Overlay (topmost): the same numbers in the on-fill colour, shown through a
          window the size of the fill, so only the part the fill covers is
          repainted. Input passes through to the real buttons underneath.

          A scrolledwindow rather than a box with overflow:hidden, because a box
          takes its natural width from its child: the window would then stretch
          from the fill to the end of the row and darken every number to the right
          of it. A scrolledwindow's natural width is its own (propagate-natural-
          width stays off), so width-request really sets the size — and scrolling
          gives the offset without negative coordinates. */}
      <scrolledwindow
        cssName="ws-mask"
        $type="overlay"
        halign={Gtk.Align.START}
        valign={Gtk.Align.FILL}
        canTarget={false}
        hscrollbarPolicy={Gtk.PolicyType.EXTERNAL}
        vscrollbarPolicy={Gtk.PolicyType.EXTERNAL}
        $={(self: Gtk.ScrolledWindow) => {
          clip = self
          self.set_child(litRow)
          // "changed" fires when upper / page-size are recomputed, i.e. exactly
          // when a clamped offset can finally be honoured.
          self.get_hadjustment().connect("changed", applyMaskScroll)
        }}
      />
    </overlay>
  )
}

export default function LeftPanel(gdkmonitor: Gdk.Monitor) {
  const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

  const win = (
    <window
      visible
      name="left-panel"
      class="LeftPanel"
      gdkmonitor={gdkmonitor}
      // Full-width top anchor (TOP + both sides) so the reserved strip spans the
      // whole top edge; halign keeps the visible chip on the left, and the right
      // panel uses IGNORE to share this strip. Exclusivity is NORMAL because the
      // zone is set by hand below — auto would reserve the full surface height
      // (including the bottom shadow margin) and double the gap under the bar.
      exclusivity={Astal.Exclusivity.NORMAL}
      anchor={TOP | LEFT | RIGHT}
      resizable={false}
      application={app}
    >
      <box cssName="left-panel-inner" halign={Gtk.Align.START}>
        <Workspaces />
      </box>
    </window>
  ) as Astal.Window

  // Reserve space only down to the *visible* bottom of the bar, not the full
  // surface. The surface is taller by BAR_SHADOW_ROOM at the bottom (transparent
  // margin that gives the drop shadow room to render); reserving that too would
  // push windows down twice — once by the bar's own bottom margin, once by
  // Hyprland's gaps_out. Keep BAR_SHADOW_ROOM in sync with the bottom value of
  // `margin` on *-panel-inner in styles/base/_panels.scss.
  const BAR_SHADOW_ROOM = 10
  // Astal maps the window synchronously at construction, so connecting to "map"
  // would miss the event. Poll on a short timeout instead until the surface has
  // an allocated height, then reserve down to the visible bar bottom (height
  // minus the transparent shadow margin) and stop.
  const reserve = () => {
    const h = win.get_height()
    if (h <= 0) return GLib.SOURCE_CONTINUE // not allocated yet — retry next tick
    Gtk4LayerShell.set_exclusive_zone(win, Math.max(0, h - BAR_SHADOW_ROOM))
    return GLib.SOURCE_REMOVE
  }
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, reserve)

  return win
}
