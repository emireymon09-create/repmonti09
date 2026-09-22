import { describe, expect, it } from 'vitest'
import {
  checkPastRange,
  diaperKpis,
  feedingKpis,
  kpiWindows,
  lastFeedingEvent,
  overlapMs,
  sleepKpis,
} from '@/lib/kpis'
import { formatDuration, startOfHouseholdDay } from '@/lib/format'
import type { DiaperChange, Feeding, NursingSession, SleepSession } from '@/lib/types'

// Ninguna aserción depende de la TZ del sistema: las ventanas se leen en
// America/Los_Angeles. `pnpm test:tz` corre este archivo bajo cuatro TZ.

const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(ms).toISOString()

// Martes 22 sep 2026, 13:00 en Los Ángeles (PDT, UTC-7).
const NOW = new Date('2026-09-22T20:00:00Z')
const { today, week } = kpiWindows(NOW)
// Medianoche del hogar de hoy: 22 sep 00:00 PDT = 07:00Z.
const MIDNIGHT = Date.parse('2026-09-22T07:00:00Z')

function feeding(id: string, at: string, type: Feeding['feeding_type'], ml: number | null = null) {
  return { id, fed_at: at, feeding_type: type, amount_ml: ml, notes: null }
}
function nursing(id: string, start: string, end: string | null): NursingSession {
  return { id, side: 'left', started_at: start, ended_at: end }
}
function sleep(id: string, start: string, end: string | null): SleepSession {
  return { id, started_at: start, ended_at: end, source: 'manual' }
}
function diaper(id: string, at: string, type: DiaperChange['diaper_type']): DiaperChange {
  return { id, changed_at: at, diaper_type: type }
}

describe('ventanas', () => {
  it('hoy empieza a la medianoche del hogar y termina ahora', () => {
    expect(iso(today.start)).toBe('2026-09-22T07:00:00.000Z')
    expect(today.end).toBe(NOW.getTime())
  })

  it('los últimos 7 días son hoy + los 6 anteriores, desde medianoche', () => {
    expect(iso(week.start)).toBe('2026-09-16T07:00:00.000Z')
    expect(week.end).toBe(NOW.getTime())
  })

  it('una ventana que cruza el cambio a horario de verano empieza a medianoche', () => {
    // 10 mar 2026, 13:00 PDT. El 8 de marzo el reloj saltó de 2:00 a 3:00.
    const w = kpiWindows(new Date('2026-03-10T20:00:00Z'))
    expect(iso(w.today.start)).toBe('2026-03-10T07:00:00.000Z') // PDT
    expect(iso(w.week.start)).toBe('2026-03-04T08:00:00.000Z') // PST
  })

  it('y la que cruza la vuelta al horario estándar también', () => {
    // 3 nov 2026, 12:00 PST. El 1 de noviembre el reloj volvió de 2:00 a 1:00.
    const w = kpiWindows(new Date('2026-11-03T20:00:00Z'))
    expect(iso(w.today.start)).toBe('2026-11-03T08:00:00.000Z') // PST
    expect(iso(w.week.start)).toBe('2026-10-28T07:00:00.000Z') // PDT
  })

  it('startOfHouseholdDay(now, n) retrocede días de calendario, no 24 h', () => {
    // 8 mar 2026 tiene 23 h en Los Ángeles.
    const monday = new Date('2026-03-09T18:00:00Z')
    expect(iso(startOfHouseholdDay(monday, 1))).toBe('2026-03-08T08:00:00.000Z')
    expect(iso(startOfHouseholdDay(monday, 0))).toBe('2026-03-09T07:00:00.000Z')
  })

  it('solapamiento: la parte de la sesión dentro de la ventana', () => {
    expect(overlapMs(iso(MIDNIGHT - HOUR), iso(MIDNIGHT + HOUR), today)).toBe(HOUR)
    expect(overlapMs(iso(MIDNIGHT - 2 * HOUR), iso(MIDNIGHT - HOUR), today)).toBe(0)
    // En curso: hasta ahora.
    expect(overlapMs(iso(NOW.getTime() - 30 * MIN), null, today)).toBe(30 * MIN)
  })
})

