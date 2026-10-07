// Component store — write ordering on a cross-project move, and the guard that
// refuses a write which drops records silently.
//
// Run with `npm test` (node's own runner; the TypeScript is type-stripped, so
// there is nothing to install).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { draftStateFor,
  componentsKey,
  createComponentStore,
  draftKey,
  historyKey,
  HISTORY_COMPONENT_BUDGET_BYTES,
  HISTORY_EXTENSION_CEILING_BYTES,
  HISTORY_INDEX_KEY,
  HISTORY_KEEP_MIN,
  SHRINK_REFUSED,
  STALE_WRITE,
} from './component-store.ts'
import type { ComponentStorage, HistoryEntry, ShrinkRefusedError, StaleWriteError } from './component-store.ts'

interface TestComponent {
  id: string
  name: string
  updatedAt?: number
  version?: number
  publishedAt?: number
  /** Stands in for the content a record carries, so an edit has something to change. */
  title?: string
  files?: Array<{ path: string; target?: string; type?: string; content: string }>
}

const SOURCE = 'dp_source'
const DEST = 'dp_dest'

/**
 * In-memory storage that can be told to fail on the Nth write of a component
 * list. Only `components:` keys are counted, so `failComponentWrite: 2` always
 * means "the second time a project's component list is persisted" however many
 * other keys were written along the way.
 */
function fakeStorage(seed: Record<string, unknown> = {}, failComponentWrite = 0) {
  const data = new Map<string, unknown>(Object.entries(seed))
  const componentWrites: string[] = []
  const storage: ComponentStorage = {
    async get<T>(key: string): Promise<T | null> {
      return (data.get(key) as T | undefined) ?? null
    },
    async set<T>(key: string, value: T): Promise<void> {
      if (key.startsWith('components:')) {
        componentWrites.push(key)
        if (componentWrites.length === failComponentWrite) {
          throw new Error('storage write failed')
        }
      }
      data.set(key, value)
    },
    async list(): Promise<string[]> {
      return [...data.keys()]
    },
  }
  return { storage, data, componentWrites }
}

function seedProjects(source: TestComponent[], dest: TestComponent[] = []) {
  return { [componentsKey(SOURCE)]: source, [componentsKey(DEST)]: dest }
}

function store(storage: ComponentStorage) {
  let n = 0
  return createComponentStore<TestComponent>({
    storage,
    newId: () => `cp_backfilled_${(n += 1)}`,
    now: () => 1000,
  })
}

const slugify = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')

const file = (path: string, content: string) => ({ path, target: path, type: 'registry:component', content })

function names(value: unknown): string[] {
  return ((value as TestComponent[] | undefined) ?? []).map((c) => c.name)
}

// ── the write order itself ───────────────────────────────────────────

test('a cross-project move writes the destination before it truncates the source', async () => {
  const { storage, componentWrites } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget' }]))
  await store(storage).moveComponent(SOURCE, 'widget', { destProjectId: DEST, slugify })

  assert.deepEqual(componentWrites, [componentsKey(DEST), componentsKey(SOURCE)])
})

// The reason the order is what it is. A failure can land on either write, and
// in neither case may the component stop existing: losing it is silent, while
// a duplicate is visible and can be cleaned up.
for (const failAt of [1, 2]) {
  test(`a failure on write ${failAt} of a cross-project move never loses the component`, async () => {
    const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget' }]), failAt)

    await assert.rejects(
      store(storage).moveComponent(SOURCE, 'widget', { destProjectId: DEST, slugify }),
      /storage write failed/,
    )

    const inSource = names(data.get(componentsKey(SOURCE))).includes('widget')
    const inDest = names(data.get(componentsKey(DEST))).includes('widget')
    assert.ok(inSource || inDest, 'the component must still exist in at least one project')
  })
}

test('a failure while truncating the source leaves a visible duplicate, not a loss', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget' }]), 2)

  await assert.rejects(store(storage).moveComponent(SOURCE, 'widget', { destProjectId: DEST, slugify }))

  assert.deepEqual(names(data.get(componentsKey(SOURCE))), ['widget'])
  assert.deepEqual(names(data.get(componentsKey(DEST))), ['widget'])
})

