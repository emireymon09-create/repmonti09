'use client'

/**
 * "Sobró X oz" (V4-41, D-10): what the baby left in the bottle. Optional —
 * empty is "not known / nothing left" (null), never 0 — and statistics only:
 * it never gives milk back to a container and never counts as discarded milk.
 *
 * ONE component for every place a bottle is logged or corrected: the bottle
 * panel on Today, "Log a past one" on /feeding, and the bottle edit panel
 * (History and /feeding). It carries its own oz/ml toggle, independent of the
 * bottle's: switching it converts what is typed (convertAmountText, the same
 * rule as every other toggle, D-19), and it starts in oz every time it mounts
 * (design.md §5.7) — a page remounts it (a `key`) after each save.
 *
 * Prefilled from a stored value (an edit), the field means that EXACT stored
 * ml while it still says what it was prefilled with: re-reading the rounded
 * ounces would move 30 ml to 29.87 on a save that changed nothing (the same
 * contract as `keepMl`, lib/milk.ts).
 *
 * It reports the parsed ml up; whether it is more than was served depends on
 * the bottle's total, which only the page knows — the page checks that with
 * validateLeftover before sending.
 */

import { useEffect, useRef, useState } from 'react'
import { AmountUnit } from '@/components/AmountUnit'
import { useT } from '@/lib/i18n/react'
import { DISPLAY_UNIT } from '@/lib/format'
import { amountText, convertAmountText, parseAmountMl } from '@/lib/milk'
import type { VolumeUnit } from '@/lib/types'

export type LeftoverValue = {
  /** Null = left empty. */
  ml: number | null
  /** What was typed isn't a number of zero or more. */
  bad: boolean
}

export function LeftoverField({
  id,
  initialMl = null,
  disabled,
  onChange,
}: {
  id: string
  /** The stored value, for an edit. */
  initialMl?: number | null
  disabled?: boolean
  onChange: (value: LeftoverValue) => void
}) {
  const { t } = useT()
  const [base] = useState(() => (initialMl != null ? amountText(initialMl, DISPLAY_UNIT) : ''))
  const [text, setText] = useState(base)
  const [unit, setUnit] = useState<VolumeUnit>(DISPLAY_UNIT)

  const untouched = initialMl != null && unit === DISPLAY_UNIT && text.trim() === base.trim()
  const parsed = parseAmountMl(text, unit)
  const value: LeftoverValue = untouched
    ? { ml: initialMl, bad: false }
    : parsed.problem
      ? { ml: null, bad: true }
      : { ml: parsed.ml, bad: false }

  // Only when it really changed: the pages re-render every second.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const sig = JSON.stringify(value)
    if (sig === reported.current) return
    reported.current = sig
    onChange(value)
  })

  const unitName = t(`unit.${unit}`)
  return (
    <div>
      <label className="label" htmlFor={id}>
        {t('bottle.leftover')}
      </label>
      <div className="row-tight row-wrap">
        <input
          id={id}
          className="input narrow"
          value={text}
          disabled={disabled}
          inputMode="decimal"
          placeholder={unitName}
          aria-label={t('bottle.leftoverAria', { unit: unitName })}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setText(e.target.value)}
        />
        <AmountUnit
          value={unit}
          disabled={disabled}
          label={t('bottle.leftoverUnit')}
          onChange={(next) => {
            if (next === unit) return
            setText((x) => convertAmountText(x, unit, next))
            setUnit(next)
          }}
        />
      </div>
      <p className="meta" id={`${id}-hint`}>
        {t('bottle.leftoverHint')}
      </p>
    </div>
  )
}
