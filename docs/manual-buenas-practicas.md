# Manual de buenas prácticas — Amelia App

Cada regla de acá cita un archivo **de este repo**. Si una regla no puede citar
código propio, no entra: este manual es una traducción del de FRUCO, no una
copia, y lo que no aplica a este stack se quedó afuera (no hay Prisma, no hay
Express, no hay multi-empresa por `empresa_id`; acá es multi-familia por RLS).

---

## 1. La identidad de una fila la genera el cliente

Los ids se generan en el navegador, con `newId()` en `lib/queue.ts:47`.

No es un capricho ni un gusto estético. Es lo que permite **empezar y terminar
una sesión estando offline**: Postgres acepta un `id` explícito por encima de su
`default gen_random_uuid()`, así que una sesión de lactancia iniciada sin
conexión y terminada sin conexión son un insert y un update que apuntan a un id
que ya elegimos nosotros, y que replayean en orden cuando vuelve el wifi.

**Corolarios:**

- Nunca un nombre, un email ni una fecha como llave. Un uuid, siempre.
- Nunca dependas de que la base te devuelva el id después de insertar: ya lo
  tenías antes.

---

## 2. Una sola puerta a la base

**Las páginas nunca arman una query.** Todo pasa por `lib/db.ts`.

Verificado el 20 sep 2026: `grep -rn "\.from(" app components lib` devuelve
únicamente `lib/db.ts` y los dos route handlers de dispositivo. Esa es la
línea que hay que mantener.

**Por qué importa, en concreto:** en la fase 2 este directorio pasa a ser
`apps/amelia` dentro del monorepo del Hub y la base deja de ser propia. Si todas
las queries viven en un archivo, esa migración es **un archivo editado**. Si
están repartidas en doce páginas, es una semana.

Los route handlers de `app/api/*` son la excepción que ya existe, y **no se
amplía**: corren con `service_role` y saltan RLS, así que cuantos menos haya,
mejor.

---

## 3. El aislamiento entre familias lo hace Postgres, no un `where`

Lo que impide que una familia vea los datos de otra es RLS: las funciones
`is_family_member()` e `is_baby_family_member()` de
`supabase/migrations/0001_init.sql`, aplicadas como policy en las 11 tablas.

**No es un filtro que el código agrega.** Un `where family_id = ...` se puede
olvidar; una policy no. Si mañana alguien escribe
`supabase.from('feedings').select('*')` sin filtro alguno, Postgres devuelve
solo lo de su familia igual.

### Toda tabla nueva nace con RLS **y GRANT** en la misma migración

Sin excepciones, y el "y GRANT" no es adorno. El bug de
`0005_grant_authenticated.sql` es la lección más cara de este repo: las policies
estaban perfectas, pero al rol `authenticated` nunca se le habían dado
privilegios de tabla. **Postgres bloquea antes de evaluar la policy**, así que
toda consulta desde la app devolvía vacío y la policy parecía el culpable.

### El test es obligatorio

Dos familias, una no ve a la otra: `tests/integration/rls.test.ts`. Corre contra
el stack completo (PostgREST + GoTrue + Kong), no contra un Postgres pelado con
`SET ROLE`, justamente porque el bug de `0005` solo aparece por el camino real.

---

## 4. Las dos llaves

| Archivo | Llave | Dónde puede vivir | Qué la limita |
| --- | --- | --- | --- |
| `lib/supabaseClient.ts` | `anon` | Browser. Es pública por diseño. | RLS. |
| `lib/supabaseAdmin.ts` | `service_role` | **Solo** route handlers. | Nada: salta RLS por completo. |

**`lib/supabaseAdmin.ts` nunca entra a un archivo `'use client'`.** Si entra, la
`service_role` se embarca en el bundle del navegador y cualquiera con la consola
abierta lee y escribe toda la base, de todas las familias.

