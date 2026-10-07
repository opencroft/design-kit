// One parameter, two things it can name: a component, or a whole project.
//
// The distinction is load-bearing in both directions. Read a project as a
// component and the install 404s on a component that was never asked for; read
// a component as a project and it installs the entire library over somebody's
// tree. Both are one missing separator apart, so each case is pinned rather
// than inferred from its neighbour.
//
// The route half — which names a project actually holds, and refusing an empty
// list — imports `@ext/host` and cannot be reached from here. The guards at the
// bottom read its source instead, and they say only that the wiring is in
// place, not that it works.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { installRequestFrom } from './install-request.ts'

const from = (component: unknown, project: unknown = null, name: unknown = null) => installRequestFrom(component, project, name)

test('a two-part reference installs that one component', () => {
  assert.deepEqual(from('kit.button'), { kind: 'component', project: 'kit', name: 'button' })
})

test('both separators work, because the grammar reads both', () => {
  assert.deepEqual(from('kit/button'), { kind: 'component', project: 'kit', name: 'button' })
})

test('a bare value installs every component of that project', () => {
  // The component half is simply left off.
  assert.deepEqual(from('acme-ui'), { kind: 'project', project: 'acme-ui' })
})

test('a project name is not mistaken for a component of some default project', () => {
  // The failure that would be invisible: reading `kit` as a component name
  // would 404 on something nobody asked for, and the message would name a
  // component that does not exist rather than the project that does.
  const request = from('kit')
  assert.equal(request?.kind, 'project')
  assert.equal(request && 'name' in request, false, 'a project request must carry no component name')
})

test('the legacy separate pair still installs one component', () => {
  // Install commands carrying this form are already copied into other
  // repositories' documentation.
  assert.deepEqual(from(null, 'kit', 'button'), { kind: 'component', project: 'kit', name: 'button' })
})

test('a reference wins over the separate pair, as the grammar says it does', () => {
  // Same precedence as every other route that reads both, so one query string
  // cannot mean different things depending on which route read it.
  assert.deepEqual(from('kit.button', 'other', 'card'), { kind: 'component', project: 'kit', name: 'button' })
})

test('a project alone, without a component parameter, installs nothing', () => {
  // `project=` on its own is the legacy pair with a half missing. It is not
  // the whole-project form — that one is spelled `component=<project>`, and
  // inventing a second spelling here would be extra surface to learn and to
  // keep working.
  assert.equal(from(null, 'kit', null), null)
})

test('nothing at all is nothing to install', () => {
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(from(empty), null, `${JSON.stringify(empty)} should name nothing`)
  }
})

test('a resolver suffix is stripped before either reading', () => {
  assert.deepEqual(from('kit.button.json'), { kind: 'component', project: 'kit', name: 'button' })
  assert.deepEqual(from('kit.json'), { kind: 'project', project: 'kit' })
})

// ── The route that has to use it ──────────────────────────────────────────

const routeSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

test('the route asks this rather than deciding for itself', () => {
  assert.match(routeSource, /installRequestFrom\(url\.searchParams\.get\('component'\)/)
})

test('the whole-project form refuses an empty component list', () => {
  // The project resolver does not throw on an unknown name, so "no such
  // project" arrives as zero components. Without this the installer would be
  // built with no arguments and report success for installing nothing.
  assert.match(routeSource, /names\.length === 0/)
  assert.match(routeSource, /No components to install/)
})

test('the refusal says both things it could mean, and presupposes neither', () => {
  // The two causes arrive at this branch as the same value, so a sentence that
  // names one of them is asserting something the route never established. Both
  // halves have to be in the words a reader actually sees.
  const refusal = routeSource.slice(routeSource.indexOf('No components to install'))
  assert.match(refusal, /has nothing published/, 'the empty-project half is gone')
  assert.match(refusal, /nothing answers to that name/, 'the no-such-project half is gone')
  assert.doesNotMatch(
    routeSource,
    /No components to install in project/,
    'the sentence calls it a project, which is the half it never looked into',
  )
})

test('every name reaches the installer as its own argument', () => {
  // Joined into one string they would become a single item name containing
  // spaces, which resolves to nothing and says little about why.
  assert.match(routeSource, /\.\.\.TARGETS/)
  assert.doesNotMatch(routeSource, /TARGETS\.join/)
})

test('the namespace closure is collected across all of them, not just the first', () => {
  // Each component can pull in registries of its own; collecting for one and
  // installing many would leave the rest unresolvable at install time.
  assert.match(routeSource, /for \(const name of names\) \{\s*\n\s*for \(const ns of await collectNamespaces/)
})
