# Amelia App — Plan de batch: pnpm, tests, docs y robustez

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar el repo con pnpm como único gestor, una suite de tests real
(unit + RLS multi-familia + el test que demuestra el hallazgo de
`/api/quick/nurse`), documentación local en `docs/` al estilo FRUCO pero
adaptada a este stack, `design.md` verificado y commiteado, y la app endurecida
en los puntos donde hoy está floja — sin tocar el schema y sin crear nada en la
nube.

**Architecture:** Nada de esto cambia la arquitectura de la app. Se agrega una
capa de verificación (Vitest + Supabase local en Docker) alrededor del código
que ya existe, se corrigen los endpoints de dispositivo y el guard de auth
dentro de los límites que ya están definidos en `CLAUDE.md`, y todo cambio de
schema se **propone** en `proposals/` en vez de migrarse acá (regla §5.2).

**Tech Stack:** TypeScript 5.5 strict · Next.js 14 App Router · React 18 ·
Supabase (PostgREST + Auth + RLS) · **pnpm** · **Vitest** · Supabase CLI local
sobre Docker.

**Spec:** este mismo archivo, §0 "Spec de origen". No hay documento de spec
separado: la spec es el pedido de Emilio del 20 sep 2026, transcrito abajo sin
reinterpretar.

---

## 0. Spec de origen

1. **Migrar de npm a pnpm** — regla dura, nunca más npm. Lockfile commiteado.
   Actualizar `package.json`, scripts, README y CLAUDE.md. Borrar cualquier
   vestigio de `package-lock.json`.
2. **Documentación local en `docs/`** tomando como referencia la doc de FRUCO en
   Notion, trayendo **solo lo que aplica** a este stack (sin Prisma, sin
   Express, sin multi-empresa: acá es multi-familia por RLS). Cuatro páginas:
   `manual-buenas-practicas.md`, `checklist-cada-cambio.md`,
   `prompt-auditoria-codigo.md`, `seguridad-operacional.md`.
3. **`design.md`** — completar/revisar contra el código real.
4. **Tests** — runner + unit tests de `lib/format.ts` (cerrando la mentira de
   "unit-tested under four system timezones"), tests de RLS/multi-familia, y el
   test que demuestra el riesgo de `/api/quick/nurse`.
5. **Robustez** — secretos de dispositivo sin rate limiting ni idempotencia,
   falta de middleware de auth server-side, `@types/react-dom` faltante, README
   desactualizado, y cualquier otro hallazgo.

**Restricciones duras:** no crear repo en GitHub (ya existe,
`emireymon09-create/repmonti09`), no crear proyecto Supabase en la nube, no
tocar `~/proyectos/fruco-erp`.

---

## Global Constraints

Estas valen para **todas** las tareas. Salen de `CLAUDE.md` y de `PROJECT.md`,
verificadas contra el código el 20 sep 2026.

- **pnpm y solo pnpm** a partir de la Tarea 1. Ningún comando `npm` / `yarn` en
  código, docs, scripts o mensajes de commit.
- **Ninguna migración numerada nueva** en `supabase/migrations/`. Los archivos
  `0001`…`0006` son historia y no se editan. Todo cambio de schema se escribe
  como **propuesta** en `proposals/` (CLAUDE.md §5.2, ADR 0003).
- **Ninguna query fuera de `lib/db.ts`** para código de página/cliente. Los
  route handlers (`app/api/*`) son la excepción que ya existe y no se amplía.
- **`lib/supabaseAdmin.ts` nunca entra a un archivo `'use client'`.**
- **Ningún hex ni px nuevo fuera de `app/globals.css`** (design.md §1).
- **Ningún secreto con prefijo `NEXT_PUBLIC_`.**
- **Nada se presenta como guardado si no lo está** (CLAUDE.md §5.5).
- **Commits:** frase imperativa en inglés, una línea, sin prefijo
  `feat:`/`fix:`/`chore:`, describiendo el efecto para quien usa la app. Se
  acepta `Fix:` informal para un arreglo puro. Cada commit cierra con:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Definition of done de cada tarea** (CLAUDE.md §8): `pnpm exec tsc --noEmit`
  pasa, `pnpm build` pasa, y si la tarea toca datos, se probó contra el Supabase
  local — no solo se leyó.
- **Timezone del hogar:** `America/Los_Angeles`. DB en UTC. Volúmenes en ml,
  peso/talla en kg/cm.
- **Si algo queda sin verificar, se dice explícitamente.** No se rellena con
  suposiciones.

---

## Estado verificado del repo (20 sep 2026)

Todo lo de abajo se leyó, no se asumió:

| Hecho | Verificación |
|---|---|
| No hay lockfile de ningún tipo | `ls` en la raíz |
| No hay `node_modules/` | `ls` |
| pnpm 11.7.0 y corepack 0.35.0 ya instalados | `pnpm -v`, `corepack --version` |
| Node v24.16.0, npm 11.13.0 | `node -v` |
| Docker 29.5.3 corriendo (2 contenedores de fruco-erp en 5432/6379) | `docker ps` |
| Supabase CLI **no** instalado | `which supabase` → not found |
| `@types/react-dom` ausente de devDependencies | `cat package.json` |
| Cero tests en el repo | `grep -rn test --include=*.ts` |
| `PROJECT.md:135` afirma "Unit-tested under four system timezones" | falso |
| `PROJECT.md:166-177` dice que editar/retractar no está construido | falso: existe desde `0006` + `lib/db.ts` |
| README dice que sueño/growth/PWA/cola offline no están construidos | falso |
| README manda `npm install -g supabase` y `cp .env.local.dev .env.local` | `.env.local.dev` no existe; el que existe es `.env.local.example` |
| `design.md` existe, 11 KB, sin commitear | `git status` |
| 6 migraciones, 11 tablas, RLS en todas | `supabase/migrations/` |
| `/api/quick/nurse` toma el `babies` más antiguo **de toda la base** con service_role | `app/api/quick/nurse/route.ts:41-46` |
| `/api/ingest` acepta cualquier `baby_id` con un secreto compartido estático | `app/api/ingest/route.ts:19-30` |
| El guard de auth es client-side (`lib/useBaby.ts`), no hay `middleware.ts` | `find` |
| `growth_measurements` no tiene policy de UPDATE ni columna `voided_at` | `0001`, `0006` |
| `families` / `family_members` no tienen policy de INSERT | `0001` |

---

## File Structure

**Se crean:**

```
.npmrc                                  Config de pnpm (shamefully-hoist off, engine-strict)
scripts/only-pnpm.mjs                   Guard de preinstall: aborta si el gestor no es pnpm
pnpm-lock.yaml                          Lockfile (commiteado)
vitest.config.ts                        Runner: alias @/, include tests/**
tests/unit/format.test.ts               Unit tests de lib/format.ts (corren bajo 4 TZ)
tests/unit/queue.test.ts                Unit tests de flushQueue/looksOffline
tests/helpers/locale.ts                 Guard de locale/TZ determinista
tests/helpers/supabase.ts               Seeding de 2 familias + clientes autenticados
tests/integration/rls.test.ts           Aislamiento entre familias
tests/integration/quick-nurse.test.ts   Demuestra el hallazgo de /api/quick/nurse
tests/integration/ingest.test.ts        Demuestra el cross-family de /api/ingest
middleware.ts                           Guard de auth server-side
lib/deviceAuth.ts                       Comparación timing-safe + rate limit en memoria
docs/README.md                          Índice de la doc local
docs/manual-buenas-practicas.md
docs/checklist-cada-cambio.md
docs/prompt-auditoria-codigo.md
docs/seguridad-operacional.md
docs/auditorias/2026-09-20-auditoria-inicial.md   Primera corrida del prompt
proposals/device-tokens-and-idempotency.md        Propuesta de schema (ADR 0005)
proposals/growth-edit-and-void.md                 Propuesta de schema
```

**Se modifican:**

```
package.json          packageManager, scripts de test, @types/react-dom, supabase CLI devDep
.gitignore            .env.test, supabase/.temp ya está
next.config.mjs       headers de seguridad
app/api/ingest/route.ts        validación + timing-safe + rate limit
app/api/quick/nurse/route.ts   validación + timing-safe + rate limit + scoping
README.md             reescrito contra la realidad, con pnpm
PROJECT.md            corregidas las afirmaciones falsas
CLAUDE.md             §2 stack (pnpm, vitest), §3 comandos, §5.1, §6 estado, §8 checklist
design.md             auditado contra el código y commiteado
```

**No se tocan:** `supabase/migrations/*`, `supabase/schema.sql`, `lib/db.ts`
(salvo que un test descubra un bug real), `app/globals.css`, `lib/tokens.ts`,
`components/*`, `public/sw.js`.

---

## Orden y por qué

1. **pnpm primero** — todo lo demás instala dependencias; hacerlo después
   obligaría a regenerar el lockfile.
2. **Runner + unit tests** — no necesitan Docker, dan la red de seguridad más
   barata y cierran la mentira de PROJECT.md.
3. **Infra de integración → RLS → hallazgos de seguridad** — el seeding de dos
   familias es prerrequisito de los dos últimos.
4. **Auditoría** — se escribe con los tests ya corriendo, así cada hallazgo se
   reporta como confirmado o como no verificado, no como sospecha.
