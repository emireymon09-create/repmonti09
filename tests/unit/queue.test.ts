import { describe, expect, it } from 'vitest'
import {
  flushQueue,
  looksOffline,
  flushSettled,
  newId,
  dependentsOf,
  discardPlan,
  discardWrites,
  isDeletion,
  nudgeSync,
  onSyncNudge,
  retryDelay,
  syncOnce,
  TIMED_OUT,
  withFlushLock,
  type FlushLocks,
  type FlushResult,
  type PendingOp,
  type PendingWrite,
  type QueueStore,
} from '@/lib/queue'

function store(initial: PendingWrite[]): QueueStore & { rows: PendingWrite[] } {
  const rows = [...initial]
  return {
    rows,
    async all() {
      return [...rows]
    },
    async add(w) {
      rows.push(w)
    },
    async remove(id) {
      const i = rows.findIndex((r) => r.id === id)
      if (i >= 0) rows.splice(i, 1)
    },
  }
}

function write(id: string, queuedAt: string, op: PendingOp, schema = 'public'): PendingWrite {
  return { id, schema, label: id, queuedAt, op }
}

const insert: PendingOp = { kind: 'insert', table: 'feedings', row: { id: 'a' } }
const update: PendingOp = { kind: 'update', table: 'feedings', id: 'a', patch: { amount_ml: 90 } }

describe('flushQueue', () => {
  it('reenvía del más viejo al más nuevo', async () => {
    const s = store([
      write('2', '2026-01-15T10:05:00Z', update),
      write('1', '2026-01-15T10:00:00Z', insert),
    ])
    const seen: PendingOp[] = []
    const result = await flushQueue(s, 'public', async (op) => {
      seen.push(op)
      return { error: null }
    })

    expect(seen).toEqual([insert, update])
    expect(result).toEqual({ sent: 2, dropped: 0, remaining: 0, error: null })
    expect(s.rows).toHaveLength(0)
  })

  it('se detiene en el primer fallo y deja el resto en cola', async () => {
    const s = store([
      write('1', '2026-01-15T10:00:00Z', insert),
      write('2', '2026-01-15T10:05:00Z', update),
    ])
    const result = await flushQueue(s, 'public', async (op) =>
      op.kind === 'insert' ? { error: null } : { error: 'boom' },
    )

    expect(result.sent).toBe(1)
    expect(result.error).toBe('boom')
    expect(result.remaining).toBe(1)
    expect(s.rows.map((r) => r.id)).toEqual(['2'])
  })

  it('descarta lo escrito contra un schema que este build ya no usa', async () => {
    const s = store([write('viejo', '2026-01-15T10:00:00Z', insert, 'legacy')])
    const result = await flushQueue(s, 'public', async () => {
      throw new Error('no debería enviarse')
    })

    expect(result).toEqual({ sent: 0, dropped: 1, remaining: 0, error: null })
    expect(s.rows).toHaveLength(0)
  })

  /**
   * Regresión del hallazgo A1 de docs/auditorias/2026-09-20-auditoria-inicial.md.
   *
   * `remaining` se calculaba como `pending.length - i - dropped`, y restar los
   * descartes es doble conteo: los que se descartaron ya salieron del store y
   * ya quedaron detrás del índice. Con un descarte antes de un fallo, la cola
   * reportaba 0 pendientes teniendo uno adentro — o sea, una escritura que no
   * está guardada presentándose como si no existiera (CLAUDE.md §5.5).
   */
  it('cuenta lo que queda en cola aunque antes haya habido un descarte', async () => {
    const s = store([
      write('legacy', '2026-01-15T10:00:00Z', insert, 'otro-schema'),
      write('real', '2026-01-15T10:05:00Z', insert),
    ])
    const result = await flushQueue(s, 'public', async () => ({ error: 'boom' }))

    expect(result.sent).toBe(0)
    expect(result.dropped).toBe(1)
    expect(result.error).toBe('boom')
    expect(s.rows.map((r) => r.id)).toEqual(['real'])
    expect(result.remaining).toBe(s.rows.length)
  })
})

