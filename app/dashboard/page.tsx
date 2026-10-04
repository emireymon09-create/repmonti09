'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, EmptyState, Grid, Label, Nav, Page } from '@/components/ui'
import {
  addGrowth,
  endNursing,
  endSleep,
  logDiaper,
  keepLastGood,
  mergePending,
  pendingWrites,
  familySettings,
  lastBottleFeeding,
  listAppointments,
  listContainers,
  listDrawdowns,
  logBottleFeed,
  milkErrorText,
  recentDiapers,
  recentFeedings,
  recentNursing,
  recentSleep,
  recordBirth,
  sessionById,
  startNursing,
  startSleep,
  updateNursing,
  updateSleep,
} from '@/lib/db'
import { useSync } from '@/lib/useSync'
import { SeenNote, SyncBar, SyncErrorBanner } from '@/components/SyncStatus'
import { lastGood, seenKey, type LastGood, type SeenState } from '@/lib/lastSeen'
import { BottleBuilder, sameAsPlan, type BottleValue } from '@/components/BottleBuilder'
import {
  applyPendingInventory,
  stashMl,
  suggestPlan,
  suggestedTotalMl,
  usableContainers,
  type BottlePlan,
} from '@/lib/milk'
import { useT } from '@/lib/i18n/react'
import {
  lastFeedingEvent,
  shiftStart,
  MAX_SHIFT_BACK_MS,
  MAX_SHIFT_MINUTES,
  type LastFeeding,
} from '@/lib/kpis'
import {
  DEFAULT_FAMILY_SETTINGS,
  dueFrom,
  lastFeedingEnd,
  lastNapEnd,
  minutesUntil,
  nextAppointment,
  type FamilySettings,
} from '@/lib/schedule'
import type {
  DiaperChange,
  DiaperType,
  DoctorAppointment,
  Feeding,
  MilkContainer,
  MilkDrawdown,
  NursingSession,
  Side,
  SleepSession,
  WithPending,
} from '@/lib/types'
import { looksOffline, type PendingWrite } from '@/lib/queue'
import {
  ageFrom,
  apptWhen,
  clockTime,
  DISPLAY_UNIT,
  formatMilkOz,
  dueRelative,
  durationBetween,
  elapsed,
  formatVolume,
  householdToday,
  lbOzToKg,
  longDate,
  timeAgo,
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
  /**
   * Los turnos médicos VUELVEN al dashboard el 24 sep 2026, en una tarjeta
   * propia debajo de las tres, y solo si hay uno dentro de las próximas 36
   * horas. Habían salido el 22 sep, cuando Today se redujo a tres tarjetas.
   */
  appt: DoctorAppointment[]
  /**
   * El inventario de leche (0013): lo que hay, para la sugerencia del
   * biberón, y la última toma de biberón — que puede no estar entre las
   * pocas más nuevas — de la que sale cuánto sugerir.
   */
  containers: MilkContainer[]
  drawdowns: MilkDrawdown[]
  lastBottle: Feeding[]
}
const NO_ROWS: ServerRows = {
  feedings: [],
  diapers: [],
  nursing: [],
  sleep: [],
  appt: [],
  containers: [],
  drawdowns: [],
  lastBottle: [],
}

/**
 * Only the keys this page reads. A copy saved on this device by an older
 * version can carry keys this one doesn't know: they are read as usual and
 * dropped here, so they are not saved again.
 */
function ownRows(rows: ServerRows): ServerRows {
  return {
    feedings: rows.feedings,
    diapers: rows.diapers,
    nursing: rows.nursing,
    sleep: rows.sleep,
    appt: rows.appt ?? [],
    containers: rows.containers ?? [],
    drawdowns: rows.drawdowns ?? [],
    lastBottle: rows.lastBottle ?? [],
  }
}

