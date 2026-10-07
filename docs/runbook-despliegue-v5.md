# Runbook — pasar producción de 0.13.0 a 0.14.0 (inventario de leche v5)

Para Luis, a mano, en orden. **Nada de esto lo ejecutó el agente: no hubo push,
ni merge a `main`, ni se tocó la nube.** Cada paso dice qué escribir, qué tiene que
salir y qué hacer si sale otra cosa.

**Revisado contra la rama el 7 oct 2026** (no contra el texto anterior de este
archivo): `git diff 66462fa HEAD -- supabase/migrations/` = solo
`0016_milk_phase3_4.sql` (1715 líneas, `begin;` en la línea 39, `commit;` en la
última); `0001`…`0015` idénticas a producción; `public/`, `lib/offlinePages.ts` y
`middleware.ts` sin cambios; `.nvmrc` = `24` y `engines.node` = `>=24`.

| Qué | Valor |
|---|---|
| Producción hoy | **0.13.0** = `66462fa` (`origin/main`), con **0014 y 0015 aplicadas** (lo dice Luis; desde el VPS no hay credenciales de la nube: el paso 1 lo comprueba) |
| A publicar | la rama **`feat/milk-inventory-v5`** (worktree `~/proyectos/amelia_app-v5`), que sale de `66462fa` sin merges (avance rápido) |
| Migración | **`0016_milk_phase3_4.sql`** — se aplica **ANTES** del código |
| Versión | **0.14.0** (paso 5). La rama sigue diciendo `0.13.0`: el bump lo hacés vos |

Material de apoyo: `docs/verificar-antes-v5.sql`, `docs/rollback-leche-v5.sql`,
`docs/compatibilidad-v5.md` (teléfonos viejos, reversa, con evidencia),
`docs/milk-v5-para-aprobar.md` (decisiones), `docs/revision-ui-v5.md` (la revisión
de pantallas de esta rama), `docs/progreso-feeding-v5.md`.

## Índice

0. Antes de empezar: firmas y momento
1. Verificación previa, solo lectura
2. Respaldo (y su límite real)
3. Aplicar 0016 y comprobarla objeto por objeto
4. La ventana: 0.13.0 sobre la base con 0016
5. Versión 0.14.0, CHANGELOG y comandos de push
6. Vercel (Node 24), refrescar cada teléfono y prueba de humo
7. Vuelta atrás, por paso
8. Lo que NO está verificado
9. Decisiones a confirmar con mamá, papá y la pediatra

---

## 0. Antes de empezar: firmas y momento

1. `docs/milk-v5-para-aprobar.md` vuelve **firmado por los dos**, con cada D5-x
   marcado (lista en el §9 de este archivo).
   - **Si algo dice "Cambiar"**: no sigas. Es trabajo de código antes de
     desplegar — y si es una constante de la base (60 min de enfriado, 60 min del
     empezado, 48 h de la Similac, 8 oz por botella), también de 0016, que todavía
     no está en la nube y cambiarla ahora es barato.
2. Elegí un momento **sin una toma en curso** y avisale a la otra persona que no
   registre **leche ni biberones** durante ~20 min. Pañales, sueño y lactancia se
   pueden seguir anotando (0016 no los toca).

## 1. Verificación previa, solo lectura

**Dónde:** Supabase → tu proyecto → **SQL Editor** → New query.
**Qué:** `docs/verificar-antes-v5.sql`. Corre dentro de
`begin transaction read only;` … `rollback;`: no puede escribir aunque quisiera.

El editor puede mostrar solo el resultado de la **última** consulta. Para cada
una: pegá `begin transaction read only;` + **una** consulta numerada +
`rollback;`, Run, anotá, y la siguiente.

