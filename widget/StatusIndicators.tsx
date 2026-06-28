import { Gdk } from "ags/gtk4"
import { Accessor, createBinding, createComputed } from "gnim"
import { createPoll } from "ags/time"
import Network from "gi://AstalNetwork?version=0.1"
import Bluetooth from "gi://AstalBluetooth?version=0.1"
import Wp from "gi://AstalWp?version=0.1"
import BarMenu from "./BarMenu"
import { WifiPage } from "./quicksettings/wifi"
import { BluetoothPage } from "./quicksettings/bluetooth"
import { VpnPage } from "./quicksettings/vpn"
import { vpnIsActivePoll, getActiveVpnId, listVpnProfiles } from "./quicksettings/vpn-config"
import { airplaneEnabledPoll } from "./quicksettings/airplane"

// A bar indicator whose settings open in a card under the icon. Thin wrapper over
// BarMenu (the shared overlay-window menu): the icon is the trigger button, the
// page is the menu content.
function IndicatorMenu(props: {
  name: string
  icon: string | Accessor<string>
  tooltip?: string | Accessor<string>
  visible?: Accessor<boolean>
  content: () => JSX.Element
  gdkmonitor: Gdk.Monitor
}) {
  return (
    <BarMenu
      name={props.name}
      gdkmonitor={props.gdkmonitor}
      // Tag each trigger with its name so it can be styled on its own (see the
      // `status-indicators button.<name>` rules in style.scss).
      buttonClass={props.name}
      tooltip={props.tooltip}
      visible={props.visible}
      content={props.content}
      button={<image iconName={props.icon} />}
    />
  )
}

// A row of small symbolic buttons in the bar. Wi-Fi/Bluetooth/VPN each open their
// settings in a popover under the button; the microphone toggles mute in place.
// They double as at-a-glance state (the icon reflects the live state) and
// shortcuts. Hovering a button shows details via a tooltip.
export default function StatusIndicators(props: { gdkmonitor: Gdk.Monitor }) {
  const net = Network.get_default()
  // net.wifi is populated asynchronously, so bind to the nested properties.
  const wifiExists = createBinding(net, "wifi").as((w) => w != null)
  const wifiEnabled = createBinding(net, "wifi", "enabled")
  // Drive the icon off the device state (NM device state), not wifi.iconName:
  // the latter mirrors NM's connectivity check and shows a "no-route" (?) glyph
  // when NM deems the link "limited" (common behind a VPN/firewall) even though
  // Wi-Fi works. DeviceState is pure: ACTIVATED = connected, prepare…secondaries
  // = connecting.
  const wifiState = createBinding(net, "wifi", "state")
  const wifiStrength = createBinding(net, "wifi", "strength")
  const wifiSsid = createBinding(net, "wifi", "ssid")
  const wifiIcon = createComputed(() => {
    if (!wifiEnabled()) return "network-wireless-disabled-symbolic"
    const st = wifiState()
    if (st === Network.DeviceState.ACTIVATED) {
      const s = wifiStrength()
      if (s >= 80) return "network-wireless-signal-excellent-symbolic"
      if (s >= 55) return "network-wireless-signal-good-symbolic"
      if (s >= 30) return "network-wireless-signal-ok-symbolic"
      if (s > 0) return "network-wireless-signal-weak-symbolic"
      return "network-wireless-signal-none-symbolic"
    }
    if (st >= Network.DeviceState.PREPARE && st <= Network.DeviceState.SECONDARIES) {
      return "network-wireless-acquiring-symbolic"
    }
    return "network-wireless-offline-symbolic"
  })
  const wifiTooltip = createComputed(() => {
    if (!wifiEnabled()) return "Wi-Fi: off"
    const st = wifiState()
    if (st === Network.DeviceState.ACTIVATED) {
      return `Wi-Fi: ${wifiSsid() || "connected"} (${wifiStrength()}%)`
    }
    if (st >= Network.DeviceState.PREPARE && st <= Network.DeviceState.SECONDARIES) {
      return "Wi-Fi: connecting…"
    }
    return "Wi-Fi: not connected"
  })

  const bt = Bluetooth.get_default()
  const btPowered = createBinding(bt, "isPowered")
  const btDevices = createBinding(bt, "devices")
  const btConnected = btDevices.as((ds) => ds.some((d) => d.connected))
  // Off (crossed) / on but no device / connected (filled).
  const btIcon = createComputed(() => {
    if (!btPowered()) return "bluetooth-disabled-symbolic"
    return btConnected() ? "bluetooth-active-symbolic" : "bluetooth-symbolic"
  })
  const btTooltip = createComputed(() => {
    if (!btPowered()) return "Bluetooth: off"
    const names = btDevices()
      .filter((d) => d.connected)
      .map((d) => d.alias || d.name)
    return names.length ? `Bluetooth: ${names.join(", ")}` : "Bluetooth: on (no device)"
  })

  const vpnActive = vpnIsActivePoll()
  // Active profile's server IP for the VPN tooltip (read straight from files).
  const vpnServer = createPoll("", 2000, () => {
    const id = getActiveVpnId()
    if (!id) return ""
    return listVpnProfiles().find((p) => p.id === id)?.outbound.server ?? ""
  })
  const vpnTooltip = createComputed(() => {
    if (!vpnActive()) return "VPN: off"
    const s = vpnServer()
    return s ? `VPN: ${s}` : "VPN connected"
  })

  const airplane = airplaneEnabledPoll()

  const wp = Wp.get_default()
  const mic = wp?.defaultMicrophone
  const micMuted = mic ? createBinding(mic, "mute") : null

  return (
    <box cssName="status-indicators">
      {/* Wi-Fi: disabled (crossed) / connecting (dots) / connected (signal bars).
          Click opens the Wi-Fi settings popover under the button. */}
      <IndicatorMenu
        name="wifi"
        icon={wifiIcon}
        tooltip={wifiTooltip}
        visible={wifiExists}
        content={() => <WifiPage />}
        gdkmonitor={props.gdkmonitor}
      />
      {/* Bluetooth: always shown; icon reflects off / on / connected. */}
      <IndicatorMenu
        name="bluetooth"
        icon={btIcon}
        tooltip={btTooltip}
        content={() => <BluetoothPage />}
        gdkmonitor={props.gdkmonitor}
      />
      {/* VPN (sing-box): always shown; the icon reflects connected/disconnected. */}
      <IndicatorMenu
        name="vpn"
        icon={vpnActive.as((a) =>
          a ? "network-vpn-symbolic" : "network-vpn-disconnected-symbolic",
        )}
        tooltip={vpnTooltip}
        content={() => <VpnPage />}
        gdkmonitor={props.gdkmonitor}
      />
      {/* Airplane mode on (also implies Wi-Fi/BT are off above). */}
      <image
        iconName="airplane-mode-symbolic"
        visible={airplane}
        tooltipText="Airplane mode on"
      />
      {/* Microphone: always shown when a mic exists; click toggles mute and the
          icon flips between active and disabled. */}
      {micMuted && mic ? (
        <button
          class="mic"
          tooltipText={micMuted.as((m) => (m ? "Microphone muted" : "Microphone on"))}
          onClicked={() => (mic.mute = !mic.mute)}
        >
          <image
            iconName={micMuted.as((m) =>
              m ? "microphone-disabled-symbolic" : "audio-input-microphone-symbolic",
            )}
          />
        </button>
      ) : null}
    </box>
  )
}
