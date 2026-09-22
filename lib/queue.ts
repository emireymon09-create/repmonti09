/**
 * Writes made with no connection.
 *
 * The 3am case this exists for: a tap in a nursery with bad wifi must
 * not vanish. It is kept on the device and replayed when the phone is
 * back, and until then the UI says so — a queued entry is never
 * presented as saved.
 *
 * The one trick that makes replay safe: rows are inserted with a
 * CLIENT-GENERATED uuid. Postgres accepts an explicit id over its
 * `default gen_random_uuid()`, so a session started offline can be
 * ended offline too — the later update targets an id we already chose,
 * and the pair replays in order.
 *
 * Replaying the same write twice must be harmless, because it happens:
 * two tabs coming back online at once, or an insert that reached the
 * server whose response was lost (it stays queued and is sent again).
 * Two guards, and the first one is the one that makes it safe:
 *
 *   · replayed inserts go out as INSERT … ON CONFLICT (id) DO NOTHING
 *     (sendOpWith in lib/db.ts), so a row already there counts as sent instead
 *     of failing on the primary key and blocking everything behind it;
 *   · replays run one at a time across tabs (`withFlushLock`), so a slow
 *     tab can't re-send an old update over a newer one. A tab that finds
 *     the queue taken doesn't wait in line to send (a hung request would
 *     hold everyone); it waits for that flush to end and reads again.
 *
 * Only the replay skips an existing row. A write made online is a plain
 * insert, so an id clash there shows as an error, never as "Saved".
 *
 * The store is behind an interface so the replay logic can be tested
 * without a browser.
 */

export type PendingOp =
  | { kind: 'insert'; table: string; row: Record<string, unknown> }
  | { kind: 'update'; table: string; id: string; patch: Record<string, unknown> }

export type PendingWrite = {
  id: string
  /** Guards the phase-2 move to the `baby` schema — see flushQueue. */
  schema: string
  /** What to call it in the UI: "Bottle", "Diaper (wet)". */
  label: string
  queuedAt: string
  op: PendingOp
}

export interface QueueStore {
  all(): Promise<PendingWrite[]>
  add(write: PendingWrite): Promise<void>
  remove(id: string): Promise<void>
}

export type FlushResult = {
  sent: number
  /** Entries discarded because they targeted a schema that no longer exists. */
  dropped: number
  remaining: number
  error: string | null
  /** Another flush held the queue, so this one sent nothing. */
  busy?: boolean
  /** The entry the flush stopped at, when `error` is set. */
  failed?: PendingWrite
}

export function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // Older WebViews. Not cryptographic, and does not need to be — this
  // is a row id, and Postgres has the uniqueness constraint.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * How long one replayed write may take. A request that hangs (the wifi
 * that drops without saying so) would otherwise hold the flush lock, and
 * with it every other tab's sync, for as long as the browser lets it hang.
 */
export const REPLAY_TIMEOUT_MS = 15_000

/** What a timed-out replay reports; looksOffline() reads it as offline. */
export const TIMED_OUT = 'Network request timed out'

function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  if (typeof AbortController === 'undefined') return undefined
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

/**
 * One send with a deadline. The signal cancels the request itself; the
 * race is the backstop for a send that ignores it. Either way it ends as
 * TIMED_OUT — offline, not a rejection: the entry stays queued, the lock
 * is let go, and the next sync tries again (a replayed insert that did
 * land meanwhile is skipped, not an error).
 */
async function sendWithin(
  send: (op: PendingOp, signal?: AbortSignal) => Promise<{ error: string | null }>,
  op: PendingOp,
  ms: number,
): Promise<{ error: string | null }> {
  const signal = timeoutSignal(ms)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ error: TIMED_OUT }), ms)
  })
  try {
    const result = await Promise.race([send(op, signal), late])
    return result.error && signal?.aborted ? { error: TIMED_OUT } : result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Replay pending writes oldest first.
 *
 * Stops at the first failure and leaves the rest queued: order matters,
 * because an update may target a row whose insert is still ahead of it.
 * Each send gets `timeoutMs` (see sendWithin).
 */
export async function flushQueue(
  store: QueueStore,
  schema: string,
  send: (op: PendingOp, signal?: AbortSignal) => Promise<{ error: string | null }>,
  timeoutMs: number = REPLAY_TIMEOUT_MS,
): Promise<FlushResult> {
  const pending = (await store.all()).slice().sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))

  let sent = 0
  let dropped = 0

  for (let i = 0; i < pending.length; i += 1) {
    const write = pending[i]

    // Written against a schema this build no longer talks to. Keeping
    // it would write to the wrong place; replaying it is not possible.
    if (write.schema !== schema) {
      await store.remove(write.id)
      dropped += 1
      continue
    }

    const { error } = await sendWithin(send, write.op, timeoutMs)
    if (error) {
      // Lo que sigue en el store son las entradas de `i` en adelante, esta
      // incluida. Los descartes ya salieron y ya quedaron detrás del índice:
      // restarlos otra vez contaba de menos y la UI podía decir "0
      // pendientes" con una escritura adentro (CLAUDE.md §5.5).
      return { sent, dropped, remaining: pending.length - i, error, failed: write }
    }

    await store.remove(write.id)
    sent += 1
  }

  return { sent, dropped, remaining: 0, error: null }
}

