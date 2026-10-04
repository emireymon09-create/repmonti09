'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page, RowMenu } from '@/components/ui'
import { SeenNote, SyncBar, SyncErrorBanner } from '@/components/SyncStatus'
import { lastGood, seenKey, type LastGood, type SeenState } from '@/lib/lastSeen'
import {
  buildActivity,
  keepLastGood,
  listContainers,
  listDrawdowns,
  mergePending,
  milkErrorText,
  pendingWrites,
  recentDiapers,
  recentFeedings,
  recentNursing,
  recentPumping,
  recentSleep,
  updateDiaper,
  updateFeeding,
  updateNursing,
  updatePumping,
  updateSleep,
  voidBottleFeed,
  voidDiaper,
  voidFeeding,
  voidNursing,
  voidPumping,
  voidSleep,
} from '@/lib/db'
import { useSync } from '@/lib/useSync'
import { useT } from '@/lib/i18n/react'
import { useReturnFocus } from '@/lib/useReturnFocus'
import type { Lang } from '@/lib/i18n'
import { looksOffline, type PendingWrite } from '@/lib/queue'
import { applyPendingInventory, describeBottle, isInventoryBottleFeed } from '@/lib/milk'
import type {
  ActivityEntry,
  DiaperChange,
  DiaperType,
  Feeding,
  FeedingType,
  MilkContainer,
  MilkDrawdown,
  NursingSession,
  PumpingSession,
  PumpSide,
  Side,
  SleepSession,
  WithPending,
} from '@/lib/types'
import {
  clockTime,
  DISPLAY_UNIT,
  fromHouseholdInputValue,
  householdToday,
  longDate,
  mlToUnit,
  toHouseholdInputValue,
  unitToMl,
} from '@/lib/format'

const HISTORY_LIMIT = 200

/** What the server last returned for each table, before the queue is merged in. */
type ServerRows = {
  feedings: Feeding[]
  diapers: DiaperChange[]
  nursing: NursingSession[]
  sleep: SleepSession[]
  pumping: PumpingSession[]
  /**
   * Which containers each bottle came from (0013), for the breakdown line —
   * and the containers, so a bottle given offline still names its M#.
   */
  containers: MilkContainer[]
  drawdowns: MilkDrawdown[]
}
const NO_ROWS: ServerRows = {
  feedings: [],
  diapers: [],
  nursing: [],
  sleep: [],
  pumping: [],
  containers: [],
  drawdowns: [],
}

/** One calendar day's worth of entries, household timezone. */
type Day = { key: string; label: string; entries: ActivityEntry[] }

/**
 * Every logged entry has an ISO `at` already — the household day it
 * falls on is just householdToday() run on that instant instead of
 * "now". Entries arrive newest-first (buildActivity's own sort), so
 * grouping in order naturally keeps days newest-first too.
 */
function groupByHouseholdDay(entries: ActivityEntry[], lang: Lang): Day[] {
  const days: Day[] = []
  const byKey = new Map<string, Day>()

  for (const entry of entries) {
    const key = householdToday(new Date(entry.at))
    let day = byKey.get(key)
    if (!day) {
      day = { key, label: longDate(entry.at, lang), entries: [] }
      byKey.set(key, day)
      days.push(day)
    }
    day.entries.push(entry)
  }

  return days
}

/**
 * The kinds with a raw row + edit/void functions behind them. Pumping joined
 * them so that /pumping can stay a plain log: History is the one place where
 * any entry gets corrected or removed.
 */
type EditKind = 'feeding' | 'diaper' | 'nursing' | 'sleep' | 'pumping'
type EditTarget = { kind: EditKind; id: string }

function isEditable(kind: ActivityEntry['kind']): kind is EditKind {
  return (
    kind === 'feeding' ||
    kind === 'diaper' ||
    kind === 'nursing' ||
    kind === 'sleep' ||
    kind === 'pumping'
  )
}

const PUMP_SIDES: PumpSide[] = ['left', 'right', 'both']

