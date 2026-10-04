'use client'

/**
 * The rows of a bottle (0013): breast milk from one or more containers, plus
 * formula. ONE component, used by the bottle panel on Today and by "Log a past
 * one" on /feeding — not two copies (docs/spec-feeding-v3.md §1.6).
 *
 * It starts from a plan (the suggestion: oldest containers first, the
 * shortfall as formula) and lets the person change anything: another
 * container, other amounts, more or fewer rows, more or less formula. Every
 * change is reported up already parsed and checked, so the page only decides
 * when to send it.
 *
 * Amounts are typed in the unit of the existing oz/ml toggle (oz by default,
 * components/AmountUnit.tsx). Switching it converts what is in the fields —
 * the number keeps meaning the same amount of milk, it is never re-read in
 * the other unit (the failure design.md §5.7 warns about).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AmountUnit } from '@/components/AmountUnit'
import { useT } from '@/lib/i18n/react'
import { newId } from '@/lib/queue'
import { DISPLAY_UNIT, ML_PER_FL_OZ, formatMilkOz } from '@/lib/format'
import { parseAmountMl, portionMl, type BottlePlan } from '@/lib/milk'
import type { MilkContainer, VolumeUnit, WithPending } from '@/lib/types'

export type BottleValue = {
  portions: { container_id: string; amount_ml: number }[]
  formulaMl: number
  totalMl: number
  /** A portion comes from a container that is still only in the queue. */
  containersPending: boolean
  /** What is wrong, in words — null when it can be logged. */
  problem: string | null
}

/**
 * One milk row. `planMl`/`planText`: what the suggestion put in it. While the
 * field still says exactly that, the row means the plan's EXACT millilitres —
 * the text is rounded to 0.01 oz, and reading it back would move a 120 ml
 * suggestion to 120.07 ml with nobody touching anything.
 */
type Row = {
  key: string
  containerId: string
  text: string
  planMl: number | null
  planText: string
}

/** An amount for a field, in `unit`: two decimals in oz, whole ml. */
function amountText(ml: number, unit: VolumeUnit): string {
  if (!(ml > 0)) return ''
  return unit === 'oz' ? String(Number((ml / ML_PER_FL_OZ).toFixed(2))) : String(Math.round(ml))
}

function rowsFromPlan(plan: BottlePlan): Row[] {
  return plan.portions.map((p) => {
    const text = amountText(p.ml, DISPLAY_UNIT)
    return { key: newId(), containerId: p.containerId, text, planMl: p.ml, planText: text }
  })
}

/** Same rows, same formula — what "Log with changes" compares against. */
export function sameAsPlan(value: BottleValue, plan: BottlePlan): boolean {
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-6
  if (!same(value.formulaMl, plan.formulaMl)) return false
  if (value.portions.length !== plan.portions.length) return false
  return plan.portions.every((p, i) => {
    const v = value.portions[i]
    return v && v.container_id === p.containerId && same(v.amount_ml, p.ml)
  })
}

