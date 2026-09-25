'use client'

/**
 * El selector de semana de vida: semana 1, 2, 3… desde que nació.
 *
 * NO es la ventana `week` de lib/kpis.ts (hoy + los 6 días de calendario
 * anteriores). Ésta es un tramo FIJO del calendario que no se mueve con el
 * tiempo, y por eso se puede elegir una y comparar con la anterior. Las dos
 * conviven; el detalle está en lib/lifeWeek.ts.
 *
 * Dos flechas y el nombre en el medio, en vez de un `<select>` con cuarenta
 * opciones: lo que se hace el 95 % de las veces es mirar la semana que corre
 * o la anterior, y eso es un toque. Las dos flechas miden `--tap` entera
 * (design.md §1): esto se usa a una mano.
 *
 * Sin `birth_date` no hay semana de vida y no se inventa una — la pantalla que
 * lo monta muestra el estado que lo explica, no "semana 1" por las dudas
 * (§5.4).
 */

import { useT } from '@/lib/i18n/react'
import { measuredOn } from '@/lib/format'
import type { LifeWeekRange } from '@/lib/lifeWeek'

export function WeekPicker({
  range,
  isCurrent,
  canGoBack,
  onChange,
}: {
  range: LifeWeekRange
  /** La semana que corre: no se puede ir hacia adelante desde acá. */
  isCurrent: boolean
  canGoBack: boolean
  onChange: (week: number) => void
}) {
  const { t, lang } = useT()
  const first = range.days[0]
  const last = range.days[range.days.length - 1]

  return (
    <div className="weekpick">
      <button
        type="button"
        className="weekpick-btn"
        disabled={!canGoBack}
        aria-label={t('week.previous')}
        onClick={() => onChange(range.week - 1)}
      >
        <Arrow direction="back" />
      </button>

      <div className="weekpick-name" aria-live="polite">
        <span className="value">
          {isCurrent
            ? t('week.thisWeek', { week: range.week })
            : t('week.number', { week: range.week })}
        </span>
        <span className="weekpick-when">
          {t('week.range', {
            start: measuredOn(first, lang),
            end: measuredOn(last, lang),
          })}
        </span>
      </div>

      <button
        type="button"
        className="weekpick-btn"
        disabled={isCurrent}
        aria-label={t('week.next')}
        onClick={() => onChange(range.week + 1)}
      >
        <Arrow direction="forward" />
      </button>
    </div>
  )
}

/**
 * Misma convención que los trece íconos del nav (design.md §8): grilla de 24,
 * `viewBox="0 0 24 24"`, sin relleno, trazo en `currentColor`. No hay librería
 * de íconos en este repo y no se agregó ninguna.
 */
function Arrow({ direction }: { direction: 'back' | 'forward' }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === 'back' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
    </svg>
  )
}
