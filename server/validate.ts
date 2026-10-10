import * as React from 'react'
import { renderToString } from 'react-dom/server'

import { baseScope, builtinModules } from '../preview-runtime/base-scope'
import { moduleResolver, type NpmModule, npmModuleKey, undeclaredPackages } from '../preview-runtime/declared-deps'
import { createEvalCore, npmModules, parseImports } from '../preview-runtime/eval-core'
import { buildProjectExports } from '../preview-runtime/project-exports'
import type { PoolGroup } from '../preview-runtime/protocol'
import { unverifiableDepModule, unverifiableDepReason } from '../preview-runtime/unverifiable-dep'
import { coerceValue, type DocSegment, defaultProps, parseDoc, resolveSrc } from '../src/live/doc-parser'
import { CONTROL_KINDS, type DocCoverage, docCoverage, truncatedMessage, unknownControlKinds } from './doc-coverage'
import { loadDep } from './eval-loader'
import {
  type ComponentVerdict,
  DEPENDENCIES_TARGET,
  isRenderTarget,
  judge,
  RENDER_TARGET,
  SOURCE_TARGET,
  type TargetOutcome,
  type ValidateTarget,
} from './verdict'

export type { ComponentVerdict, TargetOutcome, ValidateTarget } from './verdict'

// Server-side counterpart to preview-runtime/entry.tsx: evaluates a
// component's preview pool through the SAME eval-core + buildProjectExports
// pipeline the browser preview frame runs, then renders each doc target with
// `react-dom/server` — so a design agent sees a syntax error, unresolved
// import, or render crash it just introduced, without opening the dashboard.
//
// Scope boundary: this validates evaluability, import resolution, and first
// render — not browser-only behaviour (pointer interactions, ResizeObserver-
// driven layout). Effects don't run under renderToString, so effect-guarded
// browser APIs (matchMedia, IntersectionObserver, …) are unverified here.
//
// The opposite direction is classified, not reported as a break: a component
// that touches a browser global DURING render is correct in the preview frame
// and simply cannot run here, so its target comes back `unverifiable`. A
// harness that calls correct code broken teaches its reader to skip the field,
// which costs more than it can ever save.

/**
 * Globals the preview iframe has and a `react-dom/server` render does not.
 * Reading one during render makes a target unverifiable here, not broken.
 */
const BROWSER_GLOBALS = new Set([
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'screen',
  'localStorage',
  'sessionStorage',
  'matchMedia',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'ResizeObserver',
  'IntersectionObserver',
  'MutationObserver',
  'DOMParser',
  'HTMLElement',
  'Element',
  'Image',
  'self',
])

// Evaluation failures arrive as strings (eval-core stringifies them before
// returning), so a message check is the only signal available on BOTH the eval
// and the render path — one classifier for both beats an `instanceof` that
// could only ever cover half the cases.
const NOT_DEFINED_RE = /^([A-Za-z_$][\w$]*) is not defined$/

function isBrowserOnly(message: string): boolean {
  const m = NOT_DEFINED_RE.exec(message)
  return m !== null && BROWSER_GLOBALS.has(m[1])
}

function outcomeOf(error: string | undefined): TargetOutcome {
  if (!error) {
    return 'ok'
  }
  return isBrowserOnly(error) ? 'unverifiable' : 'error'
}

export interface ValidateComponentResult {
  component: string
  /**
   * `error` a target failed; `unverified` nothing rendered this component, so
   * the only thing established is that it evaluates; `ok` at least one render
   * completed and none failed. See ComponentVerdict.
   */
  verdict: ComponentVerdict
  /** One line carrying the whole answer, for a caller that reads nothing else. */
  summary: string
  /**
   * Errors and unresolved imports from the shared pool as a whole (see
   * buildProjectExports), carrying no attribution — an entry here may be this
   * component's own or a neighbour's. `summary` counts only the ones that
   * cannot be this component's; the rest are the `source` target's, reported
   * there by name.
   */
  poolDiagnostics: string[]
  targets: ValidateTarget[]
}

export interface ValidateStoredFile {
  path: string
  target: string
  type: string
  content: string
}

