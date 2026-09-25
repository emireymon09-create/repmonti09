# Auditoría — countdown, cita, semana de vida y feed de calendario

**Fecha:** 24 sep 2026
**Commit auditado:** `86f9bcf` + el árbol de trabajo sin commitear del pase del
24 sep 2026 (`git status` al empezar: 13 archivos modificados, 11 nuevos).
**Auditor:** Claude Opus 5 (1M context). **No se corrigió nada.**

**Alcance — solo lo que cambió en este pase.**

Nuevos: `supabase/migrations/0012_schedule_appointments_calendar.sql`,
`lib/schedule.ts`, `lib/lifeWeek.ts`, `lib/push/schedule.ts`,
`lib/calendar/ics.ts`, `lib/calendar/server.ts`,
`app/api/calendar/[token]/route.ts`, `app/api/calendar/feed/route.ts`,
`components/Chart.tsx`, `components/WeekPicker.tsx`,
`tests/unit/schedule.test.ts`.

Tocados: `lib/db.ts`, `lib/types.ts`, `lib/push/server.ts`, `lib/i18n/en.ts`,
`lib/i18n/es.ts`, `app/globals.css`, `app/dashboard/page.tsx`,
`app/settings/page.tsx`, `app/statistics/page.tsx`,
`components/SectionPage.tsx`, `app/api/push/nursing-check/route.ts`,
`tests/unit/i18n.test.ts`, `tests/integration/push.test.ts`.

Fuera de alcance: todo lo anterior al pase, salvo cuando un archivo nuevo lo
contradice.

---

## Resumen por severidad

| | Cantidad |
| --- | --- |
| 🔴 CRÍTICO | **0** |
| 🟠 ALTO | **3** |
| 🟡 MEDIO | **9** |
| 🟢 BAJO | **14** |

**El titular:** el aislamiento entre familias del feed `.ics` —la pieza más
riesgosa del pase, `service_role` sin sesión— **está bien hecho y se verificó
de punta a punta contra el stack local con dos familias sembradas a mano**. No
hay hallazgo crítico. Lo que sí hay es una tanda de mentiras chicas: el texto
de dos de los tres avisos push nuevos dice un número falso, `/statistics`
dibuja ceros cuando no pudo leer, y la marca de "ya avisé" se escribe sin
mirar si se escribió.

---

## 🟠 ALTO

### A-1 · El aviso de comida y el de siesta dicen un número que es falso

**Dónde:** `lib/push/server.ts:621` y `lib/push/server.ts:657`;
`lib/i18n/es.ts:483-487`; `lib/i18n/en.ts` (`push.feedingOverdue.body`,
`push.napOverdue.body`).

