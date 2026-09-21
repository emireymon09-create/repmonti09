'use client'

import type { GrowthInput } from '@/lib/format'

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
      {input('lb', 'lb', 'Weight, pounds')}
      {input('oz', 'oz', 'Weight, ounces')}
      {input('inches', 'in', 'Height, inches')}
    </div>
  ) : (
    <div className="row">
      {input('kg', 'kg', 'Weight, kilograms')}
      {input('cm', 'cm', 'Height, centimetres')}
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
