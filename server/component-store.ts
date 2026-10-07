// Component persistence for a design project, kept free of the host so the two
// rules below can be exercised directly.
//
// Both rules are about a write going wrong, and neither is observable through
// the live host: one is an ordering that only matters when a failure lands
// between two writes, the other a guard that only fires on a write nobody
// meant to make. Storage and the clock are injected for that reason.

/** The slice of the host's key/value storage this module needs. */
export interface ComponentStorage {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  /**
   * Every key this extension holds. Used only to rebuild the history index when
   * it is missing — the ordinary path reads the index instead, because reading
   * one key per component would mean re-reading the whole shared row that many
   * times per publish, which is the cost this whole design exists to avoid.
   */
  list(): Promise<string[]>
}

/**
 * The only fields this module reasons about. Kept minimal and generic so the
 * full stored shape stays declared next to the rest of the library's types
 * rather than being dragged in here.
 */
export interface StoredLike {
  id: string
  name: string
  /**
   * When this revision was written. Doubles as the token an optimistic write
   * names, since a draft has no version of its own until it is published.
   * Optional here only to keep this interface the minimal slice it says it is;
   * the library's own record declares it required.
   */
  updatedAt?: number
  /**
   * The component's files. In the slice because the history delta reasons about
   * them: it stores the ones that changed and nothing else.
   */
  files?: HistoryFile[]
  /**
   * How many times this component has been published. Absent on a record that
   * predates versioning, and read as 1 rather than backfilled — see
   * `publishedVersion`.
   */
  version?: number
  publishedAt?: number
  publishedBy?: PublishedBy
}

/**
 * Who performed a publish, as DECLARED by the door it came through — the same
 * trust model as a comment's author: attribution for coordination between the
 * people and agents sharing a kit, not an authorization boundary. `kind`
 * says which sort of publisher, so a system publisher is named honestly
 * rather than blanked. The dispatchers do not yet pass an authenticated
 * caller into extension handlers; when that lands, this field is where the
 * verified identity goes and the declared one stops being trusted.
 */
export interface PublishedBy {
  name: string
  kind: 'user' | 'agent' | 'system'
}

/**
 * One storage key per project, holding that project's whole PUBLISHED component
 * list — what installers and the registry routes are served. Nothing writes
 * here except a publish (and the one-off id backfill), so a component's
 * published bytes do not move while it is being edited.
 */
export function componentsKey(projectId: string): string {
  return `components:${projectId}`
}

/**
 * The working copy, as a SPARSE overlay rather than a second full list: it
 * holds only the components whose draft differs from what is published. A
 * component absent from it has no unpublished work, which is what lets an
 * untouched library cost nothing at all here.
 */
export function draftKey(projectId: string): string {
  return `components-draft:${projectId}`
}

/** Past published records for one component, newest first. */
export function historyKey(projectId: string, componentId: string): string {
  return `component-history:${projectId}:${componentId}`
}

/** Where the per-component byte totals live, so a prune need not read every key. */
export const HISTORY_INDEX_KEY = 'component-history-index'

/**
 * History is bounded by BYTES, not by a number of revisions.
 *
 * Every extension on an instance shares one settings row and each write
 * serialises and rewrites the whole of it, so the binding resource is that
 * row's size and a count cap cannot express a limit on it: full snapshots
 * multiply record size by revision count by library size, and across a large
 * library that outgrows everything else the row holds many times over.
 *
 * Two levels. The per-component budget keeps a component's own history small;
 * the extension-wide ceiling bounds the worst case however many components
 * publish. Both are tunable, and both are here rather than anywhere else.
 */
export const HISTORY_COMPONENT_BUDGET_BYTES = 64 * 1024
export const HISTORY_EXTENSION_CEILING_BYTES = 2 * 1024 * 1024

/**
 * Entries kept regardless of either budget. Reverting one step is the thing
 * history is for, and a budget that can take the last revision away would fail
 * exactly when it is needed. Two, not one, so the step back is itself
 * reconstructable.
 */
export const HISTORY_KEEP_MIN = 2

/**
 * The authoring view of a project: every published component, with any that has
 * unpublished work replaced by its draft, plus components that exist only as a
 * draft because they have never been published.
 *
 * Matched by `id`, never by name — a draft that renames a component still has
 * to line up with the published record it came from.
 */
export function overlayDraft<T extends StoredLike>(published: T[], draft: T[]): T[] {
  const byId = new Map(draft.map((c) => [c.id, c]))
  const merged = published.map((c) => byId.get(c.id) ?? c)
  const publishedIds = new Set(published.map((c) => c.id))
  return [...merged, ...draft.filter((c) => !publishedIds.has(c.id))]
}

/**
 * What a reader outside the editor cannot otherwise see: whether a record is
 * an unpublished draft, and which published version it is ahead of.
 *
 * Draft state is OVERLAY PRESENCE — publish's own definition ("nothing in the
 * overlay means the draft IS what is published") — never a content comparison,
 * so this cannot disagree with what publishComponent would report. A draft
 * over a record that predates versioning is ahead of v1, the same reading
 * publishedVersion gives an absent version.
 */
export function draftStateFor<T extends StoredLike>(published: T | undefined, inOverlay: boolean): number | 'unpublished' | undefined {
  if (!inOverlay) {
    return undefined
  }
  if (!published) {
    return 'unpublished'
  }
  return typeof published.version === 'number' ? published.version : 1
}

