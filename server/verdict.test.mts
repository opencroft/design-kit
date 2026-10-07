// The vacuous pass, pinned: a component with an unresolvable import and no doc
// page has nothing that renders it, so its only target is its own evaluation —
// which succeeds with the binding undefined. That must not validate green.
//
// The cases that must KEEP passing are here too, and they are the ones that
// decide whether this survives contact. `ComponentProps (from 'react')` is
// unresolved on a correct, fully rendering component — a type imported without
// the `type` keyword is indistinguishable from a missing runtime value once
// imports are stripped, so the list cannot tell a defect from a style choice,
// and a check that fires on healthy components is one that gets ignored.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  diagnosticsFromOtherGroups,
  isRenderTarget,
  judge,
  readValidationSummary,
  summarizeValidation,
  type TargetOutcome,
  type ValidateTarget,
  verdictOf,
} from './verdict.ts'

const target = (name: string, outcome: TargetOutcome, extra: Partial<ValidateTarget> = {}): ValidateTarget => ({
  target: name,
  outcome,
  unresolvedImports: [],
  ...extra,
})

const MISSING = "AgentCommandBar (from '@/components/command-bar')"
const TYPE_ONLY = "ComponentProps (from 'react')"

// What the validator produces for a component authored source-first: its files
// evaluate, and nothing in the project renders it.
const noDocPage: ValidateTarget[] = [
  target('source', 'ok', { unresolvedImports: [MISSING] }),
  target('render', 'unverifiable', { error: 'no docs/doc.mdx — nothing here renders this component, so only its evaluation was checked' }),
]

// A documented component that renders, carrying the type-only import every
// component written to the shadcn convention carries.
const documented: ValidateTarget[] = [
  target('source', 'ok', { unresolvedImports: [TYPE_ONLY] }),
  target('preview', 'ok'),
  target('sheet:variant', 'ok'),
  target('example:examples/all-variants.tsx', 'ok'),
]

test('a component nothing rendered is unverified, though no target failed', () => {
  assert.equal(verdictOf(noDocPage), 'unverified')
  // The discriminating half: without this line the assertion above could pass
  // against a rule that never said anything different.
  assert.equal(
    noDocPage.every((t) => t.outcome !== 'error'),
    true,
    'no target failed, so a "no target failed" boolean would report ok:true for this exact component',
  )
})

test('the summary of an unverified component says so, names the import, and never claims a render', () => {
  const { verdict, summary } = judge(noDocPage, [MISSING])
  assert.equal(verdict, 'unverified')
  assert.match(summary, /not verified/)
  assert.match(summary, /nothing rendered this component/)
  assert.match(summary, /AgentCommandBar/)
  assert.doesNotMatch(summary, /rendering/)
  assert.doesNotMatch(summary, /sibling/)
})

test('a rendering component stays ok, with its unresolved type import named rather than failed', () => {
  const { verdict, summary } = judge(documented, [])
  assert.equal(verdict, 'ok')
  assert.match(summary, /4\/4 targets checked/)
  assert.match(summary, /ComponentProps/)
  assert.match(summary, /import type/)
  // Reads the same whether one import is named or several.
  assert.doesNotMatch(summary, /they are/)
})

test('an error outranks a missing render — a broken component is broken, not unchecked', () => {
  const broken = [target('source', 'error', { error: 'Unexpected token' }), target('render', 'unverifiable', { error: 'no docs/doc.mdx' })]
  assert.equal(verdictOf(broken), 'error')
  assert.match(judge(broken, []).summary, /1 failed/)
})

// The SECOND unverified population, and the one nobody will be looking for: a
// component that HAS a doc page, whose render targets all came back
// unverifiable. An unverifiable target has never failed anything, so this is
// easy to read as passing. Nothing rendered it, so it is not a pass.
test('render targets that could not run here leave the component unverified, not passing', () => {
  const browserOnly = [
    target('source', 'ok'),
    target('preview', 'unverifiable', { error: 'matchMedia is not defined' }),
  ]
  assert.equal(verdictOf(browserOnly), 'unverified')
  assert.equal(
    browserOnly.every((t) => t.outcome !== 'error'),
    true,
    'no target failed, so a "no target failed" boolean would call this one a pass as well',
  )
})