5. **Endurecimiento** — se aplica sobre hallazgos ya demostrados por un test.
6. **docs/** — recién acá, porque las cuatro páginas citan comandos
   (`pnpm test:all`) y hallazgos reales que antes no existían.
7. **design.md y sincronización de doc** — al final, cuando el estado del repo
   ya es el definitivo del batch.

---

## Task 1: Migrar el proyecto a pnpm

**Files:**
- Create: `.npmrc`, `scripts/only-pnpm.mjs`, `pnpm-lock.yaml`
- Modify: `package.json`
- Test: verificación manual (`pnpm install`, `pnpm exec tsc --noEmit`, `pnpm build`)

**Interfaces:**
- Consumes: nada.
- Produces: `pnpm` como único gestor; scripts `dev`/`build`/`start` intactos;
  `@types/react-dom` disponible para el type-check de las tareas siguientes.

- [ ] **Step 1: Confirmar que no hay vestigios de npm**

```bash
cd ~/proyectos/amelia_app
ls -la | grep -iE 'package-lock|yarn.lock|node_modules'
git ls-files | grep -iE 'package-lock|yarn.lock'
```

Esperado: sin salida en ambos. Si aparece `package-lock.json`, borrarlo con
`rm package-lock.json` y, si estuviera trackeado, `git rm --cached package-lock.json`.

- [ ] **Step 2: Fijar el gestor en `package.json`**

Agregar `packageManager` y `@types/react-dom`, y los scripts de test (los
scripts se crean acá aunque el runner llegue en la Tarea 2, para no volver a
tocar el archivo):

```json
{
  "name": "amelia-app",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@11.7.0",
  "scripts": {
    "preinstall": "node scripts/only-pnpm.mjs",
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "test": "vitest run tests/unit",
    "test:tz": "for tz in UTC America/Los_Angeles Asia/Tokyo Pacific/Kiritimati; do echo \"--- TZ=$tz ---\"; TZ=$tz LANG=en_US.UTF-8 vitest run tests/unit || exit 1; done",
    "test:integration": "vitest run tests/integration",
    "test:all": "pnpm test:tz && pnpm test:integration"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "@supabase/ssr": "^0.5.1",
    "next": "^14.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

Nota: `test:tz` usa `sh -c` a través de npm-scripts; si el shell del entorno no
lo acepta tal cual, moverlo a `scripts/test-tz.sh` y dejar el script como
`bash scripts/test-tz.sh`. Verificarlo al correrlo, no asumirlo.

- [ ] **Step 3: Escribir el guard de preinstall**

`scripts/only-pnpm.mjs` — sin dependencias externas, sin `npx` (que es npm):

```js
// Este repo usa pnpm y solo pnpm (CLAUDE.md §5.1). npm o yarn rompen el
// lockfile y dejan builds no reproducibles, que es justamente el hueco que
// esta migración cierra.
const ua = process.env.npm_config_user_agent ?? ''

if (!ua.startsWith('pnpm')) {
  console.error('\n  Este proyecto usa pnpm. Corré `pnpm install`.')
  console.error(`  Gestor detectado: ${ua || 'desconocido'}\n`)
  process.exit(1)
}
```

- [ ] **Step 4: Escribir `.npmrc`**

```
# pnpm estricto: nada de dependencias fantasma.
strict-peer-dependencies=false
auto-install-peers=true
```

(`strict-peer-dependencies=false` porque Next 14 + React 18 arrastran peers que
no vale la pena pelear hoy; si `pnpm install` sale limpio sin esa línea,
borrarla.)

- [ ] **Step 5: Instalar y generar el lockfile**

```bash
cd ~/proyectos/amelia_app
pnpm install
```

Esperado: crea `node_modules/` y `pnpm-lock.yaml`. Si Node 24 dispara warnings
de engine de Next 14, anotarlos textualmente en `output.txt` — no silenciarlos.

- [ ] **Step 6: Verificar que el proyecto sigue compilando**

```bash
pnpm exec tsc --noEmit
pnpm build
```

Esperado: ambos en verde. `tsc` debe pasar ahora que `@types/react-dom` existe.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml .npmrc scripts/only-pnpm.mjs
git commit -m "$(cat <<'EOF'
Pin the project to pnpm and commit a lockfile so builds are reproducible

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Runner de tests + unit tests de `lib/format.ts` bajo cuatro timezones

**Files:**
- Create: `vitest.config.ts`, `tests/helpers/locale.ts`, `tests/unit/format.test.ts`
- Modify: `package.json` (solo si el paso 1 de la Tarea 1 dejó algo pendiente)
- Test: `pnpm test:tz`

**Interfaces:**
- Consumes: pnpm de la Tarea 1.
- Produces: `pnpm test` (unit, rápido, sin Docker) y `pnpm test:tz` (los mismos
  tests bajo `UTC`, `America/Los_Angeles`, `Asia/Tokyo`, `Pacific/Kiritimati`).
  A partir de acá, la frase de `PROJECT.md:135` deja de ser mentira.

**Decisión técnica:** Vitest, no Jest. Razones: cero configuración de transform
para TS/ESM (Next 14 ya es ESM), arranque en milisegundos, y no arrastra Babel.
No se instala `@vitejs/plugin-react` porque no hay tests de componentes en este
batch — si se agregan después, es una línea.

**Riesgo conocido y cómo se maneja:** `lib/format.ts` llama a `toLocaleString`
con locale `[]` (el del sistema). Si el locale del entorno no es `en-*`, las
aserciones de string exacto fallan por una razón que no es un bug. Por eso
`tests/helpers/locale.ts` verifica el locale y falla con un mensaje claro, y los
scripts fijan `LANG=en_US.UTF-8`.

- [ ] **Step 1: Instalar Vitest**

```bash
pnpm add -D vitest@^2.1.0
```

- [ ] **Step 2: Escribir `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Las pruebas de integración escriben en una base compartida: sin
    // paralelismo entre archivos, o dos suites se pisan el seed.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
```

- [ ] **Step 3: Escribir el guard de locale**

`tests/helpers/locale.ts`:

```ts
/**
 * lib/format.ts formatea con el locale del sistema (`[]`). Un locale que no
 * sea en-* cambia el texto de salida y haría fallar los tests por una razón
 * que no es un bug del código. Se verifica una vez, con un mensaje que dice
 * exactamente qué hacer.
 */
export function assertEnglishLocale(): void {
  const locale = new Intl.DateTimeFormat().resolvedOptions().locale
  if (!locale.startsWith('en')) {
    throw new Error(
      `Estos tests asumen un locale en-* y el entorno resolvió "${locale}". ` +
      'Corré la suite con LANG=en_US.UTF-8.',
    )
  }
}

/** La TZ bajo la que corre esta ejecución — las cuatro pasadas la cambian. */
export const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
```

- [ ] **Step 4: Escribir el test que falla**

`tests/unit/format.test.ts`. El punto de todo el archivo: **ninguna aserción
depende de `SYSTEM_TZ`**. Ese es el contrato — la casa se lee en
`America/Los_Angeles` mire quien mire.

```ts
import { describe, expect, it, beforeAll } from 'vitest'
import { assertEnglishLocale, SYSTEM_TZ } from '../helpers/locale'
import {
  HOUSEHOLD_TZ, ageFrom, apptWhen, clockTime, cmToIn, durationBetween,
  dueRelative, elapsed, flOzToMl, formatVolume, fromHouseholdInputValue,
  householdToday, kgToLbOz, lbOzToKg, longDate, measuredOn, mlToFlOz,
  mlToUnit, startOfHouseholdDay, timeAgo, toHouseholdInputValue, unitToMl,
} from '@/lib/format'

beforeAll(() => { assertEnglishLocale() })