/**
 * Which files a draft has changed since the version it sits on — the file-level
 * reading of the question `draftStateFor` answers for the whole component.
 *
 * Files are compared exactly as `reverseDelta` compares them, so a file this
 * calls changed is a file the next publish would file in its history entry.
 * One definition of "differs", not a second one free to drift from it.
 *
 * A draft over a component that was never published has changed every file it
 * holds: there is nothing for any of them to be the same as. **No draft at all
 * answers `undefined` rather than an empty list** — "nothing changed" and
 * "there is no draft" are different states, and a caller drawing a marker has
 * to be able to tell them apart.
 *
 * Note this is deliberately NOT the same question as draft presence. A file
 * edited and edited back is in the draft and is not changed here, so a
 * component can be ahead of its published version while this list is empty.
 * Both statements are true and they answer different questions: whether a
 * publish would spend a version, and which files it would carry.
 */
export function draftFilesChanged<T extends StoredLike>(published: T | undefined, draft: T | undefined): string[] | undefined {
  if (!draft) {
    return undefined
  }
  const draftFiles = splitRecord(draft).files
  if (!published) {
    return draftFiles.map(fileKeyOf)
  }
  const publishedByKey = new Map(splitRecord(published).files.map((f) => [fileKeyOf(f), f]))
  const draftKeys = new Set(draftFiles.map(fileKeyOf))
  const changed = new Set<string>()
  for (const f of draftFiles) {
    if (JSON.stringify(publishedByKey.get(fileKeyOf(f))) !== JSON.stringify(f)) {
      changed.add(fileKeyOf(f))
    }
  }
  // A file the draft deleted changed too. It has no row left to carry a marker,
  // and it is reported anyway so that anything counting this list counts it —
  // dropping it here would make a draft that only deletes look like no draft.
  for (const key of publishedByKey.keys()) {
    if (!draftKeys.has(key)) {
      changed.add(key)
    }
  }
  return [...changed]
}

// No copy of the list is set aside before a write that removes a record. A
// refused write persists nothing at all, so there is nothing to recover from,
// and the error already names what would have gone; and a deletion files the
// record it removes in that component's own history.

/**
 * A past published record, stored as a REVERSE delta against the version that
 * replaced it: the meta as it was, the file keys in the order it had them, and
 * only those files whose content differed. A revision is rebuilt by walking
 * back from the published head, so a publish that touched one file costs one
 * file. A publish that changed everything degenerates to a full snapshot, which
 * is the honest size of that change rather than a failure of the scheme.
 */
export interface HistoryEntry {
  /** The version this entry reconstructs. */
  version: number
  at: number
  /** The record without its files. Small, so it is kept whole. */
  meta: Record<string, unknown>
  /**
   * Every file key this version had, in order. Reconstruction reads the order
   * from here, so a file the newer version added is dropped on the way back
   * without needing a second list to say so.
   */
  order: string[]
  /** Only the files that differ from the newer version's. */
  files: HistoryFile[]
}

export interface HistoryFile {
  path: string
  target?: string
  type?: string
  content: string
}

/** What a component's history costs, and what the extension's costs in total. */
export interface HistoryBytes {
  component: number
  extension: number
}

/** One row of a component's revision listing, newest first. */
export interface RevisionRow {
  version: number
  /** When this version reached installers; absent on a head from before versioning. */
  publishedAt?: number
  /**
   * File keys this version changed relative to the one before it -- content
   * edits, additions and removals alike. Null when the version before it is
   * no longer held: a budget that bounds history has an edge, and "nobody can
   * say any more" must stay distinguishable from "nothing changed".
   */
  filesChanged: string[] | null
  /** Who published this version, where a publish declared it. */
  by?: PublishedBy
}

export interface RevisionsResult {
  component: string
  componentId: string
  /** The published head's version; absent when nothing is published yet. */
  version?: number
  /** Unpublished work, in draftStateFor's vocabulary; absent when draft==published. */
  draft?: number | 'unpublished'
  /** True when history no longer reaches back to version 1. */
  truncated: boolean
  revisions: RevisionRow[]
}

export interface ChangedComponent {
  component: string
  componentId: string
  to: number
  from?: number
  /** When the change last reached installers -- publishedAt, or updatedAt on a pre-versioning record. */
  changedAt: number
}

export interface ChangesSinceResult {
  changed: ChangedComponent[]
  /** sinceVersions keys that matched no component in the project. */
  unknown: string[]
}


export const SHRINK_REFUSED = 'SHRINK_REFUSED'

/**
 * Thrown when a write would remove components without saying that it means to.
 * Carries `code` rather than relying on the class, because these errors cross
 * a boundary that keeps the message and drops the prototype.
 */
export interface ShrinkRefusedError extends Error {
  code: typeof SHRINK_REFUSED
  removed: string[]
}

function shrinkRefused(projectId: string, removed: string[], before: number, after: number): ShrinkRefusedError {
  const err = new Error(
    `Refusing to write ${after} component(s) over ${before} in project ${projectId}: ` +
      `that removes ${removed.length} (${removed.join(', ')}) and the caller did not ask to remove anything. ` +
      `Nothing was written, so storage still holds all ${before}. ` +
      `Pass { allowShrink: true } if the removal is intended.`,
  ) as ShrinkRefusedError
  err.code = SHRINK_REFUSED
  err.removed = removed
  return err
}

