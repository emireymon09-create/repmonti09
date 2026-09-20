# Amelia App

Seguimiento de una bebé para uso doméstico: tomas, lactancia, pañales, sueño,
extracción de leche, crecimiento y turnos médicos. La usan dos padres, cada uno
con su propio login, sobre una base con RLS.

**Dos superficies, un solo set de componentes.** El objetivo **primario** de
diseño es una pantalla de pared de 27" en modo kiosco, leída desde el otro lado
del cuarto. El teléfono es secundario, y su caso de uso es a una mano, a las 3
de la mañana, con wifi malo. Si estás por tocar algo visual, `design.md` primero.

Todo corre **local**: Postgres, Auth y API de verdad, en Docker, sin cuentas en
la nube y sin nada desplegado todavía.

---

## Prerrequisitos

- **Node.js LTS.**
- **Docker**, corriendo. El stack local de Supabase son contenedores.
- **pnpm**, y solo pnpm:
  ```bash
  corepack enable
  ```
  La versión sale de `packageManager` en `package.json`. **`npm` y `yarn` están
  prohibidos en este repo** — hay un guard de `preinstall` que aborta si detecta
  otro gestor.

El CLI de Supabase **no se instala global**: es una devDependency y se invoca
con `pnpm exec supabase`. Queda fijado por el lockfile.

---

## Arranque

```bash
pnpm install
pnpm exec supabase start     # la primera vez baja imágenes, tarda unos minutos
cp .env.local.example .env.local
pnpm dev
```

`supabase start` imprime al terminar un bloque con `API URL`, `anon key` y
`service_role key`. Esos tres valores van a `.env.local`:

| Variable de `.env.local` | Sale de |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `API URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon key` |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role key` — **nunca** con prefijo `NEXT_PUBLIC_` |

Las seis migraciones de `supabase/migrations/` se aplican solas en
`supabase start`. Para re-aplicarlas desde cero:

```bash
pnpm exec supabase db reset
```

Studio local: `http://localhost:54323`. La app: `http://localhost:3000/login`.

> **Antes de irte:** `pnpm exec supabase stop`. El stack bindea a `0.0.0.0`, no
> a localhost — o sea que en un VPS queda expuesto salvo que haya un firewall
> delante. Detalle en `docs/seguridad-operacional.md` §6.

---

## Primera cuenta

1. En `/login`, registrate con cualquier email y contraseña. Es local: no hay
   envío de mails y la cuenta queda activa al instante.
2. Abrí **Studio** (`http://localhost:54323`) → Table Editor.
3. `families` → insertá una fila (por ejemplo, name: "Reyes Family").
4. Pestaña **Authentication** → copiá el UUID de tu usuario.
5. `family_members` → insertá una fila con ese `family_id` y ese `user_id`.
6. `babies` → insertá la fila de la bebé con el mismo `family_id`.
7. Refrescá `/dashboard`.

**Por qué a mano y no desde la app:** `families` y `family_members` **no tienen
policy de INSERT**. Es deliberado — dar de alta una familia es una operación de
administración, no algo que un usuario haga solo — pero hasta hoy no estaba
dicho en ningún lado. Está en `docs/auditorias/2026-09-20-auditoria-inicial.md`
como M4.

---

## Tests

```bash
pnpm test              # unit: lib/format.ts y lib/queue.ts. No necesita Docker
pnpm test:tz           # los mismos, bajo UTC / Los Angeles / Tokio / Kiritimati
pnpm test:integration  # RLS y endpoints de dispositivo. NECESITA el stack local
pnpm test:all          # test:tz + test:integration
```

Los de integración necesitan el stack levantado y el archivo `.env.test`:

```bash
pnpm exec supabase start
bash scripts/test-env.sh   # escribe .env.test leyendo el estado real del stack
pnpm test:integration
```

`.env.test` está gitignored: lleva una `service_role` adentro, aunque sea la
local.

**La regla de las cuatro timezones:** cualquier test que toque fechas tiene que
dar el mismo resultado bajo las cuatro. La casa se lee en
`America/Los_Angeles` mire quien mire.

---

## Verificación antes de dar algo por terminado

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm format:check
pnpm build
pnpm test:all
```

---

## Qué está construido

Auth · dashboard completo (lactancia, biberón, sólidos, pañales, sueño,
predicciones de próxima toma y próxima siesta) · Milk (extracción) · Growth ·
Doctor · History con editar y borrar · PWA instalable con service worker · cola
offline en IndexedDB con replay ordenado · RLS en las 11 tablas · los dos
endpoints de dispositivo (`/api/ingest`, `/api/quick/nurse`) · guard de auth
server-side (`middleware.ts`) · suite de tests (unit × 4 TZ + integración contra
el Supabase local).

## Qué NO está construido

- Tests de componentes y de páginas (los que hay cubren `lib/` y la base).
- CI.
- Deploy, y el proyecto Supabase en la nube. Los crea el agente del Hub
  (ADR 0001), no este repo.
- La automatización de Home Assistant que llamaría a `/api/ingest`. El endpoint
  existe; **nada lo llama** todavía.
- Uso real de `family_members.role`. La columna existe y nadie la lee: hoy todos
  los miembros de una familia tienen los mismos permisos.
- Corregir o retractar una medición de `growth_measurements`. Necesita cambio de
  schema ⇒ `proposals/growth-edit-and-void.md`.
- Tokens por dispositivo e idempotencia en los endpoints de dispositivo. Hay dos
  hallazgos críticos abiertos por esto ⇒
  `proposals/device-tokens-and-idempotency.md`.

---

## Dónde sigue la lectura

| Archivo | Qué es |
| --- | --- |
| `CLAUDE.md` | **Las reglas duras.** Punto de entrada de toda sesión. Si algo lo contradice, manda CLAUDE.md. |
| `PROJECT.md` | Arquitectura y estado; documento de traspaso hacia la sesión del Hub. |
| `design.md` | UI/UX: tokens, escala, componentes, patrones de interacción. |
| `docs/README.md` | Doc **operativa**: buenas prácticas, checklist de cada cambio, prompt de auditoría, seguridad. |
| `proposals/` | Cambios de schema propuestos. Este repo ya no numera migraciones (ADR 0003). |

---

## Nube — más adelante, no ahora

Cuando llegue, es mayormente copiar y pegar: proyecto Supabase real, las mismas
migraciones allá, los valores reales en las variables de entorno, deploy a
Vercel. La lista previa al deploy está en `docs/seguridad-operacional.md` §8.

**Este repo no crea nada en la nube por su cuenta**, y tampoco crea un repo
propio en GitHub: va a ser `apps/amelia` dentro del monorepo del Hub.
