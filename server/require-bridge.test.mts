import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  externalHasDefault,
  externalsFilter,
  REQUIRE_BRIDGE_NAMESPACE,
  requireBridgePlugin,
  requireBridgeSource,
} from './require-bridge.ts'

const EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client']

// Drive the plugin's setup() with a stand-in for esbuild's build object and
// capture the callbacks, so the resolve/load decisions are checked without
// esbuild installed.
function capture() {
  const resolvers: { filter: RegExp; cb: (args: { path: string; kind: string }) => unknown }[] = []
  const loaders: {
    filter: RegExp
    namespace?: string
    cb: (args: { path: string }) => { contents: string; loader: string }
  }[] = []
  const build = {
    onResolve: (o: { filter: RegExp }, cb: (typeof resolvers)[number]['cb']) =>
      resolvers.push({ filter: o.filter, cb }),
    onLoad: (o: { filter: RegExp; namespace?: string }, cb: (typeof loaders)[number]['cb']) =>
      loaders.push({ ...o, cb }),
  }
  requireBridgePlugin(EXTERNALS).setup(build as never)
  const resolve = (path: string, kind: string): unknown => {
    const r = resolvers.find((x) => x.filter.test(path))
    return r ? r.cb({ path, kind }) : undefined
  }
  return { resolve, loaders }
}

test('a require() of an external react specifier is routed to the bridge', () => {
  const { resolve } = capture()
  for (const spec of EXTERNALS) {
    assert.deepEqual(resolve(spec, 'require-call'), { path: spec, namespace: REQUIRE_BRIDGE_NAMESPACE })
  }
})

test('an import of an external is left alone, so bundles without CJS react requires do not change', () => {
  const { resolve } = capture()
  for (const kind of ['import-statement', 'dynamic-import', 'entry-point']) {
    assert.equal(resolve('react', kind), undefined)
  }
})

test('only the exact external specifiers match, not lookalikes or other subpaths', () => {
  const filter = externalsFilter(EXTERNALS)
  for (const spec of EXTERNALS) {
    assert.ok(filter.test(spec), spec)
  }
  for (const spec of [
    'react-dom/server',
    'react-is',
    'preact',
    'reactx',
    'xreact',
    'react/',
    'use-sync-external-store/shim',
  ]) {
    assert.equal(filter.test(spec), false, spec)
  }
})

test('the bridge re-exports the external through a plain ESM import, with a default only where the shim has one', () => {
  assert.equal(requireBridgeSource('react'), 'export * from "react"\nexport { default } from "react"\n')
  assert.equal(
    requireBridgeSource('react-dom/client'),
    'export * from "react-dom/client"\nexport { default } from "react-dom/client"\n',
  )
  // The frame's jsx-runtime shim has no default export: re-exporting one would
  // be an ESM link error that takes the whole dep down.
  assert.equal(requireBridgeSource('react/jsx-runtime'), 'export * from "react/jsx-runtime"\n')
  assert.equal(requireBridgeSource('react/jsx-dev-runtime'), 'export * from "react/jsx-dev-runtime"\n')
  assert.equal(externalHasDefault('react-dom'), true)
})

test('the loader serves bridge source only in the bridge namespace', () => {
  const { loaders } = capture()
  assert.equal(loaders.length, 1)
  assert.equal(loaders[0].namespace, REQUIRE_BRIDGE_NAMESPACE)
  assert.deepEqual(loaders[0].cb({ path: 'react' }), { contents: requireBridgeSource('react'), loader: 'js' })
})
