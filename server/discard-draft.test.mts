// Discarding a draft. The store reaches the platform host and cannot be
// imported by this runner, so these read the source — the idiom this suite
// already uses for host-bound code, and the ceiling in this extension.
//
// What they pin is deliberately narrow: the three properties that would each
// regress silently, where the behaviour looks unchanged from the call site and
// only shows up as a draft that will not go away.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const repo = () => readFileSync(new URL('./component-repo.ts', import.meta.url), 'utf-8')
const store = () => readFileSync(new URL('./repo-store.ts', import.meta.url), 'utf-8')

const bodyOf = (source: string, start: string) => {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `${start} is gone`)
  return source.slice(from, source.indexOf('\n}', from))
}

// `git checkout -- <path>` restores from the INDEX, and every draft write
// stages what it wrote — so that form restores a saved edit onto itself, and
// fails outright against a staged deletion because the path is no longer in
// the index. Naming HEAD is what makes a discard work, and nothing about the
// call site would look wrong if it were dropped.
test('a discard restores from the published head, not from the index', () => {
  const discard = bodyOf(repo(), 'export async function discardWorking')
  assert.match(discard, /git\(dir, 'checkout', 'HEAD', '--', path\)/)
  assert.ok(!/git\(dir, 'checkout', '--', path\)/.test(discard), 'restoring from the index again')
})

// The record is a path like any other, and it is the one that decides whether
// the component still reads as having unpublished work. A discard that put the
// files back and left the record behind would look like it worked and leave
// the draft marker lit.
test('a discard takes its paths from the set that includes the registry record', () => {
  const body = bodyOf(store(), 'export async function discardDraft')
  assert.match(body, /await readOwnedPaths\(dir, meta\)/)
})

// `readOwnedPaths` is what both commit sites use. A second spelling of "which
// paths are this component's" is free to drift from the first, so the discard
// must not grow its own.
test('the discard does not build its own path set', () => {
  const body = bodyOf(store(), 'export async function discardDraft')
  assert.ok(!/componentPaths\(/.test(body), 'the discard is assembling its own path set')
  assert.ok(!/meta\.files\.map/.test(body), 'the discard is walking the declared files itself')
})

// The editor holds typed-but-unsaved text per path and autosaves it at a pause.
// After a discard those buffers are edits over files that no longer hold what
// they were typed over, so leaving them puts the discarded work straight back
// at the next autosave — the user presses Discard and watches the draft return.
// Nothing about the call site would look wrong.
test('discarding clears the editor buffers, or the draft comes straight back', () => {
  const page = readFileSync(new URL('../src/components/source-editor-page.tsx', import.meta.url), 'utf-8')
  const body = page.slice(page.indexOf('const doDiscard'), page.indexOf('\n  }, [projectId, componentName, load])'))
  assert.notEqual(body.length, 0, 'the discard handler is gone')
  assert.match(body, /setEdits\(\{\}\)/)
  // The handler does not clear the draft marker by hand, and must not: the
  // marker is derived from the record, and the re-read below is what makes it
  // true. `editor-draft-state.test.mts` pins both the derivation and the
  // re-read; the buffer is this test's own subject.
  assert.match(body, /await load\(\{ rebase: true \}\)/)
})

test('a component with nothing published is refused rather than emptied', () => {
  const body = bodyOf(store(), 'export async function discardDraft')
  assert.match(body, /if \(!\(await readHeadRecord\(dir, meta\)\)\)/)
  assert.match(body, /never been published/)
})
