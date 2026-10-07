// Where a component's files live inside its repo, and how to say that location
// back to a person. Host-free, and the two directions are kept in one file on
// purpose: they are inverses, and a store that writes a path one way while
// reporting it another is exactly the pair that drifts once it is split.
//
// Meta records path, target and type; this derivation is the only bridge to the
// tree.

const IGNORED_ROOT = 'internal'
/** The directory holding one registry record per component. */
export const META_DIR = 'registry'

/** The part of a file record that decides where the file lives. */
export interface FilePlacement {
  path?: string
  target?: string
  type?: string
}

/**
 * The part of a registry record that decides which paths it owns: the name it
 * is filed under, and the files it declares.
 *
 * The name is carried explicitly rather than assumed to be the component's
 * current one, because the two can differ. A component keeps its identity
 * across a rename and changes its name, so the head can hold this same
 * component filed under what it used to be called.
 */
export interface DeclaredRecord {
  name: string
  files: FilePlacement[]
}

/** A component's registry record — the file whose presence at a ref is what
 *  makes the component exist there. */
export function metaPath(componentName: string): string {
  return `${META_DIR}/${componentName}.json`
}

/**
 * Where a file's CONTENT lives in the repo. Shipped files live at their served
 * target — unique by construction (component-named), which keeps the
 * `components/` tree a genuinely installable shadcn source. `registry:ignore`
 * files are never shipped, and their conventional paths (docs/preview.tsx,
 * docs/doc.mdx) repeat across every component in a project — laying those at
 * their bare path would make any two components collide, corrupting an import
 * of both — so they live under the component instead.
 */
export function storagePath(componentName: string, file: FilePlacement): string {
  if (file.type === 'registry:ignore') {
    return `${IGNORED_ROOT}/${componentName}/${String(file.path || file.target || '')}`
  }
  return String(file.target || file.path || '')
}

/**
 * The inverse, for anything a person reads: the path the component DECLARES.
 * A shipped file already stores at its target and comes back unchanged. An
 * ignored file's storage location is an implementation detail of this layout —
 * `internal/<name>/docs/doc.mdx` means nothing to whoever wrote `docs/doc.mdx`,
 * and naming the internal root in a history entry would leak the layout into
 * the one place a person is trying to read what changed.
 */
export function declaredPath(componentName: string, stored: string): string {
  const prefix = `${IGNORED_ROOT}/${componentName}/`
  return stored.startsWith(prefix) ? stored.slice(prefix.length) : stored
}

/**
 * Every path a component's DRAFT declares: its registry record and the storage
 * location of each file the record names.
 *
 * This is what a reader of the draft owns, and it is the right answer for
 * anything asking about the draft alone. It is NOT the whole pathspec a commit
 * has to cover — see `ownedPaths` below, and read the two together, because
 * mistaking one for the other silently leaves a staged change uncommitted.
 */
export function componentPaths(componentName: string, files: FilePlacement[]): string[] {
  return [metaPath(componentName), ...files.map((f) => storagePath(componentName, f))]
}

/**
 * EVERY path this component owns across the draft AND the published head — the
 * pathspec a commit that changes the whole component has to cover.
 *
 * The failure this guards against is a staged change that no commit was scoped
 * to pick up. Taking the scope from the draft alone produces it: a path the
 * head declares that the draft has DROPPED is still this component's. It is
 * also the one path no future record will ever name
 * again, so nothing later can pick it up: a publish commits one record and the
 * files that record names, and a dropped path is in neither. Left out, the
 * removal stays staged forever while the head goes on serving the file.
 *
 * "Dropped" covers three things, and the third is why the head record arrives
 * as a whole record rather than a list of files. A file deleted from the
 * component; the old side of a file rename inside it; and — when the head files
 * this component under a DIFFERENT NAME — the head's own registry record, plus
 * every path that embedded that old name. A renamed component's old record is
 * the purest case of the rule: the draft has removed it, no future record will
 * ever name it, and left behind it makes the registry serve one component twice.
 *
 * `isGoneFromTree` is what stops the head half going too wide, and it covers
 * the renamed record as well as the files. A path the head declares and the
 * draft does not, but which EXISTS in the working tree, is not this component's
 * any more — a neighbour declares it now, or a new component has taken the
 * freed name — and sweeping it would carry someone else's file into this
 * commit. Too narrow and too wide are different bugs, both silent, so both are
 * pinned by tests.
 *
 * The tree read arrives as a predicate rather than being done here because
 * deciding this is pure and reading a tree is not. The store owns the read; the
 * rule lives here, once, where it can be exercised without a repo.
 */
export async function ownedPaths(
  draft: DeclaredRecord,
  head: DeclaredRecord | null,
  isGoneFromTree: (storagePath: string) => Promise<boolean> | boolean,
): Promise<string[]> {
  const declared = componentPaths(draft.name, draft.files)
  const declaredSet = new Set(declared)
  const dropped = new Set<string>()
  // The head's paths under the head's OWN name — which is the component's
  // former name after a rename, and the same name otherwise. Taking them
  // through componentPaths is what puts the old registry record in scope: when
  // the names match it is already declared and falls out below.
  for (const path of head ? componentPaths(head.name, head.files) : []) {
    if (declaredSet.has(path) || dropped.has(path)) {
      continue
    }
    if (await isGoneFromTree(path)) {
      dropped.add(path)
    }
  }
  return [...declared, ...dropped]
}
