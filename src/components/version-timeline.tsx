import { cn } from 'cn'
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react'

import { type TimelineTarget, targetAt } from './version-timeline-target'

// A horizontal timeline over a component's versions, drawn as the kit's range
// slider: a muted track, the selected span over it in the primary colour, and
// a round thumb at each end of the selection. The two thumbs sit on one point
// to select one version and move apart to select the range between them.
//
// Three gestures, each with a mouse or a finger:
//   a thumb         moves that end only; pulled across the other, the two swap
//                   so the thumb under the pointer keeps following it
//   the band        the selected span between the thumbs moves as a whole,
//                   keeping how many versions it spans
//   the track       a press anywhere else jumps the nearer end to that point
//                   and goes on dragging it
// Two joined thumbs are a band of one version: dragging them moves the
// selected version. Shift-dragging them pulls one end out into a range; with
// a finger, a press on the track where the range should end does the same.
// Every one of them snaps to a point. Which one a press starts is decided from
// where it lands (`targetAt`), so the parts are drawn without pointer handling
// of their own. Each thumb is a slider for the keyboard; the band is a pointer
// shortcut for two thumb moves and has no keyboard stop of its own.
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

export interface VersionTimelinePoint {
  /** What the point is called: "v3", or "Draft". Unique on one timeline. */
  label: string
}

export interface VersionTimelineProps {
  /** Oldest first. */
  points: VersionTimelinePoint[]
  /** Indices into `points`; equal means one version is selected, not a range.
   *  What a selection MEANS is not this control's business — it reports which
   *  points are chosen and the host decides what that asks for. */
  from: number
  to: number
  onChange: (from: number, to: number) => void
}

type Handle = 'from' | 'to'

type Drag =
  | { kind: 'handle'; handle: Handle }
  | { kind: 'band'; startX: number; startFrom: number; span: number; step: number }

/** The least distance between two label centres, in px: room for "v100" or
 *  "Draft" at the label size with a gap either side. */
const LABEL_SPACING = 40

function percentFor(index: number, count: number): number {
  // A lone point sits in the middle rather than at the left edge, where it would
  // read as the start of a track that continues.
  return count > 1 ? (index / (count - 1)) * 100 : 50
}

/** The points that get a label on a track `width` px wide. The selected ends
 *  are named first, then the timeline's own ends, then the rest left to right,
 *  each only where it keeps LABEL_SPACING from every label already placed — so
 *  a wide track names every point and a narrow or crowded one thins out
 *  without two labels ever overlapping. */
