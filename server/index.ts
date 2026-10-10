import { type AppActionContext, apps as hostApps } from '@opencroft/server/apps'
import { routeUrl } from '@opencroft/server/extension'
import { storage } from '@opencroft/server/storage'

import type { PoolGroup } from '../preview-runtime/protocol'
import { componentRefFromQuery, projectFromQuery } from '../src/registry/component-ref'
import { stripClientDirective, stripsClientDirective } from './client-directive'
import { committerOf } from './commit-identity'
import {
  changedSince,
  componentsKey,
  createComponentStore,
  draftFilesChanged,
  draftKey,
  draftStateFor,
  HISTORY_INDEX_KEY,
  overlayDraft,
} from './component-store'
import {
  aliasImportNames,
  createDependencyGraphBuilder,
  parseKitRef as parseDep,
  reservedNamespaceReason,
  SELF_SCOPE_PREFIX,
} from './dependency-graph'
import { createDesignKitApp } from './design-kit-app'
import { installRequestFrom } from './install-request'
import {
  bundleDep,
  createPreviewRoutes,
  DEFAULT_PRESET,
  type ProjectTheme,
  resolveThemeCss,
  THEME_PRESETS,
} from './preview'
import { createPreviewPoolCache } from './preview-pool-cache'
import { resolveProjectRef } from './project-resolution'
import { changeSignals, isIndexRequest, shapeIndexItem, shapeProjects } from './registry-shape'
import * as repoStore from './repo-store'
import { collectShadcnSources, shadcnHas } from './shadcn-registry'
import { DEFAULT_SHADCN_STYLE, effectiveShadcnStyle, parseShadcnStyle, SHADCN_STYLES } from './shadcn-style'
import {
  assertTargetsAvailable as assertTargetsAvailableIn,
  categorizedTarget,
  type ImportTargets,
  namespaceOf,
  rewriteComponentImports,
  servedTarget,
  slugify,
  withExplicitTargets,
} from './target'
import { createValidator, type ValidateComponentResult } from './validate'
import { readValidationSummary, summarizeValidation, type ValidationSummary } from './verdict'

// All design-kit state is persisted under the extension's namespaced key/value
// storage (`storage` from @opencroft/server/storage), backed by the app's `setting` table.

// ── Design projects ────────────────────────────────────

export interface DesignProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** preview theme: a shadcn preset id, or custom token CSS (see server/preview.ts) */
  theme?: ProjectTheme
}

const PROJECTS_KEY = 'projects'

async function readProjects(): Promise<DesignProject[]> {
  const list = await storage.get<DesignProject[]>(PROJECTS_KEY)
  return Array.isArray(list) ? list : []
}

async function writeProjects(list: DesignProject[]): Promise<void> {
  await storage.set(PROJECTS_KEY, list)
}

function newId(): string {
  return `dp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function cleanName(name: unknown, fallback = 'Untitled project'): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed.length > 0 ? trimmed : fallback
}

async function listProjects(): Promise<DesignProject[]> {
  return readProjects()
}

/**
 * A project's name IS its registry namespace, slugified. Two projects whose
 * names slugify alike install under one `@ns`, and a lookup by namespace
 * returns whichever comes first — so the second is unreachable rather than
 * merely confusingly named.
 */
function assertNamespaceFree(name: string, projects: DesignProject[], exceptId?: string): void {
  const ns = slugify(name)
  const reserved = reservedNamespaceReason(ns)
  if (reserved) {
    throw new Error(
      `Refusing the name "${name}": it installs under the namespace "@${ns}", which is reserved. ${reserved} Pick a different name.`,
    )
  }
  const clash = projects.find((p) => p.id !== exceptId && slugify(p.name) === ns)
  if (clash) {
    throw new Error(
      `Refusing the name "${name}": it installs under the namespace "@${ns}", which project "${clash.name}" already uses. ` +
        `A second project there would be unreachable by namespace. Pick a name that slugifies differently.`,
    )
  }
}

/**
 * Every other action in this extension takes a project as an id OR its
 * namespace, so these do too — an agent that just created a project by name
 * should not have to go and look its id up to act on it.
 */
function findProject(projects: DesignProject[], idOrSlug: string): DesignProject | undefined {
  return projects.find((p) => p.id === idOrSlug) ?? projects.find((p) => slugify(p.name) === idOrSlug)
}

async function createProject(name?: string): Promise<{ projects: DesignProject[]; created: DesignProject }> {
  const projects = await readProjects()
  const cleaned = cleanName(name)
  assertNamespaceFree(cleaned, projects)
  const now = Date.now()
  const created: DesignProject = { id: newId(), name: cleaned, createdAt: now, updatedAt: now }
  const next = [...projects, created]
  await writeProjects(next)
  // The pool spans projects, and the project list is part of what it caches.
  invalidatePreviewPools()
  return { projects: next, created }
}

async function renameProject(input: { id: string; name: string }): Promise<DesignProject[]> {
  const projects = await readProjects()
  const current = findProject(projects, input.id)
  if (!current) {
    throw new Error(`Design project "${input.id}" does not exist.`)
  }
  const cleaned = cleanName(input.name, current.name)
  assertNamespaceFree(cleaned, projects, current.id)
  const next = projects.map((p) => (p.id === current.id ? { ...p, name: cleaned, updatedAt: Date.now() } : p))
  await writeProjects(next)
  // A legacy project's name IS its namespace, and the pool resolves
  // cross-project references BY namespace — so a rename changes which component
  // a `@ns/name` dependency reaches, not just a label.
  invalidatePreviewPools()
  return next
}

/**
 * Delete a project and everything stored under it.
 *
 * Both guards are here rather than in either caller, because a rule that lives
 * in a wrapper is a rule the other surface does not have.
 *
 * `confirmName` must be the project's exact name: an id is easy to hold by
 * mistake and says nothing about what is behind it, whereas typing the name is
 * a statement about which project the caller means.
 *
 * The DATA goes with the project. Removing the entry on its own leaves the
 * components in storage — still reachable by id through the registry routes,
 * still installable, and invisible to every rule that iterates the project
 * list.
 *
 * The project entry is removed LAST. A failure part-way then leaves a project
 * that is still listed, still visible and safe to retry, rather than an orphan
 * with no owner.
 */
async function deleteProject(
  id: string,
  options: { confirmName?: string; force?: boolean } = {},
): Promise<DesignProject[]> {
  const projects = await readProjects()
  const target = findProject(projects, id)
  if (!target) {
    throw new Error(`Design project "${id}" does not exist.`)
  }
  if (options.confirmName !== target.name) {
    throw new Error(
      `Refusing to delete project "${target.name}": pass confirmName with its exact name. ` +
        `Received ${options.confirmName === undefined ? 'nothing' : `"${options.confirmName}"`}.`,
    )
  }

  // Everything below is keyed by the project's real id, never by whatever the
  // caller addressed it with — a namespace resolves to a project, but it is
  // not what its storage keys are built from.
  const held = overlayDraft(
    await componentStore.readPublished(target.id),
    await componentStore.readDraftOverlay(target.id),
  )
  if (held.length > 0 && !options.force) {
    throw new Error(
      `Refusing to delete project "${target.name}": it still holds ${held.length} component(s) — ` +
        `${held.map((c) => c.name).join(', ')}. Pass force to delete them along with it.`,
    )
  }

  // Swept by asking storage what it holds, rather than deleting the keys this
  // function can name. A component deleted BEFORE the project has already been
  // dropped from both lists while its history entry stays, so anything derived
  // from the live list misses exactly the keys that would be left unowned —
  // which is the failure this whole function exists to stop.
  //
  // The legacy `components-snapshot:` key is taken here too. Sweeping those
  // across the library is a separate decision and not this function's to make;
  // leaving this project's own behind while deleting the project is just
  // manufacturing one more orphan.
  const ownedByProject = (key: string): boolean =>
    key === componentsKey(target.id) ||
    key === draftKey(target.id) ||
    // The legacy comment-thread key — swept with the project so no orphan key
    // survives the delete.
    key === `comments:${target.id}` ||
    key === lastValidationKey(target.id) ||
    key === `components-snapshot:${target.id}` ||
    key.startsWith(`component-history:${target.id}:`)

  for (const key of await storage.list()) {
    if (ownedByProject(key)) {
      await storage.delete(key)
    }
  }
  const historyIndex = (await storage.get<Record<string, unknown>>(HISTORY_INDEX_KEY)) ?? {}
  for (const key of Object.keys(historyIndex)) {
    if (key.startsWith(`component-history:${target.id}:`)) {
      delete historyIndex[key]
    }
  }
  await storage.set(HISTORY_INDEX_KEY, historyIndex)

  const next = projects.filter((p) => p.id !== target.id)
  await writeProjects(next)
  // The project and every component under it are gone; a pool built before this
  // still carries their sources.
  invalidatePreviewPools()
  return next
}

// Set (or clear) a project's preview theme. `preset` must be a known preset id
// (omit to reset to the default); a non-empty `css` overrides the preset with
// custom token CSS (omit/empty to clear the customization).
async function setProjectTheme(input: { id: string; preset?: string; css?: string }): Promise<DesignProject[]> {
  const projects = await readProjects()
  const presetInput = typeof input.preset === 'string' ? input.preset.trim() : ''
  if (presetInput && !THEME_PRESETS.some((p) => p.id === presetInput)) {
    throw new Error(
      `setTheme: unknown preset "${presetInput}". Valid ids: ${THEME_PRESETS.map((p) => p.id).join(', ')}.`,
    )
  }
  const preset = presetInput || DEFAULT_PRESET
  const css = typeof input.css === 'string' && input.css.trim() ? input.css : undefined
  // The shadcn style is not part of what setTheme sets — carried over, so a
  // theme edit never silently moves a project back to new-york-v4.
  const next = projects.map((p) =>
    p.id === input.id ? { ...p, theme: { preset, css, shadcnStyle: p.theme?.shadcnStyle }, updatedAt: Date.now() } : p,
  )
  await writeProjects(next)
  return next
}

// Set a legacy (KV) project's shadcn style; see setShadcnStyle on the app
// surface for what it governs.
async function setProjectShadcnStyle(input: { id: string; style?: string }): Promise<DesignProject[]> {
  const style = parseShadcnStyle(input.style)
  const projects = await readProjects()
  const next = projects.map((p) =>
    p.id === input.id ? { ...p, theme: { ...(p.theme ?? {}), shadcnStyle: style }, updatedAt: Date.now() } : p,
  )
  await writeProjects(next)
  invalidatePreviewPools()
  return next
}

// ── Components (the registry, as data) ────────────────────
// A fully serialisable component: its source code plus the meta/doc the
// component page renders. CRUD'd through the extension `actions` surface,
// backed by the KV store until that store is retired.

export interface StoredFile {
  path: string
  target: string
  type: string
  content: string
}

export interface StoredComponent {
  // Stable, never reassigned. `name` is a slug and changes on rename; `id` is
  // what survives one. Backfilled lazily by readComponents for records written
  // before this field existed.
  id: string
  name: string
  title: string
  type: 'registry:ui' | 'registry:hook'
  category: string
  description: string
  dependencies: string[]
  registryDependencies?: string[]
  files: StoredFile[]
  /** @deprecated single-file form; still read for old records. */
  source?: string
  exportName: string
  signature?: string
  createdAt: number
  /** Stamped by every write to the storage-backed store. A record read from a
   *  repository-backed project has none: its history is the repository's. */
  updatedAt?: number
  /**
   * How many times this component has been published. Written by a publish and
   * only by a publish, so a record that predates versioning simply has none —
   * it is read as 1 rather than rewritten to carry one, which is what keeps
   * every already-published component's bytes exactly as they were.
   */
  version?: number
  publishedAt?: number
  /**
   * The stored file targets ARE the served ones — what an author writes is what
   * a consumer installs. Absent on a record from before targets were
   * authoritative, and those are still served with the category composed in, so
   * an untouched project's installed paths do not move. Set once, by the
   * migration that writes today's served values into the stored ones.
   */
  targetsExplicit?: boolean
}

function newComponentId(): string {
  return `cp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

// Normalise a stored record to its files (handles legacy single-`source` form).
export function componentFiles(c: { name: string; type: string; files?: StoredFile[]; source?: string }): StoredFile[] {
  if (Array.isArray(c.files) && c.files.length > 0) {
    return c.files
  }
  if (typeof c.source === 'string') {
    const isHook = c.type === 'registry:hook'
    const target = isHook ? `hooks/${c.name}.ts` : `components/ui/${c.name}.tsx`
    return [{ path: target, target, type: isHook ? 'registry:hook' : 'registry:component', content: c.source }]
  }
  return []
}

// Components are scoped to a design project — one storage key per project.
// The persistence itself, and the two rules that protect it (cross-project
// write order, and refusing a write that drops records nobody said to drop),
// live in component-store.ts so they can be tested without a host.
async function projectExists(projectId: string): Promise<boolean> {
  return (await readProjects()).some((p) => p.id === projectId)
}

const componentStore = createComponentStore<StoredComponent>({
  storage,
  newId: newComponentId,
  listOtherProjects: async (currentProjectId) =>
    (await readProjects()).filter((p) => p.id !== currentProjectId).map((p) => ({ id: p.id, name: p.name })),
  projectExists,
})

function requireProject(projectId: unknown): string {
  const id = String(projectId ?? '').trim()
  if (!id) {
    throw new Error('No project. Select a project on the Design Kit node, or pass `project` (a design project id).')
  }
  return id
}

// `readComponents`/`writeComponents` are the AUTHORING view: they read
// published with any unpublished work laid over it, and they write the draft.
// What installers are served moves only through a publish. The
// registry routes read published directly (readComponentsViaDb) and so are
// unaffected by any of this.
const { writeComponents } = componentStore

// Publish with a record: the last validation the draft saw returned
// alongside — so the moment of shipping is not silent about a failure the
// last save already knew about. The summary is the draft's, so it is read
// before the publish and attached after it.
async function publishRecorded(
  instance: KitInstance,
  name: string,
  options: { author: string; expectedVersion?: number },
): Promise<Record<string, unknown>> {
  const projectId = instance.instanceId
  const lastValidation = await lastValidationOf(projectId, await componentIdOf(projectId, name))
  const result = await repoStore.publishComponent(instance.dataDir, name, options)
  // A publish moves the draft into published and clears it, so every cached
  // pool is describing a state that no longer exists. Then WARM this
  // component's pool, because a component somebody just published is one
  // somebody is about to look at — the wait belongs here, off the reader's
  // path, and the background build cannot fail this publish.
  invalidatePreviewPools()
  warmPreviewPool(projectId)
  return lastValidation ? { ...result, lastValidation } : { ...result }
}

/**
 * Freeze a project's served targets into its stored ones, once.
 *
 * The values written are exactly what the project was already serving, so no
 * consumer's file moves and no install diffs — the whole point of migrating
 * rather than flipping authority underneath existing installs. What changes
 * is who decides them afterwards.
 *
 * Lazy, like the id backfill it sits beside: a project migrates the first time
 * anything reads it for authoring. A project nobody touches stays unmigrated
 * and keeps composing the category in, which is the same behaviour by a
 * different route.
 */
async function migrateStoredTargets(projectId: string, list: StoredComponent[]): Promise<StoredComponent[]> {
  if (list.every((c) => c.targetsExplicit)) {
    return list
  }
  // componentFiles() is passed in because materialising the legacy
  // single-`source` form is this library's rule, not the target module's.
  const migrated = list.map((c) => withExplicitTargets(c, componentFiles) as StoredComponent)
  await componentStore.writePublished(projectId, migrated)
  return migrated
}

/** Every authoring read: published targets frozen, then the draft laid over. */
async function readComponents(projectId: string): Promise<StoredComponent[]> {
  const published = await migrateStoredTargets(projectId, await componentStore.readPublished(projectId))
  return overlayDraft(published, await componentStore.readDraftOverlay(projectId))
}

/**
 * The authoring read, each record annotated with its draft state — the
 * published version an unpublished draft is ahead of, or 'unpublished' for a
 * component never published. The surfaces outside the editor (doc page,
 * component list) exist to show what an INSTALL gets, and without this a
 * component can sit in draft indefinitely while nothing says the kit serves
 * something older than what the reader is looking at.
 */
async function readComponentsWithDraftState(
  projectId: string,
): Promise<Array<StoredComponent & { draft?: number | 'unpublished'; draftFilesChanged?: string[] }>> {
  const published = await migrateStoredTargets(projectId, await componentStore.readPublished(projectId))
  const overlay = await componentStore.readDraftOverlay(projectId)
  const publishedById = new Map(published.map((c) => [c.id, c]))
  const overlayById = new Map(overlay.map((c) => [c.id, c]))
  return overlayDraft(published, overlay).map((c) => {
    const draft = draftStateFor(publishedById.get(c.id), overlayById.has(c.id))
    if (draft === undefined) {
      return c
    }
    // Both records are already in hand here, so the file-level answer costs the
    // comparison and nothing else — no extra read, and no file content leaves
    // this function: the caller gets keys.
    return { ...c, draft, draftFilesChanged: draftFilesChanged(publishedById.get(c.id), overlayById.get(c.id)) ?? [] }
  })
}

// Wiring only. The rule, and why it is shaped the way it is, live with it in
// server/target.ts — including what `readComponents` has to return here.
function assertTargetsAvailable(component: StoredComponent): Promise<void> {
  return assertTargetsAvailableIn(component, {
    listProjects: readProjects,
    readComponents: async (projectId) =>
      overlayDraft(await componentStore.readPublished(projectId), await componentStore.readDraftOverlay(projectId)),
    normalizeFiles: componentFiles,
  })
}

/**
 * The revision a file action's caller says it read, for the optimistic guard.
 * Passing none leaves the write unguarded.
 */
function fileWriteExpectation(
  current: StoredComponent,
  expectedUpdatedAt?: number,
): { id: string; updatedAt: number } | undefined {
  return typeof expectedUpdatedAt === 'number' ? { id: current.id, updatedAt: expectedUpdatedAt } : undefined
}

// The draft-annotated view rather than the plain one, so a single component
// read carries the same draft facts the list already carried. It costs the
// comparison for whichever components currently hold a draft and nothing for
// the rest, against a second reader that would be a second definition.
async function getComponent(
  projectId: string,
  name: string,
): Promise<(StoredComponent & { draft?: number | 'unpublished'; draftFilesChanged?: string[] }) | null> {
  const list = await readComponentsWithDraftState(projectId)
  return list.find((c) => c.name === name) ?? null
}

/** A `since` from a caller: epoch milliseconds, or anything Date.parse reads. */
function sinceOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value.trim())
    if (!Number.isNaN(t)) {
      return t
    }
  }
  return undefined
}

