import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gio from "gi://Gio?version=2.0"

// Launching with the failure made visible.
//
// GIO's launch — and AstalApps' `launch()` on top of it — detaches the process
// and discards its output, so an app that dies on startup (a broken package, a
// missing library) is indistinguishable from nothing having happened. Everything
// started from the launcher instead runs under a shell that redirects output to a
// log file; if the process exits non-zero soon after, the tail of that log is
// shown in a notification.
//
// A log file rather than a pipe on purpose: a long-lived app would otherwise
// either fill the pipe buffer and block, or have all of its chatter accumulate in
// our memory for as long as it runs.

// Exits later than this belong to the app's own life — a crash hours in, or the
// user quitting it — not to a failed launch.
const REPORT_WINDOW_MS = 15_000
const MAX_LINES = 12
const MAX_CHARS = 700
// The clipboard gets the whole output, not the notification's excerpt — it exists
// to be pasted into a search box or a bug report. Capped only against a program
// that failed after printing a few megabytes.
const MAX_CLIP_CHARS = 20_000

let counter = 0

function read(path: string): string {
  try {
    const [ok, bytes] = GLib.file_get_contents(path)
    if (!ok) return ""
    return new TextDecoder().decode(bytes)
  } catch {
    return ""
  }
}

function remove(path: string) {
  try {
    Gio.File.new_for_path(path).delete(null)
  } catch {
    // already gone
  }
}

// Where the useful part of a failure sits depends on the program: node prints the
// error first and a long stack after it, python puts the exception last, a missing
// library is one line. So the excerpt starts at the first line that reads like an
// error, and only falls back to the tail when nothing matches.
const ERROR_LINE = /\b(error|fatal|cannot|can't|failed|no such|not found|exception|traceback|undefined symbol)\b/i

function excerpt(text: string): string {
  const lines = text.trimEnd().split("\n")
  const from = lines.findIndex((l) => ERROR_LINE.test(l))
  const picked =
    from >= 0 ? lines.slice(from, from + MAX_LINES) : lines.slice(-MAX_LINES)
  const out = picked.join("\n").trim()
  return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS)}…` : out
}

function notifyFailure(label: string, body: string) {
  execAsync([
    "notify-send",
    "--urgency=critical",
    "--app-name=Spotlight",
    "--icon=dialog-error",
    `${label} failed to start`,
    body || "No output.",
  ]).catch(() => {})
}

// Full output plus the command that produced it, so the paste is self-contained.
function copyFailure(command: string, output: string) {
  const text = `$ ${command}\n\n${output.trimEnd()}`
  execAsync([
    "wl-copy",
    "--",
    text.length > MAX_CLIP_CHARS ? `${text.slice(0, MAX_CLIP_CHARS)}\n…` : text,
  ]).catch(() => {})
}

// Runs `command` through a shell, detached, and reports an early failure.
// `label` names the thing in the notification (the app's display name).
export function launchCommand(command: string, label: string) {
  const log = `${GLib.get_user_runtime_dir()}/mybar-launch-${counter++}.log`
  const startedAt = GLib.get_monotonic_time() / 1000

  let proc: Gio.Subprocess
  try {
    proc = Gio.Subprocess.new(
      ["bash", "-c", `exec ${command} >"${log}" 2>&1`],
      Gio.SubprocessFlags.NONE,
    )
  } catch (e) {
    copyFailure(command, String(e))
    notifyFailure(label, `${String(e)}\n\n(copied to clipboard)`)
    return
  }

  proc.wait_async(null, (self, res) => {
    try {
      self!.wait_finish(res)
    } catch {
      remove(log)
      return
    }
    const elapsed = GLib.get_monotonic_time() / 1000 - startedAt
    if (!self!.get_successful() && elapsed < REPORT_WINDOW_MS) {
      const output = read(log)
      const reason = output.trim() || `Exited with code ${self!.get_exit_status()}.`
      copyFailure(command, reason)
      notifyFailure(label, `${excerpt(reason)}\n\n(copied to clipboard)`)
    }
    remove(log)
  })
}
