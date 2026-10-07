# Runbook — desplegar el inventario de leche v5 sobre producción 0.13.0

Para el dueño, a mano, en orden. **Nada de esto lo ejecutó el agente: no hubo
push, ni merge a `main`, ni se tocó la nube.** Los comandos están escritos para
copiarlos; cada paso dice qué esperar y cómo volver atrás.

| Qué | Valor |
|---|---|
| Producción hoy | **0.13.0** = `66462fa` (`origin/main` al crear la rama), con **0014 y 0015 aplicadas en la nube** (dato del dueño; desde el VPS no hay credenciales para comprobarlo: el paso 1 lo comprueba) |
| A publicar | rama **`feat/milk-inventory-v5`** (worktree `~/proyectos/amelia_app-v5`), avance rápido sobre `66462fa` |
| Migración a aplicar en la nube | **`0016_milk_phase3_4`** — ANTES del código |
| Versión propuesta | **0.14.0** (paso 5). La rama sigue en `0.13.0`: el bump lo hace el dueño |

Documentos de apoyo: `docs/compatibilidad-v5.md` (qué pasa con teléfonos
viejos, reversa y qué se pierde, con evidencia), `docs/verificar-antes-v5.sql`,
`docs/rollback-leche-v5.sql`, `docs/milk-v5-para-aprobar.md`,
`docs/progreso-feeding-v5.md`, `docs/spec-feeding-v5.md`.

---

## 0. Puerta: la aprobación de mamá y papá

`docs/milk-v5-para-aprobar.md` tiene que volver **firmado por los dos**, con cada
sección y cada decisión (D5-1…D5-20 y las de los roles) marcada.

- **Sin las dos firmas, no se sigue.** Si algo dice "Cambiar", es trabajo de
  código (y quizá de 0016) antes de desplegar: 0016 todavía no está en la nube,
  cambiarla ahora es barato.
- Si papá/pediatra cambian una **constante** (60 min de enfriado, 60 min del
  empezado, 48 h de la Similac, 8 oz por botella), cambia `lib/milkParams.ts` **y**
  0016 (las dos tienen el número; `tests/unit/milkParams.test.ts` falla si se
  separan). Las otras constantes (3.5 oz, +1 oz, 120 min, 6 h, 8 oz de aviso,
  paquete de 6, 72 h) son solo de la app.
- Elegí un momento **sin una toma en curso** y avisá a la otra persona que no
  registre **leche ni biberones** durante ~20 min. Pañales, sueño y lactancia se
  pueden seguir anotando (0016 no los toca).

## 1. Verificación previa (solo lectura) — `docs/verificar-antes-v5.sql`

SQL Editor de Supabase. Corre dentro de `begin transaction read only` …
`rollback`: no puede escribir. El editor puede mostrar solo la última consulta:
seleccioná `begin transaction read only;` + **una** consulta numerada +
`rollback;`, Run, y la siguiente.

| Consulta | Esperado | Si no |
|---|---|---|
| 1 | 0014 **t**, 0015 **t**, 0016 **f** | 0014 o 0015 en `f`: **pará** (producción no está donde creemos; ver los runbooks de v4). 0016 en `t`: ya está aplicada — saltá el paso 3 y revisá la consulta 2 |
| 2 | **las 21 filas `f`** | Una sola `t` = algo de 0016 quedó a medias: **pará** |
| 3 | **0** en las 8 filas | Un número > 0 = 0016 se va a abortar sola con `milk_invariant_broken` (sin aplicar nada). Revisá esos datos antes |
| 4 | conteos informativos | Qué va a tocar: cuántos biberones van a decir "Enfriando" (los de la última hora), cuántos desechos hay (todos tienen que tener biberón), tomas con "Sobró" de la última hora (Hoy dirá "sirve hasta…") |
| 5 | informativa | El historial de migraciones no es la verdad; la verdad son 1 y 2 |
| 6 | conteos | **Anotalos**: se comparan con el backup y con la prueba de humo |
| 7 | 0 y 0 | Mejor esperar a que no haya lactancia ni sueño abiertos |

