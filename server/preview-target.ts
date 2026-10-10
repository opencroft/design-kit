// Which block of a component's doc page a standalone preview is showing.
//
// The embedded preview blocks on a doc page each render a DIFFERENT thing —
// the `<Preview>` orchestrator, and one snippet per `<Example>` — so each Open
// button's link has to say which block it means. A URL naming only the project
// and the component would always open the main preview: pressing Open on the
// third example would silently show the first block instead, and nothing on
// the page would say the link had substituted anything.
//
// What the link carries is a TARGET NAME, never the code. A link carrying code
// would make opening it the same act as executing it, which is a capability
// this page deliberately does not have (see the note on the sandbox API in
// preview-runtime/entry.tsx). A name is resolved here, server-side, against the
// component's own stored doc — so the only thing a crafted link can ask for is
// a block that component already has.
//
// The names are the VALIDATOR's names (`preview`, `example:<src>` — see
// server/validate.ts), so a target that fails a check and a target a reader
// opens are the same string. One thing extra: a `<Preview>` is addressable by
// its own src as well (`preview:<src>`), because a doc may hold more than one
// and bare `preview` can only ever mean the first.
//
// Host-free on purpose: this is the whole policy behind a URL parameter that
// reaches a route, so it is exercised directly rather than through one.

import type { PreviewMode } from '../preview-runtime/protocol.ts'
import { type DocSegment, defaultProps, docsRelative, parseDoc, resolveSrc } from '../src/live/doc-parser.ts'

export interface TargetFileLike {
  path?: string
  target?: string
  content: string
}

/**
 * The doc files map a `docs/doc.mdx` resolves its tag `src` attributes
 * against, keyed by docs-relative path. Same construction as the validator's
 * `docFiles` and the client's `docFilesMap`; this is the copy the preview
 * routes use.
 */
export function docFilesOf(files: TargetFileLike[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const f of files) {
    const key = f.target || f.path || ''
    if (key.startsWith('docs/')) {
      map[key.slice('docs/'.length)] = f.content
    }
  }
  return map
}

/** The name under which a doc segment is addressable, or null if it is not. */
function labelOf(seg: DocSegment): string | null {
  if (seg.kind === 'preview') {
    return `preview:${docsRelative(seg.src)}`
  }
  if (seg.kind === 'example') {
    return `example:${docsRelative(seg.src)}`
  }
  return null
}

/** Every block of this doc a standalone preview can be opened on. */
export function docTargets(mdx: string): string[] {
  const out: string[] = []
  for (const seg of parseDoc(mdx)) {
    const label = labelOf(seg)
    if (label) {
      out.push(label)
    }
  }
  return out
}

export interface ResolvedPreviewTarget {
  /** the name this resolved to, canonicalized — never the name as asked */
  target: string
  mode: PreviewMode
  code: string
  props?: Record<string, unknown>
}

export interface UnresolvedPreviewTarget {
  error: string
  /** what this doc does offer, so the refusal is actionable rather than a "no" */
  available: string[]
}

export type PreviewTargetResult = ResolvedPreviewTarget | UnresolvedPreviewTarget

export function isResolved(result: PreviewTargetResult): result is ResolvedPreviewTarget {
  return (result as ResolvedPreviewTarget).code !== undefined
}

/**
 * Resolve a requested target against a component's doc.
 *
 * An empty request means "this component's main preview" — the first
 * `<Preview>` — which is what a link with no target in it means and what the
 * component tree's own Open does. It is the one name that is allowed to
 * resolve to something it does not spell out, and it resolves to nothing
 * rather than to a substitute when the doc has no `<Preview>`: a page that
 * quietly shows a different block is what this exists to prevent, and doing
 * it here for the default would only move it.
 */
export function resolvePreviewTarget(
  mdx: string,
  docs: Record<string, string>,
  requested: string | null | undefined,
): PreviewTargetResult {
  const segments = parseDoc(mdx)
  const available = docTargets(mdx)
  const asked = String(requested ?? '').trim()

  const wantsDefault = asked === '' || asked === 'preview'
  const addressable = segments.filter(
    (s): s is Extract<DocSegment, { kind: 'preview' | 'example' }> => s.kind === 'preview' || s.kind === 'example',
  )
  const seg = wantsDefault
    ? addressable.find((s) => s.kind === 'preview')
    : addressable.find((s) => labelOf(s) === asked)

  if (!seg) {
    return {
      error: wantsDefault
        ? 'This component has no <Preview> in its documentation.'
        : `No documented preview named "${asked}".`,
      available,
    }
  }

  const code = resolveSrc(docs, seg.src)
  if (code == null) {
    return { error: `missing file: ${seg.src}`, available }
  }

  if (seg.kind === 'preview') {
    // The controls' defaults, and only those: a standalone page has no props
    // table to drive them, so the honest thing to show is the state the doc
    // page itself opens in.
    return {
      target: `preview:${docsRelative(seg.src)}`,
      mode: 'default-export',
      code,
      props: defaultProps(seg.controls),
    }
  }
  // `snippet`, matching how the doc page renders an <Example> (see
  // src/components/live-example.tsx) — an example is an expression evaluated
  // against the pool, not a module with a default export.
  return { target: `example:${docsRelative(seg.src)}`, mode: 'snippet', code }
}
