import { useAppHref, useAppLocation, useAppNavigate } from '@opencroft/client/app'
import { Palette } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { PoolGroup } from '../preview-runtime/protocol'
import { ChatDock, type ChatSelection } from './components/chat-panel'
import { ComponentDoc } from './components/component-doc'
import { ComponentPreviewPage } from './components/component-preview-page'
import {
  componentAppPath,
  componentRouteOf,
  EDITOR_QUERY,
  isEditorView,
  legacyComponentRef,
  legacyLinkTarget,
} from './components/component-routes'
import { addressedComponent, selectForAddress } from './components/component-selection'
import { ComponentTree } from './components/component-tree'
import { LibraryShell } from './components/library-shell'
import { ProjectThemeEditor } from './components/project-theme-editor'
import { SourceEditorPage } from './components/source-editor-page'
import type { ProjectThemeData } from './components/theme-editor'
import { invoke } from './invoke'
import { buildRegistryItems, type StoredComponent } from './registry/from-stored'

// The Design Kit App's page IS the editor, on the instance's own project — the
// tree, doc page, live preview and source editor, pinned to this instance.
// What deliberately is not here is the project picker and project CRUD: an
// App instance is one project, and creating/renaming/removing instances is the
// platform's surface.

interface AppProject {
  id: string
  name: string
  slug: string
  components: number
  theme?: ProjectThemeData
}

// The space's one chat surface — the same slug and thread the space canvas
// addresses (`<space>.<agent>.main`), so this app shows the SPACE's
// conversation rather than one of its own. An app must not carry its own chat
// identity: a surface that picked its own thread would look like the same chat
// as the space's and not be it. The thread is a fixed convention, not this
// app's to choose.
const SPACE_THREAD_ID = 'main'

// Which component is open is the App's address (see
// components/component-routes.ts): `/component/<name>`, and its standalone
// preview under it. The preview is a page of its own — the frame and nothing
// else — so it is chosen here, before anything of the library is mounted.
export function DesignKitAppView({ instanceId, spaceSlug }: { instanceId: string; spaceSlug: string }) {
  const route = componentRouteOf(useAppLocation().path)
  if (route.page === 'preview') {
    return <ComponentPreviewPage projectId={instanceId} component={route.name} target={route.target} />
  }
  return <DesignKitLibrary instanceId={instanceId} spaceSlug={spaceSlug} />
}

