-- Tokens por dispositivo. Reemplazan al secreto compartido de /api/ingest y
-- /api/quick/nurse, que no decía de qué familia era nadie (hallazgos C1 y C2,
-- docs/auditorias/2026-09-20-auditoria-inicial.md).
--
-- Numerada en este repo por pedido explícito de Emilio (21 sep 2026), no por
-- el agente del Hub: ver CLAUDE.md §5.2.

-- La FK compuesta de abajo necesita que (id, family_id) sea única en babies.
-- id ya es PK, así que esto no restringe nada nuevo: solo lo hace referenciable.
alter table babies add constraint babies_id_family_id_key unique (id, family_id);

create table device_tokens (
  id uuid primary key default gen_random_uuid(),
  -- Scope directo por familia (no por join vía baby_id): fase 2 lo pide así.
  family_id uuid not null references families(id) on delete cascade,
  -- Nulo = vale para toda la familia (el NUC). No nulo = clavado a un bebé.
  baby_id uuid,
  label text not null check (length(btrim(label)) > 0),
  -- NUNCA el token en claro: sha-256 hex.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null
    check (cardinality(scopes) > 0 and scopes <@ array['ingest', 'quick_nurse']::text[]),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  -- Lo que la propuesta intentó con un CHECK que siempre daba verdadero: el bebé
  -- tiene que ser DE ESA familia. Con baby_id nulo la FK no se evalúa.
  constraint device_tokens_baby_in_family
    foreign key (baby_id, family_id) references babies (id, family_id) on delete cascade
);

alter table device_tokens enable row level security;

-- Sin policies, a propósito: nadie la lee desde la app. Solo el servidor
-- (service_role) y `pnpm device-token`.
--
-- Y el revoke hace falta aunque no haya policies: 0005 dejó
-- `alter default privileges ... grant ... to authenticated`, así que esta tabla
-- nació con grants. RLS sin policy ya bloquea las filas; el revoke cierra
-- también la tabla, para que un error de policy futuro no alcance.
revoke all on device_tokens from anon, authenticated;