describe(`bajo TZ=${SYSTEM_TZ}`, () => {
  it('la TZ del hogar no cambia con la del sistema', () => {
    expect(HOUSEHOLD_TZ).toBe('America/Los_Angeles')
  })

  // ---------------------------------------------------------- reloj

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

  // ---------------------------------------------------------- relativo

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
    // 2 días antes: nombre del día, hora del hogar
    expect(timeAgo('2026-01-13T22:14:00Z', now)).toBe('Tue 2:14 PM')
    // Más de una semana: fecha
    expect(timeAgo('2026-01-01T22:14:00Z', now)).toBe('Jan 1, 2:14 PM')
  })

  it('elapsed y durationBetween', () => {
    const start = '2026-01-15T16:00:00Z'
    expect(elapsed(start, Date.parse('2026-01-15T16:07:42Z'))).toBe('7:42')
    expect(elapsed(start, Date.parse('2026-01-15T17:07:42Z'))).toBe('1:07:42')
    expect(elapsed(start, Date.parse('2026-01-15T15:59:00Z'))).toBe('0:00')

    expect(durationBetween(start, '2026-01-15T16:00:30Z')).toBe('under a minute')
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

  // ---------------------------------------------------------- DST

  it('fromHouseholdInputValue resuelve el horario de verano', () => {
    // PST (UTC-8): 8:00 del hogar = 16:00Z
    expect(fromHouseholdInputValue('2026-01-15T08:00'))
      .toBe('2026-01-15T16:00:00.000Z')
    // PDT (UTC-7): 8:00 del hogar = 15:00Z
    expect(fromHouseholdInputValue('2026-07-15T08:00'))
      .toBe('2026-07-15T15:00:00.000Z')
    // El día del salto (8 mar 2026, 02:00 local): 03:00 local ya es PDT.
    // La resolución en dos pasos es lo que lo pone del lado correcto.
    expect(fromHouseholdInputValue('2026-03-08T03:00'))
      .toBe('2026-03-08T10:00:00.000Z')
  })

  it('fromHouseholdInputValue no explota con basura', () => {
    const out = fromHouseholdInputValue('no es una fecha')
    expect(() => new Date(out).toISOString()).not.toThrow()
  })

  it('toHouseholdInputValue y householdToday dan hora de pared del hogar', () => {
    expect(toHouseholdInputValue(new Date('2026-01-15T16:30:00Z')))
      .toBe('2026-01-15T08:30')
    // 03:00Z del 16 es todavía el 15 en la casa.
    expect(householdToday(new Date('2026-01-16T03:00:00Z'))).toBe('2026-01-15')
    expect(householdToday(new Date('2026-01-16T09:00:00Z'))).toBe('2026-01-16')
  })

  it('startOfHouseholdDay es medianoche del hogar', () => {
    const start = startOfHouseholdDay(new Date('2026-01-15T16:00:00Z'))
    expect(new Date(start).toISOString()).toBe('2026-01-15T08:00:00.000Z')
  })

  // ---------------------------------------------------------- unidades

  it('kg/lb redondea sin inventar 16 oz', () => {
    expect(kgToLbOz(3.5)).toBe('7 lb 11 oz')
    // 3.62873 kg = 8.0000 lb exactas: no puede salir "7 lb 16 oz"
    expect(kgToLbOz(3.62873)).toBe('8 lb 0 oz')
    expect(lbOzToKg(8, 0)).toBeCloseTo(3.62873, 4)
  })

  it('cm/in y ml/oz', () => {
    expect(cmToIn(50.8)).toBe('20.0 in')
    expect(mlToFlOz(147.8675)).toBe('5.0 oz')
    expect(flOzToMl(5)).toBeCloseTo(147.8675, 4)
  })

  it('formatVolume respeta la unidad elegida y guarda en ml', () => {
    expect(formatVolume(120, 'ml')).toBe('120 ml')
    expect(formatVolume(120, 'oz')).toBe('4.1 oz')
    expect(mlToUnit(120, 'ml')).toBe(120)
    expect(mlToUnit(120, 'oz')).toBe(4.1)
    expect(unitToMl(4, 'oz')).toBeCloseTo(118.294, 3)
    expect(unitToMl(120, 'ml')).toBe(120)
  })

  // ---------------------------------------------------------- edad

  it('ageFrom cuenta días del hogar', () => {
    const now = new Date('2026-01-16T03:00:00Z')  // 15 ene, 7 PM en la casa
    expect(ageFrom('2026-01-15', now)).toBe('0 days old')
    expect(ageFrom('2026-01-14', now)).toBe('1 day old')
    expect(ageFrom('2026-01-02', now)).toBe('13 days old')
    expect(ageFrom('2026-01-01', now)).toBe('2 weeks old')
    expect(ageFrom('2025-10-15', now)).toBe('3 months old')
    expect(ageFrom('2026-02-01', now)).toBeNull()   // todavía no nació
    expect(ageFrom(null, now)).toBeNull()
  })
})
```

- [ ] **Step 5: Correr y ver el resultado real**

```bash
cd ~/proyectos/amelia_app
LANG=en_US.UTF-8 pnpm test
```

Cada aserción de string exacto de arriba se derivó leyendo la implementación,
pero **el formato de `toLocaleString` lo define ICU, no el código**. Si alguna
falla por un espacio angosto (` ` antes de AM/PM en ICU nuevo) o por el
orden de los campos, **la aserción se corrige al valor real observado**, no el
código de `lib/format.ts` — salvo que el valor observado sea incorrecto de
verdad, en cuyo caso es un bug y se reporta antes de tocar nada.

- [ ] **Step 6: Correr bajo las cuatro timezones**

```bash
pnpm test:tz
```

Esperado: las cuatro pasadas (`UTC`, `America/Los_Angeles`, `Asia/Tokyo`,
`Pacific/Kiritimati`) en verde y con el mismo número de tests. Si una falla,
**es un bug real de `lib/format.ts`** y se reporta antes de corregir.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts tests/ package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
Prove that times and units read the same from any device timezone

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Unit tests de la cola offline

**Files:**
- Create: `tests/unit/queue.test.ts`
- Test: `pnpm test`

**Interfaces:**
- Consumes: el runner de la Tarea 2.
- Produces: cobertura de `flushQueue` y `looksOffline` — la lógica que decide
  si un tap de las 3 AM se pierde o no.

- [ ] **Step 1: Escribir el test**

```ts
import { describe, expect, it } from 'vitest'
import { flushQueue, looksOffline, newId, type PendingOp, type PendingWrite, type QueueStore } from '@/lib/queue'

function store(initial: PendingWrite[]): QueueStore & { rows: PendingWrite[] } {
  const rows = [...initial]
  return {
    rows,
    async all() { return [...rows] },
    async add(w) { rows.push(w) },
    async remove(id) {
      const i = rows.findIndex((r) => r.id === id)
      if (i >= 0) rows.splice(i, 1)
    },
  }
}

function write(id: string, queuedAt: string, op: PendingOp, schema = 'public'): PendingWrite {
  return { id, schema, label: id, queuedAt, op }
}

const insert: PendingOp = { kind: 'insert', table: 'feedings', row: { id: 'a' } }
const update: PendingOp = { kind: 'update', table: 'feedings', id: 'a', patch: { amount_ml: 90 } }

describe('flushQueue', () => {
  it('reenvía del más viejo al más nuevo', async () => {
    const s = store([
      write('2', '2026-01-15T10:05:00Z', update),
      write('1', '2026-01-15T10:00:00Z', insert),
    ])
    const seen: PendingOp[] = []
    const result = await flushQueue(s, 'public', async (op) => { seen.push(op); return { error: null } })

    expect(seen).toEqual([insert, update])
    expect(result).toEqual({ sent: 2, dropped: 0, remaining: 0, error: null })
    expect(s.rows).toHaveLength(0)
  })

  it('se detiene en el primer fallo y deja el resto en cola', async () => {
    const s = store([
      write('1', '2026-01-15T10:00:00Z', insert),
      write('2', '2026-01-15T10:05:00Z', update),
    ])
    const result = await flushQueue(s, 'public', async (op) =>
      op.kind === 'insert' ? { error: null } : { error: 'boom' })

    expect(result.sent).toBe(1)
    expect(result.error).toBe('boom')
    expect(s.rows.map((r) => r.id)).toEqual(['2'])
  })

  it('descarta lo escrito contra un schema que este build ya no usa', async () => {
    const s = store([write('viejo', '2026-01-15T10:00:00Z', insert, 'legacy')])
    const result = await flushQueue(s, 'public', async () => { throw new Error('no debería enviarse') })

    expect(result).toEqual({ sent: 0, dropped: 1, remaining: 0, error: null })
    expect(s.rows).toHaveLength(0)
  })
})

describe('looksOffline', () => {
  it('reconoce un request que nunca llegó', () => {
    expect(looksOffline('TypeError: Failed to fetch')).toBe(true)
    expect(looksOffline('NetworkError when attempting to fetch resource')).toBe(true)
    expect(looksOffline('Load failed')).toBe(true)
  })

  it('no encola un rechazo del servidor', () => {
    expect(looksOffline('new row violates row-level security policy')).toBe(false)
    expect(looksOffline(null)).toBe(false)
  })
})

