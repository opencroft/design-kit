// The design-kit components a component declares, shown on its doc page.
//
// Each chip is the reference exactly as declared. A reference is not a name:
// a library can hold both `button` (the external shadcn item) and
// `@design-kit/button` (its own), and shortening either to `button` prints one
// chip for two different dependencies. The scope is the part that says which
// component is meant, so it stays.
//
// Names only, deliberately. Whether a reference resolves, to what, and what
// depends on this component in turn are the dependency graph's questions.
export function DependencyChips({ references }: { references: string[] }) {
  if (references.length === 0) {
    return null
  }
  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      <span className='text-sm text-muted-foreground'>Depends on</span>
      {references.map((reference) => (
        <code key={reference} className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
          {reference}
        </code>
      ))}
    </div>
  )
}
