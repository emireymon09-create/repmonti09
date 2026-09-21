# Amelia App — Plan de batch 2: tokens por dispositivo, crecimiento editable, stack local en 127.0.0.1 y versiones

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar de raíz los hallazgos críticos C1 y C2 (los endpoints de
dispositivo resuelven familia y bebé desde un token propio, hasheado y
revocable), hacer corregible y retractable una medición de crecimiento, dejar el
stack local de Supabase escuchando solo en `127.0.0.1` sin depender de acordarse
de bajarlo, y mostrar versión + historial de cambios bajo el engranaje — subiendo
de v0.1.0 a v0.2.0.

**Architecture:** Dos migraciones nuevas y numeradas (`0007`, `0008`) —cambio de
regla explícito, ver §1—. La autorización de los dispositivos pasa de "conocer un
secreto compartido" a "traer un token cuyo hash existe en `device_tokens`, con
familia, bebé opcional y scopes"; el bebé destino se valida contra la familia del
token en un solo lugar (`lib/deviceAuth.ts`). El stack local deja el CLI de
Supabase y pasa a un `docker-compose` propio (db + auth + rest + gateway) con
todos los puertos publicados como `127.0.0.1:puerto`. La versión vive en
`package.json`, el historial en `CHANGELOG.md`, y una página `/version` los lee
en build.

**Tech Stack:** TypeScript 5.5 strict · Next.js 14 App Router · React 18 ·
Supabase (Postgres 17 + GoTrue + PostgREST + Kong, imágenes oficiales) ·
Docker Compose v5 · **pnpm** · **Vitest** · Node 24 (type stripping nativo).

**Spec:** este mismo archivo, §0. La spec es el pedido de Emilio del 21 sep
2026, transcrito sin reinterpretar. Propuestas de origen:
`proposals/device-tokens-and-idempotency.md` y `proposals/growth-edit-and-void.md`.

---

## 0. Spec de origen

Alcance **estricto**: nada de estilo, sidebar ni dark/light mode (va en un push
aparte).

1. **Resolver los 2 críticos de `proposals/device-tokens-and-idempotency.md`** —
   de raíz, no mitigar. `/api/ingest` y `/api/quick/nurse` resuelven
   familia/bebé **desde el token del dispositivo**, no adivinando ni con una env
   var de un solo bebé. Migración de schema real, numerada `0007+`, y actualizar
   la regla de `CLAUDE.md` para reflejar que este tipo de cambio SÍ se resuelve
   acá cuando Emilio lo pide explícitamente.
2. **Resolver `proposals/growth-edit-and-void.md`** — policy de UPDATE +
   `voided_at` en `growth_measurements`.
3. **Binding `0.0.0.0` resuelto de forma definitiva.** Si `config.toml` no
   permite fijar el bind, un `docker-compose` propio con `127.0.0.1:p:p`, como
   fruco-erp. Tiene que seguir sirviendo a los tests de integración.
4. **Historial de versiones en Configuración (el engranaje)** — vMAJOR.MINOR.PATCH,
   versión actual + historial. Definir fuente de verdad (package.json +
   CHANGELOG.md o similar) y cómo llega a la UI. Subir desde v0.1.0 según
   criterio propio.

**Reglas vigentes:** siempre pnpm · no crear repo ni proyecto en la nube · no
tocar fruco-erp · commit por tarea lógica · `pnpm test:all` verde antes de cada
commit · plan completo + autorización en una sola ronda.

---

## 1. Contradicciones que tengo que avisar (CLAUDE.md §0 lo exige)

**C-1. Numerar migraciones acá vs. CLAUDE.md §5.2.** Texto actual, verificado:
*"Este repo dejó de numerar sus propias migraciones. Por ADR 0003 la numeración
pasa al agente del Hub. Lo que corresponde acá es proponer una migración (en
`proposals/`), no numerarla."* Lo mismo repiten `docs/checklist-cada-cambio.md`
(bloque A: *"¿El cambio toca el schema? Entonces no es una migración acá"*;
bloque B: *"migración nueva en `proposals/`"*), `PROJECT.md` (*"This app stops
owning SQL. Propose a migration, don't number one."*) y el encabezado de las dos
propuestas. **Tu pedido manda.** Las migraciones salen como `0007` y `0008`, y
la Tarea 2 reescribe §5.2 y el checklist para que digan: *se numera acá cuando
Emilio lo pide explícitamente; si no, se propone*. No verifiqué el texto de ADR
0003: vive en el repo del Hub, que no está en esta máquina.

**C-2. La propuesta de tokens tiene un CHECK que no chequea nada.**
`proposals/device-tokens-and-idempotency.md` §2 trae
`constraint device_tokens_baby_in_family check (baby_id is null or true)` —
eso es siempre verdadero. Con esa tabla se podía clavar un token de la familia A
al bebé de la familia B, que es exactamente el bug que se quiere cerrar. Lo
reemplazo por una FK compuesta `(baby_id, family_id) → babies(id, family_id)`,
que Postgres hace cumplir de verdad.

**C-3. La propuesta daba `select` sobre `device_tokens` a `authenticated`,
`token_hash` incluido.** Y como `0005` dejó `alter default privileges ... grant
select, insert, update, delete ... to authenticated`, **cualquier tabla nueva
nace con esos grants** aunque la migración no diga nada. Mi diseño: RLS
habilitada, **sin policies**, y `revoke all ... from anon, authenticated`
explícito. Los tokens se administran con un script de servidor
(`pnpm device-token`), no desde la app. Pantalla de administración: pregunta
abierta P-2.

**C-4. La propuesta pide tres pasos con convivencia (token nuevo *o* secreto
viejo).** No hace falta y la descarto: la app **no está desplegada** (verificado:
PROJECT.md "No Vercel deployment yet", CLAUDE.md §6) y **nada llama a
`/api/ingest`** (CLAUDE.md §6). Mantener el secreto viejo aceptado sería mantener
vivo C1/C2, que es lo que pediste no hacer. Corte limpio: `NUC_DEVICE_SECRET`,
`QUICK_TOGGLE_SECRET` y `QUICK_TOGGLE_BABY_ID` desaparecen.

**C-5. La propuesta de crecimiento cita una función que no existe.** Su §3 usa
`mutate(...)`; en `lib/db.ts` no hay `mutate` — el patrón real es
`write(label, op)` (líneas 90-100, usado por `updateFeeding`/`voidFeeding`).
El plan usa `write`.

**C-6. "Igual que en fruco-erp" es verdad a medias.** Lo que fruco-erp tiene en
la UI (leído, no tocado): `apps/web/src/version.ts` exporta `APP_VERSION` desde
`package.json` y `Sidebar.tsx:118` muestra `v{APP_VERSION}`. **No hay historial
en la UI:** su changelog vive en `docs/historico/changelog-versiones-*.md` y en
Notion, y su propia auditoría (`docs/auditoria-docs/reporte-2026-08-10.md`
hallazgo 11.1) registra que ese changelog se desincronizó. Tomo de fruco la
fuente de la versión (package.json) y agrego lo que a fruco le faltó: el
historial dentro de la app, más un test que falla si `package.json` y
`CHANGELOG.md` no coinciden.

**C-7. `docs/seguridad-operacional.md` §6 opción 3 dice "revisar si el CLI
permite fijar el bind en `config.toml` — No lo verifiqué".** Ahora está
verificado, y la respuesta es **no** (ver §2, evidencia E-3).

**C-8. Checklist bloque B: "Ninguna query nueva fuera de `lib/db.ts` (los route
handlers son la excepción que ya existe y no se amplía)".** La resolución del
token y del bebé es una query de servidor con `service_role`: no puede ir en
`lib/db.ts` (es `'use client'`, clave anon). La pongo en `lib/deviceAuth.ts`,
server-only, y **saco** de los route handlers el lookup de `babies` que hoy vive
en `app/api/quick/nurse/route.ts`. Neto: la excepción se concentra en un archivo
en vez de ampliarse. Lo actualizo en el checklist.

---

## 2. Qué verifiqué (evidencia, 21 sep 2026)

- **E-1. Estado de git.** `main` limpio en `ad3d496`. Remote
  `emireymon09-create/repmonti09`. El batch anterior se hizo en rama y se mergeó
  con `--no-ff`; repito el patrón.
- **E-2. Endpoints de dispositivo.** Leídos enteros. `/api/ingest` acepta
  cualquier `baby_id` uuid con el secreto compartido (C2, test
  `ingest.test.ts` "HALLAZGO"). `/api/quick/nurse` usa `QUICK_TOGGLE_BABY_ID` o
  el único bebé de **toda la base**, 409 si hay más de uno (C1 parchado).
  `lib/deviceAuth.ts`: comparación en tiempo constante + techo de 20/min por IP
  en memoria.
- **E-3. El CLI de Supabase NO permite fijar el bind.** Versión instalada
  `2.117.0` (`pnpm exec supabase --version`). Es un binario Bun; el código que
  publica puertos, extraído del binario
  (`node_modules/.pnpm/@supabase+cli-linux-x64@2.117.0/.../bin/supabase`), es:
  `Wv=(t,n)=>[...PBt(t),...n.flatMap(({host:H,container:i})=>["-p",`${H}:${i}`])]`
  — `-p puerto:puerto` sin IP, o sea `0.0.0.0`, sin clave de config que lo
  cambie (no aparece ninguna clave `bind`/`host_ip`/`listen` en el binario).
  Docker es rootful (`/var/lib/docker`), así que `daemon.json` con `"ip"`
  requiere root, y no hay sudo.
- **E-4. Spike del docker-compose propio — funciona.** En el scratchpad (fuera
  del repo, ya bajado con `down -v`): `supabase/postgres:17.6.1.167` +
  `gotrue:v2.196.0` + `postgrest:v16.2` + `kong:2.8.1` (las mismas imágenes que
  ya bajó el CLI, sin pull), puertos `127.0.0.1:55321/55322`, JWT secret y
  claves generadas por máquina. Apliqué `0001`…`0006` con `psql` y corrí **la
  suite de integración actual: 29/29 verde** (rls 11, ingest 11, quick-nurse 7).
  `ss -tln` mostró solo `127.0.0.1:5532x`; `curl` a la IP pública
  `178.105.208.237:55321` → sin respuesta; a `127.0.0.1` → 200.
- **E-5. Estado Docker actual.** El stack de Supabase del CLI está **abajo**.
  Quedan tres volúmenes suyos: `supabase_db_amelia-app`,
  `supabase_edge_runtime_amelia-app`, `supabase_storage_amelia-app`. No los toco
  (pregunta P-4). fruco corre en `127.0.0.1:5432/6379` — no se toca.
- **E-6. `growth_measurements`.** `0001`: solo policies select/insert. `0006`
  agregó `voided_at` a 5 tablas y no a esta. `0005` dejó grants por defecto
  (select/insert/update/delete) a `authenticated` → no hace falta GRANT nuevo
  (confirma lo que dice la propuesta). `listGrowth` (`lib/db.ts:490`) no filtra
  `voided_at`. Único consumidor: `app/growth/page.tsx`. `buildActivity` no
  incluye crecimiento, así que History no se toca.
- **E-7. Engranaje.** Es un menú desplegable dentro de `Nav`
  (`components/ui.tsx:145-180`) con tres ítems (unidad, reset de leche, sign
  out), clase `nav-menu-item`. No hay página de configuración.
- **E-8. Versión.** `package.json` `"version": "0.1.0"`. No hay tags
  (`git tag` vacío), no hay CHANGELOG.
- **E-9. Node 24.16.0** → corre `.ts`/`.mts` sin transpilar (type stripping
  nativo). `tsconfig` tiene `resolveJsonModule: true`, `noEmit: true`.
- **E-10. Clases CSS reutilizables** (para no tocar estilo): `.edit-panel`,
  `.feed`, `.feed-item`, `.feed-what`, `.feed-actions`, `.linkish`, `.row`,
  `.row-tight`, `.between`, `.value`, `.meta`, `.nav-menu-item` — todas
  existentes en `app/globals.css` y usadas por History.

---

## Global Constraints

Valen para **todas** las tareas.

- **pnpm y solo pnpm.** Ni `npm` ni `yarn` en código, docs, scripts o commits.
- **`0001`…`0006` no se editan.** Las migraciones nuevas son `0007` y `0008`,
  cada una con RLS en la misma migración y grants/revokes explícitos, y un test
  de integración que las cubra.
- **Ninguna query de página fuera de `lib/db.ts`.** Queries de servidor con
  `service_role`: solo en `lib/deviceAuth.ts` y en los route handlers
  existentes.
- **`lib/supabaseAdmin.ts` nunca entra a un `'use client'`.**
- **Ningún hex, px ni clase CSS nueva.** Este batch no toca `app/globals.css`.
- **Ningún secreto con prefijo `NEXT_PUBLIC_`**; ningún secreto commiteado
  (tampoco las claves del stack local: se generan por máquina y van gitignored).
- **Nada se presenta como guardado si no lo está** (CLAUDE.md §5.5).
- **Borrado lógico:** `voided_at`, nunca `DELETE`; toda lectura filtra.
- **Commits:** frase imperativa en inglés, una línea, sin prefijo, efecto para
  quien usa la app. Cierra con
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Gate de cada commit** (en este orden, todos verdes, salida real si algo
  falla): `pnpm exec tsc --noEmit` · `pnpm lint` · `pnpm format:check` ·
  `pnpm build` · `pnpm test:all`.
- **Rama:** `batch/tokens-crecimiento-stack-versiones` desde `main @ ad3d496`.
  Merge `--no-ff` a `main` al final. **Sin push.**
- **Si algo queda sin verificar, se dice.**

---

## File Structure

| Archivo | Tarea | Responsabilidad |
| --- | --- | --- |
| `supabase/docker/docker-compose.yml` | T1 | Stack local: db, auth, rest, kong. Todo puerto como `127.0.0.1:p:p`. |
| `supabase/docker/kong.yml` | T1 | Gateway: `/auth/v1/` → auth, `/rest/v1/` → rest, CORS. |
| `supabase/docker/roles.sql` | T1 | Init del contenedor: contraseñas de `authenticator` y `supabase_auth_admin`. |
| `supabase/docker/.env` | T1 | **Gitignored.** JWT secret, password y claves de esta máquina. |
| `scripts/local-stack-keys.mjs` | T1 | Genera secret + password + JWT anon/service_role firmados. |
| `scripts/local-stack.sh` | T1 | `up`/`down`/`reset`/`env`/`psql`/`status`; aplica migraciones pendientes. |
| `scripts/test-env.sh` | T1 | **Se borra** (lo reemplaza `pnpm db:env`). |
| `supabase/config.toml` | T1 | **Se borra** (sin él, `supabase start` se niega a arrancar). |
| `supabase/migrations/0007_device_tokens.sql` | T2 | Tabla `device_tokens` + FK compuesta + RLS sin policies + revoke. |
| `lib/deviceTokens.ts` | T2 | Puro: generar, hashear, leer `Bearer`, scopes. Sin imports con alias. |
| `scripts/device-token.mts` | T2 | CLI de administración: `families`, `create`, `list`, `revoke`. |
| `lib/deviceAuth.ts` | T3 | `authenticateDevice`, `resolveBabyForDevice`, rate limit, validadores. |
| `app/api/ingest/route.ts` | T3 | Usa identidad del token; bebé validado contra la familia. |
| `app/api/quick/nurse/route.ts` | T3 | Ídem; se va `resolveBabyId` y `QUICK_TOGGLE_BABY_ID`. |
| `supabase/migrations/0008_growth_edit_and_void.sql` | T4 | `voided_at` + policy de update. |
| `lib/format.ts` | T4 | `GrowthInput`, conversión form↔métrico, edición sin pérdida de precisión. |
| `components/GrowthFields.tsx` | T4 | Los inputs lb/oz/in o kg/cm + toggle; compartidos por alta y edición. |
| `lib/db.ts` | T4 | `updateGrowth`, `voidGrowth`, `listGrowth` filtra `voided_at`. |
| `app/growth/page.tsx` | T4 | Editar / borrar por fila. |
| `CHANGELOG.md` | T5 | Fuente de verdad del historial. |
| `lib/changelog.ts` | T5 | Parser puro del CHANGELOG. |
| `lib/version.ts` | T5 | `APP_VERSION` desde `package.json`. |
| `app/version/page.tsx` | T5 | Versión actual + historial. Server component estático. |
| `components/ui.tsx` | T5 | Ítem "Version history · vX.Y.Z" en el engranaje. |
| `middleware.ts` | T5 | `/version` detrás de login, como el resto. |

