import { createHash } from 'node:crypto'

// A component's state, as one opaque token.
//
// The token is derived from git's own index entries for the component's paths
// -- mode, object id, stage and path, exactly what `git ls-files -s` reports.
// Every draft write stages what it wrote, so the index IS the state a reader
// was handed, and asking git for it means the guard and the draft marker are
// two readings of ONE instrument rather than two facts that can drift.
//
// Nothing is stored for it. A timestamp written on every write is a ratchet:
// two honest writes advance it and the record can never return to its
// committed bytes, so a component edited and put back would stay marked as
// having unpublished work with nothing differing, and the only way out would
// be to publish it. Nothing derived from content has that problem.

/**
 * The token for one component, from the index listing of its paths.
 *
 * Pure, and deliberately so: the token is a function of what is staged and of
 * nothing else -- not of the clock, not of who wrote it, not of how many times.
 * **A listing that returns to an earlier value returns the earlier token**, and
 * that is the property to keep rather than an accident to design around. It is
 * what makes an edit-and-revert leave no trace, which is the whole point.
 *
 * Its one consequence for the optimistic guard is at `assertFresh`, where it is
 * written down: a write whose base state was restored before it landed is
 * accepted, because by then it is no longer writing over anything.
 *
 * Truncated because this is compared, never inverted, and it is shown to a
 * person in a staleness error. Sixty-four bits is far more than a concurrent
 * edit needs to be distinguishable.
 */
export function stateToken(indexListing: string): string {
  return createHash('sha256').update(indexListing).digest('hex').slice(0, 16)
}
