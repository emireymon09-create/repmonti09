/**
 * The physical bottles of the milk inventory, v4 (docs/arquitectura-v4.md §1,
 * §2, §3.8, §7.1).
 *
 * Pure: no clock, no database, no React. Every instant comes in as a
 * parameter (`atMs` / `atIso`) — never `Date.now()` or `new Date()` without an
 * argument in here — so the rules can be tested under four timezones and the
 * screen and the server can be asked the same question.
 *
 * It does NOT import lib/milk.ts (that one imports this): `EMPTY_ML`,
 * `labelNumber` and `byAge` live here and lib/milk.ts re-exports or uses them.
 *
 * What it mirrors on the server (0015):
 *   · `containerState`  — §1.2, the five states and their precedence;
 *   · `rebalance`       — `milk_rebalance` (§2.3), the ONE rule for where a
 *                         change in a container's residue goes;
 *   · `planBottleEdit`  — steps 4–9 of `edit_bottle_feed` (§3.8): the screen
 *                         says "1 oz goes back to M4" before sending, and the
 *                         offline queue shows the same thing until it syncs.
 * The server has the last word; these say what it is expected to say.
 */

import type {
  Feeding,
  MilkContainer,
  MilkDiscard,
  MilkDrawdown,
  PumpingSession,
  WithPending,
} from '@/lib/types'

// ------------------------------------------------------------- constants

/**
 * Below this a container is empty: what float arithmetic leaves behind after
 * a portion is taken offline, and anything the screen would show as "0 oz"
 * (two decimals of an ounce are ~0.3 ml; half of that rounds to 0). It must
 * not be offered, counted, or end up as a portion. The same literal is in
 * 0015 (`milk_containers_released_empty` and `milk_rebalance`); a unit test
 * compares them (U-41).
 */
export const EMPTY_ML = 0.15

/**
 * How far in the future a feeding's time may be, by the server's clock
 * (`interval '10 minutes'` in 0015, D-15). The screen checks the same number
 * against its own clock; U-40 compares them.
 */
export const FUTURE_TOLERANCE_MS = 600_000

/**
 * How many physical bottles (M1…MN) the selector offers (D-23): the column
 * `babies.milk_bottle_count` defaults to this. 1–30, whole: 30 covers any
 * home fridge and keeps a selector from offering absurd numbers.
 */
export const DEFAULT_BOTTLE_COUNT = 6
export const MIN_BOTTLE_COUNT = 1
export const MAX_BOTTLE_COUNT = 30

/** Float dust: two amounts closer than this are the same amount. */
const DUST_ML = 1e-9

// ------------------------------------------------------------- labels

/** The number of an `M<n>` label, or null for anything else. */
export function labelNumber(label: string | null | undefined): number | null {
  const match = /^M([1-9][0-9]*)$/.exec(label ?? '')
  return match ? Number(match[1]) : null
}

/**
 * Oldest first — stored earlier, then the lower M number, then the id (the
 * same order 0015 uses: `stored_at, substring(label from 2)::numeric, id`).
 */
