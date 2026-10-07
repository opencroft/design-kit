import assert from 'node:assert/strict'
import { test } from 'node:test'

import { baseScope, builtinModules } from './base-scope.ts'
import { REACT_FAMILY } from './declared-deps.ts'

test('the built-in modules are exactly the React family', () => {
  assert.deepEqual(Object.keys(builtinModules).sort(), [...REACT_FAMILY].sort())
})

test('the base scope injects React and nothing else', () => {
  assert.deepEqual(Object.keys(baseScope), ['React'])
})
