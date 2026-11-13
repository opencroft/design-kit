import { type Comparator, minVersion, Range, validRange } from 'semver'

import { type NpmModule, npmModuleKey } from '../preview-runtime/declared-deps.ts'
import { depPackageName } from '../preview-runtime/unverifiable-dep.ts'

// How the modules of one pool bundle are installed (server/preview.ts
// bundleDeps). Host-free, so node --test can import it.
//
// A package the pool declares at ranges one version can satisfy is installed
// once, at their intersection, into the shared prefix: as in an app, every
// component that imports it gets the same copy. An unversioned declaration
// constrains nothing. Ranges no one version satisfies (`^14` beside `^15`), or
// a declaration that is not a semver range (a dist-tag beside a range), cannot
// share a copy, so each range of that package is installed into a prefix of its
// own: every component still renders at the version it declares, and only that
// package exists more than once in the frame.

/** A package to install, at a range npm accepts. */
export interface InstallPackage {
  name: string
  range: string
}

export interface InstallPlan {
  /** The packages each npm prefix installs. The first holds every package the pool shares, and may be empty. */
  prefixes: InstallPackage[][]
  /** The prefix each module resolves from, by npmModuleKey. */
  prefixOf: Map<string, number>
}

/** The range every one of `ranges` allows ('' allows any version), or null when no version satisfies them all. */
export function sharedRange(ranges: readonly string[]): string | null {
  const constraints = [...new Set(ranges.filter(Boolean))].sort()
  if (constraints.length <= 1) {
    return constraints[0] ?? ''
  }
  // A range is a union of comparator sets, so the intersection of several is
  // the union of every choice of one set from each, joined.
  let sets: Comparator[][] = [[]]
  for (const range of constraints) {
    if (validRange(range) === null) {
      return null
    }
    sets = sets.flatMap((chosen) => new Range(range).set.map((set) => [...chosen, ...set]))
  }
  const range = validRange(sets.map((set) => set.map((comparator) => comparator.value).join(' ')).join(' || '))
  return range !== null && minVersion(range) !== null ? range : null
}

export function installPlan(modules: readonly NpmModule[]): InstallPlan {
  const rangesOf = new Map<string, Set<string>>()
  for (const { spec, range } of modules) {
    const name = depPackageName(spec)
    rangesOf.set(name, (rangesOf.get(name) ?? new Set()).add(range))
  }
  const shared: InstallPackage[] = []
  const separate: InstallPackage[] = []
  for (const name of [...rangesOf.keys()].sort()) {
    const ranges = [...(rangesOf.get(name) as Set<string>)].sort()
    const range = sharedRange(ranges)
    if (range === null) {
      separate.push(...ranges.map((declared) => ({ name, range: declared })))
    } else {
      shared.push({ name, range })
    }
  }
  const prefixOf = new Map<string, number>()
  for (const module of modules) {
    const name = depPackageName(module.spec)
    const own = separate.findIndex((p) => p.name === name && p.range === module.range)
    prefixOf.set(npmModuleKey(module), own === -1 ? 0 : own + 1)
  }
  return { prefixes: [shared, ...separate.map((p) => [p])], prefixOf }
}
