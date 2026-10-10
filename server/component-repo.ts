import { execFile, fs, path as nodePath } from '@opencroft/server/system'

import { commitAs } from './commit-identity'
import { porcelainPaths, stagedPathsIn } from './staged-paths'

// Git-backed storage for one design project: one repo in the App instance's
// dataDir, the same pattern the Documentation app uses. Layout-agnostic on
// purpose — callers choose file paths and the per-component tag name; this
// module only runs git and the working tree. Everything goes through
// execFile('git') and fs (@opencroft/server/system), both available in actions AND raw route
// handlers, so the registry routes read through here too (no request context,
// no materialised checkout).
//
// The model: the working tree is the DRAFT (uncommitted edits); HEAD is
// PUBLISHED; a publish is one commit plus a tag `component/<name>/v<N>` on it.
// A commit therefore only ever happens at publish — which is what makes an
// untagged publish detectable (a commit past a component's highest tag).

async function git(dir: string, ...args: string[]): Promise<string> {
  return execFile('git', ['-c', 'safe.directory=*', '-C', dir, ...args.filter((a) => a !== '')])
}

export function repoDir(instance: { dataDir: string }): string {
  return instance.dataDir
}

export async function isRepo(dir: string): Promise<boolean> {
  return fs
    .access(`${dir}/.git`)
    .then(() => true)
    .catch(() => false)
}

/**
 * Create the repo if absent. It is given no identity: every commit names its
 * own, the caller's, through `commitAs`.
 */
export async function ensureRepo(dir: string): Promise<void> {
  if (await isRepo(dir)) {
    return
  }
  await fs.mkdir(dir, { recursive: true })
  await git(dir, 'init', '-q', '-b', 'main')
}

// ── Draft (working tree) ──────────────────────────────────

export async function readWorking(dir: string, path: string): Promise<string | null> {
  return fs
    .readFile(`${dir}/${path}`, 'utf-8')
    .then((c: string) => c)
    .catch(() => null)
}

/**
 * Write a draft file and stage it.
 *
 * The staging is load-bearing, not housekeeping: the index is what both the
 * draft marker and the component's state token read, so it has to be a
 * faithful record of what a reader was handed. Nothing may skip it for
 * convenience — a write left unstaged is a change neither of them can see.
 */
export async function writeWorking(dir: string, path: string, content: string): Promise<void> {
  await fs.mkdir(nodePath.dirname(`${dir}/${path}`), { recursive: true })
  await fs.writeFile(`${dir}/${path}`, content, 'utf-8')
  await git(dir, 'add', '--', path)
}

export async function removeWorking(dir: string, path: string): Promise<void> {
  // Staged/tracked: `git rm`; untracked: unlink. --ignore-unmatch covers both.
  await git(dir, 'rm', '-f', '--ignore-unmatch', '--', path)
  await fs.rm(`${dir}/${path}`).catch(() => {})
}

/**
 * Return one path to what the published head has: its content if the head
 * carries it, gone if it does not.
 *
 * **From HEAD, not from the index.** `git checkout -- <path>` restores a file
 * from the INDEX, and every draft write stages what it wrote — so against a
 * saved edit that form restores the edit onto itself and changes nothing,
 * while against a staged deletion it fails outright because the path is no
 * longer in the index to restore from. Naming HEAD is what makes this a
 * discard rather than a no-op, and it resets the index entry too, which is
 * what lets the draft marker and the state token see the component come back.
 */
export async function discardWorking(dir: string, path: string): Promise<void> {
  if (await pathInHead(dir, path)) {
    await git(dir, 'checkout', 'HEAD', '--', path)
    return
  }
  await git(dir, 'rm', '--cached', '--ignore-unmatch', '--', path).catch(() => {})
  await fs.rm(`${dir}/${path}`).catch(() => {})
}

/** Paths with uncommitted changes — the draft-ahead set. */
export async function changedPaths(dir: string): Promise<string[]> {
  return porcelainPaths(await git(dir, 'status', '--porcelain'))
}

/**
 * Git's index entries for a set of paths: mode, object id, stage and path.
 *
 * This is the same instrument the draft marker reads, asked a narrower
 * question. Every draft write stages what it wrote, so these entries are git's
 * own record of the state a reader was handed — which is what makes them
 * usable as a concurrency token without storing one.
 *
 * An empty pathspec would list the WHOLE index, so it answers with nothing
 * instead: no paths is no state, not everything's.
 */
export async function stagedState(dir: string, paths: string[]): Promise<string> {
  return paths.length > 0 ? git(dir, 'ls-files', '-s', '--', ...paths) : ''
}

// ── Published (HEAD) ──────────────────────────────────────

/** The published head's sha, or null before the first commit. */
export async function headSha(dir: string): Promise<string | null> {
  return git(dir, 'rev-parse', 'HEAD')
    .then((s) => s.trim() || null)
    .catch(() => null)
}

