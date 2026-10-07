// What the dashboard receives from a stored record. The registry dependencies
// are the part a consumer reads to know what else a component pulls in, so
// they are asserted as declared rather than by shape.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildRegistryItems, type StoredComponent } from './from-stored.ts'

function stored(over: Partial<StoredComponent> = {}): StoredComponent {
  return {
    name: 'widget',
    title: 'Widget',
    type: 'registry:ui',
    category: 'display',
    description: '',
    dependencies: [],
    files: [{ path: 'widget.tsx', target: 'components/ui/widget.tsx', type: 'registry:component', content: 'export const Widget = null' }],
    exportName: 'Widget',
    ...over,
  }
}

test('the declared registry dependencies reach the dashboard item', () => {
  const [item] = buildRegistryItems([stored({ registryDependencies: ['@design-kit/status-indicator', 'button'] })])

  assert.deepEqual(item?.registryDependencies, ['@design-kit/status-indicator', 'button'])
})

// A scope is what tells two same-named dependencies apart -- a library can
// declare both the external `button` and its own `@design-kit/button`, and a
// shortened label prints one chip for two different things. So the reference
// travels verbatim, in the order it was declared.
test('a reference keeps its scope, so two same-named dependencies stay distinct', () => {
  const [item] = buildRegistryItems([stored({ registryDependencies: ['button', '@design-kit/button'] })])

  assert.deepEqual(item?.registryDependencies, ['button', '@design-kit/button'])
})

// A record may carry no key at all, and the dashboard item's type says the
// array is always there.
//
// A guard, not coverage: a mapper that discarded the field would satisfy it
// too, by publishing an empty list for everything. It fails only if
// `undefined` reaches the item. The three around it catch a discarded field.
test('a record with no registry dependencies yields an empty list, never undefined', () => {
  const [item] = buildRegistryItems([stored()])

  assert.deepEqual(item?.registryDependencies, [])
})

test('every component in a project is built, each with its own dependencies', () => {
  const items = buildRegistryItems([
    stored({ name: 'a', registryDependencies: ['button'] }),
    stored({ name: 'b' }),
  ])

  assert.deepEqual(
    items.map((i) => [i.name, i.registryDependencies]),
    [['a', ['button']], ['b', []]],
  )
})