Probado en local (`compatibilidad-v5.md` §5): en 0001–0015 da 0016 `f` y 0/21;
con 0016, `t` y 21/21.

**`max_rows`** sigue valiendo lo del runbook v4 §1c: si el proyecto corta en
menos de 1000 filas, las sumas salen cortas sin aviso.

## 2. Backup de producción (`pg_dump`)

Igual que `runbook-despliegue-v4.md` §2 (`docs/seguridad-operacional.md`
§10.2): en tu computadora, conexión directa, formato custom, y comprobar con
`pg_restore -l` que lista las **19 tablas** del proyecto (todavía sin
`milk_ops`, `milk_transfers`, `formula_containers`). Sin ese archivo, no se
sigue.

## 3. Aplicar 0016 — ANTES de que salga el código

**El orden es: base primero, push después.** La app v5 sobre una base sin 0016
recibe 404 en toda función nueva (combinar, "ya está fría", Similac, desechar el
empezado) y la extracción manda un argumento que la función vieja no tiene
(`p_fridge_at`): **no podría registrar ni una extracción**. Al revés —0016 con la
app 0.13.0— está probado que convive (`compatibilidad-v5.md` §1–§3).

**Hacé 3, 3b y el push (paso 7) seguidos**, sin pausas largas: ese tramo es la
ventana (§9).

### 3a. `0016_milk_phase3_4.sql`

A diferencia de 0015, **0016 trae su propio `begin;` … `commit;`**: pegá el
archivo entero tal cual y Run. Si algo falla (por ejemplo
`milk_invariant_broken`), la transacción no se aplica: corré `rollback;` por las
dudas y confirmalo con la consulta 1 de `verificar-antes-v5.sql` (0016 `f`).
Termina con `notify pgrst, 'reload schema'`.

Después: consulta 1 → 0016 **t**; consulta 2 → **21/21 t**.

### 3b. Recargar el esquema de la API

```sql
notify pgrst, 'reload schema';
```

Inocuo aunque 0016 ya lo haya mandado. Comprobación (solo lectura):

```sql
select proname, pg_get_function_identity_arguments(oid)
from pg_proc where proname in ('log_pumping_session', 'milk_combine', 'formula_open');
```

→ 3 filas, `log_pumping_session` con **11** argumentos (el último `p_fridge_at`).

## 4. Checklist previo al push (en el VPS)

```bash
cd ~/proyectos/amelia_app-v5
git status --short                         # vacío (salvo el paso 5)
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm lint
pnpm format:check
pnpm build
pnpm db:reset                              # stack local 0001–0016 en 127.0.0.1 (BORRA la base local)
pnpm test:all                              # unitarias x4 husos + integración
```

Esperado: todo exit 0 (números de la última corrida en
`progreso-feeding-v5.md`). Antes, `grep -c supabase.co .env.test .env.local` →
0 y 0.

**Suites de compatibilidad** (las apps viejas contra la base local con 0016;
worktrees desacoplados, se borran al terminar):

```bash
cd ~/proyectos
git -C amelia_app-v5 worktree add --detach ../amelia_app-c1 0cbe798
git -C amelia_app-v5 worktree add --detach ../amelia_app-c2 66462fa
for d in amelia_app-c1 amelia_app-c2; do
  cp amelia_app-v5/.env.test amelia_app-v5/.env.local "$d/"
  (cd "$d" && pnpm install --frozen-lockfile && pnpm exec vitest run tests/integration --maxWorkers=2)
done
git -C amelia_app-v5 worktree remove --force ../amelia_app-c1
git -C amelia_app-v5 worktree remove --force ../amelia_app-c2
```

