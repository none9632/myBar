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
  onCleanup,
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

// ── Reusable on/off switch ──────────────────────────────────────────────────
// A styled button rather than GtkSwitch: GtkSwitch flips its `:checked` colour
// only after the knob finishes sliding, which desynced the colour from the knob.
// Here a single `.on`/`.off` class drives both, so they animate in lockstep (see
// style.scss `toggle-switch`).
function ToggleSwitch(props: { active: Accessor<boolean>; onToggle: () => void }) {
  return (
    <button
      cssName="toggle-switch"
      valign={Gtk.Align.CENTER}
      class={props.active.as((a) => (a ? "on" : "off"))}
      onClicked={props.onToggle}
    >
      <box cssName="knob" halign={Gtk.Align.START} valign={Gtk.Align.CENTER} />
    </button>
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

function BluetoothToggle(props: { onClick: () => void }) {
  const bt = Bluetooth.get_default()
  const powered = createBinding(bt, "isPowered")
  const connected = createBinding(bt, "devices").as((ds) => {
    const dev = ds.find((d) => d.connected)
    return dev ? dev.alias || dev.name : "Not connected"
  })
  return (
    <Toggle
      icon="bluetooth-symbolic"
      label={powered.as((p) => (p ? "Enabled" : "Disabled"))}
      sublabel={connected}
      active={powered}
      onClicked={props.onClick}
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

function QuickSettingsContent(props: {
  onWifiClick: () => void
  onBluetoothClick: () => void
}) {
  return (
    <box cssName="quick-settings" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box cssName="qs-toggles" spacing={8} homogeneous>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <WifiToggle onClick={props.onWifiClick} />
          <MicToggle />
        </box>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <BluetoothToggle onClick={props.onBluetoothClick} />
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
        cssName="detail-row"
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
          <label cssName="detail-badge" label={props.ap.frequency >= 5000 ? "5 GHz" : "2.4 GHz"} />
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
        <box cssName="row-menu" orientation={Gtk.Orientation.VERTICAL}>
          <button cssName="row-menu-item" onClicked={forget}>
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
    <box cssName="detail-page" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box cssName="detail-header" spacing={10}>
        <button cssName="detail-back" onClicked={props.onBack}>
          <image iconName="go-previous-symbolic" />
        </button>
        <label cssName="detail-title" label="Wi-Fi" hexpand halign={Gtk.Align.START} />
        <ToggleSwitch
          active={enabled.as((e) => !!e)}
          onToggle={() => {
            const w = net.wifi
            if (w) w.set_enabled(!w.enabled)
          }}
        />
      </box>

      <scrolledwindow
        cssName="detail-list"
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

// ── Bluetooth detail page ─────────────────────────────────────────────────────

// BlueZ reports a full-colour icon name (e.g. "audio-headset"). GTK only
// recolours *symbolic* icons via `color`, so a full-colour glyph keeps its own
// (light) colour and blends into the accent background once the row is
// connected. Prefer the "-symbolic" variant when the theme ships one, falling
// back to the plain name, and to a generic bluetooth glyph when there is none.
function symbolicIcon(name: string | null): string {
  const base = name || "bluetooth"
  const symbolic = `${base}-symbolic`
  const display = Gdk.Display.get_default()
  if (display && Gtk.IconTheme.get_for_display(display).has_icon(symbolic)) {
    return symbolic
  }
  return base
}

function BluetoothDeviceRow(props: { device: Bluetooth.Device }) {
  const dev = props.device
  const connected = createBinding(dev, "connected")
  const connecting = createBinding(dev, "connecting")
  const name = createBinding(dev, "alias") // alias falls back to the device name
  const icon = createBinding(dev, "icon")
  const batteryPercentage = createBinding(dev, "batteryPercentage")
  // BlueZ stops updating battery-percentage on disconnect but keeps reporting
  // the last value, so the badge would otherwise linger. Only surface it while
  // the device is actually connected.
  const battery = createComputed(() => (connected() ? batteryPercentage() : -1))
  const [menuOpen, setMenuOpen] = createState(false)
  // Set briefly when a connection attempt fails, to flag it in the UI.
  const [failed, setFailed] = createState(false)

  // Trailing indicator: spinner while connecting, a check once connected, a
  // warning icon for a short while after a failed attempt.
  const status = createComputed(() => {
    if (connecting()) return "connecting"
    if (connected()) return "connected"
    if (failed()) return "failed"
    return "none"
  })

  function onClick() {
    if (connecting.peek()) return
    // These GIO async methods aren't promisified at runtime, so they must be
    // called with a callback (passing none throws). connect_device() pairs as
    // needed; disconnect_device() drops all profiles. The *_finish() call throws
    // on failure (e.g. a powered-off device), which we catch and log.
    if (connected.peek()) {
      dev.disconnect_device((_d, res) => {
        try {
          dev.disconnect_device_finish(res)
        } catch (e) {
          console.error("bluetooth disconnect:", dev.address, "->", String(e))
        }
      })
    } else {
      setFailed(false)
      dev.connect_device((_d, res) => {
        try {
          dev.connect_device_finish(res)
        } catch (e) {
          console.error("bluetooth connect:", dev.address, "->", String(e))
          setFailed(true)
          // Clear the warning after a few seconds so it doesn't linger.
          setTimeout(() => setFailed(false), 4000)
        }
      })
    }
  }

  function forget() {
    setMenuOpen(false)
    Bluetooth.get_default().adapter?.remove_device(dev)
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL}>
      <button
        cssName="detail-row"
        class={connected.as((c) => (c ? "connected" : ""))}
        onClicked={onClick}
      >
        {/* Right-click a paired device to forget it. */}
        <Gtk.GestureClick
          button={3}
          onPressed={() => {
            if (dev.paired) setMenuOpen(!menuOpen.peek())
          }}
        />
        <box spacing={10}>
          <image iconName={icon.as(symbolicIcon)} />
          <label
            label={name.as((n) => n || "Unknown device")}
            hexpand
            halign={Gtk.Align.START}
            ellipsize={Pango.EllipsizeMode.END}
          />
          {/* Static wrapper: a re-rendered <With> appends its new widget to the
              END of its parent, so without this the (delayed) battery badge
              would land to the right of the status indicator. Pinned here, it
              always sits just left of the status slot. */}
          <box valign={Gtk.Align.CENTER}>
            <With value={battery}>
              {(b) =>
                b >= 0 ? (
                  <label cssName="detail-badge" label={`${Math.round(b * 100)}%`} />
                ) : (
                  <box />
                )
              }
            </With>
          </box>
          {/* Fixed-size slot so spinner → check swap in place without nudging
              the row; the battery badge then appears to its left. */}
          <box cssName="detail-status" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}>
            <With value={status}>
              {(s) =>
                s === "connecting" ? (
                  <Gtk.Spinner spinning />
                ) : s === "connected" ? (
                  <image iconName="object-select-symbolic" />
                ) : s === "failed" ? (
                  <image cssName="detail-error" iconName="dialog-warning-symbolic" />
                ) : (
                  <box />
                )
              }
            </With>
          </box>
        </box>
      </button>

      <revealer revealChild={menuOpen} transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}>
        <box cssName="row-menu" orientation={Gtk.Orientation.VERTICAL}>
          <button cssName="row-menu-item" onClicked={forget}>
            <box spacing={8}>
              <image iconName="user-trash-symbolic" />
              <label label="Forget device" hexpand halign={Gtk.Align.START} />
            </box>
          </button>
        </box>
      </revealer>
    </box>
  )
}

// A titled group of devices. The header (and the whole group) is hidden while
// the group is empty, so an unused section leaves no stray label behind.
function DeviceSection(props: { title: string; devices: Accessor<Bluetooth.Device[]> }) {
  return (
    <With value={props.devices.as((d) => d.length > 0)}>
      {(hasAny) =>
        hasAny ? (
          <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            <label cssName="detail-section" label={props.title} halign={Gtk.Align.START} />
            <For each={props.devices} id={(d) => d.address}>
              {(d) => <BluetoothDeviceRow device={d} />}
            </For>
          </box>
        ) : (
          <box />
        )
      }
    </With>
  )
}

function BluetoothPage(props: { onBack: () => void }) {
  const bt = Bluetooth.get_default()
  const powered = createBinding(bt, "isPowered")
  const devicesBinding = createBinding(bt, "devices")
  // Split into devices we've paired with before vs. freshly discovered ones.
  // Paired group: connected first, then by name. Available group: by name.
  const paired = devicesBinding.as((ds) =>
    [...ds]
      .filter((d) => d.paired && (d.name || d.alias))
      .sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1
        return (a.alias || a.name).localeCompare(b.alias || b.name)
      }),
  )
  const available = devicesBinding.as((ds) =>
    [...ds]
      .filter((d) => !d.paired && (d.name || d.alias))
      .sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name)),
  )

  // Scan for nearby devices while the page is open; stop on the way out so the
  // adapter isn't left discovering in the background. Discovery only works once
  // the adapter is powered — calling start_discovery() while it's off throws
  // org.bluez.Error.NotReady — so we guard on `powered` and (re)start if the
  // user turns Bluetooth on while the page is open.
  const adapter = bt.adapter
  function startDiscovery() {
    if (!adapter || !adapter.powered || adapter.discovering) return
    try {
      adapter.start_discovery()
    } catch (e) {
      console.error("bluetooth start_discovery:", String(e))
    }
  }
  onMount(startDiscovery)
  const unsubscribe = powered.subscribe(startDiscovery)
  onCleanup(() => {
    unsubscribe()
    if (adapter?.discovering) {
      try {
        adapter.stop_discovery()
      } catch (e) {
        console.error("bluetooth stop_discovery:", String(e))
      }
    }
  })

  return (
    <box cssName="detail-page" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box cssName="detail-header" spacing={10}>
        <button cssName="detail-back" onClicked={props.onBack}>
          <image iconName="go-previous-symbolic" />
        </button>
        <label cssName="detail-title" label="Bluetooth" hexpand halign={Gtk.Align.START} />
        <ToggleSwitch active={powered.as((p) => !!p)} onToggle={() => bt.toggle()} />
      </box>

      <scrolledwindow
        cssName="detail-list"
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        propagateNaturalHeight
        maxContentHeight={300}
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <DeviceSection title="My devices" devices={paired} />
          <DeviceSection title="Available" devices={available} />
        </box>
      </scrolledwindow>
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
  const [page, setPage] = createState<"main" | "wifi" | "bluetooth">("main")

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
              ) : (
                <QuickSettingsContent
                  onWifiClick={() => setPage("wifi")}
                  onBluetoothClick={() => setPage("bluetooth")}
                />
              )
            }
          </With>
        </box>
      </overlay>
    </window>
  )
}
