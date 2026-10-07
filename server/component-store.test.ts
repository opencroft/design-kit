import assert from 'node:assert/strict'
import test from 'node:test'

import { createComponentStore } from './component-store.ts'

interface Fixture {
  id: string
  name: string
}

function fakeStorage() {
  const data = new Map<string, unknown>()
  return {
    async get<T>(key: string): Promise<T | null> {
      return (data.has(key) ? data.get(key) : null) as T | null
    },
    async set<T>(key: string, value: T): Promise<void> {
      data.set(key, value)
    },
  }
}

test('assertNameAvailableGlobally is a no-op without listOtherProjects', async () => {
  const store = createComponentStore<Fixture>({ storage: fakeStorage(), newId: () => 'id' })
  // Nothing to check against -- must not throw just because the function exists.
  await assert.doesNotReject(() => store.assertNameAvailableGlobally('anything', 'project-a'))
})

test('assertNameAvailableGlobally refuses a name another project already holds, naming it', async () => {
  const storage = fakeStorage()
  await storage.set('components:project-b', [{ id: 'cp_1', name: 'chat-input' }])
  const store = createComponentStore<Fixture>({
    storage,
    newId: () => 'id',
    listOtherProjects: async () => [{ id: 'project-b', name: 'Base Components' }],
  })
  await assert.rejects(
    () => store.assertNameAvailableGlobally('chat-input', 'project-a'),
    /already exists in project "Base Components"/,
  )
})

test('assertNameAvailableGlobally allows a name no other project holds', async () => {
  const storage = fakeStorage()
  await storage.set('components:project-b', [{ id: 'cp_1', name: 'button' }])
  const store = createComponentStore<Fixture>({
    storage,
    newId: () => 'id',
    listOtherProjects: async () => [{ id: 'project-b', name: 'Base Components' }],
  })
  await assert.doesNotReject(() => store.assertNameAvailableGlobally('chat-input', 'project-a'))
})

test('assertNameAvailableGlobally only checks the projects it is told about, never the excluded one directly', async () => {
  // listOtherProjects is the caller's contract for "every OTHER project" --
  // this pins that the function trusts it rather than re-deriving exclusion
  // itself, by using an id that collides with the CURRENT project's own
  // components: since listOtherProjects (correctly, per its contract) never
  // returns the current project, that collision is never seen.
  const storage = fakeStorage()
  await storage.set('components:project-a', [{ id: 'cp_1', name: 'chat-input' }])
  const store = createComponentStore<Fixture>({
    storage,
    newId: () => 'id',
    listOtherProjects: async () => [],
  })
  await assert.doesNotReject(() => store.assertNameAvailableGlobally('chat-input', 'project-a'))
})

test('moveComponent same-project rename is still refused by its own destination check, independent of the global one', async () => {
  const storage = fakeStorage()
  await storage.set('components:project-a', [
    { id: 'cp_1', name: 'button' },
    { id: 'cp_2', name: 'chip' },
  ])
  const store = createComponentStore<Fixture>({ storage, newId: () => 'id' })
  await assert.rejects(
    () => store.moveComponent('project-a', 'chip', { toName: 'button', slugify: (v) => v }),
    /already exists here/,
  )
})

test('a plain cross-project move (no rename) succeeds even when a third project already holds the same name', async () => {
  const storage = fakeStorage()
  await storage.set('components:project-a', [{ id: 'cp_1', name: 'chat-input' }])
  await storage.set('components:project-b', [])
  // A third, unrelated project already holds this exact name (a duplicate
  // that predates the global check) -- moving the component from A to B
  // must not be refused because of it: the name is unchanged, so nothing
  // about global uniqueness is being (re)claimed.
  await storage.set('components:project-c', [{ id: 'cp_9', name: 'chat-input' }])
  const store = createComponentStore<Fixture>({
    storage,
    newId: () => 'id',
    listOtherProjects: async (current) =>
      [
        { id: 'project-a', name: 'A' },
        { id: 'project-b', name: 'B' },
        { id: 'project-c', name: 'C' },
      ].filter((p) => p.id !== current),
  })
  const result = await store.moveComponent('project-a', 'chat-input', { destProjectId: 'project-b', slugify: (v) => v })
  assert.deepEqual(result, { moved: true, name: 'chat-input', project: 'project-b' })
})

