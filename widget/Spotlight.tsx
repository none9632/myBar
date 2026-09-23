import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Pango from "gi://Pango?version=1.0"
import AstalApps from "gi://AstalApps?version=0.1"
import { Accessor, createComputed, createState, For } from "gnim"
import { forceLatinLayout } from "../lib/keyboard"

// macOS-Spotlight-style launcher (Phase 1: application launcher only).
//
// Like Quick Settings, the window is created once at startup but stays unmapped;
// it's shown on demand — here only via `ags request spotlight` (a Hyprland
// keybind), with no bar trigger. Open/close state and the query/result model live
// at module scope so a single instance drives everything and `toggleSpotlight`
// stays callable from app.ts.
//
// Future phases add more providers (calculator, files, windows, clipboard, …); the
// AstalApps query below would then become one provider among several behind a
// shared interface.

// Only the *query* results are capped — an empty query lists every app, so the
// launcher doubles as a browsable menu (scroll or arrow down through all of them).
const MAX_QUERY_RESULTS = 8
// Open/close fade length; keep in sync with the `.shown` transition in
// styles/spotlight/_spotlight.scss.
const ANIM_MS = 180

// Reads and indexes .desktop files, with fuzzy scoring and a persisted launch
// frequency (used to rank the default list on an empty query).
const apps = new AstalApps.Apps()

const [query, setQuery] = createState("")
const [results, setResults] = createState<AstalApps.Application[]>([])
const [selected, setSelected] = createState(0) // index into `results`
const [mapped, setMapped] = createState(false) // window shown (stays up during the fade)
const [shown, setShown] = createState(false) // drives the `.shown` fade

let isOpen = false
let closeTimer = 0
let restoreLayout: (() => void) | null = null
let entryRef: Gtk.Widget | null = null
let scrollRef: Gtk.ScrolledWindow | null = null
let listRef: Gtk.Widget | null = null // the box holding the result rows

// Stable id for `For` keying: the .desktop entry is unique; fall back to the name.
const keyOf = (a: AstalApps.Application) => a.entry || a.name

// Empty query → every app, most-used first (by AstalApps' persisted frequency,
// ties broken by name so the tail doesn't reshuffle between opens). Otherwise the
// fuzzy matches, already sorted best-first and capped to stay glanceable.
function computeResults(text: string): AstalApps.Application[] {
  const q = text.trim()
  if (!q) {
    return [...apps.get_list()].sort(
      (a, b) => b.frequency - a.frequency || a.name.localeCompare(b.name),
    )
  }
  return [...apps.fuzzy_query(q)].slice(0, MAX_QUERY_RESULTS)
}

function refresh(text: string) {
  setResults(computeResults(text))
  setSelected(0)
  scrollRef?.get_vadjustment().set_value(0)
}

// Keep the selected row inside the viewport. The rows differ in height (only some
// apps have a description), so the offset is read from the widget itself rather
// than computed from the index. Called only from `move` — on hover the pointer is
// already over the row, and scrolling under it would fight the mouse.
function scrollToSelected() {
  const sw = scrollRef
  const i = selected.peek()
  if (!sw || !listRef) return
  if (i <= 0) {
    sw.get_vadjustment().set_value(0)
    return
  }
  let row = listRef.get_first_child()
  for (let n = 0; row && n < i; n++) row = row.get_next_sibling()
  if (!row) return
  const [ok, bounds] = row.compute_bounds(listRef)
  if (!ok) return

  const adj = sw.get_vadjustment()
  const top = bounds.get_y()
  const bottom = top + bounds.get_height()
  if (top < adj.get_value()) adj.set_value(top)
  else if (bottom > adj.get_value() + adj.get_page_size())
    adj.set_value(bottom - adj.get_page_size())
}

// Clamp within the list — Spotlight doesn't wrap.
function move(delta: number) {
  const n = results.peek().length
  if (!n) return
  setSelected(Math.max(0, Math.min(n - 1, selected.peek() + delta)))
  scrollToSelected()
}

function launch(a: AstalApps.Application) {
  a.launch()
  closeSpotlight()
}

function activateSelected() {
  const a = results.peek()[selected.peek()]
  if (a) launch(a)
}

export function openSpotlight() {
  if (isOpen) return
  isOpen = true
  if (closeTimer) {
    GLib.source_remove(closeTimer)
    closeTimer = 0
  }
  // Latin input while the launcher is up; the old layout comes back on close.
  restoreLayout = forceLatinLayout()
  // Fresh session each open: clear the query, seed with the top apps.
  setQuery("")
  refresh("")
  setMapped(true)
  // Let the window map before revealing (fade + focus in the same frame snaps).
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
    if (isOpen) {
      setShown(true)
      entryRef?.grab_focus()
    }
    return GLib.SOURCE_REMOVE
  })
}

export function closeSpotlight() {
  if (!isOpen) return
  isOpen = false
  restoreLayout?.()
  restoreLayout = null
  setShown(false)
  if (closeTimer) GLib.source_remove(closeTimer)
  // Unmap only after the fade-out has played.
  closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANIM_MS, () => {
    if (!isOpen) setMapped(false)
    closeTimer = 0
    return GLib.SOURCE_REMOVE
  })
}

