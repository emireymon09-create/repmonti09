# Runbook — desplegar el inventario de leche v4 sobre producción v0.12.1

Para el dueño, a mano, en orden. **Nada de esto lo ejecutó el agente: no hubo
push, ni merge a `main`, ni se tocó la nube.** Los comandos están escritos para
copiarlos; cada paso dice qué esperar y cómo volver atrás.

Reemplaza a `docs/runbook-despliegue-leche.md` (el de v3), que **no** hay que
seguir: v3 nunca se publicó y v4 la contiene.

| Qué | Valor |
|---|---|
| Producción hoy | **v0.12.1** = `0cbe798` (`origin/main` al último `git fetch`, 6 oct 2026) |
| A publicar | rama **`feat/milk-inventory-v4`** (worktree `~/proyectos/amelia_app-v4`) = v0.12.1 + inventario v3 + PR #1 (Node 24) + PR #2 (notas) + v4. Avance rápido sobre `0cbe798` [VERIFICADO: `git merge-base --is-ancestor origin/main HEAD`] |
| Migraciones a aplicar en la nube | `0013_changer_display_scopes` (si faltara), **`0014_milk_inventory`** y **`0015_milk_phase1_2`**, en ese orden |
| Versión | la rama está en **0.12.3** sin bump propio; se propone **0.13.0** (paso 5) |

Documentos de apoyo: `docs/compatibilidad-v4.md` (qué pasa con teléfonos
viejos y cómo se vuelve atrás), `docs/verificar-antes-leche.sql`,
`docs/verificar-antes-v4.sql`, `docs/rollback-leche-v4.sql`,
`docs/rollback-leche.sql`, `docs/comparacion-v4.md`, `docs/progreso-feeding-v4.md`.

---

## 0. Puerta: la aprobación de mamá

`docs/milk-v4-para-aprobar.md` tiene que volver **firmado por papá y mamá**,
con cada sección marcada y la lista de decisiones (§10 de ese documento)
revisada.

- **Sin las dos firmas, no se sigue.** Ni backup, ni migraciones, ni push.
- Si alguna sección o decisión dice "Cambiar", **pará**: es trabajo de código
  (y quizá de la migración 0015) antes de desplegar. 0015 todavía no está en la
  nube, así que cambiarla ahora es barato; después ya no.
- Guardá el documento firmado (foto o commit) junto al backup del paso 2.

Además, antes de empezar:

- Elegí un momento **sin una toma en curso** y avisá a la otra persona que no
  registre **leche** (extracciones ni biberones) durante ~20 min. Pañales,
  sueño y lactancia se pueden seguir anotando.
- Tené a mano: la contraseña de la base de producción (conexión **directa**,
  puerto 5432), el panel de Supabase (SQL Editor) y el de Vercel.

## 1. Verificación previa (solo lectura)

SQL Editor de Supabase. Los dos archivos corren dentro de
`begin transaction read only` … `rollback`: no pueden escribir. El SQL Editor
puede mostrar **solo el resultado de la última consulta**: seleccioná
`begin transaction read only;` + **una** consulta numerada + `rollback;`, Run,
y después la siguiente.

### 1a. `docs/verificar-antes-leche.sql` (el de v3), consulta 1

| Fila | Esperado | Si no |
|---|---|---|
| 0001 … 0012, salvo 0011 | `true` | **Pará.** Producción no está donde creemos |
| 0011_push_cron | `true` o `false` | `false` = el cron del aviso push no está en la nube. **No bloquea** la leche |
| 0013_changer_display_scopes | `true` (se espera aplicada; **[NO VERIFICADO]** desde el VPS) | `false` → aplicala en el paso 3a |
| 0014_milk_inventory | **`false`** | `true` = alguien ya aplicó el inventario v3: seguí, pero **saltá el paso 3b** y mirá la consulta 3 de 1b con atención |

### 1b. `docs/verificar-antes-v4.sql`

