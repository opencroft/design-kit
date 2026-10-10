// The migration's one load-bearing property: writing served targets into
// stored ones must not move a single served path. Every branch of the
// composition is exercised, because the classes that behave differently are
// exactly the ones a spot check would miss.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ImportOrigin, ImportTargets, TargetComponent, TargetFile } from './target.ts'
import {
  assertTargetsAvailable,
  categorizedTarget,
  namespaceOf,
  rewriteComponentImports,
  servedTarget,
  targetPath,
  withExplicitTargets,
} from './target.ts'

/** The library's own rule for materialising a record's files, as index.ts applies it. */
function normalizeFiles(c: TargetComponent): TargetFile[] {
  if (Array.isArray(c.files) && c.files.length > 0) {
    return c.files
  }
  if (typeof c.source === 'string') {
    const isHook = c.type === 'registry:hook'
    const target = isHook ? `hooks/${c.name}.ts` : `components/ui/${c.name}.tsx`
    return [{ path: target, target, type: isHook ? 'registry:hook' : 'registry:component', content: c.source }]
  }
  return []
}

const comp = (over: Partial<TargetComponent> = {}): TargetComponent => ({
  name: 'widget',
  type: 'registry:ui',
  category: 'Utils',
  files: [
    { path: 'components/ui/widget.tsx', target: 'components/ui/widget.tsx', type: 'registry:component', content: '' },
  ],
  ...over,
})

function firstFile(component: TargetComponent): TargetFile {
  const file = component.files?.[0]
  assert.ok(file, `${component.name} has a file`)
  return file
}

/**
 * One record of every class that composes differently. A spot check over the
 * common one would pass while the others moved.
 */
const EVERY_CLASS: Array<[string, TargetComponent]> = [
  ['flat target with a category', comp()],
  ['no category at all', comp({ category: '' })],
  [
    'category that slugifies away from its stored folder',
    comp({
      category: 'Layouts',
      files: [
        {
          path: 'components/ui/layout/widget.tsx',
          target: 'components/ui/layout/widget.tsx',
          type: 'registry:component',
          content: '',
        },
      ],
    }),
  ],
  [
    'target already carrying a subfolder',
    comp({
      files: [
        {
          path: 'components/ui/media/widget.tsx',
          target: 'components/ui/media/widget.tsx',
          type: 'registry:component',
          content: '',
        },
      ],
    }),
  ],
  [
    'a hook, which lives outside components/ui',
    comp({
      type: 'registry:hook',
      name: 'use-thing',
      files: [{ path: 'hooks/use-thing.ts', target: 'hooks/use-thing.ts', type: 'registry:hook', content: '' }],
    }),
  ],
  [
    'several files, one of them a secondary',
    comp({
      files: [
        {
          path: 'components/ui/widget.tsx',
          target: 'components/ui/widget.tsx',
          type: 'registry:component',
          content: '',
        },
        {
          path: 'components/ui/widget-row.tsx',
          target: 'components/ui/widget-row.tsx',
          type: 'registry:component',
          content: '',
        },
      ],
    }),
  ],
  [
    'a file with no stored target, falling back to its path',
    comp({ files: [{ path: 'components/ui/widget.tsx', type: 'registry:component', content: '' }] }),
  ],
  [
    'the legacy single-source form, with no files at all',
    comp({ files: undefined, source: 'export const Widget = null' }),
  ],
  [
    'a docs file, which is never installed but still has a target',
    comp({
      files: [
        {
          path: 'components/ui/widget.tsx',
          target: 'components/ui/widget.tsx',
          type: 'registry:component',
          content: '',
        },
        { path: 'docs/doc.mdx', target: 'docs/doc.mdx', type: 'registry:ignore', content: '' },
      ],
    }),
  ],
]

test('migrating a component moves no served path, for every class of record', () => {
  for (const [label, before] of EVERY_CLASS) {
    const servedBefore = normalizeFiles(before).map((f) => servedTarget(f, before))
    const after = withExplicitTargets(before, normalizeFiles)
    const servedAfter = normalizeFiles(after).map((f) => servedTarget(f, after))

    assert.deepEqual(servedAfter, servedBefore, label)
  }
})

