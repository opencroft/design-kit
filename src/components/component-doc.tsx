import { absoluteUrl, routeUrl } from '@opencroft/client/extension'
import { FileText, History } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { PoolGroup, PreviewScope } from '../../preview-runtime/protocol'
import { DocView } from '../live/mdx'
import type { RegistryItem } from '../registry'
import { ComponentDocHeader } from './component-doc-header'
import { ComponentHistory } from './component-history'
import { InstallButton } from './install-button'
import { Markdown } from './markdown'
import { PanelTabStrip } from './panel-tab-strip'
import { SourceButton } from './source-button'

// The component detail page (space-y-8, h1 text-4xl). The header
// (title/description/Source/Install) comes from entity meta; the whole body — Preview, Sheets, Examples, interleaved prose — is
// authored in `docs/doc.mdx` and rendered by the self-contained DocView.
//
// History sits beside the documentation as a tab, which is how the
// documentation app reaches a page's history. Its strip lives there in a right
// sidebar; this page has no right rail (the one aside it has is the project's
// component tree), so the strip goes at the top of the body instead. Same
// control, same choice, the one place it could go here.
type DocTab = 'doc' | 'history'

export function ComponentDoc({
  item,
  namespace,
  projectId,
  sources,
  onOpenEditor,
}: {
  item: RegistryItem
  namespace: string
  projectId: string
  sources: PoolGroup[]
  onOpenEditor?: () => void
}) {
  const [tab, setTab] = useState<DocTab>('doc')
  const scope = useMemo<PreviewScope>(
    () => ({ sources, dependencies: item.dependencies }),
    [sources, item.dependencies],
  )

  return (
    <div className='space-y-8'>
      <ComponentDocHeader
        title={item.title}
        description={item.description}
        draft={item.draft}
        registryDependencies={item.registryDependencies}
        actions={
          <>
            <SourceButton onOpenEditor={onOpenEditor} />
            <InstallButton name={item.name} namespace={namespace} httpUrl={absoluteUrl(routeUrl(''))} />
          </>
        }
      />

      <div>
        <PanelTabStrip
          tabs={[
            { id: 'doc', label: 'Documentation', icon: FileText },
            { id: 'history', label: 'History', icon: History },
          ]}
          activeId={tab}
          onSelect={(id) => setTab(id as DocTab)}
        />
        <div className='pt-6'>
          {tab === 'history' ? (
            <ComponentHistory projectId={projectId} name={item.name} />
          ) : (
            <div className='space-y-8'>
              {item.signature && <Markdown source={item.signature} />}
              {item.doc ? (
                <DocView
                  mdx={item.doc.mdx}
                  files={item.doc.files}
                  scope={scope}
                  projectId={projectId}
                  component={item.name}
                />
              ) : (
                <p className='text-sm text-muted-foreground'>No documentation yet.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
