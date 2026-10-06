# Runbook — desplegar el inventario de leche sobre producción v0.12.1

Para el dueño, a mano, en orden. Nada de esto lo ejecutó el agente: **no hubo
push ni se tocó la nube**. Cada paso dice qué esperar y cómo volver atrás.

- Producción hoy: **v0.12.1** = commit `0cbe798` (`origin/main`).
- A publicar: rama **`feat/milk-inventory-v3-release`** (worktree
  `~/proyectos/amelia_app-release`), que es `0cbe798` + el inventario. Avanza en
  línea recta sobre `origin/main`: el push es un avance rápido, sin merge.
- Migraciones: la del papá **`0013_changer_display_scopes.sql`** (puede estar ya
  aplicada) y la nuestra **`0014_milk_inventory.sql`** (no está en la nube).
- Versión propuesta: **0.13.0** (MINOR: funcionalidad nueva visible y una
  migración que la acompaña, `CLAUDE.md` §4.1). La subís vos en el paso 5.

Documentos: `docs/compatibilidad-leche.md` (qué pasa con teléfonos viejos),
`docs/verificar-antes-leche.sql`, `docs/rollback-leche.sql`,
`docs/comparacion-v0.12.1.md`.

---

## 0. Antes de empezar (5 min)

- Elegí un momento **sin una toma en curso** y avisá a la otra persona que no
  registre nada durante ~15 min (sobre todo leche).
- Tené a mano: la contraseña de la base de producción (conexión **directa**,
  puerto 5432), acceso al panel de Supabase (SQL Editor) y al de Vercel.

## 1. Respaldo de producción — `pg_dump`

Seguí `docs/seguridad-operacional.md` §10.2 al pie de la letra (conexión directa,
no el pooler; formato custom; `pg_dump` de versión ≥ la del servidor):

```
pg_dump -Fc -d "postgresql://postgres:<PASS>@db.<ref>.supabase.co:5432/postgres" -f "amelia-prod-2026-MM-DD-pre-leche.dump"
pg_restore -l "amelia-prod-2026-MM-DD-pre-leche.dump"
```

Esperado: el `pg_restore -l` lista las 15 tablas. **Si sale vacío o corto, no
sigas.** Vuelta atrás de este paso: no hace falta (no cambia nada).

## 2. Saber qué hay de verdad en la nube (solo lectura)

SQL Editor → pegá **entero** `docs/verificar-antes-leche.sql` → Run. No escribe
nada (se probó en local dentro de una transacción `READ ONLY`).

Esperado:

| Fila | Esperado | Si no |
|---|---|---|
| 0001 … 0012 | `true` | **Pará.** Producción no está donde creemos; no sigas sin revisar |
| 0013_changer_display_scopes | `true` o `false` | `false` → hacé el paso 3a |
| 0014_milk_inventory (DEBE dar false) | `false` | `true` → **pará**: alguien aplicó parte del inventario |

Anotá además los conteos de la consulta 5 (para comparar en el paso 9).

## 3. Aplicar las migraciones que falten, en orden

### 3a. Solo si 0013 dio `false`

SQL Editor → pegá esto (el contenido del archivo entre `begin` y `commit`):

```sql
begin;
-- pegá acá el contenido de supabase/migrations/0013_changer_display_scopes.sql
commit;
```

Verificá: la fila 0013 de `verificar-antes-leche.sql` da `true`.
Vuelta atrás: no hace falta; solo ensancha los scopes permitidos de `device_tokens`.

### 3b. La del inventario: `0014_milk_inventory.sql`

**Hacé el paso 4 enseguida después de este.** Desde acá hasta que los teléfonos
se actualicen, la app vieja corre contra la base nueva: está probado que no
desfasa el inventario (`docs/compatibilidad-leche.md` §3), pero muestra errores
crudos si alguien edita una toma o extracción nueva.

El archivo **no trae** `begin/commit` propio. Pegalo envuelto, para que si algo
falla no quede a medias:

```sql
begin;
-- pegá acá el contenido COMPLETO de supabase/migrations/0014_milk_inventory.sql
commit;
```

