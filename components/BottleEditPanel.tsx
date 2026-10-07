'use client'

/**
 * Correcting a past bottle with a breakdown (2A, V4-50…V4-57): its time, how
 * much breast milk and how much formula, what was left over, and the note.
 * ONE component, opened from History's ⋯ and from /feeding's Edit (D-16) — two
 * rules for the same bottle would be worse than one panel too many.
 *
 * Before saving it says what will happen to the milk, with the same plan the
 * server runs (planBottleEdit, lib/milkBottles.ts): less milk goes back to the
 * newest bottle first (D-17), more comes from the oldest one usable at the
 * bottle's time (D-18), milk that can't go back says so (D-9), and when there
 * isn't enough milk it says how much there was and doesn't let it save
 * (V4-54). Formula never blocks.
 *
 * The amounts are in ounces with no toggle, like every edit panel (D-20):
 * a prefilled "4.1" re-read as ml would destroy the value. An untouched field
 * keeps the exact stored ml (keepMl), and an untouched time keeps the exact
 * stored instant — the time field has no seconds, and re-reading it would
 * make a save that changed nothing look like a change.
 *
 * Saving goes through editBottleFeed (the offline queue too). Another phone
 * having changed the bottle meanwhile comes back as `milk_edit_conflict`:
 * nothing was saved, the panel says so and the page reads again.
 */

import { useEffect, useRef, useState } from 'react'
import { Btn } from '@/components/ui'
import { LeftoverField, type LeftoverValue } from '@/components/LeftoverField'
import { useT } from '@/lib/i18n/react'
import {
  editBottleFeed,
  milkErrorText,
  type BottleEditContext,
  type MilkEditResult,
} from '@/lib/db'
import { isInventoryBottleFeed, keepMl, ozText, rereadsInventory } from '@/lib/milk'
import type { LegacySplit } from '@/lib/milkEstimate'
import { planBottleEdit, validateLeftover, type LostReason } from '@/lib/milkBottles'
import {
  DISPLAY_UNIT,
  formatMilkOz,
  fromHouseholdInputValue,
  toHouseholdInputValue,
} from '@/lib/format'
import { translate, type Lang, type MessageKey } from '@/lib/i18n'
import type { Feeding, WithPending } from '@/lib/types'

const LOST_KEY: Record<LostReason, MessageKey> = {
  reused: 'milk.notReturnedReused',
  discarded: 'milk.notReturnedDiscarded',
  voided: 'milk.notReturnedGone',
  unknown: 'milk.notReturnedGone',
  combined: 'milk.notReturnedCombined',
}

/** "1 oz didn't go back to M3…" for what the server said could not go back. */
export function notReturnedLines(
  result: Pick<MilkEditResult, 'lost'> | null,
  t: ReturnType<typeof useT>['t'],
): string[] {
  return (result?.lost ?? [])
    .filter((m) => m.ml > 0)
    .map((m) => t('milk.notReturned', { amount: formatMilkOz(m.ml), label: m.label }))
}

