// The two directions of a component's file layout. What these pin is that they
// are inverses: whatever the store wrote a file as, reading it back gives the
// author their own declared path again, because a history entry naming the
// internal storage root would be naming something no author ever typed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  componentPaths,
  declaredPath,
  type FilePlacement,
  metaPath,
  ownedPaths,
  storagePath,
} from './component-paths.ts'

test('a shipped file stores at its served target', () => {
  assert.equal(
    storagePath('node-card', { path: 'node-card.tsx', target: 'components/ui/node-card.tsx', type: 'registry:ui' }),
    'components/ui/node-card.tsx',
  )
  // Target wins over path; path is the fallback when no target was declared.
  assert.equal(storagePath('node-card', { path: 'node-card.tsx', type: 'registry:ui' }), 'node-card.tsx')
})

test('an ignored file is stored under the component, because its path repeats across every component', () => {
  assert.equal(
    storagePath('node-card', { path: 'docs/doc.mdx', type: 'registry:ignore' }),
    'internal/node-card/docs/doc.mdx',
  )
  assert.equal(
    storagePath('other-card', { path: 'docs/doc.mdx', type: 'registry:ignore' }),
    'internal/other-card/docs/doc.mdx',
  )
})

test('declaredPath is the inverse of storagePath for both kinds of file', () => {
  const files = [
    { path: 'node-card.tsx', target: 'components/ui/node-card.tsx', type: 'registry:ui' },
    { path: 'docs/doc.mdx', type: 'registry:ignore' },
    { path: 'docs/preview.tsx', type: 'registry:ignore' },
  ]
  for (const file of files) {
    const stored = storagePath('node-card', file)
    assert.equal(declaredPath('node-card', stored), file.target ?? file.path)
  }
})

test('declaredPath strips only THIS component’s internal root', () => {
  // A different component's stored path is not this component's to unwrap, and
  // returning it half-stripped would name a file that does not exist.
  assert.equal(declaredPath('node-card', 'internal/other-card/docs/doc.mdx'), 'internal/other-card/docs/doc.mdx')
  // A shipped path that merely mentions the word is untouched.
  assert.equal(declaredPath('node-card', 'components/ui/internal-note.tsx'), 'components/ui/internal-note.tsx')
})

// ── The scope of a component's DRAFT ───────────────────────
//
// What the draft record declares, and nothing else. This is the narrower of
// the two scopes and the right answer only for questions about the draft.

test('a component owns its registry record and every file it declares — nothing else', () => {
  assert.deepEqual(
    componentPaths('node-card', [
      { path: 'node-card.tsx', target: 'components/ui/node-card.tsx', type: 'registry:ui' },
      { path: 'docs/doc.mdx', type: 'registry:ignore' },
    ]),
    ['registry/node-card.json', 'components/ui/node-card.tsx', 'internal/node-card/docs/doc.mdx'],
  )
})

test('a component with no files still owns its record, which is what makes it exist', () => {
  assert.deepEqual(componentPaths('node-card', []), [metaPath('node-card')])
})

test('the scope never reaches a name-sharing neighbour', () => {
  // Component names that share a prefix are common, so this is a case that
  // exists rather than one imagined for the test.
  const mine = componentPaths('source-thing', [{ path: 'docs/doc.mdx', type: 'registry:ignore' }])
  const neighbour = componentPaths('source-thing-header', [{ path: 'docs/doc.mdx', type: 'registry:ignore' }])
  assert.deepEqual(
    mine.filter((p) => neighbour.includes(p)),
    [],
  )
})

// ── The scope of a COMMIT ──────────────────────────────────
//
// The draft scope plus what the published head still holds and the draft has
// let go of. Both halves are asserted because both can fail: too narrow
// leaves a staged removal no commit picks up, too wide carries a neighbour's
// file into someone else's commit. Neither failure says anything at the time.

/** Every path except those named is still in the tree. */
const goneExcept = (present: string[]) => (path: string) => !present.includes(path)

const CARD = { path: 'node-card.tsx', target: 'components/ui/node-card.tsx', type: 'registry:ui' }
const BADGE = { path: 'badge.tsx', target: 'components/ui/badge.tsx', type: 'registry:ui' }
const DOC = { path: 'docs/doc.mdx', type: 'registry:ignore' }

/** The head filing this component under the same name it has now. */
const asPublished = (files: FilePlacement[]) => ({ name: 'node-card', files })

test('a path the head declares and the draft has dropped is covered — the removal nothing else can pick up', async () => {
  // Published with two files, then the second was deleted from the draft. The
  // component has no future record that will ever name it again.
  assert.deepEqual(
    await ownedPaths(asPublished([CARD]), asPublished([CARD, BADGE]), goneExcept(['components/ui/node-card.tsx'])),
    ['registry/node-card.json', 'components/ui/node-card.tsx', 'components/ui/badge.tsx'],
  )
})

test('a dropped ignored file is covered at its storage path, not the path its author typed', async () => {
  assert.deepEqual(
    await ownedPaths(asPublished([CARD]), asPublished([CARD, DOC]), goneExcept(['components/ui/node-card.tsx'])),
    ['registry/node-card.json', 'components/ui/node-card.tsx', 'internal/node-card/docs/doc.mdx'],
  )
})