test('a completed cross-project move leaves exactly one copy, in the destination', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget' }, { id: 'cp_2', name: 'other' }]))
  const result = await store(storage).moveComponent(SOURCE, 'widget', { destProjectId: DEST, slugify })

  assert.deepEqual(result, { moved: true, name: 'widget', project: DEST })
  assert.deepEqual(names(data.get(componentsKey(SOURCE))), ['other'])
  assert.deepEqual(names(data.get(componentsKey(DEST))), ['widget'])
})

test('a cross-project move can rename in the same operation', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget' }]))
  await store(storage).moveComponent(SOURCE, 'widget', { toName: 'New Widget', destProjectId: DEST, slugify })

  assert.deepEqual(names(data.get(componentsKey(DEST))), ['new-widget'])
  assert.deepEqual(names(data.get(componentsKey(SOURCE))), [])
})

test('a same-project rename keeps the list the same size and writes once', async () => {
  const { storage, data, componentWrites } = fakeStorage(
    seedProjects([{ id: 'cp_1', name: 'widget' }, { id: 'cp_2', name: 'other' }]),
  )
  await store(storage).moveComponent(SOURCE, 'widget', { toName: 'renamed', slugify })

  assert.deepEqual(componentWrites, [componentsKey(SOURCE)])
  assert.deepEqual(names(data.get(componentsKey(SOURCE))), ['renamed', 'other'])
})

test('a colliding move is refused before anything is written', async () => {
  const { storage, componentWrites } = fakeStorage(
    seedProjects([{ id: 'cp_1', name: 'widget' }], [{ id: 'cp_9', name: 'widget' }]),
  )
  await assert.rejects(
    store(storage).moveComponent(SOURCE, 'widget', { destProjectId: DEST, slugify }),
    /already exists in the destination project/,
  )
  assert.deepEqual(componentWrites, [])
})

test('a colliding same-project rename is refused before anything is written', async () => {
  const { storage, componentWrites } = fakeStorage(
    seedProjects([{ id: 'cp_1', name: 'widget' }, { id: 'cp_2', name: 'taken' }]),
  )
  await assert.rejects(store(storage).moveComponent(SOURCE, 'widget', { toName: 'taken', slugify }), /already exists here/)
  assert.deepEqual(componentWrites, [])
})

// ── the shrink guard ─────────────────────────────────────────────────

test('a write that silently drops a component is refused and changes nothing', async () => {
  const seeded = [{ id: 'cp_1', name: 'widget' }, { id: 'cp_2', name: 'other' }]
  const { storage, data } = fakeStorage(seedProjects(seeded))

  const err = (await store(storage)
    .writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget' }])
    .then(() => null)
    .catch((e: ShrinkRefusedError) => e)) as ShrinkRefusedError

  assert.ok(err, 'the write must be refused')
  assert.equal(err.code, SHRINK_REFUSED)
  assert.deepEqual(err.removed, ['other'])
  assert.deepEqual(names(data.get(componentsKey(SOURCE))), ['widget', 'other'], 'storage must be untouched')
})

// These three protect recoverability without a set-aside copy of the whole
// list: each checks it in the place that holds it.

test('a refused write leaves nothing behind, because it wrote nothing', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget' }, { id: 'cp_2', name: 'other' }]))

  await assert.rejects(store(storage).writeComponents(SOURCE, []))

  assert.deepEqual(names(data.get(componentsKey(SOURCE))), ['widget', 'other'], 'the list is still whole')
  assert.equal(data.get(draftKey(SOURCE)), undefined, 'and no partial draft was left over')
  assert.deepEqual([...data.keys()].filter((k) => k.startsWith('components-snapshot')), [], 'nothing is copied aside')
})

test('an intended removal files the record it removed, so a delete is recoverable', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget' }, { id: 'cp_2', name: 'other', updatedAt: 4, title: 'Other' }]))
  const s = store(storage)

  assert.deepEqual(await s.deleteComponent(SOURCE, 'other'), { deleted: true, name: 'other' })

  assert.deepEqual(names(data.get(componentsKey(SOURCE))), ['widget'])
  const filed = await s.readHistory(SOURCE, 'cp_2')
  assert.equal(filed.length, 1)
  assert.equal(filed[0].meta.title, 'Other', 'the removed record itself, not a note that it went')
})