export function byAge(
  a: Pick<MilkContainer, 'stored_at' | 'label'> & { id?: string },
  b: Pick<MilkContainer, 'stored_at' | 'label'> & { id?: string },
): number {
  return (
    Date.parse(a.stored_at) - Date.parse(b.stored_at) ||
    (labelNumber(a.label) ?? 0) - (labelNumber(b.label) ?? 0) ||
    ((a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0)
  )
}

// ------------------------------------------------------------- state

export type ContainerState = 'voided' | 'discarded' | 'free' | 'expired' | 'occupied'

/** Is there a live (not voided) discard of this container? */
export function hasLiveDiscard(
  c: Pick<MilkContainer, 'id'>,
  discards: readonly MilkDiscard[],
): boolean {
  return discards.some((d) => d.container_id === c.id && !d.voided_at)
}

/** Holds its number: not voided and not released (§1.2). */
export function isOccupied(c: MilkContainer): boolean {
  return !c.voided_at && !c.released_at
}

/**
 * The state of a container at `atMs`, in this order of precedence (§1.2):
 * voided → discarded → free (released) → expired → occupied. Expiry is
 * exclusive: at the exact instant of `expires_at` it is already expired.
 * `atMs` is the phone's clock and is only for painting; a discard is decided
 * by the database's `now()` (§4).
 */
export function containerState(
  c: MilkContainer,
  discards: readonly MilkDiscard[],
  atMs: number,
): ContainerState {
  if (c.voided_at) return 'voided'
  if (hasLiveDiscard(c, discards)) return 'discarded'
  if (c.released_at) return 'free'
  if (Date.parse(c.expires_at) <= atMs) return 'expired'
  return 'occupied'
}

/** "Desechar" is offered only on an expired, still occupied container (D-6). */
export function canDiscard(
  c: MilkContainer,
  discards: readonly MilkDiscard[],
  atMs: number,
): boolean {
  return containerState(c, discards, atMs) === 'expired'
}

/** "Leche desechada": every live discard, no window (D-13). In ml. */
export function discardedTotalMl(discards: readonly MilkDiscard[]): number {
  return discards.reduce((sum, d) => (d.voided_at ? sum : sum + Number(d.amount_ml)), 0)
}

// ------------------------------------------------------------- the selector

export type SlotState = 'free' | 'occupied' | 'expired'

export type Slot = {
  label: string
  state: SlotState
  /** Can't be picked: it has milk in it (occupied or expired). */
  disabled: boolean
  /** The container holding the number, when there is one. */
  container?: WithPending<MilkContainer>
  /** What it has left and since when — "M3 · 2.5 oz · 14:20". */
  remainingMl?: number
  storedAt?: string
  /** The container holding it is only in this phone's queue. */
  pending?: boolean
}

/**
 * The bottle selector (V4-11, V4-12): M1…MN in numeric order — the number is
 * the bottle's name, not its age — each free, occupied or expired; plus the
 * containers holding a number above N (D-1: a v3 container "M9" with N = 6;
 * D-2: N lowered under a full bottle), which stay visible until emptied or
 * discarded but are never offered.
 *
 * `containers: null` means the list is unknown (offline, nothing read and no
 * saved copy, V4-11 CA3): every number is offered (`known: false`) and the
 * server decides on sync.
 *
 * Two live containers on one number can only come from the queue (two
 * phones, offline); the one the server already has wins the slot, then the
 * oldest.
 */
export function bottleSlots(
  n: number,
  containers: readonly WithPending<MilkContainer>[] | null,
  discards: readonly MilkDiscard[],
  atMs: number,
): { slots: Slot[]; outOfRange: Slot[]; known: boolean } {
  const count = effectiveBottleCount(n)
  const holders = new Map<string, WithPending<MilkContainer>>()
  // Numbers freed by something still in this phone's queue (a discard, or a
  // bottle that emptied it): free, but not synced yet (V4-39, E-16).
  const freedPending = new Set<string>()
  for (const c of containers ?? []) {
    const state = containerState(c, discards, atMs)
    if (state !== 'occupied' && state !== 'expired') {
      if (c.pending && (state === 'free' || state === 'discarded')) freedPending.add(c.label)
      continue
    }
    const held = holders.get(c.label)
    if (!held || better(c, held)) holders.set(c.label, c)
  }
  const slotOf = (label: string): Slot => {
    const c = holders.get(label)
    if (!c)
      return freedPending.has(label)
        ? { label, state: 'free', disabled: false, pending: true }
        : { label, state: 'free', disabled: false }
    return {
      label,
      state: containerState(c, discards, atMs) === 'expired' ? 'expired' : 'occupied',
      disabled: true,
      container: c,
      remainingMl: c.remaining_ml,
      storedAt: c.stored_at,
      pending: !!c.pending,
    }
  }
  const slots = Array.from({ length: count }, (_, i) => slotOf(`M${i + 1}`))
  const outOfRange = [...holders.keys()]
    .filter((label) => {
      const num = labelNumber(label)
      return num === null || num > count
    })
    .sort((a, b) => (labelNumber(a) ?? Infinity) - (labelNumber(b) ?? Infinity))
    .map(slotOf)
  return { slots, outOfRange, known: containers !== null }
}

function better(a: WithPending<MilkContainer>, b: WithPending<MilkContainer>): boolean {
  if (!!a.pending !== !!b.pending) return !a.pending
  return byAge(a, b) < 0
}

// ------------------------------------------------------------- N

export type BottleCountProblem = 'empty' | 'number' | 'whole' | 'range'

/**
 * "Cantidad de biberones" as typed in Settings (V4-10 CA1): a whole number
 * from MIN_BOTTLE_COUNT to MAX_BOTTLE_COUNT. Empty is a problem, never 0.
 */
export function validateBottleCount(
  text: string,
): { n: number; problem?: undefined } | { n?: undefined; problem: BottleCountProblem } {
  const raw = text.trim()
  if (raw === '') return { problem: 'empty' }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { problem: 'number' }
  if (!Number.isInteger(n)) return { problem: 'whole' }
  if (n < MIN_BOTTLE_COUNT || n > MAX_BOTTLE_COUNT) return { problem: 'range' }
  return { n }
}

/**
 * N as read: the column, or the default when a row from before 0015 (or a
 * read that did not select it) has none. Anything out of range — which the
 * database's CHECK does not let in — falls back to the default too.
 */
export function effectiveBottleCount(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' &&
    Number.isInteger(n) &&
    n >= MIN_BOTTLE_COUNT &&
    n <= MAX_BOTTLE_COUNT
    ? n
    : DEFAULT_BOTTLE_COUNT
}

// ------------------------------------------------------------- "sobró"

export type LeftoverProblem = 'number' | 'too_much'

/**
 * "Sobró" (V4-43, D-10): nothing (null) is fine — not known or nothing left;
 * a finite number from 0 up to what was served is fine; more than that, or
 * not a number, is a problem. Statistics only: it never moves the inventory.
 */
export function validateLeftover(
  leftoverMl: number | null,
  totalMl: number,
): LeftoverProblem | null {
  if (leftoverMl === null) return null
  if (!Number.isFinite(leftoverMl) || leftoverMl < 0) return 'number'
  if (leftoverMl > totalMl + DUST_ML) return 'too_much'
  return null
}

// ------------------------------------------------------------- the accounting

/**
 * Where a container's milk went (§2.1):
 *   amount = served + discarded + lost + remaining.
 * Replaces v3's `servedMl = amount − remaining`, which in v4 would count a
 * discard as served. With `drawdowns: null` (a page that did not read them),
 * `served` is what the other three leave — exact as long as the invariant
 * holds.
 */
export function containerBalance(
  c: MilkContainer,
  drawdowns: readonly MilkDrawdown[] | null,
  discards: readonly MilkDiscard[],
): { served: number; discarded: number; lost: number; remaining: number } {
  const discarded = discards
    .filter((d) => d.container_id === c.id && !d.voided_at)
    .reduce((s, d) => s + Number(d.amount_ml), 0)
  const lost = Number(c.lost_ml ?? 0)
  const remaining = Number(c.remaining_ml)
  const served = drawdowns
    ? drawdowns
        .filter((d) => d.container_id === c.id && !d.voided_at)
        .reduce((s, d) => s + Number(d.amount_ml), 0)
    : Math.max(0, Number(c.amount_ml) - discarded - lost - remaining)
  return { served, discarded, lost, remaining }
}

/** remaining + live discard + lost: the residue as the container holds it now. */
export function residueParts(c: MilkContainer, discards: readonly MilkDiscard[]): number {
  const b = containerBalance(c, null, discards)
  return b.remaining + b.discarded + b.lost
}

/** Is the number of `c` held by ANOTHER live, unreleased container? */
function labelHeldByOther(c: MilkContainer, containers: readonly MilkContainer[]): boolean {
  return containers.some((o) => o.id !== c.id && o.label === c.label && isOccupied(o))
}

export type RebalanceCause = 'serve' | 'return' | 'amount'

export type LostReason = 'discarded' | 'reused' | 'voided' | 'unknown'

/**
 * `milk_rebalance` (§2.3), exactly: the caller has changed the container's
 * amount or its portions, and says what the residue (`amount − served`) is
 * now. The difference with what the container holds goes:
 *
 *   · in (delta > 0):
 *       – cause 'amount' on a discarded container → the discard grows (D-8);
 *       – otherwise, if it can take it — not voided, not discarded, and
 *         either not released or its number still free (D-9) → `remaining`,
 *         and a released one is occupied again;
 *       – if not → `lost_ml` (D-9).
 *   · out (delta < 0): from `remaining`, then `lost`, then the discard; a
 *     discard that reaches 0 is voided (its amount stays — the CHECK wants it
 *     positive) and the container stays free without one (AJ-10).
 *   · then an occupied container below EMPTY_ML is released at `atIso`.
 *
 * A voided container is left as it is, as on the server (it has no portions
 * or discards to balance, INV-4); milk "coming back" to one is reported as
 * lost (`lostReason: 'voided'`) so the screen can say so, but booked nowhere.
 *
 * `containers` is the baby's list, to see whether another container holds
 * the number. Nothing passed in is changed.
 */
export function rebalance(
  c: MilkContainer,
  cause: RebalanceCause,
  newResidueMl: number,
  containers: readonly MilkContainer[],
  discards: readonly MilkDiscard[],
  atIso: string,
): {
  container: MilkContainer
  discards: MilkDiscard[]
  returnedMl: number
  lostMl: number
  lostReason?: LostReason
} {
  const container: MilkContainer = { ...c, lost_ml: Number(c.lost_ml ?? 0) }
  const out = discards.map((d) => ({ ...d }))
  const live = out.find((d) => d.container_id === c.id && !d.voided_at)
  const parts = container.remaining_ml + (live ? Number(live.amount_ml) : 0) + container.lost_ml!
  const delta = newResidueMl - parts
  let returnedMl = 0
  let lostMl = 0
  let lostReason: LostReason | undefined

  if (c.voided_at) {
    return delta > DUST_ML
      ? { container: c, discards: out, returnedMl: 0, lostMl: delta, lostReason: 'voided' }
      : { container: c, discards: out, returnedMl: 0, lostMl: 0 }
  }

  if (delta > DUST_ML) {
    if (cause === 'amount' && live) {
      live.amount_ml = Number(live.amount_ml) + delta
    } else {
      const reason: LostReason | null = live
        ? 'discarded'
        : container.released_at && labelHeldByOther(container, containers)
          ? 'reused'
          : null
      if (reason === null) {
        container.remaining_ml += delta
        container.released_at = null
        returnedMl = delta
      } else {
        container.lost_ml! += delta
        lostMl = delta
        lostReason = reason
      }
    }
  } else if (delta < -DUST_ML) {
    let take = -delta
    const fromRemaining = Math.min(container.remaining_ml, take)
    container.remaining_ml -= fromRemaining
    take -= fromRemaining
    const fromLost = Math.min(container.lost_ml!, take)
    container.lost_ml! -= fromLost
    take -= fromLost
    if (take > DUST_ML && live) {
      const left = Number(live.amount_ml) - take
      if (left <= DUST_ML) live.voided_at = atIso
      else live.amount_ml = left
    }
  }

  if (!container.released_at && container.remaining_ml < EMPTY_ML) {
    container.released_at = atIso
  }
  return { container, discards: out, returnedMl, lostMl, lostReason }
}

// ------------------------------------------------------------- editing a bottle (2A)

/** The final state asked for (absolute values, never deltas — §3.8). */
export type BottleEditRequest = {
  fed_at: string
  breast_milk_ml: number
  formula_ml: number
  leftover_ml: number | null
  /** Left out = not part of the comparison. */
  notes?: string | null
}

export type EditMovement = { containerId: string; label: string; ml: number }
export type EditLoss = EditMovement & { reason: LostReason }

export type BottleEditPlan = {
  ok: true
  /** Already in the requested state: nothing to send that changes anything. */
  noop: boolean
  /** Breast milk asked for minus what the bottle has now. */
  deltaMl: number
  /** The bottle's live portions after the edit, oldest container first. */
  portions: EditMovement[]
  /** Milk that goes back into a container (D-17). */
  returned: EditMovement[]
  /** Milk that cannot go back (D-9): the portion shrinks, the stash does not grow. */
  lost: EditLoss[]
  /** Milk taken from the oldest container usable at the bottle's time (D-18). */
  taken: EditMovement[]
  /** The lists after the edit, for the screen and the offline view. */
  containers: MilkContainer[]
  drawdowns: MilkDrawdown[]
  discards: MilkDiscard[]
}

export type BottleEditRefusal =
  | { ok: false; problem: 'bad_input' }
  | { ok: false; problem: 'not_inventory' }
  | { ok: false; problem: 'future' }
  | { ok: false; problem: 'not_enough'; availableMl: number; neededMl: number }
  | { ok: false; problem: 'unusable'; label: string }

type EditableFeeding = Pick<
  Feeding,
  'id' | 'fed_at' | 'feeding_type' | 'breast_milk_ml' | 'formula_ml'
> &
  Partial<Pick<Feeding, 'amount_ml' | 'leftover_ml' | 'notes'>>

const finiteIn = (x: number) => Number.isFinite(x) && x >= 0 && x < 100000

/**
 * The full edit of a past bottle (2A), as `edit_bottle_feed` will do it —
 * the same plan, so the screen can say what happens before sending, and the
 * offline view shows it until the server decides (V4-57).
 *
 * Order of the checks, the server's: input → not an inventory bottle →
 * already as asked (no-op) → time in the future (by `atMs`, + 10 min) →
 * the plan:
 *   · less breast milk (D-17): from the portion of the NEWEST container
 *     (stored_at desc, number desc) down to 0 — voided — before the next;
 *     each container gets its milk back through `rebalance(…, 'return')`,
 *     which may make it lost (D-9);
 *   · more breast milk (D-18): FIFO from containers that were usable at the
 *     bottle's FINAL time — not voided, not released, stored_at ≤ fed_at,
 *     expires_at > fed_at, at least EMPTY_ML — oldest first; a container the
 *     bottle already uses grows its portion (a voided one is revived);
 *     not enough → `not_enough` with what there was, and nothing changes;
 *   · formula is only a number and never blocks.
 * Then every portion left must still be from a container not expired at the
 * new time and stored no later than it + 10 min (D-7) → else `unusable`.
 *
 * Not checked here (only the server can): `p_expected` against what another
 * phone wrote meanwhile (`milk_edit_conflict`).
 */
export function planBottleEdit(
  feeding: EditableFeeding,
  drawdowns: readonly MilkDrawdown[],
  containers: readonly MilkContainer[],
  discards: readonly MilkDiscard[],
  request: BottleEditRequest,
  atMs: number,
): BottleEditPlan | BottleEditRefusal {
  const { breast_milk_ml: breast, formula_ml: formula, leftover_ml: leftover } = request
  const fedMs = Date.parse(request.fed_at)
  if (
    !finiteIn(breast) ||
    !finiteIn(formula) ||
    !(breast + formula > 0 && breast + formula < 100000) ||
    Number.isNaN(fedMs) ||
    (leftover !== null && validateLeftover(leftover, breast + formula) !== null)
  ) {
    return { ok: false, problem: 'bad_input' }
  }
  if (
    feeding.feeding_type !== 'bottle' ||
    (feeding.breast_milk_ml == null && feeding.formula_ml == null)
  ) {
    return { ok: false, problem: 'not_inventory' }
  }

  const atIso = new Date(atMs).toISOString()
  let cs = containers.map((c) => ({ ...c }))
  let ds = drawdowns.map((d) => ({ ...d }))
  let dc = discards.map((d) => ({ ...d }))
  const current = Number(feeding.breast_milk_ml ?? 0)
  const deltaMl = breast - current

  const same = (a: number | null | undefined, b: number | null | undefined) =>
    a == null || b == null ? a == null && b == null : Math.abs(a - b) <= DUST_ML
  const noop =
    Date.parse(feeding.fed_at) === fedMs &&
    same(current, breast) &&
    same(feeding.formula_ml ?? 0, formula) &&
    same(feeding.leftover_ml ?? null, leftover) &&
    (request.notes === undefined || (feeding.notes ?? null) === (request.notes ?? null))

  const livePortions = () =>
    ds.filter((d) => d.feeding_id === feeding.id && !d.voided_at && d.amount_ml > 0)
  const containerOf = (id: string) => cs.find((c) => c.id === id)
  const labelOf = (id: string, d?: MilkDrawdown) => containerOf(id)?.label ?? d?.label ?? '?'
  const finish = (
    returned: EditMovement[],
    lost: EditLoss[],
    taken: EditMovement[],
  ): BottleEditPlan => ({
    ok: true,
    noop,
    deltaMl,
    portions: livePortions()
      .map((d) => ({ d, c: containerOf(d.container_id) }))
      .sort((a, b) => (a.c && b.c ? byAge(a.c, b.c) : 0))
      .map(({ d }) => ({
        containerId: d.container_id,
        label: labelOf(d.container_id, d),
        ml: d.amount_ml,
      })),
    returned,
    lost,
    taken,
    containers: cs,
    drawdowns: ds,
    discards: dc,
  })

  if (noop) return finish([], [], [])
  if (fedMs > atMs + FUTURE_TOLERANCE_MS) return { ok: false, problem: 'future' }

  const returned: EditMovement[] = []
  const lost: EditLoss[] = []
  const taken: EditMovement[] = []

  if (deltaMl < -DUST_ML) {
    // D-17: the newest container gives back first.
    const newestFirst = livePortions()
      .map((d) => ({ d, c: containerOf(d.container_id) }))
      .sort((a, b) => {
        if (!a.c || !b.c) return a.c ? -1 : b.c ? 1 : 0
        return byAge(b.c, a.c)
      })
    let give = -deltaMl
    for (const { d, c } of newestFirst) {
      if (give <= DUST_ML) break
      const back = Math.min(d.amount_ml, give)
      give -= back
      const left = d.amount_ml - back
      ds = ds.map((x) =>
        x === d ? (left <= DUST_ML ? { ...x, voided_at: atIso } : { ...x, amount_ml: left }) : x,
      )
      if (!c) {
        lost.push({
          containerId: d.container_id,
          label: labelOf(d.container_id, d),
          ml: back,
          reason: 'unknown',
        })
        continue
      }
      const r = rebalance(c, 'return', residueParts(c, dc) + back, cs, dc, atIso)
      cs = cs.map((x) => (x.id === c.id ? r.container : x))
      dc = r.discards
      if (r.returnedMl > 0) returned.push({ containerId: c.id, label: c.label, ml: r.returnedMl })
      if (r.lostMl > 0)
        lost.push({ containerId: c.id, label: c.label, ml: r.lostMl, reason: r.lostReason! })
    }
  } else if (deltaMl > DUST_ML) {
    // D-18: the oldest milk that was usable at the bottle's final time.
    const candidates = cs
      .filter(
        (c) =>
          !c.voided_at &&
          !c.released_at &&
          !hasLiveDiscard(c, dc) &&
          Date.parse(c.stored_at) <= fedMs &&
          Date.parse(c.expires_at) > fedMs &&
          c.remaining_ml >= EMPTY_ML,
      )
      .sort(byAge)
    const availableMl = candidates.reduce((s, c) => s + c.remaining_ml, 0)
    if (availableMl < deltaMl - DUST_ML) {
      return { ok: false, problem: 'not_enough', availableMl, neededMl: deltaMl }
    }
    let need = deltaMl
    for (const c of candidates) {
      if (need <= DUST_ML) break
      const ml = Math.min(c.remaining_ml, need)
      need -= ml
      const existing = ds.find((d) => d.feeding_id === feeding.id && d.container_id === c.id)
      if (existing) {
        const grown = existing.voided_at ? ml : existing.amount_ml + ml
        ds = ds.map((x) => (x === existing ? { ...x, amount_ml: grown, voided_at: null } : x))
      } else {
        ds = [
          ...ds,
          {
            id: `${feeding.id}:${c.id}`,
            feeding_id: feeding.id,
            container_id: c.id,
            amount_ml: ml,
            label: c.label,
            voided_at: null,
          },
        ]
      }
      const r = rebalance(c, 'serve', residueParts(c, dc) - ml, cs, dc, atIso)
      cs = cs.map((x) => (x.id === c.id ? r.container : x))
      dc = r.discards
      taken.push({ containerId: c.id, label: c.label, ml })
    }
  }

  // D-7 / V4-55: what stays in the bottle has to be good at the new time.
  // The first bad one by id, as 0015 picks it (`order by c.id`).
  const stale = livePortions()
    .map((d) => containerOf(d.container_id))
    .filter((c): c is MilkContainer => !!c)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .find(
      (c) =>
        Date.parse(c.expires_at) <= fedMs || Date.parse(c.stored_at) > fedMs + FUTURE_TOLERANCE_MS,
    )
  if (stale) return { ok: false, problem: 'unusable', label: stale.label }

  return finish(returned, lost, taken)
}

// ------------------------------------------------------------- the invariant

/** The checks of §2.4, by id. INV-7 is a constraint in SQL; here it is checked too. */
export const MILK_INVARIANT_IDS = [
  'INV-1',
  'INV-2',
  'INV-3',
  'INV-4',
  'INV-5',
  'INV-6',
  'INV-7',
  'INV-8',
  'INV-9',
] as const
export type MilkInvariantId = (typeof MILK_INVARIANT_IDS)[number]

export type MilkInvariantFailure = { check: MilkInvariantId; id: string; detail: string }

type Voidable = { voided_at?: string | null }

/**
 * §2.1–§2.2 in TypeScript, the same arithmetic as the SQL of §2.4: every row
 * that breaks a rule, empty when it all adds up. Pass EVERY row, voided ones
 * included (the voided ones are what INV-4 and INV-9 look at). Usable by the
 * integration helper (reading with the admin client) and by unit tests.
 */
export function milkInvariantFailures(input: {
  containers: readonly (MilkContainer & { baby_id?: string })[]
  drawdowns: readonly MilkDrawdown[]
  discards: readonly MilkDiscard[]
  feedings?: readonly (Pick<
    Feeding,
    'id' | 'amount_ml' | 'breast_milk_ml' | 'formula_ml' | 'leftover_ml'
  > &
    Voidable)[]
  sessions?: readonly (Pick<PumpingSession, 'id' | 'amount_ml'> & Voidable)[]
}): MilkInvariantFailure[] {
  const out: MilkInvariantFailure[] = []
  const eps = 1e-9
  const sumBy = <T>(rows: readonly T[], key: (r: T) => string, amount: (r: T) => number) => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + amount(r))
    return m
  }
  const liveDraws = input.drawdowns.filter((d) => !d.voided_at)
  const liveDiscards = input.discards.filter((d) => !d.voided_at)
  const served = sumBy(
    liveDraws,
    (d) => d.container_id,
    (d) => Number(d.amount_ml),
  )
  const discarded = sumBy(
    liveDiscards,
    (d) => d.container_id,
    (d) => Number(d.amount_ml),
  )
  const byFeeding = sumBy(
    liveDraws,
    (d) => d.feeding_id,
    (d) => Number(d.amount_ml),
  )

  for (const c of input.containers) {
    const s = served.get(c.id) ?? 0
    const d = discarded.get(c.id) ?? 0
    const lost = Number(c.lost_ml ?? 0)
    if (c.voided_at) {
      if (served.has(c.id) || discarded.has(c.id))
        out.push({ check: 'INV-4', id: c.id, detail: `${c.label}: voided with live rows` })
      continue
    }
    if (Math.abs(c.amount_ml - s - d - lost - c.remaining_ml) > eps)
      out.push({
        check: 'INV-1',
        id: c.id,
        detail: `${c.label}: ${c.amount_ml} ≠ ${s} + ${d} + ${lost} + ${c.remaining_ml}`,
      })
    if (discarded.has(c.id) && (!c.released_at || c.remaining_ml !== 0))
      out.push({ check: 'INV-3', id: c.id, detail: `${c.label}: discard on a held container` })
    if (!c.released_at && c.remaining_ml < EMPTY_ML)
      out.push({ check: 'INV-5', id: c.id, detail: `${c.label}: occupied and empty` })
    if (c.released_at && c.remaining_ml >= EMPTY_ML)
      out.push({ check: 'INV-5', id: c.id, detail: `${c.label}: released with milk` })
  }

  const held = new Map<string, string[]>()
  for (const c of input.containers) {
    if (c.voided_at || c.released_at) continue
    const key = `${c.baby_id ?? ''}|${c.label}`
    held.set(key, [...(held.get(key) ?? []), c.id])
  }
  for (const [key, ids] of held)
    if (ids.length > 1)
      out.push({ check: 'INV-2', id: ids.slice().sort()[0], detail: `${key}: ${ids.length}` })

  const feedings = input.feedings ?? []
  for (const f of feedings) {
    if (f.voided_at) continue
    if (f.breast_milk_ml != null || f.formula_ml != null) {
      const breast = Number(f.breast_milk_ml ?? 0)
      const formula = Number(f.formula_ml ?? 0)
      const p = byFeeding.get(f.id) ?? 0
      if (Math.abs(breast - p) > eps || Math.abs(Number(f.amount_ml) - breast - formula) > eps)
        out.push({ check: 'INV-6', id: f.id, detail: `breast ${breast}, portions ${p}` })
    }
    if (f.leftover_ml != null && f.amount_ml != null && f.leftover_ml > f.amount_ml)
      out.push({ check: 'INV-7', id: f.id, detail: `leftover ${f.leftover_ml} > ${f.amount_ml}` })
  }

  const sessions = new Map((input.sessions ?? []).map((s) => [s.id, s]))
  for (const c of input.containers) {
    const s = c.source_session_id ? sessions.get(c.source_session_id) : undefined
    if (!c.voided_at && s && !s.voided_at && Number(s.amount_ml) !== Number(c.amount_ml))
      out.push({ check: 'INV-8', id: c.id, detail: `${c.label}: ${s.amount_ml} ≠ ${c.amount_ml}` })
  }

  const voidedFeedings = new Set(feedings.filter((f) => f.voided_at).map((f) => f.id))
  for (const d of liveDraws)
    if (voidedFeedings.has(d.feeding_id))
      out.push({ check: 'INV-9', id: d.feeding_id, detail: `portion ${d.id} on a voided bottle` })

  return out
}
