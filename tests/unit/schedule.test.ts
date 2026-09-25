import { describe, expect, it } from 'vitest'
import {
  APPOINTMENT_CARD_MS,
  DEFAULT_FAMILY_SETTINGS,
  checkThreshold,
  dueFrom,
  lastFeedingEnd,
  lastNapEnd,
  minutesUntil,
  nextAppointment,
  nextDue,
} from '@/lib/schedule'
import { REPEAT_MS, shouldAlert } from '@/lib/push/schedule'
import {
  addDays,
  currentLifeWeek,
  daysBetween,
  lifeWeekOfDay,
  lifeWeekRange,
  lifeWeeksUpTo,
} from '@/lib/lifeWeek'
import { buildIcs, foldLine, icsEscape, icsInstant } from '@/lib/calendar/ics'
import type { DoctorAppointment, Feeding, NursingSession, SleepSession } from '@/lib/types'

const feeding = (at: string, type: Feeding['feeding_type'] = 'bottle'): Feeding => ({
  id: at,
  fed_at: at,
  feeding_type: type,
  amount_ml: 120,
  notes: null,
})
const nursing = (start: string, end: string | null): NursingSession => ({
  id: start,
  side: 'left',
  started_at: start,
  ended_at: end,
})
const sleep = (start: string, end: string | null): SleepSession => ({
  id: start,
  started_at: start,
  ended_at: end,
  source: 'manual',
})

describe('lib/schedule — el último evento de comida', () => {
  it('mide desde el FIN de una toma de pecho, no desde su inicio', () => {
    // La diferencia con predictNextFeeding, que medía desde started_at: una
    // toma de 40 minutos no vence tres horas después de EMPEZAR.
    const last = lastFeedingEnd([], [nursing('2026-09-24T10:00:00Z', '2026-09-24T10:40:00Z')])
    expect(last).toEqual({ endedAt: '2026-09-24T10:40:00Z', running: false })
  })

  it('un evento puntual cuenta desde fed_at: no tiene otro instante', () => {
    expect(lastFeedingEnd([feeding('2026-09-24T10:00:00Z')], [])).toEqual({
      endedAt: '2026-09-24T10:00:00Z',
      running: false,
    })
  })

  it('cuenta las tres clases de comida, no solo el pecho', () => {
    const rows = [
      feeding('2026-09-24T09:00:00Z', 'bottle'),
      feeding('2026-09-24T11:00:00Z', 'solid'),
    ]
    expect(lastFeedingEnd(rows, [])?.endedAt).toBe('2026-09-24T11:00:00Z')
  })

  it('una sesión en curso gana y se marca `running`: está comiendo ahora', () => {
    const last = lastFeedingEnd(
      [feeding('2026-09-24T08:00:00Z')],
      [nursing('2026-09-24T12:00:00Z', null)],
    )
    expect(last).toEqual({ endedAt: '2026-09-24T12:00:00Z', running: true })
    // Y eso es lo que preserva el ocultamiento de la línea durante una
    // lactancia, que ya existía antes de este pase.
    expect(dueFrom(last, 180, Date.parse('2026-09-24T13:00:00Z'))).toBeNull()
  })

  it('una fila retractada no cuenta', () => {
    const rows = [{ ...feeding('2026-09-24T11:00:00Z'), voided_at: '2026-09-24T11:05:00Z' }]
    expect(lastFeedingEnd(rows, [])).toBeNull()
  })

  it('sin ningún evento no hay nada que decir', () => {
    expect(lastFeedingEnd([], [])).toBeNull()
    expect(dueFrom(null, 180, Date.now())).toBeNull()
  })
})

describe('lib/schedule — la última siesta', () => {
  it('mide desde ended_at', () => {
    expect(lastNapEnd([sleep('2026-09-24T10:00:00Z', '2026-09-24T11:30:00Z')])?.endedAt).toBe(
      '2026-09-24T11:30:00Z',
    )
  })
  it('durmiendo ahora: no hay próxima siesta que contar', () => {
    expect(lastNapEnd([sleep('2026-09-24T10:00:00Z', null)])?.running).toBe(true)
  })
})

