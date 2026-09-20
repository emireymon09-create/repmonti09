# Auditoría inicial — Amelia App

**Fecha:** 20 de septiembre de 2026
**Commit auditado:** `7c72ba2` (rama `batch/pnpm-tests-docs-robustez`)
**Prompt usado:** `docs/prompt-auditoria-codigo.md`
**Alcance:** todo el repo — `app/`, `lib/`, `components/`, `public/sw.js`,
`supabase/migrations/`, configuración y documentación.

> **Regla de este documento: no corrige nada.** Reporta. Los arreglos se hacen
> después, con su propio commit y su propio test. Lo único que ya está corregido
> acá es lo que se marca **CORREGIDO EN ESTE BATCH**, y se dice con qué commit.

Cada hallazgo lleva una marca de evidencia:

- **CONFIRMADO POR TEST** — hay un test ejecutable que lo demuestra. El test se
  nombra.
- **CONFIRMADO POR LECTURA** — se leyó el código y la conclusión es directa,
  pero no hay test.
- **NO VERIFICADO** — sospecha razonable, sin evidencia. Se dice para que nadie
  la lea como un hecho.

---

## Resumen

| Severidad | Cantidad | Abiertos | Cerrados en este batch |
| --- | --- | --- | --- |
| 🔴 CRÍTICO | 2 | 2 | 0 |
| 🟠 ALTO | 5 | 0 | 5 |
| 🟡 MEDIO | 6 | 2 | 4 |
| 🟢 BAJO | 5 | 3 | 2 |

Los dos críticos **siguen abiertos a propósito**: los dos necesitan tablas
nuevas y este repo dejó de numerar migraciones (CLAUDE.md §5.2, ADR 0003). Están
propuestos en `proposals/device-tokens-and-idempotency.md` y tienen un test que
los demuestra hoy.

---

## 🔴 CRÍTICOS

### C1 — `/api/quick/nurse` escribe sobre el bebé más viejo de toda la base

**Dónde:** `app/api/quick/nurse/route.ts:38-47`
**Evidencia:** **CONFIRMADO POR TEST** —
`tests/integration/quick-nurse.test.ts`, describe
_"HALLAZGO: /api/quick/nurse escribe sobre el bebé más viejo de TODA la base"_.

```ts
const { data: babies, error: babyErr } = await supabase
  .from('babies')
  .select('id')
  .order('created_at', { ascending: true })
  .limit(1)
```

El handler corre con `service_role`, que **salta RLS por completo**. El lookup
no filtra por familia: ordena `babies` por `created_at` y toma el primero de
toda la base. Con un solo hogar el resultado es correcto por accidente. Con dos
familias, el secreto de cualquiera de las dos escribe sesiones de lactancia
sobre el bebé de la familia más antigua — y la familia dueña del secreto nunca
recibe nada.

El test siembra dos familias, A primero, llama al endpoint y verifica que la
sesión aterriza en el bebé de A y que B queda en cero.

**Corrección sugerida:** resolver el bebé **desde el token del dispositivo**,
nunca desde "el más antiguo". Requiere tabla nueva ⇒
`proposals/device-tokens-and-idempotency.md` §3.

**Mitigación aplicada mientras tanto:** variable `QUICK_TOGGLE_BABY_ID`, y si no
está seteada el endpoint **falla cerrado** (409) en cuanto hay más de un bebé en
la base, en vez de adivinar. Ver hallazgo A5.

---

### C2 — Un secreto de dispositivo escribe sobre cualquier `baby_id`

**Dónde:** `app/api/ingest/route.ts:19-29`
**Evidencia:** **CONFIRMADO POR TEST** — `tests/integration/ingest.test.ts`,
_"HALLAZGO: un secreto válido escribe sobre el bebé de otra familia"_.

`NUC_DEVICE_SECRET` es uno solo para toda la instalación y el handler corre con
`service_role`. El `baby_id` llega en el body y no se contrasta contra nada:
quien tenga el secreto escribe eventos de monitor y sesiones de sueño sobre el
bebé de cualquier familia de la base.

El test lo demuestra empujando un `sound_alert` con el `baby_id` de la familia B
usando el secreto configurado, y encontrando la fila en `monitor_events` de B.

**Corrección sugerida:** tabla `device_tokens` con `token_hash`, `family_id`,
`baby_id` y `revoked_at`; el endpoint resuelve el bebé desde el token y rechaza
cualquier `baby_id` que no le corresponda. Requiere tabla nueva ⇒
`proposals/device-tokens-and-idempotency.md` §1-§2.

