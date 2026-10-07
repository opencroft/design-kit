// What an install URL is asking to install.
//
// One parameter serves both cases. `component=<project>.<name>` installs that
// component; `component=<project>` installs every component of that project.
// The second is the first with its component half left off — the same
// parameter, the same route, the same `npx` line. It is deliberately not a
// flag, not an option and not a second endpoint: it is a shortcut in the
// syntax that already exists, and anything else would be a new surface to
// learn and to keep working.
//
// The legacy `project=` + `name=` pair is still read, because install commands
// carrying it are already copied into other repositories' documentation. Its
// precedence is the one the grammar module already documents: a `component`
// reference names the project as well, so when a caller sends both, the
// reference wins.
//
// Host-free on purpose, like the grammar it builds on: this is the decision
// the route makes before it touches a database, and keeping it here is what
// lets it be asserted directly rather than read.

import { parseComponentRef, stripItemSuffix } from '../src/registry/component-ref.ts'

export type InstallRequest =
  /** One component of one project. */
  | { kind: 'component'; project: string; name: string }
  /** Every component of one project. */
  | { kind: 'project'; project: string }

/**
 * Read an install request off the query parameters, or null when they name
 * nothing installable.
 *
 * A bare `component` value — one with no separator in it — is a PROJECT. That
 * reading is safe precisely because the grammar requires both halves for a
 * reference: a value that fails to parse as one cannot be a half-written
 * reference, because there is no one-part reference form to confuse it with.
 */
export function installRequestFrom(component: unknown, project: unknown, name: unknown): InstallRequest | null {
  const ref = parseComponentRef(component)
  if (ref) {
    return { kind: 'component', project: ref.project, name: ref.name }
  }

  // The separate pair, read only when there is no reference to prefer.
  const pairProject = stripItemSuffix(project)
  const pairName = stripItemSuffix(name)
  if (pairProject && pairName) {
    return { kind: 'component', project: pairProject, name: pairName }
  }

  const whole = stripItemSuffix(component)
  return whole ? { kind: 'project', project: whole } : null
}