test('a rename to a name a third project already holds is refused, naming it', async () => {
  const storage = fakeStorage()
  await storage.set('components:project-a', [{ id: 'cp_1', name: 'widget' }])
  await storage.set('components:project-c', [{ id: 'cp_9', name: 'agent-chat-input' }])
  const store = createComponentStore<Fixture>({
    storage,
    newId: () => 'id',
    listOtherProjects: async (current) =>
      [
        { id: 'project-a', name: 'A' },
        { id: 'project-c', name: 'Base Components' },
      ].filter((p) => p.id !== current),
  })
  await assert.rejects(
    () => store.moveComponent('project-a', 'widget', { toName: 'agent-chat-input', slugify: (v) => v }),
    /already exists in project "Base Components"/,
  )
})

test('a cross-project move renamed to a name the source still holds (on a different component) is refused', async () => {
  const storage = fakeStorage()
  await storage.set('components:project-a', [
    { id: 'cp_1', name: 'chip' },
    { id: 'cp_2', name: 'badge' },
  ])
  await storage.set('components:project-b', [])
  const store = createComponentStore<Fixture>({
    storage,
    newId: () => 'id',
    listOtherProjects: async (current) =>
      [
        { id: 'project-a', name: 'Project A' },
        { id: 'project-b', name: 'Project B' },
      ].filter((p) => p.id !== current),
  })
  // Moving `chip` from A to B, renamed to `badge` -- A (the source, not the
  // destination) still holds a DIFFERENT component already named `badge`.
  await assert.rejects(
    () => store.moveComponent('project-a', 'chip', { toName: 'badge', destProjectId: 'project-b', slugify: (v) => v }),
    /already exists in project "Project A"/,
  )
})

test('moveComponent refuses a cross-project move whose destination project does not exist', async () => {
  const storage = fakeStorage()
  await storage.set('components:project-a', [{ id: 'cp_1', name: 'chip' }])
  const store = createComponentStore<Fixture>({
    storage,
    newId: () => 'id',
    projectExists: async (id) => id === 'project-a',
  })
  await assert.rejects(
    () => store.moveComponent('project-a', 'chip', { destProjectId: 'ghost-project', slugify: (v) => v }),
    /Design project "ghost-project" does not exist/,
  )
})

test('moveComponent allows a cross-project move whose destination project exists', async () => {
  const storage = fakeStorage()
  await storage.set('components:project-a', [{ id: 'cp_1', name: 'chip' }])
  await storage.set('components:project-b', [])
  const store = createComponentStore<Fixture>({
    storage,
    newId: () => 'id',
    projectExists: async (id) => id === 'project-a' || id === 'project-b',
  })
  const result = await store.moveComponent('project-a', 'chip', { destProjectId: 'project-b', slugify: (v) => v })
  assert.deepEqual(result, { moved: true, name: 'chip', project: 'project-b' })
})

test('moveComponent is a no-op destination-existence-wise without projectExists', async () => {
  // Omitting projectExists (like omitting listOtherProjects) must not force
  // every caller that only exercises the narrower rules to fake project
  // registration too.
  const storage = fakeStorage()
  await storage.set('components:project-a', [{ id: 'cp_1', name: 'chip' }])
  await storage.set('components:project-b', [])
  const store = createComponentStore<Fixture>({ storage, newId: () => 'id' })
  const result = await store.moveComponent('project-a', 'chip', { destProjectId: 'project-b', slugify: (v) => v })
  assert.deepEqual(result, { moved: true, name: 'chip', project: 'project-b' })
})

test('a same-project rename is unaffected by projectExists, even if the current project would fail it', async () => {
  // destProject === projectId on a same-project rename -- this component
  // already lives there, so it is not a NEW, unchecked bucket the way a
  // cross-project destination would be. projectExists returning false for
  // it must not matter.
  const storage = fakeStorage()
  await storage.set('components:project-a', [{ id: 'cp_1', name: 'chip' }])
  const store = createComponentStore<Fixture>({
    storage,
    newId: () => 'id',
    projectExists: async () => false,
  })
  const result = await store.moveComponent('project-a', 'chip', { toName: 'badge', slugify: (v) => v })
  assert.deepEqual(result, { moved: true, name: 'badge', project: 'project-a' })
})

test('a rename to the component\'s own current name is a no-op, not a self-collision', async () => {
  const storage = fakeStorage()
  await storage.set('components:project-a', [{ id: 'cp_1', name: 'chip' }])
  const store = createComponentStore<Fixture>({
    storage,
    newId: () => 'id',
    listOtherProjects: async (current) =>
      [{ id: 'project-b', name: 'B' }].filter((p) => p.id !== current),
  })
  const result = await store.moveComponent('project-a', 'chip', { toName: 'chip', slugify: (v) => v })
  assert.deepEqual(result, { moved: true, name: 'chip', project: 'project-a' })
})