/** The part of the Web Locks API the flush uses — a fake in the tests. */
export type FlushLocks = {
  request<T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

const FLUSH_LOCK = 'amelia-flush'

// Without Web Locks (old WebViews) this at least keeps one tab's own
// flushes from overlapping. Two such tabs can still overlap; that stays
// safe because a replayed insert already on the server is skipped, not
// an error.
let running: Promise<unknown> | null = null

function browserLocks(): FlushLocks | null {
  if (typeof navigator === 'undefined') return null
  const locks = (navigator as unknown as { locks?: FlushLocks }).locks
  return locks && typeof locks.request === 'function' ? locks : null
}

/**
 * Run `fn` unless another flush — in this tab or another one — is already
 * running; then return null at once without sending anything.
 *
 * Not waiting is the point: a tab whose request hangs holds the lock, and
 * the others must not sit behind it. They find out when it is done with
 * `flushSettled` and read again (useSync).
 */
export async function withFlushLock<T>(
  fn: () => Promise<T>,
  locks: FlushLocks | null = browserLocks(),
): Promise<T | null> {
  if (locks) {
    return locks.request(FLUSH_LOCK, { ifAvailable: true }, (lock) =>
      lock ? fn() : Promise.resolve(null),
    )
  }
  if (running) return null
  const run = fn()
  running = run
  try {
    return await run
  } finally {
    if (running === run) running = null
  }
}

/** Resolves once no flush is running. Sends nothing; only waits. */
export async function flushSettled(locks: FlushLocks | null = browserLocks()): Promise<void> {
  if (locks) {
    await locks.request(FLUSH_LOCK, async () => undefined)
    return
  }
  if (running) await running.catch(() => undefined)
}

/**
 * One sync round, as useSync runs it: flush, and if another flush held
 * the queue, wait for it to finish and — still connected, with entries
 * left (that flush may have timed out on a hung request) — try once more
 * here. Once: if that one finds the queue taken again, or fails, the
 * retry schedule (retryDelay) takes over, never a loop.
 *
 * `reread` says whether the page has to read the server again: after
 * anything was sent or dropped, after another tab's flush (it may have
 * sent this tab's entries), and when the device just came back online —
 * the page may be showing a saved copy or an "offline, nothing here yet"
 * that only a fresh read replaces.
 */
export async function syncOnce(
  flush: () => Promise<FlushResult>,
  settled: () => Promise<void>,
  cameOnline: boolean,
  online: () => boolean = () => true,
): Promise<{ result: FlushResult; reread: boolean }> {
  let result = await flush()
  const waited = !!result.busy
  if (waited) {
    await settled()
    if (online() && result.remaining > 0) result = await flush()
  }
  const reread = cameOnline || waited || result.sent > 0 || result.dropped > 0
  return { result, reread }
}

/** Waits between automatic retries while connected: 5 s, 15 s, then every 60 s. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000]

/**
 * After a sync round, how long until trying again by itself — or null for
 * "don't". Only when connected, with entries left, and for a reason that a
 * later try can fix: the request never got an answer (timed out, the
 * network failed under a connection the browser still calls up) or another
 * tab held the queue. A rejection from the server is not retried: it
 * would fail the same way, and the page shows it as an error instead.
 */
export function retryDelay(
  result: FlushResult | null,
  attempt: number,
  online: boolean,
  /**
   * Something else is waiting on the network even without a flush result
   * that says so: an entry just queued while the browser calls itself
   * online (bad wifi), or a page whose last read failed the same way.
   */
  alsoWaiting = false,
): number | null {
  if (!online) return null
  const queueWaits =
    !!result && result.remaining > 0 && (result.error ? looksOffline(result.error) : !!result.busy)
  if (!queueWaits && !alsoWaiting) return null
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
}

/**
 * Nudges for useSync from code that isn't React: an entry was just queued
 * (lib/db.ts), or a page's read failed for lack of network / worked
 * (lib/lastSeen.ts). With "bad wifi" the browser never fires 'online',
 * so without these nothing would start the retries. Same tab only.
 */
export type SyncNudge = 'queued' | 'read-failed' | 'read-ok'
const NUDGES: SyncNudge[] = ['queued', 'read-failed', 'read-ok']
const nudges = typeof EventTarget === 'undefined' ? null : new EventTarget()

export function nudgeSync(kind: SyncNudge): void {
  nudges?.dispatchEvent(new Event(kind))
}

export function onSyncNudge(callback: (kind: SyncNudge) => void): () => void {
  if (!nudges) return () => {}
  const handlers = NUDGES.map((kind) => {
    const handler = () => callback(kind)
    nudges.addEventListener(kind, handler)
    return [kind, handler] as const
  })
  return () => handlers.forEach(([kind, handler]) => nudges.removeEventListener(kind, handler))
}

/**
 * What discarding `id` takes with it, read from the queue as it is now:
 * the entry and, if it is an insert, the changes queued later for that
 * same row — without the row they could never apply. Empty if it is gone.
 */
export async function discardPlan(store: QueueStore, id: string): Promise<PendingWrite[]> {
  const all = await store.all()
  const target = all.find((w) => w.id === id)
  return target ? [target, ...dependentsOf(target, all)] : []
}

/**
 * Take entries out of the queue — only ever at the user's say-so (the
 * sync banner's "Discard this entry", after a confirm naming them):
 * nothing leaves the queue silently (CLAUDE.md §5.5). Exactly the ids
 * that confirm counted: an entry queued meanwhile (another tab) stays.
 * Returns what was removed.
 */
export async function discardWrites(store: QueueStore, ids: string[]): Promise<PendingWrite[]> {
  const all = await store.all()
  const gone = all.filter((w) => ids.includes(w.id))
  for (const w of gone) await store.remove(w.id)
  return gone
}

/** A queued soft delete: an update that sets `voided_at`. */
export function isDeletion(write: PendingWrite): boolean {
  return write.op.kind === 'update' && 'voided_at' in write.op.patch
}

/** Queued changes to the row an insert creates — they go if it is discarded. */
export function dependentsOf(write: PendingWrite, all: PendingWrite[]): PendingWrite[] {
  if (write.op.kind !== 'insert') return []
  const { table } = write.op
  const rowId = write.op.row.id
  return all.filter((w) => w.op.kind === 'update' && w.op.table === table && w.op.id === rowId)
}

/** True for "the request never reached the server", false for a rejection. */
export function looksOffline(message: string | null): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  if (!message) return false
  // A request this app cut short (a replay's deadline, or an abort as
  // supabase-js words it) — matched exactly, so that a server's own
  // "timed out" (PGRST003, a statement timeout) stays a rejection.
  if (message === TIMED_OUT || /^(AbortError|TimeoutError):/.test(message)) return true
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet/i.test(
    message,
  )
}

