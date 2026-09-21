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