export const STALE_WRITE = 'STALE_WRITE'

/**
 * Thrown when a caller says which revision it read and storage has moved on
 * since. Carries `code` for the same reason SHRINK_REFUSED does: the boundary
 * this crosses keeps the message and drops the prototype.
 */
export interface StaleWriteError extends Error {
  code: typeof STALE_WRITE
}

function staleWrite(what: string, expected: string | number, actual: string | number | null): StaleWriteError {
  const err = new Error(
    `Refusing to write ${what}: it was ${actual === null ? 'removed' : `last changed at ${actual}`}, ` +
      `and this write was built from ${expected}. Re-read the component and apply the change again — ` +
      `writing now would silently discard whatever happened in between.`,
  ) as StaleWriteError
  err.code = STALE_WRITE
  return err
}

export interface WriteOptions {
  /**
   * The caller knows this write removes components. Every operation in this
   * library removes at most one at a time and knows when it is doing it, so an
   * unflagged shrink is a write built from a list that no longer reflects
   * storage — not an intention.
   */
  allowShrink?: boolean
  /** What caused the removal. Accepted for the caller's benefit; nothing here persists it. */
  reason?: string
}

/**
 * The revision a caller read for the component it is changing. Naming it turns
 * a lost update into a refusal; omitting it leaves the write unguarded.
 */
export interface WriteExpectation {
  id: string
  updatedAt: number
}

export interface DraftWriteOptions {
  reason?: string
  expect?: WriteExpectation
}

const fileKeyOf = (f: HistoryFile): string => f.target || f.path

/** UTF-8 length, because a budget in bytes has to mean bytes. */
function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length
}

function splitRecord<T extends StoredLike>(record: T): { meta: Record<string, unknown>; files: HistoryFile[] } {
  const { files, ...meta } = record as T & { files?: HistoryFile[] }
  return { meta: meta as Record<string, unknown>, files: Array.isArray(files) ? files : [] }
}

/**
 * The delta that turns `newer` back into `older`. Files are compared by their
 * whole entry, not only content: a file that kept its content but changed type
 * or target is a different file to whoever installs it.
 */
export function reverseDelta<T extends StoredLike>(older: T, newer: T, version: number, at: number): HistoryEntry {
  const { meta, files: olderFiles } = splitRecord(older)
  const newerByKey = new Map(splitRecord(newer).files.map((f) => [fileKeyOf(f), f]))
  return {
    version,
    at,
    meta,
    order: olderFiles.map(fileKeyOf),
    files: olderFiles.filter((f) => JSON.stringify(newerByKey.get(fileKeyOf(f))) !== JSON.stringify(f)),
  }
}

/** Apply one reverse delta: the record as it was, from the record that replaced it. */
export function applyReverseDelta<T extends StoredLike>(newer: T, entry: HistoryEntry): T {
  const byKey = new Map(splitRecord(newer).files.map((f) => [fileKeyOf(f), f]))
  for (const f of entry.files) {
    byKey.set(fileKeyOf(f), f)
  }
  return {
    ...entry.meta,
    files: entry.order.map((k) => byKey.get(k)).filter((f): f is HistoryFile => Boolean(f)),
  } as unknown as T
}

/**
 * Keep the newest entries that fit the per-component budget, and never fewer
 * than the floor. The entry that crosses the budget is dropped along with
 * everything older than it, so what survives is always a contiguous run back
 * from the head — a gap would make every revision beyond it unreconstructable
 * while still costing its bytes.
 */
export function pruneToComponentBudget(entries: HistoryEntry[], budget = HISTORY_COMPONENT_BUDGET_BYTES): HistoryEntry[] {
  const kept: HistoryEntry[] = []
  let total = 0
  for (const entry of entries) {
    total += byteLength(entry)
    if (kept.length >= HISTORY_KEEP_MIN && total > budget) {
      break
    }
    kept.push(entry)
  }
  return kept
}

/**
 * The timestamp form of changesSince over an already-read published list --
 * pure, because the HTTP routes read storage through the db (no request
 * context) while the node actions read it through host.storage, and both must
 * give one answer. `publishedAt` is the honest signal where it exists;
 * `updatedAt` stands in for records from before versioning, where it moved on
 * every write -- an approximation the action description states rather than
 * hides.
 */
export function changedSince<T extends StoredLike>(published: T[], since: number): ChangedComponent[] {
  const changed: ChangedComponent[] = []
  for (const c of published) {
    const changedAt = typeof c.publishedAt === 'number' ? c.publishedAt : c.updatedAt
    if (typeof changedAt === 'number' && changedAt > since) {
      changed.push({
        component: c.name,
        componentId: c.id ?? '',
        to: typeof c.version === 'number' ? c.version : 1,
        changedAt,
      })
    }
  }
  return changed
}

