import host from '@ext/host'

import {
  changedPaths,
  commitPaths,
  commitStagedRemovals,
  componentRevisions,
  componentTag,
  diffNames,
  discardWorking,
  pathInHead,
  grepWorking,
  highestVersion,
  headSha,
  listHead,
  listWorkingFiles,
  pathsChangedSince,
  readWorking,
  removeWorking,
  showAt,
  stagedState,
  tagVersion,
  writeWorking,
} from './component-repo'
import { componentPaths, type DeclaredRecord, declaredPath, META_DIR, metaPath, ownedPaths, storagePath } from './component-paths'
import { stateToken } from './component-state'
import { planDeletion } from './file-deletion'
import { planMoves } from './file-moves'
import { unreachableEndpointMessage, type VersionEndpoint } from './version-endpoint'
import { compareFileSets, type FileComparison } from './version-diff'

// The component store, backed by one git repo per project (the App instance's
// dataDir) instead of the KV store. The authoring view is the WORKING TREE
// (draft); the published view is HEAD; a publish is one commit plus a
// `component/<name>/v<N>` tag. Layout mirrors the served tree so the repo is
// literally installable: a component's files live at their served paths, and
// its meta is `registry/<name>.json` (everything StoredComponent holds except
// the file CONTENTS and the version, which is the tag).
//
// This is the app surface's backend. The legacy node/dashboard use
// component-store.ts (KV) until the migration moves a project's data in here.

export interface StoredFile {
  path: string
  target: string
  type: string
  content: string
}

export interface StoredComponent {
  id: string
  name: string
  title: string
  type: 'registry:ui' | 'registry:hook'
  category: string
  description: string
  dependencies: string[]
  registryDependencies?: string[]
  files: StoredFile[]
  exportName: string
  signature?: string
  createdAt: number
  /**
   * What this component's draft currently is, as an opaque token — read at
   * read time and never stored. A caller hands it back as `expectedState` to
   * say which state its write was based on.
   *
   * `createdAt` stays a stored field beside it because it never churns: it is
   * written once and the record then keeps its committed bytes. A
   * last-modified stamp is the opposite, which is why the record carries none.
   */
  state: string
  version?: number
  publishedAt?: number
  targetsExplicit?: boolean
}

/**
 * Meta as stored on disk: the record minus file contents (those live at their
 * paths), and minus everything derived at read time.
 *
 * `state` is in that second group and the Omit is what says so. The token is a
 * reading of the index, and the record is one of the files the index holds —
 * storing it inside itself would be circular, and storing anything that moves
 * on every write would keep the record from ever returning to its committed
 * bytes.
 */
type StoredMeta = Omit<StoredComponent, 'files' | 'version' | 'publishedAt' | 'state'> & {
  files: Array<{ path: string; target: string; type: string }>
}

const THEME_PATH = 'theme.json'

export { declaredPath, storagePath }
export type { VersionEndpoint }

function newComponentId(): string {
  return `cp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function parseMeta(raw: string | null): StoredMeta | null {
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as StoredMeta
  } catch {
    return null
  }
}

/** What the component's draft currently is — the token a caller hands back. */
async function componentState(dir: string, meta: StoredMeta): Promise<string> {
  return stateToken(await stagedState(dir, componentPaths(meta.name, meta.files)))
}

/**
 * The optimistic guard: given, a write is refused when the component moved
 * since the caller read it.
 *
 * The token is content-addressed, which has one consequence worth stating
 * because it looks like a hole and is not. **A write is accepted if the state
 * it was based on has been RESTORED by the time it lands**, even though other
 * writes happened in between — someone edited and put it back. That is the
 * correct answer rather than a tolerated one: this guard exists to stop a write
 * silently discarding somebody's work, and at the moment this one lands there
 * is no such work left to discard. A stamp would refuse it, and refusing it
 * would be protecting a change that no longer exists.
 *
 * Both values are named in the error, because "it moved" is not actionable and
 * "it is X, you had Y" is.
 */
async function assertFresh(dir: string, meta: StoredMeta, expectedState?: string): Promise<void> {
  if (expectedState === undefined) {
    return
  }
  // An empty string is not a state this store ever produces — a real token is
  // a digest — so it can only have been supplied, and it says nothing about
  // what the caller read. It gets its own refusal rather than falling through
  // to "changed since you read it", which would name a value the caller never
  // held and send them looking for a concurrent write that never happened.
  if (expectedState === '') {
    throw new Error(
      `Cannot write component "${meta.name}" against an empty state. Read the component and hand back the \`state\` it returns, or omit the parameter to write unguarded — but do not pass an empty one, which reads as neither.`,
    )
  }
  const current = await componentState(dir, meta)
  if (current !== expectedState) {
    throw new Error(`Stale write: component "${meta.name}" changed since you read it (now ${current}, you read ${expectedState}). Re-read and retry.`)
  }
}

// ── Reads ─────────────────────────────────────────────────
// `ref` undefined = the working tree (draft, the authoring view); a ref such
// as 'HEAD' or a version tag = that published point.

async function readRaw(dir: string, path: string, ref?: string): Promise<string | null> {
  return ref ? showAt(dir, ref, path) : readWorking(dir, path)
}

