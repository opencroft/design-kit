// The generated install script, run for real against a stand-in `npx`.
//
// The stand-in records the arguments and the components.json it was started
// with, then answers the way shadcn does: its whole report on stdout, nothing
// on stderr, and the exit code the case asks for.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { SHADCN_PACKAGE, SHADCN_VERSION } from '../src/registry/shadcn-cli.ts'
import { installScriptSource } from './install-script.ts'

const REQUIRED = { '@kit': 'http://127.0.0.1:9/registry?project=kit&name={name}' }
const CONSUMER_CONFIG = `${JSON.stringify({ style: 'new-york', rsc: false, aliases: { ui: '@/components/ui' } }, null, 2)}\n`

const FAKE_NPX = `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(process.env.FAKE_NPX_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  config: JSON.parse(fs.readFileSync('components.json', 'utf8')),
}))
process.stdout.write(process.env.FAKE_NPX_STDOUT || '')
if (process.env.FAKE_NPX_SIGNAL) {
  process.kill(process.pid, process.env.FAKE_NPX_SIGNAL)
}
process.exitCode = Number(process.env.FAKE_NPX_EXIT || 0)
`

interface Run {
  status: number | null
  stdout: string
  stderr: string
  record: { args: string[]; config: { registries?: Record<string, unknown> } } | null
  configAfter: string
}

interface Fake {
  stdout?: string
  exit?: number
  signal?: string
  noNpx?: boolean
  targets?: string[]
  consumerConfig?: string
}

