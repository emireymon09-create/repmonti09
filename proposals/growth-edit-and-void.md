# Proposal — corregir y retractar una medición de crecimiento

**Para la sesión del Hub.** Este repo dejó de numerar sus propias migraciones
(CLAUDE.md §5.2, ADR 0003), así que esto es una **propuesta**, no una migración.
Nada de acá está aplicado en ninguna base.

**Cierra:** el hallazgo 🟡 M3 de
`docs/auditorias/2026-09-20-auditoria-inicial.md`.

---

## 1. Qué pasa hoy

`growth_measurements` se creó en `0001_init.sql` con policies de `select` e
`insert`, y nada más. `0006_edit_and_void.sql` agregó `voided_at` a cinco tablas
—`feedings`, `diaper_changes`, `nursing_sessions`, `sleep_sessions`,
`pumping_sessions`— y policies de `update` a cuatro. **`growth_measurements`
quedó afuera de las dos cosas.**

Efecto concreto: se anota 3,5 kg donde iban 4,5 y esa fila es permanente. No se
corrige, no se retracta, y queda para siempre en la curva de crecimiento que uno
le muestra a la pediatra.

**Demostrado, no supuesto:** `tests/integration/rls.test.ts`, test
_"growth_measurements no tiene policy de UPDATE: una medición mal cargada es
permanente"_. El propio dueño de la fila hace el update y PostgREST devuelve
cero filas afectadas, sin error — que es el modo más incómodo de fallar, porque
parece que funcionó.

---

## 2. La migración propuesta

```sql
-- ⚠️ SIN NUMERAR. La numera el agente del Hub al integrarla.

-- Corregir: la misma policy que ya tienen feedings y compañía.
create policy "update growth_measurements" on growth_measurements
  for update using (is_baby_family_member(baby_id));

-- Retractar: borrado lógico, nunca un DELETE. La historia de cuidado de una
-- bebé se marca retractada, no se destruye (CLAUDE.md §5.4).
alter table growth_measurements add column if not exists voided_at timestamptz;
```

No hace falta `grant`: `0005_grant_authenticated.sql` ya otorgó
`select, insert, update, delete` sobre **todas** las tablas del schema `public`
al rol `authenticated`, y dejó puesto el `alter default privileges`. Verificado
leyendo `0005`, no asumido.

**`doctor_appointments` queda afuera a propósito.** Está en la misma situación
respecto de `voided_at`, pero sí tiene policy de `update` desde `0001`, así que
un turno mal cargado se corrige. Agregarle borrado lógico es una decisión
distinta y merece su propia discusión.

---

## 3. Qué cambia en `lib/db.ts`

Dos funciones, calcadas del patrón que ya usan las otras cinco tablas:

```ts
export function updateGrowth(
  id: string,
  patch: { measured_at?: string; weight_kg?: number | null; height_cm?: number | null; notes?: string | null },
): Promise<Result<null>> {
  return mutate({ kind: 'update', table: 'growth_measurements', id, patch }, 'Growth entry')
}

export function voidGrowth(id: string): Promise<Result<null>> {
  return mutate(
    {
      kind: 'update',
      table: 'growth_measurements',
      id,
      patch: { voided_at: new Date().toISOString() },
    },
    'Growth entry',
  )
}
```

Y **`listGrowth()` tiene que empezar a filtrar**:

```ts
.is('voided_at', null)
```

Eso último no es opcional. Una lectura que no filtra `voided_at` deja ver filas
retractadas, que es exactamente el modo en que el borrado lógico se convierte en
un bug (CLAUDE.md §5.4: *toda lectura filtra*).

---

## 4. Qué cambia en la UI

`app/growth/page.tsx` ya lista las mediciones. Hace falta lo mismo que tiene
`app/history/page.tsx`: editar y retractar por fila, con `window.confirm` antes
de destruir (design.md §5.6).

Nada de esto necesita CSS nuevo: los componentes de `components/ui.tsx` y los
tokens de `app/globals.css` ya cubren el caso.

---

## 5. Tests que tienen que acompañar la migración

Cuando esto se aplique, el test que hoy documenta el hueco **se da vuelta**:

- `tests/integration/rls.test.ts` — _"growth_measurements no tiene policy de
  UPDATE"_ pasa a verificar que el dueño SÍ puede corregir su medición y que un
  miembro de otra familia **no**.
- Un test nuevo de que `listGrowth()` no devuelve filas con `voided_at`.
