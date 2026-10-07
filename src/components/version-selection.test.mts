// The selection rule: a selection is a set of versions and the comparison
// shows what those versions introduced.
//
// The rule's table gets one test each, because the endpoints reading (plain
// A → B) agrees with the rule on every single-point selection and differs on
// every range — so a test exercising one point would pass against either and
// pin neither.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { comparisonFor, pointsOf, type SelectionComparison, type TimelinePoint } from './version-selection.ts'

const published = (...versions: number[]) => pointsOf(versions.map((version) => ({ version })), false)
const withDraft = (...versions: number[]) => pointsOf(versions.map((version) => ({ version })), true)

/** The comparison, or a failure naming what came back instead. */
function ok(points: TimelinePoint[], floor: number, from: number, to: number): Extract<SelectionComparison, { status: 'ok' }> {
  const c = comparisonFor(points, floor, from, to)
  assert.equal(c?.status, 'ok', `expected a comparison, got ${JSON.stringify(c)}`)
  return c as Extract<SelectionComparison, { status: 'ok' }>
}

test('the timeline runs oldest first, whatever order the versions arrive in', () => {
  assert.deepEqual(
    pointsOf([{ version: 3 }, { version: 1 }, { version: 2 }], false),
    [
      { at: 1, label: 'v1' },
      { at: 2, label: 'v2' },
      { at: 3, label: 'v3' },
    ],
  )
})

test('the draft is the newest point, after every published version', () => {
  assert.deepEqual(withDraft(1, 2), [
    { at: 1, label: 'v1' },
    { at: 2, label: 'v2' },
    { at: 'draft', label: 'Draft' },
  ])
})

test('v1 alone compares against nothing — the component begins there', () => {
  assert.deepEqual(ok(published(1, 2, 3), 1, 0, 0), {
    status: 'ok',
    from: 'none',
    to: 1,
    fromLabel: 'nothing',
    selectionLabel: 'v1',
  })
})

test('v2 alone compares v1 with v2', () => {
  assert.deepEqual(ok(published(1, 2, 3), 1, 1, 1), {
    status: 'ok',
    from: 1,
    to: 2,
    fromLabel: 'v1',
    selectionLabel: 'v2',
  })
})

test('v1–v2 compares against nothing, so it carries v1 own changes as well as v2 ones', () => {
  assert.deepEqual(ok(published(1, 2, 3), 1, 0, 1), {
    status: 'ok',
    from: 'none',
    to: 2,
    fromLabel: 'nothing',
    selectionLabel: 'v1–v2',
  })
})

test('v2–v3 compares v1 with v3 — not v2 with v3, which is the endpoints reading', () => {
  assert.deepEqual(ok(published(1, 2, 3), 1, 1, 2), {
    status: 'ok',
    from: 1,
    to: 3,
    fromLabel: 'v1',
    selectionLabel: 'v2–v3',
  })
})

test('the whole timeline compares against nothing, so every file reads as added', () => {
  assert.deepEqual(ok(published(1, 2, 3), 1, 0, 2), {
    status: 'ok',
    from: 'none',
    to: 3,
    fromLabel: 'nothing',
    selectionLabel: 'v1–v3',
  })
})

test('no selection ever compares its own two ends', () => {
  const points = published(1, 2, 3, 4)
  for (let from = 0; from < points.length; from += 1) {
    for (let to = from; to < points.length; to += 1) {
      assert.notEqual(ok(points, 1, from, to).from, points[from].at, `selection ${from}..${to} compared its own lower end`)
    }
  }
})

test('the draft alone compares the last published version with the draft', () => {
  assert.deepEqual(ok(withDraft(1, 2), 1, 2, 2), {
    status: 'ok',
    from: 2,
    to: 'draft',
    fromLabel: 'v2',
    selectionLabel: 'Draft',
  })
})

test('v2–draft compares v1 with the draft, by the same rule and no rule of its own', () => {
  assert.deepEqual(ok(withDraft(1, 2), 1, 1, 2), {
    status: 'ok',
    from: 1,
    to: 'draft',
    fromLabel: 'v1',
    selectionLabel: 'v2–Draft',
  })
})

test('a component that has never been published compares its draft against nothing', () => {
  assert.deepEqual(ok(withDraft(), 0, 0, 0), {
    status: 'ok',
    from: 'none',
    to: 'draft',
    fromLabel: 'nothing',
    selectionLabel: 'Draft',
  })
})

test('a selection reaching the earliest version held is refused when the project holds nothing below it', () => {
  // Answering "nothing → v6" here would report every file as added at v6, and
  // read as the complete history of a component that has five versions below
  // the floor this project happens to hold.
  assert.deepEqual(comparisonFor(published(6, 7, 8), 6, 0, 1), { status: 'predatesHistory', floor: 6, selectionLabel: 'v6–v7' })
})

test('above that floor the same project answers normally', () => {
  assert.deepEqual(ok(published(6, 7, 8), 6, 1, 2), {
    status: 'ok',
    from: 6,
    to: 8,
    fromLabel: 'v6',
    selectionLabel: 'v7–v8',
  })
})

test('beginning at v1 and being truncated above it are different answers, not one "nothing below"', () => {
  assert.equal(comparisonFor(published(1, 2), 1, 0, 0)?.status, 'ok')
  assert.equal(comparisonFor(published(2, 3), 2, 0, 0)?.status, 'predatesHistory')
})

test('a selection addressing no point is null rather than a comparison of nothing', () => {
  assert.equal(comparisonFor([], 0, 0, 0), null)
  assert.equal(comparisonFor(published(1), 1, 0, 4), null)
})
