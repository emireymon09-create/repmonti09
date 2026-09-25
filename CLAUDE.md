# CLAUDE.md — Amelia App

Punto de entrada de toda sesión en este repo. Leelo antes de tocar nada.
Después leé `PROJECT.md` (arquitectura y estado) y `design.md` (UI/UX).
Si algo en `PROJECT.md` o en el README contradice a este archivo, **este
archivo manda** — y avisá de la contradicción en vez de elegir en silencio.

Para **trabajar** (no para entender el proyecto), la doc operativa vive en
`docs/`: manual de buenas prácticas, checklist de cada cambio, prompt de
auditoría y seguridad operacional. Índice: `docs/README.md`.

**Y antes de cualquier `git push` a `main`: subir la versión y escribir su
entrada en `CHANGELOG.md`.** Sin excepción. Ver §0.1. Tiene el mismo peso que
leer este archivo al empezar: no es opcional ni "si te acordás".

---

## 0. Regla número uno — investigar antes de hablar

**Verificá contra el código real antes de responder.** No respondas de
memoria, no respondas por lo que dice la documentación, no respondas por
lo que "suele hacer" un proyecto Next + Supabase.

- Antes de afirmar que algo existe → `grep` / `cat` el archivo.
- Antes de afirmar que algo funciona → leé la implementación completa.
- Antes de proponer un cambio → leé lo que ya está ahí y por qué.
- Si la documentación y el código no coinciden, **el código es la
  verdad** y la documentación es el bug. Reportá la diferencia.

En este repo esto no es teórico. Ejemplos reales de doc que miente:

- El README mandaba `npm install -g supabase` y
  `cp .env.local.dev .env.local`. Lo primero está prohibido acá y además
  Supabase no soporta esa instalación; lo segundo apunta a un archivo
  que **no existe** (el que existe es `.env.local.example`). Reescrito el
  20 sep 2026 — pero el hábito de verificar es lo único que agarra la
  próxima.
- El README decía que la PWA, la UI de sueño y la de crecimiento "no
  están construidas". **Están construidas.** Corregido el 20 sep 2026.
- *(Cerrado el 20 sep 2026: `lib/format.ts` y `PROJECT.md` afirmaban que
  había tests de timezone y no había un solo test en el repo. Ahora los
  hay — `tests/unit/format.test.ts`, `pnpm test:tz`. Se deja anotado
  porque la lección no es sobre los tests, es sobre la doc.)*
- `PROJECT.md` referencia `CONVENTIONS.md`, `ARCHITECTURE.md`,
  `FAMILY_HUB.md` y varios ADR. **Ninguno existe en este repo** — viven
  en el repo del Hub, que todavía no está acá.

Si no pudiste verificar algo, decilo explícitamente: *"no lo verifiqué"*.
Nunca rellenes el hueco con una suposición presentada como hecho.

---

## 0.1 Regla obligatoria — todo push a main lleva versión nueva

**Ningún push a `main` sale sin un bump de versión y su entrada en el
CHANGELOG.** Da igual el tamaño del cambio: una línea de copy, un arreglo de
CSS o un batch entero. Si el push llega a `main`, llega con versión nueva.

- **Qué se sube:** `version` en `package.json` **y** una entrada
  `## [x.y.z] - AAAA-MM-DD` arriba de todo en `CHANGELOG.md`, en inglés y en
  términos de quien usa la app.
- **Qué dígito se sube — semver de verdad, según el tipo de cambio, nunca
  por costumbre:**

  | Tipo de cambio | Dígito | Ejemplo |
  |---|---|---|
  | Arreglo de bug, copy, CSS, doc — **sin** funcionalidad nueva visible | **PATCH** `x.y.Z+1` | `0.4.0 → 0.4.1` |
  | Funcionalidad nueva visible y compatible (el selector de idioma, el tema claro) | **MINOR** `x.Y+1.0` — el PATCH vuelve a 0 | `0.4.1 → 0.5.0` |
  | Cambio grande o incompatible (rompe datos, la API de dispositivos o la forma de usar la app) | **MAJOR** `X+1.0.0` — MINOR y PATCH vuelven a 0 | `0.5.0 → 1.0.0` |

  Si el push mezcla tipos, manda el mayor: un arreglo + una función nueva es
  MINOR. Se sube **un** dígito por push, no uno por commit. Nunca se repite ni
  se retrocede una versión. Detalle en §4.1.
- **Cuándo:** en el último commit antes del push. Si el push lleva varios
  commits (un batch), un solo bump alcanza — pero **tiene que haber uno**.
- **Cómo verificarlo antes de pushear** (si no imprime nada, NO pushees):

  ```bash
  git fetch origin && git diff origin/main -- package.json | grep '^+.*"version"'
  ```

  Y `pnpm test` tiene que pasar: `tests/unit/changelog.test.ts` falla si la
  primera entrada del CHANGELOG no coincide con `package.json`.
- **Si ya se pusheó sin bump:** el próximo push lo corrige con su propio bump y
  una entrada que cubra también lo que salió sin versión. No se reescribe el
  historial de `main`.

Esta regla existe porque se olvidó. No la reinterpretes como "una vez por
batch, cuando haya un batch": la unidad es **el push**.

---

## 1. Qué es este proyecto

**Amelia** es una app de seguimiento de bebé para uso doméstico: tomas,
lactancia, pañales, sueño, extracción de leche, crecimiento y turnos
médicos. La usan dos padres, cada uno con su login propio.

Dos superficies, **un mismo set de componentes**:

- **Teléfono** — uso a una mano, a las 3 de la mañana, con wifi malo.
- **Pantalla de pared de 27"** — kiosco, se lee desde el otro lado del
  cuarto. Es el objetivo **primario** de diseño (ver `design.md`).

Es la **primera pieza de un ecosistema mayor ("Family Hub")**. Tiene su
propio deploy, pero **no** su propia base de datos: a futuro comparte un
único proyecto Supabase con el resto de la casa, y este directorio pasa a
ser `apps/amelia` dentro de un monorepo. Ese plan está detallado en
`PROJECT.md` → "What changes when the shared backend lands (phase 2)".

**Regla dura del proyecto entero:** video, imágenes y audio de la cámara
**nunca** salen de la casa. Solo eventos derivados (inicio/fin de sueño,
alertas de sonido) se empujan a `/api/ingest`. Cualquier propuesta que
viole esto se rechaza sin discusión.

---

## 2. Stack

| Capa | Qué se usa |
|---|---|
| Lenguaje | TypeScript 5.5, `strict: true` |
| Framework | Next.js 14 — **App Router** (`app/`) |
| Frontend | React 18 |
| Backend | Route Handlers del mismo Next (`app/api/*/route.ts`). **No hay backend separado.** |
| Base de datos | PostgreSQL vía **Supabase** |
| Acceso a datos | Cliente Supabase (PostgREST) directo. **No hay ORM.** |
| Estilos | CSS plano + custom properties en `app/globals.css`. **No hay Tailwind ni CSS-in-JS.** |
| Migraciones | SQL a mano en `supabase/migrations/` |
| Gestor de paquetes | **pnpm** (lockfile commiteado) |
| Tests | **Vitest** — unit bajo 4 TZ + integración contra el Supabase local |
| Lint / format | **ESLint** (`next/core-web-vitals` + `prettier`) y **Prettier** |
| Deploy | **Vercel, plan Hobby, ya desplegado** — auto-deploy en cada push a `main` |

No es un monorepo. Hay un solo `package.json`, en la raíz.

### 2.1 Dónde vive esta app de verdad (corregido el 22 sep 2026)

Hasta el 22 sep 2026 este archivo decía "Vercel previsto — todavía no
desplegado" y `PROJECT.md` decía "No cloud Supabase project". **Las dos cosas
eran falsas.** El estado real, confirmado por Luis:

| Entorno | Qué es | Base de datos |
|---|---|---|
| **Producción** | Deploy en **Vercel, plan Hobby**, con auto-deploy en cada push a `main` | **Proyecto Supabase en la nube, ya existente y en uso** |
| **Este VPS** | **Solo desarrollo y pruebas.** Nunca fue ni va a ser producción | El stack Docker de `supabase/docker/`, en 127.0.0.1 |

Consecuencias que sí o sí hay que tener presentes:

- **Un push a `main` sale a producción solo.** No hay paso manual de deploy.
  Por eso §0.1 (versión + CHANGELOG en todo push) no es burocracia: es la
  única marca de qué se publicó.
- **El Docker local no es "la base".** Una migración aplicada acá **no** está
  aplicada en producción. Aplicarla en la nube es un paso aparte y explícito.
- **`.env.local` de este VPS apunta a 127.0.0.1** (verificado el 22 sep 2026).
  Las variables de producción viven en el panel de Vercel, no en este repo.

**Verificado por el agente el 22 sep 2026** (no por lo que dijo nadie — con
`gh`, que está autenticado en este VPS, y con peticiones públicas):

| Dato | Valor | Cómo se verificó |
|---|---|---|
| Proyecto en Vercel | `emireymon09-create/amelia-app` | `target_url` del status "Vercel" en `main` |
| Auto-deploy en push a `main` | **Sí** | 12 deployments de environment `Production` en la API de GitHub; el último, 22 sep 18:32:29Z, arranca 56 s después del commit `95a86cd` (18:31:33Z) |
| URL pública de producción | `https://amelia-app.vercel.app` | 200 en `/login`, `<title>Amelia</title>` |
| Proyecto Supabase en la nube | `https://ituurekoybqjqpuycweh.supabase.co` | está en el bundle público del cliente (`NEXT_PUBLIC_SUPABASE_URL` se compila adentro) |

Esa URL de Vercel es la **estable**, no la de un deployment. La de cada
deployment (`amelia-<hash>-emireymon09-create.vercel.app`) cambia en cada push
y **no sirve** para el cron de §7.6.

**Sigue sin verificar — preguntarle a Luis:** el plan de Vercel (Hobby lo dijo
Luis; no lo pude confirmar), el plan y la región del proyecto Supabase, si las
tres variables VAPID están cargadas en Vercel, si el 2FA está puesto, y **si
las migraciones 0009/0010/0011 están aplicadas en la nube**. Para eso último
hace falta correr SQL allá, y desde este VPS no hay con qué: no hay `.vercel/`,
no hay CLI de Supabase, no hay `~/.supabase/access-token`, y en todo el home la
única mención a un `*.supabase.co` es el placeholder de `.env.local.example`.
**No lo inventes.**

### Mapa de archivos que importan