| # | Qué mira | Tiene que dar | Si da otra cosa |
|---|---|---|---|
| 1 | Las migraciones de leche, por su huella | `0014 … true`, `0015 … true`, `0016 … false` | 0014 o 0015 en `false`: **pará** — producción no está en 0.13.0 como creemos. 0016 en `true`: ya está aplicada, saltá a 3.2 |
| 2 | Los **21** objetos de 0016, uno por fila | **las 21 filas `false`** | Una sola `true` = 0016 quedó a medias: **pará** y avisá |
| 3 | La invariante de la leche con lo que hay hoy | **0 en todas las filas** (ninguna falla) | Algo > 0: 0016 se va a **abortar sola** con `milk_invariant_broken` sin aplicar nada. Pará y revisá esos datos |
| 4 | Qué va a tocar 0016 | conteos informativos | Cuántos biberones dirán "Enfriando" (los de la última hora) y cuántas tomas con "Sobró" de la última hora |
| 5 | El historial de migraciones | informativo | No es la verdad: la verdad son 1 y 2 |
| 6 | Volumen por tabla (`feedings`, `pumping_sessions`, `milk_containers`, `milk_drawdowns`, `babies`) | números | **Anotalos**: se comparan en 3.2 y en la prueba de humo |
| 7 | Lactancia o sueño abiertos ahora | `0` y `0` | Mejor esperar a que se cierren |

Probado en el stack local (`compatibilidad-v5.md` §5): con 0001–0015 da 0016
`false` y 0/21; con 0016, `true` y 21/21; después de la reversa, de nuevo `false`.

**`max_rows`:** si el proyecto corta las respuestas en menos de 1000 filas
(Settings → API), las sumas salen cortas sin aviso (runbook v4 §1c).

## 2. Respaldo (y su límite real)

