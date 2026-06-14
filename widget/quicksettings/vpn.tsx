import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"
import {
  Accessor,
  createComputed,
  createState,
  For,
  With,
  onCleanup,
  onMount,
} from "gnim"
import { Toggle, ToggleSwitch } from "./common"
import {
  VpnProfile,
  SINGBOX_CTL,
  applyVpnProfile,
  deleteVpnProfile,
  getActiveVpnId,
  listVpnProfiles,
  parseVlessLink,
  saveVpnProfile,
  seedVpnProfiles,
  vpnIsActivePoll,
} from "./vpn-config"

export function VpnToggle(props: { onClick: () => void }) {
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

export function VpnPage(props: { onBack?: () => void }) {
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
        {props.onBack ? (
          <button cssName="detail-back" onClicked={props.onBack}>
            <image iconName="go-previous-symbolic" />
          </button>
        ) : null}
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
