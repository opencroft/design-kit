// The resolution precedence, exercised against the one state that tells a right
// implementation from a wrong one: a project whose display name does not
// slugify to its slug.
//
// The divergent fixture asserts its own divergence before anything uses it. In
// the aligned state a name match that ignores the slug and one that respects it
// answer alike for every input, so a fixture that quietly became aligned would
// leave every test below passing while proving nothing.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveProjectRef } from './project-resolution.ts'
import type { ProjectReaders, ResolvableProject } from './project-resolution.ts'
import { slugify } from './target.ts'

/** Renamed after it was created: the display name no longer carries the slug. */
const RENAMED = { instanceId: 'inst-renamed', slug: 'first-name', name: 'Second Name' }

/** Never renamed — the display name still slugifies to the slug. */
const ALIGNED = { instanceId: 'inst-aligned', slug: 'steady-project', name: 'Steady Project' }

/** A legacy KV row: no slug of its own, so its namespace IS its name slugified. */
const LEGACY: ResolvableProject = { id: 'dp_legacy', name: 'Old Project' }

const RETIRED_ID = 'dp_retired'

/**
 * The world as the extension reads it, including the merge that makes the slug
 * check necessary: the project list carries the instances as well as the
 * legacy rows.
 * `calls` records which readers were reached, so the laziness the interface
 * exists for is asserted rather than assumed.
 */
function world(): { read: ProjectReaders; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    read: {
      instances: async () => {
        calls.push('instances')
        return [RENAMED, ALIGNED]
      },
      aliases: async () => {
        calls.push('aliases')
        return { [RETIRED_ID]: RENAMED.instanceId }
      },
      projects: async () => {
        calls.push('projects')
        return [
          LEGACY,
          { id: RENAMED.instanceId, name: RENAMED.name, slug: RENAMED.slug },
          { id: ALIGNED.instanceId, name: ALIGNED.name, slug: ALIGNED.slug },
        ]
      },
    },
  }
}

test('the fixtures are what they claim, or nothing below discriminates', () => {
  assert.notEqual(slugify(RENAMED.name), RENAMED.slug, 'the renamed fixture must actually diverge')
  assert.equal(slugify(ALIGNED.name), ALIGNED.slug, 'the aligned fixture must actually be aligned')
  assert.equal(LEGACY.slug, undefined, 'the legacy fixture must carry no slug')
})

test('an instance answers to its slug, under its slug', async () => {
  const { read } = world()

  assert.deepEqual(await resolveProjectRef(RENAMED.slug, read), { id: RENAMED.instanceId, ns: RENAMED.slug })
})

test('an instance answers to its instanceId, under its slug', async () => {
  const { read } = world()

  assert.deepEqual(await resolveProjectRef(RENAMED.instanceId, read), { id: RENAMED.instanceId, ns: RENAMED.slug })
})

test('a renamed instance does NOT answer to its slugified display name', async () => {
  const { read } = world()

  const resolved = await resolveProjectRef(slugify(RENAMED.name), read)

  assert.notEqual(resolved.id, RENAMED.instanceId, 'the display-name form must not reach the project')
  assert.deepEqual(resolved, { id: 'second-name', ns: 'second-name' }, 'it resolves to nothing, and the caller reports the miss')
})

test('an aligned instance answers to the form that is both its slug and its slugified name', async () => {
  const { read } = world()

  // This is the common state, so excluding slugged rows from the name match
  // must not disturb it: the one form still resolves, canonically.
  assert.deepEqual(await resolveProjectRef(ALIGNED.slug, read), { id: ALIGNED.instanceId, ns: ALIGNED.slug })
  assert.equal(slugify(ALIGNED.name), ALIGNED.slug)
})

test('a retired id resolves through its alias, and answers canonically', async () => {
  const { read } = world()

  // The alias is the deliberate second address, and the reason it splits
  // nothing: it answers under the target's namespace, not under the string it
  // was asked by.
  assert.deepEqual(await resolveProjectRef(RETIRED_ID, read), { id: RENAMED.instanceId, ns: RENAMED.slug })
})

test('a legacy row answers to its name slugified, which is its namespace', async () => {
  const { read } = world()

  assert.deepEqual(await resolveProjectRef('old-project', read), { id: LEGACY.id, ns: 'old-project' })
})

test('a legacy row answers to its id', async () => {
  const { read } = world()

  assert.deepEqual(await resolveProjectRef(LEGACY.id, read), { id: LEGACY.id, ns: 'old-project' })
})

test('a value naming no project resolves to nothing and echoes itself', async () => {
  const { read } = world()

  assert.deepEqual(await resolveProjectRef('nothing-of-that-name', read), { id: 'nothing-of-that-name', ns: 'nothing-of-that-name' })
})

test('resolving by slug reads neither the alias table nor the project list', async () => {
  const { read, calls } = world()

  await resolveProjectRef(ALIGNED.slug, read)

  assert.deepEqual(calls, ['instances'], 'the common path must not pay for the steps it does not reach')
})
