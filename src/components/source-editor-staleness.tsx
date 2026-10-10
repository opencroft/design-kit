import { Button } from '@opencroft/client/ui'
import { History, X } from 'lucide-react'

// A publish refused because the component moved underneath the editor. Amber,
// not red — nothing is broken and nothing is lost — and a different component from the
// validation refusal on purpose: different cause, different recovery,
// different words, and a different colour so the two are never read as one
// event. Recovery is manual by design — the panel says what Reload does
// BEFORE it is pressed.

export interface StalenessInfo {
  /** The version that is published now. */
  publishedVersion: number
  /** The version the open editor was built on: 0 when the draft was started
   *  before the component was first published, which is the number the store
   *  itself answers for a component with no published version. */
  baseVersion: number
  /** Already formatted — this panel does not decide how a time reads. */
  publishedAt: string
  /** Who published it. Optional because a record written before publishing
   *  recorded an author has none, and those are still out there: absent, the
   *  sentence ends at the time rather than trailing a "by" with nothing after
   *  it, which reads as a fault in the page. */
  publishedBy?: string
  /** Whether the name was supplied by whoever published or worked out by the
   *  system. Unqualified is the stronger claim, so a caller that says nothing
   *  under-claims rather than over-claims.
   *
   *  **Not rendered, and kept deliberately.** Nothing can currently produce
   *  anything but `declared`, so a qualifier would appear on every name and
   *  distinguish nothing — and it would hedge the clause that is itself the
   *  exception, doubting the rare case where a publisher IS named while the
   *  common case, where nobody is, passes without comment. The caveat it would
   *  carry: this surface cannot vouch for the name, only that someone
   *  published under it. */
  attribution?: 'declared' | 'derived'
}

export interface SourceEditorStalenessProps extends StalenessInfo {
  onReloadLatest?: () => void
  onDismiss?: () => void
}

export function SourceEditorStaleness({
  publishedVersion,
  baseVersion,
  publishedAt,
  publishedBy,
  onReloadLatest,
  onDismiss,
}: SourceEditorStalenessProps) {
  return (
    <div role='status' className='@container w-full rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2'>
      <div className='flex items-start gap-2'>
        <History aria-hidden='true' className='mt-0.5 size-4 shrink-0 text-amber-600' />
        <div className='min-w-0 flex-1'>
          <p className='text-sm font-medium text-foreground'>
            Someone published this component while you were editing.
          </p>
          <p className='pt-0.5 text-xs break-words text-muted-foreground'>
            It is now v{publishedVersion}, published at {publishedAt}
            {publishedBy ? ` — by ${publishedBy}` : ''}.{' '}
            {baseVersion > 0
              ? `Your version was built on v${baseVersion}.`
              : 'Your draft was started before it was first published.'}
          </p>
        </div>
        {onDismiss ? (
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-6 shrink-0'
            aria-label='Dismiss'
            onClick={onDismiss}
          >
            <X className='size-3.5' />
          </Button>
        ) : null}
      </div>
      {/* `!`: the host stylesheet loads after this one and redefines the base
          display utilities, so a variant that overrides one needs the flag. */}
      <div className='flex flex-col gap-2 pt-2 @[420px]:flex-row! @[420px]:items-start'>
        <Button type='button' size='sm' className='shrink-0 self-start' onClick={onReloadLatest}>
          Reload latest
        </Button>
        <p className='min-w-0 text-xs break-words text-muted-foreground'>
          It opens v{publishedVersion} in the editor and keeps your changes. Every file you had changed is marked, and
          you copy across what you want, one file at a time. Nothing is merged for you.
        </p>
      </div>
    </div>
  )
}
