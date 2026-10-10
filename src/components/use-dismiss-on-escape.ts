import { useEffect } from 'react'

// Escape closes a dialog, and what it closes it to is fixed here rather than
// chosen per caller.
//
// Held in one place because the two surfaces that need it sit in the same
// editor, and two dialogs in one editor disagreeing about Escape is worse than
// both ignoring it: a reader who presses it once and is answered, and once and
// is not, cannot learn either. Written twice, they would agree today and drift
// the first time one of them was touched alone.
//
// **Escape takes the non-destructive answer, always.** Keep the draft. Stay on
// the page. It must never be able to reach the act that loses work, and the
// reason is the same one that makes Escape worth adding at all: it is the key
// people press without looking, in the moment they realise they opened
// something they did not mean to. A reflex wired to the destructive branch is
// worse than no key at all, because the reflex does not pause to check.
//
// That makes the callback passed in the load-bearing part of every call site.
// Both dialogs this serves happen to name their DESTRUCTIVE callback
// `onDiscard` — "Discard" on one, "Leave anyway" on the other — so the two
// props a caller might reach for are one word apart. Read the call sites with
// that in mind; there is nothing this function can do to tell them apart.
//
// A window listener rather than a handler on the panel, following the editor's
// existing keyboard reflex: the panel would need focus inside it to see the
// key, and a reader who clicked the backdrop has focus nowhere in particular.
export function useDismissOnEscape(active: boolean, onCancel?: () => void): void {
  useEffect(() => {
    // Bound to whether the dialog is on screen, so nothing is listening while
    // it is closed — an Escape pressed in the editor is not for a dialog that
    // is not there.
    if (!active) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, onCancel])
}
