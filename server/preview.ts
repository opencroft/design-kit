import { cacheDir } from '@opencroft/server/storage'
import { execFile, fs, path } from '@opencroft/server/system'

import type { NpmModule } from '../preview-runtime/declared-deps'
import { depCacheKey } from '../preview-runtime/dep-url'
import type { PoolGroup } from '../preview-runtime/protocol'
import { depPackageName, isWorkspacePackageSpec } from '../preview-runtime/unverifiable-dep'
import { docFilesOf, isResolved, resolvePreviewTarget } from './preview-target'
import { requireBridgePlugin } from './require-bridge'
import { effectiveShadcnStyle, shadcnStyleCss } from './shadcn-style'

// Isolated preview backend. Serves, under /http/preview/…:
//   preview               the iframe shell (theme CSS + import map + scripts)
//   preview/runtime.js    the frame app: real React + the eval engine
//                         (preview-runtime/entry.tsx, esbuild-bundled at runtime)
//   preview/tailwind.js   @tailwindcss/browser — compiles utilities inside the
//                         frame, so arbitrary classes in stored designs work
//   preview/shim/*.js     ESM shims mapping react/react-dom (via the shell's
//                         import map) onto the frame runtime's copies
//   preview/dep           npm dependency at a version range → browser ESM,
//                         bundled on demand
//   preview/data          a component's sources for standalone (new-tab) mode
//
// The loader executes the server bundle with __dirname = the extension root,
// so node_modules/ and preview-runtime/ resolve from there.
declare const __dirname: string

// ── injected storage access ──────────────────────────────────────────
// index.ts owns the storage-backed readers (and the instance-repo ones); it
// passes them in to avoid a circular import.

export interface PreviewStoredFile {
  path: string
  target: string
  type: string
  content: string
}

export interface PreviewStoredComponent {
  name: string
  type: string
  exportName: string
  dependencies?: string[]
  files?: PreviewStoredFile[]
  source?: string
}

export interface PreviewProject {
  id: string
  name: string
  theme?: ProjectTheme
}

export interface ProjectTheme {
  /** one of THEME_PRESETS ids */
  preset?: string
  /** custom token CSS (`:root { … } .dark { … }`); overrides `preset` when set */
  css?: string
  /** the shadcn registry style `@/components/ui/*` resolves against (see
   *  server/shadcn-style.ts); absent means the default, new-york-v4 */
  shadcnStyle?: string
}

export interface PreviewDeps {
  readComponentsViaDb(projectId: string): Promise<PreviewStoredComponent[]>
  readProjectsViaDb(): Promise<PreviewProject[]>
  resolveProject(param: string): Promise<{ id: string; ns: string }>
  componentFiles(c: PreviewStoredComponent): PreviewStoredFile[]
  // The full eval-pool closure for a component (project + cross-project +
  // shadcn). Used by the standalone data route; the embedded preview fetches
  // the same closure via the `preview.sources` action.
  buildPreviewSources(projectId: string, component: string): Promise<PoolGroup[]>
}

// ── shadcn default themes ────────────────────────────────────────────
// Generated with shadcn's own base-color formula over Tailwind's gray ramps
// (values taken verbatim from tailwindcss/theme.css), so the presets match
// what `shadcn init` ships. Standard token names only — previews and installed
// components read the exact variables a shadcn app defines.

type Ramp = Record<50 | 100 | 200 | 400 | 500 | 800 | 900 | 950, string>

