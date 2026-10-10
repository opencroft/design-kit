import { cn } from 'cn'
import { type ComponentPropsWithoutRef, useEffect, useLayoutEffect, useRef, useState } from 'react'

// Follows the kit source (@opencroft/middle-truncate): middle truncation cannot
// be done in CSS — `text-overflow: ellipsis` only ever cuts the end, and the end
// is the informative part of a path, an id or a session key. So the split is
// measured — against the width actually available, at the element's actual font
// — rather than guessed from a character count that is wrong for every
// proportional typeface.

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export interface MiddleTruncateProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  /** The whole value. What is shown is derived from it and the width. */
  text: string
  /** Keep exactly this many characters at the end and give the rest to the
      head. Omitted, the two halves share the space evenly. */
  tailChars?: number
  ellipsis?: string
}

function build(chars: string[], keep: number, tailChars: number | undefined, ellipsis: string) {
  const tail = tailChars === undefined ? Math.floor(keep / 2) : Math.min(tailChars, keep)
  const head = keep - tail
  return chars.slice(0, head).join('') + ellipsis + (tail > 0 ? chars.slice(chars.length - tail).join('') : '')
}

export function MiddleTruncate({ text, tailChars, ellipsis = '…', className, ...props }: MiddleTruncateProps) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const rulerRef = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(text)

  useIsomorphicLayoutEffect(() => {
    const host = hostRef.current
    const ruler = rulerRef.current
    if (!host || !ruler) {
      return
    }
    let frame = 0
    let alive = true

    const measure = () => {
      frame = 0
      if (!alive) {
        return
      }
      const style = window.getComputedStyle(host)
      const available = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const widthOf = (candidate: string) => {
        ruler.textContent = candidate
        return ruler.getBoundingClientRect().width
      }

      // Not laid out yet, or the whole value fits: nothing to shorten. The
      // second case matters as much as the first — a widening container has to
      // give the text back, not keep the split it settled on when it was narrow.
      if (available <= 0 || widthOf(text) <= available) {
        ruler.textContent = ''
        setShown(text)
        return
      }

      // Binary search the number of characters that still fit: ~log2(length)
      // measurements, each one a forced layout, which is why this runs inside a
      // frame and only when the width, the text or the font has changed.
      const chars = Array.from(text)
      let low = 0
      let high = chars.length
      let best = ellipsis
      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        const candidate = build(chars, mid, tailChars, ellipsis)
        if (widthOf(candidate) <= available) {
          best = candidate
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      ruler.textContent = ''
      setShown(best)
    }

    const schedule = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(measure)
      }
    }

    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(host)

    // A webfont arriving after first paint changes every width on the element,
    // and a split measured against the fallback face is simply wrong once it
    // does.
    if (typeof document !== 'undefined' && document.fonts) {
      void document.fonts.ready.then(schedule)
    }

    return () => {
      alive = false
      if (frame) {
        window.cancelAnimationFrame(frame)
      }
      observer.disconnect()
    }
  }, [text, tailChars, ellipsis])

  const truncated = shown !== text

  return (
    <span
      ref={hostRef}
      title={truncated ? text : undefined}
      className={cn('relative block min-w-0 overflow-hidden whitespace-nowrap', className)}
      {...props}
    >
      <span aria-hidden='true'>{shown}</span>
      {/* Shortening is a presentational act, so the whole value stays in the
          accessibility tree. A screen reader reads the path; it does not read an
          ellipsis and stop. */}
      <span className='sr-only'>{text}</span>
      {/* The ruler: same element, same inherited font, absolutely positioned and
          invisible so measuring costs no layout of its own. */}
      <span
        ref={rulerRef}
        aria-hidden='true'
        className='pointer-events-none invisible absolute top-0 left-0 whitespace-pre'
      />
    </span>
  )
}
