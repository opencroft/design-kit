import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  declaredRanges,
  moduleResolver,
  moduleSource,
  npmModuleKey,
  parseDependency,
  undeclaredPackages,
} from './declared-deps.ts'

test('a dependency entry splits into package and range, scoped names included', () => {
  assert.deepEqual(parseDependency('lucide-react@^1.14.0'), { name: 'lucide-react', range: '^1.14.0' })
  assert.deepEqual(parseDependency('@base-ui/react@^1.0.0'), { name: '@base-ui/react', range: '^1.0.0' })
  assert.deepEqual(parseDependency('@base-ui/react'), { name: '@base-ui/react', range: '' })
  assert.deepEqual(parseDependency('cn'), { name: 'cn', range: '' })
})

test('a declared package loads from npm at its declared range, subpaths included', () => {
  const declared = declaredRanges(['lucide-react@^1.14.0', '@base-ui/react@^1.0.0', 'cn'])
  assert.deepEqual(moduleSource('lucide-react', declared), { kind: 'npm', spec: 'lucide-react', range: '^1.14.0' })
  assert.deepEqual(moduleSource('@base-ui/react/popover', declared), {
    kind: 'npm',
    spec: '@base-ui/react/popover',
    range: '^1.0.0',
  })
  assert.deepEqual(moduleSource('cn', declared), { kind: 'npm', spec: 'cn', range: '' })
})

test('the React family is always built in, whatever is declared', () => {
  const declared = declaredRanges(['react@^18.0.0', 'react-dom@^18.0.0'])
  assert.deepEqual(moduleSource('react', declared), { kind: 'builtin', spec: 'react' })
  assert.deepEqual(moduleSource('react/jsx-runtime', declared), { kind: 'builtin', spec: 'react/jsx-runtime' })
  assert.deepEqual(moduleSource('react-dom/client', declared), { kind: 'builtin', spec: 'react-dom/client' })
})

test('a workspace package resolves to the unverifiable placeholder, undeclared', () => {
  assert.deepEqual(moduleSource('agent-client/types', declaredRanges([])), {
    kind: 'workspace',
    spec: 'agent-client/types',
  })
  const placeholder = moduleResolver([], {}, new Map())('agent-client/types') as Record<string, () => unknown>
  assert.throws(() => placeholder.anything(), /unverifiable-dep:workspace-package\|agent-client\/types/)
})

test('an undeclared npm import resolves to nothing', () => {
  const declared = declaredRanges([])
  assert.equal(moduleSource('lucide-react', declared), null)
  assert.equal(moduleSource('cn', declared), null)
})

test('relative and path-alias imports are not npm imports, the @/lib/utils alias included', () => {
  const declared = declaredRanges(['cn'])
  assert.equal(moduleSource('./sibling', declared), null)
  assert.equal(moduleSource('@/components/ui/button', declared), null)
  assert.equal(moduleSource('@/lib/utils', declared), null)
})

test('the resolver answers each item from its own declarations', () => {
  const v1 = { v: 1 }
  const v2 = { v: 2 }
  const react = { react: true }
  const loaded = new Map([
    [npmModuleKey({ spec: 'marked', range: '^14' }), v1],
    [npmModuleKey({ spec: 'marked', range: '^15' }), v2],
  ])
  const builtins = { react }
  assert.equal(moduleResolver(['marked@^14'], builtins, loaded)('marked'), v1)
  assert.equal(moduleResolver(['marked@^15'], builtins, loaded)('marked'), v2)
  assert.equal(moduleResolver([], builtins, loaded)('react'), react)
  assert.equal(moduleResolver([], builtins, loaded)('marked'), undefined)
})

test('undeclared packages are reported by package name, the React family exempt', () => {
  const modules = [
    'react',
    'react/jsx-runtime',
    '@base-ui/react/popover',
    'lucide-react',
    'cn',
    './sibling',
    '@/components/ui/button',
  ]
  assert.deepEqual(undeclaredPackages(modules, ['lucide-react@^1.14.0']), ['@base-ui/react', 'cn'])
  assert.deepEqual(undeclaredPackages(modules, ['lucide-react', '@base-ui/react', 'cn']), [])
})

test('workspace packages are never required to be declared', () => {
  assert.deepEqual(undeclaredPackages(['agent-client/types', 'ui/components/ui/button', 'agent-chat', 'marked'], []), [
    'marked',
  ])
})

test('an item importing nothing from npm has nothing undeclared', () => {
  assert.deepEqual(undeclaredPackages([], []), [])
  assert.deepEqual(undeclaredPackages(['react', './a'], []), [])
})
