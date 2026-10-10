// A component nobody has published must be publishable from the editor. The
// store answers 0 for it and serves a record with no version; an editor that
// read that absence as v1 would hand v1 back as the publish's expected version,
// and the store would refuse it as stale ("is at v0, you built on v1").
//
// The page that calls these imports `@opencroft/client` and cannot be loaded
// here, so the guards at the bottom read its source: they say it builds the
// base through this module and sends that base back, not that a render works.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { movedSince, publishBaseOf } from './publish-base.ts'

test('a never-published record is built on version 0, the number the store checks a publish against', () => {
  assert.deepEqual(publishBaseOf({}), { version: 0, publishedAt: 0 })
})

test('a published record is built on its own version and time', () => {
  assert.deepEqual(publishBaseOf({ version: 4, publishedAt: 1_700_000_000_000 }), {
    version: 4,
    publishedAt: 1_700_000_000_000,
  })
})

test('reading a never-published component twice is not a move', () => {
  // Opening a never-published component and publishing it must agree with
  // itself, or the editor refuses its own first publish.
  assert.equal(movedSince(publishBaseOf({}), publishBaseOf({})), false)
})

test('a first publish by someone else is a move', () => {
  assert.equal(movedSince(publishBaseOf({}), publishBaseOf({ version: 1, publishedAt: 5 })), true)
})

test('a newer version, or the same number published at another time, is a move', () => {
  const base = publishBaseOf({ version: 2, publishedAt: 5 })
  assert.equal(movedSince(base, publishBaseOf({ version: 3, publishedAt: 9 })), true)
  assert.equal(movedSince(base, publishBaseOf({ version: 2, publishedAt: 9 })), true)
  assert.equal(movedSince(base, publishBaseOf({ version: 2, publishedAt: 5 })), false)
})

// ── The page that has to use it ───────────────────────────────────────────

/** The page with its prose removed, so a comment that quotes a forbidden form
 *  does not trip the guards against it. */
const page = readFileSync(new URL('./source-editor-page.tsx', import.meta.url), 'utf-8')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

test('the page takes its publish base from the record through this module', () => {
  assert.match(page, /setBase\(rec \? publishBaseOf\(rec\) : null\)/)
})

test('the publish hands back the base it was built on', () => {
  assert.match(page, /expectedVersion: base\.version\b/)
})

test('no version is invented for a component that has none', () => {
  assert.doesNotMatch(page, /version \?\? 1\b/, 'a never-published component reads as v1 again')
})
