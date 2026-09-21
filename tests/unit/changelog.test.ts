import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareVersions, parseChangelog } from '@/lib/changelog'

const SAMPLE = `# Changelog

Texto de introducción que no es de ninguna versión.

## [0.2.0] - 2026-09-21

Resumen de la versión,
en dos líneas.

- Primer cambio
- Segundo cambio que sigue
  en la línea de abajo

## [0.1.0] - 2026-09-20

- Lo primero
`

describe('parseChangelog', () => {
  it('lee versiones, fechas, resumen y cambios, en orden', () => {
    expect(parseChangelog(SAMPLE)).toEqual([
      {
        version: '0.2.0',
        date: '2026-09-21',
        summary: 'Resumen de la versión, en dos líneas.',
        changes: ['Primer cambio', 'Segundo cambio que sigue en la línea de abajo'],
      },
      { version: '0.1.0', date: '2026-09-20', summary: null, changes: ['Lo primero'] },
    ])
  })

  it('sin versiones, lista vacía', () => {
    expect(parseChangelog('# Changelog\n\nnada todavía\n')).toEqual([])
  })
})

describe('compareVersions', () => {
  it('compara numéricamente, no como texto', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.1.9', '0.2.0')).toBeLessThan(0)
  })
})

/**
 * El guardia contra lo que le pasó a fruco-erp (su changelog canónico se quedó
 * atrás dos versiones, auditoría 2026-08-10 hallazgo 11.1): si alguien sube la
 * versión y no escribe el CHANGELOG, o al revés, esto falla.
 */
describe('CHANGELOG.md real', () => {
  const releases = parseChangelog(readFileSync('CHANGELOG.md', 'utf8'))
  const pkg: { version: string } = JSON.parse(readFileSync('package.json', 'utf8'))

  it('la primera entrada es la versión de package.json', () => {
    expect(releases[0]?.version).toBe(pkg.version)
  })

  it('las versiones bajan estrictamente y las fechas no suben', () => {
    for (let i = 1; i < releases.length; i += 1) {
      expect(compareVersions(releases[i - 1].version, releases[i].version)).toBeGreaterThan(0)
      expect(releases[i - 1].date >= releases[i].date).toBe(true)
    }
  })

  it('cada versión tiene fecha válida y al menos un cambio', () => {
    for (const r of releases) {
      expect(Number.isNaN(Date.parse(`${r.date}T00:00:00Z`))).toBe(false)
      expect(r.changes.length).toBeGreaterThan(0)
    }
  })
})
