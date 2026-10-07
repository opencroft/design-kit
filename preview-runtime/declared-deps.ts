import { depPackageName, isWorkspacePackageSpec, unverifiableDepModule } from './unverifiable-dep.ts'

// Which npm package an import resolves to, and at which version: the item's
// declared `dependencies` decide, the same list `shadcn add` installs from.
// Host-free leaf, shared by the preview frame (entry.tsx) and the server
// validator (server/validate.ts), so both resolve an import identically.

/**
 * Served by the preview runtime itself, never from a declaration: the frame,
 * the evaluated sources and every dependency bundle (through the import map)
 * must share ONE React, and a declared `react` bundled on its own would be a
 * second copy.
 */
export const REACT_FAMILY: ReadonlySet<string> = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'])

/** One `dependencies` entry: `pkg`, `pkg@range` or `@scope/pkg@range`. */
export interface DeclaredDependency {
  name: string
  /** npm version range; '' when the entry names no version */
  range: string
}

export function parseDependency(entry: string): DeclaredDependency {
  const at = entry.lastIndexOf('@')
  return at > 0 ? { name: entry.slice(0, at), range: entry.slice(at + 1) } : { name: entry, range: '' }
}

/** Declared version range by package name. */
export function declaredRanges(dependencies: readonly string[]): Map<string, string> {
  return new Map(dependencies.map((entry) => parseDependency(entry)).map((d) => [d.name, d.range]))
}

/** Whether an import names an npm package (not a relative or path-alias import). */
export function isNpmSpecifier(module: string): boolean {
  return !module.startsWith('.') && !module.startsWith('@/')
}

/** An npm module to fetch through the dependency bundler. */
export interface NpmModule {
  spec: string
  /** '' = no version declared, the newest one is installed */
  range: string
}

export type ModuleSource = { kind: 'builtin'; spec: string } | { kind: 'workspace'; spec: string } | ({ kind: 'npm' } & NpmModule)

/**
 * Where an import's value comes from, given the declaring item's ranges (see
 * declaredRanges). A workspace package is never declared and never fetched (see
 * ./unverifiable-dep). Null when it is not an npm import, or when the item does
 * not declare its package — an undeclared import resolves to nothing, and the
 * validator names it.
 */
export function moduleSource(module: string, declared: ReadonlyMap<string, string>): ModuleSource | null {
  if (!isNpmSpecifier(module)) {
    return null
  }
  if (REACT_FAMILY.has(module)) {
    return { kind: 'builtin', spec: module }
  }
  if (isWorkspacePackageSpec(module)) {
    return { kind: 'workspace', spec: module }
  }
  const range = declared.get(depPackageName(module))
  return range === undefined ? null : { kind: 'npm', spec: module, range }
}

/** Identity of a fetched module: the same specifier at two ranges is two modules. */
export function npmModuleKey({ spec, range }: NpmModule): string {
  return range ? `${spec}@${range}` : spec
}

export type ModuleResolver = (module: string) => Record<string, unknown> | undefined

/**
 * Resolves an item's imports against its own declarations: the React family
 * from `builtins`, npm modules from `loaded` (keyed by npmModuleKey), and a
 * workspace package to the placeholder that reports it unverifiable where it
 * renders.
 */
export function moduleResolver(
  dependencies: readonly string[],
  builtins: Readonly<Record<string, Record<string, unknown>>>,
  loaded: ReadonlyMap<string, Record<string, unknown>>,
): ModuleResolver {
  const declared = declaredRanges(dependencies)
  return (module) => {
    const source = moduleSource(module, declared)
    if (source == null) {
      return undefined
    }
    if (source.kind === 'builtin') {
      return builtins[source.spec]
    }
    if (source.kind === 'workspace') {
      return unverifiableDepModule('workspace-package', source.spec)
    }
    return loaded.get(npmModuleKey(source))
  }
}

/**
 * Packages among `modules` (import specifiers) that `dependencies` does not
 * declare, sorted. The React family and the product's workspace packages are
 * exempt: neither is ever installed from a declaration.
 */
export function undeclaredPackages(modules: readonly string[], dependencies: readonly string[]): string[] {
  const declared = declaredRanges(dependencies)
  const missing = new Set<string>()
  for (const module of modules) {
    if (!isNpmSpecifier(module) || REACT_FAMILY.has(module) || isWorkspacePackageSpec(module)) {
      continue
    }
    const name = depPackageName(module)
    if (!declared.has(name)) {
      missing.add(name)
    }
  }
  return [...missing].sort()
}