test('deleting something that is not there removes nothing and files nothing', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget' }]))
  const s = store(storage)

  assert.deepEqual(await s.deleteComponent(SOURCE, 'absent'), { deleted: false, name: 'absent' })
  assert.deepEqual([...data.keys()].filter((k) => k.startsWith('component-history:')), [])
})

// An authoring write does not land where installers read. An add or an edit is
// not a shrink, and a rename is not a deletion; these two say which list each
// is protected in.

test('an edit that adds nothing and removes nothing is not treated as a shrink', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const s = store(storage)

  await s.writeComponents(SOURCE, [
    { id: 'cp_1', name: 'widget', updatedAt: 5 },
    { id: 'cp_2', name: 'added', updatedAt: 5 },
  ])

  assert.deepEqual(names(await s.readComponents(SOURCE)), ['widget', 'added'])
  assert.deepEqual(names(data.get(componentsKey(SOURCE))), ['widget'], 'an edit must not move the published list')
  assert.deepEqual(names(data.get(draftKey(SOURCE))), ['widget', 'added'])
})

test('removal is decided by id, so a rename is not mistaken for a deletion', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const s = store(storage)

  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'renamed', updatedAt: 2 }])

  assert.deepEqual(names(await s.readComponents(SOURCE)), ['renamed'])
})

// ── draft and publish ────────────────────────────────────────────────
// What installers are served changes only when someone publishes. So the
// question every test below asks is which of the two lists moved.

test('the published list is untouched byte for byte until the first publish', async () => {
  const seeded = [{ id: 'cp_1', name: 'widget', updatedAt: 1, title: 'Widget' }]
  const { storage, data } = fakeStorage(seedProjects(seeded))
  const s = store(storage)

  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 9, title: 'Renamed title' }])

  assert.equal(JSON.stringify(data.get(componentsKey(SOURCE))), JSON.stringify(seeded))
})

test('a draft is invisible to the published read the registry is served from', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const s = store(storage)

  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 9 }, { id: 'cp_2', name: 'unpublished', updatedAt: 9 }])

  assert.deepEqual(names(await s.readPublished(SOURCE)), ['widget'])
  assert.deepEqual(names(await s.readComponents(SOURCE)), ['widget', 'unpublished'])
})

test('publishing serves the draft, spends a version and clears the overlay', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1, version: 3 }]))
  const s = store(storage)
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 9 }])

  const result = await s.publishComponent(SOURCE, 'widget')

  assert.equal(result.published, true)
  assert.equal(result.version, 4)
  assert.deepEqual(await s.readPublished(SOURCE), [{ id: 'cp_1', name: 'widget', updatedAt: 9, version: 4, publishedAt: 1000 }])
  assert.deepEqual(data.get(draftKey(SOURCE)), [], 'nothing is left unpublished')
})

// The version backfill is a READ rule, not a write: a record from before
// versioning is never rewritten to carry a 1, it is simply read as one. So its
// first publish produces 2, and the published bytes stay untouched until then.
test('a record from before versioning reads as version 1, so its first publish is 2', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const s = store(storage)
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 9 }])

  assert.equal((await s.publishComponent(SOURCE, 'widget')).version, 2)
})

test('a component that has only ever been a draft publishes as version 1', async () => {
  const { storage } = fakeStorage(seedProjects([]))
  const s = store(storage)
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'fresh', updatedAt: 9 }])

  assert.equal((await s.publishComponent(SOURCE, 'fresh')).version, 1)
  assert.deepEqual(names(await s.readPublished(SOURCE)), ['fresh'])
})

test('publishing files the version it replaced, newest first', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1, version: 1 }]))
  const s = store(storage)

  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 2 }])
  await s.publishComponent(SOURCE, 'widget')
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 3 }])
  await s.publishComponent(SOURCE, 'widget')

  assert.deepEqual(
    (await s.readHistory(SOURCE, 'cp_1')).map((e) => e.version),
    [2, 1],
  )
})

test('publishing with nothing unpublished changes nothing and spends no version', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1, version: 7 }]))
  const s = store(storage)

  const result = await s.publishComponent(SOURCE, 'widget')

  assert.equal(result.published, false)
  assert.equal(result.version, 7)
  assert.equal(data.get(historyKey(SOURCE, 'cp_1')), undefined)
})

