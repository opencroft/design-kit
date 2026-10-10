// What a batch of renames does to a component: which records change, and which
// files actually have to move. Host-free, so the decision can be exercised
// without a repository.
//
// The action promises two things: that a batch is ATOMIC, and that it changes
// paths and NEVER CONTENT. Deciding the whole batch here, before anything is
// written, is what makes both true -- a request
// that cannot be satisfied is refused with nothing done, and a "move" that
// would write over content is refused rather than performed.

// Explicit extension: the test runner resolves relative imports the way Node
// does and will not guess one, and this module exists to be exercised without
// a repository. The bundler takes either form.
import { storagePath } from './component-paths.ts'

/** A file as a component's record declares it. Narrower than the placement
 *  `storagePath` accepts: a record always spells all three. */
export interface MovableFile {
  path: string
  target: string
  type: string
}

export interface Move {
  from: string
  to: string
}

/** One file that genuinely goes somewhere, in storage paths. */
export interface PlannedMove {
  from: string
  to: string
}

export interface MovePlan {
  /** The component's files after the batch, in their original order. */
  files: MovableFile[]
  /** Net relocations: where each file started against where it ends up. A file
   *  that comes back to where it began is not here, because nothing has to
   *  happen to it. */
  moves: PlannedMove[]
}

/**
 * Plan a batch of renames, or refuse it.
 *
 * Each request is resolved against the record as the batch has left it so far,
 * so a request naming a file an earlier move renamed resolves to that file.
 * The FILE work is worked out once at the end, from where each file started to
 * where it ends up: a rename chained through two names moves the file once,
 * and a rename undone later in the same batch moves it not at all.
 *
 * Two refusals, both for things the caller cannot see going wrong:
 *
 * - **a source that is not there** — checked first, because a batch
 *   naming a file the component does not have is a mistake about the component
 *   rather than about the move.
 * - **a destination another of this component's files already occupies.** The
 *   write would land on that file and the removal would then take the source
 *   away, so one file's content would replace another's and the record would
 *   end up declaring the same target twice. That is content changing, which
 *   this is documented not to do, and a record with a duplicated target lets a
 *   delete address two records at once.
 *
 * A cross-component collision is deliberately NOT refused here: only the store
 * can see what other components declare.
 *
 * **A rename to where the file already is moves nothing.** Writing a file to
 * its own storage path and then removing that path is a delete -- the write
 * and the removal are the same file, and the removal is second. The record
 * still updates: a record can declare a `path` and a `target` that differ, so
 * the spelling can change without the content going anywhere.
 */
export function planMoves(name: string, files: MovableFile[], requested: Move[]): MovePlan {
  // Each file keeps the storage path it started at, so the work can be worked
  // out from where it began rather than from each step along the way.
  const tracked = files.map((file) => ({ origin: storagePath(name, file), file }))

  for (const move of requested) {
    const found = tracked.find((t) => t.file.target === move.from || t.file.path === move.from)
    if (!found) {
      throw new Error(`moveFiles: no file "${move.from}" on component "${name}".`)
    }
    const renamed: MovableFile = { path: move.to, target: move.to, type: found.file.type }
    const destination = storagePath(name, renamed)
    if (tracked.some((t) => t !== found && storagePath(name, t.file) === destination)) {
      throw new Error(
        `moveFiles: "${move.to}" is already a file of component "${name}", so moving "${move.from}" onto it would replace its content. Delete or rename that file first.`,
      )
    }
    found.file = renamed
  }

  return {
    files: tracked.map((t) => t.file),
    moves: tracked.map((t) => ({ from: t.origin, to: storagePath(name, t.file) })).filter((m) => m.from !== m.to),
  }
}
