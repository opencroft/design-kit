// The dependency graph's one promise over the other reference walks: nothing
// vanishes. Every reference class is asserted by tag, and every way a
// reference can fail to resolve is asserted PRESENT — the silent drops in the
// pool/namespace walks are exactly what this module exists to not do.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  aliasImportNames,
  createDependencyGraphBuilder,
  type GraphComponentSummary,
  parseKitRef,
  reservedNamespaceReason,
} from './dependency-graph.ts'

type Fixture = GraphComponentSummary & { source?: string }

// Two projects. Alpha holds the root and its consumers; Beta holds a
// cross-project target whose own self-scope reference must resolve in BETA's
// namespace, not the root's.
const PROJECTS = [
  { id: 'p1', name: 'Alpha Kit' },
  { id: 'p2', name: 'Beta Kit' },
]

const ALPHA: Fixture[] = [
  {
    name: 'panel',
    type: 'registry:ui',
    title: 'Panel',
    // One of each class, including one of each way to be broken.
    registryDependencies: [
      'button', // bare → shadcn
      '@design-kit/chip', // declared sibling
      '@beta-kit/list', // declared cross-project
      '@ghost-kit/thing', // no such project → unknown-namespace
      '@design-kit/absent', // project exists, component does not → missing-component
      'not a ref!', // neither a kit ref nor a bare name → unparsable-reference
    ],
    dependencies: ['lucide-react'], // npm
    source: [
      "import { Helper } from '@/components/ui/helper'", // inferred sibling
      "import { Input } from '@/components/ui/input'", // inferred, shadcn answers
      "import { Mystery } from '@/components/ui/mystery'", // inferred, nothing answers
    ].join('\n'),
  },
  {
    name: 'chip',
    type: 'registry:ui',
    registryDependencies: ['badge'],
    source: "import { ChipBar } from '@/components/ui/chip'",
  },
  { name: 'helper', type: 'registry:ui' },
  { name: 'card', type: 'registry:ui', registryDependencies: ['@design-kit/panel'] },
  { name: 'frame', type: 'registry:ui', source: "import { Panel } from '@/components/ui/panel'" },
]

const BETA: Fixture[] = [
  { name: 'list', type: 'registry:ui', registryDependencies: ['@design-kit/leaf'] },
  { name: 'leaf', type: 'registry:ui' },
]

const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
// Mirrors namespaceOf in server/target.ts: the stored slug is the address, and
// the display name answers only for a project that has no slug of its own.
const namespaceOf = (p: { name: string; slug?: string }) => p.slug || slugify(p.name)

const build = createDependencyGraphBuilder({
  namespaceOf,
  readProjects: async () => PROJECTS,
  readComponents: async (projectId) => (projectId === 'p1' ? ALPHA : BETA),
  sourceFiles: (comp) => ((comp as Fixture).source ? [(comp as Fixture).source as string] : []),
  shadcnHas: async (name) => ['button', 'input', 'badge'].includes(name),
})

test('a kit reference parses relative to its holder, and only kit references parse', () => {
  assert.deepEqual(parseKitRef('@design-kit/chip', 'alpha-kit'), { ns: 'alpha-kit', name: 'chip' })
  assert.deepEqual(parseKitRef('@beta-kit/list', 'alpha-kit'), { ns: 'beta-kit', name: 'list' })
  assert.equal(parseKitRef('button', 'alpha-kit'), null)
  assert.equal(parseKitRef('not a ref!', 'alpha-kit'), null)
})

test('the reserved set is the self-scope namespace alone, matched as a whole segment', () => {
  // A project cannot mint the namespace the self-scope form reads as, and the
  // reason a creator sees names that form.
  const reason = reservedNamespaceReason('design-kit')
  assert.ok(reason?.includes('"@design-kit/<name>"'))
  // The prefix ends at the slash: a namespace that merely starts with the
  // same letters is an ordinary cross-project scope, for the parser and the
  // reservation alike.
  assert.deepEqual(parseKitRef('@design-kit-tokens/chip', 'alpha-kit'), { ns: 'design-kit-tokens', name: 'chip' })
  assert.equal(reservedNamespaceReason('design-kit-tokens'), null)
  assert.equal(reservedNamespaceReason('alpha-kit'), null)
})

test('an alias import resolves by its last path segment, category folders included', () => {
  assert.deepEqual(aliasImportNames("import { Flex } from '@/components/ui/layout/flex'"), ['flex'])
  assert.deepEqual(aliasImportNames("import { Button } from '@/components/ui/button'"), ['button'])
})

test('every reference class comes back tagged as itself', async () => {
  const graph = await build('p1', 'panel')
  const edge = (tag: string, reference: string) => graph.edges.find((e) => e.tag === tag && e.reference === reference)

  assert.equal(edge('declared', '@design-kit/chip')?.to, 'component:p1:chip')
  assert.equal(edge('declared', '@beta-kit/list')?.to, 'component:p2:list')
  assert.equal(edge('shadcn', 'button')?.to, 'shadcn:button')
  assert.equal(edge('npm', 'lucide-react')?.to, 'npm:lucide-react')
  assert.equal(edge('inferred', 'helper')?.to, 'component:p1:helper')
  // An inferred import the shadcn registry answers for is an external edge.
  assert.equal(edge('shadcn', 'input')?.to, 'shadcn:input')
})

