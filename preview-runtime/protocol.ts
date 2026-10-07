// postMessage protocol between the dashboard (parent) and the preview iframe.
// Shared by src/components/preview-frame.tsx (parent side) and
// preview-runtime/entry.tsx (frame side). Same-origin only — both sides verify
// event.origin against their own.

export const PREVIEW_CHANNEL = 'design-kit-preview'

export type PreviewMode = 'snippet' | 'default-export' | 'sheet'

export interface SheetSpec {
  prop: string
  /** already-coerced prop values, `undefined` value = omit the prop */
  entries: Array<{ label: string; value: unknown }>
  baseProps: Record<string, unknown>
}

/** One component of a preview pool: its source files and the npm packages they resolve against. */
export interface PoolGroup {
  files: string[]
  /** the component's declared `dependencies` entries (`pkg` / `pkg@range`) */
  dependencies: string[]
}

export interface RenderPayload {
  mode: PreviewMode
  /** one entry per registry component (feeds the eval scope) */
  sources: PoolGroup[]
  /** the code being demoed (example / preview.tsx), per `mode` semantics */
  code: string
  /** the demoed component's declared `dependencies`, which `code` resolves against */
  dependencies: string[]
  /** props for the default export (`default-export` mode) */
  props?: Record<string, unknown>
  sheet?: SheetSpec
  /** remounts the error boundary (so a fixed edit clears a crashed preview) */
  renderKey?: string
  /** render without the centering wrapper — page-flow layout for the
   *  standalone (open-in-new-tab) mode, where a full page component must
   *  stretch to the viewport instead of shrinking to content width */
  fullBleed?: boolean
}

/** What a demo evaluates against: the pool, and the demoed component's own declarations. */
export type PreviewScope = Pick<RenderPayload, 'sources' | 'dependencies'>

export type ParentMessage =
  | { channel: typeof PREVIEW_CHANNEL; type: 'render'; payload: RenderPayload }
  | { channel: typeof PREVIEW_CHANNEL; type: 'dark'; dark: boolean }

export type FrameMessage =
  | { channel: typeof PREVIEW_CHANNEL; type: 'ready' }
  | { channel: typeof PREVIEW_CHANNEL; type: 'size'; height: number }
  // `renderKey` echoes the payload's, so a caller awaiting a specific render can
  // tell its own report from the one still in flight for the previous payload —
  // postMessage is asynchronous, so without it reports arrive off by one.
  | { channel: typeof PREVIEW_CHANNEL; type: 'rendered'; error: string | null; renderKey?: string }

export function isPreviewMessage(data: unknown): data is ParentMessage | FrameMessage {
  return typeof data === 'object' && data !== null && (data as { channel?: unknown }).channel === PREVIEW_CHANNEL
}