async function listComponentNames(dir: string, ref?: string): Promise<string[]> {
  if (ref) {
    return (await listHead(dir, META_DIR))
      .filter((p) => p.startsWith(`${META_DIR}/`) && p.endsWith('.json'))
      .map((p) => p.slice(META_DIR.length + 1, -'.json'.length))
  }
  const entries = await host.fs.readdir(`${dir}/${META_DIR}`, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e: { isFile?: () => boolean; name: string }) => e.name.endsWith('.json'))
    .map((e: { name: string }) => e.name.slice(0, -'.json'.length))
}

async function hydrate(dir: string, meta: StoredMeta, ref: string | undefined, version: number): Promise<StoredComponent> {
  const files: StoredFile[] = []
  for (const f of meta.files ?? []) {
    const content = (await readRaw(dir, storagePath(meta.name, f), ref)) ?? ''
    files.push({ path: f.path, target: f.target, type: f.type, content })
  }
  // The token describes the DRAFT. A read at a published ref is not a state a
  // write can be based on, so it carries none rather than a token for
  // something no caller can return to.
  const state = ref ? '' : await componentState(dir, meta)
  return { ...meta, files, state, version: version || undefined }
}

export async function readComponentMeta(dir: string, name: string, ref?: string): Promise<StoredMeta | null> {
  return parseMeta(await readRaw(dir, metaPath(name), ref))
}

/** One component, files hydrated. Draft view when ref is omitted. */
export async function readComponent(dir: string, name: string, ref?: string): Promise<StoredComponent | null> {
  const meta = await readComponentMeta(dir, name, ref)
  if (!meta) {
    return null
  }
  return hydrate(dir, meta, ref, await highestVersion(dir, name))
}

/** Every component, files hydrated. Draft view when ref is omitted. */
export async function readComponents(dir: string, ref?: string): Promise<StoredComponent[]> {
  const names = await listComponentNames(dir, ref)
  const out: StoredComponent[] = []
  for (const name of names) {
    const meta = await readComponentMeta(dir, name, ref)
    if (meta) {
      out.push(await hydrate(dir, meta, ref, await highestVersion(dir, name)))
    }
  }
  return out
}

// The published view, cached on the HEAD sha: HEAD moves only at a publish,
// so the sha is a perfect cache key — a steady-state registry read costs one
// `rev-parse` fork, and the full hydrate (an ls-tree plus a show per file)
// runs only after a publish. A module re-evaluation just resets the cache.
const publishedCache = new Map<string, { sha: string; components: StoredComponent[] }>()

export async function readComponentsPublished(dir: string): Promise<StoredComponent[]> {
  const sha = await headSha(dir)
  if (!sha) {
    return []
  }
  const cached = publishedCache.get(dir)
  if (cached && cached.sha === sha) {
    return cached.components
  }
  const components = await readComponents(dir, 'HEAD')
  publishedCache.set(dir, { sha, components })
  return components
}

// ── Draft writes (working tree) ───────────────────────────

