// What the validator CONCLUDES, kept apart from how it finds out. The pipeline
// in server/validate.ts imports its dependencies without file extensions —
// esbuild resolves those, Node does not — so that module cannot be loaded by
// the test runner at all, and a verdict reachable only through a full pool
// build is a verdict nobody tests. Same seam, and the same reason, as
// doc-coverage.ts.
//
// One rule decides everything here: EVALUATING a component is not CHECKING it.
// A module body whose import resolved to nothing evaluates successfully — the
// binding is `undefined` and nothing has read it yet — so counting evaluation
// as a pass gives a component with nothing to render a green answer from a
// check that never ran.

/**
 * `ok` rendered; `error` a defect to fix; `unverifiable` needs a browser and
 * cannot be judged here. Three states deliberately: a boolean has to fold
 * "not checked" into one of the other two, and both ways of folding it lie.
 */
export type TargetOutcome = 'ok' | 'error' | 'unverifiable'

export interface ValidateTarget {
  /** 'dependencies' | 'source' | 'render' | 'preview' | 'example:<path>' | 'sheet:<prop>' */
  target: string
  outcome: TargetOutcome
  error?: string
  /**
   * Imports whose value resolved to nothing, so the binding is `undefined` for
   * the whole of this target. Named in the summary whether or not the target
   * rendered: a successful render only covers the paths it happened to take.
   */
  unresolvedImports: string[]
}

/** The component's own files, evaluated against the finished pool. */
export const SOURCE_TARGET = 'source'

/** The npm packages its sources and docs import, against its declared `dependencies`. */
export const DEPENDENCIES_TARGET = 'dependencies'

/**
 * Stands in for the render loop when a component has nothing to render, so
 * that "never rendered" is an entry in the list rather than an absence from
 * it. An absence is invisible: the count would read `1/1 targets checked`,
 * and the one target would be the evaluation.
 */
export const RENDER_TARGET = 'render'

/**
 * What the validator concluded about the component as a whole, carrying the
 * same three states as a single target and for the same reason. A boolean
 * meaning "no target failed" is vacuously true of a component that had
 * nothing able to fail — and it reads as a pass. `unverified` is that case
 * said out loud.
 */
export type ComponentVerdict = 'ok' | 'error' | 'unverified'

/**
 * Targets that put the component through a render, as opposed to only
 * evaluating its module body. This distinction is the verdict: `source` on its
 * own establishes that a component parses and evaluates, never that it works.
 */
export function isRenderTarget(target: string): boolean {
  return target === 'preview' || target.startsWith('example:') || target.startsWith('sheet:')
}

/**
 * `unverified` covers TWO populations, and only the first is obvious: a
 * component with no doc page, and a component whose doc page has render
 * targets of which none COMPLETED — every one `unverifiable` because it reads
 * a browser-only global during render. The second is easy to mistake for a
 * pass, since an unverifiable target has never failed anything. It is the same
 * sentence in both cases and it is true in both: nothing rendered this
 * component here, so nothing about it was established beyond that it
 * evaluates.
 */
export function verdictOf(targets: readonly ValidateTarget[]): ComponentVerdict {
  if (targets.some((t) => t.outcome === 'error')) {
    return 'error'
  }
  return targets.some((t) => isRenderTarget(t.target) && t.outcome === 'ok') ? 'ok' : 'unverified'
}

/**
 * The pool's diagnostics that cannot have come from this component.
 *
 * The pool evaluates every component's group into one flat list of strings
 * carrying no attribution, so the only sound statement about an entry is a
 * negative: one this component's own evaluation did not also produce belongs
 * to another group. An identical string produced by BOTH — two components
 * importing the same missing name is the ordinary case — is indistinguishable
 * here, and is counted as this component's rather than blamed on a neighbour.
 */
export function diagnosticsFromOtherGroups(poolDiagnostics: readonly string[], ownEvaluation: ValidateTarget | undefined): string[] {
  const own = new Set<string>(ownEvaluation?.unresolvedImports ?? [])
  if (ownEvaluation?.error) {
    own.add(ownEvaluation.error)
  }
  return poolDiagnostics.filter((d) => !own.has(d))
}