describe('newId', () => {
  it('genera uuids distintos con forma de v4', () => {
    const a = newId()
    const b = newId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})
```

- [ ] **Step 2: Correr**

```bash
LANG=en_US.UTF-8 pnpm test
```

Esperado: verde. Nota sobre `remaining`: `flushQueue` lo calcula como
`pending.length - i - dropped`; el test de arriba lo ejercita solo en los casos
donde el valor es inequívoco. Si al correrlo el número no coincide con lo que
la UI necesita, **es un hallazgo** y va a la auditoría de la Tarea 7, no a un
arreglo silencioso.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/queue.test.ts
git commit -m "$(cat <<'EOF'
Prove a queued tap replays in order and never gets silently dropped

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Infraestructura de tests de integración contra el Supabase local

**Files:**
- Create: `tests/helpers/supabase.ts`, `scripts/test-env.sh`
- Modify: `package.json` (devDependency `supabase`), `.gitignore` (`.env.test`)
- Test: `pnpm test:integration` con un test de humo

**Interfaces:**
- Consumes: pnpm (Tarea 1), Vitest (Tarea 2).
- Produces:
  - `seedTwoFamilies()` → `{ familyA, familyB, cleanup }` con
    `{ family_id, user_id, baby_id, email, client }` por familia, donde
    `client` es un `SupabaseClient` con **anon key** y sesión iniciada.
  - `adminClient()` → `SupabaseClient` con service_role.
  - Variables `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
    en `process.env` al correr la suite.

**Decisión técnica:** Supabase CLI como **devDependency**, no global. Instalarlo
global con `npm i -g supabase` es lo que dice el README hoy y es doblemente
inválido: usa npm (prohibido desde la Tarea 1) y Supabase no soporta la
instalación global de ese paquete. Como devDependency, se invoca
`pnpm exec supabase …` y queda fijado por el lockfile.

**Decisión técnica:** los tests de RLS corren contra el stack completo
(`supabase start`: Postgres + GoTrue + PostgREST + Kong), no contra un Postgres
pelado con `SET ROLE`. Razón: lo que hay que demostrar es que **la app**, que
habla PostgREST con un JWT real, no ve datos de otra familia. Un `SET ROLE` en
SQL probaría la policy pero no el camino real, y el bug de `0005` (GRANT
faltante) es exactamente del tipo que solo aparece en el camino real.

- [ ] **Step 1: Instalar el CLI y levantar el stack**

```bash
cd ~/proyectos/amelia_app
pnpm add -D supabase
pnpm exec supabase start
```

Esperado: la primera corrida baja imágenes (varios minutos) y termina
imprimiendo `API URL`, `anon key` y `service_role key`. Si Docker se queda sin
recursos o algún puerto choca, **parar y reportarlo** — hay contenedores de
fruco-erp corriendo en 5432/6379, que no chocan con los 54321-54323 de Supabase,
pero eso se confirma mirando, no se asume.

- [ ] **Step 2: Escribir el script que exporta el entorno de test**

`scripts/test-env.sh`:

```bash
#!/usr/bin/env bash
# Escribe .env.test leyendo el estado REAL del stack local. Las llaves del
# Supabase local son de desarrollo y se regeneran con `supabase start`, pero
# .env.test igual va gitignored: un archivo con una service_role adentro no
# entra al repo, sea de la base que sea.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec supabase status -o env \
  | sed -e 's/^API_URL=/SUPABASE_URL=/' \
        -e 's/^ANON_KEY=/SUPABASE_ANON_KEY=/' \
        -e 's/^SERVICE_ROLE_KEY=/SUPABASE_SERVICE_ROLE_KEY=/' \
  > .env.test
echo "Escrito .env.test"
```

Verificar antes de confiar: `pnpm exec supabase status -o env` y mirar los
nombres reales de las variables. Si difieren, ajustar el `sed` a lo observado.

- [ ] **Step 3: Agregar `.env.test` al `.gitignore`**

```bash
printf '.env.test\n' >> .gitignore
```

- [ ] **Step 4: Escribir el helper de seeding**

`tests/helpers/supabase.ts`:

```ts
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** Carga .env.test si las variables no vienen ya del entorno. */
function loadEnv(): void {
  if (process.env.SUPABASE_URL) return
  let raw: string
  try {
    raw = readFileSync(new URL('../../.env.test', import.meta.url), 'utf8')
  } catch {
    throw new Error(
      'Falta .env.test. Levantá el stack con `pnpm exec supabase start` y ' +
      'corré `bash scripts/test-env.sh`.',
    )
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/)
    if (m) process.env[m[1]] ??= m[2]
  }
}

export function adminClient(): SupabaseClient {
  loadEnv()
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function anonClient(): SupabaseClient {
  loadEnv()
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export type SeededFamily = {
  familyId: string
  userId: string
  babyId: string
  email: string
  /** Cliente anon con sesión de este padre: el camino real de la app. */
  client: SupabaseClient
}

/**
 * Dos familias completas, cada una con su padre, su bebé y datos propios.
 *
 * La familia A se siembra PRIMERO a propósito: /api/quick/nurse toma el
 * `babies` más antiguo de toda la base, así que "A primero" es lo que hace
 * visible el cruce entre familias.
 */
export async function seedTwoFamilies(tag: string): Promise<{
  a: SeededFamily
  b: SeededFamily
  cleanup: () => Promise<void>
}> {
  const admin = adminClient()

  async function seedOne(name: string): Promise<SeededFamily> {
    const email = `${tag}-${name}@amelia.test`.toLowerCase()
    const password = 'test-password-1234'

    const { data: created, error: userErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    })
    if (userErr) throw userErr
    const userId = created.user!.id

    const { data: fam, error: famErr } = await admin
      .from('families').insert({ name: `${tag}-${name}` }).select('id').single()
    if (famErr) throw famErr

    const { error: memErr } = await admin
      .from('family_members').insert({ family_id: fam.id, user_id: userId, role: 'parent' })
    if (memErr) throw memErr

    const { data: baby, error: babyErr } = await admin
      .from('babies')
      .insert({ family_id: fam.id, name: `Bebé ${name}`, birth_date: '2026-01-15' })
      .select('id').single()
    if (babyErr) throw babyErr

    const client = anonClient()
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
    if (signInErr) throw signInErr

    return { familyId: fam.id, userId, babyId: baby.id, email, client }
  }

  const a = await seedOne('a')
  const b = await seedOne('b')

  // Un dato propio por familia, para que "no ver lo del otro" signifique algo.
  for (const f of [a, b]) {
    const { error } = await admin.from('feedings').insert({
      baby_id: f.babyId, feeding_type: 'bottle', amount_ml: 90,
      fed_at: '2026-01-15T16:00:00Z', logged_by: f.userId,
    })
    if (error) throw error
  }

  async function cleanup() {
    // families borra en cascada babies → feedings/nursing/etc.
    await admin.from('families').delete().in('id', [a.familyId, b.familyId])
    await admin.auth.admin.deleteUser(a.userId)
    await admin.auth.admin.deleteUser(b.userId)
  }

  return { a, b, cleanup }
}
```

- [ ] **Step 5: Test de humo — el seeding funciona y el GRANT de `0005` sigue puesto**

`tests/integration/rls.test.ts` (primera mitad; la segunda llega en la Tarea 5):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedTwoFamilies, type SeededFamily } from '../helpers/supabase'

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>

beforeAll(async () => { ({ a, b, cleanup } = await seedTwoFamilies('rls')) })
afterAll(async () => { await cleanup() })

describe('la base responde por el camino real de la app', () => {
  it('un padre autenticado ve su propio bebé (regresión del GRANT de 0005)', async () => {
    const { data, error } = await a.client.from('babies').select('id, name')
    expect(error).toBeNull()
    expect(data?.map((r) => r.id)).toEqual([a.babyId])
  })
})
```

- [ ] **Step 6: Correr**

```bash
bash scripts/test-env.sh
pnpm test:integration
```

Esperado: verde. Si falla con "permission denied for table babies", el GRANT de
`0005` no está aplicado en la base local: correr `pnpm exec supabase db reset`.

- [ ] **Step 7: Commit**

```bash
git add tests/helpers/supabase.ts tests/integration/rls.test.ts scripts/test-env.sh package.json pnpm-lock.yaml .gitignore
git commit -m "$(cat <<'EOF'
Let the test suite talk to the local Supabase the same way the app does

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Tests de aislamiento entre familias (RLS)

**Files:**
- Modify: `tests/integration/rls.test.ts`
- Test: `pnpm test:integration`

**Interfaces:**
- Consumes: `seedTwoFamilies` de la Tarea 4.
- Produces: la garantía, ejecutable, de que una familia no ve ni toca datos de
  otra — el equivalente a la "Regla 5" de multi-tenancy de FRUCO, traducida a
  RLS por `family_id`.

- [ ] **Step 1: Agregar los casos al archivo**

```ts
describe('una familia no ve a la otra', () => {
  it('el select de feedings solo trae lo propio', async () => {
    const { data, error } = await a.client.from('feedings').select('id, baby_id')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].baby_id).toBe(a.babyId)
  })

  it('pedir explícitamente el bebé ajeno devuelve vacío, no error', async () => {
    const { data, error } = await a.client
      .from('feedings').select('id').eq('baby_id', b.babyId)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('no se puede insertar contra el bebé de otra familia', async () => {
    const { error } = await a.client.from('feedings').insert({
      baby_id: b.babyId, feeding_type: 'bottle', amount_ml: 60,
      fed_at: '2026-01-15T18:00:00Z',
    })
    expect(error).not.toBeNull()
    expect(error!.message.toLowerCase()).toContain('row-level security')
  })

  it('un update contra una fila ajena no afecta ninguna fila', async () => {
    const admin = (await import('../helpers/supabase')).adminClient()
    const { data: ajena } = await admin
      .from('feedings').select('id').eq('baby_id', b.babyId).single()

    const { data, error } = await a.client
      .from('feedings').update({ amount_ml: 999 }).eq('id', ajena!.id).select('id')
    expect(error).toBeNull()
    expect(data).toEqual([])

    // Y la fila de B sigue intacta.
    const { data: despues } = await admin
      .from('feedings').select('amount_ml').eq('id', ajena!.id).single()
    expect(Number(despues!.amount_ml)).toBe(90)
  })

  it('el borrado lógico ajeno tampoco pasa', async () => {
    const admin = (await import('../helpers/supabase')).adminClient()
    const { data: ajena } = await admin
      .from('feedings').select('id').eq('baby_id', b.babyId).single()

    const { data } = await a.client.from('feedings')
      .update({ voided_at: new Date().toISOString() }).eq('id', ajena!.id).select('id')
    expect(data).toEqual([])
  })

  it('families y family_members solo muestran la propia', async () => {
    const { data: fams } = await a.client.from('families').select('id')
    expect(fams?.map((f) => f.id)).toEqual([a.familyId])

    const { data: miembros } = await a.client.from('family_members').select('user_id')
    expect(miembros?.map((m) => m.user_id)).toEqual([a.userId])
  })

  it('un cliente sin sesión no ve nada', async () => {
    const anon = (await import('../helpers/supabase')).anonClient()
    const { data, error } = await anon.from('babies').select('id')
    expect(error === null ? data : []).toEqual([])
  })

  it('monitor_events no acepta escritura de un usuario (solo el servidor)', async () => {
    const { error } = await a.client.from('monitor_events').insert({
      baby_id: a.babyId, event_type: 'sound_alert', occurred_at: '2026-01-15T16:00:00Z',
    })
    expect(error).not.toBeNull()
  })
})
```

- [ ] **Step 2: Correr y leer con cuidado**

```bash
pnpm test:integration
```

Cada expectativa de arriba es una **lectura** de las policies de `0001`/`0006`,
no un deseo. Si alguna falla, el resultado se reporta tal cual: puede ser que la
policy sea más laxa de lo que dice la doc, y eso es un hallazgo de seguridad,
no una aserción mal escrita. **No se ablanda la aserción para que pase.**

- [ ] **Step 3: Commit**

```bash
git add tests/integration/rls.test.ts
git commit -m "$(cat <<'EOF'
Prove one family cannot read or touch another family's logs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Tests que demuestran los hallazgos de los endpoints de dispositivo

**Files:**
- Create: `tests/integration/quick-nurse.test.ts`, `tests/integration/ingest.test.ts`
- Test: `pnpm test:integration`

**Interfaces:**
- Consumes: `seedTwoFamilies` (Tarea 4).
- Produces: dos tests que **documentan el comportamiento actual, inseguro**, y
  que la Tarea 8 tendrá que dar vuelta. Ese es el punto: el riesgo queda escrito
  y ejecutable antes de discutir el arreglo.

**Nota de método:** estos tests importan el route handler directamente
(`import { POST } from '@/app/api/quick/nurse/route'`) y le pasan una `Request`.
No levantan `next dev`. Hay que fijar las env vars **antes** del import, por eso
se usa `await import(...)` dentro del test.

- [ ] **Step 1: Escribir el test de `/api/quick/nurse`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, seedTwoFamilies, type SeededFamily } from '../helpers/supabase'

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>

const SECRET = 'secreto-de-prueba-del-shortcut'

beforeAll(async () => {
  ({ a, b, cleanup } = await seedTwoFamilies('quicknurse'))
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
  process.env.QUICK_TOGGLE_SECRET = SECRET
})
afterAll(async () => { await cleanup() })

async function post(body: unknown, secret: string | null) {
  const { POST } = await import('@/app/api/quick/nurse/route')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret !== null) headers['x-device-secret'] = secret
  const req = new Request('http://localhost/api/quick/nurse', {
    method: 'POST', headers, body: JSON.stringify(body),
  })
  // NextRequest acepta una Request estándar.
  const { NextRequest } = await import('next/server')
  return POST(new NextRequest(req))
}

describe('/api/quick/nurse — autenticación', () => {
  it('rechaza sin secreto', async () => {
    expect((await post({ side: 'left' }, null)).status).toBe(401)
  })

  it('rechaza con secreto incorrecto', async () => {
    expect((await post({ side: 'left' }, 'otro')).status).toBe(401)
  })

  it('rechaza un side inválido', async () => {
    expect((await post({ side: 'arriba' }, SECRET)).status).toBe(400)
  })
})

describe('HALLAZGO: /api/quick/nurse escribe sobre el bebé más viejo de TODA la base', () => {
  /**
   * Este test documenta el riesgo tal como está hoy (CLAUDE.md §7.3):
   * el endpoint corre con service_role (salta RLS) y elige el `babies` más
   * antiguo sin filtrar por familia. Con una sola familia es correcto; con
   * dos, el secreto de CUALQUIERA escribe sobre el bebé de la familia A.
   *
   * Cuando el arreglo llegue (ver proposals/), este test tiene que DARSE
   * VUELTA: la sesión debe quedar en el bebé del titular del secreto, o el
   * endpoint debe fallar cerrado. Hasta entonces, esto es la evidencia.
   */
  it('con dos familias, la sesión aterriza en el bebé de la familia A', async () => {
    const res = await post({ side: 'left' }, SECRET)
    expect(res.status).toBe(200)

    const admin = adminClient()
    const { data: enA } = await admin
      .from('nursing_sessions').select('id').eq('baby_id', a.babyId).is('ended_at', null)
    const { data: enB } = await admin
      .from('nursing_sessions').select('id').eq('baby_id', b.babyId).is('ended_at', null)

    expect(enA).toHaveLength(1)   // ← el bebé más viejo se lo queda todo
    expect(enB).toHaveLength(0)   // ← la otra familia nunca recibe nada

    // Cerramos la sesión para no dejar estado colgando.
    await post({ side: 'left' }, SECRET)
  })

  it('el toggle sigue el ciclo start → end → switch sobre ese mismo bebé', async () => {
    const admin = adminClient()

    const started = await post({ side: 'left' }, SECRET)
    expect((await started.json()).action).toBe('started')

    const switched = await post({ side: 'right' }, SECRET)
    expect((await switched.json()).action).toBe('switched')

    const ended = await post({ side: 'right' }, SECRET)
    expect((await ended.json()).action).toBe('ended')

    const { data } = await admin
      .from('nursing_sessions').select('id, ended_at').eq('baby_id', a.babyId)
    expect(data!.every((r) => r.ended_at !== null)).toBe(true)
  })
})
```

- [ ] **Step 2: Escribir el test de `/api/ingest`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, seedTwoFamilies, type SeededFamily } from '../helpers/supabase'

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>
const SECRET = 'secreto-de-prueba-del-nuc'