/**
 * One end of a comparison: a published version number, the working tree, or the
 * empty state before a component's first version.
 *
 * Rejected rather than coerced — a `0`, a `NaN` or a stray string silently
 * becoming "some version" would compare two points the caller never asked for
 * and label the result with them.
 */
function endpointOf(value: unknown, which: string): repoStore.VersionEndpoint {
  if (value === 'draft' || value === 'none') {
    return value
  }
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${which} must be a positive version number, "draft", or "none".`)
  }
  return n
}

/** The App instance behind a project, for reads only a git repository can serve. */
async function repoInstanceFor(projectId: unknown, what: string) {
  const instance = await instanceById(requireProject(projectId as string))
  if (!instance) {
    throw new Error(`${what} needs a repository-backed project.`)
  }
  return instance
}

// ── File operations (batched) ──────────────────────────────
// A component's `files[]` is treated as a small filesystem. Operations are
// batched: read/write take/return arrays, and edit is ALL-OR-NOTHING across the
// whole batch — so a component is never left half-written. Files are matched by
// `target` or `path`.

interface FileEdit {
  path: string
  old: string
  new: string
  replaceAll?: boolean
}

function fileKey(f: StoredFile): string {
  return f.target || f.path
}

function findFileIndex(files: StoredFile[], key: string): number {
  return files.findIndex((f) => f.path === key || f.target === key)
}

async function requireComponent(projectId: string, name: string): Promise<StoredComponent> {
  const comp = await getComponent(projectId, name)
  if (!comp) {
    throw new Error(`Component "${name}" not found in this project.`)
  }
  return comp
}

// Batch read: returns the requested files (all of them when `paths` is empty).
async function readFiles(projectId: string, componentName: string, paths?: string[]): Promise<StoredFile[]> {
  const files = componentFiles(await requireComponent(projectId, componentName))
  if (!paths || paths.length === 0) {
    return files
  }
  return paths.map((p) => files[findFileIndex(files, String(p))]).filter((f): f is StoredFile => Boolean(f))
}

// Batch write (upsert): each entry matched by path/target; added if new. Atomic.
async function writeFiles(
  projectId: string,
  componentName: string,
  inputs: Array<Record<string, unknown>>,
  validate = true,
  expectedUpdatedAt?: number,
): Promise<{ written: number; files: string[]; validation?: ValidateComponentResult }> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('writeFiles: `files` (a non-empty array of { path?, target?, type?, content }) is required.')
  }
  const list = await readComponents(projectId)
  const idx = list.findIndex((c) => c.name === componentName)
  if (idx < 0) {
    throw new Error(`Component "${componentName}" not found in this project.`)
  }
  const files = componentFiles(list[idx]).map((f) => ({ ...f }))
  for (const inp of inputs) {
    const key = String(inp.path ?? inp.target ?? '').trim()
    if (!key) {
      throw new Error('writeFiles: each entry needs a `path` (or `target`).')
    }
    const at = findFileIndex(files, key)
    const nextFile: StoredFile = {
      path: String(inp.path ?? inp.target ?? key),
      // The one composition rule, applied once, here: a flat `components/ui/*`
      // target is placed under the component's category folder; anything that
      // already names a folder is taken as written. What is stored is what will
      // be served, so this is the last moment the category has any say.
      target: categorizedTarget(String(inp.target ?? inp.path ?? key), list[idx].category),
      type: String(inp.type ?? (at >= 0 ? files[at].type : 'registry:component')),
      content: String(inp.content ?? ''),
    }
    if (at >= 0) {
      files[at] = nextFile
    } else {
      files.push(nextFile)
    }
  }
  const expect = fileWriteExpectation(list[idx], expectedUpdatedAt)
  list[idx] = { ...list[idx], files, source: undefined, updatedAt: Date.now() }
  // A file write sets targets, so it is a target change like any other.
  await assertTargetsAvailable(list[idx])
  await writeComponents(projectId, list, { expect })
  // Before the validation below, which builds a pool: bumping after it would
  // have the validator check the source this write just replaced.
  invalidatePreviewPools()
  // Inline diagnostics: so an agent can't miss a preview break it just
  // introduced without opening the preview. Costs a full pool build, which
  // grows with the whole project — hence the opt-out for a caller writing many
  // files in a row that means to validate once at the end.
  return {
    written: inputs.length,
    files: files.map((f) => fileKey(f)),
    validation: validate ? await validateAfterWrite(projectId, componentName) : undefined,
  }
}

// Batch edit (string replace): ALL-OR-NOTHING. If any edit fails to match (or is
// non-unique without replaceAll), nothing is persisted; per-edit results returned.
async function editFiles(
  projectId: string,
  componentName: string,
  edits: FileEdit[],
  validate = true,
  expectedUpdatedAt?: number,
  // `validation` is absent for two distinct reasons, both deliberate: every
  // all-or-nothing failure path below returns before anything is persisted, and
  // there is nothing to validate when nothing changed; or the caller opted out.
): Promise<{
  ok: boolean
  results: Array<{ path: string; applied: boolean; count?: number; error?: string }>
  files: string[]
  validation?: ValidateComponentResult
}> {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('editFiles: `edits` (a non-empty array of { path, old, new, replaceAll? }) is required.')
  }
  const list = await readComponents(projectId)
  const idx = list.findIndex((c) => c.name === componentName)
  if (idx < 0) {
    throw new Error(`Component "${componentName}" not found in this project.`)
  }
  const original = componentFiles(list[idx])
  const draft = original.map((f) => ({ ...f }))
  const results: Array<{ path: string; applied: boolean; count?: number; error?: string }> = []

  for (const e of edits) {
    const key = String(e?.path ?? '').trim()
    const at = findFileIndex(draft, key)
    if (at < 0) {
      results.push({ path: key, applied: false, error: 'file not found' })
      continue
    }
    const oldStr = String(e?.old ?? '')
    if (oldStr === '') {
      results.push({ path: key, applied: false, error: '`old` must be non-empty' })
      continue
    }
    const occurrences = draft[at].content.split(oldStr).length - 1
    if (occurrences === 0) {
      results.push({ path: key, applied: false, error: '`old` string not found' })
      continue
    }
    if (occurrences > 1 && !e.replaceAll) {
      results.push({ path: key, applied: false, error: `\`old\` not unique (${occurrences} matches); set replaceAll` })
      continue
    }
    const newStr = String(e?.new ?? '')
    draft[at].content = e.replaceAll
      ? draft[at].content.split(oldStr).join(newStr)
      : draft[at].content.replace(oldStr, newStr)
    results.push({ path: key, applied: true, count: e.replaceAll ? occurrences : 1 })
  }

  if (results.some((r) => !r.applied)) {
    // All-or-nothing: abort, persist nothing.
    return { ok: false, results, files: original.map((f) => fileKey(f)) }
  }
  const expect = fileWriteExpectation(list[idx], expectedUpdatedAt)
  list[idx] = { ...list[idx], files: draft, source: undefined, updatedAt: Date.now() }
  await writeComponents(projectId, list, { expect })
  // Before the validation below builds a pool — see writeFiles.
  invalidatePreviewPools()
  // Inline diagnostics: so an agent can't miss a preview break it just
  // introduced without opening the preview. See writeFiles for the cost.
  return {
    ok: true,
    results,
    files: draft.map((f) => fileKey(f)),
    validation: validate ? await validateAfterWrite(projectId, componentName) : undefined,
  }
}

// Rename file paths within a component (atomic; never changes content). All-or-nothing.
async function moveFiles(
  projectId: string,
  componentName: string,
  moves: Array<{ from: string; to: string }>,
  expectedUpdatedAt?: number,
): Promise<{
  ok: boolean
  results: Array<{ from: string; to?: string; applied: boolean; error?: string }>
  files: string[]
}> {
  if (!Array.isArray(moves) || moves.length === 0) {
    throw new Error('moveFiles: `moves` (a non-empty array of { from, to }) is required.')
  }
  const list = await readComponents(projectId)
  const idx = list.findIndex((c) => c.name === componentName)
  if (idx < 0) {
    throw new Error(`Component "${componentName}" not found in this project.`)
  }
  const original = componentFiles(list[idx])
  const draft = original.map((f) => ({ ...f }))
  const results: Array<{ from: string; to?: string; applied: boolean; error?: string }> = []
  for (const m of moves) {
    const from = String(m?.from ?? '').trim()
    const to = String(m?.to ?? '').trim()
    const at = findFileIndex(draft, from)
    if (at < 0) {
      results.push({ from, applied: false, error: 'file not found' })
      continue
    }
    if (!to) {
      results.push({ from, applied: false, error: '`to` is required' })
      continue
    }
    if (findFileIndex(draft, to) >= 0) {
      results.push({ from, to, applied: false, error: 'destination already exists' })
      continue
    }
    draft[at] = { ...draft[at], path: to, target: categorizedTarget(to, list[idx].category) }
    results.push({ from, to, applied: true })
  }
  if (results.some((r) => !r.applied)) {
    return { ok: false, results, files: original.map((f) => fileKey(f)) }
  }
  const expect = fileWriteExpectation(list[idx], expectedUpdatedAt)
  list[idx] = { ...list[idx], files: draft, source: undefined, updatedAt: Date.now() }
  // Renaming a file path renames its target, so this is a target change too.
  await assertTargetsAvailable(list[idx])
  await writeComponents(projectId, list, { expect })
  invalidatePreviewPools()
  return { ok: true, results, files: draft.map((f) => fileKey(f)) }
}

// Batch-delete files from a component (matched by path/target). Removes every
// matching file and reports which paths were `deleted` vs `missing`; persists as
// long as at least one file matched. Never touches meta.
async function deleteFiles(
  projectId: string,
  componentName: string,
  paths: string[],
  expectedUpdatedAt?: number,
): Promise<{ deleted: string[]; missing: string[]; remaining: string[] }> {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('deleteFiles: `paths` (a non-empty array of file paths/targets) is required.')
  }
  const list = await readComponents(projectId)
  const idx = list.findIndex((c) => c.name === componentName)
  if (idx < 0) {
    throw new Error(`Component "${componentName}" not found in this project.`)
  }
  const files = componentFiles(list[idx])
  const remove = new Set<number>()
  const deleted: string[] = []
  const missing: string[] = []
  for (const p of paths) {
    const key = String(p ?? '').trim()
    const at = findFileIndex(files, key)
    if (at < 0) {
      missing.push(key)
    } else {
      remove.add(at)
      deleted.push(key)
    }
  }
  const next = files.filter((_, i) => !remove.has(i))
  if (deleted.length > 0) {
    const expect = fileWriteExpectation(list[idx], expectedUpdatedAt)
    list[idx] = { ...list[idx], files: next, source: undefined, updatedAt: Date.now() }
    await writeComponents(projectId, list, { expect })
    invalidatePreviewPools()
  }
  // Report only the paths (deleted / not-found / what remains) — never file
  // contents, which would be useless noise on a delete.
  return { deleted, missing, remaining: next.map((f) => fileKey(f)) }
}

// ── Exports ────────────────────────────────────

// Extension actions (called from the app page via invoke()).
export const actions = {
  'projects.list': listProjects,
  // A Design Kit App instance's project — the app page's first read. The
  // instance IS the project (its repo in its dataDir), so this is its name and
  // what the repo holds; null only when the instance does not exist.
  'app.project': async (input: { instanceId: string }) => {
    const instance = await instanceById(String(input?.instanceId ?? ''))
    if (!instance) {
      return null
    }
    return {
      id: instance.instanceId,
      name: instance.name,
      slug: instance.slug,
      components: (await repoStore.readComponents(instance.dataDir)).length,
      theme: await repoStore.readTheme(instance.dataDir),
    }
  },
  'projects.create': createProject,
  'projects.rename': renameProject,
  'projects.delete': (input: { id: string; confirmName?: string; force?: boolean }) =>
    deleteProject(String(input?.id ?? ''), { confirmName: input?.confirmName, force: input?.force }),
  'projects.setTheme': async (input: { id: string; preset?: string; css?: string }) => {
    const instance = await instanceById(String(input?.id ?? ''))
    if (instance) {
      const presetInput = typeof input?.preset === 'string' ? input.preset.trim() : ''
      if (presetInput && !THEME_PRESETS.some((x) => x.id === presetInput)) {
        throw new Error(
          `setTheme: unknown preset "${presetInput}". Valid ids: ${THEME_PRESETS.map((x) => x.id).join(', ')}.`,
        )
      }
      const { shadcnStyle } = await repoStore.readTheme(instance.dataDir)
      await repoStore.writeTheme(instance.dataDir, {
        preset: presetInput || DEFAULT_PRESET,
        css: typeof input?.css === 'string' && input.css.trim() ? input.css : undefined,
        shadcnStyle,
      })
      return readProjects()
    }
    return setProjectTheme({ id: String(input?.id ?? ''), preset: input?.preset, css: input?.css })
  },
  'projects.setShadcnStyle': async (input: { id: string; style?: string }) => {
    const instance = await instanceById(String(input?.id ?? ''))
    if (instance) {
      await writeShadcnStyle(instance.dataDir, input?.style)
      return readProjects()
    }
    return setProjectShadcnStyle({ id: String(input?.id ?? ''), style: input?.style })
  },
  'themes.list': async () => THEME_PRESETS,
  // The eval-pool closure for a component's isolated preview (its project +
  // cross-project design-kit deps + shadcn primitives). See buildPreviewSources.
  'preview.sources': (input: { projectId: string; component: string }) =>
    buildPreviewSources(requireProject(input?.projectId), String(input?.component ?? '')),
  // The component's dependency graph: provenance-tagged edges, reverse
  // "used by" edges, and every reference that resolves to nothing.
  'graph.get': (input: { projectId: string; component: string }) =>
    buildDependencyGraph(requireProject(input?.projectId), String(input?.component ?? '')),
  // The per-project reads and writes below serve BOTH worlds: given an
  // instanceId they act on the instance's repo (repo-store), else the legacy
  // KV path — so the same editor UI runs pinned to an App instance on the app
  // page; the legacy KV branch stays until that store is retired.
  'components.list': async (projectId: string) => {
    const instance = await instanceById(requireProject(projectId))
    return instance
      ? repoStore.readComponentsWithState(instance.dataDir)
      : readComponentsWithDraftState(requireProject(projectId))
  },
  'components.get': async (input: { projectId: string; name: string }) => {
    const instance = await instanceById(requireProject(input?.projectId))
    return instance
      ? repoStore.getComponentWithState(instance.dataDir, String(input?.name ?? ''))
      : getComponent(requireProject(input?.projectId), String(input?.name ?? ''))
  },
  // Throw the whole draft away and take the component back to what is
  // published — every file, not one, which is why it is a component-level call
  // rather than a path-level one.
  'components.discard': async (input: { projectId: string; name: string }) => {
    const instance = await instanceById(requireProject(input?.projectId))
    if (!instance) {
      // The legacy store keeps drafts as an overlay rather than a working
      // tree, so it has no published state on disk to return a file to. Said
      // plainly rather than answered with a confusing failure from below.
      throw new Error('This project is on the legacy store, which does not keep a draft that can be discarded.')
    }
    const discarded = await repoStore.discardDraft(instance.dataDir, String(input?.name ?? ''))
    // Throwing the draft away changes the effective sources exactly as much as
    // writing it did — the pool reads draft-first.
    invalidatePreviewPools()
    return discarded
  },
  // The last validation a component's draft saw — what the editor shows at the
  // moment of publish, warn-and-continue, after a reload has emptied its own
  // state. Null when no check has run against this draft yet.
  'validation.last': async (input: { projectId: string; component: string }) => {
    const projectId = requireProject(input?.projectId)
    return (await lastValidationOf(projectId, await componentIdOf(projectId, String(input?.component ?? '')))) ?? null
  },
  'components.revisions': async (input: { projectId: string; name: string }) => {
    const instance = await instanceById(requireProject(input?.projectId))
    return instance
      ? repoStore.listRevisions(instance.dataDir, String(input?.name ?? ''))
      : componentStore.listRevisions(requireProject(input?.projectId), String(input?.name ?? ''))
  },
  'components.changesSince': (input: {
    projectId: string
    since?: number | string
    sinceVersions?: Record<string, number>
  }) =>
    componentStore.changesSince(requireProject(input?.projectId), {
      since: sinceOf(input?.since),
      sinceVersions: input?.sinceVersions,
    }),
  // Draft file read/write/edit for the source editor — the same draft-targeted,
  // staleness-guarded semantics on either backend. The writes are admin (see
  // `actionAccess` below); core enforces that at the request-facing
  // dispatcher. files.read rides the signed-in session gate.
  'files.read': async (input: { projectId: string; component: string; paths?: string[] }) => {
    const instance = await instanceById(requireProject(input?.projectId))
    if (instance) {
      const c = await repoStore.readComponent(instance.dataDir, String(input?.component ?? ''))
      if (!c) {
        throw new Error(`Component "${String(input?.component ?? '')}" does not exist.`)
      }
      const want = input?.paths
      const files = want?.length ? c.files.filter((f) => want.includes(f.target) || want.includes(f.path)) : c.files
      return files.map((f) => ({ path: f.path, target: f.target, type: f.type, content: f.content }))
    }
    return readFiles(requireProject(input?.projectId), String(input?.component ?? ''), input?.paths)
  },
  // The read behind the history timeline. It needs a repository-backed project:
  // file content at a past version lives in that version's tag, and the legacy
  // KV store holds no equivalent — so it says so rather than answering from the
  // draft, which would be today's code under a historical label.
  'files.compareVersions': async (input: {
    projectId: string
    component: string
    from: repoStore.VersionEndpoint
    to: repoStore.VersionEndpoint
  }) => {
    const instance = await repoInstanceFor(input?.projectId, 'Comparing two versions')
    return repoStore.compareComponentVersions(
      instance.dataDir,
      String(input?.component ?? ''),
      endpointOf(input?.from, 'from'),
      endpointOf(input?.to, 'to'),
    )
  },
  // The freshness guard below reaches only the instance arm. The legacy store
  // guards with its own numeric revision, which this surface does not carry —
  // stated rather than left to be noticed.
  'files.write': async (input: {
    projectId: string
    component: string
    files: Array<Record<string, unknown>>
    validate?: boolean
    expectedState?: string
  }) => {
    const projectId = requireProject(input?.projectId)
    const instance = await instanceById(projectId)
    if (instance) {
      const component = String(input?.component ?? '')
      await repoStore.writeFiles(
        instance.dataDir,
        component,
        (input?.files ?? []) as Array<{ path?: string; target?: string; type?: string; content: string }>,
        input?.expectedState,
      )
      // Before the validation below, which builds a pool.
      invalidatePreviewPools()
      const result: Record<string, unknown> = { written: (input?.files ?? []).length }
      if (input?.validate !== false) {
        result.validation = await validateAfterWrite(projectId, component)
      }
      return result
    }
    return writeFiles(projectId, String(input?.component ?? ''), input?.files ?? [], input?.validate !== false)
  },
  'files.edit': async (input: {
    projectId: string
    component: string
    edits: FileEdit[]
    validate?: boolean
    expectedState?: string
  }) => {
    const projectId = requireProject(input?.projectId)
    const instance = await instanceById(projectId)
    if (instance) {
      const component = String(input?.component ?? '')
      const applied = await repoStore.editFiles(instance.dataDir, component, input?.edits ?? [], input?.expectedState)
      // Before the validation below, which builds a pool.
      invalidatePreviewPools()
      const result: Record<string, unknown> = { ...applied }
      if (input?.validate !== false) {
        result.validation = await validateAfterWrite(projectId, component)
      }
      return result
    }
    return editFiles(projectId, String(input?.component ?? ''), input?.edits ?? [], input?.validate !== false)
  },
  // The legacy arms of these two invalidate inside moveFiles/deleteFiles, where
  // they persist; the instance arms have no such helper of their own, so they
  // bump here — the write has already happened either way.
  'files.move': async (input: {
    projectId: string
    component: string
    moves: Array<{ from: string; to: string }>
    expectedState?: string
  }) => {
    const instance = await instanceById(requireProject(input?.projectId))
    if (!instance) {
      return moveFiles(requireProject(input?.projectId), String(input?.component ?? ''), input?.moves ?? [])
    }
    const moved = await repoStore.moveFiles(
      instance.dataDir,
      String(input?.component ?? ''),
      input?.moves ?? [],
      input?.expectedState,
    )
    invalidatePreviewPools()
    return moved
  },
  'files.delete': async (input: { projectId: string; component: string; paths: string[]; expectedState?: string }) => {
    const instance = await instanceById(requireProject(input?.projectId))
    if (!instance) {
      return deleteFiles(requireProject(input?.projectId), String(input?.component ?? ''), input?.paths ?? [])
    }
    const deleted = await repoStore.deleteFiles(
      instance.dataDir,
      String(input?.component ?? ''),
      input?.paths ?? [],
      input?.expectedState,
    )
    invalidatePreviewPools()
    return deleted
  },
}

// Per-action authorization, read by core at the request-facing dispatcher. The
// dashboard file WRITES are admin — editing a component's draft source is an
// administrator action, not something any signed-in viewer may do — while
// everything unlisted (files.read included) stays signed-in.
export const actionAccess = {
  'files.write': 'admin',
  'files.edit': 'admin',
  'files.move': 'admin',
  'files.delete': 'admin',
} as const

// ── Design Kit App actions (app_call) ────────────────────
// The component/file/theme/validate surface, served from the instance's OWN
// git repo (server/repo-store.ts): the working tree is the draft, HEAD is
// published, a publish is one commit plus the component's version tag. No
// `project` parameter and no project CRUD — the instance IS the project. The
// preview, validation and dependency-graph pipeline reach the repo through
// the unified readers below, addressed by the instanceId. The KV store keeps
// its legacy surface until it is retired; comments are not part of this
// surface.
const onRepo =
  <R>(
    run: (dir: string, params: Record<string, unknown>, instance: KitInstance, ctx: AppActionContext) => Promise<R> | R,
  ) =>
  async (ctx: AppActionContext, params: Record<string, unknown>): Promise<R> => {
    const instance = await instanceById(ctx.instanceId)
    if (!instance) {
      throw new Error('Unknown Design Kit instance.')
    }
    assertNotLegacyRevision(params)
    return run(instance.dataDir, params, instance, ctx)
  }

/**
 * Refuse a call that names the legacy `expectedUpdatedAt` parameter.
 *
 * Not compatibility machinery — the opposite. That numeric revision is a
 * last-modified stamp, and the repo-backed record carries none, so there is
 * nothing a number could be compared against; "accepting" one could only mean
 * choosing which way to fail. What this prevents is the quiet failure: a
 * caller that passes that name and has it ignored gets an UNGUARDED write
 * while believing it asked to be guarded. Refusing fails closed and says what
 * to do instead.
 */
function assertNotLegacyRevision(params: Record<string, unknown>): void {
  if (params?.expectedUpdatedAt !== undefined) {
    throw new Error(
      '`expectedUpdatedAt` was replaced by `expectedState`. Re-read the component and pass back the `state` it returns — the numeric revision no longer exists, so it cannot be checked and this call was not guarded.',
    )
  }
}

/**
 * The state a caller says its write was based on.
 *
 * Absent means no guard was asked for, and that is the ONLY thing that may
 * mean it. An empty string is a value the caller supplied — `?? ''` on a field
 * it did not find, a default that survived a round trip — and treating it as
 * absent hands back an unguarded write to somebody who believes they asked to
 * be guarded. That is the same failure the refusal below this one exists to
 * prevent, and it is the likelier one: it needs an idiom rather than a caller.
 * Every supplied string reaches the guard, which is where a value that cannot
 * be a state gets its own answer.
 */
const appParamState = (params: Record<string, unknown>): string | undefined =>
  typeof params?.expectedState === 'string' ? params.expectedState : undefined

/**
 * Meta without file contents — what list/read hand back.
 *
 * No last-modified time: nothing in this extension renders one, every time the
 * interface shows comes from a version's `publishedAt`, and the component's own
 * state is carried by `state` on the full read a caller makes before writing.
 */
function summarize(c: repoStore.StoredComponent) {
  return {
    name: c.name,
    title: c.title,
    type: c.type,
    category: c.category,
    description: c.description,
    version: c.version,
  }
}

async function requireRepoComponent(dir: string, name: string): Promise<repoStore.StoredComponent> {
  const c = await repoStore.readComponent(dir, name)
  if (!c) {
    throw new Error(`Component "${name}" does not exist.`)
  }
  return c
}

// What readTheme / setTheme / setShadcnStyle hand back: the saved theme, the
// EFFECTIVE shadcn style (the default when none is saved) and the CSS previews
// render with.
function themeView(theme: repoStore.ProjectTheme) {
  return {
    preset: theme.preset,
    css: theme.css,
    shadcnStyle: effectiveShadcnStyle(theme.shadcnStyle),
    resolvedCss: resolveThemeCss(theme),
  }
}

// Set the style `@/components/ui/*` resolves against in this project's
// previews (server/shadcn-style.ts). Empty/absent goes back to the default.
// Stored beside the preset in the theme file, because it is read at the same
// two places the theme is — the preview shell and the pool build — and it is
// equally a property of how the project is previewed, not of any component.
async function writeShadcnStyle(dir: string, input: unknown): Promise<repoStore.ProjectTheme> {
  const style = parseShadcnStyle(input)
  const theme = { ...(await repoStore.readTheme(dir)), shadcnStyle: style }
  await repoStore.writeTheme(dir, theme)
  // Every pool built before this resolved its shadcn primitives in the old
  // style — this project's, and any other project's that pulls from it only
  // through its own style, so the global bump is the precise one too.
  invalidatePreviewPools()
  return theme
}

export const instanceActions = {
  listComponents: onRepo(async (dir) => (await repoStore.readComponents(dir)).map(summarize)),
  readComponent: onRepo(async (dir, p) => {
    const c = await requireRepoComponent(dir, String(p.name ?? ''))
    const { files, ...meta } = c
    return p.listFiles ? { ...meta, files: files.map((f) => f.target) } : meta
  }),
  writeComponent: onRepo(async (dir, p) => {
    const name = String(p.name ?? '').trim()
    const exportName = String(p.exportName ?? '').trim()
    if (!name || !exportName) {
      throw new Error('writeComponent: `name` and `exportName` are required.')
    }
    const { expectedState: _e, ...input } = p
    const written = await repoStore.writeComponent(
      dir,
      { ...(input as Partial<repoStore.StoredComponent>), name, exportName },
      appParamState(p),
    )
    invalidatePreviewPools()
    return summarize(written)
  }),
  editComponent: onRepo(async (dir, p) => {
    const { name, expectedState: _e, ...patch } = p
    const edited = await repoStore.editComponent(
      dir,
      String(name ?? ''),
      patch as Partial<repoStore.StoredComponent>,
      appParamState(p),
    )
    invalidatePreviewPools()
    return summarize(edited)
  }),
  deleteComponent: onRepo(async (dir, p, _instance, ctx) => {
    const deleted = await repoStore.deleteComponent(dir, String(p.name ?? ''), committerOf(ctx))
    invalidatePreviewPools()
    return deleted
  }),
  moveComponent: onRepo(async (dir, p, instance, ctx) => {
    const name = String(p.name ?? '')
    const toName = typeof p.toName === 'string' && p.toName.trim() ? p.toName.trim() : undefined
    const toProject = typeof p.toProject === 'string' && p.toProject.trim() ? p.toProject.trim() : undefined
    if (!toProject) {
      if (!toName) {
        throw new Error('moveComponent: pass toName and/or toProject.')
      }
      const renamed = await repoStore.renameComponent(dir, name, toName)
      invalidatePreviewPools()
      return summarize(renamed)
    }
    // Across projects is across repos: publish into the destination, then a
    // delete-commit here — so the departure is a visible commit in this
    // repo's history and diff, by construction, never a silent absence.
    const dest = (await designKitInstances()).find(
      (i) => i.slug === toProject || i.instanceId === toProject || i.name === toProject,
    )
    if (!dest) {
      throw new Error(
        `moveComponent: destination "${toProject}" is not a Design Kit app instance. Create the destination app first — its slug becomes the namespace.`,
      )
    }
    if (dest.instanceId === instance.instanceId) {
      throw new Error('moveComponent: the destination is this project.')
    }
    const comp = await requireRepoComponent(dir, name)
    const finalName = toName ?? name
    // Both commits of the move, the arrival and the departure, are the mover's.
    const author = committerOf(ctx)
    await repoStore.writeComponent(dest.dataDir, { ...comp, name: finalName, files: [] })
    await repoStore.writeFiles(dest.dataDir, finalName, comp.files)
    await repoStore.publishComponent(dest.dataDir, finalName, { author })
    // The arrival already counts, even if the departure below fails: every pool
    // built before this moment is missing a component that now exists. Warmed
    // in the destination for the same reason any publish is.
    invalidatePreviewPools()
    warmPreviewPool(dest.instanceId)
    try {
      // The departure is an ordinary delete carrying the move's message. A
      // delete commits, so the departure is a visible commit in this repo's
      // history and diff by construction rather than as a feature of the move.
      const departure = await repoStore.deleteComponent(dir, name, author, `Move ${name} to ${dest.slug}`)
      if (!departure.deleted) {
        throw new Error(`Component "${name}" does not exist.`)
      }
      invalidatePreviewPools()
    } catch (err) {
      // The arrival already happened; a failure HERE means the component is in
      // two projects at once, and a retry would make that worse, not better.
      // Say exactly which state the caller is in.
      const cause = err instanceof Error ? err.message : String(err)
      throw new Error(
        `moveComponent: "${finalName}" is now published in ${dest.spaceSlug}.${dest.slug}, but the departure commit in this project failed: ${cause}. Until that commit lands, this project's published head STILL SERVES "${name}" — the component exists in two projects. Do not retry the move; fix this project's repository state (commit or discard the staged removal).`,
      )
    }
    return { moved: name, to: `${dest.spaceSlug}.${dest.slug}`, as: finalName }
  }),
  // The App's own editor publishes through this action too, so a person's
  // publish and an agent's are one path, each committed under its caller.
  publishComponent: onRepo((_dir, p, instance, ctx) =>
    publishRecorded(instance, String(p.name ?? ''), {
      author: committerOf(ctx),
      expectedVersion: typeof p.expectedVersion === 'number' ? p.expectedVersion : undefined,
    }),
  ),
  listRevisions: onRepo((dir, p) => repoStore.listRevisions(dir, String(p.name ?? ''))),
  // The two reads behind the history timeline, exposed at the same layer as
  // listRevisions: a version's own files, and the comparison between two
  // points. Each end is a version number, "draft", or "none".
  readVersion: onRepo((dir, p) =>
    repoStore.readComponentAtEndpoint(dir, String(p.name ?? ''), endpointOf(p.version, 'version')),
  ),
  compareVersions: onRepo((dir, p) =>
    repoStore.compareComponentVersions(dir, String(p.name ?? ''), endpointOf(p.from, 'from'), endpointOf(p.to, 'to')),
  ),
  changesSince: onRepo(async (dir, p) => {
    const sinceVersions = p.sinceVersions as Record<string, number> | undefined
    if (sinceVersions && Object.keys(sinceVersions).length > 0) {
      const out: Record<string, repoStore.ChangesSince> = {}
      for (const [name, v] of Object.entries(sinceVersions)) {
        out[name] = await repoStore.changesSince(dir, name, Number(v))
      }
      return out
    }
    if (p.since !== undefined) {
      return repoStore.changedSinceDate(dir, p.since as string | number)
    }
    throw new Error('changesSince: pass exactly one of `since` or `sinceVersions`.')
  }),
  getDependencyGraph: onRepo((_dir, p, instance) => buildDependencyGraph(instance.instanceId, String(p.name ?? ''))),
  readTheme: onRepo(async (dir) => themeView(await repoStore.readTheme(dir))),
  setTheme: onRepo(async (dir, p) => {
    const presetInput = typeof p.preset === 'string' ? p.preset.trim() : ''
    if (presetInput && !THEME_PRESETS.some((x) => x.id === presetInput)) {
      throw new Error(
        `setTheme: unknown preset "${presetInput}". Valid ids: ${THEME_PRESETS.map((x) => x.id).join(', ')}.`,
      )
    }
    // shadcnStyle is carried over, not reset: it has its own action, and a
    // theme edit must not quietly move the project back to new-york-v4.
    const { shadcnStyle } = await repoStore.readTheme(dir)
    const theme = {
      preset: presetInput || DEFAULT_PRESET,
      css: typeof p.css === 'string' && p.css.trim() ? p.css : undefined,
      shadcnStyle,
    }
    await repoStore.writeTheme(dir, theme)
    return themeView(theme)
  }),
  setShadcnStyle: onRepo(async (dir, p) => themeView(await writeShadcnStyle(dir, p.style))),
  listThemePresets: () => THEME_PRESETS,
  listShadcnStyles: () => SHADCN_STYLES.map((id) => ({ id, default: id === DEFAULT_SHADCN_STYLE })),
  readFiles: onRepo(async (dir, p) => {
    const c = await requireRepoComponent(dir, String(p.component ?? ''))
    const want = p.paths as string[] | undefined
    const files = want?.length ? c.files.filter((f) => want.includes(f.target) || want.includes(f.path)) : c.files
    return files.map((f) => ({ path: f.path, target: f.target, type: f.type, content: f.content }))
  }),
  writeFiles: onRepo(async (dir, p, instance) => {
    const component = String(p.component ?? '')
    const files = (p.files as Array<{ path?: string; target?: string; type?: string; content: string }>) ?? []
    await repoStore.writeFiles(dir, component, files, appParamState(p))
    // Before the validation below, which builds a pool.
    invalidatePreviewPools()
    const result: Record<string, unknown> = { written: files.length }
    if (p.validate !== false) {
      // The reported shape is this surface's own (see the header above); what
      // the write also leaves behind is the record the editor's publish reads,
      // so a draft an agent last touched is not published under an older verdict.
      result.validation = await validateAndRecord(instance.instanceId, component)
    }
    return result
  }),
  editFiles: onRepo(async (dir, p, instance) => {
    const component = String(p.component ?? '')
    const applied = await repoStore.editFiles(
      dir,
      component,
      (p.edits as Array<{ path: string; old: string; new: string; replaceAll?: boolean }>) ?? [],
      appParamState(p),
    )
    // Before the validation below, which builds a pool.
    invalidatePreviewPools()
    const result: Record<string, unknown> = { ...applied }
    if (p.validate !== false) {
      result.validation = await validateAndRecord(instance.instanceId, component)
    }
    return result
  }),
  moveFiles: onRepo(async (dir, p) => {
    const moved = await repoStore.moveFiles(
      dir,
      String(p.component ?? ''),
      (p.moves as Array<{ from: string; to: string }>) ?? [],
      appParamState(p),
    )
    invalidatePreviewPools()
    return moved
  }),
  deleteFiles: onRepo(async (dir, p) => {
    const deleted = await repoStore.deleteFiles(
      dir,
      String(p.component ?? ''),
      (p.paths as string[]) ?? [],
      appParamState(p),
    )
    invalidatePreviewPools()
    return deleted
  }),
  glob: onRepo(async (dir, p) => {
    const matches = await repoStore.globFiles(dir, String(p.pattern ?? '*'))
    const owners = await repoStore.fileOwners(dir)
    const component = typeof p.component === 'string' && p.component ? p.component : undefined
    const scoped = component ? matches.filter((m) => owners.get(m) === component) : matches
    return scoped.map((path) => ({ component: owners.get(path), path }))
  }),
  grep: onRepo(async (dir, p) => {
    const rows = await repoStore.grepFiles(dir, String(p.pattern ?? ''), p.flags as string | undefined)
    const owners = await repoStore.fileOwners(dir)
    const component = typeof p.component === 'string' && p.component ? p.component : undefined
    const scoped = component ? rows.filter((r) => owners.get(r.path) === component) : rows
    return scoped.map((r) => ({ component: owners.get(r.path), path: r.path, line: r.line, text: r.text }))
  }),
  validateComponent: onRepo((_dir, p, instance) =>
    validateComponent(instance.instanceId, p.name as string | undefined),
  ),
}

// The Design Kit App (server/design-kit-app.ts): one instance = one design
// project, stored as the repo the actions above operate on. The host
// dispatches the lifecycle hooks; the action surface goes in as an explicit
// dependency, so the app module stays free of the store's internals.
export const apps = createDesignKitApp({ boundActions: instanceActions })

// ── shadcn registry over HTTP ────────────────────────
// Served under the extension's own HTTP route, routeUrl('<key>'). The
// dispatcher matches route keys EXACTLY (no path params), so the component
// comes from the query string, as one `component=<project>.<name>` reference
// (a `/` in place of the `.` reads the same — see
// src/registry/component-ref.ts). A design project is a registry; configure it
// in a consumer's components.json:
//   "@design-kit": "https://<host><routeUrl('registry')>?project=<id>&name={name}"
// then: npx shadcn@latest add @design-kit/<name>
// That template keeps the separate `project`/`name` pair, because the `{name}`
// a client substitutes has to be a whole query value of its own.

// `targetPath`, `categorizedTarget` and `servedTarget` live in server/target.ts
// — host-free, so the property the target migration rests on (migrating a
// component moves no served path) can be exercised directly rather than argued.

// Where every design-kit file `comp`'s served content might import actually
// lands — keyed by component name for the alias form, and by stored path for a
// relative one. The rewrite itself is in server/target.ts; this is the lookup
// it needs. Imports of plain shadcn components that aren't stored in the design
// kit (e.g. `@/components/ui/dialog`) have no entry and are left alone.
// Resolution order: the component's own project first (siblings share a
// project without needing a registryDependencies entry), then components
// reachable via its registryDependencies (`@ns/name`, resolved to a project by
// namespace).
async function importTargetMap(
  projectId: string,
  ns: string,
  comp: StoredComponent,
  projects: Array<{ id: string; name: string }>,
): Promise<ImportTargets> {
  const map: ImportTargets = { byName: {}, byStoredPath: {} }
  const add = (c: StoredComponent): void => {
    for (const f of componentFiles(c).filter((x) => x.type !== 'registry:ignore')) {
      const served = servedTarget(f, c)
      // A component is named by ONE alias, its own name, so the entry point is
      // its first installable file. Every file is reachable relatively, though,
      // which is why the two maps are not the same shape.
      map.byName[c.name] ??= served
      map.byStoredPath[String(f.target || f.path).replace(/\.[a-z]+$/i, '')] = served
    }
  }
  for (const s of await readComponentsViaDb(projectId)) {
    add(s)
  }
  for (const dep of comp.registryDependencies ?? []) {
    const parsed = parseDep(dep, ns)
    if (!parsed || map.byName[parsed.name]) {
      continue
    }
    const target = await findProjectByNamespace(parsed.ns, projects)
    if (!target) {
      continue
    }
    const depComp = await getComponentViaDb(target.id, parsed.name)
    if (depComp) {
      add(depComp)
    }
  }
  return map
}

// `stripDirective` serves the files without a leading 'use client', for a
// consumer that is not RSC — see server/client-directive.ts for why the CLI
// cannot be left to do it.
function registryItem(c: StoredComponent, targets: ImportTargets, stripDirective: boolean): Record<string, unknown> {
  return {
    $schema: 'https://ui.shadcn.com/schema/registry-item.json',
    name: c.name,
    type: c.type,
    title: c.title,
    description: c.description,
    dependencies: c.dependencies ?? [],
    registryDependencies: c.registryDependencies ?? [],
    ...changeSignals(c),
    files: componentFiles(c)
      .filter((f) => f.type !== 'registry:ignore')
      .map((f) => {
        const content = rewriteComponentImports(
          f.content,
          { stored: String(f.target || f.path), served: servedTarget(f, c) },
          targets,
        )
        return {
          path: f.path,
          target: servedTarget(f, c),
          type: f.type,
          content: stripDirective ? stripClientDirective(content) : content,
        }
      }),
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  })
}