export interface ValidateStoredComponent {
  name: string
  type: string
  /** declared npm packages, `pkg` / `pkg@range` */
  dependencies?: string[]
  files: ValidateStoredFile[]
  /** @deprecated single-file form; still read for old records. */
  source?: string
}

export interface ValidateDeps {
  readComponents(projectId: string): Promise<ValidateStoredComponent[]>
  buildPreviewSources(projectId: string, component: string): Promise<PoolGroup[]>
  /** The component's own group within that pool — the files it contributes. */
  previewSourceFiles(component: ValidateStoredComponent): string[]
  bundleDep(module: NpmModule): Promise<string>
}

const fileKey = (f: ValidateStoredFile): string => f.target || f.path

// The doc files map a `docs/doc.mdx` orchestrator resolves its tag `src`
// attributes against — keyed by docs-relative path, mirroring
// src/registry/from-stored.ts's docFilesMap (client-side equivalent). Only
// the server-does-not-import-the-dashboard-bundle rule keeps these two copies
// apart.
function docFiles(files: ValidateStoredFile[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const f of files) {
    const key = fileKey(f)
    if (key.startsWith('docs/')) {
      map[key.slice('docs/'.length)] = f.content
    }
  }
  return map
}

// Why nothing rendered, in the author's own terms. Every way of reaching the
// end of the loop with no rendered target says so differently, and the
// difference is what tells an author whether to write a doc page or fix one.
function renderAbsenceReason(coverage: DocCoverage): string {
  if (coverage.state === 'absent') {
    return 'no docs/doc.mdx — nothing here renders this component, so only its evaluation was checked'
  }
  if (coverage.state === 'prose') {
    return 'docs/doc.mdx declares no <Preview>, <Example> or <Sheet> — nothing here renders this component'
  }
  return 'docs/doc.mdx produced no renderable target — see the doc.mdx target for why'
}

// Every render funnels through here, so the browser-only classification is
// applied in exactly one place rather than at each of the three call sites.
function renderTarget(target: string, unresolvedImports: string[], render: () => void): ValidateTarget {
  try {
    render()
    return { target, outcome: 'ok', unresolvedImports }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    const unverifiable = unverifiableDepReason(error)
    if (unverifiable) {
      return { target, outcome: 'unverifiable', error: unverifiable, unresolvedImports }
    }
    return { target, outcome: outcomeOf(error), error, unresolvedImports }
  }
}

