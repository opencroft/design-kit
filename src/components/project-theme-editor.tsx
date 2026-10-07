import { invoke, React, toast } from '@ext/host'

import { type ProjectThemeData, ThemeEditor, type ThemePreset } from './theme-editor'

// The theme dialog wired to this extension's server: presets are fetched when
// the dialog opens (they never change while it is closed, and a project page
// that never opens it should not pay for them), and saving writes the
// project's theme. Kept apart from ./theme-editor.tsx so that file stays a
// presentation-only component and this one is all the host has to add.
export function ProjectThemeEditor<TProject>({ projectId, theme, onSaved }: { projectId: string; theme?: ProjectThemeData; onSaved: (projects: TProject[]) => void }) {
  const [presets, setPresets] = React.useState<ThemePreset[]>([])
  const [saving, setSaving] = React.useState(false)

  const loadPresets = (open: boolean) => {
    if (!open) {
      return
    }
    invoke<ThemePreset[]>('themes.list')
      .then((list) => setPresets(Array.isArray(list) ? list : []))
      .catch(() => setPresets([]))
  }

  const save = async ({ preset, css }: { preset: string; css?: string }) => {
    setSaving(true)
    try {
      const projects = await invoke<TProject[]>('projects.setTheme', { id: projectId, preset, css })
      onSaved(projects)
      toast.success('Theme saved')
    } catch (e) {
      toast.error(`Failed to save theme: ${String(e)}`)
      // Rethrown so the dialog stays open with the edit intact.
      throw e
    } finally {
      setSaving(false)
    }
  }

  return <ThemeEditor theme={theme} presets={presets} saving={saving} onOpenChange={loadPresets} onSave={save} />
}
