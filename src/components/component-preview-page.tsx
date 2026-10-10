import { useCallback, useEffect, useMemo, useRef } from 'react'

import { PREVIEW_CHANNEL } from '../../preview-runtime/protocol'
import { standalonePreviewUrl, useHostDark } from './preview-frame'

// A component's standalone preview as a page of the App
// (`/component/<name>/preview[/<target>]`): the self-loading preview document
// filling the window, and nothing else. The manifest lists these paths in
// `fullPageRoutes`, so the host draws none of its own chrome around this page
// either — the component is all there is on it. The document itself stays on the
// extension's preview route — its runtime, Tailwind and data are fetched from
// beside it by relative URL — so this page frames it rather than moving it.
//
// Which component and which block of its doc are passed straight through: the
// data route resolves the name against the component's own doc and refuses one
// it does not document, and the frame shows that refusal.

export function ComponentPreviewPage({
  projectId,
  component,
  target,
}: {
  projectId: string
  component: string
  target: string | null
}) {
  const dark = useHostDark()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Themed at load from the query, as the embedded frame is; a later toggle
  // goes over postMessage so that it does not reload the page. The theme is
  // read at the moment the address changes, not kept as a dependency.
  const src = useMemo(
    () =>
      standalonePreviewUrl(
        projectId,
        component,
        document.documentElement.classList.contains('dark'),
        target ?? undefined,
      ),
    [projectId, component, target],
  )

  const postDark = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { channel: PREVIEW_CHANNEL, type: 'dark', dark },
      window.location.origin,
    )
  }, [dark])

  useEffect(() => {
    postDark()
  }, [postDark])

  return (
    <iframe
      ref={iframeRef}
      src={src}
      title={`${component} preview`}
      onLoad={postDark}
      className='block h-full w-full flex-1 border-0'
    />
  )
}
