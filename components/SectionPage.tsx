'use client'

/**
 * /feeding, /diapers and /sleep: one section each — its totals for today and
 * the last 7 days, a form to log one with an earlier time, and its full log
 * with Edit / Delete.
 *
 * The three pages are one component because they are the same page over
 * different tables. It follows /history's offline pattern exactly (the last
 * good rows per read, the queue merged on top, the copy saved on this
 * device, the quick repaint from the queue, stale reads dropped), and its
 * edit panel is a copy of /history's, not an extraction: /history is left
 * untouched.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SeenNote, SyncBar, SyncErrorBanner } from '@/components/SyncStatus'
import { lastGood, seenKey, type LastGood, type SeenState } from '@/lib/lastSeen'
import {
  buildActivity,
  diapersSince,
  feedingsSince,
  keepLastGood,
  logDiaper,
  logFeeding,
  mergePending,
  nursingSince,
  pendingWrites,
  recentDiapers,
  recentFeedings,
  recentNursing,
  recentSleep,
  sleepSince,
  startNursing,
  startSleep,
  updateDiaper,
  updateFeeding,
  updateNursing,
  updateSleep,
  voidDiaper,
  voidFeeding,
  voidNursing,
  voidSleep,
} from '@/lib/db'
import {
  checkPastRange,
  diaperKpis,
  feedingKpis,
  kpiWindows,
  sleepKpis,
  type KpiWindow,
  type PastRangeProblem,
} from '@/lib/kpis'
import { useSync } from '@/lib/useSync'
import { useVolumeUnit } from '@/lib/useVolumeUnit'
import { useT } from '@/lib/i18n/react'
import { useReturnFocus } from '@/lib/useReturnFocus'
import type { Lang, MessageKey } from '@/lib/i18n'
import { looksOffline, type PendingWrite } from '@/lib/queue'
import type {
  ActivityEntry,
  DiaperChange,
  DiaperType,
  Feeding,
  FeedingType,
  NursingSession,
  Result,
  Side,
  SleepSession,
  WithPending,
} from '@/lib/types'
import {
  clockTime,
  durationBetween,
  formatDuration,
  formatVolume,
  fromHouseholdInputValue,
  householdToday,
  longDate,
  mlToUnit,
  startOfHouseholdDay,
  toHouseholdInputValue,
  unitToMl,
} from '@/lib/format'

export type Section = 'feeding' | 'diapers' | 'sleep'

/** Same cap as /history: the log. The totals read their whole window. */
const LOG_LIMIT = 200

const TITLE: Record<Section, MessageKey> = {
  feeding: 'section.feeding',
  diapers: 'section.diaper',
  sleep: 'section.sleep',
}

/** What the server last returned, before the queue is merged in. */
type ServerRows = {
  feedings: Feeding[]
  nursing: NursingSession[]
  diapers: DiaperChange[]
  sleep: SleepSession[]
  /** The last 7 days, whole — for the totals. */
  weekFeedings: Feeding[]
  weekNursing: NursingSession[]
  weekDiapers: DiaperChange[]
  weekSleep: SleepSession[]
}
const NO_ROWS: ServerRows = {
  feedings: [],
  nursing: [],
  diapers: [],
  sleep: [],
  weekFeedings: [],
  weekNursing: [],
  weekDiapers: [],
  weekSleep: [],
}
type Reads = { [K in keyof ServerRows]: Result<ServerRows[K]> }

/** A table this section doesn't show: nothing to read. */
const NOT_READ = { data: [], error: null }