// ── Design Kit App instances: repo-backed projects ────────
// An App instance IS a project — its git repo in its dataDir is the store
// (server/repo-store.ts). Everywhere below that takes a "project id", an
// instanceId is a valid one: these three readers dispatch on it, so the
// preview, validation, dependency-graph and registry layers serve repo-backed
// projects through the same code path that serves the legacy KV ones, until
// the migration empties the latter.
interface KitInstance {
  instanceId: string
  slug: string
  name: string
  spaceSlug: string
  dataDir: string
}

async function designKitInstances(): Promise<KitInstance[]> {
  try {
    return await hostApps.listInstances('design-kit')
  } catch {
    return []
  }
}

async function instanceById(id: string): Promise<KitInstance | undefined> {
  return (await designKitInstances()).find((i) => i.instanceId === id)
}

async function readComponentsViaDb(projectId: string): Promise<StoredComponent[]> {
  const instance = await instanceById(projectId)
  if (instance) {
    return await repoStore.readComponentsPublished(instance.dataDir)
  }
  const list = await storage.get<StoredComponent[]>(componentsKey(projectId))
  return Array.isArray(list) ? list : []
}

async function getComponentViaDb(projectId: string, name: string): Promise<StoredComponent | null> {
  return (await readComponentsViaDb(projectId)).find((c) => c.name === name) ?? null
}

