import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'

import { baseScope, builtinModules } from './base-scope'
import { moduleResolver, type NpmModule, npmModuleKey } from './declared-deps'
import { depUrl } from './dep-url'
import { createEvalCore, npmModules } from './eval-core'
import { type FrameMessage, isPreviewMessage, type PoolGroup, PREVIEW_CHANNEL, type PreviewMode, type RenderPayload } from './protocol'
import { buildProjectExports } from './project-exports'
import { unverifiableDepReason } from './unverifiable-dep'

// The preview iframe application. Bundled server-side (see server/preview.ts)
// with its own React — the host page's React never crosses the frame boundary.
// Tailwind utilities are compiled inside the frame by @tailwindcss/browser, so
// any class a stored design uses just works, against the project's own theme.

// npm dependencies fetched on demand import react/react-dom as bare specifiers;
// the shell's import map points those at shims reading this global, so a dep
// bundle shares this frame's React instead of bringing a second copy.
;(globalThis as Record<string, unknown>).__designKitPreview = {
  React,
  ReactDOM,
  ReactDOMClient: { createRoot },
  jsxRuntime,
}

// npm modules fetched from the dep endpoint, by npmModuleKey. Built-ins never
// land here (see ./base-scope).
const loadedModules = new Map<string, Record<string, unknown>>()
const failedModules = new Map<string, string>()

const modulesFor = (dependencies: readonly string[]) => moduleResolver(dependencies, builtinModules, loadedModules)

// Fetch server-bundled ESM for npm deps the sources import. Failures are
// remembered (no refetch storm while typing) and surfaced under the preview.
async function ensureDeps(modules: NpmModule[]): Promise<void> {
  await Promise.all(
    modules
      .filter((m) => !loadedModules.has(npmModuleKey(m)) && !failedModules.has(npmModuleKey(m)))
      .map(async (module) => {
        const key = npmModuleKey(module)
        try {
          const url = new URL(depUrl(module), window.location.href).href
          const ns = (await import(/* @vite-ignore */ url)) as Record<string, unknown>
          loadedModules.set(key, ns)
        } catch (e) {
          failedModules.set(key, e instanceof Error ? e.message : String(e))
        }
      }),
  )
}

function post(msg: Omit<FrameMessage, 'channel'>): void {
  window.parent.postMessage({ channel: PREVIEW_CHANNEL, ...msg }, window.location.origin)
}

function ErrorText({ msg }: { msg: string }) {
  return <div className='m-4 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-center font-mono text-xs text-destructive'>{msg}</div>
}

// Deliberately NOT the destructive treatment: an unverifiable dependency is not
// a defect, so the note says the component is fine and only states what could
// not be checked here. Distinct from both a clean render and a red failure — a
// third visual state for the third verdict.
function UnverifiableText({ msg }: { msg: string }) {
  return <div className='m-4 whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-4 py-3 text-center font-mono text-xs text-muted-foreground'>{msg}</div>
}

// React error #130 ("element type is invalid") almost always means one of these
// imports was undefined — so when the boundary catches while imports are
// unresolved, name them instead of showing the opaque minified error.
function explain(error: string, unresolved: string[]): string {
  if (unresolved.length === 0) {
    return error
  }
  const looksLikeMissingElement = /element type is invalid|https:\/\/react\.dev\/errors\/130/i.test(error)
  const header = looksLikeMissingElement ? 'Unresolved imports (provide them via dependencies / registryDependencies):' : `${error}\n\nUnresolved imports:`
  return `${header}\n${unresolved.map((u) => `  • ${u}`).join('\n')}`
}

