// The rule: a component that has never been published is not offered Discard,
// and no confirmation names a version that does not exist.
//
// Four inputs, and all four are asserted, because refusing the never-published
// case must leave the three working cases where they are. The one that matters
// most is draft-with-no-published-version: it is the only combination where
// the control has something to discard and nowhere to discard it to, and every wrong answer to it — offering the act, or refusing
// it with the other state's sentence — is a sentence somebody reads.
//
// The rest of this rule lives in files that import `@opencroft/client` and cannot be
// imported here, so the source-text guards at the bottom say only that they
// ask this function rather than answering for themselves. They cannot see a
// render; that is a person in front of the screen.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { discardAvailability } from './discard-availability.ts'

test('no draft is nothing to discard, whether or not anything was ever published', () => {
  assert.deepEqual(discardAvailability(false, 3), { available: false, title: 'Nothing to discard' })
  assert.deepEqual(discardAvailability(false, null), { available: false, title: 'Nothing to discard' })
})

test('a draft over a published version is the act being offered', () => {
  assert.deepEqual(discardAvailability(true, 3), {
    available: true,
    title: 'Take every file back to the published version',
  })
})

test('an absent version is as good as a null one', () => {
  // Not hypothetical: a caller that coerces a null value delivers an absent
  // prop. A strict check here would report the never-published state as
  // offerable.
  assert.deepEqual(discardAvailability(true, undefined), discardAvailability(true, null))
  assert.equal(discardAvailability(true, undefined).available, false)
})

test('a draft with nothing published is refused, and not called nothing to discard', () => {
  // The case that matters most. Both halves are asserted: the control is not
  // offered, AND the reason is about the missing far end rather than about a draft the
  // person can see on their screen.
  const availability = discardAvailability(true, null)
  assert.equal(availability.available, false)
  assert.notEqual(availability.title, 'Nothing to discard')
  assert.match(availability.title, /no published version/)
})

test('no refusal states a version', () => {
  // A confirmation saying "goes back to v1" on a component with no v1 is an
  // invented version. A number reaching any of these titles is that same
  // invention in a different sentence.
  for (const draftAhead of [true, false]) {
    for (const publishedVersion of [null, 1, 7]) {
      const { available, title } = discardAvailability(draftAhead, publishedVersion)
      if (!available) {
        assert.doesNotMatch(title, /\d/, `"${title}" names a number`)
      }
    }
  }
})

test('every combination has both an answer and a sentence', () => {
  for (const draftAhead of [true, false]) {
    for (const publishedVersion of [null, 1]) {
      const availability = discardAvailability(draftAhead, publishedVersion)
      assert.equal(typeof availability.available, 'boolean')
      assert.ok(availability.title.length > 0, 'a state with no sentence')
    }
  }
})

// ── The three files that have to use it ───────────────────────────────────

/** A file with its prose removed — JSX comment blocks first, then line and
 *  block comments. The guards below forbid tokens these comments are entitled
 *  to discuss, so matching the raw file would fail on the explanation of why
 *  the code does not do that. */
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf-8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

const dialog = read('./source-editor-discard.tsx')
const header = read('./source-editor-header.tsx')
const page = read('./source-editor-page.tsx')

test('the dialog has no way to be open without a version', () => {
  // The structural half of the rule. An `open` flag beside a number permits a
  // state that is not real — shown, with nothing to go back to — and a caller
  // that reached it would fill the gap itself.
  assert.doesNotMatch(dialog, /\bopen\b/, 'the dialog has a flag that can be set independently of its version')
  // Loose, and it has to stay loose: "no version" can arrive as an absent prop
  // rather than a null one, so a strict check shows a dialog naming nothing.
  //
  // Written against the comparison rather than one spelling of it, so the same
  // condition expressed the other way round or as a named value still passes.
  // Correct code failing an assertion about correct code is the moment
  // somebody edits the code to satisfy the test.
  assert.match(dialog, /version [!=]= null/, 'the dialog no longer compares its version loosely')
  assert.doesNotMatch(dialog, /version [!=]== null/, 'the absent form no longer closes the dialog')
})

test('the dialog does not supply a version of its own', () => {
  assert.doesNotMatch(dialog, /version\s*\?\?/, 'the dialog defaults its own version')
  assert.doesNotMatch(dialog, /v\{version \|\|/, 'the dialog defaults its own version')
})

test('the header asks for availability rather than deciding it beside the title', () => {
  assert.match(header, /discardAvailability\(/)
  assert.doesNotMatch(header, /title=\{draftAhead \?/, 'the title is decided apart from the condition again')
})

test('the page reads the version it discards to rather than supplying one', () => {
  assert.match(page, /const discardTarget = record\?\.version \?\? null/)
})

test('no substituted version reaches the act', () => {
  // None is in this file: the header says "never published" for a component
  // with no published version. A substitute here is a version the store does
  // not have, on the screen or in a request.
  assert.equal(page.split('record?.version ?? 1').length - 1, 0, 'a version substitute is back')
  assert.match(page, /version=\{discardOpen \? discardTarget : null\}/)
})