export default function HistoryPage() {
  const { baby, loading, unreachable } = useBaby()
  const { t, lang } = useT()

  const [days, setDays] = useState<Day[]>([])
  const [feedings, setFeedings] = useState<WithPending<Feeding>[]>([])
  const [drawdowns, setDrawdowns] = useState<WithPending<MilkDrawdown>[]>([])
  const [diapers, setDiapers] = useState<WithPending<DiaperChange>[]>([])
  const [nursing, setNursing] = useState<WithPending<NursingSession>[]>([])
  const [sleep, setSleep] = useState<WithPending<SleepSession>[]>([])
  const [pumping, setPumping] = useState<WithPending<PumpingSession>[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [editing, setEditing] = useState<EditTarget | null>(null)
  useReturnFocus(editing && `${editing.kind}-${editing.id}`, !busy)

  // One small set of form fields, shared across kinds — only the ones
  // relevant to the entry being edited are ever shown or read.
  const [fType, setFType] = useState<FeedingType>('bottle')
  const [fAmount, setFAmount] = useState('')
  const [fAt, setFAt] = useState('')
  const [dType, setDType] = useState<DiaperType>('both')
  const [dAt, setDAt] = useState('')
  const [nSide, setNSide] = useState<Side>('left')
  const [nStart, setNStart] = useState('')
  const [nEnd, setNEnd] = useState('')
  const [sStart, setSStart] = useState('')
  const [sEnd, setSEnd] = useState('')
  const [pSide, setPSide] = useState<PumpSide>('both')
  const [pAmount, setPAmount] = useState('')
  const [pNotes, setPNotes] = useState('')
  const [pAt, setPAt] = useState('')

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    },
    [],
  )

  function confirm(message: string) {
    setFlash(message)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2500)
  }

  // Queued writes are folded in, so an entry added, corrected or deleted
  // offline shows as "not synced yet" instead of looking stale. Offline the
  // reads fail after a few seconds of retries: the last rows the server
  // gave stay up, with the queue on top of them, rather than an empty list.
  // They start from the copy this device saved last time (lib/lastSeen.ts),
  // so a reload with no connection isn't empty either. And that slow read
  // must not land over a newer one.
  const serverRows = useRef<LastGood<ServerRows> | null>(null)
  const latestRead = useRef(0)
  const [seen, setSeen] = useState<SeenState>({ kind: 'live' })

  const show = useCallback(
    (rows: ServerRows, queued: PendingWrite[]) => {
      const mFeedings = mergePending(rows.feedings, 'feedings', queued)
      const mDiapers = mergePending(rows.diapers, 'diaper_changes', queued)
      const mNursing = mergePending(rows.nursing, 'nursing_sessions', queued)
      const mSleep = mergePending(rows.sleep, 'sleep_sessions', queued)
      const mPumping = mergePending(rows.pumping, 'pumping_sessions', queued)

      setFeedings(mFeedings)
      setDrawdowns(
        applyPendingInventory(rows.containers ?? [], rows.drawdowns ?? [], queued).drawdowns,
      )
      setDiapers(mDiapers)
      setNursing(mNursing)
      setSleep(mSleep)
      setPumping(mPumping)

      // 0 = the start of time, i.e. no "since today" cutoff — the same
      // merge dashboard uses for Today, just unfiltered. buildActivity
      // sorts newest first, queued entries included; the per-kind lists
      // above are only looked up by id, so their order doesn't matter.
      // Today lists a running session first; here it goes by time like the
      // rest, so it lands under the day it started.
      const entries = buildActivity(
        mFeedings,
        mNursing,
        mDiapers,
        mSleep,
        mPumping,
        0,
        DISPLAY_UNIT,
        lang,
      ).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      setDays(groupByHouseholdDay(entries, lang))
    },
    [lang],
  )

  const refresh = useCallback(
    async (babyId: string) => {
      const read = ++latestRead.current
      const key = seenKey.page('history', babyId)
      if (serverRows.current?.key !== key) serverRows.current = lastGood(key, NO_ROWS)
      const last = serverRows.current

      // Same quick repaint as /dashboard: the queue answers at once, so an
      // edit made offline shows as "not synced yet" right away instead of
      // when the server read gives up. Only with something queued, or with
      // no connection: right after a flush the queue is empty and the last
      // server rows predate it, so repainting them would drop what was sent.
      const queuedNow = await pendingWrites()
      if (read !== latestRead.current) return
      const offline = navigator.onLine === false
      if (queuedNow.length > 0 || offline) {
        show(last.rows, queuedNow)
        setSeen(last.state(offline))
      }

      const [
        feedingsRead,
        diapersRead,
        nursingRead,
        sleepRead,
        pumpingRead,
        containersRead,
        drawdownsRead,
        queued,
      ] = await Promise.all([
        recentFeedings(babyId, HISTORY_LIMIT),
        recentDiapers(babyId, HISTORY_LIMIT),
        recentNursing(babyId, HISTORY_LIMIT),
        recentSleep(babyId, HISTORY_LIMIT),
        recentPumping(babyId, HISTORY_LIMIT),
        listContainers(babyId),
        listDrawdowns(babyId),
        pendingWrites(),
      ])
      if (read !== latestRead.current) return

      const { rows, error } = keepLastGood(last.rows, {
        feedings: feedingsRead,
        diapers: diapersRead,
        nursing: nursingRead,
        sleep: sleepRead,
        pumping: pumpingRead,
        containers: containersRead,
        drawdowns: drawdownsRead,
      })
      setSeen(last.settle(rows, error))
      // A read that failed for lack of network is not an error to shout:
      // the saved-copy note (or the "nothing saved" state) already says it,
      // and the next good read clears this. Kept apart from `err`, which
      // belongs to the user's own writes.
      setLoadErr(error && !looksOffline(error) ? t('history.couldNotLoad', { error }) : null)

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

  function startEdit(entry: ActivityEntry) {
    if (!isEditable(entry.kind)) return
    setErr(null)

    if (entry.kind === 'feeding') {
      const row = feedings.find((r) => r.id === entry.id)
      if (!row) return
      setFType(row.feeding_type)
      setFAmount(row.amount_ml != null ? String(mlToUnit(row.amount_ml, DISPLAY_UNIT)) : '')
      setFAt(toHouseholdInputValue(new Date(row.fed_at)))
    } else if (entry.kind === 'diaper') {
      const row = diapers.find((r) => r.id === entry.id)
      if (!row) return
      setDType(row.diaper_type)
      setDAt(toHouseholdInputValue(new Date(row.changed_at)))
    } else if (entry.kind === 'nursing') {
      const row = nursing.find((r) => r.id === entry.id)
      if (!row || !row.ended_at) return
      setNSide(row.side)
      setNStart(toHouseholdInputValue(new Date(row.started_at)))
      setNEnd(toHouseholdInputValue(new Date(row.ended_at)))
    } else if (entry.kind === 'sleep') {
      const row = sleep.find((r) => r.id === entry.id)
      if (!row || !row.ended_at) return
      setSStart(toHouseholdInputValue(new Date(row.started_at)))
      setSEnd(toHouseholdInputValue(new Date(row.ended_at)))
    } else {
      const row = pumping.find((r) => r.id === entry.id)
      if (!row) return
      setPSide(row.side)
      setPAmount(row.amount_ml != null ? String(mlToUnit(row.amount_ml, DISPLAY_UNIT)) : '')
      setPNotes(row.notes ?? '')
      setPAt(toHouseholdInputValue(new Date(row.pumped_at)))
    }

    setEditing({ kind: entry.kind, id: entry.id })
  }

  async function saveEdit() {
    if (!editing || !baby || busy) return
    setBusy(true)
    setErr(null)

    let result: { error: string | null; queued?: boolean }

    const editedFeed =
      editing.kind === 'feeding' ? feedings.find((r) => r.id === editing.id) : undefined
    // Behind its own insert when that is still queued (see `write` in lib/db.ts).
    const queueOnly = !!editedFeed?.pending
    if (editing.kind === 'feeding' && editedFeed && isInventoryBottleFeed(editedFeed)) {
      // A bottle with a breakdown: the time only (lib/milk.ts).
      result = await updateFeeding(
        editing.id,
        { fed_at: fromHouseholdInputValue(fAt) },
        { queueOnly },
      )
    } else if (editing.kind === 'feeding') {
      const amount = fAmount.trim() === '' ? null : Number(fAmount)
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
        setErr(t('history.amountNotNumber', { unit: t(`unit.${DISPLAY_UNIT}`) }))
        setBusy(false)
        return
      }
      result = await updateFeeding(
        editing.id,
        {
          feeding_type: fType,
          amount_ml: fType === 'bottle' && amount !== null ? unitToMl(amount, DISPLAY_UNIT) : null,
          fed_at: fromHouseholdInputValue(fAt),
        },
        { queueOnly },
      )
    } else if (editing.kind === 'diaper') {
      result = await updateDiaper(editing.id, {
        diaper_type: dType,
        changed_at: fromHouseholdInputValue(dAt),
      })
    } else if (editing.kind === 'nursing') {
      result = await updateNursing(editing.id, {
        side: nSide,
        started_at: fromHouseholdInputValue(nStart),
        ended_at: fromHouseholdInputValue(nEnd),
      })
    } else if (editing.kind === 'sleep') {
      result = await updateSleep(editing.id, {
        started_at: fromHouseholdInputValue(sStart),
        ended_at: fromHouseholdInputValue(sEnd),
      })
    } else {
      // Same parsing as the log form on /pumping: blank means "no amount".
      const trimmed = pAmount.trim()
      const amount = trimmed === '' ? null : Number(trimmed)
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
        setErr(t('history.amountNotNumber', { unit: t(`unit.${DISPLAY_UNIT}`) }))
        setBusy(false)
        return
      }
      result = await updatePumping(editing.id, {
        side: pSide,
        amount_ml: amount === null ? null : Number(unitToMl(amount, DISPLAY_UNIT).toFixed(1)),
        notes: pNotes.trim() || null,
        pumped_at: fromHouseholdInputValue(pAt),
      })
    }

    if (result.error) {
      setErr(t('common.couldNotSave', { error: milkErrorText(result.error, lang) }))
    } else {
      setEditing(null)
      confirm(result.queued ? t('common.queued') : t('common.saved'))
      refresh(baby.id)
      reloadPending()
    }
    setBusy(false)
  }

  async function deleteEntry(entry: ActivityEntry) {
    if (!baby || busy || !isEditable(entry.kind)) return
    const { kind, id } = entry
    const feed = kind === 'feeding' ? feedings.find((r) => r.id === id) : undefined
    const inventory = !!feed && isInventoryBottleFeed(feed)
    // A pumping session also comes out of the stash total on /pumping, and a
    // bottle with a breakdown gives its milk back: each confirmation says so —
    // "nothing else changes" would be false there.
    const question = inventory
      ? t('bottle.removeConfirm')
      : kind === 'pumping'
        ? t('milk.removeConfirm')
        : t('history.removeConfirm')
    if (!window.confirm(question)) return

    setBusy(true)
    setErr(null)

    // A bottle with a breakdown goes through the function that also gives its
    // milk back to each container (0013).
    const result =
      feed && inventory
        ? await voidBottleFeed(id, { pending: !!feed.pending })
        : kind === 'feeding'
          ? await voidFeeding(id)
          : kind === 'diaper'
            ? await voidDiaper(id)
            : kind === 'nursing'
              ? await voidNursing(id)
              : kind === 'sleep'
                ? await voidSleep(id)
                : await voidPumping(id)

    if (result.error) {
      setErr(t('common.couldNotDelete', { error: milkErrorText(result.error, lang) }))
    } else {
      if (editing?.id === id) setEditing(null)
      confirm(result.queued ? t('common.queued') : t('common.deleted'))
      refresh(baby.id)
      reloadPending()
    }
    setBusy(false)
  }

  if (loading)
    return (
      <Page>
        {/* El nav va también mientras carga. Sin él, cada navegación entre
            pantallas dejaba la ventana ENTERA vacía —barra de abajo
            incluida— hasta que useBaby() resolvía: eso era el "pantallazo"
            entre pantallas. Medido con CDP: existía una ventana sin nav y
            sin contenido, de 34 ms en este servidor y tanto más cuanto peor
            esté la conexión. */}
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

  return (
    <Page>
      <Nav />
      <h1 className="title">{t('history.title')}</h1>
      <SyncBar online={online} pending={pending} syncing={syncing} />
      <SeenNote state={seen} />
      <SyncErrorBanner error={syncError} failed={syncFailed} onDiscard={discardFailed} />
      {loadErr && <Banner kind="error">{loadErr}</Banner>}
      {err && <Banner kind="error">{err}</Banner>}
      {flash && !err && <Banner kind="ok">{flash}</Banner>}

      <Grid>
        {days.length === 0 ? (
          <Card>
            <div className="empty">
              {seen.kind === 'nothing' ? t('sync.nothingSaved') : t('history.empty')}
            </div>
          </Card>
        ) : (
          days.map((day) => (
            <Card key={day.key} spanAll>
              <Label>{day.label}</Label>
              <div className="feed">
                {day.entries.map((entry) => {
                  const isEditing = editing?.kind === entry.kind && editing.id === entry.id
                  const feedRow =
                    entry.kind === 'feeding' ? feedings.find((r) => r.id === entry.id) : undefined
                  const locked = !!feedRow && isInventoryBottleFeed(feedRow)
                  const breakdown = locked ? describeBottle(feedRow!, drawdowns, lang) : null
                  return (
                    <div key={`${entry.kind}-${entry.id}`}>
                      <div className="feed-item">
                        <span className="feed-time">{clockTime(entry.at, lang)}</span>
                        <span className="feed-what">
                          <span className="meta">{t(`history.kind.${entry.kind}`)} · </span>
                          {entry.detail}
                          {breakdown && <span className="meta feed-span">{breakdown}</span>}
                        </span>
                        {isEditable(entry.kind) && !isEditing && (
                          <RowMenu
                            label={t('history.rowOptions', {
                              kind: t(`history.kind.${entry.kind}`),
                              time: clockTime(entry.at, lang),
                            })}
                            editFor={`${entry.kind}-${entry.id}`}
                            disabled={busy || editing !== null}
                            // A session still running has no end to correct
                            // yet; it is stopped from Today. Delete only.
                            onEdit={entry.ongoing ? undefined : () => startEdit(entry)}
                            onDelete={() => deleteEntry(entry)}
                          />
                        )}
                      </div>

                      {isEditing && editing.kind === 'feeding' && locked && (
                        <div className="edit-panel">
                          <p className="meta">{t('bottle.timeOnly')}</p>
                          <input
                            type="datetime-local"
                            className="input"
                            value={fAt}
                            onChange={(e) => setFAt(e.target.value)}
                            max={toHouseholdInputValue()}
                            aria-label={t('common.timeItHappened')}
                          />
                          <div className="row-tight">
                            <Btn disabled={busy} onClick={saveEdit}>
                              {t('common.save')}
                            </Btn>
                            <Btn variant="quiet" onClick={() => setEditing(null)}>
                              {t('common.cancel')}
                            </Btn>
                          </div>
                        </div>
                      )}

                      {isEditing && editing.kind === 'feeding' && !locked && (
                        <div className="edit-panel">
                          <div className="row">
                            {(['bottle', 'solid', 'nursing'] as FeedingType[]).map((type) => (
                              <Btn
                                key={type}
                                variant={fType === type ? 'action' : 'quiet'}
                                onClick={() => setFType(type)}
                              >
                                {t(`feedingButton.${type}`)}
                              </Btn>
                            ))}
                          </div>
                          {fType === 'bottle' && (
                            <input
                              className="input narrow"
                              value={fAmount}
                              onChange={(e) => setFAmount(e.target.value)}
                              inputMode="decimal"
                              placeholder={t(`unit.${DISPLAY_UNIT}`)}
                              aria-label={t('history.amountIn', {
                                unit: t(`unit.${DISPLAY_UNIT}`),
                              })}
                            />
                          )}
                          <input
                            type="datetime-local"
                            className="input"
                            value={fAt}
                            onChange={(e) => setFAt(e.target.value)}
                            max={toHouseholdInputValue()}
                            aria-label={t('common.timeItHappened')}
                          />
                          <div className="row-tight">
                            <Btn disabled={busy} onClick={saveEdit}>
                              {t('common.save')}
                            </Btn>
                            <Btn variant="quiet" onClick={() => setEditing(null)}>
                              {t('common.cancel')}
                            </Btn>
                          </div>
                        </div>
                      )}

                      {isEditing && editing.kind === 'diaper' && (
                        <div className="edit-panel">
                          <div className="row">
                            {(['wet', 'dirty', 'both'] as DiaperType[]).map((type) => (
                              <Btn
                                key={type}
                                variant={dType === type ? 'action' : 'quiet'}
                                onClick={() => setDType(type)}
                              >
                                {t(`diaperButton.${type}`)}
                              </Btn>
                            ))}
                          </div>
                          <input
                            type="datetime-local"
                            className="input"
                            value={dAt}
                            onChange={(e) => setDAt(e.target.value)}
                            max={toHouseholdInputValue()}
                            aria-label={t('common.timeItHappened')}
                          />
                          <div className="row-tight">
                            <Btn disabled={busy} onClick={saveEdit}>
                              {t('common.save')}
                            </Btn>
                            <Btn variant="quiet" onClick={() => setEditing(null)}>
                              {t('common.cancel')}
                            </Btn>
                          </div>
                        </div>
                      )}

                      {isEditing && editing.kind === 'nursing' && (
                        <div className="edit-panel">
                          <div className="row">
                            {(['left', 'right'] as Side[]).map((s) => (
                              <Btn
                                key={s}
                                variant={nSide === s ? 'action' : 'quiet'}
                                onClick={() => setNSide(s)}
                              >
                                {t(`sideButton.${s}`)}
                              </Btn>
                            ))}
                          </div>
                          <label className="label" htmlFor="nursing-start">
                            {t('common.started')}
                          </label>
                          <input
                            id="nursing-start"
                            type="datetime-local"
                            className="input"
                            value={nStart}
                            onChange={(e) => setNStart(e.target.value)}
                            max={toHouseholdInputValue()}
                          />
                          <label className="label" htmlFor="nursing-end">
                            {t('common.ended')}
                          </label>
                          <input
                            id="nursing-end"
                            type="datetime-local"
                            className="input"
                            value={nEnd}
                            onChange={(e) => setNEnd(e.target.value)}
                            max={toHouseholdInputValue()}
                          />
                          <div className="row-tight">
                            <Btn disabled={busy} onClick={saveEdit}>
                              {t('common.save')}
                            </Btn>
                            <Btn variant="quiet" onClick={() => setEditing(null)}>
                              {t('common.cancel')}
                            </Btn>
                          </div>
                        </div>
                      )}

                      {isEditing && editing.kind === 'sleep' && (
                        <div className="edit-panel">
                          <label className="label" htmlFor="sleep-start">
                            {t('common.started')}
                          </label>
                          <input
                            id="sleep-start"
                            type="datetime-local"
                            className="input"
                            value={sStart}
                            onChange={(e) => setSStart(e.target.value)}
                            max={toHouseholdInputValue()}
                          />
                          <label className="label" htmlFor="sleep-end">
                            {t('common.ended')}
                          </label>
                          <input
                            id="sleep-end"
                            type="datetime-local"
                            className="input"
                            value={sEnd}
                            onChange={(e) => setSEnd(e.target.value)}
                            max={toHouseholdInputValue()}
                          />
                          <div className="row-tight">
                            <Btn disabled={busy} onClick={saveEdit}>
                              {t('common.save')}
                            </Btn>
                            <Btn variant="quiet" onClick={() => setEditing(null)}>
                              {t('common.cancel')}
                            </Btn>
                          </div>
                        </div>
                      )}

                      {isEditing && editing.kind === 'pumping' && (
                        <div className="edit-panel">
                          {/* row-wrap: "Izquierdo / Derecho / Ambos" no entra
                              en una línea en la pared — lo mismo que /pumping. */}
                          <div className="row row-wrap">
                            {PUMP_SIDES.map((s) => (
                              <Btn
                                key={s}
                                variant={pSide === s ? 'action' : 'quiet'}
                                onClick={() => setPSide(s)}
                              >
                                {t(`sideButton.${s}`)}
                              </Btn>
                            ))}
                          </div>
                          <input
                            className="input narrow"
                            value={pAmount}
                            onChange={(e) => setPAmount(e.target.value)}
                            inputMode="decimal"
                            placeholder={t('common.unitOptional', {
                              unit: t(`unit.${DISPLAY_UNIT}`),
                            })}
                            aria-label={t('history.amountIn', {
                              unit: t(`unit.${DISPLAY_UNIT}`),
                            })}
                          />
                          <input
                            className="input"
                            value={pNotes}
                            onChange={(e) => setPNotes(e.target.value)}
                            placeholder={t('common.notesOptional')}
                            aria-label={t('common.notes')}
                          />
                          <input
                            type="datetime-local"
                            className="input"
                            value={pAt}
                            onChange={(e) => setPAt(e.target.value)}
                            max={toHouseholdInputValue()}
                            aria-label={t('common.timeItHappened')}
                          />
                          <div className="row-tight">
                            <Btn disabled={busy} onClick={saveEdit}>
                              {t('common.save')}
                            </Btn>
                            <Btn variant="quiet" onClick={() => setEditing(null)}>
                              {t('common.cancel')}
                            </Btn>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </Card>
          ))
        )}
      </Grid>
    </Page>
  )
}
