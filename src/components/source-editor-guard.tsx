import { Button } from '@opencroft/client/ui'

import { useDismissOnEscape } from './use-dismiss-on-escape'

// The prompt between work a save did not store and leaving the editor. It
// fires for ONE situation, a save that failed. Typing reaches the draft on its own, so a save that has
// merely not fired yet is flushed on the way out and asks nobody anything — a
// dialog for a debounce window is noise, and noise is what teaches people to
// dismiss the dialog that matters. An unpublished draft is not at risk either.
//
// There is no "save and leave": saving is the thing that is not working, so
// offering it either does nothing or fails again without saying so. Recovery
// has one home, the “Not saved” bar. A backdrop and a panel rather than a
// modal primitive, positioned within the editor page it belongs to.
export interface SourceEditorGuardProps {
  open: boolean
  /** Files a failed save left in this tab and nowhere else. */
  dirtyCount: number
  onDiscard?: () => void
  onStay?: () => void
}

export function SourceEditorGuard({ open, dirtyCount, onDiscard, onStay }: SourceEditorGuardProps) {
  // `onStay`, never `onDiscard` — which here is "Leave anyway", the answer that
  // loses the files this panel exists to protect. Escape stays on the page.
  useDismissOnEscape(open, onStay)
  if (!open) {
    return null
  }
  return (
    // A click on the backdrop is a pointer shortcut for "Stay". The keyboard
    // has the same answer through Escape and the focused button, so the
    // backdrop takes no focus and no key of its own.
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut; the keyboard answers through Escape
    // biome-ignore lint/a11y/useKeyWithClickEvents: pointer shortcut; the keyboard answers through Escape
    <div className='absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-4' onClick={onStay}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only keeps a click inside the panel from reaching the backdrop */}
      <div
        role='alertdialog'
        aria-label='Leave with work that was not saved?'
        className='@container w-full max-w-sm rounded-lg border bg-background p-4 shadow-lg'
        onClick={(e) => e.stopPropagation()}
      >
        <p className='text-sm font-medium'>Leave with work that was not saved?</p>
        <p className='pt-1 text-xs break-words text-muted-foreground'>
          A save did not complete, so {dirtyCount} file{dirtyCount === 1 ? '' : 's'} {dirtyCount === 1 ? 'is' : 'are'}{' '}
          still only in this tab. Leaving loses {dirtyCount === 1 ? 'it' : 'them'}. Staying keeps the “Not saved” bar,
          which says what went wrong and can try again.
        </p>
        {/* Reversed, so the safe answer is under the thumb and the destructive
            one is furthest from it.

            No wide arm: the panel is capped at 384px with 16px of padding a
            side, so the box its own container query measures tops out at 352 —
            eight short of the 360px breakpoint, at every viewport there is. A
            wide variant could never match. */}
        <div className='flex flex-col-reverse gap-2 pt-3'>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='text-destructive hover:text-destructive'
            onClick={onDiscard}
          >
            Leave anyway
          </Button>
          <Button type='button' size='sm' autoFocus onClick={onStay}>
            Stay
          </Button>
        </div>
      </div>
    </div>
  )
}
