-- Los dos scopes de la pantalla del cambiador (proposals/changer-display.md §3).
--
-- Numerada en este repo por pedido explícito de Emilio (5 oct 2026), igual que
-- 0007 … 0012: ver CLAUDE.md §5.2. Entra al Hub como historia.
--
-- Mismo patrón que 0009 con push_check: no hay tabla nueva, solo se amplía la
-- lista de scopes permitidos. Sin tabla nueva no hay RLS nueva: los dos
-- endpoints escriben/leen con service_role y el bebé sale del token.
--
--   quick_diaper  POST /api/quick/diaper  — registra un pañal (idempotente por id)
--   read_status   GET  /api/quick/status  — lee qué corre, última comida, último pañal
--
-- Un scope por capacidad, no por aparato: un Shortcut que solo registra pañales
-- no tiene por qué poder leer el estado de la familia.
--
-- Aplicarla en la nube es un paso aparte y A MANO (CLAUDE.md §2.1). Sin eso,
-- `pnpm device-token create … --scope quick_diaper` falla por este CHECK.
-- Verificación:
--   select pg_get_constraintdef(oid) from pg_constraint
--   where conname = 'device_tokens_scopes_check';

alter table device_tokens drop constraint device_tokens_scopes_check;
alter table device_tokens add constraint device_tokens_scopes_check
  check (
    cardinality(scopes) > 0
    and scopes <@ array['ingest', 'quick_nurse', 'push_check',
                        'quick_diaper', 'read_status']::text[]
  );
