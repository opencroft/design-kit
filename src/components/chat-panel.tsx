import { ChatDock as HostChatDock, SelectionProvider, useSelection } from '@opencroft/client/chat'
import { type ReactNode, useEffect } from 'react'

// The chat's whole chrome -- launcher, docking, floating window, mobile
// cover -- is the host's ChatDock, the same surface the space canvas mounts.
// The dashboard contributes only what is its own: the selection bridge and
// which thread is its default.

export interface ChatSelection {
  label: string
  content: string
}

interface ChatDockProps {
  /** The group chat to open, or null when it cannot be determined yet. */
  space: string | null
  /** Thread slug within that chat. */
  threadId: string
  /** What the reader currently has open, published into the scope. */
  selection: ChatSelection | null
  /** The surface the chat sits beside. */
  children: ReactNode
}

// Publishes the host's current selection into the scope. Renders nothing -- it
// is wiring, and it lives in its own component because the hook has to run
// inside the provider.
function SelectionBridge({ selection }: { selection: ChatSelection | null }) {
  const { setSelection, clearSelection } = useSelection()
  const label = selection?.label ?? ''
  const content = selection?.content ?? ''
  useEffect(() => {
    if (!label) {
      clearSelection()
      return
    }
    setSelection({ label, content })
    // Keyed on the VALUES rather than the object: the caller builds this inline
    // on every render, so depending on its identity would run this effect on
    // every render of the caller and publish a selection identical to the one
    // already there -- a write to the scope, and a re-render of everything
    // reading it, for no change. What would retire this guard is the caller
    // handing down a stable object instead.
  }, [label, content, setSelection, clearSelection])
  return null
}

/**
 * The dashboard, with the host's shared chat surface around it.
 *
 * The whole surface is ONE selection scope: leaving the dashboard unmounts the
 * provider and the selection goes with it, which is the mechanic's own
 * guarantee rather than something maintained here.
 *
 * Without a project resolved there is nothing to scope a conversation to, so
 * `children` render alone and no chat is offered until one is.
 */
export function ChatDock({ space, threadId, selection, children }: ChatDockProps) {
  if (!space) {
    return <>{children}</>
  }

  return (
    <SelectionProvider>
      <HostChatDock space={space} id={threadId} title={`Chat · ${space}`}>
        <SelectionBridge selection={selection} />
        <div className='min-h-0 min-w-0 flex-1 overflow-auto'>{children}</div>
      </HostChatDock>
    </SelectionProvider>
  )
}