| Consulta | Esperado en producción hoy | Cómo leerlo |
|---|---|---|
| 1 | 0001–0013 igual que 1a; fila **"0014_milk_inventory (DEBE dar true)" → `false`**; fila 0015 → **`false`** | El "DEBE dar true" del encabezado supone que v3 ya se publicó. **Acá no**: `false` es lo esperado y significa "aplicar 0014 y después 0015" (pasos 3b y 3c). Si 0015 da `true`, **pará** |
| 2 | **Las 18 filas `false`** | Una sola `true` = algo de 0015 quedó a medias o se aplicó antes: **pará** y revisá |
| 3 | Sin 0014: **null** en todas (no hay inventario que revisar). Con 0014 ya puesta: **0** en todas | Un número > 0 = 0015 se va a abortar sola con `milk_invariant_broken` (sin aplicar nada). Revisá esos datos antes |
| 4 | null sin 0014; con 0014, conteos informativos | Dice qué hará 0015: vaciados que se liberan, vencidos que aparecerán con "Desechar", números > M6 |
| 5 | informativa | El historial de migraciones no es la verdad; la verdad son las consultas 1 y 2 |
| 6 | conteos | **Anotalos**: se comparan con el backup (paso 2) y con la prueba de humo (paso 11) |
| 7 | 0 y 0 | Si hay una lactancia o un sueño abiertos, mejor esperar a que terminen |

### 1c. Tope de filas de la API (`max_rows`)

La app lee en páginas de **1000** filas (`lib/readAll.ts`). Si el proyecto
corta cada respuesta en **menos** de 1000, las lecturas que suman (totales,
"Lo que hay", curvas) se quedan cortas **en silencio**.

- Dónde verlo: panel de Supabase → **Project Settings → API** (en paneles más
  nuevos, **Data API**) → **"Max rows"**. **[NO VERIFICADO]** el nombre exacto
  del menú: cambia entre versiones del panel y desde el VPS no hay acceso.
- **≥ 1000 (el valor por defecto es 1000)** → seguí.
- **< 1000** → **pará**: o se sube a 1000 en ese mismo panel, o hay que bajar
  `PAGE_SIZE` en `lib/readAll.ts` al mismo número (cambio de código, con su
  prueba) antes del push.

## 2. Backup de producción (`pg_dump`)

Seguí `docs/seguridad-operacional.md` §10.2: **en tu computadora, no en el
VPS**; conexión **directa** (`db.<ref>.supabase.co`, puerto 5432), no el pooler
(6543); formato custom; `pg_dump` de versión igual o más nueva que el servidor.
Credencial: el usuario `postgres` y la contraseña de la base (Project Settings →
Database; si no la tenés, "Reset database password" y guardala en el gestor
**antes** de cerrar). Sin poner la contraseña en la línea de comandos (así no
queda en el historial): `pg_dump` la pide.

```
pg_dump -Fc -h db.<ref>.supabase.co -p 5432 -U postgres -d postgres -f "C:\Proyectos\Backups\Amelia App\amelia-prod-2026-MM-DD-pre-leche-v4.dump"
pg_restore -l "C:\Proyectos\Backups\Amelia App\amelia-prod-2026-MM-DD-pre-leche-v4.dump"
```

- **Dónde guardarlo:** fuera del VPS y fuera de Supabase (la carpeta de
  backups de §10.1). Lleva datos de una menor: no se sube a un repo ni se manda
  por chat.
- **Comprobar que se puede leer:** el `pg_restore -l` tiene que listar las
  **15 tablas** del proyecto (todavía sin `milk_*`) y sus datos (`TABLE DATA`).
  Si sale vacío, corto o con error, **no sigas**.
- Anotá al lado del archivo si incluye el schema `auth` (los logins) o solo
  `public` (§10.2).
- Vuelta atrás de este paso: no hace falta (no cambia nada).

## 3. Aplicar las migraciones — ANTES de que salga el código

**El orden es: base primero, push después.** Con la app v4 sobre una base sin
0015, toda función nueva da 404 y la app rechaza cada biberón y cada extracción
(`compatibilidad-v4.md` §4). Al revés —la base nueva con la app vieja— está
probado que no desfasa el inventario (§2 de ese documento).

**Hacé 3b, 3c, 3d y el push (paso 7) seguidos**, sin pausas largas: ese tramo
es la "ventana" (paso 13).

Los archivos **no traen** `begin`/`commit` propio. Pegalos envueltos: si algo
falla, no queda nada a medias. Para 0015 es **obligatorio**: usa una marca que
solo vale dentro de una transacción; sin el `begin`, sus correcciones de datos
se rechazarían a mitad de camino.

### 3a. Solo si 0013 dio `false`

