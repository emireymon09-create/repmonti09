# Proposal — tokens por dispositivo e idempotencia en los endpoints de dispositivo

**§1-§3 y §5 implementados** en `0007` (21 sep 2026), con dos correcciones
respecto de lo propuesto acá: FK compuesta en lugar del `CHECK` (C-2) y sin
acceso de `authenticated` (C-3). Los archivos que quedan aplicados: la tabla
`device_tokens` (`supabase/migrations/0007_device_tokens.sql`),
`lib/deviceTokens.ts`, `lib/deviceAuth.ts` (`authenticateDevice`,
`resolveBabyForDevice`), y `scripts/device-token.mts` como CLI de admin.
Cierra los hallazgos 🔴 C1 y 🔴 C2 de
`docs/auditorias/2026-09-20-auditoria-inicial.md`. El cuerpo original de esos
parágrafos queda en el historial de git, no acá. Lo que sigue **propuesto**:
§4 (idempotencia) y §6 (lo que esto no resuelve).

---

## 4. Idempotencia

**El problema:** el NUC reintenta. Una automatización de Home Assistant con
reintentos, o un Shortcut al que se le toca dos veces, mandan el mismo evento
dos veces. Hoy eso son dos filas en `monitor_events`, o dos sesiones de sueño
abiertas que nadie cierra.

```sql
-- ⚠️ SIN NUMERAR.
create table device_request_log (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references device_tokens(id) on delete cascade,
  idempotency_key text not null,
  -- La respuesta que se devolvió la primera vez, para repetirla igual.
  response_status int not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  unique (token_id, idempotency_key)
);

alter table device_request_log enable row level security;
-- Sin policies para `authenticated`: esta tabla es solo del servidor, igual
-- que monitor_events. RLS habilitada y sin policy = nadie la lee desde la app.
```

El endpoint lee el header `Idempotency-Key`. Si ya existe para ese token,
devuelve la respuesta guardada **sin reescribir nada**. Si no existe, procesa y
la guarda.

**Retención:** un `delete from device_request_log where created_at < now() -
interval '7 days'` semanal alcanza. Siete días es mucho más de lo que un
reintento razonable necesita.

---

## 6. Lo que esta propuesta NO resuelve

Dicho explícitamente para que no se lea más de lo que dice:

- **Dónde vive la `service_role`.** Sigue en esta app. La regla del Hub dice que
  vive solo en el servidor del Hub (pregunta abierta n.º 1 de CLAUDE.md §7). Si
  el ingest se muda a `apps/hub`, esta propuesta se muda con él sin cambios.
- **Rate limiting distribuido.** Lo que hay hoy vive en la memoria de un
  proceso. Con tokens en la base, el contador natural es `last_used_at` + una
  columna de intentos fallidos, pero eso es trabajo aparte.
- **Rotación automática.** Los tokens se revocan y se crean a mano. Para dos
  dispositivos en una casa, alcanza.