**Nota de alcance:** este hallazgo es también la pregunta abierta n.º 1 de
CLAUDE.md §7 — la `service_role` vive hoy en esta app y la regla del Hub dice
que vive solo en el servidor del Hub. No lo resuelvo acá: es decisión de Emilio
y del agente del Hub.

---

## 🟠 ALTOS

### A1 — La cola offline reportaba de menos lo que le quedaba adentro

**Dónde:** `lib/queue.ts:88`
**Evidencia:** **CONFIRMADO POR TEST** — `tests/unit/queue.test.ts`,
_"cuenta lo que queda en cola aunque antes haya habido un descarte"_.
**CORREGIDO EN ESTE BATCH** — commit `7e82f1a`.

`flushQueue` devolvía `remaining: pending.length - i - dropped`. Restar los
descartes es doble conteo: una entrada descartada ya salió del store y ya quedó
detrás del índice. Con un descarte antes de un fallo, la función devolvía
`remaining: 0` teniendo una escritura real todavía en la cola.

Eso es exactamente lo que CLAUDE.md §5.5 prohíbe: una escritura no guardada
presentándose como si no existiera.

**Atenuante honesto:** hoy nadie lee `remaining` — el único consumidor,
`lib/useSync.ts:39`, mira `sent` y `dropped`. El bug estaba latente, no visible.

---

### A2 — Los secretos de dispositivo se comparaban con `!==`

**Dónde (antes del arreglo):** `app/api/ingest/route.ts:20`,
`app/api/quick/nurse/route.ts:26`
**Evidencia:** **CONFIRMADO POR LECTURA**.
**CORREGIDO EN ESTE BATCH** — `lib/deviceAuth.ts`, commit de la Tarea 8.

`deviceSecret !== process.env.NUC_DEVICE_SECRET` es una comparación de strings
que corta en el primer byte distinto. Contra un atacante con acceso a la red es
un canal de timing. No es el riesgo más grande de este repo —C1 y C2 lo son—
pero es gratis de arreglar.

**Corrección aplicada:** `timingSafeEqual` de `node:crypto`, con el mismo costo
aunque los largos difieran.

---

### A3 — Sin techo de intentos en los endpoints de dispositivo

**Dónde:** los dos route handlers.
**Evidencia:** **CONFIRMADO POR LECTURA**.
**MITIGADO EN ESTE BATCH** — `lib/deviceAuth.ts`, 20 intentos por minuto y por
IP de origen.

**Lo que la mitigación NO arregla, y hay que saberlo:** el contador vive en la
memoria de **ese** proceso. En Vercel, con varias instancias, cada una cuenta por
su lado, y un arranque en frío lo resetea. Es una molestia para el atacante, no
una barrera. La barrera real es el token por dispositivo de C1/C2.

---

### A4 — `await req.json()` sin `catch` en `/api/ingest`

**Dónde (antes del arreglo):** `app/api/ingest/route.ts:24`
**Evidencia:** **CONFIRMADO POR TEST** — `tests/integration/ingest.test.ts`,
_"un body que no es JSON responde 400, no 500"_.
**CORREGIDO EN ESTE BATCH** — `readJson()` en `lib/deviceAuth.ts`.

Un body malformado se convertía en una excepción no atrapada y salía como 500.
Un 500 dice "me rompí yo"; lo correcto es 400, "me mandaste basura".
`/api/quick/nurse:30` ya lo hacía bien (`.catch(() => null)`).

---

### A5 — Cero validación de forma del payload en `/api/ingest`

**Dónde (antes del arreglo):** `app/api/ingest/route.ts:24-29`, `:67-72`
**Evidencia:** **CONFIRMADO POR TEST** — describe _"/api/ingest endurecido"_.
**CORREGIDO EN ESTE BATCH.**

Lo único que se validaba era `if (!baby_id)`. Concretamente faltaba:

- `baby_id` sin chequeo de formato uuid — un string cualquiera llegaba a
  Postgres y volvía como 500.
- `event_type` sin lista blanca, y peor, `event_type ?? 'unknown'` en `:69`: un
  evento sin tipo **se guardaba igual**, como `'unknown'`. Basura silenciosa en
  una tabla que existe justamente para que a la casa no le entre media.
- `meta` jsonb sin tope de tamaño.
- `occurred_at` sin validar: aceptaba el año 1899 o el 3000.
- `kind` sin validar: cualquier valor distinto de `sleep_start`/`sleep_end` caía
  al camino de evento genérico en vez de rechazarse.

---

## 🟡 MEDIOS

### M1 — No existía `middleware.ts`: el guard de auth era solo client-side

