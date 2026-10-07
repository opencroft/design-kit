import { icons } from '@ext/host'
import { Button } from '@ext/ui'

import { discardAvailability } from './discard-availability'

// Back, which component is open, what state it is in, and the two acts it
// offers. There is no Save — typing reaches the draft on its own, so a control
// for it would be a control for something that has already happened, sitting
// disabled almost all of the time and reading as broken rather than idle.
// Publish and Discard are buttons because they are the deliberate acts, and
// nothing should do either on somebody's behalf while they type. The discard
// availability rule lives in a sibling module: it decides whether a destructive
// control is offered, and keeping it separate is what lets it be asserted
// rather than only read.
const { Check, ChevronLeft, Loader2 } = icons

/** `warned` is a publish held at the last moment by a failed check — the panel
 *  above says what failed, and the button says what pressing it now does. */
export type PublishState = 'idle' | 'busy' | 'warned' | 'done'

export interface SourceEditorHeaderProps {
  componentName: string
  /** The published version. */
  version: number
  /** The draft holds changes the published version does not — persisted, so it
   *  cannot be lost, and stated quietly. */
  draftAhead?: boolean
  /** The version a discard returns to, or null when this component has never
   *  been published and there is nowhere to return it to.
   *
   *  Required, and separate from `version` above, which is what this header
   *  DISPLAYS. The two are the same number whenever both exist, but only this
   *  one is permitted to be absent — so a caller cannot satisfy it by handing
   *  over whatever it happened to be showing. */
  discardTarget: number | null
  /** Files that have changed since the published version — the same fact the
   *  file list marks with a dot, counted. It has to be that definition and not
   *  another: this number sits directly above those markers, and two counts of
   *  "changed" on one screen is how a reader stops trusting either. */
  dirtyCount?: number
  publish?: PublishState
  /** A discard in flight. Separate from `publish` because they are different
   *  acts on the same draft, and folding them into one state would let a
   *  reader think one had started the other. */
  discarding?: boolean
  onBack?: () => void
  onPublish?: () => void
  onDiscard?: () => void
}

export function SourceEditorHeader({
  componentName,
  version,
  draftAhead = false,
  discardTarget,
  dirtyCount = 0,
  publish = 'idle',
  discarding = false,
  onBack,
  onPublish,
  onDiscard,
}: SourceEditorHeaderProps) {
  const dirty = dirtyCount > 0
  const publishing = publish === 'busy'
  const warned = publish === 'warned'
  const published = publish === 'done'
  const showDraftAhead = draftAhead && !published

  // Held by a failed check, the button changes what it says and how it looks.
  // The check does not refuse the publish, so this press is the decision — and a
  // decision offered under the same word it had before the warning is one made
  // without noticing.
  const publishLabel = publishing ? 'Publishing' : warned ? 'Publish anyway' : 'Publish'
  const publishTitle = publishing
    ? 'Publishing'
    : warned
      ? 'Ships the failing targets to everyone who installs this component'
      : draftAhead
        ? undefined
        : 'Nothing to publish'

  const publishButton = (
    <Button
      type='button'
      size='sm'
      variant={warned ? 'destructive' : 'default'}
      className='shrink-0'
      onClick={onPublish}
      disabled={!draftAhead || publishing || discarding}
      title={publishTitle}
    >
      {publishing ? <Loader2 className='size-3.5 animate-spin' /> : null}
      {publishLabel}
    </Button>
  )

  // Quiet beside Publish: both act on the draft, and only one of them is what
  // somebody came here to do.
  //
  // The two do NOT share a disabled condition. A draft is all Publish needs —
  // on a component with nothing published, publishing is precisely the thing to offer, and it is what
  // creates the version the other act requires. Discard needs that version to
  // already exist, so it has a second condition Publish does not, and the two
  // are decided in different places for that reason rather than by oversight.
  //
  // Availability and the title come back together so that a dim button and the
  // sentence explaining it cannot describe different states.
  const discard = discardAvailability(draftAhead, discardTarget)
  const discardButton = (
    <Button
      type='button'
      size='sm'
      variant='ghost'
      className='shrink-0 text-muted-foreground hover:text-destructive'
      onClick={onDiscard}
      disabled={!discard.available || publishing || discarding}
      title={discard.title}
    >
      {discarding ? <Loader2 className='size-3.5 animate-spin' /> : null}
      Discard
    </Button>
  )

  return (
    <div className='@container w-full'>
      <div className='flex w-full items-center gap-2 border-b px-2 py-1.5'>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          aria-label='Back to the component page'
          className='size-7 shrink-0 text-muted-foreground'
          onClick={onBack}
        >
          <ChevronLeft className='size-4' />
        </Button>

        <div className='flex min-w-0 flex-1 flex-col overflow-hidden'>
          <span className='truncate text-sm leading-tight font-medium'>{componentName}</span>
          <span className='flex min-w-0 items-center gap-1 overflow-hidden text-xs leading-tight text-muted-foreground'>
            <span className='shrink-0 tabular-nums'>v{version}</span>
            {published ? (
              <span className='flex shrink-0 items-center gap-1 text-emerald-600'>
                <Check className='size-3' />
                published just now
              </span>
            ) : null}
            {dirty ? (
              <span className='shrink-0 font-medium text-foreground'>
                · {dirtyCount} file{dirtyCount === 1 ? '' : 's'} changed
              </span>
            ) : null}
            {showDraftAhead ? <span className='truncate'>· draft ahead</span> : null}
          </span>
        </div>

        {/* Two acts, and still nothing folds away at any width: both are short
            words and neither is optional enough to hide behind an overflow a
            reader has to find. Discard sits before Publish, so the deliberate
            act is the one at the edge, under the thumb. */}
        <div className='flex shrink-0 items-center gap-1'>
          {discardButton}
          {publishButton}
        </div>
      </div>
    </div>
  )
}