/**
 * The authoring view, read the same request-free way.
 *
 * The registry routes must keep serving published, so they stay on
 * readComponentsViaDb. Everything that exists to help someone WORK on a
 * component — the preview and the validator — reads this instead, or it would
 * quietly report on the published copy while the author looks at their draft.
 */
async function readEffectiveViaDb(projectId: string): Promise<StoredComponent[]> {
  const instance = await instanceById(projectId)
  if (instance) {
    // The working tree IS the draft-first view: uncommitted edits over HEAD.
    return await repoStore.readComponents(instance.dataDir)
  }
  const published = await storage.get<StoredComponent[]>(componentsKey(projectId))
  const draft = await storage.get<StoredComponent[]>(draftKey(projectId))
  return overlayDraft(Array.isArray(published) ? published : [], Array.isArray(draft) ? draft : [])
}

// Each project is its own registry namespace, derived from its (slugified)
// name, so a component installs as `@<project-slug>/<name>`. `slugify` itself
// lives with the target composition it feeds, in server/target.ts.

async function readProjectsViaDb(): Promise<Array<{ id: string; name: string; slug?: string; theme?: ProjectTheme }>> {
  const list = await storage.get<Array<{ id: string; name: string; theme?: ProjectTheme }>>(PROJECTS_KEY)
  const legacy = Array.isArray(list) ? list : []
  // App instances are projects too: their id is the instanceId. Their namespace
  // is their SLUG, and it is carried here rather than re-derived downstream.
  //
  // slugify(instance name) is no substitute: that it equals the slug is
  // asserted when an instance is added and never again. A rename is the
  // HOST's: it changes the display name and correctly leaves the slug alone,
  // so this extension is never consulted and the equality simply stops
  // holding. Every reader that slugified the name would get a namespace the
  // project does not answer to, and they would agree with each other, so it
  // would read as working. A legacy row has no slug of its own and its
  // namespace genuinely is its name slugified; that is the only case the
  // fallback is for.
  //
  // Cross-project references resolve across both worlds, and the preview shell
  // reads an instance's theme from its repo the same way it reads a legacy
  // project's off its row.
  const instances = await designKitInstances()
  const rows: Array<{ id: string; name: string; slug?: string; theme?: ProjectTheme }> = [...legacy]
  for (const i of instances) {
    const theme = await repoStore.readTheme(i.dataDir)
    rows.push({
      id: i.instanceId,
      name: i.name,
      slug: i.slug,
      theme: theme.preset || theme.css || theme.shadcnStyle ? theme : undefined,
    })
  }
  return rows
}

