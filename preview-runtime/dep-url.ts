import { type NpmModule, npmModuleKey, parseDependency } from './declared-deps.ts'

// The frame fetches the npm modules its whole preview pool imports from the
// server's `deps` endpoint, which bundles them together on demand
// (server/preview.ts bundleDeps): one build per pool, so a package several of
// them reach (`@tiptap/core`, `prosemirror-state` under every `@tiptap/*`
// entry, `lucide-react` from every component) exists once, as it does in an
// app. Those responses carry `max-age=3600` and the frame's ESM loader caches
// by URL, so when the bundler's OUTPUT changes (a bug fix in how deps are
// built) a browser could keep running the old, broken bundle for up to an hour. Putting the bundler's version in the URL makes a
// changed bundler a different URL: bump DEP_BUNDLE_VERSION whenever bundleDeps
// would now emit different code for the same modules. The runtime that builds
// these URLs is itself served under a content hash (runtime.js?v=…), so a bump
// reaches the frame on the next load.
//
// Each module travels with its declared version range: the same specifier at
// two ranges is two modules.
//
// The server also keys its in-memory bundle cache by it. Host-free leaf so
// both the frame runtime and node --test can import it.
//
// 2: CommonJS require() of react/react-dom inside a dep is bridged to the
//    external ESM import (server/require-bridge.ts) instead of esbuild's
//    throwing __require — @base-ui/react popover/menu/select/tooltip/dialog.
// 3: one bundle per preview pool instead of one per module, exporting the
//    module at index i as `m<i>`.
export const DEP_BUNDLE_VERSION = 3

/** The modules in the order their bundle exports them: sorted by key, each once. */
export function bundleOrder(modules: readonly NpmModule[]): NpmModule[] {
  const byKey = new Map(modules.map((module) => [npmModuleKey(module), module]))
  return [...byKey.keys()].sort().map((key) => byKey.get(key) as NpmModule)
}

/** What one bundle of `modules` is known by, whatever order they were listed in. */
export function bundleKey(modules: readonly NpmModule[]): string {
  return bundleOrder(modules).map(npmModuleKey).join('\n')
}

/** The name the bundle exports the module at `index` of `bundleOrder` under. */
export function bundleExportName(index: number): string {
  return `m${index}`
}

/** A loaded bundle of `modules`, as each module's namespace by npmModuleKey. */
export function bundleNamespaces(
  modules: readonly NpmModule[],
  bundle: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  return new Map(
    bundleOrder(modules).map((module, i) => [
      npmModuleKey(module),
      bundle[bundleExportName(i)] as Record<string, unknown>,
    ]),
  )
}

export function depsUrl(modules: readonly NpmModule[]): string {
  const query = new URLSearchParams()
  for (const module of bundleOrder(modules)) {
    query.append('m', npmModuleKey(module))
  }
  query.set('v', String(DEP_BUNDLE_VERSION))
  return `deps?${query.toString()}`
}

/** A module as `depsUrl` writes it, `spec` or `spec@range`. */
export function parseModuleKey(key: string): NpmModule {
  const { name, range } = parseDependency(key)
  return { spec: name, range }
}

export function depsCacheKey(modules: readonly NpmModule[]): string {
  return `${DEP_BUNDLE_VERSION}:${bundleKey(modules)}`
}
