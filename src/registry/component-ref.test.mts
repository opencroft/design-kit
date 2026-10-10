// The component-reference grammar. It is what a shared link and an install
// command are built out of, so both separators, the halves they divide, and
// the precedence between a reference and a loose pair are asserted directly
// rather than through a route.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  componentRefFromQuery,
  formatComponentRef,
  parseComponentRef,
  projectFromQuery,
  stripItemSuffix,
} from './component-ref.ts'

const query = (search: string) => new URL(`https://example.invalid/r${search}`)

test('a dot divides the project from the component', () => {
  assert.deepEqual(parseComponentRef('acme.status-indicator'), { project: 'acme', name: 'status-indicator' })
})

test('a slash divides them the same way, so either form addresses one component', () => {
  assert.deepEqual(parseComponentRef('acme/status-indicator'), parseComponentRef('acme.status-indicator'))
})

test('a project storage id works in place of the namespace', () => {
  assert.deepEqual(parseComponentRef('dp_1a2b3c/status-indicator'), { project: 'dp_1a2b3c', name: 'status-indicator' })
})

// Component and project slugs are hyphenated, and only the FIRST separator
// divides the reference -- a hyphen is not a separator, and a name that
// somehow carried a second dot stays whole.
test('only the first separator divides, so hyphens and later dots stay in the name', () => {
  assert.deepEqual(parseComponentRef('my-product/chat-list-item'), { project: 'my-product', name: 'chat-list-item' })
  assert.deepEqual(parseComponentRef('my-product.chat.list'), { project: 'my-product', name: 'chat.list' })
})

test('a reference with only one half is not a reference', () => {
  for (const raw of [
    'status-indicator',
    'acme/',
    'acme.',
    '/status-indicator',
    '.status-indicator',
    '',
    '   ',
    null,
    undefined,
  ]) {
    assert.equal(parseComponentRef(raw), null, `expected ${JSON.stringify(raw)} to be rejected`)
  }
})

test('surrounding whitespace from a pasted link does not become part of the reference', () => {
  assert.deepEqual(parseComponentRef('  acme/status-indicator  '), { project: 'acme', name: 'status-indicator' })
})

// A registry client appends `.json` when it resolves an item through a URL
// template, so that suffix travels on real requests. It is dropped from the
// WHOLE reference before the separator is looked for: strip it from the name
// half afterwards instead, and a bare `<name>.json` reads as a complete
// two-part reference, sending the caller to project "<name>", component
// "json".
test('a .json suffix names the same item, in either separator form', () => {
  assert.deepEqual(parseComponentRef('acme/status-indicator.json'), { project: 'acme', name: 'status-indicator' })
  assert.deepEqual(parseComponentRef('acme.status-indicator.json'), { project: 'acme', name: 'status-indicator' })
  assert.equal(stripItemSuffix('status-indicator.json'), 'status-indicator')
  assert.equal(stripItemSuffix('status-indicator'), 'status-indicator')
})

test('a bare item name carrying the suffix is a half-reference, not a project called by its name', () => {
  assert.equal(parseComponentRef('status-indicator.json'), null)
})

test('a reference is written with the dot, and reads back as itself', () => {
  const written = formatComponentRef('acme', 'status-indicator')

  assert.equal(written, 'acme.status-indicator')
  assert.deepEqual(parseComponentRef(written), { project: 'acme', name: 'status-indicator' })
})

// ── reading a reference off a URL ────────────────────────────────────

test('a route reads the component from a reference, or from the separate pair', () => {
  assert.deepEqual(componentRefFromQuery(query('?component=acme.status-indicator')), {
    project: 'acme',
    name: 'status-indicator',
  })
  assert.deepEqual(componentRefFromQuery(query('?project=acme&name=status-indicator')), {
    project: 'acme',
    name: 'status-indicator',
  })
  assert.deepEqual(componentRefFromQuery(query('?project=acme&name=status-indicator.json')), {
    project: 'acme',
    name: 'status-indicator',
  })
})

test('half a pair addresses nothing', () => {
  assert.equal(componentRefFromQuery(query('?project=acme')), null)
  assert.equal(componentRefFromQuery(query('?name=status-indicator')), null)
  assert.equal(componentRefFromQuery(query('')), null)
})

// The item route resolves a reference and then delegates to the index route
// when the client asked for the reserved index name -- one query string, read
// by two routes. If they disagreed about which half wins, the same request
// would act in two different projects.
test('a reference outranks a loose project, and both readers agree on that', () => {
  const both = query('?project=other&component=acme.status-indicator')

  assert.equal(componentRefFromQuery(both)?.project, 'acme')
  assert.equal(projectFromQuery(both), 'acme')
})

test('the project half is reachable on its own, from either form', () => {
  assert.equal(projectFromQuery(query('?component=acme.status-indicator')), 'acme')
  assert.equal(projectFromQuery(query('?project=acme')), 'acme')
  assert.equal(projectFromQuery(query('')), '')
})
