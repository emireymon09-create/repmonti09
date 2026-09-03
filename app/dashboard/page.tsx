'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabaseClient'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Label, Nav, Page, inputStyle, theme } from '@/components/ui'
import { ageFrom, clockTime, durationBetween, elapsed, timeAgo } from '@/lib/format'

type Feeding = { fed_at: string; feeding_type: string; amount_ml: number | null }
type Diaper = { changed_at: string; diaper_type: string }
type Nursing = { id: string; side: 'left' | 'right'; started_at: string; ended_at: string | null }
type Sleep = { id: string; started_at: string; ended_at: string | null; source: string }
type Appointment = { id: string; title: string; scheduled_at: string; doctor_name: string | null }

export default function Dashboard() {
  const supabase = createClient()
  const { baby, userId, loading } = useBaby()

  const [lastFeeding, setLastFeeding] = useState<Feeding | null>(null)
  const [lastDiaper, setLastDiaper] = useState<Diaper | null>(null)
  const [activeNursing, setActiveNursing] = useState<Nursing | null>(null)
  const [lastNursing, setLastNursing] = useState<Nursing | null>(null)
  const [activeSleep, setActiveSleep] = useState<Sleep | null>(null)
  const [lastSleep, setLastSleep] = useState<Sleep | null>(null)
  const [nextAppt, setNextAppt] = useState<Appointment | null>(null)

  const [bottleMl, setBottleMl] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Drives the live stopwatches and the "42m ago" labels.
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
    const [feed, diaper, nursingRows, sleepRows, appt] = await Promise.all([
      supabase.from('feedings').select('fed_at, feeding_type, amount_ml')
        .eq('baby_id', babyId).order('fed_at', { ascending: false }).limit(1),
      supabase.from('diaper_changes').select('changed_at, diaper_type')
        .eq('baby_id', babyId).order('changed_at', { ascending: false }).limit(1),
      // One query covers both the running session and the last finished
      // one — an open session always sorts first by started_at.
      supabase.from('nursing_sessions').select('id, side, started_at, ended_at')
        .eq('baby_id', babyId).order('started_at', { ascending: false }).limit(5),
      supabase.from('sleep_sessions').select('id, started_at, ended_at, source')
        .eq('baby_id', babyId).order('started_at', { ascending: false }).limit(5),
      supabase.from('doctor_appointments').select('id, title, scheduled_at, doctor_name')
        .eq('baby_id', babyId).eq('completed', false)
        .gte('scheduled_at', new Date().toISOString())
        .order('scheduled_at', { ascending: true }).limit(1),
    ])

    setLastFeeding((feed.data?.[0] as Feeding) ?? null)
    setLastDiaper((diaper.data?.[0] as Diaper) ?? null)

    const nursing = (nursingRows.data ?? []) as Nursing[]
    setActiveNursing(nursing.find((n) => !n.ended_at) ?? null)
    setLastNursing(nursing.find((n) => n.ended_at) ?? null)

    const sleeps = (sleepRows.data ?? []) as Sleep[]
    setActiveSleep(sleeps.find((s) => !s.ended_at) ?? null)
    setLastSleep(sleeps.find((s) => s.ended_at) ?? null)

    setNextAppt((appt.data?.[0] as Appointment) ?? null)
  }, [supabase])

  useEffect(() => { if (baby) refresh(baby.id) }, [baby, refresh])

  // Every write goes through here so a failure can never be silent —
  // at 3am an entry that looks logged but isn't is worse than an error.
  async function run(label: string, fn: () => Promise<{ error: { message: string } | null }>) {
    if (!baby || busy) return
    setBusy(true)
    setErr(null)
    const { error } = await fn()
    if (error) {
      setErr(`Couldn't save ${label} — ${error.message}`)
    } else {
      confirm(`${label} logged`)
      await refresh(baby.id)
    }
    setBusy(false)
  }

  function logFeeding(type: 'bottle' | 'solid') {
    const ml = type === 'bottle' && bottleMl.trim() !== '' ? Number(bottleMl) : null
    if (ml !== null && (!Number.isFinite(ml) || ml <= 0)) {
      setErr('Bottle amount has to be a number of ml.')
      return
    }
    run(type === 'bottle' ? 'Bottle' : 'Solid', async () => {
      const res = await supabase.from('feedings').insert({
        baby_id: baby!.id, feeding_type: type, amount_ml: ml, logged_by: userId,
      })
      if (!res.error) setBottleMl('')
      return res
    })
  }

  const logDiaper = (type: 'wet' | 'dirty' | 'both') =>
    run(`Diaper (${type})`, () => supabase.from('diaper_changes').insert({
      baby_id: baby!.id, diaper_type: type, logged_by: userId,
    }))

  const startNursing = (side: 'left' | 'right') =>
    run(`Nursing (${side})`, () => supabase.from('nursing_sessions').insert({
      baby_id: baby!.id, side, started_at: new Date().toISOString(), logged_by: userId,
    }))

  const stopNursing = () =>
    run('Nursing end', () => supabase.from('nursing_sessions')
      .update({ ended_at: new Date().toISOString() }).eq('id', activeNursing!.id))

  const startSleep = () =>
    run('Sleep start', () => supabase.from('sleep_sessions').insert({
      baby_id: baby!.id, started_at: new Date().toISOString(), source: 'manual', logged_by: userId,
    }))

  const stopSleep = () =>
    run('Sleep end', () => supabase.from('sleep_sessions')
      .update({ ended_at: new Date().toISOString() }).eq('id', activeSleep!.id))

  if (loading) return <Page><p style={{ color: theme.muted }}>Loading…</p></Page>
  if (!baby) return <Page><Nav /><NoBaby /></Page>

  const age = ageFrom(baby.birth_date, new Date(now))
  // Which side to offer first next time — the one that wasn't used last.
  const suggestedSide = lastNursing?.side === 'left' ? 'right' : lastNursing?.side === 'right' ? 'left' : null

  return (
    <Page>
      <Nav />

      <p style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: theme.accent, margin: 0 }}>
        {new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
      </p>
      <h1 style={{ fontSize: 30, margin: '4px 0 2px' }}>{baby.name}</h1>
      {age && <p style={{ color: theme.muted, fontSize: 14, margin: '0 0 18px' }}>{age}</p>}
      {!age && <div style={{ height: 18 }} />}

      {err && <Banner kind="error">{err}</Banner>}
      {flash && !err && <Banner kind="ok">{flash}</Banner>}

      {/* ---------------- Nursing ---------------- */}
      <Card style={activeNursing ? { borderColor: theme.live } : undefined}>
        <Label>Breastfeeding</Label>
        {activeNursing ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 32, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {elapsed(activeNursing.started_at, now)}
              </span>
              <span style={{ color: theme.live, fontWeight: 600, textTransform: 'capitalize' }}>
                {activeNursing.side} side
              </span>
            </div>
            <div style={{ display: 'flex', marginTop: 10 }}>
              <Btn variant="live" onClick={stopNursing} disabled={busy}>Stop nursing</Btn>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 17, fontWeight: 600 }}>
              {lastNursing
                ? `${timeAgo(lastNursing.ended_at, now)} · ${lastNursing.side} · ${durationBetween(lastNursing.started_at, lastNursing.ended_at!)}`
                : 'No sessions yet'}
            </div>
            {suggestedSide && (
              <div style={{ fontSize: 12, color: theme.muted, marginTop: 2 }}>
                Start on the {suggestedSide} next
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Btn onClick={() => startNursing('left')} disabled={busy}
                variant={suggestedSide === 'left' ? 'action' : 'quiet'}>Left</Btn>
              <Btn onClick={() => startNursing('right')} disabled={busy}
                variant={suggestedSide === 'right' ? 'action' : 'quiet'}>Right</Btn>
            </div>
          </>
        )}
      </Card>

      {/* ---------------- Bottle / solid ---------------- */}
      <Card>
        <Label>Last feeding</Label>
        <div style={{ fontSize: 17, fontWeight: 600 }}>
          {lastFeeding
            ? `${clockTime(lastFeeding.fed_at)} · ${lastFeeding.feeding_type}${lastFeeding.amount_ml ? ` · ${lastFeeding.amount_ml} ml` : ''}`
            : '—'}
        </div>
        {lastFeeding && (
          <div style={{ fontSize: 12, color: theme.muted, marginTop: 2 }}>{timeAgo(lastFeeding.fed_at, now)}</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input
            value={bottleMl}
            onChange={(e) => setBottleMl(e.target.value)}
            inputMode="numeric"
            placeholder="ml"
            aria-label="Bottle amount in ml"
            style={{ ...inputStyle, width: 76, flex: 'none', minHeight: 52, textAlign: 'center' }}
          />
          <Btn onClick={() => logFeeding('bottle')} disabled={busy}>Bottle</Btn>
          <Btn variant="quiet" onClick={() => logFeeding('solid')} disabled={busy}>Solid</Btn>
        </div>
      </Card>

      {/* ---------------- Diapers ---------------- */}
      <Card>
        <Label>Last diaper</Label>
        <div style={{ fontSize: 17, fontWeight: 600 }}>
          {lastDiaper ? `${clockTime(lastDiaper.changed_at)} · ${lastDiaper.diaper_type}` : '—'}
        </div>
        {lastDiaper && (
          <div style={{ fontSize: 12, color: theme.muted, marginTop: 2 }}>{timeAgo(lastDiaper.changed_at, now)}</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <Btn onClick={() => logDiaper('wet')} disabled={busy}>Wet</Btn>
          <Btn onClick={() => logDiaper('dirty')} disabled={busy}>Dirty</Btn>
          <Btn onClick={() => logDiaper('both')} disabled={busy}>Both</Btn>
        </div>
      </Card>

      {/* ---------------- Sleep ---------------- */}
      <Card style={activeSleep ? { borderColor: theme.live } : undefined}>
        <Label>Sleep</Label>
        {activeSleep ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 32, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {elapsed(activeSleep.started_at, now)}
              </span>
              <span style={{ color: theme.live, fontWeight: 600 }}>
                {activeSleep.source === 'nuc_derived' ? 'detected' : 'asleep'}
              </span>
            </div>
            <div style={{ display: 'flex', marginTop: 10 }}>
              <Btn variant="live" onClick={stopSleep} disabled={busy}>She&rsquo;s awake</Btn>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 17, fontWeight: 600 }}>
              {lastSleep
                ? `${durationBetween(lastSleep.started_at, lastSleep.ended_at!)} · woke ${timeAgo(lastSleep.ended_at, now)}`
                : 'No sleep logged yet'}
            </div>
            <div style={{ display: 'flex', marginTop: 10 }}>
              <Btn onClick={startSleep} disabled={busy}>Start sleep</Btn>
            </div>
          </>
        )}
      </Card>

      {/* ---------------- Next appointment ---------------- */}
      <Card>
        <Label>Next appointment</Label>
        {nextAppt ? (
          <>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{nextAppt.title}</div>
            <div style={{ fontSize: 13, color: theme.muted, marginTop: 2 }}>
              {new Date(nextAppt.scheduled_at).toLocaleString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })}
              {nextAppt.doctor_name ? ` · ${nextAppt.doctor_name}` : ''}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 15, color: theme.muted }}>Nothing scheduled</div>
        )}
        <div style={{ marginTop: 10 }}>
          <Link href="/appointments" style={{ color: theme.accent, fontSize: 14, fontWeight: 600, textDecoration: 'none' }}>
            All appointments →
          </Link>
        </div>
      </Card>
    </Page>
  )
}