Esperado: termina sin `ERROR`. Si aparece un error, el `begin` hace que no quede
nada aplicado: anotá el mensaje y **no sigas** (no pushees).

Verificá corriendo otra vez `docs/verificar-antes-leche.sql`: la fila 0014 ahora
da **`true`** (es lo esperado *después*), y 0001–0013 siguen en `true`.

Si en la nube existe `supabase_migrations.schema_migrations` (consulta 4) y
querés mantenerlo al día, opcional:
`insert into supabase_migrations.schema_migrations(version) values ('0014_milk_inventory');`
(y `'0013_changer_display_scopes'` si la aplicaste en 3a). No cambia el
comportamiento de nada.

Vuelta atrás de este paso: `docs/rollback-leche.sql` (paso 10).

## 4. Recargar el esquema de PostgREST

```sql
notify pgrst, 'reload schema';
```

Por qué: sin el caché recargado, las funciones nuevas (`log_bottle_feed`, …) dan
404 y la app nueva lo muestra como error. En el stack local la recarga es
automática (event triggers) y el script de migración además manda este
`notify`; **en la nube no se pudo comprobar** si los event triggers existen, así
que mandalo igual: es inocuo.

Comprobación (opcional, solo lectura): en el SQL Editor
`select proname from pg_proc where proname in ('log_bottle_feed','log_pumping_session');`
→ 2 filas.

## 5. Checklist previo al push (en el VPS)

```bash
cd ~/proyectos/amelia_app-release
git status --short                      # vacío
git fetch origin
git rev-parse origin/main               # 0cbe798e4befdbe267a36c5182ff55ad138c18a1
git merge-base --is-ancestor origin/main HEAD && echo "avance rápido OK"
```

Si `origin/main` ya no es `0cbe798`, **pará**: alguien publicó otra cosa; hay que
integrarla antes (no fuerces el push).

**Versión y CHANGELOG (§0.1 de `CLAUDE.md`, obligatorio):** subí `version` a
`0.13.0` en `package.json` y agregá arriba de `CHANGELOG.md` una entrada
`## [0.13.0] - AAAA-MM-DD` (en inglés, en términos de quien usa la app). Texto
sugerido:

```
## [0.13.0] - 2026-MM-DD

- Keep a breast-milk stash: each pumping session is logged left and right and fills its own container (M1, M2…), with the tape number you write on it.
- Build each bottle from the stash: it suggests the last bottle's amount, takes the oldest milk first and tops up with formula.
- Know what there is: the Milk page shows the usable milk in oz, and fridge milk stops counting when it expires (rules in Settings → Milk storage).
- Deleting a bottle gives its milk back; a pumping session whose milk was already served can't be deleted.
- Works offline like the rest of the app.
```

