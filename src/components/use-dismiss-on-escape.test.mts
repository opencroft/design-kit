// Escape closes both of the editor's dialogs, and in both it takes the
// non-destructive answer.
//
// **Every assertion here reads SOURCE TEXT, and that is the whole instrument.**
// The hook and both dialogs import `@opencroft/client`, which is not a package this
// repo installs, so none of them can be imported by the runner — and the
// behaviour itself is a key press against a listener, which no assertion here
// could observe even if they could. Nothing below shows that Escape closes
// anything. What it shows is that there is one implementation rather than two,
// that both dialogs reach it, and that neither of them hands it the callback
// that loses work.
//
// That last one is the guard worth having. Both dialogs name their DESTRUCTIVE
// callback `onDiscard` — "Discard" on one, "Leave anyway" on the other — so the
// safe prop and the ruinous one are one word apart at both call sites, and
// nothing in the hook can tell them apart. A wrong wiring here would look
// entirely ordinary and would answer the reflex key with the act the dialog
// exists to ask about.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** A file with its prose removed — JSX comment blocks first, then line and
 *  block comments. The comments here quote the very identifiers these guards
 *  forbid, so matching the raw file would fail on the explanation. */
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf-8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

const hook = read('./use-dismiss-on-escape.ts')
const dialog = read('./source-editor-discard.tsx')
const guard = read('./source-editor-guard.tsx')

test('there is one implementation and both dialogs reach it', () => {
  assert.match(dialog, /import \{ useDismissOnEscape \} from '\.\/use-dismiss-on-escape'/)
  assert.match(guard, /import \{ useDismissOnEscape \} from '\.\/use-dismiss-on-escape'/)
})

test('neither dialog listens for keys on its own', () => {
  // Two implementations would agree on the day they were written, and the
  // whole point of one behaviour across two dialogs is that they must not be
  // able to stop agreeing later.
  assert.doesNotMatch(dialog, /addEventListener/, 'the discard dialog binds its own listener')
  assert.doesNotMatch(guard, /addEventListener/, 'the leaving guard binds its own listener')
})

test('escape takes the non-destructive answer in both dialogs', () => {
  assert.match(dialog, /useDismissOnEscape\(shown, onCancel\)/)
  assert.match(guard, /useDismissOnEscape\(open, onStay\)/)
})

test('escape is wired to the destructive callback in neither dialog', () => {
  // Stated separately from the test above rather than trusted as its converse:
  // a second call, or an edited argument, is exactly the change that would slip
  // past a test that only checks the right one is present somewhere.
  for (const [name, source] of [
    ['discard dialog', dialog],
    ['leaving guard', guard],
  ] as const) {
    assert.doesNotMatch(source, /useDismissOnEscape\([^)]*onDiscard/, `${name} hands escape the destructive callback`)
    assert.equal(source.split('useDismissOnEscape(').length - 1, 1, `${name} calls it more than once`)
  }
})

test('the safe callback is still the one the props gave that name', () => {
  // THE REGION THE GUARDS ABOVE CANNOT READ: between the destructure and the
  // call. Rename the safe prop in the destructure and its name is free; bind
  // the destructive one to it in the body and the call site still reads
  // `useDismissOnEscape(shown, onCancel)` character for character, its
  // arguments still contain no `onDiscard`, the count is still one, and Escape
  // discards the draft — with every other guard green.
  //
  // Pinning the whole destructure is what closes it, because the exploit needs
  // the name to mean something other than the prop, and there is exactly one
  // spelling in which it does not.
  assert.match(dialog, /\{ version, onDiscard, onCancel \}: SourceEditorDiscardProps/)
  assert.match(guard, /\{ open, dirtyCount, onDiscard, onStay \}: SourceEditorGuardProps/)
})

test('neither dialog rebinds the safe name before handing it over', () => {
  // The same reach, without the rename: a plain `const onCancel = onDiscard`
  // in the body needs no help from the destructure at all.
  assert.doesNotMatch(dialog, /(?:const|let|var)\s+onCancel\b/, 'the discard dialog rebinds onCancel in its body')
  assert.doesNotMatch(guard, /(?:const|let|var)\s+onStay\b/, 'the leaving guard rebinds onStay in its body')
  // And the aliasing form, which arrives at the same place through the
  // destructure rather than around it. The interface's own `onCancel?:` is the
  // other order and is deliberately not matched by this.
  assert.doesNotMatch(dialog, /:\s*onCancel\b/, 'the discard dialog aliases another prop onto onCancel')
  assert.doesNotMatch(guard, /:\s*onStay\b/, 'the leaving guard aliases another prop onto onStay')
})

test('the hook is asked before either dialog gives up rendering', () => {
  // A hook after an early return is a hook that runs on some renders and not
  // others, which React refuses at runtime. The condition is an argument here
  // precisely so the call can sit above the return.
  for (const [name, source] of [
    ['discard dialog', dialog],
    ['leaving guard', guard],
  ] as const) {
    const call = source.indexOf('useDismissOnEscape(')
    const bail = source.indexOf('return null')
    assert.ok(call > 0, `${name} does not call it at all`)
    assert.ok(bail > 0, `${name} no longer has an early return to check against`)
    assert.ok(call < bail, `${name} calls the hook after it may already have returned`)
  }
})

test('the hook listens only while the dialog is up, and stops when it goes', () => {
  assert.match(hook, /if \(!active\) \{\s*\n\s*return\s*\n\s*\}/)
  assert.match(hook, /window\.addEventListener\('keydown', onKey\)/)
  assert.match(hook, /return \(\) => window\.removeEventListener\('keydown', onKey\)/)
  assert.match(hook, /e\.key === 'Escape'/)
})