function serializeMeta(meta: StoredMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`
}

/**
 * Store a component's record.
 *
 * Nothing here decides a timestamp. The record holds only what the
 * component IS, so a write that stores what was already there leaves the bytes
 * unchanged, git reports nothing, and the draft has genuinely not moved.
 */
async function writeMeta(dir: string, meta: StoredMeta): Promise<void> {
  await writeWorking(dir, metaPath(meta.name), serializeMeta(meta))
}

/** Strip a hydrated record to its on-disk meta: no file contents, and nothing read-time. */
function toMeta(c: StoredComponent): StoredMeta {
  const { files, version, publishedAt, state, ...rest } = c
  return { ...rest, files: files.map((f) => ({ path: f.path, target: f.target, type: f.type })) }
}

export async function writeComponent(
  dir: string,
  input: Partial<StoredComponent> & { name: string; exportName: string },
  expectedState?: string,
): Promise<StoredComponent> {
  const existing = await readComponentMeta(dir, input.name)
  if (existing) {
    // The guard is ignored when creating — there is nothing to be stale against.
    await assertFresh(dir, existing, expectedState)
  }
  const now = Date.now()
  const meta: StoredMeta = {
    id: existing?.id ?? newComponentId(),
    name: input.name,
    title: input.title ?? input.name,
    type: input.type ?? 'registry:ui',
    category: input.category ?? (input.type === 'registry:hook' ? 'Hooks' : 'Components'),
    description: input.description ?? '',
    dependencies: input.dependencies ?? [],
    registryDependencies: input.registryDependencies ?? [],
    exportName: input.exportName,
    signature: input.signature,
    files: existing?.files ?? [],
    createdAt: existing?.createdAt ?? now,
    targetsExplicit: true,
  }
  await writeMeta(dir, meta)
  return hydrate(dir, meta, undefined, await highestVersion(dir, input.name))
}

export async function editComponent(dir: string, name: string, patch: Partial<StoredMeta>, expectedState?: string): Promise<StoredComponent> {
  const meta = await readComponentMeta(dir, name)
  if (!meta) {
    throw new Error(`Component "${name}" does not exist.`)
  }
  await assertFresh(dir, meta, expectedState)
  const next: StoredMeta = { ...meta, ...patch, name: meta.name, id: meta.id, files: meta.files }
  await writeMeta(dir, next)
  return hydrate(dir, next, undefined, await highestVersion(dir, name))
}

export async function writeFiles(
  dir: string,
  name: string,
  files: Array<{ path?: string; target?: string; type?: string; content: string }>,
  expectedState?: string,
): Promise<void> {
  const meta = await readComponentMeta(dir, name)
  if (!meta) {
    throw new Error(`Component "${name}" does not exist.`)
  }
  await assertFresh(dir, meta, expectedState)
  const byTarget = new Map(meta.files.map((f) => [f.target, f]))
  const owners = await fileOwners(dir)
  for (const f of files) {
    const target = String(f.target || f.path || '').trim()
    if (!target) {
      continue
    }
    const entry = { path: f.path ?? target, target, type: f.type ?? meta.files.find((x) => x.target === target)?.type ?? 'registry:component' }
    // A shipped path belongs to one component. Two components shipping the
    // same install path is a GENUINE conflict — installing both into one
    // project would have one overwrite the other — so it surfaces here as
    // exactly that, never as a storage accident later.
    if (entry.type !== 'registry:ignore') {
      const owner = owners.get(storagePath(name, entry))
      if (owner && owner !== name) {
        throw new Error(
          `Components "${owner}" and "${name}" would both ship "${target}" — installing both into one project would have one overwrite the other. Pick a different target, or resolve which component owns it.`,
        )
      }
    }
    await writeWorking(dir, storagePath(name, entry), f.content)
    byTarget.set(target, entry)
  }
  await writeMeta(dir, { ...meta, files: [...byTarget.values()] })
}

/** Batch string-replace across a component's files. ALL-OR-NOTHING: nothing persists unless every edit applies. */
export async function editFiles(
  dir: string,
  name: string,
  edits: Array<{ path: string; old: string; new: string; replaceAll?: boolean }>,
  expectedState?: string,
): Promise<{ applied: number }> {
  const meta = await readComponentMeta(dir, name)
  if (!meta) {
    throw new Error(`Component "${name}" does not exist.`)
  }
  await assertFresh(dir, meta, expectedState)
  const next = new Map<string, string>()
  for (const e of edits) {
    const entry = meta.files.find((f) => f.target === e.path || f.path === e.path)
    const where = entry ? storagePath(name, entry) : storagePath(name, { path: e.path })
    const content = next.get(where) ?? (await readWorking(dir, where))
    if (content === null || content === undefined) {
      throw new Error(`editFiles: no file "${e.path}" on component "${name}".`)
    }
    const occurrences = content.split(e.old).length - 1
    if (occurrences === 0) {
      throw new Error(`editFiles: \`old\` not found in "${e.path}".`)
    }
    if (occurrences > 1 && !e.replaceAll) {
      throw new Error(`editFiles: \`old\` is not unique in "${e.path}" (${occurrences} matches). Set replaceAll or add context.`)
    }
    next.set(where, e.replaceAll ? content.split(e.old).join(e.new) : content.replace(e.old, e.new))
  }
  for (const [where, content] of next) {
    await writeWorking(dir, where, content)
  }
  // The record is rewritten unchanged, which is deliberate rather than
  // pointless: a replacement changes no field of it, so storing it again is a
  // no-op on disk and leaves the draft exactly where the file writes left it.
  await writeMeta(dir, meta)
  return { applied: edits.length }
}

/** Batch-rename file paths within a component (atomic in the meta; contents never change). */
export async function moveFiles(
  dir: string,
  name: string,
  moves: Array<{ from: string; to: string }>,
  expectedState?: string,
): Promise<{ moved: number }> {
  const meta = await readComponentMeta(dir, name)
  if (!meta) {
    throw new Error(`Component "${name}" does not exist.`)
  }
  await assertFresh(dir, meta, expectedState)

  // Decide the whole batch first, then do the work. The action documents
  // itself as atomic: a request refused halfway must not leave the earlier
  // moves on disk with the record never updated, or the record and the tree
  // disagree about where the component's files are.
  const plan = planMoves(name, meta.files, moves)

  // The cross-component collision stays here: only the store can see what the
  // other components declare. Over the DESTINATIONS only — a file the batch
  // leaves where it is has whatever owner it already had, and refusing a move
  // because of a collision somewhere else in the component would be answering
  // a question nobody asked. Checked before anything moves, like the rest.
  const owners = await fileOwners(dir)
  for (const move of plan.moves) {
    const owner = owners.get(move.to)
    if (owner && owner !== name) {
      throw new Error(
        `Components "${owner}" and "${name}" would both ship "${declaredPath(name, move.to)}" — installing both into one project would have one overwrite the other. Pick a different target.`,
      )
    }
  }

  // Every content read before any write, so a missing file refuses the batch
  // rather than interrupting it.
  const carried: Array<{ to: string; content: string }> = []
  for (const move of plan.moves) {
    const content = await readWorking(dir, move.from)
    if (content === null) {
      throw new Error(`moveFiles: "${declaredPath(name, move.from)}" is missing from the working tree.`)
    }
    carried.push({ to: move.to, content })
  }

  for (const file of carried) {
    await writeWorking(dir, file.to, file.content)
  }
  // Only the sources nothing moved INTO. Two files that swap names, or a chain
  // that ends on a name another move vacated, both leave a source path that is
  // also a destination — removing it would delete what was just written there.
  const destinations = new Set(plan.moves.map((m) => m.to))
  for (const move of plan.moves) {
    if (!destinations.has(move.from)) {
      await removeWorking(dir, move.from)
    }
  }
  await writeMeta(dir, { ...meta, files: plan.files })
  return { moved: moves.length }
}

