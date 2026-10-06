import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { adminClient, anonClient, seedTwoFamilies, type SeededFamily } from './supabase'
import { assertMilkInvariant } from './milkInvariant'

// Ayudantes de las pruebas de integración del inventario v4 (0015). Llaman a
// las RPC por PostgREST con el JWT de un padre — el camino real — sin pasar
// por lib/db.ts ni lib/milk*.ts, que cambian en paralelo en esta misma rama:
// lo que se prueba acá es la base.

export const OZ = 29.5735
export const MIN = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000
/** Regla de heladera por defecto (babies.milk_fridge_days = 4): 96 h exactas. */
export const FRIDGE_MS = 4 * DAY

export const iso = (ms: number) => new Date(ms).toISOString()

/** ¿La base tiene 0015? Sin ella las suites v4 se saltan (NO VERIFICADO). */
export async function hasMilkV4(): Promise<boolean> {
  try {
    const { error } = await adminClient().from('milk_discards').select('id').limit(0)
    return !error
  } catch {
    return false
  }
}

export type V4Families = {
  a: SeededFamily
  /** Otro padre de la MISMA familia A (dos teléfonos, regla 21). */
  a2: SeededFamily
  b: SeededFamily
  familyIds: string[]
  cleanup: () => Promise<void>
}

/** Familias A (con dos padres) y B, descartables. */
export async function seedV4(tag: string): Promise<V4Families> {
  const { a, b, cleanup } = await seedTwoFamilies(tag)
  const admin = adminClient()
  const email = `${tag}-a2@amelia.test`.toLowerCase()
  const password = 'test-password-1234'
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const stale = list?.users.find((u) => u.email === email)
  if (stale) await admin.auth.admin.deleteUser(stale.id)
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) throw error
  const userId = created.user!.id
  const { error: memErr } = await admin
    .from('family_members')
    .insert({ family_id: a.familyId, user_id: userId, role: 'parent' })
  if (memErr) throw memErr
  const client = anonClient()
  const { error: signErr } = await client.auth.signInWithPassword({ email, password })
  if (signErr) throw signErr
  const a2: SeededFamily = { ...a, userId, email, client }
  return {
    a,
    a2,
    b,
    familyIds: [a.familyId, b.familyId],
    cleanup: async () => {
      await cleanup()
      await admin.auth.admin.deleteUser(userId)
    },
  }
}

/**
 * Un bebé nuevo en la familia de `fam` (y del mismo padre): cada prueba que
 * cuenta "lo que hay" o elige la leche más vieja necesita un inventario propio,
 * sin lo que dejaron las anteriores. Se borra en cascada con la familia.
 */
export async function newBaby(fam: SeededFamily, ...others: SeededFamily[]) {
  const { data, error } = await adminClient()
    .from('babies')
    .insert({ family_id: fam.familyId, name: 'Bebe v4', birth_date: '2026-09-01' })
    .select('id')
    .single()
  if (error) throw error
  const babyId = data.id as string
  return [fam, ...others].map((f) => ({ ...f, babyId }))
}

/** Contenedor de Postgres del stack local (127.0.0.1, ver supabase/docker). */
export const LOCAL_DB_CONTAINER = 'amelia-local-db-1'

/**
 * SQL como `postgres` dentro del contenedor local, por `docker exec` (sin red:
 * nunca toca otra base). Para lo que PostgREST no deja ver (pg_class,
 * pg_proc) o para fijar `now()` dentro de UNA transacción. Devuelve stdout
 * (`-tA`: sin encabezados, separado por `|`).
 */
export function psql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      LOCAL_DB_CONTAINER,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-qtA',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
}

export function hasLocalDocker(): boolean {
  try {
    return psql('select 1').trim() === '1'
  } catch {
    return false
  }
}

export type RpcResult = { data: unknown; error: string | null }

export async function rpc(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const { data, error } = await client.rpc(fn, args)
  return { data, error: error ? error.message : null }
}