Después:

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm lint
pnpm format:check
pnpm test            # incluye changelog.test.ts: versión == primera entrada
pnpm build
git add package.json CHANGELOG.md
git commit -m "Release 0.13.0 with the breast-milk inventory"
git fetch origin && git diff origin/main -- package.json | grep '^+.*"version"'   # tiene que imprimir la línea
```

(`pnpm test:all` necesita el stack local levantado; se corrió en verde en la
verificación de esta rama — ver el handoff.)

## 6. Previews de Vercel — leer antes de pushear

Según `CLAUDE.md` §7.8, **Preview y Producción usan la misma base de Supabase**
(lo afirmó Luis; desde el VPS se confirmó solo la mitad de producción) y la
Deployment Protection de Preview estaba prendida el 25 sep. Por eso:

- **No pushees la rama `feat/milk-inventory-v3-release` como rama propia** antes
  del paso 3b: crearía un Preview con la app nueva contra la base de producción
  sin migrar (todas las funciones de leche darían 404), y cualquier prueba ahí
  escribe datos reales.
- El paso 7 empuja **directo a `main`**, que no crea un Preview de rama.
- Si igual se creara un Preview, **no lo abras** hasta haber hecho el paso 3b.

[NO VERIFICADO] la configuración real de variables por entorno en Vercel: no hay
`.vercel/` ni CLI de Vercel en el VPS.

## 7. Push (lo hacés vos)

Desde el worktree de release (el de `main`, `~/proyectos/amelia_app`, tiene
cambios sin commitear: no lo uses para esto):

```bash
cd ~/proyectos/amelia_app-release
git push origin feat/milk-inventory-v3-release:main
```

Es un avance rápido sobre `0cbe798`; si el remoto lo rechaza por no ser avance
rápido, **no uses `--force`**: volvé al paso 5. Vercel despliega solo (~1 min).
Comprobá en GitHub/Vercel que el deployment de Production del commit nuevo
termina en verde.

Después, si querés tu `main` local al día (opcional, cuando el worktree de main
no tenga cambios pendientes): `cd ~/proyectos/amelia_app && git merge --ff-only origin/main`.

## 8. Actualizar la PWA en cada aparato

`public/sw.js` no cambió (sigue `amelia-v6`): las páginas se piden primero a la
red, así que el código nuevo llega **en la próxima carga completa**. Una pestaña
o PWA que quedó abierta sigue con el JS viejo en memoria.

- **Cada teléfono:** cerrar la app del todo (deslizarla fuera del selector de
  apps) y volver a abrirla, **con conexión**. Comprobación: Ajustes muestra
  "Milk storage / Conservación de la leche", y Menú → al pie, la versión 0.13.0.
- **Pantalla de pared:** recargar la página (o reiniciar el kiosco).
- Si un aparato tenía entradas "Not synced yet" de antes del cambio, dejalas
  sincronizar **antes** de cerrar la app.

## 9. Prueba de humo (5 min, en un teléfono ya actualizado)

| Hacer | Tiene que pasar |
|---|---|
| Leche → registrar izq 1 oz / der 1 oz con la cinta sugerida | Aparece en la lista con su M#; "Lo que hay" sube 2 oz |
| Hoy → Comida → "Dale X oz" → registrar tal cual | La toma aparece; "Lo que hay" baja lo servido |
| Historial → ⋯ en esa toma → Borrar | La leche vuelve a "Lo que hay" |
| Historial → ⋯ en la extracción → Borrar | Se borra (no está servida); si la serviste antes, la app lo impide |
| Hoy → pañal | Se registra (lo de siempre sigue andando) |
| Ajustes → Conservación → mirar | Se ven 4 h / 4 días / 6 meses |
| Pantalla del cambiador (si está encendida) | Sigue mostrando el estado y registra un pañal |

Y en el SQL Editor, solo lectura:
`select label, amount_ml, remaining_ml from milk_containers where voided_at is null order by stored_at desc limit 5;`

Para limpiar la prueba: borrá desde la app lo que registraste (no a mano en SQL).

## 10. Vuelta atrás, por paso

| Si falla en… | Qué hacer |
|---|---|
| 1–2 | Nada que deshacer |
| 3a | No hace falta deshacer 0013 |
| 3b con error | El `begin` evita que quede aplicada; confirmalo con `verificar-antes-leche.sql` (0014 = `false`) |
| 4–6, antes del push | Si querés sacar 0014: `docs/rollback-leche.sql` (ver abajo). Si no, se puede quedar: la app vieja convive (compatibilidad §3) |
| Después del push, problema de la **app** | En Vercel → Deployments → el de v0.12.1 → *Promote to Production* (o `git revert` del rango y push). La base puede quedar con 0014: la app vieja funciona salvo editar/borrar lo creado por la nueva (bloqueo visible, sin desfase). Teléfonos con entradas de leche sin sincronizar de la app nueva verán un banner por entrada y tendrán que Descartarlas (compatibilidad §4) |
| Después del push, hay que sacar **también** la base | Primero volvé la app (fila anterior), cerrá/reabrí las PWA, y recién entonces corré `docs/rollback-leche.sql` en el SQL Editor (trae su `begin/commit` y el `notify`). **Se pierden** los contenedores, las porciones y los repartos izq/der y leche/fórmula (los totales quedan); el encabezado del archivo lo detalla y trae un respaldo opcional comentado. Probado en un Postgres efímero: tras la reversa el esquema es idéntico a 0001–0013 y la suite de v0.12.1 pasa 118/118 |
| Todo salió mal | Restaurar el dump del paso 1 (`docs/seguridad-operacional.md` §10) |
