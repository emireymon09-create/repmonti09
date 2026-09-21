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

No hay CLI de Supabase en este repo: el stack local es un `docker-compose.yml`
propio en `supabase/docker/`, operado con `scripts/local-stack.sh` (`pnpm
db:*`). El CLI publicaba sus puertos en `0.0.0.0` sin forma de evitarlo; este
stack escucha **solo en 127.0.0.1**.

---

## Arranque

```bash
pnpm install
pnpm db:up          # genera claves de esta máquina, levanta y aplica migraciones
pnpm db:env         # escribe .env.test y las 3 claves de Supabase en .env.local
pnpm dev            # http://127.0.0.1:3000
```

`pnpm db:env` escribe `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
y `SUPABASE_SERVICE_ROLE_KEY` directo en `.env.local` (creándolo desde
`.env.local.example` si no existe). No hace falta copiar nada a mano.

Las seis migraciones de `supabase/migrations/` se aplican solas en `pnpm
db:up`. Para re-aplicarlas desde cero (**borra el volumen**):

```bash
pnpm db:reset
```

Sin Studio (P-3): no se levanta. La app: `http://127.0.0.1:3000/login`. `pnpm
dev` también escucha solo en `127.0.0.1` — para probar desde el teléfono en la
LAN hace falta un túnel/SSH, a propósito.

> **Antes de irte:** `pnpm db:down`. El stack ya escucha solo en `127.0.0.1` —
> el hallazgo de Postgres/Studio/API expuestos en la IP pública quedó resuelto
> el 21 sep 2026. Detalle en `docs/seguridad-operacional.md` §6.

---

## Primera cuenta

Sin Studio (P-3), las filas de alta se insertan por SQL con `pnpm db:psql`:

1. En `/login`, registrate con cualquier email y contraseña. Es local: no hay
   envío de mails y la cuenta queda activa al instante.
2. `pnpm db:psql` → `insert into families (name) values ('Reyes Family') returning id;`
3. `select id from auth.users where email = 'tu@email';` → copiá el UUID.
4. `insert into family_members (family_id, user_id) values ('<family_id>', '<user_id>');`
5. `insert into babies (family_id, name, birth_date) values ('<family_id>', 'Nombre', '2026-01-01');`
6. Refrescá `/dashboard`.

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
pnpm db:up
pnpm db:env   # escribe .env.test leyendo el estado real del stack
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