// A publish replaces one entry and removes none, so the guard that watches for
// a shrinking list has nothing to fire on. Asserted because getting this wrong
// would block every publish in a project holding more than one component.
test('the shrink guard does not misfire when a draft is promoted', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }, { id: 'cp_2', name: 'other', updatedAt: 1 }]))
  const s = store(storage)
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 9 }, { id: 'cp_2', name: 'other', updatedAt: 1 }])

  await s.publishComponent(SOURCE, 'widget')

  assert.deepEqual(names(await s.readPublished(SOURCE)), ['widget', 'other'])
})

test('an edit that puts a component back exactly as published leaves no draft behind', async () => {
  const seeded = [{ id: 'cp_1', name: 'widget', updatedAt: 1 }]
  const { storage, data } = fakeStorage(seedProjects(seeded))
  const s = store(storage)

  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 2 }])
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 1 }])

  assert.deepEqual(data.get(draftKey(SOURCE)), [])
})

test('deleting takes the published copy and the draft, and leaves the record recoverable', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }, { id: 'cp_2', name: 'other', updatedAt: 1 }]))
  const s = store(storage)
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 9, files: [file('a.tsx', 'kept')] }, { id: 'cp_2', name: 'other', updatedAt: 1 }])
  await s.publishComponent(SOURCE, 'widget')

  await s.deleteComponent(SOURCE, 'widget')

  assert.deepEqual(names(await s.readPublished(SOURCE)), ['other'])
  assert.deepEqual(names(data.get(draftKey(SOURCE))), [])
  // The component is gone, so there is no head to walk back from — which is
  // exactly why the entry a delete files is a whole record rather than a delta.
  const recovered = await s.reconstructVersion(SOURCE, 'cp_1', 2)
  assert.equal(recovered?.name, 'widget')
  assert.deepEqual(recovered?.files?.map((f) => f.content), ['kept'])
})

// ── history: reverse deltas under two byte budgets ───────────────────
// A count cap cannot express a limit on a shared row, so entries are deltas
// and the caps are in bytes. These check that what is stored is small, that
// what is rebuilt from it is exact, and that the edge where it stops is
// reported rather than hidden.

/** Publish a component holding `files`, returning the publish result. */
async function publishFiles(s: ReturnType<typeof store>, files: TestComponent['files'], at: number) {
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: at, files }])
  return s.publishComponent(SOURCE, 'widget')
}

test('a delta stores only the files that changed, not the ones that did not', async () => {
  const { storage } = fakeStorage(seedProjects([]))
  const s = store(storage)
  await publishFiles(s, [file('a.tsx', 'A1'), file('b.tsx', 'B — long enough to notice if it were copied')], 1)

  await publishFiles(s, [file('a.tsx', 'A2'), file('b.tsx', 'B — long enough to notice if it were copied')], 2)

  const [entry] = await s.readHistory(SOURCE, 'cp_1')
  assert.deepEqual(entry.files.map((f) => f.path), ['a.tsx'], 'only the changed file is stored')
  assert.deepEqual(entry.order, ['a.tsx', 'b.tsx'], 'but the order records both, so the rebuild is exact')
})

test('a revision rebuilt from deltas is the record that was published', async () => {
  const { storage } = fakeStorage(seedProjects([]))
  const s = store(storage)
  await publishFiles(s, [file('a.tsx', 'A1'), file('b.tsx', 'B1')], 1)
  await publishFiles(s, [file('a.tsx', 'A2'), file('b.tsx', 'B1'), file('c.tsx', 'C1')], 2)
  await publishFiles(s, [file('a.tsx', 'A3'), file('b.tsx', 'B1'), file('c.tsx', 'C1')], 3)

  const v1 = await s.reconstructVersion(SOURCE, 'cp_1', 1)
  const v2 = await s.reconstructVersion(SOURCE, 'cp_1', 2)

  assert.deepEqual(v1?.files, [file('a.tsx', 'A1'), file('b.tsx', 'B1')], 'a file added later is gone again')
  assert.deepEqual(v2?.files, [file('a.tsx', 'A2'), file('b.tsx', 'B1'), file('c.tsx', 'C1')])
  assert.equal(v1?.updatedAt, 1, 'meta travels with it')
})

