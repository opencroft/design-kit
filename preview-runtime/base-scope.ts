import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'

// Shared between the browser preview frame (entry.tsx) and the server-side
// validator (server/validate.ts) — both must eval stored sources against the
// IDENTICAL base scope, or a component that passes server validation could
// still misbehave in the real preview (or vice versa). Host-free: no
// `@opencroft/*` import, so this module works in both the esbuild-bundled
// browser frame and plain Node.

// Every evaluated source gets `React` in scope whether it imports it or not:
// the evaluator compiles JSX to `React.createElement`. Nothing else is
// injected — every other name a source uses comes from its own imports.
export const baseScope: Record<string, unknown> = { React }

// The React family, served by the runtime itself and never from a declaration
// (see REACT_FAMILY in ./declared-deps): the frame, the evaluated sources and
// every dependency bundle share this one React.
export const builtinModules: Record<string, Record<string, unknown>> = {
  react: React as unknown as Record<string, unknown>,
  'react-dom': ReactDOM as unknown as Record<string, unknown>,
  'react-dom/client': { createRoot } as unknown as Record<string, unknown>,
  'react/jsx-runtime': jsxRuntime as unknown as Record<string, unknown>,
}
