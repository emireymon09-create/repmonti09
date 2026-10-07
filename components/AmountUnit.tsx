'use client'

/**
 * The oz / ml toggle that sits right next to a bottle amount field
 * (23 sep 2026).
 *
 * It is NOT the old per-device preference — that one is gone and the app
 * shows every amount in ounces (lib/format.ts, DISPLAY_UNIT). This one says
 * what the number *being typed right now* is in, so a bottle measured on a
 * ml scale can be entered without doing the arithmetic in your head at 3 AM.
 *
 * Deliberately NOT remembered: it goes back to `oz` every time the card
 * mounts. It belongs to one entry, and a sticky "ml" that nobody could see
 * on the next screen is exactly how an amount gets logged wrong.
 *
 * Same segmented control as Settings (`.seg` / `.seg-btn`), so it reads as
 * "pick one of these", with `.seg-inline` for the version that lives inside
 * a row instead of under a label.
 */

import type { VolumeUnit } from '@/lib/types'
import { useT } from '@/lib/i18n/react'

const UNITS: VolumeUnit[] = ['oz', 'ml']

export function AmountUnit({
  value,
  onChange,
  disabled,
  label,
}: {
  value: VolumeUnit
  onChange: (unit: VolumeUnit) => void
  disabled?: boolean
  /**
   * The accessible name of the group, when one page has more than one toggle
   * (left and right on /pumping, "left over" next to a bottle): two radio
   * groups with the same name can't be told apart (V4-01 CA5).
   */
  label?: string
}) {
  const { t } = useT()
  return (
    <div className="seg seg-inline" role="radiogroup" aria-label={label ?? t('amountUnit.label')}>
      {UNITS.map((unit) => (
        <button
          key={unit}
          type="button"
          role="radio"
          aria-checked={value === unit}
          className="seg-btn"
          disabled={disabled}
          onClick={() => onChange(unit)}
        >
          {t(`unit.${unit}`)}
        </button>
      ))}
    </div>
  )
}
