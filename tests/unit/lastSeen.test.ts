import { describe, expect, it } from 'vitest'
import {
  forgetSeen,
  lastGood,
  readSeen,
  saveSeen,
  seenKey,
  seenState,
  type SeenStorage,
} from '@/lib/lastSeen'
import { onSyncNudge } from '@/lib/queue'

// La copia de "lo último que vio este dispositivo" que usan /dashboard,
// /history y /growth para abrir sin conexión. localStorage de mentira: un
// Map, o uno que tira en cada llamada (modo privado, cuota llena).

function memory(initial: Record<string, string> = {}): SeenStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

function broken(): SeenStorage {
  const boom = () => {
    throw new Error('SecurityError')
  }
  return {
    getItem: boom,
    setItem: boom,
    removeItem: boom,
    key: boom,
    get length(): number {
      throw new Error('SecurityError')
    },
  }
}

const offlineError = 'TypeError: Failed to fetch'
type Rows = { diapers: { id: string }[]; appt: { id: string } | null }
const EMPTY: Rows = { diapers: [], appt: null }

describe('readSeen / saveSeen', () => {
  it('guarda y devuelve las filas con la hora en que se guardaron', () => {
    const s = memory()
    saveSeen('history:b1', { diapers: [{ id: 'a' }] }, new Date('2026-09-21T10:00:00Z'), s)
    expect(readSeen('history:b1', s)).toEqual({
      rows: { diapers: [{ id: 'a' }] },
      savedAt: '2026-09-21T10:00:00.000Z',
    })
  })

  it('nada guardado, JSON roto o de otra versión: null', () => {
    const s = memory({
      'amelia:seen:roto': '{no es json',
      'amelia:seen:viejo': JSON.stringify({ v: 0, savedAt: 'x', rows: [] }),
    })
    expect(readSeen('nada', s)).toBeNull()
    expect(readSeen('roto', s)).toBeNull()
    expect(readSeen('viejo', s)).toBeNull()
  })

  it('un storage que se niega no rompe nada: se comporta como si no hubiera', () => {
    const s = broken()
    expect(() => saveSeen('k', { a: 1 }, new Date(), s)).not.toThrow()
    expect(readSeen('k', s)).toBeNull()
    expect(() => forgetSeen(s)).not.toThrow()
    expect(readSeen('k', null)).toBeNull()
    expect(() => saveSeen('k', 1, new Date(), null)).not.toThrow()
  })
})

describe('forgetSeen (cerrar sesión)', () => {
  it('borra todo lo guardado para offline y nada más', () => {
    const s = memory({ 'amelia:lang': 'es', 'amelia:theme': 'dark' })
    saveSeen(seenKey.baby, { userId: 'u', baby: null }, new Date(), s)
    saveSeen(seenKey.page('dashboard', 'b1'), EMPTY, new Date(), s)
    saveSeen(seenKey.page('history', 'b1'), EMPTY, new Date(), s)

    forgetSeen(s)

    expect([...s.map.keys()].sort()).toEqual(['amelia:lang', 'amelia:theme'])
  })
})

describe('seenState', () => {
  it('si la última lectura no falló por red, no hay nada que avisar', () => {
    expect(seenState({ offline: false, lastGoodAt: null })).toEqual({ kind: 'live' })
    expect(seenState({ offline: false, lastGoodAt: '2026-09-21T10:00:00.000Z' })).toEqual({
      kind: 'live',
    })
  })

  it('falló por red: de cuándo son las filas, o "no hay nada" si nunca hubo', () => {
    expect(seenState({ offline: true, lastGoodAt: '2026-09-21T10:00:00.000Z' })).toEqual({
      kind: 'saved',
      savedAt: '2026-09-21T10:00:00.000Z',
    })
    expect(seenState({ offline: true, lastGoodAt: null })).toEqual({ kind: 'nothing' })
  })
})