const RAMPS: Record<string, Ramp> = {
  neutral: {
    50: 'oklch(98.5% 0 0)',
    100: 'oklch(97% 0 0)',
    200: 'oklch(92.2% 0 0)',
    400: 'oklch(70.8% 0 0)',
    500: 'oklch(55.6% 0 0)',
    800: 'oklch(26.9% 0 0)',
    900: 'oklch(20.5% 0 0)',
    950: 'oklch(14.5% 0 0)',
  },
  zinc: {
    50: 'oklch(98.5% 0 0)',
    100: 'oklch(96.7% 0.001 286.375)',
    200: 'oklch(92% 0.004 286.32)',
    400: 'oklch(70.5% 0.015 286.067)',
    500: 'oklch(55.2% 0.016 285.938)',
    800: 'oklch(27.4% 0.006 286.033)',
    900: 'oklch(21% 0.006 285.885)',
    950: 'oklch(14.1% 0.005 285.823)',
  },
  slate: {
    50: 'oklch(98.4% 0.003 247.858)',
    100: 'oklch(96.8% 0.007 247.896)',
    200: 'oklch(92.9% 0.013 255.508)',
    400: 'oklch(70.4% 0.04 256.788)',
    500: 'oklch(55.4% 0.046 257.417)',
    800: 'oklch(27.9% 0.041 260.031)',
    900: 'oklch(20.8% 0.042 265.755)',
    950: 'oklch(12.9% 0.042 264.695)',
  },
  gray: {
    50: 'oklch(98.5% 0.002 247.839)',
    100: 'oklch(96.7% 0.003 264.542)',
    200: 'oklch(92.8% 0.006 264.531)',
    400: 'oklch(70.7% 0.022 261.325)',
    500: 'oklch(55.1% 0.027 264.364)',
    800: 'oklch(27.8% 0.033 256.848)',
    900: 'oklch(21% 0.034 264.665)',
    950: 'oklch(13% 0.028 261.692)',
  },
  stone: {
    50: 'oklch(98.5% 0.001 106.423)',
    100: 'oklch(97% 0.001 106.424)',
    200: 'oklch(92.3% 0.003 48.717)',
    400: 'oklch(70.9% 0.01 56.259)',
    500: 'oklch(55.3% 0.013 58.071)',
    800: 'oklch(26.8% 0.007 34.298)',
    900: 'oklch(21.6% 0.006 56.043)',
    950: 'oklch(14.7% 0.004 49.25)',
  },
}

const WHITE = 'oklch(1 0 0)'
const DESTRUCTIVE_LIGHT = 'oklch(0.577 0.245 27.325)'
const DESTRUCTIVE_DARK = 'oklch(0.704 0.191 22.216)'
const CHART_LIGHT = [
  'oklch(0.646 0.222 41.116)',
  'oklch(0.6 0.118 184.704)',
  'oklch(0.398 0.07 227.392)',
  'oklch(0.828 0.189 84.429)',
  'oklch(0.769 0.188 70.08)',
]
const CHART_DARK = [
  'oklch(0.488 0.243 264.376)',
  'oklch(0.696 0.17 162.48)',
  'oklch(0.769 0.188 70.08)',
  'oklch(0.627 0.265 303.9)',
  'oklch(0.645 0.246 16.439)',
]

function block(selector: string, tokens: Record<string, string>): string {
  return `${selector} {\n${Object.entries(tokens)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join('\n')}\n}`
}

export function presetCss(preset: string): string {
  const c = RAMPS[preset] ?? RAMPS[DEFAULT_PRESET]
  const light: Record<string, string> = {
    radius: '0.625rem',
    background: WHITE,
    foreground: c[950],
    card: WHITE,
    'card-foreground': c[950],
    popover: WHITE,
    'popover-foreground': c[950],
    primary: c[900],
    'primary-foreground': c[50],
    secondary: c[100],
    'secondary-foreground': c[900],
    muted: c[100],
    'muted-foreground': c[500],
    accent: c[100],
    'accent-foreground': c[900],
    destructive: DESTRUCTIVE_LIGHT,
    border: c[200],
    input: c[200],
    ring: c[400],
    'chart-1': CHART_LIGHT[0],
    'chart-2': CHART_LIGHT[1],
    'chart-3': CHART_LIGHT[2],
    'chart-4': CHART_LIGHT[3],
    'chart-5': CHART_LIGHT[4],
    sidebar: c[50],
    'sidebar-foreground': c[950],
    'sidebar-primary': c[900],
    'sidebar-primary-foreground': c[50],
    'sidebar-accent': c[100],
    'sidebar-accent-foreground': c[900],
    'sidebar-border': c[200],
    'sidebar-ring': c[400],
  }
  const dark: Record<string, string> = {
    background: c[950],
    foreground: c[50],
    card: c[900],
    'card-foreground': c[50],
    popover: c[900],
    'popover-foreground': c[50],
    primary: c[200],
    'primary-foreground': c[900],
    secondary: c[800],
    'secondary-foreground': c[50],
    muted: c[800],
    'muted-foreground': c[400],
    accent: c[800],
    'accent-foreground': c[50],
    destructive: DESTRUCTIVE_DARK,
    border: `${WHITE.slice(0, -1)} / 10%)`,
    input: `${WHITE.slice(0, -1)} / 15%)`,
    ring: c[500],
    'chart-1': CHART_DARK[0],
    'chart-2': CHART_DARK[1],
    'chart-3': CHART_DARK[2],
    'chart-4': CHART_DARK[3],
    'chart-5': CHART_DARK[4],
    sidebar: c[900],
    'sidebar-foreground': c[50],
    'sidebar-primary': CHART_DARK[0],
    'sidebar-primary-foreground': c[50],
    'sidebar-accent': c[800],
    'sidebar-accent-foreground': c[50],
    'sidebar-border': `${WHITE.slice(0, -1)} / 10%)`,
    'sidebar-ring': c[500],
  }
  return `${block(':root', light)}\n\n${block('.dark', dark)}`
}

