import { type AppActionHandler, type AppInstanceContext, type AppsExport, apps } from '@opencroft/server/apps'

import { ensureRepo } from './component-repo'
import { reservedNamespaceReason } from './dependency-graph'
import { slugify } from './target'

// The Design Kit App: one instance = one design project, stored as a git repo
// in the instance's dataDir (server/component-repo.ts + server/repo-store.ts).
// The instance IS the project — there is no separate project id and no binding.
// The platform creates the dataDir before onAdded and deletes it after removal,
// so the repo's whole lifecycle rides the instance's: no onRemoved needed, and
// removing an instance takes its project with it (the platform's own
// convention).

export const APP_SLUG = 'design-kit'

export interface DesignKitAppDeps {
  /** The repo-backed action surface, built in index.ts where the component helpers live. */
  boundActions: Record<string, AppActionHandler>
}

export function createDesignKitApp(deps: DesignKitAppDeps): AppsExport {
  // The instance slug is the project's registry namespace and its `?project=`
  // address, so it must be unique across every Design Kit instance, not only
  // within a space. The platform enforces per-space uniqueness; this is the
  // library-wide layer. Best-effort against a concurrent add (read-then-throw,
  // no lock) — a lost race leaves one instance unreachable by slug, never two
  // answering to one address. An add-time refusal, the platform's convention.
  async function assertSlugGloballyFree(ctx: AppInstanceContext): Promise<void> {
    if (slugify(ctx.name) !== ctx.slug) {
      throw new Error(
        `The instance slug "${ctx.slug}" does not match this library's slug of "${ctx.name}" ("${slugify(ctx.name)}"). Pick a name whose letters and digits carry it.`,
      )
    }
    const reserved = reservedNamespaceReason(ctx.slug)
    if (reserved) {
      throw new Error(
        `Refusing the name "${ctx.name}": its namespace "@${ctx.slug}" is reserved. ${reserved} Pick a different name.`,
      )
    }
    const clash = (await apps.listInstances(APP_SLUG)).find(
      (i) => i.instanceId !== ctx.instanceId && i.slug === ctx.slug,
    )
    if (clash) {
      throw new Error(
        `The namespace "@${ctx.slug}" is already taken by the "${clash.name}" instance in the "${clash.spaceSlug}" space. Pick a different name.`,
      )
    }
  }

  return {
    [APP_SLUG]: {
      async onAdded(ctx) {
        await assertSlugGloballyFree(ctx)
        await ensureRepo(ctx.dataDir)
      },
      // Initialise the repo on load too — self-healing if the dataDir was lost.
      async onLoad(ctx) {
        await ensureRepo(ctx.dataDir)
      },
      // The app declares no parameters; reacting to nothing is the whole job.
      // Without this hook a parameter save would run the host's recreate flow
      // (unload → onRemoved → dataDir deleted), which would destroy the repo.
      async onUpdated() {},
      actions: deps.boundActions,
    },
  }
}
