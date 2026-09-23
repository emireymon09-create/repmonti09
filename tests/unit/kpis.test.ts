import { describe, expect, it } from 'vitest'
import {
  checkPastRange,
  diaperKpis,
  feedingKpis,
  kpiWindows,
  lastFeedingEvent,
  overlapMs,
  shiftStart,
  sleepKpis,
  MAX_SHIFT_BACK_MS,
  MAX_SHIFT_MINUTES,
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
const { last24h, week } = kpiWindows(NOW)
// Medianoche del hogar de hoy: 22 sep 00:00 PDT = 07:00Z.
const MIDNIGHT = Date.parse('2026-09-22T07:00:00Z')
const DAY = 24 * HOUR
const ago = (ms: number) => iso(NOW.getTime() - ms)

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
  it('la ventana corta son las últimas 24 h rodantes, no el día de calendario', () => {
    expect(iso(last24h.start)).toBe('2026-09-21T20:00:00.000Z')
    expect(last24h.end).toBe(NOW.getTime())
    // La medianoche del hogar queda ADENTRO: la ventana arranca antes.
    expect(last24h.start).toBeLessThan(MIDNIGHT)
  })

  it('los últimos 7 días son hoy + los 6 anteriores, desde medianoche', () => {
    expect(iso(week.start)).toBe('2026-09-16T07:00:00.000Z')
    expect(week.end).toBe(NOW.getTime())
  })

  it('la semana que cruza el cambio a horario de verano sigue empezando a medianoche', () => {
    // 10 mar 2026, 13:00 PDT. El 8 de marzo el reloj saltó de 2:00 a 3:00.
    const w = kpiWindows(new Date('2026-03-10T20:00:00Z'))
    expect(iso(w.week.start)).toBe('2026-03-04T08:00:00.000Z') // PST
  })

  it('y la que cruza la vuelta al horario estándar también', () => {
    // 3 nov 2026, 12:00 PST. El 1 de noviembre el reloj volvió de 2:00 a 1:00.
    const w = kpiWindows(new Date('2026-11-03T20:00:00Z'))
    expect(iso(w.week.start)).toBe('2026-10-28T07:00:00.000Z') // PDT
  })

  it('startOfHouseholdDay(now, n) retrocede días de calendario, no 24 h', () => {
    // 8 mar 2026 tiene 23 h en Los Ángeles.
    const monday = new Date('2026-03-09T18:00:00Z')
    expect(iso(startOfHouseholdDay(monday, 1))).toBe('2026-03-08T08:00:00.000Z')
    expect(iso(startOfHouseholdDay(monday, 0))).toBe('2026-03-09T07:00:00.000Z')
  })

  it('solapamiento: la parte de la sesión dentro de la ventana', () => {
    expect(overlapMs(ago(DAY + HOUR), ago(DAY - HOUR), last24h)).toBe(HOUR)
    expect(overlapMs(ago(DAY + 2 * HOUR), ago(DAY + HOUR), last24h)).toBe(0)
    // En curso: hasta ahora.
    expect(overlapMs(ago(30 * MIN), null, last24h)).toBe(30 * MIN)
  })
})

