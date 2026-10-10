// The published version an open draft is built on, and whether the component
// has moved past it.
//
// The number has to be the store's own, because it is handed back as a
// publish's `expectedVersion` and the store refuses any value that is not
// exactly its current version. For a component nobody has published, the
// store's answer is 0 and the record it serves carries no version at all.
// Reading that absence as v1 would make every never-published component
// unpublishable from the editor: the editor would claim v1 against the store's
// v0, and the publish would be refused as stale.

export interface PublishBase {
  version: number
  publishedAt: number
}

/** The two fields of a component record this reads. */
export interface PublishedFields {
  version?: number
  publishedAt?: number
}

/** A record's published point. An absent version is never published, which is
 *  version 0: the number the store answers for it and checks a publish against. */
export function publishBaseOf(record: PublishedFields): PublishBase {
  return { version: record.version ?? 0, publishedAt: record.publishedAt ?? 0 }
}

/** Whether what is published now differs from what the draft was built on, by
 *  version or by when that version was published. */
export function movedSince(base: PublishBase, now: PublishBase): boolean {
  return base.version !== now.version || base.publishedAt !== now.publishedAt
}
