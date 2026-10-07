import { React, routeUrl } from '@ext/host'

import { type FrameMessage, isPreviewMessage, PREVIEW_CHANNEL, type RenderPayload } from '../../preview-runtime/protocol'
import { cn } from 'cn'

// The isolated preview surface: an iframe served by this extension's preview
// routes. Host styles cannot leak in (and design styles cannot leak out); the
// frame compiles its own Tailwind against the project theme.
//
// Sizing contract: the parent owns width, the frame owns height. The frame
// reports its content height (ResizeObserver → postMessage) and we set the
// iframe to exactly that, so previews fit their content — a badge stays small,
// a full page grows. Past `collapsedMax` the frame is capped behind an
// "Show all" expander so page-scale designs don't swallow the doc flow.

/** Track the dashboard's dark mode (the host toggles `.dark` on <html>). */
export function useHostDark(): boolean {
  const [dark, setDark] = React.useState(() => document.documentElement.classList.contains('dark'))
  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

// `target` names WHICH block of the component's doc page opens — the same
// names the validator reports under (`preview:<src>`, `example:<src>`; see
// server/preview-target.ts). Omitted, the page opens on the component's main
// preview. It carries a name and never the code: a link carrying code would
// make opening it the same act as executing it.
export function standalonePreviewUrl(projectId: string, component: string, dark: boolean, target?: string): string {
  const params = new URLSearchParams({ project: projectId, component })
  if (target) {
    params.set('target', target)
  }
  if (dark) {
    params.set('dark', '1')
  }
  return routeUrl(`preview/?${params.toString()}`)
}

export interface PreviewFrameProps {
  payload: RenderPayload
  projectId: string
  /** floor for the frame, keeps small components in a comfortable cell */
  minHeight?: number
  /** cap before the expander kicks in */
  collapsedMax?: number
  className?: string
}

export function PreviewFrame({ payload, projectId, minHeight = 208, collapsedMax = 640, className }: PreviewFrameProps) {
  const dark = useHostDark()
  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = React.useState(false)
  const [contentHeight, setContentHeight] = React.useState(0)
  const [expanded, setExpanded] = React.useState(false)

  // The frame is themed at load time from the query; later toggles go over
  // postMessage. Freeze the src so a dark-mode flip doesn't reload the frame.
  const [src] = React.useState(() => routeUrl(`preview/?project=${encodeURIComponent(projectId)}${document.documentElement.classList.contains('dark') ? '&dark=1' : ''}`))

  const post = React.useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ channel: PREVIEW_CHANNEL, ...msg }, window.location.origin)
  }, [])

  // The eval pool. Empty means the source closure is still loading — don't
  // render an incomplete pool (missing shadcn / cross-project deps would render
  // as `undefined` and latch the error boundary); show the loader instead.
  const hasSources = payload.sources.length > 0

  const payloadRef = React.useRef(payload)
  payloadRef.current = payload

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || !isPreviewMessage(event.data)) {
        return
      }
      const msg = event.data as FrameMessage
      if (msg.type === 'ready') {
        setReady(true)
        if (payloadRef.current.sources.length > 0) {
          post({ type: 'render', payload: payloadRef.current })
        }
      } else if (msg.type === 'size') {
        setContentHeight(Math.max(0, Math.min(msg.height, 20000)))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [post])

  React.useEffect(() => {
    if (ready && hasSources) {
      post({ type: 'render', payload })
    }
  }, [ready, hasSources, payload, post])

  React.useEffect(() => {
    if (ready) {
      post({ type: 'dark', dark })
    }
  }, [ready, dark, post])

  const overflows = contentHeight > collapsedMax
  const capped = overflows && !expanded
  const frameHeight = Math.max(minHeight, capped ? collapsedMax : contentHeight)

  return (
    <div className={cn('relative w-full', className)} style={{ height: frameHeight }}>
      {/* No `sandbox` attribute: this frame runs same-origin with the dashboard,
          and the stored designs it evaluates are trusted as the dashboard's
          own code. The isolation here is style/dependency-level (host
          utilities can't leak in, a design's Tailwind can't leak out) — not a
          security boundary. */}
      <iframe ref={iframeRef} src={src} title='Component preview' className='block h-full w-full border-0' />
      {(!ready || !hasSources) && <div className='pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground'>Loading preview…</div>}
      {capped && (
        <div className='absolute inset-x-0 bottom-0 z-10 flex justify-center bg-gradient-to-t from-background to-transparent pb-2 pt-8'>
          <button type='button' onClick={() => setExpanded(true)} className='rounded-full border bg-background px-3 py-1 text-xs font-medium shadow-sm transition-colors hover:bg-muted'>
            Show all ({contentHeight}px)
          </button>
        </div>
      )}
      {overflows && expanded && (
        <div className='absolute inset-x-0 bottom-0 z-10 flex justify-center pb-2'>
          <button type='button' onClick={() => setExpanded(false)} className='rounded-full border bg-background px-3 py-1 text-xs font-medium shadow-sm transition-colors hover:bg-muted'>
            Collapse
          </button>
        </div>
      )}
    </div>
  )
}