```
lib/db.ts          ÚNICA puerta a la base de datos. Las páginas nunca arman una query.
                   `sessionById` (23 sep 2026) relee UNA sesión por id: la usa
                   /dashboard antes de correrle el inicio, porque ninguna página
                   se relee sola y la pared puede estar mostrando una sesión que
                   el otro teléfono ya paró. `updateNursing`/`updateSleep` aceptan
                   `{ queueOnly: true }` para forzar la cola cuando la fila
                   todavía es un insert encolado (un UPDATE contra un id que el
                   server no tiene matchea 0 filas y PostgREST lo llama éxito).
lib/queue.ts       Cola offline en IndexedDB + replay ordenado, lock entre
                   pestañas (navigator.locks), timeout por envío, reintento solo
                   para errores de red y descarte de un rechazo.
lib/useSync.ts     Hook de conectividad + cola: vacía al montar y al volver
                   `online`, reintenta, avisa a otras pestañas y expone el
                   rechazo (`syncFailed` / `discardFailed`).
lib/lastSeen.ts    Copia en localStorage (`amelia:seen:*`) de las últimas filas
                   buenas por página y bebé, para abrir sin conexión. Sin tokens;
                   se borra al cerrar sesión, al iniciarla y sin sesión.
lib/offlinePages.ts   Lista de páginas que el service worker precalienta tras
                   iniciar sesión (mensaje 'warm' a public/sw.js).
lib/format.ts      Fechas/horas en la TZ del hogar + conversión de unidades.
                   `DISPLAY_UNIT = 'oz'` (23 sep 2026): la app MUESTRA siempre
                   onzas. La base sigue guardando ml. `lib/useVolumeUnit.ts`
                   —la preferencia oz↔ml por dispositivo— se borró ese día.
lib/schedule.ts    PURO (24 sep 2026): la cuenta regresiva de Today. `lastFeedingEnd`
                   (el FIN del último evento de comida de cualquier tipo),
                   `lastNapEnd`, `nextDue`/`dueFrom` y `nextAppointment` (ventana
                   de 36 h). Reemplazó a `predictNextFeeding`/`predictNextNap`
                   de lib/db.ts, que promediaban los últimos 6 intervalos.
lib/lifeWeek.ts    PURO: la semana de vida (1, 2, 3… desde `birth_date`), en días
                   de calendario del hogar. NO es `kpiWindows().week`.
lib/push/schedule.ts  PURO: cuándo corresponde cada aviso nuevo y qué dice.
                   `shouldAlert` es la regla de repetición cada 30 min.
lib/calendar/ics.ts   PURO: el VCALENDAR (RFC 5545) — CRLF, plegado a 75 octetos,
                   escapado de TEXT. Siempre en inglés: el feed no tiene sesión.
lib/calendar/server.ts  SOLO server: el token opaco del feed y sus queries. Existe
                   por lo mismo que lib/push/server.ts (§5.3): lib/db.ts es
                   'use client' y el feed no tiene sesión que usar.
components/Chart.tsx   Las dos gráficas de /statistics, SVG a mano. Las etiquetas
                   del eje son HTML, no `<text>`: el viewBox va con
                   preserveAspectRatio="none" y deformaba el texto 1,40x en la
                   pared. No hay librería de gráficas en este repo.
components/WeekPicker.tsx  El selector de semana de vida.
lib/kpis.ts        Totales de /feeding, /diapers y /sleep: funciones PURAS (sin
                   reloj ni base). Ventanas `last24h` (**rodante**: ahora − 24 h,
                   23 sep 2026; antes era el día de calendario y se llamaba
                   `today`) y `week` (hoy + los 6 días de calendario anteriores,
                   sin cambio), solapamiento de sesiones, `lastFeedingEvent` (la
                   leyenda del dashboard), `checkPastRange` (validación de
                   "Log a past one") y `shiftStart` (correr el inicio de una
                   sesión en curso: topes 240 min por aplicación y 12 h sobre el
                   resultado). Una fila en cola cuenta y marca `pending`.
lib/types.ts       Tipos de fila (stand-in de los types generados de fase 2).
lib/tokens.ts      Design tokens en TS, espejo de app/globals.css.
lib/supabaseClient.ts   anon key — browser. Protegido por RLS.
lib/supabaseAdmin.ts    service_role — SOLO server. Salta RLS.
lib/supabaseRoute.ts    Cliente de un route handler que actúa COMO EL PADRE que
                   llama: anon key + la sesión de sus cookies ⇒ todo pasa por
                   RLS. Lo usa /api/push/subscription. Nunca service_role.
lib/push/nursing.ts  El aviso de toma larga, en su parte PURA: umbral
                   (LONG_NURSING_MINUTES = 30), qué sesión califica, a quién se
                   le manda y qué dice (payload traducido, tag y Topic por
                   sesión, TTL de 1 h). Sin red ni base.
lib/push/endpoint.ts  Validación del endpoint de push (allowlist de hosts, solo
                   https — anti-SSRF) y del body de suscripción.
lib/push/server.ts   SOLO server: las queries del push (suscripciones, marca
                   atómica de la sesión) y los envíos con web-push. Ver §5.3.
lib/push/retry.ts    PURO: qué hacer con un 403 del servicio de push. La racha
                   se cuenta POR SUSCRIPCIÓN y solo se borra si OTRAS del mismo
                   lote sí recibieron; si fallan todas, no se borra nada y se
                   loguea como VAPID mal puesta. Columna: 0010.
lib/push/client.ts   Estado del control "Nursing alerts" en este navegador
                   (off/on/unknown/unsupported/install/unavailable/denied),
                   suscribir/desuscribir, idioma, y soltar la suscripción local
                   al iniciar o cerrar sesión.
app/api/push/subscription/route.ts   POST/DELETE de la suscripción de ESTE
                   dispositivo, con la sesión del padre (RLS).
app/api/push/nursing-check/route.ts  POST/GET, token de dispositivo scope
                   `push_check`. Quién lo llama cada minuto: §7.
scripts/vapid-keys.mjs   Genera un par VAPID (P-256, base64url). Lo llama
                   `pnpm db:env` solo si faltan: nunca pisa una clave existente.
app/globals.css    TODO el CSS del proyecto.
components/ui.tsx  Page, Grid, Card, Label, Btn, NavIcon, EmptyState, Nav — y
                   re-exporta Banner. Desde el 23 sep 2026 `Nav` es SOLO
                   navegación: no tiene ningún ajuste adentro ni recibe babyId.
app/settings/page.tsx   La pantalla Settings (23 sep 2026): tema, idioma,
                   avisos de lactancia y cerrar sesión. Vino del menú del
                   engranaje; no quedó ninguna copia allá. **La unidad oz↔ml y
                   "Reset milk total" salieron** ese mismo día (frentes 4 y 5):
                   el sistema muestra siempre onzas y el total de leche ya no
                   se puede resetear. La página no tiene `Banner` ni `useState`.
app/statistics/page.tsx   Pantalla nueva (23 sep 2026). Todavía NO dibuja nada:
                   título + `EmptyState` dentro de un `.empty-fill`, sin
                   prometer fecha. No lee nada, así que no tiene estado de
                   carga. Está en `middleware.ts`, en `lib/offlinePages.ts` y en
                   el `PRECACHE` de `public/sw.js`.
components/AmountUnit.tsx   El toggle oz/ml PEGADO a un campo de cantidad
                   (23 sep 2026). `.seg`/`.seg-inline`, `role="radiogroup"` con
                   dos `role="radio"`. Es estado del componente, **no** una
                   preferencia guardada: vale para esa entrada y vuelve a `oz`
                   al montar y después de cada guardado. Está en la fila del
                   biberón de /dashboard y en "Log a past one" de /feeding;
                   **no** en los paneles de edición, ver §6.
components/Banner.tsx   Banner (.banner error/ok/warn). En archivo propio para
                   que NursingAlerts lo use sin importar ui.tsx de vuelta.
components/SectionPage.tsx   La pantalla compartida de /feeding, /diapers y
                   /sleep: KPIs de las últimas 24 h y de 7 días, log completo
                   con editar y borrar (un panel a la vez) y "Log a past one".
components/NursingAlerts.tsx   El control "Nursing alerts", hoy en /settings
                   (antes en el menú). Sus segmentos son `role="radio"` dentro
                   de un `radiogroup`, no `menuitemradio`.
components/SyncStatus.tsx   SyncBar, SyncStatus, SeenNote (aviso de copia
                   guardada) y SyncErrorBanner (rechazo, con Descartar).
components/VersionHistory.tsx   Pantalla de /version ('use client'). La página
                   (server) lee CHANGELOG.md en el build y le pasa las versiones.
lib/i18n/en.ts     Diccionario inglés: la FUENTE de claves (`MessageKey`).
lib/i18n/es.ts     Diccionario español rioplatense (voseo), tipado contra en.ts:
                   una clave que falte o sobre es error de tipos.
lib/i18n/index.ts  translate(), detección de idioma, locale de Intl. Sin React:
                   lo usan lib/format.ts y lib/db.ts.
lib/i18n/react.tsx I18nProvider (montado en app/layout.tsx), useT(),
                   useLanguageChoice().
lib/i18n/boot.ts   Script inline del <head>: fija <html lang> y `data-lang-pending`
                   antes del primer pintado. Tiene que decidir igual que
                   resolveLang() — el test lo verifica.
lib/deviceAuth.ts  Auth de los endpoints de dispositivo: token por hash + scope,
                   resolución del bebé dentro de la familia del token, techo de
                   intentos, validación de payload.
middleware.ts      Guard de auth server-side. NO reemplaza a RLS: evita que una
                   ruta privada se renderice antes de rebotar al login.
public/sw.js       Service worker: que la app ABRA sin conexión. Nunca cachea
                   datos de Supabase ni una respuesta redirigida. El cache es
                   **`amelia-v6`** (23 sep 2026, con /statistics adentro). Ojo:
                   hasta hoy este mapa decía `amelia-v4` y era falso — ya estaba
                   en `v5` desde que entró /settings. Corregido, y comprobado
                   por el auditor de punta a punta (caches
                   `amelia-v6-shell` / `amelia-v6-assets`, recarga de
                   /statistics con la red cortada). **Sin verificar:** la
                   actualización desde un navegador que ya tenía `amelia-v5`.
tests/             Vitest. unit/ no necesita nada; integration/ necesita el
                   stack local levantado.
supabase/migrations/0010_push_forbidden_streak.sql  La columna consecutive_403.
supabase/migrations/0011_push_cron.sql  pg_cron + pg_net: el job que llama a
                   /api/push/nursing-check cada minuto DESDE la base de la nube.
                   El token y la URL van por Vault, por nombre. Defensiva: en el
                   stack local, si faltan las extensiones, no agenda nada.
supabase/docker/   Stack local de Supabase sin el CLI (docker-compose.yml,
                   kong.yml, roles.sql). Escucha solo en 127.0.0.1.
scripts/local-stack.sh   Opera el stack (pnpm db:up / db:down / db:reset / db:env
                   / db:psql / db:status).
```

---

## 3. Comandos

```bash
# Dependencias
corepack enable             # una sola vez por máquina
pnpm install

# Base de datos local (necesita Docker corriendo)
# Stack propio en supabase/docker/ — escucha solo en 127.0.0.1, no el CLI de
# Supabase (bindeaba a 0.0.0.0). Ver supabase/docker/docker-compose.yml.
pnpm db:up       # genera claves la primera vez, levanta y migra
pnpm db:env      # escribe .env.test y las 3 claves de Supabase en .env.local
                 # (crea .env.local desde .env.local.example si no existe)
pnpm db:reset    # baja, BORRA el volumen y levanta de cero
pnpm db:down     # baja los contenedores (los datos quedan en el volumen)
pnpm db:psql     # psql como postgres
pnpm db:status   # contenedores y puertos — tienen que decir 127.0.0.1

# Desarrollo
pnpm dev                    # http://127.0.0.1:3000 — escucha solo en 127.0.0.1;
                             # para probar desde el teléfono en la LAN hace falta
                             # un túnel/SSH, a propósito

# Build / producción
pnpm build
pnpm start                  # http://127.0.0.1:3000 — como `dev`, escucha SOLO en
                             # 127.0.0.1

# Tests
pnpm test                   # unit (lib/format.ts, lib/queue.ts, lib/deviceTokens.ts,
                             # lib/changelog.ts, lib/i18n, lib/lastSeen.ts,
                             # buildActivity, keepLastGood y mergePending de
                             # lib/db.ts). Sin Docker
pnpm test:tz                # los mismos, bajo UTC / LA / Tokio / Kiritimati
pnpm test:integration       # RLS + endpoints. NECESITA el stack local
pnpm test:all               # test:tz + test:integration

# Lint / format
pnpm lint
pnpm format                 # escribe
pnpm format:check           # solo verifica

# Chequeo de tipos
pnpm exec tsc --noEmit
```

`pnpm build` también corre el type-check de Next, pero `pnpm exec tsc
--noEmit` es más rápido cuando es lo único que querés saber.

**La app escucha SÓLO en `127.0.0.1`, y ya no depende de que alguien se acuerde
del flag (25 sep 2026).** `next dev` y `next start` sin `-H` bindean a
`0.0.0.0`, o sea a la IP pública del VPS; pasó el 23 sep 2026 (el script
`start` era `next start` a secas) y otra vez el 24 sep 2026 (`pnpm exec next
start -H 172.17.0.1`, a mano, para que un contenedor llegara a la app). Las dos
veces lo encontró el vigía de puertos de Luis, no el agente.

Ahora los dos caminos pasan por **`scripts/next-loopback.mjs`**, que:

- **inyecta `-H 127.0.0.1`** cuando no se pasó ninguno;
- **rechaza** cualquier `-H` que no sea loopback, con el motivo y la
  alternativa en el mensaje (exit 1, sin abrir el puerto);
- deja intactos `build`, `lint`, `--version` y todo lo que no escucha.

Lo cubre `pnpm dev` / `pnpm start` **y también** `pnpm exec next`, `npx next` y
`./node_modules/.bin/next`: el `postinstall` (`scripts/blindar-next-bin.mjs`)
reescribe el shim de `node_modules/.bin/next` para que pase por el envoltorio, y
`pnpm install` lo vuelve a aplicar. Regresión: `tests/unit/nextLoopback.test.ts`.

⚠️ **`HOSTNAME=127.0.0.1` NO sirve para esto.** En Next 14 sólo `--port` está
atado a una env var (`.env('PORT')` en `next/dist/bin/next`); `--hostname` no lo
está, y `start-server.js` termina en `server.listen(port, undefined)`, que es
todas las interfaces. Medido el 25 sep 2026: con `HOSTNAME=127.0.0.1`,
`next start -p 3099` dejó `*:3099` en `ss -tln`.

Si de verdad hace falta que algo externo llegue a la app (un contenedor, el
teléfono), la salida es un túnel SSH, o correr el contenedor con
`--add-host=host.docker.internal:host-gateway`; **nunca** abrir el puerto en
otra interfaz. La válvula de escape existe, es explícita y queda en el log:
`AMELIA_BIND_PUBLICO=1`.

---

## 4. Convenciones de commit

Las del historial real de este repo (18 commits, verificado con
`git log`). **No se usa Conventional Commits** acá:

- Frase **imperativa en inglés**, en una línea, sin prefijo
  `feat:` / `fix:` / `chore:`.
- Describe el **efecto para quien usa la app**, no el archivo tocado.
- Sin cuerpo de mensaje, sin referencias a issues.

Ejemplos reales:

```
Add an oz/ml unit toggle for bottle and pumping amounts
Let feedings, diapers, nursing, sleep, and pumping be logged with a past time
Make it installable and able to survive bad wifi
Pin search_path on the RLS helper functions
```

Para un arreglo puro se aceptó el prefijo informal `Fix:`:

```
Fix: grant table privileges to authenticated role (RLS was blocked by missing GRANTs)
```

**Mantené este estilo.** Si alguna vez se migra a Conventional Commits,
que sea una decisión explícita, no una deriva commit a commit.

### 4.1 Versionado

- **vMAJOR.MINOR.PATCH.** La versión actual es `version` en `package.json`; el
  historial es `CHANGELOG.md`. La app muestra las dos en `/version` (engranaje
  → Version history). `tests/unit/changelog.test.ts` falla si no coinciden.
- **Qué dígito** (la tabla de §0.1 manda):
  - **PATCH** (`x.y.Z+1`): arreglos de bugs, copy, CSS, docs; sin
    funcionalidad nueva visible y sin schema.
  - **MINOR** (`x.Y+1.0`): funcionalidad nueva visible pero compatible, o una
    migración de schema que la acompaña. El PATCH vuelve a 0.
  - **MAJOR** (`X+1.0.0`): cambios grandes o incompatibles — incluido un
    cambio incompatible en la API de dispositivos. Poco frecuente acá. El
    salto a **1.0.0** está previsto para cuando la app esté desplegada y en
    uso real.
- Se sube **una vez por batch**, en el último commit del batch, junto con la
  entrada del CHANGELOG (en inglés, en términos de quien usa la app — mismo
  criterio que los commits). **Y todo push a `main` lleva al menos un bump**,
  sea batch o un cambio suelto — regla obligatoria de §0.1.

---

## 5. Reglas operativas

### 5.1 Gestor de paquetes

**pnpm, y solo pnpm.** `npm` y `yarn` están prohibidos en este repo — en
comandos, en scripts, en documentación y en mensajes de commit.

`scripts/only-pnpm.mjs` corre en `preinstall` y aborta si el gestor no es
pnpm. La versión sale de `packageManager` en `package.json`; en una
máquina nueva, `corepack enable` y listo.

`pnpm-lock.yaml` **va commiteado**, siempre. El "hueco conocido" de los
builds no reproducibles se cerró el 20 sep 2026.

> **Nota de pnpm 11:** la configuración del proyecto se lee de
> `pnpm-workspace.yaml`, no del campo `"pnpm"` de `package.json`, que pnpm
> ignora. Ese archivo **no** convierte el repo en monorepo: no tiene clave
> `packages`. Está ahí para permitir los scripts de instalación de
> `unrs-resolver` (eslint) y `esbuild` (vitest); sin eso, ni `pnpm lint` ni
> `pnpm test` arrancan.

### 5.2 Migraciones

- **Nunca edites una migración ya aplicada.** `0001` … `0008` son historia.
  Un cambio se hace con un archivo nuevo.
- **Quién numera.** Por defecto, un cambio de schema se **propone** en
  `proposals/` para el agente del Hub (ADR 0003). **Excepción:** cuando Emilio
  pide explícitamente implementarlo en este repo, se numera acá con el
  siguiente número libre (así nacieron `0007` y `0008`, 21 sep 2026). Cuando
  llegue el monorepo, estas migraciones entran como historia y la numeración
  pasa al Hub.
- `supabase/schema.sql` es una vista **consolidada de referencia**, no la
  fuente de verdad. La fuente son los archivos de `migrations/`.
- Toda tabla nueva nace con **RLS habilitada en la misma migración** que
  la crea. Sin excepciones.
- Recordá el bug de `0005`: RLS correcta no alcanza si falta el `GRANT`
  al rol `authenticated`. Postgres bloquea antes de evaluar la policy.
- Toda tabla nueva nace con grants por defecto a `authenticated` (lo dejó
  `0005`). Si una tabla es solo del servidor, `revoke all ... from anon,
  authenticated` en la misma migración — ver `0007`.

### 5.3 Acceso a datos

- **Las páginas nunca arman una query.** Todo pasa por `lib/db.ts`. Eso
  es lo que hace que la migración de fase 2 sea un solo archivo editado.
- **Excepción acordada (22 sep 2026): las queries de servidor del push viven
  en `lib/push/server.ts`.** `lib/db.ts` es `'use client'` (primera línea del
  archivo): meterle una query que corre en un route handler con
  `service_role` lo arrastraría al bundle del navegador. Así que el push tiene
  su propia puerta, `lib/push/server.ts`, que es *solo server*. La regla de
  fondo no cambia: **las rutas siguen sin armar una query**
  (`app/api/push/*/route.ts` solo llama a `lib/push/server.ts`), y en fase 2
  hay dos archivos que editar en vez de uno.
- **Nunca importes `lib/supabaseAdmin.ts` desde un archivo `'use client'`.**
  Lleva la `service_role` key, que salta RLS por completo. Solo route
  handlers.
- **Nunca prefijes un secreto con `NEXT_PUBLIC_`** salvo que sea
  genuinamente público. Ese prefijo lo envía al browser.
- **No agregues tablas nuevas cuyo scope sea un join por `baby_id`.**
  En fase 2 cada tabla lleva `household_id` directo.

### 5.4 Convenciones de datos

- Timestamps en **UTC** en la base. Se renderizan en
  `America/Los_Angeles` (la TZ del hogar, no la del visitante).
- Volúmenes **siempre en ml** en la base. `oz` es solo display/entrada.
- Peso y talla **siempre en kg/cm** en la base. `lb/oz/in` es solo display.
- **Borrado lógico:** se setea `voided_at`, nunca un `DELETE`. Toda
  lectura filtra con `.is('voided_at', null)`.
- Los IDs de fila se generan **en el cliente** (`newId()` en
  `lib/queue.ts`). No es un capricho: es lo que permite iniciar *y*
  terminar una sesión estando offline.

### 5.5 Offline y honestidad de estado

Esto es una regla de producto, no un detalle técnico:

- **Nada se presenta como guardado si no lo está.** Una escritura en cola
  se muestra como "not synced yet" en todos los lugares donde aparece.
- Una escritura que el servidor **rechazó** (policy, valor inválido)
  **no se encola** — reintentarla fallaría igual. Se muestra como error.
  Solo se encola lo que nunca llegó al servidor (`looksOffline()`).
- El service worker **nunca cachea una respuesta de Supabase**: llevan
  tokens de auth y esto corre en una pantalla compartida.

### 5.6 Alcance — qué NO hacer en este repo

Según `PROJECT.md`, y salvo que Emilio lo pida explícitamente:

- **No crear otro repo en GitHub** para este directorio. Ya hay uno:
  `origin` apunta a `git@github.com:emireymon09-create/repmonti09.git`
  (verificado con `git remote -v` el 20 sep 2026 — `PROJECT.md` decía que
  no había remote, y era falso). A futuro esto va a ser `apps/amelia`
  dentro del monorepo del Hub.
- **No crear un proyecto Supabase en la nube *nuevo*.** Ojo, esto cambió de
  sentido el 22 sep 2026: **ya hay uno, y es el que usa producción.** Lo que
  sigue prohibido es *crear otro*. Trabajá contra el que existe; la base
  compartida del Hub sigue siendo la del ADR 0001 y se resolverá en fase 2.
- **No construir calendario, comidas, tareas ni riego.** Eso es del Hub.

### 5.7 Textos de la UI — siempre por los diccionarios

Desde el 21 sep 2026 la app está en inglés y en español (`lib/i18n/`).

- **Todo texto visible pasa por `lib/i18n/en.ts` y `lib/i18n/es.ts`** — labels,
  botones, banners, `aria-label`, `window.confirm`/`alert`, estados vacíos. Un
  string literal en un componente es un bug. Se agrega la clave en `en.ts` (la
  fuente) y después en `es.ts`, que está tipado contra `en.ts`: si falta, no
  compila. En componentes, `const { t, lang } = useT()`; fuera de React,
  `translate(lang, key, vars)`.
- Variables con `{nombre}`; plurales con `{ one, other }` y `count`.
  `tests/unit/i18n.test.ts` exige las mismas variables en los dos idiomas y
  que ninguna clave quede sin traducir.
- El español es **rioplatense con voseo**, con el vocabulario del proyecto
  (toma, biberón, lactancia, pañal, sueño, extracción, crecimiento, turno).
- Las funciones de `lib/format.ts` que producen palabras, y `buildActivity` de
  `lib/db.ts`, toman `lang` como **último** parámetro, con default `'en'`.
  Inglés usa el locale `en-US` fijo; español, `es` (reloj de 24 h).
- **El server siempre renderiza inglés** (páginas estáticas cacheadas por el
  service worker); el idioma se resuelve en el cliente. **No se usa
  `Accept-Language`, a propósito.**
- **Quedan en inglés por diseño:** las notas del CHANGELOG en `/version`
  (marcadas `lang="en"`, con un aviso en español), el detalle crudo de un error
  de Supabase/Postgres dentro de un banner (el marco sí se traduce), y el
  manifest/metadata. El selector nativo de fecha sigue el idioma del
  navegador, no el de la app.

### 5.8 El feed de calendario no tiene login, y es una decisión

`/api/calendar/<token>.ics` (24 sep 2026) devuelve los turnos médicos de una
familia **sin sesión, sin cookies y sin ningún header que podamos elegir**. No
es una omisión de seguridad: es lo único que un cliente de calendario sabe
hacer. iOS, Google Calendar y Thunderbird piden una URL y la vuelven a pedir
cada hora; no mandan credenciales y no hay forma de que lo hagan.

**La URL es el único control de acceso.** Con todas las letras:

- **Qué expone quien tenga el link:** título, tipo, hora, doctor y notas de los
  **turnos médicos** de esa familia. Nada más — ni tomas, ni pañales, ni sueño,
  ni peso, ni los nombres de los padres, ni nada que permita entrar a la app.
- **El token no es el `family_id`.** Es uno opaco y dedicado (`acal_` + 256
  bits), en su propia tabla (`calendar_feeds`, 0012), y la base guarda **solo
  el sha-256**: quien lea la base no se lleva un link que funcione.
- **Se rota generando otro**, que pisa la fila (`family_id` es la PK) y deja
  muerto el anterior **en el acto**. Es lo que hay que hacer si el link se
  compartió sin querer, y por eso no hay historial de tokens: un token viejo
  que siguiera sirviendo no sería una rotación. El `window.confirm` de Settings
  dice que los calendarios suscritos hay que reapuntarlos.
- **Un token mal formado y uno inexistente contestan lo mismo (404).**
  Distinguirlos le diría a quien prueba tokens cuáles tienen la forma buena.
- **El feed nunca entra a una caché**: `Cache-Control: private, no-store`.

Si alguna vez esto tiene que dejar de ser público, la salida no es agregarle
un login —rompería toda suscripción existente— sino dejar de publicar el feed.

---

## 6. Estado real — qué está y qué no

**Construido y funcionando:** auth, dashboard **de tres tarjetas** (Comida /
Pañal / Dormir — 22 sep 2026; ya **no** tiene el feed de Today, la tarjeta de
próximo turno ni "Log a missed session"), las **tres páginas de sección**
`/feeding`, `/diapers` y `/sleep`, **`/statistics`** (23 sep 2026 — la pantalla
existe y es destino real, pero **todavía no dibuja nada**), Milk (extracción),
Growth con editar/borrar (0008), Doctor, History con editar/borrar, PWA instalable, cola offline,
**RLS en las 13 tablas** (las 11 originales; `device_tokens`, la 12ª, con RLS
y **sin acceso** para `anon`/`authenticated` — solo `service_role`; y
`push_subscriptions`, la 13ª desde 0009, con RLS por `family_id` **directo**,
`revoke all` a `anon` y las cuatro operaciones a `authenticated`), los dos
endpoints de dispositivo, **tokens por dispositivo** (`device_tokens`,
0007 — cada dispositivo tiene el suyo, revocable, clavado a una familia y
opcionalmente a un bebé; reemplazó a los secretos compartidos
`NUC_DEVICE_SECRET`/`QUICK_TOGGLE_SECRET`), **middleware de auth
server-side**, **lockfile de pnpm**, **lint y format**, **historial de
versiones en `/version`** (al pie del menú), **tema claro pastel
seleccionable** (Settings → Theme: Light / Dark / System, por dispositivo),
**idioma español / inglés** (Settings → Language: System / English / Español,
por dispositivo en `localStorage` `amelia:lang`; "System" sigue a
`navigator.languages` — gana el primer idioma soportado, si no hay ninguno,
inglés — 21 sep 2026, `lib/i18n/`), **apertura sin conexión** (copia
guardada por dispositivo con aviso de cuándo es, páginas precalentadas por el
service worker tras iniciar sesión — 22 sep 2026), **sync robusta** (replay
idempotente, lock entre pestañas, reintento solo y descarte de un rechazo — 22
sep 2026), **aviso push de toma de pecho larga** (Settings → Nursing alerts,
por dispositivo; 0009 + `lib/push/` + `web-push`/VAPID — 22 sep 2026, **pero
nadie llama al check todavía**, ver §7), **corrección del inicio de una sesión
en curso** (23 sep 2026, ver más abajo), **la barra de abajo pegada al borde en
iPhone** (pasó de `fixed` a `sticky`, 23 sep 2026 — ver más abajo), y **una
suite de tests**.

