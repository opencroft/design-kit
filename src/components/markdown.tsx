import { AppLink, useAppHref } from '@opencroft/client/app'
import { CodeBlock } from '@opencroft/client/code'
import { MermaidDiagram } from '@opencroft/client/markdown'
import type { ComponentProps } from 'react'
import type { Components, ExtraProps } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { inAppPath } from './component-routes'

// Markdown docs renderer — the prose between a doc's component segments.
// `../live/doc-parser` has already split `doc.mdx` into segments by the time
// anything reaches here; this renders one `{ kind: 'md' }` segment and nothing
// else. Splitting is still that parser's job alone.
//
// `react-markdown` + `remark-gfm` is what every other markdown surface in the
// product renders with, and it gives two things:
//
//   - A fence can BE a component. `pre` is overridden below, so a fenced block
//     renders as the host's `CodeBlock` and a `mermaid` fence as the diagram it
//     describes — the same blocks the chat shows, sharing the host's single
//     highlighter and its grammar cache instead of a second copy per extension.
//   - Raw HTML in the source is not rendered. A `doc.mdx` is written by agents
//     through this app rather than reviewed in a repository, so a tag such as
//     `<img src=x onerror=…>` in a doc must not reach the page intact.
//     `rehype-raw` is DELIBERATELY not added: dropping raw HTML here is the
//     point, not a regression to restore.
//
// Element styling is Tailwind descendant variants, which the per-extension
// Tailwind pass compiles from this source. The selectors match the plain
// elements `react-markdown` renders — and `[&_pre]` reaches the `pre` inside
// `CodeBlock`, which is how the block gets its frame (the chat's
// `.prose-chat pre` does exactly this; `CodeBlock` deliberately carries no
// frame of its own).
const PROSE =
  'text-sm leading-relaxed ' +
  '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold ' +
  '[&_h3]:mt-4 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-medium ' +
  '[&_p]:my-2 [&_p]:text-muted-foreground ' +
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:text-muted-foreground ' +
  '[&_a]:text-primary [&_a]:underline ' +
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs ' +
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/40 [&_pre]:p-3 [&_pre]:text-xs ' +
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 ' +
  '[&_table]:my-3 [&_table]:w-full [&_table]:text-left [&_table]:text-xs ' +
  '[&_th]:border-b [&_th]:px-2 [&_th]:py-1.5 [&_th]:font-medium ' +
  '[&_td]:border-b [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-muted-foreground [&_td]:align-top'

/**
 * The code inside a fenced block, read from the markdown tree rather than from
 * the rendered children.
 *
 * `pre` is overridden rather than `code` because `code` is also every inline
 * span, and a fence with no language is indistinguishable from inline code by
 * its props alone. The tree says plainly which is which, and it carries the
 * text unescaped, which is what a code block and a copy button both need.
 *
 * Anything that is not exactly one `code` element of plain text is not ours to
 * claim, and the caller renders it as a plain `pre`.
 */
function fencedCode(node: ExtraProps['node']): { code: string; language?: string } | null {
  const only = node?.children?.length === 1 ? node.children[0] : undefined
  if (only?.type !== 'element' || only.tagName !== 'code') {
    return null
  }
  let text = ''
  for (const part of only.children) {
    if (part.type !== 'text') {
      return null
    }
    text += part.value
  }
  const classes = only.properties?.className
  const language = Array.isArray(classes)
    ? classes
        .map(String)
        .find((name) => name.startsWith('language-'))
        ?.slice('language-'.length)
    : undefined
  // Markdown always ends a fence's content with a newline. Keeping it would add
  // an empty last line to every block, and put one on the clipboard too.
  return { code: text.replace(/\n$/, ''), language }
}

function MarkdownPre({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const fence = fencedCode(node)
  if (!fence) {
    return <pre {...props}>{children}</pre>
  }
  // A `mermaid` fence is a picture somebody wrote in text. Rendering it as code
  // would be technically true and useless, which is why the language decides
  // what the block IS rather than only how it is coloured.
  if (fence.language === 'mermaid') {
    return <MermaidDiagram chart={fence.code} />
  }
  return <CodeBlock code={fence.code} language={fence.language} />
}

/**
 * A link written into a doc. One that leads to a page of this App — another
 * component of the project, written as its full address — moves the App in
 * place, as picking it from the tree does; any other link is left to the
 * browser.
 */
function MarkdownLink({ node, href, ...props }: ComponentProps<'a'> & ExtraProps) {
  const appHref = useAppHref()
  const to = href ? inAppPath(href, appHref('/'), window.location.origin) : null
  return to === null ? <a href={href} {...props} /> : <AppLink to={to} {...props} />
}

const markdownComponents: Components = { pre: MarkdownPre, a: MarkdownLink }

export function Markdown({ source }: { source: string }) {
  return (
    <div className={PROSE}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {source}
      </ReactMarkdown>
    </div>
  )
}
