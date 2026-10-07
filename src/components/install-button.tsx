import { icons } from '@ext/host'
import ui, { Button } from '@ext/ui'

import { CodeBlock } from '@opencroft/client'

import { formatComponentRef } from '../registry'

const { Popover, PopoverTrigger, PopoverContent } = ui as Record<string, React.ComponentType<Record<string, unknown>>>

// Install affordance. Three ways to pull the component with the shadcn CLI:
//   1. One-line install script — resolves the FULL cross-project dependency
//      graph, temporarily registers whatever namespaces it touches, runs the
//      real `shadcn add`, then removes only the registries it added. This is
//      the only option that works when the component (or a sibling it
//      depends on) has registryDependencies — shadcn can't resolve those
//      without a registries entry, even for same-project references.
//   2. Direct URL — no config, but only correct for a component with no
//      registryDependencies of its own.
//   3. Named registry — add the registry to components.json once, then use
//      the `@<namespace>/<name>` shorthand.
export interface InstallButtonProps {
  name: string
  namespace: string
  /** The absolute URL the design kit's HTTP routes sit under; the commands point at it. */
  httpUrl: string
  defaultOpen?: boolean
}

export function InstallButton({ name, namespace, httpUrl, defaultOpen }: InstallButtonProps) {
  const Terminal = icons.Terminal
  const http = httpUrl.replace(/\/+$/, '')
  const ref = formatComponentRef(namespace, name)
  const installCmd = `npx "${http}/install?component=${ref}"`
  const directCmd = `npx shadcn@latest add "${http}/registry?component=${ref}"`
  // The template keeps the separate project/name pair: `{name}` is substituted
  // by the client, so it has to be a whole query value of its own.
  const registrySnippet = `{
  "registries": {
    "@${namespace}": "${http}/registry?project=${namespace}&name={name}"
  }
}`
  const namedCmd = `npx shadcn@latest add @${namespace}/${name}`

  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger render={<Button variant='outline' size='sm' className='shrink-0 gap-1.5' />}>
        <Terminal className='h-3.5 w-3.5' />
        Install
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[34rem] max-w-[90vw] p-3'>
        <div className='space-y-1.5'>
          <div className='text-xs font-medium text-muted-foreground'>Install — resolves cross-project dependencies automatically</div>
          <CodeBlock code={installCmd} language='bash' />
        </div>
        <div className='space-y-1.5'>
          <div className='text-xs font-medium text-muted-foreground'>Direct URL — no config (only if this component has no design-kit dependencies)</div>
          <CodeBlock code={directCmd} language='bash' />
        </div>
        <div className='space-y-1.5'>
          <div className='text-xs font-medium text-muted-foreground'>Or register once in components.json, then use the short name</div>
          <CodeBlock code={registrySnippet} language='json' />
          <CodeBlock code={namedCmd} language='bash' />
        </div>
      </PopoverContent>
    </Popover>
  )
}