export const toggleSpotlight = () => (isOpen ? closeSpotlight() : openSpotlight())

function ResultRow(props: {
  app: AstalApps.Application
  isSelected: Accessor<boolean>
  onActivate: () => void
  onHover: () => void
}) {
  const a = props.app
  return (
    <box
      cssName="spotlight-result"
      class={props.isSelected.as((s) => (s ? "selected" : ""))}
      spacing={12}
    >
      {/* A plain box (not a button) so it carries no theme chrome; the gesture
          makes it clickable and the motion controller lets the mouse drive the
          same selection the arrow keys do. */}
      <Gtk.GestureClick onPressed={() => props.onActivate()} />
      <Gtk.EventControllerMotion onEnter={() => props.onHover()} />
      <image
        cssName="spotlight-result-icon"
        iconName={a.iconName || "application-x-executable"}
      />
      <box
        orientation={Gtk.Orientation.VERTICAL}
        valign={Gtk.Align.CENTER}
        hexpand
        halign={Gtk.Align.START}
      >
        <label
          cssName="spotlight-result-name"
          label={a.name}
          halign={Gtk.Align.START}
          ellipsize={Pango.EllipsizeMode.END}
        />
        {a.description ? (
          <label
            cssName="spotlight-result-desc"
            label={a.description}
            halign={Gtk.Align.START}
            ellipsize={Pango.EllipsizeMode.END}
          />
        ) : null}
      </box>
    </box>
  )
}

export default function SpotlightWindow(props: { gdkmonitor: Gdk.Monitor }) {
  const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
  // Sit in the upper third, like macOS Spotlight.
  const marginTop = Math.round(props.gdkmonitor.get_geometry().height * 0.25)

  const hasResults = results.as((r) => r.length > 0)
  const noResults = createComputed(() => query().trim() !== "" && results().length === 0)

  return (
    <window
      visible={mapped}
      name="spotlight"
      // No custom namespace: fall under the default "gtk4-layer-shell" so
      // Hyprland's blur layer-rule frosts the translucent card, like the bar and
      // the bar menus (see BarMenu.tsx).
      class="Spotlight"
      gdkmonitor={props.gdkmonitor}
      anchor={TOP | BOTTOM | LEFT | RIGHT}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.EXCLUSIVE}
      layer={Astal.Layer.OVERLAY}
      application={app}
    >
      {/* CAPTURE phase so navigation keys are handled before the focused entry
          consumes them: Escape closes, Up/Down (and Tab) move the selection,
          Enter launches. Everything else falls through to the entry for typing. */}
      <Gtk.EventControllerKey
        propagationPhase={Gtk.PropagationPhase.CAPTURE}
        onKeyPressed={(_self, keyval) => {
          switch (keyval) {
            case Gdk.KEY_Escape:
              closeSpotlight()
              return true
            case Gdk.KEY_Down:
            case Gdk.KEY_Tab:
              move(1)
              return true
            case Gdk.KEY_Up:
            case Gdk.KEY_ISO_Left_Tab:
              move(-1)
              return true
            case Gdk.KEY_Return:
            case Gdk.KEY_KP_Enter:
              activateSelected()
              return true
            default:
              return false
          }
        }}
      />
      <overlay>
        {/* Main child: full-screen dismiss area. */}
        <box>
          <Gtk.GestureClick onPressed={() => closeSpotlight()} />
        </box>
        {/* Overlay child: the centred launcher card. */}
        <box
          $type="overlay"
          cssName="spotlight-card"
          class={shown.as((s) => (s ? "shown" : ""))}
          orientation={Gtk.Orientation.VERTICAL}
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.START}
          marginTop={marginTop}
        >
          <box cssName="spotlight-search" spacing={10}>
            <image iconName="system-search-symbolic" />
            <entry
              cssName="spotlight-entry"
              hexpand
              text={query}
              placeholderText="Search"
              onNotifyText={(self) => {
                setQuery(self.text)
                refresh(self.text)
              }}
              $={(self: Gtk.Widget) => (entryRef = self)}
            />
          </box>

          {/* Toggle list vs "no results" by visibility (not <With>) so the search
              entry above is never rebuilt and keeps keyboard focus while typing. */}
          <label
            cssName="spotlight-empty"
            halign={Gtk.Align.START}
            visible={noResults}
            label={query.as((q) => `No results for “${q.trim()}”`)}
          />
          <scrolledwindow
            cssName="spotlight-results"
            hscrollbarPolicy={Gtk.PolicyType.NEVER}
            propagateNaturalHeight
            maxContentHeight={480}
            visible={hasResults}
            $={(self: Gtk.ScrolledWindow) => (scrollRef = self)}
          >
            <box
              orientation={Gtk.Orientation.VERTICAL}
              spacing={2}
              $={(self: Gtk.Widget) => (listRef = self)}
            >
              <For each={results} id={keyOf}>
                {(a, index) => (
                  <ResultRow
                    app={a}
                    isSelected={createComputed(() => selected() === index())}
                    onActivate={() => launch(a)}
                    onHover={() => setSelected(index.peek())}
                  />
                )}
              </For>
            </box>
          </scrolledwindow>
        </box>
      </overlay>
    </window>
  )
}