export function createValidator(deps: ValidateDeps) {
  async function validateOne(projectId: string, comp: ValidateStoredComponent): Promise<ValidateComponentResult> {
    const docs = docFiles(comp.files)
    const mdx = docs['doc.mdx']

    // A missing doc.mdx means nothing to RENDER, never nothing to check: a
    // component is authored source-first and documented after, so that window
    // is exactly when the first syntax error gets written. The pool is built
    // and evaluated either way; only the render loop below is skipped.
    const sources = await deps.buildPreviewSources(projectId, comp.name)
    const dependencies = comp.dependencies ?? []
    // The docs' code resolves against this component's declarations too.
    const docCode = Object.entries(docs)
      .filter(([path]) => /\.[jt]sx?$/.test(path))
      .map(([, content]) => content)

    // Pre-warm every npm dependency the pool and the docs import — the module
    // resolvers below must be synchronous (mirrors entry.tsx's ensureDeps).
    const loadedModules = new Map<string, Record<string, unknown>>()
    await Promise.all(
      npmModules([...sources, { files: docCode, dependencies }]).map(async (module) => {
        const key = npmModuleKey(module)
        const { spec } = module
        try {
          loadedModules.set(key, await loadDep(await deps.bundleDep(module)))
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          if (isBrowserOnly(message)) {
            // Importable in the browser, not under react-dom/server — render
            // against a placeholder so a target that uses it reports
            // `unverifiable`, not an opaque undefined-element error.
            loadedModules.set(key, unverifiableDepModule('browser-global', spec))
          }
          // Otherwise left unresolved — surfaces as an unresolved import below, same as the frame.
        }
      }),
    )

    const modulesFor = (declared: readonly string[]) => moduleResolver(declared, builtinModules, loadedModules)
    const modules = modulesFor(dependencies)
    const core = createEvalCore({ React, baseScope })
    const projectExports = buildProjectExports(core, sources, modulesFor)
    const resolve = (n: string) => projectExports.exports[n]

    const targets: ValidateTarget[] = []

    // What an item imports is what it must declare: the declaration is what
    // an install adds to the consumer's package.json, and what the preview
    // loads at the declared version.
    const ownFiles = deps.previewSourceFiles(comp)
    const undeclared = undeclaredPackages(
      [...ownFiles, ...docCode].flatMap((src) => parseImports(src).map((imp) => imp.module)),
      dependencies,
    )
    if (undeclared.length > 0) {
      targets.push({
        target: DEPENDENCIES_TARGET,
        outcome: 'error',
        error: `imports ${undeclared.map((p) => `"${p}"`).join(', ')} without declaring ${undeclared.length === 1 ? 'it' : 'them'} in dependencies`,
        unresolvedImports: [],
      })
    }

    // This component's own files, evaluated against the finished pool. The
    // pool's own diagnostics are a flat list over every sibling group, in
    // which this component's failure is indistinguishable from a neighbour's;
    // re-evaluating its own group is what makes the result attributable — and
    // it is the only check a component with no docs and no targets would
    // otherwise get.
    if (ownFiles.length === 0) {
      targets.push({
        target: SOURCE_TARGET,
        outcome: 'unverifiable',
        error: 'no preview source files on this component',
        unresolvedImports: [],
      })
    } else {
      const own = core.evalComponentExports(ownFiles, resolve, modules)
      targets.push({
        target: SOURCE_TARGET,
        outcome: outcomeOf(own.error ?? undefined),
        error: own.error ?? undefined,
        unresolvedImports: own.unresolved,
      })
    }

    const segments = mdx ? parseDoc(mdx) : []

    // A document that produced no renderable target has none that can fail, so
    // without this a truncated page reads as a component with nothing to
    // render rather than as a broken one. Comparing what the source
    // declares against what parsing produced is the only way to see it: the
    // parser's recovery on a tag it cannot close is to read the remainder of
    // the file as prose and stop, which is silent by design and correct for the
    // dashboard, where showing what can be shown beats showing nothing.
    const coverage = docCoverage(mdx, segments.filter((s) => s.kind !== 'md').length)
    if (coverage.state === 'truncated') {
      targets.push({ target: 'doc.mdx', outcome: 'error', error: truncatedMessage(coverage), unresolvedImports: [] })
    }

    const previewSeg = segments.find((s): s is Extract<DocSegment, { kind: 'preview' }> => s.kind === 'preview')
    const previewCode = previewSeg ? resolveSrc(docs, previewSeg.src) : null
    const controls = previewSeg?.controls ?? []

    // The same vacuous green from the other side: an unrecognised kind is not a
    // value that can fail, because nothing compares it to anything. Value
    // coercion switches on one kind and lets the rest through, so the control
    // silently does nothing and the doc renders without it — so the output is
    // byte-identical either way.
    for (const bad of unknownControlKinds(controls)) {
      targets.push({
        target: `control:${bad.control}`,
        outcome: 'error',
        error: `unknown control kind "${bad.kind}" on control "${bad.control}" — permitted kinds are ${CONTROL_KINDS.join(', ')}`,
        unresolvedImports: [],
      })
    }

    // One shared instance resolved once per component, reused by both the
    // <Preview> target and every <Sheet> that sweeps it.
    let previewComp:
      | { value: React.ComponentType<Record<string, unknown>>; unresolved: string[] }
      | { error: string; unresolved: string[] }
      | null = null
    const resolvePreviewComp = (): typeof previewComp => {
      if (previewComp || previewCode == null) {
        return previewComp
      }
      const { value, error, unresolved } = core.evalDefaultExport(previewCode, resolve, modules)
      previewComp = error
        ? { error, unresolved }
        : typeof value === 'function'
          ? { value: value as React.ComponentType<Record<string, unknown>>, unresolved }
          : { error: 'preview.tsx must `export default` a component', unresolved }
      return previewComp
    }

    for (const seg of segments) {
      if (seg.kind === 'preview') {
        const code = resolveSrc(docs, seg.src)
        if (code == null) {
          targets.push({
            target: 'preview',
            outcome: 'error',
            error: `missing file: ${seg.src}`,
            unresolvedImports: [],
          })
          continue
        }
        const resolved = resolvePreviewComp()
        if (!resolved || 'error' in resolved) {
          const error = resolved?.error ?? 'unknown error'
          targets.push({
            target: 'preview',
            outcome: outcomeOf(error),
            error,
            unresolvedImports: resolved?.unresolved ?? [],
          })
          continue
        }
        targets.push(
          renderTarget('preview', resolved.unresolved, () =>
            renderToString(React.createElement(resolved.value, defaultProps(seg.controls))),
          ),
        )
      } else if (seg.kind === 'example') {
        const label = `example:${seg.src.replace(/^\.\//, '').replace(/^docs\//, '')}`
        const code = resolveSrc(docs, seg.src)
        if (code == null) {
          targets.push({ target: label, outcome: 'error', error: `missing file: ${seg.src}`, unresolvedImports: [] })
          continue
        }
        const { element, error, unresolved } = core.evaluateSnippet(code, resolve, modules)
        if (error) {
          targets.push({ target: label, outcome: outcomeOf(error), error, unresolvedImports: unresolved })
          continue
        }
        targets.push(renderTarget(label, unresolved, () => renderToString(element as React.ReactElement)))
      } else if (seg.kind === 'sheet') {
        const label = `sheet:${seg.prop}`
        const resolved = resolvePreviewComp()
        if (!resolved || 'error' in resolved) {
          const error = resolved?.error ?? 'sheet: no <Preview> in this doc supplies the component to sweep'
          targets.push({
            target: label,
            outcome: outcomeOf(error),
            error,
            unresolvedImports: resolved?.unresolved ?? [],
          })
          continue
        }
        const kind = controls.find((c) => c.name === seg.prop)?.kind
        const base = defaultProps(controls)
        // Classify on the raw message, then label the entry — the prefix would
        // otherwise hide the "<name> is not defined" shape from the classifier.
        let failure: { error: string; outcome: TargetOutcome } | undefined
        for (const raw of seg.values) {
          const props: Record<string, unknown> = { ...base }
          const swept = coerceValue(kind, raw)
          if (swept === undefined) {
            delete props[seg.prop]
          } else {
            props[seg.prop] = swept
          }
          const entry = renderTarget(label, resolved.unresolved, () =>
            renderToString(React.createElement(resolved.value, props)),
          )
          if (entry.error) {
            failure = {
              error: `entry "${raw === '' ? 'default' : String(raw)}": ${entry.error}`,
              outcome: entry.outcome,
            }
            break
          }
        }
        targets.push({
          target: label,
          outcome: failure?.outcome ?? 'ok',
          error: failure?.error,
          unresolvedImports: resolved.unresolved,
        })
      }
    }

    // "Nothing rendered this component" has to be IN the list rather than
    // absent from it: as an absence it would read as `1/1 targets checked`,
    // with the evaluation as the one target. It lands hardest exactly here — a
    // component with no doc page is the one nobody has previewed by hand
    // either, so the verdict is the only evidence anyone has about it.
    if (!targets.some((t) => isRenderTarget(t.target))) {
      targets.push({
        target: RENDER_TARGET,
        outcome: 'unverifiable',
        error: renderAbsenceReason(coverage),
        unresolvedImports: [],
      })
    }

    return {
      component: comp.name,
      ...judge(targets, projectExports.diagnostics),
      poolDiagnostics: projectExports.diagnostics,
      targets,
    }
  }

  async function validateComponent(
    projectId: string,
    name?: string,
  ): Promise<{ components: ValidateComponentResult[] }> {
    const all = await deps.readComponents(projectId)
    const targets = name ? all.filter((c) => c.name === name) : all
    if (name && targets.length === 0) {
      throw new Error(`Component "${name}" not found in this project.`)
    }
    const components: ValidateComponentResult[] = []
    for (const c of targets) {
      components.push(await validateOne(projectId, c))
    }
    return { components }
  }

  return { validateComponent }
}