```sql
begin;
set local lock_timeout = '5s';
-- pegá acá el contenido COMPLETO de supabase/migrations/0013_changer_display_scopes.sql
commit;
```

Verificá: fila 0013 → `true`. No hace falta deshacerla nunca.

### 3b. `0014_milk_inventory.sql` (si 1a dio `false`)

```sql
begin;
set local lock_timeout = '5s';
-- pegá acá el contenido COMPLETO de supabase/migrations/0014_milk_inventory.sql
commit;
```

- `lock_timeout`: si una escritura de un teléfono tiene tomada la tabla, falla
  limpia a los 5 s en vez de dejar colgados a todos. Esperá un minuto y
  repetí.
- Si aparece un `ERROR`: corré `rollback;`, anotá el mensaje y **no sigas**.
- Verificá: `verificar-antes-leche.sql` consulta 1 → 0014 `true`;
  `verificar-antes-v4.sql` consulta 3 → **0** en todas.

### 3c. `0015_milk_phase1_2.sql`

```sql
begin;
set local lock_timeout = '5s';
-- pegá acá el contenido COMPLETO de supabase/migrations/0015_milk_phase1_2.sql
commit;
```

- Termina sola con la cuenta de toda la leche. Si dice
  `milk_invariant_broken`, **no se aplicó nada**: `rollback;`, anotá el detalle
  (dice la primera fila que no cierra) y **no sigas**.
- Ya trae `notify pgrst, 'reload schema'` al final (se entrega al `commit`).
- Verificá: `verificar-antes-v4.sql` consulta 1 → 0015 **`true`** y consulta 2
  → **las 18 `true`**. Y la consulta de `docs/arquitectura-v4.md` §2.4 (copiala
  de ahí; solo lectura) → **0 filas**. (La consulta 3 de
  `verificar-antes-v4.sql` es para *antes*: con 0015 puesta no sirve.)

Opcional, para que el historial quede al día si existe la tabla (consulta 5):

```sql
insert into supabase_migrations.schema_migrations(version)
values ('0014_milk_inventory'), ('0015_milk_phase1_2');
```

(y `'0013_changer_display_scopes'` si se aplicó en 3a). No cambia nada más.

### 3d. Recargar el esquema de la API

```sql
notify pgrst, 'reload schema';
```

Inocuo aunque 0015 ya lo haya mandado. **[NO VERIFICADO]** si la nube tiene
los disparadores que lo hacen solos (en local sí: la primera llamada ≈0,5 s
después ya veía las funciones nuevas, C-24). Comprobación (solo lectura):

```sql
select proname, pg_get_function_identity_arguments(oid)
from pg_proc where proname in ('discard_container','edit_bottle_feed','log_bottle_feed');
```

→ 3 filas, `log_bottle_feed` con 7 argumentos.

## 4. Checklist previo al push (en el VPS)

```bash
cd ~/proyectos/amelia_app-v4
git status --short                         # vacío (salvo lo que vayas a commitear en el paso 5)
node --version                             # v24.x (engines.node >=24)
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm lint
pnpm format:check
pnpm build
pnpm db:reset                              # stack local 0001–0015 en 127.0.0.1 (BORRA la base local)
pnpm test:all                              # unitarias x4 husos + integración
```

Esperado: todo en exit 0. Los números de la última corrida están en
`docs/progreso-feeding-v4.md` (al cierre de H6: unitarias 554/554 en 4 husos,
integración 307/307; el director registra ahí los finales).

**Suites de compatibilidad** (las apps viejas contra la base 0001–0015 local;
worktrees desacoplados, se borran al terminar):

```bash
cd ~/proyectos
git -C amelia_app-v4 worktree add --detach ../amelia_app-v0121-check 0cbe798
git -C amelia_app-v4 worktree add --detach ../amelia_app-v3check 71d4d0c
for d in amelia_app-v0121-check amelia_app-v3check; do
  cp amelia_app-v4/.env.test "$d/" && mkdir -p "$d/supabase/docker" && cp amelia_app-v4/supabase/docker/.env "$d/supabase/docker/"
  (cd "$d" && pnpm install --frozen-lockfile && pnpm exec vitest run tests/integration --maxWorkers=2)
done
git -C amelia_app-v4 worktree remove ../amelia_app-v0121-check
git -C amelia_app-v4 worktree remove ../amelia_app-v3check
```

