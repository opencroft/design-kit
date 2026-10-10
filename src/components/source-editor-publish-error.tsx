import { Button } from '@opencroft/client/ui'
import { X, XCircle } from 'lucide-react'

// A publish that did not complete. The act failed — nothing examined the work
// and turned it down. That is the distinction this panel exists to hold, and it is said in
// words rather than only in colour, because the other two panels in this family
// are told apart by colour and a reader should not have to remember which is
// which. Three facts, the same discipline the staleness panel keeps: that
// publishing stopped, what became of the work, and what the system actually
// said. The third is the one a toast destroys — gone before anyone has decided
// whether it mattered, and the first thing the next person will ask for.

export interface PublishErrorInfo {
  /** What the system said, as it said it. Not rewritten into something
   *  friendlier: this is the line whoever is told about the failure next will
   *  ask for, and a reassuring paraphrase of it is worth nothing to them. */
  message: string
  /** The version an installer still gets. Optional, and the sentence simply
   *  ends when it is absent rather than inventing a guarantee — a surface that
   *  cannot say what is published should not have this panel say it for it. */
  publishedVersion?: number
}

export interface SourceEditorPublishErrorProps extends PublishErrorInfo {
  onRetry?: () => void
  onDismiss?: () => void
}

export function SourceEditorPublishError({
  message,
  publishedVersion,
  onRetry,
  onDismiss,
}: SourceEditorPublishErrorProps) {
  return (
    <div
      // `alert` rather than the `status` its siblings carry, and the difference
      // is deliberate rather than a slip: the failure it reports is otherwise
      // silent, so it announces instead of waiting to be found.
      role='alert'
      className='@container w-full rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2'
    >
      <div className='flex items-start gap-2'>
        {/* Not the warning triangle and not the alert circle: this editor
            already spends both, on a check that warned and on a file a failure
            came from. A cross is the one that means the act itself did not
            happen, which is what this panel is for. */}
        <XCircle aria-hidden='true' className='mt-0.5 size-4 shrink-0 text-destructive' />
        <div className='min-w-0 flex-1'>
          <p className='text-sm font-medium text-destructive'>Publishing did not complete.</p>
          <p className='pt-0.5 text-xs break-words text-muted-foreground'>
            Nothing was published.{publishedVersion ? ` An installer still gets v${publishedVersion}.` : ''}
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

      {/* What the system said, kept rather than summarised, and selectable so
          it can be handed on. */}
      <p className='mt-2 rounded-md border bg-background px-2 py-1.5 font-mono text-xs break-all text-foreground'>
        {message}
      </p>

      {/* `!`: the host stylesheet loads after this one and redefines the base
          display utilities, so a variant that overrides one needs the flag. */}
      <div className='flex flex-col gap-2 pt-2 @[420px]:flex-row! @[420px]:items-start'>
        {onRetry ? (
          <Button type='button' size='sm' className='shrink-0 self-start' onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {/* The discriminator, spelled out. A reader arriving at a red panel has
            no way to know which of three things happened, and being told what
            did NOT happen is what stops a machine fault being read as their
            mistake. */}
        <p className='min-w-0 text-xs break-words text-muted-foreground'>
          Nothing refused this: no check failed, and nobody else published while you were editing. The publish itself
          did not finish, so it is a fault to report rather than something to fix in the component. If it happens again,
          the message above is what someone will need.
        </p>
      </div>
    </div>
  )
}
