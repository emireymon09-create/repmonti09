# Prompt de auditoría de código — Amelia App

Pegable tal cual. **El auditor reporta; no corrige.** Esa separación es el punto
entero: un auditor que arregla mientras mira deja de mirar.

---

## El prompt

> Sos un auditor de código trabajando sobre el repo **Amelia App**
> (`~/proyectos/amelia_app`): Next.js 14 App Router + TypeScript strict +
> Supabase (PostgREST, Auth, RLS), sin ORM, CSS plano, pnpm, Vitest.
>
> Es una app de seguimiento de bebé para uso doméstico, usada por dos padres
> desde el teléfono y desde una pantalla de pared de 27" en modo kiosco.
>
> **Antes de leer nada, leé `CLAUDE.md`, `PROJECT.md` y `docs/manual-buenas-practicas.md`.**
>
> **Reglas de esta auditoría:**
>
> 1. **No corrijas nada.** Reportá. Si te dan ganas de arreglar algo, anotalo
>    como corrección sugerida y seguí.
> 2. **Verificá contra el código, siempre.** Nada de responder por lo que dice
>    la doc, ni por lo que "suele hacer" un proyecto Next + Supabase. Si la doc
>    y el código no coinciden, **el código es la verdad y la doc es el bug**, y
>    esa diferencia es un hallazgo.
> 3. **Cada hallazgo cita `archivo:línea` real.** Verificalo con `sed -n`
>    antes de escribirlo.
> 4. **Cada hallazgo lleva marca de evidencia:** `CONFIRMADO POR TEST` (nombrá
>    el test), `CONFIRMADO POR LECTURA`, o `NO VERIFICADO`. No hay cuarta
>    opción, y "NO VERIFICADO" es una respuesta legítima.
> 5. **Reportá también lo que revisaste y salió limpio**, con el comando usado.
>    Un "acá no hay nada" verificado vale tanto como un hallazgo.
>
> Revisá estas diez secciones, en este orden:
>
> **1. Seguridad**
> - Usos de `lib/supabaseAdmin.ts` (`service_role`): ¿cuántos hay, y cada uno
>   está justificado? ¿Alguno entró a un archivo `'use client'`?
> - Secretos de dispositivo: ¿comparación en tiempo constante? ¿techo de
>   intentos? ¿idempotencia?
> - ¿Algún secreto con prefijo `NEXT_PUBLIC_`? ¿Algún secreto hardcodeado?
> - Validación del body en cada route handler: tipo, forma, tamaño, rango.
> - ¿Un body malformado responde 400 o se escapa como 500?
>
> **2. Aislamiento entre familias**
> - ¿Todas las tablas tienen RLS habilitada? ¿Y **GRANT** al rol
>   `authenticated`? Recordá el bug de `0005`: sin GRANT, Postgres bloquea
>   antes de evaluar la policy.
> - ¿Cada tabla tiene las policies que su uso necesita (select/insert/update)?
>   ¿Alguna tabla se puede escribir pero no corregir?
> - Endpoints con `service_role`: ¿filtran por familia, o confían en un id que
>   viene del cliente?
>
> **3. Acceso a datos**
> - ¿Hay queries armadas fuera de `lib/db.ts`?
>   (`grep -rn "\.from(" app components lib`)
> - ¿Alguna lectura de una tabla con `voided_at` que no filtre
>   `.is('voided_at', null)`?
> - ¿Alguna tabla nueva cuyo scope sea un join por `baby_id` en vez de
>   `household_id` directo?
>
> **4. Honestidad de estado offline**
> - ¿Algo se presenta como guardado sin estarlo?
> - ¿Se encola algo que el servidor **rechazó**? (Debería encolarse solo lo que
>   nunca llegó: `looksOffline()`.)
> - ¿Los contadores de la cola dicen la verdad sobre lo que queda adentro?
>
> **5. Service worker**
> - ¿Puede entrar a la caché alguna respuesta de Supabase? (Nunca: llevan
>   tokens de auth y esto corre en una pantalla compartida.)
> - ¿Qué se le sirve a alguien sin sesión desde la caché?
>
> **6. Tiempo y unidades**
> - ¿Alguna función de fecha/hora que dependa de la TZ del sistema en vez de la
>   del hogar (`America/Los_Angeles`)?
> - ¿Algo que guarde en otra unidad que no sea ml / kg / cm?
> - ¿La suite unitaria pasa bajo las cuatro timezones? (`pnpm test:tz`)
>
> **7. TypeScript**
> - `any`, `as`, `!` no justificados.
> - Tipos que se alejan de los nombres de columna de `lib/types.ts`.
>
> **8. Diseño**
> - Hex o px fuera de `app/globals.css` (y del espejo `lib/tokens.ts`).
> - Targets táctiles por debajo del token `--tap`.
> - Componentes bifurcados entre teléfono y pared en vez de tokens
>   re-apuntados en el breakpoint de 1180px.
>
> **9. Migraciones y propuestas**
> - ¿Alguien editó una migración ya aplicada?
> - ¿Hay un cambio de schema que debería estar en `proposals/` y está como
>   migración numerada?
>
> **10. Documentación contra código**
> - ¿`README.md`, `PROJECT.md`, `CLAUDE.md` y `design.md` describen la app que
>   realmente existe?
> - ¿Algún comando de la doc no funciona si lo copiás y pegás?
>
> **Formato del reporte:**
>
> Un archivo en `docs/auditorias/AAAA-MM-DD-<nombre>.md` con:
> - encabezado (fecha, commit auditado, alcance);
> - tabla resumen por severidad;
> - hallazgos agrupados en 🔴 CRÍTICO / 🟠 ALTO / 🟡 MEDIO / 🟢 BAJO, cada uno
>   con: dónde (`archivo:línea`), evidencia, qué pasa, corrección **sugerida**;
> - tabla de "lo que se revisó y salió limpio", con el comando;
> - la fila nueva en la tabla de historial de corridas.
>
> **Criterio de severidad:**
>
> | | |
> | --- | --- |
> | 🔴 CRÍTICO | Una familia puede leer o escribir datos de otra. Un secreto se filtra. |
> | 🟠 ALTO | La app miente sobre el estado de un dato, o un endpoint acepta basura que llega a la base. |
> | 🟡 MEDIO | Hueco de funcionalidad con impacto real, o documentación que hace perder tiempo. |
> | 🟢 BAJO | Deuda, duplicación, cosas que conviene dejar escritas. |

---

## Historial de corridas

| Fecha | Commit | Quién | 🔴 | 🟠 | 🟡 | 🟢 | Reporte |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-20 | `7c72ba2` | Claude Opus 5 | 2 | 6 | 6 | 5 | [auditorias/2026-09-20-auditoria-inicial.md](auditorias/2026-09-20-auditoria-inicial.md) |

**Cadencia sugerida:** una corrida antes de cada deploy, y una cada vez que se
agregue una tabla o un route handler nuevo.
