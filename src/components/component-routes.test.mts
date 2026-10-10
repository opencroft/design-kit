// A component's addresses in the App: every path a link is built with reads
// back as the page it was built for, and an old `?component=` link moves to
// the path it means without losing the rest of its query.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  componentAppPath,
  componentRouteOf,
  EDITOR_QUERY,
  inAppPath,
  isEditorView,
  legacyComponentRef,
  legacyLinkTarget,
  previewAppPath,
} from './component-routes.ts'

test('the bare address is the library', () => {
  assert.deepEqual(componentRouteOf('/'), { page: 'library' })
})

test('a component path names the component', () => {
  assert.equal(componentAppPath('task-table'), '/component/task-table')
  assert.deepEqual(componentRouteOf('/component/task-table'), { page: 'component', name: 'task-table' })
})

test('the preview path with no block opens the main preview', () => {
  assert.equal(previewAppPath('button'), '/component/button/preview')
  assert.equal(previewAppPath('button', null), '/component/button/preview')
  assert.deepEqual(componentRouteOf('/component/button/preview'), { page: 'preview', name: 'button', target: null })
})

test('a block name keeps its colon and slashes, and reads back as the same name', () => {
  const target = 'example:examples/sizes.tsx'
  const path = previewAppPath('button', target)
  assert.equal(path, '/component/button/preview/example:examples/sizes.tsx')
  assert.deepEqual(componentRouteOf(path), { page: 'preview', name: 'button', target })
})

test('a block name with characters a path cannot carry survives the round trip', () => {
  const target = 'example:my examples/a#b.tsx'
  assert.deepEqual(componentRouteOf(previewAppPath('button', target)), { page: 'preview', name: 'button', target })
})

test('a path that is no page of the App is unknown, and keeps the path to quote', () => {
  assert.deepEqual(componentRouteOf('/component'), { page: 'unknown', path: '/component' })
  assert.deepEqual(componentRouteOf('/component/button/history'), {
    page: 'unknown',
    path: '/component/button/history',
  })
  assert.deepEqual(componentRouteOf('/item/K-1'), { page: 'unknown', path: '/item/K-1' })
})

test('the editor view is the view query, on any page', () => {
  assert.equal(EDITOR_QUERY, '?view=editor')
  assert.equal(isEditorView(new URLSearchParams(EDITOR_QUERY)), true)
  assert.equal(isEditorView(new URLSearchParams('')), false)
  assert.equal(isEditorView(new URLSearchParams('view=doc')), false)
})

test('an old link carries its reference; an empty one carries none', () => {
  assert.equal(legacyComponentRef(new URLSearchParams('component=kit.button')), 'kit.button')
  assert.equal(legacyComponentRef(new URLSearchParams('component=')), null)
  assert.equal(legacyComponentRef(new URLSearchParams('')), null)
})

test('an old link moves to the component path and keeps the editor view', () => {
  assert.equal(
    legacyLinkTarget('button', new URLSearchParams('component=kit.button&view=editor')),
    '/component/button?view=editor',
  )
  assert.equal(legacyLinkTarget('button', new URLSearchParams('component=kit.button')), '/component/button')
  // The bare address carries no reference: the first component's path alone.
  assert.equal(legacyLinkTarget('alert', new URLSearchParams('')), '/component/alert')
})

const base = '/space/myspace/app/my-kit'
const origin = 'https://host.example'

test('a doc link into this App is an App path, written with or without the host', () => {
  assert.equal(inAppPath(`${base}/component/task-table`, base, origin), '/component/task-table')
  assert.equal(inAppPath(`${origin}${base}/component/task-table`, base, origin), '/component/task-table')
  assert.equal(inAppPath(base, base, origin), '/')
  assert.equal(inAppPath(`${base}?view=editor`, base, origin), '/?view=editor')
})

test('a doc link anywhere else is left to the browser', () => {
  // Another kit, another App, another site, a heading, and an App whose slug
  // only starts with this one's.
  assert.equal(inAppPath('/space/myspace/app/other-kit/component/list-row', base, origin), null)
  assert.equal(inAppPath('https://example.com/component/x', base, origin), null)
  assert.equal(inAppPath('#props', base, origin), null)
  assert.equal(inAppPath(`${base}-2/component/x`, base, origin), null)
  assert.equal(inAppPath(`${base}/component/x#props`, base, origin), null)
})

test('a doc link that climbs out with dot segments is not taken as an App path', () => {
  // The App router refuses these, and a link that throws while rendering takes
  // the whole doc page down with it.
  assert.equal(inAppPath(`${base}/component/../../other-kit`, base, origin), null)
  assert.equal(inAppPath(`${base}/./component/x`, base, origin), null)
})
