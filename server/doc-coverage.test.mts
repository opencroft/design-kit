// The two vacuous-green defects, pinned as a table.
//
// Both are the same failure from opposite sides: a verdict computed from
// targets cannot fail over a document that produced none, and a control kind
// outside the permitted set is not in the set of things that can fail.
// The cases that must KEEP passing are here too, and they are the ones that
// decide whether the check survives contact: a component documented later, a
// document that is deliberately all prose, and a page that shows tag syntax
// inside a code fence. Failing any of those makes the check noise, and a noisy
// check is what gets switched off.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { CONTROL_KINDS, docCoverage, truncatedMessage, unknownControlKinds } from './doc-coverage.ts'

test('a document with no doc.mdx at all is absent, not a failure', () => {
  assert.deepEqual(docCoverage(undefined, 0), { state: 'absent' })
})

test('a document that declares no tags is prose, not a failure', () => {
  assert.deepEqual(docCoverage('Just an explanation.\n', 0), { state: 'prose' })
})

test('a document whose tags all parsed is covered', () => {
  const mdx = '<Preview src="./preview.tsx" />\n\nWords.\n\n<Example src="./examples/basic.tsx" />\n'
  assert.deepEqual(docCoverage(mdx, 2), { state: 'covered', declared: 2, parsed: 2 })
})

// The defect. An apostrophe inside a controls expression ends the attribute
// early, the tag never closes, and the parser pushes the remainder of the file
// as one markdown segment and stops -- so the document declares tags and
// yields none of them, while reporting ok because nothing could fail.
test('a document that declares tags and parsed none of them is truncated', () => {
  const mdx = [
    `<Preview src="./preview.tsx" controls={[{ name: 'label', kind: 'text', default: '', description: 'the user's name' }]} />`,
    '',
    'Everything from that tag onwards is read as prose.',
    '',
    '<Example src="./examples/basic.tsx" />',
  ].join('\n')
  assert.deepEqual(docCoverage(mdx, 0), { state: 'truncated', declared: 2, parsed: 0 })
})

// The case a "zero targets" check would miss entirely: the break happens AFTER
// a valid tag, so the document renders something, reports one healthy target,
// and silently discards the rest.
test('a document that parsed only the tags before the break is still truncated', () => {
  const mdx = '<Preview src="./preview.tsx" />\n\n<Sheet prop="size" values={[]} />\n\n<Example src="./e.tsx" />\n'
  assert.deepEqual(docCoverage(mdx, 1), { state: 'truncated', declared: 3, parsed: 1 })
})

// Docs demonstrate their own syntax. Counting a tag that is being SHOWN would
// report every such page as truncated -- the false positive that would get
// this check removed within a week.
test('tags inside a fenced code block are being shown, not declared', () => {
  const mdx = ['Write it like this:', '', '```', '<Preview src="./preview.tsx" />', '```', '', 'That is all.'].join('\n')
  assert.deepEqual(docCoverage(mdx, 0), { state: 'prose' })
})

test('a tag inside inline code is being shown, not declared', () => {
  assert.deepEqual(docCoverage('Use `<Sheet prop="size" />` for a sweep.\n', 0), { state: 'prose' })
})

test('a fence carrying a language tag is still a fence', () => {
  const mdx = ['```tsx', '<Preview src="./preview.tsx" />', '```', '', 'Done.'].join('\n')
  assert.deepEqual(docCoverage(mdx, 0), { state: 'prose' })
})

// Standard CommonMark, and not the fence character anyone reaches for first --
// which is exactly why it has to be handled rather than assumed absent.
test('a tilde fence is a fence', () => {
  const mdx = ['~~~', '<Preview src="./preview.tsx" />', '~~~', '', 'Done.'].join('\n')
  assert.deepEqual(docCoverage(mdx, 0), { state: 'prose' })
})

// Standard markdown, and the shape a doc gets when someone indents an example
// under a list item.
test('a four-space indented block is a code block', () => {
  const mdx = ['Write it like this:', '', '    <Preview src="./preview.tsx" />', '', 'That is all.'].join('\n')
  assert.deepEqual(docCoverage(mdx, 0), { state: 'prose' })
})

