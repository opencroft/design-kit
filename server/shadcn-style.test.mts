import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_SHADCN_STYLE,
  effectiveShadcnStyle,
  parseShadcnStyle,
  SHADCN_STYLES,
  shadcnStyleCss,
  transformIconPlaceholders,
  usesShadcnVariants,
} from './shadcn-style.ts'

test('the default is new-york-v4, so a project that never sets a style previews against it', () => {
  assert.equal(DEFAULT_SHADCN_STYLE, 'new-york-v4')
  assert.equal(effectiveShadcnStyle(undefined), 'new-york-v4')
  assert.ok(SHADCN_STYLES.includes('new-york-v4'))
  assert.ok(SHADCN_STYLES.includes('base-vega'))
})

test('setting a style is validated against the allow-list, and the refusal names it', () => {
  assert.equal(parseShadcnStyle('base-vega'), 'base-vega')
  assert.equal(parseShadcnStyle('  base-vega  '), 'base-vega')
  assert.equal(parseShadcnStyle(''), 'new-york-v4')
  assert.equal(parseShadcnStyle(undefined), 'new-york-v4')
  assert.throws(() => parseShadcnStyle('new-york'), /unknown shadcn style "new-york"\. Valid styles: new-york-v4, base-vega/)
  assert.throws(() => parseShadcnStyle('../../etc'), /unknown shadcn style/)
})

test('a stored value off the list previews as the default instead of reaching a URL', () => {
  assert.equal(effectiveShadcnStyle('base-vega'), 'base-vega')
  assert.equal(effectiveShadcnStyle('../../etc'), 'new-york-v4')
  assert.equal(effectiveShadcnStyle(42), 'new-york-v4')
})

test("create-era styles compile shadcn's custom variants; new-york-v4 compiles nothing extra", () => {
  assert.equal(shadcnStyleCss('new-york-v4'), '')
  assert.equal(usesShadcnVariants('new-york-v4'), false)
  for (const style of ['base-vega', 'base-nova', 'radix-vega']) {
    assert.equal(usesShadcnVariants(style), true, style)
    const css = shadcnStyleCss(style)
    for (const variant of ['data-open', 'data-closed', 'data-checked', 'data-unchecked', 'data-selected', 'data-disabled', 'data-active', 'data-horizontal', 'data-vertical']) {
      assert.match(css, new RegExp(`@custom-variant ${variant} \\{`), `${style}: ${variant}`)
    }
    assert.match(css, /&:where\(\[data-orientation="horizontal"\]\)/)
  }
})

test('the vendored block survives the preview shell: no `</style` inside it', () => {
  assert.doesNotMatch(shadcnStyleCss('base-vega'), /<\/style/i)
})

// Shape taken from https://ui.shadcn.com/r/styles/base-vega/dialog.json.
const DIALOG = `import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"
import { Button } from "@/registry/base-vega/ui/button"
import { IconPlaceholder } from "@/app/(create)/components/icon-placeholder"

function Close() {
  return (
    <DialogPrimitive.Close render={<Button variant="ghost" size="icon-sm" />}>
      <IconPlaceholder
        lucide="XIcon"
        tabler="IconX"
        hugeicons="Cancel01Icon"
        phosphor="XIcon"
        remixicon="RiCloseLine"
      />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  )
}

function Check({ className }: { className?: string }) {
  return <IconPlaceholder lucide="CheckIcon" tabler="IconCheck" hugeicons="Tick02Icon" phosphor="CheckIcon" remixicon="RiCheckLine" className={cn("size-4 [&>svg]:x", className)} data-slot="check" />
}
`

test('IconPlaceholder becomes the lucide icon it names, keeping every other attribute', () => {
  const out = transformIconPlaceholders(DIALOG)
  assert.doesNotMatch(out, /IconPlaceholder/)
  assert.doesNotMatch(out, /icon-placeholder/)
  assert.doesNotMatch(out, /tabler=|hugeicons=|phosphor=|remixicon=|lucide=/)
  assert.match(out, /^import \{ CheckIcon, XIcon \} from "lucide-react"$/m)
  assert.match(out, /<XIcon \/>/)
  assert.match(out, /<CheckIcon className=\{cn\("size-4 \[&>svg\]:x", className\)\} data-slot="check" \/>/)
  // Everything else is untouched.
  assert.match(out, /import \{ Button \} from "@\/registry\/base-vega\/ui\/button"/)
  assert.match(out, /render=\{<Button variant="ghost" size="icon-sm" \/>\}/)
})

test('a source without placeholders comes back byte-identical (every new-york-v4 item)', () => {
  const src = 'import { XIcon } from "lucide-react"\nexport const A = () => <XIcon />\n'
  assert.equal(transformIconPlaceholders(src), src)
})

test('a placeholder without a lucide name is left for the unresolved-import report', () => {
  const src = 'import { IconPlaceholder } from "@/app/(create)/components/icon-placeholder"\nconst A = () => <IconPlaceholder tabler="IconX" />\n'
  assert.equal(transformIconPlaceholders(src), src)
})
