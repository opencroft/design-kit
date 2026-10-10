import { callAppAction } from '@opencroft/client/actions'
import { Button, ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@opencroft/client/ui'
import { Code, Eye, List, PanelRight, PanelRightClose, SaveOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { invoke } from '../invoke'
import { MiddleTruncate } from './middle-truncate'
import { MonacoCodeEditor } from './monaco-code-editor'
import { PanelTabStrip } from './panel-tab-strip'
import { standalonePreviewUrl, useHostDark } from './preview-frame'
import { movedSince, type PublishBase, publishBaseOf } from './publish-base'
import { nextPublishStep } from './publish-queue'
import { SourceEditorDiscard } from './source-editor-discard'
import { type EditorFileRow, SourceEditorFiles } from './source-editor-files'
import { SourceEditorGuard } from './source-editor-guard'
import { type PublishState, SourceEditorHeader } from './source-editor-header'
import { type PublishErrorInfo, SourceEditorPublishError } from './source-editor-publish-error'
import { SourceEditorStaleness, type StalenessInfo } from './source-editor-staleness'
import { type CheckMoment, type CheckResult, SourceEditorValidation } from './source-editor-validation'

// The full-page source editor: one header row over the file pane, the code
// surface and the draft's live preview.
//
// It composes — the code surface is the extension's MonacoCodeEditor, the
// preview is the standalone preview route (which resolves DRAFTS by design, so
// it is the draft pane for free), and every act maps onto an existing server
// action: save → files.write with its optimistic guard, publish → the App's
// publishComponent action with expectedVersion, file operations → the files.*
// family. Three levels, never conflated: the BUFFER lives here and is lost by
// leaving (the guard's whole jurisdiction); the DRAFT persists via Save; the
// PUBLISHED copy moves only via Publish.
interface StoredFileData {
  path: string
  target: string
  type: string
  content: string
}

/** How every action here reports a check: the validator's own target rows. */
interface ValidationTargets {
  targets?: Array<{ target: string; outcome: string; error?: string; unresolvedImports?: string[] }>
}

/** The last check a component's draft saw, as `validation.last` and a publish
 *  both report it. Kept server-side, so it outlives this editor's own state. */
interface LastValidation {
  ok: boolean
  failed: ValidationTargets['targets']
}

/** How long the typing has to stop before the draft takes it. Long enough that
 *  a sentence is one write rather than forty, short enough that the window in
 *  which the work exists only in this tab is not something anyone notices. */
const AUTOSAVE_PAUSE_MS = 800

/** How long the typing has to stop before the preview re-renders. Deliberately
 *  longer than the save: the draft should follow the words closely, but a pane
 *  reloading under someone's hands is what they notice. This lands when they
 *  stop to look at it, which is when they look at it. */
const PREVIEW_REFRESH_QUIET_MS = 2000

interface ComponentRecord {
  name: string
  title?: string
  files?: StoredFileData[]
  version?: number
  publishedAt?: number
  /** Who published the version this record is at, as the store recorded it.
   *  Absent on records written before publishing recorded an author — those
   *  are still installed and still published against, so the panel that reads
   *  this has to work without it. */
  publishedBy?: { name?: string; kind?: string }
  /** What the component's draft currently is, as an opaque token. Handed back
   *  on a write as `expectedState` so the server can refuse one built on a
   *  state that has since moved. Compare it; never parse it. */
  state?: string
  /** The published version this component's draft is ahead of, `'unpublished'`
   *  when it has never been published, and ABSENT when there is no draft —
   *  which is the only thing that says whether one exists. */
  draft?: number | 'unpublished'
  /** Which of this component's files the draft has changed since the version it
   *  sits on, as file keys. Absent when there is no draft; empty when a draft
   *  exists and has changed nothing back. Computed on the server because this
   *  record carries the DRAFT's files and never the published ones, so the
   *  comparison cannot be made from here. */
  draftFilesChanged?: string[]
}

export interface SourceEditorPageProps {
  /** The Design Kit App instance, which is the project: the App's own actions
   *  are called on it. */
  projectId: string
  componentName: string
  /** Draft state as the component list reported it on entry. */
  draft?: number | 'unpublished'
  onExit: () => void
}

const fileKey = (f: StoredFileData): string => f.target || f.path

function typeForNewPath(path: string): string {
  if (path.startsWith('docs/')) {
    return 'registry:ignore'
  }
  return path.startsWith('hooks/') || path.includes('/hooks/') ? 'registry:hook' : 'registry:component'
}

// Which file a validator target points at, so a failure marks a row.
function fileForTarget(target: string, sourcePaths: string[]): string | undefined {
  if (target === 'preview') {
    return 'docs/preview.tsx'
  }
  if (target.startsWith('example:')) {
    const p = target.slice('example:'.length)
    return p.startsWith('docs/') ? p : `docs/${p}`
  }
  if (target.startsWith('sheet:')) {
    return 'docs/doc.mdx'
  }
  if (target === 'source') {
    return sourcePaths[0]
  }
  return undefined
}

export function SourceEditorPage({ projectId, componentName, draft, onExit }: SourceEditorPageProps) {
  const dark = useHostDark()

  const [record, setRecord] = useState<ComponentRecord | null>(null)
  const [base, setBase] = useState<PublishBase | null>(null)
  const [loading, setLoading] = useState(true)
  // Only touched files live here; everything else reads from the record.
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [activePath, setActivePath] = useState<string>('')
  const [publish, setPublish] = useState<PublishState>('idle')
  /** Publish was pressed and is waiting for the typing to reach the draft. */
  const [publishQueued, setPublishQueued] = useState(false)
  const [saving, setSaving] = useState(false)
  const [validation, setValidation] = useState<CheckResult[] | null>(null)
  const [validationMoment, setValidationMoment] = useState<CheckMoment>('draft')
  const [publishError, setPublishError] = useState<PublishErrorInfo | null>(null)
  /** What the last save said when it failed, kept until a save succeeds. This
   *  is the only state in which typed work exists nowhere but this tab. */
  const [saveError, setSaveError] = useState<string | null>(null)
  const [staleness, setStaleness] = useState<StalenessInfo | null>(null)
  /** The files that were yours at the moment Reload latest was pressed. Held
   *  from then on so the panel's promise can be kept: after a reload the draft
   *  differs from the newer published version in two ways at once — the files
   *  you changed, and the files somebody else changed that you are now behind
   *  on — and only the first set is anybody's to settle. */
  const [keptPaths, setKeptPaths] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [guardOpen, setGuardOpen] = useState(false)
  // Two states, not one: whether the question is on screen, and whether the
  // answer is being carried out. A single flag would make the dialog reappear
  // under the spinner it started.
  const [discardOpen, setDiscardOpen] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [previewNonce, setPreviewNonce] = useState(0)
  const [previewOpen, setPreviewOpen] = useState(true)
  // Which pane shows below the wide breakpoint. It opens on the files: on a
  // narrow surface, arriving at an empty editor pane asks the reader to go
  // looking for the list. The active path is local state that is always empty
  // on the first render, so the question has a single answer and a condition
  // would be a branch nothing can take. Choosing a file moves to the code pane,
  // which is where `'code'` is reached from.
  const [tab, setTab] = useState<'files' | 'code' | 'preview'>('files')
  const [creating, setCreating] = useState(false)
  const [renamingPath, setRenamingPath] = useState<string | undefined>()
  const [pendingDeletePath, setPendingDeletePath] = useState<string | undefined>()

  const files = useMemo(() => record?.files ?? [], [record])
  const dirtyPaths = useMemo(
    () =>
      files.filter((f) => edits[fileKey(f)] !== undefined && edits[fileKey(f)] !== f.content).map((f) => fileKey(f)),
    [files, edits],
  )
  const dirty = dirtyPaths.length > 0
  const failedFiles = useMemo(
    () => new Set((validation ?? []).filter((v) => v.outcome === 'error' && v.file).map((v) => v.file as string)),
    [validation],
  )

  // Re-reads the component. `rebase` says whether this read also becomes the
  // published version the draft is considered to be built on — which is a
  // separate question from what the record holds, and the reason the two are
  // separate state. Every save ends in a plain read, so `record.version` is
  // whatever the last read happened to see; taking the publish base from it
  // compares a value against itself, and it does so precisely when a save
  // precedes a publish, which is the case the staleness check exists for. The
  // base moves only where the editor deliberately re-bases: opening a
  // component, Reload latest, and a publish of its own.
  const load = useCallback(
    async ({ rebase = false }: { rebase?: boolean } = {}): Promise<ComponentRecord | null> => {
      const rec = await invoke<ComponentRecord | null>('components.get', { projectId, name: componentName })
      setRecord(rec)
      if (rebase) {
        setBase(rec ? publishBaseOf(rec) : null)
      }
      return rec
    },
    [projectId, componentName],
  )

  useEffect(() => {
    let active = true
    setLoading(true)
    // Nothing has been reconciled in a component nobody has opened yet, and a
    // set carried over from the last one would mark files by coincidence of
    // path.
    setKeptPaths(new Set<string>())
    // Opening a component is the first re-base: the version on screen is the
    // one whatever gets typed next is built on.
    load({ rebase: true })
      .then((rec) => {
        if (active && rec) {
          const first = (rec.files ?? []).find((f) => !fileKey(f).startsWith('docs/')) ?? (rec.files ?? [])[0]
          setActivePath((cur) => cur || (first ? fileKey(first) : ''))
        }
      })
      .catch((e) => toast.error(`Failed to load the component: ${String(e)}`))
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [load])

  // The browser-level half of the guard, and it asks about one thing: work a
  // save FAILED to store. A save merely waiting out the pause is not worth a
  // prompt — the window is under a second, and a browser dialog for it would
  // fire constantly and teach people to click through the one that matters.
  useEffect(() => {
    if (!saveError) {
      return
    }
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [saveError])

  const applyValidation = useCallback(
    (v: ValidationTargets | undefined, moment: CheckMoment = 'draft') => {
      if (!v?.targets) {
        setValidation(null)
        return
      }
      const sourcePaths = files.map(fileKey).filter((p) => !p.startsWith('docs/'))
      const results: CheckResult[] = v.targets
        .filter((t) => t.outcome !== 'ok')
        .map((t) => ({
          target: t.target,
          outcome: t.outcome === 'error' ? 'error' : 'unverifiable',
          message:
            t.error ??
            (t.unresolvedImports?.length
              ? `Unresolved imports: ${t.unresolvedImports.join(', ')}`
              : 'Could not be checked.'),
          file: fileForTarget(t.target, sourcePaths),
        }))
      setValidation(results.length > 0 ? results : null)
      setValidationMoment(moment)
    },
    [files],
  )

  const save = useCallback(async (): Promise<boolean> => {
    if (!record || dirtyPaths.length === 0) {
      // Nothing left to store, so nothing is at risk — a bar still standing
      // from an earlier failure would be reporting a state that has gone.
      setSaveError(null)
      return true
    }
    setSaving(true)
    try {
      const changed = files
        .filter((f) => dirtyPaths.includes(fileKey(f)))
        .map((f) => ({ path: f.path, target: f.target, type: f.type, content: edits[fileKey(f)] as string }))
      const res = await invoke<{ validation?: ValidationTargets }>('files.write', {
        projectId,
        component: componentName,
        files: changed,
        validate: true,
        expectedState: record.state,
      })
      applyValidation(res?.validation)
      setSaveError(null)
      setPublish('idle')
      // The record first, the buffer second, and never the other way round.
      // This pane shows `edits[path] ?? file.content`, so clearing the buffer
      // while the record still holds the pre-save text swaps the textarea's
      // value back to the old one and forward again a moment later — and a
      // controlled textarea whose value changes loses the caret to the end of
      // the file and drops whatever was selected. Updating the record first
      // makes the two strings identical, so the value never changes at all and
      // nothing moves. Saving runs at a pause between words, so this would
      // happen while somebody is typing.
      await load()
      // Only the keys this write carried, and only where the buffer still holds
      // what was written. Anything typed while the request was in flight is a
      // newer edit than the one being cleared, and dropping it would throw
      // those keystrokes away.
      setEdits((cur) => {
        const next = { ...cur }
        for (const f of changed) {
          if (next[fileKey(f)] === f.content) {
            delete next[fileKey(f)]
          }
        }
        return next
      })
      return true
    } catch (e) {
      // A bar across the editor rather than a toast. Nobody chose the moment
      // this happened — it fired off the back of typing — so there is no reason
      // to think anyone was watching, and a message that removes itself on a
      // timer is one they will never see. It also has to outlive the moment: it
      // is the only sign that what they typed exists nowhere but this tab.
      setSaveError(String(e))
      // The optimistic guard may have refused because the draft moved under
      // us — reload the record so the next save names the current revision.
      load().catch(() => {})
      return false
    } finally {
      setSaving(false)
    }
  }, [record, files, edits, dirtyPaths, projectId, componentName, applyValidation, load])

  // Held in a ref because `save` is rebuilt on every keystroke — it closes over
  // the buffer — so a timer that depended on it would be cleared and restarted
  // by the very typing it is waiting out, and would never fire.
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

  // Saving is not an act: the draft follows the typing. A pause triggers
  // it rather than a keystroke, so a sentence costs one write instead of forty,
  // and `saving` holds the next one back so a slow write cannot have another
  // land on top of it.
  //
  // A failed save stops the loop dead. Without that check this would retry
  // instantly and forever against whatever is refusing it — and the bar it
  // raises would flicker rather than being read. The next attempt is the
  // reader's: Retry, or the next thing they type.
  //
  // `edits` is listed without being read: each keystroke changes it, and the
  // re-run that causes clears the pending timer and starts a new one. That
  // restart is the pause. Without it the save would fire a fixed time after
  // the first keystroke, in the middle of whatever is being typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `edits` restarts the autosave timer on every keystroke
  useEffect(() => {
    if (!dirty || saving || saveError) {
      return
    }
    const timer = setTimeout(() => void saveRef.current(), AUTOSAVE_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [dirty, edits, saving, saveError])

  // The preview follows the draft, but not at the pace of the save. Bumping it
  // where the save happens would reload the pane about once a second while
  // somebody is typing. It waits for a longer quiet instead.
  //
  // Keyed on the record's own revision rather than on the save, so it covers
  // every path that moves the draft. The acts that are not typing — creating,
  // renaming or deleting a file — refresh the frame themselves and record what
  // they refreshed it for, so this does not follow them with a second reload.
  //
  // That revision is a CONTENT-ADDRESSED token, so it returns to an earlier
  // value when the draft returns to an earlier state — edit a file and put it
  // back and the token reads D0, D1, D0. That looks like it would strand the
  // preview on the edited render, and it does not: this compares against the
  // state last PREVIEWED, not against the first one seen, so each of those
  // three differs from the one before it and the revert reloads like any other
  // change. Comparing against the opening value is what would break, which is
  // the version to not "simplify" this into.
  const previewedAt = useRef<string | undefined>(undefined)
  const draftAt = record?.state
  useEffect(() => {
    if (draftAt === undefined) {
      return
    }
    // The first record is what the frame already mounted with. Treating it as a
    // change would reload the preview a couple of seconds after every open,
    // for nothing.
    if (previewedAt.current === undefined) {
      previewedAt.current = draftAt
      return
    }
    if (previewedAt.current === draftAt) {
      return
    }
    const timer = setTimeout(() => {
      previewedAt.current = draftAt
      setPreviewNonce((n) => n + 1)
    }, PREVIEW_REFRESH_QUIET_MS)
    return () => clearTimeout(timer)
  }, [draftAt])

  // Ctrl+S works, and it is not the route to saving — that happens on its
  // own. It is the reflex thirty years of editors trained, and a page that
  // ignores it, or lets the browser answer it with its own save-page dialog,
  // reads as broken. Here it means "now, rather than after the pause".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        if (!saving) {
          void saveRef.current()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saving])

  const doPublish = useCallback(async () => {
    if (!record) {
      return
    }
    // The press that follows a warning IS the decision, so it does not re-run
    // the check that produced it and stop on the same failures again.
    const overriding = publish === 'warned'
    setPublish('busy')
    // A fresh attempt supersedes the last one's report, so the panel a previous
    // press produced does not sit above the one this press is about to.
    setPublishError(null)
    try {
      const fresh = await invoke<ComponentRecord | null>('components.get', { projectId, name: componentName })
      if (!fresh) {
        throw new Error(`Component "${componentName}" no longer exists.`)
      }
      const now = publishBaseOf(fresh)
      // No base means the opening read never completed, so nothing here was
      // built on anything, and that is treated as moved: the panel appears.
      // Erring towards a question is the safe direction; erring towards
      // agreement is how a publish goes missing.
      if (!base || movedSince(base, now)) {
        setStaleness({
          publishedVersion: now.version,
          baseVersion: base?.version ?? 0,
          publishedAt: fresh.publishedAt ? new Date(fresh.publishedAt).toLocaleString() : 'an unknown time',
          // Passed straight through, absent and all: the panel decides what a
          // missing author reads as, and it is the only place that should.
          publishedBy: fresh.publishedBy?.name,
        })
        setPublish('idle')
        return
      }
      // What the last save's check found, read from the server rather than from
      // this editor's own state: the save may have been hours, a reload or
      // somebody else ago, and the panel it drew is long gone while the
      // failures are not. It warns and never refuses — publishing while a check
      // is failing is a choice, and it is made here, with the failures on
      // screen, instead of being silently allowed or silently blocked.
      if (!overriding) {
        const last = await invoke<LastValidation | null>('validation.last', { projectId, component: componentName })
        if (last && !last.ok) {
          applyValidation({ targets: last.failed }, 'publishing')
          setPublish('warned')
          return
        }
      }
      // An App action, so the host names the signed-in person as the caller
      // and the publish is committed under their name.
      const res = await callAppAction<{ published: boolean; version: number; lastValidation?: LastValidation }>(
        projectId,
        'publishComponent',
        {
          name: componentName,
          expectedVersion: base.version,
        },
      )
      if (res.published) {
        setPublish('done')
        // Publishing settles everything the reload left outstanding: what was
        // yours is now what is published, so there is nothing left to copy
        // across and no file left to mark.
        setKeptPaths(new Set<string>())
        setPreviewNonce((n) => n + 1)
        // The publish says what it shipped, so an overridden one leaves its
        // failures on screen in the past tense rather than clearing them: the
        // report has to outlive the moment it could still have been acted on.
        if (res.lastValidation && !res.lastValidation.ok) {
          applyValidation({ targets: res.lastValidation.failed }, 'published')
        }
      } else {
        setPublish('idle')
        toast.info?.('Nothing to publish — the draft is what is already published.')
      }
      // This editor's own publish settled, so whatever is published now is what
      // the next round of typing builds on.
      await load({ rebase: true })
    } catch (e) {
      setPublish('idle')
      // A panel rather than a toast. This is the one failure here that nothing
      // refused — no check turned the work down and nobody got in ahead of it,
      // the act simply did not finish — and the system's own message is what
      // whoever hears about it next will ask for. A toast takes that away on a
      // timer, which would leave the failure effectively silent.
      //
      // `base?.version` is what an installer still gets: the publish did not
      // happen, so the version this draft was built on is still the published
      // one. It is absent when the opening read never completed and 0 when
      // nothing has been published, and in both the panel's sentence ends
      // rather than naming a version an installer cannot get.
      setPublishError({ message: String(e), publishedVersion: base?.version })
      load().catch(() => {})
    }
  }, [record, base, projectId, componentName, publish, applyValidation, load])

  // A press only queues; this carries it through once the draft holds what is
  // on screen. It runs on every commit that changes one of its inputs, so a
  // save landing, failing or being followed by more typing each move it on.
  // `saveRef` is current here: the effect that refreshes it is declared above
  // this one, and effects run in declaration order.
  useEffect(() => {
    if (!publishQueued) {
      return
    }
    const step = nextPublishStep({ saving, saveFailed: saveError !== null, dirty })
    if (step === 'wait') {
      return
    }
    if (step === 'save') {
      void saveRef.current()
      return
    }
    setPublishQueued(false)
    if (step === 'publish') {
      void doPublish()
    }
  }, [publishQueued, saving, saveError, dirty, doPublish])

  const requestPublish = useCallback(() => {
    if (publish !== 'busy' && !discarding) {
      setPublishQueued(true)
    }
  }, [publish, discarding])

  const reloadLatest = useCallback(async () => {
    // Keeps `edits` as they are: files you had changed stay marked as changed
    // against the newer base — the buffer is kept, nothing is merged. It IS a
    // re-base, and the only one a person asks for by name: pressing it accepts
    // the newer published version as the one the draft now sits on, which is
    // what stops the panel returning on the next press.
    // Taken BEFORE the re-base, because the re-base is what makes it
    // unrecoverable: afterwards the draft is measured against the newer
    // published version, and the files you changed become indistinguishable
    // from the files somebody else changed. This is the last moment the
    // difference exists to be recorded.
    //
    // It is the best available answer rather than an exact one. The set is
    // whatever the last read of the record computed, and a save landing
    // between their publish and this press re-reads it against THEIR version,
    // which widens the set to include files only they touched. The error is
    // over-marking — being asked to look at a file that turns out to need
    // nothing — which is the safe direction. An exact answer would need the
    // server to compare a draft against a named older version, and it only
    // ever compares against the current one.
    setKeptPaths(new Set(record?.draftFilesChanged ?? []))
    setStaleness(null)
    setLoading(true)
    try {
      await load({ rebase: true })
    } finally {
      setLoading(false)
    }
  }, [load, record])

  const requestExit = useCallback(() => {
    // Only a failure is worth asking about. A save that has simply not fired
    // yet is flushed on the way out — there is nothing to decide, and leaving
    // waits for the write rather than racing it.
    if (saveError) {
      setGuardOpen(true)
      return
    }
    if (dirty) {
      void saveRef.current().then((ok) => {
        if (ok) {
          onExit()
        }
      })
      return
    }
    onExit()
  }, [saveError, dirty, onExit])

  const mutateFiles = useCallback(
    async (action: string, params: Record<string, unknown>, after?: (rec: ComponentRecord | null) => void) => {
      try {
        await invoke(action, { projectId, component: componentName, expectedState: record?.state, ...params })
        setPublish('idle')
        setPreviewNonce((n) => n + 1)
        const rec = await load()
        // Refreshed already, and for this revision — so the quiet-period
        // refresh does not follow a rename or a delete with a second reload.
        previewedAt.current = rec?.state
        after?.(rec)
      } catch (e) {
        toast.error(`${action} failed: ${String(e)}`)
        load().catch(() => {})
      }
    },
    [projectId, componentName, record, load],
  )

  // Throwing the draft away, once the dialog has been answered. It does not go
  // through `mutateFiles`: that one asserts a draft exists afterwards, which is
  // the opposite of what this leaves behind.
  //
  // The buffers go too, and they have to. They are edits typed over files that
  // no longer hold what they were typed over, so keeping them would put the
  // discarded work straight back at the next autosave — the user would press
  // Discard and watch the draft return.
  const doDiscard = useCallback(async () => {
    setDiscardOpen(false)
    setDiscarding(true)
    try {
      await invoke('components.discard', { projectId, name: componentName })
      setEdits({})
      setSaveError(null)
      setValidation(null)
      setPublishError(null)
      setStaleness(null)
      setPublish('idle')
      setPreviewNonce((n) => n + 1)
      const rec = await load({ rebase: true })
      previewedAt.current = rec?.state
    } catch (e) {
      toast.error(`Discard failed: ${String(e)}`)
      load().catch(() => {})
    } finally {
      setDiscarding(false)
    }
  }, [projectId, componentName, load])

  // A draft is the set of files that changed since the last published version,
  // so the marker follows that and not the buffer. Marking unsaved edits
  // instead would clear the marker on save, which is the exact moment the work
  // becomes unpublished: the editor would say "nothing here" about a file it
  // had just made different from what anyone can install.
  //
  // A file edited and then edited back carries no marker, and that is right
  // rather than a gap: measured against the published version it has not
  // changed. The header can still report unpublished work at the same time,
  // because a publish would spend a version either way — two true answers to
  // two different questions, and neither is a correction of the other.
  const draftChangedPaths = useMemo(() => new Set(record?.draftFilesChanged ?? []), [record])

  // Derived from the record, like the markers above it, and deliberately NOT
  // held as state.
  //
  // As state set optimistically by every write, it would never be re-derived
  // from the reload that follows. Putting a file back is also a save, so a
  // component that had come back to exactly what is published would go on
  // offering Discard and Publish until the page was reloaded — while the file
  // markers and the changed-file count, which derive from the record, cleared
  // correctly, and the same screen said "no files changed" and "draft ahead"
  // at once.
  //
  // The prop covers the first render only, before the opening read lands.
  const draftAhead = record ? record.draft !== undefined : draft !== undefined

  // The version a discard returns to, or null when there is none to return to.
  // Read off the record instead of defaulted: a component that has never been
  // published holds no version here, and putting a number in its place would
  // offer the act and then tell someone their files would go back to a version
  // that does not exist. The control's availability and the
  // confirmation's sentence both come from this one value, so there is no state
  // in which one of them believes in a version the other does not.
  const discardTarget = record?.version ?? null

  // `kept` is a subset of changed rather than a second, parallel fact: a file
  // you had changed and have since brought back into line with the published
  // version has nothing left to reconcile, so it stops being marked without
  // anything having to clear it. One set to maintain, not two to keep in step.
  const rows: EditorFileRow[] = files.map((f) => ({
    path: fileKey(f),
    dirty: draftChangedPaths.has(fileKey(f)),
    kept: keptPaths.has(fileKey(f)) && draftChangedPaths.has(fileKey(f)),
    failed: failedFiles.has(fileKey(f)),
  }))

  const activeFile = files.find((f) => fileKey(f) === activePath)
  const activeText = activeFile ? (edits[activePath] ?? activeFile.content) : ''

  const filesPane = (
    <SourceEditorFiles
      files={rows}
      activePath={activePath}
      loading={loading}
      onSelect={(p) => {
        setActivePath(p)
        setTab('code')
      }}
      creating={creating}
      onNewFile={() => setCreating(true)}
      onCancelCreate={() => setCreating(false)}
      onCreate={(path) => {
        setCreating(false)
        mutateFiles(
          'files.write',
          { files: [{ path, target: path, type: typeForNewPath(path), content: '' }], validate: false },
          () => setActivePath(path),
        )
      }}
      renamingPath={renamingPath}
      onRenameStart={setRenamingPath}
      onCancelRename={() => setRenamingPath(undefined)}
      onRename={(from, to) => {
        setRenamingPath(undefined)
        mutateFiles('files.move', { moves: [{ from, to }] }, () => {
          // The buffer follows the file, and only once the rename actually
          // happened: moving it eagerly would orphan the delta the other way
          // if the move were refused. Without this, an unsaved buffer keyed by
          // the old path stops matching any file and vanishes silently — the
          // exact loss the guard exists to prevent, minus the guard.
          setEdits((cur) => {
            if (cur[from] === undefined) {
              return cur
            }
            const next = { ...cur, [to]: cur[from] }
            delete next[from]
            return next
          })
          setActivePath((cur) => (cur === from ? to : cur))
        })
      }}
      pendingDeletePath={pendingDeletePath}
      onDeleteStart={setPendingDeletePath}
      onDeleteCancel={() => setPendingDeletePath(undefined)}
      onDeleteConfirm={(path) => {
        setPendingDeletePath(undefined)
        setEdits((cur) => {
          const next = { ...cur }
          delete next[path]
          return next
        })
        mutateFiles('files.delete', { paths: [path] }, (rec) =>
          setActivePath((cur) => {
            if (cur !== path) {
              return cur
            }
            const remaining = rec?.files ?? []
            const first = remaining.find((f) => !fileKey(f).startsWith('docs/')) ?? remaining[0]
            return first ? fileKey(first) : ''
          }),
        )
      }}
    />
  )

  const codePane = (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='flex shrink-0 items-center gap-2 border-b px-2 py-1.5'>
        {activePath ? (
          <MiddleTruncate text={activePath} tailChars={16} className='min-w-0 flex-1 text-xs text-muted-foreground' />
        ) : (
          <span className='min-w-0 flex-1 truncate text-xs text-muted-foreground'>No file open</span>
        )}
        {/* The `!` on the container variants below is load-bearing. This
            extension ships its own stylesheet, and the host's loads after it
            and redefines the base display utilities — so `@[720px]:inline-flex`
            loses to `hidden` on source order, at every width, without it. */}
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='hidden size-6 shrink-0 @[720px]:inline-flex!'
          aria-label={previewOpen ? 'Hide the preview' : 'Show the preview'}
          title={previewOpen ? 'Hide the preview' : 'Show the preview'}
          onClick={() => setPreviewOpen((o) => !o)}
        >
          {previewOpen ? <PanelRightClose className='size-3.5' /> : <PanelRight className='size-3.5' />}
        </Button>
      </div>

      <div className='min-h-0 flex-1 overflow-auto'>
        {activeFile ? (
          <MonacoCodeEditor
            path={activePath}
            value={activeText}
            onChange={(v) => setEdits((cur) => ({ ...cur, [activePath]: v }))}
          />
        ) : (
          <p className='p-6 text-center text-xs text-muted-foreground'>Choose a file to edit it.</p>
        )}
      </div>
    </div>
  )

  const previewPane = (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='flex shrink-0 items-center gap-2 border-b px-2 py-1.5'>
        <span className='min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground'>Preview</span>
        {/* Said, not assumed: this renders the DRAFT — the component's own
            page keeps showing what everyone else can install. */}
        <span className='shrink-0 rounded-full border px-1.5 text-xs text-muted-foreground'>draft</span>
      </div>
      <div className='min-h-0 flex-1 overflow-auto p-2'>
        <iframe
          key={previewNonce}
          title={`${componentName} draft preview`}
          src={standalonePreviewUrl(projectId, componentName, dark)}
          className='h-full w-full border-0 bg-background'
        />
      </div>
    </div>
  )

  return (
    <div className='@container relative flex h-full min-h-0 w-full flex-col overflow-hidden'>
      {/* No version is invented here: a component never published reads as
          that, and the header says so in words. Before the opening read lands,
          a draft reported on entry is the only version known. */}
      <SourceEditorHeader
        componentName={componentName}
        version={record ? (record.version ?? null) : typeof draft === 'number' ? draft : null}
        draftAhead={draftAhead}
        discardTarget={discardTarget}
        dirtyCount={draftChangedPaths.size}
        // A queued press reads as publishing: from where the reader sits it
        // has started, and the button must not look pressable a second time.
        publish={publishQueued ? 'busy' : publish}
        discarding={discarding}
        onBack={requestExit}
        onPublish={requestPublish}
        onDiscard={() => {
          if (!saving && publish !== 'busy' && !publishQueued && !discarding) {
            setDiscardOpen(true)
          }
        }}
      />

      {/* Wide: three panes, two drag handles. The panel group lays its own
          children out horizontally, so the wrapper only has to become visible —
          `block`, not `flex`, which would give the group a second parent doing
          the same job. The `!` is the same load-bearing flag as above. */}
      <div className='hidden min-h-0 flex-1 @[720px]:block!'>
        <ResizablePanelGroup orientation='horizontal'>
          {/* Two units, on purpose, and each carries its unit as a string.
              `defaultSize` is proportional, because how the room is shared is a
              proportion. `minSize` is absolute, because a minimum exists to stop
              a pane becoming useless and useless is an absolute condition — room
              for a filename, room for a line of code. A percentage floor shrinks
              exactly when space is tightest, which is backwards.

              The unit has to be written because the package reads a BARE NUMBER
              AS PIXELS, and the opening layout cannot tell a wrong unit from a
              right one: the defaults sum to 100 and are normalised to fill the
              group either way, so only a drag ever shows it. */}
          <ResizablePanel id='files' defaultSize='22%' minSize='150px'>
            {filesPane}
          </ResizablePanel>
          <ResizableHandle withHandle />
          {/* 300 rather than a rounder number: at 720px — the width where this
              arrangement begins — the code pane's own default is about 346px,
              and a floor above its own default would have the two fighting on
              the narrowest screen this layout exists on. */}
          <ResizablePanel id='code' defaultSize={previewOpen ? '48%' : '78%'} minSize='300px'>
            {codePane}
          </ResizablePanel>
          {previewOpen ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id='preview' defaultSize='30%' minSize='150px'>
                {previewPane}
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>

      {/* Narrow: one pane at a time — a different arrangement, not a squeeze. */}
      <div className='flex min-h-0 flex-1 flex-col @[720px]:hidden!'>
        <PanelTabStrip
          tabs={[
            { id: 'files', label: 'Files', icon: List },
            { id: 'code', label: 'Code', icon: Code, count: draftChangedPaths.size },
            { id: 'preview', label: 'Preview', icon: Eye },
          ]}
          activeId={tab}
          onSelect={(id) => setTab(id as typeof tab)}
        />
        <div className='min-h-0 flex-1'>{tab === 'files' ? filesPane : tab === 'preview' ? previewPane : codePane}</div>
      </div>

      {/* The whole width, along the bottom, under every pane rather than
          inside the code one. What these report is about the component, not
          about the file that happens to be open: the only one of them that
          names a file sends the reader INTO the code pane, rather than
          belonging to it. Inside that pane they would also be hidden at narrow
          widths, where it sits behind a tab — so a report placed there would be
          out of sight on exactly the screens where a reader is least likely to go
          looking for it. Here they are on every arrangement at once, and they
          take no height from the panes until there is something to say.

          The three still stack rather than merge: a check that failed, a
          component that moved underneath the editor and a publish that never
          finished are different events with different recoveries — and only the
          middle one is a refusal, since a failed check warns and lets the
          publish through while a failure refuses nothing at all. One panel with
          three moods would make a reader work out which of them they are
          looking at. */}
      {publishError || staleness || validation ? (
        <div className='shrink-0 space-y-2 border-t p-2'>
          {/* Newest first. The other two describe a state the work is in and go
              on describing it; a publish that failed is an act that just
              happened, and putting the report of it below standing panels is
              how a failure goes unnoticed. */}
          {publishError ? (
            <SourceEditorPublishError
              {...publishError}
              onRetry={requestPublish}
              onDismiss={() => setPublishError(null)}
            />
          ) : null}
          {staleness ? (
            <SourceEditorStaleness {...staleness} onReloadLatest={reloadLatest} onDismiss={() => setStaleness(null)} />
          ) : null}
          {validation ? (
            <SourceEditorValidation
              results={validation}
              moment={validationMoment}
              onOpenFile={(p) => {
                setActivePath(p)
                setTab('code')
              }}
              onDismiss={() => setValidation(null)}
            />
          ) : null}
        </div>
      ) : null}

      {/* Last, against the bottom edge, and below the panels above it: those
          report on the work — a check, a move, a publish — and this reports
          that what you typed is not stored anywhere, which is a different
          subject rather than a louder one. Below them it also stays put when
          they appear: a band that arrives above this one takes its height from
          the panes, where the same band arriving below would push a standing
          alert upward every time. It takes no height from the editing until
          there is something to say. */}
      {saveError ? (
        <div
          role='alert'
          className='flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-destructive/40 bg-destructive/10 px-3 py-2'
        >
          {/* Not the triangle, the circle or the cross: this editor already
              spends those on a check that warned, a file a failure came from
              and a publish that did not finish. */}
          <SaveOff aria-hidden='true' className='size-4 shrink-0 text-destructive' />
          <p className='min-w-0 flex-1 text-xs break-words text-destructive'>
            <span className='font-medium'>Not saved.</span> {saveError}
          </p>
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='shrink-0'
            disabled={saving}
            onClick={() => {
              if (!saving) {
                void saveRef.current()
              }
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {/* The count here is the buffer, not the draft: this prompt is about work
          a failed save left in the tab, which is exactly what the buffer holds
          when the write did not land. */}
      <SourceEditorDiscard
        version={discardOpen ? discardTarget : null}
        onCancel={() => setDiscardOpen(false)}
        onDiscard={() => void doDiscard()}
      />

      <SourceEditorGuard
        open={guardOpen}
        dirtyCount={dirtyPaths.length}
        onStay={() => setGuardOpen(false)}
        onDiscard={() => {
          setGuardOpen(false)
          onExit()
        }}
      />
    </div>
  )
}
