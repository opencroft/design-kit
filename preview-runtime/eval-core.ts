import { transform } from 'sucrase'

import { declaredRanges, type ModuleResolver, moduleSource, type NpmModule, npmModuleKey } from './declared-deps'
import type { PoolGroup } from './protocol'

// The eval engine that runs INSIDE the preview iframe. Host-free: no @opencroft/*
// imports — React and the base scope are injected by the caller (entry.tsx),
// so this module can be bundled for the isolated preview document.
//
// Model: sources are authored with real
// ESM imports; imports are stripped before eval and every imported symbol is
// supplied through scope. Resolution order per imported name:
//   1. the caller's resolver (sibling registry exports / explicit scope)
//   2. the module resolver for the evaluated item (its declared npm
//      dependencies, bundled on demand by the server, and the React family)
// The base scope adds only what the compiled code itself needs (`React`, for
// the JSX transform); it answers no import.

export interface ImportBinding {
  /** local identifier introduced into the file's scope */
  local: string
  /** what it binds in the source module: 'default', '*', or a named export */
  imported: string
}

export interface ModuleImport {
  module: string
  bindings: ImportBinding[]
}

// Anchored to line start, matching stripImports below: an `import …` that
// appears mid-line lives inside a string/template literal (e.g. a code SAMPLE
// rendered by a component), and collecting it would send a phantom module to
// the dependency loader.
const IMPORT_RE = /^[ \t]*import\s+(type\s+)?([^'";]+?)\s+from\s*['"]([^'"]+)['"]/gm
const BARE_IMPORT_RE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm

// Parse every ESM import into (module, bindings). Type-only entries are skipped
// — they never need a runtime value. A whole-clause `import type { … } from 'x'`
// carries NO runtime value at all, so the module is dropped entirely (it must
// not reach the dependency loader); inline `{ type A, B }` drops only `A`.
export function parseImports(source: string): ModuleImport[] {
  const byModule = new Map<string, ImportBinding[]>()
  const add = (module: string, binding?: ImportBinding) => {
    const list = byModule.get(module) ?? []
    if (binding && !list.some((b) => b.local === binding.local)) {
      list.push(binding)
    }
    byModule.set(module, list)
  }
  for (const m of source.matchAll(IMPORT_RE)) {
    if (m[1]) {
      // `import type …` — a type-only declaration; no runtime import at all.
      continue
    }
    const clause = m[2].trim()
    const module = m[3]
    const ns = clause.match(/\*\s+as\s+([A-Za-z0-9_$]+)/)
    if (ns) {
      add(module, { local: ns[1], imported: '*' })
    }
    const braced = clause.match(/\{([^}]*)\}/)
    if (braced) {
      for (const raw of braced[1].split(',')) {
        const part = raw.trim()
        if (!part || part.startsWith('type ')) {
          continue
        }
        const as = part.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/)
        if (as) {
          add(module, { local: as[2], imported: as[1] })
        } else if (/^[A-Za-z0-9_$]+$/.test(part)) {
          add(module, { local: part, imported: part })
        }
      }
    }
    const def = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/\*\s+as\s+[A-Za-z0-9_$]+/, '')
      .split(',')[0]
      .trim()
    if (def && /^[A-Za-z0-9_$]+$/.test(def)) {
      add(module, { local: def, imported: 'default' })
    }
  }
  for (const m of source.matchAll(BARE_IMPORT_RE)) {
    add(m[1])
  }
  return [...byModule.entries()].map(([module, bindings]) => ({ module, bindings }))
}

/**
 * The npm modules the groups import, each at the range its own group declares
 * (see moduleSource) — what has to be fetched before they can evaluate.
 */
export function npmModules(groups: readonly PoolGroup[]): NpmModule[] {
  const modules = new Map<string, NpmModule>()
  for (const group of groups) {
    const declared = declaredRanges(group.dependencies)
    for (const src of group.files) {
      for (const imp of parseImports(src)) {
        const source = moduleSource(imp.module, declared)
        if (source?.kind === 'npm') {
          modules.set(npmModuleKey(source), { spec: source.spec, range: source.range })
        }
      }
    }
  }
  return [...modules.values()]
}

// Drop ESM import statements (their symbols are supplied via scope).
export function stripImports(source: string): string {
  return source
    .replace(/^[ \t]*import\b[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*\r?\n?/gm, '')
    .replace(/^[ \t]*import\s*['"][^'"]+['"];?[ \t]*\r?\n?/gm, '')
}

// Drop a standalone `export { A, B, … }` / `export type { … }` statement in
// its entirety — the shadcn convention of declaring functions unexported and
// bulk-exporting them at the end of the file. Naive keyword-only stripping
// (as evalComponentExports does for single-line export forms) would leave a
// dangling `{ A, B, }` block: a trailing comma isn't legal there, so it's a
// syntax error, not just dead code. The names are already harvested by
// exportedValueNames, so the statement itself contributes nothing once
// removed.
function stripExportBlocks(source: string): string {
  return source.replace(/^[ \t]*export\s+(?:type\s+)?\{[^}]*\}\s*;?[ \t]*\r?\n?/gm, '')
}

