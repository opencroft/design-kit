// ── Registry data model ──────────────────────────────────────────────
// The shapes the dashboard renders a component from; ./from-stored.ts builds
// them out of the records the server stores.

export type RegistryType = 'registry:ui' | 'registry:hook'

export interface RegistryFile {
  path: string
  target: string
  content: string
}

export type Control =
  | { name: string; kind: 'enum'; options: string[]; default: string }
  | { name: string; kind: 'boolean'; default: boolean }
  | { name: string; kind: 'text'; default: string }

// One row of the interactive props table. `control` makes the Value cell
// interactive; rows for complex types (lambdas / React nodes) omit it.
export interface PropRow {
  name: string
  type: string
  default?: string
  description: string
  control?: Control
}

// A component's rendered docs, authored as `docs/doc.mdx` (markdown + Preview/
// Sheet/Example tags). `files` maps each docs-relative path (`preview.tsx`,
// `examples/foo.tsx`) to its source so the tags can resolve their `src`.
export interface ComponentDocData {
  mdx: string
  files: Record<string, string>
}

export interface RegistryItem {
  name: string
  title: string
  type: RegistryType
  category: string
  description: string
  dependencies: string[]
  registryDependencies: string[]
  files: RegistryFile[]
  doc?: ComponentDocData
  signature?: string
  /** An unpublished draft exists: the published version it is ahead of, or
   *  'unpublished' for a component never published. */
  draft?: number | 'unpublished'
}

// Matches the host's slugify — a project's name becomes its registry namespace.
export function slugify(name: string): string {
  const base = String(name ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'components'
}

export function installCommand(namespace: string, name: string): string {
  return `npx shadcn@latest add @${namespace}/${name}`
}
