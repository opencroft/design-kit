import { Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@opencroft/client/ui'
import type { ChangeEvent, ReactNode } from 'react'

import type { Control, PropRow } from '../registry'

// A properties table on the shared `ui` Table, with an interactive "Value"
// column. Rows without a control (complex types like lambdas / React nodes)
// leave the Value cell empty.
function Chip({ children }: { children: ReactNode }) {
  return <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>{children}</code>
}

function ValueControl({
  control,
  value,
  onChange,
}: {
  control: Control
  value: string | boolean
  onChange: (name: string, v: string | boolean) => void
}) {
  if (control.kind === 'enum') {
    return (
      <select
        value={String(value)}
        onChange={(e) => onChange(control.name, e.target.value)}
        className='h-8 w-full rounded-md border bg-background px-2 text-xs'
      >
        {control.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  if (control.kind === 'boolean') {
    return (
      <input
        type='checkbox'
        checked={Boolean(value)}
        onChange={(e) => onChange(control.name, e.target.checked)}
        className='h-4 w-4 accent-primary'
      />
    )
  }
  return (
    <Input
      value={String(value)}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(control.name, e.target.value)}
      className='h-8'
    />
  )
}

export function PropsTable({
  rows,
  values,
  onChange,
}: {
  rows: PropRow[]
  values: Record<string, string | boolean>
  onChange: (name: string, v: string | boolean) => void
}) {
  return (
    <div className='w-full overflow-x-auto rounded-md border'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Prop</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Default</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className='w-44'>Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.name}>
              <TableCell>
                <Chip>{r.name}</Chip>
              </TableCell>
              <TableCell>
                <Chip>{r.type}</Chip>
              </TableCell>
              <TableCell className='text-muted-foreground'>{r.default ? <Chip>{r.default}</Chip> : '-'}</TableCell>
              <TableCell className='text-muted-foreground'>{r.description}</TableCell>
              <TableCell>
                {r.control ? (
                  <ValueControl control={r.control} value={values[r.control.name]} onChange={onChange} />
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