export async function pathInHead(dir: string, path: string): Promise<boolean> {
  return git(dir, 'cat-file', '-e', `HEAD:${path}`)
    .then(() => true)
    .catch(() => false)
}

export async function readHead(dir: string, path: string): Promise<string | null> {
  return git(dir, 'show', `HEAD:${path}`).catch(() => null)
}

/** Every file path published at HEAD, optionally under a prefix. Empty before the first commit. */
export async function listHead(dir: string, prefix = ''): Promise<string[]> {
  const args = prefix
    ? ['ls-tree', '-r', '--name-only', 'HEAD', '--', prefix]
    : ['ls-tree', '-r', '--name-only', 'HEAD']
  const out = await git(dir, ...args).catch(() => '')
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

// ── Publish: one commit, then the version tag ─────────────

export function componentTag(name: string, version: number): string {
  return `component/${name}/v${version}`
}

/**
 * Commit ONLY the given paths (the `git commit -- <paths>` form the
 * Documentation app publishes with) — so publishing one component never sweeps
 * another component's draft into the commit. Returns the new HEAD sha, or null
 * when none of the paths had changes.
 *
 * Paths that no longer exist are welcome: a removal a draft flow staged
 * (`git rm`, leaving the path in neither the working tree nor the index) must
 * ride the same commit, and `git add` on such a path is fatal — so only
 * existing paths are added, and the commit pathspec is limited to what status
 * reports, because a pathspec commit refuses the WHOLE commit over one path
 * unknown to git. One commit carrying staged content changes and staged
 * deletions together works, and leaves everything outside the pathspec
 * untouched (all measured 10.09.2026).
 *
 * The commit is made under `author`'s name, with no email (`commitAs`).
 */
export async function commitPaths(
  dir: string,
  message: string,
  paths: string[],
  author: string,
): Promise<string | null> {
  if (paths.length === 0) {
    return null
  }
  const existing: string[] = []
  for (const p of paths) {
    const present = await fs
      .access(`${dir}/${p}`)
      .then(() => true)
      .catch(() => false)
    if (present) {
      existing.push(p)
    }
  }
  if (existing.length > 0) {
    await git(dir, 'add', '--', ...existing)
  }
  const status = await git(dir, 'status', '--porcelain', '--', ...paths)
  const changed = stagedPathsIn(status, paths)
  if (changed.length === 0) {
    return null
  }
  await git(dir, ...commitAs(author), 'commit', '-q', '-m', message, '--', ...changed)
  return (await git(dir, 'rev-parse', 'HEAD')).trim()
}

/**
 * Commit changes ALREADY staged for the given paths — the removal-flow
 * counterpart to commitPaths. commitPaths runs `git add -- <paths>` first,
 * which is right for content that exists; a removal flow has already
 * `git rm`ed its paths, leaving them in neither the working tree nor the
 * index, and `git add` on such a path is fatal — "pathspec did not match any
 * files" from a sequence that succeeded (measured 10.09.2026). The commit is
 * further limited to the paths status actually reports, because a pathspec
 * commit refuses the WHOLE commit over one path unknown to git. Made under
 * `author`'s name, as commitPaths is.
 */
export async function commitStagedRemovals(
  dir: string,
  message: string,
  paths: string[],
  author: string,
): Promise<string | null> {
  if (paths.length === 0) {
    return null
  }
  const status = await git(dir, 'status', '--porcelain', '--', ...paths)
  const present = stagedPathsIn(status, paths)
  if (present.length === 0) {
    return null
  }
  await git(dir, ...commitAs(author), 'commit', '-q', '-m', message, '--', ...present)
  return (await git(dir, 'rev-parse', 'HEAD')).trim()
}

/** Every path touched by a commit since the given ISO date (or `git log --since` expression). */
export async function pathsChangedSince(dir: string, since: string): Promise<string[]> {
  const out = await git(dir, 'log', `--since=${since}`, '--name-only', '--pretty=format:').catch(() => '')
  return [
    ...new Set(
      out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ]
}

/** Tracked + untracked (non-ignored) files in the working tree, optionally under a prefix. */
export async function listWorkingFiles(dir: string, prefix = ''): Promise<string[]> {
  const args = ['ls-files', '--cached', '--others', '--exclude-standard']
  if (prefix) {
    args.push('--', prefix)
  }
  const out = await git(dir, ...args).catch(() => '')
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** Regex search over the working tree (tracked + untracked), line-oriented. */
export async function grepWorking(
  dir: string,
  pattern: string,
  flags = '',
): Promise<Array<{ path: string; line: number; text: string }>> {
  const args = ['grep', '-n', '--untracked', '-E']
  if (flags.includes('i')) {
    args.push('-i')
  }
  args.push('-e', pattern)
  const out = await git(dir, ...args).catch(() => '')
  const rows: Array<{ path: string; line: number; text: string }> = []
  for (const raw of out.split('\n').filter(Boolean)) {
    const first = raw.indexOf(':')
    const second = raw.indexOf(':', first + 1)
    if (first < 0 || second < 0) {
      continue
    }
    rows.push({ path: raw.slice(0, first), line: Number(raw.slice(first + 1, second)), text: raw.slice(second + 1) })
  }
  return rows
}

export async function tagVersion(dir: string, name: string, version: number, ref = 'HEAD'): Promise<void> {
  await git(dir, 'tag', componentTag(name, version), ref)
}

/** The published version of one component, or 0 when it has never been published. */
export async function highestVersion(dir: string, name: string): Promise<number> {
  const out = await git(dir, 'for-each-ref', '--format=%(refname)', `refs/tags/component/${name}/`).catch(() => '')
  let max = 0
  for (const line of out.split('\n')) {
    const m = line.match(/\/v(\d+)$/)
    if (m) {
      max = Math.max(max, Number(m[1]))
    }
  }
  return max
}

/** A component's published versions, newest first: version, the commit it tags, its date and author. */
export async function componentRevisions(
  dir: string,
  name: string,
): Promise<Array<{ version: number; sha: string; at: string; author: string }>> {
  // NUL separators, because an author name contains spaces. A lightweight tag
  // points straight at its commit, so authorname is the commit's author — the
  // name the publish commit was made under.
  const out = await git(
    dir,
    'for-each-ref',
    '--sort=-v:refname',
    '--format=%(refname)%00%(objectname)%00%(creatordate:iso-strict)%00%(authorname)',
    `refs/tags/component/${name}/`,
  ).catch(() => '')
  const rows: Array<{ version: number; sha: string; at: string; author: string }> = []
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, sha, at, author] = line.split('\0')
    const m = ref?.match(/\/v(\d+)$/)
    if (m) {
      rows.push({ version: Number(m[1]), sha: sha ?? '', at: at ?? '', author: author ?? '' })
    }
  }
  return rows
}

/** Current published version of every component — the whole index in one process. */
export async function componentVersions(dir: string): Promise<Record<string, number>> {
  const out = await git(dir, 'for-each-ref', '--format=%(refname)', 'refs/tags/component/').catch(() => '')
  const versions: Record<string, number> = {}
  for (const line of out.split('\n')) {
    const m = line.match(/^refs\/tags\/component\/(.+)\/v(\d+)$/)
    if (m) {
      const [, name, v] = m
      versions[name] = Math.max(versions[name] ?? 0, Number(v))
    }
  }
  return versions
}

// ── History / revisions ───────────────────────────────────

export async function showAt(dir: string, ref: string, path: string): Promise<string | null> {
  return git(dir, 'show', `${ref}:${path}`).catch(() => null)
}

export interface RepoLogEntry {
  sha: string
  message: string
  at: string
}

export async function log(dir: string, paths: string[] = [], limit = 50): Promise<RepoLogEntry[]> {
  const args = ['log', `--max-count=${limit}`, '--pretty=format:%H%x00%s%x00%aI']
  if (paths.length > 0) {
    args.push('--', ...paths)
  }
  const out = await git(dir, ...args).catch(() => '')
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, message, at] = line.split('\0')
      return { sha: sha ?? '', message: message ?? '', at: at ?? '' }
    })
}

