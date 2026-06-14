import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createPoll, interval } from "ags/time"
import { createBinding, createState, onCleanup } from "gnim"
import Battery from "gi://AstalBattery?version=0.1"
import Hyprland from "gi://AstalHyprland?version=0.1"
import QuickSettingsWindow, { toggleQs } from "./QuickSettings"
import StatusIndicators from "./StatusIndicators"
import SystemTray from "./SystemTray"

// Command to count available updates (official repos + AUR).
const UPDATE_CHECK_CMD = ["bash", "-c", "(checkupdates; yay -Qua) 2>/dev/null | wc -l"]
const UPDATE_INTERVAL = 30 * 60 * 1000 // 30 minutes

function shortLayout(layout: string): string {
  return layout.replace(/\s*\(.*\)/, "").slice(0, 2).toUpperCase()
}

function KbLayout() {
  const hypr = Hyprland.get_default()
  if (!hypr) return <box />

  const [layout, setLayout] = createState("")

  const id = hypr.connect("keyboard-layout", (_h, _kb: string, lay: string) =>
    setLayout(shortLayout(lay)),
  )
  onCleanup(() => hypr.disconnect(id))

  // Initial value: current layout of the main keyboard.
  execAsync([
    "bash",
    "-c",
    "hyprctl devices -j | jq -r '[.keyboards[] | select(.main)][0].active_keymap'",
  ])
    .then((s) => setLayout(shortLayout(s.trim())))
    .catch(() => {})

  return (
    <box cssName="kb-layout" spacing={4}>
      <label cssName="kb-icon" label="䂌" />
      <label label={layout} />
    </box>
  )
}

function Updates() {
  // -1 = not fetched yet; the first poll replaces it with the real count. The
  // chip stays visible while loading (showing "..") and once there are updates,
  // and hides only after a successful check reports zero.
  const count = createPoll(-1, UPDATE_INTERVAL, UPDATE_CHECK_CMD, (out) =>
    parseInt(out.trim(), 10) || 0,
  )

  return (
    <box cssName="updates" spacing={4} visible={count.as((n) => n !== 0)}>
      <label cssName="updates-icon" label="䂍" />
      <label label={count.as((n) => (n < 0 ? "..." : `${n}`))} />
    </box>
  )
}

// Battery level glyphs from the user's MyFont, ordered empty → full. The level
// shown is picked by charge bucket; while charging they cycle from the current
// level up to full (a "filling" animation). Reverse this array if the glyphs
// turn out to read full → empty.
const BATTERY_GLYPHS = ["䂉", "䂈", "䂇", "䂆", "䂅"]
// Frame interval for the charging fill animation.
const BATTERY_ANIM_MS = 750

function batteryLevel(p: number): number {
  return Math.max(0, Math.min(BATTERY_GLYPHS.length - 1, Math.floor(p * BATTERY_GLYPHS.length)))
}

function BatteryWidget() {
  const bat = Battery.get_default()
  if (!bat) return <box />

  const present = createBinding(bat, "isPresent")
  const percentage = createBinding(bat, "percentage")
  const charging = createBinding(bat, "charging")

  const [glyph, setGlyph] = createState(BATTERY_GLYPHS[batteryLevel(percentage.peek())])

  // While charging, animate a fill that loops from the real charge level up to
  // full; otherwise the glyph just tracks the current level.
  let timer: ReturnType<typeof interval> | null = null
  const stop = () => {
    timer?.cancel()
    timer = null
  }
  const sync = () => {
    const base = batteryLevel(percentage.peek())
    if (charging.peek()) {
      if (!timer) {
        let i = base
        timer = interval(BATTERY_ANIM_MS, () => {
          setGlyph(BATTERY_GLYPHS[i])
          // Loop back to the live charge level once we've reached full.
          i = i >= BATTERY_GLYPHS.length - 1 ? batteryLevel(percentage.peek()) : i + 1
        })
      }
    } else {
      stop()
      setGlyph(BATTERY_GLYPHS[base])
    }
  }

  sync()
  const unsubs = [charging.subscribe(sync), percentage.subscribe(sync)]
  onCleanup(() => {
    unsubs.forEach((u) => u())
    stop()
  })

  return (
    <box cssName="battery" spacing={4} visible={present}>
      <label cssName="battery-icon" label={glyph} />
      <label label={percentage.as((p) => `${Math.round(p * 100)}%`)} />
    </box>
  )
}

function Clock() {
  const time = createPoll("", 1000, "date +'%H:%M'")
  const date = createPoll("", 60000, "date +'%d %b'")

  return (
    <box cssName="clock" spacing={6}>
      <label cssName="date" label={date} />
      <label cssName="time" label={time} />
    </box>
  )
}

export default function RightPanel(gdkmonitor: Gdk.Monitor) {
  const { TOP, RIGHT } = Astal.WindowAnchor

  // Pinned overlay window for Quick Settings (self-registers via application={app}).
  // Open/close state + slide animation live in QuickSettings.tsx; the qs-button,
  // Escape, and the `ags request quicksettings` keybind all toggle the same panel.
  QuickSettingsWindow({ gdkmonitor })

  return (
    <window
      visible
      name="right-panel"
      class="RightPanel"
      gdkmonitor={gdkmonitor}
      // IGNORE (not EXCLUSIVE): the left panel already reserves the full-width
      // top strip via its auto exclusive zone. This panel just sits in that
      // strip on the right; reserving again would double the gap.
      exclusivity={Astal.Exclusivity.IGNORE}
      anchor={TOP | RIGHT}
      resizable={false}
      application={app}
    >
      <box cssName="right-panel-inner" spacing={0}>
        <StatusIndicators gdkmonitor={gdkmonitor} />
        <SystemTray />
        <BatteryWidget />
        <Updates />
        <KbLayout />
        <Clock />
        <button cssName="qs-button" onClicked={() => toggleQs()}>
          <image iconName="view-grid-symbolic" />
        </button>
      </box>
    </window>
  )
}
