import { Gdk, Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { createPoll } from "ags/time"
import { Accessor, createComputed, createState, For, With } from "gnim"
import BarMenu from "./BarMenu"

// Updates indicator + popover. The bar chip shows the total count; clicking it
// drops a card listing every pending package with its version bump, AUR ones
// flagged, and a repo/AUR breakdown up top.

const UPDATE_INTERVAL = 30 * 60 * 1000 // 30 minutes

// Official-repo updates via `checkupdates` (no sudo; it syncs a throwaway db) plus
// AUR updates via `yay -Qua`. Each line is tagged with its source. The pipe into
// sed keeps the exit status 0 even when a tool finds nothing or is missing, so the
// poll never reads as a failure.
const UPDATE_LIST_CMD = [
  "bash",
  "-c",
  "{ checkupdates 2>/dev/null | sed 's/^/repo /'; yay -Qua 2>/dev/null | sed 's/^/aur /'; }",
]

interface PkgUpdate {
  name: string
  oldVer: string
  newVer: string
  aur: boolean
}

// Lines look like `repo gtk4 1.0-1 -> 1.1-1` / `aur yay 12.0-1 -> 12.1-1`.
function parseUpdates(out: string): PkgUpdate[] {
  const items: PkgUpdate[] = []
  for (const line of out.split("\n")) {
    const m = line.match(/^(repo|aur)\s+(\S+)\s+(\S+)\s+->\s+(\S+)/)
    if (!m) continue
    items.push({ aur: m[1] === "aur", name: m[2], oldVer: m[3], newVer: m[4] })
  }
  // Repo packages first, then AUR; alphabetical within each group.
  return items.sort((a, b) =>
    a.aur === b.aur ? a.name.localeCompare(b.name) : a.aur ? 1 : -1,
  )
}

function UpdateRow(props: { pkg: PkgUpdate }) {
  const p = props.pkg
  return (
    <box cssName="updates-row" orientation={Gtk.Orientation.VERTICAL} spacing={1}>
      <box spacing={8}>
        <label
          cssName="updates-name"
          label={p.name}
          hexpand
          halign={Gtk.Align.START}
          ellipsize={Pango.EllipsizeMode.END}
        />
        {p.aur ? (
          <label cssName="updates-aur" label="AUR" valign={Gtk.Align.CENTER} />
        ) : null}
      </box>
      <box cssName="updates-ver" spacing={6} halign={Gtk.Align.START}>
        <label cssName="updates-oldver" label={p.oldVer} />
        <label cssName="updates-arrow" label="→" />
        <label cssName="updates-newver" label={p.newVer} />
      </box>
    </box>
  )
}

function UpdatesPage(props: { updates: Accessor<PkgUpdate[] | null> }) {
  const list = props.updates
  // Live filter text. Held on the page, so it resets every time the popover (and
  // thus this content) is rebuilt on open.
  const [query, setQuery] = createState("")

  // Header line: total + a repo/AUR breakdown, or the loading / up-to-date state.
  const summary = createComputed(() => {
    const u = list()
    if (u === null) return "Checking for updates…"
    if (u.length === 0) return "Everything is up to date"
    const repo = u.filter((p) => !p.aur).length
    const aur = u.filter((p) => p.aur).length
    const parts: string[] = []
    if (repo) parts.push(`${repo} repo`)
    if (aur) parts.push(`${aur} AUR`)
    return `${u.length} update${u.length === 1 ? "" : "s"} · ${parts.join(" · ")}`
  })
  const hasUpdates = list.as((u) => u !== null && u.length > 0)

  // Case-insensitive substring match on the package name.
  const filtered = createComputed(() => {
    const u = list() ?? []
    const q = query().trim().toLowerCase()
    return q ? u.filter((p) => p.name.toLowerCase().includes(q)) : u
  })
  const hasMatches = filtered.as((f) => f.length > 0)
  const noMatches = createComputed(() => query().trim() !== "" && filtered().length === 0)

  return (
    <box cssName="updates-menu" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
        <label cssName="updates-title" label="Updates" halign={Gtk.Align.START} />
        <label cssName="updates-summary" label={summary} halign={Gtk.Align.START} />
      </box>

      {/* Search + list appear only when there's something to scroll through. The
          search box stays mounted while typing (the For below re-renders, but it's
          a separate widget), so it keeps keyboard focus. Visibility — not <With> —
          toggles the list vs the "no matches" note, again to avoid disturbing it. */}
      <With value={hasUpdates}>
        {(any) =>
          any ? (
            <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
              <box cssName="updates-search" spacing={8}>
                <image iconName="system-search-symbolic" />
                <entry
                  cssName="updates-search-entry"
                  hexpand
                  text={query}
                  placeholderText="Search packages…"
                  onNotifyText={(self) => setQuery(self.text)}
                />
              </box>
              <label
                cssName="updates-empty"
                halign={Gtk.Align.START}
                visible={noMatches}
                label={query.as((q) => `No packages match “${q.trim()}”`)}
              />
              <scrolledwindow
                cssName="updates-list"
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
                propagateNaturalHeight
                maxContentHeight={360}
                visible={hasMatches}
              >
                <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                  <For each={filtered} id={(p) => p.name}>
                    {(p) => <UpdateRow pkg={p} />}
                  </For>
                </box>
              </scrolledwindow>
            </box>
          ) : (
            <box />
          )
        }
      </With>
    </box>
  )
}

export default function Updates(props: { gdkmonitor: Gdk.Monitor }) {
  // null = not fetched yet (chip shows "…"); [] = checked, none pending (chip
  // hidden); otherwise the list of pending packages.
  const updates = createPoll<PkgUpdate[] | null>(
    null,
    UPDATE_INTERVAL,
    UPDATE_LIST_CMD,
    (out) => parseUpdates(out),
  )

  return (
    <BarMenu
      name="updates"
      gdkmonitor={props.gdkmonitor}
      buttonCssName="updates"
      visible={updates.as((u) => u === null || u.length > 0)}
      content={() => <UpdatesPage updates={updates} />}
      button={
        <box spacing={4}>
          <label cssName="updates-icon" label="䂍" />
          <label label={updates.as((u) => (u === null ? "…" : `${u.length}`))} />
        </box>
      }
    />
  )
}