Esperado (`compatibilidad-v4.md` §1): v0.12.1 **118/118**; v3 **150/151**, y la
única falla es `milk.test.ts` "log_bottle_feed rechaza un contenedor anulado, uno
vencido…" recibiendo `milk_future_time` (decisión D-15, no regresión). Cualquier
otra falla: **pará**.

Antes de correr nada de esto, comprobá que `.env.test` y `.env.local` apuntan a
`127.0.0.1` (`grep -c supabase.co .env.test .env.local` → 0 y 0).

## 5. Versión: 0.13.0

**MINOR** (`CLAUDE.md` §0.1 y §4.1): funcionalidad nueva visible y migraciones
que la acompañan. 0.12.2 y 0.12.3 (PR #1 y #2) ya están en la rama y en su
CHANGELOG; **no se tocan**. Se agrega 0.13.0 **arriba** de 0.12.3.

1. `package.json`: `"version": "0.13.0"`.
2. `CHANGELOG.md`, arriba de `## [0.12.3] - 2026-10-06`, en inglés y para quien
   usa la app (v3 nunca salió: la entrada describe todo lo nuevo desde 0.12.1).
   Texto sugerido:

```
## [0.13.0] - 2026-MM-DD

Breast milk is now kept as a stash in the app's reusable bottles.

- **Log each pumping session left and right**, each side in oz or ml, and pick which bottle
  (M1–M6) it went into. A bottle with milk can't be picked again until it's used, thrown out or
  deleted. How many bottles you have is in Settings → Milk storage → Milk bottles.
- **Know what there is:** the Milk page shows the usable milk in oz, oldest first. Fridge milk
  expires after 4 days; an expired bottle says so and can be discarded, which frees it and adds
  to "Discarded milk".
- **Each bottle suggests itself:** the last bottle's amount, the oldest milk first, topped up with
  formula. You can note what was left over.
- **Fix a whole bottle from History:** time, breast milk, formula and leftover. The milk goes back
  to, or comes from, the right bottles; if there isn't enough, it says so and saves nothing.
- Older bottles show an estimated milk/formula split.
- Works offline like the rest of the app, and two phones can't fill the same bottle.
```

3. Comprobar y commitear:

```bash
pnpm test                                   # incluye tests/unit/changelog.test.ts: versión == primera entrada
git add package.json CHANGELOG.md
git commit -m "Release 0.13.0 with the reusable milk bottles"
```

(Mensaje en inglés, imperativo, sin prefijo: `CLAUDE.md` §4.) Revisá que los
textos del CHANGELOG coincidan con lo que dice la app en inglés (`lib/i18n/en.ts`)
antes de commitear; el sugerido es un borrador [NO VERIFICADO contra cada
etiqueta en pantalla].

## 6. Los PR #1 y #2

- Están **integrados** en esta rama: PR #1 (`origin/chore/pin-node-24`,
  `5bdbbec`) en `436de96` y PR #2 (`origin/docs/display-priority`, `93b4b36`) en
  `7e94c65`. **No hay que mergearlos aparte.**
- **Si nadie los tocó:** al publicar la rama en `main` (paso 7), sus commits
  quedan en `main` y GitHub normalmente los marca "Merged" solo. Si no lo hace
  **[NO VERIFICADO]**, cerralos con el comentario "Integrado en `main` vía
  feat/milk-inventory-v4 (`<hash>`)".
- **Si alguien los mergeó a `main` antes que vos** (`git fetch origin` y
  `git log --oneline 0cbe798..origin/main` muestra commits nuevos):
  1. **No fuerces nada.** En el worktree v4: `git fetch origin && git merge origin/main`.
  2. Si choca `package.json` o `CHANGELOG.md`: dejá **una sola vez** cada
     entrada `0.12.3`, `0.12.2`, `0.12.1` (en ese orden, sin duplicados) y la
     `0.13.0` arriba de todo; `version` = `0.13.0`. Nunca se repite ni se baja
     una versión (§0.1).
  3. Si `main` trae otra cosa que ya usó 0.13.0, la tuya pasa a la siguiente
     MINOR libre.
  4. Volvé a correr el paso 4 entero.
- No pushees `chore/pin-node-24` ni `docs/display-priority` de nuevo.

## 7. Integración y push (lo hacés vos)

