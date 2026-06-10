import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { Accessor, createState, With } from "gnim"
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

// Right edge inset: same as the right panel's margin.
const QS_MARGIN_RIGHT = 8
// Top inset: panel top margin (8) + panel height (~32) + 4px gap below the panel.
const QS_MARGIN_TOP = 44

export default function QuickSettingsWindow(props: {
  gdkmonitor: Gdk.Monitor
  visible: Accessor<boolean>
  close: () => void
}) {
  const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
  const [page, setPage] = createState<"main" | "wifi" | "bluetooth" | "vpn">("main")

  // Fully close the overlay and reset to the main page for next time.
  function closeAll() {
    setPage("main")
    props.close()
  }

  return (
    <window
      visible={props.visible}
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
      {/* Key controller on the window itself so Escape is received regardless
          of which inner widget (if any) holds focus. */}
      <Gtk.EventControllerKey
        onKeyPressed={(_self, keyval) => {
          if (keyval === Gdk.KEY_Escape) {
            // On a detail page Escape goes back to main; on main it closes.
            if (page.peek() !== "main") setPage("main")
            else closeAll()
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
        {/* Overlay child: the pinned settings panel. */}
        <box
          $type="overlay"
          cssName="quick-settings-wrapper"
          halign={Gtk.Align.END}
          valign={Gtk.Align.START}
          marginTop={QS_MARGIN_TOP}
          marginEnd={QS_MARGIN_RIGHT}
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
      </overlay>
    </window>
  )
}