**Las tres páginas de sección** (`app/{feeding,diapers,sleep}/page.tsx`, las
tres montan `components/SectionPage.tsx`): KPIs de las **últimas 24 horas**
(ventana **rodante** desde el 23 sep 2026 — ver más abajo) y de los **últimos
7 días** (hoy + los 6 anteriores, TZ del hogar; `lib/kpis.ts`, puro), el log
completo debajo con editar y borrar (soft-delete `voided_at`, un panel a la
vez, el foco vuelve al Edit) y **"Log a past one"** con "Finished / Still
going" — una sesión en curso con inicio pasado, bloqueada si ya hay una
activa. Las lecturas son `feedingsSince` / `nursingSince` / `diapersSince` /
`sleepSince` en `lib/db.ts`, **sin `limit`** (un total cortado en las N filas
más nuevas sería silenciosamente falso) y trayendo las sesiones que cruzan el
inicio de la ventana. Las tres están en `middleware.ts`, en
`lib/offlinePages.ts` y en el `PRECACHE` de `public/sw.js` (que pasó a
`amelia-v6` el 23 sep 2026, con `/statistics`).

**"Hoy" pasó a ser las últimas 24 horas (23 sep 2026).** La tarjeta corta de
`/feeding`, `/diapers` y `/sleep` contaba desde la medianoche del hogar: a las
00:05 los números se ponían en cero y una toma de las 23:50 desaparecía.
`kpiWindows().today` se renombró a **`last24h`** —el nombre también mentía— y
la ventana es `{ ahora − 24 h, ahora }`. La etiqueta dice **"Last 24 hours" /
"Últimas 24 horas"**. Verificado por el auditor con datos a los dos lados del
borde: 3 tomas y 11,5 oz en 24 h contra 1 toma y 5,1 oz con la ventana vieja.
Tres cosas que conviven a propósito y hay que tener claras:

- **`week` NO cambió**: sigue siendo hoy + los 6 días de calendario anteriores.
  Hay una pregunta abierta para Luis (§7.7).
- **El log de abajo sigue agrupado por día de calendario.** Una fila de ayer
  puede aparecer bajo el encabezado de ayer y a la vez contar en la tarjeta de
  24 h. Son dos preguntas distintas y ahora se escriben distinto.
- **La lectura cubre la ventana**: `SectionPage` lee desde
  `startOfHouseholdDay(now, 6)`, que siempre es ≤ `now − 24 h`. Está probado
  (`tests/unit/kpis.test.ts`), porque un total corto saldría corto **en
  silencio**.

**El sistema muestra siempre onzas (23 sep 2026).** Se borró
`lib/useVolumeUnit.ts` y con él la preferencia oz↔ml por dispositivo; queda
`DISPLAY_UNIT = 'oz'` en `lib/format.ts`. **No hubo migración de datos y no
hacía falta**: la columna es `amount_ml` y siempre guardó ml — la preferencia
solo afectaba el render y el parseo. Para *entrar* un número en ml está el
toggle por-campo de `components/AmountUnit.tsx`, al lado del campo de cantidad
de biberón (dashboard y "Log a past one" de `/feeding`): vale para esa entrada
sola, no se guarda, y vuelve a `oz` al montar la tarjeta **y después de cada
guardado exitoso**. Lo tipeado en ml se guarda tal cual (150 → `150`); lo
tipeado en oz se multiplica (4 → `118.294`). **No se convierte ml → oz → ml al
guardar**: sería perder precisión sin ganar nada.

**Correr el inicio de una sesión en curso (23 sep 2026).** Mientras hay una
lactancia corriendo, el lugar del campo de cantidad + Biberón lo ocupa un campo
numérico abierto ("empezó hace … minutos") y el botón que lo aplica; la tarjeta
Sleep, que no tiene selector de tipo, lo suma debajo de "She's awake". Es
**acumulativo** y escribe de verdad, por `updateNursing`/`updateSleep` ⇒ pasa
por la cola offline y se marca "Not synced yet" como todo lo demás. Validación
pura en `shiftStart` (`lib/kpis.ts`): número finito, > 0, ≤ 240 min por
aplicación y el resultado no puede quedar más de 12 h atrás. **Antes de
escribir se relee la fila** (`sessionById`): si el otro teléfono ya la terminó,
no se escribe nada y el banner lo dice — sin eso, una toma de 10 minutos
quedaba registrada como de 70 mientras la pantalla decía "Start moved back
60 min" (medido por el auditor). La relectura se saltea en dos casos, a
propósito: con el navegador diciendo `offline` (la escritura se encola igual y
esperar una lectura condenada costaría ~7 s), y cuando la fila todavía es un
insert **en la cola** — ahí el UPDATE directo matchearía 0 filas y PostgREST lo
llamaría éxito, así que se fuerza el camino de la cola (`queueOnly`).

**Settings, y el menú como lista (23 sep 2026).** Los ajustes que vivían
adentro del desplegable —Theme, Language, Nursing alerts y cerrar sesión— se
mudaron enteros a **`/settings`** (`app/settings/page.tsx`), la última entrada
del menú. La unidad oz↔ml y "Reset milk total" se mudaron ese mismo día y
**después se fueron del todo** (frentes 4 y 5): no están ni en el menú ni en
Settings. **No quedó ninguna copia en el menú** (verificado en el DOM: 0
`.seg`, 0 `.nav-menu-item`). El menú pasó de una grilla de 2 columnas a **una
sola columna** y hoy tiene **diez** entradas: Today, Feeding, Diapers, Sleep,
Milk, Stats, Growth, Doctor, History, Settings — medido a 390px: las 10 con el
mismo `left` (151) y el mismo ancho (226), 52px de alto cada una, menú de
598px en una ventana de 844 (no scrollea). Today y Milk se repiten con la barra
a propósito: el menú es el índice de la app. "Version history" salió de la
lista: el número de versión va **al pie** del menú, chico y alineado a la derecha, y es
el enlace a `/version` — era su única puerta. El ícono del botón **Menu** pasó
a ser **tres líneas verticales** (`ICONS.menu`, `M7 5v14 / M12 5v14 / M17 5v14`);
los sliders que tenía ahora nombran a Settings. **No hay librería de íconos en
este repo** y no se agregó ninguna: siguen siendo SVG de trazo a mano.

**El nav del teléfono: de seis a dos (22 sep) y de dos a cuatro (23 sep
2026).** La barra de abajo había bajado de seis ítems (cinco pestañas + el
engranaje) a **dos: Today y Menu**; el 23 sep 2026 pasó a **cuatro: Today ·
Milk · Stats · Menu**. Medido a 390×844: los cuatro de 94,5 px de ancho y
**56,7 px** de alto táctil, ninguno cortado, `horizScroll` 0 en los dos
idiomas. Las etiquetas se acortaron a **`Stats` / `Datos`** —a 390px entraban
enteras, pero a 320px "Estadísticas" mide 74,5 de 77 px, el mismo motivo por el
que "Crecimiento" ya era "Medidas"—; el nombre largo está en el `<h1>` de la
página. Qué pestañas se ven en el teléfono ya **no** se decide por el orden de
la lista (`:not(.tab-home)`) sino con un `phone: boolean` explícito por ítem en
`components/ui.tsx`. En tablet y en la pantalla de pared la barra queda igual
en naturaleza pero pasó a **7 ítems** (6 pestañas + Menu), sin cortes ni scroll
horizontal. El resto de las pantallas vive en el menú, que reusa el patrón de
siempre (`aria-haspopup="menu"`, `aria-expanded`, Escape con el foco de vuelta
al botón, `pointerdown` afuera).

**Y la barra dejó de ser `fixed`: ahora es `sticky` (23 sep 2026).** En un
iPhone real (16 Pro, iOS 26.6.2, **app instalada** desde la pantalla de
inicio) la barra fija se despegaba del borde durante el scroll y quedaba
flotando sobre el medio de la lista; al soltar volvía sola abajo. Pasaba en
varias pantallas y en las dos orientaciones, y también en cada transición
cargando→cargado. **No era nuestro CSS:** en todo el repo no hay un solo
`transform`, `filter`, `overflow`, `will-change`, `contain` ni
`backdrop-filter` en ningún ancestro de la barra (la cadena es
`html > body > .page > nav`, y `I18nProvider` no renderiza ningún elemento),
así que el containing block estaba sano. Es WebKit, que trata los elementos
fijos como capas atadas al viewport y las reposiciona recién al terminar el
gesto; una barra sticky viaja dentro del contenido scrolleado y no tiene esa
capa. Tres piezas, todas en `@media (max-width: 599px)` de `app/globals.css`:
`.page` pasa a columna flex con `min-height: 100dvh` (sticky solo se queda
abajo si su contenedor llega abajo), `.nav` lleva `order: 1` + `margin-top:
auto` (última en la columna **sin moverse del DOM** — de 600px para arriba la
barra va arriba y nada de esto aplica) y `width: 100vw` con
`margin: auto calc(50% - 50vw) 0` para quedar de borde a borde, que es lo que
hacía `left: 0; right: 0`. `.page` **ya no reserva** el alto de la barra con
padding: una sticky se corre sola al terminarse el documento. Detalle y
números en `design.md` §5.11. **Sin verificar acá: que el salto desaparezca en
un iPhone** — este VPS no tiene WebKit ni iOS y la emulación de Chromium no
implementa el toolbar dinámico ni las capas fijas de WebKit. Lo que sí está
medido es que no rompe nada (132 combinaciones, abajo) y que la barra queda
pegada al borde en cada posición de scroll y en los 241 cuadros de una
navegación real.

**Estados vacíos que ocupan la pantalla (23 sep 2026).** `/growth` y
`/appointments` sin una sola fila terminaban en la tarjeta del formulario y
dejaban todo lo de abajo en blanco hasta la barra. El hueco no estaba **entre**
hermanos —por eso la medición del pase anterior no lo vio— sino **después** del
último. Ahora esas dos páginas, y solo cuando no hay ninguna fila, ponen un
`.empty-fill` que se queda con el alto sobrante y centra ahí un `EmptyState`
(ícono de la sección + título + una línea que dice qué va a aparecer).
**Con datos no cambia nada**: `.page` sigue en `display: block` y
`min-height: 0` (el `:has(.empty-fill)` no matchea), 0 `.empty-fill` en el DOM,
mismo alto de documento.

**Y el hallazgo que corrige la medición anterior (23 sep 2026):** los números
"412 → 38" y "686 → 38" que quedaron escritos eran **de caja, y 38 es una
constante**. `.empty-fill` es `flex: 1 1 auto` con `align-items: center`, así
que la caja termina siempre a la misma distancia de la barra pase lo que pase
adentro: medir la caja era medir el `flex: 1`, no el blanco. La métrica que
sirve es la **tinta** —el último elemento con texto o `<svg>`—, y por tinta el
blanco seguía ahí. Medido (390×844, oscuro, inglés, sin una sola fila),
antes → después: Doctor **306,7 → 92,2**, Today **261,3 → 68,7**, Growth
**157,7 sin cambio**. Doctor se arregló abriendo su formulario cuando no hay
ningún turno (lo que `/growth` ya hacía), no tocando el CSS. Today, que nunca
había tenido `.empty-fill`, ahora lo monta en su estado sin datos.

**Remedido el mismo día, después de pasar la barra a `sticky`:** los tres
huecos bajaron **19,2 px** exactos, porque `.empty-fill` ya no se centra contra
los 100 px que reservaba la barra fija sino contra la barra de verdad. Doctor
**73,0**, Today **46,5** (37,5 en español), Growth **138,5**, Statistics
**267,5** (258,5 en español). El tema no cambia un píxel, la barra sigue
arrancando en `top: 782,3` y `docH` sigue en 844 en las 16 combinaciones. Y la
constante de caja pasó de 38,3 px a **0,0 px**: la caja ahora termina justo
donde empieza la barra. Las cifras "con datos" no se mueven.

