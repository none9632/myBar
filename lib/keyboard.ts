import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland?version=0.1"

// Keyboard-layout helper for overlays that take text input.
//
// Searching for "firefox" while a cyrillic layout is active matches nothing, so
// Spotlight (and later the prompt/menu modes) forces latin on open. Unlike the
// old rofi scripts — which ran `hyprctl switchxkblayout … 0` and left you on
// english afterwards — the previous layout is restored on close.
//
// Hyprland only reports the *friendly* layout name ("Russian (US Symbols)"), not
// its index in `kb_layout`, and mapping one to the other is guesswork. So the
// restore cycles `next` until the tracked name matches what was active before —
// with the usual two layouts that is a single step.

const LATIN_INDEX = 0 // index into hyprland's kb_layout list ("us,ru-us")
const SETTLE_MS = 60 // time for hyprland to apply a switch and emit the signal
const MAX_CYCLES = 4 // guard: never loop forever through the layout list

let device = "" // main keyboard's device name
let current = "" // its active_keymap

// Call once at startup. The signal keeps `current` fresh — including layouts the
// user toggles by hand — so no polling is needed at open/close time.
export function initKeyboard() {
  const hypr = Hyprland.get_default()
  // Deliberately unfiltered: the signal's keyboard argument doesn't always match
  // the device name from `hyprctl devices`, and only the main keyboard ever
  // changes layout here. RightPanel's indicator reads it the same way.
  hypr?.connect("keyboard-layout", (_h, _kb: string, layout: string) => {
    current = layout
  })

  execAsync([
    "bash",
    "-c",
    "hyprctl devices -j | jq -r '[.keyboards[] | select(.main)][0] | .name, .active_keymap'",
  ])
    .then((out) => {
      const [name, keymap] = out.trim().split("\n")
      device = name ?? ""
      current = keymap ?? ""
    })
    .catch(() => {})
}

function switchTo(target: number | "next") {
  if (!device) return
  execAsync(["hyprctl", "switchxkblayout", device, String(target)]).catch(() => {})
}

// Switch to latin and return the undo. The undo is safe to call even if the
// switch never happened (no hyprland, unknown device) — it just does nothing.
export function forceLatinLayout(): () => void {
  const before = current
  switchTo(LATIN_INDEX)
  return () => restore(before)
}

function restore(before: string) {
  if (!before || !device) return
  let tries = 0
  const step = () => {
    if (current === before || tries++ >= MAX_CYCLES) return GLib.SOURCE_REMOVE
    switchTo("next")
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, step)
    return GLib.SOURCE_REMOVE
  }
  // Wait once before the first check: the switch to latin may still be in flight.
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, step)
}
