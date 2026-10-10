import { ScrollArea } from '@opencroft/client/ui'
import { cn } from 'cn'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'

// The Design Kit page shell — a pinned project header over the component tree,
// beside the selected component's page.
//
// SIDE BY SIDE, EACH COLUMN SCROLLS ON ITS OWN. The two halves have unrelated
// lengths: with one scroller a long document scrolls the tree off the top and
// a large project pushes the document down before it starts. The header stays
// out of the tree's scroller, and each column carries its spacing INSIDE its
// viewport so the bar spans the column at its right edge.
//
// STACKED, THE TREE FOLDS. Below the breakpoint a tree sitting in full above
// the document would make the page scroll, and in a narrow container a long
// tree pushes the document a screen and more down. So the stacked tree is a
// disclosure naming the open component; opened, it is capped and scrolls
// itself, and choosing a component folds it again, because choosing one is a
// request to see it. The page itself still scrolls the
// document, which is the one scroller a narrow layout should have.
//
// `h-full` needs a parent with a definite height, which the host's App pane
// provides; `minHeight` is the floor for a pane shorter than the layout.

// Base UI's ScrollArea.Content -- the one wrapper inside the viewport, the
// `[data-slot=scroll-area-content]` the ui ScrollArea draws -- carries an
// INLINE `min-width: fit-content` (it is how Base UI lets content scroll
// sideways). That makes the wrapper at least as wide as its widest unbreakable
// line, which silently defeats every `truncate` and `min-w-0` below it: a long
// title would widen the tree instead of ellipsizing, and a wide code block
// would push the document past its column. An inline style loses only to
// `!important`, hence `min-w-0!`. Scoped to this root's own content, so a
// ScrollArea nested inside a page keeps its sideways scrolling.
const CONTENT_FIT = '[&>[data-slot=scroll-area-viewport]>[data-slot=scroll-area-content]]:min-w-0!'

// Every ScrollArea root here clips. The root is `position: relative`, so it —
// not the viewport — is the containing block of any absolutely positioned
// descendant, and the viewport's `overflow: scroll` only clips what it
// contains. The tree's rows carry `sr-only` text (the draft dot's title),
// which is `position: absolute`: without clipping, rows scrolled far down
// place those spans below the root, and they stretch the PAGE; plain rows add
// nothing. `overflow: hidden` on the roots contains them. shadcn's own
// ScrollArea clips its root for this reason; the one the ui package exports
// does not.
const CLIP = 'overflow-hidden'

export interface LibraryShellProps {
  /** Which project this is, plus its project-level controls. Pinned — it does not scroll. */
  header: ReactNode
  /** The component tree. */
  tree?: ReactNode
  /** Stacked layout: what the folded tree says — normally the open component's title. */
  treeLabel?: string
  /** Stacked layout: whether the tree is unfolded. Uncontrolled when omitted. */
  treeOpen?: boolean
  onTreeOpenChange?: (open: boolean) => void
  /** The component's page: its documentation, an empty state, or a refusal. */
  children: ReactNode
}

export function LibraryShell({ header, tree, treeLabel, treeOpen, onTreeOpenChange, children }: LibraryShellProps) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = treeOpen ?? ownOpen
  const setOpen = (next: boolean) => {
    setOwnOpen(next)
    onTreeOpenChange?.(next)
  }

  return (
    <div className='@container flex h-full min-h-0 w-full flex-col' style={{ minHeight: 420 }}>
      {/* The stacked layout's own copy of the sidebar. The tree is cheap to
          render twice and inert; the children are neither — a component page
          mounts a live preview — so they are rendered once, in the grid below,
          which changes column count at the breakpoint. */}
      <div className='space-y-4 p-6 @[560px]:hidden'>
        {header}
        {tree && (
          <div className='rounded-md border'>
            <button
              type='button'
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className='flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50'
            >
              <span className='min-w-0 flex-1 truncate font-medium'>{treeLabel ?? 'Components'}</span>
              <ChevronDown
                className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
              />
            </button>
            {/* The cap goes on the viewport, not the root: the viewport is
                `height: 100%`, which against an auto-height root resolves to
                its content, so a cap on the root would clip nothing. */}
            {open && (
              <ScrollArea
                className={cn('border-t', CLIP, CONTENT_FIT, '[&>[data-slot=scroll-area-viewport]]:max-h-72')}
                innerClassName='p-2'
              >
                {tree}
              </ScrollArea>
            )}
          </div>
        )}
      </div>

      <div className='grid grid-cols-1 gap-8 px-6 pb-6 @[560px]:min-h-0 @[560px]:flex-1 @[560px]:grid-cols-[278px_minmax(0,1fr)]! @[560px]:gap-0 @[560px]:p-0'>
        <aside className='hidden min-h-0 flex-col @[560px]:flex!'>
          <div className='px-6 pt-6 pb-5'>{header}</div>
          {tree && (
            <ScrollArea className={cn('min-h-0 flex-1', CLIP, CONTENT_FIT)} innerClassName='px-6 pb-6'>
              {tree}
            </ScrollArea>
          )}
        </aside>
        <main className='relative w-full min-w-0 @[560px]:min-h-0'>
          <ScrollArea
            className={cn('min-h-0 flex-1 @[560px]:h-full', CLIP, CONTENT_FIT)}
            innerClassName='@[560px]:py-6 @[560px]:pr-6 @[560px]:pl-2'
          >
            {children}
          </ScrollArea>
        </main>
      </div>
    </div>
  )
}
