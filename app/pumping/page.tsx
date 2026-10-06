'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SeenNote, SyncBar, SyncErrorBanner } from '@/components/SyncStatus'
import { AmountUnit } from '@/components/AmountUnit'
import { BottleSlotPicker, storedWhen } from '@/components/BottleSlotPicker'
import {
  discardContainer,
  keepLastGood,
  listContainers,
  listDiscards,
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
import { lastGood, readSeen, seenKey, type LastGood, type SeenState } from '@/lib/lastSeen'
import { looksOffline, type PendingWrite } from '@/lib/queue'
import {
  DEFAULT_MILK_RULES,
  EMPTY_ML,
  SERVED_EPSILON_ML,
  activeContainers,
  applyPendingInventory,
  convertAmountText,
  isUsable,
  newestSavedContainers,
  readPumpingSides,
  stashMl,
} from '@/lib/milk'
import {
  DEFAULT_BOTTLE_COUNT,
  bottleSlots,
  canDiscard,
  containerBalance,
  discardedTotalMl,
  labelNumber,
} from '@/lib/milkBottles'
import { useT } from '@/lib/i18n/react'
import type {
  MilkContainer,
  MilkDiscard,
  MilkDrawdown,
  MilkSettings,
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
  timeAgo,
  toHouseholdInputValue,
} from '@/lib/format'

/** What the server last returned, before the queue is merged in. */
type ServerRows = {
  sessions: PumpingSession[]
  containers: MilkContainer[]
  drawdowns: MilkDrawdown[]
  /** Expired milk thrown out (0015): "Discarded milk", and which bottles it freed. */
  discards: MilkDiscard[]
}
const NO_ROWS: ServerRows = { sessions: [], containers: [], drawdowns: [], discards: [] }

/** Only the keys this page reads (a copy saved by an older build may carry others, or miss some). */
function ownRows(rows: ServerRows): ServerRows {
  return {
    sessions: rows.sessions ?? [],
    containers: rows.containers ?? [],
    drawdowns: rows.drawdowns ?? [],
    discards: rows.discards ?? [],
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
  const [discards, setDiscards] = useState<WithPending<MilkDiscard>[]>([])
  // The storage rules (for the expiry shown offline) and N, how many bottles
  // the selector offers (0015). Defaults until they arrive.
  const [rules, setRules] = useState<MilkSettings>({
    ...DEFAULT_MILK_RULES,
    milk_bottle_count: DEFAULT_BOTTLE_COUNT,
  })
  const [now, setNow] = useState(() => Date.now())

  // Live: when the pump started, on this device.
  const [startedAt, setStartedAt] = useState<string | null>(null)
  // The amounts form serves both the live session (once stopped) and the
  // manual one; `stopping` says which.
  const [stopping, setStopping] = useState(false)
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  // What each number is in, each side on its own (V4-01), for THIS session
  // only — back to ounces after every save (components/AmountUnit.tsx,
  // design.md §5.7).
  const [unitLeft, setUnitLeft] = useState<VolumeUnit>(DISPLAY_UNIT)
  const [unitRight, setUnitRight] = useState<VolumeUnit>(DISPLAY_UNIT)
  const [notes, setNotes] = useState('')
  // The bottle chosen in the selector. Never preselected (D-4).
  const [bottle, setBottle] = useState<string | null>(null)
  // A bottle the server just refused as taken (another phone), until the next
  // good read: without it the selector would offer it again for a moment.
  const [justTaken, setJustTaken] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
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
  // Is the container list on screen THE list? Only after a container read
  // worked, or with this page's own saved copy. Offline with neither, the
  // list is unknown — not empty — and the bottle selector must not pretend
  // to know which bottles are free (QA, 6 oct 2026; V4-11 CA3). `goodRead`
  // remembers, per baby, that a read worked this session.
  const goodRead = useRef<string | null>(null)
  const [readKnown, setReadKnown] = useState(false)
  // Until a read has answered, an unknown list is just "not read yet".
  const [settled, setSettled] = useState(false)
  // Unknown here: what Today, Feeding or History saved on this device (the
  // same full container list), for the selector. Null when none did.
  const [savedList, setSavedList] = useState<{
    savedAt: string
    containers: MilkContainer[]
  } | null>(null)

  const show = useCallback((rows: ServerRows, queued: PendingWrite[]) => {
    const merged = mergePending(rows.sessions, 'pumping_sessions', queued).sort((a, b) =>
      b.pumped_at.localeCompare(a.pumped_at),
    )
    setSessions(merged)
    const view = applyPendingInventory(rows.containers, rows.drawdowns, rows.discards, queued)
    setContainers(view.containers)
    setDiscards(view.discards)
  }, [])

  const refresh = useCallback(
    async (babyId: string) => {
      const read = ++latestRead.current
      const key = seenKey.page('pumping', babyId)
      if (serverRows.current?.key !== key) serverRows.current = lastGood(key, NO_ROWS)
      const last = serverRows.current
      const known = () => !!last.saved || goodRead.current === key
      const otherCopies = () =>
        newestSavedContainers(
          (['dashboard', 'feeding', 'history'] as const).map((page) =>
            readSeen<Record<string, unknown>>(seenKey.page(page, babyId)),
          ),
        )
      setReadKnown(known())
      setSavedList(known() ? null : otherCopies())

      const queuedNow = await pendingWrites()
      if (read !== latestRead.current) return
      const offline = navigator.onLine === false
      if (queuedNow.length > 0 || offline) {
        show(ownRows(last.rows), queuedNow)
        setSeen(last.state(offline))
      }

      const [s, c, d, dc, queued] = await Promise.all([
        recentPumping(babyId, 100),
        listContainers(babyId),
        listDrawdowns(babyId),
        listDiscards(babyId),
        pendingWrites(),
      ])
      if (read !== latestRead.current) return
      if (!c.error) goodRead.current = key
      setReadKnown(known())
      setSavedList(known() ? null : otherCopies())
      setSettled(true)
      const { rows, error } = keepLastGood(ownRows(last.rows), {
        sessions: s,
        containers: c,
        drawdowns: d,
        discards: dc,
      })
      setSeen(last.settle(rows, error))
      // A good read has the real list (with the refused bottle taken, or free
      // again if the other phone already emptied it): the marker is done.
      if (!c.error) setJustTaken(null)
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
  // What the selector knows (V4-11 CA3): this page's list when it is THE list;
  // offline, another page's saved copy with the queue on top; with neither,
  // null — unknown, not empty.
  const slotContainers: WithPending<MilkContainer>[] | null = readKnown
    ? live
    : savedList
      ? [...savedList.containers, ...live]
      : null
  const count = rules.milk_bottle_count
  const containerOf = (sessionId: string) => live.find((c) => c.source_session_id === sessionId)

  // Switching a side's oz/ml converts what is typed in it (D-19, AJ-16): the
  // number keeps meaning the same milk. The other side is not touched (CA2).
  function switchLeft(next: VolumeUnit) {
    setLeft((x) => convertAmountText(x, unitLeft, next))
    setUnitLeft(next)
  }
  function switchRight(next: VolumeUnit) {
    setRight((x) => convertAmountText(x, unitRight, next))
    setUnitRight(next)
  }

  function needBottle(message: string) {
    setErr(message)
    setTimeout(() => pickerRef.current?.focus(), 0)
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
    setBottle(null)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || busy) return
    setErr(null)
    setSaved(null)

    const sides = readPumpingSides({ text: left, unit: unitLeft }, { text: right, unit: unitRight })
    if (sides.problem) {
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
    const input: PumpingInput = {
      left_ml: sides.leftMl,
      right_ml: sides.rightMl,
      notes: notes.trim() || null,
      pumped_at: pumpedAt,
    }

    // The bottle only matters when there is milk: with both sides empty there
    // is no container and nothing is asked (V4-04). With milk, the person
    // picks it — never made up, never renumbered (D-4, X-1). One that has
    // milk by now (the list was re-read while choosing) is refused here, as
    // the server would.
    let label: string | null = null
    if (sides.needsBottle) {
      if (!bottle) {
        needBottle(t('milk.bottleNeeded'))
        return
      }
      const { slots } = bottleSlots(count, slotContainers, discards, Date.now())
      if (slots.find((x) => x.label === bottle)?.disabled || bottle === justTaken) {
        setBottle(null)
        needBottle(milkErrorText(`milk_label_taken:${bottle}`, lang))
        return
      }
      label = bottle
    }

    setBusy(true)
    const { data, error, queued } = await logPumpingSession(baby.id, userId, input, ctx, label)
    setBusy(false)
    if (error) {
      // Saved directly, nothing was stored: another phone just put milk in
      // this bottle (V4-16). Say so, clear the choice and re-read, so the
      // selector shows it taken and another one is picked.
      const refused = /^milk_label_taken:(M[0-9]+)$/.exec(error)
      if (refused) {
        // Counted as taken right away, even if the re-read fails on bad wifi.
        setJustTaken(refused[1])
        setBottle(null)
        needBottle(milkErrorText(error, lang))
        refresh(baby.id)
        return
      }
      if (error === 'milk_bottle_needed') {
        needBottle(milkErrorText(error, lang))
        return
      }
      setErr(t('common.couldNotSave', { error: milkErrorText(error, lang) }))
      return
    }
    setSaved(
      data.label
        ? t(queued ? 'milk.queuedIn' : 'milk.loggedIn', { label: data.label })
        : queued
          ? t('common.queued')
          : t('milk.logged'),
    )
    setLeft('')
    setRight('')
    setNotes('')
    setBottle(null)
    setUnitLeft(DISPLAY_UNIT)
    setUnitRight(DISPLAY_UNIT)
    setAt(toHouseholdInputValue(new Date()))
    if (fromLive) {
      writeTimer(baby.id, null)
      setStartedAt(null)
      setStopping(false)
    }
    refresh(baby.id)
    reloadPending()
  }

  /**
   * "Desechar" (V4-33/V4-34): all that is left in an expired bottle is thrown
   * out and the bottle is free again. Asked first — it can't be undone in v4
   * (D-11). Whether it really expired is the server's call (D-15). Offline it
   * queues, behind its pumping session when that one hasn't synced (V4-39).
   */
  async function discard(c: WithPending<MilkContainer>) {
    if (!baby || busy) return
    const amount = formatMilkOz(c.remaining_ml)
    if (!window.confirm(t('milk.discardConfirm', { label: c.label, amount }))) return
    setErr(null)
    setSaved(null)
    setBusy(true)
    const { error, queued } = await discardContainer(baby.id, userId, c, {
      pending: !!c.pending,
    })
    setBusy(false)
    if (error) {
      setErr(t('common.couldNotSave', { error: milkErrorText(error, lang) }))
      refresh(baby.id)
      return
    }
    setSaved(queued ? t('common.queued') : t('milk.discardedOk', { label: c.label }))
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
  const discardedMl = discardedTotalMl(discards)
  const discardedPending = discards.some((d) => d.pending && !d.voided_at)
  // Is there milk typed? Then the selector shows; with both sides empty there
  // is no container to name (V4-04). A side that isn't a number yet counts as
  // milk, so the selector doesn't flicker while typing "1." or "1,".
  const sidesNow = readPumpingSides(
    { text: left, unit: unitLeft },
    { text: right, unit: unitRight },
  )
  const typedMilk = sidesNow.problem ? true : sidesNow.needsBottle

  // One amount field per side, each with its own oz/ml right next to it
  // (V4-01): the same AmountUnit as Today's bottle. Visible labels — a
  // placeholder alone disappears as soon as a number is typed.
  const sideField = (
    id: string,
    side: 'left' | 'right',
    value: string,
    set: (v: string) => void,
    unit: VolumeUnit,
    switchUnit: (u: VolumeUnit) => void,
  ) => {
    const unitName = t(`unit.${unit}`)
    return (
      <div>
        <label className="label" htmlFor={id}>
          {t(`side.${side}`)}
        </label>
        <div className="row-tight row-wrap">
          <input
            id={id}
            className="input narrow"
            value={value}
            onChange={(e) => set(e.target.value)}
            inputMode="decimal"
            placeholder={unitName}
            aria-label={t(side === 'left' ? 'milk.left' : 'milk.right', { unit: unitName })}
          />
          <AmountUnit
            value={unit}
            onChange={switchUnit}
            disabled={busy}
            label={t(side === 'left' ? 'milk.leftUnit' : 'milk.rightUnit')}
          />
        </div>
      </div>
    )
  }

  const amountFields = (idPrefix: string) => (
    <>
      <p className="meta">{t('milk.sidesHint')}</p>
      <div className="row row-wrap">
        {sideField(`${idPrefix}-left`, 'left', left, setLeft, unitLeft, switchLeft)}
        {sideField(`${idPrefix}-right`, 'right', right, setRight, unitRight, switchRight)}
      </div>
      {typedMilk && (
        <BottleSlotPicker
          ref={pickerRef}
          idPrefix={idPrefix}
          count={count}
          containers={slotContainers}
          discards={discards}
          nowMs={now}
          value={bottle}
          onChange={setBottle}
          disabled={busy}
          savedAgo={!readKnown && savedList ? timeAgo(savedList.savedAt, now, lang) : null}
          sayUnknown={settled || !online}
          justTaken={justTaken}
        />
      )}
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
              {/* Oldest first, by when it went into the fridge — never by number:
                  the bottles are reused, M6 can be the oldest (V4-13). */}
              {shelf.map((c) => {
                const usable = isUsable(c, now)
                const num = labelNumber(c.label)
                const outside = num === null || num > count
                return (
                  <li key={c.id} className="feed-item">
                    <div className="feed-what">
                      {t('milk.containerLine', {
                        label: c.label,
                        amount: formatMilkOz(c.remaining_ml),
                      })}
                      {outside && (
                        <span className="meta"> · {t('milk.outOfRange', { n: count })}</span>
                      )}
                      <div className="meta">
                        {t('milk.storedAt', { when: storedWhen(c.stored_at, now, lang) })}
                      </div>
                      <div className="meta">
                        {usable
                          ? t('milk.expires', {
                              when: `${longDate(c.expires_at, lang)} · ${clockTime(c.expires_at, lang)}`,
                            })
                          : t('milk.expiredShort')}
                      </div>
                      {c.pending && <div className="pending-tag">{t('common.notSyncedYet')}</div>}
                    </div>
                    {canDiscard(c, discards, now) && (
                      <span className="feed-actions">
                        <button
                          type="button"
                          className="linkish"
                          disabled={busy}
                          aria-label={t('milk.discardAria', { label: c.label })}
                          onClick={() => discard(c)}
                        >
                          {t('milk.discard')}
                        </button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <p className="meta">{t('milk.rulesHint')}</p>
        </Card>

        {/* ---------------- Discarded milk (V4-35, D-13) ---------------- */}
        <Card>
          <Label>{t('milk.discardedTotal')}</Label>
          <div className="value">{unknown ? '—' : formatMilkOz(discardedMl)}</div>
          <div className="meta">{t('milk.discardedNote')}</div>
          {discardedPending && <div className="pending-tag">{t('milk.stashPending')}</div>}
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
                // Served = what went into bottles; a discard is not served (v4).
                const served = container ? containerBalance(container, null, discards).served : 0
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