Tests: `tests/unit/deviceTokens.test.ts` (T2), `tests/unit/changelog.test.ts`
(T5), `tests/unit/format.test.ts` (T4, extendido), `tests/integration/rls.test.ts`
(T2, T4), `tests/integration/ingest.test.ts` y `quick-nurse.test.ts` (T3,
reescritos), `tests/helpers/supabase.ts` (T2: `seedDeviceToken`).

---

## Orden y por qué

1. **T1 stack local** primero: es la infraestructura sobre la que corre el gate
   de todos los commits siguientes, y cierra la exposición de inmediato.
2. **T2 schema de tokens + herramienta**, sin tocar endpoints: el commit deja
   todo verde con los endpoints viejos todavía andando.
3. **T3 endpoints** pasan a tokens: acá mueren C1, C2 y los secretos viejos.
4. **T4 crecimiento**: independiente, migración propia.
5. **T5 versiones**: último, porque el CHANGELOG de 0.2.0 describe T1-T4.
6. **T6 cierre**: verificación completa + merge.

Migraciones separadas (`0007` tokens, `0008` crecimiento): son problemas
distintos, se revisan y se podrían revertir por separado.

---

## Task 1: Stack local de Supabase escuchando solo en 127.0.0.1

**Files:**
- Create: `supabase/docker/docker-compose.yml`, `supabase/docker/kong.yml`,
  `supabase/docker/roles.sql`, `scripts/local-stack-keys.mjs`,
  `scripts/local-stack.sh`
- Delete: `scripts/test-env.sh`, `supabase/config.toml`
- Modify: `package.json` (scripts + quitar devDep `supabase`), `pnpm-lock.yaml`,
  `.gitignore`, `tests/helpers/supabase.ts:11` (mensaje de error),
  `CLAUDE.md` §2 mapa, §3 comandos, §7 pregunta 5, `README.md` (Arranque, l.30-65
  y l.98), `PROJECT.md` (Security posture, bullet del 0.0.0.0),
  `docs/manual-buenas-practicas.md` §10, `docs/seguridad-operacional.md` §6 y §9