/**
 * El server como lo ve el replay: un insert es INSERT … ON CONFLICT (id) DO
 * NOTHING (sendOpWith en lib/db.ts), así que una alta que ya está no es error.
 */
function server(initial: Record<string, Record<string, unknown>> = {}) {
  const rows = new Map(Object.entries(initial))
  const calls: PendingOp[] = []
  async function send(op: PendingOp): Promise<{ error: string | null }> {
    calls.push(op)
    // Un tick de red: sin esto dos flush "concurrentes" correrían en fila.
    await new Promise((r) => setTimeout(r, 1))
    if (op.kind === 'insert') {
      const id = String(op.row.id)
      if (!rows.has(id)) rows.set(id, { ...op.row })
    } else {
      const row = rows.get(op.id)
      if (row) Object.assign(row, op.patch)
    }
    return { error: null }
  }
  return { rows, calls, send }
}

/**
 * Un LockManager de mentira, con lo que usa lib/queue.ts: un pedido por
 * nombre a la vez, en orden; con `ifAvailable`, si está tomado, el callback
 * corre en el acto con `null`.
 */
function fakeLocks() {
  let tail: Promise<unknown> = Promise.resolve()
  // Como el real: un pedido cuenta desde que se hace, no desde que se otorga.
  let requested = 0
  const state = { held: 0, maxHeld: 0 }
  function take<T>(callback: (lock: unknown) => Promise<T>): Promise<T> {
    requested += 1
    const run = tail.then(async () => {
      state.held += 1
      state.maxHeld = Math.max(state.maxHeld, state.held)
      try {
        return await callback({})
      } finally {
        state.held -= 1
        requested -= 1
      }
    })
    tail = run.catch(() => undefined)
    return run
  }
  const locks: FlushLocks = {
    request<T>(
      _name: string,
      a: { ifAvailable: true } | (() => Promise<T>),
      b?: (lock: unknown) => Promise<T>,
    ): Promise<T> {
      if (typeof a === 'function') return take(a)
      if (requested > 0) return b!(null)
      return take(b!)
    },
  } as FlushLocks
  return Object.assign(locks, { state })
}

/** Una promesa que se resuelve a mano: un fetch colgado. */
function hanging<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('replay de una alta que ya llegó al server', () => {
  it('una alta ya presente no traba la cola: sale, y lo de atrás también', async () => {
    // El insert llegó pero se perdió la respuesta: quedó en cola igual.
    const srv = server({ a: { id: 'a', amount_ml: 60 } })
    const s = store([
      write('1', '2026-01-15T10:00:00Z', insert),
      write('2', '2026-01-15T10:05:00Z', update),
    ])

    const result = await flushQueue(s, 'public', srv.send)

    expect(result).toEqual({ sent: 2, dropped: 0, remaining: 0, error: null })
    expect(s.rows).toHaveLength(0)
    expect(srv.rows.size).toBe(1)
    expect(srv.rows.get('a')).toMatchObject({ amount_ml: 90 })
  })

  it('dos flush a la vez sobre el mismo store, sin lock: sin error y sin restos', async () => {
    // El peor caso: un navegador sin Web Locks con dos pestañas.
    const srv = server()
    const s = store([
      write('1', '2026-01-15T10:00:00Z', insert),
      write('2', '2026-01-15T10:05:00Z', update),
    ])

    const [x, y] = await Promise.all([
      flushQueue(s, 'public', srv.send),
      flushQueue(s, 'public', srv.send),
    ])

    expect(x.error).toBeNull()
    expect(y.error).toBeNull()
    expect(s.rows).toHaveLength(0)
    expect(srv.rows.size).toBe(1)
    expect(srv.rows.get('a')).toMatchObject({ amount_ml: 90 })
  })
})