**Evidencia:** CONFIRMADO POR LECTURA, con el apoyo de
`tests/unit/schedule.test.ts:111` ("pasado el umbral, los minutos quedan
NEGATIVOS y marca overdue").

El payload se arma así:

```ts
minutesOverdue: Math.abs(feedDue.minutesLeft),   // lib/push/server.ts:621
```

y `minutesLeft` es, por `nextDue` (`lib/schedule.ts:149`),
`round((endedAt + umbral − now) / 60000)`. Cuando está vencido es negativo, y
su valor absoluto son **los minutos que pasaron desde que venció**, no los
minutos desde el último evento.

El texto que recibe ese número dice otra cosa:

- `lib/i18n/es.ts:484` — `'Hace {minutes} min que {name} no come — …'`
- `lib/i18n/es.ts:487` — `'{name} lleva {minutes} min despierta — …'`
- `en.ts` — `'{name} hasn't eaten in {minutes} min'`,
  `'{name} has been awake {minutes} min'`

**Qué pasa:** con el umbral por defecto de 180 min y la comida vencida hace 5
minutos, el teléfono dice **"Hace 5 min que Amelia no come"**. Hace 185. Es la
clase exacta de afirmación que §5.5 prohíbe, y llega como notificación a las 3
de la mañana, que es cuando menos margen hay para dudar de lo que se lee. Y no
es un redondeo: el error crece con el umbral.

**Corrección sugerida:** o el payload manda los minutos desde el evento
(`round((now − Date.parse(last.endedAt)) / 60000)`, que ya está a mano en
`lastFeed.endedAt` / `lastNap.endedAt`), o el texto pasa a hablar del atraso
("se pasó por {minutes} min de lo que configuraste"). Lo primero es lo que el
copy actual promete; lo segundo es lo que el número actual significa. Cualquiera
de las dos, pero no la mezcla de hoy. Un test de `overdueFeedingPayload` con
umbral 180 y 5 min de atraso lo fijaría.

---

### A-2 · `/statistics` dibuja ceros cuando no pudo leer — y su propio encabezado dice que no lo hace

**Dónde:** `app/statistics/page.tsx:24-26` (el comentario),
`app/statistics/page.tsx:77` (`EMPTY`), `:115` (`keepLastGood(EMPTY, …)`),
`:220` (el banner) y `:226-264` (los KPIs).

**Evidencia:** CONFIRMADO POR LECTURA.

El encabezado del archivo dice, textual:

> Como el resto de la app: si la lectura falla, no se dibuja un cero — se dice
> que no se pudo leer (§5.5). Un cero inventado en una pantalla de estadísticas
> es exactamente la clase de mentira que §5.4 no permite.

El código hace lo contrario. `keepLastGood` se llama con `EMPTY` como base
(`:115`), así que **esta pantalla nunca tiene "últimas filas buenas"**: si la
lectura falla, `rows` queda en `EMPTY` y los `StatCard` se renderizan igual con
`String(feeding.total)` → `"0"`, `t('stats.dailyAverage')` → `"0.0"`, y
`sleepKpis(...).sleptMs` → `"0m"`. El banner de `:220` aparece **al lado** de
esos ceros, no en lugar de ellos.

Tres agravantes:

1. **Es una pantalla que se abre sin conexión a propósito.** Está en
   `lib/offlinePages.ts:21` y en el `PRECACHE` de `public/sw.js:36`. Pero **no
   usa `lib/lastSeen.ts`** —ninguna `seenKey`, ningún `SeenNote`—, así que
   offline no hay copia guardada que mostrar: hay ceros.
2. **Antes de que termine la primera lectura también son ceros.** `rows`
   arranca en `EMPTY` (`:84`) y no hay estado de carga propio: el `if (loading)`
   de `:125` es el de `useBaby`, no el de las cinco lecturas. `reading` (`:86`)
   solo se usa para **esconder** el banner (`:220`), no para esconder los
   números.
3. El banner queda además **oculto mientras `reading` es true**, así que
   durante un reintento se ven ceros sin ninguna advertencia.

**Corrección sugerida:** el patrón que ya usan `/growth`, `/history` y
`/dashboard`: `lastGood`/`seenKey` de `lib/lastSeen.ts` + `SeenNote`, y cuando
no hay nada guardado, el estado explícito "sin conexión, nada guardado en este
dispositivo" en vez de los `StatCard`. Como mínimo, no renderizar los KPIs
mientras `error !== null` o la primera lectura no haya vuelto.

---

### A-3 · La marca "ya avisé" se escribe sin mirar si se escribió → el aviso puede repetirse cada minuto

**Dónde:** `lib/push/server.ts:738-752` (`markAlert`), llamada desde `:635` y
`:668`.

**Evidencia:** CONFIRMADO POR LECTURA.

```ts
async function markAlert(db, familyId, patch): Promise<void> {
  await db.from('family_settings').upsert(
    { family_id: familyId, ...patch, updated_at: new Date().toISOString() },
    { onConflict: 'family_id' },
  )
}
```

El `upsert` devuelve `{ error }` y **nadie lo mira**. La función es `void`, no
hay campo en `ScheduleCheckResult` que lo reporte, y `runScheduleChecks` ya
marcó `result.feeding = 1` antes de llamarla (`:634-635`).

**Qué pasa:** si ese `upsert` falla —un GRANT que no se aplicó igual en la nube,
un error transitorio, un timeout— el aviso **salió** pero
`feed_alert_sent_at` sigue en `null`. `shouldAlert` (`lib/push/schedule.ts:67`)
devuelve `send: true` sin condiciones cuando `lastAlertAt` es `null`, así que el
próximo check —**un minuto después**, por `pg_cron`— vuelve a mandarlo. Y el
siguiente. El `tag` hace que la notificación reemplace a la anterior en la
bandeja, pero el teléfono vibra igual cada minuto mientras el vencimiento siga
abierto.

Contrasta con el camino de la toma larga, que sí se cuida: `runNursingCheck`
marca con un `update … is('long_alert_sent_at', null) … select()`
(`lib/push/server.ts:308-318`) y **devuelve la marca** si no llegó a nadie
(`released`, `:380`).

**Corrección sugerida:** devolver el error del upsert y reportarlo en
`ScheduleCheckResult` (`markFailed: boolean`), o —mejor— hacer la marca
condicional como en D-1 de abajo, que resuelve los dos problemas juntos.

---

## 🟡 MEDIO

### M-1 · La marca de comida/siesta no es atómica: dos checks a la vez mandan dos avisos

**Dónde:** `lib/push/server.ts:553-566` (la lectura de `family_settings`),
`:616-635` y `:652-668` (mandar y después marcar).

**Evidencia:** CONFIRMADO POR LECTURA.

El flujo es *leer → decidir → mandar → marcar*, con la marca en un `upsert`
incondicional (`markAlert`). No hay nada equivalente al
`is('long_alert_sent_at', null)` del WHERE que usa la toma larga, y el propio
comentario del bloque de citas (`:672-675`) invoca ese patrón como el correcto.

Dos corridas solapadas —`pg_cron` cada minuto con una corrida lenta, o alguien
que llame el endpoint a mano mientras el cron corre; el token de scope
`push_check` sirve para las dos cosas— leen las dos `feed_alert_sent_at: null`,
las dos mandan, y las dos marcan. Dos notificaciones.

El impacto visible es menor que el de A-3 (el `tag` colapsa las dos en una sola
entrada de la bandeja), pero son dos vibraciones y dos envíos pagados.

**Corrección sugerida:** reclamar la marca **antes** de mandar, con un solo
statement:
`update family_settings set feed_alert_sent_at = now where family_id = … and (feed_alert_sent_at is null or feed_alert_sent_at <= now − 30 min) returning family_id`,
y mandar solo si volvió una fila; si no llegó a nadie, devolverla a su valor
anterior como hace `released`. Necesita que la fila exista, así que conviene
crearla con un upsert vacío al principio del check (o un
`insert … on conflict do nothing`).

---

### M-2 · Con dos bebés en la familia, el countdown del push los mezcla y nombra al primero

**Dónde:** `lib/push/server.ts:539-550` y `:574-590`.

**Evidencia:** CONFIRMADO POR LECTURA.

```ts
let babiesQuery = db.from('babies').select('id, name').eq('family_id', identity.familyId)
if (identity.babyId) babiesQuery = babiesQuery.eq('id', identity.babyId)
…
const babyIds = babies.map((b) => b.id)
const babyName = babies[0].name          // ← lib/push/server.ts:549
```

y después las tres lecturas son `.in('baby_id', babyIds)` (`:578`, `:584`,
`:590`). Con un token de familia **sin** `baby_id` y dos bebés:

- `lastFeedingEnd` recibe las filas de **los dos** bebés, así que una toma del
  hermano reinicia el countdown del otro;
- el aviso que sale nombra siempre a `babies[0]`, que es el primero que
  devuelva PostgREST sin `order` explícito.

No cruza de familia (eso está bien cerrado), pero afirma algo falso sobre un
bebé concreto.

Es además **incoherente con los dos precedentes del repo**:
`resolveBabyForDevice` **falla cerrado** con 409 en ese mismo escenario
(`lib/deviceAuth.ts:137-143`), y `runNursingCheck` —en el mismo archivo— arma un
`Map` de id→nombre y resuelve el nombre por sesión
(`lib/push/server.ts:301,335`).

**Corrección sugerida:** iterar por bebé (un countdown y un aviso por bebé, con
su nombre), o fallar cerrado como `resolveBabyForDevice`. Hoy hay una sola
familia con un solo bebé, así que no arde — pero la forma que queda escrita es
la que se copia.

---

### M-3 · El link del calendario se arma con el host del pedido: en un deployment de preview nace roto

**Dónde:** `app/api/calendar/feed/route.ts:49-52`.

**Evidencia:** CONFIRMADO POR LECTURA.

```ts
const url = new URL(`/api/calendar/${issued.token}.ics`, req.nextUrl.origin).toString()
```

El comentario lo justifica ("así el link que se copia es el del host por el que
entraron, y no hace falta una variable nueva en Vercel"). Pero `CLAUDE.md`
§2.1 ya advierte lo contrario para el cron:

> La de cada deployment (`amelia-<hash>-emireymon09-create.vercel.app`) cambia
> en cada push y **no sirve** para el cron de §7.6.

Un calendario suscrito es todavía peor que el cron: es un link que alguien pega
en iOS o en Google Calendar y **no vuelve a mirar**. Si se generó desde una URL
de deployment, deja de resolver en el próximo push y el calendario simplemente
se queda con los turnos viejos, sin avisar. El token seguiría siendo válido: lo
que muere es el host.

**Corrección sugerida:** armarlo contra el host canónico
(`https://amelia-app.vercel.app`, o una env `NEXT_PUBLIC_APP_ORIGIN`), y caer al
origen del pedido solo si no está definida. O, como mínimo, dejar escrito en la
pantalla que el link hay que sacarlo desde el dominio estable.

---

### M-4 · Los umbrales se guardan en `onBlur` aunque no hayan cambiado y aunque la lectura no haya vuelto

**Dónde:** `app/settings/page.tsx:180-181` (los estados arrancan en el default),
`:186-203` (la lectura), `:219-241` (`commit`), `:267` y `:292` (los `onBlur`).

**Evidencia:** CONFIRMADO POR LECTURA.

Tres problemas encadenados:

1. **Arranca mostrando el default.** `useState(String(DEFAULT_FAMILY_SETTINGS.…))`
   pinta 180 / 120 antes de saber qué tiene la familia guardado. Si el valor
   real es 210 y alguien toca el campo y lo deja (un `focus` + `blur` sin
   escribir nada) mientras la lectura todavía viene en camino, `commit` manda
   **180** y pisa el 210. Sin conexión eso tarda ~7 s, que es tiempo de sobra.
2. **`onBlur` guarda siempre**, haya cambiado el valor o no. No hay comparación
   contra lo último leído.
3. **Al guardar un campo se manda el otro sin validar:**
   `app/settings/page.tsx:237-238`

   ```ts
   feed_threshold_minutes: which === 'feed' ? minutes : Number(feed),
   nap_threshold_minutes:  which === 'nap'  ? minutes : Number(nap),
   ```

   `checkThreshold` corrió sobre `minutes` nada más. Si el otro campo quedó
   vacío, `Number('')` es `0`, el CHECK de `0012` lo rechaza y lo que ve el
   usuario es `settings.thresholdCouldNotSave` con el texto crudo de Postgres —
   justo lo que el comentario de `:221-222` dice que se está evitando.

**Corrección sugerida:** no guardar si el valor es igual al último leído;
bloquear el commit hasta que la lectura haya vuelto (un `loaded` como el que ya
tiene `CalendarFeedSettings`); y correr `checkThreshold` sobre los dos valores
antes de mandar.

---

### M-5 · El botón del feed puede reemplazar un link vivo sin el `window.confirm`

**Dónde:** `app/settings/page.tsx:409` (`onClick={() => issue(Boolean(info))}`),
`:318-323` (la lectura que setea `info`), `:330-332` (el confirm).

**Evidencia:** CONFIRMADO POR LECTURA.

`rotate` sale de `Boolean(info)`, y `info` es `null` en dos casos que no son
"no hay feed":

- **mientras la lectura de `calendarFeed()` todavía no volvió** — el botón no
  está deshabilitado por eso (`disabled={!familyId || busy}`, `:409`; `loaded`
  solo gobierna el texto de `:397`);
- **si esa lectura falló** — `:321` setea `err` y **deja `info` en `null`**.

En los dos casos el botón dice "Create the link", no pide confirmación, y
manda `rotate: false`. Pero el servidor pisa la fila igual: `family_id` es la
PK de `calendar_feeds` y `issueCalendarToken` hace un `upsert`
(`lib/calendar/server.ts:89-97`) — el propio comentario de la ruta lo dice:
*"`rotate` no cambia lo que hace el servidor"*. **El link viejo muere sin que
nadie haya confirmado nada**, y todo calendario suscrito deja de recibir turnos
en silencio (un feed que 404 no avisa a nadie).

Segundo efecto del mismo `Boolean(info)`: con `rotate: false` el servidor
tampoco escribe `rotated_at` ni limpia `last_fetched_at`
(`lib/calendar/server.ts:94`), así que la pantalla va a seguir diciendo "Link
created hace 3 meses" sobre un token que nació recién.

**Corrección sugerida:** deshabilitar el botón hasta `loaded`, y tratar el error
de lectura como "no sé si hay uno" (pedir confirmación igual) en vez de como
"no hay". Y decidir `rotate` en el servidor (`select … then upsert`) en vez de
confiar en lo que la pantalla cree.

---

### M-6 · Un cuarto route handler con `service_role`, público y sin techo de intentos

**Dónde:** `app/api/calendar/[token]/route.ts:2,35`.

**Evidencia:** CONFIRMADO POR LECTURA + CONFIRMADO POR PRUEBA (ver la tabla de
limpios: dos familias sembradas, cada feed devolvió solo lo suyo).

El aislamiento **está bien**: la familia sale del token y solo del token
(`lib/calendar/server.ts:139-145`), las citas se filtran por los bebés de esa
familia (`:147-161`), y un token mal formado, uno inexistente y un `family_id`
puesto como token dan los tres 404. Eso no es el hallazgo.

El hallazgo es lo que queda alrededor:

- **No pasa por `authenticateDevice`**, así que no tiene el techo de 20 intentos
  por minuto y por IP que sí tienen `/api/ingest`, `/api/quick/nurse` y
  `/api/push/nursing-check` (`lib/deviceAuth.ts`). Es el **único** endpoint del
  repo con `service_role` y sin ningún límite. Un token válido además dispara
  un `UPDATE` (`last_fetched_at`, `lib/calendar/server.ts:166-169`) por cada
  GET: escritura no autenticada, amplificada.
- `docs/manual-buenas-practicas.md` §2 dice de los handlers con `service_role`:
  *"Los route handlers de `app/api/*` son la excepción que ya existe, y **no se
  amplía**"*. Esta es la cuarta y la regla no se tocó.

Con 256 bits de token la fuerza bruta no es el riesgo; el desgaste de la base y
la regla escrita sin actualizar sí.

**Corrección sugerida:** un techo por IP para esta ruta (aunque sea el mismo
`Map` de `lib/deviceAuth.ts`, con sus límites conocidos de §7.4), y escribir
`last_fetched_at` con granularidad (solo si el anterior es de hace más de X
minutos). Y, o se actualiza la frase del manual, o se argumenta por qué esta
excepción sí entra.

---

### M-7 · Elegir una semana de vida vieja lee todas las filas desde esa semana hasta hoy

**Dónde:** `components/SectionPage.tsx:374-381`;
`app/statistics/page.tsx:101-112`.

**Evidencia:** CONFIRMADO POR LECTURA.

```ts
const since = weekStart && weekStart < dayStart ? weekStart : dayStart
```

`since` es un piso, no una ventana: `feedingsSince` / `nursingSince` /
`diapersSince` / `sleepSince` no tienen `limit` (a propósito, y bien) y no
tienen tope superior. Elegir la semana 1 de un bebé de seis meses trae **seis
meses** de filas al teléfono para dibujar siete barras. Lo mismo en
`/statistics`, que además lo hace en cuatro tablas a la vez.

No es un bug de corrección —los totales salen bien— pero es exactamente el caso
que la app declara importante: teléfono, wifi malo, de madrugada.

**Corrección sugerida:** un `lte` por el otro extremo en las lecturas `*Since`
(o una variante `*Between`), que es una línea por función en `lib/db.ts` y no
rompe a ningún llamador actual.

---

### M-8 · La documentación describe una app que este pase dejó de ser

**Dónde:** varios.

**Evidencia:** CONFIRMADO POR LECTURA
(`grep -n "^### 5\." CLAUDE.md`, `sed -n '160,182p;224,236p' PROJECT.md`,
`grep -n '"version"' package.json`, `head -7 CHANGELOG.md`).

| Qué dice la doc | Qué dice el código |
| --- | --- |
| `supabase/migrations/0012_…sql:101` y `app/api/calendar/[token]/route.ts:10` citan **`CLAUDE.md` §5.8** como el lugar donde está escrita la decisión del feed sin login | **§5.8 no existe.** `CLAUDE.md` tiene §5.1…§5.7 y nada más |
| Los dos mismos comentarios dicen "y en `PROJECT.md`" | `grep -in "calendar\|ics\|feed" PROJECT.md` no devuelve una sola línea sobre el feed `.ics`, `family_settings` ni `calendar_feeds` |
| `PROJECT.md:166-171` y `CLAUDE.md` §6: las tres páginas de sección muestran "Totals for the last 24 hours **and the last 7 days**" | `components/SectionPage.tsx:749-767`: la segunda tarjeta es ahora el **selector de semana de vida**. `kpiWindows().week` ya no lo lee nadie |
| `PROJECT.md:228-233` y `CLAUDE.md` §6: `/statistics` **"draws nothing yet"**, con 267,5 px de hueco | `app/statistics/page.tsx` dibuja cuatro tarjetas con KPIs y dos clases de gráfica |
| `CLAUDE.md` §0.1: *todo push a `main` lleva versión nueva* | `package.json` sigue en **`0.9.0`** y la primera entrada de `CHANGELOG.md` es `[0.9.0] - 2026-09-23`. El plan del pase (`docs/superpowers/plans/2026-09-24-…md:5`) apunta a `0.10.0`; **todavía no se hizo** |
| `CLAUDE.md` §6 / `design.md` no mencionan `0012`, el countdown configurable, la tarjeta de cita ni el feed | existen los tres |

`design.md` §5.14, que sí cita `app/statistics/page.tsx`, **existe** — esa
referencia está bien.

**Corrección sugerida:** escribir §5.8 (o cambiar las dos citas a la sección que
termine siendo), actualizar §6 y las dos entradas de `PROJECT.md`, y hacer el
bump a `0.10.0` con su entrada de CHANGELOG **antes** del push — es MINOR
(funcionalidad nueva visible + schema que la acompaña), según la tabla de §0.1.

---

### M-9 · Las gráficas se estiran en la pared, y el comentario sobre el grosor del trazo dice lo contrario de lo que hace el CSS

**Dónde:** `components/Chart.tsx:75,141` (`preserveAspectRatio="none"`),
`app/globals.css:74,77-78,153-155,1306,1316,1321,1328-1329`.

**Evidencia:** CONFIRMADO POR LECTURA.

Dos cosas distintas, las dos del mismo lugar:

**(a) Los glifos se deforman.** El `viewBox` es `0 0 100 60` (relación 1,667) y
`preserveAspectRatio="none"`, así que el eje X y el eje Y se escalan por
separado. `.chart` toma su alto de `--chart-ratio`, que en el teléfono es
`16 / 9` (1,778 → 7 % de estiramiento horizontal, invisible) pero **en la pared
es `21 / 9`** (`app/globals.css:153`): 2,333 / 1,667 = **1,4**. Las etiquetas de
día (`.chart-label`, un `<text>` dentro del SVG) y los puntos de la línea
(`<circle r="1.6">`, que pasa a ser una elipse) salen **40 % más anchos que
altos**. En la superficie que `CLAUDE.md` §1 declara objetivo **primario** de
diseño y que se lee desde el otro lado del cuarto.

**(b) El comentario de `--chart-stroke` es falso.** `app/globals.css:76-78`
dice:

> El grosor del trazo de la línea de peso y del eje, en coordenadas del
> viewBox (100x60), no en px: el SVG lleva `preserveAspectRatio="none"`.

Pero `.chart-line` y `.chart-axis` llevan `vector-effect: non-scaling-stroke`
(`:1321`, `:1329`), que es precisamente la propiedad que **saca** al trazo del
espacio de usuario: el grosor se resuelve en el espacio del viewport, o sea en
píxeles de pantalla. `--chart-stroke: 1.4` son 1,4 px reales, y por eso el valor
de la pared (`1`) es *más fino* que el del teléfono, que es lo contrario de lo
que el comentario razona. El efecto en pantalla es correcto (por eso está el
`non-scaling-stroke`); lo que está mal es la explicación, y es la que va a leer
el próximo que toque esto.

**Corrección sugerida:** `preserveAspectRatio="xMidYMid meet"` con un viewBox que
acompañe, o —más simple— sacar el `<text>` del SVG y poner las etiquetas como
HTML debajo, que además arregla el tamaño de fuente (hoy `font-size: 5px` en
unidades de viewBox, `:1335`). Y corregir el comentario de `:76-78`.

---

## 🟢 BAJO

**B-1 · `<Link className="btn quiet">` deja el texto pegado arriba de la caja.**
`app/dashboard/page.tsx:920` es el **primer** `<a class="btn">` del repo
(`grep -rn 'className="btn'` → un solo resultado). `.btn`
(`app/globals.css:589-601`) da `min-height: var(--tap)` pero **no** da
`display: flex` ni `align-items: center`: un `<button>` centra su texto por la
hoja de estilos del navegador, un `<a>` no. Dentro de `.row-tight`
(`:355-359`, que sí es flex) el ancla se blockifica y la caja mide los 52 px —
pero el texto queda arriba. En la pared `--tap` es **84 px**
(`app/globals.css:165`). CONFIRMADO POR LECTURA. Sugerido:
`display: inline-flex; align-items: center; justify-content: center; text-decoration: none`
en `.btn`.

**B-2 · Código muerto que el pase dejó atrás.** `predictNextFeeding`
(`lib/db.ts:1032`), `predictNextNap` (`lib/db.ts:1060`) y el tipo
`SchedulePrediction` (`lib/db.ts:1019`) no los llama nadie: el único rastro son
dos comentarios. Y `kpiWindows()` sigue devolviendo `week`
(`lib/kpis.ts:45-50`) pero **ninguna página lo lee** — `components/SectionPage.tsx:643`
es el único llamador y solo usa `last24h`. CONFIRMADO POR LECTURA
(`grep -rn "predictNextFeeding\|windows.week" app components lib`). Sugerido:
borrarlos, o dejar anotado por qué se quedan.

**B-3 · Import sin usar.** `measuredOn` en `components/SectionPage.tsx:99` no
aparece en ninguna otra línea del archivo. `pnpm lint` no lo agarra
(`next/core-web-vitals` no trae `no-unused-vars` para imports de tipo/valor con
esta config) y `tsc` tampoco (`noUnusedLocals` está apagado). CONFIRMADO POR
LECTURA.

**B-4 · Cuatro claves de diccionario que no las usa nadie.**
`settings.thresholdOffline`, `stats.perDay`, `stats.weekTotal` y
`stats.chartBottle` tienen 0 usos fuera de `en.ts`/`es.ts`. La primera duele:
es el texto pensado para el caso sin conexión de los umbrales, y como no está
cableada, offline el usuario ve `settings.thresholdCouldNotSave` con el mensaje
crudo de Supabase adentro. CONFIRMADO POR LECTURA
(`grep -rn "'settings.thresholdOffline'" app components lib` → 0).

**B-5 · `reminder_sent_at` no entró a `lib/types.ts`.** `0012:74` agrega la
columna a `doctor_appointments`, pero `DoctorAppointment` no la declara — a
diferencia de `long_alert_sent_at`, que sí está (`lib/types.ts:58`) desde
`0009`. El manual §5 dice que los tipos calcan los nombres de columna.
CONFIRMADO POR LECTURA.

**B-6 · `LineChart` puede repetir una `key` de React.**
`components/Chart.tsx:148` usa `key={p.label}`, y en `/statistics` el label es
`measuredOn(g.measured_at, lang)` (`app/statistics/page.tsx:195`), que es un día
de calendario. Dos mediciones de peso el mismo día → dos keys iguales.
CONFIRMADO POR LECTURA. Sugerido: pasar el `id` de la fila.

**B-7 · `weekSince.current` se asigna durante el render.**
`components/SectionPage.tsx:655`. Funciona hoy (el efecto de `:381` corre
después), pero es una escritura de ref en fase de render, que React documenta
como no segura y que el modo concurrente puede ejecutar dos veces. CONFIRMADO
POR LECTURA.

**B-8 · `const window: KpiWindow` sombrea el `window` global.**
`app/statistics/page.tsx:158`. Nada en ese scope usa el `window` del navegador,
así que no rompe nada hoy. CONFIRMADO POR LECTURA.

**B-9 · Seis archivos de reporte sueltos en la raíz, sin gitignorear.**
`.audit-report.md`, `.close-report.md`, `.close-summary-agente.md`,
`.impl1-report.md`, `.impl2-report.md`, `.review-report.md` aparecen en
`git status` como `??` y `.gitignore` no los cubre (solo cubre `output.txt` y
`.claude/`). Se van a commitear con el pase si nadie los saca. CONFIRMADO POR
LECTURA (`cat .gitignore`).

**B-10 · "Appointment tomorrow" para una cita que puede ser hoy.**
`push.appointment.title` / `'Turno mañana'` sale para cualquier cita dentro de
las próximas 24 h (`lib/push/server.ts:677-686`), y una cita de hoy a las 23:00
reclamada a la 01:00 entra en esa ventana. CONFIRMADO POR LECTURA. El body sí es
honesto (`'· en unas {hours} horas'`).

**B-11 · El "Guardado para toda la familia" no se va nunca.**
`app/settings/page.tsx:183,212` — `flash` se setea y solo se limpia al empezar
otro guardado. Queda en pantalla indefinidamente en una pantalla de pared.
CONFIRMADO POR LECTURA.

**B-12 · La gráfica de peso ignora la semana elegida.**
`app/statistics/page.tsx:111` lee `listGrowth(babyId)` (todas las mediciones) y
`:194-198` las dibuja todas, dentro de una tarjeta que vive debajo del selector
de semana. El copy lo admite (`stats.chartWeight`: *"Weight, every measurement
so far"*), así que no miente — pero la tarjeta está en la grilla que el selector
gobierna y eso se lee como que la semana la filtra. CONFIRMADO POR LECTURA.

**B-13 · El token en claro del feed se queda en pantalla.**
`app/settings/page.tsx:386` pinta `<code className="feed-url">{url}</code>` y
nada lo saca: sobrevive hasta que alguien navegue. En la pantalla de pared de
27" en modo kiosco, el único control de acceso del calendario familiar queda
legible desde el otro lado del cuarto. CONFIRMADO POR LECTURA. Sugerido: un
botón "listo" que lo oculte, o esconderlo solo tras copiar.

**B-14 · Un miembro puede escribir las marcas de aviso de su familia.**
`0012:67` da `update` sobre toda la tabla `family_settings` a `authenticated`, y
no hay policy ni trigger por columna, así que un `PATCH` por PostgREST puede
poner `feed_alert_sent_at` en el futuro y silenciar el aviso, o en `null` para
forzarlo. Es dentro de la propia familia (la policy usa `is_family_member`,
verificado) y son dos padres de confianza, así que el impacto es nulo hoy. Queda
escrito porque la columna es de *servidor*, no de usuario. CONFIRMADO POR
LECTURA + los grants leídos de la base
(`select … from information_schema.role_table_grants`).

---

## Lo que se revisó y salió limpio

| Qué | Cómo se verificó | Resultado |
| --- | --- | --- |
| **Aislamiento entre familias del feed `.ics`** — la pregunta central del pase | Dos familias sembradas a mano en el stack local (`docker exec … psql`), dos tokens `acal_…` generados con el mismo `hashCalendarToken`, `pnpm dev` + `curl` a los dos feeds | **Limpio.** El feed de A trae solo la cita de A; el de B solo `SECRETO DE B`. La familia sale de `calendar_feeds.token_hash` y las citas se filtran por los bebés de esa familia (`lib/calendar/server.ts:139-161`). CONFIRMADO POR PRUEBA |
| **Token mal formado vs. inexistente** | `curl /api/calendar/nope.ics` → `404` en 7,8 ms; `curl /api/calendar/acal_zzz…(43).ics` → `404` en 12,2 ms; `curl /api/calendar/<family_id>.ics` → `404` | **Limpio.** Los tres dan el mismo cuerpo (`Not found`) y el mismo status. Hay una diferencia de tiempo de ~4 ms entre "no tiene la forma" y "tiene la forma pero no existe" (`tokenFromSegment` corta antes de ir a la base), pero lo único que filtra es la forma del token, que no es secreta. CONFIRMADO POR PRUEBA |
| **`0012` — RLS, policies y GRANT/REVOKE en las dos tablas nuevas** | `select relrowsecurity from pg_class`, `select … from pg_policies`, `select … from information_schema.role_table_grants` | **Limpio.** `family_settings` y `calendar_feeds` con `relrowsecurity = t`. `family_settings`: policies select/insert/update, grants `INSERT,SELECT,UPDATE` a `authenticated`, **nada** a `anon`. `calendar_feeds`: las cuatro policies y los cuatro grants a `authenticated`, **nada** a `anon`. Ninguna tabla queda "se puede escribir pero no corregir": las dos tienen `update` con `using` **y** `with check` |
| **Que `anon` no llegue a las tablas nuevas** | `curl "$URL/rest/v1/calendar_feeds?select=*"` y `…/family_settings` con la anon key | **Limpio.** `401` / `42501 permission denied` en las dos. El hash del token no se puede enumerar desde el browser. CONFIRMADO POR PRUEBA |
| **Scope por `family_id` DIRECTO, no por join a `baby_id`** | Lectura de `0012:26` y `0012:103` | **Limpio.** Las dos tablas tienen `family_id uuid primary key references families(id)`. Cumple `CLAUDE.md` §5.3 y la forma de fase 2 |
| **Migración ya aplicada editada** | `git status --short supabase/migrations/` | **Limpio.** `0001`…`0011` sin modificar; `0012` es un archivo nuevo con el siguiente número libre |
| **`lib/supabaseAdmin.ts` en un `'use client'`** | `grep -rn "supabaseAdmin" app components lib` | **Limpio.** Cuatro usos, los cuatro en `app/api/*/route.ts` (`ingest`, `quick/nurse`, `push/nursing-check`, `calendar/[token]`). `lib/calendar/server.ts:31-33` además tira si lo carga un browser |
| **Queries fuera de `lib/db.ts` / `lib/push/server.ts` / `lib/calendar/server.ts`** | `grep -rn "\.from(" app components lib` | **Limpio.** Los únicos `.from(` de tabla nuevos están en esos tres archivos. Las dos rutas de calendario no arman ninguna query (`CLAUDE.md` §5.3). Los `.from(` de `app/api/ingest` y `app/api/quick/nurse` son previos |
| **`voided_at` en las lecturas nuevas** | Lectura de `lib/push/server.ts:574-591`, `lib/calendar/server.ts:157-161`, `lib/db.ts:968-1014` | **Limpio.** Las tres lecturas nuevas de `feedings`/`nursing_sessions`/`sleep_sessions` llevan `.is('voided_at', null)`. `doctor_appointments`, `family_settings` y `calendar_feeds` **no tienen** la columna (`grep -rn voided_at supabase/migrations/`), así que no hay filtro que falte. `lib/schedule.ts:66` además descarta filas retractadas en la parte pura |
| **La sintaxis PostgREST del `.or()` nuevo** | `curl -G …/nursing_sessions --data-urlencode 'or=(started_at.gte."…",ended_at.gte."…",ended_at.is.null)'` | **Limpio.** `200`, no `400`. El ISO va entre comillas y el parser lo acepta. CONFIRMADO POR PRUEBA |
| **Los tres checks nuevos contra la base real** | Token de scope `push_check` sembrado + suscripción con endpoint `fcm.googleapis.com` inválido + `curl -X POST /api/push/nursing-check` | **Limpio en lo que buscaba.** Respuesta: `schedule: {feeding:0, nap:0, appointments:0, sent:0, failed:3, removed:1}` — los tres avisos se intentaron (las queries corren), la suscripción muerta se borró, `feed_alert_sent_at`/`nap_alert_sent_at` **quedaron sin escribir** y `reminder_sent_at` volvió a `null`. El camino de "no le llegó a nadie ⇒ se devuelve la marca" funciona. CONFIRMADO POR PRUEBA |
| **Secretos con `NEXT_PUBLIC_` o hardcodeados** | `git diff` completo + lectura de los archivos nuevos | **Limpio.** Ninguna variable nueva. El token del calendario se genera con `randomBytes(32)` y la base guarda solo el sha-256 (`0012:104`, con `check (token_hash ~ '^[0-9a-f]{64}$')`) |
| **Validación del body del handler nuevo** | Lectura de `app/api/calendar/feed/route.ts:34-42` + `curl -X POST` sin sesión | **Limpio.** Sin sesión → `401 {"error":"unauthorized"}`. Un body vacío o ilegible no revienta: el `try/catch` lo trata como "creá el primero". `rotate` solo se acepta con `=== true` |
| **Service worker** | `grep -n "isCacheable" -A 8 public/sw.js`, `PRECACHE`, `middleware.ts:62` | **Limpio.** `/api/` nunca entra a la caché (`public/sw.js:91`), así que el `.ics` no se guarda; el `Cache-Control: private, no-store` del handler es cinturón además del tirante. `/api` está fuera del matcher del middleware, que es lo que permite que el feed sea público |
| **Tiempo y unidades** | `pnpm test:tz` | **Limpio.** 267 tests × 4 TZ (`UTC`, `America/Los_Angeles`, `Asia/Tokyo`, `Pacific/Kiritimati`), todos pasan. `lib/lifeWeek.ts` resuelve las semanas con `fromHouseholdInputValue`/`householdToday`, no con la TZ del sistema, y tiene un test de cambio de horario (167/169 h) |
| **Nada se guarda en otra unidad que ml/kg/cm** | Lectura de `app/statistics/page.tsx:191-198,272-281` | **Limpio.** Solo lee: `kgToLbOz` y `mlToUnit` son display. No hay escritura nueva de volumen ni de peso |
| **TypeScript** | `pnpm exec tsc --noEmit` | **Limpio.** Sin errores. Los `as` de los archivos nuevos son los del patrón ya establecido (castear filas crudas de PostgREST a los tipos de `lib/types.ts`); no hay un solo `any` ni un `!` nuevo |
| **Hex o px fuera de `app/globals.css`** | `grep -rnE "#[0-9a-fA-F]{3,8}\b\|[0-9]+px" app components lib --include=*.ts --include=*.tsx` | **Limpio.** Los únicos hex siguen siendo `lib/tokens.ts` (el espejo declarado) y `app/layout.tsx:32` (`themeColor`), los dos previos. Los `px` que quedan son texto de comentarios. **Los números de `components/Chart.tsx` NO cuentan como px** y lo justifico: `VIEW_W=100`, `VIEW_H=60`, `r="1.6"`, `rx="1"` y los `usable - h` son coordenadas de un `viewBox` — un sistema de unidades propio del SVG que el navegador escala por la caja que le dé el CSS. Un `1.6` ahí no mide 1,6 píxeles en ninguna pantalla; el tamaño real sale de `--chart-ratio` y del ancho de la tarjeta, que **sí** están en `globals.css`. Lo que hubiera sido una violación —el alto de la gráfica, el grosor del trazo, el tamaño de la etiqueta— está en tokens (`:74,77-78,153-155`). (El comentario que los acompaña sí está mal: ver M-9) |
| **Targets táctiles bajo `--tap`** | Lectura de `app/globals.css:589-601,615-626,1350-1366` | **Limpio en tamaño.** `.weekpick-btn` declara `min-width` y `min-height` de `var(--tap)` explícitos (`:1350-1352`); el campo de umbral usa `.input`, que ya trae `min-height: var(--tap)` (`:617`) y `font-size: max(16px, …)` para que iOS no haga zoom; el botón del feed usa `<Btn>`, que es un `<button class="btn">` con `min-height: var(--tap)`. El único control nuevo que no queda perfecto es el `<Link class="btn">` de B-1, y es por alineación, no por tamaño |
| **Componentes bifurcados teléfono/pared** | Lectura de `components/Chart.tsx` y `components/WeekPicker.tsx` | **Limpio.** Un solo componente para las dos superficies; lo que cambia en el breakpoint son los tokens (`--chart-ratio`, `--chart-stroke`, `--tap`), como pide el manual §9 |
| **Honestidad offline del guardado de umbrales** | Lectura de `lib/db.ts:960-991` y `app/settings/page.tsx:205-217` | **Limpio en lo esencial.** `saveFamilySettings` **no** pasa por la cola —decisión explicada en `lib/db.ts:955-960`, y es la correcta: es un dato compartido y una cola que lo aplique tarde pisaría lo que el otro padre cambió— y el error se muestra como error, no como "guardado". No se encola nada que el servidor haya rechazado. Lo que sí queda flojo es el flujo del `onBlur`: M-4 |
| **`console.*` nuevos en `app/`, `lib/`, `components/`** | `grep -rn "console\." app components lib` | **Limpio.** Dos, los dos previos y deliberados: `lib/i18n/index.ts:97` (clave sin traducir) y `lib/push/server.ts:362` (VAPID sospechosa). Ninguno nuevo, ninguno con datos de la bebé |
| **Suite completa** | `pnpm test` (267), `pnpm test:tz` (267 × 4), `pnpm test:integration` (106, contra el stack local levantado), `pnpm lint`, `pnpm format:check`, `pnpm build` | **Todo pasa.** El build además confirma que las dos rutas de calendario salen como `ƒ` (server-rendered on demand) y que nada del código con `service_role` entró a un bundle de cliente |
| **Cobertura del pase** | `tests/unit/schedule.test.ts` (41 casos: `lib/schedule.ts`, `lib/push/schedule.ts`, `lib/lifeWeek.ts`, `lib/calendar/ics.ts`) | **Bien cubierto lo puro.** Queda **sin test**: `runScheduleChecks` entero (el diff de `tests/integration/push.test.ts` solo agrega `expect(schedule).toBeDefined()`), `hashCalendarToken`/`looksLikeCalendarToken`/`tokenFromSegment`, `calendarFeedFor` (el aislamiento lo verifiqué a mano, no hay test que lo fije) e `issueCalendarToken`. Sugerido: un `tests/integration/calendar.test.ts` con el caso de las dos familias que corrí a mano — es el que impide que una refactorización futura abra el cruce |

**Limpieza:** todos los datos que sembré (dos familias, dos bebés, tres citas,
una comida, un sueño, un `device_token`, una suscripción y dos
`calendar_feeds`) se borraron al terminar; `select count(*) from families where
id in (…)` → `0`. El `pnpm dev` que levanté quedó apagado.

---

## Lo que NO se pudo verificar

- **Que el aviso de comida/siesta llegue de verdad a un teléfono.** Lo que
  verifiqué es que los tres checks corren, deciden y llaman al servicio de push;
  el envío real contra FCM/APNs/Mozilla sigue teniendo las mismas limitaciones
  que `CLAUDE.md` §6 ya declara para la toma larga. **NO VERIFICADO.**
- **Que un cliente de calendario real (iOS, Google Calendar, Outlook) acepte el
  `.ics`.** El VCALENDAR que sirve el endpoint lo leí entero y cumple lo que
  `tests/unit/schedule.test.ts:286-372` afirma (CRLF, plegado a 75 octetos,
  escapes, UID, DTSTAMP), pero no lo suscribí en ningún cliente. **NO
  VERIFICADO.**
- **El estado de `0012` en el proyecto Supabase de la nube.** Igual que `0009`,
  `0010` y `0011` (`CLAUDE.md` §2.1): desde este VPS no hay credenciales. La
  migración está aplicada **en el stack local** (`\dt public.*` muestra
  `family_settings` y `calendar_feeds`). **NO VERIFICADO en producción.**
- **La deformación de las gráficas en la pared (M-9).** Es aritmética de
  `preserveAspectRatio` que se sigue del CSS y del `viewBox`, no una medición: no
  rendericé a 1440+ px. **CONFIRMADO POR LECTURA, no medido.**
- **El texto cortado arriba del `<Link class="btn">` (B-1).** Misma situación:
  se sigue del CSS, no lo medí en un navegador. **CONFIRMADO POR LECTURA, no
  medido.**