function readSection(section: Section, babyId: string, sinceIso: string): Promise<Reads> {
  const none = {
    feedings: NOT_READ,
    nursing: NOT_READ,
    diapers: NOT_READ,
    sleep: NOT_READ,
    weekFeedings: NOT_READ,
    weekNursing: NOT_READ,
    weekDiapers: NOT_READ,
    weekSleep: NOT_READ,
  }
  if (section === 'feeding') {
    return Promise.all([
      recentFeedings(babyId, LOG_LIMIT),
      recentNursing(babyId, LOG_LIMIT),
      feedingsSince(babyId, sinceIso),
      nursingSince(babyId, sinceIso),
    ]).then(([feedings, nursing, weekFeedings, weekNursing]) => ({
      ...none,
      feedings,
      nursing,
      weekFeedings,
      weekNursing,
    }))
  }
  if (section === 'diapers') {
    return Promise.all([recentDiapers(babyId, LOG_LIMIT), diapersSince(babyId, sinceIso)]).then(
      ([diapers, weekDiapers]) => ({ ...none, diapers, weekDiapers }),
    )
  }
  return Promise.all([recentSleep(babyId, LOG_LIMIT), sleepSince(babyId, sinceIso)]).then(
    ([sleep, weekSleep]) => ({ ...none, sleep, weekSleep }),
  )
}

/** The rows on screen: server rows with the queue folded in. */
type Shown = {
  feedings: WithPending<Feeding>[]
  nursing: WithPending<NursingSession>[]
  diapers: WithPending<DiaperChange>[]
  sleep: WithPending<SleepSession>[]
  weekFeedings: WithPending<Feeding>[]
  weekNursing: WithPending<NursingSession>[]
  weekDiapers: WithPending<DiaperChange>[]
  weekSleep: WithPending<SleepSession>[]
}

/** One calendar day of the log, household timezone (as on /history). */
type Day = { key: string; label: string; entries: ActivityEntry[] }

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

type EditKind = 'feeding' | 'diaper' | 'nursing' | 'sleep'
type EditTarget = { kind: EditKind; id: string }

function isEditable(kind: ActivityEntry['kind']): kind is EditKind {
  return kind === 'feeding' || kind === 'diaper' || kind === 'nursing' || kind === 'sleep'
}

/** A datetime-local value as the instant to store, or null when empty. */
function instant(value: string): string | null {
  return value ? fromHouseholdInputValue(value) : null
}

function minutesAgo(mins: number): string {
  return toHouseholdInputValue(new Date(Date.now() - mins * 60_000))
}

type PastFeeding = 'breast' | 'bottle' | 'solid'

