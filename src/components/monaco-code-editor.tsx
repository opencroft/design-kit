import { React } from '@ext/host'
import { Editor, loader, type OnMount } from '@monaco-editor/react'

import { CodeBlockEditor } from '@opencroft/client'

// ── Where Monaco's runtime comes from. THIS IS THE SWITCH POINT. ──────────
//
// The loader fetches Monaco at run time rather than bundling it, so this one
// value decides where roughly sixteen megabytes come from and nothing else in
// the extension knows or cares. It is a public CDN today, which is what the
// host's own diff editor and the git extension already use — so this is not a
// new class of dependency for the product, and making it a local one here
// while leaving it remote there would be an inconsistency rather than a
// posture.
//
// To serve it from this origin instead, change this value and nothing else.
// The bytes have to be served first: this extension's route table takes exact
// keys, so a tree that size needs prefix serving before this line has anywhere
// to point.
//
// The call itself only records the setting — it opens no connection, so it is
// safe at module scope, and it has to run before anything calls `init`.
const MONACO_VS = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs'
loader.config({ paths: { vs: MONACO_VS } })

// Monaco infers a language from the model's URI, and every file here is named,
// so the only ones worth stating are those whose extension it would otherwise
// read as plain text.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  html: 'html',
}

/** Exported so the diff view shares this mapping rather than growing a second
 *  one that drifts from it. */
export function languageFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext'
}

// Always dark; the editor does not follow the dashboard's own light/dark.
export const MONACO_THEME = 'vs-dark'
const THEME = MONACO_THEME

const OPTIONS = {
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  lineNumbers: 'on' as const,
  folding: true,
  renderLineHighlight: 'line' as const,
  fontSize: 13,
  tabSize: 2,
  automaticLayout: true,
  scrollbar: { alwaysConsumeMouseWheel: false },
}

/** Whether Monaco's runtime arrived. `failed` is a real answer, not an error
 *  state to hide: the runtime comes over the network, and a pane that renders
 *  nothing because a CDN is unreachable is worse than a plainer editor. */
type LoadState = 'loading' | 'ready' | 'failed'

export interface MonacoCodeEditorProps {
  /** The file being edited. Monaco keeps a model per path, so switching files
   *  and coming back restores that file's own cursor and undo history. */
  path: string
  value: string
  onChange: (value: string) => void
}

export function MonacoCodeEditor({ path, value, onChange }: MonacoCodeEditorProps) {
  const [state, setState] = React.useState<LoadState>('loading')
  const editorRef = React.useRef<Parameters<OnMount>[0] | null>(null)

  React.useEffect(() => {
    let live = true
    loader
      .init()
      .then(() => {
        if (live) {
          setState('ready')
        }
      })
      .catch(() => {
        if (live) {
          setState('failed')
        }
      })
    return () => {
      live = false
    }
  }, [])

  // The text this editor last handed upwards. Monaco is left UNCONTROLLED on
  // purpose: it owns its own buffer, undo stack and cursor, and a value is
  // pushed into it only when the text changed somewhere other than in here —
  // a Reload latest, or the record arriving for a file that was open.
  //
  // Pushing on every prop change would mean `model.setValue` on every render
  // that carries a new string, and setValue resets the cursor — the editor
  // being told text it already has.
  const emitted = React.useRef(value)

  React.useEffect(() => {
    const ed = editorRef.current
    if (!ed || value === emitted.current) {
      return
    }
    const model = ed.getModel()
    if (!model || model.getValue() === value) {
      emitted.current = value
      return
    }
    // A genuine outside change. The cursor is put back where it was rather
    // than left wherever setValue drops it; the text under it may have moved,
    // but the end of the file is never a better guess than where they were.
    const position = ed.getPosition()
    model.setValue(value)
    if (position) {
      ed.setPosition(position)
    }
    emitted.current = value
  }, [value])

  const handleMount: OnMount = (ed, monaco) => {
    editorRef.current = ed
    emitted.current = ed.getModel()?.getValue() ?? value
    // Syntax errors are worth having; semantic ones are not. Nothing here has
    // the consuming project's type graph — no React types, no path aliases, no
    // sibling components — so every import in every file would be underlined
    // as missing. A wrong red squiggle on a correct line teaches people to
    // ignore the squiggles.
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    })
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    })
  }

  // Loading and failure both fall back to a plainer editor rather than to
  // nothing. It has no undo stack of its own, no find and no multiple cursors,
  // and it is a working editor, which is the whole distinction that matters
  // when the runtime cannot be fetched.
  if (state !== 'ready') {
    return <CodeBlockEditor value={value} onChange={onChange} language={languageFor(path)} minLines={24} />
  }

  return (
    <Editor
      height='100%'
      theme={THEME}
      path={path}
      defaultValue={value}
      defaultLanguage={languageFor(path)}
      options={OPTIONS}
      onMount={handleMount}
      onChange={(next) => {
        const text = next ?? ''
        emitted.current = text
        onChange(text)
      }}
    />
  )
}