// The acceptance case: a budget necessarily has an edge, and the answer at the
// edge has to be "nobody can say" rather than a wrong record or a crash.
test('a revision beyond the pruned boundary reports that it is gone, and the oldest survivor is still exact', async () => {
  const { storage } = fakeStorage(seedProjects([]))
  const s = store(storage)
  // Each publish rewrites one big file, so every entry is roughly a third of
  // the per-component budget and the oldest are pruned within a few rounds.
  const big = (n: number) => file('a.tsx', `v${n}-`.padEnd(Math.floor(HISTORY_COMPONENT_BUDGET_BYTES / 3), 'x'))
  for (let v = 1; v <= 8; v++) {
    await publishFiles(s, [big(v)], v)
  }

  const entries = await s.readHistory(SOURCE, 'cp_1')
  const oldestKept = entries.at(-1)!.version

  assert.ok(entries.length >= HISTORY_KEEP_MIN, 'the floor is never crossed')
  assert.ok(oldestKept > 1, 'and something really was pruned, or this proves nothing')
  assert.equal(await s.reconstructVersion(SOURCE, 'cp_1', oldestKept - 1), null, 'past the boundary: no answer, not a wrong one')
  assert.deepEqual((await s.reconstructVersion(SOURCE, 'cp_1', oldestKept))?.files, [big(oldestKept)], 'at the boundary: exact')
})

test('the floor survives a budget of zero, because reverting one step is what history is for', async () => {
  const { storage } = fakeStorage(seedProjects([]))
  const s = store(storage)
  for (let v = 1; v <= 5; v++) {
    await publishFiles(s, [file('a.tsx', `v${v}`)], v)
  }

  const entries = await s.readHistory(SOURCE, 'cp_1')

  assert.ok(entries.length >= HISTORY_KEEP_MIN)
})

test('every publish reports what history costs, for the component and for the extension', async () => {
  const { storage, data } = fakeStorage(seedProjects([]))
  const s = store(storage)

  const first = await publishFiles(s, [file('a.tsx', 'A1')], 1)
  const second = await publishFiles(s, [file('a.tsx', 'A2')], 2)

  assert.equal(first.history.component, 0, 'a first publish replaces nothing, so it files nothing')
  assert.ok(second.history.component > 0, 'the second files one entry')
  assert.equal(second.history.extension, second.history.component, 'one component, so the two agree')
  assert.ok(second.history.extension < HISTORY_EXTENSION_CEILING_BYTES)
  assert.ok(data.get(HISTORY_INDEX_KEY), 'and the figure is kept, not recomputed by reading every key')
})

// The per-component budget bounds one component. The ceiling is what bounds
// the library, and it prunes across components rather than within one — so it
// is checked with several components already over it before a publish lands.
test('the extension-wide ceiling prunes the globally oldest entry, not the newest component"s', async () => {
  const entry = (version: number, at: number, size: number): HistoryEntry => ({
    version,
    at,
    meta: { id: `cp_${version}`, name: 'seeded' },
    order: ['a.tsx'],
    files: [file('a.tsx', 'x'.repeat(size))],
  })
  const seeded: Record<string, unknown> = { ...seedProjects([]) }
  // Three components, each holding four entries of ~250 KB: 3 MB, over the
  // ceiling before anything of ours is written. The oldest `at` is in `old`.
  for (const [name, base] of [['old', 100], ['mid', 200], ['new', 300]] as const) {
    seeded[historyKey(SOURCE, name)] = [3, 2, 1, 0].map((i) => entry(i + 1, base + i, 250_000))
  }
  const { storage } = fakeStorage(seeded)
  const s = store(storage)

  const result = await publishFiles(s, [file('a.tsx', 'A2')], 2).then(() => publishFiles(s, [file('a.tsx', 'A3')], 3))

  assert.ok(result.history.extension <= HISTORY_EXTENSION_CEILING_BYTES, `still over the ceiling: ${result.history.extension}`)
  assert.ok((await s.readHistory(SOURCE, 'old')).length < 4, 'the oldest component gave entries up first')
  for (const name of ['old', 'mid', 'new']) {
    assert.ok((await s.readHistory(SOURCE, name)).length >= HISTORY_KEEP_MIN, `${name} was pruned below the floor`)
  }
})