describe('withFlushLock', () => {
  it('con Web Locks, si otra pestaña está vaciando la cola, vuelve sin mandar nada', async () => {
    const locks = fakeLocks()
    const srv = server()
    const s = store([
      write('1', '2026-01-15T10:00:00Z', insert),
      write('2', '2026-01-15T10:05:00Z', update),
    ])

    const first = withFlushLock(() => flushQueue(s, 'public', srv.send), locks)
    const second = await withFlushLock(() => flushQueue(s, 'public', srv.send), locks)

    expect(second).toBeNull()
    expect(await first).toEqual({ sent: 2, dropped: 0, remaining: 0, error: null })
    expect(locks.state.maxHeld).toBe(1)
    expect(srv.calls).toEqual([insert, update])
    expect(s.rows).toHaveLength(0)
  })

  it('una pestaña colgada no traba a las demás: vuelven en el acto', async () => {
    const locks = fakeLocks()
    const hung = hanging<string>()
    const stuck = withFlushLock(() => hung.promise, locks)

    const started = Date.now()
    expect(await withFlushLock(async () => 'no debería correr', locks)).toBeNull()
    expect(Date.now() - started).toBeLessThan(50)

    // Y flushSettled espera a que la colgada termine, sin mandar nada.
    let settled = false
    const waiting = flushSettled(locks).then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    hung.resolve('listo')
    await waiting
    expect(await stuck).toBe('listo')
  })

  it('sin Web Locks, lo mismo dentro de la pestaña', async () => {
    const hung = hanging<string>()
    const stuck = withFlushLock(() => hung.promise, null)
    expect(await withFlushLock(async () => 'no', null)).toBeNull()

    let settled = false
    const waiting = flushSettled(null).then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    hung.resolve('listo')
    await waiting
    expect(await stuck).toBe('listo')
    // Libre otra vez.
    expect(await withFlushLock(async () => 'ok', null)).toBe('ok')
  })

  it('un flush que falla no deja trabados a los que siguen', async () => {
    await expect(
      withFlushLock(async () => {
        throw new Error('boom')
      }, null),
    ).rejects.toThrow('boom')
    await expect(withFlushLock(async () => 'ok', null)).resolves.toBe('ok')
  })
})

describe('replay con un envío colgado', () => {
  it('se corta por tiempo: queda en cola, cuenta como offline y suelta el lock', async () => {
    const locks = fakeLocks()
    const s = store([
      write('1', '2026-01-15T10:00:00Z', insert),
      write('2', '2026-01-15T10:05:00Z', update),
    ])
    const never = () => new Promise<{ error: string | null }>(() => {})

    const result = await withFlushLock(() => flushQueue(s, 'public', never, 20), locks)

    expect(result).toMatchObject({ sent: 0, dropped: 0, remaining: 2, error: TIMED_OUT })
    expect(result!.failed?.id).toBe('1')
    // Offline, no rechazo: useSync no muestra banner de error por esto.
    expect(looksOffline(result!.error)).toBe(true)
    expect(s.rows.map((r) => r.id)).toEqual(['1', '2'])
    // El lock quedó libre: el próximo sync entra.
    expect(await withFlushLock(async () => 'libre', locks)).toBe('libre')
  })

  it('el envío recibe una señal que se aborta, y el abort también cuenta como offline', async () => {
    const s = store([write('1', '2026-01-15T10:00:00Z', insert)])
    let seen: AbortSignal | undefined
    const result = await flushQueue(
      s,
      'public',
      (_op, signal) =>
        new Promise((resolve) => {
          seen = signal
          // Como supabase-js: un abort vuelve como error, con su propio texto.
          signal?.addEventListener('abort', () =>
            resolve({ error: 'AbortError: signal is aborted without reason' }),
          )
        }),
      20,
    )
    expect(seen?.aborted).toBe(true)
    expect(result.error).toBe(TIMED_OUT)
    expect(s.rows).toHaveLength(1)
  })

  it('un envío que contesta a tiempo no se toca', async () => {
    const s = store([write('1', '2026-01-15T10:00:00Z', insert)])
    const result = await flushQueue(s, 'public', async () => ({ error: null }), 1000)
    expect(result).toEqual({ sent: 1, dropped: 0, remaining: 0, error: null })
  })
})