**Hoy no hay un `pg_dump` vigente de producción.** El único que existe es el que
hiciste a mano el **25 sep 2026** desde tu Windows
(`C:\Proyectos\Backups\Amelia App\`, `docs/seguridad-operacional.md` §10): es
**anterior a 0014 y 0015** (no tiene nada del inventario de leche) y **nunca se
probó restaurándolo**. En este VPS no hay ninguno (`~/backups` solo tiene `fruco/`)
y el plan Free de Supabase **no trae backups automáticos ni PITR** (dato tuyo, no
verificable desde acá).

Lo que hay para hacer:

1. **Un `pg_dump` nuevo, hoy, antes del paso 3** — el procedimiento de
   `seguridad-operacional.md` §10.2, desde tu computadora, conexión **directa** (no
   el pooler), formato custom:

   ```bat
   pg_dump -Fc -d "postgresql://postgres:<PASS>@db.<ref>.supabase.co:5432/postgres" ^
           -f "C:\Proyectos\Backups\Amelia App\amelia-prod-AAAA-MM-DD.dump"
   pg_restore -l "C:\Proyectos\Backups\Amelia App\amelia-prod-AAAA-MM-DD.dump" | findstr "TABLE DATA"
   ```

   **Tiene que salir:** las tablas del proyecto con datos, incluidas
   `milk_containers`, `milk_drawdowns` (0014) y `milk_discards` (0015), y
   **ninguna** de 0016 (`milk_ops`, `milk_transfers`, `formula_containers`).
   **Si `pg_dump` se queja de versión**: tiene que ser de la misma versión del
   servidor o más nueva. **Sin ese archivo, no sigas.**
   **Límite:** sigue sin estar probado que se pueda restaurar (nadie restauró
   nunca un dump de este proyecto).
2. **Si el dump no sale**, como mínimo exportá a CSV desde el Table Editor
   `milk_containers`, `milk_drawdowns`, `milk_discards`, `pumping_sessions` y
   `feedings`. **Límite:** parcial, a mano, y no se vuelve a cargar solo.

(El bloque opcional `milk_backup_v5` de `rollback-leche-v5.sql` **no** es un
respaldo previo: guarda lo de 0016 en el momento de revertir. Ver paso 7.)

## 3. Aplicar 0016 y comprobarla objeto por objeto

**El orden es base primero, código después.** La app 0.14.0 sobre una base sin
0016 no puede registrar **ni una extracción** (manda `p_fridge_at`, que la función
vieja no tiene) y toda función nueva da 404. Al revés —0.13.0 con la base en
0016— está probado que convive (paso 4).

**Hacé 3.1, 3.2, 3.3 y el push del paso 5 seguidos**: ese tramo es la ventana.

### 3.1 Aplicar

SQL Editor → New query → pegá **el archivo entero**
`supabase/migrations/0016_milk_phase3_4.sql` tal cual → Run.

- 0016 **trae su propio** `begin;` y `commit;`, y termina con
  `notify pgrst, 'reload schema';`. No le agregues nada.
- **Tiene que dar:** "Success. No rows returned" (o equivalente, sin `ERROR`).
- **Si sale `ERROR`** (por ejemplo `milk_invariant_broken`): la transacción no
  se aplicó. Corré `rollback;` por las dudas y confirmalo con la consulta 1 del
  paso 1 (0016 `false`). No sigas.

### 3.2 Comprobar, objeto por objeto

Consulta 1 del paso 1 → **0016 `true`**. Consulta 2 → **las 21 filas `true`**.
Y esta, que nombra cada objeto nuevo (solo lectura):

```sql
select
  to_regclass('public.milk_ops')            is not null as milk_ops,
  to_regclass('public.milk_transfers')      is not null as milk_transfers,
  to_regclass('public.formula_containers')  is not null as formula_containers,
  to_regclass('public.milk_discards_one_live_feeding') is not null as idx_started,
  to_regprocedure('public.milk_mark_cold(uuid, uuid, timestamptz)') is not null as mark_cold,
  to_regprocedure('public.milk_combine(uuid, uuid, uuid, uuid[], jsonb)') is not null as combine,
  to_regprocedure('public.milk_uncombine(uuid, uuid)') is not null as uncombine,
  to_regprocedure('public.discard_started_bottle(uuid, uuid, timestamptz)') is not null as discard_started,
  to_regprocedure('public.formula_add(uuid, uuid, uuid[], numeric, timestamptz)') is not null as formula_add,
  to_regprocedure('public.formula_open(uuid, uuid, uuid, timestamptz)') is not null as formula_open,
  to_regprocedure('public.formula_finish(uuid, uuid, text, timestamptz)') is not null as formula_finish,
  to_regprocedure('public.formula_void(uuid, uuid)') is not null as formula_void,
  to_regprocedure('public.log_pumping_session(uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz, timestamptz)') is not null as pump_11,
  to_regprocedure('public.log_pumping_session(uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz)') is null as pump_10_borrada,
  (select bool_and(relrowsecurity) from pg_class
    where oid in (to_regclass('public.milk_ops'), to_regclass('public.milk_transfers'),
                  to_regclass('public.formula_containers'))) as rls_las_tres;
```

**Tiene que dar:** una fila con **todas las columnas `true`**. Una `false`:
anotá cuál y pará (0016 es una sola transacción: no debería poder quedar a
medias).

Y la consulta 6 del paso 1 otra vez: **los mismos números** que anotaste.

### 3.3 Recargar el esquema de la API

```sql
notify pgrst, 'reload schema';
```

Inocuo aunque 0016 ya lo haya mandado. Sin esto, las funciones nuevas pueden dar
404 hasta que PostgREST se reinicie.

## 4. La ventana: 0.13.0 sobre la base con 0016

Desde 3.1 hasta que el último teléfono muestre 0.14.0, la app vieja corre sobre la
base nueva. **Está probado que convive** (`docs/compatibilidad-v5.md` §1–§3, con
la salida pegada):

- **C-1**: la suite de integración de v0.12.1 sobre 0001–0016 → **118/118**.
- **C-2**: la de 0.13.0 sobre 0001–0016 → **309/310**; la única falla es
  `milkV4Schema` I-101, que cuenta tablas (`expected '22|22' to be '19|19'`: las
  tres tablas nuevas, con RLS). No es una falla de la app.

Lo que la familia **sí puede ver** en un teléfono todavía en 0.13.0 (ninguna
escritura desfasa el inventario, ninguna pantalla se cae):

1. Un biberón **origen** de una combinación dice "Ya se sirvieron … de acá" (es
   falso: se pasó a otro biberón).
2. Borrar o vaciar una extracción combinada da un error en inglés crudo,
   `milk_combined:M#`. No escribe nada; en 0.14.0 se deshace la combinación
   primero.
3. "Leche desechada" suma los biberones empezados desechados, y el Historial los
   muestra como "Leche desechada · ? · …".
4. No conoce el enfriado: ofrece leche que 0.14.0 dice "Enfriando".
5. Sin conexión, puede mostrar un destino combinado con menos leche hasta
   sincronizar (la base decide bien).

**Regla:** no registrar leche ni biberones desde un aparato que no muestre 0.14.0.

## 5. Versión 0.14.0, CHANGELOG y comandos de push

**MINOR** (`CLAUDE.md` §0.1): funcionalidad nueva visible + la migración que la
acompaña. **El agente no lo subió.**

### 5.1 Checklist en el VPS (antes de tocar la versión)

```bash
cd ~/proyectos/amelia_app-v5
git status --short                          # tiene que salir vacío
grep -c supabase.co .env.test .env.local    # tiene que salir 0 y 0
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit && pnpm lint && pnpm format:check && pnpm build
pnpm test:all                               # unitarias x4 husos + integración (stack local)
pnpm test:layout                            # la matriz de pantallas (tests/e2e/README.md)
```

Todo exit 0. Números de la última corrida: `docs/revision-ui-v5.md` y
`docs/progreso-feeding-v5.md`. Si algo falla, **no sigas**.

### 5.2 Bump

1. `package.json`: `"version": "0.14.0",`
2. `CHANGELOG.md`, **arriba** de `## [0.13.0]`, en inglés y para quien usa la app.
   Texto sugerido (revisá cada etiqueta contra `lib/i18n/en.ts`):

```
## [0.14.0] - 2026-MM-DD

The next bottle now comes with a recipe, and the app keeps track of Similac.

- **A recipe for the next bottle** on Today: how much breast milk and how much Similac, using
  cold milk that hasn't expired, oldest first, and how many feeds the cold milk covers. "If
  crying" asks for just 1 oz more when the last feed ended less than 2 hours ago. You can set a
  fixed amount of formula. Everything can still be changed before logging.
- **Cooling:** freshly pumped milk shows "Cooling · ready ~HH:MM" for an hour. If you've
  checked it, "It's cold now" marks it ready. It still expires 4 days after pumping.
- **Combine bottles:** pour cold, unexpired bottles into one. It takes the earliest expiry and
  the others become free. You can undo it while the milk it received is still there.
- **Similac stock:** log a purchase (6 × 8 oz by default), "I opened a Similac", and see how
  much is left, how much a day you use and when to buy more. An open bottle lasts 48 hours;
  after that it says "Expired" with a Discard button. Formula never blocks a feed.
- **Started bottle:** what was left over in a bottle is good for an hour. After that Today says
  it's no longer good and offers to discard it.
- **Menus no longer hide under the bottom bar:** the ⋯ menu on the last rows of History opens
  upwards, only one menu can be open at a time, and the shortcut arrow on a card no longer sits
  on top of its first line. The current page in the menu and "Delete" are easier to read.
- In Settings, the room-temperature and freezer rules moved under "Not used yet".
```

3. Comprobar y commitear:

```bash
pnpm test                           # incluye tests/unit/changelog.test.ts
git add package.json CHANGELOG.md
git commit -m "Release 0.14.0 with the bottle recipe, cooling, combining and Similac stock"
```

### 5.3 Push — ESCRITO, NO EJECUTADO por el agente

```bash
cd ~/proyectos/amelia_app-v5
git fetch origin
git rev-parse origin/main                       # tiene que ser 66462fa…
git merge-base --is-ancestor origin/main HEAD && echo "avance rápido OK"
git diff origin/main -- package.json | grep '^+.*"version"'
#   tiene que imprimir:  +  "version": "0.14.0",
git push origin feat/milk-inventory-v5:main
```

- Si `origin/main` no es `66462fa`: alguien publicó algo. Integrá `origin/main` en
  la rama y volvé a 5.1.
- Si el `grep` no imprime nada: **no pushees** (falta el bump).
- Nunca `--force`.

> ⚠️ **Los previews tocan la base de producción.** Preview y producción usan la
> **misma** base de Supabase (`CLAUDE.md` §7.8). **No pushees la rama sola**
> (`git push origin feat/milk-inventory-v5`), y menos antes del paso 3: Vercel
> crearía un Preview que escribe en la base real, y sin 0016 ni siquiera registra
> una extracción. Empujar directo a `main` no crea un Preview de la rama.

## 6. Vercel (Node 24), refrescar cada teléfono y prueba de humo

### 6.1 Vercel

1. Vercel → proyecto `amelia-app` → **Deployments**: el deployment del push
   aparece solo (~1 min). Tiene que terminar **Ready**.
2. Abrí el deployment → **Build Logs**: buscá la versión de Node. Tiene que ser
   **24.x** (`engines.node >=24`, `.nvmrc` = 24). Si dice otra: Settings → General
   → **Node.js Version → 24.x**, guardá y **Redeploy**.
3. **Si el build falla:** producción sigue en 0.13.0 con 0016 puesta, que convive
   (paso 4). Arreglá y repetí el paso 5.

### 6.2 Cada teléfono y la pantalla

`public/sw.js` no cambió (sigue `amelia-v6`): las páginas se piden primero a la
red, así que una carga **con conexión** trae 0.14.0.

1. Dejá sincronizar lo pendiente ("Todavía sin sincronizar") **antes** de cerrar.
2. Cerrá la app **del todo** (también la instalada en la pantalla de inicio) y
   abrila **con conexión**.
3. Menú → al pie tiene que decir **v0.14.0**. Si dice 0.13.0: cerrala de nuevo y
   abrila con wifi o datos. En iPhone, si persiste: mantené apretado el ícono →
   quitá la app y volvé a agregarla desde Safari.
4. Pantalla de pared: recargar.

### 6.3 Prueba de humo (≈15 min, en un teléfono real ya en 0.14.0)

| Hacé | Tiene que pasar |
|---|---|
| Leche → registrar una extracción en un biberón libre | "Enfriando · lista ~HH:MM" |
| "Ya está fría" en ese biberón | deja de decir "Enfriando" |
| Hoy → "Próximo biberón" | "X de leche + Y de Similac", con leche **fría** |
| Leche → Similac → "Anotar compra" y "Abrí una Similac" | "N cerradas + 1 abierta"; "usar hasta" = 48 h después |
| Combinar dos biberones fríos, después "Deshacer" | el destino suma, el otro queda libre; "Lo que hay" no cambia; deshacer lo devuelve |
| Historial → ⋯ de la **última** fila | el menú abre **hacia arriba**, entero, arriba de la barra |
| Abrir el Menú, y después tocar un ⋯ | nunca hay dos menús abiertos |
| Hoy → un pañal | se registra |

En el SQL Editor, solo lectura: la invariante del final de 0016 (el bloque `do`
final, cambiando `do` por `select falla, id from fallas`) → **0 filas**.

**Limpieza:** borrá desde la app lo que registraste (deshacé la combinación,
borrá la Similac de prueba con su ⋯). No a mano en SQL.

## 7. Vuelta atrás, por paso

| Si falla en… | Qué hacer | Qué se pierde |
|---|---|---|
| 0, 1, 2 | Nada que deshacer | Nada |
| 3.1 con `ERROR` | No quedó aplicada (una transacción). `rollback;` y consulta 1 | Nada |
| Después del push, problema de la **app** | Vercel → Deployments → el de 0.13.0 → **Promote to Production** (o `git revert` del rango + push con su propio bump, §0.1). La base **puede quedar en 0016**: 0.13.0 convive (paso 4) | Nada en la base. Lo encolado por 0.14.0 en un teléfono (combinar, Similac, "ya está fría", desechar el empezado) se sigue aplicando, porque las funciones siguen en la base [por lectura de `66462fa:lib/db.ts`, no probado en un teléfono] |
| Hay que sacar **0016** | Primero la app (fila anterior) y cerrar/abrir las PWA. Si se puede, **deshacé las combinaciones vivas desde 0.14.0** antes. Para conservar lo que se pierde, descomentá el bloque `milk_backup_v5` de `docs/rollback-leche-v5.sql` (va antes de su `begin;`). Después el archivo entero en el SQL Editor (trae su `begin`/`commit` y el `notify`) | **La Similac** (compras y abierta), **los desechos del biberón empezado**, **el enfriado** ("ya está fría"), **el registro de operaciones** y **las combinaciones**. La leche recibida y no servida de una combinación viva **sale de "Lo que hay"** (el NOTICE dice cuánto). Probado: invariante de 0015 = 0, esquema idéntico a 0001–0015, re-ejecutable, 0016 vuelve a entrar (`compatibilidad-v5.md` §4) |
| También 0015 o 0014 | Después del anterior, `docs/rollback-leche-v4.sql` y `docs/rollback-leche.sql` (runbook v4 §12) | Todo el inventario de leche |
| Todo salió mal | Restaurar el dump del paso 2 | Todo lo registrado después del dump. **Nunca se probó una restauración de este proyecto** |

## 8. Lo que NO está verificado

- **iPhone / WebKit / la PWA instalada.** Todo lo de pantallas se midió en
  Chromium headless (`tests/e2e`, `docs/revision-ui-v5.md`): ni el menú que abre
  hacia arriba, ni los avisos de la leche, ni los `confirm` con el dedo se vieron
  en Safari. Tampoco `env(safe-area-inset-*)` reales (en Chromium valen 0) ni el
  teclado en pantalla sobre los campos de la receta.
- **La barra de abajo elevada en el iPhone** (`CLAUDE.md` §6, v0.10.4): sigue
  abierta; esta rama no la toca.
- **El inglés es parcial donde lo dice `CLAUDE.md` §5.7** (las notas de
  `/version`, el detalle crudo de un error de Supabase, y `milk_combined:M#` en la
  app vieja). Las pantallas nuevas sí pasan por los dos diccionarios
  (`tests/unit/i18n.test.ts`).
- **Las esperas reales:** 60 min de enfriado, 60 min del empezado, 48 h de la
  Similac y el aviso de 6 h. En el VPS se probaron con el reloj fijado.
- **Red real y modo avión** en un teléfono.
- **La nube:** que 0016 corra en el SQL Editor igual que en psql, los permisos del
  proyecto, el plan de Vercel y que Node 24 esté elegido allá.
- **El respaldo:** ningún dump de este proyecto se restauró nunca.

## 9. Decisiones a confirmar con mamá, papá y la pediatra

Están en `docs/milk-v5-para-aprobar.md`, cada una con "☐ Sí ☐ Cambiar".

- **Para la pediatra** (tocan salud): D5-2 (+1 oz si llora antes de 2 h), D5-3
  (3.5 oz por toma), **D5-4 (enfriar 60 min)**, D5-9 y D5-10 (el empezado sirve
  1 h y se tira con un botón), **D5-12 (Similac abierta 48 h)**, D5-14 (avisos:
  8 oz y 6 h antes), D5-20 (la fórmula fija vale para la toma completa).
- **Para mamá y papá** (uso de la casa): D5-1, D5-5, D5-6, D5-7, D5-8, D5-11,
  D5-13, D5-15, D5-16, D5-17, D5-18, D5-19.
