# Plan — countdown, tarjeta de cita, semana de vida + gráficas, calendario .ics

**Fecha:** 24 sep 2026
**Commit base:** `86f9bcf`
**Versión base:** `0.9.0` → destino `0.10.0` (MINOR: hay funcionalidad nueva visible)
**Pedido:** Emilio, 4 frentes, 7 roles secuenciales.

---

## 0. Hallazgos verificados ANTES de diseñar

Regla §0 de `CLAUDE.md`: se verifica contra el código, no contra la doc. Esto
es lo que se encontró, con `archivo:línea`.

### H-1 🔴 El cálculo de "Next feeding" / "Next nap" **NO es hardcodeado**

El pedido dice *"reemplazar el cálculo hardcodeado"*. No hay tal cosa.

- `lib/db.ts:969-995` — `predictNextFeeding(feedings, nursing, sampleSize = 6)`
  **promedia los últimos 6 intervalos** entre eventos de comida y suma ese
  promedio al último evento.
- `lib/db.ts:997-1019` — `predictNextNap(sleep, sampleSize = 6)` promedia las
  últimas 6 **ventanas de vigilia** (fin de un sueño → inicio del siguiente).
- No hay ninguna constante de 2h ni de 3h en el repo:
  `grep -rn "3 \* 60\|hours: 3" app lib components` → 0 resultados.

**Consecuencia que hay que escribir, no esconder:** pasar de "promedio
adaptativo de los últimos 6 huecos" a "umbral fijo configurable" es un
**cambio de comportamiento real**, no un reemplazo de un placeholder. La
predicción vieja se autocorregía sola en uno o dos días tras un estirón; la
nueva no. A cambio, es la que el padre puede configurar y es la que puede
disparar una notificación (un promedio no tiene sentido como umbral de alerta:
"llegó al promedio" no es una condición de aviso, es una estadística).
Se implementa lo pedido y se deja esta nota en `CLAUDE.md` §6.

### H-2 `predictNextFeeding` mide desde el **inicio**, no desde el fin

`lib/db.ts:981` ordena por `f.fed_at` y `n.started_at`. Y `lib/kpis.ts:206-208`
lo dice explícito: *"A session is placed at its start — when the feeding
began, which is also what the next-feeding prediction measures from."*

**Decisión (el pedido pedía confirmarla con evidencia):** la ventana nueva se
mide desde el **fin del último evento de comida de cualquier tipo**:

| Tipo de fila | Instante que cuenta como "fin" | Por qué |
|---|---|---|
| `feedings` (bottle / solid / nursing-typed) | `fed_at` | Es un evento puntual: no tiene fin separado. La columna es una sola. |
| `nursing_sessions` terminada | `ended_at` | Una toma de 40 min no vence 3 h después de *empezar*. |
| `nursing_sessions` **en curso** | no vence nada | Está comiendo ahora. Ver H-3. |

Y **de cualquier tipo**, no solo pecho: la pregunta que contesta la tarjeta es
"¿cuándo le toca comer?", y un biberón de 120 ml la contesta igual que una
toma. `lastFeedingEvent` (`lib/kpis.ts:209-229`) ya trata las dos tablas como
una sola fuente para la línea de la tarjeta; esto usa el mismo criterio, con la
única diferencia del instante (fin en vez de inicio).

### H-3 El ocultamiento durante una lactancia en curso **ya existe** — no se toca

`app/dashboard/page.tsx:651` — la línea va dentro de
`{!activeNursing && feedingPrediction.dueAt && (…)}`. Lo mismo el nap en
`:818` dentro de `{!activeSleep && (…)}`. **Se preserva tal cual.** No se
redescubre a los golpes: está verificado.

### H-4 No hay librería de gráficas, ni de íconos

`package.json` — 6 dependencias de runtime: `@supabase/ssr`,
`@supabase/supabase-js`, `next`, `react`, `react-dom`, `web-push`. **Ninguna
de gráficas.** Las gráficas de `/statistics` se dibujan con **SVG inline**, con
la misma convención que los 13 íconos de `components/ui.tsx` (grilla propia,
`stroke="currentColor"`, `fill="none"`) y con colores de token, nunca hex.

### H-5 `babies.birth_date` existe y es **nullable**