**Dónde:** `lib/useBaby.ts:23-45`
**Evidencia:** **CONFIRMADO POR LECTURA** (`find . -name middleware.ts` no
devolvía nada).
**CORREGIDO EN ESTE BATCH** — `middleware.ts`.

Lo que protege los **datos** sigue siendo RLS, y eso nunca estuvo en duda. El
problema era otro: una ruta privada se renderizaba entera y recién después
`useBaby()` rebotaba al login. En una pantalla de pared compartida eso significa
mostrarle el esqueleto de la app a cualquiera que pase. Y toda ruta nueva que se
olvide de usar el hook nace desprotegida.

---

### M2 — `next.config.mjs` no mandaba ninguna cabecera de seguridad

**Dónde:** `next.config.mjs:2-4`
**Evidencia:** **CONFIRMADO POR LECTURA**.
**CORREGIDO EN ESTE BATCH** — `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`.

**CSP queda fuera a propósito.** Next 14 inyecta estilos y scripts inline; una
CSP mal puesta rompe la app en la pared sin que nadie mire la consola. Se
propone como trabajo aparte, con `report-only` primero.

---

### M3 — `growth_measurements` no tiene policy de UPDATE ni columna `voided_at`

**Dónde:** `supabase/migrations/0001_init.sql` (crea la tabla con select+insert),
`0006_edit_and_void.sql` (agrega `voided_at` a cinco tablas, **no a esta**).
**Evidencia:** **CONFIRMADO POR TEST** — `tests/integration/rls.test.ts`,
_"growth_measurements no tiene policy de UPDATE: una medición mal cargada es
permanente"_.
**ABIERTO** — requiere schema ⇒ `proposals/growth-edit-and-void.md`.

Una medición de peso o talla mal cargada no se puede corregir ni retractar desde
la app. El test lo demuestra: el propio dueño de la fila hace un update y
PostgREST devuelve cero filas afectadas, sin error.

`doctor_appointments` está en la misma situación respecto de `voided_at`, pero
sí tiene policy de UPDATE, así que al menos se corrige.

---

### M4 — `families` y `family_members` no tienen policy de INSERT

**Dónde:** `supabase/migrations/0001_init.sql`
**Evidencia:** **CONFIRMADO POR TEST** — `tests/integration/rls.test.ts`,
_"families no tiene policy de INSERT: un usuario no puede crear su propia
familia"_.
**ABIERTO — y probablemente correcto.**

Dar de alta una familia solo se puede por Studio o con `service_role`. Para un
hogar de dos personas eso es razonable, y el README ya manda hacerlo a mano. Lo
que faltaba era que estuviera **dicho como decisión** en algún lado en vez de
ser un efecto colateral. Queda dicho acá y en el README reescrito (T11).

---

### M5 — `README.md` describía una app que no es esta

**Dónde:** `README.md:17`, `:51-53`, y toda la sección "What's not built".
**Evidencia:** **CONFIRMADO POR LECTURA**.
**CORREGIDO EN ESTE BATCH** — Tarea 11.

Tres clases de mentira, todas verificadas:

1. `npm install -g supabase` (`:17`) — npm está prohibido en este repo, y
   Supabase no soporta la instalación global de ese paquete.
2. `cp .env.local.dev .env.local` (`:51`) — **ese archivo no existe**. El que
   existe es `.env.local.example`.
3. Declara "no construido" la PWA, la UI de sueño, la de crecimiento y la cola
   offline. Las cuatro están construidas y funcionando.

---

### M6 — `PROJECT.md` afirmaba cosas falsas

**Dónde:** `PROJECT.md:135`, `PROJECT.md:170-177`
**Evidencia:** **CONFIRMADO POR LECTURA**.
**CORREGIDO EN ESTE BATCH** — Tarea 11.

- `:135` — "Unit-tested under four system timezones". Hasta el 20 sep 2026 **no
  había un solo test en el repo**. Hoy la frase es cierta
  (`tests/unit/format.test.ts`, `pnpm test:tz`), pero lo fue después de este
  batch, no antes.
- `:170-177` — "Editing or retracting a logged entry" en "What's NOT built yet",
  con la coletilla "Still the biggest gap before real use". Existe desde
  `0006_edit_and_void.sql` y está cableado en `lib/db.ts`
  (`updateFeeding`/`voidFeeding` y sus equivalentes para pañales, lactancia,
  sueño y extracción). Lo que sí sigue faltando es `growth_measurements` (M3).

---

## 🟢 BAJOS

### B1 — `durationBetween` redondea: el umbral de "under a minute" son 30 segundos