describe('la ventana rodante de 24 h', () => {
  it('a las 00:10 la toma de las 23:50 de ayer sigue contando', () => {
    // 00:10 del hogar el 22 sep = 07:10Z.
    const at0010 = new Date('2026-09-22T07:10:00Z')
    const w = kpiWindows(at0010).last24h
    // Ayer 23:50 del hogar = 06:50Z del 22.
    const late = diaper('d', '2026-09-22T06:50:00Z', 'wet')
    expect(diaperKpis([late], w).total).toBe(1)
    // Y con la ventana vieja (desde la medianoche del hogar) no contaba.
    expect(diaperKpis([late], { start: MIDNIGHT, end: at0010.getTime() }).total).toBe(0)
  })

  it('el borde: justo 24 h atrás cuenta, un minuto más no', () => {
    const rows = [diaper('a', ago(DAY), 'wet'), diaper('b', ago(DAY + MIN), 'wet')]
    expect(diaperKpis(rows, last24h).total).toBe(1)
    expect(diaperKpis(rows, week).total).toBe(2)
  })

  it('cae 24 h de reloj aunque el día del hogar dure 23 o 25 h', () => {
    // Domingo 8 mar 2026, 10:00 PDT: ese día del hogar tiene 23 h.
    const spring = new Date('2026-03-08T17:00:00Z')
    expect(kpiWindows(spring).last24h.start).toBe(spring.getTime() - DAY)
    // Domingo 1 nov 2026, 10:00 PST: ese día del hogar tiene 25 h.
    const fall = new Date('2026-11-01T18:00:00Z')
    expect(kpiWindows(fall).last24h.start).toBe(fall.getTime() - DAY)
  })

  it('la lectura de la sección cubre la ventana: medianoche de hace 6 días <= ahora-24 h', () => {
    // components/SectionPage.tsx lee desde startOfHouseholdDay(now, 6) para
    // las dos tarjetas. Si esa lectura arrancara DESPUÉS del borde de las
    // 24 h, el total corto saldría corto y nadie se enteraría.
    for (const at of [
      NOW,
      new Date('2026-03-08T17:00:00Z'), // día de 23 h
      new Date('2026-11-01T18:00:00Z'), // día de 25 h
      new Date('2026-01-01T08:00:01Z'), // un segundo pasada la medianoche
    ]) {
      expect(startOfHouseholdDay(at, 6), at.toISOString()).toBeLessThanOrEqual(
        kpiWindows(at).last24h.start,
      )
    }
  })

  it('en los dos cambios de horario, una fila de hace 23 h 59 cuenta y una de 24 h 01 no', () => {
    for (const at of [new Date('2026-03-08T17:00:00Z'), new Date('2026-11-01T18:00:00Z')]) {
      const w = kpiWindows(at).last24h
      const inside = diaper('in', iso(at.getTime() - DAY + MIN), 'wet')
      const outside = diaper('out', iso(at.getTime() - DAY - MIN), 'wet')
      expect(diaperKpis([inside, outside], w).total, at.toISOString()).toBe(1)
    }
  })
})

describe('feedingKpis', () => {
  const feedings = [
    feeding('f1', iso(MIDNIGHT + 2 * HOUR), 'bottle', 120),
    feeding('f2', iso(MIDNIGHT + 3 * HOUR), 'bottle', 90),
    feeding('f3', iso(MIDNIGHT + 4 * HOUR), 'solid'),
    // Hace 25 h: afuera de las últimas 24, adentro de la semana.
    feeding('f4', ago(25 * HOUR), 'bottle', 60),
    // Hace 8 días: afuera de las dos ventanas.
    feeding('f5', iso(MIDNIGHT - 8 * 24 * HOUR), 'bottle', 500),
  ]
  const sessions = [
    // Arrancó 10 min antes del borde de las 24 h y terminó 20 min después:
    // la toma quedó afuera de la ventana, los 20 min de pecho adentro.
    nursing('n1', ago(DAY + 10 * MIN), ago(DAY - 20 * MIN)),
    nursing('n2', iso(MIDNIGHT + 5 * HOUR), iso(MIDNIGHT + 5 * HOUR + 15 * MIN)),
    // En curso desde hace 10 min.
    nursing('n3', ago(10 * MIN), null),
  ]

  it('cuenta tomas por tipo, ml de biberón y minutos de pecho de las últimas 24 h', () => {
    const k = feedingKpis(feedings, sessions, last24h)
    expect(k).toEqual({
      total: 5, // 2 biberones + 1 sólido + 2 sesiones de pecho iniciadas adentro
      bottle: 2,
      solid: 1,
      breast: 2,
      bottleMl: 210,
      breastMs: (20 + 15 + 10) * MIN,
      pending: false,
    })
  })

  it('la semana suma lo de hace 25 h y deja afuera lo de hace 8 días', () => {
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
      last24h,
    )
    expect(k.bottle).toBe(3)
    expect(k.bottleMl).toBe(240)
    expect(k.pending).toBe(true)
  })

  it('un borrado en cola deja de contar y también marca pending', () => {
    const voided = { ...feedings[0], voided_at: iso(NOW.getTime()), pending: true }
    const k = feedingKpis([voided, ...feedings.slice(1)], sessions, last24h)
    expect(k.bottle).toBe(1)
    expect(k.bottleMl).toBe(90)
    expect(k.pending).toBe(true)
  })

  it('una fila en cola fuera de la ventana no marca pending', () => {
    const old = { ...feeding('q2', iso(MIDNIGHT - 30 * 24 * HOUR), 'solid'), pending: true }
    expect(feedingKpis([old], [], last24h).pending).toBe(false)
  })

  it('una toma cargada como "nursing" en feedings cuenta como pecho', () => {
    const k = feedingKpis([feeding('f9', iso(MIDNIGHT + HOUR), 'nursing')], [], last24h)
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
        diaper('d5', ago(25 * HOUR), 'both'), // hace 25 h
      ],
      last24h,
    )
    expect(k).toEqual({ total: 4, wet: 2, dirty: 1, both: 1, pending: false })
  })

  it('en cola: cuenta y marca pending', () => {
    const k = diaperKpis(
      [{ ...diaper('q', iso(MIDNIGHT + HOUR), 'dirty'), pending: true }],
      last24h,
    )
    expect(k.dirty).toBe(1)
    expect(k.pending).toBe(true)
  })
})

