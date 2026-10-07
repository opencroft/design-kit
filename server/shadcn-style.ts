// A project's shadcn STYLE: which registry `@/components/ui/<name>` resolves
// against when the project is previewed. Host-free, so the rules are tested
// directly (server/shadcn-style.test.mts).
//
// A per-project setting because the styles are not interchangeable: a kit
// whose components compose Base UI primitives (`render={<X/>}`) previews
// wrongly against new-york-v4's Radix primitives (`asChild`), and a Radix kit
// the other way round. The default is new-york-v4, so a project that never
// sets it previews against new-york-v4.

import { SHADCN_TAILWIND_CSS } from './shadcn-tailwind-css.ts'

export const DEFAULT_SHADCN_STYLE = 'new-york-v4'

// Each one served at https://ui.shadcn.com/r/styles/<style>/<name>.json
// (button.json resolves for every entry). Plain `new-york` and `default` are
// the Tailwind-v3 registries and stay out: the preview compiles Tailwind v4,
// and their `h-[--x]` var shorthand compiles to invalid declarations there (see server/shadcn-registry.ts).
//
// An allow-list and not a pattern: the value becomes a URL path segment and a
// cache directory name.
export const SHADCN_STYLES = [
  'new-york-v4',
  'base-vega',
  'base-nova',
  'base-maia',
  'base-lyra',
  'base-mira',
  'radix-vega',
  'radix-nova',
] as const

export type ShadcnStyle = (typeof SHADCN_STYLES)[number]

export function isShadcnStyle(v: unknown): v is ShadcnStyle {
  return typeof v === 'string' && (SHADCN_STYLES as readonly string[]).includes(v)
}

/**
 * Validate a style someone is SETTING. Empty/absent means "back to the
 * default"; anything else must be on the allow-list, and the refusal names
 * what is.
 */
export function parseShadcnStyle(input: unknown, action = 'setShadcnStyle'): ShadcnStyle {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) {
    return DEFAULT_SHADCN_STYLE
  }
  if (!isShadcnStyle(raw)) {
    throw new Error(`${action}: unknown shadcn style "${raw}". Valid styles: ${SHADCN_STYLES.join(', ')}.`)
  }
  return raw
}

/**
 * The style a STORED value means. Lenient where parseShadcnStyle is strict: a
 * value that is not on the list (a hand-edited theme.json, a style later
 * dropped from the list) previews as the default instead of breaking the
 * project's preview — and never reaches a URL.
 */
export function effectiveShadcnStyle(stored: unknown): ShadcnStyle {
  return isShadcnStyle(stored) ? stored : DEFAULT_SHADCN_STYLE
}

/**
 * Whether the style's components rely on shadcn's custom Tailwind variants
 * (`data-open:`, `data-horizontal:` …, declared in `shadcn/tailwind.css`).
 * The create-era styles do — radix-* as well as base-*: radix-vega's tabs use
 * `data-horizontal:` too. new-york-v4 predates them and spells state as
 * `data-[state=open]:`, so it compiles without the extra source.
 */
export function usesShadcnVariants(style: string): boolean {
  return /^(base|radix)-/.test(style)
}

/** The extra Tailwind source the preview frame compiles for this style. */
export function shadcnStyleCss(style: string): string {
  return usesShadcnVariants(style) ? SHADCN_TAILWIND_CSS : ''
}

// ── IconPlaceholder → lucide ─────────────────────────────────────────
// The create-era registry serves items UNTRANSFORMED as far as icons go: an
// icon is `<IconPlaceholder lucide="XIcon" tabler="IconX" … />` imported from
// `@/app/(create)/components/icon-placeholder`, a module that exists only in
// shadcn's own site. The CLI rewrites it on install to the project's icon
// library. The preview has to do the same, or the placeholder is an
// unresolved import and whatever renders it throws "element type is invalid".
// lucide, because it is what the shadcn default config uses; the item then
// imports lucide-react like any other package (see ./upstream-item).