class Boundary extends React.Component<{ children: React.ReactNode; unresolved?: string[]; renderKey?: string }, { error: string | null }> {
  state: { error: string | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  // A component that throws while rendering never reaches App's own report, so
  // without this the render is announced as successful and the page shows an
  // error — "compiled" reported as "worked". Anything waiting on that report
  // (the sandbox API, the dashboard's error surface) would believe it.
  componentDidCatch(error: unknown): void {
    // Report the human reason for an unverifiable dependency, not the raw
    // marker — and still a NON-NULL error, so a reader that knows only
    // ok-vs-failed puts an unverifiable render on the not-ok side rather than
    // mistaking it for a clean pass.
    const message = error instanceof Error ? error.message : String(error)
    post({ type: 'rendered', error: unverifiableDepReason(message) ?? message, renderKey: this.props.renderKey })
  }

  render(): React.ReactNode {
    if (this.state.error !== null) {
      const unverifiable = unverifiableDepReason(this.state.error)
      return unverifiable ? <UnverifiableText msg={unverifiable} /> : <ErrorText msg={explain(this.state.error, this.props.unresolved ?? [])} />
    }
    return this.props.children
  }
}

interface Rendered {
  node: React.ReactNode
  error: string | null
  // Value imports the frame couldn't resolve (shadcn primitives or components
  // from another project). Likely cause of any render crash — shown to the user.
  unresolved: string[]
}

function renderPayload(payload: RenderPayload): Rendered {
  const core = createEvalCore({ React, baseScope })
  const projectExports = buildProjectExports(core, payload.sources, modulesFor)
  const resolve = (n: string) => projectExports.exports[n]
  const modules = modulesFor(payload.dependencies)
  // Sibling-group diagnostics ride along with whichever `unresolved` list this
  // function ends up returning — the previewed file's own imports may all
  // resolve fine while a dependency it pulled in internally didn't.
  const withDiagnostics = (unresolved: string[]): string[] => [...unresolved, ...projectExports.diagnostics]

  if (payload.mode === 'snippet') {
    const { element, error, unresolved } = core.evaluateSnippet(payload.code, resolve, modules)
    return { node: element as React.ReactNode, error, unresolved: withDiagnostics(unresolved) }
  }

  const { value, error, unresolved: defaultUnresolved } = core.evalDefaultExport(payload.code, resolve, modules)
  const unresolved = withDiagnostics(defaultUnresolved)
  if (error) {
    return { node: null, error, unresolved }
  }
  if (typeof value !== 'function') {
    return { node: null, error: 'preview.tsx must `export default` a component', unresolved }
  }
  const Comp = value as React.ComponentType<Record<string, unknown>>

  if (payload.mode === 'sheet' && payload.sheet) {
    const { prop, entries, baseProps } = payload.sheet
    return {
      node: (
        <div className='flex flex-wrap gap-3 p-4'>
          {entries.map(({ label, value: swept }) => {
            const props: Record<string, unknown> = { ...baseProps }
            if (swept === undefined) {
              delete props[prop]
            } else {
              props[prop] = swept
            }
            return (
              <div key={label} className='flex flex-col items-center gap-2'>
                <div className='flex min-h-16 min-w-24 items-center justify-center rounded-md border bg-muted/20 p-3'>
                  <Boundary key={label} unresolved={unresolved}>
                    <Comp {...props} />
                  </Boundary>
                </div>
                <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground'>{label}</code>
              </div>
            )
          })}
        </div>
      ),
      error: null,
      unresolved,
    }
  }

  return { node: <Comp {...(payload.props ?? {})} />, error: null, unresolved }
}

function DepFailures() {
  if (failedModules.size === 0) {
    return null
  }
  return (
    <div className='mx-4 mb-2 whitespace-pre-wrap rounded border border-destructive/30 bg-muted/40 px-2 py-1 font-mono text-[10px] text-muted-foreground'>
      {[...failedModules.keys()].map((m) => `failed to load dependency: ${m}`).join('\n')}
    </div>
  )
}

function App({ payload }: { payload: RenderPayload }) {
  const { node, error, unresolved } = React.useMemo(() => renderPayload(payload), [payload])

  // Once per render, not once per change of `error`: two successful renders in a
  // row both carry `error: null`, so keying this on the error alone means the
  // second one is never announced — and anything waiting for it (see the
  // sandbox API below) waits forever.
  React.useEffect(() => {
    post({ type: 'rendered', error, renderKey: payload.renderKey })
  }, [error, payload])

  if (error) {
    return <ErrorText msg={explain(error, unresolved)} />
  }
  if (payload.mode === 'sheet' || payload.fullBleed) {
    return (
      <>
        <Boundary key={payload.renderKey ?? payload.code} renderKey={payload.renderKey} unresolved={unresolved}>
          {node}
        </Boundary>
        <DepFailures />
      </>
    )
  }
  return (
    <>
      <div className='grid w-full place-items-center'>
        <Boundary key={payload.renderKey ?? payload.code} renderKey={payload.renderKey} unresolved={unresolved}>
          {node}
        </Boundary>
      </div>
      <DepFailures />
    </>
  )
}

// ── boot ─────────────────────────────────────────────────────────────

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('preview shell is missing #root')
}
const root = createRoot(rootEl)