function labelledPoints(count: number, from: number, to: number, width: number): Set<number> {
  const placed: number[] = []
  const named = new Set<number>()
  const order = [from, to, 0, count - 1, ...Array.from({ length: count }, (_, i) => i)]
  for (const i of order) {
    if (named.has(i) || i < 0 || i >= count) {
      continue
    }
    const x = (percentFor(i, count) / 100) * width
    if (placed.every((p) => Math.abs(p - x) >= LABEL_SPACING)) {
      placed.push(x)
      named.add(i)
    }
  }
  return named
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function VersionTimeline({ points, from, to, onChange }: VersionTimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const thumbRefs = useRef<Record<Handle, HTMLButtonElement | null>>({ from: null, to: null })
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState<Drag['kind'] | null>(null)
  // What a press would grab under the mouse, so hover shows the part a press
  // takes rather than the element under the cursor.
  const [hovered, setHovered] = useState<TimelineTarget | null>(null)
  const [width, setWidth] = useState(0)
  const count = points.length

  // The selection as last reported. Pointer moves can arrive faster than the
  // host re-renders, and a move computed from the previous render's props
  // would undo the one before it — a swap most visibly.
  const selection = useRef({ from, to })
  selection.current = { from, to }

  // Labels are thinned by the width they have, so the width is measured
  // before the first paint and followed as the container resizes.
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) {
      return
    }
    setWidth(track.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(track)
    return () => observer.disconnect()
  }, [])

  const indexFromClientX = (clientX: number): number => {
    const track = trackRef.current
    if (!track || count < 2) {
      return 0
    }
    const rect = track.getBoundingClientRect()
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    return clamp(Math.round(ratio * (count - 1)), 0, count - 1)
  }

  const report = (nextFrom: number, nextTo: number) => {
    const current = selection.current
    if (nextFrom !== current.from || nextTo !== current.to) {
      selection.current = { from: nextFrom, to: nextTo }
      onChange(nextFrom, nextTo)
    }
  }

  // Moving one end past the other swaps them and returns the end now being
  // moved, so a drag keeps following the pointer instead of sticking at the
  // crossing point, and the keyboard focus follows the value it moved.
  const moveHandle = (handle: Handle, index: number): Handle => {
    const current = selection.current
    const next = handle === 'from' ? { from: index, to: current.to } : { from: current.from, to: index }
    if (next.from > next.to) {
      report(next.to, next.from)
      return handle === 'from' ? 'to' : 'from'
    }
    report(next.from, next.to)
    return handle
  }

  const targetFor = (clientX: number): TimelineTarget => {
    const track = trackRef.current
    if (!track) {
      return 'track'
    }
    const rect = track.getBoundingClientRect()
    const centre = (index: number) => (percentFor(index, count) / 100) * rect.width
    return targetAt(clientX - rect.left, centre(selection.current.from), centre(selection.current.to))
  }

  // Every press lands on the track, whichever part is drawn under it, and the
  // drag is captured there so the moves arrive in one place however far the
  // pointer strays.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current
    if (e.button !== 0 || !track) {
      return
    }
    // Withholds the focus a press would give; the grabbed thumb takes it below.
    e.preventDefault()
    e.stopPropagation()
    const target = targetFor(e.clientX)
    const current = selection.current
    const joined = current.from === current.to
    let next: Drag
    if (target === 'band' || (joined && target !== 'track' && !e.shiftKey)) {
      next = {
        kind: 'band',
        startX: e.clientX,
        startFrom: current.from,
        span: current.to - current.from,
        step: track.getBoundingClientRect().width / (count - 1),
      }
    } else if (target === 'track') {
      const index = indexFromClientX(e.clientX)
      const nearer = Math.abs(index - current.from) <= Math.abs(index - current.to) ? 'from' : 'to'
      next = { kind: 'handle', handle: moveHandle(nearer, index) }
    } else {
      next = { kind: 'handle', handle: target }
    }
    if (next.kind === 'handle') {
      thumbRefs.current[next.handle]?.focus()
    }
    drag.current = next
    setDragging(next.kind)
    track.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current) {
      setHovered(e.pointerType === 'mouse' ? targetFor(e.clientX) : null)
      return
    }
    if (current.kind === 'handle') {
      drag.current = { kind: 'handle', handle: moveHandle(current.handle, indexFromClientX(e.clientX)) }
      return
    }
    const moved = current.step > 0 ? Math.round((e.clientX - current.startX) / current.step) : 0
    const nextFrom = clamp(current.startFrom + moved, 0, count - 1 - current.span)
    report(nextFrom, nextFrom + current.span)
  }

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null
    setDragging(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const onKeyDown = (handle: Handle) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const keySteps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowDown: -1,
      ArrowRight: 1,
      ArrowUp: 1,
      Home: -count,
      End: count,
    }
    const step = keySteps[e.key]
    if (step === undefined) {
      return
    }
    e.preventDefault()
    const current = handle === 'from' ? selection.current.from : selection.current.to
    const moved = moveHandle(handle, clamp(current + step, 0, count - 1))
    if (moved !== handle) {
      thumbRefs.current[moved]?.focus()
    }
  }

  const named = labelledPoints(count, from, to, width)
  const fromPercent = percentFor(from, count)
  const toPercent = percentFor(to, count)

  return (
    <div className='px-4 pb-2'>
      <div
        ref={trackRef}
        className={cn(
          'relative h-11 touch-none select-none',
          dragging ? 'cursor-grabbing' : hovered === 'track' || hovered === null ? 'cursor-pointer' : 'cursor-grab',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHovered(null)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        {/* The end points sit on the track's edges, and a thumb there reaches
            HIT_REACH (22px) past them: this layer carries those presses to
            the track. */}
        <span aria-hidden className='absolute inset-y-0 -inset-x-5.5' />

        {/* The band: the selected span as one piece, a capsule joining the
            two thumbs. Beneath the track so the span reads on top of it. */}
        {from < to && (
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute top-1/2 -ml-2 h-4 -translate-y-1/2 rounded-full transition-colors',
              hovered === 'band' || dragging === 'band' ? 'bg-primary/25' : 'bg-primary/15',
            )}
            style={{ left: `${fromPercent}%`, width: `calc(${toPercent - fromPercent}% + 1rem)` }}
          />
        )}

        <div className='pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted' />
        <div
          className='pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary'
          style={{ left: `${fromPercent}%`, width: `${toPercent - fromPercent}%` }}
        />

        {/* A tick per point, so the stops a drag snaps to are visible. */}
        {points.map((point, i) => (
          <span
            key={point.label}
            aria-hidden
            className={cn(
              'pointer-events-none absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full',
              i >= from && i <= to ? 'bg-primary-foreground' : 'bg-muted-foreground/60',
            )}
            style={{ left: `${percentFor(i, count)}%` }}
          />
        ))}

        {/* The thumbs, drawn as the kit slider's. A finger finds them by the
            reach `targetAt` gives them, not by their own size. On one point
            the two discs coincide and read as a single thumb. */}
        {(['from', 'to'] as const).map((handle) => {
          const index = handle === 'from' ? from : to
          return (
            <button
              key={handle}
              ref={(el) => {
                thumbRefs.current[handle] = el
              }}
              type='button'
              role='slider'
              aria-label={from === to ? 'Selected version' : handle === 'from' ? 'Range start' : 'Range end'}
              aria-valuemin={0}
              aria-valuemax={count - 1}
              aria-valuenow={index}
              aria-valuetext={points[index]?.label}
              aria-orientation='horizontal'
              onKeyDown={onKeyDown(handle)}
              className={cn(
                'pointer-events-none absolute top-1/2 block size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary bg-white shadow-sm ring-ring/50 outline-none transition-[color,box-shadow] focus-visible:ring-4',
                hovered === handle && 'ring-4',
              )}
              style={{ left: `${percentFor(index, count)}%` }}
            />
          )
        })}

        {/* Labels under the track, as many as the width keeps apart. */}
        {points.map((point, i) =>
          named.has(i) ? (
            <span
              key={`label-${point.label}`}
              className={cn(
                'pointer-events-none absolute top-full -mt-2 -translate-x-1/2 text-xs whitespace-nowrap tabular-nums',
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
