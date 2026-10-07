// loadDep imports a bundled npm dependency into the server-side validator.
// bundleDep()'s real output deliberately leaves `react`/`react-dom`/
// `react/jsx-runtime` as bare imports (the browser frame resolves those
// through its own import map instead of a second React copy) — these tests
// use a minimal fake bundle carrying that same shape, so the resolution is
// exercised without a network call or a real esbuild pass.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as React from 'react'

import { loadDep } from './eval-loader.ts'

test('a bundle with a bare `react` import resolves, not just one with none', async () => {
  const bundled = `import * as React from 'react'\nexport const hasCreateElement = typeof React.createElement === 'function'\n`
  const ns = await loadDep(bundled)
  assert.equal(ns.hasCreateElement, true)
})

test('named and default exports both survive, matching a real dep bundle', async () => {
  const bundled = `export const Root = 'root-marker'\nexport default { Root }\n`
  const ns = await loadDep(bundled)
  assert.equal(ns.Root, 'root-marker')
  assert.deepEqual(ns.default, { Root: 'root-marker' })
})

test('the same bundle is imported once, so repeated validations do not grow the process', async () => {
  const bundled = `export const box = {}\n`
  const [a, b] = await Promise.all([loadDep(bundled), loadDep(bundled)])
  const c = await loadDep(bundled)
  assert.equal(a.box, b.box)
  assert.equal(a.box, c.box)
})

test('a bundle that fails to import is retried on the next load', async () => {
  const bundled = `if (!globalThis.__evalLoaderRetryProbe) { globalThis.__evalLoaderRetryProbe = true; throw new Error('first import fails') }\nexport const ok = true\n`
  try {
    await assert.rejects(loadDep(bundled), /first import fails/)
    assert.equal((await loadDep(bundled)).ok, true)
  } finally {
    delete (globalThis as Record<string, unknown>).__evalLoaderRetryProbe
  }
})

test('two concurrent loads of different bundles do not collide', async () => {
  const [a, b] = await Promise.all([loadDep(`export const tag = 'a'\n`), loadDep(`export const tag = 'b'\n`)])
  assert.equal(a.tag, 'a')
  assert.equal(b.tag, 'b')
})

// The failure this guards: a loaded dep's `react` resolving to A React (present,
// well-formed, but a second copy) rather than THE React this process renders
// with is exactly what produces "Cannot read properties of null (reading
// 'useMemo')" — a mismatched dispatcher, not a missing export. Function
// identity is the only signal that distinguishes "same instance" from "an
// identical-looking copy".
test("a loaded dep's react is the SAME instance this process renders with, not a second copy", async () => {
  const bundled = `import * as React from 'react'\nexport const useMemo = React.useMemo\nexport const version = React.version\n`
  const ns = await loadDep(bundled)
  assert.equal(ns.useMemo, React.useMemo)
  assert.equal(ns.version, React.version)
})
