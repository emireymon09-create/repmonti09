'use client'

/**
 * Which physical bottle the milk went into (V4-11, V4-12, D-1, D-4).
 *
 * The bottles are real ones, reused and washed (M1…MN, N from Settings): the
 * number is the bottle's name, not its age, so they are laid out in numeric
 * order. Nothing comes chosen (D-4): picking it is the only way the app and
 * the fridge agree, and a preselected one gets accepted without looking at
 * 3 AM. A bottle that still has milk can't be chosen — it says so, with what
 * it holds and since when ("Has 2.5 oz · 14:20"), or "Expired".
 *
 * A container holding a number above N (a v3 "M9" with N = 6, or N lowered
 * under a full bottle) is shown after the others, never offered (D-1/D-2).
 *
 * `containers: null` is a list this phone doesn't know (offline, nothing
 * read, no saved copy): every number is offered and the hint says the server
 * decides on sync (V4-11 CA3) — it never pretends to know.
 *
 * Same radio-group pattern as the rest of the app (.seg in Settings,
 * AmountUnit): role="radiogroup" with role="radio" buttons. A taken bottle is
 * `aria-disabled`, not `disabled`, so a screen reader still reaches it and
 * reads why.
 */

import { forwardRef } from 'react'
import { useT } from '@/lib/i18n/react'
import { bottleSlots, type Slot } from '@/lib/milkBottles'
import { clockTime, formatMilkOz, householdToday, longDate } from '@/lib/format'
import type { Lang } from '@/lib/i18n'
import type { MilkContainer, MilkDiscard, WithPending } from '@/lib/types'

/** "14:20" today, "Oct 5 · 14:20" another day — when it went into the fridge. */
export function storedWhen(iso: string, nowMs: number, lang: Lang): string {
  const sameDay = householdToday(new Date(iso)) === householdToday(new Date(nowMs))
  return sameDay ? clockTime(iso, lang) : `${longDate(iso, lang)} · ${clockTime(iso, lang)}`
}

export const BottleSlotPicker = forwardRef<
  HTMLDivElement,
  {
    idPrefix: string
    /** N: how many bottles there are. */
    count: number
    /** Every container this phone knows of (queue folded in), or null = unknown. */
    containers: WithPending<MilkContainer>[] | null
    discards: MilkDiscard[]
    nowMs: number
    value: string | null
    onChange: (label: string) => void
    disabled?: boolean
    /** The list came from another page's saved copy: when it was saved, said as "x ago". */
    savedAgo?: string | null
    /** Say that the list is unknown (not before the first read has answered). */
    sayUnknown?: boolean
    /** A bottle the server just refused as taken, until the next good read. */
    justTaken?: string | null
  }
>(function BottleSlotPicker(
  {
    idPrefix,
    count,
    containers,
    discards,
    nowMs,
    value,
    onChange,
    disabled,
    savedAgo,
    sayUnknown,
    justTaken,
  },
  ref,
) {
  const { t, lang } = useT()
  const { slots, outOfRange, known } = bottleSlots(count, containers, discards, nowMs)
  const hint = !known
    ? sayUnknown
      ? t('milk.bottlesUnknown')
      : null
    : savedAgo
      ? t('milk.bottlesFromSaved', { when: savedAgo })
      : null

  function reason(slot: Slot, outside: boolean): string {
    let text: string
    if (slot.state === 'expired') text = t('milk.expiredShort')
    else if (slot.state === 'occupied')
      text = t('milk.slotTaken', {
        amount: formatMilkOz(slot.remainingMl ?? 0),
        when: slot.storedAt ? storedWhen(slot.storedAt, nowMs, lang) : '—',
      })
    else if (slot.label === justTaken) text = t('milk.slotJustTaken')
    else text = t('milk.slotFree')
    if (outside) text = `${text} · ${t('milk.outOfRange', { n: count })}`
    if (slot.pending) text = `${text} · ${t('common.notSyncedYet')}`
    return text
  }

  const button = (slot: Slot, outside: boolean) => {
    const blocked = slot.disabled || outside || slot.label === justTaken
    const checked = value === slot.label && !blocked
    return (
      <button
        key={slot.label}
        type="button"
        role="radio"
        className="slot"
        aria-checked={checked}
        aria-disabled={blocked || undefined}
        disabled={disabled}
        onClick={() => {
          if (!blocked) onChange(slot.label)
        }}
      >
        <span className="slot-name">{slot.label}</span>
        <span className="slot-state">{reason(slot, outside)}</span>
      </button>
    )
  }

  return (
    <div>
      <p className="label" id={`${idPrefix}-bottle-label`}>
        {t('milk.bottle')}
      </p>
      <p className="meta" id={`${idPrefix}-bottle-hint`}>
        {t('milk.bottlePick')}
      </p>
      <div
        ref={ref}
        tabIndex={-1}
        className="slots"
        role="radiogroup"
        aria-labelledby={`${idPrefix}-bottle-label`}
        aria-describedby={`${idPrefix}-bottle-hint${hint ? ` ${idPrefix}-bottle-known` : ''}`}
      >
        {slots.map((slot) => button(slot, false))}
        {outOfRange.map((slot) => button(slot, true))}
      </div>
      {hint && (
        <p className="meta" id={`${idPrefix}-bottle-known`}>
          {hint}
        </p>
      )}
    </div>
  )
})