export const DEFAULT_PRESET = 'neutral'

export const THEME_PRESETS = Object.keys(RAMPS).map((id) => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
  css: presetCss(id),
}))

export function resolveThemeCss(theme: ProjectTheme | undefined): string {
  if (theme?.css?.trim()) {
    return theme.css
  }
  return presetCss(theme?.preset ?? DEFAULT_PRESET)
}

// The standard shadcn v4 globals.css plumbing appended after the tokens: the
// dark variant, the token → utility mapping, and the app-level base styles.
// Kept out of the editable custom CSS so a theme edit can't break the wiring.
const THEME_WIRING = `
@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

@layer base {
  * {
    border-color: var(--color-border);
    outline-color: color-mix(in oklab, var(--color-ring) 50%, transparent);
  }
  body {
    margin: 0;
    background: var(--background);
    color: var(--foreground);
  }
}
`

// ── runtime + asset serving ──────────────────────────────────────────

function jsResponse(code: string, immutable: boolean): Response {
  return new Response(code, {
    status: 200,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// esbuild is a declared dependency, so the compiler externalizes it and the
// loader resolves it from the extension's own node_modules at require time.
async function loadEsbuild(): Promise<typeof import('esbuild')> {
  return import('esbuild')
}

let runtimeCache: { code: string; hash: string } | null = null

// Bundle preview-runtime/entry.tsx once per server-module lifetime. Source
// edits bump the extension mtime, which reloads this whole module — so the
// cache can't go stale.
async function buildRuntime(): Promise<{ code: string; hash: string }> {
  if (runtimeCache) {
    return runtimeCache
  }
  const esbuild = await loadEsbuild()
  const entry = path.join(__dirname, 'preview-runtime', 'entry.tsx')
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    absWorkingDir: __dirname,
  })
  const code = result.outputFiles[0].text
  runtimeCache = { code, hash: contentHash(code) }
  return runtimeCache
}

// Cache-busting only (the ?v= query param), not integrity — FNV-1a is plenty.
function contentHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

let tailwindCache: string | null = null

async function readTailwindBrowser(): Promise<string> {
  if (tailwindCache == null) {
    const file = path.join(__dirname, 'node_modules', '@tailwindcss', 'browser', 'dist', 'index.global.js')
    tailwindCache = await fs.readFile(file, 'utf-8')
  }
  return tailwindCache
}

// ESM shims behind the shell's import map: on-demand dependency bundles import
// react/react-dom as bare specifiers, which must land on the SAME React the
// frame runtime bundled (a second copy = "invalid hook call").
const SHIM_PRELUDE = `const g = globalThis.__designKitPreview;\nif (!g) { throw new Error('design-kit preview runtime not booted'); }\n`

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

const SHIMS: Record<string, string> = {
  'shim/react.js': `${SHIM_PRELUDE}const R = g.React;\nexport default R.default ?? R;\nexport const { ${REACT_EXPORTS.join(', ')} } = R;\n`,
  'shim/react-dom.js': `${SHIM_PRELUDE}const D = g.ReactDOM;\nexport default D.default ?? D;\nexport const { createPortal, flushSync } = D;\n`,
  'shim/react-dom-client.js': `${SHIM_PRELUDE}export const createRoot = g.ReactDOMClient.createRoot;\nexport default g.ReactDOMClient;\n`,
  'shim/jsx-runtime.js': `${SHIM_PRELUDE}export const { jsx, jsxs, Fragment } = g.jsxRuntime;\nexport const jsxDEV = g.jsxRuntime.jsx;\n`,
}

const IMPORT_MAP = JSON.stringify({
  imports: {
    react: './shim/react.js',
    'react-dom': './shim/react-dom.js',
    'react-dom/client': './shim/react-dom-client.js',
    'react/jsx-runtime': './shim/jsx-runtime.js',
    'react/jsx-dev-runtime': './shim/jsx-runtime.js',
  },
})

// ── on-demand dependency bundling ────────────────────────────────────

// npm package specifier, optionally with a subpath: `marked`, `@scope/pkg`,
// `pkg/subpath`.
const SPEC_RE = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*(\/[\w.~/-]+)?$/i

// A semver range or a dist-tag (`^1.2.3`, `>=1 <2`, `1.x || 2.x`, `latest`).
// No `:` and no `/`: npm reads `pkg@file:…`, `pkg@git+https://…` and
// `pkg@user/repo` as sources to fetch from rather than versions.
const RANGE_RE = /^[\w.^~<>=|* +-]{0,64}$/

// One npm prefix per package and range. Two ranges of one package cannot share
// a node_modules, and a package installed for one range must not satisfy
// another. The root holds nothing but these prefixes, so esbuild's upward
// node_modules walk from one prefix never reaches another's packages.
function installDir({ spec, range }: NpmModule): string {
  return cacheDir('preview-npm', encodeURIComponent(`${depPackageName(spec)}@${range}`))
}

const installInFlight = new Map<string, Promise<void>>()
// Keyed by depCacheKey (bundler version + spec + range). Only bundles live
// here — the install dirs hold installed packages, never built output — so a
// deploy (module reload) always rebuilds; the version in the key and in the
// frame's dep URL (preview-runtime/dep-url.ts) is what keeps browsers from
// reusing a bundle an older bundler built.
const depBundleCache = new Map<string, string>()

// Left as bare ESM imports for the frame's import map (see IMPORT_MAP). A
// CommonJS require() of one of these is bridged, not left to esbuild's
// throwing __require — see server/require-bridge.ts.
const DEP_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client']

// npm takes no cross-invocation lock on its own cache, and two `npm install`s
// into one prefix at once corrupt each other's trees (partial writes, missing
// files). The frame requests many deps in parallel, so serialize every install
// onto a single chain — only one npm runs at a time.
let installQueue: Promise<unknown> = Promise.resolve()

async function ensureInstalled(module: NpmModule): Promise<void> {
  const pkg = depPackageName(module.spec)
  const depsDir = installDir(module)
  const installed = path.join(depsDir, 'node_modules', pkg, 'package.json')
  const present = async (): Promise<boolean> => {
    try {
      await fs.access(installed)
      return true
    } catch {
      return false
    }
  }
  if (await present()) {
    return
  }
  let pending = installInFlight.get(depsDir)
  if (!pending) {
    const run = installQueue.then(async () => {
      // Re-check under the lock: a queued install — or another package pulling
      // this one transitively — may have satisfied it while we waited.
      if (await present()) {
        return
      }
      await fs.mkdir(depsDir, { recursive: true })
      const manifest = path.join(depsDir, 'package.json')
      try {
        await fs.access(manifest)
      } catch {
        await fs.writeFile(manifest, JSON.stringify({ name: 'design-kit-preview-deps', private: true }))
      }
      // --ignore-scripts: bundling for the browser only ever reads files
      // (esbuild), never executes the package — running install/postinstall
      // scripts for an arbitrary URL-supplied package name would make this a
      // remote code-execution primitive.
      await execFile('npm', [
        'install',
        module.range ? `${pkg}@${module.range}` : pkg,
        '--prefix',
        depsDir,
        '--save',
        '--legacy-peer-deps',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--loglevel=error',
      ])
    })
    // Keep the chain alive even if this install throws.
    installQueue = run.catch(() => {})
    pending = run.finally(() => installInFlight.delete(depsDir))
    installInFlight.set(depsDir, pending)
  }
  await pending
}

// Exported for server/validate.ts: the server-side validator loads npm deps
// through this exact same esbuild bundling path (see loadDep there), so it
// checks the identical dependency code the browser preview would fetch.
export async function bundleDep(module: NpmModule): Promise<string> {
  const { spec, range } = module
  // A product workspace package is never installed from npm: its bare name can
  // shadow an unrelated public package, and installing that would bundle a
  // stranger's code as ours. Callers classify these as unverifiable before they
  // get here; this is the fail-loud floor if one slips through.
  if (isWorkspacePackageSpec(spec)) {
    throw new Error(`"${spec}" names a product workspace package, which the preview never installs from npm`)
  }
  // The range reaches npm as part of an install argument; see RANGE_RE.
  if (!RANGE_RE.test(range)) {
    throw new Error(`"${range}" is not a version range`)
  }
  const cacheKey = depCacheKey(module)
  const cached = depBundleCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const depsDir = installDir(module)
  await ensureInstalled(module)
  const esbuild = await loadEsbuild()
  // Re-export wrapper so both named and default/CJS exports survive.
  const contents = `import * as __m from ${JSON.stringify(spec)}\nexport * from ${JSON.stringify(spec)}\nexport default (__m && __m.default !== undefined ? __m.default : __m)\n`
  const result = await esbuild.build({
    stdin: { contents, resolveDir: depsDir, loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    external: DEP_EXTERNALS,
    plugins: [requireBridgePlugin(DEP_EXTERNALS)],
    loader: { '.css': 'empty' },
    nodePaths: [path.join(depsDir, 'node_modules')],
  })
  const code = result.outputFiles[0].text
  depBundleCache.set(cacheKey, code)
  return code
}

// ── routes ───────────────────────────────────────────────────────────

export function createPreviewRoutes(deps: PreviewDeps): Record<string, (req: Request) => Promise<Response>> {
  async function shellRoute(req: Request): Promise<Response> {
    const url = new URL(req.url)
    // The shell references its subresources (tailwind.js, runtime.js, data,
    // dep) by RELATIVE url, so the document must live at `.../preview/` —
    // without the trailing slash the browser resolves them as siblings of
    // `preview` and every load 404s. Canonicalize instead of 404ing.
    if (!url.pathname.endsWith('/')) {
      return new Response(null, { status: 308, headers: { location: `${url.pathname}/${url.search}` } })
    }
    const project = url.searchParams.get('project') ?? ''
    const dark = url.searchParams.get('dark') === '1'
    const { id } = await deps.resolveProject(project)
    const projects = await deps.readProjectsViaDb()
    const proj = projects.find((p) => p.id === id)
    // `<` has no business inside token CSS — dropping it keeps user-authored
    // custom themes from closing the <style> tag.
    const rawTokens = resolveThemeCss(proj?.theme).replace(/</g, '')
    // Hoist top-level `@import url(...)` lines (webfonts etc.) out of the
    // text/tailwindcss block into a plain stylesheet: the in-browser tailwind
    // compiler can't fetch external imports, but native CSS can — this lets a
    // project's theme CSS load the same fonts its real site does.
    const importLines: string[] = []
    const tokens = rawTokens.replace(/^\s*@import\s+url\([^)\n]*\)[^;\n]*;\s*$/gm, (line) => {
      importLines.push(line.trim())
      return ''
    })
    const importStyle = importLines.length ? `<style>\n${importLines.join('\n')}\n</style>\n` : ''
    // The create-era styles' custom variants (`data-open:` …), compiled in the
    // same block so their classes emit rules; empty for new-york-v4, so a
    // project on the default style gets a byte-identical shell.
    const styleCss = shadcnStyleCss(effectiveShadcnStyle(proj?.theme?.shadcnStyle))
    const { hash } = await buildRuntime()
    const html = `<!doctype html>
<html${dark ? ' class="dark"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script type="importmap">${IMPORT_MAP}</script>
${importStyle}<script src="tailwind.js?v=${hash}"></script>
<style type="text/tailwindcss">
${tokens}
${THEME_WIRING}${styleCss ? `\n${styleCss}` : ''}
</style>
<script type="module" src="runtime.js?v=${hash}"></script>
</head>
<body><div id="root"></div></body>
</html>`
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  async function runtimeRoute(): Promise<Response> {
    const { code } = await buildRuntime()
    return jsResponse(code, true)
  }

  async function tailwindRoute(): Promise<Response> {
    return jsResponse(await readTailwindBrowser(), true)
  }

  async function depRoute(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const spec = url.searchParams.get('name') ?? ''
    const range = url.searchParams.get('range') ?? ''
    if (!RANGE_RE.test(range)) {
      return jsonResponse({ error: `Invalid version range: ${range}` }, 400)
    }
    // SPEC_RE's subpath group admits `.`/`..` segments (e.g.
    // `marked/../../../etc/passwd`), which packageName() strips down to a
    // valid-looking package name while esbuild still resolves the full
    // (traversing) specifier — an arbitrary-file-read primitive. Reject any
    // spec containing a `.` or `..` path segment outright.
    if (!SPEC_RE.test(spec) || spec.split('/').some((segment) => segment === '.' || segment === '..')) {
      return jsonResponse({ error: `Invalid package specifier: ${spec}` }, 400)
    }
    try {
      return jsResponse(await bundleDep({ spec, range }), false)
    } catch (e) {
      return jsonResponse({ error: `Failed to bundle ${spec}: ${e instanceof Error ? e.message : String(e)}` }, 500)
    }
  }

  async function dataRoute(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const project = url.searchParams.get('project') ?? ''
    const component = url.searchParams.get('component') ?? ''
    // Which block of the doc page to open on. Absent means the component's main
    // preview, so a link without the parameter keeps opening it. See
    // server/preview-target.ts for why this is a NAME and never the code itself.
    const target = url.searchParams.get('target')
    const { id } = await deps.resolveProject(project)
    const comps = await deps.readComponentsViaDb(id)
    const comp = comps.find((c) => c.name === component)
    if (!comp) {
      return jsonResponse({ error: `Component "${component}" not found.` }, 404)
    }
    const sources = await deps.buildPreviewSources(id, component)
    const dependencies = comp.dependencies ?? []
    const docs = docFilesOf(deps.componentFiles(comp))
    const resolved = resolvePreviewTarget(docs['doc.mdx'] ?? '', docs, target)
    if (!isResolved(resolved)) {
      // A target that was ASKED FOR and does not exist is a refusal — the
      // reader followed a link to a specific block and must not be shown a
      // different one. With no target asked for there is nothing to refuse:
      // that is a component with no doc page, and the frame falls back to
      // rendering the export bare (see preview-runtime/entry.tsx).
      if (target) {
        return jsonResponse({ error: resolved.error, available: resolved.available }, 404)
      }
      // A component whose `docs/preview.tsx` no document points at still opens
      // on it. Below that, `null` — the frame renders the export bare.
      const bare = docs['preview.tsx'] ?? null
      return jsonResponse({
        sources,
        target: null,
        mode: 'default-export',
        code: bare,
        props: {},
        exportName: comp.exportName,
        dependencies,
      })
    }
    return jsonResponse({
      sources,
      target: resolved.target,
      mode: resolved.mode,
      code: resolved.code,
      props: resolved.props ?? {},
      exportName: comp.exportName,
      dependencies,
    })
  }

  const routes: Record<string, (req: Request) => Promise<Response>> = {
    preview: shellRoute,
    'preview/runtime.js': runtimeRoute,
    'preview/tailwind.js': tailwindRoute,
    'preview/dep': depRoute,
    'preview/data': dataRoute,
  }
  for (const [key, code] of Object.entries(SHIMS)) {
    routes[`preview/${key}`] = async () => jsResponse(code, false)
  }
  return routes
}
