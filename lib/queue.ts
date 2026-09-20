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
 * Replay pending writes oldest first.
 *
 * Stops at the first failure and leaves the rest queued: order matters,
 * because an update may target a row whose insert is still ahead of it.
 */
export async function flushQueue(
  store: QueueStore,
  schema: string,
  send: (op: PendingOp) => Promise<{ error: string | null }>,
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

    const { error } = await send(write.op)
    if (error) {
      // Lo que sigue en el store son las entradas de `i` en adelante, esta
      // incluida. Los descartes ya salieron y ya quedaron detrás del índice:
      // restarlos otra vez contaba de menos y la UI podía decir "0
      // pendientes" con una escritura adentro (CLAUDE.md §5.5).
      return { sent, dropped, remaining: pending.length - i, error }
    }

    await store.remove(write.id)
    sent += 1
  }

  return { sent, dropped, remaining: 0, error: null }
}

/** True for "the request never reached the server", false for a rejection. */
export function looksOffline(message: string | null): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  if (!message) return false
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