**La transición loading→contenido (23 sep 2026).** El pase anterior sacó el
pantallazo blanco metiendo el `<Nav>` en el estado de carga; quedaba el salto
seco entre "Loading…" y el contenido. Primeros **tokens de movimiento** del
proyecto (`--motion-enter: 180ms`, `--motion-wait: 120ms`, `--ease-out`) y dos
reglas: todo lo que la página pinta al terminar de cargar entra con un
`@keyframes enter` de opacidad, y el `"Loading…"` (`.loading-note`) arranca
recién a los 120ms. Medido cuadro por cuadro con rAF y un clic real en el
`<Link>` de Growth: **antes** el "Loading…" se veía 3 cuadros a opacidad 1 y el
contenido aparecía directo en 1; **después** el "Loading…" se ve **0 cuadros**
y el contenido sube 0 → 0.25 → 0.47 → 0.64 → 0.76 → 0.85 → 1 en ~180ms. Con la
CPU a 1/6 el "Loading…" sigue sin verse y el fundido es igual; con
`prefers-reduced-motion: reduce` no hay fundido (0→1 en un cuadro). El `<nav>`
queda **afuera** de la animación —React reusa ese nodo— y midió opacidad 1 en
todos los cuadros, 0 cuadros sin nav.

**Today, la cabecera y las tarjetas (22 sep 2026).** Nombre con la **edad
debajo, en su propio renglón** (en gris y sin el peso del título) y la fecha de
hoy arriba a la derecha con `longDate()`, el formato por idioma de siempre. La
edad estuvo en la misma línea que el nombre entre el 22 y el 23 sep 2026: se
**revirtió** por pedido de Luis, se leía peor. A 390px la reversión no cambia
nada medible —el nombre y la edad ya envolvían a dos renglones en la columna
angosta—; la línea única solo existía de 768px para arriba (la tinta de Today
bajó 20 px a 768 y 27 px a 1440). Las
tres tarjetas llevan un botón-ícono en la esquina que abre su sección, y en la
pared miden **lo mismo** (455/455/455 medidos): lo iguala el grid con
`align-items: stretch`, no un alto elegido a ojo, y el pie se apoya abajo con
`margin-top: auto`. En el teléfono, apiladas de a una, conservan su alto
natural: igualarlas ahí sería agregar aire.

**El "pantallazo" entre pantallas (22 sep 2026).** Causa real, medida con CDP
cuadro por cuadro: **no era el fondo** —el tema nunca se pierde, 0 cuadros con
fondo claro o sin `data-theme`— sino que el `if (loading)` de las seis páginas
devolvía `<Page>` **sin `<Nav>`**. Durante esa ventana la pantalla quedaba
entera vacía, barra de abajo incluida. Ahora el nav se renderiza también
mientras carga; la ventana sin contenido sigue existiendo (33 ms en este
servidor, más con mala conexión) pero la app nunca queda sin marco.

**El aviso push**, en concreto: migración `0009_push.sql` —
`push_subscriptions` (RLS y GRANTs en la misma migración, scope por
`family_id` directo), `nursing_sessions.long_alert_sent_at` y el scope
`push_check` en `device_tokens`. Claves VAPID:
`NEXT_PUBLIC_VAPID_PUBLIC_KEY` es pública a propósito (el navegador la
necesita para suscribirse); `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` son **solo
server**, y `pnpm db:env` las genera con `scripts/vapid-keys.mjs` solo si
faltan (pisarlas mata todas las suscripciones que ya hay).
`/api/push/subscription` corre con la **sesión del padre** (anon + cookies,
`lib/supabaseRoute.ts`) ⇒ todo pasa por RLS; `/api/push/nursing-check` corre
con `service_role` y se autentica con un token de dispositivo de scope
`push_check`. El aviso sale **una sola vez por sesión** gracias a un
`update … where long_alert_sent_at is null returning`, y si ningún envío salió
bien la marca **se devuelve a null** (campo `released` de la respuesta) para
que el próximo check reintente.

**Alcance exacto de los tests** (que no es "hay tests" a secas):

| Cubierto | Archivo |
|---|---|
| `lib/format.ts` — fechas, horas, DST, unidades, edad; ida y vuelta oz↔ml con cantidades de biberón reales (2–8 oz y 60–240 ml) y que `DISPLAY_UNIT` es `'oz'` | `tests/unit/format.test.ts`, bajo cuatro TZ |
| `lib/queue.ts` — orden de replay, descartes, `looksOffline`, `newId`; replay de un alta que ya está en el server, lock entre pestañas (`withFlushLock`, con y sin Web Locks), timeout por envío, `syncOnce` (cuándo relee la página), `retryDelay` (5 s → 15 s → 60 s, nunca ante un rechazo), nudges, y descartar un rechazo con sus ediciones dependientes | `tests/unit/queue.test.ts` |
| `lib/deviceTokens.ts` — formato del token, hash, scopes | `tests/unit/deviceTokens.test.ts` |
| `lib/changelog.ts` — parseo del CHANGELOG y que su primera entrada coincida con `version` de `package.json` | `tests/unit/changelog.test.ts` |
| `buildActivity` de `lib/db.ts` — texto del feed de Today y de History (sin repetir el tipo); sesiones de lactancia y sueño en curso (marcadas, primero en Today aunque empezaran antes de medianoche); valores que ningún diccionario conoce | `tests/unit/activity.test.ts` |
| `lib/lastSeen.ts` — copia guardada por página y bebé, `forgetSeen`, `seenState`/`lastGood` ("saved" / "nothing"), corte a mitad de sesión con el navegador "online", storage que se niega | `tests/unit/lastSeen.test.ts` |
| `keepLastGood` y `mergePending` de `lib/db.ts` — qué se ve offline: últimas filas buenas por lectura, cola encima, un alta encolada que el server ya devolvió no se duplica | `tests/unit/pending.test.ts` |
| `lib/kpis.ts` — la ventana **rodante de 24 h** (cruce de medianoche: una fila de las 23:50 de ayer cuenta a las 00:10 y **con la ventana vieja no contaba**, así que el test falla si alguien revierte esto; el borde exacto, 24 h sí y 24 h 1 min no; los dos cambios de horario; y que la lectura de la sección cubre la ventana — `startOfHouseholdDay(now,6) <= now−24h`, la red contra un total corto en silencio) y la de los últimos 7 días (días de calendario, no 6×24 h), solapamiento de una sesión con la ventana; totales de comida, pañal y sueño; una fila en cola cuenta y marca `pending`, un borrado en cola deja de contar y también marca, una fila en cola fuera de la ventana no marca; `lastFeedingEvent` (ignora una sesión en curso); `checkPastRange` (futuro, fin antes del inicio, vacío); `shiftStart` (resta simple, acumulativo, decimales, 0 y negativos, campo vacío / letras / `Infinity` / fecha inválida, el tope de 240 y el de 12 h **evaluado sobre el resultado**, que es el que tapa una suma de correcciones chicas); `formatDuration` | `tests/unit/kpis.test.ts` |
| `lib/push/retry.ts` — la política de 403: suma solo si otra del lote recibió, borra al tercero, "todas en 403" no borra nada ni toca contadores (VAPID del servidor), una sola suscripción en 403 nunca se borra sola, un OK reinicia la racha, un 410 no cuenta como 403 | `tests/unit/push.test.ts` |
| Los dos caminos del 403 por el camino real (base + servicio de push falso): el selectivo (racha 1→2→3 y se borra SOLO la muerta), el OK que reinicia, "todas a la vez" tres veces seguidas sin borrar nada, y volver a suscribirse desde la ruta | `tests/integration/push.test.ts` |
| `lib/push/{nursing,endpoint,client}.ts` — umbral de 30 min exacto e inclusivo, con offset horario y sin minutos negativos; una sesión terminada, borrada o ya avisada no califica; el payload en los dos idiomas, con tag y Topic por sesión; un `lang` guardado desconocido cae en inglés; a quién se le manda (un envío por endpoint, la fila más reciente, nadie que ya no sea de la familia); la allowlist de endpoints (nada de http, hosts internos, look-alikes, puertos ni credenciales); el body de suscripción campo por campo; y el estado del control cuando la suscripción del navegador es de otro par de claves VAPID o el server no contesta | `tests/unit/push.test.ts` |
| `lib/i18n` — `es` con exactamente las claves de `en`, sin vacías ni sin traducir y con las mismas variables; `translate` (interpolación, variable faltante visible, plurales); detección de idioma y elección guardada; que el script de `lib/i18n/boot.ts` decida igual que `resolveLang()`; `lib/format.ts` y `buildActivity` en español; `translate` con una clave armada desde datos que no existe; `describeWrite` | `tests/unit/i18n.test.ts` |
| Aislamiento entre familias por RLS, por el camino real (PostgREST + JWT) | `tests/integration/rls.test.ts` |
| Corregir y retractar `growth_measurements` sin cruzar de familia | `tests/integration/rls.test.ts` |
| Los dos endpoints de dispositivo: auth, validación, rate limit, scoping | `tests/integration/{ingest,quick-nurse}.test.ts` |
| Las lecturas `*Since` de `lib/db.ts` por el camino real: la sesión que cruza el inicio de la ventana y la que sigue en curso vienen, lo viejo y lo borrado no; tomas y pañales desde el inicio inclusive; sin `limit` (más de 20 filas en la ventana vienen todas); con RLS, pedir el bebé de la otra familia no devuelve nada. Y `sessionById` (23 sep 2026): la sesión en curso viene con `ended_at: null`, una terminada viene **con** su `ended_at`, una retractada y un id que no existe son `null` (no una fila fantasma ni un error), y la sesión de la otra familia se lee como si no estuviera | `tests/integration/since.test.ts` |
| Push, contra la base y un servicio de push falso local que **descifra** el payload: RLS de `push_subscriptions` (cada padre solo su fila — ni el otro padre de la misma familia la ve; nadie inserta a nombre de otro ni con la familia de otro; `anon` no lee nada; el CHECK de https); `/api/push/subscription` (401 sin sesión, 400 con body inválido, guarda con la familia del padre y actualiza el idioma sin duplicar, 403 con un bebé de otra familia, DELETE); y `/api/push/nursing-check`: quién entra (sin token 401, revocado 401, sin el scope 403), marca **una sola vez** y manda cifrado y firmado en el idioma de cada dispositivo, dos checks en paralelo → una marca y un envío por endpoint, GET igual que POST, el umbral (29 min no, 31 sí), no cruza de familia ni de bebé, un 410 borra la suscripción, un 500 no la borra y **saca la marca** para reintentar, y sin claves VAPID no marca nada (503) | `tests/integration/push.test.ts` |
| Replay de la cola por el camino real (`sendOpWith` de `lib/db.ts`): alta repetida y dos "pestañas" a la vez → sin error y una fila (`ON CONFLICT (id) DO NOTHING`); el reenvío no pisa una edición; la escritura online sigue siendo insert común (un id repetido es error); señal abortada = offline y no escribe; con RLS real no cruza de familia (alta contra el bebé de otra familia rechazada; reusar el id de una fila ajena no la toca) | `tests/integration/queue-replay.test.ts` |

**NO hay tests de componentes ni de páginas.** Lo que se cubre es `lib/`
y la base.

**Countdown real, alertas configurables, tarjeta de cita, semana de vida,
gráficas y calendario .ics (24 sep 2026).** El pase entero, y lo que hay que
saber de cada frente:

- **El countdown de Today dejó de ser un promedio.** Hasta hoy la línea "Next
  feeding" salía de `predictNextFeeding` y "Next nap" de `predictNextNap`
  (`lib/db.ts`), que **promediaban los últimos 6 intervalos**. El pedido decía
  "reemplazar el cálculo hardcodeado": **no había ninguno**, y conviene tenerlo
  escrito porque el cambio es real, no el relleno de un placeholder. El
  promedio se autocorregía solo tras un estirón; el umbral fijo no. A cambio,
  un umbral **sí puede disparar un aviso** ("llegó al promedio" es una
  estadística, no una condición de alerta) y lo pone el padre. La lógica pura
  está en `lib/schedule.ts`; las dos funciones viejas se borraron.
- **Se mide desde el FIN del último evento, no desde su inicio.**
  `predictNextFeeding` medía desde el inicio (`lib/kpis.ts` lo decía explícito).
  Una toma de 40 minutos no vence tres horas después de *empezar*. Para un
  evento puntual (biberón, sólido) el fin es `fed_at`, que es la única columna
  que hay; para una toma terminada es `ended_at`; **con una sesión en curso no
  vence nada**, y eso es lo que preserva —ahora por construcción, no con un
  `if` aparte— el ocultamiento de la línea durante una lactancia.
- **Los dos umbrales son un dato de FAMILIA, no del dispositivo.** Es la
  diferencia con Theme, Language y Nursing alerts, que están en la misma
  pantalla y viven en `localStorage`: los dos padres tienen que ver el mismo
  número, y el **servidor** lo lee para decidir si manda el aviso.
  `family_settings` (0012), scope `family_id` directo. **No pasan por la cola
  offline**, a propósito: son un dato compartido y una cola que los aplica
  tarde podría pisar lo que el otro cambió. Sin conexión la pantalla lo dice y
  no guarda nada.
