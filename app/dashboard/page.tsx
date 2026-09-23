'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import {
  addGrowth,
  endNursing,
  endSleep,
  logDiaper,
  logFeeding,
  keepLastGood,
  mergePending,
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
import { SeenNote, SyncBar, SyncErrorBanner } from '@/components/SyncStatus'
import { lastGood, seenKey, type LastGood, type SeenState } from '@/lib/lastSeen'
import { useVolumeUnit } from '@/lib/useVolumeUnit'
import { useT } from '@/lib/i18n/react'
import { lastFeedingEvent, type LastFeeding } from '@/lib/kpis'
import type {
  DiaperChange,
  DiaperType,
  Feeding,
  NursingSession,
  Side,
  SleepSession,
  WithPending,
} from '@/lib/types'
import { looksOffline, type PendingWrite } from '@/lib/queue'
import {
  ageFrom,
  clockTime,
  dueRelative,
  durationBetween,
  elapsed,
  formatVolume,
  householdToday,
  lbOzToKg,
  longDate,
  timeAgo,
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
}
const NO_ROWS: ServerRows = { feedings: [], diapers: [], nursing: [], sleep: [] }

/**
 * Only the keys this page reads. A copy saved on this device before the
 * appointment card left the dashboard still carries `appt`; it is
 * read as usual and the extra key is dropped here, so it is not saved again.
 */
function ownRows(rows: ServerRows): ServerRows {
  return {
    feedings: rows.feedings,
    diapers: rows.diapers,
    nursing: rows.nursing,
    sleep: rows.sleep,
  }
}

