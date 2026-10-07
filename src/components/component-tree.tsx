import { icons, React } from '@ext/host'
import ui from '@ext/ui'

import { ComponentTreeItem } from './component-tree-item'

const { Blocks, ChevronRight, Code, Component, Folder, Layout, MessageSquare, Play, TextCursor, Wrench } = icons
const { Collapsible, CollapsibleContent, CollapsibleTrigger } = ui as Record<string, React.ComponentType<Record<string, unknown>>>

export interface ComponentTreeEntry {
  name: string
  title: string
  type: 'registry:ui' | 'registry:hook'
  category: string
  /** An unpublished draft exists: the published version it is ahead of, or
   *  'unpublished' for a component never published. Feeds the row's amber dot. */
  draft?: number | 'unpublished'
  /** The component's own address; with it the row is a real link. */
  href?: string
}

export interface ComponentTreeProps {
  items: ComponentTreeEntry[]
  selected?: string
  /** A plain press on a row. On a row with `href` it takes the navigation over
   *  from the browser; a modified press stays with the browser. */
  onSelect?: (name: string) => void
}

const CATEGORY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  Chat: MessageSquare,
  Input: TextCursor,
  Layouts: Layout,
  Media: Play,
  Utils: Wrench,
  'Design Kit': Blocks,
}

function SectionLabel({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className='mb-1 flex items-center px-2 text-xs font-semibold tracking-wide text-muted-foreground'>
      <Icon className='mr-2 h-4 w-4' />
      {children}
    </div>
  )
}

// The design-kit component tree: Components grouped by collapsible category, then
// Hooks — each row a ComponentTreeItem carrying its draft dot.
export function ComponentTree({ items, selected, onSelect }: ComponentTreeProps) {
  const uiItems = items.filter((i) => i.type === 'registry:ui')
  const hookItems = items.filter((i) => i.type === 'registry:hook')
  const categories = [...new Set(uiItems.map((i) => i.category))]

  return (
    <div className='flex flex-col gap-5'>
      {uiItems.length > 0 && (
        <div>
          <SectionLabel icon={Component}>Components</SectionLabel>
          <div className='flex flex-col gap-0.5'>
            {categories.map((cat) => {
              const Icon = CATEGORY_ICON[cat] ?? Folder
              return (
                <Collapsible key={cat} defaultOpen className='group/collapsible'>
                  <CollapsibleTrigger className='flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted'>
                    <Icon className='h-4 w-4' />
                    <span>{cat}</span>
                    <ChevronRight className='ml-auto h-4 w-4 transition-transform group-data-open/collapsible:rotate-90' />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className='ml-4 flex flex-col gap-0.5 border-l pl-2'>
                      {uiItems
                        .filter((i) => i.category === cat)
                        .map((item) => (
                          <ComponentTreeItem
                            key={item.name}
                            label={item.title}
                            draft={item.draft}
                            href={item.href}
                            active={item.name === selected}
                            onSelect={() => onSelect?.(item.name)}
                          />
                        ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
          </div>
        </div>
      )}

      {hookItems.length > 0 && (
        <div>
          <SectionLabel icon={Code}>Hooks</SectionLabel>
          <div className='flex flex-col gap-0.5'>
            {hookItems.map((item) => (
              <ComponentTreeItem
                key={item.name}
                label={item.title}
                draft={item.draft}
                href={item.href}
                active={item.name === selected}
                onSelect={() => onSelect?.(item.name)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
