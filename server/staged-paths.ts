// Parsers over `git status --porcelain` output: the subset of the requested
// paths a scoped commit may actually name, and the full changed-path census.
//
// Why this exists: `git commit -- <pathspec>` refuses the WHOLE commit when
// any one pathspec matches nothing known to git, while `git status` is
// lenient about exactly that and simply lists what does match (both measured
// 10.09.2026). So the status output is the reliable census of what a
// commit-by-pathspec can carry, and the commit must be limited to it.
//
// Untracked entries (`??`) are excluded: status lists them, but a pathspec
// commit rejects them the same way it rejects unknown paths.

export function stagedPathsIn(porcelain: string, paths: string[]): string[] {
  const listed = new Set<string>()
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) {
      continue
    }
    if (line.startsWith('??')) {
      continue
    }
    for (const side of sidesOf(line)) {
      listed.add(side)
    }
  }
  return paths.filter((p) => listed.has(p))
}

/**
 * Every path a porcelain status names, untracked included — the draft-ahead
 * census. A rename line contributes both of its paths: the old side is a
 * removal and the new side an addition, and a reader keeping the fused
 * `old -> new` string would recognise neither (a staged rename is one
 * `R old -> new` line — measured 10.09.2026).
 */
export function porcelainPaths(porcelain: string): string[] {
  const listed = new Set<string>()
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) {
      continue
    }
    for (const side of sidesOf(line)) {
      if (side) {
        listed.add(side)
      }
    }
  }
  return [...listed]
}

// Rename/copy lines name two paths (`R  old -> new`); both sides are part
// of the change, so both count.
function sidesOf(line: string): string[] {
  return line.slice(3).split(' -> ').map(unquote)
}

// git quotes paths containing specials (core.quotePath) as C-style strings.
// Component paths are slug-built and never need it, but a quoted line must
// not silently fall out of the intersection.
function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\(["\\tn])/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c))
  }
  return p
}
