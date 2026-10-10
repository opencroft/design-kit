import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEP_BUNDLE_VERSION, depCacheKey, depUrl } from './dep-url.ts'

test('the dep URL carries the bundler version, so a bundler fix is a new URL to the browser', () => {
  assert.equal(
    depUrl({ spec: '@base-ui/react/popover', range: '' }),
    `dep?name=%40base-ui%2Freact%2Fpopover&v=${DEP_BUNDLE_VERSION}`,
  )
  assert.ok(DEP_BUNDLE_VERSION >= 2, 'version 2 is the first whose bundles bridge CJS require("react")')
})

test('the dep URL carries the declared range', () => {
  assert.equal(
    depUrl({ spec: 'lucide-react', range: '^1.14.0' }),
    `dep?name=lucide-react&range=%5E1.14.0&v=${DEP_BUNDLE_VERSION}`,
  )
})

test('the server cache key separates bundler versions, specs and ranges', () => {
  assert.notEqual(
    depCacheKey({ spec: 'react-day-picker', range: '' }),
    depCacheKey({ spec: 'react-day-picker/locale', range: '' }),
  )
  assert.notEqual(depCacheKey({ spec: 'marked', range: '^14' }), depCacheKey({ spec: 'marked', range: '^15' }))
  assert.notEqual(depCacheKey({ spec: 'marked', range: '' }), depCacheKey({ spec: 'marked', range: '^15' }))
  assert.equal(depCacheKey({ spec: 'marked', range: '^15' }), `${DEP_BUNDLE_VERSION}:marked@^15`)
})
