import { cn } from 'cn'
import type { ReactNode } from 'react'

import { EXAMPLE_FRAME_PRESETS, type ExampleFrameWidth, frameTracks, isBounded, presetOf } from './example-frame-width'

// The surface a preview is shown ON: a hatched backdrop, cross-hair rules along
// the edges of the previewed box, and the width that box is rendered at.
//
// Two rules decide everything here.
//
// THE FRAME NEVER LAYS THE CONTENT OUT. Every decorative element is a
// zero-contribution, pointer-transparent item, and the children sit in a plain
// block — no flex wrapper, no stretch, no background of the frame's own. A
// wrapper of the frame's own would turn every preview into, say, a flex row, and
// a component that lays its own children out would be laid out twice. Whether
// the hatch is drawn is a question about pixels only; it cannot reach the thing
// being previewed.
//
// THE RULES BELONG TO A BOUNDED BOX. Cross-hairs say "this is where the
// component ends" — which is information only when the component ends somewhere
// short of the frame. At full width they would trace the frame's own border and
// claim a boundary that is the container's, not the design's, so they are drawn
// only for a width that bounds the content.

export interface ExampleFrameProps {
  children: ReactNode
  /** default `'fit'` — the content decides */
  width?: ExampleFrameWidth
  /** Show the hatch backdrop and the cross-hair rules. Default on. */
  grid?: boolean
  /** minimum gutter around the previewed box, in rem. 1 by default: enough
   *  for the rules to read as a boundary, and no more of the frame spent on
   *  hatch than that. */
  gutter?: number
  className?: string
}

export function ExampleFrame({ children, width = 'fit', grid = true, gutter = 1, className }: ExampleFrameProps) {
  const template = frameTracks(width, gutter)
  // A number wider than the frame would otherwise overflow and cut the design
  // off at the right edge with no scrollbar to reach it.
  const box = typeof width === 'number' ? { width, maxWidth: '100%' } : undefined
  const rules = grid && isBounded(width)

  return (
    <div className={cn('relative grid flex-1 bg-background [--pattern-fg:var(--border)]', className)} style={template}>
      {/* Diagonal hatch backdrop — deliberately not `bg-fixed`: in a nested
          scrolling panel a viewport-anchored background bleeds across the
          page. */}
      {grid && (
        <div className='pointer-events-none col-start-1 row-start-1 col-span-full row-span-full bg-[repeating-linear-gradient(315deg,color-mix(in_srgb,var(--pattern-fg),transparent_30%)_0,color-mix(in_srgb,var(--pattern-fg),transparent_30%)_1px,transparent_0,transparent_50%)] bg-size-[10px_10px]' />
      )}
      {rules && (
        <div className='pointer-events-none col-start-1 row-start-2 col-span-full border-y border-y-(--pattern-fg)' />
      )}
      {rules && (
        <div className='pointer-events-none col-start-2 row-start-1 row-span-full border-x border-x-(--pattern-fg)' />
      )}

      {/* The content, and nothing around it: a plain block that starts a new
          stacking context above the hatch and imposes no display mode of its
          own. `min-w-0` so a wide child scrolls or wraps rather than blowing
          the track out past the gutters. */}
      <div className='relative z-1 col-start-2 row-start-2 min-w-0' style={box}>
        {children}
      </div>
    </div>
  )
}

export interface ExampleFrameWidthControlProps {
  width: ExampleFrameWidth
  onChange: (width: ExampleFrameWidth) => void
  className?: string
}

/**
 * The preset row, as its own export rather than part of the frame: the frame is
 * used in places that have no toolbar to put it in (a sheet cell, a doc figure),
 * and a control that appeared there would be chrome inside the artwork. Whoever
 * owns the toolbar renders this and owns the width state — one owner, so a drag
 * and a preset press cannot disagree about how wide the preview is.
 */
export function ExampleFrameWidthControl({ width, onChange, className }: ExampleFrameWidthControlProps) {
  const active = presetOf(width)
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      {EXAMPLE_FRAME_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type='button'
          onClick={() => onChange(preset.width)}
          aria-pressed={active?.id === preset.id}
          title={preset.width === 'full' ? `${preset.label} — full width` : `${preset.label} — ${preset.width}px`}
          className={cn(
            'rounded px-1.5 py-0.5 transition-colors hover:bg-zinc-800 hover:text-zinc-200',
            active?.id === preset.id && 'bg-zinc-800 text-zinc-200',
          )}
        >
          {preset.label}
        </button>
      ))}
    </div>
  )
}