function DesignKitLibrary({ instanceId, spaceSlug }: { instanceId: string; spaceSlug: string }) {
  const location = useAppLocation()
  const navigate = useAppNavigate()
  const appHref = useAppHref()
  // undefined = loading; null = the instance could not be resolved.
  const [project, setProject] = useState<AppProject | null | undefined>(undefined)
  // null = the list could not be read, and it is a separate value from the
  // empty list on purpose. As `[]` a failed read would be byte-identical to a
  // project that genuinely holds nothing, so the page would have to pick one
  // of two sentences, and both are false when the read has failed. It cannot
  // choose an honest one while the two states share a value. Same vocabulary
  // as `project` above, which makes exactly this distinction.
  const [stored, setStored] = useState<StoredComponent[] | null>([])
  const [loadingComponents, setLoadingComponents] = useState(true)
  // What was asked for is the address and nothing else: a pick from the tree
  // moves the App to the component's path, so a component reached by a click
  // resolves down the same path as one reached by a link, a reload or Back.
  const route = useMemo(() => componentRouteOf(location.path), [location.path])
  const legacyRef = legacyComponentRef(location.search)
  const editorOpen = isEditorView(location.search)
  // Stacked layout only: whether the folded component tree is open. Held
  // here rather than in the shell so that choosing a component can fold it —
  // choosing one is a request to see it.
  const [treeOpen, setTreeOpen] = useState(false)

  const reloadProject = useCallback(() => {
    return invoke<AppProject | null>('app.project', { instanceId })
      .then((p) => setProject(p ?? null))
      .catch(() => setProject(null))
  }, [instanceId])

  const reloadComponents = useCallback(() => {
    setLoadingComponents(true)
    return (
      invoke<StoredComponent[]>('components.list', instanceId)
        // A reply that is not a list is not an empty project either — it is a
        // read that did not produce one, and it takes the same answer as a
        // thrown one rather than being rounded down to nothing.
        .then((list) => setStored(Array.isArray(list) ? list : null))
        .catch(() => setStored(null))
        .finally(() => setLoadingComponents(false))
    )
  }, [instanceId])

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => (cancelled ? undefined : reloadProject()))
      .then(() => (cancelled ? undefined : reloadComponents()))
    return () => {
      cancelled = true
    }
  }, [reloadProject, reloadComponents])

  // A failed read has no components to show, which is the same as an empty one
  // for everything DOWNSTREAM of here — the tree, the selection, the address.
  // What it is not the same as is what the page says about it, and that is
  // decided from `stored` itself rather than from this.
  const items = useMemo(() => buildRegistryItems(stored ?? []), [stored])

  // Derived, and held in no second place. A fallback that wrote a substitute
  // BACK into the selection, or substituted at render, would leave nothing in
  // the page that remembered a different component had been asked for, and the
  // rewrite below would look correct from the inside. No narrower fallback is
  // wanted either: the request is written only by the address at mount and a
  // tree click, and no action this client invokes creates, removes or renames a
  // component — so a request naming something absent arrives from the address
  // or it does not arrive. Should the client gain one of those, this line gains
  // a second source, and the answer there is still to say what happened rather
  // than to quietly show something else.
  // Everything this page's project answers to. Both, not one: the reference
  // grammar accepts a namespace slug or a storage id as the first half, so an
  // address written either way is addressing this page and has to resolve.
  // `project.id` is the instance id, which is what `projectId` is threaded to
  // the server as everywhere below — the same value under two names rather
  // than a third fact to keep in step.
  //
  // Empty until the project read lands. That reads as "no address is for this
  // page yet", which is the safe direction while there is nothing to show and
  // nothing to write.
  const identities = useMemo(() => (project ? [project.slug, project.id] : []), [project])
  const selection = useMemo(
    () =>
      selectForAddress(
        route,
        legacyRef,
        items.map((i) => i.name),
        identities,
      ),
    [route, legacyRef, items, identities],
  )
  const item = selection.status === 'selected' ? items.find((i) => i.name === selection.name) : undefined
  const addressName = addressedComponent(selection)

  useEffect(() => {
    // Only the bare address is rewritten — to the component it resolved to,
    // the one a `?component=` link named or else the first — and in place, so
    // Back does not return to an address that only ever forwarded. A path
    // already names its component. null is a refusal, not an empty name: the
    // request did not resolve, so the address is left exactly as it arrived
    // and stays readable as the thing that was asked for.
    if (project && route.page === 'library' && addressName) {
      navigate(legacyLinkTarget(addressName, location.search), { replace: true })
    }
  }, [project, route.page, addressName, location.search, navigate])

  const [sources, setSources] = useState<PoolGroup[]>([])
  useEffect(() => {
    setSources([])
    const name = item?.name
    if (!name) {
      return
    }
    let active = true
    invoke<PoolGroup[]>('preview.sources', { projectId: instanceId, component: name })
      .then((s) => {
        if (active) {
          setSources(Array.isArray(s) ? s : [])
        }
      })
      .catch(() => {
        if (active) {
          setSources([])
        }
      })
    return () => {
      active = false
    }
  }, [instanceId, item?.name])

  if (project === undefined) {
    return <div className='p-6 py-12 text-center text-xs text-muted-foreground'>Loading…</div>
  }
  if (project === null) {
    return (
      <div className='flex h-full w-full items-center justify-center p-6'>
        <div className='flex max-w-md flex-col items-center gap-3 text-center'>
          <Palette className='size-8 text-muted-foreground' />
          <p className='text-sm text-muted-foreground'>This Design Kit instance could not be resolved.</p>
        </div>
      </div>
    )
  }

  const entries = items.map((i) => ({
    name: i.name,
    title: i.title,
    type: i.type,
    category: i.category,
    draft: i.draft,
    href: appHref(componentAppPath(i.name)),
  }))

  // Named for its type, since `selection` is the component resolution above.
  // With no resolved item it names only the project: with a request that did
  // not resolve there is no component for the chat to claim is open.
  const chatSelection: ChatSelection | null = (() => {
    const projectLine = `Design project: ${project.name} (${project.slug})`
    if (!item) {
      return { label: project.name, content: projectLine }
    }
    return {
      label: `${project.name} · ${item.title || item.name}`,
      content: [
        projectLine,
        `Component: ${item.name}${item.title && item.title !== item.name ? ` (${item.title})` : ''}`,
      ].join('\n'),
    }
  })()

  // The shell composes these twice — pinned header over a scrolling tree side
  // by side, header over a folded tree stacked — so they stay two pieces.
  const projectHeader = (
    <div className='flex items-center justify-between gap-2'>
      <div className='min-w-0'>
        <div className='truncate text-sm font-semibold'>{project.name}</div>
        <div className='truncate text-xs text-muted-foreground'>@{project.slug}</div>
      </div>
      <ProjectThemeEditor projectId={instanceId} theme={project.theme} onSaved={() => reloadProject()} />
    </div>
  )
  const componentTree =
    entries.length > 0 ? (
      <ComponentTree
        items={entries}
        selected={item?.name ?? ''}
        onSelect={(name) => {
          navigate(componentAppPath(name))
          setTreeOpen(false)
        }}
      />
    ) : null

  const content = loadingComponents ? (
    <div className='py-12 text-center text-xs text-muted-foreground'>Loading components…</div>
  ) : selection.status === 'other-project' ? (
    // ABOVE THE FAILED READ, deliberately: this is the one answer on the page
    // that never consults the component list. It is decided from the address
    // and the project's own identities, and both of those are established while
    // the list is unreadable — so this sentence survives an outage intact, and
    // reporting the outage instead would replace a true and final answer with a
    // less useful one. The reader settles it the same way: a cross-project
    // address does not start working when the list heals, so "could not be
    // read" would promise them a retry that can never help.
    //
    // Says only what the page knows. It read a project half, and that is not
    // one this page answers to — so it names the project that was asked for
    // and stops. It deliberately does NOT say the component was not found:
    // the component may exist perfectly well, in the project the address
    // actually names, and claiming otherwise would be asserting an absence
    // this page never looked for. Establishing that would take a lookup, and
    // a page that has to fetch in order to phrase an error is a worse trade
    // than a sentence that is true without one.
    //
    // No apology and no suggested remedy: opening another project is not
    // something this page can do, and offering it would be the same kind of
    // claim in a friendlier voice.
    <div className='rounded-md border border-destructive/40 bg-destructive/5 px-4 py-12 text-center'>
      <p className='text-sm font-medium break-words text-destructive'>{`The address names the design project "${selection.project}", which is not this one.`}</p>
    </div>
  ) : stored === null ? (
    // Checked before every branch that reads the component list, because each
    // sentence below it is a claim ABOUT that list and none of them is true
    // when it could not be read. Without this the page would tell a reader
    // their project was empty, or that a component they had a working link to
    // did not exist — and both invite an action that destroys something: create
    // what already exists, or recreate what was never gone.
    //
    // The one branch above it is not a hole in that rule: it is the only answer
    // here that makes no claim about the list at all.
    //
    // "Could not be read" is this product's own phrase for a load that failed,
    // and the muted panel is how it already says it — the same on a component's
    // history and, one function above this, on the instance itself. Matching
    // rather than inventing is what keeps a reader from having to learn a
    // second vocabulary for the same event.
    <div className='rounded-lg border border-dashed px-4 py-12 text-center text-sm text-muted-foreground'>
      This project's components could not be read.
    </div>
  ) : item ? (
    <ComponentDoc
      key={item.name}
      item={item}
      namespace={project.slug}
      projectId={instanceId}
      sources={sources}
      onOpenEditor={() => navigate(EDITOR_QUERY, { replace: true })}
    />
  ) : selection.status === 'missing' ? (
    // The destructive register its siblings here use for an act that was turned
    // down, rather than the muted one the empty state below uses: an empty
    // project is a state somebody is in, and this is a request that was
    // refused. The sentence is the server's own, so that a reader who meets the
    // same miss through the registry route reads the same words.
    //
    // No `role='alert'`: unlike the publish-error panel, which announces over a
    // screen that carried on as if nothing happened, this IS the page's content
    // and is read in place, like the doc it stands in for. The tree beside it
    // is the way out, so nothing is said here about what to do next.
    <div className='rounded-md border border-destructive/40 bg-destructive/5 px-4 py-12 text-center'>
      <p className='text-sm font-medium break-words text-destructive'>{`Component "${selection.requested}" not found.`}</p>
    </div>
  ) : (
    <div className='rounded-lg border border-dashed px-4 py-12 text-center text-sm text-muted-foreground'>
      An empty project. Add a component with this instance's{' '}
      <code className='rounded bg-muted px-1 py-0.5 font-mono text-xs'>writeComponent</code> action.
    </div>
  )

  return (
    <ChatDock space={spaceSlug} threadId={SPACE_THREAD_ID} selection={chatSelection}>
      {editorOpen && item ? (
        <div className='flex h-full flex-col' style={{ minHeight: 480 }}>
          <SourceEditorPage
            key={`${instanceId}:${item.name}`}
            projectId={instanceId}
            componentName={item.name}
            draft={item.draft}
            onExit={() => {
              navigate(componentAppPath(item.name), { replace: true })
              reloadComponents()
            }}
          />
        </div>
      ) : (
        // `h-full` in the shell resolves, checked rather than assumed: the
        // host's `main` is `h-dvh`, the App page mounts this in a `flex-1
        // min-h-0` column of it, the host ChatDock root is `h-full min-h-0`,
        // and ChatDock in components/chat-panel.tsx hands us a stretched
        // `flex-1 overflow-auto` flex item. Side by side, the page itself never
        // scrolls.
        <LibraryShell
          header={projectHeader}
          tree={componentTree}
          treeLabel={item?.title || item?.name}
          treeOpen={treeOpen}
          onTreeOpenChange={setTreeOpen}
        >
          {content}
        </LibraryShell>
      )}
    </ChatDock>
  )
}