describe('syncOnce (lo que decide si la página relee)', () => {
  const idle: FlushResult = { sent: 0, dropped: 0, remaining: 0, error: null }
  const noWait = async () => {}

  it('cola vacía y sin cambios: no relee', async () => {
    expect((await syncOnce(async () => idle, noWait, false)).reread).toBe(false)
  })

  it('mandó algo: relee', async () => {
    expect((await syncOnce(async () => ({ ...idle, sent: 1 }), noWait, false)).reread).toBe(true)
  })

  it('al volver la conexión relee siempre, aunque la cola esté vacía', async () => {
    // Si no, el aviso de "copia guardada" o el "sin conexión, nada guardado"
    // quedaban puestos con conexión hasta recargar.
    expect((await syncOnce(async () => idle, noWait, true)).reread).toBe(true)
  })

  it('otra pestaña tenía la cola: espera a que termine y relee', async () => {
    // El bug: esta pestaña entraba con la cola ya vaciada por la otra
    // (sent = 0), no releía y sus entradas decían "Not synced yet" para
    // siempre aunque ya estuvieran en la base.
    const order: string[] = []
    const { reread } = await syncOnce(
      async () => {
        order.push('flush')
        return order.length === 1 ? { ...idle, remaining: 3, busy: true } : idle
      },
      async () => {
        order.push('esperó')
      },
      false,
    )
    expect(order).toEqual(['flush', 'esperó', 'flush'])
    expect(reread).toBe(true)
  })

  it('si la otra pestaña se cortó por tiempo y quedó cola, manda ella una vez', async () => {
    // Hallazgo del auditor: la pestaña con el POST colgado se corta a los
    // 15 s y la cola quedaba en 3 sin que nadie reintentara.
    let calls = 0
    const { result } = await syncOnce(
      async () => {
        calls += 1
        return calls === 1 ? { ...idle, remaining: 3, busy: true } : { ...idle, sent: 3 }
      },
      noWait,
      false,
    )
    expect(calls).toBe(2)
    expect(result.sent).toBe(3)
  })

  it('una sola vez: si la encuentra tomada de nuevo, no hace bucle', async () => {
    let calls = 0
    const { result } = await syncOnce(
      async () => {
        calls += 1
        return { ...idle, remaining: 3, busy: true }
      },
      noWait,
      false,
    )
    expect(calls).toBe(2)
    expect(result.busy).toBe(true)
  })

  it('sin conexión o con la cola vacía, no vuelve a mandar', async () => {
    let calls = 0
    const busyOnce = async () => {
      calls += 1
      return { ...idle, remaining: 3, busy: true }
    }
    await syncOnce(busyOnce, noWait, false, () => false)
    expect(calls).toBe(1)

    calls = 0
    await syncOnce(
      async () => {
        calls += 1
        return { ...idle, remaining: 0, busy: true }
      },
      noWait,
      false,
    )
    expect(calls).toBe(1)
  })

  it('dos pestañas de verdad sobre la misma cola: las dos terminan releyendo', async () => {
    const locks = fakeLocks()
    const srv = server()
    const s = store([
      write('1', '2026-01-15T10:00:00Z', insert),
      write('2', '2026-01-15T10:05:00Z', update),
    ])
    const flush = async (): Promise<FlushResult> =>
      (await withFlushLock(() => flushQueue(s, 'public', srv.send), locks)) ?? {
        ...idle,
        remaining: s.rows.length,
        busy: true,
      }

    const [a, b] = await Promise.all([
      syncOnce(flush, () => flushSettled(locks), false),
      syncOnce(flush, () => flushSettled(locks), false),
    ])
    expect([a.reread, b.reread]).toEqual([true, true])
    expect(a.result.sent + b.result.sent).toBe(2)
    expect(srv.calls).toEqual([insert, update])
    expect(s.rows).toHaveLength(0)
  })
})

