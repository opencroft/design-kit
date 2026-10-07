import type { ModuleResolver } from './declared-deps'
import { type EvalCore, exportedValueNames, parseImports } from './eval-core'
import type { PoolGroup } from './protocol'

// Shared between the browser preview frame (entry.tsx) and the server-side
// validator (server/validate.ts) — both must evaluate a project's pool with
// the IDENTICAL ordering/fixpoint logic, or the server harness would be
// checking a different algorithm than the one real previews run, making it
// useless as a regression net.

export interface ProjectExports {
  exports: Record<string, unknown>
  // Errors/unresolved imports from sibling file-groups (e.g. dropdown-menu.tsx)
  // that still produced SOME exports — the group didn't throw overall, but may
  // be exactly why a consumer crashes at render (a component internally
  // referencing an unresolved sibling import). The top-level unresolved-import
  // tracking never sees this: it only looks at the previewed file's own
  // imports, not what its dependencies failed to resolve internally.
  diagnostics: string[]
}

// Evaluation captures resolved names BY VALUE into a group's closures: a group
// evaluated before one of its dependencies keeps the dependency's
// previous-pass closure (whose own imports may still have been undefined) even
// after a later pass redefines it — the count-based fixpoint below never sees
// that, so an A → B → C chain with A ordered before B renders C as undefined
// (React error #130) with zero unresolved-import diagnostics. Ordering groups
// so dependencies evaluate first makes the final pass's captures correct;
// cyclic groups keep their input order and rely on the fixpoint.
export function sortGroupsByDependency(sources: readonly PoolGroup[]): PoolGroup[] {
  const infos = sources.map((group, i) => {
    const all = group.files.join('\n')
    return { i, group, exports: exportedValueNames(all), needs: parseImports(all).flatMap((imp) => imp.bindings.map((b) => b.local)) }
  })
  const provider = new Map<string, number>()
  for (const g of infos) {
    for (const name of g.exports) {
      if (!provider.has(name)) {
        provider.set(name, g.i)
      }
    }
  }
  const indegree = new Array<number>(infos.length).fill(0)
  const dependents = infos.map(() => new Set<number>())
  for (const g of infos) {
    for (const name of g.needs) {
      const p = provider.get(name)
      if (p !== undefined && p !== g.i && !dependents[p].has(g.i)) {
        dependents[p].add(g.i)
        indegree[g.i]++
      }
    }
  }
  const queue = infos.filter((g) => indegree[g.i] === 0).map((g) => g.i)
  const order: number[] = []
  while (queue.length > 0) {
    const i = queue.shift()!
    order.push(i)
    for (const j of dependents[i]) {
      if (--indegree[j] === 0) {
        queue.push(j)
      }
    }
  }
  if (order.length < infos.length) {
    const placed = new Set(order)
    for (const g of infos) {
      if (!placed.has(g.i)) {
        order.push(g.i)
      }
    }
  }
  return order.map((i) => infos[i].group)
}

// Evaluate every component's files into one shared export map, in dependency
// order (see sortGroupsByDependency). The fixpoint stays as the backstop for
// cyclic sibling references. Each group's imports resolve against its own
// declared dependencies, through `modulesFor`.
export function buildProjectExports(core: EvalCore, sources: readonly PoolGroup[], modulesFor: (dependencies: readonly string[]) => ModuleResolver): ProjectExports {
  const ordered = sortGroupsByDependency(sources).map((group) => ({ files: group.files, modules: modulesFor(group.dependencies) }))
  const globalExports: Record<string, unknown> = {}
  const resolve = (n: string) => globalExports[n]
  // Reset each pass rather than accumulate — a name unresolved in an early
  // pass commonly resolves once a later sibling group has run, so only the
  // LAST pass actually executed reflects genuinely unresolved state.
  let diagnostics: string[] = []
  let prevCount = -1
  for (let pass = 0; pass < 4; pass++) {
    diagnostics = []
    for (const { files, modules } of ordered) {
      if (files.length === 0) {
        continue
      }
      const { exports, error, unresolved } = core.evalComponentExports(files, resolve, modules)
      for (const [k, v] of Object.entries(exports)) {
        if (v !== undefined) {
          globalExports[k] = v
        }
      }
      if (error) {
        diagnostics.push(error)
      }
      diagnostics.push(...unresolved)
    }
    const count = Object.keys(globalExports).length
    if (count === prevCount) {
      break
    }
    prevCount = count
  }
  return { exports: globalExports, diagnostics }
}
