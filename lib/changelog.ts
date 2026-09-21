/**
 * El historial de versiones que se ve en /version.
 *
 * Fuente de verdad: CHANGELOG.md en la raíz (el historial) y el campo
 * "version" de package.json (la versión actual). tests/unit/changelog.test.ts
 * falla si no coinciden.
 *
 * Formato que se lee, y nada más:
 *   ## [0.2.0] - 2026-09-21      ← encabezado de versión
 *   Un párrafo opcional           ← resumen
 *   - un cambio                   ← cada cambio; las líneas con sangría
 *     que sigue acá                  continúan el anterior
 */

export type Release = {
  version: string
  date: string
  summary: string | null
  changes: string[]
}

const HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/

export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = []
  let current: Release | null = null

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd()
    const heading = line.match(HEADING)
    if (heading) {
      current = { version: heading[1], date: heading[2], summary: null, changes: [] }
      releases.push(current)
      continue
    }
    if (!current || line.trim() === '' || line.startsWith('#')) continue

    if (line.startsWith('- ')) {
      current.changes.push(line.slice(2).trim())
    } else if (line.startsWith('  ') && current.changes.length > 0) {
      current.changes[current.changes.length - 1] += ` ${line.trim()}`
    } else if (current.changes.length === 0) {
      current.summary = current.summary ? `${current.summary} ${line.trim()}` : line.trim()
    }
  }
  return releases
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}
