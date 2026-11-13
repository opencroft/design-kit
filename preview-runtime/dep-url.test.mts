import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bundleExportName,
  bundleKey,
  bundleNamespaces,
  bundleOrder,
  DEP_BUNDLE_VERSION,
  depsCacheKey,
  depsUrl,
  parseModuleKey,
} from './dep-url.ts'

const core = { spec: '@tiptap/core', range: '^3.31.4' }
const state = { spec: '@tiptap/pm/state', range: '^3.31.4' }
const lucide = { spec: 'lucide-react', range: '' }

test('the deps URL carries every module with its range, and the bundler version', () => {
  assert.equal(
    depsUrl([state, lucide]),
    `deps?m=%40tiptap%2Fpm%2Fstate%40%5E3.31.4&m=lucide-react&v=${DEP_BUNDLE_VERSION}`,
  )
  assert.ok(DEP_BUNDLE_VERSION >= 3, 'version 3 is the first that bundles a pool’s modules together')
})

test('one set of modules is one URL and one bundle, in whatever order and repetition it is listed', () => {
  assert.equal(depsUrl([lucide, core, state]), depsUrl([state, lucide, core, lucide]))
  assert.equal(bundleKey([lucide, core]), bundleKey([core, lucide, core]))
  assert.deepEqual(bundleOrder([lucide, core, lucide]), [core, lucide])
})

test('a module key reads back as the module, scoped subpaths and missing ranges included', () => {
  assert.deepEqual(parseModuleKey('@tiptap/pm/state@^3.31.4'), state)
  assert.deepEqual(parseModuleKey('@tiptap/core@^3.31.4'), core)
  assert.deepEqual(parseModuleKey('lucide-react'), lucide)
  assert.deepEqual(parseModuleKey('@base-ui/react/popover'), { spec: '@base-ui/react/popover', range: '' })
})

test('the server cache key separates bundler versions, specs, ranges and sets', () => {
  assert.notEqual(
    depsCacheKey([{ spec: 'react-day-picker', range: '' }]),
    depsCacheKey([{ spec: 'react-day-picker/locale', range: '' }]),
  )
  assert.notEqual(depsCacheKey([{ spec: 'marked', range: '^14' }]), depsCacheKey([{ spec: 'marked', range: '^15' }]))
  assert.notEqual(depsCacheKey([core]), depsCacheKey([core, state]))
  assert.equal(depsCacheKey([{ spec: 'marked', range: '^15' }]), `${DEP_BUNDLE_VERSION}:marked@^15`)
})

test('a loaded bundle is read back as each module’s namespace, in the order it was built', () => {
  const coreNs = { Extension: 'core' }
  const stateNs = { Plugin: 'state' }
  const bundle = { [bundleExportName(0)]: coreNs, [bundleExportName(1)]: stateNs }
  const loaded = bundleNamespaces([state, core], bundle)
  assert.equal(loaded.get('@tiptap/core@^3.31.4'), coreNs)
  assert.equal(loaded.get('@tiptap/pm/state@^3.31.4'), stateNs)
})