/** Rename a component: its meta file and name move; file paths and contents stay (use moveFiles for paths). */
export async function renameComponent(dir: string, from: string, to: string): Promise<StoredComponent> {
  const meta = await readComponentMeta(dir, from)
  if (!meta) {
    throw new Error(`Component "${from}" does not exist.`)
  }
  if (await readComponentMeta(dir, to)) {
    throw new Error(`Component "${to}" already exists.`)
  }
  const next: StoredMeta = { ...meta, name: to }
  // Ignore-file storage paths embed the component name — carry them to the
  // new name's home, or the rename would orphan every doc file.
  for (const f of meta.files) {
    if (f.type === 'registry:ignore') {
      const content = await readWorking(dir, storagePath(from, f))
      if (content !== null) {
        await writeWorking(dir, storagePath(to, f), content)
      }
      await removeWorking(dir, storagePath(from, f))
    }
  }
  await writeMeta(dir, next)
  await removeWorking(dir, metaPath(from))
  return hydrate(dir, next, undefined, await highestVersion(dir, to))
}

/**
 * Batch-delete a component's files, matched by path or target.
 *
 * `deleted` and `missing` partition the strings the CALLER asked for;
 * `removedFiles` names the records that actually went. They are not the same
 * list: one string can name several records (two records sharing a path is the
 * collision this exists to report honestly), and two strings can name one.
 * Which records a request addresses is decided once, in file-deletion.ts — the
 * same set drives the record that is persisted, the stored files that are
 * removed, and what is reported, which is what stops a file surviving with no
 * record pointing at it.
 */
export async function deleteFiles(dir: string, name: string, paths: string[], expectedState?: string): Promise<{ deleted: string[]; missing: string[]; removedFiles: string[] }> {
  const meta = await readComponentMeta(dir, name)
  if (!meta) {
    throw new Error(`Component "${name}" does not exist.`)
  }
  await assertFresh(dir, meta, expectedState)
  const plan = planDeletion(meta.files, paths)
  for (const entry of plan.removed) {
    await removeWorking(dir, storagePath(name, entry))
  }
  if (plan.removed.length > 0) {
    await writeMeta(dir, { ...meta, files: plan.remaining })
  }
  // Named the way its author declared it, not by its storage location: an
  // ignored file lives under an internal root that means nothing to whoever
  // wrote `docs/doc.mdx`.
  return {
    deleted: plan.deleted,
    missing: plan.missing,
    removedFiles: plan.removed.map((f) => declaredPath(name, storagePath(name, f))),
  }
}

// ── The authoring view with state, for the editor UI ──────
// The git-backed counterpart of the KV path's readComponentsWithDraftState
// (server/index.ts): the working tree is the record (the draft the editor
// edits), `draft` says whether it is ahead of the published head (or never
// published), `draftFilesChanged` names the files that differ, and
// publishedBy/At come off the latest version tag's commit.

export interface StateComponent extends StoredComponent {
  draft?: number | 'unpublished'
  draftFilesChanged?: string[]
  publishedBy?: { name?: string }
}

export async function readComponentsWithState(dir: string): Promise<StateComponent[]> {
  const working = await readComponents(dir)
  const changed = new Set(await changedPaths(dir))
  const published = new Map((await readComponentsPublished(dir)).map((c) => [c.name, c]))
  const out: StateComponent[] = []
  for (const c of working) {
    // Changed paths come back as storage paths; the editor marks rows by the
    // file's TARGET, so translate before reporting.
    const changedTargets = c.files.filter((f) => changed.has(storagePath(c.name, f))).map((f) => f.target)
    // A file the published head declares that the draft no longer does is a
    // pending deletion — a draft change no current file row carries, so it
    // would otherwise vanish from this view while the repository stays dirty.
    const declared = new Set(c.files.map((f) => storagePath(c.name, f)))
    const removedTargets = (published.get(c.name)?.files ?? [])
      .filter((f) => !declared.has(storagePath(c.name, f)) && changed.has(storagePath(c.name, f)))
      .map((f) => f.target)
    // The record counts as a draft change in its own right, and it has to: the
    // served registry item is built out of it, so a title, a description, a
    // type or a dependency edited with no file touched is a real difference an
    // installer receives, and a marker that ignored the record would say
    // nothing about it. The record holds only what the component IS -- no
    // last-modified stamp that moves when nothing has -- so it is dirty exactly
    // when something about it differs from what is published. Dropping it from
    // here would give a marker that misses the only change it is sole witness to.
    const metaTouched = changed.has(metaPath(c.name))
    const revs = await componentRevisions(dir, c.name)
    const top = revs[0]
    const draft =
      c.version === undefined ? ('unpublished' as const) : changedTargets.length > 0 || removedTargets.length > 0 || metaTouched ? c.version : undefined
    out.push({
      ...c,
      publishedAt: top ? Date.parse(top.at) || undefined : undefined,
      publishedBy: top?.author ? { name: top.author } : undefined,
      draft,
      draftFilesChanged: draft === undefined ? undefined : draft === 'unpublished' ? c.files.map((f) => f.target) : [...changedTargets, ...removedTargets],
    })
  }
  return out
}