test('a tab-indented block is a code block', () => {
  const mdx = ['Write it like this:', '', '\t<Example src="./e.tsx" />', '', 'That is all.'].join('\n')
  assert.deepEqual(docCoverage(mdx, 0), { state: 'prose' })
})

// The most natural way to turn a tag off for a moment, and something doc
// authors do constantly. Reporting a commented-out tag as a discarded one
// would fire on ordinary editing.
test('a tag inside a JSX comment is disabled, not declared', () => {
  const mdx = ['{/* <Preview src="./preview.tsx" /> */}', '', 'Still being written.'].join('\n')
  assert.deepEqual(docCoverage(mdx, 0), { state: 'prose' })
})

test('a multi-line JSX comment is disabled too', () => {
  const mdx = ['{/*', '  <Preview src="./preview.tsx" />', '  <Example src="./e.tsx" />', '*/}', '', 'Words.'].join('\n')
  assert.deepEqual(docCoverage(mdx, 0), { state: 'prose' })
})

// The counter must still see a real tag sitting next to a shown one, or the
// stripping has bought coverage by going blind.
test('a real tag beside a shown one is still counted', () => {
  const mdx = ['```', '<Preview src="./shown.tsx" />', '```', '', '<Preview src="./real.tsx" />'].join('\n')
  assert.deepEqual(docCoverage(mdx, 1), { state: 'covered', declared: 1, parsed: 1 })
  assert.deepEqual(docCoverage(mdx, 0), { state: 'truncated', declared: 1, parsed: 0 })
})

test('the truncated message names both counts and what causes it', () => {
  const message = truncatedMessage({ state: 'truncated', declared: 3, parsed: 1 })
  assert.match(message, /declares 3/)
  assert.match(message, /produced 1/)
  assert.match(message, /2 were discarded/)
  assert.match(message, /apostrophe/)
})

// Reads the union rather than restating it. Asserting the constant equals a
// literal is the code agreeing with itself, and the consequence of drift is
// severe: an unrecognised kind is a hard failure, so a kind added to the union
// without touching the constant turns every document using it red.
//
// A type-level pin would be the usual answer and cannot work here -- this
// repository has no tsconfig and no typecheck script, so nothing would ever
// evaluate it. This runs in the suite that actually runs.
test('the permitted control kinds are exactly the ones the registry union declares', () => {
  const source = readFileSync(new URL('../src/registry/types.ts', import.meta.url), 'utf8')
  const union = source.match(/export type Control =([\s\S]*?)(?=\n\nexport |\n\n\/\/)/)
  // Both guards matter: if the union is renamed or reshaped, this test would
  // otherwise pass by finding nothing, which is the exact failure the rest of
  // this file exists to catch.
  assert.ok(union, 'could not find the Control union — this check would silently stop checking')
  const declared = [...new Set([...union[1].matchAll(/kind:\s*'([^']+)'/g)].map((m) => m[1]))]
  assert.ok(declared.length > 0, 'found the union but no kinds inside it')
  assert.deepEqual([...CONTROL_KINDS].sort(), declared.sort())
})

test('a control kind outside the permitted set is reported by control and by value', () => {
  const controls = [
    { name: 'label', kind: 'string', default: 'x' },
    { name: 'size', kind: 'enum', options: ['sm'], default: 'sm' },
  ]
  assert.deepEqual(unknownControlKinds(controls), [{ control: 'label', kind: 'string' }])
})

test('every permitted kind passes', () => {
  const controls = CONTROL_KINDS.map((kind, i) => ({ name: `c${i}`, kind }))
  assert.deepEqual(unknownControlKinds(controls), [])
})

// A control with no kind at all is as unusable as one with a wrong kind, and
// it is the shape a hand-edited doc produces most easily.
test('a control with a missing kind is reported rather than skipped', () => {
  assert.deepEqual(unknownControlKinds([{ name: 'label', default: 'x' }]), [
    { control: 'label', kind: 'undefined' },
  ])
})

test('an unnamed control is still reported, named as unnamed', () => {
  assert.deepEqual(unknownControlKinds([{ kind: 'nope' }]), [{ control: '(unnamed)', kind: 'nope' }])
})

test('no controls at all is not a finding', () => {
  assert.deepEqual(unknownControlKinds([]), [])
})