let seq = 0
async function handleRender(payload: RenderPayload): Promise<void> {
  const mySeq = ++seq
  await ensureDeps(npmModules([...payload.sources, { files: [payload.code], dependencies: payload.dependencies }]))
  if (mySeq !== seq) {
    return // superseded while deps were loading
  }
  root.render(<App payload={payload} />)
}

// ── driving a self-loading page from the outside ─────────────────────
// A page that loaded its own component (see the branch at the bottom) is where
// a snippet can be tried against the real component pool without touching the
// stored files: `designKit.render(code)` drives the SAME render path the
// dashboard's editor drives, and resolves with what the page then showed.
// Nothing is persisted — a reload restores the component's own preview.
//
// Reachable only from inside the page, never from the URL. Code carried in a
// link would make opening it the same act as executing it; that is a capability
// this page does not have today and must not gain. Anyone who can call this can
// already postMessage the same payload, so the trust boundary is unchanged.

interface SandboxResult {
  ok: boolean
  error: string | null
}

interface SandboxApi {
  /** resolves once the component pool has loaded and the first render is in */
  ready: Promise<void>
  /** render a snippet against the loaded pool; resolves with the outcome */
  render(code: string, opts?: { mode?: PreviewMode; props?: Record<string, unknown> }): Promise<SandboxResult>
  /** back to the component's own docs preview */
  reset(): Promise<SandboxResult>
}

// Every render already announces itself with a `rendered` message (the parent
// uses it for error reporting); standalone, `post` targets this same window, so
// awaiting that message is how a caller learns the outcome. The timeout is the
// honest answer to a component that crashes without producing one: a call that
// never resolves is worse than one that says it timed out.
function nextRendered(renderKey: string, timeoutMs = 5000): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const done = (result: SandboxResult) => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(result)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !isPreviewMessage(event.data)) {
        return
      }
      const msg = event.data
      // Match on the key, not on arrival order: postMessage is asynchronous, so
      // the previous payload's report can land after this call started waiting.
      if (msg.type === 'rendered' && msg.renderKey === renderKey) {
        done({ ok: !msg.error, error: msg.error })
      }
    }
    const timer = setTimeout(() => done({ ok: false, error: 'timed out waiting for the render to report' }), timeoutMs)
    window.addEventListener('message', onMessage)
  })
}

let sandboxSeq = 0

function installSandbox(initial: RenderPayload, ready: Promise<void>): void {
  const run = (payload: RenderPayload): Promise<SandboxResult> => {
    sandboxSeq += 1
    const renderKey = `sandbox-${sandboxSeq}`
    const settled = nextRendered(renderKey)
    void handleRender({ ...payload, renderKey })
    return settled
  }
  const api: SandboxApi = {
    ready,
    render: (code, opts) => run({ ...initial, mode: opts?.mode ?? 'snippet', code, props: opts?.props ?? {} }),
    reset: () => run(initial),
  }
  ;(window as unknown as Record<string, unknown>).designKit = api
}