beforeAll(async () => {
  ({ a, b, cleanup } = await seedTwoFamilies('ingest'))
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
  process.env.NUC_DEVICE_SECRET = SECRET
})
afterAll(async () => { await cleanup() })

async function post(body: unknown, secret: string | null) {
  const { POST } = await import('@/app/api/ingest/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret !== null) headers['x-device-secret'] = secret
  return POST(new NextRequest(new Request('http://localhost/api/ingest', {
    method: 'POST', headers, body: JSON.stringify(body),
  })))
}

describe('/api/ingest', () => {
  it('rechaza sin secreto y sin baby_id', async () => {
    expect((await post({ baby_id: a.babyId }, null)).status).toBe(401)
    expect((await post({}, SECRET)).status).toBe(400)
  })

  it('abre y cierra una sesión de sueño derivada', async () => {
    expect((await post({ baby_id: a.babyId, kind: 'sleep_start', occurred_at: '2026-01-15T20:00:00Z' }, SECRET)).status).toBe(200)
    expect((await post({ baby_id: a.babyId, kind: 'sleep_end', occurred_at: '2026-01-15T21:30:00Z' }, SECRET)).status).toBe(200)

    const admin = adminClient()
    const { data } = await admin.from('sleep_sessions')
      .select('started_at, ended_at, source').eq('baby_id', a.babyId)
    expect(data).toHaveLength(1)
    expect(data![0].source).toBe('nuc_derived')
    expect(data![0].ended_at).not.toBeNull()
  })

  /**
   * HALLAZGO: el secreto es uno solo para toda la instalación y el endpoint
   * corre con service_role, así que quien lo tenga puede escribir sobre
   * CUALQUIER baby_id de la base, no solo el suyo. Documentado, no corregido:
   * el arreglo de fondo (token hasheado por dispositivo) es cambio de schema
   * y vive en proposals/.
   */
  it('HALLAZGO: un secreto válido escribe sobre el bebé de otra familia', async () => {
    const res = await post({ baby_id: b.babyId, event_type: 'sound_alert' }, SECRET)
    expect(res.status).toBe(200)

    const admin = adminClient()
    const { data } = await admin.from('monitor_events').select('id').eq('baby_id', b.babyId)
    expect(data).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Correr**

```bash
pnpm test:integration
```

Esperado: verde. Si `next/server` no se puede importar dentro de Vitest sin el
runtime de Next, el fallback es extraer la lógica del handler a una función pura
que reciba `(headers, body)` — **pero eso es refactor de producción y no se hace
sin avisar**: si pasa, se reporta y se pide luz verde.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/quick-nurse.test.ts tests/integration/ingest.test.ts
git commit -m "$(cat <<'EOF'
Pin down what the device endpoints do today, cross-family writes included

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Auditoría de código — reporte, sin corregir

**Files:**
- Create: `docs/auditorias/2026-09-20-auditoria-inicial.md`
- Test: revisión de que cada hallazgo cita archivo:línea real

**Interfaces:**
- Consumes: los tests de las Tareas 2-6 (lo demostrado se marca CONFIRMADO).
- Produces: la lista priorizada que la Tarea 8 ejecuta y que la Tarea 9 usa
  como insumo del `prompt-auditoria-codigo.md`.

**Regla del formato (copiada de FRUCO, adaptada):** el reporte **no corrige
nada**. Severidades 🔴 CRÍTICO / 🟠 ALTO / 🟡 MEDIO / 🟢 BAJO, cada hallazgo con
`archivo:línea`, descripción, corrección sugerida, y una marca de
**CONFIRMADO POR TEST** / **NO VERIFICADO**.

- [ ] **Step 1: Escribir el reporte con los hallazgos ya verificados**

Contenido mínimo obligatorio (todo esto ya está verificado contra el código el
20 sep 2026; el ejecutor re-verifica línea por línea antes de escribir):

**🔴 CRÍTICOS**
1. `app/api/quick/nurse/route.ts:41-46` — toma el `babies` más antiguo de toda
   la base con service_role. CONFIRMADO POR TEST (Tarea 6).
2. `app/api/ingest/route.ts:19-30` — un único secreto estático habilita escribir
   sobre cualquier `baby_id`. CONFIRMADO POR TEST (Tarea 6).

**🟠 ALTOS**
3. Ambos endpoints comparan el secreto con `!==` (comparación no timing-safe) y
   no tienen rate limiting ni idempotencia. `route.ts:20` y `:26`.
4. No existe `middleware.ts`: el guard de auth es client-side (`lib/useBaby.ts:26-33`).
   Los datos los protege RLS, pero hay parpadeo de contenido y cualquier ruta
   nueva que no use el hook nace desprotegida.
5. `app/api/ingest/route.ts:23` — `await req.json()` sin `catch`: un body no-JSON
   sale como 500 en vez de 400. (`quick/nurse` sí lo cachea, `:31`.)
6. `app/api/ingest/route.ts:24-30` — cero validación de forma: `baby_id` sin
   chequeo de uuid, `event_type` sin lista blanca, `meta` jsonb sin tope de
   tamaño, `occurred_at` sin validar.

**🟡 MEDIOS**
7. `next.config.mjs` no manda ninguna cabecera de seguridad.
8. `growth_measurements` no tiene policy de UPDATE ni `voided_at`: una medición
   mal cargada es permanente. (`0001`, `0006`.) Requiere schema → propuesta.
9. `families` / `family_members` no tienen policy de INSERT: dar de alta una
   familia solo se puede por Studio o service_role. Es coherente con el README,
   pero no está dicho en ningún lado como decisión.
10. `README.md` completo — describe como "no construido" lo que está construido
    y manda comandos que no funcionan (`npm install -g supabase`,
    `cp .env.local.dev .env.local`, archivo inexistente).
11. `PROJECT.md:135` (tests inexistentes, ya cerrado por la Tarea 2) y
    `PROJECT.md:166-177` (editar/retractar declarado no construido, existe desde
    `0006`).
12. `public/sw.js:79` — el fallback de navegación offline devuelve `/dashboard`
    cacheado aun a quien no tiene sesión. No filtra datos (el shell es estático
    y el fetch a Supabase falla), pero conviene dejarlo escrito.

**🟢 BAJOS**
13. `preview.html` (31 KB) trackeado en la raíz, sin referencias desde el código.
14. `family_members.role` existe y nadie la lee (CLAUDE.md §6 ya lo dice).
15. Sin lint ni format configurados (fuera del alcance de este batch salvo que
    Emilio lo pida).

- [ ] **Step 2: Verificar cada `archivo:línea` del reporte**

```bash
cd ~/proyectos/amelia_app
sed -n '19,30p' app/api/ingest/route.ts
sed -n '41,46p' app/api/quick/nurse/route.ts
sed -n '26,33p' lib/useBaby.ts
```

Corregir en el reporte cualquier número que no coincida.

- [ ] **Step 3: Commit**

```bash
git add docs/auditorias/2026-09-20-auditoria-inicial.md
git commit -m "$(cat <<'EOF'
Write down every security and quality finding found in the audit pass

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Endurecer lo que se puede endurecer sin tocar el schema

**Files:**
- Create: `middleware.ts`, `lib/deviceAuth.ts`,
  `proposals/device-tokens-and-idempotency.md`, `proposals/growth-edit-and-void.md`
- Modify: `app/api/ingest/route.ts`, `app/api/quick/nurse/route.ts`,
  `next.config.mjs`, `.env.local.example`
- Test: `pnpm test:all` + prueba manual en el navegador

**Interfaces:**
- Consumes: los hallazgos de la Tarea 7.
- Produces:
  - `lib/deviceAuth.ts` exporta
    `checkDeviceSecret(req: Request, expected: string | undefined): 'ok' | 'unauthorized' | 'rate_limited'`
    y `readJson<T>(req: Request): Promise<T | null>`.
  - `middleware.ts` protege `/dashboard`, `/pumping`, `/growth`,
    `/appointments`, `/history` redirigiendo a `/login` cuando no hay sesión.

**Límite explícito:** idempotencia real y tokens por dispositivo **necesitan
tablas nuevas** ⇒ van a `proposals/`, no se implementan acá (CLAUDE.md §5.2).
El rate limiting que sí entra es **en memoria del proceso**; en Vercel, con
varias instancias, es mitigación parcial y el doc lo dice con esas palabras.

- [ ] **Step 1: Escribir `lib/deviceAuth.ts`**

```ts
import { timingSafeEqual } from 'node:crypto'

/**
 * Autenticación de los dos endpoints de dispositivo.
 *
 * Lo que arregla respecto de comparar con `!==`:
 *   · comparación en tiempo constante, para no filtrar el secreto por timing
 *   · un techo de intentos por minuto, para que un secreto estático no se
 *     pueda probar a fuerza bruta
 *
 * Lo que NO arregla, y hay que saberlo: el secreto sigue siendo uno solo y
 * compartido, y el contador vive en la memoria de ESTE proceso. En un deploy
 * con varias instancias, cada una cuenta por su lado. El arreglo de fondo
 * (token hasheado por dispositivo + idempotencia) es cambio de schema y vive
 * en proposals/device-tokens-and-idempotency.md.
 */

const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 20
const attempts = new Map<string, { count: number; resetAt: number }>()

function constantTimeEquals(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Igual gastamos el tiempo de una comparación, para no filtrar el largo.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export type DeviceAuthResult = 'ok' | 'unauthorized' | 'rate_limited'

export function checkDeviceSecret(req: Request, expected: string | undefined): DeviceAuthResult {
  const key = req.headers.get('x-forwarded-for') ?? 'local'
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
  } else {
    entry.count += 1
    if (entry.count > MAX_ATTEMPTS) return 'rate_limited'
  }

  const given = req.headers.get('x-device-secret')
  if (!given || !expected) return 'unauthorized'
  return constantTimeEquals(given, expected) ? 'ok' : 'unauthorized'
}

/** Un body que no es JSON es un 400 del cliente, no un 500 nuestro. */
export async function readJson<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T } catch { return null }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** Un instante ISO dentro de una ventana sensata: ni el año 1900 ni el 3000. */
export function isSaneInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const t = Date.parse(value)
  if (Number.isNaN(t)) return false
  const now = Date.now()
  return t > now - 365 * 86_400_000 && t < now + 86_400_000
}
```

- [ ] **Step 2: Escribir el test de lo nuevo, antes de cablearlo**

Agregar a `tests/integration/ingest.test.ts`:

```ts
describe('/api/ingest endurecido', () => {
  it('un body que no es JSON responde 400, no 500', async () => {
    const { POST } = await import('@/app/api/ingest/route')
    const { NextRequest } = await import('next/server')
    const res = await POST(new NextRequest(new Request('http://localhost/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-secret': SECRET },
      body: 'esto no es json',
    })))
    expect(res.status).toBe(400)
  })

  it('un baby_id que no es uuid responde 400', async () => {
    expect((await post({ baby_id: 'la-bebe', event_type: 'sound_alert' }, SECRET)).status).toBe(400)
  })

  it('un event_type fuera de la lista blanca responde 400', async () => {
    expect((await post({ baby_id: a.babyId, event_type: 'video_clip' }, SECRET)).status).toBe(400)
  })

  it('un occurred_at absurdo responde 400', async () => {
    expect((await post({ baby_id: a.babyId, event_type: 'sound_alert', occurred_at: '1899-01-01T00:00:00Z' }, SECRET)).status).toBe(400)
  })
})
```

- [ ] **Step 3: Correr y verlos fallar**

```bash
pnpm test:integration
```

Esperado: los cuatro nuevos en rojo (hoy el handler devuelve 500 o 200).

- [ ] **Step 4: Cablear `/api/ingest`**

Reemplazar el bloque de auth y validación de `app/api/ingest/route.ts`
(conservando los tres caminos `sleep_start` / `sleep_end` / evento genérico tal
como están):

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { checkDeviceSecret, isSaneInstant, isUuid, readJson } from '@/lib/deviceAuth'

// Lo único que el NUC puede empujar. Video, imagen y audio NUNCA salen de la
// casa (CLAUDE.md §1): acá solo entran eventos derivados.
const EVENT_TYPES = ['sound_alert', 'motion_start', 'motion_end'] as const
const MAX_META_BYTES = 2_048

export async function POST(req: NextRequest) {
  const auth = checkDeviceSecret(req, process.env.NUC_DEVICE_SECRET)
  if (auth === 'rate_limited') {
    return NextResponse.json({ error: 'too many requests' }, { status: 429 })
  }
  if (auth !== 'ok') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await readJson<Record<string, unknown>>(req)
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 })

  const { baby_id, event_type, occurred_at, meta, kind } = body
  if (!isUuid(baby_id)) {
    return NextResponse.json({ error: 'baby_id required' }, { status: 400 })
  }
  if (occurred_at !== undefined && !isSaneInstant(occurred_at)) {
    return NextResponse.json({ error: 'occurred_at out of range' }, { status: 400 })
  }
  if (kind !== undefined && kind !== 'sleep_start' && kind !== 'sleep_end') {
    return NextResponse.json({ error: 'unknown kind' }, { status: 400 })
  }
  if (kind === undefined && !EVENT_TYPES.includes(event_type as typeof EVENT_TYPES[number])) {
    return NextResponse.json({ error: 'unknown event_type' }, { status: 400 })
  }
  if (meta !== undefined && meta !== null && JSON.stringify(meta).length > MAX_META_BYTES) {
    return NextResponse.json({ error: 'meta too large' }, { status: 400 })
  }

  // …los tres caminos existentes, sin cambios…
}
```

- [ ] **Step 5: Cablear `/api/quick/nurse`**

Mismo tratamiento de auth (`checkDeviceSecret` + 429) y `readJson`. El scoping
del bebé **no se cambia todavía**: es una decisión de producto que está en las
preguntas abiertas de este plan. Lo que sí entra es dejar el riesgo escrito en
el código, encima del lookup:

```ts
  // ⚠️ Un solo hogar. Este lookup toma el `babies` más antiguo de TODA la
  // base, sin filtrar por familia, y corre con service_role (salta RLS).
  // Con más de una familia, el secreto de cualquiera escribe sobre el bebé
  // más viejo. Demostrado en tests/integration/quick-nurse.test.ts.
  // Arreglo propuesto: proposals/device-tokens-and-idempotency.md §3.
```

- [ ] **Step 6: Correr los tests otra vez**

```bash
pnpm test:all
```

Esperado: los cuatro nuevos en verde, y los de la Tarea 6 **siguen igual** — el
cruce entre familias todavía existe, porque acá no se arregló. Si un test de la
Tarea 6 cambia de resultado, algo se movió sin querer.

- [ ] **Step 7: Escribir `middleware.ts`**

```ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Guard de auth del lado del servidor.
 *
 * Lo que protege los DATOS sigue siendo RLS — esto no la reemplaza. Lo que
 * arregla es el parpadeo: hasta acá, una ruta privada se renderizaba y recién
 * después useBaby() rebotaba al login, y una pantalla de pared compartida
 * mostraba el esqueleto de la app a cualquiera.
 */
const PROTECTED = ['/dashboard', '/pumping', '/growth', '/appointments', '/history']

export async function middleware(req: NextRequest) {
  const res = NextResponse.next({ request: { headers: req.headers } })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookies) => {
          for (const { name, value, options } of cookies) res.cookies.set(name, value, options)
        },
      },
    },
  )

  const { data: { user } } = await supabase.auth.getUser()
  const needsAuth = PROTECTED.some((p) => req.nextUrl.pathname.startsWith(p))

  if (!user && needsAuth) {
    const login = req.nextUrl.clone()
    login.pathname = '/login'
    return NextResponse.redirect(login)
  }
  return res
}

export const config = {
  // Ni assets, ni el service worker, ni el manifest: el kiosco tiene que
  // poder levantar la shell sin conexión aunque la sesión haya caducado.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons|sw.js|manifest.webmanifest|api).*)'],
}
```

- [ ] **Step 8: Verificar el middleware a mano, contra el Supabase local**

```bash
pnpm dev
```

Comprobar, y anotar el resultado real en `output.txt`:
1. En ventana privada, `http://localhost:3000/dashboard` redirige a `/login`
   **sin** mostrar el dashboard ni un instante.
2. Tras iniciar sesión, `/dashboard` carga y **no** vuelve a rebotar (si rebota,
   la sesión de `createBrowserClient` no está en cookies legibles por el
   middleware y hay que revisar la versión de `@supabase/ssr` — **esto está sin
   verificar hasta correrlo**).
3. `/login` sigue accesible sin sesión.
4. La PWA instalada sigue abriendo offline (el matcher excluye `sw.js`).

- [ ] **Step 9: Cabeceras de seguridad en `next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        // La pantalla de pared no necesita nada de esto, y la cámara del
        // teléfono menos todavía: la regla de la casa es que no sale media.
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
      ],
    }]
  },
}

export default nextConfig
```

(CSP queda **fuera**: Next 14 inyecta estilos y scripts inline y una CSP mal
puesta rompe la app en la pared sin que nadie mire la consola. Se propone como
trabajo aparte, con `report-only` primero.)

- [ ] **Step 10: Escribir las dos propuestas de schema**

`proposals/device-tokens-and-idempotency.md` — qué tiene que existir para cerrar
los dos hallazgos críticos, para que lo numere el agente del Hub:
- tabla `device_tokens` (id, family_id, baby_id, label, token_hash, created_at,
  revoked_at), RLS + GRANT en la misma migración;
- columna/tabla de idempotencia: `idempotency_key` con índice único por
  dispositivo, y el endpoint devolviendo el resultado anterior en vez de
  duplicar;
- `/api/quick/nurse` resolviendo el bebé **desde el token**, nunca desde
  "el más antiguo";
- migración del secreto actual: convive un período, después se revoca.

`proposals/growth-edit-and-void.md`:
- policy de UPDATE en `growth_measurements` + columna `voided_at`,
- las funciones `updateGrowth` / `voidGrowth` que irían en `lib/db.ts`,
- por qué hoy una medición mal cargada es permanente.

- [ ] **Step 11: `pnpm test:all`, typecheck y build**

```bash
pnpm exec tsc --noEmit
pnpm build
pnpm test:all
```

- [ ] **Step 12: Commits (tres, uno por cambio de efecto)**

```bash
git add lib/deviceAuth.ts app/api/ingest/route.ts app/api/quick/nurse/route.ts tests/integration/ingest.test.ts
git commit -m "$(cat <<'EOF'
Make the device endpoints reject junk, throttle guesses, and compare secrets safely

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"

git add middleware.ts next.config.mjs
git commit -m "$(cat <<'EOF'
Send a signed-out visitor to the login screen before any private page renders

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"

git add proposals/
git commit -m "$(cat <<'EOF'
Propose per-device tokens, idempotency, and editable growth entries for the Hub

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Documentación local en `docs/`

**Files:**
- Create: `docs/README.md`, `docs/manual-buenas-practicas.md`,
  `docs/checklist-cada-cambio.md`, `docs/prompt-auditoria-codigo.md`,
  `docs/seguridad-operacional.md`
- Modify: `CLAUDE.md` (un puntero a `docs/`)

**Interfaces:**
- Consumes: los comandos reales (`pnpm test:all`) y los hallazgos de la Tarea 7.
- Produces: las cuatro páginas de la estructura FRUCO, traducidas a este stack.

**Regla de traducción (lo que NO se copia de FRUCO):** nada de Prisma, Express,
Zod, `empresa_id`, JWT propio, `requirePermiso`, repositories, audit log,
paginación de 100, Winston, docker-compose, ni Raspberry Pi. Cada regla que
entra tiene que poder citar un archivo **de este repo**.

- [ ] **Step 1: `docs/README.md`** — índice de una pantalla: qué es cada página,
  en qué orden leerlas (CLAUDE.md → PROJECT.md → design.md → estas cuatro), y la
  regla de oro heredada de FRUCO: *investigar antes de hablar; si la doc y el
  código no coinciden, el código es la verdad y la doc es el bug.*

- [ ] **Step 2: `docs/manual-buenas-practicas.md`** — secciones:
  1. **Identidad de datos** — los ids los genera el cliente (`newId()` en
     `lib/queue.ts`), y por qué: es lo que permite empezar y terminar una sesión
     offline. Nunca un nombre como llave.
  2. **Una sola puerta a la base** — todo por `lib/db.ts`; las páginas no arman
     queries; qué cambia en fase 2 y por qué eso es un solo archivo editado.
  3. **Multi-familia por RLS, no por filtro en el código** — el aislamiento lo
     hace Postgres (`is_baby_family_member`), no un `where` que alguien puede
     olvidar. Corolario: toda tabla nueva nace con RLS **y GRANT** en la misma
     migración (el bug de `0005`). Test obligatorio: dos familias, una no ve a
     la otra (`tests/integration/rls.test.ts`).
  4. **Las dos llaves** — anon (browser, bajo RLS) vs service_role (solo route
     handlers, salta RLS). `lib/supabaseAdmin.ts` nunca entra a un `'use client'`.
     Nada de `NEXT_PUBLIC_` en un secreto.
  5. **Tipos** — `lib/types.ts` es el stand-in de los types generados; los
     nombres calcan las columnas para que el swap de fase 2 sea un swap.
  6. **Convenciones de datos** — UTC en la base, `America/Los_Angeles` al
     renderizar; ml y kg/cm en la base, oz/lb solo display; borrado lógico con
     `voided_at` y toda lectura filtrando `.is('voided_at', null)`.
  7. **Honestidad de estado** — nada se muestra como guardado si no lo está; un
     rechazo del servidor no se encola; el SW nunca cachea una respuesta de
     Supabase.
  8. **Migraciones** — no se edita una aplicada; este repo ya no numera:
     `proposals/`.
  9. **Diseño** — ningún hex ni px fuera de `app/globals.css`; los tokens de
     escala se re-apuntan en el breakpoint de 1180px, no se bifurcan componentes.
  10. **Tests** — qué es unit acá (`lib/format.ts`, `lib/queue.ts`) y qué exige
      base (`tests/integration/`); la regla de las cuatro timezones.
  11. **Commits** — imperativo en inglés, una línea, sin prefijo, describiendo el
      efecto para quien usa la app; ejemplos reales del historial.
  12. **Apéndice: frases que delatan deuda** — adaptadas: *"total RLS lo tapa"*,
      *"esto lo valido en la página"*, *"le pongo el hex acá nomás"*,
      *"después le hago el test"*, *"lo encolo y listo"*.

- [ ] **Step 3: `docs/checklist-cada-cambio.md`** — tres bloques:
  - **Antes de escribir código:** ¿verifiqué contra el código, no contra la doc?
    ¿toca datos de familia → hay test de aislamiento? ¿toca schema → es propuesta?
    ¿toca visual → sale de un token?
  - **Después:** `pnpm test:all`, `pnpm exec tsc --noEmit`, `pnpm build`, probado
    contra el Supabase local; sin `console.log` nuevo; sin `any` nuevo; sin
    secreto hardcodeado; `.env.local.example` actualizado; ninguna query fuera de
    `lib/db.ts`; `supabaseAdmin` fuera de todo `'use client'`.
  - **Antes del commit:** formato del mensaje, y el recordatorio de que `npm`
    está prohibido.

- [ ] **Step 4: `docs/prompt-auditoria-codigo.md`** — el prompt pegable, con las
  secciones adaptadas: 1) Seguridad (service_role, secretos de dispositivo,
  `NEXT_PUBLIC_`, validación de body, rate limiting); 2) Aislamiento entre
  familias (RLS + GRANT, `family_id`, endpoints con service_role que no filtran);
  3) Acceso a datos (queries fuera de `lib/db.ts`, lecturas sin
  `.is('voided_at', null)`); 4) Honestidad de estado offline; 5) Service worker
  (nunca una respuesta de Supabase en caché); 6) Tiempo y unidades (TZ del hogar,
  ml/kg en la base); 7) TypeScript (`any`, `as`, `!`); 8) Diseño (hex/px fuera de
  `globals.css`, targets táctiles); 9) Migraciones y propuestas; 10) Doc vs
  código. Formato de reporte 🔴🟠🟡🟢 con `archivo:línea` + corrección sugerida,
  y la regla explícita: **no corrige nada, solo reporta**. Cierra con la tabla de
  historial de corridas, con la del 20 sep 2026 ya cargada.

- [ ] **Step 5: `docs/seguridad-operacional.md`** — reglas que sí aplican a este
  proyecto:
  1. **pnpm y solo pnpm**, con `corepack enable` en servidores; nunca
     `npm install -g`.
  2. **Lockfile siempre en git**; `pnpm audit` antes de cada deploy.
  3. **Nunca `curl | sh`** en un servidor: bajar, leer, ejecutar.
  4. **Secretos fuera del repo y fuera de Notion**; `.env.local` con permisos
     `600`; una contraseña pegada en un chat cuenta como expuesta.
  5. **service_role**: qué es, por qué salta RLS, dónde vive hoy
     (`/api/ingest`) y por qué eso está marcado como pregunta abierta contra la
     regla del Hub.
  6. **Secretos de dispositivo**: estáticos y compartidos hoy; cómo rotarlos;
     qué tapa el rate limiting en memoria y qué **no**.
  7. **Puertos de Docker**: verificar el binding real con
     `sudo ss -tlnp | grep 5432` — `ufw status` no es evidencia. Aplica al stack
     local de Supabase en este VPS; **verificar y anotar el binding real
     observado**, no copiar la conclusión de FRUCO.
  8. **La regla dura del proyecto**: video, imagen y audio de la cámara nunca
     salen de la casa; a `/api/ingest` solo entran eventos derivados.
  9. **Historial de incidentes** — arranca vacío, con el formato listo.

- [ ] **Step 6: Puntero en `CLAUDE.md`**

Agregar después de la línea que manda leer `PROJECT.md` y `design.md`:

```markdown
Para trabajar (no para entender el proyecto), la doc operativa vive en `docs/`:
buenas prácticas, checklist de cada cambio, prompt de auditoría y seguridad
operacional. Índice: `docs/README.md`.
```

- [ ] **Step 7: Verificar que la doc no miente**

```bash
cd ~/proyectos/amelia_app
grep -rn "npm " docs/ README.md CLAUDE.md | grep -v pnpm
grep -rn "empresa_id\|Prisma\|Express\|Zod" docs/
```

Esperado: sin salida en ambos.

- [ ] **Step 8: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "$(cat <<'EOF'
Write the local handbook, change checklist, audit prompt, and security rules

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Auditar `design.md` contra el código y commitearlo

**Files:**
- Modify: `design.md`
- Test: verificación línea por línea contra `app/globals.css`, `lib/tokens.ts`,
  `components/ui.tsx`, `app/manifest.ts`, `public/sw.js`

**Interfaces:**
- Consumes: nada.
- Produces: `design.md` trackeado y verificado. Hoy está sin commitear.

- [ ] **Step 1: Verificar la tabla de paleta**

```bash
cd ~/proyectos/amelia_app
sed -n '16,28p' app/globals.css
sed -n '14,27p' lib/tokens.ts
```

Los diez tokens de color tienen que coincidir **exactamente** entre los dos
archivos y con la tabla de `design.md §2`. Cualquier divergencia es un hallazgo:
se anota, no se emparcha en silencio.

- [ ] **Step 2: Verificar la escala**

```bash
sed -n '29,72p' app/globals.css
```

Contrastar contra `design.md §3`: siete tokens de tipografía, seis de espaciado,
`--r-card`, `--r-control`, `--tap` (52px / 84px), `--measure`, `--col-gap`,
`--cols`, y el breakpoint de 1180px que también está en
`lib/tokens.ts:surface.wallMinWidth`.

- [ ] **Step 3: Verificar el inventario de componentes**

```bash
grep -n '^export function' components/ui.tsx
ls components/
```

`design.md §4` tiene que nombrar los siete exports de `ui.tsx` (`Page`, `Grid`,
`Card`, `Label`, `Btn`, `Banner`, `Nav`) **y** los tres componentes sueltos que
hoy podrían faltarle: `NoBaby`, `SyncStatus`, `ServiceWorker`. Agregar los que
falten, con su responsabilidad en una línea.

- [ ] **Step 4: Verificar los patrones de §5 uno por uno**

Cada subsección afirma algo sobre el código. Comprobar:
- §5.2 el cronómetro → `elapsed()` en `lib/format.ts`
- §5.3 relativo/absoluto → `timeAgo()`
- §5.4 "not synced yet" → `mark()` en `buildActivity`, `lib/db.ts`
- §5.6 confirmación antes de destruir → `window.confirm` en `components/ui.tsx`
- §5.7 unidad hablada → `lib/useVolumeUnit.ts` + `formatVolume`
- §5.8 hora pasada → los parámetros `at?` de `lib/db.ts`

Lo que no se pueda citar, se marca **"no verificado"** en el propio documento.

- [ ] **Step 5: Resolver o marcar la referencia a la skill `impeccable`**

`design.md` líneas 8-14 manda consultar una skill llamada `impeccable` antes de
proponer diseño nuevo. **Esa skill no está disponible en este entorno**
(verificado contra la lista de skills de la sesión). No se borra la referencia:
se agrega una nota de una línea diciendo que no está disponible acá y que hay
que confirmar con Emilio si existe de su lado. Es la pregunta Q3 de este plan.

- [ ] **Step 6: Commit**

```bash
git add design.md
git commit -m "$(cat <<'EOF'
Commit the design guidelines, checked line by line against the real stylesheet

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Sincronizar README, PROJECT.md y CLAUDE.md con la realidad

**Files:**
- Modify: `README.md`, `PROJECT.md`, `CLAUDE.md`
- Test: relectura contra el estado del repo al terminar el batch

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: doc que no miente. Es la última tarea a propósito: antes de ella el
  estado todavía cambiaba.

- [ ] **Step 1: Reescribir `README.md`**

Estructura nueva, toda en pnpm:
1. Qué es Amelia, en tres líneas, y la advertencia de que el objetivo primario
   es la pantalla de pared.
2. **Prerrequisitos:** Node LTS, Docker corriendo, pnpm (`corepack enable`).
   Fuera el `npm install -g supabase`: el CLI es devDependency.
3. **Arranque:**
   ```bash
   pnpm install
   pnpm exec supabase start
   cp .env.local.example .env.local   # completar con lo que imprime supabase start
   pnpm dev
   ```
   (`cp .env.local.dev .env.local` desaparece: ese archivo no existe.)
4. **Primera cuenta:** los pasos de Studio siguen siendo correctos —
   `families` / `family_members` / `babies` a mano — y ahora se dice **por qué**:
   no hay policy de INSERT para esas tablas.
5. **Tests:** `pnpm test`, `pnpm test:tz`, `pnpm test:integration`, `pnpm test:all`,
   y que integration necesita el stack local levantado.
6. **Qué está construido / qué no** — reemplazado por la lista real de
   `CLAUDE.md §6`: auth, dashboard completo, Milk, Growth, Doctor, History con
   editar/borrar, PWA, cola offline, RLS en las 11 tablas, los dos endpoints de
   dispositivo. No construido: lint/format, CI, deploy, Supabase en la nube, la
   automatización de HA, el uso de `family_members.role`.
7. **Puntero a `docs/`.**

- [ ] **Step 2: Corregir `PROJECT.md`**

- Línea 135: "Unit-tested under four system timezones" — **ahora es cierta**.
  Agregar el puntero: `tests/unit/format.test.ts`, `pnpm test:tz`.
- Líneas 166-177: sacar "Editing or retracting a logged entry" de "What's NOT
  built" — existe desde `0006` + `lib/db.ts` (`updateFeeding`, `voidFeeding`,
  etc.). Dejar lo que sí falta: la policy de UPDATE de `growth_measurements`,
  que ahora tiene propuesta.