function runInstall(fake: Fake = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'install-script-'))
  try {
    const consumer = join(dir, 'consumer')
    const bin = join(dir, 'bin')
    mkdirSync(consumer)
    mkdirSync(bin)
    writeFileSync(join(consumer, 'components.json'), fake.consumerConfig ?? CONSUMER_CONFIG)
    writeFileSync(join(dir, 'cli.js'), installScriptSource(REQUIRED, fake.targets ?? ['@kit/button']))
    if (!fake.noNpx) {
      writeFileSync(join(bin, 'npx'), FAKE_NPX)
      chmodSync(join(bin, 'npx'), 0o755)
    }
    const recordPath = join(dir, 'record.json')
    const result = spawnSync(process.execPath, [join(dir, 'cli.js')], {
      cwd: consumer,
      encoding: 'utf8',
      env: {
        // Without a stand-in, PATH holds only the empty bin directory, so no
        // real npx can answer in its place.
        PATH: fake.noNpx ? bin : `${bin}:${dirname(process.execPath)}`,
        FAKE_NPX_RECORD: recordPath,
        FAKE_NPX_STDOUT: fake.stdout ?? '',
        FAKE_NPX_EXIT: String(fake.exit ?? 0),
        ...(fake.signal ? { FAKE_NPX_SIGNAL: fake.signal } : {}),
      },
    })
    let record = null
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8'))
    } catch {}
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      record,
      configAfter: readFileSync(join(consumer, 'components.json'), 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const REASON = 'Request to http://127.0.0.1:9/registry?project=kit&name=button failed, reason: connect ECONNREFUSED'
const SHADCN_FAILURE = `\nSomething went wrong. Please check the error below for more details.\n\n${REASON}\n`

test("a failed shadcn's reason reaches stderr, which is all a caller may keep of a failure", () => {
  const run = runInstall({ stdout: SHADCN_FAILURE, exit: 1 })
  assert.equal(run.status, 1)
  assert.ok(run.stderr.includes(REASON), run.stderr)
  assert.ok(run.stderr.includes(`npx --yes ${SHADCN_PACKAGE} add --yes --overwrite @kit/button exited with code 1`))
})

test("shadcn's stdout is passed on to stdout as well, so a terminal shows it as it arrives", () => {
  const run = runInstall({ stdout: SHADCN_FAILURE, exit: 1 })
  assert.ok(run.stdout.includes(REASON), run.stdout)
})

test("shadcn's exit code is the script's", () => {
  assert.equal(runInstall({ stdout: SHADCN_FAILURE, exit: 3 }).status, 3)
})

test('a shadcn stopped by a signal fails the script and says so', () => {
  const run = runInstall({ signal: 'SIGTERM' })
  assert.equal(run.status, 1)
  assert.ok(run.stderr.includes('was stopped by SIGTERM'), run.stderr)
})

test("a successful install leaves shadcn's report on stdout only", () => {
  const run = runInstall({ stdout: '  - src/components/ui/button.tsx\n', exit: 0 })
  assert.equal(run.status, 0)
  assert.equal(run.stdout, '  - src/components/ui/button.tsx\n')
  assert.equal(run.stderr, '')
})

test('no npx to run: the script fails and names what it could not start', () => {
  const run = runInstall({ noNpx: true })
  assert.equal(run.status, 1)
  assert.ok(run.stderr.includes(`Could not run npx --yes ${SHADCN_PACKAGE}`), run.stderr)
  assert.equal(run.configAfter, CONSUMER_CONFIG)
})

test('npx is told the pinned shadcn version, and every target as its own argument', () => {
  // Joined into one string the targets would become a single item name
  // containing spaces, which resolves to nothing and says little about why.
  const run = runInstall({ targets: ['@kit/button', '@kit/card'] })
  assert.match(SHADCN_VERSION, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(run.record?.args, [
    '--yes',
    `shadcn@${SHADCN_VERSION}`,
    'add',
    '--yes',
    '--overwrite',
    '@kit/button',
    '@kit/card',
  ])
})

test('the namespaces are registered for the run and components.json is put back after a failure', () => {
  const run = runInstall({ stdout: SHADCN_FAILURE, exit: 1 })
  assert.deepEqual(Object.keys(run.record?.config.registries ?? {}), ['@kit'])
  assert.equal(run.configAfter, CONSUMER_CONFIG)
})

test('a consumer that is not RSC has rsc=false asked for on the namespaces it gets', () => {
  const run = runInstall()
  assert.deepEqual(run.record?.config.registries, { '@kit': { url: REQUIRED['@kit'], params: { rsc: 'false' } } })
})

test('an RSC consumer gets the namespaces without the parameter', () => {
  const rsc = `${JSON.stringify({ style: 'new-york', rsc: true }, null, 2)}\n`
  const run = runInstall({ consumerConfig: rsc })
  assert.deepEqual(run.record?.config.registries, { '@kit': REQUIRED['@kit'] })
  assert.equal(run.configAfter, rsc)
})

test("a consumer's own entry for the namespace borrows the parameter for the run and gets its value back", () => {
  const own = `${JSON.stringify({ rsc: false, registries: { '@kit': REQUIRED['@kit'], '@other': 'http://127.0.0.1:9/other/{name}' } }, null, 2)}\n`
  const run = runInstall({ consumerConfig: own, stdout: SHADCN_FAILURE, exit: 1 })
  assert.deepEqual(run.record?.config.registries, {
    '@kit': { url: REQUIRED['@kit'], params: { rsc: 'false' } },
    '@other': 'http://127.0.0.1:9/other/{name}',
  })
  assert.equal(run.configAfter, own)
})

test('components.json is put back after a success', () => {
  const run = runInstall({ exit: 0 })
  assert.deepEqual(Object.keys(run.record?.config.registries ?? {}), ['@kit'])
  assert.equal(run.configAfter, CONSUMER_CONFIG)
})

test('the vendored shadcn tailwind.css comes from the release the kit runs', () => {
  // Bumping SHADCN_VERSION without re-vendoring would compile previews with one
  // release's CSS and install with another's.
  const vendored = readFileSync(new URL('./shadcn-tailwind-css.ts', import.meta.url), 'utf8')
  const header = /from the npm package shadcn@(\d+\.\d+\.\d+)/.exec(vendored)
  assert.ok(header, 'shadcn-tailwind-css.ts does not name the release it was vendored from')
  assert.equal(header[1], SHADCN_VERSION)
})