**Dónde:** `lib/format.ts:118-119`
**Evidencia:** **CONFIRMADO POR TEST** — `tests/unit/format.test.ts`.
**ABIERTO, y posiblemente deseado.**

`Math.round` hace que una sesión de 30 segundos se lea "1 min" y una de 29,
"under a minute". No es un bug —es redondeo normal— pero el nombre de la función
sugiere el umbral en 60 y no está. Queda documentado en el test para que nadie
lo "arregle" por sorpresa.

---

### B2 — `public/sw.js:80` devuelve `/dashboard` cacheado a quien no tiene sesión

**Dónde:** `public/sw.js:80`
**Evidencia:** **CONFIRMADO POR LECTURA**.
**ABIERTO — riesgo bajo, escrito para que no sorprenda.**

El fallback de navegación offline devuelve la shell de `/dashboard` guardada en
caché aunque el visitante no tenga sesión. **No filtra datos**: la shell es
estática, el fetch a Supabase falla sin red y el middleware nuevo (M1) solo
actúa cuando hay red. Lo que se ve es el esqueleto vacío de la app. Es el precio
de que el kiosco abra sin conexión, que es un requisito explícito del proyecto.

`isCacheable` (`public/sw.js:52-58`) sí está bien: descarta todo lo que no sea
same-origin, o sea que **ninguna respuesta de Supabase entra a la caché**, tal
como manda CLAUDE.md §5.5.

---

### B3 — `preview.html` en la raíz, 31 KB, sin referencias desde el código

**Dónde:** `preview.html`
**Evidencia:** **CONFIRMADO POR LECTURA** (`grep -rn preview.html app components lib` sin resultados).
**CORREGIDO EN ESTE BATCH** — movido a `docs/design/preview.html` (Tarea 10).

---

### B4 — Un hex fuera de `app/globals.css` y de `lib/tokens.ts`

**Dónde:** `app/layout.tsx:25` — `themeColor: '#211D1B'`
**Evidencia:** **CONFIRMADO POR LECTURA**.
**ABIERTO.**

El valor es correcto (coincide con `--bg` y con `tokens.colors.bg`), pero está
escrito a mano en un tercer lugar. Si alguna vez cambia el fondo, este se queda
atrás y la barra del navegador del teléfono queda de otro color. Arreglo: leerlo
de `lib/tokens.ts`. No lo toco en este batch porque `metadata` de Next se evalúa
en build y quiero verificar que el import no arrastre nada al cliente antes de
moverlo — **eso no lo verifiqué**.

---

### B5 — `family_members.role` existe y nadie la lee

**Dónde:** `supabase/migrations/0001_init.sql`, columna `role`.
**Evidencia:** **CONFIRMADO POR LECTURA** (`grep -rn "role" lib/ app/` no
devuelve ninguna lectura de esa columna).
**ABIERTO, ya conocido** — CLAUDE.md §6 lo dice. Hoy todos los miembros de una
familia tienen exactamente los mismos permisos. El chequeo de rol es trabajo de
fase 2 y su lugar natural es `lib/useBaby.ts`.

---

## Lo que se revisó y salió limpio

No todo hallazgo vale lo mismo que un "acá no hay nada". Estas verificaciones se
corrieron y no encontraron nada:

| Qué se buscó | Comando | Resultado |
| --- | --- | --- |
| Queries armadas fuera de `lib/db.ts` | `grep -rn "\.from(" app components lib` | Solo `lib/db.ts` y los dos route handlers. Limpio. |
| `any` / `as any` | `grep -rn ": any\|as any" app components lib` | Cero. |
| `console.*` olvidados | `grep -rn "console\." app components lib` | Cero. |
| Secretos con prefijo `NEXT_PUBLIC_` | `grep -rn NEXT_PUBLIC app lib components` | Solo URL y anon key, que son públicas por diseño. |
| `supabaseAdmin` en un `'use client'` | `grep -rn supabaseAdmin app components` | Solo los dos route handlers. |
| Lecturas sin `.is('voided_at', null)` | lectura de `lib/db.ts` | Las cinco tablas que tienen la columna la filtran. `growth_measurements` y `doctor_appointments` no la tienen (ver M3). |
| Hex o px nuevos fuera de `globals.css` | `grep -rnE "#[0-9a-fA-F]{3,8}"` | Solo `lib/tokens.ts` (el espejo autorizado) y B4. |
| RLS habilitada en todas las tablas | lectura de las 6 migraciones | Sí, en las 11. |

---

## Historial de corridas

| Fecha | Commit | Quién | Críticos | Altos | Medios | Bajos |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-20 | `7c72ba2` | Claude Opus 5 | 2 | 5 | 6 | 5 |
