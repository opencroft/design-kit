// How wide a preview renders, and where that leaves the frame's decoration.
//
// Kept apart from example-frame.tsx so it can be exercised directly: the claims
// worth pinning here are not about pixels but about meaning — that the Mobile
// preset is a width at which a component branching on the product's mobile
// breakpoint actually takes the mobile branch, and that the cross-hair rules
// are drawn exactly when the previewed box ends short of the frame. Both read
// as arbitrary constants in a JSX file and neither can be checked there.

/** How wide the previewed box renders. `'fit'` shrinks to content, `'full'` fills, a number is px. */
export type ExampleFrameWidth = 'fit' | 'full' | number

export interface ExampleFramePreset {
  id: string
  label: string
  width: ExampleFrameWidth
}

// The product's own mobile breakpoint: the host's `useIsMobile` matches
// `(max-width: 767px)`, so a viewport is mobile strictly BELOW this number.
// Duplicated rather than imported because this file installs into consumer
// projects that have no such hook; the test below is what keeps the copy honest
// about what it means.
export const MOBILE_BREAKPOINT = 768

/** Whether a width makes a component that consults the breakpoint take its mobile branch. */
export function isMobileWidth(width: ExampleFrameWidth): boolean {
  return typeof width === 'number' && width < MOBILE_BREAKPOINT
}

// Desktop / Tablet / Mobile, and the pair around the breakpoint is deliberate:
// Tablet is the narrowest width that is still NOT mobile, so pressing the two in
// turn is how an author sees the switch itself rather than two arbitrary sizes.
export const EXAMPLE_FRAME_PRESETS: ExampleFramePreset[] = [
  { id: 'desktop', label: 'Desktop', width: 'full' },
  { id: 'tablet', label: 'Tablet', width: MOBILE_BREAKPOINT },
  { id: 'mobile', label: 'Mobile', width: 390 },
]

/** Which preset a width is, or null when it is a hand-dragged width. */
export function presetOf(width: ExampleFrameWidth): ExampleFramePreset | null {
  return EXAMPLE_FRAME_PRESETS.find((p) => p.width === width) ?? null
}

/**
 * Whether the previewed box ends somewhere short of the frame.
 *
 * This is the whole condition for drawing the cross-hair rules. They say "the
 * component ends here", which is information only when the component ends
 * before the frame does — at full width they would trace the container's own
 * border and claim it as the design's edge.
 */
export function isBounded(width: ExampleFrameWidth): boolean {
  return width !== 'full'
}

/**
 * The grid the frame draws in: a gutter, the previewed box, a gutter.
 *
 * The content occupies the middle cell and the decoration spans the whole grid
 * carrying nothing, so this template is the COMPLETE description of where the
 * content sits — turning the hatch off cannot move it.
 */
export function frameTracks(
  width: ExampleFrameWidth,
  gutter: number,
): { gridTemplateColumns: string; gridTemplateRows: string } {
  const side = `minmax(${gutter}rem,auto)`
  const middle = width === 'full' ? 'minmax(0,1fr)' : width === 'fit' ? 'auto' : `${width}px`
  return {
    gridTemplateColumns: `${side} ${middle} ${side}`,
    // Height is never a preset — a design is judged at a width and allowed to be
    // as tall as it is. The middle row fills only when the box does, so a bounded
    // box sits centred with real space above and below for the rules to run in.
    gridTemplateRows: `${side} ${width === 'full' ? 'minmax(0,1fr)' : 'auto'} ${side}`,
  }
}