`supabase/migrations/0001_init.sql:30` — `birth_date date` (sin `not null`).
`lib/types.ts:25` — `birth_date: string | null`. `lib/db.ts:403` —
`recordBirth()` existe para cargarla.

**Consecuencia:** la "semana de vida" **no siempre se puede calcular**. Sin
`birth_date` el filtro no tiene sentido y no se puede inventar uno. El filtro
cae a un estado explícito que dice que falta la fecha de nacimiento y dónde se
carga — no a "semana 1" por las dudas (§5.4: no afirmar un hecho falso).

### H-6 `families` solo tiene policy de `select`

`supabase/migrations/0001_init.sql:157` — `create policy "select own family"`,
y no hay ninguna de `insert`/`update`/`delete` sobre esa tabla en ninguna
migración. Por eso el token del calendario **no puede ser una columna de
`families`**: un padre no podría escribirla, y la fase 2 reemplaza `families`
por `core.households` (`PROJECT.md`, "What changes when the shared backend
lands"). Va en una tabla propia, scope `family_id` **directo**.

### H-7 `lib/db.ts` es `'use client'` — el `.ics` no puede llamarlo

`lib/db.ts:1` es `'use client'` y usa el cliente anon del navegador
(`lib/supabaseClient.ts`). Un route handler público, sin sesión, que lee las
citas de una familia identificada por un token, **no puede** pasar por ahí.

**El pedido dice** *"El route handler solo llama a `lib/db.ts` — no arma su
propio `.from(...)`"*. La primera mitad es imposible con el código real; la
segunda se cumple **entera**. Se usa el precedente ya acordado de `CLAUDE.md`
§5.3: las queries de servidor del push viven en `lib/push/server.ts` por
exactamente esta razón. Las del calendario viven en **`lib/calendar/server.ts`**,
server-only, y el route handler no arma ninguna query. Esta desviación del
pedido se reporta, no se elige en silencio.

### H-8 `docs/seguridad-operacional.md` §8 miente sobre el deploy

`docs/seguridad-operacional.md:210` — *"Todavía no hay deploy (Vercel está
previsto, no hecho)"*. Es **falso** desde el 22 sep 2026: `CLAUDE.md` §2.1 y
`PROJECT.md` documentan el deploy en Vercel con auto-deploy verificado. Hallazgo
de doc contra código, fuera del alcance de los 4 frentes. Se corrige en el rol
DOCUMENTADOR.

### H-9 El techo de intentos es compartido y no se resuelve acá

`lib/deviceAuth.ts` — 20 intentos por minuto y por IP, compartido por
`/api/ingest`, `/api/quick/nurse` y `/api/push/nursing-check` (`CLAUDE.md` §7,
pregunta 4). Ver la decisión D-2: **no se agrega ningún consumidor nuevo.**

---

## 1. Decisiones de diseño (con su motivo, criterio de §7.6)

### D-1 · Los umbrales son un dato de familia, en una tabla nueva

No es `localStorage` como Theme/Language: los dos padres tienen que ver el
mismo número, y el **servidor** necesita leerlo para decidir si manda el aviso
— `localStorage` no existe del lado del servidor. Migración **`0012`**, tabla
`family_settings`, scope `family_id` **directo** (fase 2, `CLAUDE.md` §5.3),
RLS + GRANT en la misma migración (bug de 0005).

### D-2 · Un solo endpoint de check, no cuatro — y **ningún cron nuevo**

Se extiende `/api/push/nursing-check` con los tres checks nuevos (comida
vencida, siesta vencida, cita en 24 h). **No se crean endpoints nuevos ni jobs
nuevos.** Motivos, en el mismo formato con que §7.6 eligió `pg_cron` sobre
Vercel Cron:

- **El techo de intentos es por IP, no por endpoint** (H-9). Cuatro endpoints
  llamados por minuto desde la misma IP gastan 4 de las 20, contra 1. Con el
  NUC detrás de la misma IP eso empieza a dar 429 (`CLAUDE.md` §7, pregunta 4).
- **`0011` ya está escrita y en camino a aplicarse en la nube** con el jobname
  `nursing-check`, la URL en Vault y el token de scope `push_check`. Un endpoint
  nuevo = un secreto nuevo en Vault + un job nuevo + otra corrida manual de
  Luis. Cero de eso hace falta.
