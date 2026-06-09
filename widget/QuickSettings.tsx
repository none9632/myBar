import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync } from "ags/process"
import { readFile, writeFile } from "ags/file"
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

// ── VPN (sing-box) ──────────────────────────────────────────────────────────
// sing-box runs as a system service in TUN mode. We keep a library of VLESS
// profiles under ~/.config/sing-box/profiles/ and switch the active one by
// rendering a full config (a fixed template + the profile's outbound) and
// handing it to the `singbox-ctl` helper, which validates, installs it to
// /etc/sing-box/config.json and restarts the service. Reading state
// (`systemctl is-active`) needs no privilege; every mutation goes through the
// helper, allowed passwordless via /etc/sudoers.d/sing-box.

const VPN_DIR = `${GLib.get_user_config_dir()}/sing-box`
const VPN_PROFILES_DIR = `${VPN_DIR}/profiles`
const VPN_RENDERED = `${VPN_DIR}/rendered/active.json`
const VPN_ACTIVE_FILE = `${VPN_DIR}/active`
const VPN_SYSTEM_CONFIG = "/etc/sing-box/config.json"
const SINGBOX_CTL = `${GLib.get_home_dir()}/.local/bin/singbox-ctl`

interface VpnOutbound {
  type: string
  tag: string
  server: string
  server_port: number
  uuid: string
  flow?: string
  tls?: object
  transport?: object
}

interface VpnProfile {
  id: string
  name: string
  link: string
  outbound: VpnOutbound
}

// Decode a URL query string into a plain map (gjs lacks a guaranteed
// URLSearchParams, so parse by hand).
function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of query.replace(/^\?/, "").split("&")) {
    if (!pair) continue
    const eq = pair.indexOf("=")
    const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))
    const val = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1))
    out[key] = val
  }
  return out
}

