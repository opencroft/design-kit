import { icons } from '@ext/host'
import { Button } from '@ext/ui'

// Source is NAVIGATION into the full-page editor, not a dialog: reading source
// and changing it are the same surface. A read-only dialog would show the
// published copy while the editor works on the draft — two surfaces that would
// drift. The editor's file pane is where source is read.
export function SourceButton({ onOpenEditor }: { onOpenEditor?: () => void }) {
  const Code = icons.Code
  return (
    <Button variant='outline' size='sm' className='shrink-0 gap-1.5' onClick={onOpenEditor}>
      <Code className='h-3.5 w-3.5' />
      Source
    </Button>
  )
}