- **No se edita `0011`** (es historia, §5.2) y no se necesita.
- **Costo:** el nombre `nursing-check` queda histórico y ya no describe todo lo
  que hace. Se documenta en el encabezado del handler y en `CLAUDE.md` §6. Se
  prefiere un nombre desactualizado y documentado a una pieza de
  infraestructura nueva que Luis tiene que aplicar a mano en producción.

**Consecuencia para la nube:** el único paso manual nuevo es **aplicar la
migración `0012`**. Ni Vault, ni cron, ni variables de entorno nuevas.

### D-3 · La repetición del aviso cada ~30 min se marca en `family_settings`

El aviso de toma larga se marca por sesión (`nursing_sessions.long_alert_sent_at`).
Acá no hay fila que marcar: "no comió" no es una fila. La marca va en
`family_settings` (`feed_alert_sent_at`, `nap_alert_sent_at`) y la regla pura es:
se avisa si está vencido **y** (nunca se avisó **o** el último aviso es de hace
≥ 30 min **o** hubo un evento nuevo después del último aviso — eso reinicia el
ciclo). Igual que el resto del push, la parte que decide es **pura y sin base**
(`lib/push/schedule.ts`), y lo que toca la base y la red va en
`lib/push/server.ts`.

### D-4 · La semana de vida NO es la ventana `week` de `lib/kpis.ts`

`kpiWindows().week` (`lib/kpis.ts:49`) es "hoy + los 6 días de calendario
anteriores" y alimenta la tarjeta larga de las tres secciones. La **semana de
vida** es la semana 1, 2, 3… desde `babies.birth_date`. Conviven, y el filtro
nuevo **sustituye** la tarjeta de "Last 7 days" en `/feeding`, `/diapers` y
`/sleep` (era el pedido). Sobre la pregunta abierta §7.7 de `CLAUDE.md`
(*"¿la ventana de 7 días también tiene que ser rodante?"*): **este cambio la
vuelve moot para las tres páginas de sección** —esa tarjeta deja de existir
ahí— pero **no** para `lib/kpis.ts`, donde `week` sobrevive como función pura.
Se anota así en §7, no se cierra.

### D-5 · El token del calendario: hash en base, rotable, y sin login por decisión

Mismo espíritu que `device_tokens` (`0007`): la base guarda **solo el
sha-256**, el valor en claro se muestra una vez. Tabla propia `calendar_feeds`
(H-6), con `rotated_at`. **Rotar = generar uno nuevo, que pisa la fila y deja
muerto el link viejo en el acto** — que es lo que hace falta si alguien
comparte el link sin querer. Se documenta en Settings, en la pantalla, no solo
en un .md.

**Sin login, la URL es el único control de acceso.** Es una decisión de
producto explícita, no una omisión: un cliente de calendario (iOS, Google,
Thunderbird) suscrito a un feed no manda credenciales. Qué queda expuesto para
quien tenga la URL: **título, tipo, hora, doctor y notas de los turnos médicos**
de esa familia. Nada de tomas, pañales, sueño, peso ni nombres de los padres.
Se escribe en `CLAUDE.md` y en `PROJECT.md`.

---

## 2. Alcance

### FRENTE 1 — Countdown de comida/siesta + alertas configurables
1. `0012` — `family_settings`: `nap_threshold_minutes` (default 120),
   `feed_threshold_minutes` (default 180), `feed_alert_sent_at`,
   `nap_alert_sent_at`. RLS + GRANT explícitos.
2. `lib/schedule.ts` — **puro**: `lastFeedingEnd()`, `lastNapEnd()`,
   `nextDue()`, `dueState()`. Sin reloj propio ni base.
3. `lib/db.ts` — `familySettings()` / `updateFamilySettings()`.
4. `app/dashboard/page.tsx` — reemplaza `predictNextFeeding`/`predictNextNap`
   por el countdown real. **Se preserva H-3.**
5. `app/settings/page.tsx` — los dos umbrales, como dato de familia.
6. `lib/push/schedule.ts` (puro) + el check en `lib/push/server.ts`.

### FRENTE 2 — Tarjeta de próxima cita + recordatorio 24 h
1. `0012` — `doctor_appointments.reminder_sent_at`.
2. `lib/schedule.ts` — `nextAppointment()` puro, ventana de 36 h.
3. `app/dashboard/page.tsx` — `Card spanAll` **debajo** de las tres. Se agrega,
   no reemplaza.