test('the index is rebuilt from storage when it is missing, rather than read as nothing', async () => {
  const { storage, data } = fakeStorage(seedProjects([]))
  const s = store(storage)
  await publishFiles(s, [file('a.tsx', 'A1')], 1)
  await publishFiles(s, [file('a.tsx', 'A2')], 2)
  const withIndex = (await publishFiles(s, [file('a.tsx', 'A3')], 3)).history.extension

  data.delete(HISTORY_INDEX_KEY)
  const rebuilt = (await publishFiles(s, [file('a.tsx', 'A4')], 4)).history.extension

  assert.ok(rebuilt >= withIndex, `a rebuilt index must not read as empty (was ${withIndex}, rebuilt ${rebuilt})`)
})

// ── the optimistic guard ─────────────────────────────────────────────
// It refuses a write built from a revision storage has moved past. It cannot
// prevent one: the host exposes only get and set, so the read and the write are
// two calls with a gap between them.

test('a write naming a revision that storage has moved past is refused', async () => {
  const { storage, data } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const s = store(storage)
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 50 }])

  const err = (await s
    .writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 60 }], { expect: { id: 'cp_1', updatedAt: 1 } })
    .then(() => null)
    .catch((e: StaleWriteError) => e)) as StaleWriteError

  assert.ok(err, 'the write must be refused')
  assert.equal(err.code, STALE_WRITE)
  assert.match(err.message, /50/, 'the error must say what it found, not only that it disagreed')
  assert.deepEqual(
    ((data.get(draftKey(SOURCE)) as Array<{ updatedAt: number }>) ?? []).map((c) => c.updatedAt),
    [50],
    'the refused write must change nothing',
  )
})

test('a write naming the revision it actually read is allowed through', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const s = store(storage)

  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 2 }], { expect: { id: 'cp_1', updatedAt: 1 } })

  assert.deepEqual((await s.readComponents(SOURCE)).map((c) => c.updatedAt), [2])
})

test('a write naming a component that has since been deleted is refused', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const s = store(storage)
  await s.deleteComponent(SOURCE, 'widget')

  await assert.rejects(
    s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 2 }], { expect: { id: 'cp_1', updatedAt: 1 } }),
    (e: StaleWriteError) => e.code === STALE_WRITE,
  )
})

test('publishing against a version someone else has already spent is refused', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1, version: 4 }]))
  const s = store(storage)
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 9 }])

  await assert.rejects(
    s.publishComponent(SOURCE, 'widget', { expectedVersion: 3 }),
    (e: StaleWriteError) => e.code === STALE_WRITE,
  )
  assert.equal((await s.readPublished(SOURCE))[0].updatedAt, 1, 'the refused publish must change nothing')
})

// ── the id backfill, which writes during a read ──────────────────────

test('reading a project backfills missing ids and persists them once', async () => {
  const { storage, data, componentWrites } = fakeStorage({
    [componentsKey(SOURCE)]: [{ name: 'widget' }, { id: 'cp_2', name: 'other' }],
  })
  const s = store(storage)

  const first = await s.readComponents(SOURCE)
  assert.equal(first[0].id, 'cp_backfilled_1')
  assert.deepEqual(componentWrites, [componentsKey(SOURCE)])
  assert.deepEqual(names(data.get(componentsKey(SOURCE))), ['widget', 'other'])

  await s.readComponents(SOURCE)
  assert.deepEqual(componentWrites, [componentsKey(SOURCE)], 'a second read must not write again')
})

test('the backfill write is not refused as a shrink', async () => {
  // Every record lacks an id, so none of them can be matched by one. Treating
  // an unmatchable record as removed would refuse the write that gives it an id.
  const { storage, data } = fakeStorage({ [componentsKey(SOURCE)]: [{ name: 'widget' }, { name: 'other' }] })

  const list = await store(storage).readComponents(SOURCE)

  assert.deepEqual(list.map((c) => c.id), ['cp_backfilled_1', 'cp_backfilled_2'])
  assert.deepEqual(names(data.get(componentsKey(SOURCE))), ['widget', 'other'])
})

