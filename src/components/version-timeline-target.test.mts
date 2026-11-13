import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BAND_MIN, DISC_RADIUS, HIT_REACH, type TimelineTarget, targetAt } from './version-timeline-target.ts'

// Thumb spacings from touching discs to a wide track: 16px is a 19-point
// timeline on a 288px track, 48px a 7-point one.
const SPACINGS = [0, 4, 8, 12, 16, 24, 32, 48, 60, 72, 100, 200]

/** Every whole-px x from `start` to `end`, inclusive. */
const xs = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => start + i)

/** The widest run of whole-px presses between the thumbs that grab the band. */
const bandWidth = (fromX: number, toX: number) =>
  xs(fromX, toX).filter((x) => targetAt(x, fromX, toX) === 'band').length

test('a press on a thumb disc grabs that thumb at every spacing', () => {
  // At spacing 0 the two discs are one thumb; the joined test covers it.
  for (const spacing of SPACINGS.filter((s) => s > 0)) {
    const fromX = 100
    const toX = fromX + spacing
    for (const [handle, centre] of [
      ['from', fromX],
      ['to', toX],
    ] as const) {
      assert.equal(targetAt(centre, fromX, toX), handle, `${handle} centre, spacing ${spacing}`)
    }
    // Off-centre on the disc, on the side away from the other thumb.
    assert.equal(targetAt(fromX - DISC_RADIUS, fromX, toX), 'from', `from disc edge, spacing ${spacing}`)
    assert.equal(targetAt(toX + DISC_RADIUS, fromX, toX), 'to', `to disc edge, spacing ${spacing}`)
  }
})

test('touching discs split at the midpoint', () => {
  assert.equal(targetAt(107, 100, 116), 'from')
  assert.equal(targetAt(109, 100, 116), 'to')
})

test('a thumb reaches HIT_REACH outward and the track lies beyond', () => {
  assert.equal(targetAt(100 - HIT_REACH, 100, 200), 'from')
  assert.equal(targetAt(100 - HIT_REACH - 1, 100, 200), 'track')
  assert.equal(targetAt(200 + HIT_REACH, 100, 200), 'to')
  assert.equal(targetAt(200 + HIT_REACH + 1, 100, 200), 'track')
})

test('joined thumbs are grabbed by the end facing the press', () => {
  const cases: [number, TimelineTarget][] = [
    [50 - HIT_REACH, 'from'],
    [45, 'from'],
    [50, 'to'],
    [55, 'to'],
    [50 + HIT_REACH, 'to'],
    [50 + HIT_REACH + 1, 'track'],
  ]
  for (const [x, target] of cases) {
    assert.equal(targetAt(x, 50, 50), target, `x ${x}`)
  }
})

test('the band keeps everything between the discs while that is under BAND_MIN', () => {
  // One step of a 7-point timeline on a 288px track.
  assert.equal(bandWidth(192, 240), 48 - 2 * DISC_RADIUS - 1)
  assert.equal(targetAt(192 + DISC_RADIUS + 1, 192, 240), 'band')
  assert.equal(targetAt(240 - DISC_RADIUS - 1, 192, 240), 'band')
})

test('the band never drops below BAND_MIN once the discs leave room for it', () => {
  for (const spacing of SPACINGS) {
    const gap = spacing - 2 * DISC_RADIUS
    const width = bandWidth(0, spacing)
    if (gap <= 0) {
      assert.equal(width, 0, `spacing ${spacing}`)
    } else {
      assert.ok(width >= Math.min(BAND_MIN, gap) - 1, `spacing ${spacing}: band ${width}px`)
    }
  }
})

test('on a long span each thumb reaches HIT_REACH inward and the band has the rest', () => {
  assert.equal(targetAt(100 + HIT_REACH, 100, 300), 'from')
  assert.equal(targetAt(100 + HIT_REACH + 1, 100, 300), 'band')
  assert.equal(targetAt(300 - HIT_REACH, 100, 300), 'to')
  assert.equal(targetAt(300 - HIT_REACH - 1, 100, 300), 'band')
})