// Resolve a `project` query param that is either a project id OR its slug, to
// the storage id + the namespace (slug). So registry URLs can use the slug.
// Legacy-id aliases: when a project migrates, its KV record is deleted but
// the `?project=<id>` URLs baked into consumers' components.json across
// repositories are forever. This map carries each retired project id to the
// instance that owns its data now, written by the migration BEFORE the delete
// so there is no window where neither form resolves. It BELONGS TO THE ROUTES
// — a translation table for retired addresses, not project data — which is
// why it stays in the KV store permanently and must never be "cleaned up" as
// leftover store content.
const PROJECT_ALIASES_KEY = 'project-aliases'

async function readAliasesViaDb(): Promise<Record<string, string>> {
  const map = await storage.get<Record<string, string>>(PROJECT_ALIASES_KEY)
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {}
}

// Resolve a `?project=` value to a project id and the namespace it serves
// under. The precedence, and why the legacy name match passes over any row
// carrying a slug, live with the rule in server/project-resolution.ts — kept
// free of the host so the renamed-project case can be exercised at all, which
// no environment can do. What stays here is the wiring, and the readers stay
// functions so a step that is never reached is never paid for.
async function resolveProject(param: string): Promise<{ id: string; ns: string }> {
  return resolveProjectRef(param, {
    instances: designKitInstances,
    aliases: readAliasesViaDb,
    projects: readProjectsViaDb,
  })
}