**Interfaces:**
- Produces: `pnpm db:up`, `pnpm db:down`, `pnpm db:reset`, `pnpm db:env`,
  `pnpm db:psql`, `pnpm db:status`. `.env.test` con las mismas cuatro variables
  que hoy (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_DB_URL`) → los tests no cambian. API en `http://127.0.0.1:54321`,
  Postgres en `127.0.0.1:54322` (mismos puertos que el CLI → la URL de
  `.env.local` no cambia; sí cambian las claves).

- [ ] **Step 1: Rama**

```bash
git switch -c batch/tokens-crecimiento-stack-versiones
```

- [ ] **Step 2: Generador de claves** — `scripts/local-stack-keys.mjs`

```js
// Genera los secretos del stack local de ESTA máquina. Nunca se commitean:
// el archivo que sale de acá (supabase/docker/.env) está en .gitignore.
//
// Las claves anon/service_role son JWT HS256 firmados con el JWT secret, que es
// exactamente lo que GoTrue y PostgREST validan. Diez años de vida: es un stack
// de desarrollo que escucha solo en 127.0.0.1.
import { createHmac, randomBytes } from 'node:crypto'

const jwtSecret = randomBytes(32).toString('hex')
const postgresPassword = randomBytes(24).toString('hex')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

function mint(role) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ role, iss: 'amelia-local', iat: now, exp: now + 10 * 365 * 86_400 })
  const sig = createHmac('sha256', jwtSecret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

process.stdout.write(
  [
    `JWT_SECRET=${jwtSecret}`,
    `POSTGRES_PASSWORD=${postgresPassword}`,
    `ANON_KEY=${mint('anon')}`,
    `SERVICE_ROLE_KEY=${mint('service_role')}`,
    '',
  ].join('\n'),
)
```

- [ ] **Step 3: Init SQL** — `supabase/docker/roles.sql`

```sql
-- Corre una sola vez, cuando el volumen de datos está vacío. La imagen de
-- supabase/postgres crea los roles; acá solo les ponemos la contraseña de ESTA
-- máquina (sale de supabase/docker/.env, nunca del repo).
\set pgpass `echo "$POSTGRES_PASSWORD"`
alter user authenticator with password :'pgpass';
alter user supabase_auth_admin with password :'pgpass';
```

- [ ] **Step 4: Gateway** — `supabase/docker/kong.yml`

```yaml
# Lo mínimo que la app y los tests usan: Auth y PostgREST detrás de una sola
# URL, como en Supabase. Sin key-auth: PostgREST y GoTrue validan el JWT ellos
# mismos, y el stack solo escucha en 127.0.0.1.
_format_version: '2.1'
services:
  - name: auth-v1
    url: http://auth:9999/
    routes: [{ name: auth-v1-all, strip_path: true, paths: [/auth/v1/] }]
    plugins: [{ name: cors }]
  - name: rest-v1
    url: http://rest:3000/
    routes: [{ name: rest-v1-all, strip_path: true, paths: [/rest/v1/] }]
    plugins: [{ name: cors }]
```

- [ ] **Step 5: Compose** — `supabase/docker/docker-compose.yml`

```yaml
# Stack local de Supabase para Amelia, SIN el CLI.
#
# Por qué existe: `supabase start` (CLI 2.117) publica cada puerto como
# `-p puerto:puerto`, o sea en 0.0.0.0, y no tiene clave de config para
# cambiarlo. En este VPS eso dejaba Postgres (postgres/postgres) y Studio sin
# auth en la IP pública. Acá cada puerto se publica como 127.0.0.1:p:p, igual
# que fruco-erp. Ver docs/seguridad-operacional.md §6.
#
# Mismas imágenes que ya había bajado el CLI: no hay pull nuevo.
# Se opera con scripts/local-stack.sh (pnpm db:up / db:down / db:reset).
name: amelia-local

services:
  db:
    image: public.ecr.aws/supabase/postgres:17.6.1.167
    ports: ['127.0.0.1:54322:5432']
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      PGPASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: postgres
      JWT_SECRET: ${JWT_SECRET}
    volumes:
      - ./roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:ro
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD', 'pg_isready', '-U', 'postgres', '-h', 'localhost']
      interval: 2s
      retries: 30

  auth:
    image: public.ecr.aws/supabase/gotrue:v2.196.0
    depends_on: { db: { condition: service_healthy } }
    environment:
      GOTRUE_API_HOST: 0.0.0.0 # dentro de la red de compose; no se publica
      GOTRUE_API_PORT: 9999
      API_EXTERNAL_URL: http://127.0.0.1:54321
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:${POSTGRES_PASSWORD}@db:5432/postgres
      GOTRUE_SITE_URL: http://localhost:3000
      GOTRUE_DISABLE_SIGNUP: 'false'
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_EXP: 3600
      GOTRUE_JWT_SECRET: ${JWT_SECRET}
      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true'
      # Lo mismo que enable_confirmations = false del config.toml viejo.
      GOTRUE_MAILER_AUTOCONFIRM: 'true'
    healthcheck:
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:9999/health']
      interval: 2s
      retries: 30

  rest:
    image: public.ecr.aws/supabase/postgrest:v16.2
    depends_on: { db: { condition: service_healthy } }
    environment:
      PGRST_DB_URI: postgres://authenticator:${POSTGRES_PASSWORD}@db:5432/postgres
      PGRST_DB_SCHEMAS: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: ${JWT_SECRET}
      PGRST_DB_USE_LEGACY_GUCS: 'false'

  kong:
    image: public.ecr.aws/supabase/kong:2.8.1
    depends_on: [auth, rest]
    ports: ['127.0.0.1:54321:8000']
    environment:
      KONG_DATABASE: 'off'
      KONG_DECLARATIVE_CONFIG: /home/kong/kong.yml
      KONG_DNS_ORDER: LAST,A,CNAME
      KONG_PLUGINS: cors
    volumes: ['./kong.yml:/home/kong/kong.yml:ro']

volumes:
  db-data:
```

Nota: si el healthcheck de `auth` falla porque la imagen no trae `wget`
(no lo verifiqué; el spike corrió sin healthcheck en `auth`), se reemplaza por
esperar en el script con `curl -sf http://127.0.0.1:54321/auth/v1/health` en un
loop de 30 intentos. **No se saca la espera**: las migraciones de la app
referencian `auth.users` y tienen que correr después de GoTrue.

- [ ] **Step 6: Script de operación** — `scripts/local-stack.sh`

```bash
#!/usr/bin/env bash
# Opera el stack local de Supabase (supabase/docker/). Reemplaza al CLI de
# Supabase, que publica sus puertos en 0.0.0.0 sin forma de evitarlo.
#
#   up      genera las claves la primera vez, levanta y aplica migraciones pendientes
#   down    baja los contenedores (los datos quedan en el volumen)
#   reset   baja, BORRA el volumen y levanta de cero con todas las migraciones
#   env     escribe .env.test y actualiza las 3 claves de Supabase en .env.local
#   psql    abre psql como postgres
#   status  contenedores y puertos (tienen que decir 127.0.0.1)
set -euo pipefail
cd "$(dirname "$0")/.."

DIR=supabase/docker
ENVF=$DIR/.env
dc() { docker compose -f "$DIR/docker-compose.yml" --env-file "$ENVF" "$@"; }
psql_db() { dc exec -T db psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres "$@"; }

ensure_keys() {
  if [ ! -f "$ENVF" ]; then
    node scripts/local-stack-keys.mjs > "$ENVF"
    chmod 600 "$ENVF"
    echo "Claves nuevas en $ENVF (gitignored)."
  fi
}

apply_migrations() {
  psql_db -c "create schema if not exists supabase_migrations;
              create table if not exists supabase_migrations.schema_migrations (
                version text primary key, applied_at timestamptz not null default now());"
  for f in supabase/migrations/*.sql; do
    v=$(basename "$f" .sql)
    done_already=$(psql_db -tAc "select 1 from supabase_migrations.schema_migrations where version = '$v'")
    [ "$done_already" = "1" ] && continue
    echo "aplicando $v"
    { echo 'begin;'; cat "$f"; echo;
      echo "insert into supabase_migrations.schema_migrations (version) values ('$v');";
      echo 'commit;'; } | psql_db
  done
  # PostgREST cachea el schema: sin esto no ve las tablas nuevas.
  psql_db -c "notify pgrst, 'reload schema'"
}

get() { grep -E "^$1=" "$ENVF" | cut -d= -f2-; }

write_env() {
  local url=http://127.0.0.1:54321
  {
    echo "SUPABASE_URL=$url"
    echo "SUPABASE_ANON_KEY=$(get ANON_KEY)"
    echo "SUPABASE_SERVICE_ROLE_KEY=$(get SERVICE_ROLE_KEY)"
    echo "SUPABASE_DB_URL=postgresql://postgres:$(get POSTGRES_PASSWORD)@127.0.0.1:54322/postgres"
  } > .env.test
  chmod 600 .env.test
  [ -f .env.local ] || cp .env.local.example .env.local
  sed -i -e "s|^NEXT_PUBLIC_SUPABASE_URL=.*|NEXT_PUBLIC_SUPABASE_URL=$url|" \
         -e "s|^NEXT_PUBLIC_SUPABASE_ANON_KEY=.*|NEXT_PUBLIC_SUPABASE_ANON_KEY=$(get ANON_KEY)|" \
         -e "s|^SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$(get SERVICE_ROLE_KEY)|" .env.local
  chmod 600 .env.local
  echo "Escritos .env.test y las 3 claves de Supabase en .env.local"
}

case "${1:-}" in
  up)     ensure_keys; dc up -d --wait; apply_migrations ;;
  down)   dc down ;;
  reset)  ensure_keys; dc down -v; dc up -d --wait; apply_migrations ;;
  env)    ensure_keys; write_env ;;
  psql)   dc exec db psql -U postgres -d postgres ;;
  status) dc ps --format '{{.Name}}\t{{.Status}}\t{{.Ports}}' ;;
  *) echo "uso: $0 up|down|reset|env|psql|status" >&2; exit 2 ;;
esac
```

`chmod +x scripts/local-stack.sh`.

- [ ] **Step 7: package.json, lockfile, gitignore**

Scripts nuevos (se agregan; `test:*` quedan igual):

```json
"db:up": "bash scripts/local-stack.sh up",
"db:down": "bash scripts/local-stack.sh down",
"db:reset": "bash scripts/local-stack.sh reset",
"db:env": "bash scripts/local-stack.sh env",
"db:psql": "bash scripts/local-stack.sh psql",
"db:status": "bash scripts/local-stack.sh status",
```

```bash
pnpm remove supabase          # el CLI deja de ser dependencia: es el que bindea a 0.0.0.0
git rm scripts/test-env.sh supabase/config.toml
printf 'supabase/docker/.env\n' >> .gitignore
```

Sin `config.toml`, un `pnpm dlx supabase start` distraído se niega a arrancar
(pide `supabase init`) en vez de abrir puertos. `supabase/migrations/`,
`schema.sql` y `snippets/` se quedan.

- [ ] **Step 8: Mensaje de error del helper** — `tests/helpers/supabase.ts:11-14`

```ts
    throw new Error(
      'Falta .env.test. Levantá el stack con `pnpm db:up` y corré `pnpm db:env`.',
    )
```

- [ ] **Step 9: Levantar y verificar el binding (la prueba de esta tarea)**

```bash
pnpm db:up && pnpm db:env && pnpm db:status
ss -tln | grep -E ':5432[0-9]'
curl -s -m 3 -o /dev/null -w '%{http_code}\n' "http://$(hostname -I | awk '{print $1}'):54321/rest/v1/" || echo "sin respuesta (esperado)"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:54321/rest/v1/
```

Expected: `db:status` muestra `127.0.0.1:54321->8000/tcp` y
`127.0.0.1:54322->5432/tcp` y ningún `0.0.0.0`; `ss` solo `127.0.0.1`; IP
pública → `000`/sin respuesta; loopback → `200`. Y `pnpm db:up` otra vez no
re-aplica nada (idempotente: no imprime "aplicando").

- [ ] **Step 9b: `next dev` también en 127.0.0.1 (decisión de Emilio, P-5)**

`package.json`: `"dev": "next dev -H 127.0.0.1"`. Verificar:
`pnpm dev &` → `ss -tln | grep ':3000'` muestra `127.0.0.1:3000`, no `*:3000`
ni `0.0.0.0:3000`; `kill %1`. Actualizar la línea `pnpm dev` de CLAUDE.md §3 y
del README ("escucha solo en 127.0.0.1; para probar desde el teléfono en la
LAN hace falta un túnel/SSH, a propósito").

- [ ] **Step 9c: Copiar los datos del stack viejo al nuevo — SIN TOCAR EL VIEJO (decisión de Emilio, P-4)**

**Regla dura:** los volúmenes `supabase_db_amelia-app`,
`supabase_edge_runtime_amelia-app` y `supabase_storage_amelia-app` **no se
borran, no se montan en escritura y no se modifican bajo ninguna
circunstancia**. Quedan como respaldo. Ningún `docker volume rm`, ningún
`docker compose down -v` que los alcance (el `down -v` de `db:reset` solo borra
`amelia-local_db-data`, del proyecto compose nuevo — verificar con
`docker volume ls` antes y después).

Procedimiento (sobre una **copia**):

```bash
docker volume ls --format '{{.Name}}' | sort > /tmp/.../scratchpad/volumes-before.txt   # usar el scratchpad de la sesión
docker volume create amelia-legacy-copy
docker run --rm -v supabase_db_amelia-app:/src:ro -v amelia-legacy-copy:/dst alpine sh -c 'cp -a /src/. /dst/'
# Postgres viejo levantado sobre la COPIA, sin publicar ningún puerto:
docker run -d --name amelia-legacy-read -v amelia-legacy-copy:/var/lib/postgresql/data \
  public.ecr.aws/supabase/postgres:17.6.1.167
# esperar pg_isready; si la imagen/versión no coincide con la del volumen, leer
# PG_VERSION del volumen copiado y usar esa imagen (las que dejó el CLI están locales)
docker exec amelia-legacy-read pg_isready -U postgres
docker exec amelia-legacy-read psql -U postgres -tAc "select version from supabase_migrations.schema_migrations order by 1"   # qué migraciones tenía
docker exec amelia-legacy-read psql -U postgres -tAc "select count(*) from auth.users"
# y un count(*) por tabla de public, al output
```

Dump **solo de datos**, de lo que la app usa, y restore en el stack nuevo (que
en este punto tiene aplicadas las mismas `0001`…`0006`):

```bash
docker exec amelia-legacy-read pg_dump -U postgres --data-only --disable-triggers \
  -t auth.users -t auth.identities \
  -t public.families -t public.family_members -t public.babies -t public.feedings \
  -t public.diaper_changes -t public.sleep_sessions -t public.growth_measurements \
  -t public.nursing_sessions -t public.doctor_appointments -t public.monitor_events \
  -t public.pumping_sessions > <scratchpad>/legacy-data.sql
```

(la lista de tablas de `public` se confirma contra `\dt public.*` de la copia;
si hay una tabla de la app que no está en la lista, se agrega; si alguna de
`0003` —reset de leche— guarda estado en otra tabla, también). Restore:
`pnpm db:psql` no sirve para stdin; usar
`docker compose -f supabase/docker/docker-compose.yml --env-file supabase/docker/.env exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < <scratchpad>/legacy-data.sql`
**antes** de correr los tests de integración (los tests crean y borran sus
propias familias con tag; no tocan las filas migradas). Si el restore choca con
filas que GoTrue crea al arrancar (no debería: `auth.users` nace vacío), se
reporta y se decide, no se fuerza.

Verificación: los mismos `count(*)` en el stack nuevo coinciden con los de la
copia; un usuario viejo puede loguearse (`signInWithPassword` con una cuenta
conocida si Emilio la tiene; si no, se verifica que `auth.users` e
`auth.identities` tengan las mismas filas y se dice que el login no se probó).

Limpieza: `docker rm -f amelia-legacy-read` y `docker volume rm amelia-legacy-copy`
(la **copia**, que creamos nosotros). Después:
`docker volume ls --format '{{.Name}}' | sort | diff volumes-before.txt -` →
la única diferencia admitida es `amelia-local_db-data` (nuevo). Los tres
`supabase_*_amelia-app` siguen estando. Todo al output.

El dump queda en el scratchpad de la sesión (tiene hashes de contraseñas: no
entra al repo, no se copia a ningún otro lado).

- [ ] **Step 10: Suite completa contra el stack nuevo**

Run: `pnpm test:all`
Expected: unit ×4 TZ verdes; integración **29/29** (lo mismo que el spike).

- [ ] **Step 11: Docs** — reemplazar cada aparición operativa del CLI:

```bash
grep -rn 'supabase start\|supabase stop\|supabase db reset\|supabase status\|test-env.sh\|0\.0\.0\.0\|54323' \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git . \
  | grep -v '^./docs/auditorias/' | grep -v '^./docs/superpowers/plans/' | grep -v '^./supabase/docker/'
```

Cada hit se reescribe (los reportes de auditoría y los planes viejos son
historia y no se tocan):

- `CLAUDE.md` §3: bloque "Base de datos local" pasa a `pnpm db:up` /
  `pnpm db:env` / `pnpm db:reset` / `pnpm db:down` / `pnpm db:psql`, con la nota
  "escucha solo en 127.0.0.1 — ver `supabase/docker/docker-compose.yml`"; se va
  la línea de Studio (no se levanta Studio: P-3). §2 mapa: agregar
  `supabase/docker/` y `scripts/local-stack.sh`. §7 pregunta 5: **cerrada**, con
  fecha y la evidencia E-3/E-4 en dos líneas.
- `README.md` Arranque: `pnpm install` → `pnpm db:up` → `pnpm db:env` →
  `pnpm dev`. Se va la tabla de "copiá tres valores de `supabase start`" (lo
  hace `db:env`) y el aviso de "antes de irte `supabase stop`".
- `docs/manual-buenas-practicas.md` §10: "Docker + `pnpm db:up`".
- `docs/seguridad-operacional.md` §6: el hallazgo queda como historia con fecha;
  se agrega "Resuelto el 21 sep 2026" con la salida de `db:status` y de `ss`.
  Las tres opciones pasan a una: "el stack propio ya bindea a 127.0.0.1; no
  vuelvas al CLI". §9: primera fila del historial de incidentes (fecha
  20 sep 2026, qué pasó: Postgres/Studio/API en 0.0.0.0; cómo se detectó:
  `docker ps` + curl desde la IP pública; qué se hizo: stack propio en
  127.0.0.1; qué cambió: se sacó el CLI y `config.toml`).
- `PROJECT.md` Security posture: el bullet del `0.0.0.0` pasa a resuelto.

- [ ] **Step 12: Gate + commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm format:check && pnpm build && pnpm test:all
git status --short   # ni .env.test, ni .env.local, ni supabase/docker/.env
git add -A && git commit -m "Keep the local database reachable from this machine only

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Tabla `device_tokens`, herramienta de administración y cambio de regla

**Files:**
- Create: `supabase/migrations/0007_device_tokens.sql`, `lib/deviceTokens.ts`,
  `scripts/device-token.mts`, `tests/unit/deviceTokens.test.ts`
- Modify: `tests/helpers/supabase.ts` (+ `seedDeviceToken`),
  `tests/integration/rls.test.ts` (+ describe `device_tokens`),
  `tsconfig.json` (+ `allowImportingTsExtensions`), `package.json`
  (+ script `device-token`), `supabase/schema.sql` (+ bloque 0007),
  `CLAUDE.md` §5.2, `docs/checklist-cada-cambio.md` (A y B), `PROJECT.md`
  (phase 2, bullet de migraciones)

**Interfaces:**
- Produces (`lib/deviceTokens.ts`):
  - `DEVICE_SCOPES: readonly ['ingest', 'quick_nurse']`
  - `type DeviceScope = 'ingest' | 'quick_nurse'`
  - `isDeviceScope(v: unknown): v is DeviceScope`
  - `generateDeviceToken(): { token: string; hash: string }` — token
    `amd_` + 43 chars base64url (32 bytes)
  - `hashDeviceToken(token: string): string` — sha-256 hex, 64 chars
  - `looksLikeDeviceToken(v: unknown): v is string`
  - `readBearer(req: Request): string | null`
- Produces (`tests/helpers/supabase.ts`):
  `seedDeviceToken(opts: { familyId: string; babyId?: string | null; scopes: DeviceScope[]; revoked?: boolean }): Promise<{ id: string; token: string }>`
- Produces: `pnpm device-token families|create|list|revoke`

- [ ] **Step 1: Test unitario que falla** — `tests/unit/deviceTokens.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import {
  generateDeviceToken,
  hashDeviceToken,
  isDeviceScope,
  looksLikeDeviceToken,
  readBearer,
} from '@/lib/deviceTokens'

describe('generateDeviceToken', () => {
  it('da un token con prefijo y 256 bits, y su hash', () => {
    const { token, hash } = generateDeviceToken()
    expect(token).toMatch(/^amd_[A-Za-z0-9_-]{43}$/)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(hashDeviceToken(token))
  })

  it('dos tokens nunca salen iguales', () => {
    expect(generateDeviceToken().token).not.toBe(generateDeviceToken().token)
  })
})

describe('hashDeviceToken', () => {
  it('es determinístico y no contiene el token', () => {
    const t = 'amd_' + 'a'.repeat(43)
    expect(hashDeviceToken(t)).toBe(hashDeviceToken(t))
    expect(hashDeviceToken(t)).not.toContain('aaaa')
  })
})

describe('looksLikeDeviceToken', () => {
  it('acepta solo la forma exacta', () => {
    expect(looksLikeDeviceToken(generateDeviceToken().token)).toBe(true)
    expect(looksLikeDeviceToken('amd_corto')).toBe(false)
    expect(looksLikeDeviceToken('secreto-viejo-compartido')).toBe(false)
    expect(looksLikeDeviceToken(undefined)).toBe(false)
  })
})

describe('readBearer', () => {
  const req = (h?: string) =>
    new Request('http://x', h === undefined ? {} : { headers: { authorization: h } })

  it('lee el token de Authorization: Bearer', () => {
    expect(readBearer(req('Bearer amd_abc'))).toBe('amd_abc')
    expect(readBearer(req('bearer amd_abc'))).toBe('amd_abc')
  })

  it('sin header, o con otro esquema, no hay token', () => {
    expect(readBearer(req())).toBeNull()
    expect(readBearer(req('Basic abc'))).toBeNull()
    expect(readBearer(req('Bearer '))).toBeNull()
  })
})

describe('isDeviceScope', () => {
  it('solo los dos scopes que existen', () => {
    expect(isDeviceScope('ingest')).toBe(true)
    expect(isDeviceScope('quick_nurse')).toBe(true)
    expect(isDeviceScope('admin')).toBe(false)
  })
})
```

- [ ] **Step 2: Correrlo — falla**

Run: `pnpm exec vitest run tests/unit/deviceTokens.test.ts`
Expected: FAIL, `Failed to resolve import "@/lib/deviceTokens"`.

- [ ] **Step 3: Implementación** — `lib/deviceTokens.ts`

```ts
import { createHash, randomBytes } from 'node:crypto'

/**
 * Tokens por dispositivo: lo que reemplaza a NUC_DEVICE_SECRET y
 * QUICK_TOGGLE_SECRET (hallazgos C1 y C2 de
 * docs/auditorias/2026-09-20-auditoria-inicial.md).
 *
 * Puro y sin imports con alias `@/`: lo usan tanto el servidor como
 * scripts/device-token.mts, que corre con Node pelado.
 *
 * Por qué sha-256 y no bcrypt: el token son 256 bits aleatorios, no una
 * contraseña elegida por una persona. No hay diccionario que probar; un hash
 * rápido alcanza y permite buscar por índice.
 */

export const DEVICE_SCOPES = ['ingest', 'quick_nurse'] as const
export type DeviceScope = (typeof DEVICE_SCOPES)[number]

const PREFIX = 'amd_'
const SHAPE = /^amd_[A-Za-z0-9_-]{43}$/

export function isDeviceScope(value: unknown): value is DeviceScope {
  return DEVICE_SCOPES.some((s) => s === value)
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** El token en claro existe una sola vez: acá, al crearlo. La base guarda el hash. */
export function generateDeviceToken(): { token: string; hash: string } {
  const token = PREFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashDeviceToken(token) }
}

/** Filtro barato antes de ir a la base: basura con otra forma ni se busca. */
export function looksLikeDeviceToken(value: unknown): value is string {
  return typeof value === 'string' && SHAPE.test(value)
}

export function readBearer(req: Request): string | null {
  const match = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)
  return match ? match[1] : null
}
```

- [ ] **Step 4: Correrlo — pasa**

Run: `pnpm exec vitest run tests/unit/deviceTokens.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Tests de integración que fallan** — en `tests/helpers/supabase.ts`
agregar (import de `generateDeviceToken` y `type DeviceScope` desde
`@/lib/deviceTokens`):

```ts
/**
 * Un token de dispositivo sembrado directo con service_role, como lo haría
 * `pnpm device-token create`. Devuelve el token en claro: la base solo tiene el
 * hash. Se borra en cascada con la familia en cleanup().
 */
export async function seedDeviceToken(opts: {
  familyId: string
  babyId?: string | null
  scopes: DeviceScope[]
  revoked?: boolean
}): Promise<{ id: string; token: string }> {
  const { token, hash } = generateDeviceToken()
  const { data, error } = await adminClient()
    .from('device_tokens')
    .insert({
      family_id: opts.familyId,
      baby_id: opts.babyId ?? null,
      label: 'dispositivo de prueba',
      token_hash: hash,
      scopes: opts.scopes,
      revoked_at: opts.revoked ? new Date().toISOString() : null,
    })
    .select('id')
    .single()
  if (error) throw error
  return { id: data.id, token }
}
```

Y actualizar el comentario de `seedTwoFamilies` ("La familia A se siembra
PRIMERO a propósito: /api/quick/nurse toma el `babies` más antiguo…") a:
"La familia A se siembra primero: era la que el bug viejo de /api/quick/nurse se
quedaba (C1). Se mantiene el orden para que el test que lo prueba cerrado siga
significando algo."

En `tests/integration/rls.test.ts`, importar `seedDeviceToken` y agregar al final:

```ts
/**
 * 0007: los tokens de dispositivo son solo del servidor. Ni un padre logueado
 * ni un anónimo los leen o los crean — ni siquiera los de su propia familia.
 * Se administran con `pnpm device-token`, que usa service_role.
 */
describe('device_tokens', () => {
  it('un padre no puede leer tokens, ni los de su propia familia', async () => {
    await seedDeviceToken({ familyId: a.familyId, scopes: ['ingest'] })
    const { data, error } = await a.client.from('device_tokens').select('id, token_hash')
    expect(error).not.toBeNull()
    expect(data).toBeNull()
  })

  it('un padre no puede crear un token', async () => {
    const { error } = await a.client.from('device_tokens').insert({
      family_id: a.familyId,
      label: 'colado',
      token_hash: 'f'.repeat(64),
      scopes: ['ingest'],
    })
    expect(error).not.toBeNull()
  })

  it('un anónimo tampoco lee', async () => {
    const { data, error } = await anonClient().from('device_tokens').select('id')
    expect(error).not.toBeNull()
    expect(data).toBeNull()
  })

  it('un token no se puede clavar a un bebé de otra familia (FK compuesta)', async () => {
    const { error } = await adminClient().from('device_tokens').insert({
      family_id: a.familyId,
      baby_id: b.babyId,
      label: 'cruzado',
      token_hash: 'e'.repeat(64),
      scopes: ['quick_nurse'],
    })
    expect(error?.code).toBe('23503')
  })

  it('un scope que no existe se rechaza', async () => {
    const { error } = await adminClient().from('device_tokens').insert({
      family_id: a.familyId,
      label: 'poderoso',
      token_hash: 'd'.repeat(64),
      scopes: ['admin'],
    })
    expect(error?.code).toBe('23514')
  })

  it('un token sin scopes se rechaza', async () => {
    const { error } = await adminClient().from('device_tokens').insert({
      family_id: a.familyId,
      label: 'vacío',
      token_hash: 'c'.repeat(64),
      scopes: [],
    })
    expect(error?.code).toBe('23514')
  })
})
```

Run: `pnpm test:integration`
Expected: FAIL — `relation "public.device_tokens" does not exist` en
`seedDeviceToken` y en los inserts.

- [ ] **Step 6: Migración** — `supabase/migrations/0007_device_tokens.sql`

```sql
-- Tokens por dispositivo. Reemplazan al secreto compartido de /api/ingest y
-- /api/quick/nurse, que no decía de qué familia era nadie (hallazgos C1 y C2,
-- docs/auditorias/2026-09-20-auditoria-inicial.md).
--
-- Numerada en este repo por pedido explícito de Emilio (21 sep 2026), no por
-- el agente del Hub: ver CLAUDE.md §5.2.

-- La FK compuesta de abajo necesita que (id, family_id) sea única en babies.
-- id ya es PK, así que esto no restringe nada nuevo: solo lo hace referenciable.
alter table babies add constraint babies_id_family_id_key unique (id, family_id);

create table device_tokens (
  id uuid primary key default gen_random_uuid(),
  -- Scope directo por familia (no por join vía baby_id): fase 2 lo pide así.
  family_id uuid not null references families(id) on delete cascade,
  -- Nulo = vale para toda la familia (el NUC). No nulo = clavado a un bebé.
  baby_id uuid,
  label text not null check (length(btrim(label)) > 0),
  -- NUNCA el token en claro: sha-256 hex.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null
    check (cardinality(scopes) > 0 and scopes <@ array['ingest', 'quick_nurse']::text[]),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  -- Lo que la propuesta intentó con un CHECK que siempre daba verdadero: el bebé
  -- tiene que ser DE ESA familia. Con baby_id nulo la FK no se evalúa.
  constraint device_tokens_baby_in_family
    foreign key (baby_id, family_id) references babies (id, family_id) on delete cascade
);

alter table device_tokens enable row level security;

-- Sin policies, a propósito: nadie la lee desde la app. Solo el servidor
-- (service_role) y `pnpm device-token`.
--
-- Y el revoke hace falta aunque no haya policies: 0005 dejó
-- `alter default privileges ... grant ... to authenticated`, así que esta tabla
-- nació con grants. RLS sin policy ya bloquea las filas; el revoke cierra
-- también la tabla, para que un error de policy futuro no alcance.
revoke all on device_tokens from anon, authenticated;
```

Aplicar: `pnpm db:up` (aplica solo la pendiente; debe imprimir `aplicando 0007_device_tokens`).

- [ ] **Step 7: Correr — pasa**

Run: `pnpm test:integration`
Expected: PASS, incluidos los 6 nuevos de `device_tokens`. Los de ingest y
quick-nurse siguen verdes con los secretos viejos (esta tarea no los toca).

- [ ] **Step 8: Herramienta** — `tsconfig.json` agrega
`"allowImportingTsExtensions": true` (válido porque ya hay `noEmit: true`), y
`scripts/device-token.mts`:

```ts
/**
 * Administración de tokens de dispositivo. Corre con service_role (la de
 * .env.local): es una herramienta de servidor, nunca de la app.
 *
 *   pnpm device-token families
 *   pnpm device-token create --family <uuid> [--baby <uuid>] --label "NUC del cuarto" --scope ingest
 *   pnpm device-token list --family <uuid>
 *   pnpm device-token revoke --id <uuid>
 *
 * El token en claro se imprime UNA vez, en `create`. Después solo existe su hash.
 */
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { DEVICE_SCOPES, generateDeviceToken, isDeviceScope } from '../lib/deviceTokens.ts'

const out = (line: string) => process.stdout.write(`${line}\n`)
function die(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) die('Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local')
const db = createClient(url, key, { auth: { persistSession: false } })

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    family: { type: 'string' },
    baby: { type: 'string' },
    label: { type: 'string' },
    scope: { type: 'string', multiple: true },
    id: { type: 'string' },
  },
})

