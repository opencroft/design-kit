// What a caller is told when an end of a comparison cannot be read.
//
// These assert behaviour rather than wording: that every member of the union
// has a spelling, that "above the versions held" and "below them" stay
// different answers, and that the one which could be answered with the empty
// state says not to.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { endpointLabel, unreachableEndpointMessage, type VersionEndpoint } from './version-endpoint.ts'

test('every endpoint has a spelling, and the empty state is never rendered as a version', () => {
  assert.equal(endpointLabel(3), 'v3')
  assert.equal(endpointLabel('draft'), 'its draft')
  // The failure this exists to prevent: "vnone", in the one case the empty
  // state is what the caller most needs described accurately.
  assert.equal(endpointLabel('none'), 'the state before its first version')
  assert.doesNotMatch(endpointLabel('none'), /^v/)
})

test('an endpoint the function does not know refuses rather than inventing a version', () => {
  // The protection that does not need a compiler, and the only one there is:
  // nothing type-checks this repository, so the `never` line beside the throw
  // is a claim nothing evaluates. Ordering the branches so the `v` prefix
  // belongs to a NUMBER is what sends an unknown member here — as a
  // fallthrough it would have come back "vfuture", which is `vnone` one member
  // later, in the function written to prevent `vnone`.
  assert.throws(() => endpointLabel('future' as unknown as VersionEndpoint), /unhandled endpoint future/)
})

test('a version above the ones held has not been published — which is a different answer from being unstored', () => {
  const message = unreachableEndpointMessage('node-card', 9, [1, 2, 3])
  assert.match(message, /holds v1–v3/)
  assert.match(message, /has not been published/)
  assert.doesNotMatch(message, /predates/)
  // Nothing here should push the caller at the empty state: v9 is not below
  // anything, so comparing against "none" would answer a question nobody asked.
  assert.doesNotMatch(message, /none/)
})

test('a version below the ones held predates the stored history, and the message closes the empty-state exit', () => {
  const message = unreachableEndpointMessage('node-card', 5, [6, 7, 8])
  assert.match(message, /holds v6–v8/)
  assert.match(message, /predates/)
  // The load-bearing half: the nearest other value in the schema resolves and
  // fabricates, so the message has to name it and refuse it.
  assert.match(message, /"none"/)
  assert.match(message, /every file as added at v6/)
})

test('a single version held reads as one version rather than as an empty range', () => {
  assert.match(unreachableEndpointMessage('node-card', 5, [6]), /holds v6\./)
})

test('a component with nothing published says so instead of naming a range', () => {
  const message = unreachableEndpointMessage('node-card', 1, [])
  assert.equal(message, '"node-card" has nothing at v1. This project holds no published version of it.')
})

test('a missing draft is its own answer and borrows none of the version advice', () => {
  assert.equal(unreachableEndpointMessage('node-card', 'draft', [1, 2]), '"node-card" has nothing at its draft.')
})

test('a gap inside the range is neither too high nor too low', () => {
  const message = unreachableEndpointMessage('node-card', 7, [6, 8])
  assert.match(message, /does not include v7/)
  assert.doesNotMatch(message, /predates/)
  assert.doesNotMatch(message, /has not been published/)
})
