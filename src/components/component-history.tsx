import { icons, invoke, React } from '@ext/host'

import { cn } from 'cn'
import { type FileComparison, VersionDiffView } from './version-diff-view'
import { comparisonFor, pointsOf, type SelectionComparison } from './version-selection'
import { VersionTimeline } from './version-timeline'

const { Info } = icons

// A component's publish history: a horizontal timeline over its versions, the
// selection it makes, and the record of what each version changed.
//
// The timeline's split handle selects one version or a range, and what a
// selection asks for is `comparisonFor` — a set of versions, shown as the
// change those versions introduced. The draft, when the working tree is ahead
// of the last publish, is the newest point, so "what have I changed since I
// published" is an ordinary selection rather than a separate feature.
//
// The version list below the selection is kept rather than replaced by the
// timeline. The two answer different questions: the timeline is how you choose,
// the list is the record of what changed and when, which a control cannot show
// for every version at once.
//
// This surface mirrors the documentation app's page history, and says more than
// it in three places, each deliberate. Documentation heads an entry with a
// commit subject because a commit is all it has, where a published component
// has a VERSION — the thing a person installs. Documentation has no per-page
// draft marker at all, only a project-wide filter. And documentation swallows a
// failed history load, which makes an empty history and a broken one look
// identical; this one says so.
//
// ── Why this shows FILES and never the doc page rendered at that version ────
//
// The documentation app, which this whole surface is parity with, DOES render
// the old page — clicking a revision there shows that version of the page
// through the normal renderer. That is the closer analogy, and it is
// deliberately not followed here.
//
// The kit's doc rendering runs LIVE PREVIEWS, and a preview pools the project's
// CURRENT sibling code. So an old version's doc would render that version's
// prose around today's components, mixing two points in time with nothing on
// screen marking which parts came from where — and it would look entirely
// convincing doing it: a wrong answer wearing the shape of a right one.
//
// If you are reading this because you were about to make this page render the
// old doc: that is the thing to solve first. The preview would have to pool the
// sibling code AS IT WAS at that version, which it has no way to do today —
// pooling is whole-project and always current.

interface RevisionRow {
  version: number
  publishedAt: string
  sha: string
  author: string
  /** Files this version changed, as the component declares them. Null when
   *  there is no version below it to compare against. */
  changed: string[] | null
}

interface Revisions {
  name: string
  versions: RevisionRow[]
  floor: number
  draftAhead: boolean
}

type LoadState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; revisions: Revisions }

type ContentState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'diff'; fromLabel: string; selectionLabel: string; files: FileComparison[] }

function publishedOn(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString()
}

function Line({ children }: { children: React.ReactNode }) {
  return <p className='px-1 py-2 text-xs text-muted-foreground'>{children}</p>
}

/** What a version changed, or why that question has no answer for it. */
function Changed({ changed, floor }: { changed: string[] | null; floor: number }) {
  if (changed === null) {
    // The oldest row held. Whether the component BEGINS here or the project
    // merely starts holding it here are different facts, and reporting them the
    // same way is what would let a truncated history read as a complete one.
    return floor > 1 ? (
      <p className='text-xs text-muted-foreground'>This project's history begins at v{floor}, so what this version changed is not held here.</p>
    ) : (
      <p className='text-xs text-muted-foreground'>The first version — every file in it was new.</p>
    )
  }
  if (changed.length === 0) {
    return <p className='text-xs text-muted-foreground'>No file changes — this publish moved the registry record only.</p>
  }
  return (
    <ul className='space-y-0.5'>
      {changed.map((path) => (
        <li key={path} className='truncate font-mono text-xs text-muted-foreground' title={path}>
          {path}
        </li>
      ))}
    </ul>
  )
}

/** The selection cannot be answered, and the reason is worth a sentence rather
 *  than an empty panel — an unanswerable range and an unchanged one look the
 *  same otherwise. */
function PredatesHistory({ comparison }: { comparison: Extract<SelectionComparison, { status: 'predatesHistory' }> }) {
  return (
    <Line>
      {comparison.selectionLabel} cannot be shown. This project's history begins at v{comparison.floor}, so the state before it — which is what these changes
      would be measured against — is not held here. Select from v{comparison.floor + 1} or later to compare within the history that is.
    </Line>
  )
}

