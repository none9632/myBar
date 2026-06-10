import { createBinding, createComputed } from "gnim"
import { createPoll } from "ags/time"
import Network from "gi://AstalNetwork?version=0.1"
import Bluetooth from "gi://AstalBluetooth?version=0.1"
import Wp from "gi://AstalWp?version=0.1"
import { vpnIsActivePoll, getActiveVpnId, listVpnProfiles } from "./quicksettings/vpn-config"
import { airplaneEnabledPoll } from "./quicksettings/airplane"

// A row of small symbolic icons in the bar, each shown only while its feature is
// active, so the current radio/audio state is readable at a glance without
// opening Quick Settings. Hovering an icon shows details via a tooltip.
export default function StatusIndicators() {
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
  const btTooltip = createComputed(() => {
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
  const vpnTooltip = vpnServer.as((s) => (s ? `VPN: ${s}` : "VPN connected"))

  const airplane = airplaneEnabledPoll()

  const wp = Wp.get_default()
  const mic = wp?.defaultMicrophone
  const micMuted = mic ? createBinding(mic, "mute") : null

  return (
    <box cssName="status-indicators" spacing={6}>
      {/* Wi-Fi: disabled (crossed) / connecting (dots) / connected (signal bars). */}
      <image iconName={wifiIcon} visible={wifiExists} tooltipText={wifiTooltip} />
      {/* Bluetooth: filled icon when a device is connected. */}
      <image
        iconName={btConnected.as((c) => (c ? "bluetooth-active-symbolic" : "bluetooth-symbolic"))}
        visible={btPowered.as((p) => !!p)}
        tooltipText={btTooltip}
      />
      {/* VPN (sing-box) running. */}
      <image iconName="network-vpn-symbolic" visible={vpnActive} tooltipText={vpnTooltip} />
      {/* Airplane mode on (also implies Wi-Fi/BT are off above). */}
      <image
        iconName="airplane-mode-symbolic"
        visible={airplane}
        tooltipText="Airplane mode on"
      />
      {/* Microphone muted. */}
      {micMuted ? (
        <image
          iconName="microphone-disabled-symbolic"
          visible={micMuted}
          tooltipText="Microphone muted"
        />
      ) : null}
    </box>
  )
}