// A route that acts on one component takes it as a single `component`
// reference; one that needs only the project takes either half-form. Both
// readers, and the precedence they share, live with the grammar in
// src/registry/component-ref.ts.
const MISSING_COMPONENT = 'Missing component. Pass `component=<project>.<name>` — a `/` works in place of the `.`.'
const MISSING_PROJECT = 'Missing project. Pass `project=<id-or-namespace>`.'

// Rescope intra-project deps (`@design-kit/x`, the canonical self-scope) to the
// project's namespace; bare names (shadcn defaults) and other scopes are kept.
function rescope(deps: unknown, ns: string): string[] {
  return (Array.isArray(deps) ? deps : []).map((d) =>
    typeof d === 'string' && d.startsWith(SELF_SCOPE_PREFIX)
      ? `@${ns}/${d.slice(SELF_SCOPE_PREFIX.length)}`
      : String(d),
  )
}

// GET /http/registry?component=<project>.<name> — a single shadcn registry item.
async function registryItemRoute(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const ref = componentRefFromQuery(url)
  if (!ref) {
    return json({ error: MISSING_COMPONENT }, 400)
  }
  // A client resolving a whole namespace has only this route's template to work
  // with, so it asks here for the reserved name and expects the index. Answered
  // by delegating rather than by rebuilding the payload, so the index has one
  // definition however it is reached.
  if (isIndexRequest(ref.name)) {
    return registryIndexRoute(req)
  }
  const { id, ns } = await resolveProject(ref.project)
  const comp = await getComponentViaDb(id, ref.name)
  if (!comp) {
    return json({ error: `Component "${ref.name}" not found in project ${ref.project}.` }, 404)
  }
  const item = registryItem(
    comp,
    await importTargetMap(id, ns, comp, await readProjectsViaDb()),
    stripsClientDirective(url),
  )
  item.registryDependencies = rescope(item.registryDependencies, ns)
  return json(item)
}

// GET /http/all?project=<id> — an aggregate item pulling in every component.
async function registryAllRoute(req: Request): Promise<Response> {
  const project = projectFromQuery(new URL(req.url))
  if (!project) {
    return json({ error: MISSING_PROJECT }, 400)
  }
  const { id, ns } = await resolveProject(project)
  const list = await readComponentsViaDb(id)
  return json({
    $schema: 'https://ui.shadcn.com/schema/registry-item.json',
    name: 'all',
    type: 'registry:registry',
    title: 'All components',
    registryDependencies: list.map((c) => `@${ns}/${c.name}`),
    files: [],
  })
}

// GET /http/index?project=<id> — the registry index (item summaries).
async function registryIndexRoute(req: Request): Promise<Response> {
  // Reached directly, and by delegation from the item route when a client asks
  // it for the reserved index name — so the project is read from whichever of
  // the two forms that client addressed the item with.
  const project = projectFromQuery(new URL(req.url))
  if (!project) {
    return json({ error: MISSING_PROJECT }, 400)
  }
  const { id } = await resolveProject(project)
  const list = await readComponentsViaDb(id)
  return json({
    $schema: 'https://ui.shadcn.com/schema/registry.json',
    name: 'design-kit',
    homepage: '',
    items: list.map((c) =>
      shapeIndexItem(
        c,
        componentFiles(c)
          .filter((f) => f.type !== 'registry:ignore')
          .map((f) => ({ path: f.path, target: servedTarget(f, c), type: f.type })),
      ),
    ),
  })
}

// GET /http/projects — every design project in this library, with the
// namespace each installs under. Read-only, and the only route that answers
// "which libraries exist"; every other route needs a project chosen already.
// A consumer checking whether an installed component still has an original
// needs it, because looking only where the component was last known to live
// reports a move as a disappearance.
async function projectsRoute(): Promise<Response> {
  return json(shapeProjects(await readProjectsViaDb(), namespaceOf))
}

// ── Cross-project install script (curl|npx-style) ────────────
// GET /http/install?component=<project>.<name> returns a tiny npm package
// tarball (not JSON) whose bin script: reads the caller's components.json,
// registers whatever design-kit project namespaces the component's
// registryDependencies graph touches (skipping any that conflict with a
// different existing URL), runs the real `shadcn add`, then removes only the
// registries it added. So `npx <this-url>` is the full one-line install even
// when the component depends on components from other design-kit projects —
// same-project sibling deps need this too, since shadcn has no notion of
// "current registry" when the top-level item was fetched by a raw URL.

// `@design-kit/x` is the self-scope placeholder (see rescope()); any other
// `@ns/x` is a literal cross-project reference. A bare name (no `@`) is an
// external default-registry dependency (e.g. shadcn's own `button`) — not ours.
// One parser for every reader of the reference vocabulary — the walks below
// and the dependency graph — imported as parseDep.

// Only resolves namespaces that match one of THIS design-kit's own projects —
// an unrecognised `@ns` is some other registry entirely, outside our scope.
//
// Matched against the namespace a project actually PUBLISHES under, which is
// its slug wherever it has one. Matching a slugified display name instead
// fails the wrong way round for a renamed project: the canonical spelling —
// the one the registry serves and the one we tell people to write — would be
// the spelling that did not resolve, and an unresolved reference is skipped
// here as another registry's rather than reported, so it would go quiet.
async function findProjectByNamespace(
  ns: string,
  projects: Array<{ id: string; name: string; slug?: string }>,
): Promise<{ id: string; ns: string } | null> {
  const p = projects.find((x) => namespaceOf(x) === ns)
  return p ? { id: p.id, ns } : null
}

// Walk registryDependencies from (projectId, ns, name), following any
// reference that resolves to one of our own projects, and collect every
// namespace touched — including the start project's own.
async function collectNamespaces(projectId: string, ns: string, name: string): Promise<Set<string>> {
  const projects = await readProjectsViaDb()
  const visited = new Set<string>()
  const namespaces = new Set<string>()

  async function walk(pid: string, pns: string, cname: string): Promise<void> {
    const key = `${pid}:${cname}`
    if (visited.has(key)) {
      return
    }
    visited.add(key)
    namespaces.add(pns)
    const comp = await getComponentViaDb(pid, cname)
    if (!comp) {
      return
    }
    for (const dep of comp.registryDependencies ?? []) {
      const parsed = parseDep(dep, pns)
      if (!parsed) {
        continue
      }
      const target = await findProjectByNamespace(parsed.ns, projects)
      if (!target) {
        continue
      }
      await walk(target.id, target.ns, parsed.name)
    }
  }

  await walk(projectId, ns, name)
  return namespaces
}

// ── Minimal ustar+gzip tar builder (no `tar` dependency) ──────

function tarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 100, 'utf8')
  buf.write('0000644\0', 100, 8)
  buf.write('0000000\0', 108, 8)
  buf.write('0000000\0', 116, 8)
  buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12)
  buf.write('00000000000\0', 136, 12)
  buf.write('        ', 148, 8)
  buf.write('0', 156, 1)
  buf.write('ustar\0', 257, 6)
  buf.write('00', 263, 2)
  let sum = 0
  for (let i = 0; i < 512; i++) {
    sum += buf[i]
  }
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return buf
}

function tarEntry(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8')
  const header = tarHeader(name, data.length)
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512 || 512)
  data.copy(padded)
  return Buffer.concat([header, padded])
}

async function buildPackageTarball(files: Array<{ name: string; content: string }>): Promise<Buffer> {
  const zlib = await import('node:zlib')
  const entries = files.map((f) => tarEntry(`package/${f.name}`, f.content))
  const tar = Buffer.concat([...entries, Buffer.alloc(1024)])
  return zlib.gzipSync(tar)
}

// `targets` rather than one target, because the whole-project form adds every
// component in a single `shadcn add` — the CLI takes them variadically
// (`shadcn add [components...]`, confirmed against the CLI's own help on
// 14.09.2026), so one invocation resolves the closure across all of them
// instead of N invocations each re-reading the registry.
//
// Deliberately not shadcn's own `--all`: that means every component of every
// registry the consuming project has configured, which is a different and
// wider thing than every component of THIS project.
function installScriptSource(required: Record<string, string>, targets: string[]): string {
  return `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const REQUIRED = ${JSON.stringify(required, null, 2)}
const TARGETS = ${JSON.stringify(targets)}

const configPath = path.join(process.cwd(), 'components.json')
if (!fs.existsSync(configPath)) {
  console.error('No components.json found in ' + process.cwd() + '. Run this from a shadcn-initialized project.')
  process.exit(1)
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const registries = config.registries || {}
const added = []

// Basic-auth-gated host support. Two env vars, one command, no files:
//   \`npm_config_//<host>/:_auth=<base64 user:pass>\` — used by npm itself to
//   fetch this script's tarball, but npm STRIPS credential-shaped config vars
//   from the env it passes to package scripts, so this script cannot read it;
//   \`DESIGN_KIT_AUTH=<same base64>\` — readable here, and referenced by the
//   Authorization header templates below via shadcn's \${VAR} substitution,
//   so the secret never lands in components.json.
const host = new URL(REQUIRED[Object.keys(REQUIRED)[0]]).host
const auth = process.env.DESIGN_KIT_AUTH || process.env['npm_config_//' + host + '/:_auth']
if (auth) {
  process.env.DESIGN_KIT_AUTH = auth
  // Also satisfy env-var templates of registries ALREADY configured for this
  // host with an auth header of their own (e.g. \${MY_REGISTRY_AUTH}) — same
  // credential, whatever name the existing entry expects.
  for (const key of Object.keys(registries)) {
    const entry = registries[key]
    if (!entry || typeof entry === 'string' || !entry.headers) {
      continue
    }
    let entryHost = null
    try {
      entryHost = new URL(String(entry.url)).host
    } catch (e) {}
    if (entryHost !== host) {
      continue
    }
    for (const hv of Object.values(entry.headers)) {
      const m = /\\$\\{([A-Za-z0-9_]+)\\}/.exec(String(hv))
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = auth
      }
    }
  }
}

// A consumer that is not RSC is served its files with 'use client' already
// removed (\`rsc=false\`, see server/client-directive.ts): shadcn's own removal
// skips every other file of one install. Sent as registry \`params\` so the URL
// still compares equal to an entry the consumer configured itself; such an
// entry gets the parameter for this run only and is put back afterwards.
const stripDirective = !config.rsc
const augmented = {}

for (const ns of Object.keys(REQUIRED)) {
  const url = REQUIRED[ns]
  const existing = registries[ns]
  const existingUrl = typeof existing === 'string' ? existing : existing && existing.url
  if (existing && existingUrl !== url) {
    console.warn('Skipping ' + ns + ': already configured with a different URL (' + existingUrl + ')')
    continue
  }
  if (!existing) {
    const entry = { url: url }
    if (auth) {
      entry.headers = { Authorization: 'Basic \${DESIGN_KIT_AUTH}' }
    }
    if (stripDirective) {
      entry.params = { rsc: 'false' }
    }
    registries[ns] = entry.headers || entry.params ? entry : url
    added.push(ns)
  } else if (stripDirective) {
    augmented[ns] = existing
    const entry = typeof existing === 'string' ? { url: existing } : Object.assign({}, existing)
    entry.params = Object.assign({}, entry.params, { rsc: 'false' })
    registries[ns] = entry
  }
}

try {
  if (added.length > 0 || Object.keys(augmented).length > 0) {
    // Written directly (not \`shadcn registry add\`) so the entries can carry
    // the auth header; the finally block below restores the file either way.
    config.registries = registries
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\\n')
  }
  // Non-interactive: the design kit is the source of truth and installed
  // components are read-only vendored copies — skip confirmation prompts and
  // overwrite differing existing files instead of hanging on a prompt.
  // Spread, so every target is its own argument. Joining them into one string
  // would hand shadcn a single item whose name contains spaces, which resolves
  // to nothing and reports no error worth reading.
  //
  // No partial handling on purpose: a failure here throws, the finally block
  // below still restores components.json, and the script exits non-zero. A
  // component that cannot be installed is the kit's defect or the component's,
  // and neither is this installer's to absorb by carrying on.
  execFileSync('npx', ['shadcn@latest', 'add', '--yes', '--overwrite', ...TARGETS], { stdio: 'inherit' })
} finally {
  if (added.length > 0 || Object.keys(augmented).length > 0) {
    const fresh = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (fresh.registries) {
      for (const ns of added) {
        delete fresh.registries[ns]
      }
      for (const ns of Object.keys(augmented)) {
        fresh.registries[ns] = augmented[ns]
      }
      if (Object.keys(fresh.registries).length === 0) {
        delete fresh.registries
      }
    }
    fs.writeFileSync(configPath, JSON.stringify(fresh, null, 2) + '\\n')
  }
}
`
}

const MISSING_INSTALL_TARGET =
  'Missing component. Pass `component=<project>.<name>` for one component, or `component=<project>` for all of them — a `/` works in place of the `.`.'

// GET /http/install?component=<project>.<name> — one component.
// GET /http/install?component=<project>        — every component of it.
//
// An npm package tarball whose bin script performs the temporary-registries
// install described above. The two forms differ only in which names the script
// is told to add: one parameter, one route, one `npx` line.
async function installScriptRoute(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const request = installRequestFrom(
    url.searchParams.get('component'),
    url.searchParams.get('project'),
    url.searchParams.get('name'),
  )
  if (!request) {
    return json({ error: MISSING_INSTALL_TARGET }, 400)
  }
  const { id, ns: topNs } = await resolveProject(request.project)

  let names: string[]
  if (request.kind === 'component') {
    const comp = await getComponentViaDb(id, request.name)
    if (!comp) {
      return json({ error: `Component "${request.name}" not found in project ${request.project}.` }, 404)
    }
    names = [request.name]
  } else {
    // Sorted, so the same project produces the same tarball twice running.
    names = (await readComponentsViaDb(id)).map((c) => c.name).sort()
    // An empty list is refused rather than shipped. The project resolver does
    // not throw on a name it does not know — it falls back to treating the
    // name as an id — so "no such project" and "a project with nothing
    // published" arrive here identically, as zero components. Handing either
    // of them an installer with no arguments would report success for having
    // installed nothing, which is the one answer neither case deserves.
    //
    // ONE REFUSAL, AND ITS SENTENCE SAYS BOTH THINGS IT COULD MEAN. Naming the
    // project as a project would presuppose it exists, which is precisely what
    // this branch never established — the resolver's fallback is what makes the
    // two indistinguishable, and a phrasing that picks one asserts something
    // nobody looked into. Stating the disjunction costs a clause; establishing
    // which half is true costs a lookup performed only in order to word an
    // error, and the reader's next step is the same either way.
    if (names.length === 0) {
      return json(
        {
          error: `No components to install: project "${request.project}" has nothing published, or nothing answers to that name.`,
        },
        404,
      )
    }
  }

  const namespaces = new Set<string>()
  for (const name of names) {
    for (const ns of await collectNamespaces(id, topNs, name)) {
      namespaces.add(ns)
    }
  }
  const registryBase = new URL(routeUrl('registry'), url.origin).href
  const required: Record<string, string> = {}
  for (const ns of namespaces) {
    required[`@${ns}`] = `${registryBase}?project=${ns}&name={name}`
  }

  const script = installScriptSource(
    required,
    names.map((name) => `@${topNs}/${name}`),
  )
  const label = request.kind === 'component' ? request.name : 'all'
  const tarball = await buildPackageTarball([
    {
      name: 'package.json',
      content: JSON.stringify(
        { name: `design-kit-install-${topNs}-${label}`, version: '1.0.0', bin: { install: './cli.js' } },
        null,
        2,
      ),
    },
    { name: 'cli.js', content: script },
  ])

  return new Response(new Uint8Array(tarball), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' },
  })
}

// ── preview source closure ───────────────────────────
// The isolated preview resolves imports by evaluating a POOL of component
// sources. This assembles that pool for a component: its whole project, plus
// the transitive closure of its dependencies — cross-project design-kit
// components (via registryDependencies `@ns/name`, read from the DB) and shadcn
// primitives (bare registryDependency names + undeclared `@/components/ui/*`
// imports, fetched & cached from the shadcn registry). Mirrors how the shadcn
// CLI resolves registryDependencies on install, but into the eval pool instead
// of onto disk.

const PREVIEW_SOURCE = (f: StoredFile): boolean =>
  f.type !== 'registry:ignore' && !(f.target || f.path).startsWith('docs/')

// Structural parameter (the same shape componentFiles takes) so the preview
// validator can be handed this function without knowing the full stored record.
function previewSourceFiles(c: { name: string; type: string; files?: StoredFile[]; source?: string }): string[] {
  return componentFiles(c)
    .filter(PREVIEW_SOURCE)
    .map((f) => f.content)
}

// The `@/…` alias-import scan lives in dependency-graph.ts (imported above):
// the pool's inferred resolution and the graph's inferred edges must read the
// same imports the same way, so there is exactly one copy of the regex.

/**
 * Everything every pool build starts from: the project list, each project's
 * components, and the by-name index over all of them.
 *
 * Split out of the walk below because it is the same for every component and
 * it is where the time goes — one read per project, plus the projects read
 * itself. An author previews several components of one project in a row, so
 * computing this once and reusing it is the bulk of what the cache saves.
 */
interface PreviewCorpus {
  projects: Array<{ id: string; name: string; slug?: string; theme?: ProjectTheme }>
  projComps: Map<string, StoredComponent[]>
  index: Map<string, { projectId: string; ns: string; comp: StoredComponent }>
}

async function readPreviewCorpus(): Promise<PreviewCorpus> {
  const projects = await readProjectsViaDb()

  // Index every component of every project once: name → its component + project.
  // First match wins (used only as a fallback for undeclared imports).
  const projComps = new Map<string, StoredComponent[]>()
  const index = new Map<string, { projectId: string; ns: string; comp: StoredComponent }>()
  for (const p of projects) {
    // The authoring view: a preview exists to show the author what they are
    // working on, so it resolves against drafts. The registry routes below are
    // the ones that must stay on published.
    const comps = await readEffectiveViaDb(p.id)
    projComps.set(p.id, comps)
    for (const c of comps) {
      if (!index.has(c.name)) {
        index.set(c.name, { projectId: p.id, ns: namespaceOf(p), comp: c })
      }
    }
  }
  return { projects, projComps, index }
}