export function SectionPage({ section }: { section: Section }) {
  const { baby, userId, loading, unreachable } = useBaby()
  const [unit] = useVolumeUnit()
  const { t, lang } = useT()

  const [shown, setShown] = useState<Shown>(NO_ROWS)
  const [days, setDays] = useState<Day[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [editing, setEditing] = useState<EditTarget | null>(null)
  useReturnFocus(editing && `${editing.kind}-${editing.id}`, !busy)

  // Edit panel fields, as on /history: only the ones for the entry being
  // edited are shown or read.
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

  // "Log a past one".
  const [pKind, setPKind] = useState<PastFeeding>('breast')
  const [pSide, setPSide] = useState<Side>('left')
  const [pAmount, setPAmount] = useState('')
  const [pDiaper, setPDiaper] = useState<DiaperType>('wet')
  const [pAt, setPAt] = useState(() => toHouseholdInputValue())
  const [pStart, setPStart] = useState(() => minutesAgo(section === 'sleep' ? 60 : 15))
  const [pEnd, setPEnd] = useState(() => toHouseholdInputValue())
  // Nursing and sleep: "still going" logs a session that started earlier and
  // hasn't ended — it stays open and is stopped from Today, as if Start had
  // been pressed at the time picked.
  const [pOngoing, setPOngoing] = useState(false)

  function resetPast() {
    setPAmount('')
    setPAt(toHouseholdInputValue())
    setPStart(minutesAgo(section === 'sleep' ? 60 : 15))
    setPEnd(toHouseholdInputValue())
    setPOngoing(false)
  }

  // The totals include a session still running, up to now.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

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

  // Same as /history: queued writes are folded in and marked; a failed read
  // keeps the last good rows (starting from this device's saved copy), and a
  // slow read never lands over a newer one.
  const serverRows = useRef<LastGood<ServerRows> | null>(null)
  const latestRead = useRef(0)
  const [seen, setSeen] = useState<SeenState>({ kind: 'live' })

  const show = useCallback(
    (rows: ServerRows, queued: PendingWrite[]) => {
      const next: Shown = {
        feedings: mergePending(rows.feedings, 'feedings', queued),
        nursing: mergePending(rows.nursing, 'nursing_sessions', queued),
        diapers: mergePending(rows.diapers, 'diaper_changes', queued),
        sleep: mergePending(rows.sleep, 'sleep_sessions', queued),
        weekFeedings: mergePending(rows.weekFeedings, 'feedings', queued),
        weekNursing: mergePending(rows.weekNursing, 'nursing_sessions', queued),
        weekDiapers: mergePending(rows.weekDiapers, 'diaper_changes', queued),
        weekSleep: mergePending(rows.weekSleep, 'sleep_sessions', queued),
      }
      // Only this section's tables: the others were never read and stay empty.
      if (section !== 'feeding') {
        next.feedings = next.nursing = next.weekFeedings = next.weekNursing = []
      }
      if (section !== 'diapers') next.diapers = next.weekDiapers = []
      if (section !== 'sleep') next.sleep = next.weekSleep = []
      setShown(next)

      // Time order, as on /history: a running session sits where it started.
      const entries = buildActivity(
        next.feedings,
        next.nursing,
        next.diapers,
        next.sleep,
        0,
        unit,
        lang,
      ).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      setDays(groupByHouseholdDay(entries, lang))
    },
    [section, unit, lang],
  )

  const refresh = useCallback(
    async (babyId: string) => {
      const read = ++latestRead.current
      const key = seenKey.page(section, babyId)
      if (serverRows.current?.key !== key) serverRows.current = lastGood(key, NO_ROWS)
      const last = serverRows.current

      // The queue answers at once: with something queued, or no connection,
      // repaint from it now instead of when the server read gives up.
      const queuedNow = await pendingWrites()
      if (read !== latestRead.current) return
      const offline = navigator.onLine === false
      if (queuedNow.length > 0 || offline) {
        show(last.rows, queuedNow)
        setSeen(last.state(offline))
      }

      const since = new Date(startOfHouseholdDay(new Date(), 6)).toISOString()
      const [reads, queued] = await Promise.all([
        readSection(section, babyId, since),
        pendingWrites(),
      ])
      if (read !== latestRead.current) return

      const { rows, error } = keepLastGood(last.rows, reads)
      setSeen(last.settle(rows, error))
      // No network is not an error to shout: the saved-copy note says it.
      setLoadErr(error && !looksOffline(error) ? t('category.couldNotLoad', { error }) : null)

      show(rows, queued)
    },
    [section, show, t],
  )

  const { online, pending, syncing, syncError, syncFailed, discardFailed, reloadPending } = useSync(
    () => {
      if (baby) refresh(baby.id)
    },
  )

  useEffect(() => {
    if (baby) refresh(baby.id)
  }, [baby, refresh])

  function problemText(problem: PastRangeProblem): string {
    return t(`past.${problem}`)
  }

  // ------------------------------------------------------------ edit / delete

  function startEdit(entry: ActivityEntry) {
    if (!isEditable(entry.kind)) return
    setErr(null)

    if (entry.kind === 'feeding') {
      const row = shown.feedings.find((r) => r.id === entry.id)
      if (!row) return
      setFType(row.feeding_type)
      setFAmount(row.amount_ml != null ? String(mlToUnit(row.amount_ml, unit)) : '')
      setFAt(toHouseholdInputValue(new Date(row.fed_at)))
    } else if (entry.kind === 'diaper') {
      const row = shown.diapers.find((r) => r.id === entry.id)
      if (!row) return
      setDType(row.diaper_type)
      setDAt(toHouseholdInputValue(new Date(row.changed_at)))
    } else if (entry.kind === 'nursing') {
      const row = shown.nursing.find((r) => r.id === entry.id)
      if (!row || !row.ended_at) return
      setNSide(row.side)
      setNStart(toHouseholdInputValue(new Date(row.started_at)))
      setNEnd(toHouseholdInputValue(new Date(row.ended_at)))
    } else {
      const row = shown.sleep.find((r) => r.id === entry.id)
      if (!row || !row.ended_at) return
      setSStart(toHouseholdInputValue(new Date(row.started_at)))
      setSEnd(toHouseholdInputValue(new Date(row.ended_at)))
    }

    setEditing({ kind: entry.kind, id: entry.id })
  }

  async function saveEdit() {
    if (!editing || !baby || busy) return
    setErr(null)

    let send: () => Promise<{ error: string | null; queued?: boolean }>
    let problem: PastRangeProblem | null

    if (editing.kind === 'feeding') {
      const amount = fAmount.trim() === '' ? null : Number(fAmount)
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
        setErr(t('history.amountNotNumber', { unit }))
        return
      }
      const at = instant(fAt)
      problem = checkPastRange(at, undefined, Date.now())
      const id = editing.id
      send = () =>
        updateFeeding(id, {
          feeding_type: fType,
          amount_ml: fType === 'bottle' && amount !== null ? unitToMl(amount, unit) : null,
          fed_at: at!,
        })
    } else if (editing.kind === 'diaper') {
      const at = instant(dAt)
      problem = checkPastRange(at, undefined, Date.now())
      const id = editing.id
      send = () => updateDiaper(id, { diaper_type: dType, changed_at: at! })
    } else if (editing.kind === 'nursing') {
      const start = instant(nStart)
      const end = instant(nEnd)
      problem = checkPastRange(start, end, Date.now())
      const id = editing.id
      send = () => updateNursing(id, { side: nSide, started_at: start!, ended_at: end })
    } else {
      const start = instant(sStart)
      const end = instant(sEnd)
      problem = checkPastRange(start, end, Date.now())
      const id = editing.id
      send = () => updateSleep(id, { started_at: start!, ended_at: end })
    }

    if (problem) {
      setErr(problemText(problem))
      return
    }

    setBusy(true)
    const result = await send()
    if (result.error) {
      setErr(t('common.couldNotSave', { error: result.error }))
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
    if (!window.confirm(t('category.removeConfirm'))) return

    const { kind, id } = entry
    setBusy(true)
    setErr(null)

    const result =
      kind === 'feeding'
        ? await voidFeeding(id)
        : kind === 'diaper'
          ? await voidDiaper(id)
          : kind === 'nursing'
            ? await voidNursing(id)
            : await voidSleep(id)

    if (result.error) {
      setErr(t('common.couldNotDelete', { error: result.error }))
    } else {
      if (editing?.id === id) setEditing(null)
      confirm(result.queued ? t('common.queued') : t('common.deleted'))
      refresh(baby.id)
      reloadPending()
    }
    setBusy(false)
  }

  // ------------------------------------------------------------ log a past one

  async function onPast(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || busy) return
    setErr(null)
    const nowMs = Date.now()

    let label: string
    let at: string | null
    let problem: PastRangeProblem | null
    let send: () => Promise<{ error: string | null; queued?: boolean }>

    if (section === 'feeding' && pKind === 'breast') {
      // Two open sessions would leave Today stopping one and hiding the other.
      if (pOngoing && shown.nursing.some((r) => !r.ended_at)) {
        setErr(t('past.alreadyNursing'))
        return
      }
      const start = instant(pStart)
      const end = pOngoing ? undefined : instant(pEnd)
      at = start
      problem = checkPastRange(start, end, nowMs)
      label = t(pSide === 'left' ? 'dash.label.nursingLeft' : 'dash.label.nursingRight')
      send = () => startNursing(baby.id, userId, pSide, start!, end ?? undefined)
    } else if (section === 'feeding') {
      at = instant(pAt)
      problem = checkPastRange(at, undefined, nowMs)
      if (pKind === 'bottle') {
        const raw = pAmount.trim()
        const amount = raw === '' ? null : Number(raw)
        if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
          setErr(t('dash.bottleNotNumber', { unit }))
          return
        }
        const ml = amount === null ? null : unitToMl(amount, unit)
        label = t('dash.label.bottle')
        send = () => logFeeding(baby.id, userId, 'bottle', ml, at!)
      } else {
        label = t('dash.label.solid')
        send = () => logFeeding(baby.id, userId, 'solid', null, at!)
      }
    } else if (section === 'diapers') {
      at = instant(pAt)
      problem = checkPastRange(at, undefined, nowMs)
      label = t('dash.label.diaper', { type: t(`diaper.${pDiaper}`) })
      send = () => logDiaper(baby.id, userId, pDiaper, at!)
    } else {
      if (pOngoing && shown.sleep.some((r) => !r.ended_at)) {
        setErr(t('past.alreadySleeping'))
        return
      }
      const start = instant(pStart)
      const end = pOngoing ? undefined : instant(pEnd)
      at = start
      problem = checkPastRange(start, end, nowMs)
      label = t('dash.label.sleep')
      send = () => startSleep(baby.id, userId, start!, end ?? undefined)
    }

    if (problem) {
      setErr(problemText(problem))
      return
    }

    setBusy(true)
    const { error, queued } = await send()
    if (error) {
      setErr(t('dash.couldNotSaveLabel', { label, error }))
    } else {
      const when = t('dash.forTime', { time: clockTime(at, lang) })
      confirm(t(queued ? 'dash.queuedLabel' : 'dash.loggedLabel', { label, when }))
      resetPast()
      refresh(baby.id)
      reloadPending()
    }
    setBusy(false)
  }

  // ------------------------------------------------------------ render

  if (loading)
    return (
      <Page>
        <p className="empty">{t('common.loading')}</p>
      </Page>
    )
  if (!baby)
    return (
      <Page>
        <Nav />
        <NoBaby offline={unreachable} />
      </Page>
    )

  // Offline with nothing saved on this device: a total of 0 would be a guess.
  const unknown = seen.kind === 'nothing'
  const windows = kpiWindows(new Date(now))
  const maxInput = toHouseholdInputValue(new Date(now))

  function totals(w: KpiWindow): { rows: [string, string][]; pending: boolean } {
    if (section === 'feeding') {
      const k = feedingKpis(shown.weekFeedings, shown.weekNursing, w, now)
      return {
        pending: k.pending,
        rows: [
          [t('kpi.feedings'), String(k.total)],
          [t('kpi.breast'), String(k.breast)],
          [t('feedingButton.bottle'), String(k.bottle)],
          [t('feedingButton.solid'), String(k.solid)],
          [t('kpi.bottleVolume'), formatVolume(k.bottleMl, unit)],
          [t('kpi.breastTime'), formatDuration(k.breastMs, lang)],
        ],
      }
    }
    if (section === 'diapers') {
      const k = diaperKpis(shown.weekDiapers, w)
      return {
        pending: k.pending,
        rows: [
          [t('kpi.diapers'), String(k.total)],
          [t('activity.diaperDetail.wet'), String(k.wet)],
          [t('activity.diaperDetail.dirty'), String(k.dirty)],
          [t('activity.diaperDetail.both'), String(k.both)],
        ],
      }
    }
    const k = sleepKpis(shown.weekSleep, w, now)
    return {
      pending: k.pending,
      rows: [
        [t('kpi.slept'), formatDuration(k.sleptMs, lang)],
        [t('kpi.naps'), String(k.naps)],
      ],
    }
  }

  function kpiCard(title: string, w: KpiWindow) {
    const { rows, pending: hasPending } = totals(w)
    return (
      <Card key={title}>
        <Label>{title}</Label>
        <dl className="kpis">
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{unknown ? '—' : value}</dd>
            </Fragment>
          ))}
        </dl>
        {hasPending && !unknown && <div className="pending-tag">{t('kpi.includesPending')}</div>}
      </Card>
    )
  }

  /** A finished session's span, under its line in the log. */
  function spanOf(entry: ActivityEntry): string | null {
    const row =
      entry.kind === 'nursing'
        ? shown.nursing.find((r) => r.id === entry.id)
        : entry.kind === 'sleep'
          ? shown.sleep.find((r) => r.id === entry.id)
          : undefined
    if (!row || !row.ended_at) return null
    return `${clockTime(row.started_at, lang)}–${clockTime(row.ended_at, lang)} · ${durationBetween(row.started_at, row.ended_at, lang)}`
  }

  const editButtons = (
    <div className="row-tight">
      <Btn disabled={busy} onClick={saveEdit}>
        {t('common.save')}
      </Btn>
      <Btn variant="quiet" onClick={() => setEditing(null)}>
        {t('common.cancel')}
      </Btn>
    </div>
  )

  const needsRange = section === 'sleep' || (section === 'feeding' && pKind === 'breast')

  return (
    <Page>
      <Nav babyId={baby.id} />
      <h1 className="title">{t(TITLE[section])}</h1>
      <SyncBar online={online} pending={pending} syncing={syncing} />
      <SeenNote state={seen} />
      <SyncErrorBanner error={syncError} failed={syncFailed} onDiscard={discardFailed} />
      {loadErr && <Banner kind="error">{loadErr}</Banner>}
      {err && <Banner kind="error">{err}</Banner>}
      {flash && !err && <Banner kind="ok">{flash}</Banner>}

      <Grid>
        {kpiCard(t('kpi.today'), windows.today)}
        {kpiCard(t('kpi.week'), windows.week)}

        {/* ---------------- Log a past one ---------------- */}
        <Card>
          <Label>{t('past.title')}</Label>
          <form onSubmit={onPast} className="stack">
            {section === 'feeding' && (
              <div className="row">
                {(['breast', 'bottle', 'solid'] as PastFeeding[]).map((kind) => (
                  <Btn
                    key={kind}
                    variant={pKind === kind ? 'action' : 'quiet'}
                    onClick={() => setPKind(kind)}
                  >
                    {kind === 'breast' ? t('kpi.breast') : t(`feedingButton.${kind}`)}
                  </Btn>
                ))}
              </div>
            )}
            {section === 'feeding' && pKind === 'breast' && (
              <div className="row">
                {(['left', 'right'] as Side[]).map((s) => (
                  <Btn
                    key={s}
                    variant={pSide === s ? 'action' : 'quiet'}
                    onClick={() => setPSide(s)}
                  >
                    {t(`sideButton.${s}`)}
                  </Btn>
                ))}
              </div>
            )}
            {section === 'diapers' && (
              <div className="row">
                {(['wet', 'dirty', 'both'] as DiaperType[]).map((kind) => (
                  <Btn
                    key={kind}
                    variant={pDiaper === kind ? 'action' : 'quiet'}
                    onClick={() => setPDiaper(kind)}
                  >
                    {t(`diaperButton.${kind}`)}
                  </Btn>
                ))}
              </div>
            )}
            {section === 'feeding' && pKind === 'bottle' && (
              <input
                className="input narrow"
                value={pAmount}
                onChange={(e) => setPAmount(e.target.value)}
                inputMode="decimal"
                placeholder={unit}
                aria-label={t('dash.bottleAmount', { unit })}
              />
            )}
            {needsRange && (
              <div className="row">
                {[false, true].map((ongoing) => (
                  <Btn
                    key={String(ongoing)}
                    variant={pOngoing === ongoing ? 'action' : 'quiet'}
                    onClick={() => setPOngoing(ongoing)}
                  >
                    {ongoing ? t('past.stillGoing') : t('past.finished')}
                  </Btn>
                ))}
              </div>
            )}
            {needsRange ? (
              <>
                <label className="label" htmlFor={`past-${section}-start`}>
                  {t('common.started')}
                </label>
                <input
                  id={`past-${section}-start`}
                  type="datetime-local"
                  className="input"
                  value={pStart}
                  onChange={(e) => setPStart(e.target.value)}
                  max={maxInput}
                  required
                />
                {pOngoing ? (
                  <p className="meta">{t('past.stillGoingHint')}</p>
                ) : (
                  <>
                    <label className="label" htmlFor={`past-${section}-end`}>
                      {t('common.ended')}
                    </label>
                    <input
                      id={`past-${section}-end`}
                      type="datetime-local"
                      className="input"
                      value={pEnd}
                      onChange={(e) => setPEnd(e.target.value)}
                      max={maxInput}
                      required
                    />
                  </>
                )}
              </>
            ) : (
              <>
                <label className="label" htmlFor={`past-${section}-at`}>
                  {t('common.timeItHappened')}
                </label>
                <input
                  id={`past-${section}-at`}
                  type="datetime-local"
                  className="input"
                  value={pAt}
                  onChange={(e) => setPAt(e.target.value)}
                  max={maxInput}
                  required
                />
              </>
            )}
            <div className="row-tight">
              <Btn type="submit" disabled={busy}>
                {busy ? t('common.saving') : t('past.save')}
              </Btn>
            </div>
          </form>
        </Card>
      </Grid>

      {/* ---------------- The log ---------------- */}
      <h2 className="label section-label">{t('category.entries')}</h2>
      <Grid>
        {days.length === 0 ? (
          <Card>
            <div className="empty">{unknown ? t('sync.nothingSaved') : t('history.empty')}</div>
          </Card>
        ) : (
          days.map((day) => (
            <Card key={day.key} spanAll>
              <Label>{day.label}</Label>
              <div className="feed">
                {day.entries.map((entry) => {
                  const isEditing = editing?.kind === entry.kind && editing.id === entry.id
                  const span = spanOf(entry)
                  return (
                    <div key={`${entry.kind}-${entry.id}`}>
                      <div className="feed-item">
                        <span className="feed-time">{clockTime(entry.at, lang)}</span>
                        <span className="feed-what">
                          {section === 'feeding' ? entry.what : entry.detail}
                          {span && <span className="meta feed-span">{span}</span>}
                        </span>
                        {isEditable(entry.kind) && !isEditing && (
                          <span className="feed-actions">
                            {/* A session still running is stopped from Today. */}
                            {!entry.ongoing && (
                              <button
                                type="button"
                                className="linkish"
                                data-edit-for={`${entry.kind}-${entry.id}`}
                                disabled={busy || editing !== null}
                                onClick={() => startEdit(entry)}
                              >
                                {t('common.edit')}
                              </button>
                            )}
                            <button
                              type="button"
                              className="linkish"
                              disabled={busy || editing !== null}
                              onClick={() => deleteEntry(entry)}
                            >
                              {t('common.delete')}
                            </button>
                          </span>
                        )}
                      </div>

                      {isEditing && editing.kind === 'feeding' && (
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
                              placeholder={unit}
                              aria-label={t('history.amountIn', { unit })}
                            />
                          )}
                          <input
                            type="datetime-local"
                            className="input"
                            value={fAt}
                            onChange={(e) => setFAt(e.target.value)}
                            max={maxInput}
                            aria-label={t('common.timeItHappened')}
                          />
                          {editButtons}
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
                            max={maxInput}
                            aria-label={t('common.timeItHappened')}
                          />
                          {editButtons}
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
                          <label className="label" htmlFor="edit-nursing-start">
                            {t('common.started')}
                          </label>
                          <input
                            id="edit-nursing-start"
                            type="datetime-local"
                            className="input"
                            value={nStart}
                            onChange={(e) => setNStart(e.target.value)}
                            max={maxInput}
                          />
                          <label className="label" htmlFor="edit-nursing-end">
                            {t('common.ended')}
                          </label>
                          <input
                            id="edit-nursing-end"
                            type="datetime-local"
                            className="input"
                            value={nEnd}
                            onChange={(e) => setNEnd(e.target.value)}
                            max={maxInput}
                          />
                          {editButtons}
                        </div>
                      )}

                      {isEditing && editing.kind === 'sleep' && (
                        <div className="edit-panel">
                          <label className="label" htmlFor="edit-sleep-start">
                            {t('common.started')}
                          </label>
                          <input
                            id="edit-sleep-start"
                            type="datetime-local"
                            className="input"
                            value={sStart}
                            onChange={(e) => setSStart(e.target.value)}
                            max={maxInput}
                          />
                          <label className="label" htmlFor="edit-sleep-end">
                            {t('common.ended')}
                          </label>
                          <input
                            id="edit-sleep-end"
                            type="datetime-local"
                            className="input"
                            value={sEnd}
                            onChange={(e) => setSEnd(e.target.value)}
                            max={maxInput}
                          />
                          {editButtons}
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
