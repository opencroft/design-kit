// What a batch of renames decides. The properties here are the two the action
// promises: it is atomic, and it changes paths and never content. Both are
// decisions about the whole batch, which is why they are made in one place
// before anything is written.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { type MovableFile, planMoves } from './file-moves.ts'

const NAME = 'my-component'
const ui = (path: string): MovableFile => ({ path, target: path, type: 'registry:component' })
const doc = (path: string): MovableFile => ({ path, target: path, type: 'registry:ignore' })

const ONE = ui('components/ui/one.tsx')
const TWO = ui('components/ui/two.tsx')

test('an ordinary rename moves the file and rewrites the record', () => {
  const plan = planMoves(NAME, [ONE, TWO], [{ from: ONE.target, to: 'components/ui/renamed.tsx' }])
  assert.deepEqual(plan.moves, [{ from: ONE.target, to: 'components/ui/renamed.tsx' }])
  assert.deepEqual(
    plan.files.map((f) => f.target),
    ['components/ui/renamed.tsx', TWO.target],
  )
})

// Writing a file to its own storage path and then removing that path is a
// delete, while the record would go on declaring it.
test('a rename to where the file already is moves nothing', () => {
  const plan = planMoves(NAME, [ONE, TWO], [{ from: ONE.target, to: ONE.target }])
  assert.deepEqual(plan.moves, [])
  assert.deepEqual(
    plan.files.map((f) => f.target),
    [ONE.target, TWO.target],
  )
})

test('the record still updates when the spelling changes but the storage path does not', () => {
  // An ignored file stores under the component, so its declared path can be
  // rewritten without the content going anywhere.
  const sub = { path: 'docs/a.mdx', target: 'docs/a.mdx', type: 'registry:ignore' }
  const plan = planMoves(NAME, [sub], [{ from: 'docs/a.mdx', to: 'docs/a.mdx' }])
  assert.deepEqual(plan.moves, [])
  assert.equal(plan.files[0].target, 'docs/a.mdx')
})

// Performed, this would silently lose content, and it would leave a duplicated
// target that lets a delete address two records at once.
test('a move onto another file of the same component is refused', () => {
  assert.throws(() => planMoves(NAME, [ONE, TWO], [{ from: ONE.target, to: TWO.target }]), /already a file of component/)
})

test('the refusal leaves the caller a record that still declares both files', () => {
  const files = [ONE, TWO]
  assert.throws(() => planMoves(NAME, files, [{ from: ONE.target, to: TWO.target }]))
  assert.deepEqual(
    files.map((f) => f.target),
    [ONE.target, TWO.target],
    'the input was mutated by a refused plan',
  )
})

test('a source the component does not have is refused, and first', () => {
  assert.throws(() => planMoves(NAME, [ONE], [{ from: 'components/ui/nope.tsx', to: 'x.tsx' }]), /no file "components\/ui\/nope\.tsx"/)
})

// Atomicity, as a property of the plan: a batch that cannot be satisfied
// produces no moves at all, so nothing reaches the working tree.
test('a batch whose later request is bad plans nothing at all', () => {
  assert.throws(() =>
    planMoves(NAME, [ONE, TWO], [
      { from: ONE.target, to: 'components/ui/renamed.tsx' },
      { from: 'components/ui/nope.tsx', to: 'components/ui/other.tsx' },
    ]),
  )
})

test('a file renamed twice in one batch moves once, end to end', () => {
  const plan = planMoves(NAME, [ONE], [
    { from: ONE.target, to: 'components/ui/mid.tsx' },
    { from: 'components/ui/mid.tsx', to: 'components/ui/final.tsx' },
  ])
  assert.deepEqual(plan.moves, [{ from: ONE.target, to: 'components/ui/final.tsx' }])
  assert.equal(plan.files[0].target, 'components/ui/final.tsx')
})

test('a rename undone inside the same batch moves nothing', () => {
  const plan = planMoves(NAME, [ONE], [
    { from: ONE.target, to: 'components/ui/mid.tsx' },
    { from: 'components/ui/mid.tsx', to: ONE.target },
  ])
  assert.deepEqual(plan.moves, [])
})

test('two files can swap names, and both moves are reported', () => {
  const plan = planMoves(NAME, [ONE, TWO], [
    { from: ONE.target, to: 'components/ui/tmp.tsx' },
    { from: TWO.target, to: ONE.target },
    { from: 'components/ui/tmp.tsx', to: TWO.target },
  ])
  assert.deepEqual(plan.moves.sort((a, b) => a.from.localeCompare(b.from)), [
    { from: ONE.target, to: TWO.target },
    { from: TWO.target, to: ONE.target },
  ])
})

test('a request matches by declared path as well as by served target', () => {
  const split = { path: 'a.tsx', target: 'components/ui/a.tsx', type: 'registry:component' }
  const plan = planMoves(NAME, [split], [{ from: 'a.tsx', to: 'components/ui/b.tsx' }])
  assert.deepEqual(plan.moves, [{ from: 'components/ui/a.tsx', to: 'components/ui/b.tsx' }])
})

test('an ignored file keeps its internal storage root when it moves', () => {
  const plan = planMoves(NAME, [doc('docs/a.mdx')], [{ from: 'docs/a.mdx', to: 'docs/b.mdx' }])
  assert.deepEqual(plan.moves, [{ from: `internal/${NAME}/docs/a.mdx`, to: `internal/${NAME}/docs/b.mdx` }])
})

// The store reaches the platform host and cannot be imported by this runner, so
// the wiring is asserted against the source read as text — the idiom this suite
// already uses for host-bound code.
test('the store plans the whole batch before it writes anything', () => {
  const source = readFileSync(new URL('./repo-store.ts', import.meta.url), 'utf-8')
  const body = source.slice(source.indexOf('export async function moveFiles'), source.indexOf('export async function renameComponent'))
  assert.match(body, /const plan = planMoves\(name, meta\.files, moves\)/)
  // Every read before any write, which is what makes a refusal leave nothing
  // behind. Asserted as "the gathering loop contains no write", because
  // comparing where each first appears is satisfied by a write moved INTO that
  // loop — the exact edit this is meant to catch.
  const gathering = body.slice(body.indexOf('const carried'), body.indexOf('for (const file of carried)'))
  assert.ok(gathering.length > 0, 'the content-gathering loop is gone')
  assert.ok(!gathering.includes('writeWorking'), 'the batch writes while it is still reading')
  assert.match(body, /for \(const file of carried\) \{\s*await writeWorking\(dir, file\.to, file\.content\)/)
  // And no per-move write/remove pair survives inside the planning loop.
  assert.ok(!/for \(const m of moves\)/.test(body), 'the store is walking the raw requests again')
})

test('the store removes only the sources nothing moved into', () => {
  const source = readFileSync(new URL('./repo-store.ts', import.meta.url), 'utf-8')
  const body = source.slice(source.indexOf('export async function moveFiles'), source.indexOf('export async function renameComponent'))
  assert.match(body, /const destinations = new Set\(plan\.moves\.map\(\(m\) => m\.to\)\)/)
  assert.match(body, /if \(!destinations\.has\(move\.from\)\)/)
})