describe('lib/schedule — la cuenta regresiva', () => {
  const end = '2026-09-24T10:00:00Z'

  it('suma el umbral al fin del evento', () => {
    const d = nextDue(end, 180, Date.parse('2026-09-24T11:00:00Z'))
    expect(d?.dueAt).toBe('2026-09-24T13:00:00.000Z')
    expect(d?.minutesLeft).toBe(120)
    expect(d?.overdue).toBe(false)
  })

  it('pasado el umbral, los minutos quedan NEGATIVOS y marca overdue', () => {
    const d = nextDue(end, 180, Date.parse('2026-09-24T13:45:00Z'))
    expect(d?.minutesLeft).toBe(-45)
    expect(d?.overdue).toBe(true)
  })

  it('el borde es inclusivo: justo al vencer ya está vencido', () => {
    expect(nextDue(end, 180, Date.parse('2026-09-24T13:00:00Z'))?.overdue).toBe(true)
    expect(nextDue(end, 180, Date.parse('2026-09-24T12:59:59Z'))?.overdue).toBe(false)
  })

  it('una fecha inválida no produce un vencimiento inventado', () => {
    expect(nextDue('no es una fecha', 180, Date.now())).toBeNull()
  })

  it('los defaults son los del pedido y los de la columna (0012)', () => {
    expect(DEFAULT_FAMILY_SETTINGS.feed_threshold_minutes).toBe(180)
    expect(DEFAULT_FAMILY_SETTINGS.nap_threshold_minutes).toBe(120)
  })
})

describe('lib/schedule — validación del umbral', () => {
  it('acepta lo que el CHECK de 0012 acepta', () => {
    expect(checkThreshold(15)).toBeNull()
    expect(checkThreshold(1440)).toBeNull()
  })
  it('rechaza fuera de rango, decimales y basura', () => {
    expect(checkThreshold(14)).toBe('outOfRange')
    expect(checkThreshold(1441)).toBe('outOfRange')
    expect(checkThreshold(90.5)).toBe('notNumber')
    expect(checkThreshold(Number.NaN)).toBe('notNumber')
    expect(checkThreshold(Number.POSITIVE_INFINITY)).toBe('notNumber')
  })
})

describe('lib/schedule — la próxima cita', () => {
  const appt = (at: string, completed = false): DoctorAppointment => ({
    id: at,
    title: 'Control',
    appointment_type: 'checkup',
    scheduled_at: at,
    doctor_name: null,
    notes: null,
    completed,
  })
  const now = Date.parse('2026-09-24T12:00:00Z')

  it('trae la más próxima dentro de las 36 h', () => {
    const rows = [appt('2026-09-25T18:00:00Z'), appt('2026-09-25T09:00:00Z')]
    expect(nextAppointment(rows, now)?.scheduled_at).toBe('2026-09-25T09:00:00Z')
  })

  it('fuera de la ventana de 36 h no hay tarjeta', () => {
    expect(nextAppointment([appt('2026-09-27T12:00:00Z')], now)).toBeNull()
    // Y el borde exacto sí entra.
    expect(
      nextAppointment([appt(new Date(now + APPOINTMENT_CARD_MS).toISOString())], now),
    ).not.toBeNull()
  })

  it('ignora las pasadas y las marcadas como hechas', () => {
    expect(nextAppointment([appt('2026-09-24T09:00:00Z')], now)).toBeNull()
    expect(nextAppointment([appt('2026-09-25T09:00:00Z', true)], now)).toBeNull()
  })

  it('minutesUntil nunca es negativo', () => {
    expect(minutesUntil('2026-09-24T11:00:00Z', now)).toBe(0)
    expect(minutesUntil('2026-09-24T13:30:00Z', now)).toBe(90)
  })
})