**Recomendado: desde el worktree v4, avance rápido directo a `main`.** El
worktree de `main` (`~/proyectos/amelia_app`) tiene cambios sin commitear y su
`main` local está en `9824e26`, atrás de `origin/main`: no lo uses para esto.

```bash
cd ~/proyectos/amelia_app-v4
git fetch origin
git rev-parse origin/main                   # 0cbe798e4befdbe267a36c5182ff55ad138c18a1 (si no, paso 6)
git merge-base --is-ancestor origin/main HEAD && echo "avance rápido OK"
git diff origin/main -- package.json | grep '^+.*"version"'   # §0.1: TIENE que imprimir "+  \"version\": \"0.13.0\","
git push origin feat/milk-inventory-v4:main
```

- Si el `grep` no imprime nada: **no pushees** (falta el paso 5).
- Si el remoto rechaza por no ser avance rápido: **nunca `--force`**; volvé al
  paso 6.
- Empuja **solo a `main`**: no crea la rama `feat/milk-inventory-v4` en GitHub
  (y por lo tanto ningún Preview, paso 9).

Alternativa con merge explícito (solo si querés un commit de merge en el
historial; necesita un `main` local limpio):

```bash
cd ~/proyectos/amelia_app
git status --short                          # tiene que estar vacío: si no, NO sigas por acá
git switch main && git merge --ff-only origin/main
git merge --no-ff feat/milk-inventory-v4 -m "Merge the reusable milk bottles (0.13.0)"
git diff origin/main -- package.json | grep '^+.*"version"'
git push origin main
```

Después del push: Vercel despliega solo (~1 min). En GitHub/Vercel, el
deployment de **Production** del commit nuevo tiene que terminar en verde. Si
el build falla, producción **sigue** en v0.12.1 (un build fallido no se
promueve); mirá el paso 8.

## 8. Node 24 en Vercel

