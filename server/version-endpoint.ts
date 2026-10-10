// One end of a comparison over a component's history, and how to say it back to
// whoever asked. Host-free.
//
// The spelling function exists so that ONE site spells an endpoint. A template
// at each call site plus a two-member assumption is all it takes to ship
// `vnone` into the exact case the empty state exists to serve; a single site is
// the protection.
//
// The ordering below is the first protection, and it needs no compiler: the
// `v` prefix belongs to a NUMBER rather than to "not draft and not none", so a
// fourth member cannot fall into `v${at}` and come back as `vhead`. The `never`
// line makes a fourth member a type error under `npm run typecheck`; it is
// erased at build, so the `throw` beside it is what holds at run time.

export type VersionEndpoint = number | 'draft' | 'none'

/** How to name one end inside a sentence. */
export function endpointLabel(at: VersionEndpoint): string {
  if (typeof at === 'number') {
    return `v${at}`
  }
  if (at === 'draft') {
    return 'its draft'
  }
  if (at === 'none') {
    return 'the state before its first version'
  }
  const unhandled: never = at
  throw new Error(`endpointLabel: unhandled endpoint ${String(unhandled)}`)
}

/**
 * Why an end of a requested comparison could not be read.
 *
 * The message has to distinguish two failures that look identical from where
 * the caller stands, because they call for opposite responses:
 *
 *   ABOVE the versions held  — that version has not been published yet, so the
 *                              answer is to wait or to ask for a lower one.
 *   BELOW them               — it predates what this project stores, so no
 *                              comparison against it exists to be had.
 *
 * The second carries a warning that is the whole reason this message was worth
 * writing. A caller told only "nothing at v5" reaches for the nearest other
 * value in the schema, and the nearest one is `"none"` — which resolves, and
 * answers with every file added at the earliest version held. That is a
 * complete, specific, fabricated history, handed to whoever was looking for a
 * way to proceed. Saying "not here" without closing that exit is most of a
 * trap.
 */
export function unreachableEndpointMessage(name: string, missing: VersionEndpoint, held: number[]): string {
  const head = `"${name}" has nothing at ${endpointLabel(missing)}.`
  if (typeof missing !== 'number') {
    return head
  }
  if (held.length === 0) {
    return `${head} This project holds no published version of it.`
  }
  const lowest = held[0]
  const highest = held[held.length - 1]
  const range = lowest === highest ? `v${lowest}` : `v${lowest}–v${highest}`
  if (missing > highest) {
    return `${head} This project holds ${range}; v${missing} has not been published.`
  }
  if (missing < lowest) {
    return (
      `${head} This project holds ${range}. Anything below v${lowest} predates the history stored here, so there is no state to compare against — ` +
      `and "none" is not a stand-in for it: "none" is the EMPTY state, so comparing against it would report every file as added at v${lowest}, ` +
      `which is a history this component does not have.`
    )
  }
  return `${head} This project holds ${range}, which does not include v${missing}.`
}