- **El aviso de comida/siesta se repite cada ~30 min** mientras siga vencido, y
  **un evento nuevo reinicia el ciclo** — sin esa tercera condición, un aviso
  del ciclo anterior podía callar al siguiente media hora. La regla es pura
  (`shouldAlert`, `lib/push/schedule.ts`). La marca se **toma antes de mandar y
  de forma atómica** (compare-and-set sobre la columna), y **se devuelve si no
  le llegó a nadie**: un aviso que sale sin quedar marcado se repite cada
  minuto.
- **La tarjeta de próxima cita volvió a Today**, debajo de las tres y solo
  dentro de las **36 horas** previas. Se agrega, no reemplaza nada. **Sin borde
  de color**: el borde de color se gasta en `.card.is-live` y nada más. El
  recordatorio push sale **24 h antes y una sola vez** por cita
  (`doctor_appointments.reminder_sent_at`, 0012, mismo patrón que 0009) — una
  cita no cambia con el tiempo, repetirla cada media hora sería spam.
- **`/statistics` dibuja.** Cuatro tarjetas —comida, pañales, sueño,
  crecimiento— con los KPIs de la semana elegida arriba y una gráfica abajo.
  **Barras** para las tres primeras (cantidades discretas que se comparan entre
  días) y **línea** para el peso (magnitud continua: lo que importa es la
  pendiente). El eje Y del peso **no arranca en cero**, a propósito: entre 3,9
  y 4,3 kg un eje desde cero dibuja una línea plana. **No se agregó ninguna
  librería de gráficas**: son SVG a mano, como los trece íconos.
- **La "semana de vida" NO es la ventana `week` de `lib/kpis.ts`.** Es la
  semana 1, 2, 3… desde `babies.birth_date`: un tramo **fijo** del calendario
  que no se mueve, por eso se puede elegir y comparar. `lib/lifeWeek.ts`, en
  días de calendario del hogar (una semana con cambio de horario dura 169 h, y
  hay test). **Sin `birth_date` no hay semana y no se inventa una**: la
  pantalla dice qué falta y dónde se carga.
- **El selector de semana sustituyó la tarjeta de "Last 7 days"** en
  `/feeding`, `/diapers` y `/sleep`. La de 24 h y el log de abajo no cambiaron.
  La lectura cubre **la más vieja de las dos ventanas**: un total cortado corto
  saldría corto en silencio.
- **Feed de calendario `.ics`** (`/api/calendar/<token>.ics`), de solo lectura,
  **sin login a propósito** — ver §5.8. Token opaco `acal_…` dedicado, **nunca
  el `family_id`**, del que la base guarda solo el sha-256 (`calendar_feeds`,
  0012, mismo espíritu que `device_tokens` de 0007). **Rotar = generar uno
  nuevo**, que pisa la fila y mata el link viejo en el acto.
- **Los tres checks nuevos viven en `/api/push/nursing-check`**, no en
  endpoints nuevos. El nombre quedó chico y se dejó igual: el techo de
  `lib/deviceAuth.ts` es **por IP, no por endpoint** (§7, pregunta 4), y `0011`
  ya está escrita y en camino a la nube con ese jobname, la URL en Vault y el
  token `push_check`. Un endpoint nuevo sería un secreto más en Vault, un job
  más y otra corrida manual en producción. **Consecuencia buena: el único paso
  manual nuevo en la nube es aplicar `0012`** — ni Vault, ni cron, ni variables
  nuevas. Detalle en `docs/aplicar-en-la-nube-0012.md`.

**Tres arreglos del 25 sep 2026 (v0.10.1).** (1) La barra de abajo nacía unos
píxeles arriba al abrir la app **de cero** en un iPhone instalado y se asentaba
sola al primer scroll — mecanismo distinto al de §5.11, que ya está cerrado.
`.page` se anclaba con `min-height: 100dvh` y el `dvh` es lo que WebKit
recalcula tarde; ahora hay `html, body { height: 100% }` y un
`min-height: 100%` después de las líneas de `vh`/`dvh`, que no dependen de esa
unidad. **Chromium no reproduce el bug de WebKit y `display-mode: standalone`
no se pudo emular en chrome-headless-shell** — lo medido acá es que el cambio
no mueve un píxel (18 combinaciones idénticas) y que un `dvh` corto produce
exactamente el síntoma; **la confirmación depende del iPhone de Luis**.
(2) El "hace X" de la tarjeta de Comida de Today contaba desde que la toma
**empezaba**: una toma de 45 min recién terminada decía "1h 35m ago" en vez de
"50m ago". `lastFeedingEvent` (`lib/kpis.ts`) pasó de `at` a **`endedAt`**, y
ese instante también **ordena** — un biberón del medio de una toma larga ya no
le roba el lugar. Era el **único** lugar del repo con el patrón (se revisaron
los seis usos de `timeAgo`). (3) `/statistics`: el selector de semana estaba
pegado borde con borde a la primera tarjeta (**0 px** medidos a 390 y 1440);
ahora los separa `--col-gap` (12 px / 20 px). Detalle y números: `design.md`
§5.18.

**Hallazgos del barrido general del 25 sep** (144 combinaciones: 12 pantallas ×
3 anchos × 2 temas × 2 idiomas; `horizScroll` 0, texto cortado 0, contraste AA
0 fallas sobre 7 760 elementos): targets táctiles de `.linkish` y del toggle
oz/ml por debajo de 44 px, y el desborde de 24 px de `/pumping` a 1440 en
español — que **contradecía lo que este archivo decía más abajo** sobre ese
recorte. Quedaron sin tocar ese día porque los dos eran decisiones de diseño,
no arreglos sin ambigüedad. **Luis los aprobó y se cerraron el mismo 25 sep
2026 (v0.10.3)** — ver el párrafo siguiente.

**Los dos arreglos que faltaban del 25 sep 2026 (v0.10.3).**

- **Todo target táctil llega a 44 × 44 px.** `.linkish` era `padding: 0` sin
  ningún mínimo, así que su área de toque era la de su texto: medido con datos
  reales, **47,6 × 18** el toggle "lb / in" de `/growth` (66,7 × 24 en la
  pared), **219,5 × 18** el enlace de `/login` (236,2 en español), **33,3 × 44**
  el "Edit" de cada fila del log en `/feeding`, `/diapers`, `/sleep`,
  `/pumping`, `/growth` e `/history` —el alto se lo daba una regla suelta de
  `.feed-actions`, el ancho no se lo daba nadie— y **36 × 52** el segmento
  oz/ml de `/dashboard` (`.seg-inline .seg-btn`, `min-width: 3em` = 36 px con
  `--t-meta` a 12 px). El piso pasó a ser un **token, `--tap-min: 44px`**, que
  es otra cosa que `--tap` (52 px en el teléfono, 84 en la pared: el tamaño
  *cómodo*, no el mínimo). `--tap-min` lo aplica `.linkish` en las **dos**
  dimensiones, `.seg-inline .seg-btn` como `max(3em, var(--tap-min))`, y
  reemplaza los **seis 44px sueltos** que ya había en `.pill`, `.tab`, `.gear`,
  `.nav-menu-version`, `.seg-btn` y la regla de `.feed-actions` (esa última se
  borró: el piso ahora es de `.linkish`). **Medido antes y después, 144
  combinaciones cada vez:** targets por debajo de 44 px **11 distintos → 0**.
  Lo que mueve de espaciado, medido en 42 combinaciones (7 pantallas × 3 anchos
  × 2 idiomas): sólo tres se mueven — `/growth` **+26 px** a 390/768 y **+20**
  a 1440 (el toggle pasa de 18/24 a 44 de alto), `/history` **+35 px** sólo a
  390 en inglés (una fila del log envuelve un renglón más), y `/pumping`
  **+96 px** a 1440 en español, que es el arreglo de abajo. Las otras 39
  combinaciones dan **0 px de diferencia**, con 0 texto cortado y 0 scroll
  horizontal.
- **`/pumping` ya no desborda su tarjeta a 1440 px en español.** La fila
  "Izquierdo / Derecho / Ambos" tenía `scrollWidth` 425 contra `clientWidth`
  401: **24 px** que se salían de la caja sin producir scroll horizontal de
  página, que es lo único que medía el barrido del 23 sep — por eso había
  pasado por bueno. `.row` es flex **sin** `flex-wrap` a propósito (existe
  `.row-wrap` como clase aparte), así que **no se tocó `.row`**: las dos filas
  de lados de `/pumping` (el formulario y el panel de edición) pasaron a
  `row row-wrap`, el mismo recurso que ya usaba la fila del biberón de
  `/dashboard`. Medido después: desborde interno **24 px → 0** en las 144
  combinaciones, `horizScroll` 0 en todas.

**No construido:**

- *(Cerrado el 24 sep 2026: `/statistics` no dibujaba nada. Era el hueco
  conocido que abrió el pase del 23 sep —267,5 px de tinta a la barra sin
  datos— y lo cierra este: cuatro tarjetas con KPIs y gráficas de la semana de
  vida. Lo que **sigue** valiendo de aquella nota: sin `birth_date` cargada, y
  solo entonces, la pantalla vuelve a ser un estado vacío, porque sin fecha de
  nacimiento no hay semana de vida que mostrar.)*
- **El panel de edición todavía puede convertir una fila a `solid`.** "Solid"
  salió de todo formulario que *crea* una toma, pero el selector de los paneles
  de edición (`components/SectionPage.tsx` y `app/history/page.tsx`, los dos
  `['bottle','solid','nursing']`) lo sigue ofreciendo, y eso es deliberado: una
  fila `solid` mal cargada tiene que poder *salir* de ahí, y un selector de
  tres al que le falta la opción actual pinta la fila como si fuera otra cosa.
  El efecto que hay que tener escrito es que **`solid` sigue siendo alcanzable
  desde la UI**, reetiquetando una fila que ya existe. Opción intermedia que
  propuso el revisor y nadie implementó: ofrecer `solid` **solo cuando la fila
  ya es `solid`**. En la base local hay **0 filas `solid`**; **cuántas hay en
  producción no se sabe** (no hay credenciales de la nube acá, §2.1).
- **`/pumping` no tiene el toggle oz/ml.** El toggle quedó solo en los campos
  de biberón. Quien se saca leche y mide con una jeringa graduada en ml no
  tiene forma de tipear ml en Milk, que es justamente el envase que viene en
  ml. Decisión para Luis, no un bug: el plan pedía el toggle "al lado del campo
  de cantidad de Bottle".
- **`babies.pumping_reset_at` se sigue respetando y ya no tiene escritor.**
  `/pumping` filtra por esa columna, pero "Reset milk total" no existe más, así
  que **una familia que hizo un reset antes de hoy queda con ese corte para
  siempre**, sin forma de moverlo ni de deshacerlo desde la app. Se dejó así
  porque sacar el filtro le cambiaría el total sin avisar. Si en producción hay
  un `pumping_reset_at` cargado, ese total quedó congelado — **no se pudo
  comprobar desde este VPS**.
- **Un offset grande puede disparar el aviso push de "toma larga".**
  `lib/push/nursing.ts` decide con `started_at <= ahora − 30 min`, y el offset
  **reescribe `started_at`**: correr 25 minutos hacia atrás una toma de 10
  la convierte, para el job de `pg_cron`, en una de 35, y el aviso sale en el
  minuto siguiente. No hay spam (`long_alert_sent_at` es de una sola vez por
  sesión) y se puede argumentar que el aviso es *correcto*. Queda **documentado
  y sin tocar**: `lib/push/` estaba fuera de alcance del pase. Luis tiene que
  saberlo antes de que le llegue el primer push raro.
- **Editar una cantidad tipeada en ml la redondea.** `mlToUnit(ml,'oz')`
  redondea a 1 decimal y los paneles de edición precargan con eso, así que
  150 ml guardados exactos, abiertos en el panel y guardados **sin tocar nada**,
  quedan en 5,1 oz → 150,82 ml. Deriva máxima ±1,48 ml por fila, una sola vez
  (después es idempotente). Es la consecuencia de que el toggle de unidad **no**
  vaya en los paneles de edición — decisión correcta: un `4.1` precargado en oz
  releído como ml destruiría el dato en silencio.