- Sección "Security posture": agregar que hay rate limiting en memoria y
  validación de payload en los dos endpoints, que el guard de auth ya es
  server-side, y que el cruce entre familias de `/api/quick/nurse` **sigue
  abierto** con test que lo demuestra.

- [ ] **Step 3: Corregir `CLAUDE.md`**

- §0: el ejemplo "`lib/format.ts` y `PROJECT.md` afirman que hay tests… no hay
  ninguno" ya no vale. Reemplazarlo por un ejemplo vivo (el README, hasta hoy) y
  anotar que el de los tests se cerró el 20 sep 2026.
- §2 tabla de stack: Tests → **Vitest**; Gestor de paquetes → **pnpm**.
- §3 comandos: todo a pnpm, agregar los scripts de test y `pnpm exec supabase start`.
- §5.1: el "hueco conocido" del lockfile se cierra; la regla pasa a ser
  "pnpm, con lockfile commiteado; npm y yarn prohibidos".
- §6 "Estado real": mover tests de "no construido" a "construido", con el
  alcance exacto (format, queue, RLS, endpoints de dispositivo) y aclarando que
  **no** hay tests de componentes ni de páginas.
- §8 checklist: cambiar `npx tsc --noEmit` por `pnpm exec tsc --noEmit`,
  `npm run build` por `pnpm build`, y agregar `pnpm test:all`.

