import { useAppHref } from '@opencroft/client/app'
import { CodeBlockEditor } from '@opencroft/client/code'
import { cn } from 'cn'
import { Check, Code2, Copy, ExternalLink, Grid3x3, Pencil, RotateCcw } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react'

import type { PreviewMode, PreviewScope, RenderPayload } from '../../preview-runtime/protocol'
import { previewAppPath } from './component-routes'
import { ExampleFrame, ExampleFrameWidthControl } from './example-frame'
import type { ExampleFrameWidth } from './example-frame-width'
import { PreviewFrame } from './preview-frame'

// The single preview surface used everywhere: an isolated PreviewFrame (iframe)
// inside the striped ExampleFrame, rendered at a chosen width — the Desktop /
// Tablet / Mobile presets, or any width the right-edge handle is dragged to.
// Media queries inside the frame respond for real, so a component that branches
// on the mobile breakpoint takes the mobile branch at the Mobile preset rather
// than merely looking narrow. Plus a Grid / Code / Copy / Reset toolbar and the
// editable, highlighted code. Controlled — the parent owns the code (so the
// props table or a use-case wrapper can drive it). Evaluation happens inside
// the frame; this component only ships payloads.
//
// The WIDTH is owned here and nowhere else: the frame draws at whatever it is
// handed, the presets and the drag handle both write this one value, so the two
// can never disagree about how wide the preview is.
export interface PreviewBlockProps {
  code: string
  onCodeChange: (v: string) => void
  onReset: () => void
  projectId: string
  /** the pool and declarations that feed the frame's eval scope */
  scope: PreviewScope
  /** the demoed component's name — enables the open-in-new-tab button */
  component?: string
  /** which block of the component's doc page this is, so Open opens THIS one
   *  rather than the component's main preview (see server/preview-target.ts) */
  target?: string
  mode: PreviewMode
  /** props for the default export (`default-export` mode) */
  previewProps?: Record<string, unknown>
  renderKey?: string
}