// Draft state is overlay presence — publish's own definition — so these pin
// the reading rather than any content comparison.

test('no overlay entry means no draft, whatever the record looks like', () => {
  assert.equal(draftStateFor({ id: 'c1', name: 'x', version: 4 }, false), undefined)
})

test('a draft over a published record is ahead of that record\'s version', () => {
  assert.equal(draftStateFor({ id: 'c1', name: 'x', version: 4 }, true), 4)
})

test('a draft over a record that predates versioning is ahead of v1', () => {
  assert.equal(draftStateFor({ id: 'c1', name: 'x' }, true), 1)
})

test('a draft with no published record behind it has never been published', () => {
  assert.equal(draftStateFor(undefined, true), 'unpublished')
})

// ── versioning reads: the legacy backfill made observable, and history reporting ──

test('a legacy record (no version, no draft) reads back as version 1 with draft==published', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const result = await store(storage).listRevisions(SOURCE, 'widget')
  assert.equal(result.version, 1, 'a record from before versioning reads as version 1')
  assert.equal(result.draft, undefined, 'no overlay entry means draft==published')
  assert.equal(result.truncated, false)
  assert.deepEqual(result.revisions, [{ version: 1, filesChanged: [] }], 'one row: the head, nothing more to say')
})

test('reading a legacy record writes nothing at all', async () => {
  const { storage, data, componentWrites } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const before = JSON.stringify([...data.entries()])
  const s = store(storage)
  await s.readComponents(SOURCE)
  await s.listRevisions(SOURCE, 'widget')
  await s.changesSince(SOURCE, { since: 0 })
  assert.equal(componentWrites.length, 0, 'version is read-normalised, never backfilled by a write')
  assert.equal(JSON.stringify([...data.entries()]), before, 'storage is byte-identical after every read surface')
})

test('a never-published draft reports draft:unpublished and no version', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const s = store(storage)
  await s.writeComponents(SOURCE, [
    { id: 'cp_1', name: 'widget', updatedAt: 1 },
    { id: 'cp_2', name: 'unborn', updatedAt: 2 },
  ])
  const result = await s.listRevisions(SOURCE, 'unborn')
  assert.equal(result.version, undefined, 'no published version exists to report')
  assert.equal(result.draft, 'unpublished')
  assert.deepEqual(result.revisions, [])
})

// A clock the publish flow can advance, so publishedAt values are distinct and
// changesSince has real times to cut between.
function storeWithClock(storage: ComponentStorage, clock: { now: number }) {
  return createComponentStore<TestComponent>({
    storage,
    newId: () => `cp_fresh_${Math.random().toString(36).slice(2, 8)}`,
    now: () => clock.now,
  })
}

async function publishThree(storage: ComponentStorage, clock: { now: number }) {
  const s = storeWithClock(storage, clock)
  clock.now = 100
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 100, files: [file('a.tsx', 'a1')] }])
  await s.publishComponent(SOURCE, 'widget') // v1: created with a.tsx
  clock.now = 200
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 200, files: [file('a.tsx', 'a1'), file('b.tsx', 'b1')] }])
  await s.publishComponent(SOURCE, 'widget') // v2: adds b.tsx
  clock.now = 300
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 300, files: [file('a.tsx', 'a2'), file('b.tsx', 'b1')] }])
  await s.publishComponent(SOURCE, 'widget') // v3: edits a.tsx
  return s
}

test('listRevisions over three publishes: versions newest-first with the right changed files', async () => {
  const { storage } = fakeStorage(seedProjects([]))
  const s = await publishThree(storage, { now: 0 })
  const result = await s.listRevisions(SOURCE, 'widget')
  assert.equal(result.version, 3)
  assert.equal(result.draft, undefined, 'everything published; draft==published')
  assert.equal(result.truncated, false)
  assert.deepEqual(
    result.revisions.map((r) => ({ version: r.version, filesChanged: r.filesChanged ? [...r.filesChanged].sort() : null })),
    [
      { version: 3, filesChanged: ['a.tsx'] },
      { version: 2, filesChanged: ['b.tsx'] },
      { version: 1, filesChanged: ['a.tsx'] },
    ],
  )
  assert.equal(result.revisions[0].publishedAt, 300)
})

