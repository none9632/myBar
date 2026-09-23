import AstalApps from "gi://AstalApps?version=0.1"
import GLib from "gi://GLib"
import GioUnix from "gi://GioUnix?version=2.0"
import type { Provider, SpotlightItem } from "../types"
import { launchCommand } from "../launch"
import { inTerminal } from "../terminal"

// Application launcher — the default source, answering the unprefixed query.

// Only the *query* results are capped — an empty query lists every app, so the
// launcher doubles as a browsable menu (scroll or arrow down through all of them).
const MAX_QUERY_RESULTS = 8

// Reads and indexes .desktop files, with fuzzy scoring and a launch frequency,
// which is what ranks the default list.
const apps = new AstalApps.Apps()

// AstalApps keeps the frequency counter here and reads it back at startup. It
// normally writes the file from `launch()` — which we bypass, to see why an app
// failed — so the bookkeeping is ours now.
const FREQUENTS = `${GLib.get_user_cache_dir()}/astal/apps-frequents.json`

function rememberLaunch(app: AstalApps.Application) {
  app.frequency = app.frequency + 1
  const counts: Record<string, number> = {}
  for (const a of apps.get_list()) if (a.entry && a.frequency > 0) counts[a.entry] = a.frequency
  try {
    GLib.mkdir_with_parents(`${GLib.get_user_cache_dir()}/astal`, 0o755)
    GLib.file_set_contents(FREQUENTS, JSON.stringify(counts))
  } catch (e) {
    console.error("spotlight: could not save launch frequencies:", e)
  }
}

// The .desktop Exec line, minus the field codes (%U, %f…) that stand for file
// arguments we never pass. `Terminal=true` entries — htop and friends — are only
// useful inside a terminal window, and GIO is the one that normally handles that.
function commandFor(app: AstalApps.Application): string | null {
  const info = app.entry ? GioUnix.DesktopAppInfo.new(app.entry) : null
  const raw = info?.get_commandline() || app.executable || ""
  const line = raw
    .replace(/%[a-zA-Z]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!line) return null
  return info?.get_boolean("Terminal") ? inTerminal(line) : line
}

function start(app: AstalApps.Application) {
  rememberLaunch(app)
  const command = commandFor(app)
  // Nothing parseable in the entry: fall back to GIO, silent failure and all.
  if (!command) {
    app.launch()
    return
  }
  launchCommand(command, app.name)
}

// Does any application name start with this text? The calculator asks before
// claiming a query that merely begins with a digit, so an app like "2048" keeps
// priority over evaluating "2048" as an expression.
export function hasNamePrefix(query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return apps.get_list().some((app) => app.name.toLowerCase().startsWith(q))
}

function toItem(app: AstalApps.Application, score: number): SpotlightItem {
  return {
    // The .desktop entry is unique; fall back to the name.
    id: app.entry || app.name,
    icon: app.iconName || "application-x-executable",
    title: app.name,
    subtitle: app.description || undefined,
    score,
    activate: () => start(app),
  }
}

const provider: Provider = {
  id: "apps",
  search(query) {
    const q = query.trim()
    // Empty query → every app, most-used first. Equal frequencies fall through to
    // the registry's title tie-break, so the tail keeps a stable order.
    if (!q) return apps.get_list().map((app) => toItem(app, app.frequency))

    // Fuzzy matches arrive best-first; turn that order into descending scores so
    // the registry's sort preserves it.
    const hits = apps.fuzzy_query(q).slice(0, MAX_QUERY_RESULTS)
    return hits.map((app, i) => toItem(app, hits.length - i))
  },
}

export default provider