Esperado (`compatibilidad-v5.md` §1): v0.12.1 **118/118**; 0.13.0 **309/310**,
y la única falla es `milkV4Schema` I-101 (`expected '22|22' to be '19|19'`: las
tres tablas nuevas, con RLS). Si además falla "INV-1 por SQL", hay una
combinación viva en la base local (QA-4): no es regresión. Cualquier otra falla:
**pará**.

## 5. Versión: 0.14.0

**MINOR** (`CLAUDE.md` §0.1 y §4.1): funcionalidad nueva visible y la
migración que la acompaña. **No lo subió el agente.**

1. `package.json`: `"version": "0.14.0"`.
2. `CHANGELOG.md`, arriba de `## [0.13.0]`, en inglés y para quien usa la app.
   Texto sugerido [NO VERIFICADO contra cada etiqueta en pantalla: revisalo con
   `lib/i18n/en.ts` antes de commitear]:

```
## [0.14.0] - 2026-MM-DD

The next bottle now comes with a recipe, and the app keeps track of Similac.

- **A recipe for the next bottle** on Today: how much breast milk and how much Similac, using
  cold milk that hasn't expired, oldest first, and telling you how many feeds the cold milk
  covers. "If crying" asks for just 1 oz more when the last feed ended less than 2 hours ago.
  You can set a fixed amount of formula. Everything can still be changed before logging.
- **Cooling:** freshly pumped milk shows "Cooling · ready ~HH:MM" for an hour. If you've
  checked it, "It's cold now" marks it ready. It still expires 4 days after pumping.
- **Combine bottles:** pour cold, unexpired bottles into one. It takes the earliest expiry and
  the others become free. You can undo it while the milk it received is still there.
- **Similac stock:** log a purchase (6 × 8 oz by default), "I opened a Similac", and see how
  much is left, how much a day you use and when to buy more. An open bottle lasts 48 hours;
  after that it says "Expired" with a Discard button. Formula never blocks a feed.
- **Started bottle:** what was left over in a bottle is good for an hour. After that Today says
  it's no longer good and offers to discard it.
- In Settings, the room-temperature and freezer rules moved under "Not used yet".
```

3. Comprobar y commitear:

```bash
pnpm test                                   # incluye tests/unit/changelog.test.ts
git add package.json CHANGELOG.md
git commit -m "Release 0.14.0 with the bottle recipe, cooling, combining and Similac stock"
```

## 6. PWA y service worker

`public/sw.js` **no cambió** en la rama (sigue `amelia-v6`; `git diff 66462fa
HEAD -- public/` vacío) y **no hace falta subirlo**: las páginas se piden
primero a la red (`request.mode === 'navigate'`, red y después caché) y el
código de cada versión va en archivos con hash propio (`/_next/static/...`), así
que una carga **con conexión** trae v5. No hay pantallas nuevas que precalentar
(`lib/offlinePages.ts` y `middleware.ts` sin cambios). Lo que sí hay que saber:
un aparato que abre la app **sin conexión** sirve la copia guardada, que puede
ser 0.13.0, hasta su próxima carga con red — es parte de la ventana (§9).

- **Cada teléfono:** cerrar la app del todo y abrirla **con conexión**.
  Comprobación: Menú → al pie, **0.14.0**; en Hoy, la línea "Próximo biberón:
  …"; en Leche, la tarjeta "Similac" y "Combinar biberones".
- **Pantalla de pared:** recargar o reiniciar el kiosco.
- Entradas "Todavía sin sincronizar" de antes: dejarlas sincronizar **antes** de
  cerrar la app.
- **Regla:** no registrar leche ni biberones desde un aparato que no muestra
  0.14.0 (ver §9).

## 7. Integración y push (lo hacés vos)

Igual que `runbook-despliegue-v4.md` §7, desde el worktree v5:

```bash
cd ~/proyectos/amelia_app-v5
git fetch origin
git rev-parse origin/main                   # 66462fa… (si no, integrá origin/main y volvé al paso 4)
git merge-base --is-ancestor origin/main HEAD && echo "avance rápido OK"
git diff origin/main -- package.json | grep '^+.*"version"'   # TIENE que imprimir "+  \"version\": \"0.14.0\","
git push origin feat/milk-inventory-v5:main
```