- **A 320px en español `/pumping` sigue desbordando** (12px de scroll
  horizontal, medidos). **Es previo a este pase**, verificado barato y sin
  `git stash`: `app/diapers/page.tsx` no tiene un solo cambio, el diff de
  `app/pumping/page.tsx` toca únicamente de dónde sale la unidad (no su
  markup), y el de `components/SectionPage.tsx` no toca la fila del formulario
  de pañal. 320px está además por debajo de los anchos que pide la checklist
  §8. A 390 y 1440, en los dos temas y los dos idiomas, las 10 páginas dan
  **0 desbordes y 0 scroll horizontal** (barrido de 40 combinaciones, 23 sep
  2026) — incluido `/pumping` a 1440 en español, que antes de este cierre
  recortaba. **Corregido el 25 sep 2026: eso último era falso.** En el barrido
  de 144 combinaciones, `/pumping` a **1440 px en español** seguía desbordando
  su tarjeta **24 px** (la fila "Izquierdo / Derecho / Ambos"; `.row` es flex
  sin `flex-wrap` y la columna mide 401 px). No producía scroll horizontal de
  página, que es lo único que medía el barrido del 23 sep, y por eso pasó por
  bueno. *(Cerrado ese mismo día en v0.10.3: las dos filas de lados de
  `/pumping` llevan `row-wrap`. 24 px → 0. Se deja escrita la historia porque
  la lección no es el desborde, es que **el barrido del 23 sep medía la métrica
  equivocada**: scroll horizontal de página no ve un hijo que se sale de un
  contenedor flex. La métrica que sirve es `scrollWidth - clientWidth` del
  propio contenedor.)*
- **Dos pestañas corriendo el mismo inicio: una corrección se pierde.**
  El offset es read-modify-write sin `If-Match`. Dos pestañas que apliquen −5
  cada una leyendo el mismo valor escriben el mismo resultado y el segundo −5
  desaparece sin error. La relectura previa cierra el caso grave (escribir
  sobre una sesión ya terminada), no éste. Es coherente con el modelo del repo
  (ids en cliente, sin optimistic locking) y con lo que ya pasa en los paneles
  de edición.
- **Un campo de offset vacío contesta "Minutes has to be a number".** Para un
  campo en blanco el mensaje útil sería el de `offset.notPositive`. Cambio de
  una condición; no se hizo en este cierre por alcance.
- **El parseo de la cantidad acepta notación exponencial y no tiene techo.**
  `Number('1e2')` → 100, y 100 oz se guardan como 2957 ml sin que nada chille.
  Con `inputMode="decimal"` el riesgo real es bajo y **es previo a este pase**.
- **La tarjeta de Comida muestra un `Solid 0` permanente** para cualquier
  familia sin filas viejas. No es incorrecto —cuenta lo que hay— pero ocupa una
  línea de KPI para siempre. Sugerencia del revisor: mostrar la fila solo si
  `k.solid > 0`.