export async function getComponentWithState(dir: string, name: string): Promise<StateComponent | null> {
  return (await readComponentsWithState(dir)).find((c) => c.name === name) ?? null
}

/**
 * Migration import: write a full record — meta preserved verbatim (id,
 * createdAt, everything the record holds) plus its file contents — into the
 * working tree. No commit: the migration commits once for the whole project.
 */
export async function importComponentRecord(dir: string, record: StoredComponent): Promise<void> {
  for (const f of record.files) {
    await writeWorking(dir, storagePath(record.name, f), f.content)
  }
  await writeMeta(dir, toMeta(record))
}

/** Which component owns each working-tree storage path — content and meta files alike. */
export async function fileOwners(dir: string): Promise<Map<string, string>> {
  const owners = new Map<string, string>()
  for (const name of await listComponentNames(dir)) {
    const meta = await readComponentMeta(dir, name)
    if (!meta) {
      continue
    }
    owners.set(metaPath(name), name)
    for (const f of meta.files) {
      owners.set(storagePath(name, f), name)
    }
  }
  return owners
}

/**
 * Components whose published files changed in commits since a point in time
 * (ISO 8601 or epoch milliseconds). Time-based `changesSince` — the
 * version-based form is `changesSince(name, v)` with the tag floor.
 */
export async function changedSinceDate(dir: string, since: string | number): Promise<Array<{ name: string; changed: string[] }>> {
  const iso = typeof since === 'number' || /^\d+$/.test(String(since)) ? new Date(Number(since)).toISOString() : String(since)
  const paths = new Set(await pathsChangedSince(dir, iso))
  if (paths.size === 0) {
    return []
  }
  const owners = await fileOwners(dir)
  const byComponent = new Map<string, string[]>()
  for (const p of paths) {
    const owner = owners.get(p)
    if (owner) {
      byComponent.set(owner, [...(byComponent.get(owner) ?? []), p])
    }
  }
  return [...byComponent.entries()].map(([name, changed]) => ({ name, changed }))
}

// ── Search over the working tree ──────────────────────────

export async function globFiles(dir: string, pattern: string, prefix = ''): Promise<string[]> {
  const files = await listWorkingFiles(dir, prefix)
  const rx = new RegExp(
    `^${pattern.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`,
  )
  return files.filter((f) => rx.test(f))
}

export async function grepFiles(dir: string, pattern: string, flags?: string): Promise<Array<{ path: string; line: number; text: string }>> {
  return grepWorking(dir, pattern, flags ?? '')
}

// ── The scope of a commit that changes one component ──────

/**
 * The head's record for this component, found by IDENTITY rather than by name.
 *
 * A component keeps its id across a rename and changes its name, so after one
 * the head still files it under its old name and a lookup by name finds
 * nothing. That miss would leave a renamed component's old record at head
 * forever: no operation is scoped to a path nothing can name.
 *
 * The name lookup misses on a component's FIRST publish as well as after a
 * rename, and a first publish is ordinary, so the search below is narrowed to
 * head records the draft no longer accounts for. That set is normally empty and
 * nothing is read; a rename is what puts something in it.
 *
 * KNOWN BLIND SPOT, and it is a deliberate trade rather than an oversight.
 * Skipping head names the draft still holds means missing the case where a
 * component is renamed and a NEW component is then created at the freed name:
 * the head record under the old name is this component's, but the draft holds
 * that name for someone else, so it is skipped and this component's paths under
 * its old name stay at head. That is reachable — nothing stops a name being
 * reused once a rename frees it — and the residue lasts until the new namesake
 * publishes, which overwrites the record. There is no cheap exact gate: knowing
 * whether a head record is OURS means reading it, which is the cost being
 * avoided. Removing the narrowing is one line if the case is ever judged to
 * outweigh reading every head record on every first publish.
 */
async function readHeadRecord(dir: string, meta: StoredMeta): Promise<DeclaredRecord | null> {
  const sameName = await readComponentMeta(dir, meta.name, 'HEAD')
  if (sameName) {
    return { name: meta.name, files: sameName.files }
  }
  const draftNames = new Set(await listComponentNames(dir))
  for (const name of await listComponentNames(dir, 'HEAD')) {
    if (draftNames.has(name)) {
      continue
    }
    const candidate = await readComponentMeta(dir, name, 'HEAD')
    if (candidate && candidate.id === meta.id) {
      return { name, files: candidate.files }
    }
  }
  return null
}

