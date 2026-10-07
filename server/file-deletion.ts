// Which file records a delete request addresses, decided once.
//
// Deciding it twice with two different rules — `find` ONE record per requested
// string, that record being the only one reported and the only one whose stored
// file is removed, then persist the record list through a `filter` that drops
// EVERY record matching the same string — disagrees exactly when a component
// holds more than one record a single string addresses. Then both halves are
// wrong at once: more records go than the call reports, and the stored file
// removed belongs to whichever record `find` happens to reach first, which need
// not be one of the records the caller was thinking of. For a component holding
//
//   { path: 'components/ui/x.tsx', target: 'components/ui/feedback/x.tsx' }
//   { path: 'components/ui/x.tsx', target: 'components/ui/x.tsx' }
//
// deleting 'components/ui/x.tsx' that way reports one path, removes both
// records, and leaves the second record's file on disk with nothing pointing at
// it.
//
// So the selection lives here, host-free, and the store applies it: the same
// set is what is removed from the record, what is reported, and whose stored
// files go.
//
// EVERY match, not the first. A request that addresses two records removes
// both. The alternative — take the first — reads like the smaller change and is
// not: it makes position in the array the rule for which of two records a
// string means, which is a disambiguation nobody chose and no caller can see.
// Whether a single record among several sharing a path SHOULD be addressable is
// an open product question; every-match leaves it open, because the answer to
// it is a new argument this function does not have, not a different reading of
// the argument it does.

/** The part of a file record a delete request can name. */
export interface AddressableFile {
  path: string
  target: string
}

export interface DeletionPlan<T> {
  /** Every record the request addresses, in declaration order. */
  removed: T[]
  /** The requested strings that addressed at least one record. */
  deleted: string[]
  /** The requested strings that addressed none. */
  missing: string[]
  /** The records that stay, in declaration order. */
  remaining: T[]
}

/**
 * One record, one request string: does that string name this record?
 *
 * Both fields, because the documented parameter is "file paths/targets" and
 * nothing distinguishes which of the two a caller meant. That is also why one
 * string can name two records at once.
 */
export function addresses(file: AddressableFile, request: string): boolean {
  return file.target === request || file.path === request
}

export function planDeletion<T extends AddressableFile>(files: T[], requests: string[]): DeletionPlan<T> {
  const removing = new Set<T>()
  const deleted: string[] = []
  const missing: string[] = []
  for (const request of requests) {
    const matched = files.filter((file) => addresses(file, request))
    if (matched.length === 0) {
      missing.push(request)
      continue
    }
    for (const file of matched) {
      removing.add(file)
    }
    deleted.push(request)
  }
  // Partitioned out of the original list rather than accumulated per request,
  // so a record two different strings both name is removed once and appears
  // once, and both lists keep the order the component declared.
  return {
    removed: files.filter((file) => removing.has(file)),
    deleted,
    missing,
    remaining: files.filter((file) => !removing.has(file)),
  }
}
