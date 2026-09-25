'use client'

/**
 * Statistics — el tablero de la semana de vida (24 sep 2026).
 *
 * Hasta hoy esta pantalla no dibujaba nada: un título y un estado vacío que lo
 * decía. Era un hueco conocido, anotado en CLAUDE.md §6 y medido en design.md
 * §5.14 (267,5 px de tinta a la barra). **Este pase lo cierra.**
 *
 * Qué muestra: una tarjeta por sección —comida, pañales, sueño, crecimiento—
 * con los KPIs de la semana elegida arriba y una gráfica de su comportamiento
 * abajo. La semana es la SEMANA DE VIDA (1, 2, 3… desde que nació), no la
 * semana de calendario ni la ventana `week` de lib/kpis.ts — ver
 * lib/lifeWeek.ts.
 *
 * Qué gráfica y por qué (no es decorado, cada una responde una pregunta):
 *   · comida, pañales, sueño → **barras por día**. Son cantidades discretas
 *     que se comparan entre sí ("¿el jueves durmió menos?"), y una barra por
 *     día es la forma más directa de compararlas.
 *   · crecimiento → **línea**. El peso es una magnitud continua y lo que
 *     importa es la pendiente; barras sugerirían que cada visita es
 *     independiente de la anterior.
 *
 * Como el resto de la app: si la lectura falla, no se dibuja un cero — se dice
 * que no se pudo leer (§5.5). Un cero inventado en una pantalla de estadísticas
 * es exactamente la clase de mentira que §5.4 no permite.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, EmptyState, Grid, Label, Nav, Page } from '@/components/ui'
import { NoBaby } from '@/components/NoBaby'
import { BarChart, LineChart, type ChartPoint } from '@/components/Chart'
import { WeekPicker } from '@/components/WeekPicker'
import { Banner } from '@/components/Banner'
import { SeenNote } from '@/components/SyncStatus'
import { lastGood, seenKey, type LastGood, type SeenState } from '@/lib/lastSeen'
import { useBaby } from '@/lib/useBaby'
import { looksOffline } from '@/lib/queue'
import { useT } from '@/lib/i18n/react'
import {
  diapersSince,
  feedingsSince,
  listGrowth,
  nursingSince,
  sleepSince,
  keepLastGood,
} from '@/lib/db'
import { diaperKpis, feedingKpis, overlapMs, sleepKpis, type KpiWindow } from '@/lib/kpis'
import {
  currentLifeWeek,
  lifeWeekRange,
  lifeWeekSinceIso,
  type LifeWeekRange,
} from '@/lib/lifeWeek'
import {
  DISPLAY_UNIT,
  formatDuration,
  formatVolume,
  kgToLbOz,
  measuredOn,
  mlToUnit,
  startOfHouseholdDay,
} from '@/lib/format'
import type {
  DiaperChange,
  Feeding,
  GrowthMeasurement,
  NursingSession,
  SleepSession,
} from '@/lib/types'

type Rows = {
  feedings: Feeding[]
  nursing: NursingSession[]
  diapers: DiaperChange[]
  sleep: SleepSession[]
  growth: GrowthMeasurement[]
}

const EMPTY: Rows = { feedings: [], nursing: [], diapers: [], sleep: [], growth: [] }

export default function StatisticsPage() {
  const { baby, loading, unreachable } = useBaby()
  const { t, lang } = useT()

  const [week, setWeek] = useState<number | null>(null)
  const [rows, setRows] = useState<Rows>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  // A-2 (auditoría del 24 sep 2026): esta pantalla está en el precache y en
  // lib/offlinePages.ts, así que se abre sin conexión — y dibujaba CEROS
  // cuando la lectura fallaba, con el banner de error al lado en vez de en su
  // lugar. Un cero inventado en una pantalla de estadísticas es justo lo que
  // §5.4 prohíbe. Ahora conserva la última copia buena por dispositivo, la
  // anuncia con SeenNote, y sin nada guardado muestra "—".
  const saved = useRef<LastGood<Rows> | null>(null)
  const [seen, setSeen] = useState<SeenState>({ kind: 'live' })

  const birthDate = baby?.birth_date ?? null
  const current = useMemo(
    () => (birthDate ? currentLifeWeek(birthDate, new Date()) : null),
    [birthDate],
  )
  // Se abre en la semana que corre, que es la que se mira el 95 % de las veces.
  const shownWeek = week ?? current
  const range: LifeWeekRange | null = useMemo(
    () => (birthDate && shownWeek ? lifeWeekRange(birthDate, shownWeek) : null),
    [birthDate, shownWeek],
  )

  const babyId = baby?.id
  const sinceIso = range ? lifeWeekSinceIso(range) : null

  const load = useCallback(async () => {
    if (!babyId || !sinceIso || !shownWeek) return
    setReading(true)
    // La copia guardada es POR SEMANA: los totales de la semana 3 no son los
    // de la 15, y mostrar los de otra semana sería peor que no mostrar nada.
    const key = `${seenKey.page('statistics', babyId)}:w${shownWeek}`
    if (saved.current?.key !== key) saved.current = lastGood(key, EMPTY)
    const last = saved.current

    const [feedings, nursing, diapers, sleep, growth] = await Promise.all([
      feedingsSince(babyId, sinceIso),
      nursingSince(babyId, sinceIso),
      diapersSince(babyId, sinceIso),
      sleepSince(babyId, sinceIso),
      listGrowth(babyId),
    ])
    // Mismo patrón que /growth y /history: se conservan las últimas filas
    // buenas y una lectura que falla no vacía la pantalla.
    const merged = keepLastGood(last.rows, { feedings, nursing, diapers, sleep, growth })
    setSeen(last.settle(merged.rows, merged.error))
    setRows(merged.rows)
    // Quedarse sin red no es un error que haya que gritar: SeenNote ya lo dice
    // (§5.4). El banner queda para un error de verdad.
    setError(merged.error && !looksOffline(merged.error) ? merged.error : null)
    setReading(false)
  }, [babyId, sinceIso, shownWeek])

  useEffect(() => {
    void load()
  }, [load])

  if (loading)
    return (
      <Page>
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

  // Sin fecha de nacimiento no hay semana de vida. No se muestra "semana 1"
  // por las dudas: se dice qué falta y dónde se carga (§5.4).
  if (!birthDate || !range)
    return (
      <Page>
        <Nav />
        <h1 className="title">{t('stats.title')}</h1>
        <div className="empty-fill">
          <EmptyState
            icon="statistics"
            title={t('week.noBirthDate')}
            hint={t('week.noBirthDateHint')}
          />
        </div>
      </Page>
    )

  const window: KpiWindow = { start: range.start, end: range.end }
  const feeding = feedingKpis(rows.feedings, rows.nursing, window, range.end)
  const diapers = diaperKpis(rows.diapers, window)
  const sleep = sleepKpis(rows.sleep, window, range.end)
  const hasRows = feeding.total > 0 || diapers.total > 0 || sleep.naps > 0 || sleep.sleptMs > 0
  // Sin conexión y sin copia guardada: no se sabe. Un 0 sería una afirmación.
  const unknown = seen.kind === 'nothing'

  /** El día de la semana, corto, para el eje: "Mon" / "lun". */
  const dayLabel = (day: string) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es' : 'en-US', {
      weekday: 'short',
      timeZone: 'UTC',
    })

  /** Los siete días de la semana, cada uno con su ventana propia. */
  const perDay = range.days.map((day, i) => {
    const start = startOfHouseholdDayFrom(range, i)
    const end = startOfHouseholdDayFrom(range, i + 1)
    return { day, label: dayLabel(day), w: { start, end } as KpiWindow }
  })

  const feedingsPerDay: ChartPoint[] = perDay.map(({ label, w }) => {
    const k = feedingKpis(rows.feedings, rows.nursing, w, w.end)
    return { label, value: k.total, spoken: String(k.total) }
  })
  const diapersPerDay: ChartPoint[] = perDay.map(({ label, w }) => {
    const k = diaperKpis(rows.diapers, w)
    return { label, value: k.total, spoken: String(k.total) }
  })
  const sleepPerDay: ChartPoint[] = perDay.map(({ label, w }) => {
    const ms = rows.sleep.reduce((sum, s) => sum + overlapMs(s.started_at, s.ended_at, w, w.end), 0)
    return { label, value: ms / 3_600_000, spoken: formatDuration(ms, lang) }
  })

  const weights = rows.growth
    .filter((g): g is GrowthMeasurement & { weight_kg: number } => g.weight_kg != null)
    .sort((a, b) => a.measured_at.localeCompare(b.measured_at))
  const weightPoints: ChartPoint[] = weights.map((g) => ({
    label: measuredOn(g.measured_at, lang),
    value: g.weight_kg,
    spoken: kgToLbOz(g.weight_kg),
  }))
  const lastGrowth = weights[weights.length - 1] ?? null
  const prevGrowth = weights[weights.length - 2] ?? null

  const days = range.days.length
  const avg = (n: number) => (n / days).toFixed(1)

  return (
    <Page>
      <Nav />
      <h1 className="title">{t('stats.title')}</h1>

      <Card spanAll>
        <Label>{t('week.label')}</Label>
        <WeekPicker
          range={range}
          isCurrent={current !== null && range.week >= current}
          canGoBack={range.week > 1}
          onChange={setWeek}
        />
      </Card>

      <SeenNote state={seen} />
      {error && !reading && <Banner kind="error">{t('stats.couldNotLoad', { error })}</Banner>}

      <Grid>
        <StatCard
          title={t('stats.feeding')}
          rows={[
            [t('kpi.feedings'), String(feeding.total)],
            [t('kpi.breast'), String(feeding.breast)],
            [t('kpi.bottleVolume'), formatVolume(feeding.bottleMl, DISPLAY_UNIT)],
            [t('kpi.breastTime'), formatDuration(feeding.breastMs, lang)],
            [t('stats.dailyAverage'), avg(feeding.total)],
          ]}
          chart={
            hasRows ? <BarChart title={t('stats.chartFeedings')} points={feedingsPerDay} /> : null
          }
          caption={t('stats.chartFeedings')}
          empty={!hasRows ? t('stats.noRows') : null}
          unknown={unknown}
        />

        <StatCard
          title={t('stats.diapers')}
          rows={[
            [t('kpi.diapers'), String(diapers.total)],
            [t('activity.diaperDetail.wet'), String(diapers.wet)],
            [t('activity.diaperDetail.dirty'), String(diapers.dirty)],
            [t('activity.diaperDetail.both'), String(diapers.both)],
            [t('stats.dailyAverage'), avg(diapers.total)],
          ]}
          chart={
            hasRows ? <BarChart title={t('stats.chartDiapers')} points={diapersPerDay} /> : null
          }
          caption={t('stats.chartDiapers')}
          empty={!hasRows ? t('stats.noRows') : null}
          unknown={unknown}
        />

        <StatCard
          title={t('stats.sleep')}
          rows={[
            [t('kpi.slept'), formatDuration(sleep.sleptMs, lang)],
            [t('kpi.naps'), String(sleep.naps)],
            [t('stats.dailyAverage'), formatDuration(sleep.sleptMs / days, lang)],
          ]}
          chart={hasRows ? <BarChart title={t('stats.chartSleep')} points={sleepPerDay} /> : null}
          caption={t('stats.chartSleep')}
          empty={!hasRows ? t('stats.noRows') : null}
          unknown={unknown}
        />

        <StatCard
          title={t('stats.growth')}
          rows={
            lastGrowth
              ? [
                  [t('stats.latestWeight'), kgToLbOz(lastGrowth.weight_kg)],
                  ...(lastGrowth.height_cm != null
                    ? ([[t('stats.latestHeight'), `${lastGrowth.height_cm} cm`]] as [
                        string,
                        string,
                      ][])
                    : []),
                  ...(prevGrowth
                    ? ([
                        [t('stats.since'), gainLabel(lastGrowth.weight_kg, prevGrowth.weight_kg)],
                      ] as [string, string][])
                    : []),
                ]
              : []
          }
          // El peso es continuo y lo que importa es la pendiente: línea, no barras.
          chart={<LineChart title={t('stats.chartWeight')} points={weightPoints} />}
          caption={t('stats.chartWeight')}
          empty={weightPoints.length < 2 ? t('stats.noGrowth') : null}
          unknown={unknown}
        />
      </Grid>
    </Page>
  )
}

