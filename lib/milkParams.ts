/**
 * Every clinical number of the milk inventory v5 (docs/spec-feeding-v5.md §4),
 * with a name, in one place.
 *
 * None of these is a medical fact: each is a default the family has not
 * confirmed yet (section F of the phase 1–2 report went unanswered). Changing
 * one is a decision, not a refactor — and where the database also knows the
 * number (0016's `milk_cooling_minutes()`, `milk_started_bottle_minutes()`,
 * `formula_open_max_hours()`, `formula_bottle_ml()`, the 1–24 of
 * `formula_add`), it takes a NEW migration too: tests/unit/milkParams.test.ts
 * reads 0016 and fails when the two drift apart.
 *
 * `EMPTY_ML` and `FUTURE_TOLERANCE_MS` are not here: they already live in
 * lib/milkBottles.ts (0015) and are not repeated.
 */

import { ML_PER_FL_OZ } from '@/lib/format'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

// ------------------------------------------------------------- cooling (V5-20…V5-23)

// Decisión a confirmar (papá/pediatra): 60 min fijos para que la leche recién
// extraída quede fría en el refri, sin escalar por cantidad (D5-4; papá dio
// rangos de 30 a 90). Espejo: milk_cooling_minutes() de 0016.
export const COOLING_MIN_MINUTES = 60

// ------------------------------------------------------------- started bottle (V5-10)

// Decisión a confirmar (papá/pediatra): lo que sobra de un biberón empezado
// sirve 60 min desde la hora de la toma (D5-9). Espejo:
// milk_started_bottle_minutes() de 0016.
export const BOTTLE_STARTED_MAX_MIN = 60

// ------------------------------------------------------------- formula (V5-01…V5-07)

// Decisión a confirmar (papá/pediatra): una Similac abierta dura 48 h desde
// "Abrí una Similac" (D5-12). Espejo: formula_open_max_hours() de 0016.
export const FORMULA_OPEN_MAX_H = 48

// Decisión a confirmar (papá/pediatra): el aviso "vence pronto" sale 6 h antes
// de las 48 h (D5-14).
export const FORMULA_OPEN_WARN_H = 6

// Decisión a confirmar (papá/pediatra): aviso de fórmula baja cuando queda
// 8 oz o menos en total — una botella (D5-14).
export const FORMULA_LOW_WARN_OZ = 8

// Decisión a confirmar (papá/pediatra): una botella de Similac trae 8 oz.
// Espejo: formula_bottle_ml() de 0016 (236.5882365 ml; acá con el
// ML_PER_FL_OZ de la app, 0.0002 ml menos — el test lo acota).
export const FORMULA_BOTTLE_OZ = 8

// Decisión a confirmar (papá/pediatra): "Anotar compra" propone un paquete de
// 6 botellas (D5-15).
export const FORMULA_PACK_COUNT = 6

// Decisión a confirmar (papá/pediatra): como mucho 24 botellas por compra
// (D5-15). Espejo: el `v_n > 24` de formula_add en 0016.
export const FORMULA_PACK_MAX = 24

// Decisión a confirmar (papá/pediatra): el consumo por día se promedia sobre
// las últimas 72 h (V5-04).
export const FORMULA_PER_DAY_WINDOW_H = 72

// ------------------------------------------------------------- recipe (V5-40…V5-44)

// Decisión a confirmar (papá/pediatra): una toma completa es 3.5 oz (D5-3,
// ejemplo de papá; no se guarda por familia todavía).
export const RECIPE_TARGET_OZ = 3.5

// Decisión a confirmar (papá/pediatra): "si llora" poco después de comer se
// le da 1 oz más (D5-2).
export const RECIPE_CRY_EXTRA_OZ = 1

// Decisión a confirmar (papá/pediatra): "poco después" = menos de 120 min
// desde el FIN de la última toma; con 120 min o más, toma completa (D5-2).
export const RECIPE_CRY_WINDOW_MIN = 120

// ------------------------------------------------------------- derived (ms / ml)

export const COOLING_MS = COOLING_MIN_MINUTES * MINUTE_MS
export const BOTTLE_STARTED_MAX_MS = BOTTLE_STARTED_MAX_MIN * MINUTE_MS
export const FORMULA_OPEN_MAX_MS = FORMULA_OPEN_MAX_H * HOUR_MS
export const FORMULA_OPEN_WARN_MS = FORMULA_OPEN_WARN_H * HOUR_MS
export const FORMULA_PER_DAY_WINDOW_MS = FORMULA_PER_DAY_WINDOW_H * HOUR_MS
export const RECIPE_CRY_WINDOW_MS = RECIPE_CRY_WINDOW_MIN * MINUTE_MS

export const FORMULA_BOTTLE_ML = FORMULA_BOTTLE_OZ * ML_PER_FL_OZ
export const FORMULA_LOW_WARN_ML = FORMULA_LOW_WARN_OZ * ML_PER_FL_OZ
export const RECIPE_TARGET_ML = RECIPE_TARGET_OZ * ML_PER_FL_OZ
export const RECIPE_CRY_EXTRA_ML = RECIPE_CRY_EXTRA_OZ * ML_PER_FL_OZ
