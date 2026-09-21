'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import {
  addGrowth,
  buildActivity,
  endNursing,
  endSleep,
  logDiaper,
  logFeeding,
  keepLastGood,
  mergePending,
  nextAppointment,
  pendingWrites,
  predictNextFeeding,
  predictNextNap,
  recentDiapers,
  recentFeedings,
  recentNursing,
  recentSleep,
  recordBirth,
  startNursing,
  startSleep,
} from '@/lib/db'
import { useSync } from '@/lib/useSync'
import { SyncBar } from '@/components/SyncStatus'
import { useVolumeUnit } from '@/lib/useVolumeUnit'
import { useT } from '@/lib/i18n/react'
import type {
  ActivityEntry,
  DiaperChange,
  DiaperType,
  DoctorAppointment,
  Feeding,
  NursingSession,
  Side,
  SleepSession,
  WithPending,
} from '@/lib/types'
import type { PendingWrite } from '@/lib/queue'
import {
  ageFrom,
  apptWhen,
  clockTime,
  dueRelative,
  durationBetween,
  elapsed,
  formatVolume,
  fromHouseholdInputValue,
  householdToday,
  lbOzToKg,
  longDate,
  startOfHouseholdDay,
  timeAgo,
  toHouseholdInputValue,
  unitToMl,
} from '@/lib/format'

/** Newest first, after queued rows have been folded in out of order. */
function sortDesc<T extends Record<string, unknown>>(rows: T[], key: keyof T): T[] {
  return rows
    .slice()
    .sort((a, b) => new Date(String(b[key])).getTime() - new Date(String(a[key])).getTime())
}

/** What the server last returned, before the queue is merged in. */
type ServerRows = {
  feedings: Feeding[]
  diapers: DiaperChange[]
  nursing: NursingSession[]
  sleep: SleepSession[]
  appt: DoctorAppointment | null
}
const NO_ROWS: ServerRows = { feedings: [], diapers: [], nursing: [], sleep: [], appt: null }

