import { icons, React } from '@ext/host'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@ext/ui'

// Follows the kit source (@opencroft/row-context-menu): the menu a list row
// carries — right-click on a pointer, long press on touch, both from the
// primitive rather than from anything written here.
//
// **The click guard is the load-bearing part.** The row underneath is itself a
// button, so without `stopPropagation` on the content a press on Delete falls
// through and selects the very row being deleted — the menu closes, the file
// opens, and the delete still fires.
//
// The kit never confirms, and neither does this: what is being destroyed and
// whether that is worth asking about is the host's knowledge. `onDelete`
// reports the press, and this pane answers it in the row.
//
// With no entries and no `onDelete` the row is returned untouched, so a
// read-only list pays nothing for the option.
const { Trash2 } = icons

export interface RowMenuEntry {
  label: string
  onSelect: () => void
  icon?: React.ReactNode
  /** Draws the entry destructively. `onDelete` already does this for the
   *  canonical Delete; this is for a second destructive act a host owns. */
  destructive?: boolean
  /** Only needed when two entries share a label. */
  key?: string
}

export interface RowContextMenuProps {
  /** The row: one element, which becomes the trigger (Base UI renders the
   *  trigger AS it, via `render`), so it keeps its own click, keyboard and drag
   *  behaviour — this adds a menu to a row rather than wrapping it in one. It
   *  must spread the props it is given and forward its ref; a DOM element does. */
  children: React.ReactElement
  entries?: RowMenuEntry[]
  /** The canonical destructive Delete, always last. Its own prop rather than an
   *  entry so every list deletes with the same wording, icon and position. */
  onDelete?: () => void
}

export function RowContextMenu({ children, entries, onDelete }: RowContextMenuProps) {
  if (!entries?.length && !onDelete) {
    return <>{children}</>
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      {/* `min-w-32` is the scale utility for 8rem. A scale class is a literal
          and always renders; an arbitrary one renders only where the same
          string reaches a file the build scans. */}
      <ContextMenuContent className='min-w-32' onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        {entries?.map((entry) => (
          <ContextMenuItem
            key={entry.key ?? entry.label}
            className={entry.destructive ? 'text-destructive focus:text-destructive' : undefined}
            onClick={entry.onSelect}
          >
            {entry.icon}
            {entry.label}
          </ContextMenuItem>
        ))}
        {onDelete ? (
          <ContextMenuItem className='text-destructive focus:text-destructive' onClick={onDelete}>
            <Trash2 className='size-3' />
            Delete
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
