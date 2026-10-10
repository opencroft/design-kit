// A preview dependency the sandbox cannot resolve is UNVERIFIABLE, not broken:
// the component is fine, the check simply cannot run here. Two causes share one
// vocabulary, so a reader never meets a second word for the same idea:
//
//   'browser-global'    — the dependency reads a browser global (document,
//                         window, …) when its module is evaluated, so it cannot
//                         be imported under react-dom/server. Detected on the
//                         server validator by the load error; see validate.ts.
//   'workspace-package' — the dependency is one of the product's own shared
//                         workspace packages, whose truth lives in app code the
//                         preview's npm sandbox has no access to. Its bare name
//                         may also be a DIFFERENT public package on npm, so
//                         installing it would preview a stranger's code. These
//                         are classified from the table below BEFORE any npm
//                         attempt, for exactly that reason.
//
// Host-free: imported by the server validator, by the preview frame runtime
// (preview-runtime/entry.tsx), and by the dep route. The placeholder a matched
// specifier resolves to throws the marker WHEN RENDERED, so the verdict lands
// only on a component that actually renders the dependency (blast radius one),
// and carries the dependency's own name.

// The product's shared workspace packages, by the bare name a component imports
// them under: the unscoped packages, which are the ones a bare specifier can
// silently shadow with an unrelated public npm package. Scoped `@opencroft/*`
// packages are not listed — a bare import of one 404s on npm (a loud failure),
// not a silent shadow. This is a hand-maintained table that has to track the
// product's workspace package names; what would replace it is resolving such a
// reference through declared namespaces, by project and path, never reaching
// for npm.
const WORKSPACE_PACKAGES = new Set(['agent-chat', 'agent-client', 'ui'])

export type UnverifiableDepCause = 'browser-global' | 'workspace-package'

/** The npm package a bare specifier belongs to (`@scope/pkg` keeps both segments). */
export function depPackageName(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** A specifier whose package is one of the product's own workspace packages. */
export function isWorkspacePackageSpec(spec: string): boolean {
  return WORKSPACE_PACKAGES.has(depPackageName(spec))
}

// No real error message begins with this sentinel, so `startsWith` distinguishes
// it with certainty. The cause and the specifier ride after it, `|`-separated;
// a module specifier never contains `|`.
export const UNVERIFIABLE_DEP_MARKER = 'design-kit:unverifiable-dep:'

export function unverifiableDepError(cause: UnverifiableDepCause, spec: string): string {
  return `${UNVERIFIABLE_DEP_MARKER}${cause}|${spec}`
}

/**
 * When `error` is an unverifiable-dependency marker, the human-readable reason
 * (naming the dependency, and saying the component itself is fine); null for any
 * other error, so a genuine failure is untouched.
 */
export function unverifiableDepReason(error: string | undefined): string | null {
  if (!error?.startsWith(UNVERIFIABLE_DEP_MARKER)) {
    return null
  }
  const rest = error.slice(UNVERIFIABLE_DEP_MARKER.length)
  const bar = rest.indexOf('|')
  const cause = rest.slice(0, bar) as UnverifiableDepCause
  const spec = rest.slice(bar + 1)
  if (cause === 'workspace-package') {
    return `uses "${spec}", one of this product's own workspace packages — the preview cannot load it and will not guess at a same-named npm package, so the component itself is fine and is only verifiable where the package is installed`
  }
  return `renders "${spec}", which reads a browser global when its module is evaluated, so it cannot run under react-dom/server — verify it in the browser preview`
}

/**
 * Stand-in for an unverifiable dependency. Every export — named or default — is
 * a component that throws the marker when RENDERED, so the failure lands only on
 * a target that actually renders the dependency. The Proxy covers export names
 * that cannot be known ahead of time; symbol access (module-interop probes)
 * falls through to undefined, and so does `then` — see the trap below for why
 * that one is load-bearing rather than tidy.
 */
export function unverifiableDepModule(cause: UnverifiableDepCause, spec: string): Record<string, unknown> {
  const placeholder = () => {
    throw new Error(unverifiableDepError(cause, spec))
  }
  const exports: Record<string, unknown> = { default: placeholder }
  return new Proxy(exports, {
    get: (target, prop) => {
      // Do NOT let `then` fall through to the placeholder, however wrong the
      // exception looks next to "every export is a component".
      //
      // Answering `then` with a function makes this object a THENABLE, and
      // anything that awaits a module object — an async resolver, a dynamic
      // import, a plain `await mod` — resolves one by CALLING that function.
      // The throw would stop being render-time and become load-time, which puts
      // the failure back on every component that pools the dependency instead
      // of the single one that renders it: a whole-project blast radius.
      // Blast radius one is the entire point of throwing on render, and
      // thenability is the one way to lose it without touching anything that
      // looks related.
      //
      // Symbol access is undefined for the ordinary reason: module-interop
      // probes must not come back holding a component.
      if (typeof prop === 'symbol' || prop === 'then') {
        return undefined
      }
      return prop in target ? target[prop] : placeholder
    },
  })
}