export function BottleEditPanel({
  feeding,
  inventory,
  idPrefix,
  onSaved,
  onCancel,
  onReread,
}: {
  feeding: WithPending<Feeding>
  /** What this phone knows of the inventory, the queue folded in. */
  inventory: BottleEditContext
  idPrefix: string
  /** Saved or queued: the page closes the panel and shows `message`. */
  onSaved: (message: string) => void
  onCancel: () => void
  /** What is on screen is out of date: the page reads again. */
  onReread: () => void
}) {
  const { t, lang } = useT()
  const [base] = useState(() => ({
    at: toHouseholdInputValue(new Date(feeding.fed_at)),
    milk: ozText(feeding.breast_milk_ml ?? 0),
    formula: ozText(feeding.formula_ml ?? 0),
  }))
  const [at, setAt] = useState(base.at)
  const [milk, setMilk] = useState(base.milk)
  const [formula, setFormula] = useState(base.formula)
  const [notes, setNotes] = useState(feeding.notes ?? '')
  const [leftover, setLeftover] = useState<LeftoverValue>({
    ml: feeding.leftover_ml ?? null,
    bad: false,
  })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const errRef = useRef<HTMLDivElement>(null)

  // The time limit and "usable at that time" move with the clock.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // An error is read where it happens: focus goes to it.
  useEffect(() => {
    if (err) errRef.current?.focus()
  }, [err])

  const unitName = t(`unit.${DISPLAY_UNIT}`)
  const breast = keepMl(milk, base.milk, feeding.breast_milk_ml ?? 0)
  const form = keepMl(formula, base.formula, feeding.formula_ml ?? 0)
  const fedAt = at === base.at ? feeding.fed_at : at ? fromHouseholdInputValue(at) : ''
  const breastMl = breast.ml ?? 0
  const formulaMl = form.ml ?? 0
  const totalMl = breastMl + formulaMl

  // What is wrong with the fields themselves, before any plan.
  const fieldProblem = breast.problem
    ? t('bottle.milkNotNumber')
    : form.problem
      ? t('bottle.formulaNotNumber')
      : leftover.bad
        ? t('bottle.leftoverNotNumber')
        : !fedAt
          ? t('past.needTime')
          : !(totalMl > 0)
            ? t('bottle.empty')
            : validateLeftover(leftover.ml, totalMl) === 'too_much'
              ? t('bottle.leftoverTooMuch')
              : null

  const plan = fieldProblem
    ? null
    : planBottleEdit(
        feeding,
        inventory.drawdowns,
        inventory.containers,
        inventory.discards,
        {
          fed_at: fedAt,
          breast_milk_ml: breastMl,
          formula_ml: formulaMl,
          leftover_ml: leftover.ml,
          notes: notes.trim() || null,
        },
        now,
        inventory.transfers,
      )

  const planProblem =
    plan && !plan.ok
      ? plan.problem === 'not_enough'
        ? milkErrorText(`milk_not_enough:${plan.availableMl}`, lang)
        : plan.problem === 'unusable'
          ? milkErrorText(`milk_container_unusable:${plan.label}`, lang)
          : plan.problem === 'future'
            ? milkErrorText('milk_future_time', lang)
            : plan.problem === 'not_inventory'
              ? milkErrorText('milk_not_inventory', lang)
              : milkErrorText('milk_bad_input', lang)
      : null
  const problem = fieldProblem ?? planProblem

  // What happens to the milk, said before saving (§8.2: by what this phone knows).
  const lines: string[] = []
  if (plan && plan.ok && !plan.noop) {
    for (const m of plan.taken)
      lines.push(t('bottle.editTakes', { amount: formatMilkOz(m.ml), label: m.label }))
    for (const m of plan.returned)
      lines.push(t('bottle.editReturns', { amount: formatMilkOz(m.ml), label: m.label }))
    for (const m of plan.lost)
      lines.push(t(LOST_KEY[m.reason], { amount: formatMilkOz(m.ml), label: m.label }))
    if (lines.length === 0) lines.push(t('bottle.editNoMilkChange'))
  }

  async function save() {
    if (busy || problem || !plan || !plan.ok) return
    // Nothing changed: nothing to send (the server would answer a no-op too).
    if (plan.noop) {
      onCancel()
      return
    }
    setErr(null)
    setBusy(true)
    const res = await editBottleFeed(
      feeding,
      {
        fed_at: fedAt,
        breast_ml: breastMl,
        formula_ml: formulaMl,
        leftover_ml: leftover.ml,
        notes: notes.trim() || null,
      },
      inventory,
    )
    setBusy(false)
    if (res.error) {
      setErr(t('common.couldNotSave', { error: milkErrorText(res.error, lang) }))
      // Another phone changed the bottle, or the milk on screen is stale:
      // read again so the next try starts from what really is.
      if (/^milk_(edit_conflict|not_enough)/.test(res.error) || rereadsInventory(res.error)) {
        onReread()
      }
      return
    }
    const lost = res.queued
      ? plan.lost.map((m) =>
          t('milk.byThisPhone', {
            text: t(LOST_KEY[m.reason], { amount: formatMilkOz(m.ml), label: m.label }),
          }),
        )
      : notReturnedLines(res.data, t)
    onSaved([t(res.queued ? 'common.queued' : 'common.saved'), ...lost].join(' '))
  }

  return (
    <div className="edit-panel" id={`${idPrefix}-panel`}>
      <p className="label">{t('bottle.editTitle')}</p>
      <div>
        <label className="label" htmlFor={`${idPrefix}-at`}>
          {t('common.timeItHappened')}
        </label>
        <input
          id={`${idPrefix}-at`}
          type="datetime-local"
          className="input"
          value={at}
          disabled={busy}
          onChange={(e) => setAt(e.target.value)}
          max={toHouseholdInputValue(new Date(now))}
        />
      </div>
      <div className="row-tight row-wrap">
        <div>
          <label className="label" htmlFor={`${idPrefix}-milk`}>
            {t('bottle.editMilk', { unit: unitName })}
          </label>
          <input
            id={`${idPrefix}-milk`}
            className="input narrow"
            value={milk}
            disabled={busy}
            inputMode="decimal"
            placeholder={unitName}
            onChange={(e) => setMilk(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${idPrefix}-formula`}>
            {t('bottle.editFormula', { unit: unitName })}
          </label>
          <input
            id={`${idPrefix}-formula`}
            className="input narrow"
            value={formula}
            disabled={busy}
            inputMode="decimal"
            placeholder={unitName}
            onChange={(e) => setFormula(e.target.value)}
          />
        </div>
      </div>
      <div className="value" aria-live="polite">
        {t('bottle.total', { amount: formatMilkOz(totalMl) })}
      </div>
      <LeftoverField
        id={`${idPrefix}-leftover`}
        initialMl={feeding.leftover_ml ?? null}
        disabled={busy}
        onChange={setLeftover}
      />
      <input
        className="input"
        value={notes}
        disabled={busy}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={t('common.notesOptional')}
        aria-label={t('common.notes')}
      />
      {lines.length > 0 && !problem && (
        <div aria-live="polite">
          <p className="meta">{t('bottle.editPlan')}</p>
          <ul className="meta">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {problem && (
        <p className="meta" aria-live="polite">
          {problem}
        </p>
      )}
      {err && (
        <div ref={errRef} tabIndex={-1} role="alert" className="banner error">
          {err}
        </div>
      )}
      <div className="row-tight">
        <Btn disabled={busy || !!problem || !plan || !plan.ok} onClick={save}>
          {busy ? t('common.saving') : t('common.save')}
        </Btn>
        <Btn variant="quiet" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Btn>
      </div>
    </div>
  )
}

/**
 * The detail line of a bottle WITHOUT a breakdown (legacy, D-14/D-11b): its
 * estimated milk / formula split, said as an estimate ("≈ 1.5 oz breast milk
 * + 1.5 oz formula (estimated)", V4-63), then "· 1 oz left over" when that is
 * known (V4-44). Null when there is nothing to add to its total. Nothing here
 * is stored: the estimate is computed when the page reads (lib/milkEstimate.ts).
 */
export function legacyBottleLine(
  feeding: Feeding,
  split: LegacySplit | undefined,
  lang: Lang,
): string | null {
  if (feeding.feeding_type !== 'bottle' || isInventoryBottleFeed(feeding)) return null
  const parts: string[] = []
  if (split) {
    parts.push(
      translate(lang, 'bottle.estimated', {
        milk: formatMilkOz(split.breastMl),
        formula: formatMilkOz(split.formulaMl),
      }),
    )
  }
  if (feeding.leftover_ml != null) {
    parts.push(
      translate(lang, 'bottle.leftoverPart', { amount: formatMilkOz(Number(feeding.leftover_ml)) }),
    )
  }
  return parts.length ? parts.join(' · ') : null
}
