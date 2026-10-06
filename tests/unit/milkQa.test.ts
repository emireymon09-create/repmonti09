import { describe, expect, it } from 'vitest'
import {
  newestSavedContainers,
  pumpingRemoveConfirmKey,
  rereadsInventory,
  suggestTape,
  takenTapes,
} from '@/lib/milk'
import { milkErrorText } from '@/lib/db'
import type { MilkContainer, PumpingSession } from '@/lib/types'

// Regresiones de la QA en navegador de la rama de leche (6 oct 2026). No hay
// tests de componentes en este repo: cada decisión que estaba enterrada en una
// página vive ahora en lib/ y se prueba acá.

function c(label: string, over: Partial<MilkContainer> = {}): MilkContainer {
  return {
    id: `id-${label}`,
    source_session_id: `s-${label}`,
    label,
    amount_ml: 100,
    remaining_ml: 100,
    stored_at: '2026-10-05T10:00:00Z',
    location: 'fridge',
    expires_at: '2026-10-09T10:00:00Z',
    ...over,
  }
}

describe('Bug 1 — the tape is never guessed when the containers are unknown', () => {
  it('nothing read and nothing saved: no taken list, no suggestion (was M1)', () => {
    const taken = takenTapes({ live: [], readKnown: false, saved: null, justSaved: null })
    expect(taken).toBeNull()
    expect(suggestTape(taken)).toBeNull()
  })

  it('a read that came back empty is KNOWN empty: M1 is right', () => {
    const taken = takenTapes({ live: [], readKnown: true, saved: null, justSaved: null })
    expect(taken).toEqual([])
    expect(suggestTape(taken)).toBe('M1')
  })

  it('unknown here, but another page saved the list: next after it, queued ones included', () => {
    const saved = Array.from({ length: 10 }, (_, i) => c(`M${i + 1}`))
    const queued = [c('M11')]
    const taken = takenTapes({ live: queued, readKnown: false, saved, justSaved: null })
    expect(suggestTape(taken)).toBe('M12')
    expect(taken).toContain('M3')
  })

  it('a known list ignores another page’s copy, and counts the tape just used', () => {
    const taken = takenTapes({
      live: [c('M2')],
      readKnown: true,
      saved: [c('M40')],
      justSaved: 'M3',
    })
    expect(suggestTape(taken)).toBe('M4')
  })

  it('voided containers free their tape', () => {
    const taken = takenTapes({
      live: [],
      readKnown: false,
      saved: [c('M1'), c('M2', { voided_at: '2026-10-05T11:00:00Z' } as Partial<MilkContainer>)],
      justSaved: null,
    })
    expect(suggestTape(taken)).toBe('M2')
  })

  it('newestSavedContainers: the newest copy that really has a container list', () => {
    const old = { savedAt: '2026-10-05T08:00:00Z', rows: { containers: [c('M1')] } }
    const newer = { savedAt: '2026-10-05T09:00:00Z', rows: { containers: [c('M1'), c('M2')] } }
    const noList = { savedAt: '2026-10-05T10:00:00Z', rows: { feedings: [] } }
    expect(newestSavedContainers([old, null, newer, noList])).toEqual({
      savedAt: newer.savedAt,
      containers: newer.rows.containers,
    })
    expect(newestSavedContainers([null, noList])).toBeNull()
  })

  it('a rejected tape in the sync banner is neutral and says what works', () => {
    const sync = milkErrorText('milk_label_taken:M1', 'en', 'sync')
    expect(sync).not.toMatch(/Another phone already used/)
    expect(sync).not.toMatch(/Delete this session/)
    expect(sync).toMatch(/M1/)
    expect(sync).toMatch(/Discard this entry/)
    const es = milkErrorText('milk_label_taken:M1', 'es', 'sync')
    expect(es).not.toMatch(/Borrá esta sesión/)
    expect(es).toMatch(/Descartar este registro/)
    // Outside the banner (an edit in History) there is nothing to discard.
    expect(milkErrorText('milk_label_taken:M1', 'en')).not.toMatch(/Discard|Delete this session/)
  })
})

describe('Bug 2 — a stale-inventory rejection re-reads what there is', () => {
  it('overdraw and unusable container re-read; other errors do not', () => {
    expect(rereadsInventory('milk_overdraw:M16')).toBe(true)
    expect(rereadsInventory('milk_container_unusable:M3')).toBe(true)
    expect(rereadsInventory('milk_container_unusable')).toBe(true)
    expect(rereadsInventory('milk_bad_input')).toBe(false)
    expect(rereadsInventory('Failed to fetch')).toBe(false)
    expect(rereadsInventory(null)).toBe(false)
  })
})

describe('Bug 5 — deleting a pumping session says what it really does', () => {
  const session = (over: Partial<PumpingSession>): PumpingSession =>
    ({
      id: 's1',
      pumped_at: '2026-10-05T10:00:00Z',
      side: 'both',
      amount_ml: null,
      left_ml: null,
      right_ml: null,
      notes: null,
      ...over,
    }) as PumpingSession

  it('with a container: its milk comes out of what there is', () => {
    expect(pumpingRemoveConfirmKey(session({ left_ml: 50, amount_ml: 50 }), c('M1'))).toBe(
      'milk.removeConfirm',
    )
  })
  it('legacy (total, no sides, no container): its own text', () => {
    expect(pumpingRemoveConfirmKey(session({ amount_ml: 90 }), undefined)).toBe(
      'milk.removeConfirmLegacy',
    )
  })
  it('no amount (no container): its own text', () => {
    expect(pumpingRemoveConfirmKey(session({ left_ml: 0, right_ml: 0 }), undefined)).toBe(
      'milk.removeConfirmNoMilk',
    )
    expect(pumpingRemoveConfirmKey(session({}), undefined)).toBe('milk.removeConfirmNoMilk')
  })
})
