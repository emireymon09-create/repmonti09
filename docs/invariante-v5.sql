-- invariante-v5.sql — SOLO LECTURA. La invariante del final de
-- supabase/migrations/0016_milk_phase3_4.sql (INV-1…INV-13, con
-- transferencias, biberón empezado y Similac), lista para pegar en el SQL
-- Editor DESPUÉS de aplicar 0016 (runbook §3.2 y §6.3).
--
-- Tiene que dar: "Success. No rows returned" (cero filas). Cada fila es una
-- falla: `falla` dice cuál (INV-…) e `id` qué fila. Corre dentro de
-- `begin transaction read only` … `rollback`: no puede escribir.
--
-- Ensayado el 8 oct 2026 (docs/ensayo-predeploy-v5.md, E2/E3) contra una
-- réplica de producción por el mismo camino que el SQL Editor: 0 filas.
-- Si 0016 cambia, esto se vuelve a copiar de su bloque `do` final.

begin transaction read only;
with srv as (
  select container_id, sum(amount_ml) as ml
  from milk_drawdowns where voided_at is null group by container_id
), dsc as (
  select container_id, sum(amount_ml) as ml, count(*) as n
  from milk_discards
  where voided_at is null and container_id is not null group by container_id
), tin as (
  select to_container_id as container_id, sum(amount_ml) as ml
  from milk_transfers where voided_at is null group by to_container_id
), tout as (
  select from_container_id as container_id, sum(amount_ml) as ml
  from milk_transfers where voided_at is null group by from_container_id
), fallas as (
  select 'INV-1 cuenta' as falla, c.id
    from milk_containers c
    left join srv s on s.container_id = c.id
    left join dsc d on d.container_id = c.id
    left join tin i on i.container_id = c.id
    left join tout o on o.container_id = c.id
   where c.voided_at is null
     and abs(c.amount_ml + coalesce(i.ml,0) - coalesce(s.ml,0) - coalesce(d.ml,0)
             - c.lost_ml - c.remaining_ml - coalesce(o.ml,0)) > 1e-9
  union all
  select 'INV-2 número doble', min(c.id::text)::uuid
    from milk_containers c
   where c.voided_at is null and c.released_at is null
   group by c.baby_id, c.label having count(*) > 1
  union all
  select 'INV-3 desecho incoherente', c.id
    from milk_containers c join dsc d on d.container_id = c.id
   where c.voided_at is not null or c.released_at is null or c.remaining_ml <> 0
  union all
  select 'INV-4 anulado con vivos', c.id
    from milk_containers c
    left join srv s on s.container_id = c.id
    left join dsc d on d.container_id = c.id
    left join tin i on i.container_id = c.id
    left join tout o on o.container_id = c.id
   where c.voided_at is not null
     and (s.ml is not null or d.ml is not null or i.ml is not null or o.ml is not null)
  union all
  select 'INV-5 ocupado vacío', c.id
    from milk_containers c
   where c.voided_at is null and c.released_at is null and c.remaining_ml < 0.15
  union all
  select 'INV-6 desglose', f.id
    from feedings f
    left join (select feeding_id, sum(amount_ml) ml from milk_drawdowns
                where voided_at is null group by feeding_id) p on p.feeding_id = f.id
   where f.voided_at is null and (f.breast_milk_ml is not null or f.formula_ml is not null)
     and (abs(coalesce(f.breast_milk_ml,0) - coalesce(p.ml,0)) > 1e-9
          or abs(f.amount_ml - coalesce(f.breast_milk_ml,0) - coalesce(f.formula_ml,0)) > 1e-9)
  union all
  select 'INV-8 sesión≠contenedor', c.id
    from milk_containers c join pumping_sessions ps on ps.id = c.source_session_id
   where c.voided_at is null and ps.voided_at is null and ps.amount_ml is distinct from c.amount_ml
  union all
  select 'INV-9 porción huérfana', d.feeding_id
    from milk_drawdowns d join feedings f on f.id = d.feeding_id
   where d.voided_at is null and f.voided_at is not null
  union all
  select 'INV-10 empezado incoherente', x.id
    from milk_discards x left join feedings f on f.id = x.feeding_id
   where x.voided_at is null and x.reason = 'started_bottle_expired'
     and (f.id is null or f.voided_at is not null or f.feeding_type <> 'bottle'
          or f.baby_id <> x.baby_id
          or f.leftover_ml is distinct from x.amount_ml)
  union all
  select 'INV-11 transferencia incoherente', t.id
    from milk_transfers t
    join milk_containers o on o.id = t.from_container_id
    join milk_containers d on d.id = t.to_container_id
   where t.voided_at is null
     and (o.baby_id <> t.baby_id or d.baby_id <> t.baby_id
          or o.voided_at is not null or o.released_at is null or o.remaining_ml >= 0.15
          or d.voided_at is not null)
  union all
  select 'INV-12 fórmula', min(x.id::text)::uuid
    from formula_containers x
   where x.voided_at is null and x.opened_at is not null and x.finished_at is null
   group by x.baby_id having count(*) > 1
  union all
  select 'INV-12 fórmula', x.id
    from formula_containers x
   where x.finished_at < x.opened_at
  union all
  select 'INV-13 caducidad combinada', t.id
    from milk_transfers t
    join milk_containers o on o.id = t.from_container_id
    join milk_containers d on d.id = t.to_container_id
   where t.voided_at is null and d.voided_at is null and d.expires_at > o.expires_at
)
select falla, id from fallas order by 1, 2;
rollback;
