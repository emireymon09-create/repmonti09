import { beforeAll, describe, expect, it } from 'vitest'
import { assertEnglishLocale, SYSTEM_TZ } from '../helpers/locale'
import {
  ageFrom,
  apptWhen,
  clockTime,
  cmToIn,
  DISPLAY_UNIT,
  durationBetween,
  dueRelative,
  elapsed,
  emptyGrowthInput,
  flOzToMl,
  formatVolume,
  fromHouseholdInputValue,
  type GrowthInput,
  growthInputFromMetric,
  growthInputToMetric,
  householdToday,
  HOUSEHOLD_TZ,
  kgToLbOz,
  kgToLbOzParts,
  lbOzToKg,
  longDate,
  measuredOn,
  ML_PER_FL_OZ,
  mlToFlOz,
  mlToUnit,
  resolveGrowthEdit,
  startOfHouseholdDay,
  timeAgo,
  toHouseholdInputValue,
  unitToMl,
} from '@/lib/format'

beforeAll(() => {
  assertEnglishLocale()
})

/**
 * El contrato de todo este archivo: NINGUNA aserción depende de SYSTEM_TZ.
 * La casa se lee en America/Los_Angeles mire quien mire — por eso la suite
 * corre cuatro veces (scripts/test-tz.sh) y tiene que dar lo mismo siempre.
 */
