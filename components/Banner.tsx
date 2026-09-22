/**
 * The status banner. Its own file so components that components/ui.tsx
 * renders (the settings menu's NursingAlerts) can use it without importing
 * ui.tsx back — ui.tsx re-exports it, so `@/components/ui` keeps working.
 */
export function Banner({
  kind,
  children,
}: {
  kind: 'error' | 'ok' | 'warn'
  children: React.ReactNode
}) {
  return (
    <div role="status" className={`banner ${kind}`}>
      {children}
    </div>
  )
}