La rama exige `engines.node >=24` y trae `.nvmrc` = `24` (PR #1). pnpm 11
(`packageManager: pnpm@11.7.0`) no corre en Node 20.

- Dónde verlo: Vercel → proyecto `amelia-app` → **Settings → General →
  Node.js Version** → **24.x**. Vercel también lee `engines.node` de
  `package.json` y, si la versión pedida no está disponible, el build falla.
- En el log del primer deployment, buscá la línea de la versión de Node y la
  de pnpm.
- **[NO VERIFICADO desde el VPS]**: qué versión de Node usa hoy el proyecto,
  si ofrece 24.x, y cómo está instalando pnpm 11 para v0.12.1 (que ya lo pedía).
  Sin `.vercel/` ni CLI ni credenciales acá. Mirarlo **antes** del push: si el
  build de producción falla, la base ya tiene 0015 y los teléfonos siguen en la
  app vieja (convive, pero la ventana se alarga).

## 9. Previews de Vercel — leer antes de pushear

Según `CLAUDE.md` §7.8, **Preview y Producción usan la misma base de
Supabase** (dicho por Luis; desde el VPS se confirmó solo la mitad de
producción), y la Deployment Protection de Preview estaba prendida el 25 sep.

- **No pushees `feat/milk-inventory-v4` como rama propia** ni abras un PR con
  ella **antes de los pasos 3b–3d**: crearía un Preview de la app v4 contra la
  base de producción **sin migrar** (todo daría 404) y cualquier prueba ahí
  escribe datos reales de Amelia.
- Aun después de migrar, un Preview es **la base real**: no lo uses para
  probar.
- Los Previews de `chore/pin-node-24` y `docs/display-priority` (si existen)
  corren la app v0.12.x: después de 0015 se comportan como "app vieja" (su leche
  entra fuera del inventario). **No registres leche desde ellos.**
- Si la protección está apagada, esas URLs quedan abiertas a quien las tenga:
  decisión pendiente de §7.8, no de este despliegue.
- **[NO VERIFICADO]** las variables por entorno en Vercel.

## 10. Actualizar la PWA en cada aparato

`public/sw.js` **no cambió** (sigue `amelia-v6`): el código nuevo llega en la
**próxima carga completa**. Una pestaña o PWA abierta sigue con lo viejo en
memoria.

- **Cada teléfono:** cerrar la app del todo (deslizarla fuera del selector de
  apps) y abrirla de nuevo **con conexión**. Comprobación: Menú → al pie,
  **0.13.0**; en Leche, el selector "¿En qué biberón quedó?" (ya no hay campo
  "Cinta").
- **Pantalla de pared** (panel de Home Assistant): recargar la página o
  reiniciar el kiosco.
- Si un aparato tenía entradas "Todavía sin sincronizar" de antes, dejalas
  sincronizar **antes** de cerrar la app.
- **Regla:** no registrar **leche** desde un aparato que todavía no muestra
  0.13.0. Lo que registre la app vieja entra **fuera** del inventario: una
  extracción no ocupa biberón y un biberón de leche materna **no descuenta**,
  así que "Lo que hay" queda **más alto** que la heladera.

## 11. Prueba de humo en producción (≈10 min, en un teléfono ya actualizado)

| Hacer | Tiene que pasar |
|---|---|
| Leche → izq 1 oz, der 30 ml, sin elegir biberón → Registrar | "Elegí en qué biberón quedó." y no guarda |
| Elegir un biberón libre (p. ej. M1) → Registrar | "Sesión registrada en M1."; "Lo que hay" sube ≈2 oz; M1 aparece ocupado en el selector |
| Hoy → Comida → Biberón → Registrar tal cual | Sale de la leche más vieja; "Lo que hay" baja |
| Historial → ⋯ en esa toma → Editar → bajar la leche 0.5 oz, poner Sobró | Muestra "Vuelve 0.5 oz a M1"; al guardar, "Lo que hay" sube 0.5 oz |
| Hoy → Biberón con "Sobró" | Guarda; "Lo que hay" baja lo servido entero |
| Ajustes → Conservación → "Biberones de leche" | Muestra 6; ambiente y congelador dicen "Todavía no se usa" |
| Desechar (solo si hay un biberón **vencido** de verdad; no se fuerza en producción) | Pregunta, lo libera y suma a "Leche desechada" |
| Historial | Las filas nuevas, y tomas viejas con "(estimado)" |
| Hoy → pañal | Se registra |
| Pantalla del cambiador (si está encendida) | Sigue mostrando el estado y registra un pañal |

Y en el SQL Editor, solo lectura: la consulta de `docs/arquitectura-v4.md` §2.4
→ **0 filas**; la consulta 6 de `verificar-antes-v4.sql` → los conteos del paso
1b más lo que registraste.

**Lo que no se pudo probar en el VPS y se prueba acá** [NO VERIFICADO hasta
entonces]: iPhone / WebKit, la PWA **instalada**, red real (y un rato en modo
avión: registrar, volver a la red, ver que la marca desaparece), y el selector
con dedo a una mano.

**Limpieza:** borrá desde la app lo que registraste (primero la toma, después
la extracción), no a mano en SQL.

**Lo que registraron aparatos viejos durante la ventana** (solo lectura;
reemplazá la hora por la del paso 3b, en UTC):

```sql
select 'biberón sin desglose' as que, id, fed_at as cuando, amount_ml
from feedings where feeding_type = 'bottle' and breast_milk_ml is null and formula_ml is null
  and voided_at is null and created_at > 'AAAA-MM-DD HH:MM+00'
union all
select 'extracción legada', id, pumped_at, amount_ml
from pumping_sessions where left_ml is null and right_ml is null and amount_ml is not null
  and voided_at is null and created_at > 'AAAA-MM-DD HH:MM+00';
```

Si fue leche materna: borrala desde Historial y volvé a registrarla con la app
nueva (la extracción eligiendo el biberón; el biberón eligiendo de qué salió).

## 12. Vuelta atrás, por paso

| Si falla en… | Qué hacer |
|---|---|
| 0–2 | Nada que deshacer |
| 3a | 0013 no hace falta deshacerla |
| 3b o 3c con error | El `begin` evita que quede aplicada: `rollback;` y confirmalo con `verificar-antes-v4.sql` (consulta 1/2). Si 3b entró y 3c no, la base queda en 0014 con la app v0.12.1: convive (probado en v3, `compatibilidad-leche.md`) |
| Antes del push, querés sacar todo | `docs/rollback-leche-v4.sql` y después `docs/rollback-leche.sql` (abajo) |
| **Después del push, problema de la app** | Vercel → Deployments → el de v0.12.1 → *Promote to Production* (o `git revert` del rango y push, con su propio bump §0.1). Ojo: tras un *Promote* a uno viejo, Vercel deja de asignar Production a los pushes siguientes hasta deshacerlo en el panel. **v3 nunca tuvo deployment**: volver la app es volver a **v0.12.1**. La base puede **quedar en 0015**: la app vieja funciona; editar o borrar lo creado por v4 da un error visible sin dañar nada; entradas de leche encoladas por v4 en un teléfono se rechazan una por una y hay que Descartarlas (`compatibilidad-v4.md` §5.1, C-13) |
| **Hay que sacar también 0015 (v4 → v3)** | **Primero la app** (fila anterior), cerrar y reabrir las PWA, y recién entonces `docs/rollback-leche-v4.sql` entero en el SQL Editor (trae su `begin`/`commit` y el `notify`). **Se pierden:** todos los desechos y el total "Leche desechada", todo "sobró", la cantidad de biberones, las marcas de liberado y de leche perdida, el registro de ediciones; se anulan los contenedores desechados, los liberados con leche perdida y los de números repetidos sin leche; sus extracciones pierden el reparto izq/der (el total queda). Trae un respaldo opcional comentado (`milk_backup_v4`): leelo antes. Probado: esquema idéntico a 0001–0014, re-ejecutable, y 0015 vuelve a entrar después (R-10) |
| **Y también 0014 (v3 → v0.12.1)** | Después del anterior, `docs/rollback-leche.sql` (encadenable, probado: deja 0001–0013 idéntico y la suite v0.12.1 118/118). **Se pierden** contenedores, porciones y repartos izq/der y leche/fórmula; los totales quedan |
| Todo salió mal | Restaurar el backup del paso 2 (abajo) |

**Restaurar el backup — último recurso.** Pierde **todo** lo registrado después
del backup (pañales y sueño incluidos). Nunca se probó una restauración de este
proyecto **[NO VERIFICADO]** (`handoff-2026-09-25.md` lo marca como pendiente):
hacelo con tiempo y, si podés, primero en una base de prueba local. La forma
general es `pg_restore --clean --if-exists --no-owner -d "<conexión directa>"
archivo.dump`, sobre la conexión directa; si el dump no tiene `auth`, los
logins no vuelven (`seguridad-operacional.md` §10.2). Antes, la app en
v0.12.1 (fila de arriba).

## 13. Riesgos que decide el dueño

1. **La ventana de despliegue.** Desde 3b hasta que el último aparato muestre
   0.13.0, lo que registre de leche un aparato viejo queda fuera del inventario
   y "Lo que hay" puede quedar por encima de la heladera. Mitigación: pasos 0,
   10 y la consulta del paso 11.
2. **El reloj de los teléfonos** (D-15). Una toma o extracción más de 10 min en
   el futuro se rechaza; "Desechar" lo decide la hora del servidor. Un teléfono
   con el reloj **atrasado** todavía puede servir leche ya vencida en una toma
   "de ahora" (riesgo escrito, no cerrado). Conviene hora automática en los dos.
3. **Las decisiones D-x** de `milk-v4-para-aprobar.md` §10. Si mamá cambia
   alguna después de publicar, es una versión nueva y quizá otra migración.
4. **`max_rows`** (paso 1c): si es < 1000, las sumas salen cortas sin aviso.
5. **Node 24 en Vercel** (paso 8): si el build falla, la base queda migrada con
   la app vieja hasta resolverlo.
6. **Previews contra la base real** (paso 9, `CLAUDE.md` §7.8).
7. **La reversa pierde datos** (paso 12): desechos, sobró, ediciones, reparto
   izq/der de algunas extracciones. Y un riesgo residual escrito en
   `compatibilidad-v4.md` §5.2: si tras la reversa alguien **escribe a mano**
   los lados de una extracción vuelta legada, la app vieja le crea un biberón
   con esa leche.
8. **Defecto previo de v0.12.1, no corregido:** la hora por defecto de "Leche"
   es la de abrir la página o del último guardado, no la de tocar "Registrar".
   En v4 eso hace vencer la leche **antes** (lado seguro) y puede alterar el
   orden "más vieja primero" (`progreso-feeding-v4.md`, H5).
9. **Leche que no vuelve** (D-9) y "Desechar" que no se deshace (D-11): la
   familia tiene que saberlo (`reglas-de-uso-familia.md` §3 y §9).
10. **Un backup que nunca se restauró** no está probado como backup.
