import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { commitAs, committerOf, UNNAMED_AUTHOR } from './commit-identity.ts'

const run = promisify(execFile)

const hasGit = await run('git', ['--version']).then(
  () => true,
  () => false,
)

// A commit made the way a component is published, in a repository with no
// identity configured anywhere: no global or system config, no EMAIL in the
// environment. `repoConfig` is written into the repository's own config first,
// the way a repository created before per-commit identities still carries one.
async function commitIn(author: string, repoConfig: Record<string, string> = {}): Promise<{ author: string; committer: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'commit-identity-'))
  try {
    const env = { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' }
    const git = (...args: string[]) => run('git', ['-C', dir, ...args], { env })
    await git('init', '--quiet')
    for (const [key, value] of Object.entries(repoConfig)) {
      await git('config', key, value)
    }
    await writeFile(join(dir, 'button.tsx'), 'export const Button = 1\n')
    await git('add', 'button.tsx')
    await git('-c', 'commit.gpgsign=false', '-c', 'user.useConfigOnly=true', ...commitAs(author), 'commit', '--quiet', '-m', 'Publish button v1')
    const { stdout } = await git('log', '-1', '--format=%an <%ae>%n%cn <%ce>')
    const [authorLine, committerLine] = stdout.trim().split('\n')
    return { author: authorLine, committer: committerLine }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("a publish is committed under the caller's name, with no email", { skip: !hasGit && 'git is not installed' }, async () => {
  assert.deepEqual(await commitIn('Alice Example'), { author: 'Alice Example <>', committer: 'Alice Example <>' })
})

test("a repository whose config still names an identity is committed under the caller's name", { skip: !hasGit && 'git is not installed' }, async () => {
  const configured = { 'user.name': 'Example Kit', 'user.email': 'kit@example.com' }
  assert.deepEqual(await commitIn('agent-a', configured), { author: 'agent-a <>', committer: 'agent-a <>' })
})

test('a caller with no usable name is committed as the unnamed author', { skip: !hasGit && 'git is not installed' }, async () => {
  assert.deepEqual(await commitIn('  '), { author: `${UNNAMED_AUTHOR} <>`, committer: `${UNNAMED_AUTHOR} <>` })
})

test('angle brackets and line breaks cannot break the ident line', () => {
  assert.deepEqual(commitAs('agent-a <x@example.com>\nsecond'), ['-c', 'user.name=agent-a x@example.com second', '-c', 'user.email='])
})

test('the committer is the signed-in person, else the calling agent, else the unnamed author', () => {
  assert.equal(committerOf({ callerPerson: { name: 'Alice Example' } }), 'Alice Example')
  assert.equal(committerOf({ callerAgent: 'agent-a' }), 'agent-a')
  assert.equal(committerOf({}), UNNAMED_AUTHOR)
})
