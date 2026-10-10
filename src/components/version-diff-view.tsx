import { DiffEditor, type DiffEditorProps, type DiffOnMount } from '@monaco-editor/react'
import { cn } from 'cn'
import { Columns2, FileMinus, FilePen, FilePlus, Rows2 } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { initMonaco, languageFor, MONACO_THEME, monoFontFamily } from './monaco-code-editor'

// The difference between two points in a component's history, shown in an
// established diff convention rather than a new one: Monaco's `DiffEditor`,
// read-only, minimap off. A component is several files and a diff editor takes
// one pair, so the changed files list beside the selected file's diff.
//
// Side by side by default, with a unified toggle. A narrow column is too narrow
// to split; this is the wide main column, where side by side fits.
//
// The convention is COPIED, not imported. The `agent-chat` workspace package
// has a diff editor and is deliberately unused: its bare name is exactly the
// specifier the preview refuses to resolve (preview-runtime/unverifiable-dep.ts)
// — importing it here would reintroduce the failure that refusal exists to
// prevent.

export type FileChange = 'added' | 'removed' | 'changed' | 'unchanged'

export interface FileComparison {
  target: string
  type: string
  change: FileChange
  /** A string is content; null is "did not exist on that side"; absent means it
   *  was not carried, which only happens for an unchanged file. This view
   *  renders none of the unchanged ones, so both are present on every row it
   *  draws — and null becomes an empty pane, which is what an absent file
   *  should diff as. */
  before?: string | null
  after?: string | null
}

const MARKER: Record<Exclude<FileChange, 'unchanged'>, { icon: typeof FilePen; className: string; label: string }> = {
  added: { icon: FilePlus, className: 'text-emerald-600', label: 'added' },
  removed: { icon: FileMinus, className: 'text-destructive', label: 'removed' },
  changed: { icon: FilePen, className: 'text-muted-foreground', label: 'changed' },
}

const OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 13,
  automaticLayout: true,
  scrollbar: { alwaysConsumeMouseWheel: false },
}

/** Whether Monaco's runtime arrived. `failed` is a real answer, not a state to
 *  hide: the runtime comes over the network, and a pane that renders nothing
 *  because a CDN is unreachable looks identical to two versions being the same. */
type LoadState = 'loading' | 'ready' | 'failed'

/** `DiffEditor` with its models released in an order Monaco accepts.
 *  @monaco-editor/react 4.7 disposes the models before the editor that still
 *  shows them, which Monaco 0.55 answers with "TextModel got disposed before
 *  DiffEditorWidget model got reset". So the models are kept out of its hands
 *  and released here — detached first. This cleanup runs before the library's
 *  own, since React runs a parent's cleanups before its children's. */
function SafeDiffEditor(props: DiffEditorProps) {
  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null)
  useEffect(
    () => () => {
      const editor = editorRef.current
      const models = editor?.getModel()
      editor?.setModel(null)
      models?.original.dispose()
      models?.modified.dispose()
      editorRef.current = null
    },
    [],
  )
  return (
    <DiffEditor
      {...props}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor, monaco) => {
        editorRef.current = editor
        props.onMount?.(editor, monaco)
      }}
    />
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className='px-1 py-3 text-xs text-muted-foreground'>{children}</p>
}

export function VersionDiffView({
  files,
  fromLabel,
  selectionLabel,
}: {
  files: FileComparison[]
  fromLabel: string
  selectionLabel: string
}) {
  const changed = useMemo(() => files.filter((f) => f.change !== 'unchanged'), [files])
  const [selected, setSelected] = useState<string>('')
  const [sideBySide, setSideBySide] = useState(true)
  const [monaco, setMonaco] = useState<LoadState>('loading')

  useEffect(() => {
    let live = true
    initMonaco()
      .then(() => live && setMonaco('ready'))
      .catch(() => live && setMonaco('failed'))
    return () => {
      live = false
    }
  }, [])

  // The chosen file is held by path, so it survives a re-fetch that returns the
  // same file in a different position. It falls back to the first changed file
  // rather than to nothing, which is what makes the panel useful on arrival.
  const active = changed.find((f) => f.target === selected) ?? changed[0]

  if (changed.length === 0) {
    return (
      <Note>
        {selectionLabel} changed nothing — no file of this component differs from {fromLabel}.
      </Note>
    )
  }

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        {/* The selection and what it is measured against are both named, and
            they are deliberately different things: a range reading "v2–v3"
            shows what v2 and v3 together introduced, which is measured from
            v1. Showing only one of the two would read as an off-by-one. */}
        <p className='text-xs text-muted-foreground'>
          <span className='font-medium text-foreground'>{selectionLabel}</span> · {changed.length}{' '}
          {changed.length === 1 ? 'file' : 'files'} · against{' '}
          <span className='font-medium text-foreground'>{fromLabel}</span>
        </p>
        <div className='flex gap-0.5 rounded-md border p-0.5'>
          <button
            type='button'
            title='Side by side'
            aria-pressed={sideBySide}
            onClick={() => setSideBySide(true)}
            className={cn('rounded p-1', sideBySide && 'bg-accent')}
          >
            <Columns2 className='size-3.5' />
          </button>
          <button
            type='button'
            title='Unified'
            aria-pressed={!sideBySide}
            onClick={() => setSideBySide(false)}
            className={cn('rounded p-1', !sideBySide && 'bg-accent')}
          >
            <Rows2 className='size-3.5' />
          </button>
        </div>
      </div>

      <div className='grid grid-cols-1 gap-3 @[720px]:grid-cols-[220px_minmax(0,1fr)]!'>
        <ul className='space-y-0.5'>
          {changed.map((file) => {
            const marker = MARKER[file.change as Exclude<FileChange, 'unchanged'>]
            const Icon = marker.icon
            return (
              <li key={file.target}>
                <button
                  type='button'
                  onClick={() => setSelected(file.target)}
                  title={`${file.target} — ${marker.label}`}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/50',
                    file.target === active?.target && 'bg-accent',
                  )}
                >
                  <Icon className={cn('size-3 shrink-0', marker.className)} />
                  {/* The tail of a path is what identifies a file; the head is
                      what it shares with its neighbours, so it is the head that
                      gets clipped. */}
                  <span className='truncate [direction:rtl] text-left'>{file.target}</span>
                </button>
              </li>
            )
          })}
        </ul>

        <div className='min-w-0 overflow-hidden rounded-md border'>
          {monaco === 'failed' ? (
            <Note>
              The diff viewer could not load. It is fetched over the network, so this is about the connection rather
              than about these versions.
            </Note>
          ) : monaco === 'loading' ? (
            <Note>Loading the diff viewer…</Note>
          ) : active ? (
            <SafeDiffEditor
              height={420}
              theme={MONACO_THEME}
              language={languageFor(active.target)}
              original={active.before ?? ''}
              modified={active.after ?? ''}
              options={{ ...OPTIONS, fontFamily: monoFontFamily(), renderSideBySide: sideBySide }}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