describe('feedingKpis', () => {
  const feedings = [
    feeding('f1', iso(MIDNIGHT + 2 * HOUR), 'bottle', 120),
    feeding('f2', iso(MIDNIGHT + 3 * HOUR), 'bottle', 90),
    feeding('f3', iso(MIDNIGHT + 4 * HOUR), 'solid'),
    // Ayer 23:59: no es de hoy, sí de la semana.
    feeding('f4', iso(MIDNIGHT - MIN), 'bottle', 60),
    // Hace 8 días: afuera de las dos ventanas.
    feeding('f5', iso(MIDNIGHT - 8 * 24 * HOUR), 'bottle', 500),
  ]
  const sessions = [
    // Empezó ayer 23:50 y terminó hoy 00:20: toma de ayer, 20 min de hoy.
    nursing('n1', iso(MIDNIGHT - 10 * MIN), iso(MIDNIGHT + 20 * MIN)),
    nursing('n2', iso(MIDNIGHT + 5 * HOUR), iso(MIDNIGHT + 5 * HOUR + 15 * MIN)),
    // En curso desde hace 10 min.
    nursing('n3', iso(NOW.getTime() - 10 * MIN), null),
  ]

  it('cuenta tomas por tipo, ml de biberón y minutos de pecho de hoy', () => {
    const k = feedingKpis(feedings, sessions, today)
    expect(k).toEqual({
      total: 5, // 2 biberones + 1 sólido + 2 sesiones de pecho iniciadas hoy
      bottle: 2,
      solid: 1,
      breast: 2,
      bottleMl: 210,
      breastMs: (20 + 15 + 10) * MIN,
      pending: false,
    })
  })

  it('la semana suma lo de ayer y deja afuera lo de hace 8 días', () => {
    const k = feedingKpis(feedings, sessions, week)
    expect(k.bottle).toBe(3)
    expect(k.bottleMl).toBe(270)
    expect(k.breast).toBe(3) // n1 empezó dentro de la semana
    expect(k.breastMs).toBe((30 + 15 + 10) * MIN)
    expect(k.total).toBe(7)
  })

  it('una fila en cola cuenta y marca pending', () => {
    const k = feedingKpis(
      [...feedings, { ...feeding('q1', iso(MIDNIGHT + 6 * HOUR), 'bottle', 30), pending: true }],
      sessions,
      today,
    )
    expect(k.bottle).toBe(3)
    expect(k.bottleMl).toBe(240)
    expect(k.pending).toBe(true)
  })

  it('un borrado en cola deja de contar y también marca pending', () => {
    const voided = { ...feedings[0], voided_at: iso(NOW.getTime()), pending: true }
    const k = feedingKpis([voided, ...feedings.slice(1)], sessions, today)
    expect(k.bottle).toBe(1)
    expect(k.bottleMl).toBe(90)
    expect(k.pending).toBe(true)
  })

  it('una fila en cola fuera de la ventana no marca pending', () => {
    const old = { ...feeding('q2', iso(MIDNIGHT - 30 * 24 * HOUR), 'solid'), pending: true }
    expect(feedingKpis([old], [], today).pending).toBe(false)
  })

  it('una toma cargada como "nursing" en feedings cuenta como pecho', () => {
    const k = feedingKpis([feeding('f9', iso(MIDNIGHT + HOUR), 'nursing')], [], today)
    expect(k.breast).toBe(1)
    expect(k.total).toBe(1)
    expect(k.breastMs).toBe(0)
  })
})

describe('diaperKpis', () => {
  it('total y por tipo; "both" es su propio tipo', () => {
    const k = diaperKpis(
      [
        diaper('d1', iso(MIDNIGHT + HOUR), 'wet'),
        diaper('d2', iso(MIDNIGHT + 2 * HOUR), 'wet'),
        diaper('d3', iso(MIDNIGHT + 3 * HOUR), 'dirty'),
        diaper('d4', iso(MIDNIGHT + 4 * HOUR), 'both'),
        diaper('d5', iso(MIDNIGHT - HOUR), 'both'), // ayer
      ],
      today,
    )
    expect(k).toEqual({ total: 4, wet: 2, dirty: 1, both: 1, pending: false })
  })

  it('medianoche exacta es de hoy; un minuto antes, de ayer', () => {
    const rows = [diaper('a', iso(MIDNIGHT), 'wet'), diaper('b', iso(MIDNIGHT - MIN), 'wet')]
    expect(diaperKpis(rows, today).total).toBe(1)
    expect(diaperKpis(rows, week).total).toBe(2)
  })

  it('en cola: cuenta y marca pending', () => {
    const k = diaperKpis([{ ...diaper('q', iso(MIDNIGHT + HOUR), 'dirty'), pending: true }], today)
    expect(k.dirty).toBe(1)
    expect(k.pending).toBe(true)
  })
})