switch (positionals[0]) {
  case 'families': {
    const { data, error } = await db.from('babies').select('id, name, family_id, families(name)')
    if (error) die(error.message)
    for (const b of data ?? []) out(`familia ${b.family_id}  bebé ${b.id}  ${b.name}`)
    break
  }
  case 'create': {
    const scopes = values.scope ?? []
    if (!values.family || !values.label || scopes.length === 0) {
      die(`uso: create --family <uuid> [--baby <uuid>] --label <texto> --scope ${DEVICE_SCOPES.join('|')}`)
    }
    const bad = scopes.filter((s) => !isDeviceScope(s))
    if (bad.length > 0) die(`scopes desconocidos: ${bad.join(', ')}`)
    const { token, hash } = generateDeviceToken()
    const { data, error } = await db
      .from('device_tokens')
      .insert({
        family_id: values.family,
        baby_id: values.baby ?? null,
        label: values.label,
        token_hash: hash,
        scopes,
      })
      .select('id')
      .single()
    if (error) die(error.message)
    out(`id:    ${data.id}`)
    out(`token: ${token}`)
    out('Guardalo ahora en el dispositivo (header Authorization: Bearer <token>). No se vuelve a mostrar.')
    break
  }
  case 'list': {
    if (!values.family) die('uso: list --family <uuid>')
    const { data, error } = await db
      .from('device_tokens')
      .select('id, label, baby_id, scopes, created_at, last_used_at, revoked_at')
      .eq('family_id', values.family)
      .order('created_at')
    if (error) die(error.message)
    for (const t of data ?? []) {
      const state = t.revoked_at ? `REVOCADO ${t.revoked_at}` : `último uso ${t.last_used_at ?? 'nunca'}`
      out(`${t.id}  ${t.label}  [${t.scopes.join(',')}]  bebé ${t.baby_id ?? 'toda la familia'}  ${state}`)
    }
    break
  }
  case 'revoke': {
    if (!values.id) die('uso: revoke --id <uuid>')
    const { data, error } = await db
      .from('device_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', values.id)
      .is('revoked_at', null)
      .select('id')
    if (error) die(error.message)
    out(data && data.length > 0 ? `revocado ${values.id}` : 'no existe o ya estaba revocado')
    break
  }
  default:
    die('uso: pnpm device-token families|create|list|revoke')
}
```

`package.json`: `"device-token": "node --env-file=.env.local scripts/device-token.mts"`.

Si `pnpm build` o `tsc` se quejan del import con `.ts` pese al flag, el
fallback es excluir `scripts/**/*.mts` del `include` de `tsconfig.json` y
dejarlo tipado solo por Node — **se reporta si pasa**, no se esconde.

- [ ] **Step 9: Probar la herramienta contra el stack local**

```bash
pnpm device-token families                        # lista familias/bebés de prueba (si hay)
pnpm device-token create --family <uuid> --label "prueba manual" --scope ingest
pnpm device-token list --family <uuid>            # aparece, "último uso nunca"
pnpm device-token revoke --id <id>                # "revocado <id>"
pnpm device-token revoke --id <id>                # "no existe o ya estaba revocado"
pnpm db:psql -c "select token_hash from device_tokens where id = '<id>'"   # 64 hex, no el token
```

Si no hay familia sembrada, crear una con `pnpm db:psql` (insert en `families`)
y borrarla al terminar. Salida real al output.

- [ ] **Step 10: Regla y docs**

`CLAUDE.md` §5.2, reemplazar los bullets 1-2 por:

```markdown
- **Nunca edites una migración ya aplicada.** `0001` … `0008` son historia.
  Un cambio se hace con un archivo nuevo.
- **Quién numera.** Por defecto, un cambio de schema se **propone** en
  `proposals/` para el agente del Hub (ADR 0003). **Excepción:** cuando Emilio
  pide explícitamente implementarlo en este repo, se numera acá con el
  siguiente número libre (así nacieron `0007` y `0008`, 21 sep 2026). Cuando
  llegue el monorepo, estas migraciones entran como historia y la numeración
  pasa al Hub.
```

y agregar un bullet: *"Toda tabla nueva nace con grants por defecto a
`authenticated` (lo dejó `0005`). Si una tabla es solo del servidor, `revoke
all ... from anon, authenticated` en la misma migración — ver `0007`."*

`docs/checklist-cada-cambio.md`: bloque A, el ítem del schema pasa a "¿El cambio
toca el schema? Si Emilio pidió implementarlo acá, migración nueva numerada; si
no, propuesta en `proposals/` (CLAUDE.md §5.2)". Bloque B: "Si tocaste el
schema: migración nueva (o propuesta), con RLS **y** GRANT/REVOKE explícitos, y
un test de integración". Y el ítem de queries: "(los route handlers y
`lib/deviceAuth.ts`, server-only, son la excepción)".

`PROJECT.md` phase 2, bullet "Migrations move to `packages/db/migrations`…":
agregar "`0007` y `0008` se numeraron en este repo por pedido explícito; entran
al Hub como historia."

`supabase/schema.sql`: agregar al final el contenido de `0007` bajo un
encabezado `-- ---------- DEVICE TOKENS (0007) ----------`.

- [ ] **Step 11: Gate + commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm format:check && pnpm build && pnpm test:all
git add -A && git commit -m "Give each device its own revocable token, tied to one family

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Los endpoints de dispositivo escriben solo en la familia de su token

**Files:**
- Modify: `lib/deviceAuth.ts` (reescritura de la parte de auth),
  `app/api/ingest/route.ts`, `app/api/quick/nurse/route.ts`,
  `.env.local.example`, `docs/seguridad-operacional.md` §5 y §8,
  `CLAUDE.md` §6 y §7 (preguntas 3 y 4), `PROJECT.md` (`/api/ingest`, NOT built,
  Security posture), `proposals/device-tokens-and-idempotency.md`
- Test (reescritos): `tests/integration/ingest.test.ts`,
  `tests/integration/quick-nurse.test.ts`

**Interfaces:**
- Consumes: `hashDeviceToken`, `looksLikeDeviceToken`, `readBearer`,
  `type DeviceScope` (T2); `seedDeviceToken` (T2).
- Produces (`lib/deviceAuth.ts`):
  - `type DeviceIdentity = { tokenId: string; familyId: string; babyId: string | null; scopes: DeviceScope[] }`
  - `type DeviceFailure = { status: 400 | 401 | 403 | 404 | 409 | 429 | 500; error: string }`
  - `isDeviceFailure(x: object): x is DeviceFailure`
  - `authenticateDevice(req: Request, supabase: SupabaseClient, scope: DeviceScope): Promise<DeviceIdentity | DeviceFailure>`
  - `resolveBabyForDevice(supabase: SupabaseClient, identity: DeviceIdentity, requested: unknown): Promise<{ babyId: string } | DeviceFailure>`
  - `deviceFailureResponse(f: DeviceFailure): NextResponse`
  - se mantienen: `resetDeviceRateLimit`, `readJson`, `isUuid`, `isSaneInstant`
  - **se elimina:** `checkDeviceSecret`, `DeviceAuthResult`, `constantTimeEquals`

Semántica de `resolveBabyForDevice` (una sola, para los dos endpoints):

| `requested` | token clavado a un bebé | token de familia |
| --- | --- | --- |
| ausente | ese bebé | el único bebé de la familia; 0 → 404; >1 → 409 |
| no-uuid | 400 | 400 |
| uuid | igual al clavado → ok; distinto → 403 | de la familia → ok; si no → 403 |

- [ ] **Step 1: Reescribir los tests (fallan)** — `tests/integration/ingest.test.ts` completo:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  adminClient,
  exposeEnvToRouteHandlers,
  seedDeviceToken,
  seedTwoFamilies,
  type SeededFamily,
} from '../helpers/supabase'
import { resetDeviceRateLimit } from '@/lib/deviceAuth'

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>
let familyA: string // toda la familia A, scope ingest
let pinnedA: string // clavado al bebé de A
let nurseOnlyA: string // scope equivocado
let revokedA: string

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  ;({ a, b, cleanup } = await seedTwoFamilies('ingest'))
  familyA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['ingest'] })).token
  pinnedA = (await seedDeviceToken({ familyId: a.familyId, babyId: a.babyId, scopes: ['ingest'] }))
    .token
  nurseOnlyA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['quick_nurse'] })).token
  revokedA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['ingest'], revoked: true }))
    .token
})
afterAll(async () => {
  await cleanup()
})

// El contador del rate limit es global al proceso.
beforeEach(() => {
  resetDeviceRateLimit()
})

async function post(body: unknown, token: string | null, extra: Record<string, string> = {}) {
  return raw(JSON.stringify(body), token, extra)
}

async function raw(body: string, token: string | null, extra: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/ingest/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return POST(
    new NextRequest(new Request('http://localhost/api/ingest', { method: 'POST', headers, body })),
  )
}

async function eventsOf(babyId: string) {
  const { data } = await adminClient().from('monitor_events').select('id').eq('baby_id', babyId)
  return data ?? []
}

describe('/api/ingest — quién entra', () => {
  it('sin token, 401', async () => {
    expect((await post({ event_type: 'sound_alert' }, null)).status).toBe(401)
  })

  it('el header viejo x-device-secret ya no abre nada', async () => {
    const res = await post({ baby_id: a.babyId, event_type: 'sound_alert' }, null, {
      'x-device-secret': 'secreto-de-prueba-del-nuc',
    })
    expect(res.status).toBe(401)
  })

  it('un token bien formado que no existe, 401', async () => {
    expect((await post({ event_type: 'sound_alert' }, 'amd_' + 'x'.repeat(43))).status).toBe(401)
  })

  it('un token revocado, 401', async () => {
    expect((await post({ event_type: 'sound_alert' }, revokedA)).status).toBe(401)
  })

  it('un token sin el scope ingest, 403', async () => {
    expect((await post({ event_type: 'sound_alert' }, nurseOnlyA)).status).toBe(403)
  })

  it('marca last_used_at del token que entró', async () => {
    const t = await seedDeviceToken({ familyId: a.familyId, scopes: ['ingest'] })
    expect((await post({ event_type: 'sound_alert' }, t.token)).status).toBe(200)
    const { data } = await adminClient()
      .from('device_tokens')
      .select('last_used_at')
      .eq('id', t.id)
      .single()
    expect(data!.last_used_at).not.toBeNull()
  })
})

/**
 * HALLAZGO C2, CERRADO. Antes: un secreto válido escribía sobre el bebé de
 * cualquier familia. Ahora el bebé se valida contra la familia del token.
 */
describe('/api/ingest — a qué bebé le escribe', () => {
  it('un token de la familia A NO escribe sobre el bebé de B', async () => {
    const res = await post({ baby_id: b.babyId, event_type: 'sound_alert' }, familyA)
    expect(res.status).toBe(403)
    expect(await eventsOf(b.babyId)).toEqual([])
  })

  it('un token clavado a A tampoco escribe sobre B', async () => {
    expect((await post({ baby_id: b.babyId, event_type: 'sound_alert' }, pinnedA)).status).toBe(403)
    expect(await eventsOf(b.babyId)).toEqual([])
  })

  it('un token de familia escribe sobre un bebé de su familia', async () => {
    const before = (await eventsOf(a.babyId)).length
    expect((await post({ baby_id: a.babyId, event_type: 'motion_start' }, familyA)).status).toBe(
      200,
    )
    expect(await eventsOf(a.babyId)).toHaveLength(before + 1)
  })

  it('sin baby_id, un token clavado usa su bebé', async () => {
    const before = (await eventsOf(a.babyId)).length
    expect((await post({ event_type: 'motion_end' }, pinnedA)).status).toBe(200)
    expect(await eventsOf(a.babyId)).toHaveLength(before + 1)
  })

  it('sin baby_id, un token de familia con un solo bebé usa ese', async () => {
    const before = (await eventsOf(a.babyId)).length
    expect((await post({ event_type: 'sound_alert' }, familyA)).status).toBe(200)
    expect(await eventsOf(a.babyId)).toHaveLength(before + 1)
  })

  it('abre y cierra una sesión de sueño derivada', async () => {
    const start = await post(
      { baby_id: a.babyId, kind: 'sleep_start', occurred_at: '2026-09-20T20:00:00Z' },
      familyA,
    )
    expect(start.status).toBe(200)
    const end = await post(
      { baby_id: a.babyId, kind: 'sleep_end', occurred_at: '2026-09-20T21:30:00Z' },
      familyA,
    )
    expect(end.status).toBe(200)

    const { data } = await adminClient()
      .from('sleep_sessions')
      .select('ended_at, source')
      .eq('baby_id', a.babyId)
    expect(data).toHaveLength(1)
    expect(data![0].source).toBe('nuc_derived')
    expect(data![0].ended_at).not.toBeNull()
  })
})

describe('/api/ingest — con un segundo bebé en la familia A', () => {
  let secondA: string

  beforeAll(async () => {
    const { data, error } = await adminClient()
      .from('babies')
      .insert({ family_id: a.familyId, name: 'Bebe a2', birth_date: '2026-09-01' })
      .select('id')
      .single()
    if (error) throw error
    secondA = data.id
  })

  it('un token de familia sin baby_id falla cerrado (409), no adivina', async () => {
    const res = await post({ event_type: 'sound_alert' }, familyA)
    expect(res.status).toBe(409)
  })

  it('un token de familia con baby_id del segundo bebé, escribe ahí', async () => {
    expect((await post({ baby_id: secondA, event_type: 'sound_alert' }, familyA)).status).toBe(200)
    expect(await eventsOf(secondA)).toHaveLength(1)
  })

  it('un token clavado al primero no escribe sobre el segundo, aunque sea de su familia', async () => {
    expect((await post({ baby_id: secondA, event_type: 'sound_alert' }, pinnedA)).status).toBe(403)
  })
})

describe('/api/ingest — validación del payload', () => {
  it('un body que no es JSON responde 400, no 500', async () => {
    expect((await raw('esto no es json', familyA)).status).toBe(400)
  })

  it('un baby_id que no es uuid responde 400', async () => {
    expect((await post({ baby_id: 'la-bebe', event_type: 'sound_alert' }, familyA)).status).toBe(
      400,
    )
  })

  it('un event_type fuera de la lista blanca responde 400', async () => {
    expect((await post({ baby_id: a.babyId, event_type: 'video_clip' }, familyA)).status).toBe(400)
  })

  it('un event_type ausente no se guarda como "unknown"', async () => {
    expect((await post({ baby_id: a.babyId }, familyA)).status).toBe(400)
  })

  it('un occurred_at absurdo responde 400', async () => {
    const res = await post(
      { baby_id: a.babyId, event_type: 'sound_alert', occurred_at: '1899-01-01T00:00:00Z' },
      familyA,
    )
    expect(res.status).toBe(400)
  })

  it('un kind desconocido responde 400', async () => {
    expect((await post({ baby_id: a.babyId, kind: 'sleep_sideways' }, familyA)).status).toBe(400)
  })

  it('un meta gigante responde 400', async () => {
    const res = await post(
      { baby_id: a.babyId, event_type: 'sound_alert', meta: { blob: 'x'.repeat(4000) } },
      familyA,
    )
    expect(res.status).toBe(400)
  })
})

describe('/api/ingest — techo de intentos', () => {
  it('el intento 21 dentro del minuto responde 429', async () => {
    let last = 0
    for (let i = 0; i < 21; i += 1) {
      last = (await post({ event_type: 'sound_alert' }, 'amd_' + 'y'.repeat(43))).status
    }
    expect(last).toBe(429)
  })
})
```

