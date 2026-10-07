// ── Addressing one component ─────────────────────────────────────────
// A component reference names one component of one design project as a single
// string: `<project>.<name>`, or `<project>/<name>`. The two separators mean
// the same thing, and a reference is WRITTEN with the dot.
//
// The dot is a precaution rather than a fix for an observed failure: every use
// inside this kit is a query value, where both separators are legal and both
// are verified working. It is preferred because a reference gets copied by
// hand into places a query value's rules do not follow it — a path segment, a
// filename, a message that formats anything slash-shaped as a path — and the
// dot has no second meaning in any of them. Anyone weighing a third form
// should know that this argument is precautionary, not evidence.
//
// `<project>` is a project's namespace slug or its storage id, `<name>` is a
// component slug. Neither can hold a `/` or a `.`: names and namespaces are
// slugified on write, and ids are generated. So the first separator is the
// only one that divides the two halves, whichever character it is.
//
// One grammar serves every entry point that takes a component — the
// registry's HTTP routes, and the App's legacy `?component=` link, which
// opens the component it names — so a reference copied out of one addresses
// the same component in the other.
//
// This module is taken by the SERVER bundle too (server/index.ts imports it by
// deep path, not through src/registry's barrel, so the barrel's client-only
// siblings stay out of that bundle). It must stay host-free — no DOM, no
// React, no `@ext/host` — because anything added here follows into a bundle
// that has none of them.

export interface ComponentRef {
  /** Project namespace or storage id; resolved by whoever reads the reference. */
  project: string
  /** Component slug within that project. */
  name: string
}

const SEPARATOR = /[/.]/

/**
 * Drop the `.json` a registry client appends when it resolves an item through
 * a URL template. Applied to the WHOLE reference before the separator is
 * looked for, which is what keeps a bare `<name>.json` from reading as a
 * two-part reference whose project is the name and whose name is `json`.
 */
export function stripItemSuffix(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/\.json$/, '')
}

/**
 * Read `<project>.<name>` or `<project>/<name>`; null unless both halves are
 * there. A component literally named `json` is unreachable in the dot form —
 * `<project>.json` is indistinguishable from a suffixed project reference —
 * and is addressed with the slash instead.
 */
export function parseComponentRef(raw: unknown): ComponentRef | null {
  const ref = stripItemSuffix(raw)
  const at = ref.search(SEPARATOR)
  if (at <= 0 || at === ref.length - 1) {
    return null
  }
  return { project: ref.slice(0, at), name: ref.slice(at + 1) }
}

/**
 * The form a reference is WRITTEN in. Both separators are read; every link and
 * command this kit hands out carries the dot, so a copied one has one shape
 * and keeps it wherever it is pasted.
 */
export function formatComponentRef(project: string, name: string): string {
  return `${project}.${name}`
}

// ── Reading a reference off a URL ────────────────────────────────────
// One precedence rule, used by every route: a `component` reference names the
// project as well as the name, so when a caller sends both it is the reference
// that wins. The alternative — each route picking its own order — makes the
// same query string act in different projects depending on which route read
// it, and the item route's delegation to the index route sends one query
// string through two of them.

/**
 * The component a route acts on. The separate `project` + `name` pair is read
 * as well, because two kinds of caller send it: the `registries`
 * template, which a client substitutes `{name}` into as a whole query value,
 * and every install command already copied into another repository's docs.
 */
export function componentRefFromQuery(url: URL): ComponentRef | null {
  const ref = parseComponentRef(url.searchParams.get('component'))
  if (ref) {
    return ref
  }
  const project = url.searchParams.get('project') ?? ''
  const name = stripItemSuffix(url.searchParams.get('name'))
  return project && name ? { project, name } : null
}

/**
 * The project a route acts in — for the routes that need only that half. A
 * reference stays sufficient on them, under the same precedence.
 */
export function projectFromQuery(url: URL): string {
  return parseComponentRef(url.searchParams.get('component'))?.project || url.searchParams.get('project') || ''
}
