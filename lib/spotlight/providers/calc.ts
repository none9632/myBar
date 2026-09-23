import { execAsync } from "ags/process"
import type { Provider, SpotlightItem } from "../types"
import { hasNamePrefix } from "./apps"

// Calculator and unit/currency converter, backed by qalc.
//
// qalc answers *anything* — `qalc -t firefox` happily prints "0 B" with exit 0 —
// so it never sees an unprefixed query unless it plainly looks like arithmetic.
// Typing "=" forces it regardless, which is also how to reach the syntax the
// heuristic rejects ("=hex(255)").

// Pins the answer above app matches when both reply to the same query.
const SCORE = 1_000_000
// qalc fetches exchange rates on its first run of the day and can sit there.
const TIMEOUT_S = "3"

// Starts like a number or a bracket, and contains something arithmetic. "to" is
// what makes conversions work ("100 usd to eur"); note qalc wants full unit names
// and `to`, not `in` — "2^10 to hex" converts, "2^10 in hex" does not.
const STARTS_NUMERIC = /^[\s\d(.+-]/
const HAS_OPERATOR = /[+\-*/^%]|\bto\b|\bmod\b/
const STARTS_WITH_DIGIT = /^\d/

function looksLikeMath(query: string): boolean {
  const q = query.trim()
  if (q.length > 1 && STARTS_NUMERIC.test(q) && HAS_OPERATOR.test(q)) return true

  // No operator, but it opens with a digit — "0x1f", "5!", "42 celsius". Ambiguous
  // on its own, since an app could be named "2048", so the app list gets first
  // refusal. Expressions that evaluate to themselves ("2" → "2") are dropped by
  // the echo check in `search`, so this costs nothing when the digit was a search.
  return STARTS_WITH_DIGIT.test(q) && !hasNamePrefix(q)
}

const provider: Provider = {
  id: "calc",
  prefix: "=",
  placeholder: "Calculate",
  claims: looksLikeMath,
  debounceMs: 120,

  async search(query, cancel): Promise<SpotlightItem[]> {
    const q = query.trim()
    if (!q) return []

    let out: string
    try {
      out = await execAsync(["timeout", TIMEOUT_S, "qalc", "-t", q])
    } catch {
      return [] // unparseable: qalc exits non-zero only on a real failure
    }
    if (cancel.aborted) return []

    const value = out.trim()
    // An expression qalc couldn't evaluate comes back echoed ("1/0" → "1 / 0");
    // treat that as no answer rather than showing the question as the result.
    if (!value || value.replace(/\s+/g, "") === q.replace(/\s+/g, "")) return []

    return [
      {
        id: "calc",
        icon: "accessories-calculator-symbolic",
        title: value,
        subtitle: q,
        badge: "⏎ copy",
        score: SCORE,
        activate: () => {
          execAsync(["wl-copy", "--", value]).catch(() => {})
        },
      },
    ]
  },
}

export default provider