test('the migration is what makes a stored target authoritative, and it is idempotent', () => {
  const once = withExplicitTargets(comp(), normalizeFiles)
  const twice = withExplicitTargets(once, normalizeFiles)

  assert.equal(once.files?.[0]?.target, 'components/ui/utils/widget.tsx', 'the served value is written in')
  assert.deepEqual(twice, once, 'running it again changes nothing')
})

// After migration the category does not decide where a file lands, so renaming
// it relocates nothing at any consumer.
test('once targets are explicit, a category change does not move a served path', () => {
  const migrated = withExplicitTargets(comp(), normalizeFiles)
  const recategorised = { ...migrated, category: 'Media' }

  assert.equal(servedTarget(firstFile(migrated), recategorised), 'components/ui/utils/widget.tsx')
})

test('before migration, a category change does move it — which is why the guard has to fire there', () => {
  const before = comp()
  const recategorised = { ...before, category: 'Media' }

  assert.equal(servedTarget(firstFile(before), before), 'components/ui/utils/widget.tsx')
  assert.equal(servedTarget(firstFile(before), recategorised), 'components/ui/media/widget.tsx')
})

test('an author can put an explicit target anywhere, including flat under a category', () => {
  const explicit: TargetComponent = { ...comp({ category: 'Utils' }), targetsExplicit: true }

  assert.equal(servedTarget({ target: 'components/ui/widget.tsx' }, explicit), 'components/ui/widget.tsx')
  assert.equal(servedTarget({ target: 'lib/widget.ts' }, explicit), 'lib/widget.ts')
})

// Composing onto a target that already carries a folder must not double the
// path. Structural, not a slug comparison, because a category can slugify to
// something other than the folder already stored for it.
test('composition never nests a second segment under one that is already there', () => {
  assert.equal(categorizedTarget('components/ui/layout/widget.tsx', 'Layouts'), 'components/ui/layout/widget.tsx')
  assert.equal(categorizedTarget('hooks/use-thing.ts', 'Hooks'), 'hooks/use-thing.ts')
  assert.equal(categorizedTarget('components/ui/widget.tsx', '  '), 'components/ui/widget.tsx')
})

// ── import rewriting ─────────────────────────────────────────────────
// The property under test is that the AUTHORED form stops mattering: two
// sources naming the same sibling two different ways must come out naming the
// same installed file.

const KIT: ImportTargets = {
  byName: {
    'status-indicator': 'components/ui/feedback/status-indicator.tsx',
    'agent-avatar': 'components/ui/media/agent-avatar.tsx',
    'use-debounce': 'hooks/use-debounce.ts',
  },
  byStoredPath: {
    'components/ui/status-indicator': 'components/ui/feedback/status-indicator.tsx',
    'components/ui/agent-avatar': 'components/ui/media/agent-avatar.tsx',
    'hooks/use-debounce': 'hooks/use-debounce.ts',
  },
}

const CHAT: ImportOrigin = { stored: 'components/ui/chat-turn.tsx', served: 'components/ui/chat/chat-turn.tsx' }

test('a sibling in another category resolves the same whether it was authored relative or aliased', () => {
  const relative = rewriteComponentImports(`import { S } from './status-indicator'`, CHAT, KIT)
  const aliased = rewriteComponentImports(`import { S } from '@/components/ui/status-indicator'`, CHAT, KIT)

  assert.equal(relative, `import { S } from '../feedback/status-indicator'`)
  assert.equal(aliased, `import { S } from '../feedback/status-indicator'`)
})

// Leaving `./` alone would leave a relative import across categories pointing
// at a path nothing installs.
test('a relative import is not left pointing at a path nothing installs', () => {
  const out = rewriteComponentImports(`import { A } from './agent-avatar'`, CHAT, KIT)

  assert.notEqual(out, `import { A } from './agent-avatar'`)
  assert.equal(out, `import { A } from '../media/agent-avatar'`)
})

// The emitted form, and the reason it is a path: one base cannot address two
// packages, so `@/x` is the form that cannot be made to work at a consumer
// whose packages are separate. Both files here land in the shared package, so
// the path is the whole answer.
test('two files in the same package name each other by path, not by alias', () => {
  const out = rewriteComponentImports(`import { S } from './status-indicator'`, CHAT, KIT)

  assert.ok(!out.includes('@/'), 'nothing addressed through an alias')
  assert.equal(out, `import { S } from '../feedback/status-indicator'`)
})