export function PreviewBlock({
  code,
  onCodeChange,
  onReset,
  projectId,
  scope,
  component,
  target,
  mode,
  previewProps,
  renderKey,
}: PreviewBlockProps) {
  const [copied, setCopied] = useState(false)
  const [grid, setGrid] = useState(true)
  const [showCode, setShowCode] = useState(true)
  // What the preview is rendered at: a preset, or a px width from the handle.
  const [width, setWidth] = useState<ExampleFrameWidth>('full')
  const frameRef = useRef<HTMLDivElement>(null)
  // True while the resize handle is held — see the shield rendered below.
  const [dragging, setDragging] = useState(false)
  const appHref = useAppHref()

  const payload = useMemo<RenderPayload>(
    () => ({ mode, ...scope, code, props: previewProps, renderKey }),
    [mode, scope, code, previewProps, renderKey],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard may be unavailable
    }
  }

  // Drag the right handle to set an explicit width; releasing near full clears
  // it back to the Desktop preset. The previewed box is CENTRED in the frame
  // (that is what gives the cross-hair rules something to trace), so the
  // pointer sits half a box away from the centre rather than a whole box away
  // from the left edge — the factor of two below is that, not a fudge.
  //
  // An iframe is its own document: once the pointer crosses into it, every
  // pointermove goes to the frame and this page's window hears nothing, so an
  // unguarded drag freezes the moment it passes over the preview it is
  // resizing — which, with the handle beside a centred box, is immediately.
  // Two guards:
  // pointer capture keeps the events on the handle where the browser honours
  // it, and a full-viewport shield sits over every frame on the page (this
  // preview's and its neighbours') for as long as the drag lasts, which works
  // everywhere.
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const container = frameRef.current
    if (!container) {
      return
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
    const move = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      const w = Math.round(Math.max(160, Math.min(rect.width, (ev.clientX - rect.left - rect.width / 2) * 2)))
      setWidth(w >= rect.width - 4 ? 'full' : w)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.userSelect = ''
      setDragging(false)
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    // A cancelled pointer (a touch taken over by scrolling, a lost capture)
    // never sends pointerup; without this the shield would stay up and the
    // whole page would stop taking clicks.
    window.addEventListener('pointercancel', up)
  }

  return (
    <div>
      <div ref={frameRef} className='relative flex min-h-60 overflow-hidden rounded-t-lg border bg-background'>
        {/* The frame always spans the block; how wide the PREVIEW renders is the
            frame's business, so that the gutters it leaves are real space the
            cross-hair rules can be drawn in. */}
        <ExampleFrame grid={grid} width={width} gutter={width === 'full' ? 0 : undefined}>
          <PreviewFrame payload={payload} projectId={projectId} minHeight={112} className='min-w-0' />
        </ExampleFrame>

        {/* Resize handle, pinned to the previewed box's right edge — which is
            the frame's right edge only at full width. */}
        <div
          onPointerDown={startResize}
          title='Drag to resize'
          style={typeof width === 'number' ? { left: `calc(50% + ${width / 2}px)` } : undefined}
          className={cn(
            'group absolute inset-y-0 z-20 flex w-2.5 cursor-ew-resize items-center justify-center',
            typeof width !== 'number' && 'right-0',
          )}
        >
          <div className='h-10 w-1 rounded-full bg-border transition-colors group-hover:bg-primary/70' />
        </div>

        {dragging && <div aria-hidden className='fixed inset-0 z-50 cursor-ew-resize' />}

        {typeof width === 'number' && (
          <div className='pointer-events-none absolute left-2 top-1 z-20 rounded bg-zinc-900/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200'>
            {width}px
          </div>
        )}
      </div>

      <div
        className={cn(
          'flex items-center justify-between gap-2 border border-t-0 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-400',
          !showCode && 'rounded-b-lg',
        )}
      >
        <span className='flex items-center gap-1.5'>
          {showCode && (
            <>
              <Pencil className='h-3 w-3' />
              Editable — change the code to update the preview
            </>
          )}
        </span>
        <div className='flex items-center gap-1'>
          <ExampleFrameWidthControl width={width} onChange={setWidth} />
          <span className='mx-0.5 h-3 w-px bg-zinc-700' />
          {component && (
            <a
              href={appHref(previewAppPath(component, target))}
              target='_blank'
              rel='noreferrer'
              title='Open this preview in a new tab'
              className='flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-zinc-800 hover:text-zinc-200'
            >
              <ExternalLink className='h-3 w-3' />
              Open
            </a>
          )}
          <button
            type='button'
            onClick={() => setGrid((g) => !g)}
            title='Toggle grid'
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-zinc-800 hover:text-zinc-200',
              grid && 'bg-zinc-800 text-zinc-200',
            )}
          >
            <Grid3x3 className='h-3 w-3' />
            Grid
          </button>
          <button
            type='button'
            onClick={() => setShowCode((s) => !s)}
            title={showCode ? 'Hide code' : 'Show code'}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-zinc-800 hover:text-zinc-200',
              showCode && 'bg-zinc-800 text-zinc-200',
            )}
          >
            <Code2 className='h-3 w-3' />
            Code
          </button>
          <button
            type='button'
            onClick={copy}
            className='flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-zinc-800 hover:text-zinc-200'
          >
            {copied ? <Check className='h-3 w-3' /> : <Copy className='h-3 w-3' />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type='button'
            onClick={() => {
              onReset()
              setWidth('full')
            }}
            className='flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-zinc-800 hover:text-zinc-200'
          >
            <RotateCcw className='h-3 w-3' />
            Reset
          </button>
        </div>
      </div>

      {showCode && (
        <div className='overflow-hidden rounded-b-lg border border-t-0 focus-within:ring-2 focus-within:ring-ring focus-within:ring-inset'>
          <CodeBlockEditor value={code} onChange={onCodeChange} language='tsx' />
        </div>
      )}
    </div>
  )
}
