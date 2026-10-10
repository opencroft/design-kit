// Pairing a component's files across two points in its history. What these pin
// is mostly about ABSENCE, which here has three distinct meanings that a reader
// must not collapse: a file that did not exist, a file whose content was not
// carried because nothing happened to it, and a file that exists and is empty.
// `change` is the authority on which of those it is.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareFileSets, hasChanges } from './version-diff.ts'

const file = (target: string, content: string, type = 'registry:ui') => ({ path: target, target, type, content })

test('a file present on both sides is changed or unchanged by its content', () => {
  const rows = compareFileSets(
    [file('components/ui/card.tsx', 'v1'), file('docs/doc.mdx', 'same', 'registry:ignore')],
    [file('components/ui/card.tsx', 'v2'), file('docs/doc.mdx', 'same', 'registry:ignore')],
  )
  const card = rows.find((r) => r.target === 'components/ui/card.tsx')
  assert.equal(card?.change, 'changed')
  assert.equal(card?.before, 'v1')
  assert.equal(card?.after, 'v2')
  assert.equal(rows.find((r) => r.target === 'docs/doc.mdx')?.change, 'unchanged')
})

test('a file on one side only is added or removed, with NULL for the side it is missing from', () => {
  const rows = compareFileSets([file('gone.tsx', 'old')], [file('new.tsx', 'fresh')])
  const added = rows.find((r) => r.target === 'new.tsx')
  const removed = rows.find((r) => r.target === 'gone.tsx')
  assert.equal(added?.change, 'added')
  assert.equal(added?.before, null)
  assert.equal(added?.after, 'fresh')
  assert.equal(removed?.change, 'removed')
  assert.equal(removed?.before, 'old')
  assert.equal(removed?.after, null)
})

test('an unchanged file carries NO content, and that is not the same as the file being absent', () => {
  // The three states, side by side in one result. Collapsing any two of them is
  // the failure this test exists for: "not carried" is a transport decision,
  // "null" is a fact about the version, and "" is a fact about the file.
  const rows = compareFileSets(
    [file('same.tsx', 'x'), file('empty.tsx', '')],
    [file('same.tsx', 'x'), file('empty.tsx', ''), file('added.tsx', 'new')],
  )

  const unchanged = rows.find((r) => r.target === 'same.tsx')
  assert.equal(unchanged?.change, 'unchanged')
  assert.equal(unchanged?.before, undefined)
  assert.equal(unchanged?.after, undefined)
  assert.ok(unchanged)
  assert.equal('before' in unchanged, false)

  const added = rows.find((r) => r.target === 'added.tsx')
  assert.equal(added?.before, null)
  assert.notEqual(added?.before, undefined)

  // A file that exists on both sides and is empty on both is unchanged, not
  // added and not absent — read by emptiness it would be neither.
  const empty = rows.find((r) => r.target === 'empty.tsx')
  assert.equal(empty?.change, 'unchanged')
})

test('an empty file is not a missing one — `change` is the authority, not the content', () => {
  // Both sides exist; one is empty. Read by emptiness this is "removed"; read
  // by `change` it is what it actually is, a file whose contents were deleted.
  const rows = compareFileSets([file('a.tsx', 'had content')], [file('a.tsx', '')])
  assert.equal(rows[0].change, 'changed')
  assert.equal(rows[0].after, '')
  assert.notEqual(rows[0].after, null)
})

test('unchanged files are still listed, so a caller can still say what a version holds', () => {
  const rows = compareFileSets([file('a.tsx', 'x'), file('b.tsx', 'y')], [file('a.tsx', 'x'), file('b.tsx', 'y')])
  assert.equal(rows.length, 2)
  assert.equal(hasChanges(rows), false)
  // The list survives; only the bytes are dropped.
  assert.deepEqual(
    rows.map((r) => r.target),
    ['a.tsx', 'b.tsx'],
  )
})

test('comparing two versions that differ in nothing carries no content at all', () => {
  // The worst case: a component of several files, none of them
  // changed. Every row must be content-free, or the payload is entirely waste.
  const side = [file('a.tsx', 'x'), file('b.tsx', 'y'), file('docs/doc.mdx', 'z', 'registry:ignore')]
  const rows = compareFileSets(side, side)
  assert.equal(rows.length, 3)
  assert.equal(hasChanges(rows), false)
  assert.equal(
    rows.every((r) => !('before' in r) && !('after' in r)),
    true,
  )
})

test('what changed sorts above what did not, alphabetically within each group', () => {
  const rows = compareFileSets(
    [file('z-unchanged.tsx', 'same'), file('m-removed.tsx', 'old'), file('b-changed.tsx', 'v1')],
    [file('z-unchanged.tsx', 'same'), file('a-added.tsx', 'new'), file('b-changed.tsx', 'v2')],
  )
  assert.deepEqual(
    rows.map((r) => [r.change, r.target]),
    [
      ['added', 'a-added.tsx'],
      ['removed', 'm-removed.tsx'],
      ['changed', 'b-changed.tsx'],
      ['unchanged', 'z-unchanged.tsx'],
    ],
  )
})

test('two empty sides compare to nothing rather than throwing', () => {
  assert.deepEqual(compareFileSets([], []), [])
  assert.equal(hasChanges([]), false)
})