export function BottleBuilder({
  usable,
  plan,
  disabled,
  onChange,
  idPrefix,
}: {
  /** Containers a bottle can come from right now, oldest first, queue folded in. */
  usable: WithPending<MilkContainer>[]
  /** Where the rows start. A new plan (another time, another total) starts them over. */
  plan: BottlePlan
  disabled?: boolean
  onChange: (value: BottleValue) => void
  /** Keeps ids unique when two builders could be on one page. */
  idPrefix: string
}) {
  const { t } = useT()
  const [unit, setUnit] = useState<VolumeUnit>(DISPLAY_UNIT)
  const [rows, setRows] = useState<Row[]>(() => rowsFromPlan(plan))
  const [formula, setFormula] = useState(() => amountText(plan.formulaMl, DISPLAY_UNIT))
  const [formulaPlan, setFormulaPlan] = useState<{ ml: number; text: string | null }>(() => ({
    ml: plan.formulaMl,
    text: amountText(plan.formulaMl, DISPLAY_UNIT),
  }))
  // Once the person has typed something, a new plan (the other phone logged a
  // bottle, a container expired) does NOT wipe it: the builder says the
  // suggestion changed and offers to start over.
  const [dirty, setDirty] = useState(false)
  const [stale, setStale] = useState(false)

  function startOver(from: BottlePlan) {
    const text = amountText(from.formulaMl, DISPLAY_UNIT)
    setUnit(DISPLAY_UNIT)
    setRows(rowsFromPlan(from))
    setFormula(text)
    setFormulaPlan({ ml: from.formulaMl, text })
    setDirty(false)
    setStale(false)
  }

  // A different plan — the page changed the total, the time, or what there is.
  const firstPlan = useRef(plan)
  useEffect(() => {
    if (plan === firstPlan.current) return
    firstPlan.current = plan
    // Typed rows, or a unit picked by hand, are not wiped by a new plan: the
    // builder says the suggestion changed and offers to start over.
    if (dirty || unit !== DISPLAY_UNIT) setStale(true)
    else startOver(plan)
    // `dirty` and `unit` are read, not watched: typing must not start over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan])

  const value = useMemo<BottleValue>(() => {
    const portions: BottleValue['portions'] = []
    let problem: string | null = null
    let containersPending = false
    const seen = new Set<string>()
    for (const row of rows) {
      const container = usable.find((c) => c.id === row.containerId) ?? null
      if (!container) {
        problem ??= t('bottle.pickContainer')
        continue
      }
      if (seen.has(container.id)) {
        problem ??= t('bottle.sameTwice', { label: container.label })
        continue
      }
      seen.add(container.id)
      const parsed = parseAmountMl(row.text, unit)
      if (parsed.problem || parsed.ml === null || !(parsed.ml > 0)) {
        problem ??= t('bottle.amountFor', { label: container.label })
        continue
      }
      const ml =
        row.planMl !== null && row.text === row.planText
          ? row.planMl
          : portionMl(Number(row.text.trim().replace(',', '.')), unit, container)
      // Never more than the container holds — shown here, refused by the
      // server too. Nothing is quietly cut down.
      if (ml > container.remaining_ml + 1e-9) {
        problem ??= t('bottle.notEnough', {
          label: container.label,
          amount: formatMilkOz(container.remaining_ml),
        })
        continue
      }
      if (container.pending) containersPending = true
      portions.push({ container_id: container.id, amount_ml: ml })
    }
    const f = parseAmountMl(formula, unit)
    if (f.problem) problem ??= t('bottle.formulaNotNumber')
    const formulaMl = formula === formulaPlan.text ? formulaPlan.ml : (f.ml ?? 0)
    const breast = portions.reduce((sum, p) => sum + p.amount_ml, 0)
    const totalMl = breast + formulaMl
    if (!problem && !(totalMl > 0)) problem = t('bottle.empty')
    return { portions, formulaMl, totalMl, containersPending, problem }
  }, [rows, formula, formulaPlan, unit, usable, t])

  // Report up only when the value really changed. The page re-renders every
  // second (its clock) and hands down a fresh `usable` array each time; a new
  // but equal value must not set the page's state again, or the two would
  // keep re-rendering each other forever.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const sig = JSON.stringify(value)
    if (sig === reported.current) return
    reported.current = sig
    onChange(value)
  }, [value, onChange])

  function switchUnit(next: VolumeUnit) {
    if (next === unit) return
    const convert = (text: string) => {
      const parsed = parseAmountMl(text, unit)
      return parsed.ml == null ? text : amountText(parsed.ml, next)
    }
    // A field still showing the plan's amount keeps meaning the plan's EXACT
    // ml in the other unit too — switching back and forth changes nothing.
    setRows((rs) =>
      rs.map((r) => {
        const untouched = r.planMl !== null && r.text === r.planText
        if (!untouched) return { ...r, text: convert(r.text) }
        const text = amountText(r.planMl!, next)
        return { ...r, text, planText: text }
      }),
    )
    const formulaUntouched = formulaPlan.text !== null && formula === formulaPlan.text
    if (formulaUntouched) {
      const text = amountText(formulaPlan.ml, next)
      setFormula(text)
      setFormulaPlan({ ml: formulaPlan.ml, text })
    } else {
      setFormula(convert)
    }
    setUnit(next)
  }

  function addRow() {
    const used = new Set(rows.map((r) => r.containerId))
    const next = usable.find((c) => !used.has(c.id))
    setRows((rs) => [
      ...rs,
      { key: newId(), containerId: next?.id ?? '', text: '', planMl: null, planText: '' },
    ])
    setDirty(true)
  }

  function updateRow(key: string, change: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)))
    setDirty(true)
  }

  const unitName = t(`unit.${unit}`)

  return (
    <div className="stack">
      {stale && (
        <p className="meta">
          {t('bottle.planChanged')}{' '}
          <button type="button" className="linkish" onClick={() => startOver(plan)}>
            {t('bottle.startOver')}
          </button>
        </p>
      )}
      {rows.length === 0 && usable.length === 0 && <p className="meta">{t('bottle.noMilk')}</p>}
      {rows.map((row, i) => (
        <div key={row.key} className="row-tight row-wrap">
          <select
            className="input"
            value={row.containerId}
            disabled={disabled}
            aria-label={t('bottle.containerAria', { n: i + 1 })}
            onChange={(e) => updateRow(row.key, { containerId: e.target.value, planMl: null })}
          >
            <option value="">{t('bottle.chooseContainer')}</option>
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {t('bottle.containerOption', {
                  label: c.label,
                  amount: formatMilkOz(c.remaining_ml),
                })}
              </option>
            ))}
          </select>
          <input
            className="input narrow"
            value={row.text}
            disabled={disabled}
            inputMode="decimal"
            placeholder={unitName}
            aria-label={t('bottle.amountAria', { n: i + 1, unit: unitName })}
            onChange={(e) => updateRow(row.key, { text: e.target.value })}
          />
          <button
            type="button"
            className="linkish"
            disabled={disabled}
            onClick={() => {
              setRows((rs) => rs.filter((r) => r.key !== row.key))
              setDirty(true)
            }}
          >
            {t('bottle.removeRow')}
          </button>
        </div>
      ))}
      {usable.length > rows.length && (
        <div>
          <button type="button" className="linkish" disabled={disabled} onClick={addRow}>
            {t('bottle.addRow')}
          </button>
        </div>
      )}
      <div className="row-tight row-wrap">
        <label className="label" htmlFor={`${idPrefix}-formula`}>
          {t('bottle.formula')}
        </label>
        <input
          id={`${idPrefix}-formula`}
          className="input narrow"
          value={formula}
          disabled={disabled}
          inputMode="decimal"
          placeholder={unitName}
          onChange={(e) => {
            setFormula(e.target.value)
            setDirty(true)
          }}
        />
        <AmountUnit value={unit} onChange={switchUnit} disabled={disabled} />
      </div>
      <div className="value" aria-live="polite">
        {t('bottle.total', { amount: formatMilkOz(value.totalMl) })}
      </div>
      {value.problem && <p className="meta">{value.problem}</p>}
    </div>
  )
}