test('every way to be broken is present, not dropped', async () => {
  const graph = await build('p1', 'panel')

  const reasons = new Map(graph.unresolved.map((u) => [u.reference, u.reason]))
  assert.equal(reasons.get('@ghost-kit/thing'), 'unknown-namespace')
  assert.equal(reasons.get('@design-kit/absent'), 'missing-component')
  assert.equal(reasons.get('not a ref!'), 'unparsable-reference')
  assert.equal(reasons.get('mystery'), 'unresolved-import')
  assert.equal(graph.unresolved.length, 4)

  // Each one is also a real node and a real edge, so a renderer cannot lose it.
  const unresolvedNodes = graph.nodes.filter((n) => n.kind === 'unresolved')
  assert.equal(unresolvedNodes.length, 4)
  for (const u of graph.unresolved) {
    assert.ok(graph.edges.some((e) => e.reference === u.reference && e.unresolved === u.reason))
  }
  // A self-scope reference normalizes to its holder's namespace, so the broken
  // node names the target identity, not the literal placeholder.
  assert.ok(graph.nodes.some((n) => n.id === 'unresolved:@alpha-kit/absent'))
})

test('the walk is transitive, and a foreign self-scope resolves in the foreign namespace', async () => {
  const graph = await build('p1', 'panel')

  // chip was reached through the root and its own external dep is present.
  assert.ok(graph.edges.some((e) => e.from === 'component:p1:chip' && e.to === 'shadcn:badge'))
  // list (Beta) declares @design-kit/leaf: Beta's leaf, not Alpha's anything.
  const leaf = graph.edges.find((e) => e.from === 'component:p2:list' && e.reference === '@design-kit/leaf')
  assert.equal(leaf?.to, 'component:p2:leaf')
  assert.equal(leaf?.tag, 'declared')
  // A component importing its own name is not its own dependency.
  assert.ok(!graph.edges.some((e) => e.from === e.to))
})

test('reverse edges answer "used by", with the same provenance split', async () => {
  const graph = await build('p1', 'panel')

  assert.deepEqual(
    graph.reverse.map((e) => ({ from: e.from, tag: e.tag })).sort((a, b) => a.from.localeCompare(b.from)),
    [
      { from: 'component:p1:card', tag: 'declared' },
      { from: 'component:p1:frame', tag: 'inferred' },
    ],
  )
  for (const e of graph.reverse) {
    assert.equal(e.to, 'component:p1:panel')
  }
  // The consumers exist as nodes, so "used by" is drawable.
  assert.ok(graph.nodes.some((n) => n.id === 'component:p1:card'))
  assert.ok(graph.nodes.some((n) => n.id === 'component:p1:frame'))
})

test('the root is marked, and a missing root refuses instead of answering emptily', async () => {
  const graph = await build('p1', 'panel')
  const root = graph.nodes.find((n) => n.id === graph.root)
  assert.equal(root?.kind, 'component')
  assert.equal((root as { root?: true }).root, true)

  await assert.rejects(() => build('p1', 'no-such-component'), /not found/)
})

// ── A project whose stored slug is not its slugified name ──
//
// The fixtures above carry no slug, so they exercise the fallback and say
// nothing about this. A project that HAS one publishes under it, and this graph
// decides two things at once: what a reference resolves to, and what gets
// reported as `unknown-namespace`. Keying it off the display name would get
// both wrong at once for a renamed project — the canonical spelling called
// unknown, and the stale spelling drawn as a real edge.

const RENAMED = [{ id: 'p1', name: 'Old Display Name', slug: 'stored-slug' }]

const buildRenamed = createDependencyGraphBuilder({
  namespaceOf,
  readProjects: async () => RENAMED,
  readComponents: async () => [
    { name: 'root', type: 'registry:ui', registryDependencies: ['@stored-slug/leaf', '@old-display-name/leaf'] },
    { name: 'leaf', type: 'registry:ui' },
  ],
  sourceFiles: () => [],
  shadcnHas: async () => false,
})

test('a reference in the stored slug resolves, and the slugified display name does not', async () => {
  const graph = await buildRenamed('p1', 'root')

  // The canonical spelling reaches the component.
  assert.ok(graph.edges.some((e) => e.reference === '@stored-slug/leaf' && !e.unresolved))
  // The stale spelling is reported, not quietly drawn as an edge to nowhere.
  assert.deepEqual(
    graph.unresolved.map((u) => ({ reference: u.reference, reason: u.reason })),
    [{ reference: '@old-display-name/leaf', reason: 'unknown-namespace' }],
  )
})

test('a component node carries the namespace the project publishes under', async () => {
  const graph = await buildRenamed('p1', 'root')
  const root = graph.nodes.find((n) => n.id === graph.root)

  assert.equal((root as { namespace?: string }).namespace, 'stored-slug')
})

test('a project with no slug still resolves under its slugified name', async () => {
  // The legacy row, unchanged: it has no other address, so the name is it.
  const graph = await build('p1', 'panel')
  const root = graph.nodes.find((n) => n.id === graph.root)

  assert.equal((root as { namespace?: string }).namespace, 'alpha-kit')
})