- [ ] **Step 4: Verificación final completa**

```bash
cd ~/proyectos/amelia_app
grep -rn "npm run\|npm install\|npx " README.md CLAUDE.md PROJECT.md docs/ || echo "sin rastros de npm"
pnpm exec tsc --noEmit
pnpm build
pnpm test:all
git status --short
```

- [ ] **Step 5: Commit**

```bash
git add README.md PROJECT.md CLAUDE.md
git commit -m "$(cat <<'EOF'
Make the README and handoff docs describe the app that actually exists

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review del plan

**Cobertura de la spec:**

| Pedido | Tarea |
|---|---|
| 1. Migrar a pnpm, lockfile, borrar vestigios, actualizar doc | T1 (+ T9/T11 para la doc) |
| 2. docs/ con las cuatro páginas estilo FRUCO | T9 |
| 3. design.md completado/revisado | T10 |
| 4a. Unit tests de `lib/format.ts` bajo 4 TZ | T2 |
| 4b. Tests de RLS/multi-familia | T4 + T5 |
| 4c. Test del hallazgo de `/api/quick/nurse` | T6 |
| 5a. Secretos de dispositivo: rate limiting / idempotencia | T8 (rate limit sí; idempotencia → propuesta, requiere schema) |
| 5b. Middleware de auth server-side | T8 |
| 5c. `@types/react-dom` | T1 |
| 5d. README desactualizado | T11 |
| 5e. Otros hallazgos | T7 (reporte) + T8 (los que no tocan schema) |

**Huecos declarados:** la idempotencia real y los tokens por dispositivo no se
implementan acá porque necesitan tablas nuevas y este repo no numera migraciones
(CLAUDE.md §5.2). Quedan como propuesta en `proposals/`, con el test que
demuestra el riesgo ya escrito.

**Consistencia de nombres:** `seedTwoFamilies`, `adminClient`, `anonClient`,
`SeededFamily`, `checkDeviceSecret`, `readJson`, `isUuid`, `isSaneInstant`,
`assertEnglishLocale`, `SYSTEM_TZ` — cada uno se define en la tarea que lo crea
y se usa con la misma firma en las que lo consumen.

---

## Preguntas abiertas — no las resuelvo solo

1. **`/api/quick/nurse` con más de una familia.** El arreglo de fondo es token
   por dispositivo (propuesta). Mientras tanto, ¿querés un parche de una línea
   —variable `QUICK_TOGGLE_BABY_ID` y fallar cerrado si hay más de un bebé— o lo
   dejamos documentado y el endpoint tal cual hasta que llegue el Hub?
   *Mi recomendación: el parche, porque falla cerrado y no cuesta nada.*
2. **Idempotencia.** Necesita schema ⇒ propuesta. ¿Confirmás que va así y no
   como migración numerada acá?
3. **Skill `impeccable`** referenciada en `design.md:8-14`: no existe en este
   entorno. ¿Existe del tuyo, o saco la referencia?
4. **`preview.html`** (31 KB, trackeado, sin referencias desde el código):
   ¿se queda, se mueve a `docs/`, o se borra?
5. **Lint y format** (eslint + prettier): no están en tu lista y no los metí.
   ¿Los agrego en este batch o quedan para el próximo?
6. **Ubicación de este plan:** lo guardé en
   `docs/superpowers/plans/2026-09-20-pnpm-tests-docs-robustez.md` porque es el
   default de la skill. Si preferís que viva en `docs/` a secas, lo muevo.
7. **`PROJECT.md`** es un documento de handoff hacia el agente del Hub. Doy por
   hecho que puedo corregir sus afirmaciones falsas (T11). Si preferís que solo
   las reporte y no las toque, decímelo.
