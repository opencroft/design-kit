import { randomUUID } from 'node:crypto'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'

// npm deps the preview pool imports are bundled the same way the browser
// `preview/dep` endpoint does (esbuild → ESM string) — the exact bundle a
// real preview frame would fetch. That bundle deliberately leaves
// `react`/`react-dom`/`react/jsx-runtime` as bare imports (see bundleDep's
// `external`), because the browser frame resolves those through its own
// import map onto the frame's shared React instead of a second copy — a
// second copy means a component's hooks run against a dispatcher the
// rendering React never set, which is a null-dispatcher crash
// ("Cannot read properties of null (reading 'useMemo')"), not a silent one.
//
// A real file resolves those bare specifiers via Node's ordinary node_modules
// walk, but "resolves" isn't "resolves to the SAME instance validate.ts
// renders with": walking up from wherever this file happens to sit can land
// on any react on the way, not necessarily the one this extension's own
// server bundle was compiled against. The browser frame avoids exactly this
// with an import map (see preview.ts's SHIMS/IMPORT_MAP); Node has no native
// import-map equivalent, but ordinary node_modules resolution already prefers
// the CLOSEST ancestor node_modules over a further one — so writing stub
// `react`/`react-dom`/etc. packages into a node_modules right next to the
// eval temp files, each just forwarding to this module's own live imports
// via a global (mirroring the browser shim's `globalThis.__designKitPreview`
// pattern exactly), pins the dep bundle to the SAME instance unconditionally.
const EVAL_TMP_DIR = path.join(process.cwd(), '.eval-tmp')
const STUB_NODE_MODULES = path.join(EVAL_TMP_DIR, 'node_modules')

;(globalThis as Record<string, unknown>).__designKitEvalHost = {
  React,
  ReactDOM,
  ReactDOMClient: { createRoot },
  jsxRuntime,
}

// Mirrors preview.ts's REACT_EXPORTS -- the browser shim's own list of names
// an `import * as X from 'react'` needs available as properties of X, since
// an ESM namespace import can't be populated dynamically from a runtime
// object; it has to come from a real `export const` list.
const REACT_EXPORTS = [
  'useState',
  'useEffect',
  'useCallback',
  'useMemo',
  'useRef',
  'useContext',
  'useReducer',
  'useId',
  'useLayoutEffect',
  'useSyncExternalStore',
  'useTransition',
  'useDeferredValue',
  'useImperativeHandle',
  'useDebugValue',
  'useInsertionEffect',
  'startTransition',
  'createElement',
  'createContext',
  'createRef',
  'forwardRef',
  'memo',
  'lazy',
  'Component',
  'PureComponent',
  'version',
  'Fragment',
  'Suspense',
  'StrictMode',
  'Children',
  'cloneElement',
  'isValidElement',
]

const STUB_PRELUDE = `const g = globalThis.__designKitEvalHost;\nif (!g) { throw new Error('design-kit eval host not booted'); }\n`

const STUB_FILES: Record<string, string> = {
  'react/package.json': JSON.stringify({
    name: 'react',
    version: '0.0.0',
    type: 'module',
    main: './index.mjs',
    exports: { '.': './index.mjs', './jsx-runtime': './jsx-runtime.mjs', './jsx-dev-runtime': './jsx-runtime.mjs' },
  }),
  'react/index.mjs': `${STUB_PRELUDE}const R = g.React;\nexport default R.default ?? R;\nexport const { ${REACT_EXPORTS.join(', ')} } = R;\n`,
  'react/jsx-runtime.mjs': `${STUB_PRELUDE}export const { jsx, jsxs, Fragment } = g.jsxRuntime;\nexport const jsxDEV = g.jsxRuntime.jsx;\n`,
  'react-dom/package.json': JSON.stringify({
    name: 'react-dom',
    version: '0.0.0',
    type: 'module',
    main: './index.mjs',
    exports: { '.': './index.mjs', './client': './client.mjs' },
  }),
  'react-dom/index.mjs': `${STUB_PRELUDE}const D = g.ReactDOM;\nexport default D.default ?? D;\nexport const { createPortal, flushSync } = D;\n`,
  'react-dom/client.mjs': `${STUB_PRELUDE}export const createRoot = g.ReactDOMClient.createRoot;\nexport default g.ReactDOMClient;\n`,
}

let stubsReady: Promise<void> | null = null

// Static content -- written once per process, not per loadDep call. Guarded
// by a marker file's presence rather than blindly overwriting every time, the
// same "check, then write" shape ensureInstalled() uses for npm deps.
async function ensureStubs(): Promise<void> {
  const marker = path.join(STUB_NODE_MODULES, 'react', 'package.json')
  try {
    await access(marker)
    return
  } catch {
    // fall through to (re)write
  }
  await Promise.all(
    Object.entries(STUB_FILES).map(async ([rel, content]) => {
      const dest = path.join(STUB_NODE_MODULES, rel)
      await mkdir(path.dirname(dest), { recursive: true })
      await writeFile(dest, content, 'utf8')
    }),
  )
}

// An imported ES module is never unloaded, so importing the same bundle again
// for every validation grows the server process by the bundle's size each
// time. One import per distinct bundle, keyed by its code: identical code is
// the identical module. A failed import is not kept, so the next call retries.
const loaded = new Map<string, Promise<Record<string, unknown>>>()

export function loadDep(bundled: string): Promise<Record<string, unknown>> {
  let pending = loaded.get(bundled)
  if (!pending) {
    pending = importBundle(bundled)
    loaded.set(bundled, pending)
    pending.catch(() => loaded.delete(bundled))
  }
  return pending
}

async function importBundle(bundled: string): Promise<Record<string, unknown>> {
  if (!stubsReady) {
    stubsReady = ensureStubs()
  }
  await stubsReady
  const file = path.join(EVAL_TMP_DIR, `${randomUUID()}.mjs`)
  try {
    await writeFile(file, bundled, 'utf8')
    return await import(`file://${file}`)
  } finally {
    await rm(file, { force: true })
  }
}