describe('sleepKpis', () => {
  // Empezó 2 h antes del borde de las 24 h y terminó 6 h después: 8 h en
  // total, 6 adentro de la ventana, y la siesta no cuenta (empezó afuera).
  const night = sleep('s1', ago(DAY + 2 * HOUR), ago(DAY - 6 * HOUR))
  const nap = sleep('s2', iso(MIDNIGHT + 9 * HOUR), iso(MIDNIGHT + 10 * HOUR + 30 * MIN))
  // En curso desde hace 45 min.
  const running = sleep('s3', ago(45 * MIN), null)

  it('24 h: solo la parte adentro de la ventana, y la en curso hasta ahora', () => {
    const k = sleepKpis([night, nap, running], last24h)
    expect(k.sleptMs).toBe(6 * HOUR + 90 * MIN + 45 * MIN)
    expect(k.naps).toBe(2) // la noche empezó antes de la ventana
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
    const k = sleepKpis([{ ...night, pending: true }], last24h)
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

describe('shiftStart — correr el inicio de una sesión en curso', () => {
  const now = NOW.getTime()
  const start = ago(10 * MIN)

  it('resta los minutos pedidos y devuelve un ISO', () => {
    const { at, problem } = shiftStart(start, 5, now)
    expect(problem).toBeNull()
    expect(at).toBe(ago(15 * MIN))
  })

  it('es acumulativo: cada aplicación corre el inicio que hay AHORA', () => {
    let at = start
    for (const mins of [5, 5, 3]) {
      const step = shiftStart(at, mins, now)
      expect(step.problem).toBeNull()
      at = step.at!
    }
    expect(at).toBe(ago(23 * MIN))
  })

  it('acepta decimales — 2,5 min son 150 segundos', () => {
    expect(shiftStart(start, 2.5, now).at).toBe(ago(12.5 * MIN))
  })

  it('cero no es una corrección, y tampoco un negativo', () => {
    expect(shiftStart(start, 0, now)).toEqual({ at: null, problem: 'notPositive' })
    expect(shiftStart(start, -5, now)).toEqual({ at: null, problem: 'notPositive' })
  })

  it('un campo vacío o con letras llega como NaN y se rechaza', () => {
    expect(shiftStart(start, Number(''), now).problem).toBe('notPositive') // Number('') === 0
    expect(shiftStart(start, Number('cinco'), now).problem).toBe('notNumber')
    expect(shiftStart(start, Infinity, now).problem).toBe('notNumber')
    expect(shiftStart('no es una fecha', 5, now).problem).toBe('notNumber')
  })

  it('el tope por aplicación son 240 minutos: 240 entra, 241 no', () => {
    expect(MAX_SHIFT_MINUTES).toBe(240)
    expect(shiftStart(ago(0), MAX_SHIFT_MINUTES, now).at).toBe(ago(240 * MIN))
    expect(shiftStart(ago(0), MAX_SHIFT_MINUTES + 1, now).problem).toBe('tooLong')
  })

  it('y el inicio resultante no puede quedar a más de 12 h de ahora', () => {
    expect(MAX_SHIFT_BACK_MS).toBe(12 * HOUR)
    // Una sesión que arrancó hace 11 h: correrla 59 min entra, 61 no.
    const old = ago(11 * HOUR)
    expect(shiftStart(old, 59, now).problem).toBeNull()
    expect(shiftStart(old, 61, now).problem).toBe('tooFarBack')
    // Justo en el borde: 12 h exactas se aceptan.
    expect(shiftStart(ago(11 * HOUR), 60, now).at).toBe(ago(12 * HOUR))
  })

  it('el tope de 12 h se aplica aunque cada paso sea chico (acumulativo)', () => {
    let at = ago(11 * HOUR + 52 * MIN)
    const first = shiftStart(at, 5, now)
    expect(first.problem).toBeNull() // 11 h 57 min: entra
    at = first.at!
    expect(shiftStart(at, 5, now).problem).toBe('tooFarBack') // 12 h 02 min: no
  })
})
