// The one declaration of a comparison's endpoints, imported rather than
// restated here. Values of this type CROSS between the two sides — this module
// decides the ends, the server's compare read accepts them — so a second
// declaration would not be a copy of a convenience, it would be a wire contract
// with two authors, diverging in silence the first time one side gained a
// member.
//
// `import type` is load-bearing, not a style preference. It is erased at parse
// time and never resolved, so this adds no dependency of the client bundle on
// the server one. The type-only form builds with zero mention of the server
// module in the output, and the same import written as a VALUE resolves and
// inlines server code into the client bundle.
//
// It is also the only import from `server/` anywhere under `src/`. The
// direction the shipped build proves is the other one — the server bundle
// imports pure helpers out of `src/registry` and `src/live`. That
// asymmetry survives precisely because nothing is pulled across here. Written
// without `type`, it would stop being true.
import type { VersionEndpoint } from '../../server/version-endpoint'

// What a selection on the version timeline means.
//
// A selection is a SET of versions, and the comparison it asks for is the
// change those versions introduced — NOT the difference between its two ends.
// For a selection running from A to B, the comparison runs from the state
// immediately BEFORE A to the state at B:
//
//   v1 alone         nothing → v1
//   v2 alone         v1 → v2
//   v1–v2            nothing → v2
//   v2–v3            v1 → v3
//   the whole line   nothing → the newest point, so every file reads as added
//
// The endpoints reading — plain A → B — is NOT the rule, and it earns a
// paragraph because it is what anyone implementing a two-handled slider writes
// first. It drops the earliest selected version's own changes, and it agrees
// with the rule above on every single-point selection, so a surface built on it
// looks correct until someone pulls the two halves apart.
//
// The draft needs no rule of its own. It is the newest point, so the state
// before it is the last published version and a range ending on it begins
// wherever the rule already says. That is why nothing below branches on it.
//
// ── Below the earliest point held ─────────────────────────────────────────
//
// "The state immediately before A" has to exist. When A is the earliest point
// on the timeline it does not, and there are two different reasons for that
// which must not be given the same answer:
//
//   the component BEGINS here    the empty state. Every file really was added,
//                                and all of it reading as added is the truth.
//
//   the project does not HOLD    refuse. Answering with the empty state would
//   what came before             claim the component was created at a version
//                                it merely survives from.
//
// The second is not hypothetical: a component's earliest held version can be
// above v1. For one that begins at v6, the empty-state answer would report
// every file as newly added at v6 — a specific, plausible, entirely fabricated
// history.

/** One end of a comparison, as the server's compare read names them. Declared
 *  once, on the server side — see the import at the top of this file. */
export type { VersionEndpoint }

export interface TimelinePoint {
  /** A published version number, or the working tree. */
  at: number | 'draft'
  /** What the point is called: "v3", or "Draft". */
  label: string
}

/** The older end when a selection begins at the component's own beginning. */
export const NOTHING_LABEL = 'nothing'

export const DRAFT_LABEL = 'Draft'

export type SelectionComparison =
  | {
      status: 'ok'
      from: VersionEndpoint
      to: VersionEndpoint
      /** The older end's name — a point the user did NOT select, since it is
       *  what the selection is measured against. Shown next to the selection
       *  rather than instead of it: a range reading "v2–v3" that is measured
       *  from v1 looks like a mistake unless both are on screen. */
      fromLabel: string
      /** What the user selected: "v2", or "v1–v3". */
      selectionLabel: string
    }
  | {
      status: 'predatesHistory'
      /** The earliest version this project holds. */
      floor: number
      selectionLabel: string
    }

/**
 * The timeline's points, oldest first — which is the opposite of the version
 * list's newest-first order. Both are right for what they are: a timeline reads
 * left to right in time, a list of what happened lately reads from the top.
 */
export function pointsOf(versions: Array<{ version: number }>, draftAhead: boolean): TimelinePoint[] {
  const published: TimelinePoint[] = [...versions]
    .sort((a, b) => a.version - b.version)
    .map((v) => ({ at: v.version, label: `v${v.version}` }))
  return draftAhead ? [...published, { at: 'draft', label: DRAFT_LABEL }] : published
}

/**
 * The comparison a selection asks for, or the reason it cannot be answered.
 *
 * `from` and `to` index `points`; `floor` is the earliest version the project
 * holds, and 0 when it holds none. Null when the indices address no point,
 * which is a caller with nothing to show rather than a failure to report.
 */
export function comparisonFor(
  points: TimelinePoint[],
  floor: number,
  from: number,
  to: number,
): SelectionComparison | null {
  const first = points[from]
  const last = points[to]
  if (!first || !last) {
    return null
  }
  const selectionLabel = from === to ? first.label : `${first.label}–${last.label}`

  const before = points[from - 1]
  if (before) {
    return { status: 'ok', from: before.at, to: last.at, fromLabel: before.label, selectionLabel }
  }
  if (floor > 1) {
    return { status: 'predatesHistory', floor, selectionLabel }
  }
  return { status: 'ok', from: 'none', to: last.at, fromLabel: NOTHING_LABEL, selectionLabel }
}