export default function Dashboard() {
  const { baby, userId, loading, refreshBaby } = useBaby()
  const [unit] = useVolumeUnit()
  const { t, lang } = useT()

  const [feedings, setFeedings] = useState<WithPending<Feeding>[]>([])
  const [diapers, setDiapers] = useState<WithPending<DiaperChange>[]>([])
  const [nursing, setNursing] = useState<WithPending<NursingSession>[]>([])
  const [sleep, setSleep] = useState<WithPending<SleepSession>[]>([])
  const [appt, setAppt] = useState<DoctorAppointment | null>(null)
  const [today, setToday] = useState<ActivityEntry[]>([])

  const [birthDate, setBirthDate] = useState(() => householdToday())
  const [birthLb, setBirthLb] = useState('')
  const [birthOz, setBirthOz] = useState('')
  const [birthIn, setBirthIn] = useState('')
  const [birthBusy, setBirthBusy] = useState(false)
  const [bottleAmount, setBottleAmount] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // Every log button stamps "now" by default. This lets a missed
  // feeding/diaper/nursing/sleep entry be logged with its real time
  // instead -- it applies to the next single save only, then clears
  // itself, so it can never silently backdate something later.
  const [logAt, setLogAt] = useState<string | null>(null)
  const [showTimeEditor, setShowTimeEditor] = useState(false)
  const [timeInput, setTimeInput] = useState('')
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Drives the stopwatches and the relative labels. The wall screen is
  // always on, so this is the only thing keeping it honest.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
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

  // What the server last returned. Offline a read fails (after a few
  // seconds of retries) and comes back empty; painting that would wipe
  // Today, hide a running timer and offer to start a second session. A
  // failed read keeps the previous good rows instead, and a slow read
  // never lands over a newer one.
  const serverRows = useRef<ServerRows>(NO_ROWS)
  const latestRead = useRef(0)

  // Anything still queued is folded in and marked, so a tap made with
  // no signal is visible rather than apparently lost.
  const show = useCallback(
    (rows: ServerRows, queued: PendingWrite[]) => {
      const mFeedings = mergePending(rows.feedings, 'feedings', queued)
      const mDiapers = mergePending(rows.diapers, 'diaper_changes', queued)
      const mNursing = mergePending(rows.nursing, 'nursing_sessions', queued)
      const mSleep = mergePending(rows.sleep, 'sleep_sessions', queued)

      setFeedings(sortDesc(mFeedings, 'fed_at'))
      setDiapers(sortDesc(mDiapers, 'changed_at'))
      setNursing(sortDesc(mNursing, 'started_at'))
      setSleep(sortDesc(mSleep, 'started_at'))
      setAppt(rows.appt)
      setToday(
        buildActivity(mFeedings, mNursing, mDiapers, mSleep, startOfHouseholdDay(), unit, lang),
      )
    },
    [unit, lang],
  )

  const refresh = useCallback(
    async (babyId: string) => {
      const read = ++latestRead.current

      // The queue is local and answers at once: a session just started
      // offline shows as running (Stop, not Left/Right) right away, not
      // after the server read gives up. Only when something is queued: right
      // after a flush the queue is empty but the last server rows predate
      // it, so repainting them would briefly drop what was just sent.
      const queuedNow = await pendingWrites()
      if (read !== latestRead.current) return
      if (queuedNow.length > 0) show(serverRows.current, queuedNow)

      const [f, d, n, s, a, queued] = await Promise.all([
        recentFeedings(babyId),
        recentDiapers(babyId),
        recentNursing(babyId),
        recentSleep(babyId),
        nextAppointment(babyId),
        pendingWrites(),
      ])
      if (read !== latestRead.current) return

      const { rows, error } = keepLastGood(serverRows.current, {
        feedings: f,
        diapers: d,
        nursing: n,
        sleep: s,
        appt: a,
      })
      serverRows.current = rows

      // Offline reads fail; that is expected and the sync bar already
      // says so, so don't also shout an error over the top of it.
      if (error && navigator.onLine) setErr(t('dash.couldNotLoad', { error }))

      show(rows, queued)
    },
    [show, t],
  )

  const { online, pending, syncing, syncError, reloadPending } = useSync(() => {
    if (baby) refresh(baby.id)
  })

  useEffect(() => {
    if (baby) refresh(baby.id)
  }, [baby, refresh])

  // Every write reports its failure. A log entry that looks saved and
  // isn't is the worst thing this app can do.
  async function run(label: string, fn: () => Promise<{ error: string | null; queued?: boolean }>) {
    if (!baby || busy) return
    setBusy(true)
    setErr(null)
    const { error, queued } = await fn()
    if (error) {
      setErr(t('dash.couldNotSaveLabel', { label, error }))
    } else {
      const when = logAt ? t('dash.forTime', { time: clockTime(logAt, lang) }) : ''
      confirm(t(queued ? 'dash.queuedLabel' : 'dash.loggedLabel', { label, when }))
      // The time override was used by this save; clear it now so it can't
      // backdate the next one.
      setLogAt(null)
      // A queued write is already on screen after refresh's quick repaint
      // from the queue, so the buttons needn't wait for the slow (offline)
      // server read. A write that reached the server only shows once that
      // read lands: until then the page would still offer Left/Right, and
      // a second tap would open a second session. Keep busy until it does.
      if (queued) refresh(baby.id)
      else await refresh(baby.id)
      await reloadPending()
    }
    setBusy(false)
  }

  const activeNursing = nursing.find((n) => !n.ended_at) ?? null
  const lastNursing = nursing.find((n) => n.ended_at) ?? null
  const activeSleep = sleep.find((s) => !s.ended_at) ?? null
  const lastSleep = sleep.find((s) => s.ended_at) ?? null
  const lastFeeding = feedings[0] ?? null
  const lastDiaper = diapers[0] ?? null
  const feedingPrediction = predictNextFeeding(feedings, nursing)
  const napPrediction = predictNextNap(sleep)

  async function onBirth(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || birthBusy) return
    setBirthBusy(true)
    setErr(null)

    const { error } = await recordBirth(baby.id, birthDate)
    if (error) {
      setErr(t('common.couldNotSave', { error }))
      setBirthBusy(false)
      return
    }

    const lb = birthLb.trim() === '' ? null : Number(birthLb)
    const oz = birthOz.trim() === '' ? null : Number(birthOz)
    const inch = birthIn.trim() === '' ? null : Number(birthIn)
    if (lb !== null || oz !== null || inch !== null) {
      await addGrowth(baby.id, userId, {
        measured_at: birthDate,
        weight_kg:
          lb !== null || oz !== null ? Number(lbOzToKg(lb ?? 0, oz ?? 0).toFixed(3)) : null,
        height_cm: inch !== null ? Number((inch * 2.54).toFixed(1)) : null,
        notes: t('dash.birthWeightNote'),
      })
    }

    await refreshBaby()
    setBirthBusy(false)
  }

  function onBottle() {
    const raw = bottleAmount.trim()
    const amount = raw === '' ? null : Number(raw)
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
      setErr(t('dash.bottleNotNumber', { unit }))
      return
    }
    const ml = amount === null ? null : unitToMl(amount, unit)
    run(t('dash.label.bottle'), async () => {
      const res = await logFeeding(baby!.id, userId, 'bottle', ml, logAt ?? undefined)
      if (!res.error) setBottleAmount('')
      return res
    })
  }

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
        <NoBaby />
      </Page>
    )

  if (!baby.birth_date) {
    return (
      <Page>
        <Nav babyId={baby.id} />
        <p className="eyebrow">{longDate(now, lang)}</p>
        <h1 className="name">{t('dash.expecting', { name: baby.name })}</h1>
        {err && <Banner kind="error">{err}</Banner>}
        <Card>
          <Label>{t('dash.notBornYet')}</Label>
          <p className="meta">{t('dash.notBornNote')}</p>
          <form onSubmit={onBirth}>
            <div className="stack">
              <div>
                <label className="label" htmlFor="birth-date">
                  {t('dash.birthDate')}
                </label>
                <input
                  id="birth-date"
                  className="input"
                  type="date"
                  value={birthDate}
                  onChange={(e) => setBirthDate(e.target.value)}
                  max={householdToday()}
                  required
                />
              </div>
              <div className="row">
                <input
                  className="input"
                  value={birthLb}
                  onChange={(e) => setBirthLb(e.target.value)}
                  inputMode="decimal"
                  placeholder={t('dash.lbOptional')}
                  aria-label={t('dash.birthWeightLb')}
                />
                <input
                  className="input"
                  value={birthOz}
                  onChange={(e) => setBirthOz(e.target.value)}
                  inputMode="decimal"
                  placeholder="oz"
                  aria-label={t('dash.birthWeightOz')}
                />
                <input
                  className="input"
                  value={birthIn}
                  onChange={(e) => setBirthIn(e.target.value)}
                  inputMode="decimal"
                  placeholder={t('dash.inOptional')}
                  aria-label={t('dash.birthHeightIn')}
                />
              </div>
            </div>
            <div className="row-tight">
              <Btn type="submit" disabled={birthBusy}>
                {birthBusy ? t('common.saving') : t('dash.shesHere')}
              </Btn>
            </div>
          </form>
        </Card>
      </Page>
    )
  }

  const age = ageFrom(baby.birth_date, new Date(now), lang)
  const suggested: Side | null = lastNursing
    ? lastNursing.side === 'left'
      ? 'right'
      : 'left'
    : null

  return (
    <Page>
      <Nav babyId={baby.id} />

      <p className="eyebrow">{longDate(now, lang)}</p>
      <h1 className="name">{baby.name}</h1>
      <p className="age">{age ?? ' '}</p>

      <SyncBar online={online} pending={pending} syncing={syncing} />
      {syncError && <Banner kind="error">{t('common.couldNotSync', { error: syncError })}</Banner>}
      {err && <Banner kind="error">{err}</Banner>}
      {flash && !err && <Banner kind="ok">{flash}</Banner>}

      {logAt && !showTimeEditor && (
        <Banner kind="warn">
          {t('dash.backdating', { time: clockTime(logAt, lang) })}{' '}
          <button type="button" className="linkish" onClick={() => setLogAt(null)}>
            {t('dash.resetToNow')}
          </button>
        </Banner>
      )}

      <div className="row-tight row-wrap log-time">
        {!showTimeEditor ? (
          <Btn
            variant="quiet"
            onClick={() => {
              setTimeInput(toHouseholdInputValue(logAt ? new Date(logAt) : new Date(now)))
              setShowTimeEditor(true)
            }}
          >
            {logAt ? t('dash.changeTime') : t('dash.logMissed')}
          </Btn>
        ) : (
          <>
            <input
              type="datetime-local"
              className="input"
              value={timeInput}
              onChange={(e) => setTimeInput(e.target.value)}
              max={toHouseholdInputValue(new Date(now))}
              aria-label={t('dash.timeActually')}
            />
            <Btn
              disabled={!timeInput}
              onClick={() => {
                setLogAt(fromHouseholdInputValue(timeInput))
                setShowTimeEditor(false)
              }}
            >
              {t('dash.useThisTime')}
            </Btn>
            <Btn variant="quiet" onClick={() => setShowTimeEditor(false)}>
              {t('common.cancel')}
            </Btn>
          </>
        )}
      </div>

      <Grid>
        {/* ---------------- Breastfeeding ---------------- */}
        <Card live={!!activeNursing}>
          <Label>{t('dash.breastfeeding')}</Label>
          {activeNursing ? (
            <>
              <div className="stopwatch">
                <span className="clock">{elapsed(activeNursing.started_at, now)}</span>
                <span className="side">
                  {t('dash.sideActive', { side: t(`side.${activeNursing.side}`) })}
                </span>
              </div>
              <div className="row-tight">
                <Btn
                  variant="live"
                  disabled={busy}
                  onClick={() =>
                    run(t('dash.label.nursingEnd'), () =>
                      endNursing(activeNursing.id, logAt ?? undefined),
                    )
                  }
                >
                  {t('dash.stopNursing')}
                </Btn>
              </div>
            </>
          ) : (
            <>
              <div className="value">
                {lastNursing
                  ? `${timeAgo(lastNursing.ended_at, now, lang)} · ${t(`side.${lastNursing.side}`)} · ${durationBetween(lastNursing.started_at, lastNursing.ended_at!, lang)}`
                  : t('dash.noSessions')}
              </div>
              {suggested && (
                <div className="meta">{t('dash.startOn', { side: t(`side.${suggested}`) })}</div>
              )}
              <div className="row-tight">
                <Btn
                  disabled={busy}
                  variant={suggested === 'left' ? 'action' : 'quiet'}
                  onClick={() =>
                    run(t('dash.label.nursingLeft'), () =>
                      startNursing(baby.id, userId, 'left', logAt ?? undefined),
                    )
                  }
                >
                  {t('sideButton.left')}
                </Btn>
                <Btn
                  disabled={busy}
                  variant={suggested === 'right' ? 'action' : 'quiet'}
                  onClick={() =>
                    run(t('dash.label.nursingRight'), () =>
                      startNursing(baby.id, userId, 'right', logAt ?? undefined),
                    )
                  }
                >
                  {t('sideButton.right')}
                </Btn>
              </div>
            </>
          )}
        </Card>

        {/* ---------------- Feeding ---------------- */}
        <Card>
          <Label>{t('dash.lastFeeding')}</Label>
          <div className="value">
            {lastFeeding
              ? `${clockTime(lastFeeding.fed_at, lang)} · ${t(`feedingType.${lastFeeding.feeding_type}`)}${lastFeeding.amount_ml ? ` · ${formatVolume(lastFeeding.amount_ml, unit)}` : ''}`
              : '—'}
          </div>
          {lastFeeding && <div className="meta">{timeAgo(lastFeeding.fed_at, now, lang)}</div>}
          {lastFeeding?.pending && <div className="pending-tag">{t('common.notSyncedYet')}</div>}
          {feedingPrediction.dueAt && (
            <div className="meta">
              {t('dash.nextFeeding', {
                time: clockTime(feedingPrediction.dueAt, lang),
                due: dueRelative(feedingPrediction.dueAt, now, lang) ?? '',
              })}
            </div>
          )}
          <div className="row-tight">
            <input
              className="input narrow"
              value={bottleAmount}
              onChange={(e) => setBottleAmount(e.target.value)}
              inputMode="decimal"
              placeholder={unit}
              aria-label={t('dash.bottleAmount', { unit })}
            />
            <Btn disabled={busy} onClick={onBottle}>
              {t('dash.bottle')}
            </Btn>
            <Btn
              variant="quiet"
              disabled={busy}
              onClick={() =>
                run(t('dash.label.solid'), () =>
                  logFeeding(baby.id, userId, 'solid', null, logAt ?? undefined),
                )
              }
            >
              {t('dash.solid')}
            </Btn>
          </div>
        </Card>

        {/* ---------------- Diapers ---------------- */}
        <Card>
          <Label>{t('dash.lastDiaper')}</Label>
          <div className="value">
            {lastDiaper
              ? `${clockTime(lastDiaper.changed_at, lang)} · ${t(`diaper.${lastDiaper.diaper_type}`)}`
              : '—'}
          </div>
          {lastDiaper && <div className="meta">{timeAgo(lastDiaper.changed_at, now, lang)}</div>}
          {lastDiaper?.pending && <div className="pending-tag">{t('common.notSyncedYet')}</div>}
          <div className="row-tight">
            {(['wet', 'dirty', 'both'] as DiaperType[]).map((kind) => (
              <Btn
                key={kind}
                disabled={busy}
                onClick={() =>
                  run(t('dash.label.diaper', { type: t(`diaper.${kind}`) }), () =>
                    logDiaper(baby.id, userId, kind, logAt ?? undefined),
                  )
                }
              >
                {t(`diaperButton.${kind}`)}
              </Btn>
            ))}
          </div>
        </Card>

        {/* ---------------- Sleep ---------------- */}
        <Card live={!!activeSleep}>
          <Label>{t('dash.sleep')}</Label>
          {activeSleep ? (
            <>
              <div className="stopwatch">
                <span className="clock">{elapsed(activeSleep.started_at, now)}</span>
                <span className="side">
                  {activeSleep.source === 'nuc_derived' ? t('dash.detected') : t('dash.asleep')}
                </span>
              </div>
              <div className="row-tight">
                <Btn
                  variant="live"
                  disabled={busy}
                  onClick={() =>
                    run(t('dash.label.sleepEnd'), () =>
                      endSleep(activeSleep.id, logAt ?? undefined),
                    )
                  }
                >
                  {t('dash.shesAwake')}
                </Btn>
              </div>
            </>
          ) : (
            <>
              <div className="value">
                {lastSleep
                  ? t('dash.lastSleep', {
                      duration: durationBetween(lastSleep.started_at, lastSleep.ended_at!, lang),
                      ago: timeAgo(lastSleep.ended_at, now, lang),
                    })
                  : t('dash.noSleep')}
              </div>
              {napPrediction.dueAt && (
                <div className="meta">
                  {t('dash.nextNap', {
                    time: clockTime(napPrediction.dueAt, lang),
                    due: dueRelative(napPrediction.dueAt, now, lang) ?? '',
                  })}
                </div>
              )}
              <div className="row-tight">
                <Btn
                  disabled={busy}
                  onClick={() =>
                    run(t('dash.label.sleepStart'), () =>
                      startSleep(baby.id, userId, logAt ?? undefined),
                    )
                  }
                >
                  {t('dash.startSleep')}
                </Btn>
              </div>
            </>
          )}
        </Card>

        {/* ---------------- Next appointment ---------------- */}
        <Card>
          <Label>{t('dash.nextAppointment')}</Label>
          {appt ? (
            <>
              <div className="value">{appt.title}</div>
              <div className="meta">
                {apptWhen(appt.scheduled_at, lang)}
                {appt.doctor_name ? ` · ${appt.doctor_name}` : ''}
              </div>
            </>
          ) : (
            <div className="empty">{t('dash.nothingScheduled')}</div>
          )}
          <div className="row-tight">
            <Link href="/appointments" className="linkish">
              {t('dash.allAppointments')}
            </Link>
          </div>
        </Card>

        {/* ---------------- Today ----------------
            Merged from this app's tables. Becomes one read of
            core.activity when the shared backend lands. */}
        <Card spanAll>
          <Label>{t('dash.today')}</Label>
          {today.length === 0 ? (
            <div className="empty">{t('dash.nothingToday')}</div>
          ) : (
            <div className="feed">
              {today.map((entry) => (
                <div className="feed-item" key={`${entry.kind}-${entry.at}`}>
                  <span className="feed-time">{clockTime(entry.at, lang)}</span>
                  <span className="feed-what">{entry.what}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Grid>
    </Page>
  )
}
