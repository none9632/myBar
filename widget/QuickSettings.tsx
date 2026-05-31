import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { execAsync } from "ags/process"
import { Accessor, createBinding, createState } from "gnim"
import Network from "gi://AstalNetwork?version=0.1"
import Bluetooth from "gi://AstalBluetooth?version=0.1"
import Wp from "gi://AstalWp?version=0.1"
import PowerProfiles from "gi://AstalPowerProfiles?version=0.1"

type MaybeAccessor<T> = T | Accessor<T>

// ── Reusable toggle button ────────────────────────────────────────────────────

function Toggle(props: {
  icon: MaybeAccessor<string>
  label: MaybeAccessor<string>
  sublabel?: MaybeAccessor<string>
  active: Accessor<boolean>
  onClicked: () => void
}) {
  return (
    <button
      cssName="qs-toggle"
      hexpand
      class={props.active.as((a) => (a ? "active" : ""))}
      onClicked={props.onClicked}
    >
      <box spacing={10} halign={Gtk.Align.START}>
        <image cssName="qs-toggle-icon" iconName={props.icon} />
        <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER}>
          <label cssName="qs-toggle-label" halign={Gtk.Align.START} label={props.label} />
          {props.sublabel !== undefined ? (
            <label
              cssName="qs-toggle-sublabel"
              halign={Gtk.Align.START}
              ellipsize={Pango.EllipsizeMode.END}
              maxWidthChars={14}
              label={props.sublabel}
            />
          ) : null}
        </box>
      </box>
    </button>
  )
}

// ── Slider ────────────────────────────────────────────────────────────────────

function ControlSlider(props: {
  icon: MaybeAccessor<string>
  value: Accessor<number>
  onChange: (value: number) => void
}) {
  return (
    <box cssName="qs-slider" spacing={10}>
      <image cssName="qs-slider-icon" iconName={props.icon} halign={Gtk.Align.START} />
      <slider
        cssName="qs-scale"
        hexpand
        value={props.value}
        min={0}
        max={1}
        step={0.01}
        onChangeValue={(_self, _scroll, value) => {
          props.onChange(value)
          return false
        }}
      />
      <label
        cssName="qs-slider-value"
        halign={Gtk.Align.END}
        label={props.value.as((v) => `${Math.round(v * 100)}%`)}
      />
    </box>
  )
}

// ── Wi-Fi ─────────────────────────────────────────────────────────────────────

function WifiToggle() {
  const net = Network.get_default()
  // net.wifi is populated asynchronously, so we bind to the nested properties.
  const enabled = createBinding(net, "wifi", "enabled")
  const ssid = createBinding(net, "wifi", "ssid")
  return (
    <Toggle
      icon="network-wireless-symbolic"
      label={enabled.as((e) => (e ? "Enabled" : "Disabled"))}
      sublabel={ssid.as((s) => s || "Not connected")}
      active={enabled.as((e) => !!e)}
      onClicked={() => {
        const wifi = net.wifi
        if (wifi) wifi.set_enabled(!wifi.enabled)
      }}
    />
  )
}

// ── Bluetooth ─────────────────────────────────────────────────────────────────

function BluetoothToggle() {
  const bt = Bluetooth.get_default()
  const powered = createBinding(bt, "isPowered")
  const connected = createBinding(bt, "devices").as((ds) => {
    const dev = ds.find((d) => d.connected)
    return dev ? dev.name : "Not connected"
  })
  return (
    <Toggle
      icon="bluetooth-symbolic"
      label={powered.as((p) => (p ? "Enabled" : "Disabled"))}
      sublabel={connected}
      active={powered}
      onClicked={() => bt.toggle()}
    />
  )
}

// ── Microphone ────────────────────────────────────────────────────────────────

