// Publish pressed while the last edit is still being saved must still publish.
// Dropping the press whenever a save is in flight does nothing at all: no
// request, no spinner, no message.
//
// The page that runs these steps imports `@opencroft/client` and cannot be
// loaded here, so the guards at the bottom read its source: they say the press
// goes through this rule rather than being decided beside it, not that a click
// in a browser works.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { nextPublishStep } from './publish-queue.ts'

test('a press during a save waits for it instead of being dropped', () => {
  assert.equal(nextPublishStep({ saving: true, saveFailed: false, dirty: false }), 'wait')
  assert.equal(nextPublishStep({ saving: true, saveFailed: false, dirty: true }), 'wait')
})

test('typing that has not reached the draft is stored before anything is published', () => {
  assert.equal(nextPublishStep({ saving: false, saveFailed: false, dirty: true }), 'save')
})

test('a stored draft is published', () => {
  assert.equal(nextPublishStep({ saving: false, saveFailed: false, dirty: false }), 'publish')
})

test('a failed save stops the press rather than publishing without what is on screen', () => {
  assert.equal(nextPublishStep({ saving: false, saveFailed: true, dirty: true }), 'stop')
  assert.equal(nextPublishStep({ saving: false, saveFailed: true, dirty: false }), 'stop')
})

test('every combination reaches an answer, and only a settled draft publishes', () => {
  for (const saving of [true, false]) {
    for (const saveFailed of [true, false]) {
      for (const dirty of [true, false]) {
        const step = nextPublishStep({ saving, saveFailed, dirty })
        assert.ok(['wait', 'save', 'stop', 'publish'].includes(step))
        assert.equal(step === 'publish', !saving && !saveFailed && !dirty, `${saving}/${saveFailed}/${dirty}`)
      }
    }
  }
})

// ── The page that has to use it ───────────────────────────────────────────

const page = readFileSync(new URL('./source-editor-page.tsx', import.meta.url), 'utf-8')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

test('Publish and Try again queue the press rather than deciding it themselves', () => {
  assert.match(page, /onPublish=\{requestPublish\}/)
  assert.match(page, /onRetry=\{requestPublish\}/)
})

test('no press is dropped because a save is in flight', () => {
  // The form that drops it: a guard on `saving` in front of a direct publish.
  assert.doesNotMatch(page, /!saving[^\n]*\)\s*\{\s*void doPublish\(\)/, 'a press is dropped while saving again')
})

test('the queued press is carried through by the step rule', () => {
  assert.match(page, /nextPublishStep\(\{ saving, saveFailed: saveError !== null, dirty \}\)/)
})

test('a queued press shows as publishing', () => {
  assert.match(page, /publish=\{publishQueued \? 'busy' : publish\}/)
})
