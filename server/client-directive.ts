// The `'use client'` directive, removed here rather than by the installer.
//
// shadcn's add drops a leading `'use client'` from every file it writes into a
// project whose components.json says `rsc: false`. Its test is a module-level
// regex carrying the `g` flag, so `lastIndex` survives from one file to the
// next: after a file loses the directive, the next file's test starts past the
// end of its text and fails. Within one install the 1st, 3rd, 5th… file that
// starts with the directive loses it and the others keep it. As of shadcn
// 4.21.3, whose transform comes from @shadcn/registry 0.1.2:
//
//   var s=/^["']use client["']$/g, …; return r&&s.test(r.getText())&&r.remove(),t
//
// The registry therefore serves files with the directive already gone when the
// installer says the consumer is not RSC (`rsc=false`). The CLI then finds no
// directive to test, `lastIndex` never moves, and every file of the install
// comes out the same. An `rsc: true` consumer sends nothing and gets the
// sources unchanged, which is what the CLI leaves alone for it too.
//
// Host-free, so it can be asserted directly.

/**
 * Leading comments and whitespace, the directive in either quote, an optional
 * semicolon, and the line breaks after it. The directive must end its
 * statement — `'use client'.length` is an expression, not a directive.
 * Deliberately not global: a `g` regex used through `test`/`exec` is exactly
 * the defect described above.
 */
const LEADING_DIRECTIVE = /^((?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*)(["'])use client\2[ \t]*;?(?=[ \t]*(?:\r?\n|$|\/\/|\/\*))(?:[ \t]*\r?\n)*/

/**
 * `source` without a leading `'use client'` directive. Comments above it stay;
 * the directive line and the blank lines after it go, which is what the CLI's
 * own removal leaves for a single file. A `'use client'` that is not the first
 * statement is not a directive and is left alone.
 */
export function stripClientDirective(source: string): string {
  return source.replace(LEADING_DIRECTIVE, '$1')
}

/**
 * Whether a registry request asks for the directive to be removed: the
 * installer adds `rsc=false` for a consumer whose components.json is not RSC.
 * Anything else, including no parameter at all, serves the sources as stored.
 */
export function stripsClientDirective(url: URL): boolean {
  return url.searchParams.get('rsc') === 'false'
}