test('no targets at all is unverified — the emptiest case must not be the greenest', () => {
  const { verdict, summary } = judge([], [])
  assert.equal(verdict, 'unverified')
  assert.match(summary, /0\/0 targets checked/)
})

test('only a real render counts as one', () => {
  assert.equal(isRenderTarget('preview'), true)
  assert.equal(isRenderTarget('example:examples/sizes.tsx'), true)
  assert.equal(isRenderTarget('sheet:variant'), true)
  // 'render' is the placeholder that reports the ABSENCE of a render; counting
  // it would be the vacuous pass under a new name.
  assert.equal(isRenderTarget('render'), false)
  assert.equal(isRenderTarget('source'), false)
  assert.equal(isRenderTarget('doc.mdx'), false)
  assert.equal(isRenderTarget('control:variant'), false)
})

test('a pool entry this component also produced is not blamed on another component', () => {
  // The ordinary case: two components import the same type-only name,
  // so the pool lists it twice and both entries match this component's own.
  const pool = [TYPE_ONLY, TYPE_ONLY]
  const own = documented.find((t) => t.target === 'source')
  assert.deepEqual(diagnosticsFromOtherGroups(pool, own), [])
  assert.doesNotMatch(judge(documented, pool).summary, /other components/)
})

test('a pool entry this component could not have produced is counted as another component\'s', () => {
  const pool = [TYPE_ONLY, "Chart (from '@/components/ui/chart')"]
  const own = documented.find((t) => t.target === 'source')
  assert.deepEqual(diagnosticsFromOtherGroups(pool, own), ["Chart (from '@/components/ui/chart')"])
  assert.match(judge(documented, pool).summary, /1 diagnostics from other components/)
})

test('a component whose own evaluation threw owns that pool entry too', () => {
  const threw = [target('source', 'error', { error: 'Unexpected token' })]
  assert.deepEqual(diagnosticsFromOtherGroups(['Unexpected token'], threw[0]), [])
})

test('with no source target every pool entry belongs to somebody else', () => {
  assert.deepEqual(diagnosticsFromOtherGroups([TYPE_ONLY], undefined), [TYPE_ONLY])
})

// A summary is read at a later moment than it was written, which is the whole
// point of keeping one — and it puts three different things behind the same
// empty-looking answer. A check where nothing failed is a report; a component
// nothing ever checked has no record; and a record that cannot say what failed
// is not a report either, however much it looks like one.
test('a summary keeps the failing rows and drops the rest', () => {
  const failing = target('preview', 'error', { error: 'Element type is invalid' })
  const summary = summarizeValidation([target('source', 'ok'), failing, target('sheet:variant', 'unverifiable')], 5)
  assert.equal(summary.ok, false)
  assert.deepEqual(summary.failed, [failing])
  assert.equal(summary.at, 5)
})

test('nothing failing is a report rather than an absence', () => {
  const summary = summarizeValidation([target('preview', 'ok'), target('sheet:variant', 'unverifiable')], 5)
  assert.equal(summary.ok, true)
  assert.deepEqual(summary.failed, [])
  assert.deepEqual(readValidationSummary(summary), summary)
})

test('a summary reads back with the rows a panel needs', () => {
  const summary = summarizeValidation([target('preview', 'error', { error: 'Element type is invalid' })], 5)
  assert.deepEqual(readValidationSummary(summary), summary)
})

test('a record written under the older shape answers as no record', () => {
  // Bare target names: the field's older shape, without the validator's rows.
  // Nothing in a name can be worded as a failure, so surfacing it would put an
  // entry on screen that says only that something is wrong somewhere.
  assert.equal(readValidationSummary({ ok: false, failed: ['preview'], at: 5 }), undefined)
  assert.equal(readValidationSummary(undefined), undefined)
  // Being an object is not the property that matters — naming a target is.
  // An empty array and a row missing its target are both objects, and both
  // would have read as targets under a plain typeof check.
  assert.equal(readValidationSummary({ ok: false, failed: [{ outcome: 'error' }], at: 5 }), undefined)
  assert.equal(readValidationSummary({ ok: false, failed: [[]], at: 5 }), undefined)
})
