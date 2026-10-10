import type { ReactNode } from 'react'

import { DependencyChips } from './dependency-chips'

// The top of a component's page — title, description, the draft notice, what
// it depends on, and the page's actions (Source, Install) on the right.
//
// The actions are a slot. Which acts a page offers is the page's decision, and
// both of those buttons carry host wiring (the editor route, the install
// URLs) that has no business inside a heading.
export interface ComponentDocHeaderProps {
  title: string
  description?: string
  /** An unpublished draft exists: the published version it is ahead of, or
   *  'unpublished' for a component never published. Absent, nothing is said. */
  draft?: number | 'unpublished'
  registryDependencies?: string[]
  actions?: ReactNode
}

export function ComponentDocHeader({
  title,
  description,
  draft,
  registryDependencies = [],
  actions,
}: ComponentDocHeaderProps) {
  return (
    <div className='space-y-2'>
      <div className='flex items-start justify-between gap-4'>
        <h1 className='text-4xl font-bold tracking-tight'>{title}</h1>
        {actions && <div className='flex shrink-0 items-center gap-2'>{actions}</div>}
      </div>
      {description && <p className='text-lg text-muted-foreground'>{description}</p>}
      {/* The reader's real question is "if I install this right now, what
          lands?" — so the sentence answers that, rather than describing what
          the page is showing. Amber: nothing broken, nothing lost. */}
      {/* Loose on purpose: a kit sheet delivers an absent value, never null. */}
      {draft != null && (
        <p className='text-sm font-medium text-amber-600'>
          {draft === 'unpublished'
            ? 'Installing this component right now gets nothing — it has never been published.'
            : `Installing this component right now gets v${draft} — this page shows a newer, unpublished draft.`}
        </p>
      )}
      <DependencyChips references={registryDependencies} />
    </div>
  )
}
