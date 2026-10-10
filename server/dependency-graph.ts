// The dependency graph of a component: what it stands on, with provenance,
// and what stands on it.
//
// This is the third reader of the reference vocabulary the walks in
// server/index.ts also traverse (collectNamespaces for install manifests,
// buildPreviewSources for the preview pool), kept separate so a graph consumer
// gets the one thing neither of those can afford to keep: the references that
// do NOT resolve. Both of those walks drop a broken reference silently —
// reasonable for their jobs (a pool cannot pool what does not exist), fatal
// for a graph whose whole point is to show a component's true footing. Here
// the unresolved case is not an edge case: every reference produces an edge,
// and a reference that resolves to nothing produces an edge into an
// `unresolved` node carrying the reason it did not.
//
// Edge tags are the four classes a reference can be:
//   declared — a registryDependencies entry resolving to a kit component
//   inferred — a path-alias import in the source naming a kit component the
//              declaration list does not cover
//   shadcn   — an external shadcn-registry item, whether declared as a bare
//              name or inferred from an import the shadcn registry answers for
//   npm      — a package named in `dependencies`
//
// An inferred import is resolved from its importer's point of view: a sibling
// in the importer's own project wins, then the shadcn registry, then the first
// match across every project — the order the preview pool applies for the
// project it is building. The pool's own skip-set is about pooling (a file
// only needs to be present once), not identity, which is why this module
// resolves per importer instead of borrowing that set. Reverse edges use the
// same resolver, so "depends on" and "used by" cannot disagree.

// Structural, like previewSourceFiles' parameter: the graph needs only what
// it reads, so callers are not tied to the full stored record. Everything
// else — the rule that names a project's namespace included — arrives
// injected, so the module tests without a host, the same way registry-shape
// does.
export interface GraphComponentSummary {
  name: string
  type: string
  title?: string
  category?: string
  dependencies?: string[]
  registryDependencies?: string[]
}

export interface DependencyGraphDeps {
  readProjects(): Promise<Array<{ id: string; name: string; slug?: string }>>
  /**
   * The namespace a project publishes under. Injected as the whole question
   * rather than as a slugify: a project's namespace is its stored slug, and
   * only a project without one is named by its display name. Given only
   * slugify, this module would answer with a name-derived namespace and call
   * the real one unknown.
   */
  namespaceOf(project: { id: string; name: string; slug?: string }): string
  readComponents(projectId: string): Promise<GraphComponentSummary[]>
  sourceFiles(component: GraphComponentSummary): string[]
  shadcnHas(name: string): Promise<boolean>
}

export type UnresolvedReason = 'unparsable-reference' | 'unknown-namespace' | 'missing-component' | 'unresolved-import'

export type GraphNode =
  | {
      id: string
      kind: 'component'
      projectId: string
      namespace: string
      name: string
      title?: string
      category?: string
      root?: true
    }
  | { id: string; kind: 'shadcn'; name: string }
  | { id: string; kind: 'npm'; name: string }
  | { id: string; kind: 'unresolved'; reference: string; reason: UnresolvedReason }

export type EdgeTag = 'declared' | 'inferred' | 'shadcn' | 'npm'

export interface GraphEdge {
  from: string
  to: string
  tag: EdgeTag
  /** The reference exactly as written: a registryDependencies entry, an npm
   *  package name, or the name an import specifier resolves by. */
  reference: string
  /** Present exactly when `to` is an unresolved node. */
  unresolved?: UnresolvedReason
}

export interface UnresolvedRef {
  from: string
  reference: string
  reason: UnresolvedReason
}

export interface DependencyGraph {
  root: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Every reference that resolved to nothing — also present as nodes and
   *  edges above; listed separately so "is anything broken?" is one read. */
  unresolved: UnresolvedRef[]
  /** Direct consumers of the root — "used by". Same edge shape, pointing at
   *  the root. */
  reverse: GraphEdge[]
}

/** The self-scope namespace. `@design-kit/<name>` names a sibling in whichever
 *  project declares it, so the same reference addresses a different project
 *  from each place it is written — which is why no project may mint it as its
 *  own namespace (reservedNamespaceReason below). The prefix ends at the `/`
 *  and every reader matches it whole, so a namespace that merely starts with
 *  these letters (say `design-kit-tokens`) is an ordinary cross-project scope. */