/**
 * The last validation a component's draft saw, kept so a LATER moment can
 * report it. The save that ran the check and the publish that ships what it
 * found can be hours, a reload, or a different person apart, and a failure
 * nobody is shown at the moment of shipping may as well not have been found.
 *
 * It holds the validator's own target rows rather than a second wording of
 * them: a surface reporting this record and one reporting a fresh result have
 * to describe the same failure in the same words, and one shape is the only
 * way that is guaranteed rather than maintained.
 */
export interface ValidationSummary {
  /** No target failed. Says nothing about targets that could not be checked. */
  ok: boolean
  failed: ValidateTarget[]
  /** When the check ran, so a reader can tell a fresh record from a stale one. */
  at: number
}

export function summarizeValidation(targets: readonly ValidateTarget[], at: number): ValidationSummary {
  const failed = targets.filter((t) => t.outcome === 'error')
  return { ok: failed.length === 0, failed, at }
}

const isValidateTarget = (value: unknown): value is ValidateTarget => typeof (value as ValidateTarget | undefined)?.target === 'string'

/**
 * A stored summary read back, which is not the same as a summary: the record
 * outlives its own shape. An entry in the older shape holds bare target names
 * instead of the validator's rows, and a name cannot be worded as a failure —
 * so such an entry answers as NO record rather than as a report nobody can act
 * on, and the next save replaces it.
 *
 * **The distinction that branch hides is worth saying out loud because
 * nothing observes it:** "no record" and "a record I cannot read" leave here
 * as the same answer, so a caller that warns on failures warns for neither.
 * If a store is ever found holding the older shape, the two answers have to
 * become distinguishable before anything relies on this one.
 */
export function readValidationSummary(stored: { ok: boolean; failed: unknown[]; at: number } | undefined): ValidationSummary | undefined {
  if (!stored) {
    return undefined
  }
  const rows = stored.failed.filter(isValidateTarget)
  return rows.length === stored.failed.length ? { ...stored, failed: rows } : undefined
}

export interface Judgement {
  verdict: ComponentVerdict
  /** One line carrying the whole answer, for a caller that reads nothing else. */
  summary: string
}

/**
 * The verdict and its one-line summary, produced together so the sentence and
 * the field can never disagree about the same run.
 *
 * Unresolved imports are NAMED but do not by themselves fail a component,
 * because the list cannot tell a defect from a style choice. Once imports are
 * stripped, a type imported without the `type` keyword is indistinguishable
 * from a missing runtime value: both resolve to nothing and both are reported.
 * That is a property of the evaluator, not a guess about how components happen
 * to be written — and a check that fires on healthy ones is the check that
 * gets ignored.
 */
export function judge(targets: readonly ValidateTarget[], poolDiagnostics: readonly string[]): Judgement {
  const verdict = verdictOf(targets)
  const count = (o: TargetOutcome) => targets.filter((t) => t.outcome === o).length
  const parts: string[] = []
  if (verdict === 'unverified') {
    parts.push('not verified — nothing rendered this component')
  }
  parts.push(`${count('ok')}/${targets.length} targets checked`)
  if (count('error') > 0) {
    parts.push(`${count('error')} failed`)
  }
  if (count('unverifiable') > 0) {
    parts.push(`${count('unverifiable')} not checkable here, see the target's own reason`)
  }
  const unresolved = [...new Set(targets.flatMap((t) => t.unresolvedImports))]
  if (unresolved.length > 0) {
    parts.push(
      `${unresolved.length} unresolved import${unresolved.length === 1 ? '' : 's'} of this component's own — ` +
        `${unresolved.join(', ')} — undefined wherever used; write \`import type\` for any that are types`,
    )
  }
  const foreign = diagnosticsFromOtherGroups(poolDiagnostics, targets.find((t) => t.target === SOURCE_TARGET))
  if (foreign.length > 0) {
    parts.push(`${foreign.length} diagnostics from other components in the shared preview pool, see poolDiagnostics`)
  }
  return { verdict, summary: `${parts.join('; ')}.` }
}
