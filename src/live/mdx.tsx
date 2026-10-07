import { React } from '@ext/host'

import type { PreviewScope, RenderPayload } from '../../preview-runtime/protocol'
import type { PropRow } from '../registry'
import { cn } from 'cn'
import { LiveExample } from '../components/live-example'
import { Markdown } from '../components/markdown'
import { PreviewBlock } from '../components/preview-block'
import { PreviewFrame } from '../components/preview-frame'
import { PropsTable } from '../components/props-table'
import { coerceValue, type ControlSpec, defaultProps, docsRelative, type DocSegment, parseDoc, resolveSrc } from './doc-parser'

// ── The doc renderer ─────────────────────────────────────────────────
// A single, self-contained module: everything needed to turn a
// component's `docs/doc.mdx` into the rendered page lives here — the JSX
// `DocView` walker. The parser itself lives in ./doc-parser (shared with the
// server-side validator, which needs it but isn't a JSX context).
//
//   <Preview src="./preview.tsx" controls={[{ name, kind, options?, default }]} />
//   <Sheet prop="size" values={['sm','md','lg']} title?="…" />
//   <Example src="./examples/foo.tsx" title?="…" />

function controlsToRows(controls: ControlSpec[]): PropRow[] {
  return controls.map((c) => ({
    name: c.name,
    type: c.kind === 'enum' ? c.options.filter(Boolean).map((o) => `'${o}'`).join(' | ') || 'string' : c.kind === 'boolean' ? 'boolean' : 'string',
    default: c.kind === 'boolean' ? String(c.default) : c.default || undefined,
    description: c.description ?? '',
    control: c,
  }))
}

function initValues(controls: ControlSpec[]): Record<string, string | boolean> {
  const v: Record<string, string | boolean> = {}
  for (const c of controls) {
    v[c.name] = c.kind === 'boolean' ? Boolean(c.default) : String(c.default ?? '')
  }
  return v
}

function ErrorText({ msg }: { msg: string }) {
  return <div className='rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-center font-mono text-xs text-destructive'>{msg}</div>
}

// ── Interactive preview (controls-driven) ────────────────────────────

// Renders the preview file's `export default` component (inside the isolated
// frame), driven by the interactive props table. The user edits only the
// example code; the controls (kinds/options/defaults) come from the
// `<Preview controls={…}>` attribute.
function DocPreview({ code, controls, scope, projectId, component, target }: { code: string; controls: ControlSpec[]; scope: PreviewScope; projectId: string; component: string; target: string }) {
  const [current, setCurrent] = React.useState(code)
  const [values, setValues] = React.useState<Record<string, string | boolean>>(() => initValues(controls))
  React.useEffect(() => {
    setCurrent(code)
  }, [code])
  React.useEffect(() => {
    setValues(initValues(controls))
  }, [controls])

  const props = React.useMemo(() => {
    const out: Record<string, unknown> = {}
    for (const c of controls) {
      const v = coerceValue(c.kind, values[c.name])
      if (v !== undefined) {
        out[c.name] = v
      }
    }
    return out
  }, [controls, values])

  const rows = controlsToRows(controls)

  return (
    <div className='space-y-4'>
      <PreviewBlock
        code={current}
        onCodeChange={setCurrent}
        onReset={() => {
          setCurrent(code)
          setValues(initValues(controls))
        }}
        projectId={projectId}
        scope={scope}
        component={component}
        target={target}
        mode='default-export'
        previewProps={props}
        renderKey={`${current}::${JSON.stringify(values)}`}
      />
      {rows.length > 0 && <PropsTable rows={rows} values={values} onChange={(name, v) => setValues((p) => ({ ...p, [name]: v }))} />}
    </div>
  )
}

// ── Sheet (exhaustive state grid) ────────────────────────────────────

// Sweeps one prop across all `values`, rendering the PREVIEW component each time
// (so any children/composition in the example carry over), with the other props
// pinned to their control defaults. The grid itself renders inside the isolated
// frame — the cells are the design, not host chrome.
function DocSheet({ prop, values, title, previewCode, controls, scope, projectId }: { prop: string; values: unknown[]; title?: string; previewCode: string | null; controls: ControlSpec[]; scope: PreviewScope; projectId: string }) {
  const kind = controls.find((c) => c.name === prop)?.kind
  const payload = React.useMemo<RenderPayload | null>(() => {
    if (!previewCode) {
      return null
    }
    return {
      mode: 'sheet',
      ...scope,
      code: previewCode,
      sheet: {
        prop,
        entries: values.map((raw) => ({ label: raw === '' ? 'default' : String(raw), value: coerceValue(kind, raw) })),
        baseProps: defaultProps(controls),
      },
    }
  }, [previewCode, scope, prop, values, kind, controls])

  if (!payload) {
    return <ErrorText msg='sheet: no <Preview> in this doc supplies the component to sweep' />
  }

  return (
    <div className='space-y-2'>
      {title && <h3 className='text-sm font-medium'>{title}</h3>}
      <div className='overflow-hidden rounded-lg border bg-background'>
        <PreviewFrame payload={payload} projectId={projectId} minHeight={96} />
      </div>
    </div>
  )
}

function MissingFile({ src }: { src: string }) {
  return <ErrorText msg={`missing file: ${src}`} />
}

// ── The walker ───────────────────────────────────────────────────────

export function DocView({ mdx, files, scope, projectId, component }: { mdx: string; files: Record<string, string>; scope: PreviewScope; projectId: string; component: string }) {
  const segments = React.useMemo(() => {
    try {
      return parseDoc(mdx)
    } catch {
      return [{ kind: 'md', text: mdx }] as DocSegment[]
    }
  }, [mdx])

  // The first <Preview> supplies the component + controls that Sheets sweep.
  const previewSeg = segments.find((s): s is Extract<DocSegment, { kind: 'preview' }> => s.kind === 'preview')
  const previewCode = previewSeg ? resolveSrc(files, previewSeg.src) : null
  const controls = previewSeg?.controls ?? []

  return (
    <div className={cn('space-y-4')}>
      {segments.map((seg, i) => {
        if (seg.kind === 'md') {
          return <Markdown key={i} source={seg.text} />
        }
        if (seg.kind === 'preview') {
          const code = resolveSrc(files, seg.src)
          // Its OWN src, not the doc's first preview: a document may hold more
          // than one <Preview>, and Open has to name the block it sits on.
          return code == null ? <MissingFile key={i} src={seg.src} /> : <DocPreview key={i} code={code} controls={seg.controls} scope={scope} projectId={projectId} component={component} target={`preview:${docsRelative(seg.src)}`} />
        }
        if (seg.kind === 'sheet') {
          return <DocSheet key={i} prop={seg.prop} values={seg.values} title={seg.title} previewCode={previewCode} controls={controls} scope={scope} projectId={projectId} />
        }
        if (seg.kind === 'example') {
          const code = resolveSrc(files, seg.src)
          return code == null ? <MissingFile key={i} src={seg.src} /> : <LiveExample key={i} code={code} scope={scope} projectId={projectId} component={component} target={`example:${docsRelative(seg.src)}`} />
        }
        return null
      })}
    </div>
  )
}
