// The two claims the frame's width policy rests on, which are invisible in JSX:
// that the Mobile preset is mobile in the product's own sense, and that the
// cross-hair rules appear exactly where there is space for them to mean
// anything. Plus the property the layout rests on — the hatch cannot move the
// content, because the track template does not consult it.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EXAMPLE_FRAME_PRESETS,
  type ExampleFrameWidth,
  frameTracks,
  isBounded,
  isMobileWidth,
  MOBILE_BREAKPOINT,
  presetOf,
} from './example-frame-width.ts'

const preset = (id: string) => {
  const hit = EXAMPLE_FRAME_PRESETS.find((p) => p.id === id)
  assert.ok(hit, `no preset "${id}"`)
  return hit
}

test('the Mobile preset renders at a width the mobile breakpoint fires at', () => {
  assert.equal(isMobileWidth(preset('mobile').width), true)
})

test('Tablet is the narrowest width that is NOT mobile, so the pair brackets the switch', () => {
  assert.equal(preset('tablet').width, MOBILE_BREAKPOINT)
  assert.equal(isMobileWidth(preset('tablet').width), false)
  assert.equal(isMobileWidth(MOBILE_BREAKPOINT - 1), true)
})

test('Desktop is full width, so it is the one preset with no edge of its own', () => {
  assert.equal(preset('desktop').width, 'full')
  assert.equal(isBounded(preset('desktop').width), false)
  assert.equal(isMobileWidth(preset('desktop').width), false)
})

test('every other width bounds the box, including a hand-dragged one', () => {
  for (const width of ['fit', 390, 768, 1200] as ExampleFrameWidth[]) {
    assert.equal(isBounded(width), true, `expected ${String(width)} to be bounded`)
  }
})

test('a hand-dragged width is no preset, and every preset is its own', () => {
  assert.equal(presetOf(421), null)
  for (const p of EXAMPLE_FRAME_PRESETS) {
    assert.equal(presetOf(p.width)?.id, p.id)
  }
})

test('the track template puts the box in the middle cell at the width asked for', () => {
  assert.deepEqual(frameTracks(390, 2), {
    gridTemplateColumns: 'minmax(2rem,auto) 390px minmax(2rem,auto)',
    gridTemplateRows: 'minmax(2rem,auto) auto minmax(2rem,auto)',
  })
  assert.deepEqual(frameTracks('full', 0), {
    gridTemplateColumns: 'minmax(0rem,auto) minmax(0,1fr) minmax(0rem,auto)',
    gridTemplateRows: 'minmax(0rem,auto) minmax(0,1fr) minmax(0rem,auto)',
  })
  assert.equal(frameTracks('fit', 4).gridTemplateColumns, 'minmax(4rem,auto) auto minmax(4rem,auto)')
})

test('the layout does not depend on whether the grid is drawn', () => {
  // `frameTracks` takes no `grid` argument, and that is the property: there is
  // no value of the toggle that could reach the content's box. Stated as a test
  // so making the layout depend on the toggle has to delete this line to go
  // green.
  assert.equal(frameTracks.length, 2)
})
