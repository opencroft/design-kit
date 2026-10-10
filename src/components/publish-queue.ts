// What a pressed Publish does next, given where the draft is.
//
// A press is never dropped. Publish acts on the stored draft, so a press that
// lands while typing is still on its way there has to wait for it rather than
// publish the draft without the last edit or do nothing at all. Doing nothing
// while a save is in flight means no request, no spinner, no message, and the
// header changing a second later when the save's own read comes back, which
// reads as the press having been ignored.

export type PublishStep =
  /** A save is in flight: wait for it to land. */
  | 'wait'
  /** Typing has not reached the draft yet: store it now, then come back. */
  | 'save'
  /** The last save failed. The press stops here, and the Not saved bar is
   *  what says why: publishing would ship a draft without what is on screen. */
  | 'stop'
  /** The draft holds everything typed: publish it. */
  | 'publish'

export interface DraftProgress {
  saving: boolean
  saveFailed: boolean
  /** The buffer holds typing the draft does not. */
  dirty: boolean
}

export function nextPublishStep({ saving, saveFailed, dirty }: DraftProgress): PublishStep {
  if (saving) {
    return 'wait'
  }
  if (saveFailed) {
    return 'stop'
  }
  return dirty ? 'save' : 'publish'
}
