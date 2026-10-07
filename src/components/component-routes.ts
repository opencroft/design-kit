// A component's addresses inside the Design Kit App. The App is one project,
// so a path names only the component: `/component/<name>` is its doc page and
// `/component/<name>/preview` its standalone preview, with a block of the doc
// named after it (`/component/<name>/preview/example:examples/sizes.tsx`).
// Everything here is App-relative, the form the host's App router takes.
//
// The block names are the validator's (see server/preview-target.ts), so a
// target a check reports and a target a reader opens are the same string.
//
// Host-free, so it is exercised directly by the unit tests.

const COMPONENT = 'component'
const PREVIEW = 'preview'
const VIEW_PARAM = 'view'
const EDITOR_VIEW = 'editor'

// The query key of the legacy address form, `?component=<project>.<name>`.
// Read only so that such a link can be moved to the path it means.
const LEGACY_COMPONENT_PARAM = 'component'

export type ComponentRoute =
  | { page: 'library' }
  | { page: 'component'; name: string }
  | { page: 'preview'; name: string; target: string | null }
  | { page: 'unknown'; path: string }

// A block name reads `<kind>:<docs-relative path>`: the colon and the slashes
// stay as they are, so the address reads like the name it carries.
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** The App path of a component's doc page. */
export function componentAppPath(name: string): string {
  return `/${COMPONENT}/${encodeSegment(name)}`
}

/** The App path of a component's standalone preview, on one block of its doc when `target` is given. */
export function previewAppPath(name: string, target?: string | null): string {
  const path = `${componentAppPath(name)}/${PREVIEW}`
  return target ? `${path}/${target.split('/').map(encodeSegment).join('/')}` : path
}

/** The page an App path names. */
export function componentRouteOf(appPath: string): ComponentRoute {
  const segments = appPath.split('/').filter(Boolean).map(decodeSegment)
  if (segments.length === 0) {
    return { page: 'library' }
  }
  const [head, name, sub, ...rest] = segments
  if (head === COMPONENT && name) {
    if (sub === undefined) {
      return { page: 'component', name }
    }
    if (sub === PREVIEW) {
      return { page: 'preview', name, target: rest.length > 0 ? rest.join('/') : null }
    }
  }
  return { page: 'unknown', path: `/${segments.join('/')}` }
}

/**
 * The App path a link written into a doc leads to, when it leads into this App
 * — `base` is the App's own address, `origin` the page's, so a link written
 * with the host in it counts too. Null for anything else, and for a path that
 * climbs with `.` or `..`, which the App router refuses to take.
 */
export function inAppPath(href: string, base: string, origin: string): string | null {
  const local = href.startsWith(`${origin}/`) ? href.slice(origin.length) : href
  const rest = local === base ? '/' : local.startsWith(`${base}/`) || local.startsWith(`${base}?`) ? local.slice(base.length) : null
  if (rest === null || rest.includes('#')) {
    return null
  }
  const to = rest.startsWith('?') ? `/${rest}` : rest
  return to.split('?')[0].split('/').some((part) => part === '.' || part === '..') ? null : to
}

/** Whether the address opens the component in the source editor. */
export function isEditorView(search: URLSearchParams): boolean {
  return search.get(VIEW_PARAM) === EDITOR_VIEW
}

/** The query that opens the page the App is on in the source editor. */
export const EDITOR_QUERY = `?${new URLSearchParams({ [VIEW_PARAM]: EDITOR_VIEW })}`

/** The `<project>.<name>` reference an old `?component=` link carries; null when it carries none. */
export function legacyComponentRef(search: URLSearchParams): string | null {
  return search.get(LEGACY_COMPONENT_PARAM) || null
}

/**
 * Where an old `?component=` link that resolved to `name` belongs: the
 * component's path, keeping the rest of the query (the editor view) and
 * dropping only the reference the path carries.
 */
export function legacyLinkTarget(name: string, search: URLSearchParams): string {
  const rest = new URLSearchParams(search)
  rest.delete(LEGACY_COMPONENT_PARAM)
  const query = rest.toString()
  return `${componentAppPath(name)}${query ? `?${query}` : ''}`
}
