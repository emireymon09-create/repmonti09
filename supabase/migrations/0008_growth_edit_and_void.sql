-- Una medición de crecimiento mal cargada ya no es permanente (hallazgo M3,
-- docs/auditorias/2026-09-20-auditoria-inicial.md). Lo que 0006 hizo para las
-- otras cinco tablas, y dejó afuera a esta.
--
-- Numerada en este repo por pedido explícito de Emilio: CLAUDE.md §5.2.

-- Retractar: borrado lógico, nunca DELETE (CLAUDE.md §5.4).
alter table growth_measurements add column if not exists voided_at timestamptz;

-- Corregir. El WITH CHECK explícito impide mudar la fila a un bebé ajeno
-- (Postgres ya usaría el USING, pero así no depende de acordarse).
create policy "update growth_measurements" on growth_measurements
  for update
  using (is_baby_family_member(baby_id))
  with check (is_baby_family_member(baby_id));

-- Sin GRANT nuevo: 0005 ya otorgó update sobre todas las tablas de public a
-- authenticated. Verificado por el test de integración, no supuesto.