- **Durante una lactancia no se puede cargar un biberón desde `/dashboard`.**
  Ese lugar lo ocupa el offset. La salida existe (`/feeding` → "Log a past
  one", cuyo campo de fecha arranca en **ahora**), pero conviene tenerlo
  escrito: junto con la predicción "Next feeding" que ya se ocultaba, la
  tarjeta de Comida durante una toma de pecho se queda **sin ninguna** acción
  que no sea Stop y el offset.
- Tests de componentes y de páginas
- CI
  *(Corregido el 22 sep 2026: acá decía "Deploy, y proyecto Supabase en la
  nube (lo crea el agente del Hub)". Era falso — los dos existen y están en
  uso. Ver §2.1.)*
- La automatización de Home Assistant que llamaría a `/api/ingest`
  (el endpoint existe, **nada lo llama**)
- Uso real de `family_members.role` (la columna existe, nadie la lee →
  hoy todos los miembros tienen los mismos permisos)
- Idempotencia en los endpoints de dispositivo ⇒
  `proposals/device-tokens-and-idempotency.md`
- **El disparo periódico de `/api/push/nursing-check`.** El endpoint existe y
  funciona. **Decidido el 22 sep 2026** (§7.6): lo llama `pg_cron` + `pg_net`
  **desde el proyecto Supabase de la nube**, una vez por minuto. Se descartaron
  el VPS (no es producción) y Vercel Cron (en Hobby corre una vez por día).
  La migración está escrita — `supabase/migrations/0011_push_cron.sql` — pero
  **sigue sin llegar el aviso solo hasta que esa migración se aplique en el
  proyecto de la nube y se cargue el secreto en Vault**, y eso no se pudo hacer
  desde este VPS: no hay credenciales del proyecto cloud acá. Estado exacto y
  qué falta: `output.txt` de este pase y §7.6.
- **El clic en la notificación quedó SIN VERIFICAR** (22 sep 2026). El handler
  `notificationclick` de `public/sw.js` corre y cierra la notificación, pero
  `clients.focus()` / `openWindow()` están prohibidos sin una activación de
  usuario real, y CDP no ofrece un clic de notificación: la navegación a
  `/dashboard` no se pudo ejecutar acá. Leído, no probado.
- **Lo que este VPS no puede probar del push** (declarado por el auditor, no
  es "anda"): Chrome estable y Android, APNs/iOS (incluido el flujo "agregar a
  la pantalla de inicio"), Firefox, el teléfono bloqueado o con la app
  cerrada, el TTL y el header `Topic` con el dispositivo desconectado, y el
  borrado por 404/410 contra el servicio real (FCM acepta y descarta). Lo que
  sí se probó de punta a punta es Chromium completo contra el servicio de push
  real (`jmt17.google.com`) en este servidor.
- **"Una sola sesión abierta" se defiende solo en el cliente**, y solo contra
  lo que la página tiene cargado (filas del server + cola). Sin conexión y sin
  copia guardada, el bloqueo no ve una sesión abierta que exista en el server:
  podrían abrirse dos. Es el mismo guard que `/dashboard` ya tenía antes de
  este pase; no hay constraint en la base.
- *(Cerrado el 22 sep 2026: el 403 del servicio de push se reintentaba para
  siempre. Ahora la racha se cuenta **por suscripción** en
  `push_subscriptions.consecutive_403` (0010 — en la base, porque en Vercel
  cada check es un proceso nuevo y un contador en RAM no sobrevive al minuto
  siguiente). Regla, en `lib/push/retry.ts`: 403 en una mientras **otra del
  mismo lote sí recibió** suma 1, y a los 3 chequeos seguidos esa fila se
  borra; un envío OK devuelve la racha a 0; volver a suscribirse desde el
  navegador también. Y si **todas** las del lote dan 403, no se borra ninguna
  y no se toca ningún contador: eso no es una suscripción muerta, es casi
  seguro la VAPID del servidor mal puesta, y sale por `console.warn` con
  `vapidSuspect: true` en la respuesta. Probado en los dos caminos, unit
  (`decideForbidden`, 11 casos) e integración contra la base y el servicio de
  push falso.)*
- **Una pestaña abandonada sin cerrar sesión deja su fila** en
  `push_subscriptions`. Se limpia al cerrar sesión o cuando el servicio de
  push la da por muerta (404/410).
- **El check comparte el techo de intentos de `lib/deviceAuth.ts`** (20 por
  minuto y por IP) con `/api/ingest` y `/api/quick/nurse`: un consumidor más
  de un contador que ya tiene los problemas de §7.4.
- **`/history` acepta guardar un fin anterior al inicio** al editar una
  sesión. Es previo a este pase (`/history` no cambió de comportamiento acá);
  las tres páginas nuevas **sí** validan, con `checkPastRange` de
  `lib/kpis.ts`.
- **La predicción "Next feeding" ya no se muestra durante una lactancia en
  curso** (`app/dashboard/page.tsx`: la línea va dentro de `!activeNursing`).
  Es consecuencia de juntar lactancia y biberón en una sola tarjeta; no fue
  una decisión explícita.
- **`components/SectionPage.tsx` quedó en ~1000 líneas** (995 el 22 sep 2026).
  Seguimiento propuesto: extraer el panel de edición, que hoy está **copiado**
  entre `SectionPage` y `/history`, no compartido.
- *(Cerrado el 21 sep 2026: honestidad offline en `/growth`. Ahora usa
  `mergePending`: una alta, corrección o borrado encolados se ven con "Not
  synced yet" y desaparece la marca al sincronizar. Al investigarlo salió que
  el hueco era más grande que lo anotado: offline, la lectura falla tras ~7 s
  de reintentos y devolvía `[]`, así que la lista **se vaciaba** y no quedaba
  fila sobre la que aplicar la edición; y esa lectura lenta, al resolver
  tarde, pisaba a una más nueva. `/growth` conserva las últimas filas del
  servidor y descarta lecturas viejas.)*
- *(Cerrado el 21 sep 2026: el mismo bug en `/history` y en `/dashboard`.
  Offline, `/history` quedaba con 0 de 7 entradas. `/dashboard` tenía el mismo
  problema, peor (verificado con Playwright): Today pasaba de 6 a 1, el
  cronómetro de lactancia en curso desaparecía y volvía a ofrecer Left/Right
  (riesgo de abrir una segunda sesión), el último pañal quedaba en "—", sueño
  decía "No sleep logged yet" y el próximo turno "Nothing scheduled". Las dos
  páginas usan ahora el patrón de `/growth` —últimas filas buenas por tabla
  (`keepLastGood` en `lib/db.ts`, turno incluido; `/growth` pasó a usar el
  mismo helper) + descartar lecturas viejas
  + `mergePending`— y el banner de error de lectura sale solo con conexión.
  `/dashboard` además repinta al toque desde la cola cuando no está vacía (una
  sesión iniciada offline muestra Stop en ~66 ms) y solo espera la relectura
  cuando la escritura llegó al server. `/history` decía "Saved"/"Deleted"
  aunque la escritura solo quedara en cola (violaba §5.5): ahora dice que
  quedó en este dispositivo, y usa `useSync` + `SyncBar` con banner si falla
  la sincronización. `mergePending` ya no duplica un alta encolada que el
  server ya devolvió. Verificado: offline, Today 9 = 6 + 3 en cola, no
  desaparece nada del server, sin duplicados tras sincronizar, la base
  coincide; `/history` 7/7 offline y correcta tras sincronizar. Decisión: una
  fila borrada offline sigue en la lista con "not synced yet" hasta que se
  sincroniza, igual que en `/growth`.)*
- *(Cerrado el 22 sep 2026: replay de la cola sin protección contra mandar
  dos veces la misma alta. Las altas del **replay** salen como `INSERT … ON
  CONFLICT (id) DO NOTHING` (`sendOpWith` en `lib/db.ts`, modo `replay`); la
  escritura online sigue siendo un insert común, así un choque de id ahí se ve
  como error y nunca como "Saved". Además: lock entre pestañas con
  `navigator.locks` en modo `ifAvailable` (la pestaña que encuentra la cola
  tomada no hace fila: espera a que termine y relee) + fallback dentro de la
  pestaña sin Web Locks (`withFlushLock` en `lib/queue.ts`); timeout de 15 s
  por envío (`REPLAY_TIMEOUT_MS`), que cuenta como offline; reintento solo a
  5 s → 15 s → 60 s, **solo para errores de red** y nunca para un rechazo
  (`retryDelay`, también arrancado por "nudges" cuando se encola algo o una
  lectura falla con el navegador diciendo `online`); y un rechazo real se
  puede descartar desde `SyncErrorBanner` (`components/SyncStatus.tsx`) tras un
  `window.confirm` que nombra la entrada y cuántas ediciones dependientes se
  van con ella. Verificado por el auditor (Playwright contra `next start` +
  service worker, Chromium, stack local): dos pestañas 6/6 con locks (5 altas
  → +3 pañales +2 tomas, 0 ids duplicados, cola 0 en las dos a ~255 ms, 5 POST,
  0 respuestas 409, 0 "duplicate key") y 6/6 sin `navigator.locks` (10 POST,
  0 errores); respuesta perdida (`page.route` abortando tras llegar al server,
  y con inyección directa en IndexedDB) → cola 0, 1 fila; POST colgado en una
  pestaña → la otra manda a 15,0 s, cola 0 a 15,8 s, 3/3 filas; "wifi malo"
  (`onLine` true, Supabase bloqueado) → recupera a 7,5 s con 1 POST y 0
  banners; rechazo de RLS encolado → 1 solo POST en 90 s, sin bucle; Discard
  aceptado → cola 0 a ~130 ms y la entrada válida de atrás entra; cancelado →
  no cambia nada.)*
- *(Cerrado el 22 sep 2026: `/dashboard`, tarjetas de Lactancia y Sueño sin
  "Not synced yet". Llevan `.pending-tag` en la sesión en curso y en la
  última terminada. Verificado: la marca se va a ~110 ms de reconectar.)*
- *(Cerrado el 22 sep 2026: un sueño en curso no aparecía en Today. La
  anotación solo nombraba el sueño, pero **la lactancia en curso tampoco
  aparecía**. `buildActivity` lista ahora las dos sesiones en curso, a la hora
  en que empezaron y con el sufijo "· in progress" / "· en curso"; en Today van
  primero, aunque hayan empezado antes de medianoche (verificado: un sueño de
  ayer a las 22:00 es la primera entrada). History las ordena por hora como
  al resto y no les ofrece Editar (se paran desde Today). Al terminarlas, sin
  duplicados.)*
- *(Cerrado el 22 sep 2026: `/history` sin repintado rápido desde la cola.
  Repinta al toque desde la cola, como `/dashboard`, cuando la cola no está
  vacía o el navegador dice offline; `/growth` también. Verificado: la marca
  "not synced yet" aparece a 57–66 ms de la edición offline (antes ~7 s).)*
- *(Cerrado el 22 sep 2026: primera carga sin conexión = lista vacía.
  `lib/lastSeen.ts` guarda en `localStorage` (`amelia:seen:*`, por página y
  por bebé; sin tokens ni sesión) las últimas filas buenas, y se borra al
  cerrar sesión (`components/ui.tsx`), al iniciarla (`app/login`) y cuando no
  hay sesión (`lib/useBaby.ts`). Offline, la página muestra esa copia con el
  aviso `SeenNote` (clase `.syncbar`, informativo, no error) que dice la hora
  de la última lectura buena; si no hay nada guardado, un estado explícito
  "sin conexión, nada guardado en este dispositivo" en vez de "No sleep logged
  yet" o listas vacías (y `NoBaby offline` en vez de "no hay perfil de bebé").
  Hallazgo al investigarlo: offline en frío `useBaby` mandaba **al login**
  (`getUser()` falla sin red); ahora distingue "no se pudo preguntar" de "no
  hay sesión" y usa el bebé guardado. Y el service worker (`amelia-v3`) no
  tenía las páginas privadas (se instala desde `/login`, donde responden con
  un redirect): un reload offline daba `ERR_FAILED`. Ahora las precalienta
  tras iniciar sesión (`lib/offlinePages.ts`, mensaje `warm`) y nunca guarda
  una respuesta redirigida. Verificado: offline, `/dashboard` 3 entradas,
  `/history` 3, `/growth` 4,2 kg, con aviso; al volver la conexión sin
  recargar, el aviso se va en ~110–210 ms; cerrar sesión deja 0 claves
  `amelia:seen:*`.)*
- **Las páginas no se releen solas.** Ninguna página vuelve a leer por su
  cuenta: no hay relectura periódica ni en `visibilitychange`/`focus`; solo al
  montar, al volver `online` y después de sincronizar. En la pantalla de
  pared, lo que registra el otro padre desde su teléfono no aparece hasta
  recargar. Y si internet se cae con la página abierta y nadie la toca
  (`navigator.onLine` sigue en true), el aviso de copia guardada no aparece
  nunca (auditor: 0 en 30 s; con una acción del usuario aparece a ~12 s). Se
  empezó a implementar (un hook de relectura mientras la página está visible)
  y se descartó en este pase por decisión de Emilio, para cerrar lo aprobado.
- **Recarga durante un corte con la cola vacía.** Con `navigator.onLine` en
  true y nada en cola, una página recargada en medio de un corte muestra el
  estado vacío ~7 s, hasta que sus lecturas se rinden; recién ahí aparecen la
  copia y el aviso. La marca `amelia:seen:net-down` existe (`lib/lastSeen.ts`)
  pero el repintado rápido solo corre con algo en cola o con el navegador
  offline.
- **Menores, aceptados:** el "hace X" del aviso de copia guardada y del
  banner de rechazo no avanza con la página abierta (se calcula al pintar);
  carrera estrecha: una edición encolada en otra pestaña después de descartar
  su alta queda como un update sobre 0 filas (inocuo); la cola de IndexedDB
  **no** se borra al cerrar sesión (a propósito: perdería escrituras sin
  sincronizar), así que filas de la familia pueden quedar en el dispositivo
  hasta que sincronicen.
- *(Cerrado el 21 sep 2026: `select.input` de Doctor. En iOS no desbordaba,
  pero su tema le bajaba el alto a ~29px; ahora lleva `appearance: none`,
  detalle en `design.md` §4.)*

---

## 7. Preguntas abiertas (no las resuelvas solo — preguntá)

1. La `service_role` key vive hoy en `/api/ingest` de esta app, pero la
   regla del Hub dice que vive **solo en el servidor del Hub**. O el
   ingest se muda a `apps/hub`, o la regla necesita una excepción.
2. Cuál de las dos cajas (NUC o HA Green) deriva los eventos de sueño y
   llama a `/api/ingest` — **no está decidido**.
3. **Cerrada el 21 sep 2026.** `/api/quick/nurse` y `/api/ingest` corren con
   `service_role`, que salta RLS, pero ya no se autentican con un secreto
   compartido: cada dispositivo tiene su propio token (`device_tokens`,
   0007), clavado a una familia y opcionalmente a un bebé. El bebé sobre
   el que se escribe sale del token, nunca puede salir de su familia, y si
   no alcanza la información para decidir (token de familia con más de un
   bebé y sin `baby_id`), el endpoint **falla cerrado** (409) en vez de
   adivinar. Demostrado en `tests/integration/{ingest,quick-nurse}.test.ts`.
4. Los tokens de dispositivo siguen siendo estáticos (no rotan solos) y el
   techo de intentos (`lib/deviceAuth.ts`, 20 por minuto y por IP) tiene
   varios problemas sin resolver: vive en la memoria de un proceso (con varias
   instancias no sirve, y un arranque en frío lo resetea); la clave es el
   header `x-forwarded-for`, que controla el propio cliente; el `Map` nunca
   expira sus entradas; y cuenta también los intentos que **sí** autenticaron,
   así que un NUC mandando más de 20 eventos por minuto legítimos empieza a
   recibir 429. Seguimiento propuesto: contar solo los intentos de auth
   fallidos, o usar como clave el id del token ya autenticado, y podar las
   entradas vencidas. Y sigue sin haber idempotencia: el mismo evento
   mandado dos veces son dos filas. Ninguno implementado ⇒
   `proposals/device-tokens-and-idempotency.md` §4 y §6.
   **Desde el 22 sep 2026 hay un consumidor más de ese techo:**
   `/api/push/nursing-check` pasa por el mismo `authenticateDevice`, y está
   pensado para llamarse **una vez por minuto**. Si el check y el NUC salen
   detrás de la misma IP, comparten las 20 por minuto.
   **El 24 sep 2026 NO se agregó ninguno**, y fue una decisión, no una
   casualidad: los tres checks nuevos (comida vencida, siesta vencida,
   recordatorio de cita) se metieron **adentro** de `/api/push/nursing-check`
   en vez de tener endpoints propios, justamente porque el techo es **por IP y
   no por endpoint** — cuatro endpoints por minuto gastarían 4 de las 20 en vez
   de 1. Sigue habiendo **un** consumidor por minuto.
   **Y hay uno nuevo que NO tiene techo:** `/api/calendar/[token]`, público y
   con `service_role`, no pasa por `authenticateDevice` y por lo tanto no tiene
   límite de intentos (hallazgo M-6 de la auditoría del 24 sep 2026). Es de
   solo lectura y el token es de 256 bits, pero queda anotado acá y no se
   resuelve en este pase.
5. **Cerrada el 21 sep 2026.** El CLI de Supabase no tiene forma de fijar el
   bind (evidencia E-3: el binario arma `-p puerto:puerto`, sin IP, y no hay
   clave de config que lo cambie). Se reemplazó por un `docker-compose.yml`
   propio en `supabase/docker/` que publica cada puerto como
   `127.0.0.1:puerto:puerto` (evidencia E-4: mismo patrón validado en un
   spike, 29/29 tests). E-3 y E-4 están en
   `docs/superpowers/plans/2026-09-21-tokens-crecimiento-stack-versiones.md`
   §2. `pnpm db:status`
   confirma `127.0.0.1:54321->8000/tcp` y `127.0.0.1:54322->5432/tcp`, sin
   ningún `0.0.0.0`. Ver `docs/seguridad-operacional.md` §6.
6. **Quién llama a `/api/push/nursing-check` cada minuto — DECIDIDO el 22 sep
   2026: `pg_cron` + `pg_net` dentro del proyecto Supabase de la nube.**
   Descartadas, con motivo:
   - **El VPS** (systemd, cron de sistema, un proceso de la app): descartado
     porque **este VPS no es producción** y nunca va a serlo (§2.1). Poner
     infraestructura de producción acá sería inventar una dependencia que no
     existe.
   - **Vercel Cron:** en el plan **Hobby** corre **una vez por día**, y además
     con hasta ~59 min de imprecisión. Para un umbral de 30 minutos no sirve.
     (El endpoint igual sigue respondiendo a `GET` con `Authorization: Bearer`,
     que es lo que haría falta si alguna vez se pasa a Pro.)
   - **La caja de la casa** (NUC o HA Green): sigue siendo posible, pero agrega
     una dependencia de que la casa esté encendida y empalma con la pregunta 2
     y con el techo de intentos de la 4. No se eligió.
   La implementación vive en `supabase/migrations/0011_push_cron.sql`.
   **Lo que queda abierto no es la decisión, es la ejecución en la nube:**
   - El **valor** del token de scope `push_check` nunca va al repo. Vive en
     **Supabase Vault**, con el nombre `amelia_push_check_token`, y la
     migración solo lo referencia por nombre. Hay que crearlo a mano, una sola
     vez, desde el SQL Editor (§7.6.1 del `output.txt` de este pase).
   - La **URL de producción** también va por Vault
     (`amelia_push_check_url`) por la misma razón: no está verificada desde
     acá y no se inventa en un archivo del repo.
   - **Nada de esto se pudo aplicar ni verificar desde este VPS**: no hay
     credenciales del proyecto de la nube acá (sin `.vercel/`, sin CLI de
     Supabase, sin `~/.supabase/access-token`; `.env.local` apunta a
     127.0.0.1). Mientras no se aplique allá, **el aviso no llega solo.**
     El paso a paso para hacerlo a mano, con las consultas de verificación
     ya escritas: **`docs/aplicar-en-la-nube.md`**.
   - Y ojo: el endpoint resuelve la familia **desde el token**, así que es
     **un job de `pg_cron` por familia**. Hoy hay una sola.
7. **¿La ventana de 7 días también tiene que ser rodante?** (abierta el 23 sep
   2026; **parcialmente moot desde el 24 sep 2026** — ver el cierre al final.) "Hoy" pasó a ser las últimas 24 horas porque a las 00:01 los números
   se ponían en cero. `week` quedó como estaba —hoy + los 6 días de calendario
   anteriores— porque el pedido hablaba solo de "hoy", y cambiarlo sin que
   nadie lo pida habría sido alcance inventado. Pero si la idea de fondo es
   "no quiero que a medianoche se me borren los números", la de 7 días tiene
   exactamente el mismo problema una vez por semana, más chico. Cambiarla es
   una línea (`start: end - 7 * DAY_MS`) más su etiqueta. **Consecuencia
   mientras tanto, que conviene tener escrita:** la pantalla de sección mezcla
   a propósito **tres** unidades de tiempo — 24 h rodantes en la tarjeta corta,
   7 días de calendario en la larga, y el log agrupado por día de calendario.

   **Actualización del 24 sep 2026:** la tarjeta de "últimos 7 días" **ya no
   existe** en `/feeding`, `/diapers` ni `/sleep` — la sustituyó el selector de
   semana de vida. Así que:
   - **Para esas tres pantallas la pregunta queda sin objeto.** Y las tres
     unidades de tiempo siguen siendo tres, pero otras: 24 h rodantes, la
     semana de vida (fija) y el log por día de calendario.
   - **Para `lib/kpis.ts` sigue abierta.** `kpiWindows().week` no se tocó y
     sigue siendo una función pura con sus tests; hoy no la consume ninguna
     pantalla. Si nunca vuelve a tener consumidor, la decisión es si se borra,
     no si se vuelve rodante. **No lo resuelvas solo.**

---

## 8. Antes de decir "listo"

- [ ] `pnpm exec tsc --noEmit` pasa
- [ ] `pnpm lint` y `pnpm format:check` pasan
- [ ] `pnpm build` pasa
- [ ] `pnpm test:all` pasa — y si no pudiste correr los de integración
      (Docker apagado), **lo decís**, no lo das por bueno
- [ ] Lo probaste contra el Supabase local, no solo lo leíste
- [ ] Ningún hex ni px nuevo fuera de `app/globals.css` (ver `design.md`)
- [ ] Ninguna query nueva fuera de `lib/db.ts`
- [ ] Ningún texto visible nuevo fuera de `lib/i18n/en.ts` + `es.ts` (§5.7)
- [ ] `lib/supabaseAdmin.ts` no entró a ningún `'use client'`
- [ ] Si tocaste el schema: migración **nueva**, con RLS y GRANTs
- [ ] Si tocaste layout: barrido a 390 y 1440 px, en los dos temas y los dos
      idiomas, con 0 scroll horizontal y 0 desborde nuevo
- [ ] Si algo quedó sin verificar, lo dijiste explícitamente
- [ ] Si vas a pushear a `main`: versión subida + entrada en `CHANGELOG.md`
      (§0.1 — sin excepción)

Reportá el resultado real. Si algo falla, mostrá la salida. Si salteaste
un paso, decilo.
