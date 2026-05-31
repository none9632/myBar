import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"
import { createBinding, createState, onCleanup } from "gnim"
import Battery from "gi://AstalBattery?version=0.1"
import Hyprland from "gi://AstalHyprland?version=0.1"

// Команда для подсчёта доступных обновлений (репозитории + AUR).
const UPDATE_CHECK_CMD = ["bash", "-c", "(checkupdates; yay -Qua) 2>/dev/null | wc -l"]
const UPDATE_INTERVAL = 30 * 60 * 1000 // 30 минут

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

  // Начальное значение: текущая раскладка основной клавиатуры.
  execAsync([
    "bash",
    "-c",
    "hyprctl devices -j | jq -r '[.keyboards[] | select(.main)][0].active_keymap'",
  ])
    .then((s) => setLayout(shortLayout(s.trim())))
    .catch(() => {})

  return (
    <box cssName="kb-layout" spacing={4}>
      <label cssName="kb-icon" label="⌨" />
      <label label={layout} />
    </box>
  )
}

function Updates() {
  const count = createPoll(0, UPDATE_INTERVAL, UPDATE_CHECK_CMD, (out) =>
    parseInt(out.trim(), 10) || 0,
  )

  return (
    <box cssName="updates" spacing={4} visible={count.as((n) => n > 0)}>
      <label cssName="updates-icon" label="" />
      <label label={count.as((n) => `${n}`)} />
    </box>
  )
}

function BatteryWidget() {
  const bat = Battery.get_default()
  if (!bat) return <box />

  const present = createBinding(bat, "isPresent")
  const percentage = createBinding(bat, "percentage")
  const iconName = createBinding(bat, "batteryIconName")

  return (
    <box cssName="battery" spacing={4} visible={present}>
      <image iconName={iconName} />
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

  return (
    <window
      visible
      name="right-panel"
      class="RightPanel"
      gdkmonitor={gdkmonitor}
      exclusivity={Astal.Exclusivity.EXCLUSIVE}
      anchor={TOP | RIGHT}
      resizable={false}
      application={app}
    >
      <box cssName="right-panel-inner" spacing={12}>
        <KbLayout />
        <Updates />
        <BatteryWidget />
        <Clock />
      </box>
    </window>
  )
}
