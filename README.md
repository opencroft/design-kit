# Design Kit

Design projects for OpenCroft. Each **Design Kit App instance** is one
project: a categorized **component & hook library** — a categorized sidebar
plus a documentation panel with live previews and copy-paste usage code — that
also serves a shadcn-compatible registry, so its components install into other
projects with the shadcn CLI.

## App instances

One instance = one project, stored as a git repository in the instance's data
directory (`server/repo-store.ts`): the working tree is the draft, `HEAD` is
what installers are served, and a publish is one commit plus a version tag.
The instance's slug is the project's registry namespace, minted from its name
at add time. The editor lives on the app page
(`/space/<space>/app/<instanceId>`); agents drive the same surface through the
instance's `app_call` actions (declared in `extension.json`).

## Isolated previews

Previews render inside an **iframe** served by this extension (see
`server/preview.ts` + `preview-runtime/`), not in the host page — so OpenCroft's
styles can't leak in and a design's styles can't leak out. Inside the frame:

- **Tailwind** is compiled by `@tailwindcss/browser` against the project's own
  theme, so *any* class a stored design uses works (arbitrary values, chart
  colors, variants) — not just the classes the host happens to ship.
- **Theme** is per-project: a shadcn default (neutral/zinc/slate/gray/stone) or
  custom token CSS, edited from the sidebar's *Theme* dialog and stored on the
  project. Standard shadcn variable names only — installed components read the
  same tokens.
- **Fit-content sizing**: the frame reports its content height, so a preview
  grows to fit anything from a badge to a full page (capped with a *Show all*
  expander; *Open* launches the design standalone in a new tab).
- **npm dependencies** a component imports are bundled on demand
  (`preview/dep`) and share the frame's React via an import map, so a
  `dependencies` package renders in the preview exactly as it will on install.

## Registry (shadcn-shaped)

Every project serves a shadcn-shaped registry over the extension's HTTP route,
`/api/ext/<extension-id>/http/…` (`<extension-id>` is the id the instance runs
this extension under, e.g. `acme.design-kit`): the index, per-item JSON, and a
one-line install script. Components live in the project's repository at their
served paths (`components/…`), with meta under `registry/<name>.json` and doc
files under `internal/<name>/docs/`.

### Addressing a component

One component is named as a single reference — `<project>.<name>`, or
`<project>/<name>`. `<project>` is the project's namespace (its slugified name)
or its storage id. Both forms read the same everywhere a component is addressed
(`src/registry/component-ref.ts`); the dot is what every link and command hands
out, because it carries through a path or a filename without picking up a
second meaning:

| Where | Form |
| --- | --- |
| Registry item | `<host>/api/ext/<extension-id>/http/registry?component=<project>.<name>` |
| One-line install | `npx "<host>/api/ext/<extension-id>/http/install?component=<project>.<name>"` |

The `registries` template a consumer's `components.json` holds keeps the
separate `project` / `name` pair, because the `{name}` its client substitutes
has to be a query value of its own. Both routes still read that pair.

## Docs

A component's documentation is `docs/doc.mdx`: markdown prose with
self-closing `<Preview>`, `<Sheet>` and `<Example>` tags that render live
previews (`src/live/doc-parser.ts`, `src/live/mdx.tsx`). The prose renders
with `react-markdown` + `remark-gfm`; raw HTML in a doc is not rendered.

## Layout

| Path | Purpose |
| --- | --- |
| `extension.json` | Manifest + `provides.apps` + the app action schemas |
| `src/client.tsx` | Binds the app view |
| `src/design-kit-app-view.tsx` | The app page: library nav, docs, source editor |
| `src/components/*` | The library's display pieces (nav, doc, preview, install, source editor) |
| `src/registry/*` | The reference grammar + client-side registry shaping |
| `server/index.ts` | Extension actions, app actions, and the registry HTTP routes |
| `preview-runtime/*` | The code that runs inside the preview iframe |

`dist/` and `node_modules/` are git-ignored.

## Tests

```sh
npm test
```

## License

MIT — see [LICENSE](LICENSE).
