import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installPlan, sharedRange } from './install-plan.ts'

test('ranges one version satisfies share one range, and an unversioned declaration constrains nothing', () => {
  assert.equal(sharedRange(['^1.49.0', '^1.14.0', '']), '>=1.14.0 <2.0.0-0 >=1.49.0')
  assert.equal(sharedRange(['', '^0.4.0']), '^0.4.0')
  assert.equal(sharedRange(['^0.4.0', '^0.4.0']), '^0.4.0')
  assert.equal(sharedRange(['', '']), '')
  assert.equal(sharedRange(['latest']), 'latest')
})

test('the shared range of unions is every set of one intersected with every set of the other', () => {
  const range = sharedRange(['1.x || 2.x', '^2.1.0']) as string
  assert.ok(range.includes('||'), range)
  assert.equal(sharedRange([range, '<2.1.0']), null)
  assert.notEqual(sharedRange(['1.2 - 1.4', '^1.3.0']), null)
})

test('ranges no version satisfies, or a dist-tag beside a range, share nothing', () => {
  assert.equal(sharedRange(['^14', '^15']), null)
  assert.equal(sharedRange(['latest', '^1.0.0']), null)
})

test('a pool installs every package it can share into one prefix, each once', () => {
  const plan = installPlan([
    { spec: 'lucide-react', range: '^1.49.0' },
    { spec: 'lucide-react', range: '' },
    { spec: '@tiptap/core', range: '^3.31.4' },
    { spec: '@tiptap/pm/state', range: '^3.31.4' },
  ])
  assert.deepEqual(plan.prefixes, [
    [
      { name: '@tiptap/core', range: '^3.31.4' },
      { name: '@tiptap/pm', range: '^3.31.4' },
      { name: 'lucide-react', range: '^1.49.0' },
    ],
  ])
  assert.deepEqual([...plan.prefixOf.values()], [0, 0, 0, 0])
})

test('a package declared at ranges that share nothing gets a prefix per range, the rest still shared', () => {
  const plan = installPlan([
    { spec: 'marked', range: '^15' },
    { spec: 'marked', range: '^14' },
    { spec: 'cn', range: '' },
  ])
  assert.deepEqual(plan.prefixes, [
    [{ name: 'cn', range: '' }],
    [{ name: 'marked', range: '^14' }],
    [{ name: 'marked', range: '^15' }],
  ])
  assert.equal(plan.prefixOf.get('cn'), 0)
  assert.equal(plan.prefixOf.get('marked@^14'), 1)
  assert.equal(plan.prefixOf.get('marked@^15'), 2)
})
