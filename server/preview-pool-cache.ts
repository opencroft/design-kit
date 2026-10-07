// When a preview pool may be handed out again, and when it has stopped being
// the truth.
//
// Assembling the pool for one component is the expensive part of opening a
// preview: it reads EVERY project, then EVERY component of every project, then
// walks the dependency closure asking the shadcn registry about each undeclared
// import. Uncached, that work is redone from scratch for every reader — the
// client action, the standalone preview route and the server-side validator —
// and redone again for the next component the author clicks, even though the
// second one is nearly always a sibling in the same project whose answer was
// already computed.
//
// So the policy lives here, apart from the builder it caches. This module
// imports nothing: no `@ext/host`, not even a relative module that chains to
// it, so the caching rules can be exercised directly with `node --test` instead
// of being argued about. server/index.ts injects the real builders.
//
// The invalidation granularity is a single GLOBAL epoch, and that is a
// deliberate refusal to be clever. A pool spans projects: a component in
// project A can pull a component out of project B through a
// registryDependencies reference or a bare `@/…` import, so a write in B
// changes what A's pool must contain. Per-project invalidation would have to
// know the closure to know which projects to drop — and the closure is exactly
// what the cache is holding instead of recomputing. An honest global bump
// throws away more than strictly necessary; a clever per-project one would
// serve a preview that is quietly missing a dependency's latest source, which
// is the failure the author would blame on their own code.
//
// A rejected build is NEVER cached. A pool build fails on a transient read, and
// a cached rejection would turn one bad moment into a preview that stays broken
// until the next write — with nothing the author could do to retry it.

// The KEY is the caller's to choose, and it must name everything the builder
// reads and nothing else. Naming less serves one caller another's answer;
// naming more — a component name a project-wide builder never looks at — stores
// the identical pool under N keys, so the first open of every component of a
// project pays a full build and the heap holds N copies of that project's
// source. See server/index.ts for the key in force and why.
export interface PreviewPoolCacheDeps<Pool, Shared> {
  /** The real, uncached pool build — injected so this module stays host-free. */
  buildPool(key: string): Promise<Pool>
  /**
   * The expensive prefix every pool build shares: the project list plus each
   * project's components. Memoized on the same epoch as the pools, because it
   * goes stale for exactly the same reasons and at exactly the same moments.
   */
  buildShared(): Promise<Shared>
}

export interface PreviewPoolCache<Pool, Shared> {
  /** The pool under a key, built once per epoch per key. */
  pool(key: string): Promise<Pool>
  /** The shared prefix, built once per epoch. */
  shared(): Promise<Shared>
  /** Drop everything: the next reader of anything rebuilds. */
  invalidate(): void
  /**
   * Prepare a pool in the background so the next reader gets a hit. Returns
   * nothing and throws nothing — a warm is an optimization, and the caller
   * (a publish that already succeeded) must not be delayed or failed by it.
   */
  warm(key: string): void
  /** The current revision. Observable so a test can state what changed. */
  readonly epoch: number
}

/** One memoized promise, tagged with the epoch it was started under. */
interface Entry<V> {
  epoch: number
  value: Promise<V>
}

export function createPreviewPoolCache<Pool, Shared>(deps: PreviewPoolCacheDeps<Pool, Shared>): PreviewPoolCache<Pool, Shared> {
  let epoch = 0
  const pools = new Map<string, Entry<Pool>>()
  let sharedEntry: Entry<Shared> | undefined

  // The in-flight promise is what gets stored, not the resolved value: two
  // readers arriving together (the client action and the validator, or several
  // preview frames mounting at once) then SHARE one build instead of racing two
  // identical ones and throwing one away.
  const remember = <V>(start: () => Promise<V>, keep: (entry: Entry<V>) => void, forget: (entry: Entry<V>) => void): Promise<V> => {
    const entry: Entry<V> = { epoch, value: start() }
    keep(entry)
    // Evict on rejection, and do it here rather than at the next read so the
    // retry is available immediately. The handler is attached before the
    // caller's own, so a caller that reacts to the failure by asking again
    // already finds the slot empty. The `catch` also keeps a warm's failure
    // from surfacing as an unhandled rejection.
    entry.value.catch(() => forget(entry))
    return entry.value
  }

  const pool = (key: string): Promise<Pool> => {
    const hit = pools.get(key)
    // An entry from an older epoch is not a hit: it was built from components
    // that have since been written, so serving it would show the author the
    // code they just replaced.
    if (hit && hit.epoch === epoch) {
      return hit.value
    }
    return remember(
      () => deps.buildPool(key),
      (entry) => pools.set(key, entry),
      (entry) => {
        // Only if the slot is still OURS: an invalidate plus a fresh build may
        // have replaced it while the failed one was settling, and deleting then
        // would throw away a good entry.
        if (pools.get(key) === entry) {
          pools.delete(key)
        }
      },
    )
  }

  const shared = (): Promise<Shared> => {
    if (sharedEntry && sharedEntry.epoch === epoch) {
      return sharedEntry.value
    }
    return remember(
      () => deps.buildShared(),
      (entry) => {
        sharedEntry = entry
      },
      (entry) => {
        if (sharedEntry === entry) {
          sharedEntry = undefined
        }
      },
    )
  }

  // Closures over the state rather than methods reading `this`: call sites
  // destructure what they need out of this cache, and a `this`-dependent method
  // would break the moment one did.
  return {
    get epoch() {
      return epoch
    },
    pool,
    shared,
    invalidate: (): void => {
      epoch += 1
      // Cleared as well as out-dated: the epoch tag alone would be enough for
      // correctness, but every pool holds the full source text of a project,
      // and keeping the superseded copies is how a long-lived server grows a
      // heap nobody asked for.
      pools.clear()
      sharedEntry = undefined
    },
    warm: (key: string): void => {
      // Deliberately not awaited and deliberately silent. The failure a warm
      // can hit is one the next real reader will hit too, and that reader has
      // somebody to report it to.
      void pool(key).catch(() => {})
    },
  }
}
