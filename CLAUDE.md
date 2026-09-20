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

- `lib/format.ts` y `PROJECT.md` afirman que hay tests de timezone.
  **No hay ningún test en el repo.**
- El README dice que la PWA, la UI de sueño y la de crecimiento "no
  están construidas". **Están construidas.**
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
| Gestor de paquetes | **npm** |
| Tests | **Ninguno** (por definir) |
| Lint / format | **Ninguno** (por definir) |
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
public/sw.js       Service worker: que la app ABRA sin conexión.
```

---

## 3. Comandos

```bash
# Dependencias
npm install

# Base de datos local (necesita Docker corriendo)
npm install -g supabase     # una sola vez
supabase start              # levanta Postgres + Auth + API + Studio
supabase db reset           # re-aplica las migraciones desde cero
# Studio local: http://localhost:54323

# Entorno
cp .env.local.example .env.local   # y completá los valores

# Desarrollo
npm run dev                 # http://localhost:3000

# Build / producción
npm run build
npm start

# Test   -> por definir (no hay runner instalado)
# Lint   -> por definir (no hay eslint ni prettier)
```

**Chequeo de tipos:** no hay script propio. `npm run build` corre el
type-check de Next. Para chequear sin buildear: `npx tsc --noEmit`.

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

---

## 5. Reglas operativas

### 5.1 Gestor de paquetes

**npm.** No corras `pnpm` ni `yarn` en este repo.

> **Hueco conocido:** no hay lockfile commiteado. Los builds no son
> reproducibles. Cerrar esto (commitear `package-lock.json`) es una
> mejora pendiente, no una licencia para cambiar de gestor.

### 5.2 Migraciones

- **Nunca edites una migración ya aplicada.** Los archivos
  `supabase/migrations/0001` … `0006` son historia. Un cambio se hace
  con un archivo nuevo.
- **Este repo dejó de numerar sus propias migraciones.** Por ADR 0003 la
  numeración pasa al agente del Hub. Lo que corresponde acá es
  **proponer** una migración (en `proposals/`), no numerarla.
- `supabase/schema.sql` es una vista **consolidada de referencia**, no la
  fuente de verdad. La fuente son los archivos de `migrations/`.
- Toda tabla nueva nace con **RLS habilitada en la misma migración** que
  la crea. Sin excepciones.
- Recordá el bug de `0005`: RLS correcta no alcanza si falta el `GRANT`
  al rol `authenticated`. Postgres bloquea antes de evaluar la policy.

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

- **No crear un repo propio en GitHub** para este directorio. Va a ser
  `apps/amelia` dentro del monorepo del Hub.
- **No crear un proyecto Supabase en la nube.** La base compartida la
  crea el agente del Hub (ADR 0001).
- **No construir calendario, comidas, tareas ni riego.** Eso es del Hub.

---

## 6. Estado real — qué está y qué no

**Construido y funcionando:** auth, dashboard completo (lactancia,
biberón, sólidos, pañales, sueño, predicciones), Milk (extracción),
Growth, Doctor, History con editar/borrar, PWA instalable, cola offline,
RLS en las 11 tablas, los dos endpoints de dispositivo.

**No construido:**

- Tests automatizados (**cero**, pese a lo que dice la doc)
- Lint / format
- Lockfile
- CI, deploy, proyecto Supabase en la nube
- Middleware de auth server-side (el guard es client-side; lo que
  protege los datos es RLS)
- La automatización de Home Assistant que llamaría a `/api/ingest`
  (el endpoint existe, **nada lo llama**)
- Uso real de `family_members.role` (la columna existe, nadie la lee →
  hoy todos los miembros tienen los mismos permisos)

---

## 7. Preguntas abiertas (no las resuelvas solo — preguntá)

1. La `service_role` key vive hoy en `/api/ingest` de esta app, pero la
   regla del Hub dice que vive **solo en el servidor del Hub**. O el
   ingest se muda a `apps/hub`, o la regla necesita una excepción.
2. Cuál de las dos cajas (NUC o HA Green) deriva los eventos de sueño y
   llama a `/api/ingest` — **no está decidido**.
3. `/api/quick/nurse` asume **un solo bebé en toda la base** (toma el
   `babies` más antiguo sin filtrar por familia) y corre con
   `service_role`, o sea que salta RLS. Correcto para un hogar, incorrecto
   apenas haya más de una familia.
4. Los secretos de dispositivo son estáticos y compartidos, sin
   idempotencia ni rate limiting. ADR 0005 pide tokens hasheados por
   dispositivo. No implementado.

---

## 8. Antes de decir "listo"

- [ ] `npx tsc --noEmit` pasa
- [ ] `npm run build` pasa
- [ ] Lo probaste contra el Supabase local, no solo lo leíste
- [ ] Ningún hex ni px nuevo fuera de `app/globals.css` (ver `design.md`)
- [ ] Ninguna query nueva fuera de `lib/db.ts`
- [ ] `lib/supabaseAdmin.ts` no entró a ningún `'use client'`
- [ ] Si tocaste el schema: migración **nueva**, con RLS y GRANTs
- [ ] Si algo quedó sin verificar, lo dijiste explícitamente

Reportá el resultado real. Si algo falla, mostrá la salida. Si salteaste
un paso, decilo.
