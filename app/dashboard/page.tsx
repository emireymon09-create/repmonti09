'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import {
  buildActivity, endNursing, endSleep, logDiaper, logFeeding, nextAppointment,
  recentDiapers, recentFeedings, recentNursing, recentSleep, startNursing, startSleep,
} from '@/lib/db'
import type {
  ActivityEntry, DiaperChange, DiaperType, DoctorAppointment, Feeding,
  NursingSession, Side, SleepSession,
} from '@/lib/types'
import {
  ageFrom, apptWhen, clockTime, durationBetween, elapsed, longDate,
  startOfHouseholdDay, timeAgo,
} from '@/lib/format'

export default function Dashboard() {
  const { baby, userId, loading } = useBaby()

  const [feedings, setFeedings] = useState<Feeding[]>([])
  const [diapers, setDiapers] = useState<DiaperChange[]>([])
  const [nursing, setNursing] = useState<NursingSession[]>([])
  const [sleep, setSleep] = useState<SleepSession[]>([])
  const [appt, setAppt] = useState<DoctorAppointment | null>(null)
  const [today, setToday] = useState<ActivityEntry[]>([])

  const [bottleMl, setBottleMl] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Drives the stopwatches and the relative labels. The wall screen is
  // always on, so this is the only thing keeping it honest.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  function confirm(message: string) {
    setFlash(message)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2500)
  }

  const refresh = useCallback(async (babyId: string) => {
    const [f, d, n, s, a] = await Promise.all([
      recentFeedings(babyId), recentDiapers(babyId),
      recentNursing(babyId), recentSleep(babyId), nextAppointment(babyId),
    ])

    const firstError = [f, d, n, s, a].find((r) => r.error)?.error
    if (firstError) setErr(`Couldn't load today — ${firstError}`)

    setFeedings(f.data)
    setDiapers(d.data)
    setNursing(n.data)
    setSleep(s.data)
    setAppt(a.data)
    setToday(buildActivity(f.data, n.data, d.data, s.data, startOfHouseholdDay()))
  }, [])

  useEffect(() => { if (baby) refresh(baby.id) }, [baby, refresh])

  // Every write reports its failure. A log entry that looks saved and
  // isn't is the worst thing this app can do.
  async function run(label: string, fn: () => Promise<{ error: string | null }>) {
    if (!baby || busy) return
    setBusy(true)
    setErr(null)
    const { error } = await fn()
    if (error) setErr(`Couldn't save ${label} — ${error}`)
    else { confirm(`${label} logged`); await refresh(baby.id) }
    setBusy(false)
  }

  const activeNursing = nursing.find((n) => !n.ended_at) ?? null
  const lastNursing = nursing.find((n) => n.ended_at) ?? null
  const activeSleep = sleep.find((s) => !s.ended_at) ?? null
  const lastSleep = sleep.find((s) => s.ended_at) ?? null
  const lastFeeding = feedings[0] ?? null
  const lastDiaper = diapers[0] ?? null

  function onBottle() {
    const raw = bottleMl.trim()
    const ml = raw === '' ? null : Number(raw)
    if (ml !== null && (!Number.isFinite(ml) || ml <= 0)) {
      setErr('Bottle amount has to be a number of ml.')
      return
    }
    run('Bottle', async () => {
      const res = await logFeeding(baby!.id, userId, 'bottle', ml)
      if (!res.error) setBottleMl('')
      return res
    })
  }

  if (loading) return <Page><p className="empty">Loading…</p></Page>
  if (!baby) return <Page><Nav /><NoBaby /></Page>

  const age = ageFrom(baby.birth_date, new Date(now))
  const suggested: Side | null = lastNursing
    ? (lastNursing.side === 'left' ? 'right' : 'left')
    : null

  return (
    <Page>
      <Nav />

      <p className="eyebrow">{longDate(now)}</p>
      <h1 className="name">{baby.name}</h1>
      <p className="age">{age ?? ' '}</p>

      {err && <Banner kind="error">{err}</Banner>}
      {flash && !err && <Banner kind="ok">{flash}</Banner>}

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
                <Btn variant="live" disabled={busy}
                  onClick={() => run('Nursing end', () => endNursing(activeNursing.id))}>
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
                <Btn disabled={busy} variant={suggested === 'left' ? 'action' : 'quiet'}
                  onClick={() => run('Nursing (left)', () => startNursing(baby.id, userId, 'left'))}>
                  Left
                </Btn>
                <Btn disabled={busy} variant={suggested === 'right' ? 'action' : 'quiet'}
                  onClick={() => run('Nursing (right)', () => startNursing(baby.id, userId, 'right'))}>
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
              ? `${clockTime(lastFeeding.fed_at)} · ${lastFeeding.feeding_type}${lastFeeding.amount_ml ? ` · ${lastFeeding.amount_ml} ml` : ''}`
              : '—'}
          </div>
          {lastFeeding && <div className="meta">{timeAgo(lastFeeding.fed_at, now)}</div>}
          <div className="row-tight">
            <input
              className="input narrow"
              value={bottleMl}
              onChange={(e) => setBottleMl(e.target.value)}
              inputMode="numeric"
              placeholder="ml"
              aria-label="Bottle amount in ml"
            />
            <Btn disabled={busy} onClick={onBottle}>Bottle</Btn>
            <Btn variant="quiet" disabled={busy}
              onClick={() => run('Solid', () => logFeeding(baby.id, userId, 'solid', null))}>
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
          <div className="row-tight">
            {(['wet', 'dirty', 'both'] as DiaperType[]).map((kind) => (
              <Btn key={kind} disabled={busy}
                onClick={() => run(`Diaper (${kind})`, () => logDiaper(baby.id, userId, kind))}>
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
                <Btn variant="live" disabled={busy}
                  onClick={() => run('Sleep end', () => endSleep(activeSleep.id))}>
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
              <div className="row-tight">
                <Btn disabled={busy}
                  onClick={() => run('Sleep start', () => startSleep(baby.id, userId))}>
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
                {apptWhen(appt.scheduled_at)}{appt.doctor_name ? ` · ${appt.doctor_name}` : ''}
              </div>
            </>
          ) : (
            <div className="empty">Nothing scheduled</div>
          )}
          <div className="row-tight">
            <Link href="/appointments" className="linkish">All appointments →</Link>
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