**Nunca prefijes un secreto con `NEXT_PUBLIC_`.** Ese prefijo es literalmente la
instrucción "mandá esto al browser". Hoy solo la URL y la anon key lo llevan, y
las dos son públicas a propósito.

Los dos endpoints que corren con `service_role` —`/api/ingest` y
`/api/quick/nurse`— se autentican con un secreto de dispositivo
(`lib/deviceAuth.ts`), no con una sesión de usuario, y tienen hallazgos abiertos
en `auditorias/2026-09-20-auditoria-inicial.md` (C1 y C2). Leelos antes de tocar
cualquiera de los dos.

---

## 5. Tipos

`lib/types.ts` es el **stand-in** de los types generados de Supabase que llegan
en la fase 2. Por eso los campos calcan los nombres de las columnas: el día que
se reemplace por `packages/db/types`, el swap es un swap y no una traducción.

No inventes un nombre más lindo para un campo. `amount_ml` se llama `amount_ml`.

---

## 6. Convenciones de datos

Estas cuatro no se negocian, y cada una tiene un test que la fija:

| Convención | Dónde vive | Test |
| --- | --- | --- |
| Timestamps en **UTC** en la base, renderizados en `America/Los_Angeles` | `lib/format.ts:16` | `tests/unit/format.test.ts` |
| Volúmenes **siempre en ml** en la base; `oz` es display/entrada | `lib/format.ts:182-196` | idem |
| Peso y talla **siempre en kg/cm**; `lb/oz/in` es display | `lib/format.ts:147-164` | idem |
| Borrado lógico con `voided_at`, nunca un `DELETE` | `lib/db.ts`, migración `0006` | `tests/integration/rls.test.ts` |

Sobre la timezone: es la **del hogar, no la del visitante**. Un teléfono en otro
huso y la pantalla de la pared tienen que coincidir sobre a qué hora comió. Por
eso la suite unitaria corre cuatro veces, bajo `UTC`,
`America/Los_Angeles`, `Asia/Tokyo` y `Pacific/Kiritimati`
(`scripts/test-tz.sh`), y ninguna aserción puede depender de la TZ del sistema.

Sobre `voided_at`: **toda lectura filtra con `.is('voided_at', null)`.** Una
lectura que no filtra es la forma en que el borrado lógico se convierte en bug.
Hoy las cinco tablas que tienen la columna la filtran;
`growth_measurements` no tiene la columna todavía y por eso hay una propuesta
(`proposals/growth-edit-and-void.md`).

---

## 7. Honestidad de estado

Esto es una regla de **producto**, no un detalle técnico. A las 3 de la mañana,
con mal wifi, lo peor que puede hacer la app es mentir.

1. **Nada se presenta como guardado si no lo está.** Una escritura en cola se
   muestra como "not synced yet" en **todos** los lugares donde aparece.
2. **Una escritura que el servidor rechazó no se encola.** Un rechazo de policy
   o un valor inválido va a fallar igual la segunda vez: se muestra como error.
   Solo se encola lo que nunca llegó al servidor — `looksOffline()` en
   `lib/queue.ts:99`.
3. **El service worker nunca cachea una respuesta de Supabase.**
   `isCacheable()` en `public/sw.js:52` descarta todo lo que no sea same-origin.
   Las respuestas llevan tokens de auth y esto corre en una pantalla compartida.

Un ejemplo real de cómo se rompe esta regla sin querer: hasta el 20 sep 2026,
`flushQueue` devolvía `remaining: pending.length - i - dropped`. Restar los
descartes es doble conteo, y con un descarte antes de un fallo la función
reportaba **cero pendientes teniendo una escritura adentro**. Nadie leía ese
campo todavía, así que el bug estaba latente. Lo agarró un test, no una lectura.

---

## 8. Migraciones

- **Nunca edites una migración ya aplicada.** `0001`…`0006` son historia.
- **Este repo dejó de numerar.** Por ADR 0003 la numeración pasa al agente del
  Hub. Lo que corresponde acá es **proponer**, en `proposals/`.
