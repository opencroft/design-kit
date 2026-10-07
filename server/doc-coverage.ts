// The two judgements the validator makes about a document, as pure functions.
//
// Both exist because a verdict computed from targets is vacuously clean over a
// document that produced no targets: the check reports success hardest when
// there is nothing there. Answering that needs no React, no eval pool and no
// render, so it lives here and is checked directly against a table -- the
// validator itself cannot be loaded by the test runner at all, and a decision
// that can only be exercised through a full run is a decision nobody tests.

/**
 * Every control kind a doc may declare. This is the runtime half of the
 * `Control` union in the registry types: that union is erased at compile time,
 * and the controls themselves arrive from a parsed attribute expression that is
 * CAST rather than validated, so nothing checks them unless this does.
 */
export const CONTROL_KINDS = ['enum', 'boolean', 'text'] as const

export type ControlKind = (typeof CONTROL_KINDS)[number]

export interface UnknownControlKind {
  /** The control's `name`, so the report says which one rather than only that one is wrong. */
  control: string
  /** What was written. Named back, because "invalid kind" alone leaves the author guessing. */
  kind: string
}

/**
 * Controls whose `kind` is not one this project understands.
 *
 * Outside this check, a control with an unrecognised kind is not rejected: value
 * coercion switches on `boolean` and lets everything else fall through, so the
 * control silently does nothing and the document renders without it. That is
 * the same vacuous green as a document with no targets, reached from the other
 * side -- a value outside the set is not in the set of things that can fail.
 */
export function unknownControlKinds(controls: readonly unknown[]): UnknownControlKind[] {
  const permitted = new Set<string>(CONTROL_KINDS)
  const found: UnknownControlKind[] = []
  for (const raw of controls) {
    const c = (raw ?? {}) as { name?: unknown; kind?: unknown }
    const kind = typeof c.kind === 'string' ? c.kind : String(c.kind)
    if (!permitted.has(kind)) {
      found.push({ control: typeof c.name === 'string' ? c.name : '(unnamed)', kind })
    }
  }
  return found
}

/**
 * What a document turned out to be, so that "nothing to check" stops being
 * spelled the same way as "checked, nothing wrong".
 *
 * `absent` and `prose` are legitimate and must stay legitimate: a component is
 * authored source-first and documented after, and a document may be an
 * explanation with nothing to render. A check that failed either would be
 * noise, and a noisy check is one that gets switched off.
 *
 * `truncated` is the defect. The parser's recovery on a tag it cannot close is
 * to push the remainder of the file as one markdown segment and stop, so a
 * document can declare tags and yield none of them, or yield only the ones
 * before the break. Comparing what the source declares against what parsing
 * produced is what makes that visible; nothing downstream can otherwise see it.
 */
export type DocCoverage =
  | { state: 'absent' }
  | { state: 'prose' }
  | { state: 'covered'; declared: number; parsed: number }
  | { state: 'truncated'; declared: number; parsed: number }

// Tags inside code, or commented out, are being SHOWN or DISABLED, not
// declared -- the docs demonstrate their own syntax constantly, so counting
// those reports a healthy page as truncated.
//
// Every way of doing that has to be covered, not the common ones, and the
// reason is the whole argument for this check existing: a check that fires on
// healthy documents gets switched off, and then the defect it was built for is
// invisible again with a plausible excuse attached. A missed case here is worse
// than no check at all.
//
// Stripping too much is the safe direction. It can only ever under-report a
// truncated document, never condemn a healthy one.
function withoutCodeSpans(src: string): string {
  return (
    src
      // Fenced blocks: either fence character, any language tag, closing fence
      // at the start of its own line. An unclosed fence deliberately does not
      // match rather than swallowing the rest of the file.
      .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '')
      // A JSX comment -- `{/* <Preview … /> */}` is the ordinary way to turn a
      // tag off for a moment, which doc authors do constantly.
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      // An indented code block: four spaces or a tab opening the line.
      .replace(/^(?: {4}|\t)[^\n]*$/gm, '')
      // Inline code.
      .replace(/`[^`\n]*`/g, '')
  )
}

const TAG_OPEN = /<(?:Preview|Sheet|Example)\b/g

export function docCoverage(mdx: string | undefined, parsedTagSegments: number): DocCoverage {
  if (mdx === undefined) {
    return { state: 'absent' }
  }
  const declared = (withoutCodeSpans(mdx).match(TAG_OPEN) ?? []).length
  if (declared === 0) {
    return { state: 'prose' }
  }
  return { state: declared > parsedTagSegments ? 'truncated' : 'covered', declared, parsed: parsedTagSegments }
}

/** The sentence a truncated document reports, naming both counts. */
export function truncatedMessage(coverage: Extract<DocCoverage, { state: 'truncated' }>): string {
  const lost = coverage.declared - coverage.parsed
  return (
    `doc.mdx declares ${coverage.declared} component tag${coverage.declared === 1 ? '' : 's'} but parsing produced ${coverage.parsed}: ` +
    `${lost} ${lost === 1 ? 'was' : 'were'} discarded, which happens when a tag's attributes cannot be closed ` +
    `(an unescaped apostrophe inside a controls expression does it) -- everything from that tag onwards is read as prose`
  )
}