export default function Dashboard() {
  const { baby, userId, loading, refreshBaby, unreachable } = useBaby()
  const [unit] = useVolumeUnit()
  const { t, lang } = useT()

  const [feedings, setFeedings] = useState<WithPending<Feeding>[]>([])
  const [diapers, setDiapers] = useState<WithPending<DiaperChange>[]>([])
  const [nursing, setNursing] = useState<WithPending<NursingSession>[]>([])
  const [sleep, setSleep] = useState<WithPending<SleepSession>[]>([])

  const [birthDate, setBirthDate] = useState(() => householdToday())
  const [birthLb, setBirthLb] = useState('')
  const [birthOz, setBirthOz] = useState('')
  const [birthIn, setBirthIn] = useState('')
  const [birthBusy, setBirthBusy] = useState(false)
  const [bottleAmount, setBottleAmount] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // Every button here stamps "now". Logging with an earlier time lives on
  // each section's page ("Log a past one": /feeding, /diapers, /sleep).
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
  // never lands over a newer one. Those rows start from the copy this
  // device saved last time (lib/lastSeen.ts), so a reload with no
  // connection isn't a blank page either.
  const serverRows = useRef<LastGood<ServerRows> | null>(null)
  const latestRead = useRef(0)
  const [seen, setSeen] = useState<SeenState>({ kind: 'live' })

  // Anything still queued is folded in and marked, so a tap made with
  // no signal is visible rather than apparently lost.
  const show = useCallback((rows: ServerRows, queued: PendingWrite[]) => {
    const mFeedings = mergePending(rows.feedings, 'feedings', queued)
    const mDiapers = mergePending(rows.diapers, 'diaper_changes', queued)
    const mNursing = mergePending(rows.nursing, 'nursing_sessions', queued)
    const mSleep = mergePending(rows.sleep, 'sleep_sessions', queued)

    setFeedings(sortDesc(mFeedings, 'fed_at'))
    setDiapers(sortDesc(mDiapers, 'changed_at'))
    setNursing(sortDesc(mNursing, 'started_at'))
    setSleep(sortDesc(mSleep, 'started_at'))
  }, [])

  const refresh = useCallback(
    async (babyId: string) => {
      const read = ++latestRead.current
      const key = seenKey.page('dashboard', babyId)
      if (serverRows.current?.key !== key) serverRows.current = lastGood(key, NO_ROWS)
      const last = serverRows.current

      // The queue is local and answers at once: a session just started
      // offline shows as running (Stop, not Left/Right) right away, not
      // after the server read gives up. Only when something is queued, or
      // with no connection (the reads can only end up where they start):
      // right after a flush the queue is empty but the last server rows
      // predate it, so repainting them would briefly drop what was just sent.
      const queuedNow = await pendingWrites()
      if (read !== latestRead.current) return
      const offline = navigator.onLine === false
      if (queuedNow.length > 0 || offline) {
        show(ownRows(last.rows), queuedNow)
        setSeen(last.state(offline))
      }

      const [f, d, n, s, queued] = await Promise.all([
        recentFeedings(babyId),
        recentDiapers(babyId),
        recentNursing(babyId),
        recentSleep(babyId),
        pendingWrites(),
      ])
      if (read !== latestRead.current) return

      const { rows, error } = keepLastGood(ownRows(last.rows), {
        feedings: f,
        diapers: d,
        nursing: n,
        sleep: s,
      })
      setSeen(last.settle(rows, error))

      // A read that failed for lack of network is not an error to shout:
      // the saved-copy note (or the "nothing saved" state) already says it,
      // and the next good read clears this. Kept apart from `err`, which
      // belongs to the user's own writes.
      setLoadErr(error && !looksOffline(error) ? t('dash.couldNotLoad', { error }) : null)

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
      confirm(t(queued ? 'dash.queuedLabel' : 'dash.loggedLabel', { label, when: '' }))
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
  const lastFeed = lastFeedingEvent(feedings, nursing)
  const lastDiaper = diapers[0] ?? null
  // Offline, with no read yet and nothing saved on this device: "no
  // sessions yet" would be a guess, so the cards say nothing instead.
  const unknown = seen.kind === 'nothing'
  const feedingPrediction = predictNextFeeding(feedings, nursing)
  const napPrediction = predictNextNap(sleep)

  /** The Feeding card's line: time · kind (breast with its side) · amount or length. */
  function feedingLegend(last: LastFeeding): string {
    if (last.kind === 'nursing') {
      const n = last.row
      return `${clockTime(n.started_at, lang)} · ${t('legend.breast', { side: t(`side.${n.side}`) })} · ${durationBetween(n.started_at, n.ended_at, lang)}`
    }
    const f = last.row
    const amount = f.amount_ml ? ` · ${formatVolume(f.amount_ml, unit)}` : ''
    return `${clockTime(f.fed_at, lang)} · ${t(`feedingType.${f.feeding_type}`)}${amount}`
  }

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
      const res = await logFeeding(baby!.id, userId, 'bottle', ml)
      if (!res.error) setBottleAmount('')
      return res
    })
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

  if (!baby.birth_date) {
    return (
      <Page>
        <Nav />
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
      <Nav />

      {/* Nombre y edad en la misma línea, y la fecha de hoy arriba a la
          derecha. Antes iban apilados en tres renglones y la fecha arrancaba
          la pantalla: en la pared, lo primero que se lee tiene que ser de
          quién es la pantalla, no qué día es. En el teléfono la fecha baja
          sola debajo del nombre (flex-wrap), sin romper nada. */}
      <header className="page-head">
        <h1 className="name">
          {baby.name}
          {age && <span className="age">{age}</span>}
        </h1>
        <p className="eyebrow">{longDate(now, lang)}</p>
      </header>

      <SyncBar online={online} pending={pending} syncing={syncing} />
      <SeenNote state={seen} />
      <SyncErrorBanner error={syncError} failed={syncFailed} onDiscard={discardFailed} />
      {loadErr && <Banner kind="error">{loadErr}</Banner>}
      {err && <Banner kind="error">{err}</Banner>}
      {flash && !err && <Banner kind="ok">{flash}</Banner>}

      {/* `even`: las tres tarjetas miden lo mismo aunque una tenga cronómetro
          y otra una sola línea. No es un alto fijo a ojo — es el grid el que
          las estira a la más alta, con los mismos tokens de padding. */}
      <Grid even>
        {/* ---------------- Feeding: nursing, bottle, solids ---------------- */}
        <Card
          live={!!activeNursing}
          even
          quickLink={{
            href: '/feeding',
            label: t('dash.detailsFor', { section: t('section.feeding') }),
          }}
        >
          <Label>{t('section.feeding')}</Label>
          {activeNursing && (
            <>
              <div className="stopwatch">
                <span className="clock">{elapsed(activeNursing.started_at, now)}</span>
                <span className="side">
                  {t('dash.sideActive', { side: t(`side.${activeNursing.side}`) })}
                </span>
              </div>
              {activeNursing.pending && (
                <div className="pending-tag">{t('common.notSyncedYet')}</div>
              )}
              <div className="row-tight">
                <Btn
                  variant="live"
                  disabled={busy}
                  onClick={() =>
                    run(t('dash.label.nursingEnd'), () => endNursing(activeNursing.id))
                  }
                >
                  {t('dash.stopNursing')}
                </Btn>
              </div>
            </>
          )}
          <div className={activeNursing ? 'meta' : 'value'}>
            {lastFeed ? feedingLegend(lastFeed) : unknown ? '—' : t('dash.noFeedings')}
          </div>
          {lastFeed && !activeNursing && (
            <div className="meta">{timeAgo(lastFeed.at, now, lang)}</div>
          )}
          {lastFeed?.row.pending && <div className="pending-tag">{t('common.notSyncedYet')}</div>}
          {!activeNursing && feedingPrediction.dueAt && (
            <div className="meta">
              {t('dash.nextFeeding', {
                time: clockTime(feedingPrediction.dueAt, lang),
                due: dueRelative(feedingPrediction.dueAt, now, lang) ?? '',
              })}
            </div>
          )}
          {!activeNursing && (
            <>
              {suggested && (
                <div className="meta">{t('dash.startOn', { side: t(`side.${suggested}`) })}</div>
              )}
              <div className="row-tight">
                <Btn
                  disabled={busy}
                  variant={suggested === 'left' ? 'action' : 'quiet'}
                  onClick={() =>
                    run(t('dash.label.nursingLeft'), () => startNursing(baby.id, userId, 'left'))
                  }
                >
                  {t('sideButton.left')}
                </Btn>
                <Btn
                  disabled={busy}
                  variant={suggested === 'right' ? 'action' : 'quiet'}
                  onClick={() =>
                    run(t('dash.label.nursingRight'), () => startNursing(baby.id, userId, 'right'))
                  }
                >
                  {t('sideButton.right')}
                </Btn>
              </div>
            </>
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
                run(t('dash.label.solid'), () => logFeeding(baby.id, userId, 'solid', null))
              }
            >
              {t('dash.solid')}
            </Btn>
          </div>
        </Card>

        {/* ---------------- Diaper ---------------- */}
        <Card
          even
          quickLink={{
            href: '/diapers',
            label: t('dash.detailsFor', { section: t('section.diaper') }),
          }}
        >
          <Label>{t('section.diaper')}</Label>
          <div className="value">
            {lastDiaper
              ? `${clockTime(lastDiaper.changed_at, lang)} · ${t(`diaper.${lastDiaper.diaper_type}`)}`
              : unknown
                ? '—'
                : t('dash.noDiapers')}
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
                    logDiaper(baby.id, userId, kind),
                  )
                }
              >
                {t(`diaperButton.${kind}`)}
              </Btn>
            ))}
          </div>
        </Card>

        {/* ---------------- Sleep ---------------- */}
        <Card
          live={!!activeSleep}
          even
          quickLink={{
            href: '/sleep',
            label: t('dash.detailsFor', { section: t('section.sleep') }),
          }}
        >
          <Label>{t('section.sleep')}</Label>
          {activeSleep ? (
            <>
              <div className="stopwatch">
                <span className="clock">{elapsed(activeSleep.started_at, now)}</span>
                <span className="side">
                  {activeSleep.source === 'nuc_derived' ? t('dash.detected') : t('dash.asleep')}
                </span>
              </div>
              {activeSleep.pending && <div className="pending-tag">{t('common.notSyncedYet')}</div>}
              <div className="row-tight">
                <Btn
                  variant="live"
                  disabled={busy}
                  onClick={() => run(t('dash.label.sleepEnd'), () => endSleep(activeSleep.id))}
                >
                  {t('dash.shesAwake')}
                </Btn>
              </div>
            </>
          ) : null}
          {/* The last finished sleep: when she woke · how long she slept. */}
          <div className={activeSleep ? 'meta' : 'value'}>
            {lastSleep
              ? `${clockTime(lastSleep.ended_at, lang)} · ${durationBetween(lastSleep.started_at, lastSleep.ended_at!, lang)}`
              : unknown
                ? '—'
                : t('dash.noSleep')}
          </div>
          {lastSleep && !activeSleep && (
            <div className="meta">{timeAgo(lastSleep.ended_at, now, lang)}</div>
          )}
          {lastSleep?.pending && <div className="pending-tag">{t('common.notSyncedYet')}</div>}
          {!activeSleep && (
            <>
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
                  onClick={() => run(t('dash.label.sleepStart'), () => startSleep(baby.id, userId))}
                >
                  {t('dash.startSleep')}
                </Btn>
              </div>
            </>
          )}
        </Card>
      </Grid>
    </Page>
  )
}
