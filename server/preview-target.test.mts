// Each Open button on a doc page opens its own block: pressing it on an
// example must not open the component's main preview instead. The other cases
// are here too — a link with no target in it opens the main preview, and a
// name that is not in the document is refused rather than substituted.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { docFilesOf, docTargets, isResolved, resolvePreviewTarget } from './preview-target.ts'

const MDX = `Some prose.

<Preview src="./preview.tsx" controls={[{ name: 'size', kind: 'enum', options: ['sm', 'lg'], default: 'lg' }]} />

More prose.

<Sheet prop="size" values={['sm', 'lg']} />

<Example src="./examples/with-icon.tsx" title="With an icon" />

<Example src="./examples/disabled.tsx" />
`

const DOCS: Record<string, string> = {
  'doc.mdx': MDX,
  'preview.tsx': 'export default function Preview() { return <Thing /> }',
  'examples/with-icon.tsx': '<Thing icon />',
  'examples/disabled.tsx': '<Thing disabled />',
}

test('each example resolves to its OWN code, not the main preview', () => {
  const icon = resolvePreviewTarget(MDX, DOCS, 'example:examples/with-icon.tsx')
  const disabled = resolvePreviewTarget(MDX, DOCS, 'example:examples/disabled.tsx')
  assert.ok(isResolved(icon) && isResolved(disabled))
  assert.equal(icon.code, '<Thing icon />')
  assert.equal(disabled.code, '<Thing disabled />')
  assert.notEqual(icon.code, disabled.code)
})

test('an example renders as a snippet, a preview as a default export', () => {
  const example = resolvePreviewTarget(MDX, DOCS, 'example:examples/disabled.tsx')
  const preview = resolvePreviewTarget(MDX, DOCS, 'preview')
  assert.ok(isResolved(example) && isResolved(preview))
  assert.equal(example.mode, 'snippet')
  assert.equal(preview.mode, 'default-export')
})

test('a preview opens on its controls’ defaults, an example carries no props', () => {
  const preview = resolvePreviewTarget(MDX, DOCS, 'preview')
  const example = resolvePreviewTarget(MDX, DOCS, 'example:examples/disabled.tsx')
  assert.ok(isResolved(preview) && isResolved(example))
  assert.deepEqual(preview.props, { size: 'lg' })
  assert.equal(example.props, undefined)
})

test('a link with no target still opens the main preview', () => {
  for (const asked of [null, undefined, '', '  ']) {
    const result = resolvePreviewTarget(MDX, DOCS, asked)
    assert.ok(isResolved(result), `expected ${JSON.stringify(asked)} to resolve`)
    assert.equal(result.target, 'preview:preview.tsx')
  }
})

test('a <Preview> is addressable by its own src, so a second one is reachable', () => {
  const two = `<Preview src="./preview.tsx" controls={[]} />\n<Preview src="./alt.tsx" controls={[]} />\n`
  const docs = { 'doc.mdx': two, 'preview.tsx': 'FIRST', 'alt.tsx': 'SECOND' }
  const bare = resolvePreviewTarget(two, docs, 'preview')
  const alt = resolvePreviewTarget(two, docs, 'preview:alt.tsx')
  assert.ok(isResolved(bare) && isResolved(alt))
  assert.equal(bare.code, 'FIRST')
  assert.equal(alt.code, 'SECOND')
})

test('a name the document does not offer is refused, with what it does offer', () => {
  const result = resolvePreviewTarget(MDX, DOCS, 'example:examples/nope.tsx')
  assert.ok(!isResolved(result))
  assert.match(result.error, /No documented preview named/)
  assert.deepEqual(result.available, [
    'preview:preview.tsx',
    'example:examples/with-icon.tsx',
    'example:examples/disabled.tsx',
  ])
})

test('a sheet is not addressable — it has no source of its own to open', () => {
  const result = resolvePreviewTarget(MDX, DOCS, 'sheet:size')
  assert.ok(!isResolved(result))
  assert.ok(!result.available.some((t) => t.startsWith('sheet:')))
})

test('a document with no <Preview> refuses the default rather than substituting an example', () => {
  const mdx = '<Example src="./examples/only.tsx" />\n'
  const result = resolvePreviewTarget(mdx, { 'doc.mdx': mdx, 'examples/only.tsx': 'ONLY' }, '')
  assert.ok(!isResolved(result))
  assert.deepEqual(result.available, ['example:examples/only.tsx'])
})

test('a target whose file is gone says which file, and is not an empty render', () => {
  const result = resolvePreviewTarget(MDX, { 'doc.mdx': MDX }, 'preview')
  assert.ok(!isResolved(result))
  assert.match(result.error, /missing file: \.\/preview\.tsx/)
})

test('targets are named the way the validator names them', () => {
  assert.deepEqual(docTargets(MDX), [
    'preview:preview.tsx',
    'example:examples/with-icon.tsx',
    'example:examples/disabled.tsx',
  ])
})

test('docFilesOf keys by docs-relative path and keeps the component source out', () => {
  const map = docFilesOf([
    { target: 'components/ui/thing.tsx', content: 'SOURCE' },
    { target: 'docs/doc.mdx', content: 'DOC' },
    { path: 'docs/examples/a.tsx', content: 'A' },
  ])
  assert.deepEqual(map, { 'doc.mdx': 'DOC', 'examples/a.tsx': 'A' })
})
