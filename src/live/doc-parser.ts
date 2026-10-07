import type { Control } from '../registry'

// The pure `docs/doc.mdx` parser — no React/JSX, so it's usable from a plain
// Node context too (the server-side validator, see server/validate.ts) as well
// as the client doc renderer (./mdx.tsx). Both must read a doc the SAME way,
// or a component that validates server-side could render differently in the
// real dashboard (or vice versa).
//
// doc.mdx is authored as VALID MDX (markdown + self-closing component tags +
// `{…}` JS expression attributes), so this lite parser can later be swapped
// for real `@mdx-js/mdx` without touching a single doc file:
//
//   <Preview src="./preview.tsx" controls={[{ name, kind, options?, default }]} />
//   <Sheet prop="size" values={['sm','md','lg']} title?="…" />
//   <Example src="./examples/foo.tsx" title?="…" />

export type ControlSpec = Control & { description?: string }

export type DocSegment =
  | { kind: 'md'; text: string }
  | { kind: 'preview'; src: string; controls: ControlSpec[] }
  | { kind: 'sheet'; prop: string; values: unknown[]; title?: string }
  | { kind: 'example'; src: string; title?: string }

const TAG_NAMES = ['Preview', 'Sheet', 'Example'] as const

// Evaluate a `{…}` attribute expression (an array/object literal in a doc).
// Treated as trusted input — the project's own doc.mdx. Real MDX evaluates
// these too.
function evalExpr(expr: string): unknown {
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${expr});`)()
  } catch {
    return undefined
  }
}

// Locate the next component tag start at/after `from`.
function findNextTag(src: string, from: number): { index: number; name: string; attrStart: number } | null {
  let best: { index: number; name: string; attrStart: number } | null = null
  for (const name of TAG_NAMES) {
    const re = new RegExp(`<${name}(?=[\\s/>])`, 'g')
    re.lastIndex = from
    const m = re.exec(src)
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, name, attrStart: m.index + name.length + 1 }
    }
  }
  return best
}

// From the first attribute char, find the position of the closing `/` in `/>`,
// respecting quotes and `{…}` nesting so braces/brackets inside expressions
// don't end the tag early. Returns -1 if unterminated.
function scanTagEnd(src: string, start: number): number {
  let i = start
  let depth = 0
  let quote: string | null = null
  while (i < src.length) {
    const ch = src[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      }
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      i++
      continue
    }
    if (ch === '{') {
      depth++
      i++
      continue
    }
    if (ch === '}') {
      depth--
      i++
      continue
    }
    if (depth === 0 && ch === '/' && src[i + 1] === '>') {
      return i
    }
    i++
  }
  return -1
}

// Parse an attribute list: `name="str"`, `name={expr}`, or bare `name`.
function parseAttrs(s: string): Record<string, unknown> {
  const attrs: Record<string, unknown> = {}
  let i = 0
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) {
      i++
    }
  }
  while (i < s.length) {
    skipWs()
    if (i >= s.length) {
      break
    }
    const nameM = /^[A-Za-z_][\w-]*/.exec(s.slice(i))
    if (!nameM) {
      break
    }
    const name = nameM[0]
    i += name.length
    skipWs()
    if (s[i] !== '=') {
      attrs[name] = true
      continue
    }
    i++ // '='
    skipWs()
    const ch = s[i]
    if (ch === '{') {
      let depth = 0
      let quote: string | null = null
      const start = i
      for (; i < s.length; i++) {
        const c = s[i]
        if (quote) {
          if (c === quote) {
            quote = null
          }
          continue
        }
        if (c === '"' || c === "'" || c === '`') {
          quote = c
          continue
        }
        if (c === '{') {
          depth++
        } else if (c === '}') {
          depth--
          if (depth === 0) {
            i++
            break
          }
        }
      }
      attrs[name] = { __expr: s.slice(start + 1, i - 1) }
    } else if (ch === '"' || ch === "'") {
      i++
      const start = i
      while (i < s.length && s[i] !== ch) {
        i++
      }
      attrs[name] = s.slice(start, i)
      i++
    } else {
      const start = i
      while (i < s.length && !/\s/.test(s[i])) {
        i++
      }
      attrs[name] = s.slice(start, i)
    }
  }
  return attrs
}

function attrStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function attrExpr(v: unknown): unknown {
  return v && typeof v === 'object' && '__expr' in (v as Record<string, unknown>) ? evalExpr((v as { __expr: string }).__expr) : v
}

export function parseDoc(src: string): DocSegment[] {
  const segments: DocSegment[] = []
  const pushMd = (text: string) => {
    if (text.trim()) {
      segments.push({ kind: 'md', text })
    }
  }
  let pos = 0
  while (pos < src.length) {
    const tag = findNextTag(src, pos)
    if (!tag) {
      pushMd(src.slice(pos))
      break
    }
    if (tag.index > pos) {
      pushMd(src.slice(pos, tag.index))
    }
    const slash = scanTagEnd(src, tag.attrStart)
    if (slash < 0) {
      pushMd(src.slice(tag.index))
      break
    }
    const attrs = parseAttrs(src.slice(tag.attrStart, slash))
    pos = slash + 2 // past `/>`
    if (tag.name === 'Preview') {
      const controls = attrExpr(attrs.controls)
      segments.push({ kind: 'preview', src: attrStr(attrs.src) ?? '', controls: Array.isArray(controls) ? (controls as ControlSpec[]) : [] })
    } else if (tag.name === 'Sheet') {
      const values = attrExpr(attrs.values)
      segments.push({ kind: 'sheet', prop: attrStr(attrs.prop) ?? '', values: Array.isArray(values) ? values : [], title: attrStr(attrs.title) })
    } else if (tag.name === 'Example') {
      segments.push({ kind: 'example', src: attrStr(attrs.src) ?? '', title: attrStr(attrs.title) })
    }
  }
  return segments
}

// A tag `src` ("./preview.tsx", "docs/examples/foo.tsx") reduced to the key the
// doc file map is built on. Also the spelling a doc TARGET carries, so the name
// a validator reports a failure under and the name a link opens are produced by
// one function rather than by two regexes that agree until one is edited.
export function docsRelative(src: string): string {
  return src.replace(/^\.\//, '').replace(/^docs\//, '')
}

// Resolve a tag `src` (relative to docs/, e.g. "./preview.tsx" or
// "./examples/foo.tsx") against the doc file map (keyed by docs-relative path).
export function resolveSrc(files: Record<string, string>, src: string): string | null {
  const key = docsRelative(src)
  if (files[key] != null) {
    return files[key]
  }
  const hit = Object.entries(files).find(([k]) => k === key || k.endsWith(`/${key}`))
  return hit ? hit[1] : null
}

// Coerce a control value / sheet sweep value to a real prop value. Empty string
// means "omit this optional prop"; "true"/"false" become booleans.
export function coerceValue(kind: Control['kind'] | undefined, raw: unknown): unknown {
  if (kind === 'boolean' || raw === true || raw === false) {
    return Boolean(raw)
  }
  if (raw === '' || raw == null) {
    return undefined
  }
  if (raw === 'true') {
    return true
  }
  if (raw === 'false') {
    return false
  }
  return raw
}

// Build the prop object the preview/sheet renders with, from control defaults.
export function defaultProps(controls: ControlSpec[]): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const c of controls) {
    const v = coerceValue(c.kind, c.default)
    if (v !== undefined) {
      props[c.name] = v
    }
  }
  return props
}