// --------------------------------------------------------------- IndexedDB

const DB_NAME = 'amelia-pending'
const DB_VERSION = 1
const STORE = 'writes'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * IndexedDB, or a store that quietly holds nothing.
 *
 * Private browsing and locked-down kiosk profiles can refuse storage.
 * Losing the queue is worse than not having it, so a failure here is
 * reported through the caller's normal error path rather than throwing
 * on a button press.
 */
export function browserQueueStore(): QueueStore {
  const available = typeof indexedDB !== 'undefined'

  return {
    async all() {
      if (!available) return []
      try {
        const db = await openDb()
        const tx = db.transaction(STORE, 'readonly')
        return (await promisify(tx.objectStore(STORE).getAll())) as PendingWrite[]
      } catch {
        return []
      }
    },
    async add(write) {
      if (!available) throw new Error('This device will not let the app store anything offline.')
      const db = await openDb()
      const tx = db.transaction(STORE, 'readwrite')
      await promisify(tx.objectStore(STORE).put(write))
    },
    async remove(id) {
      if (!available) return
      try {
        const db = await openDb()
        const tx = db.transaction(STORE, 'readwrite')
        await promisify(tx.objectStore(STORE).delete(id))
      } catch {
        /* it will be retried and removed next flush */
      }
    },
  }
}
