// ── The shadcn CLI the kit runs and shows ────────────────────────────
// Every command the kit generates names this one version: the install script
// it serves and the commands its install popover offers to copy.
//
// Pinned rather than `@latest`, so every install runs the one release that
// server/shadcn-tailwind-css.ts is vendored from, and a new shadcn release
// does not make npx download and install a different CLI. npx still asks the
// npm registry for shadcn's metadata on every run (npm 10 revalidates it even
// when this version is in the npx cache); only a consumer that has this
// version installed locally runs without that request.
//
// Updating it: change the version here, re-vendor server/shadcn-tailwind-css.ts
// from the same release (server/install-script.test.mts fails while the two
// name different versions), and run one install with the new version into a
// shadcn project before publishing.
export const SHADCN_VERSION = '4.21.0'

/** The npm package spec to hand npx: `shadcn@<version>`. */
export const SHADCN_PACKAGE = `shadcn@${SHADCN_VERSION}`
