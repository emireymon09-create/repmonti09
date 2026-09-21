'use client'

import type { GrowthInput } from '@/lib/format'
import { useT } from '@/lib/i18n/react'

type Field = 'lb' | 'oz' | 'inches' | 'kg' | 'cm'

/**
 * The weight/height inputs, in whichever units are showing. Shared by "new
 * measurement" and "edit measurement" on /growth so the two can't drift.
 */
export function GrowthFields({
  value,
  onChange,
}: {
  value: GrowthInput
  onChange: (next: GrowthInput) => void
}) {
  const { t } = useT()
  const input = (field: Field, placeholder: string, label: string) => (
    <input
      className="input"
      value={value[field]}
      onChange={(e) => onChange({ ...value, [field]: e.target.value })}
      inputMode="decimal"
      placeholder={placeholder}
      aria-label={label}
    />
  )

  return value.imperial ? (
    <div className="row">
      {input('lb', 'lb', t('growth.weightLb'))}
      {input('oz', 'oz', t('growth.weightOz'))}
      {input('inches', 'in', t('growth.heightIn'))}
    </div>
  ) : (
    <div className="row">
      {input('kg', 'kg', t('growth.weightKg'))}
      {input('cm', 'cm', t('growth.heightCm'))}
    </div>
  )
}

export function UnitToggle({
  value,
  onChange,
}: {
  value: GrowthInput
  onChange: (next: GrowthInput) => void
}) {
  return (
    <button
      type="button"
      className="linkish"
      onClick={() => onChange({ ...value, imperial: !value.imperial })}
    >
      {value.imperial ? 'lb / in' : 'kg / cm'}
    </button>
  )
}
