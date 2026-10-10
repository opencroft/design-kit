// What a delete request addresses. The property these pin: the records
// removed, the strings reported, and the records left are three views of ONE
// decision, so no run of this can remove a record it did not report or leave a
// record it said was gone.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { addresses, planDeletion } from './file-deletion.ts'

interface FileRecord {
  path: string
  target: string
  type: string
}

const ui = (path: string, target: string): FileRecord => ({ path, target, type: 'registry:ui' })

// The collision: two records sharing a path, differing only
// by target, so the shared string names both and neither can be named alone.
const COLLIDED: FileRecord[] = [
  ui('components/ui/status-indicator.tsx', 'components/ui/feedback/status-indicator.tsx'),
  ui('components/ui/status-indicator.tsx', 'components/ui/status-indicator.tsx'),
]

// The fixture has to actually collide, or every assertion below passes without
// exercising anything.
test('the collision fixture really is two records one string names', () => {
  assert.equal(COLLIDED[0].path, COLLIDED[1].path)
  assert.notEqual(COLLIDED[0].target, COLLIDED[1].target)
  assert.equal(COLLIDED.filter((f) => addresses(f, 'components/ui/status-indicator.tsx')).length, 2)
})

test('a string naming two records removes and reports both', () => {
  const plan = planDeletion(COLLIDED, ['components/ui/status-indicator.tsx'])
  assert.equal(plan.removed.length, 2)
  assert.deepEqual(plan.removed, COLLIDED)
  assert.deepEqual(plan.remaining, [])
  assert.deepEqual(plan.missing, [])
})

// The orphan half. Removing the stored file of only whichever record `find`
// reaches first, while silently dropping the rest from the record, leaves a file
// with nothing pointing at it. The store removes a file per entry in
// `removed`, so this is the assertion that rules it out.
test('every record dropped is in `removed`, so every one of their files is accounted for', () => {
  const plan = planDeletion(COLLIDED, ['components/ui/status-indicator.tsx'])
  const dropped = COLLIDED.filter((f) => !plan.remaining.includes(f))
  assert.deepEqual(plan.removed, dropped)
})

test('a record is addressed by its target as well as by its path', () => {
  const files = [ui('button.tsx', 'components/ui/button.tsx'), ui('card.tsx', 'components/ui/card.tsx')]
  assert.deepEqual(planDeletion(files, ['components/ui/button.tsx']).removed, [files[0]])
  assert.deepEqual(planDeletion(files, ['button.tsx']).removed, [files[0]])
})

test('the records a request does not name are untouched, in their original order', () => {
  const files = [
    ui('a.tsx', 'components/ui/a.tsx'),
    ui('b.tsx', 'components/ui/b.tsx'),
    ui('c.tsx', 'components/ui/c.tsx'),
  ]
  const plan = planDeletion(files, ['components/ui/b.tsx'])
  assert.deepEqual(plan.removed, [files[1]])
  assert.deepEqual(plan.remaining, [files[0], files[2]])
  assert.deepEqual(plan.deleted, ['components/ui/b.tsx'])
})

test('a string naming nothing is reported missing and removes nothing', () => {
  const files = [ui('a.tsx', 'components/ui/a.tsx')]
  const plan = planDeletion(files, ['components/ui/nope.tsx'])
  assert.deepEqual(plan.removed, [])
  assert.deepEqual(plan.remaining, files)
  assert.deepEqual(plan.deleted, [])
  assert.deepEqual(plan.missing, ['components/ui/nope.tsx'])
})

test('a hit and a miss in one request are each reported on their own side', () => {
  const files = [ui('a.tsx', 'components/ui/a.tsx')]
  const plan = planDeletion(files, ['components/ui/a.tsx', 'components/ui/nope.tsx'])
  assert.deepEqual(plan.deleted, ['components/ui/a.tsx'])
  assert.deepEqual(plan.missing, ['components/ui/nope.tsx'])
  assert.deepEqual(plan.removed, files)
})

// Both strings named the same record. It must go once, not twice — the store
// removes one stored file per entry, and a duplicate would be a second removal
// of a path that is already gone.
test('two strings naming one record remove it once and both count as deleted', () => {
  const files = [ui('a.tsx', 'components/ui/a.tsx'), ui('b.tsx', 'components/ui/b.tsx')]
  const plan = planDeletion(files, ['a.tsx', 'components/ui/a.tsx'])
  assert.deepEqual(plan.removed, [files[0]])
  assert.deepEqual(plan.deleted, ['a.tsx', 'components/ui/a.tsx'])
  assert.deepEqual(plan.remaining, [files[1]])
})