// Flat targets are what make the path form reach: with both files served from
// one directory the specifier is a bare sibling, which is also what the
// authored source says — so this case rewrites to itself.
test('a sibling served from the same directory comes out as a sibling', () => {
  const flat: ImportTargets = {
    byName: { markdown: 'components/markdown.tsx' },
    byStoredPath: { 'components/markdown': 'components/markdown.tsx' },
  }
  const turn: ImportOrigin = { stored: 'components/chat-turn.tsx', served: 'components/chat-turn.tsx' }

  assert.equal(rewriteComponentImports(`import { M } from './markdown'`, turn, flat), `import { M } from './markdown'`)
})

// The one case a path cannot express, and the reason the alias survives at all.
// The importer is in the consumer's own package and the importee in the shared
// one; a relative path between them would leave the package the library can see
// for one it cannot name. The alias is emitted knowing it is wrong there — the
// consumer has to carry its own specifier, and nothing here can report that.
test('a reference that crosses into the shared package keeps the alias', () => {
  const own: ImportOrigin = { stored: 'components/chat-turn.tsx', served: 'components/chat-turn.tsx' }

  assert.equal(
    rewriteComponentImports(`import { A } from './agent-avatar'`, own, KIT),
    `import { A } from '@/components/ui/media/agent-avatar'`,
  )
})

// And the same boundary from the other side, so the rule is pinned as a
// comparison of both ends rather than a property of the importee alone.
test('a reference out of the shared package into the own one keeps the alias too', () => {
  const targets: ImportTargets = {
    byName: { markdown: 'components/markdown.tsx' },
    byStoredPath: { 'components/markdown': 'components/markdown.tsx' },
  }
  const shared: ImportOrigin = {
    stored: 'components/ui/thread-artifacts.tsx',
    served: 'components/ui/group-chat/thread-artifacts.tsx',
  }

  assert.equal(
    rewriteComponentImports(`import { M } from './markdown'`, shared, targets),
    `import { M } from '@/components/markdown'`,
  )
})

// A path is only a path if a bundler reads it as one. `markdown` alone is a
// package name; `./markdown` is the file beside this one.
test('an emitted path is always prefixed, never a bare name', () => {
  const targets: ImportTargets = { byName: { logo: 'logo.tsx' }, byStoredPath: { logo: 'logo.tsx' } }
  const root: ImportOrigin = { stored: 'wordmark.tsx', served: 'wordmark.tsx' }

  assert.equal(rewriteComponentImports(`import { L } from './logo'`, root, targets), `import { L } from './logo'`)
})

test('a hook resolves to where hooks land, not under components', () => {
  assert.equal(
    rewriteComponentImports(`import { useDebounce } from '@/components/ui/use-debounce'`, CHAT, KIT),
    `import { useDebounce } from '@/hooks/use-debounce'`,
  )
})

// A category-qualified alias is the one `@/` form this does not touch, so a
// source that already carries one comes out byte-identical. That is not a
// claim that rewriting diffs nothing — emitting paths deliberately rewrites
// every same-package import line — but it is the property that keeps an
// already-correct alias from being mangled into a second category.
test('an alias already pointing where the component lands is unchanged', () => {
  const source = `import { S } from '@/components/ui/feedback/status-indicator'`

  assert.equal(rewriteComponentImports(source, CHAT, KIT), source)
})

// The third authored form, and it is NOT rewritten. Pinned so the omission is
// a stated property rather than something a reader has to infer from a regex:
// a category-qualified specifier goes through untouched, which is what keeps an
// already-correct alias byte-identical — and also what leaves it naming a
// category that can be renamed out from under it.
test('a category-qualified specifier passes through untouched, even when it names the wrong category', () => {
  const wrong = `import { S } from '@/components/ui/utils/status-indicator'`

  assert.equal(rewriteComponentImports(wrong, CHAT, KIT), wrong)
})

test('a specifier naming nothing this library serves is left exactly as it was', () => {
  const source = `import { Dialog } from '@/components/ui/dialog'\nimport { cn } from '@/lib/utils'\nimport x from './not-a-component'\nimport React from 'react'`

  assert.equal(rewriteComponentImports(source, CHAT, KIT), source)
})