export function ComponentHistory({ projectId, name }: { projectId: string; name: string }) {
  const [state, setState] = React.useState<LoadState>({ status: 'loading' })
  const [selection, setSelection] = React.useState<{ from: number; to: number } | null>(null)
  const [content, setContent] = React.useState<ContentState>({ status: 'loading' })

  React.useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    setSelection(null)
    invoke<Revisions>('components.revisions', { projectId, name })
      .then((revisions) => {
        if (active) {
          setState(revisions && Array.isArray(revisions.versions) ? { status: 'ready', revisions } : { status: 'failed' })
        }
      })
      .catch(() => {
        if (active) {
          setState({ status: 'failed' })
        }
      })
    return () => {
      active = false
    }
  }, [projectId, name])

  const revisions = state.status === 'ready' ? state.revisions : null
  const points = React.useMemo(() => pointsOf(revisions?.versions ?? [], Boolean(revisions?.draftAhead)), [revisions])

  // The selection starts on the newest point, both halves together — so the
  // panel opens showing something rather than asking to be configured first.
  const from = selection ? selection.from : Math.max(0, points.length - 1)
  const to = selection ? selection.to : Math.max(0, points.length - 1)
  const comparison = React.useMemo(() => comparisonFor(points, revisions?.floor ?? 0, from, to), [points, revisions?.floor, from, to])

  React.useEffect(() => {
    if (comparison?.status !== 'ok') {
      return
    }
    let active = true
    setContent({ status: 'loading' })
    invoke<{ files: FileComparison[] }>('files.compareVersions', { projectId, component: name, from: comparison.from, to: comparison.to })
      .then((result) => {
        if (active) {
          setContent({ status: 'diff', fromLabel: comparison.fromLabel, selectionLabel: comparison.selectionLabel, files: result.files })
        }
      })
      .catch((e: unknown) => {
        if (active) {
          setContent({ status: 'failed', message: e instanceof Error ? e.message : 'This selection could not be read.' })
        }
      })
    return () => {
      active = false
    }
  }, [projectId, name, comparison])

  if (state.status === 'loading') {
    return <Line>Loading history…</Line>
  }
  if (state.status === 'failed') {
    return <Line>This component's history could not be read.</Line>
  }

  const { versions, floor, draftAhead } = state.revisions
  const latest = versions.length > 0 ? versions[0].version : 0

  if (points.length === 0) {
    return <Line>No published versions yet.</Line>
  }

  // A list row is inside the selection when its version falls between the two
  // ends. The draft sits above every published version, so as an end it does
  // not bound anything below it.
  const fromAt = points[from]?.at
  const toAt = points[to]?.at
  const lowerBound = typeof fromAt === 'number' ? fromAt : Number.POSITIVE_INFINITY
  const upperBound = typeof toAt === 'number' ? toAt : Number.POSITIVE_INFINITY
  const inSelection = (version: number) => version >= lowerBound && version <= upperBound

  return (
    <div className='space-y-4'>
      <VersionTimeline points={points} from={from} to={to} onChange={(nextFrom, nextTo) => setSelection({ from: nextFrom, to: nextTo })} />

      <div>
        {comparison?.status === 'predatesHistory' ? (
          <PredatesHistory comparison={comparison} />
        ) : content.status === 'loading' ? (
          <Line>Loading…</Line>
        ) : content.status === 'failed' ? (
          <Line>{content.message}</Line>
        ) : (
          <VersionDiffView files={content.files} fromLabel={content.fromLabel} selectionLabel={content.selectionLabel} />
        )}
      </div>

      {draftAhead && (
        // Amber for the same reason the page header uses it: nothing is broken
        // and nothing is lost, but what is on screen is not what installs.
        <div className='rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2'>
          <p className='text-sm font-medium text-amber-600'>Draft — not published</p>
          <p className='text-xs text-muted-foreground'>
            {latest > 0
              ? `This component has changes beyond v${latest}. Installing it right now still gets v${latest}.`
              : 'This component has never been published, so installing it right now gets nothing.'}
          </p>
        </div>
      )}

      <ul className='space-y-3'>
        {versions.map((entry) => (
          <li key={entry.sha} className={cn('rounded-md border px-3 py-2', inSelection(entry.version) ? 'border-primary/40 bg-accent/30' : undefined)}>
            <div className='flex items-baseline justify-between gap-2'>
              <span className='text-sm font-semibold'>v{entry.version}</span>
              <span className='truncate text-xs text-muted-foreground'>
                {entry.author ? `${entry.author} · ` : ''}
                {publishedOn(entry.publishedAt)}
              </span>
            </div>
            <div className='mt-1.5'>
              <Changed changed={entry.changed} floor={floor} />
            </div>
          </li>
        ))}
      </ul>

      {floor > 1 && (
        <p className='flex items-start gap-1.5 text-xs text-muted-foreground'>
          <Info className='mt-0.5 size-3 shrink-0' />
          <span>
            Versions before v{floor} predate this project's migrated history and are not held here, so this list starts where the record does rather than where the
            component did.
          </span>
        </p>
      )}
    </div>
  )
}