// Turn a copy-pastable example (imports + `export default`) into a
// `render(<X/>)` module body the evaluator understands.
export function toRenderableSource(source: string): string {
  let code = stripImports(source)
  let name = 'Example'

  const namedFn = code.match(/export\s+default\s+function\s+([A-Za-z0-9_$]+)/)
  const anonFn = code.match(/export\s+default\s+function\s*\(/)

  if (namedFn) {
    name = namedFn[1]
    code = code.replace(/export\s+default\s+function/, 'function')
  } else if (anonFn) {
    code = code.replace(/export\s+default\s+function/, `function ${name}`)
  } else {
    const identifier = code.match(/export\s+default\s+([A-Za-z0-9_$]+)\s*;?/)
    if (identifier) {
      name = identifier[1]
      code = code.replace(/export\s+default\s+[A-Za-z0-9_$]+\s*;?/, '')
    } else {
      code = code.replace(/export\s+default\s+/, `const ${name} = `)
    }
  }

  return `${code}\nrender(<${name} />)`
}

// Value (not type) symbols a module exports — used to return all exports.
export function exportedValueNames(source: string): string[] {
  const names = new Set<string>()
  for (const m of source.matchAll(
    /^[ \t]*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    names.add(m[1])
  }
  for (const m of source.matchAll(/^[ \t]*export\s*\{([^}]*)\}(?!\s*from)/gm)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim()
      if (!part || part.startsWith('type ')) {
        continue
      }
      const as = part.match(/\bas\s+([A-Za-z0-9_$]+)/)
      const nm = as ? as[1] : part
      if (/^[A-Za-z0-9_$]+$/.test(nm)) {
        names.add(nm)
      }
    }
  }
  return [...names]
}

export type Resolver = (name: string) => unknown

export interface EvalCoreOptions {
  React: unknown
  /** Names every evaluated source gets without importing them. */
  baseScope: Record<string, unknown>
}

// Every entry point takes the module resolver of the item being evaluated:
// imports resolve against that item's own declarations, so two items of one
// pool may use two versions of the same package.
export interface EvalCore {
  evalComponentExports(
    source: string | string[],
    resolve?: Resolver,
    modules?: ModuleResolver,
  ): { exports: Record<string, unknown>; error: string | null; unresolved: string[] }
  evaluateSnippet(
    source: string,
    resolve?: Resolver,
    modules?: ModuleResolver,
  ): { element: unknown; error: string | null; unresolved: string[] }
  evalDefaultExport(
    source: string,
    resolve?: Resolver,
    modules?: ModuleResolver,
  ): { value: unknown; error: string | null; unresolved: string[] }
}

// A top-level `const`/`let`/`class` declaration cannot redeclare a `new
// Function` parameter of the same name (SyntaxError) — unlike `function`,
// which may shadow one. The files of one component are evaluated joined, so
// one file declaring `const Sheet = …` while another imports `Sheet` from it
// puts the name both in the scope and in the body, and the group fails to eval
// entirely. Scan the post-transform code for its own top-level declarations so
// those names can be excluded from injection and left to resolve via the
// body's own binding.
//
// Anchored to COLUMN 0 (no leading whitespace) so only genuinely top-level
// declarations match — group sources are joined standard-formatted files, so
// a real top-level `const` (every shadcn primitive included) sits at column
// 0, while anything indented is nested inside a function/block. Matching
// indented lines too would exclude a nested `const X = …` from injection even
// though X is still legally used as the INJECTED value at outer scope (e.g. a
// component using an imported `Check` in its top-level JSX while a handler
// buried inside it separately shadows `Check` with its own local `const`) —
// that's legal nested shadowing, not a collision, and must keep resolving to
// the injected value at the outer scope.
const TOP_LEVEL_DECL_RE = /^(?:export\s+)?(?:const|let|var|class|function\*?)\s+([A-Za-z_$][\w$]*)/gm

function declaredNames(code: string): Set<string> {
  const names = new Set<string>()
  for (const m of code.matchAll(TOP_LEVEL_DECL_RE)) {
    names.add(m[1])
  }
  return names
}

