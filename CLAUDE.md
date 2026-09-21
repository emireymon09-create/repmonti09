# CLAUDE.md — Amelia App

Punto de entrada de toda sesión en este repo. Leelo antes de tocar nada.
Después leé `PROJECT.md` (arquitectura y estado) y `design.md` (UI/UX).
Si algo en `PROJECT.md` o en el README contradice a este archivo, **este
archivo manda** — y avisá de la contradicción en vez de elegir en silencio.

Para **trabajar** (no para entender el proyecto), la doc operativa vive en
`docs/`: manual de buenas prácticas, checklist de cada cambio, prompt de
auditoría y seguridad operacional. Índice: `docs/README.md`.

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
| Deploy | Vercel previsto — todavía no desplegado |

No es un monorepo. Hay un solo `package.json`, en la raíz.

### Mapa de archivos que importan

```
lib/db.ts          ÚNICA puerta a la base de datos. Las páginas nunca arman una query.
lib/queue.ts       Cola offline en IndexedDB + replay ordenado.
lib/format.ts      Fechas/horas en la TZ del hogar + conversión de unidades.
lib/types.ts       Tipos de fila (stand-in de los types generados de fase 2).
lib/tokens.ts      Design tokens en TS, espejo de app/globals.css.
lib/supabaseClient.ts   anon key — browser. Protegido por RLS.
lib/supabaseAdmin.ts    service_role — SOLO server. Salta RLS.
app/globals.css    TODO el CSS del proyecto.
components/ui.tsx  Page, Grid, Card, Label, Btn, Banner, Nav.
lib/deviceAuth.ts  Auth de los endpoints de dispositivo: token por hash + scope,
                   resolución del bebé dentro de la familia del token, techo de
                   intentos, validación de payload.
middleware.ts      Guard de auth server-side. NO reemplaza a RLS: evita que una
                   ruta privada se renderice antes de rebotar al login.
public/sw.js       Service worker: que la app ABRA sin conexión.
tests/             Vitest. unit/ no necesita nada; integration/ necesita el
                   stack local levantado.
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
pnpm start

# Tests
pnpm test                   # unit (lib/format.ts, lib/queue.ts, lib/deviceTokens.ts,
                             # lib/changelog.ts). Sin Docker
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
- **MINOR:** capacidad nueva visible, migración de schema, o cambio
  incompatible en la API de dispositivos (mientras sea `0.x`).
  **PATCH:** arreglos sin schema ni capacidad nueva. **1.0.0:** cuando la app
  esté desplegada y en uso real.
- Se sube **una vez por batch**, en el último commit del batch, junto con la
  entrada del CHANGELOG (en inglés, en términos de quien usa la app — mismo
  criterio que los commits).

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
- **No crear un proyecto Supabase en la nube.** La base compartida la
  crea el agente del Hub (ADR 0001).
- **No construir calendario, comidas, tareas ni riego.** Eso es del Hub.

---

## 6. Estado real — qué está y qué no

**Construido y funcionando:** auth, dashboard completo (lactancia,
biberón, sólidos, pañales, sueño, predicciones), Milk (extracción),
Growth con editar/borrar (0008), Doctor, History con editar/borrar, PWA instalable, cola offline,
RLS en las 11 tablas (y RLS y sin acceso para `anon`/`authenticated` — solo
`service_role` — en `device_tokens`, la 12ª), los dos
endpoints de dispositivo, **tokens por dispositivo** (`device_tokens`,
0007 — cada dispositivo tiene el suyo, revocable, clavado a una familia y
opcionalmente a un bebé; reemplazó a los secretos compartidos
`NUC_DEVICE_SECRET`/`QUICK_TOGGLE_SECRET`), **middleware de auth
server-side**, **lockfile de pnpm**, **lint y format**, **historial de
versiones en `/version`** (engranaje → Version history), **tema claro pastel
seleccionable** (engranaje → Theme: Light / Dark / System, por dispositivo), y **una suite de
tests**.

**Alcance exacto de los tests** (que no es "hay tests" a secas):

| Cubierto | Archivo |
|---|---|
| `lib/format.ts` — fechas, horas, DST, unidades, edad | `tests/unit/format.test.ts`, bajo cuatro TZ |
| `lib/queue.ts` — orden de replay, descartes, `looksOffline`, `newId` | `tests/unit/queue.test.ts` |
| `lib/deviceTokens.ts` — formato del token, hash, scopes | `tests/unit/deviceTokens.test.ts` |
| `lib/changelog.ts` — parseo del CHANGELOG y que su primera entrada coincida con `version` de `package.json` | `tests/unit/changelog.test.ts` |
| Aislamiento entre familias por RLS, por el camino real (PostgREST + JWT) | `tests/integration/rls.test.ts` |
| Corregir y retractar `growth_measurements` sin cruzar de familia | `tests/integration/rls.test.ts` |
| Los dos endpoints de dispositivo: auth, validación, rate limit, scoping | `tests/integration/{ingest,quick-nurse}.test.ts` |

**NO hay tests de componentes ni de páginas.** Lo que se cubre es `lib/`
y la base.

**No construido:**

- Tests de componentes y de páginas
- CI
- Deploy, y proyecto Supabase en la nube (lo crea el agente del Hub)
- La automatización de Home Assistant que llamaría a `/api/ingest`
  (el endpoint existe, **nada lo llama**)
- Uso real de `family_members.role` (la columna existe, nadie la lee →
  hoy todos los miembros tienen los mismos permisos)
- Idempotencia en los endpoints de dispositivo ⇒
  `proposals/device-tokens-and-idempotency.md`
- Honestidad de estado offline en `/growth`: una edición o un borrado
  encolados sin conexión muestran el banner "Saved on this device", pero la
  fila se queda con sus valores viejos y sin marca de "not synced yet",
  porque `app/growth/page.tsx` no usa `mergePending` (a diferencia de
  `app/history/page.tsx` y `app/dashboard/page.tsx`, que sí lo usan). Fuera de
  alcance de este batch.

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
- [ ] `lib/supabaseAdmin.ts` no entró a ningún `'use client'`
- [ ] Si tocaste el schema: migración **nueva**, con RLS y GRANTs
- [ ] Si algo quedó sin verificar, lo dijiste explícitamente

Reportá el resultado real. Si algo falla, mostrá la salida. Si salteaste
un paso, decilo.
