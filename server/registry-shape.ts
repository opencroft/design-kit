// Response shapes for the registry's read-only index routes, kept free of the
// host so the published contract can be tested directly.
//
// These are what an outside consumer sees. A checker comparing an application's
// installed copies against the library needs two things this file provides:
// which libraries exist at all, and a component's stable identity rather than only
// its current name. Without the first it can only look where it already
// believes a component lives; without the second a rename is indistinguishable
// from a deletion.

export interface ShapedProject {
  id: string
  name: string
  /** The registry namespace this project installs under. */
  namespace: string
}

/**
 * What a consumer compares against its own last install to decide whether a
 * component has moved on. Carried by both published shapes — the index item and
 * the registry item — so that answering "has this changed?" never requires
 * fetching the item to find out.
 *
 * `updatedAt` is milliseconds since the epoch, and every component record
 * carries one, so it is always present.
 * `version` comes from the publish layer and is omitted while a record has
 * none: an absent field says "this library does not version yet", where a
 * defaulted number would say "published exactly that many times" and be wrong.
 */
export interface ChangeSignals {
  updatedAt: number
  version?: number
}

export function changeSignals(component: { updatedAt: number; version?: number }): ChangeSignals {
  return typeof component.version === 'number'
    ? { updatedAt: component.updatedAt, version: component.version }
    : { updatedAt: component.updatedAt }
}

export interface ShapedIndexItem extends ChangeSignals {
  /**
   * Stable for the life of the component, across renames and moves between
   * projects. `name` is a slug and changes; this does not.
   */
  id: string
  name: string
  type: string
  title: string
  description: string
  /**
   * `type` is required here, not descriptive: the registry client validates
   * each file entry as a discriminated union keyed on it, so an index that
   * omits it is rejected by the client before the items it lists are ever
   * read — the whole point of an index existing at all.
   */
  files: Array<{ path: string; target: string; type: string }>
}

/**
 * The published project list.
 *
 * `namespace` is the project's STORED slug wherever it has one, and only falls
 * back to slugifying the display name for a project that has no slug of its own
 * to report. The two are not interchangeable: a slug is fixed when the project
 * is created and is its permanent address, while a display name can be changed
 * afterwards and takes no address with it. Deriving the namespace from the name
 * is therefore right only until the first rename, and wrong silently after it —
 * this route is where a consumer comes to LOOK UP a namespace, so answering
 * with a name-derived guess hands out the wrong one at the moment of asking.
 *
 * The rule arrives as `namespaceOf` rather than as a slugify to apply, so this
 * module and the resolvers share one definition of it — separate copies, all
 * keyed off a mutable name and all agreeing with each other, would make a wrong
 * answer invisible.
 */
export function shapeProjects(
  projects: Array<{ id: string; name: string; slug?: string }>,
  namespaceOf: (project: { id: string; name: string; slug?: string }) => string,
): { projects: ShapedProject[] } {
  return { projects: projects.map((p) => ({ id: p.id, name: p.name, namespace: namespaceOf(p) })) }
}

export function shapeIndexItem(
  component: { id: string; name: string; type: string; title: string; description: string; updatedAt: number; version?: number },
  files: Array<{ path: string; target: string; type: string }>,
): ShapedIndexItem {
  return {
    id: component.id,
    name: component.name,
    type: component.type,
    title: component.title,
    description: component.description,
    ...changeSignals(component),
    files,
  }
}

/**
 * The item name a registry client asks for when it wants the whole index.
 *
 * A client resolving a namespace has only one URL template to work with — the
 * one that fetches a single item — so it asks that template for this reserved
 * name and expects the index back. Serving an item here instead is what makes
 * namespace-wide search and install fail while per-item installs keep working.
 *
 * The consequence is that a component actually called this cannot be fetched
 * through the item route. It is still listed in the index, and the name is
 * reserved by the client's own convention, not by a choice made here.
 */
export const REGISTRY_INDEX_NAME = 'registry'

/** True when a request for `name` is really a request for the whole index. */
export function isIndexRequest(name: string): boolean {
  return name === REGISTRY_INDEX_NAME
}