test('a relative specifier is resolved against where the source SITS, not where it lands', () => {
  // Both files are stored flat; only the served paths differ. Resolving `./x`
  // against the served directory would look for `components/ui/chat/x` and
  // find nothing.
  const out = rewriteComponentImports(`import { S } from './status-indicator'`, CHAT, KIT)

  assert.equal(out, `import { S } from '../feedback/status-indicator'`)
})

test('a parent-relative specifier resolves too', () => {
  const nested: ImportOrigin = { stored: 'components/ui/chat/turn.tsx', served: 'components/ui/chat/turn.tsx' }

  assert.equal(
    rewriteComponentImports(`import { S } from '../status-indicator'`, nested, KIT),
    `import { S } from '../feedback/status-indicator'`,
  )
})

// Once stored targets are authoritative, a component's stored path IS its
// served path — so `./x`, written when both files sat in one directory,
// resolves against a directory that no longer holds the sibling. The name is
// what the author meant, and it is what makes the authored form irrelevant.
// The importer sits in a different category from the importee, so `./x` names
// a path that does not exist and the NAME is the only thing left to go on. The
// two files being apart is what makes this falsifiable: were they in one
// directory the right answer would be the authored form itself, and the test
// would pass without the fallback ever running.
test('a sibling written relatively still resolves after both files have moved apart', () => {
  const moved: ImportOrigin = { stored: 'components/ui/media/alpha.tsx', served: 'components/ui/media/alpha.tsx' }

  assert.equal(
    rewriteComponentImports(`import { S } from './status-indicator'`, moved, KIT),
    `import { S } from '../feedback/status-indicator'`,
  )
})

// The two lookups must disagree for this to prove anything, so the served
// target of the path-matched file is deliberately somewhere the name-matched
// one is not.
test('a relative path that names a served file beats the name that happens to match it', () => {
  const targets: ImportTargets = {
    byName: { widget: 'components/ui/media/widget.tsx' },
    byStoredPath: { 'components/ui/chat/widget': 'components/ui/chat/pinned/widget.tsx' },
  }
  const importer: ImportOrigin = { stored: 'components/ui/chat/turn.tsx', served: 'components/ui/chat/turn.tsx' }

  assert.equal(
    rewriteComponentImports(`import { W } from './widget'`, importer, targets),
    `import { W } from './pinned/widget'`,
  )
})

test('rewriting is idempotent, so serving an already-rewritten file changes nothing', () => {
  const once = rewriteComponentImports(`import { S } from './status-indicator'`, CHAT, KIT)

  assert.equal(rewriteComponentImports(once, CHAT, KIT), once)
})

// ── the invariant ────────────────────────────────────────────────────
// The cross-project branch is why this is here: a library holding one design
// project can never execute it, so these tests inject a library that holds
// several.

type Guarded = TargetComponent & { id: string }

function library(projects: Array<{ id: string; name: string; components: Guarded[] }>) {
  return {
    listProjects: async () => projects.map((p) => ({ id: p.id, name: p.name })),
    readComponents: async (projectId: string) => projects.find((p) => p.id === projectId)?.components ?? [],
    normalizeFiles: normalizeFiles as (c: Guarded) => TargetFile[],
  }
}

const held = (id: string, name: string, target: string, over: Partial<Guarded> = {}): Guarded => ({
  id,
  name,
  type: 'registry:ui',
  category: '',
  targetsExplicit: true,
  files: [{ path: target, target, type: 'registry:component', content: '' }],
  ...over,
})

test('a target already served by ANOTHER project is refused', async () => {
  const deps = library([
    {
      id: 'p1',
      name: 'Acme UI',
      components: [held('cp_1', 'status-indicator', 'components/ui/utils/status-indicator.tsx')],
    },
    { id: 'p2', name: 'Base Components', components: [] },
  ])

  await assert.rejects(
    assertTargetsAvailable(held('cp_2', 'status-indicator', 'components/ui/utils/status-indicator.tsx'), deps),
    (e: Error) => /components\/ui\/utils\/status-indicator\.tsx/.test(e.message) && /Acme UI/.test(e.message),
  )
})

