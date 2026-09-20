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

export default function Dashboard() {
  const { baby, userId, loading, refreshBaby } = useBaby()
  const [unit] = useVolumeUnit()

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

  const refresh = useCallback(
    async (babyId: string) => {
      const [f, d, n, s, a, queued] = await Promise.all([
        recentFeedings(babyId),
        recentDiapers(babyId),
        recentNursing(babyId),
        recentSleep(babyId),
        nextAppointment(babyId),
        pendingWrites(),
      ])

      // Offline reads fail; that is expected and the sync bar already
      // says so, so don't also shout an error over the top of it.
      const firstError = [f, d, n, s, a].find((r) => r.error)?.error
      if (firstError && navigator.onLine) setErr(`Couldn't load today — ${firstError}`)

      // Anything still queued is folded in and marked, so a tap made with
      // no signal is visible rather than apparently lost.
      const mFeedings = mergePending(f.data, 'feedings', queued)
      const mDiapers = mergePending(d.data, 'diaper_changes', queued)
      const mNursing = mergePending(n.data, 'nursing_sessions', queued)
      const mSleep = mergePending(s.data, 'sleep_sessions', queued)

      setFeedings(sortDesc(mFeedings, 'fed_at'))
      setDiapers(sortDesc(mDiapers, 'changed_at'))
      setNursing(sortDesc(mNursing, 'started_at'))
      setSleep(sortDesc(mSleep, 'started_at'))
      setAppt(a.data)
      setToday(buildActivity(mFeedings, mNursing, mDiapers, mSleep, startOfHouseholdDay(), unit))
    },
    [unit],
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
      setErr(`Couldn't save ${label} — ${error}`)
    } else {
      const when = logAt ? ` for ${clockTime(logAt)}` : ''
      confirm(
        queued ? `${label} saved on this device${when} — will sync` : `${label} logged${when}`,
      )
      await refresh(baby.id)
      await reloadPending()
      setLogAt(null)
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
      setErr(`Couldn't save — ${error}`)
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
        notes: 'Birth weight',
      })
    }

    await refreshBaby()
    setBirthBusy(false)
  }

  function onBottle() {
    const raw = bottleAmount.trim()
    const amount = raw === '' ? null : Number(raw)
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
      setErr(`Bottle amount has to be a number of ${unit}.`)
      return
    }
    const ml = amount === null ? null : unitToMl(amount, unit)
    run('Bottle', async () => {
      const res = await logFeeding(baby!.id, userId, 'bottle', ml, logAt ?? undefined)
      if (!res.error) setBottleAmount('')
      return res
    })
  }

  if (loading)
    return (
      <Page>
        <p className="empty">Loading…</p>
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
        <p className="eyebrow">{longDate(now)}</p>
        <h1 className="name">Expecting {baby.name}</h1>
        {err && <Banner kind="error">{err}</Banner>}
        <Card>
          <Label>Not born yet</Label>
          <p className="meta">
            Logging, the feeding clock, growth tracking — all of it turns on the moment you save her
            birth date below. Nothing before that is lost; it just starts counting from here.
          </p>
          <form onSubmit={onBirth}>
            <div className="stack">
              <div>
                <label className="label" htmlFor="birth-date">
                  Birth date
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
                  placeholder="lb (optional)"
                  aria-label="Birth weight, pounds"
                />
                <input
                  className="input"
                  value={birthOz}
                  onChange={(e) => setBirthOz(e.target.value)}
                  inputMode="decimal"
                  placeholder="oz"
                  aria-label="Birth weight, ounces"
                />
                <input
                  className="input"
                  value={birthIn}
                  onChange={(e) => setBirthIn(e.target.value)}
                  inputMode="decimal"
                  placeholder="in (optional)"
                  aria-label="Birth height, inches"
                />
              </div>
            </div>
            <div className="row-tight">
              <Btn type="submit" disabled={birthBusy}>
                {birthBusy ? 'Saving…' : 'She\u2019s here! \uD83C\uDF89'}
              </Btn>
            </div>
          </form>
        </Card>
      </Page>
    )
  }

  const age = ageFrom(baby.birth_date, new Date(now))
  const suggested: Side | null = lastNursing
    ? lastNursing.side === 'left'
      ? 'right'
      : 'left'
    : null

  return (
    <Page>
      <Nav babyId={baby.id} />

      <p className="eyebrow">{longDate(now)}</p>
      <h1 className="name">{baby.name}</h1>
      <p className="age">{age ?? ' '}</p>

      <SyncBar online={online} pending={pending} syncing={syncing} />
      {syncError && <Banner kind="error">Couldn&rsquo;t sync — {syncError}</Banner>}
      {err && <Banner kind="error">{err}</Banner>}
      {flash && !err && <Banner kind="ok">{flash}</Banner>}

      {logAt && !showTimeEditor && (
        <Banner kind="warn">
          Backdating to {clockTime(logAt)} — the next thing you log uses this time.{' '}
          <button type="button" className="linkish" onClick={() => setLogAt(null)}>
            Reset to now
          </button>
        </Banner>
      )}

      <div className="row-tight" style={{ flexWrap: 'wrap' }}>
        {!showTimeEditor ? (
          <Btn
            variant="quiet"
            onClick={() => {
              setTimeInput(toHouseholdInputValue(logAt ? new Date(logAt) : new Date(now)))
              setShowTimeEditor(true)
            }}
          >
            {logAt ? 'Change time…' : 'Log a missed session…'}
          </Btn>
        ) : (
          <>
            <input
              type="datetime-local"
              className="input"
              value={timeInput}
              onChange={(e) => setTimeInput(e.target.value)}
              max={toHouseholdInputValue(new Date(now))}
              aria-label="Time this actually happened"
            />
            <Btn
              disabled={!timeInput}
              onClick={() => {
                setLogAt(fromHouseholdInputValue(timeInput))
                setShowTimeEditor(false)
              }}
            >
              Use this time
            </Btn>
            <Btn variant="quiet" onClick={() => setShowTimeEditor(false)}>
              Cancel
            </Btn>
          </>
        )}
      </div>

      <Grid>
        {/* ---------------- Breastfeeding ---------------- */}
        <Card live={!!activeNursing}>
          <Label>Breastfeeding</Label>
          {activeNursing ? (
            <>
              <div className="stopwatch">
                <span className="clock">{elapsed(activeNursing.started_at, now)}</span>
                <span className="side">{activeNursing.side} side</span>
              </div>
              <div className="row-tight">
                <Btn
                  variant="live"
                  disabled={busy}
                  onClick={() =>
                    run('Nursing end', () => endNursing(activeNursing.id, logAt ?? undefined))
                  }
                >
                  Stop nursing
                </Btn>
              </div>
            </>
          ) : (
            <>
              <div className="value">
                {lastNursing
                  ? `${timeAgo(lastNursing.ended_at, now)} · ${lastNursing.side} · ${durationBetween(lastNursing.started_at, lastNursing.ended_at!)}`
                  : 'No sessions yet'}
              </div>
              {suggested && <div className="meta">Start on the {suggested} next</div>}
              <div className="row-tight">
                <Btn
                  disabled={busy}
                  variant={suggested === 'left' ? 'action' : 'quiet'}
                  onClick={() =>
                    run('Nursing (left)', () =>
                      startNursing(baby.id, userId, 'left', logAt ?? undefined),
                    )
                  }
                >
                  Left
                </Btn>
                <Btn
                  disabled={busy}
                  variant={suggested === 'right' ? 'action' : 'quiet'}
                  onClick={() =>
                    run('Nursing (right)', () =>
                      startNursing(baby.id, userId, 'right', logAt ?? undefined),
                    )
                  }
                >
                  Right
                </Btn>
              </div>
            </>
          )}
        </Card>

        {/* ---------------- Feeding ---------------- */}
        <Card>
          <Label>Last feeding</Label>
          <div className="value">
            {lastFeeding
              ? `${clockTime(lastFeeding.fed_at)} · ${lastFeeding.feeding_type}${lastFeeding.amount_ml ? ` · ${formatVolume(lastFeeding.amount_ml, unit)}` : ''}`
              : '—'}
          </div>
          {lastFeeding && <div className="meta">{timeAgo(lastFeeding.fed_at, now)}</div>}
          {lastFeeding?.pending && <div className="pending-tag">Not synced yet</div>}
          {feedingPrediction.dueAt && (
            <div className="meta">
              Next feeding {clockTime(feedingPrediction.dueAt)} ·{' '}
              {dueRelative(feedingPrediction.dueAt, now)}
            </div>
          )}
          <div className="row-tight">
            <input
              className="input narrow"
              value={bottleAmount}
              onChange={(e) => setBottleAmount(e.target.value)}
              inputMode="decimal"
              placeholder={unit}
              aria-label={`Bottle amount in ${unit}`}
            />
            <Btn disabled={busy} onClick={onBottle}>
              Bottle
            </Btn>
            <Btn
              variant="quiet"
              disabled={busy}
              onClick={() =>
                run('Solid', () => logFeeding(baby.id, userId, 'solid', null, logAt ?? undefined))
              }
            >
              Solid
            </Btn>
          </div>
        </Card>

        {/* ---------------- Diapers ---------------- */}
        <Card>
          <Label>Last diaper</Label>
          <div className="value">
            {lastDiaper ? `${clockTime(lastDiaper.changed_at)} · ${lastDiaper.diaper_type}` : '—'}
          </div>
          {lastDiaper && <div className="meta">{timeAgo(lastDiaper.changed_at, now)}</div>}
          {lastDiaper?.pending && <div className="pending-tag">Not synced yet</div>}
          <div className="row-tight">
            {(['wet', 'dirty', 'both'] as DiaperType[]).map((kind) => (
              <Btn
                key={kind}
                disabled={busy}
                onClick={() =>
                  run(`Diaper (${kind})`, () =>
                    logDiaper(baby.id, userId, kind, logAt ?? undefined),
                  )
                }
              >
                {kind[0].toUpperCase() + kind.slice(1)}
              </Btn>
            ))}
          </div>
        </Card>

        {/* ---------------- Sleep ---------------- */}
        <Card live={!!activeSleep}>
          <Label>Sleep</Label>
          {activeSleep ? (
            <>
              <div className="stopwatch">
                <span className="clock">{elapsed(activeSleep.started_at, now)}</span>
                <span className="side">
                  {activeSleep.source === 'nuc_derived' ? 'detected' : 'asleep'}
                </span>
              </div>
              <div className="row-tight">
                <Btn
                  variant="live"
                  disabled={busy}
                  onClick={() =>
                    run('Sleep end', () => endSleep(activeSleep.id, logAt ?? undefined))
                  }
                >
                  She&rsquo;s awake
                </Btn>
              </div>
            </>
          ) : (
            <>
              <div className="value">
                {lastSleep
                  ? `${durationBetween(lastSleep.started_at, lastSleep.ended_at!)} · woke ${timeAgo(lastSleep.ended_at, now)}`
                  : 'No sleep logged yet'}
              </div>
              {napPrediction.dueAt && (
                <div className="meta">
                  Next nap ~{clockTime(napPrediction.dueAt)} ·{' '}
                  {dueRelative(napPrediction.dueAt, now)}
                </div>
              )}
              <div className="row-tight">
                <Btn
                  disabled={busy}
                  onClick={() =>
                    run('Sleep start', () => startSleep(baby.id, userId, logAt ?? undefined))
                  }
                >
                  Start sleep
                </Btn>
              </div>
            </>
          )}
        </Card>

        {/* ---------------- Next appointment ---------------- */}
        <Card>
          <Label>Next appointment</Label>
          {appt ? (
            <>
              <div className="value">{appt.title}</div>
              <div className="meta">
                {apptWhen(appt.scheduled_at)}
                {appt.doctor_name ? ` · ${appt.doctor_name}` : ''}
              </div>
            </>
          ) : (
            <div className="empty">Nothing scheduled</div>
          )}
          <div className="row-tight">
            <Link href="/appointments" className="linkish">
              All appointments →
            </Link>
          </div>
        </Card>

        {/* ---------------- Today ----------------
            Merged from this app's tables. Becomes one read of
            core.activity when the shared backend lands. */}
        <Card spanAll>
          <Label>Today</Label>
          {today.length === 0 ? (
            <div className="empty">Nothing logged yet today.</div>
          ) : (
            <div className="feed">
              {today.map((entry) => (
                <div className="feed-item" key={`${entry.kind}-${entry.at}`}>
                  <span className="feed-time">{clockTime(entry.at)}</span>
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
