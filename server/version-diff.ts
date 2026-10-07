// Pairing one component's files across two points in its history, so a range
// on the timeline can be shown file by file. Host-free and deliberately
// source-agnostic: the two sides are just file lists, so the same function
// serves version-to-version, version-to-draft, and anything later that has two
// ends.
//
// Files are paired by their declared TARGET rather than by storage path. The
// target is the path the component declares and a person recognises, it is what
// a history entry already reports, and it is stable across the one rewrite the
// storage path is subject to (an ignored file moving under `internal/<name>/`).

export interface ComparableFile {
  path: string
  target: string
  type: string
  content: string
}

export type FileChange = 'added' | 'removed' | 'changed' | 'unchanged'

export interface FileComparison {
  target: string
  type: string
  change: FileChange
  /**
   * Content on the older side, in THREE distinguishable states:
   *
   *   a string   — the file's bytes on that side, empty string included;
   *   null       — the file did not exist on that side;
   *   absent     — not carried, because this row is `unchanged` and both sides
   *                already hold the same bytes. Fetch them with `readVersion`.
   *
   * Two states would not be enough. An unchanged file carries no content and a
   * missing file has no content, so collapsing them would make content-absence
   * mean two different things — which is the exact conflation `change` exists
   * to prevent, reintroduced one level down.
   */
  before?: string | null
  /** Content on the newer side, with the same three states as `before`. */
  after?: string | null
}

// `change` is the authority on what happened, never the shape of `before` or
// `after`. Reading existence off the content is wrong in both directions: a
// file that exists and is empty carries '', and a file that is merely unchanged
// carries nothing at all.
const ORDER: Record<FileChange, number> = { added: 0, removed: 1, changed: 2, unchanged: 3 }

/**
 * Every file on either side, classified — and the CONTENT only of those where
 * something happened.
 *
 * The full list is always returned, unchanged files included, because the list
 * is the cheap part and dropping rows would make "what does this version hold"
 * unanswerable. What is dropped is their content: both sides of an unchanged
 * file are the same bytes, and `readVersion` already exists to fetch a version's
 * files when someone actually wants to read one.
 *
 * That distinction is most of the payload: when few files changed, unchanged
 * content would otherwise dominate the response, and comparing a component that
 * changed NOTHING would carry every byte of it just to say so.
 *
 * Ordered by what changed first and alphabetically within that, so a caller
 * that renders the list as-is puts the answer at the top rather than wherever
 * the alphabet happens to place it.
 */
export function compareFileSets(before: ComparableFile[], after: ComparableFile[]): FileComparison[] {
  const olds = new Map(before.map((f) => [f.target, f]))
  const news = new Map(after.map((f) => [f.target, f]))
  const rows: FileComparison[] = []

  for (const target of new Set([...olds.keys(), ...news.keys()])) {
    const old = olds.get(target)
    const now = news.get(target)
    if (!old && now) {
      rows.push({ target, type: now.type, change: 'added', before: null, after: now.content })
      continue
    }
    if (old && !now) {
      rows.push({ target, type: old.type, change: 'removed', before: old.content, after: null })
      continue
    }
    if (old && now) {
      // The newer side names the type: a file whose type changed is that type
      // now, and the older value is what it stopped being.
      if (old.content === now.content) {
        rows.push({ target, type: now.type, change: 'unchanged' })
        continue
      }
      rows.push({ target, type: now.type, change: 'changed', before: old.content, after: now.content })
    }
  }

  return rows.sort((a, b) => ORDER[a.change] - ORDER[b.change] || a.target.localeCompare(b.target))
}

/** Whether a comparison found anything at all — the "these two are identical" case. */
export function hasChanges(rows: FileComparison[]): boolean {
  return rows.some((r) => r.change !== 'unchanged')
}
