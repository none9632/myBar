import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"
import {
  Accessor,
  createBinding,
  createComputed,
  createState,
  For,
  With,
  onMount,
} from "gnim"
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

function WifiToggle(props: { onClick: () => void }) {
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
      onClicked={props.onClick}
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

function QuickSettingsContent(props: { onWifiClick: () => void }) {
  return (
    <box cssName="quick-settings" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box cssName="qs-toggles" spacing={8} homogeneous>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <WifiToggle onClick={props.onWifiClick} />
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

// ── Wi-Fi detail page ─────────────────────────────────────────────────────────

function NetworkRow(props: {
  ap: Network.AccessPoint
  activeSsid: Accessor<string | null>
  saved: Accessor<Set<string>>
  expandedRow: Accessor<string | null>
  setExpandedRow: (key: string | null) => void
}) {
  const ssid = props.ap.ssid
  const key = props.ap.bssid
  const icon = createBinding(props.ap, "iconName")
  const isActive = props.activeSsid.as((s) => s !== null && s === ssid)
  // Only one password field may be open at a time (shared at the page level).
  const expanded = props.expandedRow.as((k) => k === key)
  const setExpanded = (open: boolean) => props.setExpandedRow(open ? key : null)
  const [password, setPassword] = createState("")
  const [connecting, setConnecting] = createState(false)
  const [menuOpen, setMenuOpen] = createState(false)
  const [wrongPassword, setWrongPassword] = createState(false)

  // Trailing indicator: spinner while connecting, check when connected, an open
  // padlock for saved secured networks, a closed one for unknown secured ones.
  const status = createComputed(() => {
    if (connecting()) return "connecting"
    if (isActive()) return "connected"
    if (props.ap.requiresPassword) return props.saved().has(ssid ?? "") ? "unlocked" : "locked"
    return "none"
  })

  function connect(pw?: string) {
    if (!ssid) return
    const cmd = pw
      ? ["nmcli", "device", "wifi", "connect", ssid, "password", pw]
      : ["nmcli", "device", "wifi", "connect", ssid]
    setConnecting(true)
    setWrongPassword(false)
    execAsync(cmd)
      .then(() => {
        setConnecting(false)
        setExpanded(false)
        setPassword("")
      })
      .catch((err) => {
        setConnecting(false)
        const msg = String(err)
        // NM reports a queued activation (e.g. switching networks) as an error
        // even though the connection is actually proceeding. Only auto-collapse
        // for a saved/open network; keep the field for a password attempt.
        if (/enqueued/i.test(msg)) {
          if (!pw) {
            setExpanded(false)
            setPassword("")
          }
          return
        }
        // Connection failed → reveal the field to retry.
        if (props.ap.requiresPassword) {
          setExpanded(true)
          // A password was tried and rejected → clear it and flag the mistake.
          if (pw) {
            setWrongPassword(true)
            setPassword("")
          }
        } else {
          console.error("wifi connect:", msg)
        }
      })
  }

  function onClick() {
    if (isActive.peek() || connecting.peek()) return
    // Try saved credentials (or open network) first; the password field is
    // revealed only if the connection attempt fails for a secured network.
    connect()
  }

  function forget() {
    setMenuOpen(false)
    if (!ssid) return
    execAsync(["nmcli", "connection", "delete", ssid]).catch((e) =>
      console.error("forget network:", ssid, "->", e),
    )
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL}>
      <button
        cssName="wifi-row"
        class={isActive.as((a) => (a ? "connected" : ""))}
        onClicked={onClick}
      >
        <Gtk.GestureClick button={3} onPressed={() => setMenuOpen(!menuOpen.peek())} />
        <box spacing={10}>
          <image iconName={icon} />
          <label
            label={ssid || "Hidden network"}
            hexpand
            halign={Gtk.Align.START}
            ellipsize={Pango.EllipsizeMode.END}
          />
          <label cssName="wifi-band" label={props.ap.frequency >= 5000 ? "5 GHz" : "2.4 GHz"} />
          <With value={status}>
            {(s) =>
              s === "connecting" ? (
                <Gtk.Spinner spinning />
              ) : s === "connected" ? (
                <image iconName="object-select-symbolic" />
              ) : s === "unlocked" ? (
                <image cssName="wifi-lock" iconName="changes-allow-symbolic" />
              ) : s === "locked" ? (
                <image cssName="wifi-lock" iconName="changes-prevent-symbolic" />
              ) : (
                <box />
              )
            }
          </With>
        </box>
      </button>

      <revealer revealChild={menuOpen} transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}>
        <box cssName="wifi-menu" orientation={Gtk.Orientation.VERTICAL}>
          <button cssName="wifi-menu-item" onClicked={forget}>
            <box spacing={8}>
              <image iconName="user-trash-symbolic" />
              <label label="Forget network" hexpand halign={Gtk.Align.START} />
            </box>
          </button>
        </box>
      </revealer>

      <revealer revealChild={expanded} transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}>
        <box cssName="wifi-password" spacing={6}>
          <entry
            hexpand
            text={password}
            class={wrongPassword.as((w) => (w ? "error" : ""))}
            placeholderText={wrongPassword.as((w) => (w ? "Wrong password" : "Password"))}
            visibility={false}
            onNotifyText={(self) => {
              setPassword(self.text)
              // Clear the error state as soon as the user types a new password
              // (an empty value here is our own programmatic reset, so ignore it).
              if (self.text !== "") setWrongPassword(false)
            }}
            onActivate={() => connect(password.peek())}
          />
          <button cssName="wifi-connect" onClicked={() => connect(password.peek())}>
            <label label="Connect" />
          </button>
        </box>
      </revealer>
    </box>
  )
}