export const SELF_SCOPE_NS = 'design-kit'
export const SELF_SCOPE_PREFIX = `@${SELF_SCOPE_NS}/`

/** A kit reference from `registryDependencies`, or null when the entry is not
 *  one (bare shadcn names, and anything unparsable). Self-scope references
 *  resolve to the namespace of the project HOLDING them, so the caller passes
 *  the holder's namespace, never the graph root's. */
export function parseKitRef(dep: unknown, ownNs: string): { ns: string; name: string } | null {
  if (typeof dep !== 'string' || !dep.startsWith('@')) {
    return null
  }
  if (dep.startsWith(SELF_SCOPE_PREFIX)) {
    return { ns: ownNs, name: dep.slice(SELF_SCOPE_PREFIX.length) }
  }
  const [ns, ...rest] = dep.slice(1).split('/')
  return { ns, name: rest.join('/') }
}

/** Why `ns` cannot become a project's registry namespace — null when it can.
 *  Every surface that mints a namespace runs this; it lives beside the parser
 *  so the reserved set and the way references are read cannot drift apart. */
export function reservedNamespaceReason(ns: string): string | null {
  if (ns !== SELF_SCOPE_NS) {
    return null
  }
  return (
    `"${SELF_SCOPE_PREFIX}<name>" is the self-scope form of a registry dependency: it names a sibling in whichever project declares it, never a project called "${SELF_SCOPE_NS}". ` +
    `A project under this namespace can hold components, but no reference from any other project can reach them.`
  )
}

// The item name a `@/…` path alias resolves to — its last path segment.
// `@/components/ui/button` → button; `@/components/ui/layout/flex` → flex.
export function aliasImportNames(content: string): string[] {
  const re = /from\s*['"]@\/[^'"]*?([A-Za-z0-9-]+)['"]/g
  return Array.from(content.matchAll(re), (m) => m[1])
}

const BARE_NAME = /^[a-z0-9-]+$/