describe('lib/push/schedule — la regla de repetición', () => {
  const now = Date.parse('2026-09-24T12:00:00Z')

  it('no avisa si no está vencido', () => {
    expect(shouldAlert({ overdue: false, lastAlertAt: null, lastEventAt: null, now }).send).toBe(
      false,
    )
  })

  it('avisa la primera vez', () => {
    expect(shouldAlert({ overdue: true, lastAlertAt: null, lastEventAt: null, now }).send).toBe(
      true,
    )
  })

  it('no repite antes de los 30 min', () => {
    const recent = new Date(now - REPEAT_MS + 60_000).toISOString()
    const d = shouldAlert({ overdue: true, lastAlertAt: recent, lastEventAt: null, now })
    expect(d.send).toBe(false)
    expect(d.reason).toBe('tooSoon')
  })

  it('repite a los 30 min exactos', () => {
    const old = new Date(now - REPEAT_MS).toISOString()
    expect(shouldAlert({ overdue: true, lastAlertAt: old, lastEventAt: null, now }).send).toBe(true)
  })

  it('un evento posterior al último aviso reinicia el ciclo', () => {
    // El caso que se paga caro: comió a las 11:55, el aviso anterior fue a las
    // 11:50, y a las 12:00 vuelve a estar vencido por otro motivo. Sin esta
    // condición el aviso se quedaría callado media hora.
    const recent = new Date(now - 10 * 60_000).toISOString()
    const evento = new Date(now - 5 * 60_000).toISOString()
    expect(shouldAlert({ overdue: true, lastAlertAt: recent, lastEventAt: evento, now }).send).toBe(
      true,
    )
  })

  it('una marca ilegible no bloquea el aviso', () => {
    expect(shouldAlert({ overdue: true, lastAlertAt: 'basura', lastEventAt: null, now }).send).toBe(
      true,
    )
  })
})

describe('lib/lifeWeek — la semana de vida', () => {
  const birth = '2026-09-01'

  it('el día del nacimiento es la semana 1, y el séptimo día también', () => {
    expect(lifeWeekOfDay(birth, '2026-09-01')).toBe(1)
    expect(lifeWeekOfDay(birth, '2026-09-07')).toBe(1)
    expect(lifeWeekOfDay(birth, '2026-09-08')).toBe(2)
    expect(lifeWeekOfDay(birth, '2026-09-22')).toBe(4)
  })

  it('antes de nacer no hay semana, y sin fecha de nacimiento tampoco', () => {
    expect(lifeWeekOfDay(birth, '2026-08-31')).toBeNull()
    expect(lifeWeekOfDay(null, '2026-09-10')).toBeNull()
    expect(lifeWeekOfDay('', '2026-09-10')).toBeNull()
  })

  it('el tramo de una semana son siete días de calendario y es medio abierto', () => {
    const r = lifeWeekRange(birth, 2)!
    expect(r.days).toEqual([
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
      '2026-09-14',
    ])
    // `end` es la medianoche de la semana 3: un evento no cae en dos semanas.
    expect(r.end).toBe(lifeWeekRange(birth, 3)!.start)
  })

  it('una semana con cambio de horario dura 167 o 169 h, no 168 — y sigue siendo de siete días', () => {
    // El horario de verano de Los Ángeles termina el 1 de noviembre de 2026.
    const r = lifeWeekRange('2026-10-29', 1)!
    expect(r.days).toHaveLength(7)
    const hours = (r.end - r.start) / 3_600_000
    expect(hours).toBe(169)
  })

  it('NO se ofrece una semana futura: no tendría datos', () => {
    const now = new Date('2026-09-20T12:00:00Z')
    expect(currentLifeWeek(birth, now)).toBe(3)
    expect(lifeWeeksUpTo(birth, now)).toEqual([3, 2, 1])
    expect(lifeWeeksUpTo(null, now)).toEqual([])
  })

  it('la aritmética de días de calendario no se corre con los meses', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(daysBetween('2026-09-01', '2026-10-01')).toBe(30)
  })

  it('una semana pedida que no existe no devuelve un tramo inventado', () => {
    expect(lifeWeekRange(birth, 0)).toBeNull()
    expect(lifeWeekRange(birth, 1.5)).toBeNull()
    expect(lifeWeekRange(null, 3)).toBeNull()
  })
})

