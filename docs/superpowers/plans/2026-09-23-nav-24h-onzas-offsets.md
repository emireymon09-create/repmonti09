# Plan — 2026-09-23 · nav de 4, ventana rodante de 24 h, onzas fijas, offsets de sesión

Pase de 10 frentes pedido por Luis. Roles secuenciales: implementador ×2 →
auditor → revisor → documentador.

**Fuera de alcance, sin excepción:** `supabase/migrations/`, `lib/push/`,
variables de entorno, Vercel, cualquier cosa de la nube. No se pushea a `main`
sin confirmación explícita.

---

## Hallazgos de la investigación previa (verificados contra el código)

1. **No hay modales con overlay en esta app** (design.md §4, "la edición es
   inline y la confirmación es `window.confirm`"). Lo que Luis llama "el modal
   de Feeding" es la **tarjeta Feeding de `/dashboard`**
   (`app/dashboard/page.tsx:427-524`). Lo mismo con "el modal de Sleep" — es la
   tarjeta Sleep (`:562-623`).

2. **Los "3 botones" del selector de tipo no son tres tipos.** En la fila
   `row-tight` de la tarjeta Feeding hay: un `<input class="input narrow">`
   cuyo **placeholder es la unidad activa** (`unit`, hoy `oz` o `ml`), el botón
   **Bottle** y el botón **Solid**. Es decir: "ml" **no** es un tercer tipo, es
   el placeholder del campo de cantidad. Sacando Solid (frente 6) queda el
   campo + un botón.
   Aparte, y solo cuando **no** hay lactancia en curso, están los botones
   **Left / Right** (que ya se ocultan con la sesión corriendo).

3. **El volumen se guarda siempre en ml.** La columna es `amount_ml`
   (`lib/types.ts`, `lib/db.ts`); `lib/format.ts` convierte solo para mostrar
   (`formatVolume`) y para entrar (`unitToMl`). La unidad elegida vive en
   `localStorage` (`amelia:volume-unit`, `lib/useVolumeUnit.ts`) y **nunca toca
   lo guardado**. ⇒ **El frente 4 no necesita ninguna migración de datos.**

4. **El límite de día vive en un solo lugar:** `startOfHouseholdDay()` en
   `lib/format.ts:396`. Lo consumen `lib/kpis.ts:36-37` (`kpiWindows`) y
   `components/SectionPage.tsx:340` (el `since` de la lectura).

5. **`.empty-fill` / `:has()` siguen en el CSS** (`app/globals.css:415-427`) y
   `/appointments` y `/growth` siguen montándolo. La regresión del frente 0 hay
   que **medirla**, no suponerla.

---

## Frente 0 — regresión del espacio en blanco (Doctor y Today)

Medir **antes de tocar**, a 390×844, Chromium, tema oscuro e inglés:

- `document.documentElement.scrollHeight`
- el `getBoundingClientRect().bottom` del **último elemento con contenido**
- el `top` de la barra `.nav` (fija) — el hueco es `navTop - lastBottom`
- presencia de `.empty-fill` en el DOM y si `:has()` matchea
  (`getComputedStyle(page).display === 'flex'`)

Recién con esos números, causa raíz. Sospechas a confirmar o descartar:
- el `:has(.empty-fill)` dejó de matchear en Doctor
- Today no tenía `.empty-fill` nunca; sacar `.card-link` le bajó el alto

Arreglo permitido: extender el patrón `.empty-fill` a Today **solo** en su
estado sin datos, o corregir el selector. Con datos, `/dashboard` no cambia.

## Frente 1 — barra de 4: Today · Milk · Statistics · Menu

- `TABS` en `components/ui.tsx` suma `/statistics` después de `/pumping`.
- La barra del teléfono deja de esconder todo salvo `tab-home`: marca explícita
  por ítem (p. ej. `phone: true` en Today, Milk y Statistics) en vez del
  `:not(.tab-home)` de hoy.
- Ícono nuevo `statistics`, **dibujado a mano**, grilla de 24, `currentColor`,
  `fill="none"`, mismo `strokeWidth` que el resto. Sin librerías.
- Ruta nueva `app/statistics/page.tsx`: `Page` + `Nav` + título + `EmptyState`
  dentro de un `.empty-fill`. Placeholder honesto, sin prometer fecha.
- Altas obligatorias: `middleware.ts` (PROTECTED), `lib/offlinePages.ts`,
  `public/sw.js` (PRECACHE + **subir el nombre del cache**, `amelia-v4` → `v5`).
- **Medir a 390px**: ancho de cada ítem, alto del área táctil, y que ninguna
  etiqueta se corte, en inglés y español. Si "Estadísticas" no entra, acortar
  la etiqueta (precedente: "Medidas" por "Crecimiento", design.md §5.9) y
  decirlo. Si 4 no entran bien, **decirlo en el reporte, no forzarlo**.

## Frente 2 — menú vertical de 10

`SECTIONS` pasa a: Today, Feeding, Diapers, Sleep, Milk, Statistics, Growth,
Doctor, History, Settings. Today y Milk quedan duplicados con la barra a
propósito. El comentario del archivo dice hoy "las 8 pantallas que NO son
Today" — hay que reescribirlo.

## Frente 3 — "hoy" = últimas 24 horas rodantes

- `kpiWindows()` (`lib/kpis.ts`): `today` pasa a `{ start: now - 24h, end: now }`.
- **`week` NO se toca** (sigue siendo hoy + los 6 días de calendario
  anteriores). El pedido habla solo de "hoy"; cambiarlo sería alcance que nadie
  pidió. **Anotarlo en el reporte como no-cambio deliberado.**
- **La etiqueta tiene que dejar de mentir.** La tarjeta dice "Today" /
  "Hoy"; con una ventana rodante eso es falso. Cambiar la copy a
  "Last 24 hours" / "Últimas 24 horas" en `lib/i18n/{en,es}.ts`. Es §5.5 del
  proyecto (nada se muestra como algo que no es).
- Grepear **todo** lo que compare fechas de día: `startOfHouseholdDay`,
  `householdToday`, `buildActivity`, cualquier `toDateString`/`slice(0,10)`.
  Cada uso: decidir y documentar si es un resumen (pasa a rodante) o un default
  de campo de fecha (no se toca).
- `SectionPage.tsx:340` lee desde `startOfHouseholdDay(now, 6)`; con `today`
  rodante esa lectura sigue cubriendo la ventana. Verificarlo, no suponerlo.
- **No** implementar el filtro de semanas del bebé.

## Frente 4 — sistema fijo en onzas

- Sale el bloque "Units" de `app/settings/page.tsx` (label, nota y botón).
- `lib/useVolumeUnit.ts` se borra; los consumidores muestran en `'oz'` fijo.
- El tipo `VolumeUnit` **queda** (lo usan `formatVolume` / `unitToMl` y el
  toggle del frente 9).
- **Sin migración de datos**: la base ya guarda ml (hallazgo 3). Decirlo.
- El toggle lb/in de Growth **no se toca**.

## Frente 5 — fuera "Reset milk total"

Grepear `resetPumpingTotal`. Si solo lo usa Settings: borrar el botón, la
función de `lib/db.ts` y sus claves de i18n. Si algún test lo usa, decidir y
documentar.

## Frente 6 — fuera "Solid" de la creación

- Sale el botón Solid de la tarjeta Feeding y la opción `solid` de **todo
  formulario que cree una toma** (dashboard y "Log a past one" de
  `components/SectionPage.tsx`).
- **No** se toca el tipo `'solid'` en `lib/types.ts`, ni su traducción, ni
  `buildActivity`: las filas viejas se siguen viendo en History y en el log.
- **Contar las filas existentes** con `pnpm db:psql`
  (`select count(*) from feedings where feeding_type = 'solid'`) y reportar el
  número.

## Frente 7 — lactancia en curso: ocultar tipos, mostrar offset

En la tarjeta Feeding, **mientras `activeNursing`**:
- se oculta la fila del campo de cantidad + botón Bottle;
- en su lugar, un campo numérico abierto ("empezó hace … minutos") y un botón
  que lo aplica.
- Escribe de verdad: `updateNursing(id, { started_at: <nuevo ISO> })`
  (`lib/db.ts:551`), que es el camino que ya usa la app para corregir una
  sesión (pasa por la cola offline). **No inventar otro.**
- **Acumulativo:** sí. Cada aplicación resta N minutos al `started_at` actual.
- **Validación:** número finito, `> 0`, `<= 240` minutos por aplicación, y el
  `started_at` resultante no puede quedar más de 12 h antes de ahora. Error
  visible en el `Banner` de la página, nunca en silencio.
- El cronómetro tiene que saltar: como la fila se relee, `elapsed()` ya crece.
  **Verificarlo en pantalla, no deducirlo.**

## Frente 8 — sueño en curso: mismo offset

La tarjeta Sleep **no tiene selector de tipo** — no hay nada que ocultar. Se le
agrega el mismo campo de offset mientras `activeSleep`, con la misma
validación, escribiendo con `updateSleep(id, { started_at })` (`lib/db.ts:612`).

## Frente 9 — toggle oz/ml al lado del campo de cantidad

- Un `.seg` visible (el mismo control segmentado de Settings) junto al campo de
  cantidad de Bottle, con `role="radiogroup"` / `role="radio"`.
- **Estado local del componente, no persistido**: vuelve a `oz` cada vez que se
  monta la tarjeta. Es lo que pidió Luis y no hay patrón mejor en la app (los
  demás toggles son preferencias de dispositivo; este es de una entrada).
- Guardado: `unitToMl(valor, unidadElegida)` — ya existe. Ojo: **la base guarda
  ml**, así que "convertir a onzas antes de guardar" se cumple como "la app
  muestra siempre oz"; convertir ml→oz→ml perdería precisión. Documentarlo.
- Redondeo de display: el de siempre, `formatVolume` con 1 decimal.

---

## Tests nuevos (unitarios, `tests/unit/`)

1. `kpiWindows` rodante: cruce de medianoche (una fila de las 23:50 de ayer
   cuenta a las 00:10 de hoy), los dos cambios de horario, y que una fila de
   hace 24 h 1 min ya no cuente. Bajo las 4 TZ (`pnpm test:tz`).
2. Conversión oz↔ml: `unitToMl` / `formatVolume` en los dos sentidos, con
   cantidades de biberón reales (2–8 oz).
3. Offset sobre una sesión activa: 0 minutos (rechazado), decimales,
   aplicaciones repetidas acumulativas, tope de 240, tope de 12 h.
   La función de cálculo/validación va **pura** (p. ej. `shiftStart()` en
   `lib/kpis.ts` o un módulo propio) para poder testearla sin React.

## Verde obligatorio antes de dar nada por hecho

`pnpm exec tsc --noEmit` · `pnpm lint` · `pnpm format:check` · `pnpm build` ·
`pnpm test:all` (el stack local está levantado: `amelia-local-*` en 127.0.0.1).
Y `git diff --stat` mostrando que no se tocó `supabase/migrations/`,
`lib/push/` ni nada de entorno.
