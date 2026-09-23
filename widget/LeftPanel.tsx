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

// The number on a chip. It sits in the *overlay* slot of an overlay whose main
// child is empty, and gtk does not measure overlay children — so the chip is
// sized by its css alone and the digit never pins it open. That is what lets
// the slot be animated shut with the number still on screen, fading, instead of
// having to yank the number out first (the button clips it, see `overflow`).
function ChipNumber({ id }: { id: number }) {
  return (
    <overlay>
      <box />
      <label $type="overlay" label={`${id}`} />
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

  // Per-chip animation handles. The real row and its lit copy bind the very same
  // accessors, so the two can never measure differently while a chip animates.
  // Created on demand and dropped with the chip, so a workspace that comes back
  // later starts from a clean state.
  type ChipAnim = {
    width: Accessor<number> // -1 = natural
    setWidth: Setter<number>
    opacity: Accessor<number>
    setOpacity: Setter<number>
    // While a chip animates in or out its size is driven from here, so the css
    // minimum has to step aside.
    sizing: Accessor<boolean>
    setSizing: Setter<boolean>
  }
  const anims = new Map<number, ChipAnim>()
  const chipAnim = (id: number): ChipAnim => {
    let a = anims.get(id)
    if (!a) {
      const [width, setWidth] = createState(-1)
      const [opacity, setOpacity] = createState(1)
      const [sizing, setSizing] = createState(false)
      a = { width, setWidth, opacity, setOpacity, sizing, setSizing }
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
  let placed = false

  // The numbers sit in the overlay, on top of the sliding fill. Tell the overlay
  // to measure itself to that row so the fill track underneath stretches to full
  // width (otherwise it collapses to the fill's own size).
  const linkMeasure = () => {
    if (overlay && row) (overlay as Gtk.Overlay).set_measure_overlay(row, true)
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
    clip.get_hadjustment().set_value(Math.round(x))
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

  // The target is a function, not a pair of numbers: while a chip collapses out
  // of the row, every chip to its right slides left — including the one the fill
  // is heading for. Re-reading the bounds each frame keeps the fill on the
  // moving chip, and the mask with it. Aimed once, as this was before, the fill
  // landed a chip-width off and the mask lit up the number next door until the
  // next reflow corrected it.
  const startTween = (target: () => [number, number] | null) => {
    if (!pill) return
    let to = target()
    if (!to) return
    const fromX = pill.margin_start
    const fromW = pill.width_request > 0 ? pill.width_request : to[1]
    if (tick) {
      pill.remove_tick_callback(tick)
      tick = 0
    }
    let t0 = -1
    tick = pill.add_tick_callback((w, clock) => {
      if (t0 < 0) t0 = clock.get_frame_time()
      const p = Math.min(1, (clock.get_frame_time() - t0) / (WS_ANIM_MS * 1000))
      const e = easeMacos(p)
      to = target() ?? to // mid-reflow: keep the last known target
      const x = fromX + (to[0] - fromX) * e
      const width = fromW + (to[1] - fromW) * e
      w.margin_start = Math.round(x)
      w.width_request = Math.round(width)
      syncMask(x, width)
      if (p >= 1) {
        tick = 0
        return false
      }
      return true
    })
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
      if (t0 < 0) t0 = clock.get_frame_time()
      const p = Math.min(1, (clock.get_frame_time() - t0) / (WS_CHIP_MS * 1000))
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

  // Fold hyprland's list into what the row shows: keep chips whose workspace
  // disappeared until their exit has played, grow the ones that just appeared,
  // and take a chip back if its workspace returns mid-flight.
  const reconcile = () => {
    const live = liveIds.peek()
    const previous = shown.peek()

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
      a.setWidth(0)
      a.setOpacity(0)
    }

    setShown([...live, ...ghosts].sort((a, b) => a - b))

    for (const id of starting) startExit(id, widths.get(id) ?? null)
    for (const id of [...fresh, ...regrown]) startEnter(id, full)
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
      // Leaving an *empty* workspace destroys it, and hyprland reports the
      // removal a few ms before the new focus arrives. In between, the fill is
      // still aimed at a workspace that is already out of the list: its button
      // is about to go, the row shrinks underneath, and gtk clamps the fill
      // back into the shorter row — so for a frame or two it highlights the
      // last surviving workspace instead. Park it off screen and wait for the
      // focus to catch up; `placed = false` then puts it straight onto the new
      // workspace rather than sliding out of a slot that no longer exists.
      // Special workspaces are never in the list, so they must not count as
      // gone — the fill stays on the regular workspace underneath them.
      const gone = id != null && id > 0 && !shown.peek().includes(id)
      if (pill && gone) {
        if (tick) {
          pill.remove_tick_callback(tick)
          tick = 0
        }
        pill.visible = false
        // The lit copy of the numbers is clipped to the fill, so it has to go
        // with it — otherwise the number under the stale rectangle stays
        // painted in the on-fill colour and reads as the active workspace.
        if (clip) clip.visible = false
        placed = false
      }
      const btn = pill && id != null && !gone ? btns.get(id) : null
      const tb = btn ? boundsOf(btn) : null
      // pill/row not built yet, or the button isn't laid out (just created /
      // mid-reflow) — keep polling, but don't spin forever (e.g. a special ws).
      if (!pill || !tb) return ++tries > 80 ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE
      if (!placed) {
        pill.margin_start = Math.round(tb[0])
        pill.width_request = Math.round(tb[1])
        pill.visible = true
        if (clip) clip.visible = true
        syncMask(tb[0], tb[1])
        placed = true
      } else {
        const target = btn
        startTween(() => boundsOf(target))
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
              <ChipNumber id={id} />
            </button>
          )
        }}
      </For>
    </box>
  ) as Gtk.Widget

  focusedId.subscribe(aim) // focus change → slide to it
  liveIds.subscribe(() => {
    reconcile() // ws added / starting to leave → rebuild what the row shows
    aim() // …then reflow + slide
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
                <ChipNumber id={id} />
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
