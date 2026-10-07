import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as P from '@/lib/milkParams'
import { ML_PER_FL_OZ } from '@/lib/format'

// U-P1 (docs/plan-pruebas-v5.md §1): las constantes clínicas de v5, con nombre,
// sus valores por defecto (spec §4, todas "a confirmar") y el espejo con las
// funciones SQL de 0016, leídas del texto de la migración.

const sql = readFileSync(
  join(__dirname, '..', '..', 'supabase', 'migrations', '0016_milk_phase3_4.sql'),
  'utf8',
)

/** El literal que devuelve `create or replace function <name>() … select <n>`. */
function sqlConstant(name: string): number {
  const m = new RegExp(
    `function\\s+${name}\\(\\)[\\s\\S]*?\\$\\$\\s*select\\s+([0-9.]+)\\s*\\$\\$`,
  ).exec(sql)
  if (!m) throw new Error(`${name}() not found in 0016`)
  return Number(m[1])
}

describe('U-P1 milkParams — valores por defecto', () => {
  it('los doce valores del pedido', () => {
    expect(P.COOLING_MIN_MINUTES).toBe(60)
    expect(P.BOTTLE_STARTED_MAX_MIN).toBe(60)
    expect(P.FORMULA_OPEN_MAX_H).toBe(48)
    expect(P.FORMULA_OPEN_WARN_H).toBe(6)
    expect(P.FORMULA_LOW_WARN_OZ).toBe(8)
    expect(P.FORMULA_BOTTLE_OZ).toBe(8)
    expect(P.FORMULA_PACK_COUNT).toBe(6)
    expect(P.FORMULA_PACK_MAX).toBe(24)
    expect(P.RECIPE_TARGET_OZ).toBe(3.5)
    expect(P.RECIPE_CRY_EXTRA_OZ).toBe(1)
    expect(P.RECIPE_CRY_WINDOW_MIN).toBe(120)
    expect(P.FORMULA_PER_DAY_WINDOW_H).toBe(72)
  })

  it('los derivados en ms y ml salen de ellos', () => {
    expect(P.COOLING_MS).toBe(60 * 60_000)
    expect(P.BOTTLE_STARTED_MAX_MS).toBe(60 * 60_000)
    expect(P.FORMULA_OPEN_MAX_MS).toBe(48 * 3_600_000)
    expect(P.FORMULA_OPEN_WARN_MS).toBe(6 * 3_600_000)
    expect(P.FORMULA_PER_DAY_WINDOW_MS).toBe(72 * 3_600_000)
    expect(P.RECIPE_CRY_WINDOW_MS).toBe(120 * 60_000)
    expect(P.FORMULA_BOTTLE_ML).toBe(8 * ML_PER_FL_OZ)
    expect(P.FORMULA_LOW_WARN_ML).toBe(8 * ML_PER_FL_OZ)
    expect(P.RECIPE_TARGET_ML).toBe(3.5 * ML_PER_FL_OZ)
    expect(P.RECIPE_CRY_EXTRA_ML).toBe(ML_PER_FL_OZ)
  })

  it('cada constante lleva su "Decisión a confirmar" en el archivo', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'lib', 'milkParams.ts'), 'utf8')
    const names = [...text.matchAll(/export const ([A-Z_]+) = \d/g)].map((m) => m[1])
    expect(names).toHaveLength(12)
    for (const name of names) {
      const before = text.slice(0, text.indexOf(`export const ${name} =`))
      const comment = before.slice(before.lastIndexOf('\n\n'))
      expect(comment, name).toMatch(/Decisión a confirmar \(papá\/pediatra\)/)
    }
  })
})

describe('U-P1 milkParams — espejo de 0016', () => {
  it('milk_cooling_minutes() = COOLING_MIN_MINUTES', () => {
    expect(sqlConstant('milk_cooling_minutes')).toBe(P.COOLING_MIN_MINUTES)
  })
  it('milk_started_bottle_minutes() = BOTTLE_STARTED_MAX_MIN', () => {
    expect(sqlConstant('milk_started_bottle_minutes')).toBe(P.BOTTLE_STARTED_MAX_MIN)
  })
  it('formula_open_max_hours() = FORMULA_OPEN_MAX_H', () => {
    expect(sqlConstant('formula_open_max_hours')).toBe(P.FORMULA_OPEN_MAX_H)
  })
  it('formula_bottle_ml() = FORMULA_BOTTLE_OZ en ml (misma botella al centésimo de oz)', () => {
    const ml = sqlConstant('formula_bottle_ml')
    // La base usa la onza US exacta (29.5735295625); la app, 29.5735.
    expect(Math.abs(ml - P.FORMULA_BOTTLE_ML)).toBeLessThan(0.001)
    expect((ml / ML_PER_FL_OZ).toFixed(2)).toBe(P.FORMULA_BOTTLE_OZ.toFixed(2))
  })
  it('formula_add acepta de 1 a FORMULA_PACK_MAX botellas', () => {
    const body = sql.slice(
      sql.indexOf('function formula_add('),
      sql.indexOf('function formula_open('),
    )
    expect(body).toMatch(new RegExp(`v_n < 1 or v_n > ${P.FORMULA_PACK_MAX}\\b`))
  })
  it('milk_is_cold usa milk_cooling_minutes() desde coalesce(fridge_at, stored_at)', () => {
    expect(sql).toMatch(
      /coalesce\(c\.fridge_at, c\.stored_at\) \+ milk_cooling_minutes\(\) \* interval '1 minute' <= t/,
    )
  })
})
