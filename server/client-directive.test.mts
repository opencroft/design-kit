// The registry removes 'use client' itself for a consumer that is not RSC,
// because shadcn's removal skips every other file of one install. The cases
// below pin what a removal leaves, what it must not touch, and that it gives
// the same answer however many times in a row it is asked — the property the
// CLI's own regex lacks.
//
// The route and the install script live in index.ts, which imports
// `@opencroft/server` and cannot be loaded here. The guards at the bottom read its
// source and say only that the wiring is in place, not that it works.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { stripClientDirective, stripsClientDirective } from './client-directive.ts'

test('a leading directive and the blank line after it go', () => {
  assert.equal(
    stripClientDirective(`'use client'\n\nimport * as React from 'react'\n`),
    `import * as React from 'react'\n`,
  )
})

test('both quotes, with or without a semicolon', () => {
  assert.equal(stripClientDirective(`"use client"\nexport {}\n`), 'export {}\n')
  assert.equal(stripClientDirective(`'use client';\nexport {}\n`), 'export {}\n')
  assert.equal(stripClientDirective(`"use client";\r\n\r\nexport {}\r\n`), 'export {}\r\n')
})

test('comments above the directive stay', () => {
  assert.equal(
    stripClientDirective(`// header\n/* block */\n'use client'\n\nexport {}\n`),
    `// header\n/* block */\nexport {}\n`,
  )
})

test('a file that is only the directive becomes empty', () => {
  assert.equal(stripClientDirective(`'use client'\n`), '')
  assert.equal(stripClientDirective(`'use client'`), '')
})

test('the same string after the first statement is not a directive', () => {
  const source = `import x from 'y'\n'use client'\nexport {}\n`
  assert.equal(stripClientDirective(source), source)
})

test('an expression that starts with the string is not a directive', () => {
  const source = `'use client'.length\n`
  assert.equal(stripClientDirective(source), source)
})

test('a file without the directive is unchanged', () => {
  const source = `import { cn } from '@/lib/utils'\n\nexport function A() {}\n`
  assert.equal(stripClientDirective(source), source)
})

test('every file of a run loses it, not every other one', () => {
  // The defect being worked around: a `g` regex keeps lastIndex between calls,
  // so the same input alternated true, false, true, false.
  const source = `'use client'\n\nexport {}\n`
  assert.deepEqual(
    [1, 2, 3, 4].map(() => stripClientDirective(source)),
    ['export {}\n', 'export {}\n', 'export {}\n', 'export {}\n'],
  )
})

test('only rsc=false asks for the removal', () => {
  const ask = (query: string) => stripsClientDirective(new URL(`http://kit/http/registry?component=kit.a${query}`))
  assert.equal(ask('&rsc=false'), true)
  assert.equal(ask(''), false)
  assert.equal(ask('&rsc=true'), false)
  assert.equal(ask('&rsc='), false)
})

const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8')

test('the registry item route serves stripped files when asked', () => {
  assert.match(index, /registryItem\([^;]*stripsClientDirective\(url\),?\s*\)/)
  assert.match(index, /stripDirective \? stripClientDirective\(content\) : content/)
})

test('the install script asks for it when the consumer is not RSC, and restores entries it borrowed', () => {
  assert.match(index, /const stripDirective = !config\.rsc/)
  assert.match(index, /entry\.params = \{ rsc: 'false' \}/)
  assert.match(index, /fresh\.registries\[ns\] = augmented\[ns\]/)
})
