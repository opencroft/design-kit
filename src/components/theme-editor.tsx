import { CodeBlockEditor } from '@opencroft/client/code'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Label,
} from '@opencroft/client/ui'
import { Palette } from 'lucide-react'
import { useEffect, useState } from 'react'

// The per-project preview theme dialog — pick one of the shadcn default themes,
// or derive a custom one by editing its token CSS (`:root { … } .dark { … }`,
// standard shadcn variable names).
//
// Presentation only. Which presets exist and what saving does arrive as props,
// so nothing it shows depends on a server being there. The host wiring lives in
// ./project-theme-editor.tsx.

export interface ProjectThemeData {
  preset?: string
  css?: string
}

export interface ThemePreset {
  id: string
  label: string
  css: string
}

export interface ThemeEditorProps {
  /** The project's saved theme; the dialog re-seeds from it each time it opens. */
  theme?: ProjectThemeData
  /** The presets on offer. Empty while they load — the saved one is still shown. */
  presets: ThemePreset[]
  saving?: boolean
  /** Told when the dialog opens or closes — the moment to fetch presets. */
  onOpenChange?: (open: boolean) => void
  /** Resolve to close the dialog; reject to keep it open with the edit intact. */
  onSave: (next: { preset: string; css?: string }) => Promise<void> | void
}

export function ThemeEditor({ theme, presets, saving = false, onOpenChange, onSave }: ThemeEditorProps) {
  const [open, setOpenState] = useState(false)
  const [preset, setPreset] = useState('neutral')
  const [customize, setCustomize] = useState(false)
  const [css, setCss] = useState('')

  const setOpen = (next: boolean) => {
    setOpenState(next)
    onOpenChange?.(next)
  }

  // (Re-)seed the dialog from the project's saved theme each time it opens.
  useEffect(() => {
    if (!open) {
      return
    }
    setPreset(theme?.preset ?? 'neutral')
    setCustomize(Boolean(theme?.css))
    setCss(theme?.css ?? '')
  }, [open, theme])

  const presetCss = (id: string) => presets.find((p) => p.id === id)?.css ?? ''

  const selectPreset = (id: string) => {
    setPreset(id)
    if (customize) {
      // The editor derives from a preset — switching presets re-seeds it.
      setCss(presetCss(id))
    }
  }

  const toggleCustomize = () => {
    if (!customize && !css.trim()) {
      setCss(presetCss(preset))
    }
    setCustomize(!customize)
  }

  const save = async () => {
    try {
      await onSave({ preset, css: customize && css.trim() ? css : undefined })
      setOpen(false)
    } catch {
      // The caller reports the failure; the dialog stays open so the edit is not lost.
    }
  }

  const label = theme?.css ? 'Custom' : (theme?.preset ?? 'neutral')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size='sm' variant='outline' className='w-full justify-start' />}>
        <Palette className='h-3.5 w-3.5' />
        Theme
        <span className='ml-auto text-xs capitalize text-muted-foreground'>{label}</span>
      </DialogTrigger>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Preview theme</DialogTitle>
          <DialogDescription>
            The theme previews render with, isolated from the app. Pick a shadcn default or customize its token CSS.
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-3'>
          <div className='flex items-center gap-3'>
            <Label className='w-16 shrink-0 text-xs'>Preset</Label>
            <select
              value={preset}
              onChange={(e) => selectPreset(e.target.value)}
              className='h-9 flex-1 rounded-md border bg-background px-2 text-sm'
            >
              {(presets.length > 0 ? presets : [{ id: preset, label: preset, css: '' }]).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <Button size='sm' variant={customize ? 'default' : 'outline'} onClick={toggleCustomize}>
              Customize CSS
            </Button>
          </div>

          {customize && (
            <div className='max-h-80 overflow-auto rounded-md border'>
              <CodeBlockEditor value={css} onChange={setCss} language='css' minLines={10} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant='outline' onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
