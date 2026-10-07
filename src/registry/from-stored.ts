import type { RegistryItem } from './types'

// Serialisable component shape persisted by the server (entity meta + files).
// All docs — the `doc.mdx` orchestrator plus its `preview.tsx` / `examples/*`
// code — live in `docs/*` files, never in meta.
export interface StoredFile {
  path: string
  target: string
  type: string
  content: string
}
export interface StoredComponent {
  name: string
  title: string
  type: 'registry:ui' | 'registry:hook'
  category: string
  description: string
  dependencies: string[]
  registryDependencies?: string[]
  files?: StoredFile[]
  source?: string
  exportName: string
  signature?: string
  /** An unpublished draft exists: the published version it is ahead of, or
   *  'unpublished' for a component never published. Absent when draft and
   *  published are the same thing. */
  draft?: number | 'unpublished'
}

function normalizeFiles(c: StoredComponent): StoredFile[] {
  if (c.files && c.files.length > 0) {
    return c.files
  }
  if (typeof c.source === 'string') {
    const isHook = c.type === 'registry:hook'
    const target = isHook ? `hooks/${c.name}.ts` : `components/ui/${c.name}.tsx`
    return [{ path: target, target, type: isHook ? 'registry:hook' : 'registry:component', content: c.source }]
  }
  return []
}

const fileKey = (f: StoredFile): string => f.target || f.path

// Source files feed the render scope; `docs/**` and registry:ignore are docs.
function sourceFiles(files: StoredFile[]): StoredFile[] {
  return files.filter((f) => f.type !== 'registry:ignore' && !fileKey(f).startsWith('docs/'))
}

// The doc files, keyed by their path relative to `docs/` — so a tag's
// `src="./preview.tsx"` / `src="./examples/foo.tsx"` resolves to `preview.tsx`
// / `examples/foo.tsx`. `doc.mdx` is the orchestrator.
function docFilesMap(files: StoredFile[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const f of files) {
    const key = fileKey(f)
    if (key.startsWith('docs/')) {
      map[key.slice('docs/'.length)] = f.content
    }
  }
  return map
}

// Every component's source files, grouped per component — the eval scope the
// preview iframe builds its exports from. Nothing is evaluated in the host
// page; the sources travel to the frame as data.
export function collectProjectSources(stored: StoredComponent[]): string[][] {
  return stored.map((c) => sourceFiles(normalizeFiles(c)).map((f) => f.content))
}

function toRegistryItem(c: StoredComponent): RegistryItem {
  const files = normalizeFiles(c)
  const docFiles = docFilesMap(files)
  const mdx = docFiles['doc.mdx']

  return {
    name: c.name,
    title: c.title,
    type: c.type,
    category: c.category,
    description: c.description,
    dependencies: c.dependencies ?? [],
    // Carried through verbatim. A reference is not the same thing as a name:
    // a library can declare both `button` (the external shadcn item) and
    // `@design-kit/button` (its own), so dropping the scope to show a shorter
    // label would print one chip for two different dependencies.
    registryDependencies: c.registryDependencies ?? [],
    files: files.map((f) => ({ path: f.path, target: f.target, content: f.content })),
    doc: mdx != null ? { mdx, files: docFiles } : undefined,
    signature: c.signature,
    // Carried through explicitly: a field the server sends is not on the
    // dashboard until a line here says so, and the page renders fine with it
    // silently missing.
    draft: c.draft,
  }
}

// Build all render-ready items for a project.
export function buildRegistryItems(stored: StoredComponent[]): RegistryItem[] {
  return stored.map((c) => toRegistryItem(c))
}