// The uncached build. Every caller goes through buildPreviewSources below —
// this one is reached only by the cache, which is what makes "how often is this
// recomputed" a question with one answer.
//
// The corpus it reads is SHARED with every other pool built in the same epoch,
// so nothing here may mutate it; the walk only reads, and the groups it pushes
// are freshly built arrays.
async function buildPreviewPool(projectId: string): Promise<PoolGroup[]> {
  const { projects, projComps, index } = await previewPools.shared()
  const projectComps = projComps.get(projectId) ?? []
  const localNames = new Set(projectComps.map((c) => c.name))
  // The namespace a self-scope reference (`@design-kit/x`) resolves against, so
  // it must be the one findProjectByNamespace matches — the project's published
  // namespace. These two values never leave the server: they are pool lookup
  // keys, not anything a consumer is handed.
  const ownProject = projects.find((p) => p.id === projectId)
  const ownNs = ownProject ? namespaceOf(ownProject) : ''
  // Every shadcn primitive in this pool — its own imports' and the ones
  // cross-project components pull in — resolves in THIS project's style: the
  // pool is what this project previews with, and one frame cannot hold two
  // `button`s under one name.
  const style = effectiveShadcnStyle(ownProject?.theme?.shadcnStyle)

  const groups: PoolGroup[] = []
  const dkVisited = new Set<string>() // `<projectId>::<name>` of design-kit comps already pooled
  const pulledNames = new Set<string>() // component names provided cross-project (not shadowed by shadcn)
  const shadcnNames = new Set<string>()

  // Add a design-kit component's sources to the pool once. Returns whether it
  // was newly added (so the caller enqueues it for dependency processing).
  const addDk = (pid: string, comp: StoredComponent): boolean => {
    const key = `${pid}::${comp.name}`
    if (dkVisited.has(key)) {
      return false
    }
    dkVisited.add(key)
    groups.push({ files: previewSourceFiles(comp), dependencies: comp.dependencies ?? [] })
    return true
  }

  // 1) the whole current project — siblings resolve freely.
  const queue: Array<{ comp: StoredComponent; ns: string }> = []
  for (const c of projectComps) {
    addDk(projectId, c)
    queue.push({ comp: c, ns: ownNs })
  }

  // 2) walk each pooled component's dependencies (breadth-first).
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { comp, ns } = next
    // Explicit registryDependencies: `@ns/name` → design-kit; bare → shadcn.
    for (const dep of comp.registryDependencies ?? []) {
      const parsed = parseDep(dep, ns)
      if (parsed) {
        const target = await findProjectByNamespace(parsed.ns, projects)
        if (!target) {
          continue
        }
        const depComp = (projComps.get(target.id) ?? []).find((c) => c.name === parsed.name)
        if (depComp && addDk(target.id, depComp)) {
          pulledNames.add(depComp.name)
          queue.push({ comp: depComp, ns: target.ns })
        }
      } else if (/^[a-z0-9-]+$/.test(dep)) {
        shadcnNames.add(dep)
      }
    }
    // Undeclared `@/…` imports: a shadcn primitive if the registry has it, else
    // the user's own kit component by name (any project), else left undefined
    // (surfaced in-frame as an unresolved import).
    for (const content of previewSourceFiles(comp)) {
      for (const seg of aliasImportNames(content)) {
        if (seg === 'utils' || localNames.has(seg) || pulledNames.has(seg)) {
          continue
        }
        if (await shadcnHas(seg, style)) {
          shadcnNames.add(seg)
        } else {
          const hit = index.get(seg)
          if (hit && addDk(hit.projectId, hit.comp)) {
            pulledNames.add(seg)
            queue.push({ comp: hit.comp, ns: hit.ns })
          }
        }
      }
    }
  }

  // 3) shadcn primitives (transitive), skipping any name a design-kit component
  // already provides so a local `button` isn't shadowed by shadcn's.
  const { sources } = await collectShadcnSources(
    [...shadcnNames],
    (n) => localNames.has(n) || pulledNames.has(n),
    style,
  )
  groups.push(...sources)
  return groups
}

// The cache in front of that build (server/preview-pool-cache.ts holds the
// policy, host-free and unit-tested). Every pool and the corpus they share are
// tagged with one global epoch; any write to any component in any project, and
// any project appearing or disappearing, bumps it via invalidatePreviewPools.
const previewPools = createPreviewPoolCache<PoolGroup[], PreviewCorpus>({
  buildPool: buildPreviewPool,
  buildShared: readPreviewCorpus,
})

/**
 * The pool for a component's preview — the only entry point, cached.
 *
 * The three readers (the `preview.sources` action, the standalone preview/data
 * route and the server-side validator) all arrive here, and on a fresh write
 * two of them arrive at once; the cache hands them one build rather than three.
 *
 * THE KEY IS THE PROJECT, NOT THE COMPONENT, because the build above is: it
 * pools the whole project and then the closure of the whole project's
 * dependencies, and `componentName` reaches none of that. Keyed per component
 * the cache would be correct and nearly useless — the same pool rebuilt for the
 * first open of every component and held N times over in the heap, each copy
 * carrying a project's full source text. The parameter stays in the signature
 * because it is the shape the validator and the preview routes inject, and
 * because a build narrowed to one component's own closure is the obvious next
 * step: whoever narrows it must widen this key in the same commit.
 *
 * The returned groups are SHARED between readers. Nobody may mutate them —
 * today's consumers flatten and serialize, which is what this depends on.
 */
export function buildPreviewSources(projectId: string, _componentName: string): Promise<PoolGroup[]> {
  return previewPools.pool(projectId)
}

/**
 * Every pool is now wrong: a component was created, written, edited, moved,
 * deleted, published or discarded, or a project appeared or disappeared.
 *
 * Called at the mutation itself rather than around the action, because a write
 * validates AFTER it persists and that validation builds a pool: bumping any
 * later would have the validator report on the sources the write replaced.
 *
 * A function declaration, not a const, so the mutation helpers defined earlier
 * in this file can call it without depending on where `previewPools` sits.
 */
function invalidatePreviewPools(): void {
  previewPools.invalidate()
}

/**
 * Prepare a component's pool after its publish, in the background.
 *
 * The product shape: a published component is one somebody is about to look at,
 * so the wait for its pool belongs to the publish that just finished and not to
 * the reader who opens the preview next. Not awaited and never throwing (see
 * the cache's `warm`) — a publish that succeeded must not be delayed by this,
 * and must certainly not be reported as failed by it.
 */
function warmPreviewPool(projectId: string): void {
  previewPools.warm(projectId)
}

// Server-side preview validation — reuses buildPreviewSources, the DB-backed
// component reader, and the pool-group builder above; see server/validate.ts
// for the eval/render pipeline itself.
const { validateComponent } = createValidator({
  readComponents: readEffectiveViaDb,
  buildPreviewSources,
  previewSourceFiles,
  bundleDep,
})

// The dependency graph behind the doc page and the graph view: same stored
// records, same draft-first read the previews use, and — unlike the walks
// above — it keeps every reference that resolves to nothing.
const buildDependencyGraph = createDependencyGraphBuilder({
  readProjects: readProjectsViaDb,
  namespaceOf,
  readComponents: readEffectiveViaDb,
  sourceFiles: previewSourceFiles,
  shadcnHas,
})

// Best-effort: validation failures must never block a write/edit that already
// succeeded — surface them as data, not a thrown error.
// The last validation each component's draft saw, kept OUTSIDE the component
// record: writing it onto the record would bump updatedAt and break every
// optimistic write guard, and it must never ride into the registry payload.
// Publish reads it so the moment of shipping can say what the last save knew.
const lastValidationKey = (projectId: string): string => `last-validation:${projectId}`

// As stored, which is not as read: `failed` comes back through
// readValidationSummary, where an entry written under an older shape is turned
// away rather than surfaced as a report nobody can word.
type StoredValidationSummary = Omit<ValidationSummary, 'failed'> & { failed: unknown[] }

const readSummaries = async (projectId: string): Promise<Record<string, StoredValidationSummary>> =>
  (await storage.get<Record<string, StoredValidationSummary>>(lastValidationKey(projectId))) ?? {}

/**
 * A component's stable id, on whichever store holds the project — the key its
 * last-validation record is kept under. Resolved here so that nothing reading
 * or writing that record has to know which of the two stores answered.
 */
async function componentIdOf(projectId: string, name: string): Promise<string | undefined> {
  const instance = await instanceById(projectId)
  return instance
    ? (await repoStore.readComponentMeta(instance.dataDir, name))?.id
    : (await readComponents(projectId)).find((c) => c.name === name)?.id
}

async function recordValidationSummary(
  projectId: string,
  componentId: string | undefined,
  result: ValidateComponentResult,
): Promise<void> {
  if (!componentId) {
    return
  }
  const map = await readSummaries(projectId)
  map[componentId] = summarizeValidation(result.targets ?? [], Date.now())
  await storage.set(lastValidationKey(projectId), map)
}

async function lastValidationOf(
  projectId: string,
  componentId: string | undefined,
): Promise<ValidationSummary | undefined> {
  if (!componentId) {
    return undefined
  }
  return readValidationSummary((await readSummaries(projectId))[componentId])
}

/**
 * Validate a component's draft and remember what the check found, so the
 * publish that ships that draft can report it. Every write path goes through
 * here — a record only one surface maintains is worse than none, because the
 * publish would then report an older verdict than the draft it is shipping.
 *
 * Returns the run as the validator produced it; the editor-facing callers take
 * the single result out of it below.
 */
async function validateAndRecord(projectId: string, name: string): Promise<{ components: ValidateComponentResult[] }> {
  const outcome = await validateComponent(projectId, name)
  const result = outcome.components[0]
  if (result) {
    await recordValidationSummary(projectId, await componentIdOf(projectId, name), result)
  }
  return outcome
}

async function validateAfterWrite(projectId: string, name: string): Promise<ValidateComponentResult> {
  try {
    const { components } = await validateAndRecord(projectId, name)
    const result = components[0]
    if (result) {
      return result
    }
    // The reader found no such component immediately after a successful write.
    // Nothing was checked, and that must not arrive looking like a pass.
    return {
      component: name,
      verdict: 'unverified',
      summary: 'Not validated: the component was not found when validation ran.',
      poolDiagnostics: [],
      targets: [
        {
          target: 'source',
          outcome: 'unverifiable',
          error: 'component not found when validation ran',
          unresolvedImports: [],
        },
      ],
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return {
      component: name,
      verdict: 'error',
      summary: `Validation could not run: ${error}`,
      poolDiagnostics: [],
      targets: [{ target: 'validate', outcome: 'error', error, unresolvedImports: [] }],
    }
  }
}

// "What changed since my last install" for a consumer script: additive,
// read-only, timestamp form only — the version-map form needs a body and
// belongs to the app's changesSince action; a consumer that holds versions
// has an agent.
// Reads the PUBLISHED list via the db like every other route (no request
// context), through the same pure function the store's changesSince uses.
async function changesRoute(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const project = projectFromQuery(url)
  if (!project) {
    return json({ error: MISSING_PROJECT }, 400)
  }
  const since = sinceOf(url.searchParams.get('since'))
  if (since === undefined) {
    return json({ error: 'Pass since=<ISO 8601 or epoch milliseconds>.' }, 400)
  }
  const { id } = await resolveProject(project)
  return json({ changed: changedSince(await readComponentsViaDb(id), since) })
}

export const routes = {
  registry: registryItemRoute,
  all: registryAllRoute,
  index: registryIndexRoute,
  projects: projectsRoute,
  install: installScriptRoute,
  changes: changesRoute,
  // Isolated preview iframe: shell, frame runtime, in-frame Tailwind, npm dep
  // bundles, standalone data. See server/preview.ts.
  // The preview serves the kit's own iframe, not an installer, so it is
  // handed the authoring view — the same list the validator and the editor see.
  ...createPreviewRoutes({
    readComponentsViaDb: readEffectiveViaDb,
    readProjectsViaDb,
    resolveProject,
    componentFiles,
    buildPreviewSources,
  }),
}