describe('lastGood', () => {
  it('primera vez de verdad y offline: vacío, y lo dice', () => {
    const lg = lastGood('dashboard:b1', EMPTY, memory())
    expect(lg.rows).toEqual(EMPTY)
    expect(lg.state(true)).toEqual({ kind: 'nothing' })
    expect(lg.settle(lg.rows, offlineError)).toEqual({ kind: 'nothing' })
  })

  it('una lectura buena se guarda, y la próxima apertura offline arranca de ahí', () => {
    const s = memory()
    const first = lastGood('dashboard:b1', EMPTY, s)
    const rows = { diapers: [{ id: 'a' }], appt: { id: 'x' } }
    expect(first.settle(rows, null)).toEqual({ kind: 'live' })

    // Recarga sin conexión.
    const again = lastGood('dashboard:b1', EMPTY, s)
    expect(again.rows).toEqual(rows)
    expect(again.state(true).kind).toBe('saved')
    expect(again.settle(again.rows, offlineError).kind).toBe('saved')
  })

  it('no guarda una ronda con errores', () => {
    const s = memory()
    lastGood('dashboard:b1', EMPTY, s).settle({ diapers: [{ id: 'a' }], appt: null }, offlineError)
    expect(readSeen('dashboard:b1', s)).toBeNull()
  })

  it('corte a mitad de sesión (el navegador sigue "online"): avisa, con la hora de la última buena', () => {
    // Hallazgo del revisor: con una lectura buena en esta apertura el estado
    // quedaba 'live' y los datos se congelaban por horas sin aviso.
    const s = memory()
    saveSeen(
      'growth:b1',
      { diapers: [{ id: 'viejo' }], appt: null },
      new Date('2026-09-20T08:00:00Z'),
      s,
    )
    const lg = lastGood('growth:b1', EMPTY, s)
    lg.settle({ diapers: [{ id: 'nuevo' }], appt: null }, null)
    const goodAt = readSeen('growth:b1', s)!.savedAt

    const cut = lg.settle(lg.rows, offlineError)
    expect(cut).toEqual({ kind: 'saved', savedAt: goodAt })
    expect(goodAt).not.toBe('2026-09-20T08:00:00.000Z')
    expect(lg.rows.diapers).toEqual([{ id: 'nuevo' }])

    // Vuelve: la próxima lectura buena lo saca.
    expect(lg.settle(lg.rows, null)).toEqual({ kind: 'live' })
  })

  it('el repintado rápido desde la cola no cambia el estado: no parpadea', () => {
    const lg = lastGood('dashboard:b1', EMPTY, memory())
    lg.settle({ diapers: [{ id: 'a' }], appt: null }, null)
    const cut = lg.settle(lg.rows, offlineError)
    expect(cut.kind).toBe('saved')
    // navigator.onLine dice true: igual se mantiene hasta que una lectura resuelva.
    expect(lg.state(false)).toEqual(cut)
    expect(lg.state(true)).toEqual(cut)
    lg.settle(lg.rows, null)
    expect(lg.state(true)).toEqual({ kind: 'live' })
  })

  it('un rechazo del server con conexión no se presenta como "offline"', () => {
    const lg = lastGood('history:b1', EMPTY, memory())
    expect(lg.settle(lg.rows, 'permission denied for table feedings')).toEqual({ kind: 'live' })
  })

  it('una copia guardada antes de que existiera una clave igual trae todas las claves', () => {
    const s = memory()
    saveSeen('dashboard:b1', { diapers: [{ id: 'a' }] }, new Date(), s)
    expect(lastGood('dashboard:b1', EMPTY, s).rows).toEqual({ diapers: [{ id: 'a' }], appt: null })
  })

  it('la copia es por bebé: otro bebé no ve la del primero', () => {
    const s = memory()
    lastGood(seenKey.page('history', 'b1'), EMPTY, s).settle(
      { diapers: [{ id: 'a' }], appt: null },
      null,
    )
    const other = lastGood(seenKey.page('history', 'b2'), EMPTY, s)
    expect(other.rows).toEqual(EMPTY)
    expect(other.state(true)).toEqual({ kind: 'nothing' })
  })

  it('sin storage, se comporta como antes: solo memoria', () => {
    const lg = lastGood('dashboard:b1', EMPTY, broken())
    expect(lg.rows).toEqual(EMPTY)
    expect(lg.settle({ diapers: [{ id: 'a' }], appt: null }, null)).toEqual({ kind: 'live' })
    expect(lg.rows.diapers).toEqual([{ id: 'a' }])
  })
})

describe('lastGood avisa a useSync cómo le fue a la lectura', () => {
  it('falla de red → read-failed; lectura buena → read-ok; rechazo → nada', () => {
    const seen: string[] = []
    const stop = onSyncNudge((k) => seen.push(k))
    const lg = lastGood('dashboard:b9', EMPTY, memory())
    lg.settle(lg.rows, offlineError)
    lg.settle(lg.rows, 'permission denied for table feedings')
    lg.settle(lg.rows, null)
    stop()
    expect(seen).toEqual(['read-failed', 'read-ok'])
  })
})

describe('lastGood entre páginas', () => {
  it('en medio de un corte, una página nueva ya arranca avisando; al volver, no', () => {
    const s = memory()
    saveSeen('history:b7', EMPTY, new Date('2026-09-21T10:00:00Z'), s)
    lastGood('dashboard:b7', EMPTY, s).settle(EMPTY, offlineError)
    expect(lastGood('history:b7', EMPTY, s).state(false)).toEqual({
      kind: 'saved',
      savedAt: '2026-09-21T10:00:00.000Z',
    })
    lastGood('dashboard:b7', EMPTY, s).settle(EMPTY, null)
    expect(lastGood('history:b7', EMPTY, s).state(false)).toEqual({ kind: 'live' })
  })
})
