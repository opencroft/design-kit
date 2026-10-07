// Whether a discard is on offer, and what the control says about itself when
// it is not.
//
// Two things have to be true before this act exists at all: there is a draft to
// throw away, and there is a published version to throw it back to. Without the
// second, a component that has never been published would offer the control,
// open the confirmation, and the confirmation would name a version number that
// does not exist, because the screen had supplied a default where the record
// held nothing. The only refusal would come from the server, after the press.
//
// Availability and the reason are one answer rather than a condition and a
// title written beside each other. A control that is merely dim says nothing
// about why it is dim, and a title maintained separately from the condition is
// free to describe a state the button is not in — which is how "Nothing to
// discard" would end up over a component that has a draft and plainly does
// have something to discard.
//
// None of this replaces the store's own guard. That one refuses a discard on a
// component with no published version and leaves the draft where it is, and it
// has to keep doing so: this decides what is OFFERED on one screen, which is a
// different question from what is ALLOWED, and only the second is reached by a
// caller that is not this screen.

export interface DiscardAvailability {
  /** Whether the control can be pressed. */
  available: boolean
  /** What the control says about itself. Present in both states, so the
   *  sentence cannot go missing on the branch nobody looked at. */
  title: string
}

/**
 * `publishedVersion` is the version a discard returns to, or nothing when the
 * component has never been published.
 *
 * "Nothing" is an answer rather than an absent one: it is what a record holds
 * for a component with no published version, and substituting a number for it
 * is the defect this exists to prevent. Nothing here invents one, and nothing
 * downstream should either — a caller with a version to state has read it.
 *
 * Undefined is in the union and the check below is loose, both deliberately.
 * A caller that coerces a null value into an absent prop delivers the
 * never-published state as undefined, so a strict check would report it as
 * offerable.
 */
export function discardAvailability(draftAhead: boolean, publishedVersion: number | null | undefined): DiscardAvailability {
  if (!draftAhead) {
    return { available: false, title: 'Nothing to discard' }
  }
  if (publishedVersion == null) {
    // Deliberately not "Nothing to discard": there IS a draft, and telling
    // someone otherwise about work they can see on their screen is worse than
    // the dim button alone. What is missing is the far end of the act.
    return { available: false, title: 'There is no published version to discard back to' }
  }
  return { available: true, title: 'Take every file back to the published version' }
}