Nota sobre el sueño: el `occurred_at` del test viejo era `2026-01-15`, que hoy
`isSaneInstant` todavía acepta (ventana de 365 días) pero deja de aceptar en
enero 2027. Se mueve a `2026-09-20` para que el test no caduque; **no** se
toca `isSaneInstant`.

`tests/integration/quick-nurse.test.ts` completo:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  adminClient,
  exposeEnvToRouteHandlers,
  seedDeviceToken,
  seedTwoFamilies,
  type SeededFamily,
} from '../helpers/supabase'
import { resetDeviceRateLimit } from '@/lib/deviceAuth'

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>
let pinnedB: string
let familyA: string
let ingestOnlyA: string

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  ;({ a, b, cleanup } = await seedTwoFamilies('quicknurse'))
  pinnedB = (await seedDeviceToken({ familyId: b.familyId, babyId: b.babyId, scopes: ['quick_nurse'] }))
    .token
  familyA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['quick_nurse'] })).token
  ingestOnlyA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['ingest'] })).token
})
afterAll(async () => {
  await cleanup()
})

beforeEach(() => {
  resetDeviceRateLimit()
})

async function post(body: unknown, token: string | null) {
  const { POST } = await import('@/app/api/quick/nurse/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return POST(
    new NextRequest(
      new Request('http://localhost/api/quick/nurse', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
    ),
  )
}

async function sessionsOf(babyId: string) {
  const { data } = await adminClient()
    .from('nursing_sessions')
    .select('id, ended_at')
    .eq('baby_id', babyId)
  return data ?? []
}

describe('/api/quick/nurse — autenticación', () => {
  it('rechaza sin token', async () => {
    expect((await post({ side: 'left' }, null)).status).toBe(401)
  })

  it('rechaza un token que no existe', async () => {
    expect((await post({ side: 'left' }, 'amd_' + 'z'.repeat(43))).status).toBe(401)
  })

  it('rechaza un token sin el scope quick_nurse', async () => {
    expect((await post({ side: 'left' }, ingestOnlyA)).status).toBe(403)
  })

  it('rechaza un side inválido', async () => {
    expect((await post({ side: 'arriba' }, pinnedB)).status).toBe(400)
  })
})

/**
 * HALLAZGO C1, CERRADO. Antes: el bebé más antiguo de toda la base, después un
 * parche con QUICK_TOGGLE_BABY_ID. Ahora el bebé sale del token.
 */
describe('/api/quick/nurse — a qué bebé le escribe', () => {
  it('un token clavado a B escribe en B y la familia A no se entera', async () => {
    const res = await post({ side: 'left' }, pinnedB)
    expect(res.status).toBe(200)
    expect((await res.json()).action).toBe('started')
    expect(await sessionsOf(a.babyId)).toEqual([])
    expect((await sessionsOf(b.babyId)).filter((s) => s.ended_at === null)).toHaveLength(1)
    await post({ side: 'left' }, pinnedB) // cerrar
  })

  it('un token de familia con un solo bebé escribe en ese bebé', async () => {
    expect((await post({ side: 'right' }, familyA)).status).toBe(200)
    expect(await sessionsOf(a.babyId)).toHaveLength(1)
    await post({ side: 'right' }, familyA) // cerrar
  })

  it('un token de A no puede apuntar al bebé de B con baby_id', async () => {
    const before = (await sessionsOf(b.babyId)).length
    expect((await post({ side: 'left', baby_id: b.babyId }, familyA)).status).toBe(403)
    expect(await sessionsOf(b.babyId)).toHaveLength(before)
  })

  it('el toggle sigue el ciclo start -> switch -> end', async () => {
    expect((await (await post({ side: 'left' }, pinnedB)).json()).action).toBe('started')
    expect((await (await post({ side: 'right' }, pinnedB)).json()).action).toBe('switched')
    expect((await (await post({ side: 'right' }, pinnedB)).json()).action).toBe('ended')
    expect((await sessionsOf(b.babyId)).every((s) => s.ended_at !== null)).toBe(true)
  })

  it('con dos bebés en la familia y un token de familia, falla cerrado (409)', async () => {
    const { error } = await adminClient()
      .from('babies')
      .insert({ family_id: a.familyId, name: 'Bebe a2', birth_date: '2026-09-01' })
    expect(error).toBeNull()
    const before = (await sessionsOf(a.babyId)).length
    const res = await post({ side: 'left' }, familyA)
    expect(res.status).toBe(409)
    expect(await sessionsOf(a.babyId)).toHaveLength(before)
  })
})
```

Run: `pnpm test:integration`
Expected: FAIL — los endpoints todavía leen `x-device-secret` (401 donde se
espera 200/403/409).

- [ ] **Step 2: `lib/deviceAuth.ts`** — reemplazar el bloque de encabezado,
`constantTimeEquals`, `DeviceAuthResult` y `checkDeviceSecret` por lo de abajo.
`WINDOW_MS`, `MAX_ATTEMPTS`, `attempts`, `resetDeviceRateLimit`, `readJson`,
`UUID`, `isUuid`, `isSaneInstant` quedan como están.

```ts
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hashDeviceToken,
  looksLikeDeviceToken,
  readBearer,
  type DeviceScope,
} from '@/lib/deviceTokens'

/**
 * Autenticación y autorización de los dos endpoints de dispositivo
 * (`/api/ingest` y `/api/quick/nurse`). SOLO SERVIDOR: recibe el cliente
 * service_role del route handler.
 *
 * Quién entra: un token de `device_tokens` (0007), buscado por su hash, no
 * revocado, con el scope del endpoint. A qué bebé escribe: el que resuelva
 * resolveBabyForDevice(), que nunca sale de la familia del token. Eso es lo que
 * cierra C1 y C2 (docs/auditorias/2026-09-20-auditoria-inicial.md).
 *
 * Por qué ya no hay comparación en tiempo constante: no se compara un secreto,
 * se busca un hash por índice. Lo que un atacante podría medir es el tiempo de
 * buscar el sha-256 de SU intento, que no le dice nada del token real.
 *
 * Lo que sigue sin resolver: el techo de intentos vive en la memoria de este
 * proceso (varias instancias = varios contadores), y no hay idempotencia.
 * Ver proposals/device-tokens-and-idempotency.md.
 */

export type DeviceIdentity = {
  tokenId: string
  familyId: string
  babyId: string | null
  scopes: DeviceScope[]
}

export type DeviceFailure = {
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500
  error: string
}

export function isDeviceFailure(value: object): value is DeviceFailure {
  return 'error' in value
}

export function deviceFailureResponse(f: DeviceFailure): NextResponse {
  return NextResponse.json({ error: f.error }, { status: f.status })
}

function allowAttempt(req: Request): boolean {
  const key = req.headers.get('x-forwarded-for') ?? 'local'
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  entry.count += 1
  return entry.count <= MAX_ATTEMPTS
}

