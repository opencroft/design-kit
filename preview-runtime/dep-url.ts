import type { NpmModule } from './declared-deps.ts'

// The frame fetches each npm dependency from the server's `dep` endpoint,
// which bundles it on demand (server/preview.ts bundleDep). Those responses
// carry `max-age=3600` and the frame's ESM loader caches by URL, so when the
// bundler's OUTPUT changes (a bug fix in how deps are built) a browser could
// keep running the old, broken bundle for up to an hour. Putting the bundler's
// version in the URL makes a changed bundler a different URL: bump
// DEP_BUNDLE_VERSION whenever bundleDep would now emit different code for the
// same package. The runtime that builds these URLs is itself served under a
// content hash (runtime.js?v=…), so a bump reaches the frame on the next load.
//
// The declared version range is part of both the URL and the key: the same
// specifier at two ranges is two bundles.
//
// The server also keys its in-memory bundle cache by it. Host-free leaf so
// both the frame runtime and node --test can import it.
//
// 2: CommonJS require() of react/react-dom inside a dep is bridged to the
//    external ESM import (server/require-bridge.ts) instead of esbuild's
//    throwing __require — @base-ui/react popover/menu/select/tooltip/dialog.
export const DEP_BUNDLE_VERSION = 2

export function depUrl({ spec, range }: NpmModule): string {
  const query = new URLSearchParams({ name: spec })
  if (range) {
    query.set('range', range)
  }
  query.set('v', String(DEP_BUNDLE_VERSION))
  return `dep?${query.toString()}`
}

export function depCacheKey({ spec, range }: NpmModule): string {
  return `${DEP_BUNDLE_VERSION}:${spec}@${range}`
}
