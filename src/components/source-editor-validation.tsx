import { icons, React } from '@ext/host'
import { Button } from '@ext/ui'

import { cn } from 'cn'

// A failed check reported at the moment it matters. Every entry carries the
// file it came from and opens it — "what failed" is useless without "where" —
// and the panel says what has become of the work in the same breath as the
// failure, because a report that leaves that unsaid reads as a loss. That
// sentence is the only part that changes between the moments a check is read
// at: one that ran on a save, a publish about to ship what it found, and one
// that already did. A failure never refuses the publish — someone who has read
// what failed and ships anyway has made a choice. A target that reads something
// only a browser has is listed in a quieter tone and said in words to be not a
// failure.
const { AlertTriangle, X } = icons

export interface CheckResult {
  /** The target, worded the way the validator words it. */
  target: string
  outcome: 'error' | 'unverifiable'
  message: string
  /** The file the target came from, where one is attributable. */
  file?: string
}

/**
 * Which moment the panel is reporting at. The failures are the same list in all
 * three; what changes is what has become of the work, and that is the part a
 * reader decides on.
 */
export type CheckMoment = 'draft' | 'publishing' | 'published'

/** What has become of the work, per moment. Written out rather than assembled
 *  from fragments, because these are the sentences somebody decides on. */
const CONSEQUENCE: Record<CheckMoment, { title: (count: number, s: string) => string; detail: string }> = {
  draft: {
    title: (count, s) => `${count} target${s} failed`,
    detail: 'The draft holds them. Nothing is published.',
  },
  publishing: {
    title: (count, s) => `${count} target${s} failing — publish anyway?`,
    detail: 'Publishing ships them to everyone who installs this component.',
  },
  published: {
    title: (count, s) => `Published with ${count} failing target${s}`,
    detail: 'Everyone who installs this component now gets them.',
  },
}

export interface SourceEditorValidationProps {
  results: CheckResult[]
  /** Defaults to `draft` — a check that ran when the draft was written. */
  moment?: CheckMoment
  onOpenFile?: (path: string) => void
  onDismiss?: () => void
}

export function SourceEditorValidation({ results, moment = 'draft', onOpenFile, onDismiss }: SourceEditorValidationProps) {
  const failures = results.filter((r) => r.outcome === 'error')
  const hasFailures = failures.length > 0
  const ordered = [...failures, ...results.filter((r) => r.outcome !== 'error')]
  const consequence = CONSEQUENCE[moment]

  return (
    <div
      role='status'
      className={cn('w-full rounded-md border px-3 py-2', hasFailures ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-muted/30')}
    >
      <div className='flex items-start gap-2'>
        <AlertTriangle aria-hidden='true' className={cn('mt-0.5 size-4 shrink-0', hasFailures ? 'text-destructive' : 'text-muted-foreground')} />
        <div className='min-w-0 flex-1'>
          <p className={cn('text-sm font-medium', hasFailures ? 'text-destructive' : 'text-foreground')}>
            {hasFailures ? consequence.title(failures.length, failures.length === 1 ? '' : 's') : 'Nothing failed'}
          </p>
          <p className='pt-0.5 text-xs text-muted-foreground'>
            {hasFailures ? consequence.detail : 'The targets below could not be checked ahead of a real preview.'}
          </p>
        </div>
        {onDismiss ? (
          <Button type='button' variant='ghost' size='icon' className='size-6 shrink-0' aria-label='Dismiss' onClick={onDismiss}>
            <X className='size-3.5' />
          </Button>
        ) : null}
      </div>

      <ul className='space-y-1 pt-2'>
        {ordered.map((result) => {
          const failed = result.outcome === 'error'
          const body = (
            <>
              <span className={cn('block font-mono text-xs break-all', failed ? 'text-destructive' : 'text-muted-foreground')}>{result.target}</span>
              <span className='block pt-0.5 text-xs break-words text-foreground'>{result.message}</span>
              {failed ? null : (
                <span className='block pt-0.5 text-xs text-muted-foreground'>
                  Not a failure. This target reads something only a browser has, so it cannot be checked here.
                </span>
              )}
              {result.file ? (
                <span className='block truncate pt-1 text-xs text-muted-foreground underline underline-offset-2' title={result.file}>
                  {result.file}
                </span>
              ) : null}
            </>
          )
          const tone = failed ? 'border-destructive/30 bg-background' : 'border-border bg-background'
          return (
            <li key={`${result.target}:${result.file ?? ''}`}>
              {result.file && onOpenFile ? (
                <button
                  type='button'
                  onClick={() => onOpenFile(result.file as string)}
                  className={cn('block w-full rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-muted', tone)}
                >
                  {body}
                </button>
              ) : (
                <div className={cn('rounded-md border px-2 py-1.5', tone)}>{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
