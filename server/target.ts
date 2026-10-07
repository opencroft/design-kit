// Where a consumer installs a file, and nothing else.
//
// Kept free of the host so the one property target migration rests on can be
// exercised directly: migrating a component must not move a single served
// path. That is a claim about a function, and it is checked as one.

/** Matches OpenCroft's slugify — turns a display name into a namespace-shaped string. */
export function slugify(name: string): string {
  const base = String(name ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'components'
}

/**
 * The namespace a project publishes under — the ONE definition of it.
 *
 * A project's slug is fixed when it is created and is its permanent address; a
 * display name can be changed afterwards and takes no address with it, so the
 * two agree only until the first rename. Deriving the namespace from the name
 * is therefore correct only for a project that has no slug of its own, which is
 * the fallback below and nothing else.
 *
 * It lives here, beside `slugify`, so that every surface needing it shares one
 * rule: what a project list advertises, what a registry route accepts, what a
 * cross-project reference resolves against, and what the dependency graph calls
 * unknown. Separate copies keyed off a mutable name would all agree with each
 * other and all be wrong together after a rename, so none of them would look
 * wrong.
 *
 * An empty slug is not an address, so it falls through to the name rather than
 * being published as one.
 */
export function namespaceOf(project: { name: string; slug?: string }): string {
  return project.slug || slugify(project.name)
}

export interface TargetFile {
  path?: string
  target?: string
  type?: string
  content?: string
}

export interface TargetComponent {
  name: string
  type: string
  category: string
  files?: TargetFile[]
  /** @deprecated single-file form; still read for old records. */
  source?: string
  targetsExplicit?: boolean
}

/** The path a component's single file gets when nothing else says otherwise. */
export function targetPath(component: { name: string; type: string }): string {
  return component.type === 'registry:hook' ? `hooks/${component.name}.ts` : `components/ui/${component.name}.tsx`
}

// Insert the component's category as a subfolder in a `components/ui/*`
// target (`components/ui/x.tsx` → `components/ui/<catslug>/x.tsx`). Hook/lib
// targets (anything outside `components/ui/`) and components with no/empty
// category are served flat, unchanged. A target that already has a subfolder
// segment there is left alone too — some stored records already bake the
// category into `target` itself, and composing onto that would double the path.
// Checked structurally (any existing subfolder), not by comparing against
// `slugify(category)`: a category like "Layouts" slugifies to "layouts", but
// the folder already stored for those items is "layout" (singular) — a
// slug-equality check would miss that case and still nest a second, wrong
// segment underneath it.
export function categorizedTarget(target: string, category: string): string {
  const prefix = 'components/ui/'
  const cat = category.trim()
  if (!target.startsWith(prefix) || !cat) {
    return target
  }
  const rest = target.slice(prefix.length)
  if (rest.includes('/')) {
    return target
  }
  return `${prefix}${slugify(cat)}/${rest}`
}

/**
 * The path a consumer installs this file at — the one definition of it, and
 * the value the served-target invariant is over.
 *
 * Once a component carries explicit targets the stored value is served
 * verbatim: the author decides the layout, not the kit's taxonomy, and a
 * category rename relocates no file at any consumer. Until then, the category
 * composes into the path.
 *
 * A file with no stored target falls back to its own path, then to the
 * component's default. For a component with explicit targets, that fallback is
 * the only place a category composes a path.
 */
export function servedTarget(file: TargetFile, component: TargetComponent): string {
  const stored = String(file.target ?? '').trim()
  if (component.targetsExplicit && stored) {
    return stored
  }
  return categorizedTarget(stored || String(file.path ?? '').trim() || targetPath(component), component.category)
}

/** Where a served file sits, and where it was stored — a rewrite needs both. */
export interface ImportOrigin {
  stored: string
  served: string
}

/**
 * Where each referable file actually lands, keyed the two ways a source can
 * name one: by component name for the `@/components/ui/<name>` alias, and by
 * stored path for a relative specifier, which resolves against the layout the
 * source was WRITTEN in rather than the one it installs into.
 */
export interface ImportTargets {
  byName: Record<string, string>
  byStoredPath: Record<string, string>
}

const dropExtension = (path: string): string => path.replace(/\.[a-z]+$/i, '')

/** `a/b/c.tsx` → `a/b`. A path with no directory yields the empty string. */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/** Everything served under this prefix belongs to the consumer's shared package. */
const SHARED_PREFIX = 'components/ui/'

/**
 * Whether a served file lands in the shared package — the one bit a target
 * prefix carries about a consumer's layout.
 *
 * `components/ui/` is the shared package, the one a consumer addresses through
 * its `ui` alias; everything else belongs to whatever package the importer is
 * in. Two files that agree on this bit land together and can name each other by
 * path. Two that disagree cannot: a relative path would have to cross a package
 * boundary, and the library knows there is one without knowing what is on the
 * far side of it.
 *
 * Hooks and `lib/` files fall on the "with the importer" side by construction.
 * That is the right answer for the layouts this serves, and it is not a
 * measurement: it has not been checked against a real reference between a hook
 * target and a component target.
 */
function inSharedPackage(target: string): boolean {
  return target.startsWith(SHARED_PREFIX)
}

/**
 * A path from one served file to another, extensionless and always prefixed —
 * `./sibling` or `../elsewhere/file`, never a bare `sibling`, which a bundler
 * would read as a package name.
 */
function relativeSpecifier(fromServed: string, toServed: string): string {
  const from = directoryOf(fromServed).split('/').filter(Boolean)
  const to = dropExtension(toServed).split('/')
  let common = 0
  // `to.length - 1` because the file's own name is never a shared directory.
  while (common < from.length && common + 1 < to.length && from[common] === to[common]) {
    common++
  }
  const rest = to.slice(common).join('/')
  const up = from.length - common
  return up > 0 ? `${'../'.repeat(up)}${rest}` : `./${rest}`
}

/** Resolve `./x` or `../y/x` against a directory, collapsing `.` and `..`. */
function resolveRelative(fromDir: string, specifier: string): string {
  const out: string[] = fromDir ? fromDir.split('/') : []
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') {
      continue
    }
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.join('/')
}

