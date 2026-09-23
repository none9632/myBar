import GLib from "gi://GLib"
import type { Provider, SpotlightItem } from "../types"
import { launchCommand } from "../launch"
import { inTerminal, terminal } from "../terminal"

// Run a command from $PATH — the ">" mode, rofi's `run` equivalent.
//
// Exclusive to its prefix on purpose: mixing ~3800 binaries into the default
// query would bury the applications under their own CLI entry points.

const MAX_RESULTS = 8
// Rescan $PATH at most this often; a package install mid-session shows up within
// a minute without paying for a scan on every keystroke.
const TTL_MS = 60_000
// Commands run in a terminal by default: this mode exists for the CLI, and a
// detached `neofetch` prints into the void. Graphical programs have their own
// rows in the app list, and Shift+Enter still runs one detached from here.

let cache: string[] = []
let scannedAt = 0

function executables(): string[] {
  const now = GLib.get_monotonic_time() / 1000
  if (cache.length && now - scannedAt < TTL_MS) return cache

  const seen = new Set<string>()
  for (const dir of (GLib.getenv("PATH") ?? "").split(":")) {
    if (!dir) continue
    let handle: GLib.Dir
    try {
      handle = GLib.Dir.open(dir, 0)
    } catch {
      continue // missing or unreadable entry in PATH
    }
    let name = handle.read_name()
    while (name !== null) {
      const path = `${dir}/${name}`
      // IS_EXECUTABLE is true for directories too, hence the second test.
      if (
        !seen.has(name) &&
        GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) &&
        !GLib.file_test(path, GLib.FileTest.IS_DIR)
      ) {
        seen.add(name)
      }
      name = handle.read_name()
    }
  }

  cache = [...seen].sort()
  scannedAt = now
  return cache
}

function toItem(name: string, args: string, score: number): SpotlightItem {
  const line = args ? `${name} ${args}` : name
  const term = terminal()
  return {
    id: name,
    icon: "utilities-terminal-symbolic",
    title: line,
    subtitle: term
      ? `Enter — run in ${term.bin} · Shift+Enter — run detached`
      : "Enter — run detached",
    badge: "Run",
    score,
    activate: () => launchCommand(inTerminal(line), name),
    altActivate: term ? () => launchCommand(line, name) : undefined,
  }
}

const provider: Provider = {
  id: "run",
  prefix: ">",
  placeholder: "Run a command",
  // Also answers a plain query that no application matched.
  fallback: true,

  search(query) {
    const trimmed = query.trim()
    if (!trimmed) return []

    // Everything after the first word is passed through to the command, so
    // "> htop -d 5" matches "htop" and runs the whole line.
    const [name, ...rest] = trimmed.split(/\s+/)
    const args = rest.join(" ")
    const needle = name.toLowerCase()

    const starts: string[] = []
    const inside: string[] = []
    for (const exe of executables()) {
      const at = exe.toLowerCase().indexOf(needle)
      if (at === 0) starts.push(exe)
      else if (at > 0) inside.push(exe)
    }

    const hits = [...starts, ...inside].slice(0, MAX_RESULTS)
    return hits.map((exe, i) => toItem(exe, args, hits.length - i))
  },
}

export default provider