export async function authenticateDevice(
  req: Request,
  supabase: SupabaseClient,
  scope: DeviceScope,
): Promise<DeviceIdentity | DeviceFailure> {
  // El techo va ANTES de la base: la fuerza bruta no llega ni a la query.
  if (!allowAttempt(req)) return { status: 429, error: 'too many requests' }

  const token = readBearer(req)
  if (!looksLikeDeviceToken(token)) return { status: 401, error: 'unauthorized' }

  const { data, error } = await supabase
    .from('device_tokens')
    .select('id, family_id, baby_id, scopes')
    .eq('token_hash', hashDeviceToken(token))
    .is('revoked_at', null)
    .maybeSingle()
  if (error) return { status: 500, error: error.message }
  if (!data) return { status: 401, error: 'unauthorized' }
  if (!data.scopes.includes(scope)) {
    return { status: 403, error: `this token does not have the ${scope} scope` }
  }

  // Best effort: que un fallo al anotar el uso no tumbe el evento.
  await supabase
    .from('device_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)

  return { tokenId: data.id, familyId: data.family_id, babyId: data.baby_id, scopes: data.scopes }
}

/**
 * El bebé sobre el que un dispositivo puede escribir. Nunca sale de la familia
 * del token; con un token clavado, nunca sale de ese bebé. Cuando no alcanza
 * la información para decidir, falla cerrado en vez de adivinar.
 */
export async function resolveBabyForDevice(
  supabase: SupabaseClient,
  identity: DeviceIdentity,
  requested: unknown,
): Promise<{ babyId: string } | DeviceFailure> {
  if (requested !== undefined) {
    if (!isUuid(requested)) return { status: 400, error: 'baby_id must be a uuid' }
    if (identity.babyId !== null) {
      return requested === identity.babyId
        ? { babyId: requested }
        : { status: 403, error: 'this token is pinned to another baby' }
    }
    const { data, error } = await supabase
      .from('babies')
      .select('id')
      .eq('id', requested)
      .eq('family_id', identity.familyId)
      .maybeSingle()
    if (error) return { status: 500, error: error.message }
    return data ? { babyId: requested } : { status: 403, error: "baby_id is not in this token's family" }
  }

  if (identity.babyId !== null) return { babyId: identity.babyId }

  // limit(2): alcanza para saber si hay ambigüedad.
  const { data, error } = await supabase
    .from('babies')
    .select('id')
    .eq('family_id', identity.familyId)
    .order('created_at', { ascending: true })
    .limit(2)
  if (error) return { status: 500, error: error.message }
  if (!data || data.length === 0) return { status: 404, error: 'no baby set up in this family yet' }
  if (data.length > 1) {
    return {
      status: 409,
      error: 'this family has more than one baby — send baby_id, or pin the token to one baby',
    }
  }
  return { babyId: data[0].id }
}
```

(`isUuid` se declara más abajo en el mismo archivo con `export function`, que
se eleva: el orden no importa. Se deja el `import { timingSafeEqual }` afuera.)

- [ ] **Step 3: `/api/ingest`** — reemplazar el comentario de cabecera (el
bloque "This is the ONLY door…" + el ⚠️ C2) por:

```ts
// La única puerta por la que la casa (NUC / Home Assistant) le habla a
// Supabase. Se autentica con un token de dispositivo propio (device_tokens,
// 0007), nunca con un login de usuario ni con la service_role en el dispositivo.
// Crear uno: `pnpm device-token create --family <uuid> --label ... --scope ingest`.
//
// Expected request:
//   POST /api/ingest
//   Header: Authorization: Bearer <token de dispositivo>
//   Body: { baby_id?, event_type, occurred_at?, meta? }
//     OR:  { baby_id?, kind: 'sleep_start' | 'sleep_end', occurred_at? }
//   baby_id es opcional si el token está clavado a un bebé o la familia tiene
//   uno solo. Nunca puede apuntar fuera de la familia del token (403).
```

y el cuerpo de `POST` hasta antes de `// Sleep session start/end…` por:

```ts
export async function POST(req: NextRequest) {
  const supabase = createAdminClient()
  const identity = await authenticateDevice(req, supabase, 'ingest')
  if (isDeviceFailure(identity)) return deviceFailureResponse(identity)

  const body = await readJson<Record<string, unknown>>(req)
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 })

  const { baby_id, event_type, occurred_at, meta, kind } = body

  if (occurred_at !== undefined && !isSaneInstant(occurred_at)) {
    return NextResponse.json({ error: 'occurred_at out of range' }, { status: 400 })
  }
  if (kind !== undefined && kind !== 'sleep_start' && kind !== 'sleep_end') {
    return NextResponse.json({ error: 'unknown kind' }, { status: 400 })
  }
  // Antes, un evento sin tipo se guardaba igual como 'unknown'. Basura
  // silenciosa en la tabla que existe justamente para que no entre media.
  if (kind === undefined && !EVENT_TYPES.includes(event_type as (typeof EVENT_TYPES)[number])) {
    return NextResponse.json({ error: 'unknown event_type' }, { status: 400 })
  }
  if (meta !== undefined && meta !== null && JSON.stringify(meta).length > MAX_META_BYTES) {
    return NextResponse.json({ error: 'meta too large' }, { status: 400 })
  }

  // Validar el payload antes de tocar babies: la basura no genera queries.
  const target = await resolveBabyForDevice(supabase, identity, baby_id)
  if (isDeviceFailure(target)) return deviceFailureResponse(target)
  const babyId = target.babyId
```

y en el resto del handler, cada `baby_id` (insert de `sleep_sessions`,
`.eq('baby_id', …)` del `sleep_end`, insert de `monitor_events`) pasa a
`baby_id: babyId` / `.eq('baby_id', babyId)`. Import:
`import { authenticateDevice, deviceFailureResponse, isDeviceFailure, isSaneInstant, readJson, resolveBabyForDevice } from '@/lib/deviceAuth'`
(`isUuid` ya no se importa acá). El `as (typeof EVENT_TYPES)[number]` es el que
ya existe, no uno nuevo.

- [ ] **Step 4: `/api/quick/nurse`** — borrar `resolveBabyId` entero y su
JSDoc; cabecera:

```ts
// La puerta que usa un Shortcut de iOS para alternar la lactancia sin login:
// "L" o "R" arranca, corta o cambia de lado, igual que los botones del
// dashboard. Se autentica con un token de dispositivo con scope quick_nurse
// (device_tokens, 0007). Lo normal es clavarlo al bebé:
// `pnpm device-token create --family <uuid> --baby <uuid> --label ... --scope quick_nurse`.
//
// Expected request:
//   POST /api/quick/nurse
//   Header: Authorization: Bearer <token de dispositivo>
//   Body: { side: 'left' | 'right', baby_id? }
//
// Response body always has a `message` string meant to be read back
// via the Shortcut's "Show Notification" / "Show Result" step, e.g.
// "Nursing (left) started — 6:42 PM".
```

y el principio de `POST`:

```ts
export async function POST(req: NextRequest) {
  const supabase = createAdminClient()
  const identity = await authenticateDevice(req, supabase, 'quick_nurse')
  if (isDeviceFailure(identity)) return deviceFailureResponse(identity)

  const body = await readJson<{ side?: unknown; baby_id?: unknown }>(req)
  const side = body?.side
  if (side !== 'left' && side !== 'right') {
    return NextResponse.json({ error: "side must be 'left' or 'right'" }, { status: 400 })
  }

  const target = await resolveBabyForDevice(supabase, identity, body?.baby_id)
  if (isDeviceFailure(target)) return deviceFailureResponse(target)
  const baby = { id: target.babyId }
```

El resto (active / start / stop / switch) queda igual. Imports: se van
`SupabaseClient`, `checkDeviceSecret`, `isUuid`; entran `authenticateDevice`,
`deviceFailureResponse`, `isDeviceFailure`, `resolveBabyForDevice`.

- [ ] **Step 5: Correr — pasa**

Run: `pnpm test:integration`
Expected: PASS. Y grep de control:
`grep -rn "checkDeviceSecret\|NUC_DEVICE_SECRET\|QUICK_TOGGLE" app lib tests` → vacío.

- [ ] **Step 6: Prueba real, de punta a punta, contra el stack local**

```bash
pnpm dev -H 127.0.0.1 &                       # -H: que next dev tampoco escuche en 0.0.0.0 (P-5)
pnpm device-token families                    # tomar un family_id / baby_id de prueba
TOKEN=$(pnpm -s device-token create --family <fam> --baby <baby> --label smoke --scope ingest --scope quick_nurse | awk '/^token:/{print $2}')
curl -s -X POST http://127.0.0.1:3000/api/ingest -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"event_type":"sound_alert"}'           # {"ok":true}
curl -s -X POST http://127.0.0.1:3000/api/quick/nurse -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"side":"left"}'                        # started
curl -s -X POST http://127.0.0.1:3000/api/quick/nurse -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"side":"left"}'                        # ended
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/ingest \
  -H 'x-device-secret: lo-que-sea' -d '{}'                                        # 401
pnpm device-token revoke --id <id>                                               # y el mismo curl → 401
kill %1
```

Salida real al output. Datos de la prueba: se retractan/borran al terminar.

- [ ] **Step 7: Env y docs**

`.env.local.example`: se borran los bloques de `NUC_DEVICE_SECRET`,
`QUICK_TOGGLE_SECRET` y `QUICK_TOGGLE_BABY_ID`, y se agrega:

```bash
# Los dispositivos (NUC, Shortcut de iOS) ya no usan secretos compartidos acá:
# cada uno tiene su token en la tabla device_tokens. Crearlos con
#   pnpm device-token create --family <uuid> [--baby <uuid>] --label <texto> --scope ingest|quick_nurse
```

`.env.local` (decisión de Emilio, P-7): borrar las líneas `NUC_DEVICE_SECRET=`,
`QUICK_TOGGLE_SECRET=`, `QUICK_TOGGLE_BABY_ID=` y sus comentarios. Solo esas;
el resto del archivo queda igual. `chmod 600` se mantiene. Verificar con
`sed -E 's/=.*/=<redacted>/' .env.local` (nunca imprimir valores).

Barrido: `grep -rn 'NUC_DEVICE_SECRET\|QUICK_TOGGLE\|x-device-secret\|checkDeviceSecret' --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git . | grep -v '^./docs/auditorias/\|^./docs/superpowers/plans/'`
y reescribir cada hit:

- `docs/seguridad-operacional.md` §5 → "Tokens de dispositivo": qué son, cómo se
  crean/listan/revocan, rotar = crear uno nuevo + revocar el viejo, y la lista de
  lo que **sigue** abierto (rate limit en memoria, idempotencia). §4 "dónde
  vive hoy la service_role" sigue igual (pregunta abierta 1, no se toca). §8:
  se van las líneas de `NUC_DEVICE_SECRET`/`QUICK_TOGGLE_*`; entra "crear los
  tokens de los dispositivos reales con `pnpm device-token` contra la base de
  producción".
- `CLAUDE.md` §6: "Tokens por dispositivo" pasa de *no construido* a
  *construido*; queda *no construido* "Idempotencia en los endpoints de
  dispositivo ⇒ `proposals/device-tokens-and-idempotency.md`". §7: pregunta 3
  **cerrada** (21 sep 2026, el bebé sale del token); pregunta 4 queda solo con
  lo que sigue abierto (contador en memoria, sin idempotencia).
- `PROJECT.md`: sección `/api/ingest` (ya no "shared device secret"); "What's
  NOT built" (se va tokens, queda idempotencia); Security posture ("Devices
  authenticate with their own hashed per-device token… **Implemented in 0007**");
  "What it left open" (C1 y C2 cerrados).
- `proposals/device-tokens-and-idempotency.md`: encabezado "§1-§3 y §5
  **implementados** en `0007` (21 sep 2026), con dos correcciones: FK compuesta
  en lugar del CHECK (C-2) y sin acceso de `authenticated` (C-3). Lo que sigue
  propuesto: §4 idempotencia y §6." Se borran §2-§3 y §5 del cuerpo (quedan en
  git) y se deja §4 y §6.

- [ ] **Step 8: Gate + commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm format:check && pnpm build && pnpm test:all
git add -A && git commit -m "Make the device endpoints write only to the family their token belongs to

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Corregir y retractar una medición de crecimiento

**Files:**
- Create: `supabase/migrations/0008_growth_edit_and_void.sql`,
  `components/GrowthFields.tsx`
- Modify: `lib/format.ts:147-160`, `lib/db.ts:490-519`, `app/growth/page.tsx`
  (reescritura), `lib/types.ts` (sin cambios si `GrowthMeasurement` no expone
  `voided_at` — no lo necesita), `supabase/schema.sql`, `CLAUDE.md` §6,
  `PROJECT.md` (NOT built), `proposals/growth-edit-and-void.md` (**se borra**)
- Test: `tests/unit/format.test.ts` (extendido), `tests/integration/rls.test.ts`
  (el test del hueco se da vuelta)

**Interfaces:**
- Produces (`lib/format.ts`):
  - `type GrowthInput = { imperial: boolean; lb: string; oz: string; inches: string; kg: string; cm: string }`
  - `emptyGrowthInput(imperial: boolean): GrowthInput`
  - `kgToLbOzParts(kg: number): { lb: number; oz: number }` (y `kgToLbOz` pasa a usarla)
  - `type GrowthMetric = { weightKg: number | null; heightCm: number | null }`
  - `growthInputToMetric(input: GrowthInput): GrowthMetric | { error: string }`
  - `growthInputFromMetric(weightKg: number | null, heightCm: number | null, imperial: boolean): GrowthInput`
  - `resolveGrowthEdit(base: GrowthInput, edited: GrowthInput, original: GrowthMetric): GrowthMetric | { error: string }`
- Produces (`lib/db.ts`): `updateGrowth(id, patch)`, `voidGrowth(id)`
- Produces: `GrowthFields({ value, onChange })`, `UnitToggle({ value, onChange })`

- [ ] **Step 1: Test RLS dado vuelta (falla)** — en `rls.test.ts`, borrar el `it`
"growth_measurements no tiene policy de UPDATE…" (queda el de `families` en ese
describe) y agregar:

```ts
/** 0008: una medición mal cargada se corrige o se retracta — solo por su familia. */
describe('growth_measurements se corrige y se retracta', () => {
  let id: string

  beforeAll(async () => {
    const { data, error } = await adminClient()
      .from('growth_measurements')
      .insert({ baby_id: a.babyId, measured_at: '2026-09-15', weight_kg: 3.5 })
      .select('id')
      .single()
    if (error) throw error
    id = data.id
  })

  async function weight() {
    const { data } = await adminClient()
      .from('growth_measurements')
      .select('weight_kg')
      .eq('id', id)
      .single()
    return Number(data!.weight_kg)
  }

  it('el dueño corrige su medición', async () => {
    const { data, error } = await a.client
      .from('growth_measurements')
      .update({ weight_kg: 4.5 })
      .eq('id', id)
      .select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(await weight()).toBe(4.5)
  })

  it('otra familia no la puede corregir', async () => {
    const { data } = await b.client
      .from('growth_measurements')
      .update({ weight_kg: 9.9 })
      .eq('id', id)
      .select('id')
    expect(data ?? []).toEqual([])
    expect(await weight()).toBe(4.5)
  })

  it('no se puede mudar la medición al bebé de otra familia', async () => {
    const { error } = await a.client
      .from('growth_measurements')
      .update({ baby_id: b.babyId })
      .eq('id', id)
    expect(error).not.toBeNull()
  })

  it('otra familia no la puede retractar', async () => {
    const { data } = await b.client
      .from('growth_measurements')
      .update({ voided_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
    expect(data ?? []).toEqual([])
  })

  it('retractada, desaparece de la lectura de la app pero sigue en la base', async () => {
    const { error } = await a.client
      .from('growth_measurements')
      .update({ voided_at: new Date().toISOString() })
      .eq('id', id)
    expect(error).toBeNull()

    // La misma lectura que hace listGrowth() (lib/db.ts).
    const { data: visibles } = await a.client
      .from('growth_measurements')
      .select('id')
      .eq('baby_id', a.babyId)
      .is('voided_at', null)
    expect(visibles!.map((r) => r.id)).not.toContain(id)

    const { data: enLaBase } = await adminClient()
      .from('growth_measurements')
      .select('id')
      .eq('id', id)
    expect(enLaBase).toHaveLength(1)
  })
})
```

Run: `pnpm test:integration`
Expected: FAIL — "el dueño corrige" da `data: []` (no hay policy) y los de
`voided_at` dan `column "voided_at" does not exist`.

Lo que **no** cubre un test automático: que `listGrowth()` en sí filtre. Es
`'use client'` y usa `createBrowserClient`, que no corre en Node. Lo cubre la
revisión del diff (Step 6) y la prueba manual (Step 9). Se dice así en el
reporte.

- [ ] **Step 2: Migración** — `supabase/migrations/0008_growth_edit_and_void.sql`

```sql
-- Una medición de crecimiento mal cargada ya no es permanente (hallazgo M3,
-- docs/auditorias/2026-09-20-auditoria-inicial.md). Lo que 0006 hizo para las
-- otras cinco tablas, y dejó afuera a esta.
--
-- Numerada en este repo por pedido explícito de Emilio: CLAUDE.md §5.2.

-- Retractar: borrado lógico, nunca DELETE (CLAUDE.md §5.4).
alter table growth_measurements add column if not exists voided_at timestamptz;

-- Corregir. El WITH CHECK explícito impide mudar la fila a un bebé ajeno
-- (Postgres ya usaría el USING, pero así no depende de acordarse).
create policy "update growth_measurements" on growth_measurements
  for update
  using (is_baby_family_member(baby_id))
  with check (is_baby_family_member(baby_id));

-- Sin GRANT nuevo: 0005 ya otorgó update sobre todas las tablas de public a
-- authenticated. Verificado por el test de integración, no supuesto.
```

`pnpm db:up` → `aplicando 0008_growth_edit_and_void`.

- [ ] **Step 3: Correr — pasa**

Run: `pnpm test:integration` → PASS.

- [ ] **Step 4: Unit tests de conversión (fallan)** — agregar a
`tests/unit/format.test.ts` (import de los nuevos nombres):

```ts
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
    expect(growthInputToMetric(imperial({ oz: '8' }))).toEqual({ weightKg: 0.227, heightCm: null })
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
    expect(resolveGrowthEdit(base, { ...base, lb: '8', oz: '0' }, { weightKg: 3.5, heightCm: 50 }))
      .toEqual({ weightKg: 3.629, heightCm: 50 })
  })

  it('pasar a kg/cm sin tocar nada tampoco cambia nada', () => {
    const base = growthInputFromMetric(3.5, 50, true)
    expect(resolveGrowthEdit(base, { ...base, imperial: false }, { weightKg: 3.5, heightCm: 50 }))
      .toEqual({ weightKg: 3.5, heightCm: 50 })
  })

  it('borrar la talla la deja en null', () => {
    const base = growthInputFromMetric(3.5, 50, false)
    expect(resolveGrowthEdit(base, { ...base, cm: '' }, { weightKg: 3.5, heightCm: 50 })).toEqual({
      weightKg: 3.5,
      heightCm: null,
    })
  })
})
```

Run: `pnpm test` → FAIL (`growthInputToMetric is not a function` / imports).

- [ ] **Step 5: `lib/format.ts`** — reemplazar `kgToLbOz` (l.147-156) y
agregar después de `cmToIn`:

```ts
export function kgToLbOzParts(kg: number): { lb: number; oz: number } {
  const total = kg * LB_PER_KG
  let lb = Math.floor(total)
  let oz = Math.round((total - lb) * 16)
  if (oz === 16) {
    lb += 1
    oz = 0
  }
  return { lb, oz }
}

export function kgToLbOz(kg: number): string {
  const { lb, oz } = kgToLbOzParts(kg)
  return `${lb} lb ${oz} oz`
}
```

