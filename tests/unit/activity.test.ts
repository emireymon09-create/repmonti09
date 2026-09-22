import { describe, expect, it } from 'vitest'
import { buildActivity } from '@/lib/db'

// History prints the kind as a label in front of each entry ("Diaper · …"),
// the dashboard's Today feed prints the text alone. `what` has to stand on
// its own; `detail` must not name the kind again.

const at = '2026-09-20T12:00:00.000Z'

function entries() {
  return buildActivity(
    [
      { id: 'f1', fed_at: at, feeding_type: 'bottle', amount_ml: 120, notes: null },
      { id: 'f2', fed_at: at, feeding_type: 'solid', amount_ml: null, notes: null },
      { id: 'f3', fed_at: at, feeding_type: 'nursing', amount_ml: null, notes: null },
    ],
    [{ id: 'n1', side: 'left', started_at: at, ended_at: at }],
    [
      { id: 'd1', changed_at: at, diaper_type: 'wet' },
      { id: 'd2', changed_at: at, diaper_type: 'both', pending: true },
    ],
    [
      { id: 's1', started_at: at, ended_at: at, source: 'manual' },
      { id: 's2', started_at: at, ended_at: at, source: 'nuc_derived' },
    ],
    0,
    'ml',
  )
}

const byId = (id: string) => entries().find((e) => e.id === id)!

describe('buildActivity', () => {
  it('keeps the Today feed text self-describing', () => {
    expect(byId('d1').what).toBe('Diaper · wet')
    expect(byId('n1').what).toBe('Nursed · left')
    expect(byId('f1').what).toBe('Bottle · 120 ml')
    expect(byId('s1').what).toBe('Woke')
  })

  it('gives History a detail that does not repeat the kind label', () => {
    expect(byId('d1').detail).toBe('Wet')
    expect(byId('n1').detail).toBe('Left side')
    expect(byId('f1').detail).toBe('Bottle · 120 ml')
    expect(byId('f2').detail).toBe('Solids')
    expect(byId('f3').detail).toBe('Nursing (logged as feed)')
    expect(byId('s1').detail).toBe('Woke')
    expect(byId('s2').detail).toBe('Woke (detected)')
  })

  it('never starts a detail with its own kind', () => {
    const noun: Record<string, RegExp> = {
      diaper: /^diaper/i,
      nursing: /^nurs/i,
      feeding: /^feed/i,
      sleep: /^sleep/i,
    }
    for (const e of entries()) expect(e.detail).not.toMatch(noun[e.kind])
  })

  it('marks a queued entry as not synced in both texts', () => {
    expect(byId('d2').what).toBe('Diaper · both · not synced yet')
    expect(byId('d2').detail).toBe('Both · not synced yet')
  })
})

describe('buildActivity — sesiones en curso', () => {
  const started = '2026-09-20T11:00:00.000Z'
  const midnight = new Date('2026-09-20T07:00:00.000Z').getTime()

  function running(since = 0, lang: 'en' | 'es' = 'en') {
    return buildActivity(
      [],
      [{ id: 'n9', side: 'right', started_at: started, ended_at: null }],
      [],
      [
        { id: 's9', started_at: started, ended_at: null, source: 'manual', pending: true },
        { id: 's8', started_at: started, ended_at: null, source: 'nuc_derived' },
      ],
      since,
      'ml',
      lang,
    )
  }
  const find = (id: string, since?: number, lang?: 'en' | 'es') =>
    running(since, lang).find((e) => e.id === id)!

  it('un sueño en curso aparece, a la hora en que empezó y marcado en curso', () => {
    const s = find('s8')
    expect(s.at).toBe(started)
    expect(s.kind).toBe('sleep')
    expect(s.ongoing).toBe(true)
    expect(s.what).toBe('Asleep (detected) · in progress')
    expect(s.detail).toBe('Asleep (detected) · in progress')
  })

  it('uno iniciado offline dice además que no está sincronizado', () => {
    expect(find('s9').what).toBe('Asleep · in progress · not synced yet')
  })

  it('la lactancia en curso también, sin repetir el tipo en el detalle', () => {
    const n = find('n9')
    expect(n.ongoing).toBe(true)
    expect(n.what).toBe('Nursing · right · in progress')
    expect(n.detail).toBe('Right side · in progress')
  })

  it('una sesión en curso que empezó antes de medianoche sigue en Today', () => {
    expect(find('s9', midnight + 24 * 3600_000)).toBeDefined()
  })

  it('en español, sin repetir "pecho"', () => {
    expect(find('s9', 0, 'es').what).toBe('Dormida · en curso · sin sincronizar')
    expect(find('s8', 0, 'es').what).toBe('Dormida (detectada) · en curso')
    expect(find('n9', 0, 'es').what).toMatch(/^Lactancia · \S+ · en curso$/)
    expect(find('n9', 0, 'es').detail).toBe('Lado derecho · en curso')
  })

  it('en Today, lo que está en curso va arriba de todo', () => {
    const later = '2026-09-20T12:30:00.000Z'
    const feed = buildActivity(
      [{ id: 'f9', fed_at: later, feeding_type: 'bottle', amount_ml: 60, notes: null }],
      [{ id: 'n9', side: 'right', started_at: started, ended_at: null }],
      [{ id: 'd9', changed_at: later, diaper_type: 'wet' }],
      [{ id: 's9', started_at: '2026-09-20T10:00:00.000Z', ended_at: null, source: 'manual' }],
      0,
    )
    // Las en curso primero (entre ellas, la más nueva arriba), después el resto.
    expect(feed.map((e) => e.id)).toEqual(['n9', 's9', 'f9', 'd9'])
  })

  it('una sesión terminada no se marca en curso', () => {
    expect(byId('s1').ongoing).toBeUndefined()
    expect(byId('n1').ongoing).toBeUndefined()
  })
})

describe('buildActivity — valores que ningún diccionario conoce', () => {
  it('no revienta: muestra el valor crudo', () => {
    const feed = buildActivity(
      [{ id: 'f', fed_at: at, feeding_type: 'formula' as never, amount_ml: null, notes: null }],
      [{ id: 'n', side: 'middle' as never, started_at: at, ended_at: at }],
      [{ id: 'd', changed_at: at, diaper_type: 'purple' as never, pending: true }],
      [{ id: 's', started_at: at, ended_at: at, source: 'robot' as never }],
      0,
      'ml',
      'es',
    )
    const by = (id: string) => feed.find((e) => e.id === id)!
    expect(by('d').what).toBe('Pañal · purple · sin sincronizar')
    expect(by('d').detail).toBe('purple · sin sincronizar')
    expect(by('n').what).toBe('Tomó pecho · middle')
    expect(by('f').what).toBe('formula')
    expect(by('s').what).toBe('Se despertó')
  })
})