describe('retryDelay (reintento solo, con conexión)', () => {
  const left: FlushResult = { sent: 0, dropped: 0, remaining: 3, error: TIMED_OUT }

  it('tras un corte por tiempo: 5 s, 15 s y después cada 60 s', () => {
    expect([0, 1, 2, 3, 9].map((n) => retryDelay(left, n, true))).toEqual([
      5_000, 15_000, 60_000, 60_000, 60_000,
    ])
  })

  it('también si otra pestaña tenía la cola, o la red falló con el navegador "online"', () => {
    expect(retryDelay({ ...left, error: null, busy: true }, 0, true)).toBe(5_000)
    expect(retryDelay({ ...left, error: 'TypeError: Failed to fetch' }, 0, true)).toBe(5_000)
  })

  it('un rechazo real del server no se reintenta', () => {
    expect(
      retryDelay({ ...left, error: 'new row violates row-level security policy' }, 0, true),
    ).toBeNull()
    expect(
      retryDelay({ ...left, error: 'PGRST003: Timed out acquiring connection' }, 0, true),
    ).toBeNull()
  })

  it('sin conexión, o con la cola vacía, nada', () => {
    expect(retryDelay(left, 0, false)).toBeNull()
    expect(retryDelay({ ...left, remaining: 0 }, 0, true)).toBeNull()
    expect(retryDelay({ ...left, error: null }, 0, true)).toBeNull()
  })
})

describe('retryDelay sin resultado de flush (wifi malo)', () => {
  it('una alta recién encolada o una lectura fallida arrancan los reintentos', () => {
    expect(retryDelay(null, 0, true, true)).toBe(5_000)
    expect(retryDelay(null, 2, true, true)).toBe(60_000)
  })
  it('sin nada esperando, o sin conexión, no', () => {
    expect(retryDelay(null, 0, true, false)).toBeNull()
    expect(retryDelay(null, 0, false, true)).toBeNull()
  })
  it('un rechazo en la cola no se reintenta aunque una lectura falle: el que reintenta es la lectura', () => {
    const rejected: FlushResult = {
      sent: 0,
      dropped: 0,
      remaining: 1,
      error: 'violates check constraint',
    }
    expect(retryDelay(rejected, 0, true, false)).toBeNull()
    expect(retryDelay(rejected, 0, true, true)).toBe(5_000)
  })
})

describe('nudgeSync / onSyncNudge', () => {
  it('avisa lo encolado y las lecturas, y se puede dejar de escuchar', () => {
    const seen: string[] = []
    const stop = onSyncNudge((k) => seen.push(k))
    nudgeSync('queued')
    nudgeSync('read-failed')
    nudgeSync('read-ok')
    stop()
    nudgeSync('queued')
    expect(seen).toEqual(['queued', 'read-failed', 'read-ok'])
  })
})

