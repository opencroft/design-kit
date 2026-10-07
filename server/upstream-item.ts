// An upstream shadcn registry item, made to resolve in the preview pool the
// way it resolves in a project the shadcn CLI installed it into.
//
// Upstream items lean on what `shadcn init` set up in the project: the class
// helper under the project's `utils` alias, and packages such as
// `lucide-react` or `class-variance-authority` that they import without
// declaring. The preview resolves an import only from its item's declared
// `dependencies`, so both are supplied here, when the item is fetched.
//
// Host-free leaf with explicit extensions, so node --test can load it.

import { parseDependency, REACT_FAMILY } from '../preview-runtime/declared-deps.ts'
import { depPackageName, isWorkspacePackageSpec } from '../preview-runtime/unverifiable-dep.ts'

const UTILS_IMPORT_RE = /(from\s*)(['"])@\/lib\/utils\2/g

/**
 * The class helper imported from the `cn` package, as the CLI writes it into a
 * project whose `utils` alias is `cn`.
 */
export function withCnPackage(source: string): string {
  return source.replace(UTILS_IMPORT_RE, '$1$2cn$2')
}

const IMPORT_SPEC_RE = /^[ \t]*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|^[ \t]*import\s*['"]([^'"]+)['"]/gm

/**
 * The item's declared dependencies, plus every npm package its files import
 * that it does not declare, at no particular version. The React family and
 * the product's workspace packages are never declared.
 */
export function upstreamDependencies(files: readonly string[], declared: readonly string[]): string[] {
  const names = new Set(declared.map((entry) => parseDependency(entry).name))
  const added: string[] = []
  for (const source of files) {
    for (const m of source.matchAll(IMPORT_SPEC_RE)) {
      const spec = m[1] ?? m[2]
      if (spec.startsWith('.') || spec.startsWith('@/') || REACT_FAMILY.has(spec) || isWorkspacePackageSpec(spec)) {
        continue
      }
      const name = depPackageName(spec)
      if (!names.has(name)) {
        names.add(name)
        added.push(name)
      }
    }
  }
  return [...declared, ...added]
}