export function createDependencyGraphBuilder(deps: DependencyGraphDeps) {
  return async function buildDependencyGraph(projectId: string, componentName: string): Promise<DependencyGraph> {
    const projects = await deps.readProjects()
    const byProject = new Map<string, GraphComponentSummary[]>()
    for (const p of projects) {
      byProject.set(p.id, await deps.readComponents(p.id))
    }
    // Keyed on the namespace each project PUBLISHES under, not on its slugified
    // display name. This map decides both what a reference resolves to and what
    // gets reported as `unknown-namespace`, so keying it off a mutable name would
    // make the graph's own answer wrong in both directions at once for a renamed
    // project: the canonical spelling called unknown, and the stale one reported
    // as a real edge.
    const nsOf = new Map(projects.map((p) => [p.id, deps.namespaceOf(p)]))
    const projectByNs = new Map(projects.map((p) => [deps.namespaceOf(p), p.id]))

    // First match by bare name across every project — deliberately the same
    // rule the preview pool uses, so an inferred edge points where the pool
    // would actually have gone.
    const index = new Map<string, { projectId: string; comp: GraphComponentSummary }>()
    for (const p of projects) {
      for (const c of byProject.get(p.id) ?? []) {
        if (!index.has(c.name)) {
          index.set(c.name, { projectId: p.id, comp: c })
        }
      }
    }

    const rootComp = (byProject.get(projectId) ?? []).find((c) => c.name === componentName)
    if (!rootComp) {
      throw new Error(`Component "${componentName}" not found in this project.`)
    }

    const nodes = new Map<string, GraphNode>()
    const edges: GraphEdge[] = []
    const edgeSeen = new Set<string>()
    const unresolved: UnresolvedRef[] = []
    const shadcnCache = new Map<string, boolean>()

    const componentId = (pid: string, name: string) => `component:${pid}:${name}`

    const ensureComponent = (pid: string, comp: GraphComponentSummary): string => {
      const id = componentId(pid, comp.name)
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          kind: 'component',
          projectId: pid,
          namespace: nsOf.get(pid) ?? '',
          name: comp.name,
          title: comp.title,
          category: comp.category,
        })
      }
      return id
    }
    const ensureShadcn = (name: string): string => {
      const id = `shadcn:${name}`
      if (!nodes.has(id)) {
        nodes.set(id, { id, kind: 'shadcn', name })
      }
      return id
    }
    const ensureNpm = (name: string): string => {
      const id = `npm:${name}`
      if (!nodes.has(id)) {
        nodes.set(id, { id, kind: 'npm', name })
      }
      return id
    }
    // Identity is the NORMALIZED reference: two projects' self-scope
    // references to the same missing sibling name are different targets, so
    // they normalize to different ids and never share a node by accident.
    const ensureUnresolved = (identity: string, reference: string, reason: UnresolvedReason): string => {
      const id = `unresolved:${identity}`
      if (!nodes.has(id)) {
        nodes.set(id, { id, kind: 'unresolved', reference, reason })
      }
      return id
    }

    const addEdge = (edge: GraphEdge): void => {
      const key = JSON.stringify([edge.from, edge.to, edge.tag, edge.reference])
      if (edgeSeen.has(key)) {
        return
      }
      edgeSeen.add(key)
      edges.push(edge)
      if (edge.unresolved) {
        unresolved.push({ from: edge.from, reference: edge.reference, reason: edge.unresolved })
      }
    }

    const shadcnHas = async (name: string): Promise<boolean> => {
      const hit = shadcnCache.get(name)
      if (hit !== undefined) {
        return hit
      }
      const answer = await deps.shadcnHas(name)
      shadcnCache.set(name, answer)
      return answer
    }

    // Where an undeclared `@/…` import of `name` lands, seen from a component
    // of `importerProjectId`: own sibling, then the shadcn registry, then the
    // first match anywhere, then nowhere.
    const resolveImport = async (
      importerProjectId: string,
      name: string,
    ): Promise<
      | { kind: 'component'; projectId: string; comp: GraphComponentSummary }
      | { kind: 'shadcn' }
      | { kind: 'unresolved' }
    > => {
      const sibling = (byProject.get(importerProjectId) ?? []).find((c) => c.name === name)
      if (sibling) {
        return { kind: 'component', projectId: importerProjectId, comp: sibling }
      }
      if (await shadcnHas(name)) {
        return { kind: 'shadcn' }
      }
      const hit = index.get(name)
      if (hit) {
        return { kind: 'component', projectId: hit.projectId, comp: hit.comp }
      }
      return { kind: 'unresolved' }
    }

    // References of one component: every declared entry, every npm package,
    // every undeclared alias import — each becomes exactly one edge. Returns
    // the kit components to walk next.
    const referencesOf = async (
      pid: string,
      comp: GraphComponentSummary,
    ): Promise<Array<{ projectId: string; comp: GraphComponentSummary }>> => {
      const from = ensureComponent(pid, comp)
      const ns = nsOf.get(pid) ?? ''
      const next: Array<{ projectId: string; comp: GraphComponentSummary }> = []
      const coveredNames = new Set<string>()

      for (const dep of comp.registryDependencies ?? []) {
        const parsed = parseKitRef(dep, ns)
        if (parsed) {
          coveredNames.add(parsed.name)
          const targetPid = projectByNs.get(parsed.ns)
          if (targetPid === undefined) {
            addEdge({
              from,
              to: ensureUnresolved(`@${parsed.ns}/${parsed.name}`, dep, 'unknown-namespace'),
              tag: 'declared',
              reference: dep,
              unresolved: 'unknown-namespace',
            })
            continue
          }
          const target = (byProject.get(targetPid) ?? []).find((c) => c.name === parsed.name)
          if (!target) {
            addEdge({
              from,
              to: ensureUnresolved(`@${parsed.ns}/${parsed.name}`, dep, 'missing-component'),
              tag: 'declared',
              reference: dep,
              unresolved: 'missing-component',
            })
            continue
          }
          addEdge({ from, to: ensureComponent(targetPid, target), tag: 'declared', reference: dep })
          next.push({ projectId: targetPid, comp: target })
        } else if (BARE_NAME.test(dep)) {
          coveredNames.add(dep)
          addEdge({ from, to: ensureShadcn(dep), tag: 'shadcn', reference: dep })
        } else {
          addEdge({
            from,
            to: ensureUnresolved(dep, dep, 'unparsable-reference'),
            tag: 'declared',
            reference: dep,
            unresolved: 'unparsable-reference',
          })
        }
      }

      for (const pkg of comp.dependencies ?? []) {
        addEdge({ from, to: ensureNpm(pkg), tag: 'npm', reference: pkg })
      }

      for (const content of deps.sourceFiles(comp)) {
        for (const name of aliasImportNames(content)) {
          if (name === 'utils' || coveredNames.has(name)) {
            continue
          }
          coveredNames.add(name)
          const hit = await resolveImport(pid, name)
          if (hit.kind === 'component') {
            // Its own name resolving to itself is not a dependency — a scroll
            // area may import its own scrollbar this way on purpose.
            if (hit.projectId === pid && hit.comp.name === comp.name) {
              continue
            }
            addEdge({ from, to: ensureComponent(hit.projectId, hit.comp), tag: 'inferred', reference: name })
            next.push({ projectId: hit.projectId, comp: hit.comp })
          } else if (hit.kind === 'shadcn') {
            addEdge({ from, to: ensureShadcn(name), tag: 'shadcn', reference: name })
          } else {
            addEdge({
              from,
              to: ensureUnresolved(`import:${name}`, name, 'unresolved-import'),
              tag: 'inferred',
              reference: name,
              unresolved: 'unresolved-import',
            })
          }
        }
      }

      return next
    }

    // Forward: the transitive closure under the root.
    const rootId = ensureComponent(projectId, rootComp)
    ;(nodes.get(rootId) as Extract<GraphNode, { kind: 'component' }>).root = true
    const walked = new Set<string>([rootId])
    const queue: Array<{ projectId: string; comp: GraphComponentSummary }> = [{ projectId, comp: rootComp }]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const { projectId: pid, comp } = next
      for (const found of await referencesOf(pid, comp)) {
        const id = componentId(found.projectId, found.comp.name)
        if (!walked.has(id)) {
          walked.add(id)
          queue.push(found)
        }
      }
    }

    // Reverse: direct consumers of the root, wherever they live. The same
    // resolver decides what an import means, so a component counted here is
    // exactly one whose forward graph would carry an edge to the root.
    const reverse: GraphEdge[] = []
    const reverseSeen = new Set<string>()
    const addReverse = (edge: GraphEdge): void => {
      const key = JSON.stringify([edge.from, edge.tag, edge.reference])
      if (!reverseSeen.has(key)) {
        reverseSeen.add(key)
        reverse.push(edge)
      }
    }
    const rootNs = nsOf.get(projectId) ?? ''
    for (const p of projects) {
      for (const consumer of byProject.get(p.id) ?? []) {
        if (p.id === projectId && consumer.name === rootComp.name) {
          continue
        }
        const consumerNs = nsOf.get(p.id) ?? ''
        const declaredNames = new Set<string>()
        for (const dep of consumer.registryDependencies ?? []) {
          const parsed = parseKitRef(dep, consumerNs)
          if (!parsed) {
            continue
          }
          declaredNames.add(parsed.name)
          if (parsed.ns === rootNs && parsed.name === rootComp.name) {
            addReverse({ from: ensureComponent(p.id, consumer), to: rootId, tag: 'declared', reference: dep })
          }
        }
        let checkedImport = false
        for (const content of deps.sourceFiles(consumer)) {
          if (checkedImport) {
            break
          }
          for (const name of aliasImportNames(content)) {
            if (name !== rootComp.name || declaredNames.has(name)) {
              continue
            }
            checkedImport = true
            const hit = await resolveImport(p.id, name)
            if (hit.kind === 'component' && hit.projectId === projectId && hit.comp.name === rootComp.name) {
              addReverse({ from: ensureComponent(p.id, consumer), to: rootId, tag: 'inferred', reference: name })
            }
            break
          }
        }
      }
    }

    return { root: rootId, nodes: [...nodes.values()], edges, unresolved, reverse }
  }
}