4. `lib/push/server.ts` — el check de 24 h, marca de una sola vez.

### FRENTE 3 — Semana de vida + gráficas
1. `lib/lifeWeek.ts` — **puro**: `lifeWeekOf()`, `lifeWeekRange()`,
   `lifeWeeksSince()`. En la TZ del hogar.
2. `components/SectionPage.tsx` — el selector sustituye a "Last 7 days".
3. `app/statistics/page.tsx` — cuatro tarjetas (feeding, diaper, sleep,
   growth): KPIs de la semana arriba, gráfica abajo.
4. `components/Chart.tsx` — barras y línea, SVG inline, tokens.

### FRENTE 4 — Calendario .ics
1. `0012` — `calendar_feeds`.
2. `lib/calendar/ics.ts` — **puro**: generación de VCALENDAR, escapado RFC 5545.
3. `lib/calendar/server.ts` — server-only (H-7).
4. `app/api/calendar/[token]/route.ts` — solo llama a `lib/calendar/server.ts`.
5. `app/api/calendar/feed/route.ts` — generar/rotar, con la **sesión del padre**
   (`lib/supabaseRoute.ts`, RLS), nunca `service_role`.
6. `app/settings/page.tsx` — el control.

---

## 3. Fuera de alcance — SIN EXCEPCIÓN (copiado del pedido)

- Tocar el proyecto Supabase de la nube o sus secretos directamente.
- Variables de entorno en el panel de Vercel.
- `git push` a `main` sin confirmación explícita de Emilio, incluso con todo
  verde.
- Editar una migración ya aplicada (`0001`…`0011` son historia — §5.2).
- Aplicar algo en producción. Programar/extender la lógica local sí;
  aplicarla allá no (eso es un `docs/aplicar-en-la-nube.md` nuevo).
- La Parte 1 del pedido original (verificar/aplicar 0009-0011 en la nube): ya
  resuelta en `docs/aplicar-en-la-nube.md`, la corre Luis a mano.
- Resolver el techo de intentos de `lib/deviceAuth.ts` (H-9, §7 pregunta 4).
- Crear otro repo de GitHub o un segundo proyecto Supabase (§5.6).

---

## 4. Reglas duras que aplican a todo (de `CLAUDE.md`)

pnpm y solo pnpm · una sola puerta a la base (`lib/db.ts`, con la excepción
server-only de `lib/push/server.ts` y `lib/calendar/server.ts`) · ids del
cliente con `newId()` · borrado lógico `voided_at` y toda lectura nueva filtra
`.is('voided_at', null)` · nunca `supabaseAdmin` en un `'use client'` · nunca
un secreto con `NEXT_PUBLIC_` · ninguna tabla nueva con scope por join de
`baby_id` · **todo texto visible** por `lib/i18n/en.ts` + `es.ts` · ningún hex
ni px fuera de `app/globals.css` (+ espejo `lib/tokens.ts`) con su variante de
pared a 1180px · honestidad de estado offline (§5.5) · bump MINOR + CHANGELOG
en el último commit antes de cualquier push · commits en imperativo inglés, una
línea, sin prefijo.

---

## 5. Roles

| # | Rol | Entregable |
|---|---|---|
| 1 | PLAN | este archivo |
| 2 | IMPLEMENTADOR ×4 | los 4 frentes |
| 3 | FRONTEND/DISEÑO | `impeccable` adapt / audit / polish sobre dashboard, Settings, Statistics, las 3 secciones |
| 4 | QA/TESTER | stack real: `pnpm db:up` + `pnpm build && pnpm start`, datos sembrados, cada frente de punta a punta |
| 5 | AUDITOR | las 10 secciones de `docs/prompt-auditoria-codigo.md`, con `archivo:línea` y marca de evidencia |
| 6 | REVISOR | cierra o deja anotado cada hallazgo, con motivo |
| 7 | DOCUMENTADOR | `CLAUDE.md` §6/§7, `PROJECT.md`, `design.md`, `CHANGELOG.md`, `docs/aplicar-en-la-nube-0012.md`, `.env.local.example` si hiciera falta (no se espera: D-2 no agrega variables) |
