import host from '@ext/host'

import type { PoolGroup } from '../preview-runtime/protocol'
import { DEFAULT_SHADCN_STYLE, effectiveShadcnStyle, transformIconPlaceholders } from './shadcn-style'
import { upstreamDependencies, withCnPackage } from './upstream-item'

// Fetches shadcn/ui registry items on demand and returns their SOURCE (the same
// .tsx the shadcn CLI would write into a project), so the isolated preview can
// resolve `@/components/ui/<name>` the same way it resolves a cross-project
// design-kit component — by evaluating the source in the frame's pool. Their
// npm `dependencies` (radix, class-variance-authority) go into the pool with
// them, like a kit item's, and ride the frame's on-demand dependency bundler;
// their `registryDependencies` (bare names of other shadcn items) are fetched
// transitively here.
//
// Nothing is hosted: items are fetched from the public registry and cached on
// disk (per style) so repeats are free.

// The STYLE is the project's (server/shadcn-style.ts), new-york-v4 unless the
// project set another. Only v4 styles are allowed, because the preview frame
// compiles Tailwind v4 (see server/preview.ts). Plain `new-york` is the
// Tailwind-v3 registry: its var shorthand (`h-[--cell-size]`) compiles under v4
// to a literal `height: --cell-size` — a declaration browsers silently drop, so
// the calendar item, for one, previews with no sizing at all under new-york (4
// of its classes compile invalid there, 0 under new-york-v4).
//
// Every style is fetched and cached on its own: the same name is a different
// item per style (base-vega's `button` wraps @base-ui/react, new-york-v4's
// wraps radix-ui), so the style is part of every key below.
function baseUrl(style: string): string {
  return `https://ui.shadcn.com/r/styles/${style}`
}

interface ShadcnItem {
  name: string
  /** source file contents (the .tsx the CLI would write) */
  files: string[]
  /** npm packages, `pkg` / `pkg@range`: the item's own, plus the ones it imports undeclared */
  dependencies: string[]
  /** bare names of other shadcn items this depends on */
  registryDependencies: string[]
}

// `null` = known-missing (404 / fetch failure) so we don't retry every render.
// Keyed `<style>::<name>`.
const memCache = new Map<string, ShadcnItem | null>()

function cacheFile(style: string, name: string): string {
  return host.path.join(host.cacheDir('shadcn-registry', style), `${name}.json`)
}

async function readCached(style: string, name: string): Promise<string | null> {
  try {
    return await host.fs.readFile(cacheFile(style, name), 'utf-8')
  } catch {
    return null
  }
}

async function fetchItem(name: string, requestedStyle: string): Promise<ShadcnItem | null> {
  // Re-checked here, at the URL: whatever a caller passes, only an allow-listed
  // style becomes a path segment or a cache directory.
  const style = effectiveShadcnStyle(requestedStyle)
  const key = `${style}::${name}`
  const cached = memCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  let raw = await readCached(style, name)
  if (raw == null) {
    try {
      const res = await fetch(`${baseUrl(style)}/${encodeURIComponent(name)}.json`)
      if (!res.ok) {
        memCache.set(key, null)
        return null
      }
      raw = await res.text()
      await host.fs.mkdir(host.path.dirname(cacheFile(style, name)), { recursive: true })
      await host.fs.writeFile(cacheFile(style, name), raw)
    } catch {
      memCache.set(key, null)
      return null
    }
  }
  try {
    const json = JSON.parse(raw) as { files?: Array<{ content?: unknown }>; dependencies?: unknown; registryDependencies?: unknown }
    // The disk cache keeps the registry's bytes; the rewrites happen on read:
    // icon placeholders (a no-op on new-york-v4, whose items import lucide
    // directly) and the utils alias (see ./upstream-item).
    const files = (json.files ?? [])
      .map((f) => f.content)
      .filter((c): c is string => typeof c === 'string')
      .map((c) => withCnPackage(transformIconPlaceholders(c)))
    const registryDependencies = Array.isArray(json.registryDependencies)
      ? json.registryDependencies.filter((d): d is string => typeof d === 'string' && /^[a-z0-9-]+$/.test(d))
      : []
    const declared = Array.isArray(json.dependencies) ? json.dependencies.filter((d): d is string => typeof d === 'string') : []
    const dependencies = upstreamDependencies(files, declared)
    const item: ShadcnItem = { name, files, dependencies, registryDependencies }
    memCache.set(key, item)
    return item
  } catch {
    memCache.set(key, null)
    return null
  }
}

// Whether a name exists as a shadcn registry item (cached). Used to decide, for
// an undeclared `@/components/ui/<name>` import, whether it's a shadcn primitive
// or the user's own kit component. Asked in the project's style: the styles'
// item sets are not identical.
export async function shadcnHas(name: string, style: string = DEFAULT_SHADCN_STYLE): Promise<boolean> {
  return (await fetchItem(name, style)) !== null
}

// Fetch (in `style`) every name plus its transitive shadcn registryDependencies, returning
// one source group per resolved item. `skip` excludes names already provided
// elsewhere (design-kit components), so a design-kit `button` isn't shadowed by
// shadcn's. Bounded so a pathological graph can't fetch forever.
export async function collectShadcnSources(
  names: string[],
  skip: (name: string) => boolean,
  style: string = DEFAULT_SHADCN_STYLE,
): Promise<{ sources: PoolGroup[]; resolved: string[]; missing: string[] }> {
  const visited = new Set<string>()
  const sources: PoolGroup[] = []
  const resolved: string[] = []
  const missing: string[] = []
  let budget = 100

  async function walk(name: string): Promise<void> {
    if (visited.has(name) || skip(name) || budget <= 0) {
      return
    }
    visited.add(name)
    budget--
    const item = await fetchItem(name, style)
    if (!item) {
      missing.push(name)
      return
    }
    if (item.files.length > 0) {
      sources.push({ files: item.files, dependencies: item.dependencies })
      resolved.push(name)
    }
    for (const dep of item.registryDependencies) {
      await walk(dep)
    }
  }

  for (const n of names) {
    await walk(n)
  }
  return { sources, resolved, missing }
}