```ts
/** What the growth form holds: the text as typed, in whichever units are showing. */
export type GrowthInput = {
  imperial: boolean
  lb: string
  oz: string
  inches: string
  kg: string
  cm: string
}

export type GrowthMetric = { weightKg: number | null; heightCm: number | null }

export function emptyGrowthInput(imperial: boolean): GrowthInput {
  return { imperial, lb: '', oz: '', inches: '', kg: '', cm: '' }
}

function growthNumber(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : NaN
}

/** Form → what the database stores (kg to the gram, cm to the millimetre). */
export function growthInputToMetric(input: GrowthInput): GrowthMetric | { error: string } {
  let weightKg: number | null = null
  let heightCm: number | null = null

  if (input.imperial) {
    const lb = growthNumber(input.lb)
    const oz = growthNumber(input.oz)
    const inches = growthNumber(input.inches)
    if ([lb, oz, inches].some((v) => v !== null && Number.isNaN(v))) {
      return { error: 'Weight and height have to be numbers.' }
    }
    if (lb !== null || oz !== null) weightKg = lbOzToKg(lb ?? 0, oz ?? 0)
    if (inches !== null) heightCm = inches * 2.54
  } else {
    const kg = growthNumber(input.kg)
    const cm = growthNumber(input.cm)
    if ([kg, cm].some((v) => v !== null && Number.isNaN(v))) {
      return { error: 'Weight and height have to be numbers.' }
    }
    weightKg = kg
    heightCm = cm
  }

  if (weightKg === null && heightCm === null) return { error: 'Enter a weight, a height, or both.' }
  return {
    weightKg: weightKg === null ? null : Number(weightKg.toFixed(3)),
    heightCm: heightCm === null ? null : Number(heightCm.toFixed(1)),
  }
}

/** A stored measurement back into the form, both unit systems filled in. */
export function growthInputFromMetric(
  weightKg: number | null,
  heightCm: number | null,
  imperial: boolean,
): GrowthInput {
  const parts = weightKg === null ? null : kgToLbOzParts(weightKg)
  return {
    imperial,
    lb: parts ? String(parts.lb) : '',
    oz: parts ? String(parts.oz) : '',
    inches: heightCm === null ? '' : (heightCm / 2.54).toFixed(1),
    kg: weightKg === null ? '' : String(weightKg),
    cm: heightCm === null ? '' : String(heightCm),
  }
}

/**
 * Saving an edit. A field the parent didn't touch keeps its stored value
 * EXACTLY: lb/oz are rounded to the ounce, so re-deriving an untouched weight
 * from them would quietly move the growth curve (3.5 kg → 3.487 kg).
 */
export function resolveGrowthEdit(
  base: GrowthInput,
  edited: GrowthInput,
  original: GrowthMetric,
): GrowthMetric | { error: string } {
  const computed = growthInputToMetric(edited)
  if ('error' in computed) return computed
  const sameWeight = edited.imperial
    ? edited.lb === base.lb && edited.oz === base.oz
    : edited.kg === base.kg
  const sameHeight = edited.imperial ? edited.inches === base.inches : edited.cm === base.cm
  return {
    weightKg: sameWeight ? original.weightKg : computed.weightKg,
    heightCm: sameHeight ? original.heightCm : computed.heightCm,
  }
}
```

Run: `pnpm test:tz` → PASS bajo las cuatro TZ.

- [ ] **Step 6: `lib/db.ts`** — sección growth:

```ts
export async function listGrowth(babyId: string): Promise<Result<GrowthMeasurement[]>> {
  const { data: rows, error } = await data()
    .from('growth_measurements')
    .select('id, measured_at, weight_kg, height_cm, notes')
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .order('measured_at', { ascending: false })
  if (error) return fail([] as GrowthMeasurement[], error)
  return ok((rows ?? []) as GrowthMeasurement[])
}
```

y después de `addGrowth`:

```ts
/** Correct a measurement typed wrong — the pediatrician's number, not ours. */
export function updateGrowth(
  id: string,
  patch: Partial<{
    measured_at: string
    weight_kg: number | null
    height_cm: number | null
    notes: string | null
  }>,
): Promise<Result<null>> {
  return write('Edit measurement', { kind: 'update', table: 'growth_measurements', id, patch })
}

/** Soft-delete: the entry leaves the growth curve, the row stays. */
export function voidGrowth(id: string): Promise<Result<null>> {
  return write('Delete measurement', {
    kind: 'update',
    table: 'growth_measurements',
    id,
    patch: { voided_at: new Date().toISOString() },
  })
}
```

(Los `as GrowthMeasurement[]` ya existían; no son nuevos.)

- [ ] **Step 7: `components/GrowthFields.tsx`**

```tsx
'use client'

import type { GrowthInput } from '@/lib/format'

type Field = 'lb' | 'oz' | 'inches' | 'kg' | 'cm'

/**
 * The weight/height inputs, in whichever units are showing. Shared by "new
 * measurement" and "edit measurement" on /growth so the two can't drift.
 */
export function GrowthFields({
  value,
  onChange,
}: {
  value: GrowthInput
  onChange: (next: GrowthInput) => void
}) {
  const input = (field: Field, placeholder: string, label: string) => (
    <input
      className="input"
      value={value[field]}
      onChange={(e) => onChange({ ...value, [field]: e.target.value })}
      inputMode="decimal"
      placeholder={placeholder}
      aria-label={label}
    />
  )

  return value.imperial ? (
    <div className="row">
      {input('lb', 'lb', 'Weight, pounds')}
      {input('oz', 'oz', 'Weight, ounces')}
      {input('inches', 'in', 'Height, inches')}
    </div>
  ) : (
    <div className="row">
      {input('kg', 'kg', 'Weight, kilograms')}
      {input('cm', 'cm', 'Height, centimetres')}
    </div>
  )
}

export function UnitToggle({
  value,
  onChange,
}: {
  value: GrowthInput
  onChange: (next: GrowthInput) => void
}) {
  return (
    <button
      type="button"
      className="linkish"
      onClick={() => onChange({ ...value, imperial: !value.imperial })}
    >
      {value.imperial ? 'lb / in' : 'kg / cm'}
    </button>
  )
}
```

- [ ] **Step 8: `app/growth/page.tsx`** — reescritura completa:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import { GrowthFields, UnitToggle } from '@/components/GrowthFields'
import { addGrowth, listGrowth, updateGrowth, voidGrowth } from '@/lib/db'
import type { GrowthMeasurement } from '@/lib/types'
import {
  cmToIn,
  emptyGrowthInput,
  growthInputFromMetric,
  growthInputToMetric,
  householdToday,
  kgToLbOz,
  measuredOn,
  resolveGrowthEdit,
  type GrowthInput,
} from '@/lib/format'

const QUEUED = 'Saved on this device — will sync when you’re back online'