test('changesSince with a timestamp between publishes names the component at its current version', async () => {
  const { storage } = fakeStorage(seedProjects([]))
  const s = await publishThree(storage, { now: 0 })
  const result = await s.changesSince(SOURCE, { since: 150 })
  assert.deepEqual(result.unknown, [])
  assert.deepEqual(result.changed, [{ component: 'widget', componentId: 'cp_1', to: 3, changedAt: 300 }])
})

test('changesSince over a fresh project returns empty, not an error', async () => {
  const { storage } = fakeStorage(seedProjects([]))
  const result = await store(storage).changesSince(SOURCE, { since: 0 })
  assert.deepEqual(result, { changed: [], unknown: [] })
})

test('changesSince with a version map reports from/to, and unknown keys separately', async () => {
  const { storage } = fakeStorage(seedProjects([]))
  const s = await publishThree(storage, { now: 0 })
  const uptodate = await s.changesSince(SOURCE, { sinceVersions: { widget: 3 } })
  assert.deepEqual(uptodate.changed, [])
  const behind = await s.changesSince(SOURCE, { sinceVersions: { cp_1: 1, ghost: 2 } })
  assert.deepEqual(behind.changed, [{ component: 'widget', componentId: 'cp_1', from: 1, to: 3, changedAt: 300 }])
  assert.deepEqual(behind.unknown, ['ghost'])
})

test('changesSince refuses both forms at once, and neither', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const s = store(storage)
  await assert.rejects(s.changesSince(SOURCE, {}), /exactly one/)
  await assert.rejects(s.changesSince(SOURCE, { since: 5, sinceVersions: { widget: 1 } }), /exactly one/)
})

test('a legacy record with no publishedAt is compared by updatedAt, honestly', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 50 }]))
  const s = store(storage)
  const stale = await s.changesSince(SOURCE, { since: 60 })
  assert.deepEqual(stale.changed, [])
  const fresh = await s.changesSince(SOURCE, { since: 40 })
  assert.deepEqual(fresh.changed, [{ component: 'widget', componentId: 'cp_1', to: 1, changedAt: 50 }])
})

// Publish attribution: declared by the door, stamped on the record, and never
// inherited — a stale name is worse than no name.

test('a publish records who declared it, and the next publish does not inherit them', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1, version: 1, publishedAt: 500 }]))
  const s = store(storage)
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 9 }])

  const first = await s.publishComponent(SOURCE, 'widget', { by: { name: 'agent-a', kind: 'agent' } })
  assert.equal(first.published, true)
  let head = (await s.readPublished(SOURCE))[0] as { publishedBy?: { name: string; kind: string } }
  assert.deepEqual(head.publishedBy, { name: 'agent-a', kind: 'agent' })

  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 19, title: 'edited again' }])
  const second = await s.publishComponent(SOURCE, 'widget')
  assert.equal(second.published, true)
  head = (await s.readPublished(SOURCE))[0] as { publishedBy?: { name: string; kind: string } }
  assert.equal(head.publishedBy, undefined, 'the previous publisher must not be attributed to a publish that declared nobody')
})

test('revision rows name their publisher where one was declared, system publishers included', async () => {
  const { storage } = fakeStorage(seedProjects([{ id: 'cp_1', name: 'widget', updatedAt: 1 }]))
  const s = store(storage)

  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 9, title: 'first' }])
  await s.publishComponent(SOURCE, 'widget', { by: { name: 'agent-a', kind: 'agent' } })
  await s.writeComponents(SOURCE, [{ id: 'cp_1', name: 'widget', updatedAt: 19, title: 'second' }])
  await s.publishComponent(SOURCE, 'widget', { by: { name: 'nightly-sync', kind: 'system' } })

  const result = await s.listRevisions(SOURCE, 'widget')
  const byVersion = new Map(result.revisions.map((r) => [r.version, r.by]))
  assert.deepEqual(byVersion.get(result.version), { name: 'nightly-sync', kind: 'system' })
  assert.deepEqual(byVersion.get(result.version - 1), { name: 'agent-a', kind: 'agent' })
})
