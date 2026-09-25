/**
 * The last rows each page read from the server, kept on this device.
 *
 * Offline, a page keeps showing what the server last returned
 * (keepLastGood in lib/db.ts) — but only in memory, so a reload with no
 * connection used to start from nothing. This keeps a copy in
 * localStorage, so the wall screen reloaded during a wifi outage shows
 * what it last saw, marked as such, instead of an empty page.
 *
 * What is kept, and what is not:
 *
 *   · Rows of the signed-in family only, as the server returned them
 *     under RLS. Never a token, never a session — auth stays with
 *     Supabase's own storage.
 *   · It is wiped on sign-out (components/ui.tsx), on a new sign-in
 *     (app/login) and whenever the app finds nobody signed in
 *     (lib/useBaby.ts): this runs on a screen the whole house shares.
 *
 * Storage can refuse (private browsing, a full quota, a locked-down
 * kiosk profile). Every call swallows that: without storage the app
 * behaves exactly as it did before this existed.
 *
 * Not the service worker's job: public/sw.js never caches a Supabase
 * response (CLAUDE.md §5.5). This is app data, in the app's hands.
 */

import { looksOffline, nudgeSync } from '@/lib/queue'

/** The part of `localStorage` used here — a fake in the tests. */
export type SeenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

export type Seen<T> = { rows: T; savedAt: string }

const PREFIX = 'amelia:seen:'
// Bumped when the shape of what is stored changes; older copies are ignored.
const VERSION = 1

function browserStorage(): SeenStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** What was saved under `key`, or null if nothing (or nothing usable) is. */
export function readSeen<T>(
  key: string,
  storage: SeenStorage | null = browserStorage(),
): Seen<T> | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { v?: number; savedAt?: unknown; rows?: unknown }
    if (parsed.v !== VERSION || typeof parsed.savedAt !== 'string' || parsed.rows == null) {
      return null
    }
    return { rows: parsed.rows as T, savedAt: parsed.savedAt }
  } catch {
    return null
  }
}

/** Keep `rows` as the last thing seen under `key`. */
export function saveSeen<T>(
  key: string,
  rows: T,
  now: Date = new Date(),
  storage: SeenStorage | null = browserStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(PREFIX + key, JSON.stringify({ v: VERSION, savedAt: now.toISOString(), rows }))
  } catch {
    /* over quota or refused: the page just won't have it next time */
  }
}

/** Forget everything this file ever saved. Sign-out calls it. */
export function forgetSeen(storage: SeenStorage | null = browserStorage()): void {
  if (!storage) return
  try {
    const mine: string[] = []
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i)
      if (k && k.startsWith(PREFIX)) mine.push(k)
    }
    for (const k of mine) storage.removeItem(k)
  } catch {
    /* nothing to do: storage that can't be read holds nothing of ours */
  }
}

/**
 * What a page tells the user about the rows it shows:
 *
 *   · 'live'    — the last read worked (or failed for a reason other than
 *                 the network, which is shown as an error instead).
 *   · 'saved'   — the last read failed for lack of network; the rows are
 *                 the last good ones, from `savedAt` — this session's last
 *                 good read, or the copy saved on this device before.
 *   · 'nothing' — the same, with no good read ever: an honest "nothing
 *                 here yet" instead of "no sleep logged yet".
 */
export type SeenState = { kind: 'live' } | { kind: 'saved'; savedAt: string } | { kind: 'nothing' }

export function seenState(opts: { offline: boolean; lastGoodAt: string | null }): SeenState {
  if (!opts.offline) return { kind: 'live' }
  if (opts.lastGoodAt) return { kind: 'saved', savedAt: opts.lastGoodAt }
  return { kind: 'nothing' }
}

/**
 * The storage keys, in one place. Page rows are per baby, so another
 * family's copy could never be the one a page reads; the baby itself is
 * one entry, overwritten by whoever signs in next.
 */
export const seenKey = {
  baby: 'baby',
  page: (
    page: 'dashboard' | 'history' | 'growth' | 'feeding' | 'diapers' | 'sleep' | 'statistics',
    babyId: string,
  ) => `${page}:${babyId}`,
}

/**
 * A page's "last good rows", started from this device's saved copy and
 * saved again after every round of reads that all worked.
 *
 * `rows` is what keepLastGood (lib/db.ts) builds on; `settle` takes what
 * it returned and says what the page should tell the user about it.
 */
export type LastGood<T> = {
  /** The storage key: a page starts a new one when the baby changes. */
  readonly key: string
  readonly rows: T
  readonly saved: Seen<T> | null
  /** After a round of reads: the rows to keep and the first read error. */
  settle(rows: T, error: string | null): SeenState
  /**
   * For a repaint before the reads answer (from the queue, at once): the
   * state as the last read left it. Only before any read of this page has
   * answered does `offline` decide — to show the saved copy right away on
   * a reload with no connection.
   */
  state(offline: boolean): SeenState
}

// How the most recent read of any page ended. Kept on the device too, so
// a page opened or reloaded in the middle of an outage — with the browser
// still saying "online" — starts from "saved" instead of "live". The page
// only paints from it before its reads answer when something is queued;
// with an empty queue the note waits for those reads to give up
// (CLAUDE.md §6). Under the same prefix, so sign-out clears it with the rest.
const DOWN_KEY = 'net-down'

function networkDown(storage: SeenStorage | null): boolean {
  if (!storage) return false
  try {
    return storage.getItem(PREFIX + DOWN_KEY) === '1'
  } catch {
    return false
  }
}

function setNetworkDown(down: boolean, storage: SeenStorage | null): void {
  if (!storage) return
  try {
    if (down) storage.setItem(PREFIX + DOWN_KEY, '1')
    else storage.removeItem(PREFIX + DOWN_KEY)
  } catch {
    /* only the note's first seconds depend on it */
  }
}

export function lastGood<T extends Record<string, unknown>>(
  key: string,
  empty: T,
  storage?: SeenStorage | null,
): LastGood<T> {
  const found = readSeen<T>(key, storage)
  // Spread over `empty`, so a copy saved before a new kind of row existed
  // still hands back every key the page expects.
  const saved = found ? { ...found, rows: { ...empty, ...found.rows } } : null
  let rows: T = saved ? saved.rows : empty
  // When the rows on screen were last good: a read in this session, or
  // the saved copy. Offline, that is what the note says — also after a
  // cut in the middle of a session, when the browser may still say
  // "online" and the rows are only getting older.
  let lastGoodAt: string | null = saved?.savedAt ?? null
  const store = storage === undefined ? browserStorage() : storage
  let current: SeenState | null = networkDown(store)
    ? seenState({ offline: true, lastGoodAt })
    : null

  return {
    key,
    get rows() {
      return rows
    },
    saved,
    settle(next, error) {
      rows = next
      const offline = !!error && looksOffline(error)
      if (!error) {
        const now = new Date()
        lastGoodAt = now.toISOString()
        saveSeen(key, next, now, storage)
      }
      // useSync retries the reads while they fail for lack of network, and
      // stops once one works (bad wifi never fires 'online').
      if (!error) nudgeSync('read-ok')
      else if (offline) nudgeSync('read-failed')
      if (!error) setNetworkDown(false, store)
      else if (offline) setNetworkDown(true, store)
      current = seenState({ offline, lastGoodAt })
      return current
    },
    state(offline) {
      return current ?? seenState({ offline, lastGoodAt })
    },
  }
}