export type PumpOpts = {
  left?: number | null
  right?: number | null
  label?: string | null
  /** Hora de la extracción (= entrada al refri, D-3). Default: ahora. */
  at?: number
  id?: string
  containerId?: string | null
  babyId?: string
}

export function pumpArgs(fam: SeededFamily, o: PumpOpts = {}) {
  const label = o.label === undefined ? null : o.label
  return {
    p_id: o.id ?? randomUUID(),
    p_baby_id: o.babyId ?? fam.babyId,
    p_side: 'both',
    p_left_ml: o.left === undefined ? null : o.left,
    p_right_ml: o.right === undefined ? null : o.right,
    p_notes: null,
    p_pumped_at: iso(o.at ?? Date.now()),
    p_container_id: o.containerId !== undefined ? o.containerId : label ? randomUUID() : null,
    p_container_label: label,
    p_container_expires_at: null,
  }
}

/** Extracción con biberón; falla la prueba si no entra. */
export async function pumpOk(fam: SeededFamily, ml: number, label: string, at?: number) {
  const args = pumpArgs(fam, { left: ml, label, at })
  const r = await rpc(fam.client, 'log_pumping_session', args)
  expect(r.error, `pump ${label}`).toBeNull()
  return { sessionId: args.p_id, containerId: args.p_container_id as string, args }
}

export type FeedOpts = {
  formula?: number
  leftover?: number | null
  at?: number
  id?: string
  /** Llamar con los seis argumentos de la app v3 (sin p_leftover_ml). */
  sixArgs?: boolean
}

export function feedArgs(fam: SeededFamily, portions: [string, number][], o: FeedOpts = {}) {
  const args: Record<string, unknown> = {
    p_id: o.id ?? randomUUID(),
    p_baby_id: fam.babyId,
    p_fed_at: iso(o.at ?? Date.now()),
    p_notes: null,
    p_formula_ml: o.formula ?? 0,
    p_portions: portions.map(([container_id, amount_ml]) => ({ container_id, amount_ml })),
  }
  if (!o.sixArgs) args.p_leftover_ml = o.leftover ?? null
  return args
}

export async function feedOk(
  fam: SeededFamily,
  portions: [string, number][],
  o: FeedOpts = {},
): Promise<string> {
  const args = feedArgs(fam, portions, o)
  const r = await rpc(fam.client, 'log_bottle_feed', args)
  expect(r.error, 'log_bottle_feed').toBeNull()
  return args.p_id as string
}

export type ContainerRow = {
  id: string
  label: string
  amount_ml: number
  remaining_ml: number
  lost_ml: number
  released_at: string | null
  voided_at: string | null
  stored_at: string
  expires_at: string
}

export async function containerRow(id: string): Promise<ContainerRow> {
  const { data, error } = await adminClient()
    .from('milk_containers')
    .select(
      'id, label, amount_ml, remaining_ml, lost_ml, released_at, voided_at, stored_at, expires_at',
    )
    .eq('id', id)
    .single()
  if (error) throw error
  return data as ContainerRow
}

export async function feedingRow(id: string) {
  const { data, error } = await adminClient()
    .from('feedings')
    .select('id, fed_at, amount_ml, breast_milk_ml, formula_ml, leftover_ml, notes, voided_at')
    .eq('id', id)
    .single()
  if (error) throw error
  return data as {
    id: string
    fed_at: string
    amount_ml: number
    breast_milk_ml: number | null
    formula_ml: number | null
    leftover_ml: number | null
    notes: string | null
    voided_at: string | null
  }
}

/** Porciones vivas de una toma, como {etiqueta: ml}. */
export async function portionsOf(feedingId: string): Promise<Record<string, number>> {
  const { data, error } = await adminClient()
    .from('milk_drawdowns')
    .select('amount_ml, milk_containers(label)')
    .eq('feeding_id', feedingId)
    .is('voided_at', null)
  if (error) throw error
  const out: Record<string, number> = {}
  for (const d of data as unknown as { amount_ml: number; milk_containers: { label: string } }[])
    out[d.milk_containers.label] = Number(d.amount_ml)
  return out
}

