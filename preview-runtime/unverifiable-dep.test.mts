// The vocabulary for a dependency the preview sandbox cannot resolve. Two
// causes, one marker, one outcome (unverifiable) — the tests pin that a real
// error is never mistaken for the marker (which would turn a genuine defect
// green), that a workspace-package name is recognised before any npm attempt,
// and that the placeholder throws only when rendered.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  depPackageName,
  isWorkspacePackageSpec,
  UNVERIFIABLE_DEP_MARKER,
  unverifiableDepError,
  unverifiableDepModule,
  unverifiableDepReason,
} from './unverifiable-dep.ts'

test('a workspace-package specifier is recognised by its package name, subpath and all', () => {
  assert.equal(isWorkspacePackageSpec('agent-chat/components/ui/widget'), true)
  assert.equal(isWorkspacePackageSpec('agent-chat'), true)
  assert.equal(isWorkspacePackageSpec('agent-client/utils'), true)
  assert.equal(isWorkspacePackageSpec('ui/button'), true)
  // A public npm dependency is not a workspace package and must still install.
  assert.equal(isWorkspacePackageSpec('react-markdown'), false)
  assert.equal(isWorkspacePackageSpec('lucide-react'), false)
  assert.equal(isWorkspacePackageSpec('@radix-ui/react-dialog'), false)
  // The collision is exact on the package name, not a prefix: a different
  // package that merely starts with the same letters is not shadowed.
  assert.equal(isWorkspacePackageSpec('agent-chat-widgets'), false)
})

test('depPackageName keeps a scope but stops at the first subpath segment', () => {
  assert.equal(depPackageName('agent-chat/components/x'), 'agent-chat')
  assert.equal(depPackageName('agent-chat'), 'agent-chat')
  assert.equal(depPackageName('@scope/pkg/sub'), '@scope/pkg')
})

test('an unverifiable-dependency marker becomes a reason naming the dependency and reassuring about the component', () => {
  const workspace = unverifiableDepReason(unverifiableDepError('workspace-package', 'agent-chat/components/ui/widget'))
  assert.ok(workspace !== null)
  assert.match(workspace, /agent-chat\/components\/ui\/widget/)
  assert.match(workspace, /the component itself is fine/)
  assert.doesNotMatch(workspace, new RegExp(UNVERIFIABLE_DEP_MARKER))

  const browser = unverifiableDepReason(unverifiableDepError('browser-global', 'react-markdown'))
  assert.ok(browser !== null)
  assert.match(browser, /react-markdown/)
  assert.match(browser, /browser preview/)
})

test('a real error is never read as the marker — or the branch would turn a defect green', () => {
  assert.equal(unverifiableDepReason('Element type is invalid: expected a string but got: undefined'), null)
  assert.equal(unverifiableDepReason(undefined), null)
  // The marker only counts as a prefix: a message that merely contains the
  // token is a genuine error and stays one.
  assert.equal(unverifiableDepReason(`thrown: ${UNVERIFIABLE_DEP_MARKER}workspace-package|x`), null)
})

test('the placeholder throws the marker only when an export is CALLED (rendered), not when accessed', () => {
  const mod = unverifiableDepModule('workspace-package', 'agent-chat/components/x')
  const Default = mod.default as () => unknown
  const Named = (mod as Record<string, unknown>).AgentCommandBar as () => unknown
  // Access resolves to a value (so evaluating a module body that imports it does
  // not throw); only rendering it does.
  assert.equal(typeof Default, 'function')
  assert.equal(typeof Named, 'function')
  assert.throws(
    () => Default(),
    (e: Error) => unverifiableDepReason(e.message) !== null,
  )
  assert.throws(
    () => Named(),
    (e: Error) => /agent-chat\/components\/x/.test(e.message),
  )
  // Symbol access (module-interop probes) is undefined, not a throwing stand-in.
  assert.equal((mod as Record<symbol, unknown>)[Symbol.iterator], undefined)
})

test('the placeholder is not a thenable — awaiting it must not convert the throw into a rejection', async () => {
  const mod = unverifiableDepModule('workspace-package', 'agent-chat/components/x')
  // The invariant, not the implementation: whatever answers property access,
  // `then` must not come back callable. A thenable module object would make any
  // caller that awaits it reject at RESOLUTION time, which lands on every
  // component pooling the dependency rather than the one that renders it.
  assert.equal(mod.then, undefined)
  assert.equal(await Promise.resolve(mod), mod)
})