function WifiPage(props: { onBack: () => void }) {
  const net = Network.get_default()
  const enabled = createBinding(net, "wifi", "enabled")
  const apsBinding = createBinding(net, "wifi", "accessPoints")
  const activeApBinding = createBinding(net, "wifi", "activeAccessPoint")
  const activeSsid = activeApBinding.as((ap) => ap?.ssid ?? null)
  // Key (bssid) of the row whose password field is open — at most one.
  const [expandedRow, setExpandedRow] = createState<string | null>(null)
  // Connected network first, then the rest sorted by signal strength.
  const accessPoints = createComputed(() => {
    const aps = apsBinding()
    const activeBssid = activeApBinding()?.bssid
    return aps
      ? [...aps]
          .filter((ap) => ap.ssid)
          .sort((a, b) => {
            if (a.bssid === activeBssid) return -1
            if (b.bssid === activeBssid) return 1
            return b.strength - a.strength
          })
      : []
  })
  // Names of known Wi-Fi connections that have connected successfully at least
  // once (TIMESTAMP > 0). This excludes profiles left over from a wrong password.
  const savedNetworks = createPoll(
    new Set<string>(),
    5000,
    [
      "bash",
      "-c",
      "nmcli -t -f NAME,TYPE,TIMESTAMP connection show | awk -F: '$2 ~ /wireless/ && $3 > 0 {print $1}'",
    ],
    (out) => new Set(out.split("\n").map((s) => s.trim()).filter(Boolean)),
  )

  // LAN IPv4 of the Wi-Fi device itself (avoids picking up a VPN tunnel address).
  const ip = createPoll("—", 5000, [
    "bash",
    "-c",
    `dev=$(nmcli -t -f DEVICE,TYPE device status | awk -F: '$2=="wifi"{print $1; exit}'); nmcli -g IP4.ADDRESS device show "$dev" | head -1 | cut -d/ -f1`,
  ])

  // Trigger a scan when the page opens.
  onMount(() => net.wifi?.scan())

  return (
    <box cssName="wifi-page" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box cssName="wifi-header" spacing={10}>
        <button cssName="wifi-back" onClicked={props.onBack}>
          <image iconName="go-previous-symbolic" />
        </button>
        <label cssName="wifi-title" label="Wi-Fi" hexpand halign={Gtk.Align.START} />
        {/*
          Custom toggle instead of GtkSwitch: GtkSwitch only flips its
          `:checked` state (the track colour) AFTER the knob finishes its
          hard-coded 100ms slide, so the colour always lagged the knob. Here a
          single `.on`/`.off` class drives both the knob position and the track
          colour, so they animate in lockstep (see style.scss `wifi-switch`).
        */}
        <button
          cssName="wifi-switch"
          valign={Gtk.Align.CENTER}
          class={enabled.as((e) => (e ? "on" : "off"))}
          onClicked={() => {
            const w = net.wifi
            if (w) w.set_enabled(!w.enabled)
          }}
        >
          <box cssName="knob" halign={Gtk.Align.START} valign={Gtk.Align.CENTER} />
        </button>
      </box>

      <scrolledwindow
        cssName="wifi-list"
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        propagateNaturalHeight
        maxContentHeight={300}
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
          <For each={accessPoints} id={(ap) => ap.bssid}>
            {(ap) => (
              <NetworkRow
                ap={ap}
                activeSsid={activeSsid}
                saved={savedNetworks}
                expandedRow={expandedRow}
                setExpandedRow={setExpandedRow}
              />
            )}
          </For>
        </box>
      </scrolledwindow>

      <box cssName="wifi-ip" spacing={8}>
        <image iconName="network-wired-symbolic" />
        <label label="Local IP" hexpand halign={Gtk.Align.START} />
        <label cssName="wifi-ip-value" label={ip.as((s) => s.trim() || "—")} />
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
  const [page, setPage] = createState<"main" | "wifi">("main")

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
            // On the Wi-Fi page Escape goes back; on main it closes.
            if (page.peek() === "wifi") setPage("main")
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
              ) : (
                <QuickSettingsContent onWifiClick={() => setPage("wifi")} />
              )
            }
          </With>
        </box>
      </overlay>
    </window>
  )
}