/** "+240 g" / "-40 g": la diferencia con la medición anterior, con su signo. */
function gainLabel(kg: number, previousKg: number): string {
  const grams = Math.round((kg - previousKg) * 1000)
  return `${grams >= 0 ? '+' : ''}${grams} g`
}

/**
 * La medianoche del hogar del día `i` de la semana. Se resuelve contra
 * `startOfHouseholdDay` para que un cambio de horario dentro de la semana no
 * corra los días: sumar 24 h siete veces daría 23 o 25 horas de error.
 */
function startOfHouseholdDayFrom(range: LifeWeekRange, i: number): number {
  if (i === 0) return range.start
  if (i >= range.days.length) return range.end
  return startOfHouseholdDay(new Date(`${range.days[i]}T12:00:00Z`), 0)
}

function StatCard({
  title,
  rows,
  chart,
  caption,
  empty,
  unknown,
}: {
  title: string
  rows: [string, string][]
  chart: React.ReactNode
  caption: string
  empty: string | null
  /** Offline y sin copia guardada: los números son "—" y no se dibuja nada. */
  unknown: boolean
}) {
  return (
    <Card>
      <div className="stat-head">
        <Label>{title}</Label>
      </div>
      {rows.length > 0 && (
        <dl className="kpis">
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{unknown ? '—' : value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {unknown ? (
        <p className="note">{/* SeenNote arriba ya explica por qué */}</p>
      ) : empty ? (
        <p className="note">{empty}</p>
      ) : (
        <>
          {chart}
          <p className="note">{caption}</p>
        </>
      )}
    </Card>
  )
}