export function createEvalCore({ React, baseScope }: EvalCoreOptions): EvalCore {
  // Names `new Function` cannot take as parameters.
  const RESERVED =
    /^(default|let|const|var|class|function|return|import|export|new|this|typeof|in|of|if|else|for|while|do)$/

  function moduleValue(modules: ModuleResolver | undefined, module: string, imported: string): unknown {
    const exportsObj = modules?.(module)
    if (!exportsObj) {
      return undefined
    }
    if (imported === '*') {
      return exportsObj
    }
    if (imported === 'default') {
      // Interop: prefer the real default, fall back to the namespace (CJS).
      return exportsObj.default !== undefined ? exportsObj.default : exportsObj
    }
    return exportsObj[imported]
  }

  // Build the eval scope for a source. `unresolved` lists value imports that
  // resolved to nothing (no sibling export, no declared or built-in module) —
  // e.g. a shadcn primitive or cross-project component the frame wasn't given,
  // or a package the item does not declare.
  // Surfacing these by name turns an opaque React error #130 ("element type is
  // invalid") into an actionable message.
  function buildScope(
    source: string,
    resolve?: Resolver,
    modules?: ModuleResolver,
    extra?: Record<string, unknown>,
  ): { scope: Record<string, unknown>; unresolved: string[] } {
    const scope: Record<string, unknown> = { React, ...baseScope }
    const unresolved = new Set<string>()
    for (const imp of parseImports(source)) {
      // Relative imports are satisfied by file concatenation (multi-file
      // components eval together), not by this scope — so a missing value here
      // isn't a real miss and must not be reported.
      const isRelative = imp.module.startsWith('.')
      for (const b of imp.bindings) {
        if (RESERVED.test(b.local)) {
          continue
        }
        const own = resolve ? resolve(b.local) : undefined
        const v = own !== undefined ? own : moduleValue(modules, imp.module, b.imported)
        scope[b.local] = v
        if (v === undefined && !isRelative) {
          unresolved.add(`${b.local} (from '${imp.module}')`)
        }
      }
    }
    return { scope: { ...scope, ...(extra ?? {}) }, unresolved: [...unresolved] }
  }

  function run(code: string, scope: Record<string, unknown>): unknown {
    const declared = declaredNames(code)
    const keys = Object.keys(scope).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.test(k) && !declared.has(k))
    const fn = new Function(...keys, code)
    return fn(...keys.map((k) => scope[k]))
  }

  function evalComponentExports(
    source: string | string[],
    resolve?: Resolver,
    modules?: ModuleResolver,
  ): { exports: Record<string, unknown>; error: string | null; unresolved: string[] } {
    const sources = Array.isArray(source) ? source : [source]
    const all = sources.join('\n')
    const { scope, unresolved } = buildScope(all, resolve, modules)
    try {
      const body = sources.map((s) => stripImports(stripExportBlocks(s)).replace(/^[ \t]*export\s+/gm, '')).join('\n\n')
      const exportNames = exportedValueNames(all)
      // Guard each name: an `as`-aliased or otherwise-unhandled re-export in
      // exportNames may not correspond to a locally-declared identifier (e.g.
      // `export { Foo as Bar }` harvests "Bar", but only "Foo" is declared) —
      // referencing it directly would throw a ReferenceError and fail the
      // whole group. Missing pieces degrade to an undefined export instead.
      const ret = exportNames.length
        ? `\nreturn { ${exportNames.map((name) => `${name}: typeof ${name} === 'undefined' ? undefined : ${name}`).join(', ')} };`
        : '\nreturn {};'
      const { code } = transform(body + ret, { transforms: ['jsx', 'typescript'], production: true })
      return { exports: (run(code, scope) as Record<string, unknown>) ?? {}, error: null, unresolved }
    } catch (e) {
      return { exports: {}, error: e instanceof Error ? e.message : String(e), unresolved }
    }
  }

  function evaluateSnippet(
    source: string,
    resolve?: Resolver,
    modules?: ModuleResolver,
  ): { element: unknown; error: string | null; unresolved: string[] } {
    const { scope, unresolved } = buildScope(source, resolve, modules, { render: () => {} })
    try {
      const renderable = toRenderableSource(source)
      const { code } = transform(renderable, { transforms: ['jsx', 'typescript'], production: true })
      let captured: unknown = null
      scope.render = (el: unknown) => {
        captured = el
      }
      run(code, scope)
      return { element: captured, error: null, unresolved }
    } catch (e) {
      return { element: null, error: e instanceof Error ? e.message : String(e), unresolved }
    }
  }

  function evalDefaultExport(
    source: string,
    resolve?: Resolver,
    modules?: ModuleResolver,
  ): { value: unknown; error: string | null; unresolved: string[] } {
    const { scope, unresolved } = buildScope(source, resolve, modules)
    try {
      const body = stripImports(source).replace(/^[ \t]*export\s+default\s+/m, 'return ')
      const { code } = transform(body, { transforms: ['jsx', 'typescript'], production: true })
      return { value: run(code, scope), error: null, unresolved }
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : String(e), unresolved }
    }
  }

  return { evalComponentExports, evaluateSnippet, evalDefaultExport }
}