// Content-height reporting for the parent's fit-content sizing. The parent owns
// width, the frame owns height — one direction per axis, no feedback loop.
let lastHeight = -1
function reportSize(): void {
  const height = Math.ceil(rootEl.getBoundingClientRect().height)
  if (Math.abs(height - lastHeight) >= 1) {
    lastHeight = height
    post({ type: 'size', height })
  }
}
new ResizeObserver(reportSize).observe(rootEl)
window.addEventListener('load', reportSize)

window.addEventListener('message', (event: MessageEvent) => {
  if (event.origin !== window.location.origin || !isPreviewMessage(event.data)) {
    return
  }
  const msg = event.data
  if (msg.type === 'render') {
    void handleRender(msg.payload)
  } else if (msg.type === 'dark') {
    document.documentElement.classList.toggle('dark', msg.dark)
  }
})

// Self-loading mode: the URL names a component, so this page fetches it from
// the data route and renders its docs preview itself rather than waiting to be
// handed one.
//
// The discriminator is the URL, not the framing. `window.parent === window`
// cannot stand in for "nobody is going to feed me": a frame is also how the
// source editor asks for a self-loading preview, and against that parent,
// which mounts the iframe and posts nothing, this page would wait forever for
// a `render` that never comes. An empty body and no error is what that looks
// like from outside.
//
// The two modes cannot overlap, which is what makes the URL a safe
// discriminator: the embedded frame's src carries no `component` (see
// preview-frame.tsx) precisely because that frame is fed over postMessage. So a
// `component` in the URL is always a request to self-load, framed or not.
const params = new URLSearchParams(window.location.search)
const selfLoadComponent = params.get('component')
const projectId = params.get('project')
// Which block of the doc page this link opens on. Passed straight through to
// the data route, which is the only thing that knows what names a component's
// document offers — this page never decides that, so a link cannot make it
// render anything the component does not document.
const selfLoadTarget = params.get('target')
if (selfLoadComponent && projectId) {
  const query = new URLSearchParams({ project: projectId, component: selfLoadComponent })
  if (selfLoadTarget) {
    query.set('target', selfLoadTarget)
  }
  const url = new URL(`data?${query.toString()}`, window.location.href).href
  // `ready` is what a caller awaits instead of guessing with a timeout: it
  // settles when the pool is loaded and the component's own preview is on
  // screen, which is the state every later `render` builds on.
  const ready = fetch(url)
    // A refusal from the route carries a sentence a reader can act on ("no
    // documented preview named …", plus the names the document does offer).
    // Reporting only the status code would throw that away and leave a page
    // saying only "404" for a link naming a block that has since been renamed.
    .then(async (r) => {
      if (r.ok) {
        return r.json()
      }
      const body = (await r.json().catch(() => null)) as { error?: string; available?: string[] } | null
      const detail = body?.available?.length ? `${body.error}\n\nThis component documents:\n${body.available.map((t) => `  • ${t}`).join('\n')}` : body?.error
      throw new Error(detail || `${r.status}`)
    })
    .then((data: { sources: PoolGroup[]; mode?: PreviewMode; code: string | null; props?: Record<string, unknown>; exportName: string; dependencies: string[] }) => {
      // The mode travels with the code because it is a property of the block
      // that was opened, not of this page: an <Example> is a snippet and a
      // <Preview> is a module with a default export, and rendering one as the
      // other fails in a way that reads as a broken component. The route
      // decides it, from the document — a URL cannot.
      const code = data.code ?? `export default function Example() {\n  return <${data.exportName} />\n}`
      const mode: PreviewMode = data.code != null && data.mode ? data.mode : 'default-export'
      // Standalone = viewed as a page: no centering wrapper, so full-width
      // components (page layouts, section backgrounds) stretch to the viewport.
      const initial: RenderPayload = { mode, sources: data.sources, code, dependencies: data.dependencies, props: data.props ?? {}, fullBleed: true }
      installSandbox(initial, ready)
      return handleRender(initial)
    })
    .catch((e) => {
      root.render(<ErrorText msg={`failed to load component: ${e instanceof Error ? e.message : String(e)}`} />)
    })
} else {
  post({ type: 'ready' })
}