describe('cola trabada por un rechazo real', () => {
  const bad = write('bad', '2026-01-15T10:00:00Z', {
    kind: 'insert',
    table: 'diaper_changes',
    row: { id: 'x', diaper_type: 'purple' },
  })
  const badEdit = write('bad-edit', '2026-01-15T10:01:00Z', {
    kind: 'update',
    table: 'diaper_changes',
    id: 'x',
    patch: { diaper_type: 'wet' },
  })
  const good = write('good', '2026-01-15T10:02:00Z', insert)
  const otherTableSameId = write('other', '2026-01-15T10:03:00Z', {
    kind: 'update',
    table: 'feedings',
    id: 'x',
    patch: {},
  })

  it('flushQueue dice en qué entrada se frenó, y la deja (y lo de atrás) en la cola', async () => {
    const s = store([bad, good])
    const result = await flushQueue(s, 'public', async (op) =>
      op.kind === 'insert' && op.table === 'diaper_changes'
        ? { error: 'rejected' }
        : { error: null },
    )
    expect(result.failed?.id).toBe('bad')
    expect(s.rows.map((r) => r.id)).toEqual(['bad', 'good'])
  })

  it('descartarla saca también sus ediciones encoladas, y nada más; la cola sigue', async () => {
    const s = store([bad, badEdit, good, otherTableSameId])
    expect(dependentsOf(bad, s.rows).map((w) => w.id)).toEqual(['bad-edit'])

    const plan = await discardPlan(s, 'bad')
    expect(plan.map((w) => w.id)).toEqual(['bad', 'bad-edit'])
    const gone = await discardWrites(
      s,
      plan.map((w) => w.id),
    )
    expect(gone.map((w) => w.id)).toEqual(['bad', 'bad-edit'])
    expect(s.rows.map((r) => r.id)).toEqual(['good', 'other'])

    const result = await flushQueue(s, 'public', async () => ({ error: null }))
    expect(result).toEqual({ sent: 2, dropped: 0, remaining: 0, error: null })
  })

  it('una edición rechazada se va sola; un id que ya no está no hace nada', async () => {
    const s = store([bad, badEdit, good])
    expect((await discardPlan(s, 'bad-edit')).map((w) => w.id)).toEqual(['bad-edit'])
    expect(await discardPlan(s, 'no-existe')).toEqual([])
    expect((await discardWrites(s, ['bad-edit'])).map((w) => w.id)).toEqual(['bad-edit'])
    expect(s.rows.map((r) => r.id)).toEqual(['bad', 'good'])
  })

  it('borra solo lo que el confirm contó: una edición encolada después (otra pestaña) se queda', async () => {
    const s = store([bad, good])
    const plan = await discardPlan(s, 'bad') // el confirm dice: solo el alta
    expect(plan.map((w) => w.id)).toEqual(['bad'])
    await s.add(badEdit) // mientras el confirm estaba abierto
    await discardWrites(
      s,
      plan.map((w) => w.id),
    )
    expect(s.rows.map((r) => r.id)).toEqual(['good', 'bad-edit'])
  })

  it('isDeletion: un update que pone voided_at es un borrado', () => {
    const del = write('del', '2026-01-15T10:04:00Z', {
      kind: 'update',
      table: 'diaper_changes',
      id: 'x',
      patch: { voided_at: '2026-01-15T10:04:00Z' },
    })
    expect(isDeletion(del)).toBe(true)
    expect(isDeletion(badEdit)).toBe(false)
    expect(isDeletion(bad)).toBe(false)
  })
})

describe('looksOffline', () => {
  it('reconoce un request que nunca llegó', () => {
    expect(looksOffline('TypeError: Failed to fetch')).toBe(true)
    expect(looksOffline('NetworkError when attempting to fetch resource')).toBe(true)
    expect(looksOffline('Load failed')).toBe(true)
    expect(looksOffline('AbortError: signal is aborted without reason')).toBe(true)
    expect(looksOffline('TimeoutError: signal timed out')).toBe(true)
    expect(looksOffline(TIMED_OUT)).toBe(true)
  })

  it('no encola un rechazo del servidor', () => {
    expect(looksOffline('new row violates row-level security policy')).toBe(false)
    // Un "timed out" del propio server sigue siendo un rechazo.
    expect(looksOffline('Timed out acquiring connection from connection pool.')).toBe(false)
    expect(looksOffline('canceling statement due to statement timeout')).toBe(false)
    expect(looksOffline(null)).toBe(false)
  })
})

describe('newId', () => {
  it('genera uuids distintos con forma de v4', () => {
    const a = newId()
    const b = newId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})
