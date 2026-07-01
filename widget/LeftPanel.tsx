import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createBinding, For, onCleanup } from "gnim"
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

function Workspaces() {
  const hypr = Hyprland.get_default()
  if (!hypr) return <box cssName="workspaces" />

  const workspaces = createBinding(hypr, "workspaces").as((wss) =>
    [...wss].filter((ws) => ws.id > 0).sort((a, b) => a.id - b.id),
  )
  const focusedId = createBinding(hypr, "focusedWorkspace").as((fw) => fw?.id)

  const btns = new Map<number, Gtk.Widget>()
  let overlay: Gtk.Widget | null = null
  let row: Gtk.Widget | null = null
  let pill: Gtk.Widget | null = null
  let tick = 0
  let placed = false

  // The numbers sit in the overlay, on top of the sliding fill. Tell the overlay
  // to measure itself to that row so the fill track underneath stretches to full
  // width (otherwise it collapses to the fill's own size).
  const linkMeasure = () => {
    if (overlay && row) (overlay as Gtk.Overlay).set_measure_overlay(row, true)
  }

  const boundsOf = (btn: Gtk.Widget): [number, number] | null => {
    if (!row) return null
    const [ok, rect] = btn.compute_bounds(row)
    if (!ok || rect.size.width <= 0) return null
    return [rect.origin.x, rect.size.width]
  }

  const startTween = (toX: number, toW: number) => {
    if (!pill) return
    const fromX = pill.margin_start
    const fromW = pill.width_request > 0 ? pill.width_request : toW
    if (tick) {
      pill.remove_tick_callback(tick)
      tick = 0
    }
    let t0 = -1
    tick = pill.add_tick_callback((w, clock) => {
      if (t0 < 0) t0 = clock.get_frame_time()
      const p = Math.min(1, (clock.get_frame_time() - t0) / (WS_ANIM_MS * 1000))
      const e = easeMacos(p)
      w.margin_start = Math.round(fromX + (toX - fromX) * e)
      w.width_request = Math.round(fromW + (toW - fromW) * e)
      if (p >= 1) {
        tick = 0
        return false
      }
      return true
    })
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
      const btn = pill && id != null ? btns.get(id) : null
      const tb = btn ? boundsOf(btn) : null
      // pill/row not built yet, or the button isn't laid out (just created /
      // mid-reflow) — keep polling, but don't spin forever (e.g. a special ws).
      if (!pill || !tb) return ++tries > 80 ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE
      if (!placed) {
        pill.margin_start = Math.round(tb[0])
        pill.width_request = Math.round(tb[1])
        pill.visible = true
        placed = true
      } else {
        startTween(tb[0], tb[1])
      }
      return GLib.SOURCE_REMOVE
    }
    if (step()) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8, step)
  }

  focusedId.subscribe(aim) // focus change → slide to it
  workspaces.subscribe(aim) // ws added/removed → reflow + slide
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
        <For each={workspaces} id={(ws) => ws.id}>
          {(ws) => (
            <button
              cssName="workspace-btn"
              class={focusedId.as((id) => (id === ws.id ? "active" : ""))}
              onClicked={() => hypr.dispatch("workspace", `${ws.id}`)}
              $={(self: Gtk.Widget) => {
                btns.set(ws.id, self)
                onCleanup(() => btns.delete(ws.id))
              }}
            >
              <label label={`${ws.id}`} />
            </button>
          )}
        </For>
      </box>
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
