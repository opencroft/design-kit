import assert from 'node:assert/strict'
import { test } from 'node:test'

import { porcelainPaths, stagedPathsIn } from './staged-paths.ts'

test('staged deletions intersect with the requested paths', () => {
  const porcelain = 'D  registry/x.json\nD  components/ui/x.tsx\nD  internal/x/docs/doc.mdx'
  const paths = ['registry/x.json', 'components/ui/x.tsx', 'internal/x/docs/doc.mdx']
  assert.deepEqual(stagedPathsIn(porcelain, paths), paths)
})

test('a requested path git does not list falls out', () => {
  const porcelain = 'D  registry/x.json'
  assert.deepEqual(stagedPathsIn(porcelain, ['registry/x.json', 'never/existed.json']), ['registry/x.json'])
})

test('a listed path that was not requested is not swept in', () => {
  const porcelain = 'D  registry/x.json\n M components/ui/unrelated-draft.tsx'
  assert.deepEqual(stagedPathsIn(porcelain, ['registry/x.json']), ['registry/x.json'])
})

test('untracked entries are excluded even when requested', () => {
  const porcelain = '?? registry/x.json'
  assert.deepEqual(stagedPathsIn(porcelain, ['registry/x.json']), [])
})

test('rename lines contribute both sides', () => {
  const porcelain = 'R  registry/old.json -> registry/new.json'
  assert.deepEqual(stagedPathsIn(porcelain, ['registry/old.json', 'registry/new.json']), [
    'registry/old.json',
    'registry/new.json',
  ])
})

test('quoted paths unquote before intersecting', () => {
  const porcelain = 'D  "registry/we ird.json"'
  assert.deepEqual(stagedPathsIn(porcelain, ['registry/we ird.json']), ['registry/we ird.json'])
})

test('empty output yields nothing', () => {
  assert.deepEqual(stagedPathsIn('', ['registry/x.json']), [])
})

test('the census lists every changed path, staged or not, untracked included', () => {
  const porcelain = 'M  registry/x.json\n D components/ui/x.tsx\n?? components/ui/new.tsx'
  assert.deepEqual(porcelainPaths(porcelain), ['registry/x.json', 'components/ui/x.tsx', 'components/ui/new.tsx'])
})

test('the census splits a rename into both real paths, never the fused string', () => {
  const porcelain = 'R  components/ui/old.tsx -> components/ui/new.tsx'
  assert.deepEqual(porcelainPaths(porcelain), ['components/ui/old.tsx', 'components/ui/new.tsx'])
})

test('the census unquotes and drops empty lines', () => {
  assert.deepEqual(porcelainPaths('D  "registry/we ird.json"\n'), ['registry/we ird.json'])
  assert.deepEqual(porcelainPaths(''), [])
})
