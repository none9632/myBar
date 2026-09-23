import GLib from "gi://GLib"

// Terminal used for commands that print to a console.
//
// `--hold` keeps the window open after the command exits — without it the
// terminal closes the instant the output is printed, which looks identical to
// nothing having happened. Each terminal spells it slightly differently, hence
// the table rather than a bare name.
const TERMINALS = [
  { bin: "kitty", wrap: (line: string) => `kitty --hold ${line}` },
  { bin: "alacritty", wrap: (line: string) => `alacritty --hold -e ${line}` },
  { bin: "foot", wrap: (line: string) => `foot --hold ${line}` },
]

export function terminal() {
  for (const t of TERMINALS) if (GLib.find_program_in_path(t.bin)) return t
  return null
}

// Wraps a command so it runs in a terminal window, or returns it unchanged when
// none of the known terminals is installed.
export function inTerminal(line: string): string {
  return terminal()?.wrap(line) ?? line
}
