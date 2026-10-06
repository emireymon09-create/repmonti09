'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SeenNote, SyncBar, SyncErrorBanner } from '@/components/SyncStatus'
import { AmountUnit } from '@/components/AmountUnit'
import {
  keepLastGood,
  listContainers,
  listDrawdowns,
  logPumpingSession,
  mergePending,
  milkErrorText,
  milkRules,
  pendingWrites,
  recentPumping,
  type PumpingInput,
} from '@/lib/db'
import { useSync } from '@/lib/useSync'
import { lastGood, seenKey, type LastGood, type SeenState } from '@/lib/lastSeen'
import { looksOffline, type PendingWrite } from '@/lib/queue'
import {
  DEFAULT_MILK_RULES,
  EMPTY_ML,
  SERVED_EPSILON_ML,
  activeContainers,
  applyPendingInventory,
  isUsable,
  nextContainerLabel,
  normalizeTapeLabel,
  parseAmountMl,
  servedMl,
  stashMl,
  tapeInUse,
  type TapeCheck,
} from '@/lib/milk'
import { useT } from '@/lib/i18n/react'
import type {
  MilkContainer,
  MilkDrawdown,
  MilkRules,
  PumpingSession,
  VolumeUnit,
  WithPending,
} from '@/lib/types'
import {
  clockTime,
  DISPLAY_UNIT,
  elapsed,
  formatMilkOz,
  fromHouseholdInputValue,
  longDate,
  toHouseholdInputValue,
} from '@/lib/format'

/** What the server last returned, before the queue is merged in. */
type ServerRows = {
  sessions: PumpingSession[]
  containers: MilkContainer[]
  drawdowns: MilkDrawdown[]
}
const NO_ROWS: ServerRows = { sessions: [], containers: [], drawdowns: [] }

/** Only the keys this page reads (a copy saved by an older build may carry others, or miss some). */
function ownRows(rows: ServerRows): ServerRows {
  return {
    sessions: rows.sessions ?? [],
    containers: rows.containers ?? [],
    drawdowns: rows.drawdowns ?? [],
  }
}

/**
 * The live timer's start, kept on THIS device (docs/spec-feeding-v3.md S-4):
 * it survives a reload, and the other phone doesn't see it. Every access is
 * guarded — a private window or a kiosk profile may refuse storage, and then
 * the timer simply doesn't survive a reload.
 */
const timerKey = (babyId: string) => `amelia:pump-start:${babyId}`
function readTimer(babyId: string): string | null {
  try {
    return localStorage.getItem(timerKey(babyId))
  } catch {
    return null
  }
}
function writeTimer(babyId: string, value: string | null) {
  try {
    if (value) localStorage.setItem(timerKey(babyId), value)
    else localStorage.removeItem(timerKey(babyId))
  } catch {
    /* the timer just won't survive a reload */
  }
}