/**
 * Rewrite a served file's imports of other design-kit components to where those
 * components actually install.
 *
 * The point is that **how a reference was authored does not decide whether it
 * resolves.** A component's served target carries its category, so two
 * components in one project install into different directories: a relative
 * specifier written when both sat in one stored directory resolves to nothing
 * after install, and an alias rewritten from a category is only right while the
 * category is what decides the path — which is not the case once stored
 * targets are authoritative. Both forms are resolved to the importee's real
 * target and emitted the same way.
 *
 * The emitted form is decided by the TARGET PREFIX, because that prefix is the
 * only thing this library knows about the consumer's layout. Two files whose
 * targets put them in the same package get a path relative to the importer;
 * two that do not get the alias.
 *
 * A path is what the installer leaves alone. Every `@/` specifier that is not
 * already `@/registry/…` is rewritten by `shadcn add` onto ONE base — the first
 * segment of the consumer's `aliases.components` — so an emitted `@/x` comes
 * back out as `<base>/x` and one base cannot address two packages. A relative
 * specifier passes through untouched and resolves against wherever the pair
 * actually landed, which is the same answer for every consumer. Observed by
 * installing, not read off the CLI's source.
 *
 * So the alias survives only where a path cannot go: across a package
 * boundary, where the library can see that the two files part company but not
 * what the far side is called. That emission is still wrong for a consumer
 * whose packages are separate — there is no alias slot for "some other
 * package", and such a consumer has to carry its own specifier there. It is
 * named here rather than hidden because nothing downstream reports it: the
 * failure lands at the consumer's build, not in this library.
 *
 * THREE authored forms reach this, and only two are rewritten. The alias
 * pattern captures one segment after `components/ui/`, so a CATEGORY-QUALIFIED
 * specifier (`@/components/ui/<cat>/x`) matches nothing and passes through
 * untouched. That is deliberate — it is what makes an already-correct alias
 * come out unchanged — but it also means such a specifier keeps naming a
 * category, and a category rename leaves it pointing nowhere. It is a hazard of
 * its own rather than a case this function handles.
 *
 * A specifier that names nothing this library serves is left exactly as it was.
 */