function MicToggle() {
  const wp = Wp.get_default()
  const mic = wp?.defaultMicrophone
  if (!mic) {
    return (
      <Toggle
        icon="microphone-disabled-symbolic"
        label="No Microphone"
        active={new Accessor(() => false)}
        onClicked={() => {}}
      />
    )
  }

  const muted = createBinding(mic, "mute")
  return (
    <Toggle
      icon={muted.as((m) =>
        m ? "microphone-disabled-symbolic" : "audio-input-microphone-symbolic",
      )}
      label={muted.as((m) => (m ? "Disabled" : "Enabled"))}
      active={muted.as((m) => !m)}
      onClicked={() => (mic.mute = !mic.mute)}
    />
  )
}

// ── Power profile ─────────────────────────────────────────────────────────────

function PowerToggle() {
  const pp = PowerProfiles.get_default()
  const profile = createBinding(pp, "activeProfile")
  const isPerf = profile.as((p) => p === "performance")
  return (
    <Toggle
      icon={isPerf.as((p) =>
        p ? "power-profile-performance-symbolic" : "power-profile-balanced-symbolic",
      )}
      label={isPerf.as((p) => (p ? "Performance" : "Balanced"))}
      active={isPerf}
      onClicked={() => {
        pp.activeProfile = pp.activeProfile === "performance" ? "balanced" : "performance"
      }}
    />
  )
}

// ── Volume slider ─────────────────────────────────────────────────────────────

function VolumeSlider() {
  const wp = Wp.get_default()
  const speaker = wp?.defaultSpeaker
  if (!speaker) return <box />

  const volume = createBinding(speaker, "volume")
  const icon = createBinding(speaker, "volumeIcon")
  return (
    <ControlSlider icon={icon} value={volume} onChange={(v) => (speaker.volume = v)} />
  )
}

// ── Brightness slider ─────────────────────────────────────────────────────────

function BrightnessSlider() {
  const [brightness, setBrightness] = createState(0.5)

  // Initial value from brightnessctl (4th field: "75%").
  execAsync(["bash", "-c", "brightnessctl -m | cut -d, -f4 | tr -d '%'"])
    .then((s) => {
      const pct = parseInt(s.trim(), 10)
      if (!isNaN(pct)) setBrightness(pct / 100)
    })
    .catch(() => {})

  return (
    <ControlSlider
      icon="display-brightness-symbolic"
      value={brightness}
      onChange={(v) => {
        setBrightness(v)
        execAsync(["brightnessctl", "set", `${Math.round(v * 100)}%`]).catch(() => {})
      }}
    />
  )
}

// ── Compose ───────────────────────────────────────────────────────────────────

function QuickSettingsContent() {
  return (
    <box cssName="quick-settings" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box cssName="qs-toggles" spacing={8} homogeneous>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <WifiToggle />
          <MicToggle />
        </box>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <BluetoothToggle />
          <PowerToggle />
        </box>
      </box>

      <box cssName="qs-sliders" orientation={Gtk.Orientation.VERTICAL} spacing={10}>
        <BrightnessSlider />
        <VolumeSlider />
      </box>
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

  return (
    <window
      visible={props.visible}
      name="quick-settings"
      namespace="quick-settings"
      class="QuickSettings"
      gdkmonitor={props.gdkmonitor}
      anchor={TOP | BOTTOM | LEFT | RIGHT}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      layer={Astal.Layer.OVERLAY}
      application={app}
    >
      {/* Full-screen dismiss layer: a click outside the content closes it. */}
      <box>
        <Gtk.EventControllerKey
          onKeyPressed={(_self, keyval) => {
            if (keyval === Gdk.KEY_Escape) props.close()
            return false
          }}
        />
        <Gtk.GestureClick onPressed={() => props.close()} />
        <box
          cssName="quick-settings-wrapper"
          halign={Gtk.Align.END}
          valign={Gtk.Align.START}
          marginTop={QS_MARGIN_TOP}
          marginEnd={QS_MARGIN_RIGHT}
        >
          {/* Clicks inside the content must not bubble to the dismiss layer. */}
          <Gtk.GestureClick
            onPressed={(gesture) => gesture.set_state(Gtk.EventSequenceState.CLAIMED)}
          />
          <QuickSettingsContent />
        </box>
      </box>
    </window>
  )
}