export default function PumpingPage() {
  const { baby, userId, loading, unreachable } = useBaby()
  const { t, lang } = useT()

  const [sessions, setSessions] = useState<WithPending<PumpingSession>[]>([])
  const [containers, setContainers] = useState<WithPending<MilkContainer>[]>([])
  const [rules, setRules] = useState<MilkRules>(DEFAULT_MILK_RULES)
  const [now, setNow] = useState(() => Date.now())

  // Live: when the pump started, on this device.
  const [startedAt, setStartedAt] = useState<string | null>(null)
  // The amounts form serves both the live session (once stopped) and the
  // manual one; `stopping` says which.
  const [stopping, setStopping] = useState(false)
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  // What the two numbers are in, for THIS session only — back to ounces after
  // every save (components/AmountUnit.tsx, design.md §5.7).
  const [unit, setUnit] = useState<VolumeUnit>(DISPLAY_UNIT)
  const [notes, setNotes] = useState('')
  // The tape the person typed; null = untouched, so the field shows the
  // current suggestion (and follows it when the list changes).
  const [tape, setTape] = useState<string | null>(null)
  // A tape just taken online (saved here, or refused because another phone
  // has it), until the next good read: without it, the field would offer that
  // same number again for a moment.
  const [justSaved, setJustSaved] = useState<string | null>(null)
  const [at, setAt] = useState(() => toHouseholdInputValue(new Date()))

  const [err, setErr] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (baby) setStartedAt(readTimer(baby.id))
  }, [baby])

  // Same pattern as /growth: the last good server rows (starting from this
  // device's saved copy), the queue folded on top, a slow read never landing
  // over a newer one.
  const serverRows = useRef<LastGood<ServerRows> | null>(null)
  const latestRead = useRef(0)
  const [seen, setSeen] = useState<SeenState>({ kind: 'live' })

  const show = useCallback((rows: ServerRows, queued: PendingWrite[]) => {
    const merged = mergePending(rows.sessions, 'pumping_sessions', queued).sort((a, b) =>
      b.pumped_at.localeCompare(a.pumped_at),
    )
    setSessions(merged)
    const view = applyPendingInventory(rows.containers, rows.drawdowns, queued).containers
    setContainers(view)
  }, [])

  const refresh = useCallback(
    async (babyId: string) => {
      const read = ++latestRead.current
      const key = seenKey.page('pumping', babyId)
      if (serverRows.current?.key !== key) serverRows.current = lastGood(key, NO_ROWS)
      const last = serverRows.current

      const queuedNow = await pendingWrites()
      if (read !== latestRead.current) return
      const offline = navigator.onLine === false
      if (queuedNow.length > 0 || offline) {
        show(ownRows(last.rows), queuedNow)
        setSeen(last.state(offline))
      }

      const [s, c, d, queued] = await Promise.all([
        recentPumping(babyId, 100),
        listContainers(babyId),
        listDrawdowns(babyId),
        pendingWrites(),
      ])
      if (read !== latestRead.current) return
      const { rows, error } = keepLastGood(ownRows(last.rows), {
        sessions: s,
        containers: c,
        drawdowns: d,
      })
      setSeen(last.settle(rows, error))
      // A good read made after the save has the real list (with that tape, or
      // without it if another phone already voided it): the marker is done.
      if (!error) setJustSaved(null)
      setLoadErr(error && !looksOffline(error) ? t('milk.couldNotLoad', { error }) : null)
      show(rows, queued)
    },
    [show, t],
  )

  const { online, pending, syncing, syncError, syncFailed, discardFailed, reloadPending } = useSync(
    () => {
      if (baby) refresh(baby.id)
    },
  )

  useEffect(() => {
    if (baby) refresh(baby.id)
  }, [baby, refresh])

  // The family's storage rules: only for the expiry this screen shows while
  // offline — the server computes the real one. Defaults until they arrive.
  useEffect(() => {
    if (!baby) return
    let cancelled = false
    milkRules(baby.id).then((res) => {
      if (!cancelled && res.data) setRules(res.data)
    })
    return () => {
      cancelled = true
    }
  }, [baby])

  const live = containers.filter((c) => !c.voided_at)
  const ctx = { containers: live, rules }
  // `live` is already the non-voided list (queued ones included).
  const suggestedTape = nextContainerLabel([...live.map((c) => c.label), justSaved])
  const tapeTaken = (label: string) => tapeInUse(label, live) || label === justSaved
  const tapeText = tape ?? suggestedTape
  const containerOf = (sessionId: string) => live.find((c) => c.source_session_id === sessionId)

  function readSides(l: string, r: string, u: VolumeUnit) {
    const pl = parseAmountMl(l, u)
    const pr = parseAmountMl(r, u)
    if (pl.problem || pr.problem) return null
    return { left_ml: pl.ml, right_ml: pr.ml }
  }

  function startLive() {
    if (!baby) return
    const start = new Date().toISOString()
    writeTimer(baby.id, start)
    setStartedAt(start)
    setStopping(false)
    setErr(null)
  }

  function cancelLive() {
    if (!baby) return
    if (!window.confirm(t('milk.live.cancelConfirm'))) return
    writeTimer(baby.id, null)
    setStartedAt(null)
    setStopping(false)
    setTape(null)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || busy) return
    setErr(null)
    setSaved(null)

    const sides = readSides(left, right, unit)
    if (!sides) {
      setErr(t('milk.amountNotNumber'))
      return
    }
    // A live session is dated when it started; a manual one, by the field.
    const fromLive = stopping && startedAt
    const pumpedAt = fromLive ? startedAt : fromHouseholdInputValue(at)
    if (!fromLive && Date.parse(pumpedAt) > Date.now()) {
      setErr(t('past.inFuture'))
      return
    }
    const input: PumpingInput = { ...sides, notes: notes.trim() || null, pumped_at: pumpedAt }

    // The tape only matters when there is milk: without an amount there is
    // no container, and the field never blocks the session. A tape a live
    // container (queued ones too) already has is refused here, never
    // renumbered — the server refuses it as well.
    let label: string | undefined
    if ((sides.left_ml ?? 0) + (sides.right_ml ?? 0) > 0) {
      // Untouched, the field holds the suggestion, which is always valid —
      // even past the six digits a typed tape is limited to.
      const check: TapeCheck =
        tape === null ? { ok: true, label: suggestedTape } : normalizeTapeLabel(tape)
      if (!check.ok) {
        const key = check.problem === 'empty' ? 'milk.tapeEmpty' : 'milk.tapeFormat'
        setErr(t(key, { label: suggestedTape }))
        return
      }
      if (tapeTaken(check.label)) {
        setErr(t('milk.tapeInUse', { label: check.label }))
        return
      }
      label = check.label
    }

    setBusy(true)
    const { data, error, queued } = await logPumpingSession(baby.id, userId, input, ctx, label)
    setBusy(false)
    if (error) {
      // Saved directly, nothing was stored: the other phone just took this
      // tape. Say "pick another" (not the queued-sync "delete this session")
      // and re-read so the suggestion moves past it.
      const taken = /^milk_label_taken:(M[0-9]+)$/.exec(error)
      if (taken) {
        // Counted as taken right away, even if the re-read fails on bad wifi.
        setJustSaved(taken[1])
        setErr(t('milk.tapeInUse', { label: taken[1] }))
        refresh(baby.id)
        return
      }
      setErr(t('common.couldNotSave', { error: milkErrorText(error, lang) }))
      return
    }
    if (data.label && !queued) setJustSaved(data.label)
    setSaved(
      data.label
        ? t(queued ? 'milk.queuedLabel' : 'milk.loggedLabel', { label: data.label })
        : queued
          ? t('common.queued')
          : t('milk.logged'),
    )
    setLeft('')
    setRight('')
    setNotes('')
    setTape(null)
    setUnit(DISPLAY_UNIT)
    setAt(toHouseholdInputValue(new Date()))
    if (fromLive) {
      writeTimer(baby.id, null)
      setStartedAt(null)
      setStopping(false)
    }
    refresh(baby.id)
    reloadPending()
  }

  if (loading)
    return (
      <Page>
        {/* El nav va también mientras carga (design.md §5.13). */}
        <Nav />
        <p className="empty loading-note">{t('common.loading')}</p>
      </Page>
    )
  if (!baby)
    return (
      <Page>
        <Nav />
        <NoBaby offline={unreachable} />
      </Page>
    )

  // Building the stash starts weeks before the due date, so this page works
  // even on the "Expecting" screen — it never checks birth_date.
  const unknown = seen.kind === 'nothing'
  // What the screen would show as "0 oz" is empty (lib/milk.ts, EMPTY_ML).
  const shelf = activeContainers(live).filter((c) => c.remaining_ml >= EMPTY_ML)
  const stash = stashMl(live, now)
  const stashPending = shelf.some((c) => c.pending)
  const unitName = t(`unit.${unit}`)

  // Etiqueta visible por lado: el placeholder solo no alcanza — "Izquierdo, oz"
  // no entra en un campo angosto, y desaparece apenas se tipea un número.
  const amountFields = (idPrefix: string) => (
    <>
      <p className="meta">{t('milk.sidesHint')}</p>
      <div className="row-tight row-wrap">
        <div>
          <label className="label" htmlFor={`${idPrefix}-left`}>
            {t('side.left')}
          </label>
          <input
            id={`${idPrefix}-left`}
            className="input narrow"
            value={left}
            onChange={(e) => setLeft(e.target.value)}
            inputMode="decimal"
            placeholder={unitName}
            aria-label={t('milk.left', { unit: unitName })}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${idPrefix}-right`}>
            {t('side.right')}
          </label>
          <input
            id={`${idPrefix}-right`}
            className="input narrow"
            value={right}
            onChange={(e) => setRight(e.target.value)}
            inputMode="decimal"
            placeholder={unitName}
            aria-label={t('milk.right', { unit: unitName })}
          />
        </div>
        <AmountUnit value={unit} onChange={setUnit} disabled={busy} />
      </div>
      <div>
        <label className="label" htmlFor={`${idPrefix}-tape`}>
          {t('milk.tape')}
        </label>
        <input
          id={`${idPrefix}-tape`}
          className="input narrow"
          value={tapeText}
          onChange={(e) => setTape(e.target.value)}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <input
        className="input"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={t('common.notesOptional')}
        aria-label={t('common.notes')}
      />
    </>
  )

  return (
    <Page>
      <Nav />
      <h1 className="title">{t('milk.title')}</h1>
      <SyncBar online={online} pending={pending} syncing={syncing} />
      <SeenNote state={seen} />
      <SyncErrorBanner error={syncError} failed={syncFailed} onDiscard={discardFailed} />
      {loadErr && <Banner kind="error">{loadErr}</Banner>}
      {err && <Banner kind="error">{err}</Banner>}
      {saved && !err && <Banner kind="ok">{saved}</Banner>}

      <Grid>
        {/* ---------------- Live session ---------------- */}
        <Card live={!!startedAt}>
          <Label>{t('milk.live.title')}</Label>
          {startedAt ? (
            <form onSubmit={save}>
              <div className="stopwatch">
                <span className="clock">{elapsed(startedAt, now)}</span>
                <span className="side">
                  {t('milk.live.running', { time: clockTime(startedAt, lang) })}
                </span>
              </div>
              {stopping ? (
                <div className="stack">
                  {amountFields('pump-live')}
                  <div className="row-tight">
                    <Btn type="submit" disabled={busy}>
                      {busy ? t('common.saving') : t('milk.logSession')}
                    </Btn>
                    <Btn variant="quiet" disabled={busy} onClick={() => setStopping(false)}>
                      {t('common.cancel')}
                    </Btn>
                  </div>
                </div>
              ) : (
                <div className="row-tight">
                  <Btn variant="live" disabled={busy} onClick={() => setStopping(true)}>
                    {t('milk.live.finish')}
                  </Btn>
                  <Btn variant="quiet" disabled={busy} onClick={cancelLive}>
                    {t('milk.live.cancel')}
                  </Btn>
                </div>
              )}
            </form>
          ) : (
            <>
              <p className="meta">{t('milk.live.hint')}</p>
              <div className="row-tight">
                <Btn disabled={busy} onClick={startLive}>
                  {t('milk.live.start')}
                </Btn>
              </div>
            </>
          )}
        </Card>

        {/* ---------------- Manual, with a past time ---------------- */}
        {!stopping && (
          <Card>
            <form onSubmit={save}>
              <Label>{t('milk.logTitle')}</Label>
              <div className="stack">
                {amountFields('pump-manual')}
                <div>
                  <label className="label" htmlFor="pump-at">
                    {t('milk.when')}
                  </label>
                  <input
                    id="pump-at"
                    type="datetime-local"
                    className="input"
                    value={at}
                    onChange={(e) => setAt(e.target.value)}
                    max={toHouseholdInputValue(new Date(now))}
                  />
                </div>
              </div>
              <div className="row-tight">
                <Btn type="submit" disabled={busy}>
                  {busy ? t('common.saving') : t('milk.logSession')}
                </Btn>
              </div>
            </form>
          </Card>
        )}

        {/* ---------------- What there is ---------------- */}
        <Card>
          <Label>{t('milk.inStash')}</Label>
          <div className="value">{unknown ? '—' : formatMilkOz(stash)}</div>
          <div className="meta">{t('milk.stashNote')}</div>
          {stashPending && <div className="pending-tag">{t('milk.stashPending')}</div>}
          {!unknown && shelf.length === 0 && <div className="empty">{t('milk.noContainers')}</div>}
          {shelf.length > 0 && (
            <ul className="feed">
              {shelf.map((c) => {
                const usable = isUsable(c, now)
                return (
                  <li key={c.id} className="feed-item">
                    <div className="feed-what">
                      {t('milk.containerLine', {
                        label: c.label,
                        amount: formatMilkOz(c.remaining_ml),
                      })}
                    </div>
                    <div className="meta">
                      {usable
                        ? t('milk.expires', {
                            when: `${longDate(c.expires_at, lang)} · ${clockTime(c.expires_at, lang)}`,
                          })
                        : t('milk.expired')}
                    </div>
                    {c.pending && <div className="pending-tag">{t('common.notSyncedYet')}</div>}
                  </li>
                )
              })}
            </ul>
          )}
          <p className="meta">{t('milk.rulesHint')}</p>
        </Card>

        {/* ---------------- Sessions ----------------
            Solo para registrar y mirar, como lo dejó v0.11.0 (4a3c082):
            corregir o borrar una extracción se hace en el Historial, con el
            resto de las entradas (el ⋯ de cada fila), que pasa por las mismas
            funciones que cuidan el inventario (update_pumping_session /
            void_pumping_session, con el chequeo de lo ya servido). La esquina
            lleva ahí. */}
        <Card spanAll quickLink={{ href: '/history', label: t('milk.editInHistory') }}>
          <Label>{t('milk.sessions')}</Label>
          {sessions.length === 0 ? (
            <div className="empty">{unknown ? t('milk.nothingSaved') : t('milk.empty')}</div>
          ) : (
            <div className="feed">
              {sessions.map((row) => {
                const container = containerOf(row.id)
                const served = servedMl(container)
                const voided = !!(row as { voided_at?: string | null }).voided_at
                const hasSides = row.left_ml != null || row.right_ml != null
                return (
                  <div className="feed-item" key={row.id}>
                    <span className="feed-time">{clockTime(row.pumped_at, lang)}</span>
                    <div className="feed-what">
                      <span className="meta">{longDate(row.pumped_at, lang)} · </span>
                      {row.amount_ml != null ? formatMilkOz(row.amount_ml) : t('milk.noAmount')}
                      {container && ` · ${container.label}`}
                      {/* Una sesión vieja (antes de 0014) solo tiene total y el
                          lado de entonces: se lo muestra como lo mostraba
                          v0.12.1, sin inventarle izquierda y derecha. */}
                      {!hasSides && row.amount_ml != null && ` · ${t(`sideButton.${row.side}`)}`}
                      {row.notes && ` · ${row.notes}`}
                      {hasSides && (
                        <div className="meta">
                          {t('milk.sidesLine', {
                            left: row.left_ml != null ? formatMilkOz(row.left_ml) : '—',
                            right: row.right_ml != null ? formatMilkOz(row.right_ml) : '—',
                          })}
                        </div>
                      )}
                      {container && served > SERVED_EPSILON_ML && (
                        <div className="meta">
                          {t('milk.servedNote', { amount: formatMilkOz(served) })}
                        </div>
                      )}
                      {voided && <div className="meta">{t('milk.deletedPending')}</div>}
                      {row.pending && <div className="pending-tag">{t('common.notSyncedYet')}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </Grid>
    </Page>
  )
}