export interface ComponentStoreDeps {
  storage: ComponentStorage
  /** Mints an id for a record written before ids existed. */
  newId: () => string
  now?: () => number
  /**
   * Every OTHER design project (id + display name), for the global
   * uniqueness check below: a component's slug is refused if any other
   * project already holds it, not just the one project a write happens to
   * touch. Optional -- omitting it (e.g. a test exercising only the
   * same-project/destination rules below) makes the global check a no-op
   * rather than forcing every caller to fake project listing.
   */
  listOtherProjects?: (currentProjectId: string) => Promise<Array<{ id: string; name: string }>>
  /**
   * Whether a project id is a real, registered design project, not just a
   * storage bucket some write happened to touch. Optional, like
   * listOtherProjects and for the same reason (a caller not exercising the
   * cross-project surface should not have to fake this too) -- but omitting
   * it leaves a cross-project move's destination unchecked: a move whose
   * destination is never checked against this can silently create a
   * component in a bucket listOtherProjects (and everything else that reads
   * the real project list) is permanently blind to, defeating
   * assertNameAvailableGlobally without ever calling it incorrectly.
   */
  projectExists?: (projectId: string) => Promise<boolean>
}

export function createComponentStore<T extends StoredLike>(deps: ComponentStoreDeps) {
  const now = deps.now ?? Date.now

  async function rawRead(projectId: string): Promise<T[]> {
    const list = await deps.storage.get<T[]>(componentsKey(projectId))
    return Array.isArray(list) ? list : []
  }

  /**
   * The published list — what the registry serves.
   *
   * Lazy backfill: a record written before `id` existed has none. Assign one
   * and persist it here, once, so every other read of this project can rely on
   * `id` always being present without re-deriving it per call.
   */
  async function readPublished(projectId: string): Promise<T[]> {
    const list = await rawRead(projectId)
    let changed = false
    const withIds = list.map((c) => {
      if (c.id) return c
      changed = true
      return { ...c, id: deps.newId() }
    })
    if (changed) {
      await writePublished(projectId, withIds)
    }
    return withIds
  }

  async function readDraftOverlay(projectId: string): Promise<T[]> {
    const list = await deps.storage.get<T[]>(draftKey(projectId))
    return Array.isArray(list) ? list : []
  }

  /**
   * The authoring view: published, with unpublished work laid over it. Every
   * read that is about editing goes through here, so an author never sees the
   * copy installers are being served while their own change sits unpublished.
   */
  async function readComponents(projectId: string): Promise<T[]> {
    return overlayDraft(await readPublished(projectId), await readDraftOverlay(projectId))
  }

  /** A published record's version, reading a record from before versioning as 1. */
  function publishedVersion(record: T | undefined): number {
    return typeof record?.version === 'number' ? record.version : 1
  }

  /**
   * Persist a project's component list, refusing a write that drops records
   * the caller never said it was dropping.
   *
   * Removal is decided by `id`, not by name or by length: a rename changes the
   * name and a move that also adds one keeps the length, so neither of those
   * answers "is anything gone".
   */
  async function writePublished(projectId: string, list: T[], options: WriteOptions = {}): Promise<void> {
    const before = await rawRead(projectId)
    const kept = new Set(list.map((c) => c.id).filter(Boolean))
    // A record with no id yet cannot be matched, and treating it as removed
    // would refuse the backfill write that is about to give it one.
    const removed = before.filter((c) => c.id && !kept.has(c.id)).map((c) => c.name)

    // Nothing is written before the refusal: a refused write leaves storage
    // exactly as it was, so there is no prior state to keep a copy of.
    if (removed.length > 0 && !options.allowShrink) {
      throw shrinkRefused(projectId, removed, before.length, list.length)
    }

    await deps.storage.set(componentsKey(projectId), list)
  }

  /**
   * Refuse a write built from a revision that storage has since moved past.
   *
   * Optimistic by necessity, not by preference: the host's storage exposes only
   * `get` and `set`, so an extension's read-modify-write spans two calls and
   * cannot be made atomic from here. Re-reading immediately before the write
   * narrows the window to the gap between this check and the `set`; it does not
   * close it. A caller that names no expectation is unguarded.
   */
  function assertFresh(current: T[], expect: WriteExpectation | undefined): void {
    if (!expect) {
      return
    }
    const found = current.find((c) => c.id === expect.id)
    if (!found) {
      throw staleWrite(`component ${expect.id}`, expect.updatedAt, null)
    }
    if (found.updatedAt !== expect.updatedAt) {
      throw staleWrite(`component "${found.name}"`, expect.updatedAt, found.updatedAt)
    }
  }

  /**
   * Persist an authoring change. It lands in the DRAFT overlay and nowhere
   * else: what installers are served changes only when someone publishes.
   *
   * `list` is the whole effective list as the caller means it to be. Only the
   * difference against published is stored.
   *
   * Removing a component here is refused whatever the caller says, because a
   * draft cannot express "deleted": the published copy would go on being
   * served with nothing to show that anyone meant otherwise. Removal has its
   * own doors, and they act on the published list.
   */
  async function writeComponents(projectId: string, list: T[], options: DraftWriteOptions = {}): Promise<void> {
    const published = await readPublished(projectId)
    const effective = overlayDraft(published, await readDraftOverlay(projectId))
    assertFresh(effective, options.expect)

    const kept = new Set(list.map((c) => c.id).filter(Boolean))
    const removed = effective.filter((c) => c.id && !kept.has(c.id)).map((c) => c.name)
    if (removed.length > 0) {
      throw shrinkRefused(projectId, removed, effective.length, list.length)
    }

    // A record is in the overlay when it differs from what is published, so an
    // edit that puts a component back exactly as published leaves no draft
    // behind. Compared by serialisation: both sides are built from the same
    // literal, so key order matches, and the only cost of being wrong is a
    // redundant overlay entry that publishes to the same bytes.
    const publishedJson = new Map(published.map((c) => [c.id, JSON.stringify(c)]))
    await deps.storage.set(
      draftKey(projectId),
      list.filter((c) => publishedJson.get(c.id) !== JSON.stringify(c)),
    )
  }

  /**
   * Make one component's draft the published copy: version incremented, the
   * record it replaces appended to that component's history, and the draft
   * entry cleared so the component reads as having no unpublished work.
   *
   * The shrink guard cannot fire here and is not consulted: publishing changes
   * one entry of the published list and removes none, so the count it watches
   * is unchanged or one higher.
   */
  async function publishComponent(
    projectId: string,
    name: string,
    options: { expectedVersion?: number; by?: PublishedBy } = {},
  ): Promise<{ published: boolean; name: string; version: number; history: HistoryBytes }> {
    const published = await readPublished(projectId)
    const draft = await readDraftOverlay(projectId)
    const effective = overlayDraft(published, draft)

    const target = effective.find((c) => c.name === name)
    if (!target) {
      throw new Error(`Component "${name}" not found in this project.`)
    }
    const current = published.find((c) => c.id === target.id)

    if (options.expectedVersion !== undefined && options.expectedVersion !== publishedVersion(current)) {
      throw staleWrite(`component "${name}"`, `version ${options.expectedVersion}`, current ? `version ${publishedVersion(current)}` : null)
    }

    // Nothing in the overlay means the draft IS what is published. Reported
    // rather than treated as an error, and it spends no version: a publish
    // that changes nothing must not make every consumer re-fetch.
    if (!draft.some((c) => c.id === target.id)) {
      return { published: false, name, version: publishedVersion(current), history: await historyBytes(projectId, target.id) }
    }

    const version = current ? publishedVersion(current) + 1 : 1
    // The draft record was copied from a published one, so it can carry the
    // PREVIOUS publisher's name — inheriting it would attribute this publish
    // to whoever did the last one, which is worse than recording nobody.
    const { publishedBy: _inherited, ...bare } = target as T & { publishedBy?: PublishedBy }
    const next = { ...(bare as unknown as T), version, publishedAt: now(), ...(options.by ? { publishedBy: options.by } : {}) }

    // The delta is against the record that replaces it, so it is computed here,
    // between knowing both. A component published for the first time replaces
    // nothing and files nothing.
    const bytes = current
      ? await fileRevision(projectId, target.id, reverseDelta(current, next, publishedVersion(current), now()))
      : await historyBytes(projectId, target.id)

    await writePublished(projectId, current ? published.map((c) => (c.id === target.id ? next : c)) : [...published, next])
    await deps.storage.set(
      draftKey(projectId),
      draft.filter((c) => c.id !== target.id),
    )
    return { published: true, name: next.name, version, history: bytes }
  }

  /** A component's history entries, newest first. */
  async function readHistory(projectId: string, componentId: string): Promise<HistoryEntry[]> {
    const past = await deps.storage.get<HistoryEntry[]>(historyKey(projectId, componentId))
    return Array.isArray(past) ? past : []
  }

  /**
   * Rebuild a past revision by walking back from the published head.
   *
   * Returns null when the version is beyond what history still holds — pruned,
   * or never recorded. That is a real answer and not an error: a budget that
   * bounds growth necessarily has an edge, and a caller has to be able to tell
   * "this is what it was" from "nobody can say any more".
   */
  async function reconstructVersion(projectId: string, componentId: string, version: number): Promise<T | null> {
    const head = (await readPublished(projectId)).find((c) => c.id === componentId)
    if (head && publishedVersion(head) === version) {
      return head
    }
    // No head at all means the component was deleted. Its newest entry is a
    // full snapshot for exactly that reason, so the walk starts from nothing
    // and the first entry rebuilds the whole record.
    let record = head ?? ({ files: [] } as unknown as T)
    // Entries are newest first and always contiguous back from the head, so
    // the first one that does not continue the chain means the rest is gone.
    for (const entry of await readHistory(projectId, componentId)) {
      // An entry with no `order` is not one this code wrote. Rebuilding from it
      // would produce a record that looks right and is not, so the walk stops
      // here and the answer is the same as for a pruned one: nobody can say.
      if (!Array.isArray(entry.order)) {
        return null
      }
      record = applyReverseDelta(record, entry)
      if (entry.version === version) {
        return record
      }
    }
    return null
  }

  /**
   * The file keys that differ between two adjacent versions, read off the
   * reverse delta that steps between them: the delta's own files (content or
   * shape edits) plus keys present on one side only (added or removed).
   */
  function changedAcross(entry: HistoryEntry, newerOrder: string[]): string[] {
    const older = new Set(entry.order)
    const newer = new Set(newerOrder)
    const changed = new Set(entry.files.map((f) => fileKeyOf(f)))
    for (const key of newerOrder) {
      if (!older.has(key)) {
        changed.add(key)
      }
    }
    for (const key of entry.order) {
      if (!newer.has(key)) {
        changed.add(key)
      }
    }
    return [...changed]
  }

  /**
   * A component's publish history, newest first, derived entirely from what is
   * already stored: the published head plus the reverse-delta chain. A
   * pre-versioning head lists as the single version-1 row; a version-1 row
   * changed everything by existing; a row whose predecessor was pruned reports
   * null rather than guessing.
   */
  async function listRevisions(projectId: string, name: string): Promise<RevisionsResult> {
    const target = (await readComponents(projectId)).find((c) => c.name === name)
    if (!target) {
      throw new Error(`Component "${name}" not found in this project.`)
    }
    const published = (await readPublished(projectId)).find((c) => c.id === target.id)
    const inOverlay = (await readDraftOverlay(projectId)).some((c) => c.id === target.id)
    const draft = draftStateFor(published, inOverlay)
    if (!published) {
      // Never published is a real state, not an error: there are no versions
      // to list yet, and the first publish will create version 1.
      return {
        component: target.name,
        componentId: target.id ?? '',
        ...(draft === undefined ? {} : { draft }),
        truncated: false,
        revisions: [],
      }
    }
    const history = await readHistory(projectId, published.id ?? '')
    const headVersion = publishedVersion(published)
    const headOrder = splitRecord(published).files.map((f) => fileKeyOf(f))
    const revisions: RevisionRow[] = []
    const newest = history[0]
    revisions.push({
      version: headVersion,
      ...(typeof published.publishedAt === 'number' ? { publishedAt: published.publishedAt } : {}),
      ...(published.publishedBy ? { by: published.publishedBy } : {}),
      filesChanged:
        newest && Array.isArray(newest.order)
          ? changedAcross(newest, headOrder)
          : headVersion === 1
            ? [...headOrder]
            : null,
    })
    for (let i = 0; i < history.length; i++) {
      const entry = history[i]
      // An entry with no order is not one this code wrote -- same stop rule
      // as reconstructVersion, for the same reason.
      if (!Array.isArray(entry.order)) {
        break
      }
      const older = history[i + 1]
      revisions.push({
        version: entry.version,
        ...(typeof entry.meta?.publishedAt === 'number' ? { publishedAt: entry.meta.publishedAt as number } : {}),
        ...((entry.meta as { publishedBy?: PublishedBy } | undefined)?.publishedBy ? { by: (entry.meta as { publishedBy?: PublishedBy }).publishedBy } : {}),
        filesChanged:
          older && Array.isArray(older.order)
            ? changedAcross(older, entry.order)
            : entry.version === 1
              ? [...entry.order]
              : null,
      })
    }
    const oldest = revisions[revisions.length - 1]?.version ?? headVersion
    return {
      component: published.name,
      componentId: published.id ?? '',
      version: headVersion,
      ...(draft === undefined ? {} : { draft }),
      truncated: oldest > 1,
      revisions,
    }
  }

  /**
   * What changed in a project since a caller's reference point. Exactly one of
   * `since` (epoch ms) or `sinceVersions` (per-component versions, keyed by
   * componentId or name) -- passing both would silently answer only one
   * question, and passing neither answers none.
   */
  async function changesSince(
    projectId: string,
    query: { since?: number; sinceVersions?: Record<string, number> },
  ): Promise<ChangesSinceResult> {
    const hasSince = typeof query.since === 'number' && Number.isFinite(query.since)
    const map = query.sinceVersions && Object.keys(query.sinceVersions).length > 0 ? query.sinceVersions : undefined
    if (hasSince === Boolean(map)) {
      throw new Error('Pass exactly one of `since` (a timestamp) or `sinceVersions` (a per-component version map).')
    }
    const published = await readPublished(projectId)
    if (hasSince) {
      return { changed: changedSince(published, query.since as number), unknown: [] }
    }
    const byId = new Map(published.map((c) => [c.id, c]))
    const byName = new Map(published.map((c) => [c.name, c]))
    const changed: ChangedComponent[] = []
    const unknown: string[] = []
    for (const [key, from] of Object.entries(map as Record<string, number>)) {
      const c = byId.get(key) ?? byName.get(key)
      if (!c) {
        unknown.push(key)
        continue
      }
      const to = publishedVersion(c)
      if (to > from) {
        changed.push({
          component: c.name,
          componentId: c.id ?? '',
          from,
          to,
          changedAt: (typeof c.publishedAt === 'number' ? c.publishedAt : c.updatedAt) as number,
        })
      }
    }
    return { changed, unknown }
  }

  /**
   * The index that lets a prune cost two reads instead of one per component.
   * Derived, so a missing one is rebuilt rather than treated as empty — reading
   * every history key once is expensive, and doing it silently on every publish
   * is exactly the cost this design exists to avoid.
   */
  async function readHistoryIndex(): Promise<Record<string, { bytes: number; oldest: number }>> {
    const stored = await deps.storage.get<Record<string, { bytes: number; oldest: number }>>(HISTORY_INDEX_KEY)
    if (stored && typeof stored === 'object') {
      return stored
    }
    const rebuilt: Record<string, { bytes: number; oldest: number }> = {}
    for (const key of await deps.storage.list()) {
      if (!key.startsWith('component-history:')) {
        continue
      }
      const entries = (await deps.storage.get<HistoryEntry[]>(key)) ?? []
      if (Array.isArray(entries) && entries.length > 0) {
        rebuilt[key] = { bytes: byteLength(entries), oldest: entries[entries.length - 1].at }
      }
    }
    return rebuilt
  }

  const indexEntry = (entries: HistoryEntry[]) => ({ bytes: byteLength(entries), oldest: entries[entries.length - 1]?.at ?? 0 })
  const totalBytes = (index: Record<string, { bytes: number }>) => Object.values(index).reduce((sum, e) => sum + e.bytes, 0)

  /**
   * File one revision, then hold both budgets: the component's own first, then
   * the extension-wide ceiling, dropping whichever surviving entry is oldest
   * anywhere. Both stop at the keep-last-2 floor, so a ceiling breach is
   * reported through the returned bytes rather than met by deleting the last
   * thing anyone could revert to.
   */
  async function fileRevision(projectId: string, componentId: string, entry: HistoryEntry): Promise<HistoryBytes> {
    const key = historyKey(projectId, componentId)
    const kept = pruneToComponentBudget([entry, ...(await readHistory(projectId, componentId))])
    await deps.storage.set(key, kept)

    const index = await readHistoryIndex()
    index[key] = indexEntry(kept)

    // A key already at the floor cannot give anything up, so it is set aside
    // rather than removed from the index — removing it would understate the
    // total and make the ceiling look met when it is not.
    const atFloor = new Set<string>()
    while (totalBytes(index) > HISTORY_EXTENSION_CEILING_BYTES) {
      const oldestKey = Object.entries(index)
        .filter(([k]) => !atFloor.has(k))
        .sort((a, b) => a[1].oldest - b[1].oldest)[0]?.[0]
      if (!oldestKey) {
        break
      }
      const stored = await deps.storage.get<HistoryEntry[]>(oldestKey)
      const entries = Array.isArray(stored) ? stored : []
      if (entries.length <= HISTORY_KEEP_MIN) {
        atFloor.add(oldestKey)
        continue
      }
      const trimmed = entries.slice(0, -1)
      await deps.storage.set(oldestKey, trimmed)
      index[oldestKey] = indexEntry(trimmed)
    }

    await deps.storage.set(HISTORY_INDEX_KEY, index)
    return { component: index[key]?.bytes ?? 0, extension: totalBytes(index) }
  }

  /** The same figures, without filing anything — for a publish that files nothing. */
  async function historyBytes(projectId: string, componentId: string): Promise<HistoryBytes> {
    const index = await readHistoryIndex()
    return { component: index[historyKey(projectId, componentId)]?.bytes ?? 0, extension: totalBytes(index) }
  }

  async function getComponent(projectId: string, name: string): Promise<T | null> {
    return (await readComponents(projectId)).find((c) => c.name === name) ?? null
  }

  /**
   * A component's slug is global: refused if any OTHER project already
   * holds it, on top of -- not instead of -- the narrower same-project and
   * destination-project checks moveComponent enforces below. A no-op when
   * the store was built without `listOtherProjects`.
   *
   * Callers decide WHEN this fires (a create, or a rename) -- this only
   * answers the question for whichever name they ask about, so an ordinary
   * re-save of a record that already holds its own name never calls this
   * and is never affected by it.
   */
  async function assertNameAvailableGlobally(name: string, currentProjectId: string): Promise<void> {
    if (!deps.listOtherProjects) {
      return
    }
    for (const project of await deps.listOtherProjects(currentProjectId)) {
      // The effective list, not the published one: a name taken by a component
      // that exists only as a draft is still taken, and handing it out twice
      // would make the second one unpublishable.
      const collision = (await readComponents(project.id)).find((c) => c.name === name)
      if (collision) {
        throw new Error(`A component named "${name}" already exists in project "${project.name}".`)
      }
    }
  }

  /**
   * Removal acts on the PUBLISHED list, and on the draft alongside it. It is
   * not an authoring change waiting for a publish: dropping only the draft
   * would leave the component installed, served and no longer editable, which
   * is the opposite of what the caller asked for.
   */
  async function deleteComponent(projectId: string, name: string): Promise<{ deleted: boolean; name: string }> {
    const published = await readPublished(projectId)
    const draft = await readDraftOverlay(projectId)
    const target = overlayDraft(published, draft).find((c) => c.name === name)
    if (!target) {
      return { deleted: false, name }
    }
    if (published.some((c) => c.id === target.id)) {
      await writePublished(
        projectId,
        published.filter((c) => c.id !== target.id),
        { allowShrink: true, reason: `deleteComponent("${name}")` },
      )
    }
    if (draft.some((c) => c.id === target.id)) {
      await deps.storage.set(
        draftKey(projectId),
        draft.filter((c) => c.id !== target.id),
      )
    }
    // The record that was being served is filed before it goes, so a delete is
    // recoverable from the same place every other past revision is. It is the
    // only thing that survives the component, and it lives under the same two
    // budgets as everything else, so it cannot grow without bound.
    const last = published.find((c) => c.id === target.id)
    if (last) {
      // Against a record with no files at all, so every file differs and the
      // entry is a full snapshot. It has to be: once the component is gone
      // there is no published head left for a delta to be relative to.
      await fileRevision(projectId, target.id, reverseDelta(last, { ...last, files: [] }, publishedVersion(last), now()))
    }
    return { deleted: true, name }
  }

  /**
   * Move and/or rename a component. `destProjectId` is already resolved by the
   * caller; this module does not know how a project id-or-slug is looked up.
   *
   * Write order on a cross-project move matters, for the same reason it matters
   * when the component's comment threads are carried across: the destination
   * gets its copy BEFORE the source is truncated, so a failure between the two
   * writes leaves a duplicate — annoying, visible, fixable — instead of losing
   * the component outright, which is silent and leaves the installed copy in a
   * consuming app as the only surviving version of it.
   *
   * All collision guards run before anything is written, so a colliding move
   * throws having changed nothing.
   */
  async function moveComponent(
    projectId: string,
    name: string,
    options: { toName?: string; destProjectId?: string; slugify: (v: string) => string },
  ): Promise<{ moved: boolean; name: string; project: string }> {
    const list = await readComponents(projectId)
    const idx = list.findIndex((c) => c.name === name)
    if (idx < 0) {
      throw new Error(`Component "${name}" not found in this project.`)
    }
    const comp = list[idx]
    const newName = options.toName ? options.slugify(options.toName) : comp.name
    if (!newName) {
      throw new Error('moveComponent: `toName` resolved to an empty slug.')
    }
    const destProject = options.destProjectId ?? projectId

    // A move into a different project only counts as landing anywhere real if
    // that project is one assertNameAvailableGlobally (and everything else
    // that reads the project list) can actually see -- otherwise the moved
    // component becomes invisible to the very check this store exists to
    // enforce, silently. Same-project moves need no check: projectId is
    // already established (this component is IN it), so destProject === projectId
    // cannot be a new, unchecked bucket.
    if (destProject !== projectId && deps.projectExists && !(await deps.projectExists(destProject))) {
      throw new Error(`Design project "${destProject}" does not exist.`)
    }

    // A rename claims a name globally, checked against every project except
    // the one this move lands in (that project's own collision is the
    // narrower check just below, which already covers it). A plain move
    // with no rename does NOT need this: the name was already globally
    // unique before the move (enforced when it was created or last
    // renamed), and moving it to a different project cannot make some OTHER
    // project's list start containing it -- checking here regardless would
    // only ever find the moving component's own current, soon-to-be-vacated
    // entry in the source project and refuse a move that changes nothing
    // about global uniqueness.
    if (newName !== comp.name) {
      await assertNameAvailableGlobally(newName, destProject)
    }

    // A rename is not an authoring change: the name is the component's address
    // in the registry, so it has to move on the PUBLISHED copy or installers go
    // on being served the old one with nothing recording that anyone renamed
    // it. Where the component also has unpublished work, both copies are
    // carried and each keeps its own content — only the name is rewritten.
    const publishedSource = await readPublished(projectId)
    const draftSource = await readDraftOverlay(projectId)
    const rename = (c: T): T => ({ ...c, name: newName, updatedAt: now() })
    const publishedComp = publishedSource.find((c) => c.id === comp.id)
    const draftComp = draftSource.find((c) => c.id === comp.id)

    if (destProject === projectId) {
      if (newName !== comp.name && list.some((c) => c.name === newName)) {
        throw new Error(`A component named "${newName}" already exists here.`)
      }
      if (publishedComp) {
        await writePublished(projectId, publishedSource.map((c) => (c.id === comp.id ? rename(c) : c)))
      }
      if (draftComp) {
        await deps.storage.set(draftKey(projectId), draftSource.map((c) => (c.id === comp.id ? rename(c) : c)))
      }
      return { moved: true, name: newName, project: projectId }
    }

    const destList = await readComponents(destProject)
    if (destList.some((c) => c.name === newName)) {
      throw new Error(`A component named "${newName}" already exists in the destination project.`)
    }
    if (publishedComp) {
      await writePublished(destProject, [...(await readPublished(destProject)), rename(publishedComp)])
    }
    if (draftComp) {
      await deps.storage.set(draftKey(destProject), [...(await readDraftOverlay(destProject)), rename(draftComp)])
    }
    if (publishedComp) {
      await writePublished(projectId, publishedSource.filter((c) => c.id !== comp.id), {
        allowShrink: true,
        reason: `moveComponent("${name}") to project ${destProject}`,
      })
    }
    if (draftComp) {
      await deps.storage.set(draftKey(projectId), draftSource.filter((c) => c.id !== comp.id))
    }
    // History is keyed by project, so it has to travel with the component or it
    // is left where nothing can reach it. The index moves with it, or the
    // ceiling would go on counting bytes at an address that no longer holds
    // any.
    const past = await readHistory(projectId, comp.id)
    if (past.length > 0) {
      await deps.storage.set(historyKey(destProject, comp.id), past)
      await deps.storage.set(historyKey(projectId, comp.id), [])
      const index = await readHistoryIndex()
      delete index[historyKey(projectId, comp.id)]
      index[historyKey(destProject, comp.id)] = indexEntry(past)
      await deps.storage.set(HISTORY_INDEX_KEY, index)
    }
    return { moved: true, name: newName, project: destProject }
  }

  return {
    componentsKey,
    publishedVersion,
    listRevisions,
    changesSince,
    readComponents,
    readPublished,
    readDraftOverlay,
    readHistory,
    reconstructVersion,
    historyBytes,
    writeComponents,
    writePublished,
    publishComponent,
    getComponent,
    deleteComponent,
    moveComponent,
    assertNameAvailableGlobally,
  }
}