/** Paths changed between two refs (e.g. a version tag and HEAD), optionally scoped. */
export async function diffNames(dir: string, from: string, to: string, paths: string[] = []): Promise<string[]> {
  const args = ['diff', '--name-only', `${from}..${to}`]
  if (paths.length > 0) {
    args.push('--', ...paths)
  }
  const out = await git(dir, ...args).catch(() => '')
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

// ── The commit/tag atomicity invariant ────────────────────
// A publish is `commitPaths` then `tagVersion`. A crash between leaves a commit
// with no tag. Because the working tree holds drafts, a commit happens ONLY at
// publish — so a component whose paths changed in commits newer than its
// highest tag has an untagged publish. Detect it, and repair by tagging HEAD.

export async function untaggedPublishHeads(dir: string, componentPaths: Record<string, string[]>): Promise<string[]> {
  const untagged: string[] = []
  for (const [name, paths] of Object.entries(componentPaths)) {
    const v = await highestVersion(dir, name)
    const since = v > 0 ? `${componentTag(name, v)}..HEAD` : 'HEAD'
    const args = ['log', '--oneline', since]
    if (paths.length > 0) {
      args.push('--', ...paths)
    }
    const out = await git(dir, ...args).catch(() => '')
    if (out.trim()) {
      untagged.push(name)
    }
  }
  return untagged
}