export default function GrowthPage() {
  const { baby, userId, loading } = useBaby()

  const [rows, setRows] = useState<GrowthMeasurement[]>([])
  // The pediatrician's office says lb/oz and inches out loud; the
  // database stores metric. Default to what gets spoken.
  const [input, setInput] = useState<GrowthInput>(() => emptyGrowthInput(true))
  const [date, setDate] = useState(() => householdToday())
  const [notes, setNotes] = useState('')

  // Editing one row at a time. `editBase` is the form as it was prefilled, so
  // an untouched weight or height keeps its exact stored value.
  const [editing, setEditing] = useState<GrowthMeasurement | null>(null)
  const [editBase, setEditBase] = useState<GrowthInput>(() => emptyGrowthInput(true))
  const [editInput, setEditInput] = useState<GrowthInput>(() => emptyGrowthInput(true))
  const [editDate, setEditDate] = useState('')
  const [editNotes, setEditNotes] = useState('')

  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (babyId: string) => {
    const { data, error } = await listGrowth(babyId)
    if (error) setErr(`Couldn't load measurements — ${error}`)
    setRows(data)
  }, [])

  useEffect(() => {
    if (baby) refresh(baby.id)
  }, [baby, refresh])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || busy) return
    setErr(null)

    const metric = growthInputToMetric(input)
    if ('error' in metric) {
      setErr(metric.error)
      return
    }

    setBusy(true)
    const { error, queued } = await addGrowth(baby.id, userId, {
      measured_at: date,
      weight_kg: metric.weightKg,
      height_cm: metric.heightCm,
      notes: notes.trim() || null,
    })
    setBusy(false)

    if (error) {
      setErr(`Couldn't save — ${error}`)
      return
    }
    setSaved(queued ? QUEUED : 'Measurement saved')
    setInput(emptyGrowthInput(input.imperial))
    setNotes('')
    refresh(baby.id)
  }

  function startEdit(row: GrowthMeasurement) {
    setErr(null)
    setSaved(null)
    const base = growthInputFromMetric(row.weight_kg, row.height_cm, input.imperial)
    setEditing(row)
    setEditBase(base)
    setEditInput(base)
    setEditDate(row.measured_at)
    setEditNotes(row.notes ?? '')
  }

  async function saveEdit() {
    if (!baby || !editing || busy) return
    setErr(null)

    const metric = resolveGrowthEdit(editBase, editInput, {
      weightKg: editing.weight_kg,
      heightCm: editing.height_cm,
    })
    if ('error' in metric) {
      setErr(metric.error)
      return
    }

    setBusy(true)
    const { error, queued } = await updateGrowth(editing.id, {
      measured_at: editDate,
      weight_kg: metric.weightKg,
      height_cm: metric.heightCm,
      notes: editNotes.trim() || null,
    })
    setBusy(false)

    if (error) {
      setErr(`Couldn't save the change — ${error}`)
      return
    }
    setSaved(queued ? QUEUED : 'Measurement updated')
    setEditing(null)
    refresh(baby.id)
  }

  async function remove(row: GrowthMeasurement) {
    if (!baby || busy) return
    if (
      !window.confirm(
        `Remove the ${measuredOn(row.measured_at)} measurement? It stops counting toward the growth curve.`,
      )
    )
      return

    setBusy(true)
    setErr(null)
    const { error, queued } = await voidGrowth(row.id)
    setBusy(false)

    if (error) {
      setErr(`Couldn't remove — ${error}`)
      return
    }
    setSaved(queued ? QUEUED : 'Measurement removed')
    refresh(baby.id)
  }

  if (loading)
    return (
      <Page>
        <p className="empty">Loading…</p>
      </Page>
    )
  if (!baby)
    return (
      <Page>
        <Nav />
        <NoBaby />
      </Page>
    )

  return (
    <Page>
      <Nav babyId={baby.id} />
      <h1 className="title">Growth</h1>
      <SyncStatus />
      {err && <Banner kind="error">{err}</Banner>}
      {saved && !err && <Banner kind="ok">{saved}</Banner>}

      <Grid>
        <Card>
          <form onSubmit={save}>
            <div className="between">
              <Label>New measurement</Label>
              <UnitToggle value={input} onChange={setInput} />
            </div>

            <div className="stack">
              <input
                className="input"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-label="Date measured"
              />
              <GrowthFields value={input} onChange={setInput} />
              <input
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (optional)"
                aria-label="Notes"
              />
            </div>

            <div className="row-tight">
              <Btn type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save measurement'}
              </Btn>
            </div>
          </form>
        </Card>

        {rows.length === 0 ? (
          <Card>
            <div className="empty">No measurements recorded yet.</div>
          </Card>
        ) : (
          rows.map((row, index) => {
            // Newest first, so the next entry is the previous visit.
            const prev = rows[index + 1]
            const gain =
              prev && row.weight_kg != null && prev.weight_kg != null
                ? row.weight_kg - prev.weight_kg
                : null
            const isEditing = editing?.id === row.id
            return (
              <Card key={row.id}>
                <div className="between">
                  <Label>{measuredOn(row.measured_at)}</Label>
                  {!isEditing && (
                    <span className="feed-actions">
                      <button
                        type="button"
                        className="linkish"
                        disabled={busy}
                        onClick={() => startEdit(row)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="linkish"
                        disabled={busy}
                        onClick={() => remove(row)}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </div>

                {isEditing ? (
                  <div className="edit-panel">
                    <div className="between">
                      <Label>Edit measurement</Label>
                      <UnitToggle value={editInput} onChange={setEditInput} />
                    </div>
                    <div className="stack">
                      <input
                        className="input"
                        type="date"
                        value={editDate}
                        onChange={(e) => setEditDate(e.target.value)}
                        aria-label="Date measured"
                      />
                      <GrowthFields value={editInput} onChange={setEditInput} />
                      <input
                        className="input"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder="Notes (optional)"
                        aria-label="Notes"
                      />
                    </div>
                    <div className="row-tight">
                      <Btn disabled={busy} onClick={saveEdit}>
                        {busy ? 'Saving…' : 'Save changes'}
                      </Btn>
                      <Btn variant="quiet" onClick={() => setEditing(null)}>
                        Cancel
                      </Btn>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="value">
                      {row.weight_kg != null &&
                        `${kgToLbOz(row.weight_kg)} (${row.weight_kg.toFixed(2)} kg)`}
                      {row.weight_kg != null && row.height_cm != null && ' · '}
                      {row.height_cm != null &&
                        `${cmToIn(row.height_cm)} (${row.height_cm.toFixed(1)} cm)`}
                    </div>
                    {gain !== null && (
                      <div className={gain >= 0 ? 'gain-up' : 'gain-down'}>
                        {gain >= 0 ? '+' : '−'}
                        {kgToLbOz(Math.abs(gain))} since last visit
                      </div>
                    )}
                    {row.notes && <div className="meta">{row.notes}</div>}
                  </>
                )}
              </Card>
            )
          })
        )}
      </Grid>
    </Page>
  )
}
```

Honestidad de estado (§5.5): una edición o un borrado **encolados** muestran el
banner "Saved on this device — will sync…", pero la lista sigue mostrando el
valor del servidor hasta que sincronice. Eso ya pasa hoy con el alta de una
medición encolada (la página de crecimiento no usa `mergePending`, a diferencia
de History). No se presenta nada como guardado en el servidor, así que no viola
la regla; incorporar `mergePending` acá queda como mejora posible, **fuera de
alcance**.

- [ ] **Step 9: Prueba manual contra el stack local**

`pnpm dev -H 127.0.0.1`, con un usuario de prueba: alta de 7 lb 11 oz → editar
solo la nota → `pnpm db:psql -c "select weight_kg, notes, voided_at from growth_measurements order by created_at desc limit 1"`
muestra el peso **sin cambiar**; editar peso a 8 lb 0 oz → 3.629; borrar →
`voided_at` no nulo y la fila desaparece de `/growth`. **Si no hay navegador
disponible en el VPS, lo digo y lo dejo como verificación pendiente para
Emilio**, con los pasos exactos; no lo doy por probado.

- [ ] **Step 10: Docs**

- `proposals/growth-edit-and-void.md`: `git rm` (implementado en `0008`; el
  texto queda en git).
- `supabase/schema.sql`: bloque `-- ---------- GROWTH EDIT/VOID (0008) ----------`.
- `CLAUDE.md` §6: "Corregir o retractar una medición" pasa a construido.
- `PROJECT.md` "What's NOT built": se va el bullet de growth; en "What's
  built" `/growth` suma "edit and delete per entry".

- [ ] **Step 11: Gate + commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm format:check && pnpm build && pnpm test:all
git add -A && git commit -m "Let a mistyped growth measurement be corrected or retracted

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Versión e historial de cambios bajo el engranaje — v0.2.0

**Criterio de versión (pedido: decidir MINOR vs PATCH):** **0.1.0 → 0.2.0,
MINOR.** Hay dos migraciones de schema, una capacidad nueva visible (editar y
borrar crecimiento, historial de versiones) y un cambio **incompatible** en la
API de dispositivos (el header `x-device-secret` deja de funcionar). En semver,
mientras la versión es `0.y.z` un cambio incompatible sube MINOR, no MAJOR. No
es PATCH: PATCH queda para arreglos sin schema y sin capacidad nueva.
`1.0.0` se reserva para cuando la app esté desplegada y en uso real en la casa.

**Files:**
- Create: `CHANGELOG.md`, `lib/changelog.ts`, `lib/version.ts`,
  `app/version/page.tsx`, `tests/unit/changelog.test.ts`
- Modify: `package.json` (`"version": "0.2.0"`), `components/ui.tsx` (ítem del
  engranaje), `middleware.ts:13` (`/version` protegido), `CLAUDE.md` (§4.1
  nuevo "Versionado", §6), `PROJECT.md` (What's built)

**Interfaces:**
- Produces:
  - `type Release = { version: string; date: string; summary: string | null; changes: string[] }`
  - `parseChangelog(markdown: string): Release[]` — más nuevo primero, como está escrito
  - `compareVersions(a: string, b: string): number`
  - `APP_VERSION: string`
  - ruta `/version`

- [ ] **Step 1: Test que falla** — `tests/unit/changelog.test.ts`

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareVersions, parseChangelog } from '@/lib/changelog'

const SAMPLE = `# Changelog

Texto de introducción que no es de ninguna versión.

## [0.2.0] - 2026-09-21

Resumen de la versión,
en dos líneas.

- Primer cambio
- Segundo cambio que sigue
  en la línea de abajo

## [0.1.0] - 2026-09-20

- Lo primero
`

describe('parseChangelog', () => {
  it('lee versiones, fechas, resumen y cambios, en orden', () => {
    expect(parseChangelog(SAMPLE)).toEqual([
      {
        version: '0.2.0',
        date: '2026-09-21',
        summary: 'Resumen de la versión, en dos líneas.',
        changes: ['Primer cambio', 'Segundo cambio que sigue en la línea de abajo'],
      },
      { version: '0.1.0', date: '2026-09-20', summary: null, changes: ['Lo primero'] },
    ])
  })

  it('sin versiones, lista vacía', () => {
    expect(parseChangelog('# Changelog\n\nnada todavía\n')).toEqual([])
  })
})

describe('compareVersions', () => {
  it('compara numéricamente, no como texto', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.1.9', '0.2.0')).toBeLessThan(0)
  })
})

/**
 * El guardia contra lo que le pasó a fruco-erp (su changelog canónico se quedó
 * atrás dos versiones, auditoría 2026-08-10 hallazgo 11.1): si alguien sube la
 * versión y no escribe el CHANGELOG, o al revés, esto falla.
 */
describe('CHANGELOG.md real', () => {
  const releases = parseChangelog(readFileSync('CHANGELOG.md', 'utf8'))
  const pkg: { version: string } = JSON.parse(readFileSync('package.json', 'utf8'))

  it('la primera entrada es la versión de package.json', () => {
    expect(releases[0]?.version).toBe(pkg.version)
  })

  it('las versiones bajan estrictamente y las fechas no suben', () => {
    for (let i = 1; i < releases.length; i += 1) {
      expect(compareVersions(releases[i - 1].version, releases[i].version)).toBeGreaterThan(0)
      expect(releases[i - 1].date >= releases[i].date).toBe(true)
    }
  })

  it('cada versión tiene fecha válida y al menos un cambio', () => {
    for (const r of releases) {
      expect(Number.isNaN(Date.parse(`${r.date}T00:00:00Z`))).toBe(false)
      expect(r.changes.length).toBeGreaterThan(0)
    }
  })
})
```

Run: `pnpm test` → FAIL (`@/lib/changelog` no existe).

- [ ] **Step 2: `lib/changelog.ts`**

```ts
/**
 * El historial de versiones que se ve en /version.
 *
 * Fuente de verdad: CHANGELOG.md en la raíz (el historial) y el campo
 * "version" de package.json (la versión actual). tests/unit/changelog.test.ts
 * falla si no coinciden.
 *
 * Formato que se lee, y nada más:
 *   ## [0.2.0] - 2026-09-21      ← encabezado de versión
 *   Un párrafo opcional           ← resumen
 *   - un cambio                   ← cada cambio; las líneas con sangría
 *     que sigue acá                  continúan el anterior
 */

export type Release = {
  version: string
  date: string
  summary: string | null
  changes: string[]
}

const HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/

export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = []
  let current: Release | null = null

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd()
    const heading = line.match(HEADING)
    if (heading) {
      current = { version: heading[1], date: heading[2], summary: null, changes: [] }
      releases.push(current)
      continue
    }
    if (!current || line.trim() === '' || line.startsWith('#')) continue

    if (line.startsWith('- ')) {
      current.changes.push(line.slice(2).trim())
    } else if (line.startsWith('  ') && current.changes.length > 0) {
      current.changes[current.changes.length - 1] += ` ${line.trim()}`
    } else if (current.changes.length === 0) {
      current.summary = current.summary ? `${current.summary} ${line.trim()}` : line.trim()
    }
  }
  return releases
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}
```

- [ ] **Step 3: `CHANGELOG.md` y `package.json`**

`package.json`: `"version": "0.2.0"`.

`CHANGELOG.md` (fecha de 0.2.0 = el día real del commit; el test solo exige
formato y orden):

```markdown
# Changelog

Every version of Amelia, newest first. The current version is the `version`
field in `package.json`; this file is the history. A test fails if the two
disagree. Shown in the app under the settings gear → Version history.

## [0.2.0] - 2026-09-21

Devices get their own keys, growth entries can be fixed, and the development
database stops answering on the internet.

- Each device — the nursery computer, a phone Shortcut — now has its own key,
  tied to one family and revocable on its own. The shared device passwords are
  gone.
- Sleep events and the quick nursing toggle can only land on a baby of the
  family the device belongs to.
- A growth measurement can be edited or deleted from the Growth page. Editing
  the notes no longer nudges the weight by rounding.
- Version history, here, under the settings gear.
- The local development database only listens on this machine.

## [0.1.0] - 2026-09-20

The first version that tracks a baby end to end.

- Nursing, bottle, solids, diapers and sleep from the dashboard, with the next
  feeding and nap predicted.
- Milk pumping, growth, doctor appointments, and a full history with edit and
  delete.
- Installs as an app and keeps working on bad wifi: entries wait on the device
  and sync when it's back, marked "not synced yet" until then.
- Two parents, each with their own login; one family never sees another's data.
```

Run: `pnpm test` → PASS.

- [ ] **Step 4: `lib/version.ts`**

```ts
import pkg from '@/package.json'

/**
 * La versión de la app: el campo "version" de package.json (mismo patrón que
 * fruco-erp, apps/web/src/version.ts). El historial está en CHANGELOG.md.
 */
export const APP_VERSION: string = pkg.version
```

- [ ] **Step 5: `app/version/page.tsx`**

```tsx
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Card, Grid, Label, Nav, Page } from '@/components/ui'
import { parseChangelog } from '@/lib/changelog'
import { measuredOn } from '@/lib/format'
import { APP_VERSION } from '@/lib/version'

// Se arma en el build: CHANGELOG.md no cambia entre deploys.
export const dynamic = 'force-static'

export default function VersionPage() {
  const releases = parseChangelog(readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8'))

  return (
    <Page>
      <Nav />
      <h1 className="title">Version history</h1>
      <Grid>
        <Card spanAll>
          <Label>Current version</Label>
          <div className="value">v{APP_VERSION}</div>
        </Card>
        {releases.map((r) => (
          <Card key={r.version} spanAll>
            <Label>
              v{r.version} · {measuredOn(r.date)}
            </Label>
            {r.summary && <div className="meta">{r.summary}</div>}
            <div className="feed">
              {r.changes.map((change) => (
                <div key={change} className="feed-item">
                  <span className="feed-what">{change}</span>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </Grid>
    </Page>
  )
}
```

Sin clases nuevas: `title`, `value`, `meta`, `feed`, `feed-item`, `feed-what`,
`Card spanAll` ya existen (E-10).

- [ ] **Step 6: Engranaje y middleware**

`components/ui.tsx`: `import { APP_VERSION } from '@/lib/version'`, y en el
menú, **antes** de "Sign out":

```tsx
            <button
              role="menuitem"
              className="nav-menu-item"
              onClick={() => {
                setMenuOpen(false)
                router.push('/version')
              }}
            >
              Version history · v{APP_VERSION}
            </button>
```

`middleware.ts:13`:
`const PROTECTED = ['/dashboard', '/pumping', '/growth', '/appointments', '/history', '/version']`

- [ ] **Step 7: Verificar build y bundle**

```bash
pnpm build                                        # /version aparece como ○ (static)
grep -rl '"devDependencies"' .next/static || echo "package.json no se filtró al browser"
```

Si `package.json` entero aparece en `.next/static` (la lista de dependencias
en el bundle del cliente), `lib/version.ts` pasa a leer
`process.env.APP_VERSION`, inyectado en `next.config.mjs` con
`env: { APP_VERSION: JSON.parse(readFileSync('./package.json', 'utf8')).version }`.
Se reporta cuál de las dos quedó.

Y a mano: `pnpm dev -H 127.0.0.1`; sin sesión, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/version`
→ `307` (al login). Con sesión (navegador): engranaje → "Version history ·
v0.2.0" → la página con 0.2.0 y 0.1.0. **Si no hay navegador, lo digo.**

- [ ] **Step 8: Regla de versionado** — `CLAUDE.md`, nueva §4.1 después de §4:

```markdown
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
```

§6: agregar "historial de versiones en `/version`" a lo construido.

- [ ] **Step 9: Gate + commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm format:check && pnpm build && pnpm test:all
git add -A && git commit -m "Show the app version and its change history under the settings gear

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Cierre — verificación completa y merge

- [ ] **Step 1: Barrido de consistencia**

```bash
grep -rn 'NUC_DEVICE_SECRET\|QUICK_TOGGLE\|x-device-secret\|supabase start\|test-env.sh\|growth-edit-and-void' \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git . \
  | grep -v '^./docs/auditorias/\|^./docs/superpowers/plans/\|^./CHANGELOG.md'
```

Expected: vacío, o solo menciones históricas marcadas como tales ("hasta el 21
sep 2026…"). Cada hit restante se explica en el reporte.

- [ ] **Step 2: Estado de la red, de nuevo, con todo arriba**

`pnpm db:status` + `ss -tln | grep -E ':(5432[0-9]|3000)'` → nada en `0.0.0.0`
de este proyecto.

- [ ] **Step 3: Gate completo + checklist de CLAUDE.md §8**, ítem por ítem, en
el output (incluido "ningún hex/px nuevo": `git diff main --stat -- app/globals.css`
vacío).

- [ ] **Step 4: Merge**

```bash
git switch main
git merge --no-ff batch/tokens-crecimiento-stack-versiones -m "Merge the device tokens, growth editing, local stack and versions batch

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
pnpm test:all
```

Tag y push (decisión de Emilio, P-6):

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin main
git push origin v0.2.0
```

Sin `--force`. Si el push es rechazado (main remoto avanzó), se para y se
reporta; no se rebasea ni se fuerza.

- [ ] **Step 5:** `pnpm db:down` si Emilio no lo va a usar enseguida (ya no es
por seguridad — escucha en 127.0.0.1 — sino por memoria del VPS). Reporte final
a `output.txt`.

---

## Self-review del plan

- **Cobertura de la spec.** (1) C1 → T3 quick-nurse (bebé desde el token, se va
  `QUICK_TOGGLE_BABY_ID`); C2 → T3 ingest (403 fuera de la familia); schema real
  → T2 `0007`; contradicción + renumeración + regla → §1 C-1 y T2 Step 10.
  (2) → T4, migración aparte `0008`. (3) → T1, con la investigación del CLI en
  E-3 y el compose probado en E-4, sirviendo a los tests (29/29 en el spike).
  (4) → T5: fuente de verdad (package.json + CHANGELOG.md), UI (engranaje →
  `/version`), criterio 0.2.0 justificado.
- **Fuera de alcance, a propósito:** idempotencia (§4 de la propuesta — no es
  C1/C2), rate limit distribuido, pantalla de administración de tokens,
  `mergePending` en /growth, Studio local, CSS. Cada uno está en §Preguntas o
  en el reporte, no escondido.
- **Placeholders:** ninguno. Lo que puede fallar tiene fallback escrito y
  obligación de reportarlo (healthcheck de `auth`, `allowImportingTsExtensions`,
  JSON en el bundle, navegador para la prueba manual).
- **Consistencia de nombres:** `seedDeviceToken`, `authenticateDevice`,
  `resolveBabyForDevice`, `isDeviceFailure`, `deviceFailureResponse`,
  `DeviceScope` = `'ingest' | 'quick_nurse'` (igual en TS, en el CHECK de SQL y
  en los tests); `GrowthInput`/`GrowthMetric`/`resolveGrowthEdit` iguales en
  format.ts, tests y página.

---

## Preguntas abiertas — no las resuelvo solo

Todas tienen un **default** que aplico si me autorizás sin comentarlas.

- **P-1. Idempotencia en este batch.** Es la otra mitad de la propuesta (tabla
  `device_request_log` + header `Idempotency-Key`), pero **no** es C1/C2 y el
  alcance es estricto. *Default: afuera; queda propuesta.* Si la querés adentro
  es una migración `0009` y una tarea más.
- **P-2. Administración de tokens.** *Default: solo `pnpm device-token` (CLI de
  servidor).* Una pantalla en Configuración implica UI nueva y dar a los padres
  acceso de escritura a `device_tokens` — lo dejaría para el push de UI.
- **P-3. Studio local.** El stack nuevo no levanta Studio (era lo más expuesto:
  sin auth). *Default: sin Studio; `pnpm db:psql` para mirar la base.* Se puede
  agregar en `127.0.0.1:54323` si lo usás.
- **P-4. Volúmenes viejos del CLI** (`supabase_db_amelia-app` y dos más). Tienen
  los datos de prueba del stack anterior. *Default: no los toco.* ¿Los borro al
  final, o hay algo ahí (una cuenta que usás para probar) que quieras migrar?
- **P-5. `next dev` también escucha en `0.0.0.0`.** Mismo problema de fondo en
  el mismo VPS: `pnpm dev` expone la app —con `/api/ingest` corriendo con
  `service_role`— en la IP pública. En el plan uso `pnpm dev -H 127.0.0.1` para
  mis pruebas. *Default: no cambio el script `dev`.* Recomiendo cambiarlo a
  `next dev -H 127.0.0.1` (una línea) — ¿lo sumo a la T1?
- **P-6. Push y tag.** *Default: merge local a `main`, sin push y sin tag
  `v0.2.0`.* ¿Querés el tag (local) y/o el push a `origin`?
- **P-7. Tu `.env.local`.** `pnpm db:env` reescribe en él solo las 3 claves de
  Supabase (el stack nuevo tiene claves nuevas). Las líneas viejas de
  `NUC_DEVICE_SECRET` / `QUICK_TOGGLE_*` quedan ahí sin efecto. *Default: no las
  borro* (es tu archivo). ¿Las saco?

### Respuestas de Emilio (21 sep 2026) — vinculantes

- Ejecución: subagentes **secuenciales**, uno a la vez, revisado antes del siguiente.
- P-1: idempotencia **afuera**. P-2: default (solo CLI). P-3: **sin Studio**.
- P-4: **copiar** los datos del stack viejo al nuevo (T1 Step 9c); los volúmenes
  viejos **no se borran bajo ninguna circunstancia**.
- P-5: **sí**, `next dev -H 127.0.0.1` en T1 (Step 9b).
- P-6: **sí**, tag `v0.2.0` + push al cerrar (T6 Step 4).
- P-7: **sí**, borrar las variables viejas de `.env.local` (T3 Step 7).