describe('lib/calendar/ics — RFC 5545', () => {
  const appt = (over: Partial<DoctorAppointment> = {}): DoctorAppointment => ({
    id: '11111111-2222-3333-4444-555555555555',
    title: 'Control de 2 meses',
    appointment_type: 'checkup',
    scheduled_at: '2026-09-25T17:30:00.000Z',
    doctor_name: 'Dra. Pérez',
    notes: null,
    completed: false,
    ...over,
  })

  it('los instantes van en UTC, sin guiones ni dos puntos ni milisegundos', () => {
    expect(icsInstant('2026-09-25T17:30:00.000Z')).toBe('20260925T173000Z')
  })

  it('escapa barra, punto y coma, coma y saltos de línea — en ese orden', () => {
    expect(icsEscape('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne')
  })

  it('pliega a 75 octetos con un espacio al principio de la continuación', () => {
    const long = `DESCRIPTION:${'x'.repeat(200)}`
    const folded = foldLine(long)
    expect(folded).toContain('\r\n ')
    for (const part of folded.split('\r\n')) {
      expect(Buffer.from(part, 'utf8').length).toBeLessThanOrEqual(75)
    }
  })

  it('no parte un carácter multibyte por el medio', () => {
    const folded = foldLine(`SUMMARY:${'á'.repeat(80)}`)
    // Si partiera un carácter aparecería U+FFFD al decodificar.
    expect(folded).not.toContain('�')
  })

  it('arma un VCALENDAR completo, con CRLF y terminado', () => {
    const ics = buildIcs({
      name: 'Amelia',
      appointments: [appt()],
      now: new Date('2026-09-24T12:00:00Z'),
    })
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain('UID:11111111-2222-3333-4444-555555555555@amelia.app')
    expect(ics).toContain('DTSTAMP:20260924T120000Z')
    expect(ics).toContain('DTSTART:20260925T173000Z')
    // Una hora de duración: la app no guarda cuánto dura un turno.
    expect(ics).toContain('DTEND:20260925T183000Z')
    expect(ics).toContain('STATUS:CONFIRMED')
    expect(ics).not.toContain('\n\n')
    // Ni una sola línea suelta con LF: iOS y Outlook rechazan el feed entero.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('una cita hecha queda como CANCELLED, no desaparece del feed', () => {
    const ics = buildIcs({
      name: 'Amelia',
      appointments: [appt({ completed: true })],
      now: new Date('2026-09-24T12:00:00Z'),
    })
    expect(ics).toContain('STATUS:CANCELLED')
  })

  it('sin turnos es un calendario válido y vacío, no un error', () => {
    const ics = buildIcs({ name: 'Amelia', appointments: [], now: new Date() })
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).not.toContain('BEGIN:VEVENT')
  })

  it('una nota con coma no corta el campo', () => {
    const ics = buildIcs({
      name: 'Amelia',
      appointments: [appt({ notes: 'Traer la libreta, la tarjeta y el carnet' })],
      now: new Date('2026-09-24T12:00:00Z'),
    })
    expect(ics).toContain('\\, la tarjeta')
  })

  it('una fecha ilegible se saltea en vez de romper el feed entero', () => {
    const ics = buildIcs({
      name: 'Amelia',
      appointments: [appt({ scheduled_at: 'no es una fecha' })],
      now: new Date('2026-09-24T12:00:00Z'),
    })
    expect(ics).not.toContain('BEGIN:VEVENT')
    expect(ics).toContain('END:VCALENDAR')
  })
})