test('a dropped path that EXISTS again is left alone — it belongs to whoever declares it now', async () => {
  // The head says this component shipped it; the draft does not; the file is
  // back in the tree, so a neighbour re-declared it. Sweeping it here would
  // commit someone else's file under this component's change.
  assert.deepEqual(
    await ownedPaths(
      asPublished([CARD]),
      asPublished([CARD, BADGE]),
      goneExcept(['components/ui/node-card.tsx', 'components/ui/badge.tsx']),
    ),
    ['registry/node-card.json', 'components/ui/node-card.tsx'],
  )
})

test('a path both the draft and the head declare appears once', async () => {
  assert.deepEqual(await ownedPaths(asPublished([CARD]), asPublished([CARD]), goneExcept([])), [
    'registry/node-card.json',
    'components/ui/node-card.tsx',
  ])
})

test('the tree is never consulted about a path the draft declares', async () => {
  // A draft file is this component's by declaration. Were presence in the tree
  // allowed to decide it, a component would lose its own files from its commit
  // whenever the tree disagreed — which is exactly the state a delete is in.
  const asked: string[] = []
  await ownedPaths(asPublished([CARD, DOC]), asPublished([CARD, DOC, BADGE]), (path) => {
    asked.push(path)
    return true
  })
  assert.deepEqual(asked, ['components/ui/badge.tsx'])
})

test('an unpublished component owns exactly what its draft declares', async () => {
  assert.deepEqual(await ownedPaths(asPublished([CARD]), null, goneExcept([])), [
    'registry/node-card.json',
    'components/ui/node-card.tsx',
  ])
})

test('a component deleted whole still covers what the head held', async () => {
  // The delete case: the draft record is read before the files come out, so
  // the draft half is its full declared set and the head half is whatever it
  // had already let go of.
  assert.deepEqual(await ownedPaths(asPublished([CARD]), asPublished([CARD, BADGE]), goneExcept([])), [
    'registry/node-card.json',
    'components/ui/node-card.tsx',
    'components/ui/badge.tsx',
  ])
})

// ── When the head files this component under another name ──
//
// A rename changes what a component is called and keeps what it IS. The head
// goes on holding its old registry record, and unless something takes the
// freed name, no later record will name that path — so if this rule does not
// reach it, nothing does, and the registry serves one component under two
// names indefinitely.

const RENAMED = { name: 'node-panel', files: [CARD, DOC] }
const UNDER_OLD_NAME = { name: 'node-card', files: [CARD, DOC] }

test('a renamed component owns the registry record it was published under', async () => {
  // Everything the old name still holds at head, and nothing else. Note the
  // shipped file is NOT renamed: its path is the target its author declared,
  // which is why a stale record left at head goes on resolving to a working
  // component.
  assert.deepEqual(await ownedPaths(RENAMED, UNDER_OLD_NAME, goneExcept(['components/ui/node-card.tsx'])), [
    'registry/node-panel.json',
    'components/ui/node-card.tsx',
    'internal/node-panel/docs/doc.mdx',
    'registry/node-card.json',
    'internal/node-card/docs/doc.mdx',
  ])
})

test('a rename that changes nothing else adds exactly one path — the old record', async () => {
  assert.deepEqual(
    await ownedPaths(
      { name: 'node-panel', files: [CARD] },
      { name: 'node-card', files: [CARD] },
      goneExcept(['components/ui/node-card.tsx']),
    ),
    ['registry/node-panel.json', 'components/ui/node-card.tsx', 'registry/node-card.json'],
  )
})

test('a head path still in the tree is left alone; the rest of the old record still goes', async () => {
  // The rule here is the predicate's, not the search's: ownedPaths sweeps only
  // what the tree actually lost. The old registry record is back in the tree —
  // a new component was created at the freed name — so it stays, because
  // sweeping it would delete a live component's record inside this one's
  // commit. The old internal path is gone, is still this component's, and goes.
  //
  // That scenario does not reach this rule through the integration, and the
  // name above deliberately does not claim it does. Once a new draft holds the
  // freed name, readHeadRecord's documented narrowing skips it and finds no
  // head record at all — so the old internal path is left at head as well.
  // What is pinned below is the rule; covering the scenario end to end needs
  // the narrowing gone.
  assert.deepEqual(
    await ownedPaths(RENAMED, UNDER_OLD_NAME, goneExcept(['components/ui/node-card.tsx', 'registry/node-card.json'])),
    [
      'registry/node-panel.json',
      'components/ui/node-card.tsx',
      'internal/node-panel/docs/doc.mdx',
      'internal/node-card/docs/doc.mdx',
    ],
  )
})

test('a component whose head record is not found owns only its draft', async () => {
  // What a first publish looks like, and what a rename must NOT look like: no
  // head record means nothing of this component is published under any name.
  assert.deepEqual(await ownedPaths(RENAMED, null, goneExcept([])), [
    'registry/node-panel.json',
    'components/ui/node-card.tsx',
    'internal/node-panel/docs/doc.mdx',
  ])
})
