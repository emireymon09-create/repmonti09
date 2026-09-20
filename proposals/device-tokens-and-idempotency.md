# Proposal — tokens por dispositivo e idempotencia en los endpoints de dispositivo

**Para la sesión del Hub.** Este repo dejó de numerar sus propias migraciones
(CLAUDE.md §5.2, ADR 0003), así que esto es una **propuesta**, no una migración.
Nada de acá está aplicado en ninguna base.

**Cierra:** los hallazgos 🔴 C1 y 🔴 C2 de
`docs/auditorias/2026-09-20-auditoria-inicial.md`, y la pregunta abierta n.º 4
de CLAUDE.md §7 (ADR 0005 pide tokens hasheados por dispositivo).

**Estado hoy, demostrado con tests que ya corren:**

- `tests/integration/ingest.test.ts` — un único secreto estático escribe sobre
  el `baby_id` de **cualquier** familia.
- `tests/integration/quick-nurse.test.ts` — sin `QUICK_TOGGLE_BABY_ID`, con más
  de un bebé en la base el endpoint ahora falla cerrado (409). Eso es un parche,
  no el arreglo: sigue sin haber ninguna relación entre *quién trae el secreto*
  y *sobre qué bebé escribe*.

---

## 1. El problema, en una frase

Los dos endpoints de dispositivo corren con `service_role`, que **salta RLS por
completo**, y se autentican con un secreto compartido que no identifica a nadie.
El resultado: la autorización no existe. Solo existe autenticación, y de la más
débil.

Con un hogar no se nota. Con dos, el secreto del NUC de la casa A escribe
eventos de sueño sobre la bebé de la casa B, y nadie se entera.

---

## 2. Tabla `device_tokens`

```sql
-- ⚠️ SIN NUMERAR. La numera el agente del Hub al integrarla.
create table device_tokens (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  -- Nulo = el token vale para toda la familia (p. ej. el NUC, que empuja
  -- eventos de varios bebés). No nulo = queda clavado a un bebé.
  baby_id uuid references babies(id) on delete cascade,
  label text not null,                 -- "NUC del cuarto", "Shortcut de Emilio"
  -- NUNCA el token en claro. sha-256 hex del secreto, 64 caracteres.
  token_hash text not null unique,
  -- Qué puede hacer este token. Sin esto, el Shortcut del teléfono podría
  -- empujar eventos de monitor y el NUC podría abrir sesiones de lactancia.
  scopes text[] not null default array['ingest'],
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint device_tokens_baby_in_family check (baby_id is null or true)
);

create index device_tokens_active on device_tokens (token_hash)
  where revoked_at is null;

alter table device_tokens enable row level security;

-- Un padre ve y administra los tokens de SU familia. El endpoint no usa
-- estas policies (entra con service_role), pero la pantalla de ajustes sí.
create policy "select own device_tokens" on device_tokens
  for select using (is_family_member(family_id));
create policy "insert own device_tokens" on device_tokens
  for insert with check (is_family_member(family_id));
create policy "update own device_tokens" on device_tokens
  for update using (is_family_member(family_id));

-- El bug de 0005: RLS correcta no alcanza sin GRANT. Postgres bloquea antes
-- de evaluar la policy.
grant select, insert, update on device_tokens to authenticated;
```

**Por qué `token_hash` y no el token:** una base robada no puede devolver los
secretos. El endpoint hashea lo que le llega y busca por hash; el token en claro
se muestra **una sola vez**, cuando se crea, y después no existe en ningún lado.

**Por qué `scopes` y no un booleano:** hoy son dos endpoints, mañana son cuatro.
Un array de texto no cuesta nada y evita la migración siguiente.

---

## 3. Qué cambia en el código

### `lib/deviceAuth.ts`

`checkDeviceSecret()` pasa de comparar contra una env var a resolver un token:

```ts
export type DeviceIdentity = {
  tokenId: string
  familyId: string
  babyId: string | null
  scopes: string[]
}

export async function resolveDeviceToken(
  req: Request,
  supabase: SupabaseClient,
): Promise<DeviceIdentity | 'unauthorized' | 'rate_limited'>
```

La comparación en tiempo constante que ya está no se tira: se aplica al hash.

### `/api/ingest`

```ts
const identity = await resolveDeviceToken(req, supabase)
// ...
// EL CAMBIO: el baby_id del body tiene que pertenecer a la familia del token.
if (!(await babyBelongsTo(supabase, baby_id, identity.familyId))) {
  return NextResponse.json({ error: 'baby_id not yours' }, { status: 403 })
}
```

Eso, y solo eso, cierra C2.

### `/api/quick/nurse`

El bebé se resuelve **desde el token**: `identity.babyId`, y si es nulo, el
único bebé de `identity.familyId`. El lookup de "el `babies` más antiguo de toda
la base" desaparece, junto con la env var `QUICK_TOGGLE_BABY_ID`, que era el
parche provisorio. Eso cierra C1.

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

## 5. Migración desde el estado actual

El corte de un día para el otro rompe la casa. Propuesta en tres pasos:

1. **Convivencia.** El endpoint acepta token nuevo **o** `NUC_DEVICE_SECRET`
   viejo. Cada uso del viejo escribe un warning con la IP de origen.
2. **Corte de los dispositivos.** Se crea un token por dispositivo real (el NUC,
   el Shortcut de cada teléfono) y se reconfigura cada uno.
3. **Revocación.** Se borran `NUC_DEVICE_SECRET` y `QUICK_TOGGLE_SECRET` del
   entorno. A partir de ahí, sin token no se entra.

El paso 1 es el que hace que esto sea aplicable sin coordinar un apagón.

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
