import { icons, React } from '@ext/host'
import { Button, Input } from '@ext/ui'

import { cn } from 'cn'
import { MiddleTruncate } from './middle-truncate'
import { RowContextMenu } from './row-context-menu'

// One component's own files, source and docs together, a dot per file changed
// since the last published version, New file in the pane header (the only
// route out of empty, so it never moves), and rename/delete answering IN the row — rename as an input carrying the
// one-line warning, delete as a confirmation naming the file, because every
// file operation writes to the draft and is undone by not publishing, so a
// modal would claim an irreversibility that isn't there.
//
// Rename and delete live in the row's context menu — right-click on a pointer,
// long press on touch — so no row spends width on buttons that it could give
// to the filename.
//
// Where an action lives does not change how destructive it is. Delete
// still answers IN the row rather than deleting on the press — the menu starts
// the confirmation, and the confirmation names the file.
const { AlertCircle, Pencil, Plus } = icons

export interface EditorFileRow {
  path: string
  /** This file has changed since the component's last published version — what
   *  being part of the draft means, file by file. Not "unsaved": a save moves
   *  the typing into the draft, which is where this starts being true rather
   *  than where it stops. */
  dirty?: boolean
  /** A refused publish reported a failure that came from this file. */
  failed?: boolean
  /** After loading a newer version, this file's earlier text was kept for
   *  reconciliation — it is one of the files YOU had changed, as against one
   *  the reload simply left you behind on. Both differ from what is published
   *  and only one of them is yours to settle. */
  kept?: boolean
}

export interface SourceEditorFilesProps {
  files: EditorFileRow[]
  activePath?: string
  loading?: boolean
  onSelect?: (path: string) => void
  creating?: boolean
  onNewFile?: () => void
  onCreate?: (path: string) => void
  onCancelCreate?: () => void
  renamingPath?: string
  onRenameStart?: (path: string) => void
  onRename?: (path: string, next: string) => void
  onCancelRename?: () => void
  pendingDeletePath?: string
  onDeleteStart?: (path: string) => void
  onDeleteConfirm?: (path: string) => void
  onDeleteCancel?: () => void
}

function PathInput({
  defaultValue = '',
  placeholder,
  caution = false,
  hint,
  onSubmit,
  onCancel,
}: {
  defaultValue?: string
  placeholder: string
  caution?: boolean
  hint?: (value: string) => string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = React.useState(defaultValue)
  return (
    <div>
      <Input
        autoFocus
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        className='h-7 text-xs'
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' && value.trim()) {
            onSubmit(value.trim())
          }
          if (e.key === 'Escape') {
            onCancel()
          }
        }}
      />
      {hint ? <p className={cn('px-1 pt-1 text-xs', caution ? 'text-amber-600' : 'text-muted-foreground')}>{hint(value)}</p> : null}
    </div>
  )
}