Si el `grep` no imprime nada: **no pushees**. Nunca `--force`. Empujar solo a
`main` no crea un Preview de la rama: **no pushees la rama sola antes del paso
3** (un Preview usa la **misma base** de producción, `CLAUDE.md` §7.8). Después
del push, Vercel despliega solo; si el build falla, producción sigue en 0.13.0
con 0016 puesta (convive).

## 8. Prueba de humo en producción (≈15 min, en un teléfono ya en 0.14.0)

| Hacer | Tiene que pasar |
|---|---|
| Leche → anotar una extracción en un biberón libre | "Enfriando · lista ~HH:MM" (una hora después de tocar Registrar) |
| "Ya está fría" en ese biberón | Deja de decir "Enfriando" |
| Hoy → la línea "Próximo biberón" | "X de leche + Y de Similac" con leche **fría**; la recién extraída aparece como "enfriando, lista ~…" y no se usa |
| "Si llora" con la última toma hace < 2 h | Propone 1 oz |
| Leche → Similac → "Anotar compra" (6) y "Abrí una Similac" | "6 cerradas" → "5 cerradas + 1 abierta con 8 oz"; "usar hasta" = 48 h después |
| Registrar un biberón con fórmula | La abierta baja esa fórmula |
| Combinar dos biberones fríos | El destino suma; el otro queda libre; "Lo que hay" igual; "Deshacer" lo devuelve |
| Biberón con "Sobró" | Hoy: "Sobró … · sirve hasta …" |
| Historial | Las filas nuevas; "Combinado …" |
| Hoy → pañal; pantalla del cambiador | Se registran |

Y en el SQL Editor, solo lectura, la invariante del final de 0016 (la consulta
`with srv as (` … `select count(*), min(falla …` del bloque `do` final, cambiando
el `do` por un `select falla, id from fallas`) → **0 filas**.

**Lo que no se pudo probar en el VPS y se prueba acá** [NO VERIFICADO hasta
entonces]:

- **iPhone / WebKit y la PWA instalada** (en el VPS solo hay Chromium headless):
  las tarjetas nuevas, el selector de combinar y los `confirm` con dedo.
- **Red real** y un rato en modo avión: combinar, "ya está fría", abrir Similac
  y desechar el empezado sin conexión; volver a la red y ver que la marca "sin
  sincronizar" se va y nada se duplica.
- **Las esperas reales:** 60 min de enfriado (que la marca se vaya sola), 60 min
  del biberón empezado ("ya no sirve" + Desechar), **48 h** de una Similac
  abierta ("Caducada" + Desechar) y el aviso de 6 h antes. En el VPS se probaron
  con el reloj adelantado (`page.clock`) y horas pasadas por SQL, no esperando.
- **La nube:** que 0016 corra en el SQL Editor como en psql, `notify pgrst` y
  los permisos del proyecto.

**Limpieza:** borrá desde la app lo registrado (la toma, la extracción; deshacé
la combinación de prueba y borrá la Similac de prueba con su ⋯ si la hay), no a
mano en SQL.

## 9. Riesgos de ventana (desde 3a hasta que el último aparato muestre 0.14.0)

Probado que **ninguna escritura de 0.13.0 desfasa el inventario** ni se cae una
pantalla (`compatibilidad-v5.md` §1–§3). Lo que sí puede ver la familia:

1. **Un biberón origen de una combinación** aparece en la Leche de 0.13.0 con
   "Ya se sirvieron … de acá" (es falso: se pasó a otro biberón).
2. **Borrar o vaciar una extracción combinada** desde 0.13.0 da un error en
   inglés crudo, `milk_combined:M#` (0.13.0 no conoce el código). No escribe
   nada; en v5 se deshace la combinación primero.
