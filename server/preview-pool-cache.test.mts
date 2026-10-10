import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPreviewPoolCache } from './preview-pool-cache.ts'

// A builder that counts its calls and records what it was asked for, so every
// assertion below is about work NOT done rather than about a value returned.
function countingBuilder() {
  const calls: string[] = []
  const cache = createPreviewPoolCache<string[][], string>({
    buildPool: async (key) => {
      calls.push(key)
      return [[key]]
    },
    buildShared: async () => {
      calls.push('shared')
      return 'corpus'
    },
  })
  return { calls, cache }
}

test('a second reader of the same key gets the first build, not a second one', async () => {
  const { calls, cache } = countingBuilder()
  const first = await cache.pool('p1')
  const second = await cache.pool('p1')
  assert.deepEqual(second, first)
  assert.deepEqual(calls, ['p1'])
})

test('an epoch bump rebuilds: what a write changed is what the next preview shows', async () => {
  const { calls, cache } = countingBuilder()
  await cache.pool('p1')
  cache.invalidate()
  await cache.pool('p1')
  assert.deepEqual(calls, ['p1', 'p1'])
  assert.equal(cache.epoch, 1)
})

test('two keys are independent — one project cached does not answer for another', async () => {
  const { calls, cache } = countingBuilder()
  const first = await cache.pool('p1')
  const second = await cache.pool('p2')
  await cache.pool('p3')
  assert.notDeepEqual(second, first)
  assert.deepEqual(calls, ['p1', 'p2', 'p3'])
})

test('the shared prefix is built once per epoch, however many pools ask for it', async () => {
  const { calls, cache } = countingBuilder()
  assert.equal(await cache.shared(), 'corpus')
  assert.equal(await cache.shared(), 'corpus')
  cache.invalidate()
  assert.equal(await cache.shared(), 'corpus')
  assert.deepEqual(calls, ['shared', 'shared'])
})

test('a rejection is not cached: the next call retries instead of replaying the failure', async () => {
  let attempts = 0
  const cache = createPreviewPoolCache<string[][], string>({
    buildPool: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('the component store was briefly unreadable')
      }
      return [['recovered']]
    },
    buildShared: async () => 'corpus',
  })

  await assert.rejects(cache.pool('p1'), /briefly unreadable/)
  assert.deepEqual(await cache.pool('p1'), [['recovered']])
  assert.equal(attempts, 2)
})

test('a rejected shared prefix is not cached either', async () => {
  let attempts = 0
  const cache = createPreviewPoolCache<string[][], string>({
    buildPool: async () => [[]],
    buildShared: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('no project list')
      }
      return 'corpus'
    },
  })

  await assert.rejects(cache.shared(), /no project list/)
  assert.equal(await cache.shared(), 'corpus')
  assert.equal(attempts, 2)
})

test('concurrent readers of one key share a single in-flight build', async () => {
  let started = 0
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const cache = createPreviewPoolCache<string[][], string>({
    buildPool: async () => {
      started += 1
      await gate
      return [['pooled']]
    },
    buildShared: async () => 'corpus',
  })

  // Both asked before either could finish — the case the preview actually hits,
  // with the client action and the validator arriving on the same write.
  const both = Promise.all([cache.pool('p1'), cache.pool('p1')])
  release()
  const [a, b] = await both
  assert.equal(started, 1)
  assert.deepEqual(a, [['pooled']])
  // The same promise resolved both readers, so they cannot disagree.
  assert.equal(a, b)
})

test('a warm leaves the pool ready for the next reader without being awaited', async () => {
  const { calls, cache } = countingBuilder()
  cache.warm('p1')
  assert.deepEqual(await cache.pool('p1'), [['p1']])
  assert.deepEqual(calls, ['p1'])
})

test('a warm that fails is swallowed — a publish must not be failed by it', async () => {
  const cache = createPreviewPoolCache<string[][], string>({
    buildPool: async () => {
      throw new Error('pool build failed after publish')
    },
    buildShared: async () => 'corpus',
  })

  cache.warm('p1')
  // Let the rejection settle: an unswallowed one would take the process down
  // as an unhandled rejection rather than fail this assertion.
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(cache.pool('p1'), /pool build failed/)
})