export async function liveDiscards(containerId: string) {
  const { data, error } = await adminClient()
    .from('milk_discards')
    .select('id, amount_ml, discarded_at, reason, logged_by, voided_at')
    .eq('container_id', containerId)
  if (error) throw error
  return data as {
    id: string
    amount_ml: number
    discarded_at: string
    reason: string
    logged_by: string
    voided_at: string | null
  }[]
}

export function discardArgs(containerId: string, at?: number | null, id?: string) {
  return {
    p_id: id ?? randomUUID(),
    p_container_id: containerId,
    p_discarded_at: at === undefined || at === null ? null : iso(at),
  }
}

/** El "esperado" que vio la pantalla, leído de la fila tal como está. */
export async function expectedOf(feedingId: string) {
  const f = await feedingRow(feedingId)
  return {
    fed_at: f.fed_at,
    breast_milk_ml: Number(f.breast_milk_ml),
    formula_ml: Number(f.formula_ml),
    leftover_ml: f.leftover_ml === null ? null : Number(f.leftover_ml),
  }
}

export type EditReq = {
  fedAt?: string
  breast?: number
  formula?: number
  leftover?: number | null
  notes?: string | null
}

/** Argumentos de edit_bottle_feed: lo que no se pide queda como está. */
export async function editArgs(feedingId: string, req: EditReq, opId?: string) {
  const f = await feedingRow(feedingId)
  const expected = await expectedOf(feedingId)
  return {
    p_op_id: opId ?? randomUUID(),
    p_feeding_id: feedingId,
    p_fed_at: req.fedAt ?? f.fed_at,
    p_breast_ml: req.breast ?? Number(f.breast_milk_ml),
    p_formula_ml: req.formula ?? Number(f.formula_ml),
    p_leftover_ml:
      req.leftover !== undefined
        ? req.leftover
        : f.leftover_ml === null
          ? null
          : Number(f.leftover_ml),
    p_notes: req.notes !== undefined ? req.notes : f.notes,
    p_expected: expected,
  }
}

/** Foto de todo lo que la leche toca para un bebé: para afirmar "nada cambió". */
export async function milkSnapshot(babyId: string) {
  const admin = adminClient()
  const [c, d, x, f, p, e] = await Promise.all([
    admin
      .from('milk_containers')
      .select('id, label, amount_ml, remaining_ml, lost_ml, released_at, voided_at, expires_at')
      .eq('baby_id', babyId)
      .order('id'),
    admin
      .from('milk_drawdowns')
      .select('id, container_id, feeding_id, amount_ml, voided_at')
      .eq('baby_id', babyId)
      .order('id'),
    admin
      .from('milk_discards')
      .select('id, container_id, amount_ml, discarded_at, voided_at')
      .eq('baby_id', babyId)
      .order('id'),
    admin
      .from('feedings')
      .select('id, fed_at, amount_ml, breast_milk_ml, formula_ml, leftover_ml, voided_at')
      .eq('baby_id', babyId)
      .order('id'),
    admin
      .from('pumping_sessions')
      .select('id, side, amount_ml, left_ml, right_ml, pumped_at, voided_at')
      .eq('baby_id', babyId)
      .order('id'),
    admin.from('milk_feeding_edits').select('op_id').eq('baby_id', babyId).order('op_id'),
  ])
  for (const r of [c, d, x, f, p, e]) expect(r.error).toBeNull()
  return {
    containers: c.data,
    drawdowns: d.data,
    discards: x.data,
    feedings: f.data,
    sessions: p.data,
    edits: e.data,
  }
}

/** Los "topes" del plan de pruebas (§0): todos → milk_bad_input. */
export const BAD_AMOUNTS: unknown[] = ['NaN', 'Infinity', '-Infinity', -1, 100000, '1e400']

export { assertMilkInvariant }
