// The component state token. What these pin is the property the token rests
// on: it is a function of what is STAGED and of nothing else, so a draft that
// comes back to an earlier state comes back to its earlier token. A stamp
// cannot do that — two honest writes advance it and the record can never
// return to its committed bytes, which leaves a component marked as having
// unpublished work with nothing differing.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { stateToken } from './component-state.ts'

// Index entries in the shape `git ls-files -s` reports: mode, object id, stage,
// path. The object id is what carries the content, which is why editing a file
// and putting it back reproduces the entry exactly.
const entry = (oid: string, path: string) => `100644 ${oid} 0\t${path}`

const RECORD = entry('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'registry/thing.json')
const SOURCE = entry('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'components/ui/thing.tsx')
const SOURCE_EDITED = entry('cccccccccccccccccccccccccccccccccccccccc', 'components/ui/thing.tsx')

const published = [RECORD, SOURCE].join('\n')
const edited = [RECORD, SOURCE_EDITED].join('\n')

test('the same staged state gives the same token', () => {
  assert.equal(stateToken(published), stateToken(published))
})

test('an edited file gives a different token', () => {
  assert.notEqual(stateToken(edited), stateToken(published))
})

// The one that matters. Everything else here is arithmetic; this is the
// behaviour that rules out a stored stamp. Salting the token with a clock, a
// counter or a write id would pass every other test in this file and fail
// this one.
test('a draft put back where it started gets its first token back', () => {
  const before = stateToken(published)
  const during = stateToken(edited)
  const after = stateToken(published)
  assert.notEqual(during, before)
  assert.equal(after, before)
})

test('a file added or removed changes it, so the file set is part of the state', () => {
  const withDocs = [RECORD, SOURCE, entry('dddddddddddddddddddddddddddddddddddddddd', 'internal/thing/docs/doc.mdx')].join('\n')
  assert.notEqual(stateToken(withDocs), stateToken(published))
  assert.notEqual(stateToken([RECORD].join('\n')), stateToken(published))
})

test('the record counts too — a metadata-only edit moves the token', () => {
  const renamed = [entry('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'registry/thing.json'), SOURCE].join('\n')
  assert.notEqual(stateToken(renamed), stateToken(published))
})

test('order counts — two components cannot swap entries and read the same', () => {
  assert.notEqual(stateToken([SOURCE, RECORD].join('\n')), stateToken(published))
})

test('no staged paths is a state, not an absence', () => {
  assert.equal(typeof stateToken(''), 'string')
  assert.notEqual(stateToken(''), stateToken(published))
})

test('the token is opaque and short enough to put in an error a person reads', () => {
  const token = stateToken(published)
  assert.match(token, /^[0-9a-f]{16}$/)
})

// The store reaches the platform host and cannot be imported by this runner, so
// the wiring is asserted against the source read as text — the idiom this suite
// already uses for host-bound code.
test('the store derives the token from the same paths the draft marker reads', () => {
  const source = readFileSync(new URL('./repo-store.ts', import.meta.url), 'utf-8')
  assert.match(source, /stateToken\(await stagedState\(dir, componentPaths\(meta\.name, meta\.files\)\)\)/)
})

test('no last-modified stamp survives anywhere in the store', () => {
  const source = readFileSync(new URL('./repo-store.ts', import.meta.url), 'utf-8')
  assert.ok(!/\bupdatedAt\b/.test(source), 'the record is carrying a last-modified field again')
})

// A caller passing the retired `expectedUpdatedAt` parameter would have it
// ignored and get an unguarded write, having explicitly asked to be guarded.
// The refusal is what makes that fail closed, and it has to be on the wrapper
// every instance action goes through rather than on the six that happen to
// accept a token today.
test('a call still naming the old parameter is refused, on the shared wrapper', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8')
  const onRepo = source.slice(source.indexOf('const onRepo ='), source.indexOf('function assertNotLegacyRevision'))
  assert.match(onRepo, /assertNotLegacyRevision\(params\)/)
  assert.match(source, /expectedUpdatedAt` was replaced by `expectedState`/)
})

// A supplied token and no token are different requests, and only one of them
// means "write unguarded". Filtering the empty string to absent would give an
// unguarded write to a caller who believed they had asked for a guard — the
// same failure as the refusal above, reached by `?? ''` rather than by a
// caller naming a retired parameter.
test('an empty state is carried to the guard, not filtered into no guard', () => {
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8')
  const reader = index.slice(index.indexOf('const appParamState ='))
  assert.ok(!/expectedState !== ''/.test(reader.slice(0, reader.indexOf('\n\n'))), 'the empty string is being filtered out again')

  const store = readFileSync(new URL('./repo-store.ts', import.meta.url), 'utf-8')
  const guard = store.slice(store.indexOf('async function assertFresh'))
  assert.match(guard.slice(0, guard.indexOf('\n}')), /expectedState === ''/)
})

// The index is what both the marker and this token read, so a write that does
// not stage is a change neither can see. Pinned here rather than left as an
// expectation.
test('every draft write stages what it wrote', () => {
  const source = readFileSync(new URL('./component-repo.ts', import.meta.url), 'utf-8')
  const writeWorking = source.slice(source.indexOf('export async function writeWorking'))
  assert.match(writeWorking.slice(0, writeWorking.indexOf('\n}')), /git\(dir, 'add', '--', path\)/)
})