describe(`bajo TZ=${SYSTEM_TZ}`, () => {
  it('la TZ del hogar no cambia con la del sistema', () => {
    expect(HOUSEHOLD_TZ).toBe('America/Los_Angeles')
  })

  // ---------------------------------------------------------------- reloj

  it('clockTime muestra hora del hogar, no la del visitante', () => {
    // 2026-01-15T16:00Z = 8:00 AM PST
    expect(clockTime('2026-01-15T16:00:00Z')).toBe('8:00 AM')
    // 2026-07-15T16:00Z = 9:00 AM PDT
    expect(clockTime('2026-07-15T16:00:00Z')).toBe('9:00 AM')
  })

  it('clockTime devuelve em dash sin valor', () => {
    expect(clockTime(null)).toBe('—')
    expect(clockTime(undefined)).toBe('—')
  })

  it('longDate y apptWhen se leen en la TZ del hogar', () => {
    // 2026-01-16T03:00Z es todavía el 15 en Los Angeles.
    expect(longDate('2026-01-16T03:00:00Z')).toBe('Thursday, January 15')
    expect(apptWhen('2026-01-16T03:00:00Z')).toBe('Thu, Jan 15, 7:00 PM')
  })

  it('measuredOn no corre la fecha de una columna date', () => {
    expect(measuredOn('2026-01-15')).toBe('January 15, 2026')
    expect(measuredOn('2026-12-31')).toBe('December 31, 2026')
  })

  // ------------------------------------------------------------- relativo

  it('timeAgo: relativo adentro del día', () => {
    const now = Date.parse('2026-01-15T16:00:00Z')
    expect(timeAgo('2026-01-15T15:59:30Z', now)).toBe('just now')
    expect(timeAgo('2026-01-15T15:18:00Z', now)).toBe('42m ago')
    expect(timeAgo('2026-01-15T12:50:00Z', now)).toBe('3h 10m ago')
    expect(timeAgo('2026-01-15T13:00:00Z', now)).toBe('3h ago')
    expect(timeAgo(null, now)).toBe('never')
  })

  it('timeAgo: absoluto pasado el día', () => {
    const now = Date.parse('2026-01-15T16:00:00Z')
    // 2 días antes: nombre del día, hora del hogar.
    expect(timeAgo('2026-01-13T22:14:00Z', now)).toBe('Tue 2:14 PM')
    // Más de una semana: fecha.
    expect(timeAgo('2026-01-01T22:14:00Z', now)).toBe('Jan 1, 2:14 PM')
  })

  it('elapsed y durationBetween', () => {
    const start = '2026-01-15T16:00:00Z'
    expect(elapsed(start, Date.parse('2026-01-15T16:07:42Z'))).toBe('7:42')
    expect(elapsed(start, Date.parse('2026-01-15T17:07:42Z'))).toBe('1:07:42')
    expect(elapsed(start, Date.parse('2026-01-15T15:59:00Z'))).toBe('0:00')

    // durationBetween redondea (no trunca): el umbral real de "under a
    // minute" son 30 segundos, no 60. Verificado contra la implementación,
    // no asumido — 30s exactos ya se leen como "1 min".
    expect(durationBetween(start, '2026-01-15T16:00:29Z')).toBe('under a minute')
    expect(durationBetween(start, '2026-01-15T16:00:30Z')).toBe('1 min')
    expect(durationBetween(start, '2026-01-15T16:24:00Z')).toBe('24 min')
    expect(durationBetween(start, '2026-01-15T18:15:00Z')).toBe('2h 15m')
    expect(durationBetween(start, '2026-01-15T18:00:00Z')).toBe('2h')
  })

  it('dueRelative es signado', () => {
    const now = Date.parse('2026-01-15T16:00:00Z')
    expect(dueRelative(null, now)).toBeNull()
    expect(dueRelative('2026-01-15T16:00:20Z', now)).toBe('due now')
    expect(dueRelative('2026-01-15T16:45:00Z', now)).toBe('due in 45m')
    expect(dueRelative('2026-01-15T15:50:00Z', now)).toBe('10m overdue')
    expect(dueRelative('2026-01-15T18:30:00Z', now)).toBe('due in 2h 30m')
  })

  // ------------------------------------------------------------------ DST

  it('fromHouseholdInputValue resuelve el horario de verano', () => {
    // PST (UTC-8): 8:00 del hogar = 16:00Z
    expect(fromHouseholdInputValue('2026-01-15T08:00')).toBe('2026-01-15T16:00:00.000Z')
    // PDT (UTC-7): 8:00 del hogar = 15:00Z
    expect(fromHouseholdInputValue('2026-07-15T08:00')).toBe('2026-07-15T15:00:00.000Z')
    // El día del salto (8 mar 2026, 02:00 local): 03:00 local ya es PDT.
    // La resolución en dos pasos es lo que lo pone del lado correcto.
    expect(fromHouseholdInputValue('2026-03-08T03:00')).toBe('2026-03-08T10:00:00.000Z')
  })

  it('fromHouseholdInputValue no explota con basura', () => {
    const out = fromHouseholdInputValue('no es una fecha')
    expect(() => new Date(out).toISOString()).not.toThrow()
  })

  it('toHouseholdInputValue y householdToday dan hora de pared del hogar', () => {
    expect(toHouseholdInputValue(new Date('2026-01-15T16:30:00Z'))).toBe('2026-01-15T08:30')
    // 03:00Z del 16 es todavía el 15 en la casa.
    expect(householdToday(new Date('2026-01-16T03:00:00Z'))).toBe('2026-01-15')
    expect(householdToday(new Date('2026-01-16T09:00:00Z'))).toBe('2026-01-16')
  })

  it('startOfHouseholdDay es medianoche del hogar', () => {
    const start = startOfHouseholdDay(new Date('2026-01-15T16:00:00Z'))
    expect(new Date(start).toISOString()).toBe('2026-01-15T08:00:00.000Z')
  })

  // ------------------------------------------------------------- unidades

  it('kg/lb redondea sin inventar 16 oz', () => {
    expect(kgToLbOz(3.5)).toBe('7 lb 11 oz')
    // 3.62873 kg = 8.0000 lb exactas: no puede salir "7 lb 16 oz".
    expect(kgToLbOz(3.62873)).toBe('8 lb 0 oz')
    expect(lbOzToKg(8, 0)).toBeCloseTo(3.62873, 4)
  })

  it('cm/in y ml/oz', () => {
    expect(cmToIn(50.8)).toBe('20.0 in')
    expect(mlToFlOz(147.8675)).toBe('5.0 oz')
    expect(flOzToMl(5)).toBeCloseTo(147.8675, 4)
  })

  it('oz ↔ ml ida y vuelta con cantidades reales de biberón (2–8 oz)', () => {
    // La base guarda ml; la app muestra oz (DISPLAY_UNIT). Lo que tiene que
    // aguantar es el viaje completo: se tipea en una unidad, se guarda en ml,
    // se vuelve a mostrar.
    for (const oz of [2, 2.5, 3, 4, 4.5, 5, 6, 7, 8]) {
      const ml = unitToMl(oz, 'oz')
      expect(mlToUnit(ml, 'oz')).toBe(oz)
      expect(formatVolume(ml, 'oz')).toBe(`${oz.toFixed(1)} oz`)
    }
    // Y al revés: tipeado en ml, guardado tal cual, mostrado en oz.
    for (const ml of [60, 90, 120, 150, 180, 240]) {
      expect(unitToMl(ml, 'ml')).toBe(ml)
      expect(formatVolume(ml, 'oz')).toBe(`${(ml / ML_PER_FL_OZ).toFixed(1)} oz`)
    }
    // 4 oz tipeadas y 118 ml tipeados son la misma toma con un decimal.
    expect(formatVolume(unitToMl(4, 'oz'), 'oz')).toBe('4.0 oz')
    expect(formatVolume(unitToMl(118, 'ml'), 'oz')).toBe('4.0 oz')
  })

  it('DISPLAY_UNIT es onzas: la app no pregunta más la unidad', () => {
    expect(DISPLAY_UNIT).toBe('oz')
  })

  it('formatVolume respeta la unidad elegida y guarda en ml', () => {
    expect(formatVolume(120, 'ml')).toBe('120 ml')
    expect(formatVolume(120, 'oz')).toBe('4.1 oz')
    expect(mlToUnit(120, 'ml')).toBe(120)
    expect(mlToUnit(120, 'oz')).toBe(4.1)
    expect(unitToMl(4, 'oz')).toBeCloseTo(118.294, 3)
    expect(unitToMl(120, 'ml')).toBe(120)
  })

  // ----------------------------------------------------------------- edad

  it('ageFrom cuenta días del hogar', () => {
    const now = new Date('2026-01-16T03:00:00Z') // 15 ene, 7 PM en la casa
    expect(ageFrom('2026-01-15', now)).toBe('0 days old')
    expect(ageFrom('2026-01-14', now)).toBe('1 day old')
    expect(ageFrom('2026-01-02', now)).toBe('13 days old')
    expect(ageFrom('2026-01-01', now)).toBe('2 weeks old')
    expect(ageFrom('2025-10-15', now)).toBe('3 months old')
    expect(ageFrom('2026-02-01', now)).toBeNull() // todavía no nació
    expect(ageFrom(null, now)).toBeNull()
  })

  describe('growth form ↔ metric', () => {
    const imperial = (p: Partial<GrowthInput>): GrowthInput => ({ ...emptyGrowthInput(true), ...p })
    const metric = (p: Partial<GrowthInput>): GrowthInput => ({ ...emptyGrowthInput(false), ...p })

    it('kgToLbOzParts redondea igual que kgToLbOz', () => {
      expect(kgToLbOzParts(3.5)).toEqual({ lb: 7, oz: 11 })
      expect(kgToLbOzParts(3.62873)).toEqual({ lb: 8, oz: 0 })
    })

    it('lb/oz/in a kg/cm, con el redondeo que guarda la base', () => {
      expect(growthInputToMetric(imperial({ lb: '8', oz: '0', inches: '20' }))).toEqual({
        weightKg: 3.629,
        heightCm: 50.8,
      })
    })

    it('solo onzas cuenta como peso', () => {
      expect(growthInputToMetric(imperial({ oz: '8' }))).toEqual({
        weightKg: 0.227,
        heightCm: null,
      })
    })

    it('kg/cm pasan tal cual', () => {
      expect(growthInputToMetric(metric({ kg: '3.5', cm: '50' }))).toEqual({
        weightKg: 3.5,
        heightCm: 50,
      })
    })

    it('texto que no es número es un error, no un cero', () => {
      expect(growthInputToMetric(imperial({ lb: 'ocho' }))).toEqual({
        error: 'Weight and height have to be numbers.',
      })
    })

    it('nada cargado es un error', () => {
      expect(growthInputToMetric(imperial({}))).toEqual({
        error: 'Enter a weight, a height, or both.',
      })
    })

    it('growthInputFromMetric llena las dos unidades', () => {
      expect(growthInputFromMetric(3.5, 50, true)).toEqual({
        imperial: true,
        lb: '7',
        oz: '11',
        inches: '19.7',
        kg: '3.5',
        cm: '50',
      })
      expect(growthInputFromMetric(null, null, false)).toEqual(emptyGrowthInput(false))
    })

    it('editar solo otra cosa no le cambia el peso por redondeo de onzas', () => {
      const original = { weightKg: 3.5, heightCm: 50 }
      const base = growthInputFromMetric(3.5, 50, true)
      // 7 lb 11 oz reconvertido serían 3.487 kg: eso NO tiene que pasar.
      expect(resolveGrowthEdit(base, { ...base }, original)).toEqual(original)
    })

    it('editar el peso sí lo recalcula; la talla intacta queda exacta', () => {
      const base = growthInputFromMetric(3.5, 50, true)
      expect(
        resolveGrowthEdit(base, { ...base, lb: '8', oz: '0' }, { weightKg: 3.5, heightCm: 50 }),
      ).toEqual({ weightKg: 3.629, heightCm: 50 })
    })

    it('pasar a kg/cm sin tocar nada tampoco cambia nada', () => {
      const base = growthInputFromMetric(3.5, 50, true)
      expect(
        resolveGrowthEdit(base, { ...base, imperial: false }, { weightKg: 3.5, heightCm: 50 }),
      ).toEqual({ weightKg: 3.5, heightCm: 50 })
    })

    it('borrar la talla la deja en null', () => {
      const base = growthInputFromMetric(3.5, 50, false)
      expect(resolveGrowthEdit(base, { ...base, cm: '' }, { weightKg: 3.5, heightCm: 50 })).toEqual(
        {
          weightKg: 3.5,
          heightCm: null,
        },
      )
    })
  })
})
