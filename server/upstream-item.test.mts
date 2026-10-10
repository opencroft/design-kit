import assert from 'node:assert/strict'
import { test } from 'node:test'

import { upstreamDependencies, withCnPackage } from './upstream-item.ts'

test('the utils alias import becomes an import of the cn package, either quote style', () => {
  assert.equal(withCnPackage(`import { cn } from "@/lib/utils"\n`), `import { cn } from "cn"\n`)
  assert.equal(withCnPackage(`import { cn } from '@/lib/utils'\n`), `import { cn } from 'cn'\n`)
})

test('other imports are left alone', () => {
  const source = `import { Button } from "@/components/ui/button"\nimport { cn } from "cn"\nconst path = "@/lib/utils/extra"\n`
  assert.equal(withCnPackage(source), source)
})

test('undeclared npm imports are added by package name, declared ones kept with their range', () => {
  const files = [
    `import * as React from "react"\nimport { cva } from "class-variance-authority"\nimport { XIcon } from "lucide-react"\nimport { Dialog as DialogPrimitive } from "radix-ui"\nimport { cn } from "cn"\nimport { Button } from "@/components/ui/button"\nimport "./styles.css"\n`,
    `import { Popover } from "@base-ui/react/popover"\nexport { Slot } from "radix-ui"\n`,
  ]
  assert.deepEqual(upstreamDependencies(files, ['radix-ui@^1.4.0', 'cn']), [
    'radix-ui@^1.4.0',
    'cn',
    'class-variance-authority',
    'lucide-react',
    '@base-ui/react',
  ])
})

test('an item importing nothing from npm keeps exactly its declarations', () => {
  assert.deepEqual(upstreamDependencies([`import * as React from "react"\nimport { x } from "./x"\n`], ['cn']), ['cn'])
  assert.deepEqual(upstreamDependencies([], []), [])
})
