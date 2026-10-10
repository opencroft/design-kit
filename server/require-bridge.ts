import type { Plugin } from 'esbuild'

// On-demand dependency bundles (preview.ts bundleDep) are ESM with
// `react`/`react-dom`/`react/jsx-runtime` left EXTERNAL, so the frame's import
// map lands every copy on the one React the frame runtime bundled. That works
// for `import` — esbuild keeps it as an ESM import. It does NOT work for a
// CommonJS `require("react")` inside the bundle (e.g. use-sync-external-store's
// shim, pulled in by @base-ui/react's popover/menu/select/tooltip...): an
// external require in ESM output becomes esbuild's `__require("react")`, which
// in a browser throws "Dynamic require of "react" is not supported" the moment
// the CJS module initializes — so the whole dep namespace comes back empty.
//
// The fix, for every CJS dep at once rather than per package: a `require()` of
// one of those externals resolves to a tiny virtual ESM module that re-exports
// the external via a normal `import`, which esbuild keeps as the same bare ESM
// specifier the import map serves; the require then yields that namespace
// (through esbuild's own __toCommonJS interop). `import` statements of the
// externals are untouched, so a bundle with no such require is byte-identical.
//
// Host-free leaf module (type-only esbuild import) so node --test can load it.

export const REQUIRE_BRIDGE_NAMESPACE = 'design-kit-require-bridge'

// The frame's shims (preview.ts SHIMS) and the validator's stubs
// (eval-loader.ts STUB_FILES) give react, react-dom and react-dom/client a
// default export, but not the jsx runtimes — and re-exporting a `default` the
// target does not have is an ESM link error, so the bridge must know which.
export function externalHasDefault(spec: string): boolean {
  return !/\/jsx(-dev)?-runtime$/.test(spec)
}

// The bridge module's source. The named re-export covers plain CJS access
// (`require("react").useSyncExternalStore`); the default covers Babel/TS
// interop (`__esModule ? m.default : m`), which esbuild's namespace object
// signals by carrying `__esModule: true`.
export function requireBridgeSource(spec: string): string {
  const s = JSON.stringify(spec)
  return externalHasDefault(spec) ? `export * from ${s}\nexport { default } from ${s}\n` : `export * from ${s}\n`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

// Exact-match filter for the external specifiers (no subpaths beyond the ones
// listed — `react-dom/server` is not external and must not be bridged).
export function externalsFilter(externals: readonly string[]): RegExp {
  return new RegExp(`^(?:${externals.map(escapeRegExp).join('|')})$`)
}

export function requireBridgePlugin(externals: readonly string[]): Plugin {
  const filter = externalsFilter(externals)
  return {
    name: 'design-kit-require-bridge',
    setup(build) {
      build.onResolve({ filter }, (args) =>
        args.kind === 'require-call' ? { path: args.path, namespace: REQUIRE_BRIDGE_NAMESPACE } : undefined,
      )
      build.onLoad({ filter: /.*/, namespace: REQUIRE_BRIDGE_NAMESPACE }, (args) => ({
        contents: requireBridgeSource(args.path),
        loader: 'js',
      }))
    },
  }
}
