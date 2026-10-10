// The registry's published read-only shapes. These are a contract with
// consumers outside this repository, so the fields they promise are asserted
// by name rather than by structural comparison.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { changeSignals, isIndexRequest, REGISTRY_INDEX_NAME, shapeIndexItem, shapeProjects } from './registry-shape.ts'

const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
// Mirrors namespaceOf in server/target.ts: the stored slug is the address, and
// the display name answers only for a project that has no slug of its own.
const namespaceOf = (p: { name: string; slug?: string }) => p.slug || slugify(p.name)

test('the project list carries the id, the display name and the install namespace', () => {
  const shaped = shapeProjects(
    [
      { id: 'dp_1', name: 'Base Components' },
      { id: 'dp_2', name: 'My Product' },
    ],
    namespaceOf,
  )

  assert.deepEqual(shaped, {
    projects: [
      { id: 'dp_1', name: 'Base Components', namespace: 'base-components' },
      { id: 'dp_2', name: 'My Product', namespace: 'my-product' },
    ],
  })
})

test('an empty library still answers with a list, not an error', () => {
  assert.deepEqual(shapeProjects([], namespaceOf), { projects: [] })
})

// ── The namespace a project is published under ──
//
// A project that has a slug is published under THAT, and the display name has
// no say. The two disagree exactly when a project has been renamed since it was
// created, because a rename moves the name and deliberately leaves the address.

test('a project with a slug is published under it, not under its slugified name', () => {
  const shaped = shapeProjects([{ id: 'p_1', name: 'File Manager Extension', slug: 'stored-slug' }], namespaceOf)

  assert.deepEqual(shaped, { projects: [{ id: 'p_1', name: 'File Manager Extension', namespace: 'stored-slug' }] })
})

test('a project with no slug of its own falls back to its slugified name', () => {
  // The legacy row: its namespace genuinely IS its name slugified, because it
  // has no other address. This is the only case the fallback exists for, and
  // keeping it is what lets the two kinds of project share one list.
  const shaped = shapeProjects([{ id: 'dp_1', name: 'Base Components' }], namespaceOf)

  assert.deepEqual(shaped, { projects: [{ id: 'dp_1', name: 'Base Components', namespace: 'base-components' }] })
})

test('a slug that matches the slugified name is still read from the slug', () => {
  // Worth pinning precisely because it cannot fail by accident: while the two
  // agree, every wrong implementation also passes. The assertion below is on a
  // name that slugifies to something DIFFERENT from the slug being supplied,
  // so it distinguishes reading the slug from re-deriving it. Without that,
  // this test would be the shape of a test rather than one.
  const agreeing = shapeProjects([{ id: 'p_1', name: 'Agent Chat', slug: 'agent-chat' }], namespaceOf)
  assert.deepEqual(agreeing, { projects: [{ id: 'p_1', name: 'Agent Chat', namespace: 'agent-chat' }] })

  const renamedSince = shapeProjects([{ id: 'p_1', name: 'Agent Chat', slug: 'chat-agent' }], namespaceOf)
  assert.equal(renamedSince.projects[0].namespace, 'chat-agent')
})

test('an empty slug is not an address, so the name still answers', () => {
  const shaped = shapeProjects([{ id: 'p_1', name: 'Base Components', slug: '' }], namespaceOf)

  assert.equal(shaped.projects[0].namespace, 'base-components')
})

test('an index item carries the stable id alongside the current name', () => {
  const item = shapeIndexItem(
    {
      id: 'cp_1',
      name: 'widget',
      type: 'registry:ui',
      title: 'Widget',
      description: 'does things',
      updatedAt: 1_700_000_000_000,
    },
    [{ path: 'widget.tsx', target: 'components/ui/widget.tsx', type: 'registry:component' }],
  )

  assert.equal(item.id, 'cp_1')
  assert.equal(item.name, 'widget')
  assert.deepEqual(item.files, [{ path: 'widget.tsx', target: 'components/ui/widget.tsx', type: 'registry:component' }])
})

// The registry client validates each file entry as a discriminated union keyed
// on `type` -- an index missing it is rejected outright, before any item in it
// is read. A real client (shadcn's own CLI) fails exactly this way against an
// index whose files lack it.
test('every file in the index carries the type field the client validates against', () => {
  const item = shapeIndexItem(
    { id: 'cp_1', name: 'widget', type: 'registry:ui', title: 'Widget', description: '', updatedAt: 1_700_000_000_000 },
    [{ path: 'a.tsx', target: 'components/ui/a.tsx', type: 'registry:component' }],
  )

  assert.equal(item.files[0]?.type, 'registry:component')
})

test('the id survives a rename, so a consumer can tell one from a deletion', () => {
  const before = shapeIndexItem(
    { id: 'cp_1', name: 'widget', type: 'registry:ui', title: 'Widget', description: '', updatedAt: 1 },
    [],
  )
  const after = shapeIndexItem(
    { id: 'cp_1', name: 'gadget', type: 'registry:ui', title: 'Gadget', description: '', updatedAt: 2 },
    [],
  )

  assert.equal(before.id, after.id)
  assert.notEqual(before.name, after.name)
})

// Change signals. A consumer holding an installed copy asks "has this moved on
// since I took it?" — these are the fields it compares, and they are published
// on the index so that asking does not require fetching every item.

test('an index item carries the timestamp a consumer compares against its own copy', () => {
  const item = shapeIndexItem(
    { id: 'cp_1', name: 'widget', type: 'registry:ui', title: 'Widget', description: '', updatedAt: 1_700_000_000_000 },
    [],
  )

  assert.equal(item.updatedAt, 1_700_000_000_000)
})

// Omitted rather than defaulted: a consumer must be able to tell "this library
// does not version yet" from "this component has been published once", and any
// number at all would answer the second question.
//
// This one is a guard, not coverage. A shape that never published `version` at
// all satisfies it too, so it cannot show the field working. What it protects
// against is an edit that gives the missing case a default. The test below it
// is the one that fails if the field is not published.
test('no version field is published while a record carries none', () => {
  const item = shapeIndexItem(
    { id: 'cp_1', name: 'widget', type: 'registry:ui', title: 'Widget', description: '', updatedAt: 1 },
    [],
  )

  assert.equal('version' in item, false)
  assert.equal(Object.hasOwn(changeSignals({ updatedAt: 1 }), 'version'), false)
})

test('a version is published once a record carries one', () => {
  const item = shapeIndexItem(
    { id: 'cp_1', name: 'widget', type: 'registry:ui', title: 'Widget', description: '', updatedAt: 1, version: 3 },
    [],
  )

  assert.equal(item.version, 3)
  assert.deepEqual(changeSignals({ updatedAt: 1, version: 3 }), { updatedAt: 1, version: 3 })
})

// The signals are one definition shared by the index item and the registry
// item, so both surfaces answer the same question the same way.
test('the signals are exactly the two fields, and neither is invented', () => {
  assert.deepEqual(changeSignals({ updatedAt: 42 }), { updatedAt: 42 })
})

// The reserved name a client uses to ask one item URL for the whole index.

test('the reserved name is recognised as a request for the index', () => {
  assert.equal(isIndexRequest(REGISTRY_INDEX_NAME), true)
})

test('an ordinary component name is not a request for the index', () => {
  for (const name of ['button', 'registry-table', 'my-registry', 'Registry', 'registryitem', '']) {
    assert.equal(isIndexRequest(name), false, `expected "${name}" to be treated as an ordinary item`)
  }
})