/**
 * `ownedPaths` against a real repo: the published record is whichever head
 * record this component IS, and "gone from the tree" is a working-tree read.
 *
 * Both commit sites go through this. The REPORTING layer does not, and its
 * readers do not agree with each other, so they are worth telling apart rather
 * than waved at as one group.
 *
 * `draftAhead` in listRevisions and the `metaTouched` check in
 * readComponentsWithState use the declared set alone, and should keep doing so:
 * they answer "has the draft moved", not "what must this commit cover".
 *
 * `removedTargets`, sitting beside metaTouched, is NOT one of those. It builds
 * the head half itself out of the published record, discriminating on what git
 * reports as changed instead of on a tree read, and over the file storage paths
 * alone rather than componentPaths. So this concept has two live spellings —
 * here for commits, there for reporting — and anyone tracing the family should
 * read both rather than assume the reporting layer defers to this one. The
 * reporting one also matches the head by NAME, so it does not see a
 * rename; that is a display gap, not a commit gap, and it is not this to fix.
 *
 * What keeps the declared-set readers correct is close to definitional rather
 * than fragile, which is worth saying plainly because the fragile version
 * invites a defensive fix nobody needs: a declared path is declared BY the
 * record, so an operation that stops declaring one necessarily rewrites the
 * record, and the record's path is in the declared set. Every meta write in
 * this file that can shrink `files` goes through writeMeta.
 *
 * The shape that WOULD break them is the mirror — a working-tree mutation with
 * no record write. `discardDraft` is the one place that does it, and it is
 * safe for a reason worth stating rather than assuming: it takes its paths
 * from THIS function, so the record is one of the paths it returns to the
 * head. The record moves with the files instead of being left behind them,
 * which is what makes a discarded component read as having no draft at all.
 */
async function readOwnedPaths(dir: string, meta: StoredMeta): Promise<string[]> {
  const head = await readHeadRecord(dir, meta)
  return ownedPaths(meta, head, async (path) => (await readWorking(dir, path)) === null)
}

export interface DeleteResult {
  deleted: boolean
  name: string
  /** The commit that took it out of the published head, or null when there was
   *  nothing published to take it out of. */
  committed: string | null
}

/**
 * Delete a component — its files and its registry record — out of the working
 * tree AND out of the published head, in one commit scoped to its own paths.
 *
 * The commit is not conditional on the component being published, because the
 * condition already lives in the pathspec: only paths git reports as staged
 * ride along, and a component that was never committed leaves nothing staged
 * once its paths are removed. So deleting an unpublished component produces no
 * commit BY CONSTRUCTION rather than by a branch someone has to keep true.
 *
 * Staging without committing is not an option. It is not "the deletion lands
 * later" — there is no later. The published head would go on serving a
 * component the authoring view no longer has, the staged removals would sit in
 * the tree indefinitely, and no subsequent operation is scoped to pick them up:
 * a publish commits one component's meta and its files, and a deleted
 * component has no meta left to publish. The component would end up absent
 * from the interface, present in the registry, and unreachable by any ordinary
 * flow.
 *
 * The commit is made under `author`'s name.
 */
export async function deleteComponent(dir: string, name: string, author: string, message = `Delete ${name}`): Promise<DeleteResult> {
  const meta = await readComponentMeta(dir, name)
  if (!meta) {
    return { deleted: false, name, committed: null }
  }
  // Computed before the removals below, so the tree read that decides the head
  // half sees the state this delete started from rather than its own work.
  const paths = await readOwnedPaths(dir, meta)
  for (const f of meta.files) {
    await removeWorking(dir, storagePath(name, f))
  }
  await removeWorking(dir, metaPath(name))
  // Not commitPaths: that path `git add`s first, and an add on a just-rm'ed
  // path is fatal — which would leave every cross-repo move printing a git
  // error while its departure sat staged and uncommitted, the source repo dirty
  // and its published head still serving the moved component.
  const committed = await commitStagedRemovals(dir, message, paths, author)
  return { deleted: true, name, committed }
}

// ── Publish: one commit over the component's files + meta, then the tag ──

export interface PublishResult {
  published: boolean
  name: string
  version: number
}

/** Publish one component's draft, committed under `options.author`'s name. */
export async function publishComponent(dir: string, name: string, options: { author: string; expectedVersion?: number }): Promise<PublishResult> {
  const meta = await readComponentMeta(dir, name)
  if (!meta) {
    throw new Error(`Component "${name}" does not exist.`)
  }
  const current = await highestVersion(dir, name)
  if (options.expectedVersion !== undefined && options.expectedVersion !== current) {
    throw new Error(`Stale publish: component "${name}" is at v${current}, you built on v${options.expectedVersion}.`)
  }
  // One publish is one commit over THIS component's paths, and only those —
  // another component's draft never rides along.
  const paths = await readOwnedPaths(dir, meta)
  const sha = await commitPaths(dir, `Publish ${name} v${current + 1}`, paths, options.author)
  if (!sha) {
    // Nothing changed since the published head: no commit, no version spent.
    return { published: false, name, version: current }
  }
  const version = current + 1
  await tagVersion(dir, name, version, sha)
  return { published: true, name, version }
}

// ── History / revisions (tags are the source of truth) ────

export interface RevisionRow {
  version: number
  publishedAt: string
  sha: string
  /** The name the publish commit was made under. */
  author: string
  /**
   * The component's own files this version changed, against the version below
   * it. The registry record is excluded: it moves on every publish and would
   * drown the answer, so `[]` means a publish that touched nothing else.
   * `null` means there is no version below this one to compare against, which
   * is NOT the same as "changed nothing" -- the guess `changesSince` already
   * refuses to make.
   */
  changed: string[] | null
}