- `supabase/schema.sql` es una vista consolidada de referencia. La fuente de
  verdad son los archivos de `supabase/migrations/`.

---

## 9. Diseño

- **Ningún hex ni px nuevo fuera de `app/globals.css`.** `lib/tokens.ts` es el
  espejo en TypeScript de esas mismas custom properties, y se actualiza junto.
- Los tokens de escala **se re-apuntan** en el breakpoint de 1180px. No se
  bifurcan los componentes: el mismo `<Card>` sirve al teléfono y a la pantalla
  de pared, y lo que cambia es el valor del token.
- El objetivo **primario** de diseño es la pantalla de 27" leída desde el otro
  lado del cuarto. El teléfono es el caso a una mano, de madrugada.

Detalles completos en `design.md`.

---

## 10. Tests

| Tipo | Qué cubre | Necesita | Comando |
| --- | --- | --- | --- |
| Unit | `lib/format.ts`, `lib/queue.ts` | Nada | `pnpm test` |
| Unit × 4 TZ | lo mismo, bajo cuatro timezones | Nada | `pnpm test:tz` |
| Integración | RLS, endpoints de dispositivo | Docker + `pnpm db:up` | `pnpm test:integration` |
| Todo | | Docker | `pnpm test:all` |

**Lo que NO hay:** tests de componentes ni de páginas. No los inventes de
apuro; cuando hagan falta, `@vitejs/plugin-react` es una línea en
`vitest.config.ts`.

**La regla de las cuatro timezones:** cualquier test que toque fechas u horas
tiene que dar el mismo resultado bajo las cuatro. Si una falla, es un bug real
de `lib/format.ts` y se reporta **antes** de corregir.

**Un test no se ablanda para que pase.** Si una aserción sobre una policy falla,
puede ser que la policy sea más laxa de lo que dice la doc — y eso es un
hallazgo de seguridad, no una aserción mal escrita.

---

## 11. Commits

Las del historial real de este repo. **No se usa Conventional Commits.**

- Frase **imperativa en inglés**, en una línea, sin prefijo
  `feat:` / `fix:` / `chore:`.
- Describe el **efecto para quien usa la app**, no el archivo tocado.
- Sin cuerpo, sin referencias a issues.
- Se acepta el prefijo informal `Fix:` para un arreglo puro.

Ejemplos reales:

```
Add an oz/ml unit toggle for bottle and pumping amounts
Make it installable and able to survive bad wifi
Pin search_path on the RLS helper functions
Fix: grant table privileges to authenticated role (RLS was blocked by missing GRANTs)
```

---

## 12. Apéndice — frases que delatan deuda

Si te escuchás diciendo alguna de estas, pará.

> **"Total RLS lo tapa."**
> RLS tapa el acceso del usuario. No tapa un route handler con `service_role`,
> que es exactamente donde están los dos hallazgos críticos de este repo.

> **"Esto lo valido en la página."**
> Entonces no está validado. La página es una de varias entradas, y ninguna
> valida por las otras. Va en `lib/db.ts`, en la policy o en el handler.

> **"Le pongo el hex acá nomás."**
> Ahí nace el tercer lugar donde vive el mismo color, y el día que cambie, dos
> se actualizan y uno no.

> **"Después le hago el test."**
> Este repo vivió meses con `PROJECT.md` afirmando que había tests de timezone
> y cero tests en disco. "Después" tiene un historial.

> **"Lo encolo y listo."**
> Encolar lo que el servidor **rechazó** no lo salva: lo va a rechazar igual.
> Y mientras tanto la UI dice que está por guardarse. Eso es mentirle a alguien
> a las 3 de la mañana.

> **"Es solo un `console.log` para debuggear."**
> En una pantalla de pared compartida, un log con datos de la bebé queda ahí.
> Hoy hay cero `console.*` en `app/`, `lib/` y `components/`. Que siga así.