const PLACEHOLDER_IMPORT = /^[ \t]*import\s*\{\s*IconPlaceholder\s*\}\s*from\s*["'][^"']*\/icon-placeholder["'];?[ \t]*$/m
const LIBRARY_ATTRS = new Set(['lucide', 'tabler', 'hugeicons', 'phosphor', 'remixicon'])

// Split a JSX tag's attribute text into whole attributes, respecting quoted
// strings and `{…}` expressions (which may themselves hold `>` or `/`).
function splitAttributes(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) {
      i++
    }
    if (i >= text.length) {
      break
    }
    const start = i
    let depth = 0
    let quote: string | null = null
    while (i < text.length) {
      const ch = text[i]
      if (quote) {
        if (ch === quote) {
          quote = null
        }
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
      } else if (depth === 0 && /\s/.test(ch)) {
        break
      }
      i++
    }
    out.push(text.slice(start, i))
  }
  return out
}

// Find the end of a tag's attribute text (the index of its closing `/>` or
// `>`), from just after the tag name.
function tagEnd(src: string, from: number): { attrsEnd: number; selfClosing: boolean } | null {
  let depth = 0
  let quote: string | null = null
  for (let i = from; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
    } else if (depth === 0 && ch === '/' && src[i + 1] === '>') {
      return { attrsEnd: i, selfClosing: true }
    } else if (depth === 0 && ch === '>') {
      return { attrsEnd: i, selfClosing: false }
    }
  }
  return null
}

/**
 * Rewrite every `<IconPlaceholder lucide="Name" … />` to `<Name … />` (the
 * other libraries' attributes dropped, everything else kept) and the
 * placeholder import to an import of those names from lucide-react. A source
 * with no placeholder comes back unchanged, so this is safe on every style.
 */
export function transformIconPlaceholders(source: string): string {
  if (!source.includes('IconPlaceholder')) {
    return source
  }
  const icons = new Set<string>()
  let out = ''
  let pos = 0
  const OPEN = '<IconPlaceholder'
  for (;;) {
    const at = source.indexOf(OPEN, pos)
    if (at < 0) {
      break
    }
    const nameEnd = at + OPEN.length
    // `<IconPlaceholderFoo` is a different element.
    if (/[\w$]/.test(source[nameEnd] ?? '')) {
      out += source.slice(pos, nameEnd)
      pos = nameEnd
      continue
    }
    const end = tagEnd(source, nameEnd)
    if (!end) {
      break
    }
    const attrs = splitAttributes(source.slice(nameEnd, end.attrsEnd))
    const lucideAttr = attrs.find((a) => /^lucide=/.test(a))
    const icon = lucideAttr?.match(/^lucide=["']([A-Za-z_$][\w$]*)["']$/)?.[1]
    if (!icon) {
      // No usable lucide name: leave the element alone rather than guess. It
      // surfaces as an unresolved import, which names the problem.
      out += source.slice(pos, nameEnd)
      pos = nameEnd
      continue
    }
    icons.add(icon)
    const kept = attrs.filter((a) => !LIBRARY_ATTRS.has(a.split('=')[0]))
    out += source.slice(pos, at) + `<${icon}${kept.length ? ` ${kept.join(' ')}` : ''}${end.selfClosing ? ' />' : '>'}`
    pos = end.attrsEnd + (end.selfClosing ? 2 : 1)
    // A non-self-closing placeholder closes with its own name.
    if (!end.selfClosing) {
      const close = source.indexOf('</IconPlaceholder>', pos)
      if (close >= 0) {
        out += source.slice(pos, close) + `</${icon}>`
        pos = close + '</IconPlaceholder>'.length
      }
    }
  }
  out += source.slice(pos)
  if (icons.size === 0) {
    return source
  }
  const lucideImport = `import { ${[...icons].sort().join(', ')} } from "lucide-react"`
  return PLACEHOLDER_IMPORT.test(out) ? out.replace(PLACEHOLDER_IMPORT, lucideImport) : `${lucideImport}\n${out}`
}