test('a target served in the SAME project is refused too, which is why the scope includes it', async () => {
  const deps = library([
    { id: 'p1', name: 'Acme UI', components: [held('cp_1', 'alpha', 'components/ui/feedback/shared-row.tsx')] },
  ])

  await assert.rejects(
    assertTargetsAvailable(held('cp_2', 'beta', 'components/ui/feedback/shared-row.tsx'), deps),
    /already serves that exact path/,
  )
})

// The negative control, as a test: the same file name under two categories is
// two different paths and must stay legal. A guard that refuses this has
// re-implemented the name guard under a new key.
test('the same file name at two different targets is not a collision', async () => {
  const deps = library([
    { id: 'p1', name: 'Acme UI', components: [held('cp_1', 'chat-input', 'components/ui/agent-chat/chat-input.tsx')] },
    { id: 'p2', name: 'Base Components', components: [] },
  ])

  await assertTargetsAvailable(held('cp_2', 'chat-input', 'components/ui/chat/chat-input.tsx'), deps)
})

test('a component does not collide with itself, so re-saving one is not refused', async () => {
  const existing = held('cp_1', 'widget', 'components/ui/widget.tsx')
  const deps = library([{ id: 'p1', name: 'Acme UI', components: [existing] }])

  await assertTargetsAvailable({ ...existing, name: 'renamed' }, deps)
})

// Docs never install, so they cannot overwrite anything. Both sides of the
// comparison are checked: the claimant's ignored files claim nothing, and the
// holder's ignored files block nothing.
test('registry:ignore files neither claim a target nor block one', async () => {
  const holder = held('cp_1', 'alpha', 'docs/doc.mdx', {
    files: [{ path: 'docs/doc.mdx', target: 'docs/doc.mdx', type: 'registry:ignore', content: '' }],
  })
  const deps = library([{ id: 'p1', name: 'Acme UI', components: [holder] }])

  await assertTargetsAvailable(held('cp_2', 'beta', 'docs/doc.mdx'), deps)
  await assertTargetsAvailable(
    held('cp_3', 'gamma', 'docs/doc.mdx', {
      files: [{ path: 'docs/doc.mdx', target: 'docs/doc.mdx', type: 'registry:ignore', content: '' }],
    }),
    library([{ id: 'p1', name: 'Acme UI', components: [held('cp_1', 'alpha', 'docs/doc.mdx')] }]),
  )
})

// An unmigrated record still composes its category, so the guard has to compare
// what each side SERVES rather than what each side stores.
test('a collision between a migrated and an unmigrated record is still seen', async () => {
  const unmigrated = held('cp_1', 'alpha', 'components/ui/shared-row.tsx', {
    category: 'Feedback',
    targetsExplicit: undefined,
  })
  const deps = library([{ id: 'p1', name: 'Acme UI', components: [unmigrated] }])

  await assert.rejects(
    assertTargetsAvailable(held('cp_2', 'beta', 'components/ui/feedback/shared-row.tsx'), deps),
    /already serves that exact path/,
  )
})

test('a component with no installable files claims nothing and is never refused', async () => {
  const deps = library([{ id: 'p1', name: 'Acme UI', components: [held('cp_1', 'alpha', 'components/ui/widget.tsx')] }])

  await assertTargetsAvailable({ ...held('cp_2', 'beta', 'x'), files: [] }, deps)
})

test('the default path follows the kind of thing being served', () => {
  assert.equal(targetPath({ name: 'widget', type: 'registry:ui' }), 'components/ui/widget.tsx')
  assert.equal(targetPath({ name: 'use-thing', type: 'registry:hook' }), 'hooks/use-thing.ts')
})

// ── The namespace a project publishes under ──
//
// One definition, shared by everything that advertises, accepts, resolves or
// reports a namespace. It is asserted here against a display name that
// slugifies to something OTHER than the slug, because while the two agree
// every wrong implementation passes too.

test('a project publishes under its stored slug, not its slugified display name', () => {
  assert.equal(namespaceOf({ name: 'File Manager Extension', slug: 'acme-file-manager' }), 'acme-file-manager')
})

test('a project with no slug is named by its display name', () => {
  assert.equal(namespaceOf({ name: 'Base Components' }), 'base-components')
})

test('an empty slug is not an address', () => {
  assert.equal(namespaceOf({ name: 'Base Components', slug: '' }), 'base-components')
})