// Parse a `vless://uuid@host:port?params#name` share link into a sing-box
// outbound. Covers the reality/vision + tls cases (and ws/grpc transport);
// returns null if the link isn't a recognisable VLESS URL.
function parseVlessLink(raw: string): VpnProfile | null {
  const link = raw.trim()
  const m = link.match(/^vless:\/\/([^@]+)@([^:/?#]+):(\d+)(\?[^#]*)?(#.*)?$/i)
  if (!m) return null
  const [, uuid, host, portStr, query = "", hash = ""] = m
  const p = parseQuery(query)
  const name = (hash ? decodeURIComponent(hash.slice(1)) : "") || host

  const outbound: VpnOutbound = {
    type: "vless",
    tag: "vless-out",
    server: host,
    server_port: parseInt(portStr, 10),
    uuid,
  }
  if (p.flow) outbound.flow = p.flow

  const security = p.security || "none"
  if (security === "reality" || security === "tls") {
    const tls: Record<string, unknown> = {
      enabled: true,
      server_name: p.sni || p.peer || host,
    }
    if (p.fp) tls.utls = { enabled: true, fingerprint: p.fp }
    if (security === "reality") {
      tls.reality = { enabled: true, public_key: p.pbk || "", short_id: p.sid || "" }
    }
    outbound.tls = tls
  }

  if (p.type === "ws") {
    const ws: Record<string, unknown> = { type: "ws", path: p.path || "/" }
    if (p.host) ws.headers = { Host: p.host }
    outbound.transport = ws
  } else if (p.type === "grpc") {
    outbound.transport = { type: "grpc", service_name: p.serviceName || "" }
  }

  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  return { id, name, link, outbound }
}

// A complete, standalone sing-box config built from the fixed template plus the
// given outbound. Mirrors the original /etc/sing-box/config.json so existing
// dns/route behaviour is preserved; only the VLESS server varies.
function renderVpnConfig(outbound: VpnOutbound): string {
  const config = {
    dns: {
      servers: [
        { type: "tls", tag: "google", detour: "vless-out", server: "8.8.8.8" },
        { type: "udp", tag: "local", server: "1.1.1.1" },
      ],
      strategy: "ipv4_only",
    },
    inbounds: [
      {
        type: "tun",
        address: "172.19.0.1/30",
        auto_route: true,
        auto_redirect: true,
        strict_route: true,
      },
    ],
    outbounds: [
      { ...outbound, tag: "vless-out" },
      { type: "direct", tag: "direct" },
    ],
    route: {
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        { ip_is_private: true, outbound: "direct" },
      ],
      auto_detect_interface: true,
      default_domain_resolver: "local",
      final: "vless-out",
    },
  }
  return JSON.stringify(config, null, 2)
}

function listVpnProfiles(): VpnProfile[] {
  if (!GLib.file_test(VPN_PROFILES_DIR, GLib.FileTest.IS_DIR)) return []
  const profiles: VpnProfile[] = []
  try {
    const en = Gio.File.new_for_path(VPN_PROFILES_DIR).enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    let info: Gio.FileInfo | null
    while ((info = en.next_file(null)) !== null) {
      const fname = info.get_name()
      if (!fname.endsWith(".json")) continue
      try {
        const data = JSON.parse(readFile(`${VPN_PROFILES_DIR}/${fname}`))
        if (data?.outbound?.server) {
          profiles.push({
            id: fname.replace(/\.json$/, ""),
            name: data.name || data.outbound.server,
            link: data.link || "",
            outbound: data.outbound,
          })
        }
      } catch (e) {
        console.error("vpn profile parse:", fname, "->", String(e))
      }
    }
  } catch (e) {
    console.error("vpn list profiles:", String(e))
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name))
}

function saveVpnProfile(p: VpnProfile) {
  writeFile(
    `${VPN_PROFILES_DIR}/${p.id}.json`,
    JSON.stringify({ name: p.name, link: p.link, outbound: p.outbound }, null, 2),
  )
}

function deleteVpnProfile(id: string) {
  try {
    Gio.File.new_for_path(`${VPN_PROFILES_DIR}/${id}.json`).delete(null)
  } catch (e) {
    console.error("vpn delete profile:", id, "->", String(e))
  }
}

function getActiveVpnId(): string {
  try {
    return readFile(VPN_ACTIVE_FILE).trim()
  } catch {
    return ""
  }
}

// Render the profile's config and ask the helper to validate + install + restart.
function applyVpnProfile(p: VpnProfile): Promise<string> {
  writeFile(VPN_RENDERED, renderVpnConfig(p.outbound))
  writeFile(VPN_ACTIVE_FILE, p.id)
  return execAsync(["sudo", SINGBOX_CTL, "apply", VPN_RENDERED])
}

// First-run seeding: lift the VLESS outbound from the live system config into a
// profile so the user's current server shows up in the list.
function seedVpnProfiles() {
  if (listVpnProfiles().length > 0) return
  try {
    const cfg = JSON.parse(readFile(VPN_SYSTEM_CONFIG))
    const ob = (cfg.outbounds || []).find((o: VpnOutbound) => o.type === "vless")
    if (!ob?.server) return
    const id = Date.now().toString(36)
    saveVpnProfile({ id, name: ob.server, link: "", outbound: { ...ob, tag: "vless-out" } })
    if (!getActiveVpnId()) writeFile(VPN_ACTIVE_FILE, id)
  } catch (e) {
    console.error("vpn seed:", String(e))
  }
}

function vpnIsActivePoll(): Accessor<boolean> {
  // `|| true` keeps exit code 0 so an inactive service isn't a failed poll.
  return createPoll(
    false,
    2000,
    ["bash", "-c", "systemctl is-active sing-box || true"],
    (out) => out.trim() === "active",
  )
}

function VpnToggle(props: { onClick: () => void }) {
  const active = vpnIsActivePoll()
  // Subtitle: the server IP of the selected profile (read straight from the
  // files, no subprocess). Updates when the active config changes on the page.
  const activeServer = createPoll("", 2000, () => {
    const id = getActiveVpnId()
    if (!id) return ""
    return listVpnProfiles().find((p) => p.id === id)?.outbound.server ?? ""
  })
  return (
    <Toggle
      icon={active.as((a) => (a ? "network-vpn-symbolic" : "network-vpn-disconnected-symbolic"))}
      label={active.as((a) => (a ? "Connected" : "Disconnected"))}
      sublabel={activeServer.as((ip) => ip || "Not connected")}
      active={active}
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
  onVpnClick: () => void
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

// ── VPN detail page ───────────────────────────────────────────────────────────

function VpnRow(props: {
  profile: VpnProfile
  activeId: Accessor<string>
  onSelect: (p: VpnProfile) => void
  onDeleted: () => void
}) {
  const p = props.profile
  // Name is held locally so a rename shows immediately: <For> reuses the row by
  // id and never re-runs with the updated profile object (see [[gnim-with-append-order]]).
  const [name, setName] = createState(p.name)
  const [menuOpen, setMenuOpen] = createState(false)
  const [renaming, setRenaming] = createState(false)
  const [renameText, setRenameText] = createState(p.name)
  const isActive = props.activeId.as((id) => id === p.id)

  // Latency is measured on demand, for the active config only. We time a full
  // HTTP round-trip to a generate_204 endpoint *through* the tunnel — the same
  // thing Clash/sing-box GUIs report as "ping". A bare TCP/ICMP probe is useless
  // here: the TUN terminates connections locally, so it answers in ~0-2ms rather
  // than the real server RTT. null = unreachable. Retries cover the few seconds
  // the tunnel needs to come up after a restart.
  const [pingMs, setPingMs] = createState<number | null>(null)
  const [measuring, setMeasuring] = createState(false)

  function measure(attempt = 0) {
    setMeasuring(true)
    if (attempt === 0) setPingMs(null)
    execAsync([
      "bash",
      "-c",
      "curl -o /dev/null -s -w '%{time_total} %{http_code}' --max-time 6 " +
        "http://cp.cloudflare.com/generate_204",
    ])
      .then((out) => {
        const [secStr, code] = out.trim().split(/\s+/)
        const sec = parseFloat(secStr)
        const ok = (code === "204" || code === "200") && !isNaN(sec) && sec > 0
        if (ok) {
          setPingMs(Math.round(sec * 1000))
          setMeasuring(false)
        } else if (attempt < 3 && isActive.peek()) {
          setTimeout(() => measure(attempt + 1), 1500)
        } else {
          setPingMs(null)
          setMeasuring(false)
        }
      })
      .catch(() => {
        if (attempt < 3 && isActive.peek()) {
          setTimeout(() => measure(attempt + 1), 1500)
        } else {
          setPingMs(null)
          setMeasuring(false)
        }
      })
  }

  // Measure whenever this row becomes the active one (page open or selection).
  onMount(() => {
    if (isActive.peek()) measure()
  })
  const unsubscribe = isActive.subscribe(() => {
    if (isActive.peek()) measure()
  })
  onCleanup(() => unsubscribe())

  // Trailing indicator, shown for the active row only: spinner while measuring,
  // then a check with the latency badge, or a warning if the server was
  // unreachable.
  const status = createComputed(() => {
    if (!isActive()) return "none"
    if (measuring()) return "measuring"
    return pingMs() != null ? "ok" : "fail"
  })
  const pingText = createComputed(() =>
    isActive() && !measuring() && pingMs() != null ? `${pingMs()} ms` : "",
  )

  function openRename() {
    setMenuOpen(false)
    setRenameText(name.peek())
    setRenaming(true)
  }

  function commitRename(value: string) {
    const next = value.trim()
    setRenaming(false)
    if (!next || next === name.peek()) return
    setName(next)
    saveVpnProfile({ ...p, name: next })
  }

  function remove() {
    setMenuOpen(false)
    deleteVpnProfile(p.id)
    props.onDeleted()
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL}>
      <button
        cssName="detail-row"
        class={isActive.as((a) => (a ? "connected" : ""))}
        onClicked={() => props.onSelect(p)}
      >
        {/* Right-click for rename / delete. */}
        <Gtk.GestureClick button={3} onPressed={() => setMenuOpen(!menuOpen.peek())} />
        <box spacing={10}>
          <image iconName="network-vpn-symbolic" />
          <label
            label={name}
            hexpand
            halign={Gtk.Align.START}
            ellipsize={Pango.EllipsizeMode.END}
          />
          <box valign={Gtk.Align.CENTER}>
            <With value={pingText}>
              {(t) => (t ? <label cssName="detail-badge" label={t} /> : <box />)}
            </With>
          </box>
          <box cssName="detail-status" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}>
            <With value={status}>
              {(s) =>
                s === "measuring" ? (
                  <Gtk.Spinner spinning />
                ) : s === "ok" ? (
                  <image iconName="object-select-symbolic" />
                ) : s === "fail" ? (
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
          <button cssName="row-menu-item" onClicked={openRename}>
            <box spacing={8}>
              <image iconName="document-edit-symbolic" />
              <label label="Rename" hexpand halign={Gtk.Align.START} />
            </box>
          </button>
          <button cssName="row-menu-item" onClicked={remove}>
            <box spacing={8}>
              <image iconName="user-trash-symbolic" />
              <label label="Delete" hexpand halign={Gtk.Align.START} />
            </box>
          </button>
        </box>
      </revealer>

      <revealer revealChild={renaming} transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}>
        <box cssName="wifi-password" spacing={6}>
          <entry
            hexpand
            text={renameText}
            onNotifyText={(self) => setRenameText(self.text)}
            onActivate={() => commitRename(renameText.peek())}
          />
          <button cssName="wifi-connect" onClicked={() => commitRename(renameText.peek())}>
            <label label="Save" />
          </button>
        </box>
      </revealer>
    </box>
  )
}

function VpnPage(props: { onBack: () => void }) {
  const running = vpnIsActivePoll()
  const [profiles, setProfiles] = createState<VpnProfile[]>([])
  const [activeId, setActiveId] = createState("")
  const [addOpen, setAddOpen] = createState(false)
  const [addText, setAddText] = createState("")
  const [addError, setAddError] = createState(false)

  function refresh() {
    setProfiles(listVpnProfiles())
    setActiveId(getActiveVpnId())
  }

  onMount(() => {
    seedVpnProfiles()
    refresh()
  })

  function select(p: VpnProfile) {
    setActiveId(p.id) // optimistic; the poll/refresh confirms once restarted
    applyVpnProfile(p).catch((e) => console.error("vpn apply:", String(e)))
  }

  function toggleService() {
    const verb = running.peek() ? "stop" : "start"
    execAsync(["sudo", SINGBOX_CTL, verb]).catch((e) =>
      console.error("vpn", verb, ":", String(e)),
    )
  }

  function addLink() {
    const parsed = parseVlessLink(addText.peek())
    if (!parsed) {
      setAddError(true)
      return
    }
    saveVpnProfile(parsed)
    setAddText("")
    setAddError(false)
    setAddOpen(false)
    refresh()
  }

  return (
    <box cssName="detail-page" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box cssName="detail-header" spacing={10}>
        <button cssName="detail-back" onClicked={props.onBack}>
          <image iconName="go-previous-symbolic" />
        </button>
        <label cssName="detail-title" label="VPN" hexpand halign={Gtk.Align.START} />
        <ToggleSwitch active={running} onToggle={toggleService} />
      </box>

      <scrolledwindow
        cssName="detail-list"
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        propagateNaturalHeight
        maxContentHeight={300}
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
          <For each={profiles} id={(p) => p.id}>
            {(p) => (
              <VpnRow profile={p} activeId={activeId} onSelect={select} onDeleted={refresh} />
            )}
          </For>
        </box>
      </scrolledwindow>

      <revealer revealChild={addOpen} transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}>
        <box cssName="wifi-password" spacing={6}>
          {/* Submit with Enter — no separate button. */}
          <entry
            hexpand
            text={addText}
            class={addError.as((e) => (e ? "error" : ""))}
            placeholderText={addError.as((e) => (e ? "Invalid vless:// link" : "vless://…"))}
            onNotifyText={(self) => {
              setAddText(self.text)
              if (self.text !== "") setAddError(false)
            }}
            onActivate={addLink}
          />
        </box>
      </revealer>

      <button cssName="vpn-add" onClicked={() => setAddOpen(!addOpen.peek())}>
        <box spacing={8} halign={Gtk.Align.CENTER}>
          <image iconName="list-add-symbolic" />
          <label label="Add config" />
        </box>
      </button>
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
                />
              )
            }
          </With>
        </box>
      </overlay>
    </window>
  )
}