export default function Dashboard() {
  const { baby, userId, loading, refreshBaby, unreachable } = useBaby()
  const { t, lang } = useT()

  const [feedings, setFeedings] = useState<WithPending<Feeding>[]>([])
  const [diapers, setDiapers] = useState<WithPending<DiaperChange>[]>([])
  const [nursing, setNursing] = useState<WithPending<NursingSession>[]>([])
  const [sleep, setSleep] = useState<WithPending<SleepSession>[]>([])
  const [appointments, setAppointments] = useState<DoctorAppointment[]>([])
  const [containers, setContainers] = useState<WithPending<MilkContainer>[]>([])
  const [lastBottle, setLastBottle] = useState<Feeding[]>([])
  // Los umbrales de la familia (0012). Hasta que la lectura vuelva valen los
  // defaults, que son los mismos números que el DEFAULT de la columna: así la
  // cuenta regresiva funciona antes de que nadie entre a Settings.
  const [settings, setSettings] = useState<FamilySettings>(DEFAULT_FAMILY_SETTINGS)

  const [birthDate, setBirthDate] = useState(() => householdToday())
  const [birthLb, setBirthLb] = useState('')
  const [birthOz, setBirthOz] = useState('')
  const [birthIn, setBirthIn] = useState('')
  const [birthBusy, setBirthBusy] = useState(false)
  // The bottle panel (0013): opened by the bottle button, inline under the
  // three cards — this app has no overlay modals (design.md §4). Focus goes
  // into it on open and back to the button on close.
  const [bottleOpen, setBottleOpen] = useState(false)
  const [built, setBuilt] = useState<BottleValue | null>(null)
  const bottleBtn = useRef<HTMLButtonElement>(null)
  const panelHead = useRef<HTMLHeadingElement>(null)
  // "She started five minutes before I hit the button": minutes to move a
  // running session's start back. One field per card, so a number typed in
  // one is never applied to the other.
  const [nursingBack, setNursingBack] = useState('')
  const [sleepBack, setSleepBack] = useState('')
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
  // Has a first read settled? The four arrays start empty and `seen` starts
  // 'live', so without this a household with months of data is told "The log
  // starts here" for the whole read — measured at 1.5 s of it with 1500 ms of
  // latency, and CLAUDE.md §6 puts a stalled read at ~7 s. Saying nothing was
  // ever logged when we simply haven't looked is what §5.5 forbids.
  const [loaded, setLoaded] = useState(false)

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
    // Los turnos no se editan desde acá, así que no pasan por mergePending:
    // la tarjeta solo los lee.
    setAppointments(rows.appt ?? [])
    // The queue folded into what there is: a bottle given offline already
    // came out of its containers, a session pumped offline is already in.
    setContainers(
      applyPendingInventory(rows.containers ?? [], rows.drawdowns ?? [], queued).containers,
    )
    setLastBottle(rows.lastBottle ?? [])
  }, [])

  const refresh = useCallback(
    async (babyId: string) => {
      const read = ++latestRead.current
      const key = seenKey.page('dashboard', babyId)
      if (serverRows.current?.key !== key) {
        serverRows.current = lastGood(key, NO_ROWS)
        setLoaded(false)
      }
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

      const [f, d, n, s, a, c, dd, lb, queued] = await Promise.all([
        recentFeedings(babyId),
        recentDiapers(babyId),
        recentNursing(babyId),
        recentSleep(babyId),
        listAppointments(babyId),
        listContainers(babyId),
        listDrawdowns(babyId),
        lastBottleFeeding(babyId),
        pendingWrites(),
      ])
      if (read !== latestRead.current) return

      const { rows, error } = keepLastGood(ownRows(last.rows), {
        feedings: f,
        diapers: d,
        nursing: n,
        sleep: s,
        appt: a,
        containers: c,
        drawdowns: dd,
        lastBottle: { ...lb, data: lb.data ? [lb.data] : [] },
      })
      setSeen(last.settle(rows, error))

      // A read that failed for lack of network is not an error to shout:
      // the saved-copy note (or the "nothing saved" state) already says it,
      // and the next good read clears this. Kept apart from `err`, which
      // belongs to the user's own writes.
      setLoadErr(error && !looksOffline(error) ? t('dash.couldNotLoad', { error }) : null)

      show(rows, queued)
      // Only here, and never in the quick repaint above: what makes the
      // empty state honest is that a read has answered, one way or another.
      setLoaded(true)
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

  // Los umbrales de la familia (0012). Lectura aparte de las cuatro de arriba
  // a propósito: no son filas de la bebé, no se editan desde acá y no pasan
  // por la cola offline (lib/db.ts lo explica). Si falla, quedan los defaults
  // y la cuenta regresiva sigue funcionando — no hay nada que mentir: el
  // número por defecto es el mismo que tiene la columna.
  useEffect(() => {
    const familyId = baby?.family_id
    if (!familyId) return
    let cancelled = false
    familySettings(familyId).then((res) => {
      if (!cancelled && res.data) setSettings(res.data)
    })
    return () => {
      cancelled = true
    }
  }, [baby?.family_id])

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
  // Nada registrado TODAVÍA: ni tomas, ni pecho, ni pañales, ni sueño. Las tres
  // tarjetas quedan cortas y de ahí hasta la barra de abajo no hay nada — 261px
  // medidos a 390×844. Es el mismo hueco que /growth y /appointments cerraron
  // el 23 sep 2026 con `.empty-fill`, salvo que Today nunca lo tuvo. Con una
  // sola fila cargada esto no se monta y el `:has()` no matchea, así que el
  // layout con datos no cambia en nada.
  //
  // `unknown` queda afuera a propósito: sin conexión y sin copia guardada no
  // sabemos que no hay nada, solo que no lo pudimos leer (§5.5). Y `loaded`
  // por el mismo motivo un paso antes: mientras la primera lectura no vuelve,
  // las cuatro listas están vacías porque nadie las llenó todavía.
  const nothingLogged =
    loaded &&
    !unknown &&
    feedings.length === 0 &&
    nursing.length === 0 &&
    diapers.length === 0 &&
    sleep.length === 0
  // La cuenta regresiva real (24 sep 2026). Reemplaza a predictNextFeeding /
  // predictNextNap, que promediaban los últimos seis intervalos: un promedio
  // se autocorregía solo tras un estirón, pero no se puede configurar ni
  // notificar sobre él ("llegó al promedio" es una estadística, no una
  // condición de aviso). Ahora el número lo pone el padre, es de la familia
  // entera (0012) y es el mismo que usa el aviso push.
  //
  // Y se mide desde el FIN del último evento, no desde su inicio: una toma de
  // 40 minutos no vence tres horas después de EMPEZAR. Ver lib/schedule.ts.
  const feedingPrediction = dueFrom(
    lastFeedingEnd(feedings, nursing),
    settings.feed_threshold_minutes,
    now,
  )
  const napPrediction = dueFrom(lastNapEnd(sleep), settings.nap_threshold_minutes, now)
  // Solo si cae dentro de las próximas 36 horas: más lejos no es información
  // de hoy, y Doctor ya la lista.
  const upcoming = nextAppointment(appointments, now)

  /** The Feeding card's line: time · kind (breast with its side) · amount or length. */
  function feedingLegend(last: LastFeeding): string {
    if (last.kind === 'nursing') {
      const n = last.row
      return `${clockTime(n.started_at, lang)} · ${t('legend.breast', { side: t(`side.${n.side}`) })} · ${durationBetween(n.started_at, n.ended_at, lang)}`
    }
    const f = last.row
    const amount = f.amount_ml ? ` · ${formatVolume(f.amount_ml, DISPLAY_UNIT)}` : ''
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

  // ------------------------------------------------------------ the bottle

  // How much to suggest: the last bottle's total (queued ones included), or
  // the 3 oz starting value when there never was one (lib/milk.ts).
  const suggestedMl = suggestedTotalMl([...feedings, ...lastBottle])
  const usable = usableContainers(containers, now)
  // The plan is recomputed every second (the clock ticks), but it only
  // CHANGES when the amount, the containers or an expiry do. Handing the
  // builder a new object each second would start its rows over under the
  // person's fingers, so the same plan object is kept while it is equal.
  const rawPlan = suggestPlan(suggestedMl, usable, now)
  const planSig = JSON.stringify(rawPlan)
  const planRef = useRef<{ sig: string; plan: BottlePlan } | null>(null)
  if (!planRef.current || planRef.current.sig !== planSig) {
    planRef.current = { sig: planSig, plan: rawPlan }
  }
  const plan = planRef.current.plan

  function planLine(p: BottlePlan): string {
    const parts = p.portions.map((x) => `${x.label} ${formatMilkOz(x.ml)}`)
    if (p.formulaMl > 0) parts.push(t('bottle.planFormula', { amount: formatMilkOz(p.formulaMl) }))
    return `${parts.join(' + ')} = ${formatMilkOz(p.totalMl)}`
  }

  function openBottle() {
    setErr(null)
    setBottleOpen(true)
    // After the panel is painted.
    setTimeout(() => panelHead.current?.focus(), 0)
  }

  function closeBottle() {
    setBottleOpen(false)
    setTimeout(() => bottleBtn.current?.focus(), 0)
  }

  function logBottle(value: {
    portions: { container_id: string; amount_ml: number }[]
    formulaMl: number
    containersPending: boolean
  }) {
    run(t('dash.label.bottle'), async () => {
      const res = await logBottleFeed(
        baby!.id,
        userId,
        {
          fed_at: new Date().toISOString(),
          notes: null,
          formula_ml: value.formulaMl,
          portions: value.portions,
        },
        { containersPending: value.containersPending },
      )
      if (!res.error) closeBottle()
      // The rejection in words: "M3 doesn't have that much milk left…"
      return res.error ? { ...res, error: milkErrorText(res.error, lang) } : res
    })
  }

  /** "Log as is": exactly the suggestion shown, one tap. */
  function logAsIs() {
    logBottle({
      portions: plan.portions.map((p) => ({ container_id: p.containerId, amount_ml: p.ml })),
      formulaMl: plan.formulaMl,
      containersPending: plan.portions.some(
        (p) => containers.find((c) => c.id === p.containerId)?.pending,
      ),
    })
  }

  /**
   * Move a running session's start back by the minutes typed. Writes for
   * real, through the same updateNursing/updateSleep the log's edit panel
   * uses, so it goes through the offline queue like everything else — and
   * it is cumulative: each apply shifts the start the row has NOW.
   *
   * "NOW" is the catch, and it is why this re-reads the row first. Nothing
   * on this screen refreshes by itself (CLAUDE.md §6), so the wall display
   * can be showing a session the other parent stopped from their phone an
   * hour ago. Writing `started_at` over a finished row doesn't correct it,
   * it stretches it: measured, a 10-minute feed ended up recorded as 70
   * while the screen said "Start moved back 60 min".
   *
   * Three cases deliberately skip the re-read, because there is nothing on
   * the server to read:
   *   - `pending`: the row is still an insert in the queue. A direct UPDATE
   *     would match zero rows and PostgREST calls that success, so the
   *     write goes through the queue instead (`queueOnly`).
   *   - the browser says it is offline: `write()` queues without asking
   *     anyone, and making the correction sit through a read that is going
   *     to fail would cost the ~7 s the reads take to give up (§6).
   *   - the read is attempted and can't reach the server: same rule, a
   *     missing answer never blocks a correction that used to work.
   */
  async function moveStartBack(
    kind: 'nursing' | 'sleep',
    id: string,
    startedAt: string,
    pending: boolean,
    typed: string,
    clear: () => void,
  ) {
    if (!baby || busy) return
    setErr(null)

    const minutes = typed.trim() === '' ? NaN : Number(typed)
    const problems = {
      max: String(MAX_SHIFT_MINUTES),
      hours: String(MAX_SHIFT_BACK_MS / 3_600_000),
    }
    const first = shiftStart(startedAt, minutes, Date.now())
    if (first.problem) {
      setErr(t(`offset.${first.problem}`, problems))
      return
    }

    setBusy(true)
    let at = first.at

    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    if (!pending && !offline) {
      const table = kind === 'nursing' ? 'nursing_sessions' : 'sleep_sessions'
      const { data: fresh, error: readErr } = await sessionById(table, id)
      if (!readErr) {
        if (!fresh || fresh.ended_at) {
          setErr(t(fresh ? 'offset.alreadyEnded' : 'offset.gone'))
          setBusy(false)
          return
        }
        // The row may also have moved since it was painted (the other tab
        // applied its own offset). Shift what it actually says, and put the
        // result back through the same limits.
        const again = shiftStart(fresh.started_at, minutes, Date.now())
        if (again.problem) {
          setErr(t(`offset.${again.problem}`, problems))
          setBusy(false)
          return
        }
        at = again.at
      }
    }

    const opts = pending ? { queueOnly: true } : undefined
    const { error, queued } =
      kind === 'nursing'
        ? await updateNursing(id, { started_at: at! }, opts)
        : await updateSleep(id, { started_at: at! }, opts)

    if (error) {
      setErr(t('common.couldNotSave', { error }))
    } else {
      clear()
      confirm(queued ? t('common.queued') : t('offset.moved', { minutes: String(minutes) }))
      // Same as `run`: a queued write is already on screen after refresh's
      // quick repaint from the queue, so don't make the card wait for the
      // slow (offline) server read.
      if (queued) refresh(baby.id)
      else await refresh(baby.id)
      await reloadPending()
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

      {/* El nombre con la edad DEBAJO, y la fecha de hoy arriba a la derecha.
          La fecha sigue sin arrancar la pantalla: en la pared, lo primero que
          se lee tiene que ser de quién es la pantalla, no qué día es. La edad
          volvió a su renglón el 23 sep 2026 — en la misma línea que el nombre
          se leía peor. En el teléfono la fecha baja sola (flex-wrap). */}
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
              {/* Mientras hay una toma corriendo, el lugar del campo de
                  cantidad + Biberón lo ocupa esto: la corrección del inicio.
                  No es un menú de opciones — es un campo abierto, cualquier
                  número de minutos, porque el atraso real nunca es una de
                  tres cifras elegidas de antemano. */}
              <p className="meta">{t('offset.hint')}</p>
              <div className="row-tight">
                <input
                  className="input narrow"
                  value={nursingBack}
                  onChange={(e) => setNursingBack(e.target.value)}
                  inputMode="decimal"
                  placeholder={t('offset.minutes')}
                  aria-label={t('offset.ariaNursing')}
                />
                <Btn
                  variant="quiet"
                  disabled={busy}
                  onClick={() =>
                    moveStartBack(
                      'nursing',
                      activeNursing.id,
                      activeNursing.started_at,
                      !!activeNursing.pending,
                      nursingBack,
                      () => setNursingBack(''),
                    )
                  }
                >
                  {t('offset.apply')}
                </Btn>
              </div>
            </>
          )}
          <div className={activeNursing ? 'meta' : 'value'}>
            {lastFeed ? feedingLegend(lastFeed) : unknown ? '—' : t('dash.noFeedings')}
          </div>
          {lastFeed && !activeNursing && (
            <div className="meta">{timeAgo(lastFeed.endedAt, now, lang)}</div>
          )}
          {lastFeed?.row.pending && <div className="pending-tag">{t('common.notSyncedYet')}</div>}
          {!activeNursing && feedingPrediction && (
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
          {/* El biberón (0013): una línea con cuánto dar y el botón de la
              mamila, que abre el panel de abajo. Se carga cuando NO hay una
              toma de pecho corriendo: ahí esta fila es la corrección del
              inicio. Sólidos salió de acá el 23 sep 2026. */}
          {!activeNursing && (
            <>
              <div className="meta">{t('dash.give', { amount: formatMilkOz(suggestedMl) })}</div>
              <div className="row-tight">
                <Btn
                  icon="milk"
                  ref={bottleBtn}
                  disabled={busy}
                  ariaExpanded={bottleOpen}
                  ariaControls="bottle-panel"
                  onClick={() => (bottleOpen ? closeBottle() : openBottle())}
                >
                  {t('dash.bottle')}
                </Btn>
              </div>
            </>
          )}
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
              {/* Esta tarjeta no tiene selector de tipo: no había nada que
                  esconder, así que la corrección del inicio se agrega y ya.
                  Mismo campo, misma validación, misma escritura real. */}
              <p className="meta">{t('offset.hint')}</p>
              <div className="row-tight">
                <input
                  className="input narrow"
                  value={sleepBack}
                  onChange={(e) => setSleepBack(e.target.value)}
                  inputMode="decimal"
                  placeholder={t('offset.minutes')}
                  aria-label={t('offset.ariaSleep')}
                />
                <Btn
                  variant="quiet"
                  disabled={busy}
                  onClick={() =>
                    moveStartBack(
                      'sleep',
                      activeSleep.id,
                      activeSleep.started_at,
                      !!activeSleep.pending,
                      sleepBack,
                      () => setSleepBack(''),
                    )
                  }
                >
                  {t('offset.apply')}
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
              {napPrediction && (
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

      {/* El panel del biberón (0013), inline y de ancho completo, debajo de
          las tres tarjetas: en la pared no estira la de Comida (el grid las
          iguala) y en el teléfono queda justo debajo del botón. */}
      {bottleOpen && !activeNursing && (
        <Card spanAll>
          <div
            id="bottle-panel"
            className="stack"
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeBottle()
            }}
          >
            <h2 className="label" tabIndex={-1} ref={panelHead}>
              {t('bottle.panelTitle')}
            </h2>
            <div className="value">{planLine(plan)}</div>
            <div className="meta">
              {t('bottle.stashLeft', { amount: formatMilkOz(stashMl(containers, now)) })}
            </div>
            {containers.some((c) => c.pending) && (
              <div className="pending-tag">{t('milk.stashPending')}</div>
            )}
            <div className="row-tight">
              <Btn disabled={busy} onClick={logAsIs}>
                {t('bottle.logAsIs')}
              </Btn>
            </div>
            <p className="meta">{t('bottle.changeHint')}</p>
            <BottleBuilder
              usable={usable}
              plan={plan}
              disabled={busy}
              onChange={setBuilt}
              idPrefix="dash-bottle"
            />
            <div className="row-tight row-wrap">
              <Btn
                variant="quiet"
                disabled={busy || !built || !!built.problem || sameAsPlan(built, plan)}
                onClick={() => built && logBottle(built)}
              >
                {t('bottle.logChanges')}
              </Btn>
              <Btn variant="quiet" disabled={busy} onClick={closeBottle}>
                {t('bottle.close')}
              </Btn>
            </div>
          </div>
        </Card>
      )}

      {/* La próxima cita médica, DEBAJO de las tres tarjetas y solo dentro de
          las 36 horas previas. Se agrega, no reemplaza nada.

          Sin borde de color a propósito (design.md §2, economía del color): el
          borde de color se gasta en un solo lugar, la sesión en curso
          (.card.is-live). Una cita de mañana no puede competir por la atención
          con una toma que está pasando ahora. */}
      {upcoming && (
        <Card spanAll>
          <Label>{t('appt.next')}</Label>
          <div className="appt-next">
            <span className="value">{upcoming.title}</span>
            <span className="meta appt-when">{apptWhen(upcoming.scheduled_at, lang)}</span>
          </div>
          <div className="meta">{untilText(upcoming, now, t)}</div>
          {upcoming.doctor_name && (
            <div className="meta">{t('appt.with', { doctor: upcoming.doctor_name })}</div>
          )}
          <div className="row-tight">
            <Link className="btn quiet" href="/appointments">
              {t('appt.open')}
            </Link>
          </div>
        </Card>
      )}

      {/* Ver `nothingLogged`: la pantalla termina en algo en vez de terminar
          en blanco. Las tarjetas dicen que no hay nada de LO SUYO; esto dice
          qué pasa cuando se toque un botón y adónde va a parar. */}
      {nothingLogged && (
        <div className="empty-fill">
          <EmptyState icon="today" title={t('dash.empty')} hint={t('dash.emptyHint')} />
        </div>
      )}
    </Page>
  )
}

/**
 * "en 3 horas" / "en 40 minutos". Por debajo de una hora se cuenta en minutos:
 * "en 0 horas" no es una respuesta, y a esa altura los minutos son justamente
 * lo que se quiere saber.
 */
function untilText(appt: DoctorAppointment, now: number, t: ReturnType<typeof useT>['t']): string {
  const minutes = minutesUntil(appt.scheduled_at, now)
  if (minutes < 60) return t('appt.inMinutes', { count: minutes })
  return t('appt.inHours', { count: Math.round(minutes / 60) })
}
