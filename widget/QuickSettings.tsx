import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import { createState, With } from "gnim"
import { WifiToggle, WifiPage } from "./quicksettings/wifi"
import { BluetoothToggle, BluetoothPage } from "./quicksettings/bluetooth"
import { VpnToggle, VpnPage } from "./quicksettings/vpn"
import { MicToggle, VolumeSlider } from "./quicksettings/audio"
import { PowerToggle, BrightnessSlider } from "./quicksettings/system"
import { AirplaneToggle } from "./quicksettings/airplane"
import { HardwareInfo } from "./quicksettings/hardware"

// ── Compose ───────────────────────────────────────────────────────────────────

function QuickSettingsContent(props: {
  onWifiClick: () => void
  onBluetoothClick: () => void
  onVpnClick: () => void
  onClose: () => void
}) {
  return (
    <box cssName="quick-settings" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box cssName="qs-toggles" spacing={8} homogeneous>
        {/* Left column: Wi-Fi, Bluetooth, Power. Right column: VPN (next to
            Wi-Fi), Microphone. */}
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <WifiToggle onClick={props.onWifiClick} />
          <BluetoothToggle onClick={props.onBluetoothClick} />
          <PowerToggle />
        </box>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <VpnToggle onClick={props.onVpnClick} />
          <MicToggle />
          <AirplaneToggle />
        </box>
      </box>

      <box cssName="qs-sliders" orientation={Gtk.Orientation.VERTICAL} spacing={10}>
        <BrightnessSlider />
        <VolumeSlider />
      </box>

      <HardwareInfo onClose={props.onClose} />
    </box>
  )
}

// ── Pinned overlay window ─────────────────────────────────────────────────────

// Where the Quick Settings panel sits relative to the bar. Keep BAR_INSET and
// BAR_HEIGHT in sync with the right panel in styles/base/_panels.scss (the
// `margin` on *-panel-inner and $bar-height) — QS_GAP is the one knob you normally touch.
const BAR_INSET = 10 // = margin on *-panel-inner
const BAR_HEIGHT = 32 // = $bar-height
const QS_GAP = 10 // gap between the bottom of the bar and the panel

const QS_MARGIN_RIGHT = BAR_INSET // right edge aligned with the bar
// Below the bar + the gap. Exported so the status-indicator menus drop to the same
// height with the same gap.
export const QS_MARGIN_TOP = BAR_INSET + BAR_HEIGHT + QS_GAP

// Open/close slide duration (kept in sync with the Revealer below). Exported so
// the bar's status-indicator popovers animate with the same timing.
export const QS_ANIM_MS = 250

// Shared open state, animated. The window must stay mapped while the panel slides
// out, so intent is split in two: `mapped` shows the window, `revealed` drives the
// Revealer. Opening maps then reveals (next tick, so the Revealer actually
// animates instead of snapping); closing un-reveals, then unmaps once the slide
// has finished. The qs-button, Escape, and `ags request quicksettings` all go
// through these, so every entry point stays in sync.
const [mapped, setMapped] = createState(false)
const [revealed, setRevealed] = createState(false)

let isOpen = false
let closeTimer = 0

export function openQs() {
  isOpen = true
  if (closeTimer) {
    GLib.source_remove(closeTimer)
    closeTimer = 0
  }
  setMapped(true)
  // Let the window/Revealer map first; revealing in the same frame snaps.
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
    if (isOpen) setRevealed(true)
    return GLib.SOURCE_REMOVE
  })
}

export function closeQs() {
  isOpen = false
  setRevealed(false)
  if (closeTimer) GLib.source_remove(closeTimer)
  // Unmap only after the slide-out has played.
  closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QS_ANIM_MS, () => {
    if (!isOpen) setMapped(false)
    closeTimer = 0
    return GLib.SOURCE_REMOVE
  })
}

export const toggleQs = () => (isOpen ? closeQs() : openQs())

export default function QuickSettingsWindow(props: { gdkmonitor: Gdk.Monitor }) {
  const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
  const [page, setPage] = createState<"main" | "wifi" | "bluetooth" | "vpn">("main")

  // Closing slides the panel out (closeQs). Reset to the main page only once the
  // window is fully unmapped, so the slide-out shows the current page instead of
  // flipping to main mid-animation.
  function closeAll() {
    closeQs()
  }
  mapped.subscribe(() => {
    if (!mapped.peek()) setPage("main")
  })

  return (
    <window
      visible={mapped}
      name="quick-settings"
      namespace="quick-settings"
      class="QuickSettings"
      gdkmonitor={props.gdkmonitor}
      anchor={TOP | BOTTOM | LEFT | RIGHT}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.EXCLUSIVE}
      layer={Astal.Layer.OVERLAY}
      application={app}
    >
      {/* Key controller on the window itself so Escape is received regardless of
          which inner widget holds focus. CAPTURE phase is essential: a focused
          entry (Wi-Fi password / VPN add field) swallows Escape in the bubble
          phase, so we must intercept it on the way down. */}
      <Gtk.EventControllerKey
        propagationPhase={Gtk.PropagationPhase.CAPTURE}
        onKeyPressed={(_self, keyval) => {
          if (keyval === Gdk.KEY_Escape) {
            // On a detail page Escape goes back to main; on main it closes.
            if (page.peek() !== "main") setPage("main")
            else closeAll()
            return true
          }
          return false
        }}
      />
      {/*
        Overlay keeps the dismiss area and the content in separate input
        chains: clicks on the content reach its buttons normally, clicks on
        the exposed background close the overlay.
      */}
      <overlay>
        {/* Main child: full-screen dismiss area. */}
        <box>
          <Gtk.GestureClick onPressed={() => closeAll()} />
        </box>
        {/* Overlay child: the pinned settings panel, in a Revealer so it slides
            down from under the bar on open and back up on close. */}
        <revealer
          $type="overlay"
          halign={Gtk.Align.END}
          valign={Gtk.Align.START}
          marginTop={QS_MARGIN_TOP}
          marginEnd={QS_MARGIN_RIGHT}
          revealChild={revealed}
          transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
          transitionDuration={QS_ANIM_MS}
        >
          <box
            cssName="quick-settings-wrapper"
            class={revealed.as((r) => (r ? "shown" : ""))}
          >
            <With value={page}>
              {(p) =>
                p === "wifi" ? (
                  <WifiPage onBack={() => setPage("main")} />
                ) : p === "bluetooth" ? (
                  <BluetoothPage onBack={() => setPage("main")} />
                ) : p === "vpn" ? (
                  <VpnPage onBack={() => setPage("main")} />
                ) : (
                  <QuickSettingsContent
                    onWifiClick={() => setPage("wifi")}
                    onBluetoothClick={() => setPage("bluetooth")}
                    onVpnClick={() => setPage("vpn")}
                    onClose={closeAll}
                  />
                )
              }
            </With>
          </box>
        </revealer>
      </overlay>
    </window>
  )
}
