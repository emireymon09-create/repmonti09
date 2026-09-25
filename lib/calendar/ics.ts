/**
 * El feed .ics de los turnos médicos, en su parte PURA: armar el VCALENDAR.
 * Sin red, sin base, sin env — igual que lib/push/nursing.ts es la parte pura
 * del aviso. Lo que toca la base vive en lib/calendar/server.ts.
 *
 * RFC 5545. Lo que este archivo respeta y por qué importa (un cliente de
 * calendario real rechaza el feed entero por cualquiera de estas):
 *
 *   · CRLF entre líneas, no LF (§3.1). iOS y Outlook son estrictos.
 *   · Plegado a 75 octetos, con un espacio al principio de la continuación
 *     (§3.1). Una nota larga del doctor pasa ese largo sin esfuerzo.
 *   · Escapado de `\`, `;`, `,` y los saltos de línea dentro de un TEXT
 *     (§3.3.11). Sin esto, una nota con una coma corta el campo.
 *   · UID estable y único por evento (§3.8.4.7), y DTSTAMP obligatorio.
 *   · Los instantes van en UTC con la Z. La base ya guarda UTC, así que no
 *     hace falta emitir un VTIMEZONE: el cliente lo muestra en la zona del
 *     usuario. El texto de la app sí se renderiza en la TZ del hogar
 *     (lib/format.ts), pero un calendario es del dispositivo que lo lee.
 *
 * EL IDIOMA: el feed se emite en INGLÉS, siempre. Es la misma razón por la que
 * el server siempre renderiza inglés (CLAUDE.md §5.7): no hay sesión, no hay
 * `localStorage`, y `Accept-Language` no se usa en este repo a propósito. Lo
 * que se traduce sí es el tipo de turno, y para eso los diccionarios se
 * consultan con 'en' fijo.
 */

import { translate } from '@/lib/i18n'
import type { AppointmentType, DoctorAppointment } from '@/lib/types'

/** Cuánto dura un turno en el calendario cuando la app no guarda duración. */
export const APPOINTMENT_DURATION_MINUTES = 60

/**
 * El dominio de los UID. No identifica a nadie ni lleva el token: es una
 * etiqueta, y el uuid de la fila ya es único.
 */
export const ICS_UID_DOMAIN = 'amelia.app'

/** `20260924T183000Z` — el formato de instante de RFC 5545 §3.3.5. */
export function icsInstant(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/**
 * Escapa un valor TEXT (§3.3.11). El orden importa: la barra invertida va
 * primero, o se escaparían las barras que este mismo paso acaba de agregar.
 */
export function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

/**
 * Plegado de línea a 75 octetos (§3.1). Se cuenta en OCTETOS, no en
 * caracteres: "Pediatría" en UTF-8 ocupa más bytes que letras, y plegar por
 * largo de string dejaría líneas fuera de norma. Tampoco se parte un carácter
 * multibyte por el medio.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line

  const out: string[] = []
  let start = 0
  let limit = 75
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    // No cortar en medio de un carácter: los bytes de continuación UTF-8 son
    // 10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
    out.push(bytes.subarray(start, end).toString('utf8'))
    start = end
    // Las continuaciones llevan un espacio adelante, que también ocupa octeto.
    limit = 74
  }
  return out.join('\r\n ')
}

function line(name: string, value: string): string {
  return foldLine(`${name}:${value}`)
}

/** El nombre del tipo de turno, en inglés (ver el encabezado). */
function typeLabel(type: AppointmentType | null): string | null {
  if (!type) return null
  return translate('en', `apptType.${type}`)
}

export type IcsCalendar = {
  /** Lo que el cliente muestra como nombre del calendario suscrito. */
  name: string
  appointments: readonly DoctorAppointment[]
  /** El DTSTAMP de esta generación. */
  now: Date
}

/**
 * El VCALENDAR entero, como string listo para servir.
 *
 * Un feed sin un solo turno es un VCALENDAR válido y vacío, no un 404: un
 * calendario suscrito que empieza a devolver error se ve como una cuenta rota,
 * y "todavía no hay turnos" es una respuesta correcta.
 */
export function buildIcs({ name, appointments, now }: IcsCalendar): string {
  const stamp = icsInstant(now.toISOString())
  const out: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    line('PRODID', '-//Amelia//Baby tracking//EN'),
    'CALSCALE:GREGORIAN',
    // El feed es de solo lectura: cualquier cambio se hace en la app.
    'METHOD:PUBLISH',
    line('X-WR-CALNAME', icsEscape(name)),
    // Cada cuánto vale la pena que el cliente vuelva a pedirlo. Un turno se
    // carga con días de anticipación; cada hora es de sobra.
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ]

  for (const a of appointments) {
    const start = Date.parse(a.scheduled_at)
    if (Number.isNaN(start)) continue
    const end = new Date(start + APPOINTMENT_DURATION_MINUTES * 60_000).toISOString()

    const description = [
      a.doctor_name ? `Doctor: ${a.doctor_name}` : null,
      typeLabel(a.appointment_type),
      a.notes,
    ]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join('\n')

    out.push(
      'BEGIN:VEVENT',
      line('UID', `${a.id}@${ICS_UID_DOMAIN}`),
      line('DTSTAMP', stamp),
      line('DTSTART', icsInstant(a.scheduled_at)),
      line('DTEND', icsInstant(end)),
      line('SUMMARY', icsEscape(a.title)),
    )
    if (description) out.push(line('DESCRIPTION', icsEscape(description)))
    if (a.doctor_name) out.push(line('LOCATION', icsEscape(a.doctor_name)))
    // Un turno marcado como hecho queda en el calendario pero como cancelado:
    // borrarlo del feed le sacaría del historial al cliente una cita que sí
    // pasó.
    out.push(line('STATUS', a.completed ? 'CANCELLED' : 'CONFIRMED'), 'END:VEVENT')
  }

  out.push('END:VCALENDAR')
  // Termina en CRLF: una última línea sin terminador es la que más clientes
  // truncan.
  return `${out.join('\r\n')}\r\n`
}