describe('sleepKpis', () => {
  // Ayer 22:00 → hoy 06:00: 2 h de ayer, 6 h de hoy, una siesta de ayer.
  const night = sleep('s1', iso(MIDNIGHT - 2 * HOUR), iso(MIDNIGHT + 6 * HOUR))
  const nap = sleep('s2', iso(MIDNIGHT + 9 * HOUR), iso(MIDNIGHT + 10 * HOUR + 30 * MIN))
  // En curso desde hace 45 min.
  const running = sleep('s3', iso(NOW.getTime() - 45 * MIN), null)

  it('hoy: solo la parte después de medianoche, y la en curso hasta ahora', () => {
    const k = sleepKpis([night, nap, running], today)
    expect(k.sleptMs).toBe(6 * HOUR + 90 * MIN + 45 * MIN)
    expect(k.naps).toBe(2) // la noche empezó ayer
    expect(k.pending).toBe(false)
  })

  it('semana: la noche entera y tres siestas', () => {
    const k = sleepKpis([night, nap, running], week)
    expect(k.sleptMs).toBe(8 * HOUR + 90 * MIN + 45 * MIN)
    expect(k.naps).toBe(3)
  })

  it('el "ahora" de la sesión en curso se puede pasar aparte', () => {
    const w = { start: MIDNIGHT, end: NOW.getTime() }
    expect(sleepKpis([running], w, NOW.getTime() - 15 * MIN).sleptMs).toBe(30 * MIN)
  })

  it('una sesión en cola que se solapa marca pending', () => {
    const k = sleepKpis([{ ...night, pending: true }], today)
    expect(k.sleptMs).toBe(6 * HOUR)
    expect(k.pending).toBe(true)
  })
})

describe('lastFeedingEvent', () => {
  it('el más reciente entre tomas y sesiones de pecho terminadas', () => {
    const f = [feeding('f1', iso(MIDNIGHT + HOUR), 'bottle', 100)]
    const n = [nursing('n1', iso(MIDNIGHT + 2 * HOUR), iso(MIDNIGHT + 2 * HOUR + 20 * MIN))]
    const last = lastFeedingEvent(f, n)
    expect(last?.kind).toBe('nursing')
    expect(last?.at).toBe(n[0].started_at)
  })

  it('ignora una sesión en curso', () => {
    const f = [feeding('f1', iso(MIDNIGHT + HOUR), 'solid')]
    const n = [nursing('n1', iso(MIDNIGHT + 3 * HOUR), null)]
    expect(lastFeedingEvent(f, n)?.kind).toBe('feeding')
  })

  it('nada registrado → null', () => {
    expect(lastFeedingEvent([], [])).toBeNull()
  })
})

describe('checkPastRange', () => {
  const now = NOW.getTime()
  it('acepta una hora pasada y un rango pasado bien ordenado', () => {
    expect(checkPastRange(iso(now - HOUR), undefined, now)).toBeNull()
    expect(checkPastRange(iso(now - HOUR), iso(now - 30 * MIN), now)).toBeNull()
  })
  it('rechaza el futuro, el fin antes del inicio y lo vacío', () => {
    expect(checkPastRange(iso(now + MIN), undefined, now)).toBe('inFuture')
    expect(checkPastRange(iso(now - HOUR), iso(now + MIN), now)).toBe('inFuture')
    expect(checkPastRange(iso(now - HOUR), iso(now - HOUR), now)).toBe('endBeforeStart')
    expect(checkPastRange(iso(now - HOUR), iso(now - 2 * HOUR), now)).toBe('endBeforeStart')
    expect(checkPastRange(null, undefined, now)).toBe('needTime')
    expect(checkPastRange(iso(now - HOUR), null, now)).toBe('needTime')
  })
})

describe('formatDuration', () => {
  it('un total: cero dice cero', () => {
    expect(formatDuration(0)).toBe('0 min')
    expect(formatDuration(45 * MIN)).toBe('45 min')
    expect(formatDuration(2 * HOUR)).toBe('2h')
    expect(formatDuration(7 * HOUR + 20 * MIN, 'es')).toBe('7 h 20 min')
  })
})