/** A component's declared storage paths at one ref -- the pathspec its diffs must be scoped to. */
async function componentPathsAt(dir: string, name: string, ref: string): Promise<string[]> {
  const meta = await readComponentMeta(dir, name, ref)
  return meta ? meta.files.map((f) => storagePath(name, f)) : []
}

/**
 * What one component changed between two of its own tags. Every tag in this
 * repo sits on ONE linear history shared with every other component, so an
 * unscoped tag-to-tag diff reports whatever else happened to be published in
 * between as if this component had changed it. The pathspec is the union of
 * what the component declared at both ends, so a file added, removed or
 * renamed across the pair is still covered.
 */
async function changedBetween(dir: string, from: string, to: string, scopeFor: (ref: string) => Promise<string[]>): Promise<string[]> {
  const scope = Array.from(new Set([...(await scopeFor(from)), ...(await scopeFor(to))]))
  // An empty pathspec diffs the WHOLE repo, which is the very failure above.
  // Declaring no files means there is nothing of this component's to report.
  return scope.length > 0 ? diffNames(dir, from, to, scope) : []
}

export async function listRevisions(dir: string, name: string): Promise<{ name: string; versions: RevisionRow[]; floor: number; draftAhead: boolean }> {
  const revs = await componentRevisions(dir, name)
  const pathCache = new Map<string, string[]>()
  const scopeFor = async (ref: string): Promise<string[]> => {
    const hit = pathCache.get(ref)
    if (hit) {
      return hit
    }
    const paths = await componentPathsAt(dir, name, ref)
    pathCache.set(ref, paths)
    return paths
  }

  const versions: RevisionRow[] = []
  for (let i = 0; i < revs.length; i += 1) {
    const r = revs[i]
    // Newest first, so the version BELOW this one is the next row along.
    const older = revs[i + 1]
    const tag = componentTag(name, r.version)
    versions.push({
      version: r.version,
      publishedAt: r.at,
      sha: r.sha,
      author: r.author,
      // Reported as the component DECLARES them: a history entry is read by a
      // person, and the internal storage root is this layout's business.
      changed: older ? (await changedBetween(dir, componentTag(name, older.version), tag, scopeFor)).map((p) => declaredPath(name, p)) : null,
    })
  }

  const floor = revs.length > 0 ? Math.min(...revs.map((r) => r.version)) : 0
  const meta = await readComponentMeta(dir, name)
  const changed = await changedPaths(dir)
  // Match on STORAGE paths, which is what git reports. A `registry:ignore`
  // file (docs/doc.mdx, docs/preview.tsx) is stored under `internal/<name>/`
  // and never at its target, so matching the target alone would see no draft at all
  // for exactly the files a component's author edits most.
  //
  // The set includes the component's RECORD, for the reason the reporting
  // marker keeps it: an edit to what the registry serves touches no file, and
  // a timeline with no Draft point on it would leave that edit with nothing to
  // compare against. It is honest here only because the record holds nothing
  // that moves on its own -- no last-modified stamp, so no phantom difference.
  const own = meta ? new Set(componentPaths(name, meta.files)) : null
  const draftAhead = Boolean(own && changed.some((p) => own.has(p)))
  return { name, versions, floor, draftAhead }
}

export type ChangesSince =
  | { status: 'ok'; changed: string[]; from: number; to: number }
  | { status: 'predatesHistory'; floor: number; message: string }
  | { status: 'ahead'; latest: number; message: string }

/**
 * What changed for a component since version N. The floor is the component's
 * LOWEST tag (the migration baseline): below it we cannot compare, and say so
 * rather than answering "no changes" — the failure that ships stale code.
 */
export async function changesSince(dir: string, name: string, since: number): Promise<ChangesSince> {
  const top = await highestVersion(dir, name)
  let floor = 0
  for (let v = 1; v <= top; v += 1) {
    if ((await showAt(dir, componentTag(name, v), metaPath(name))) !== null) {
      floor = v
      break
    }
  }
  if (since > top) {
    return { status: 'ahead', latest: top, message: `v${since} is ahead of the registry — latest is v${top}.` }
  }
  if (floor === 0 || since < floor) {
    return { status: 'predatesHistory', floor, message: `cannot compare against v${since} — it predates this project's migrated history (earliest is v${floor || top}); install the current state.` }
  }
  const changed = await diffNames(dir, componentTag(name, since), 'HEAD')
  return { status: 'ok', changed, from: since, to: top }
}

// `'none'`, the empty state, is a value rather than a special case in the
// caller because it is what collapses two questions into one: "everything this
// version introduced" is "what changed between these two ends" with `'none'` as
// the older end, so nothing has to grow a second code path to answer it. It
// also makes the union TOTAL — every member resolves to a file list — which is
// what lets the comparison below name a missing end without a cast.

export interface VersionFiles {
  name: string
  /** Which point this is: a published version number, the working tree, or the
   *  empty state before the component's first version. */
  at: VersionEndpoint
  files: Array<{ path: string; target: string; type: string; content: string }>
}

