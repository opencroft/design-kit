import { React } from '@ext/host'
import { Button } from '@ext/ui'

import { useDismissOnEscape } from './use-dismiss-on-escape'

// The question between a draft and throwing it away.
//
// This editor does not confirm its file operations, and says why: a modal
// "would claim an irreversibility that isn't there", because everything else
// here writes to the draft and is undone by not publishing. That premise is
// exactly what fails for this one act — a discard IS the undoing, so there is
// nothing behind it to fall back to. The rule read on its own terms asks for a
// dialog here rather than forbidding one.
//
// Its own panel rather than a second mood on the leaving guard: that one is
// about work a failed save left in the tab, this one about work that was
// stored and is being deliberately thrown away. One dialog with two moods
// would make a reader work out which of them they are looking at, which is the
// same reason the notices below stack rather than merge.
export interface SourceEditorDiscardProps {
  /** The published version everything goes back to, or null for no dialog.
   *
   *  One value rather than an `open` flag beside a number: a flag would permit
   *  a state that is not real — open, with no version to go back to — and a
   *  caller reaching it would fill the gap with a number it had not read, so
   *  this dialog would tell someone their files return to a version that never
   *  existed. With the two collapsed there is no such state to reach: a
   *  version is what opens this, so the sentence below can only ever name one
   *  that was established. */
  version: number | null
  onDiscard?: () => void
  onCancel?: () => void
}

export function SourceEditorDiscard({ version, onDiscard, onCancel }: SourceEditorDiscardProps) {
  // Loose on purpose, and not a tightening anyone should apply: "no version" is
  // the condition, and a prop that arrives absent means that as much as one
  // that arrives null. A caller that coerces null to undefined before it
  // reaches a prop produces the absent form, so a strict check here would
  // render a dialog whose sentence names nothing at all.
  const shown = version != null
  // `onCancel`, never `onDiscard` — Escape keeps the draft. It sits above the
  // early return because a hook cannot be called conditionally, and takes the
  // condition as an argument instead.
  useDismissOnEscape(shown, onCancel)
  if (!shown) {
    return null
  }
  return (
    <div className='absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-4' onClick={onCancel}>
      <div
        role='alertdialog'
        aria-label='Discard this draft?'
        className='@container w-full max-w-sm rounded-lg border bg-background p-4 shadow-lg'
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <p className='text-sm font-medium'>Discard this draft?</p>
        {/* Says what comes back rather than how much goes, on purpose. A count
            of changed files reads as the size of the loss, and it is not: a
            draft that changed only the component's description has no changed
            files and is still a draft, so a number here would say "0" over a
            dialog about losing something. */}
        <p className='pt-1 text-xs break-words text-muted-foreground'>
          Every file of this component goes back to v{version}. Anything in the draft that has not been published is lost, and this cannot be undone.
        </p>
        {/* Reversed, so the safe answer is under the thumb and the destructive
            one is furthest from it — the same arrangement as the leaving
            guard, for the same reason. */}
        <div className='flex flex-col-reverse gap-2 pt-3'>
          <Button type='button' variant='ghost' size='sm' className='text-destructive hover:text-destructive' onClick={onDiscard}>
            Discard
          </Button>
          <Button type='button' size='sm' autoFocus onClick={onCancel}>
            Keep the draft
          </Button>
        </div>
      </div>
    </div>
  )
}