3. **"Leche desechada"** de la Leche de 0.13.0 **suma** los biberones empezados
   desechados (v5 no los suma, D5-11) y el Historial de 0.13.0 los muestra como
   "Leche desechada · ? · …".
4. **0.13.0 no conoce el enfriado:** ofrece leche que v5 dice "Enfriando".
5. **0.13.0 no descuenta Similac**… pero tampoco hace falta: el consumo se
   deriva de la fórmula de cada toma (D5-13), así que un biberón con fórmula
   registrado desde 0.13.0 **sí** baja la abierta en v5.
6. **Sin conexión, la vista local de 0.13.0** puede mostrar un destino combinado
   con menos leche hasta sincronizar (la base decide bien).
7. **v5 sobre una base sin 0016** (si se pushea antes del paso 3): no registra
   extracciones ni nada nuevo. **Orden: 0016 primero.**

Mitigación: pasos 0, 6 y "no registrar leche desde un aparato viejo".

## 10. Vuelta atrás, por paso

| Si falla en… | Qué hacer |
|---|---|
| 0–2 | Nada que deshacer |
| 3a con error | No quedó aplicada (una transacción). `rollback;` y consulta 1 |
| **Después del push, problema de la app** | Vercel → Deployments → el de 0.13.0 → *Promote to Production* (o `git revert` del rango y push, con su propio bump §0.1). La base **puede quedar en 0016**: la 0.13.0 funciona (C-2 309/310, §1); sus rarezas son las de §9. Lo encolado por v5 en un teléfono (combinar, Similac, "ya está fría", desechar el empezado) **sí** se aplica, porque las funciones siguen en la base y la cola de 0.13.0 manda cualquier `kind:'rpc'` por su nombre (`git show 66462fa:lib/db.ts`, líneas 138–144) [por lectura de código, no probado en un teléfono] |
| **Hay que sacar también 0016** | **Primero la app** (fila anterior), cerrar y reabrir las PWA; si se puede, **deshacer desde v5 las combinaciones vivas** antes de volver la app. Después `docs/rollback-leche-v5.sql` entero en el SQL Editor (trae su `begin`/`commit` y el `notify`). **Se pierden:** la Similac (compras y la abierta), los desechos de biberón empezado, el enfriado, el registro de operaciones y las combinaciones; la leche recibida y no servida de una combinación viva sale de "Lo que hay" (el NOTICE dice cuánto). Trae un respaldo opcional comentado (`milk_backup_v5`). Probado: invariante de 0015 = 0, esquema idéntico a 0001–0015, re-ejecutable, y 0016 vuelve a entrar después (`compatibilidad-v5.md` §4). Con la base revertida, lo que un teléfono v5 tenga encolado recibe 404 y queda para Descartar |
| **Y también 0015 o 0014** | Después del anterior, `docs/rollback-leche-v4.sql` y `docs/rollback-leche.sql` (runbook v4 §12) |
| Todo salió mal | Restaurar el backup del paso 2 — pierde todo lo registrado después; nunca se probó una restauración de este proyecto [NO VERIFICADO] |

## 11. Riesgos que decide el dueño

1. La ventana (§9).
2. **Las decisiones D5-x** y las constantes (`milk-v5-para-aprobar.md`): cambiar
   una después de publicar es otra versión y, para cuatro de ellas, otra
   migración.
3. **El reloj de los teléfonos:** combinar, "ya está fría", desechar el empezado y
   desechar la Similac los decide la hora **del servidor**; el enfriado y la
   receta los pinta el teléfono. Conviene hora automática en los dos.
4. **La reversa pierde datos** (§10).
5. **Previews contra la base real** (`CLAUDE.md` §7.8).
6. **Observaciones abiertas de QA** (`progreso-feeding-v5.md` H5): O-2 el desecho
   del empezado sin conexión desaparece de Hoy sin marca propia; O-3 una Similac
   creada por la base mide 236.5882365 ml y una comprada 236.588; O-4 dos
   "Combinado con M1" si dos orígenes se llamaban igual.