/**
 * A component's files as one published version shipped them, read from that
 * version's tag.
 *
 * Null when there is no such version — asked for a version that was never
 * published, or one below the migration baseline where no tag exists. It must
 * stay null rather than falling back to the working tree: a fallback would show
 * today's code under a historical label, which reads as an answer and is not
 * one.
 *
 * The version is echoed from the argument rather than taken off the record,
 * because `readComponent` reports the component's HIGHEST version in that field
 * whatever ref it actually read.
 */
export async function readComponentAtVersion(dir: string, name: string, version: number): Promise<VersionFiles | null> {
  const at = await readComponent(dir, name, componentTag(name, version))
  return at ? { name, at: version, files: at.files.map(fileOf) } : null
}

/** The same shape for the working tree — the draft end of a comparison. */
export async function readComponentDraftFiles(dir: string, name: string): Promise<VersionFiles | null> {
  const draft = await readComponent(dir, name)
  return draft ? { name, at: 'draft', files: draft.files.map(fileOf) } : null
}

/** A component's files at any one end of a comparison. */
export async function readComponentAtEndpoint(dir: string, name: string, at: VersionEndpoint): Promise<VersionFiles | null> {
  if (at === 'none') {
    return { name, at, files: [] }
  }
  return at === 'draft' ? readComponentDraftFiles(dir, name) : readComponentAtVersion(dir, name, at)
}

/**
 * Two ends of a component's history, paired file by file.
 *
 * The one place the pairing is composed, so the invoke the history surface
 * calls and the App action an agent calls cannot answer the same question
 * differently.
 */
export async function compareComponentVersions(
  dir: string,
  name: string,
  from: VersionEndpoint,
  to: VersionEndpoint,
): Promise<{ component: string; from: VersionEndpoint; to: VersionEndpoint; files: FileComparison[] }> {
  const [older, newer] = await Promise.all([readComponentAtEndpoint(dir, name, from), readComponentAtEndpoint(dir, name, to)])
  if (!older || !newer) {
    // The versions actually held, so the refusal can say which ends WOULD work.
    // Read only on this path: it costs a git call, and a comparison that
    // succeeds never needs it.
    const held = (await componentRevisions(dir, name)).map((r) => r.version).sort((a, b) => a - b)
    throw new Error(unreachableEndpointMessage(name, !older ? from : to, held))
  }
  return { component: name, from: older.at, to: newer.at, files: compareFileSets(older.files, newer.files) }
}

function fileOf(f: StoredFile): { path: string; target: string; type: string; content: string } {
  return { path: f.path, target: f.target, type: f.type, content: f.content }
}

// ── Theme ─────────────────────────────────────────────────

export interface ProjectTheme {
  preset?: string
  css?: string
  /** see server/shadcn-style.ts; absent = new-york-v4 */
  shadcnStyle?: string
}

export async function readTheme(dir: string): Promise<ProjectTheme> {
  return (parseMeta(await readWorking(dir, THEME_PATH)) as unknown as ProjectTheme) ?? {}
}

export async function writeTheme(dir: string, theme: ProjectTheme): Promise<void> {
  await writeWorking(dir, THEME_PATH, `${JSON.stringify(theme, null, 2)}\n`)
}

// ── Discard a draft (return the whole component to published) ───

export interface DiscardResult {
  /** Files whose content came back from the published head. */
  restored: string[]
  /** Files the draft added, which the published head has nothing to come back
   *  to — so they are gone. Named separately because that is the half a person
   *  cannot undo by discarding again. */
  removed: string[]
}

/**
 * Return every one of a component's files to the published head: the whole
 * draft, not one file.
 *
 * The path set is `readOwnedPaths`, which is what the two commit sites use —
 * the same concept rather than a second spelling of it. That matters in both
 * directions here. It reaches the component's REGISTRY RECORD, so a discard
 * leaves no record change behind and the component genuinely stops reading as
 * having unpublished work; and its head half is narrowed to paths that are
 * gone from the tree, so a path the head declared and a neighbour has since
 * taken over is left alone instead of being restored over somebody else's
 * file.
 *
 * Refused for a component that has never been published: there is no state to
 * come back to, and the only other reading of "roll it back" would be to
 * delete the component, which is a different act with a different action.
 */
export async function discardDraft(dir: string, name: string): Promise<DiscardResult> {
  const meta = await readComponentMeta(dir, name)
  if (!meta) {
    throw new Error(`Component "${name}" does not exist.`)
  }
  if (!(await readHeadRecord(dir, meta))) {
    throw new Error(
      `Component "${name}" has never been published, so there is no version to discard back to. Delete it instead if that is what you mean.`,
    )
  }
  const result: DiscardResult = { restored: [], removed: [] }
  for (const path of await readOwnedPaths(dir, meta)) {
    const published = await pathInHead(dir, path)
    await discardWorking(dir, path)
    // The registry record is discarded like everything else and reported like
    // nothing else: it is this layout's bookkeeping, not a file its author
    // wrote, and naming it here would put storage machinery in a list a person
    // reads to see what happened to their work.
    if (!path.startsWith(`${META_DIR}/`)) {
      ;(published ? result.restored : result.removed).push(declaredPath(name, path))
    }
  }
  return result
}
