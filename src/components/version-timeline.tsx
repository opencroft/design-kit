import { React } from '@ext/host'

import { cn } from 'cn'
import type { TimelinePoint } from './version-selection'

// A horizontal timeline over a component's published versions. A single handle
// split into two halves that move independently: together they select one
// version, apart they select the range between them.
//
// ── The spacing is EVEN, and that is a decision, not an omission ──────────
//
// Points sit at equal intervals whatever the gap in time between them: the
// intervals do not matter.
//
// A real time axis is the obvious "improvement" to make here, which is why this
// paragraph exists — making one would be undoing a decision rather than adding
// to it. It is also worse for the case this surface is for: three versions
// published within an hour and a fourth three weeks later would crush the first
// three into one unclickable cluster, and the versions people compare are
// usually the ones published close together.
//
// Oldest on the left, newest on the right — the draft, when there is one, being
// the newest point.

export interface VersionTimelineProps {
  /** Oldest first. */
  points: TimelinePoint[]
  /** Indices into `points`; equal means one version is selected, not a range.
   *  What a selection MEANS is not this control's business — it reports which
   *  points are chosen and `comparisonFor` decides what that asks for. */
  from: number
  to: number
  onChange: (from: number, to: number) => void
}

type Handle = 'from' | 'to'

/** Tick labels stop being readable long before they stop fitting, so past this
 *  many points only the ends and the handles are named. */
const LABEL_EVERY_POINT_UP_TO = 10

function percentFor(index: number, count: number): number {
  // A lone point sits in the middle rather than at the left edge, where it would
  // read as the start of a track that continues.
  return count > 1 ? (index / (count - 1)) * 100 : 50
}

export function VersionTimeline({ points, from, to, onChange }: VersionTimelineProps) {
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const dragging = React.useRef<Handle | null>(null)
  const count = points.length

  const indexFromClientX = React.useCallback(
    (clientX: number): number => {
      const track = trackRef.current
      if (!track || count < 2) {
        return 0
      }
      const rect = track.getBoundingClientRect()
      const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
      return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))))
    },
    [count],
  )

  // Moving one half past the other swaps them and hands the drag to the half
  // that is now under the pointer, so the handle keeps following the finger
  // instead of sticking at the crossing point.
  const moveHandle = React.useCallback(
    (handle: Handle, index: number) => {
      const next = handle === 'from' ? { from: index, to } : { from, to: index }
      if (next.from > next.to) {
        dragging.current = handle === 'from' ? 'to' : 'from'
        onChange(next.to, next.from)
        return
      }
      onChange(next.from, next.to)
    },
    [from, to, onChange],
  )

  const onPointerDown = (handle: Handle) => (e: React.PointerEvent<HTMLButtonElement>) => {
    dragging.current = handle
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging.current) {
      return
    }
    moveHandle(dragging.current, indexFromClientX(e.clientX))
  }

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    dragging.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const onKeyDown = (handle: Handle) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const current = handle === 'from' ? from : to
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'Home' ? -count : e.key === 'End' ? count : 0
    if (step === 0) {
      return
    }
    e.preventDefault()
    moveHandle(handle, Math.min(count - 1, Math.max(0, current + step)))
  }

  const namedPoints = count <= LABEL_EVERY_POINT_UP_TO ? points.map((_, i) => i) : [0, count - 1, from, to]

  return (
    <div className='pt-1 pb-6'>
      <div ref={trackRef} className='relative h-8'>
        {/* The track, and the selected span over it. */}
        <div className='absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-border' />
        <div
          className='absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-primary'
          style={{ left: `${percentFor(from, count)}%`, width: `${percentFor(to, count) - percentFor(from, count)}%` }}
        />

        {points.map((point, i) => (
          <button
            key={String(point.at)}
            type='button'
            title={point.label}
            aria-label={point.label}
            onClick={() => moveHandle(Math.abs(i - from) <= Math.abs(i - to) ? 'from' : 'to', i)}
            className='absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-background transition-colors hover:border-primary'
            style={{ left: `${percentFor(i, count)}%` }}
          >
            <span className='sr-only'>{point.label}</span>
          </button>
        ))}

        {/* One handle split in two. The halves are half-pills, so sitting on the
            same point they read as a single handle and moving apart splits it. */}
        {(['from', 'to'] as const).map((handle) => {
          const index = handle === 'from' ? from : to
          return (
            <button
              key={handle}
              type='button'
              role='slider'
              aria-label={from === to ? 'Selected version' : handle === 'from' ? 'Range start' : 'Range end'}
              aria-valuemin={0}
              aria-valuemax={count - 1}
              aria-valuenow={index}
              aria-valuetext={points[index]?.label}
              onPointerDown={onPointerDown(handle)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={onKeyDown(handle)}
              className={cn(
                'absolute top-1/2 h-5 w-2 -translate-y-1/2 cursor-grab touch-none border border-primary bg-primary shadow-sm active:cursor-grabbing',
                handle === 'from' ? 'rounded-l-full -translate-x-full' : 'rounded-r-full',
              )}
              style={{ left: `${percentFor(index, count)}%` }}
            />
          )
        })}

        {/* Tick labels, under the track. */}
        {points.map((point, i) =>
          namedPoints.includes(i) ? (
            <span
              key={`label-${String(point.at)}`}
              className={cn(
                'absolute top-full mt-1 -translate-x-1/2 text-[10px] whitespace-nowrap',
                i === from || i === to ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
              style={{ left: `${percentFor(i, count)}%` }}
            >
              {point.label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  )
}
