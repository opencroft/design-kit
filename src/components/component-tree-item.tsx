import type { MouseEvent } from 'react'

import { cn } from 'cn'

export interface ComponentTreeItemProps {
  // The component's display title.
  label: string
  /** An unpublished draft exists. A number names the published version the
   *  draft is ahead of; 'unpublished' marks a component never published at
   *  all. Absent, the draft and the published copy are the same thing — which
   *  is why absence renders nothing. */
  draft?: number | 'unpublished'
  active?: boolean
  /** The component's own address. With it the row is a real link, so a new
   *  tab, a new window and copy link work on it. */
  href?: string
  /** A plain press on the row. With `href`, it takes the navigation over from
   *  the browser, so a client router can move in place; a modified press (new
   *  tab, new window) always stays with the browser. */
  onSelect?: () => void
}

function opensElsewhere(event: MouseEvent) {
  return event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
}

// A row in the component tree: the component title and a leading amber dot
// when an unpublished draft exists (amber, because nothing is broken and
// nothing is lost — the dot's title names the published version installers
// still get).
export function ComponentTreeItem({ label, draft, active = false, href, onSelect }: ComponentTreeItemProps) {
  const draftTitle = draft === 'unpublished' ? 'Draft — never published' : `Draft ahead of the published v${draft}`
  const className = cn(
    'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors',
    active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  )
  const content = (
    <>
      {draft !== undefined && (
        <span title={draftTitle} className='size-1.5 shrink-0 rounded-full bg-amber-500'>
          <span className='sr-only'>{draftTitle}</span>
        </span>
      )}
      <span className='min-w-0 flex-1 truncate'>{label}</span>
    </>
  )
  if (href === undefined) {
    return (
      <button type='button' onClick={onSelect} className={className}>
        {content}
      </button>
    )
  }
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      className={className}
      onClick={(event) => {
        if (onSelect && !opensElsewhere(event)) {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      {content}
    </a>
  )
}
