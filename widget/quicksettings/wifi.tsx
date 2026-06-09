import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"
import { Accessor, createBinding, createComputed, createState, For, With, onMount } from "gnim"
import Network from "gi://AstalNetwork?version=0.1"
import { Toggle, ToggleSwitch } from "./common"

export function WifiToggle(props: { onClick: () => void }) {
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

export function WifiPage(props: { onBack: () => void }) {
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