export function rewriteComponentImports(content: string, importer: ImportOrigin, targets: ImportTargets): string {
  // Same package: a path, which the installer leaves alone. Different package:
  // the alias, which is the only form left and is wrong for a consumer whose
  // packages are separate.
  const emit = (served: string): string =>
    inSharedPackage(served) === inSharedPackage(importer.served) ? relativeSpecifier(importer.served, served) : `@/${dropExtension(served)}`

  // This pass runs FIRST, and the order is load-bearing because both passes can
  // emit a path: the alias pattern below cannot match one, while this pattern
  // would happily re-resolve the alias pass's output against the stored
  // directory a second time. In this order every specifier is resolved once.
  //
  // Quoted so a specifier is only rewritten where one can appear, and resolved
  // against the STORED directory: `./x` was written next to the file as it sits
  // in the library, not as it lands.
  const withPaths = content.replace(/(['"])(\.\.?\/[^'"]*)\1/g, (match, quote: string, specifier: string) => {
    const resolved = dropExtension(resolveRelative(directoryOf(importer.stored), specifier))
    // The path first: if it names a file this library serves, that is the
    // answer and nothing else is guessed at.
    //
    // Then the component of that name. A relative specifier is written against
    // the layout its author had in front of them, and that layout is not the
    // one the file installs into — a sibling written as `./x` when both sat in
    // one directory names a component, not a location, the moment either of
    // them moves. Falling back to the name is what makes the authored form stop
    // deciding whether the import resolves.
    //
    // The cost, stated at its real width. This pass matches any QUOTED STRING
    // that starts with `./` or `../`, not only an import specifier — a
    // `fetch('./data.json')` is indistinguishable from an import here — and the
    // name fallback then redirects it if what it ends in happens to be a
    // component name. Two things keep it off today's paths rather than one: a
    // local file that is itself served matches the path lookup above and never
    // reaches the fallback, and `registry:ignore` files are filtered out before
    // any of this runs, so only installable source is rewritten at all.
    // Narrowing the match to import and export clauses would remove the first
    // half of that and is not done here.
    const served = targets.byStoredPath[resolved] ?? targets.byName[resolved.slice(resolved.lastIndexOf('/') + 1)]
    return served ? `${quote}${emit(served)}${quote}` : match
  })

  // The authored alias form, `@/components/ui/<name>`. Leaving it after the
  // path pass is safe in the one direction that matters: a path this emits is
  // not matched by the pattern above, and an alias it emits is always
  // category-qualified, which this pattern's single captured segment cannot
  // name.
  return withPaths.replace(/@\/components\/ui\/([\w-]+)/g, (match, name: string) => {
    const served = targets.byName[name]
    return served ? emit(served) : match
  })
}

/**
 * The invariant: no two installable files served by this library may carry the
 * same target.
 *
 * The unit is a FILE, not a component. A component serves several files, each
 * with its own target, and it is a file that overwrites another file on
 * install. `registry:ignore` files are out of scope — they are never installed,
 * so they cannot overwrite anything.
 *
 * The scope is the whole library INCLUDING the component's own project. Two
 * components in one project cannot share a name, but the unit is the file, and
 * two components in one category can serve same-named secondary files.
 * Explicit stored targets make a same-project collision reachable outright.
 *
 * Library-wide is an over-refusal, stated rather than discovered: it forbids two
 * components in unrelated projects sharing a target even where no consumer
 * registers both. Nothing the kit can see says which projects a consumer
 * registers, so library-wide is the only thing checkable at authoring time —
 * and it is narrower than the name guard beside it, which refuses on a coarser
 * key.
 *
 * The readers are injected, for the same reason the component store injects
 * `listOtherProjects`: this is a rule about a whole library, and a rule that
 * can only be exercised against a live one is a rule nobody can test. In
 * particular the CROSS-PROJECT branch is unreachable from a library holding
 * one project.
 *
 * `readComponents` must return the EFFECTIVE list — published with drafts laid
 * over it. A guard reading only what is published sees none of the work in
 * progress and lets two components claim one target, which then collide the
 * moment both are published.
 *
 * It is a read, then a decision, then a write by the caller, over storage that
 * offers no compare-and-set. Two concurrent authoring edits can both pass. No
 * atomicity is claimed.
 */
export async function assertTargetsAvailable<T extends TargetComponent & { id: string }>(
  component: T,
  deps: {
    listProjects: () => Promise<Array<{ id: string; name: string }>>
    readComponents: (projectId: string) => Promise<T[]>
    normalizeFiles: (c: T) => TargetFile[]
  },
): Promise<void> {
  const installable = (c: T) => deps.normalizeFiles(c).filter((f) => f.type !== 'registry:ignore')
  const claimed = new Set(installable(component).map((f) => servedTarget(f, component)))
  if (claimed.size === 0) {
    return
  }
  for (const project of await deps.listProjects()) {
    for (const other of await deps.readComponents(project.id)) {
      // A component does not collide with itself: this is the record being
      // replaced, matched by the id that survives a rename.
      if (other.id === component.id) {
        continue
      }
      for (const f of installable(other)) {
        const target = servedTarget(f, other)
        if (claimed.has(target)) {
          throw new Error(
            `Refusing to serve "${target}" from component "${component.name}": ` +
              `"${other.name}" in project "${project.name}" already serves that exact path, ` +
              `so installing both would overwrite one with the other. ` +
              `Give this component a different target, or a different category.`,
          )
        }
      }
    }
  }
}

/**
 * The component with today's served targets written into its stored ones.
 *
 * The values are what it was already serving, so this moves no consumer's file
 * and diffs no install — which is the whole reason to migrate rather than flip
 * authority underneath existing installs. What changes is who decides them
 * afterwards.
 *
 * `normalizeFiles` is passed in rather than imported because materialising the
 * legacy single-`source` form is the library's own rule, not this module's.
 */
export function withExplicitTargets<T extends TargetComponent>(component: T, normalizeFiles: (c: T) => TargetFile[]): T {
  if (component.targetsExplicit) {
    return component
  }
  return {
    ...component,
    targetsExplicit: true,
    files: normalizeFiles(component).map((f) => ({ ...f, target: servedTarget(f, component) })),
    source: undefined,
  }
}
