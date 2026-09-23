// The contract between the launcher window and whatever produces its rows.
//
// The window knows nothing about applications, files or calculators: it renders
// SpotlightItems and calls `activate` on the selected one. Everything specific to
// a source lives in its provider under `providers/`.

// Cancellation token handed to a provider. Not the web AbortSignal — gjs doesn't
// guarantee that global — but the same idea: the registry flips it when a newer
// query supersedes this one, and a slow provider is expected to check it before
// doing more work or resolving.
export interface Cancel {
  readonly aborted: boolean
}

export interface SpotlightItem {
  // Stable across re-queries: it keys the `<For>`, so a row that survives a
  // keystroke keeps its widget instead of being rebuilt.
  id: string
  icon?: string // icon name or path
  title: string
  subtitle?: string
  // Short tail on the right of the row, naming the source or the Enter action.
  badge?: string
  // Higher sorts first; ties break on title. Each provider defines its own scale,
  // which only matters once several of them answer the same query.
  score: number
  activate(): void
  // Shift+Enter, when the item has a meaningful second action (run in a terminal,
  // reveal in the file manager…). Falls back to `activate`.
  altActivate?(): void
}

export interface Provider {
  id: string
  // When set, a query starting with it is routed to this provider alone, with the
  // prefix stripped (e.g. "=" for the calculator). Providers without one answer
  // the default, unprefixed query.
  prefix?: string
  // Shown in the entry while this provider's mode is active.
  placeholder?: string
  // Skip the provider until the query is at least this long — for sources whose
  // search costs a subprocess.
  minQueryLength?: number
  // Lets a prefixed provider also answer the *unprefixed* query when the text
  // clearly belongs to it — "2+2" reaching the calculator without typing "=".
  claims?(query: string): boolean
  // Wait this long after the last keystroke before searching. For providers that
  // spawn a process, so a fast typist doesn't start one per character.
  debounceMs?: number
  // Answer only when nothing else did. For sources that are too broad to mix into
  // every query but are the obvious next guess once the usual ones come up empty —
  // $PATH binaries after the app list finds nothing.
  fallback?: boolean
  search(query: string, cancel: Cancel): SpotlightItem[] | Promise<SpotlightItem[]>
}