test('an empty request removes nothing and reports nothing', () => {
  const files = [ui('a.tsx', 'components/ui/a.tsx')]
  const plan = planDeletion(files, [])
  assert.deepEqual(plan.removed, [])
  assert.deepEqual(plan.deleted, [])
  assert.deepEqual(plan.missing, [])
  assert.deepEqual(plan.remaining, files)
})

// The invariant the whole module exists for, stated once over every fixture
// above: removed and remaining partition the input, every removed record is
// named by a requested string, and no remaining record is.
test('removed and remaining partition the records, and nothing is on the wrong side', () => {
  const cases: Array<{ files: FileRecord[]; requests: string[] }> = [
    { files: COLLIDED, requests: ['components/ui/status-indicator.tsx'] },
    { files: COLLIDED, requests: ['components/ui/feedback/status-indicator.tsx'] },
    { files: COLLIDED, requests: [] },
    {
      files: [ui('a.tsx', 'components/ui/a.tsx'), ui('b.tsx', 'components/ui/b.tsx')],
      requests: ['a.tsx', 'components/ui/nope.tsx'],
    },
  ]
  for (const { files, requests } of cases) {
    const plan = planDeletion(files, requests)
    assert.equal(plan.removed.length + plan.remaining.length, files.length)
    for (const file of plan.removed) {
      assert.ok(
        requests.some((r) => addresses(file, r)),
        `removed a record no request names: ${file.target}`,
      )
    }
    for (const file of plan.remaining) {
      assert.ok(!requests.some((r) => addresses(file, r)), `kept a record a request names: ${file.target}`)
    }
    for (const request of plan.deleted) {
      assert.ok(
        plan.removed.some((f) => addresses(f, request)),
        `reported deleted with nothing removed: ${request}`,
      )
    }
    for (const request of plan.missing) {
      assert.ok(!files.some((f) => addresses(f, request)), `reported missing while a record matches: ${request}`)
    }
  }
})

// An ignored file is stored somewhere else entirely (see component-paths), but
// it is addressed the same way, and its record has to come back in `removed`
// carrying its type so the store can work out where its file lives.
test('a record of any type is carried through unchanged', () => {
  const doc = { path: 'docs/doc.mdx', target: 'docs/doc.mdx', type: 'registry:ignore' }
  const plan = planDeletion([doc, ui('a.tsx', 'components/ui/a.tsx')], ['docs/doc.mdx'])
  assert.deepEqual(plan.removed, [doc])
  assert.equal(plan.removed[0]?.type, 'registry:ignore')
})

// The store applies the plan; nothing above can see whether it does, because
// repo-store.ts reaches the host and cannot be imported here. So the body is
// read as text, the way this suite already pins the registry control union —
// the one check that runs in a repository with no typecheck.
//
// What it guards against is a second selection rule living inside deleteFiles
// alongside the first: two rules disagree silently for as long as no component
// has two records one string names.
test('the store selects with the plan and nothing else', () => {
  const source = readFileSync(new URL('./repo-store.ts', import.meta.url), 'utf8')
  const body = source.match(/export async function deleteFiles\([\s\S]*?\n}/)
  // Without this the check passes by finding nothing the moment the function is
  // renamed or reshaped, which is the failure the whole test exists to catch.
  assert.ok(body, 'could not find deleteFiles in repo-store.ts — this check would silently stop checking')
  const text = body[0]
  assert.equal((text.match(/planDeletion\(/g) ?? []).length, 1, 'the record selection is decided more than once')
  assert.match(text, /for \(const entry of plan\.removed\)/, 'a stored file is removed per record the plan removed')
  assert.match(text, /files: plan\.remaining/, 'what is persisted is what the plan left')
  // A `.find` or a second `.filter` over the records here is not necessarily
  // wrong, but it is the shape of a second selection rule, so it has to be
  // looked at rather than merged.
  assert.doesNotMatch(text, /\.find\(/, 'deleteFiles selects records again with its own find')
  assert.doesNotMatch(text, /meta\.files\.filter\(/, 'deleteFiles selects records again with its own filter')
})
