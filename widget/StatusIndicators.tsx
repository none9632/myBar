import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import { Accessor, createBinding, createComputed, createState, onCleanup, With } from "gnim"
import { createPoll } from "ags/time"
import Network from "gi://AstalNetwork?version=0.1"
import Bluetooth from "gi://AstalBluetooth?version=0.1"
import Wp from "gi://AstalWp?version=0.1"
import { QS_ANIM_MS, QS_MARGIN_TOP } from "./QuickSettings"
import { WifiPage } from "./quicksettings/wifi"
import { BluetoothPage } from "./quicksettings/bluetooth"
import { VpnPage } from "./quicksettings/vpn"
import { vpnIsActivePoll, getActiveVpnId, listVpnProfiles } from "./quicksettings/vpn-config"
import { airplaneEnabledPoll } from "./quicksettings/airplane"

// A bar indicator whose settings open in a small overlay window that drops from
// under the button — built like the Quick Settings panel so it gets the same
// slide+fade on BOTH open and close (a GtkPopover can't animate its close: it
// tears its surface down instantly). A full-screen dismiss layer means Esc /
// clicking outside / clicking the bar all close it. The page is built lazily while
// open (<With> on `mapped`), so per-page side effects — Wi-Fi scan, Bluetooth
// discovery — start on open and stop on close.
function IndicatorMenu(props: {
  name: string
  icon: string | Accessor<string>
  tooltip?: string | Accessor<string>
  visible?: Accessor<boolean>
  content: () => JSX.Element
  gdkmonitor: Gdk.Monitor
}) {
  const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

  // `mapped` keeps the window shown while the card animates; `revealed` drives the
  // slide+fade. Splitting them lets the close animation play before the window
  // unmaps — same machinery as QuickSettings.tsx. `cardLeft` positions the card
  // centred under the button.
  const [mapped, setMapped] = createState(false)
  const [revealed, setRevealed] = createState(false)
  const [cardLeft, setCardLeft] = createState(0)
  let isOpen = false
  let closeTimer = 0
  let btn: Gtk.Widget | null = null
  // Card width, to centre it on the button. An estimate (detail-page min-width 320
  // + 14px padding each side) until the card is first allocated, then its real
  // measured width (see the card's tick callback). `openCenter` is captured at open
  // so a width correction mid-open re-centres around the same point.
  let cardWidth = 348
  let openCenter = 0

  // Screen-x of the button's centre. The bar window is anchored to the right, so its
  // left edge sits at (monitor width − bar width); add the button's centre within
  // the bar. All in GTK logical px, which is what marginStart wants.
  function buttonCenterX(): number {
    const root = btn?.get_root()
    if (!btn || !root) return openCenter
    const [ok, b] = btn.compute_bounds(root)
    if (!ok) return openCenter
    return (
      props.gdkmonitor.get_geometry().width - root.get_width() + b.get_x() + b.get_width() / 2
    )
  }

  function open() {
    isOpen = true
    if (closeTimer) {
      GLib.source_remove(closeTimer)
      closeTimer = 0
    }
    openCenter = buttonCenterX()
    setCardLeft(openCenter - cardWidth / 2)
    setMapped(true)
    // Let the window map first; revealing in the same frame snaps.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
      if (isOpen) setRevealed(true)
      return GLib.SOURCE_REMOVE
    })
  }

  function close() {
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

  // The overlay window (self-registers via application={app}), mirroring the Quick
  // Settings panel: a full-screen dismiss area + a Revealer that slides the card
  // down from under the bar.
  ;(
    <window
      visible={mapped}
      name={`indicator-${props.name}`}
      // No custom namespace: fall under the default "gtk4-layer-shell" so Hyprland's
      // blur layer-rule (which matches that namespace) applies, like the bar itself.
      class="IndicatorMenu"
      gdkmonitor={props.gdkmonitor}
      anchor={TOP | BOTTOM | LEFT | RIGHT}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.EXCLUSIVE}
      layer={Astal.Layer.OVERLAY}
      application={app}
    >
      <Gtk.EventControllerKey
        onKeyPressed={(_self, keyval) => {
          if (keyval === Gdk.KEY_Escape) close()
          return false
        }}
      />
      <overlay>
        {/* Main child: full-screen dismiss area. */}
        <box>
          <Gtk.GestureClick onPressed={() => close()} />
        </box>
        {/* Overlay child: the card, dropping straight under the button. */}
        <revealer
          $type="overlay"
          halign={Gtk.Align.START}
          valign={Gtk.Align.START}
          marginStart={cardLeft}
          marginTop={QS_MARGIN_TOP}
          revealChild={revealed}
          transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
          transitionDuration={QS_ANIM_MS}
        >
          <box
            cssName="indicator-menu-card"
            class={revealed.as((r) => (r ? "shown" : ""))}
            $={(self: Gtk.Widget) => {
              // Measure the real card width once allocated and re-centre on the
              // button (still invisible behind the fade, so no visible jump). The
              // width is stable per page, so stop ticking after the first reading.
              self.add_tick_callback(() => {
                const w = self.get_width()
                if (w <= 0) return GLib.SOURCE_CONTINUE
                if (w !== cardWidth) {
                  cardWidth = w
                  if (isOpen) setCardLeft(openCenter - w / 2)
                }
                return GLib.SOURCE_REMOVE
              })
            }}
          >
            <With value={mapped}>{(m) => (m ? props.content() : <box />)}</With>
          </box>
        </revealer>
      </overlay>
    </window>
  )

  return (
    <button
      visible={props.visible}
      tooltipText={props.tooltip}
      onClicked={() => (isOpen ? close() : open())}
      $={(self: Gtk.Widget) => {
        btn = self
      }}
    >
      <image iconName={props.icon} />
    </button>
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
    <box cssName="status-indicators" spacing={3}>
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
      {/* Bluetooth: filled icon when a device is connected. */}
      <IndicatorMenu
        name="bluetooth"
        icon={btConnected.as((c) => (c ? "bluetooth-active-symbolic" : "bluetooth-symbolic"))}
        tooltip={btTooltip}
        visible={btPowered.as((p) => !!p)}
        content={() => <BluetoothPage />}
        gdkmonitor={props.gdkmonitor}
      />
      {/* VPN (sing-box) running. */}
      <IndicatorMenu
        name="vpn"
        icon="network-vpn-symbolic"
        tooltip={vpnTooltip}
        visible={vpnActive}
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
