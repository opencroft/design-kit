// ── The install script's source ──────────────────────────────────────
// The `cli.js` of the npm tarball GET /http/install serves (server/index.ts):
// it registers the namespaces the dependency graph needs in the consumer's
// components.json for one run, runs `shadcn add`, and restores the file.
//
// Host-free, so its tests can generate the script and run it against a stand-in
// `npx` (server/install-script.test.mts).

import { SHADCN_PACKAGE } from '../src/registry/shadcn-cli.ts'

// `targets` rather than one target, because the whole-project form adds every
// component in a single `shadcn add` — the CLI takes them variadically
// (`shadcn add [components...]`, confirmed against the CLI's own help on
// 14.09.2026), so one invocation resolves the closure across all of them
// instead of N invocations each re-reading the registry.
//
// Deliberately not shadcn's own `--all`: that means every component of every
// registry the consuming project has configured, which is a different and
// wider thing than every component of THIS project.
export function installScriptSource(required: Record<string, string>, targets: string[]): string {
  return `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const REQUIRED = ${JSON.stringify(required, null, 2)}
const TARGETS = ${JSON.stringify(targets)}
const SHADCN = ${JSON.stringify(SHADCN_PACKAGE)}

const configPath = path.join(process.cwd(), 'components.json')
if (!fs.existsSync(configPath)) {
  console.error('No components.json found in ' + process.cwd() + '. Run this from a shadcn-initialized project.')
  process.exit(1)
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const registries = config.registries || {}
const added = []

// Basic-auth-gated host support. Two env vars, one command, no files:
//   \`npm_config_//<host>/:_auth=<base64 user:pass>\` — used by npm itself to
//   fetch this script's tarball, but npm STRIPS credential-shaped config vars
//   from the env it passes to package scripts, so this script cannot read it;
//   \`DESIGN_KIT_AUTH=<same base64>\` — readable here, and referenced by the
//   Authorization header templates below via shadcn's \${VAR} substitution,
//   so the secret never lands in components.json.
const host = new URL(REQUIRED[Object.keys(REQUIRED)[0]]).host
const auth = process.env.DESIGN_KIT_AUTH || process.env['npm_config_//' + host + '/:_auth']
if (auth) {
  process.env.DESIGN_KIT_AUTH = auth
  // Also satisfy env-var templates of registries ALREADY configured for this
  // host with an auth header of their own (e.g. \${MY_REGISTRY_AUTH}) — same
  // credential, whatever name the existing entry expects.
  for (const key of Object.keys(registries)) {
    const entry = registries[key]
    if (!entry || typeof entry === 'string' || !entry.headers) {
      continue
    }
    let entryHost = null
    try {
      entryHost = new URL(String(entry.url)).host
    } catch (e) {}
    if (entryHost !== host) {
      continue
    }
    for (const hv of Object.values(entry.headers)) {
      const m = /\\$\\{([A-Za-z0-9_]+)\\}/.exec(String(hv))
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = auth
      }
    }
  }
}

// A consumer that is not RSC is served its files with 'use client' already
// removed (\`rsc=false\`, see server/client-directive.ts): shadcn's own removal
// skips every other file of one install. Sent as registry \`params\` so the URL
// still compares equal to an entry the consumer configured itself; such an
// entry gets the parameter for this run only and is put back afterwards.
const stripDirective = !config.rsc
const augmented = {}

for (const ns of Object.keys(REQUIRED)) {
  const url = REQUIRED[ns]
  const existing = registries[ns]
  const existingUrl = typeof existing === 'string' ? existing : existing && existing.url
  if (existing && existingUrl !== url) {
    console.warn('Skipping ' + ns + ': already configured with a different URL (' + existingUrl + ')')
    continue
  }
  if (!existing) {
    const entry = { url: url }
    if (auth) {
      entry.headers = { Authorization: 'Basic \${DESIGN_KIT_AUTH}' }
    }
    if (stripDirective) {
      entry.params = { rsc: 'false' }
    }
    registries[ns] = entry.headers || entry.params ? entry : url
    added.push(ns)
  } else if (stripDirective) {
    augmented[ns] = existing
    const entry = typeof existing === 'string' ? { url: existing } : Object.assign({}, existing)
    entry.params = Object.assign({}, entry.params, { rsc: 'false' })
    registries[ns] = entry
  }
}

const changesConfig = added.length > 0 || Object.keys(augmented).length > 0

// Takes out the namespaces this run added and puts back the entries it gave
// \`params\`, whatever shadcn did to the rest of the file meanwhile.
function restoreConfig() {
  if (!changesConfig) {
    return
  }
  const fresh = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (fresh.registries) {
    for (const ns of added) {
      delete fresh.registries[ns]
    }
    for (const ns of Object.keys(augmented)) {
      fresh.registries[ns] = augmented[ns]
    }
    if (Object.keys(fresh.registries).length === 0) {
      delete fresh.registries
    }
  }
  fs.writeFileSync(configPath, JSON.stringify(fresh, null, 2) + '\\n')
}

if (changesConfig) {
  // Written directly (not \`shadcn registry add\`) so the entries can carry
  // the auth header; restoreConfig() puts the file back either way.
  config.registries = registries
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\\n')
}

// Non-interactive: the design kit is the source of truth and installed
// components are read-only vendored copies — skip confirmation prompts and
// overwrite differing existing files instead of hanging on a prompt. npx gets
// --yes too: running this script is the consent to fetch shadcn, and without
// it npx asks again, or cancels when npm's \`yes\` config is false.
// Spread, so every target is its own argument. Joining them into one string
// would hand shadcn a single item whose name contains spaces, which resolves
// to nothing and reports no error worth reading.
const args = ['--yes', SHADCN, 'add', '--yes', '--overwrite', ...TARGETS]

// shadcn writes the whole report of a failure, its reason included, to stdout,
// and nothing to stderr. A caller that keeps only stderr of a failed command,
// as agent tool runners do, would get no reason at all. So stdout is passed on
// as it arrives and also kept; on failure it is written to stderr again, under
// a line naming the command.
//
// No partial handling on purpose: a failure restores components.json and exits
// non-zero. A component that cannot be installed is the kit's defect or the
// component's, and neither is this installer's to absorb by carrying on.
const output = []
let finished = false
function finish(failure, exitCode) {
  if (finished) {
    return
  }
  finished = true
  restoreConfig()
  if (!failure) {
    return
  }
  const shown = Buffer.concat(output).toString('utf8')
  if (shown.trim()) {
    process.stderr.write('\\nOutput of npx ' + args.join(' ') + ':\\n' + shown + (shown.endsWith('\\n') ? '' : '\\n'))
  }
  console.error('\\n' + failure)
  process.exitCode = exitCode || 1
}

const child = spawn('npx', args, { stdio: ['inherit', 'pipe', 'inherit'] })
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk)
  output.push(chunk)
})
child.on('error', (err) => {
  finish('Could not run npx ' + args.join(' ') + ': ' + err.message, 1)
})
child.on('close', (code, signal) => {
  if (code === 0) {
    finish(null, 0)
    return
  }
  const how = signal ? 'was stopped by ' + signal : 'exited with code ' + code
  finish('npx ' + args.join(' ') + ' ' + how + '. components.json is restored; nothing else was undone.', code)
})
`
}
