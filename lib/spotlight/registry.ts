import GLib from "gi://GLib"
import type { Cancel, Provider, SpotlightItem } from "./types"
import apps from "./providers/apps"
import calc from "./providers/calc"
import run from "./providers/run"

// Routes a query to the providers that should answer it and merges what comes
// back. Adding a source means writing one file under `providers/` and listing it
// here — the window never changes.

// Order matters only for prefix lookup; results are ordered by score.
const PROVIDERS: Provider[] = [apps, calc, run]

export interface Route {
  providers: Provider[]
  // The query with any mode prefix stripped.
  query: string
  // Set when a prefix put the launcher into one provider's mode.
  mode?: Provider
}

export function route(text: string): Route {
  for (const p of PROVIDERS) {
    if (p.prefix && text.startsWith(p.prefix)) {
      return { providers: [p], query: text.slice(p.prefix.length), mode: p }
    }
  }
  // No prefix: the default providers, plus any prefixed one that recognises the
  // text as its own ("2+2" is arithmetic whether or not you typed "="), plus the
  // fallbacks — `search` decides whether those actually get asked.
  const providers = PROVIDERS.filter((p) => !p.prefix || p.fallback || p.claims?.(text))
  return { providers, query: text }
}

function merge(byProvider: Map<string, SpotlightItem[]>): SpotlightItem[] {
  // TODO (phase 3+): cap each provider's share here, so one chatty source can't
  // crowd out the rest of an unprefixed query.
  const all: SpotlightItem[] = []
  for (const items of byProvider.values()) all.push(...items)
  return all.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
}

// Bumped by every search; a provider's token compares against it, so results from
// a superseded query are dropped instead of overwriting fresher ones.
let generation = 0

// Runs the query and hands results to `emit`. Synchronous providers land in the
// first (synchronous) call, so an empty query is already populated by the time the
// window maps; slow ones emit again as they resolve.
export function search(text: string, emit: (items: SpotlightItem[]) => void) {
  const gen = ++generation
  const cancel: Cancel = {
    get aborted() {
      return gen !== generation
    },
  }

  const { providers, query } = route(text)
  const collected = new Map<string, SpotlightItem[]>()

  const ask = (p: Provider) => {
    let result: SpotlightItem[] | Promise<SpotlightItem[]>
    try {
      result = p.search(query, cancel)
    } catch (e) {
      console.error(`spotlight: provider "${p.id}" failed:`, e)
      return
    }

    if (Array.isArray(result)) {
      collected.set(p.id, result)
      // Synchronous answers during the initial pass are emitted together below;
      // this only fires for one arriving after a debounce.
      if (settled) emit(merge(collected))
      return
    }
    result
      .then((items) => {
        if (cancel.aborted) return
        collected.set(p.id, items)
        emit(merge(collected))
      })
      .catch((e) => console.error(`spotlight: provider "${p.id}" failed:`, e))
  }

  const askAll = (list: Provider[]) => {
    for (const p of list) {
      if (query.trim().length < (p.minQueryLength ?? 0)) continue

      if (p.debounceMs) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, p.debounceMs, () => {
          if (!cancel.aborted) ask(p)
          return GLib.SOURCE_REMOVE
        })
        continue
      }
      ask(p)
    }
  }

  const count = () => {
    let n = 0
    for (const items of collected.values()) n += items.length
    return n
  }

  let settled = false
  askAll(providers.filter((p) => !p.fallback))
  // Nothing so far, so the fallbacks get their turn — typing "neofetch" lists the
  // binary once no application matches, without having to reach for ">". The
  // decision is made on what answered synchronously: a debounced provider is at
  // most one row arriving later, and it sorts above these anyway.
  if (count() === 0) askAll(providers.filter((p) => p.fallback))

  settled = true
  emit(merge(collected))
}
