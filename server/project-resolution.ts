// Which project a `?project=` value names, and the namespace that project
// publishes under.
//
// Kept free of the host for one reason: what tells a right implementation of
// this precedence from a wrong one is a project whose display name does not
// slugify to its slug, and a library holding no such project cannot show it.
// When the two agree, both implementations answer alike on every input, so a
// green run there is not evidence either way. Here that state is a fixture,
// and the test asserts it is still divergent before using it.

import { namespaceOf, slugify } from './target.ts'

/** An App instance, by the two addresses of it that a rename cannot move. */
export interface ResolvableInstance {
  instanceId: string
  slug: string
}

/** A row of the project list: a legacy KV project, or an instance carrying its slug. */
export interface ResolvableProject {
  id: string
  name: string
  slug?: string
}

/**
 * The three lists this reads, each behind a function so a step that is never
 * reached is never paid for. Resolving by slug is the common case and answers
 * from the first list alone; the other two involve further storage reads, and
 * one of them a filesystem read per instance.
 */
export interface ProjectReaders {
  instances: () => Promise<ResolvableInstance[]>
  aliases: () => Promise<Record<string, string>>
  projects: () => Promise<ResolvableProject[]>
}

export interface ResolvedProject {
  id: string
  ns: string
}

/**
 * Resolve a `?project=` value to the project it names and the namespace that
 * project publishes under.
 *
 * The order is the precedence, and each step is a different kind of address:
 *
 * 1. An App instance's slug or its instanceId. Both are permanent — the slug is
 *    the address its repo is stored under, and a rename is the host's and does
 *    not touch it.
 * 2. A retired project id, through the alias table. That table exists because
 *    the `?project=<id>` URLs baked into consumers' configs outlive the record
 *    they named, and it answers with the CANONICAL namespace rather than with
 *    the string it was asked by.
 * 3. A legacy KV project, by its id or by its name slugified. A legacy row has
 *    no slug of its own, so its namespace genuinely IS its name slugified.
 *
 * **Step 3's name match is for rows with no slug only, and that is what this
 * function exists to get right.** The list it searches carries App instances
 * too, so a name match that ignored the slug would let a renamed instance
 * answer under a second namespace — its slug AND its slugified display name,
 * each serving a full dependency graph spelled in whichever form was asked for.
 * Nothing would fail: every install would succeed under either name, and the
 * payload would agree with the question, so the split would be invisible.
 * Excluding rows that carry a slug removes the second address and leaves the
 * permanent ones. It is the same sentence as `namespaceOf`'s, read as a question about
 * which rows the fallback is for, which is why both live beside `slugify`.
 *
 * A consumer that installed under the display-name form gets a 404 here
 * instead of a working install. The fix for such a consumer is an alias row at
 * step 2 — a deliberate address that answers canonically, which splits
 * nothing — and never a name match on rows that carry a slug.
 *
 * Nothing found is not an error: the caller looks the component up next and
 * reports the miss against the reference it was given, rather than this layer
 * inventing a message about a project the caller never claimed existed.
 */
export async function resolveProjectRef(param: string, read: ProjectReaders): Promise<ResolvedProject> {
  const instances = await read.instances()
  const instance = instances.find((i) => i.slug === param || i.instanceId === param)
  if (instance) {
    return { id: instance.instanceId, ns: instance.slug }
  }
  const aliased = (await read.aliases())[param]
  if (aliased) {
    const target = instances.find((i) => i.instanceId === aliased)
    if (target) {
      return { id: target.instanceId, ns: target.slug }
    }
  }
  const projects = await read.projects()
  const p = projects.find((x) => x.id === param) ?? projects.find((x) => !x.slug && slugify(x.name) === param)
  return p ? { id: p.id, ns: namespaceOf(p) } : { id: param, ns: slugify(param) }
}