export function SourceEditorFiles({
  files,
  activePath,
  loading = false,
  onSelect,
  creating = false,
  onNewFile,
  onCreate,
  onCancelCreate,
  renamingPath,
  onRenameStart,
  onRename,
  onCancelRename,
  pendingDeletePath,
  onDeleteStart,
  onDeleteConfirm,
  onDeleteCancel,
}: SourceEditorFilesProps) {
  return (
    <div className='flex h-full min-h-0 w-full flex-col'>
      <div className='flex shrink-0 items-center gap-2 border-b px-2 py-1.5'>
        <span className='min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground'>Files</span>
        <Button type='button' variant='ghost' size='icon' className='size-6 shrink-0' aria-label='New file' title='New file' onClick={onNewFile}>
          <Plus className='size-3.5' />
        </Button>
      </div>

      <div className='min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1'>
        {creating ? (
          <div className='px-1 py-1'>
            <PathInput
              placeholder='File path'
              onSubmit={(v) => onCreate?.(v)}
              onCancel={() => onCancelCreate?.()}
              hint={(v) =>
                v.startsWith('docs/')
                  ? 'A docs file: it renders on the page and is never shipped to anyone who installs the component.'
                  : 'Shipped with the component.'
              }
            />
          </div>
        ) : null}

        {loading ? (
          <div className='space-y-1 p-1' aria-hidden='true'>
            <div className='h-5 animate-pulse rounded-md bg-muted' />
            <div className='h-5 w-4/5 animate-pulse rounded-md bg-muted' />
            <div className='h-5 w-3/5 animate-pulse rounded-md bg-muted' />
          </div>
        ) : null}

        {!loading && files.length === 0 && !creating ? (
          <p className='px-2 py-6 text-center text-xs text-muted-foreground'>No files yet.</p>
        ) : null}

        {!loading &&
          files.map((file) => {
            if (file.path === renamingPath) {
              return (
                <div key={file.path} className='px-1 py-1'>
                  <PathInput
                    defaultValue={file.path}
                    placeholder='File path'
                    caution
                    // Names the right direction. What breaks is inside this
                    // component: the imports in its other files still ask for
                    // the old path, and nothing rewrites stored content on a
                    // rename. Other components resolve this one by NAME —
                    // both a declared dependency and a path alias end at the
                    // component index, never at a filename — so a file rename
                    // cannot reach them.
                    hint={() =>
                      'Renaming does not update the imports that name this file elsewhere in this component. Other components are unaffected: they refer to this component by name, not by filename.'
                    }
                    onSubmit={(v) => onRename?.(file.path, v)}
                    onCancel={() => onCancelRename?.()}
                  />
                </div>
              )
            }

            if (file.path === pendingDeletePath) {
              return (
                <div key={file.path} className='rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5'>
                  <p className='text-xs font-medium text-destructive'>Delete this file?</p>
                  <MiddleTruncate text={file.path} tailChars={14} className='pt-0.5 text-xs text-destructive' />
                  <div className='flex items-center gap-1 pt-1.5'>
                    <Button type='button' size='sm' variant='destructive' className='h-6 px-2 text-xs' onClick={() => onDeleteConfirm?.(file.path)}>
                      Delete
                    </Button>
                    <Button type='button' size='sm' variant='ghost' className='h-6 px-2 text-xs' onClick={() => onDeleteCancel?.()}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )
            }

            const active = file.path === activePath
            return (
              <RowContextMenu
                key={file.path}
                entries={[
                  {
                    label: 'Rename',
                    icon: <Pencil className='size-3' />,
                    onSelect: () => onRenameStart?.(file.path),
                  },
                ]}
                onDelete={() => onDeleteStart?.(file.path)}
              >
                <button
                  type='button'
                  onClick={() => onSelect?.(file.path)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors',
                    active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {/* Slot held either way, so a file going dirty never shifts the names. */}
                  <span aria-hidden='true' className={cn('size-1.5 shrink-0 rounded-full', file.dirty ? 'bg-primary' : 'bg-transparent')} />
                  {file.dirty ? <span className='sr-only'>changed since the last published version</span> : null}
                  <MiddleTruncate text={file.path} tailChars={14} className={cn('min-w-0 flex-1', active && 'font-medium')} />
                  {/* Amber, and after the name rather than before it: the dot
                      says this file differs from what is published, and this
                      says the difference is yours — the reload left it as you
                      had it. A file marked only with a dot is one somebody
                      else moved and you are simply behind on. */}
                  {file.kept ? (
                    <span className='shrink-0 rounded-full border border-amber-500/50 px-1.5 text-xs text-amber-600'>kept</span>
                  ) : null}
                  {file.failed ? (
                    <>
                      <AlertCircle className='size-3 shrink-0 text-destructive' aria-hidden='true' />
                      <span className='sr-only'>a publish failure came from this file</span>
                    </>
                  ) : null}
                </button>
              </RowContextMenu>
            )
          })}
      </div>
    </div>
  )
}
