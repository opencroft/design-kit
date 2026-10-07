// Where the editor's draft state comes from. The page reaches the platform
// host and cannot be imported by this runner, so these read the source — the
// idiom this suite uses for host-bound code, and the ceiling in this extension.
//
// What these guard against: a page holding `draftAhead` as its own state, set
// optimistically by every write and never re-derived from the reload that
// follows. Putting a file back is also a write, so a component that had come
// back to exactly what is published would go on offering Discard and Publish
// until the page was reloaded. The store would be right throughout; the screen
// would be reading a second copy.
//
// What makes it worth pinning rather than trusting: the page's OTHER readers of
// draft state derive from the record, so a held copy makes the screen disagree
// with itself — no files marked, no changed-file count, and "draft ahead"
// beside them. Reading only the correct half shows nothing wrong.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const page = () => readFileSync(new URL('../src/components/source-editor-page.tsx', import.meta.url), 'utf-8')

const handler = (source: string, start: string) => {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `${start} is gone`)
  const to = source.indexOf('\n  }, [', from)
  assert.notEqual(to, -1, `${start} has no dependency list`)
  return source.slice(from, to)
}

test('whether a draft exists is derived from the record, never held beside it', () => {
  const source = page()
  assert.match(source, /const draftAhead = record \? record\.draft !== undefined : draft !== undefined/)
  assert.ok(!/setDraftAhead/.test(source), 'the page is holding its own copy of draft state again')
  assert.ok(!/useState\([^)]*draft !== undefined/.test(source), 'draft state is state again')
})

test('the file markers derive from the record too', () => {
  assert.match(page(), /new Set\(record\?\.draftFilesChanged \?\? \[\]\)/)
})

// The derivation is only as fresh as the record, so a write that does not
// re-read leaves the screen behind exactly as a held copy would — the same
// failure through a different door.
test('every path that changes the draft re-reads the record afterwards', () => {
  const source = page()
  // AWAITED, specifically. Each of these handlers also re-reads from its catch
  // block, as `load().catch(...)` — so matching a bare `load(` is satisfied by
  // the failure path alone and would accept a handler that never re-reads when
  // the write succeeds, which is the exact edit this exists to catch.
  for (const start of [
    'const save = React.useCallback',
    'const mutateFiles = React.useCallback',
    'const doDiscard = React.useCallback',
    'const doPublish = React.useCallback',
  ]) {
    assert.match(handler(source, start), /await load\(/, `${start} does not re-read on the path that succeeded`)
  }
})
