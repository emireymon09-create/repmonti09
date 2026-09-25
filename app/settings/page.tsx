'use client'

/**
 * Settings — la pantalla de ajustes (22 sep 2026).
 *
 * Todo esto vivía adentro del menú desplegable del engranaje: tema, idioma,
 * avisos de lactancia y cerrar sesión. Un menú que era a la vez navegación y
 * panel de control crecía sin techo y obligaba a mantener abierto un
 * desplegable para cambiar algo. Ahora el menú es solo navegación
 * (components/ui.tsx) y los ajustes son una pantalla, con lugar para
 * explicar qué hace cada uno.
 *
 * No hay duplicados: ninguno de estos controles quedó en el menú.
 *
 * Dos ajustes se fueron el 23 sep 2026 y no se reemplazaron por nada:
 *
 *   · **oz / ml.** Ya no es una preferencia: la app muestra siempre onzas
 *     (lib/format.ts, DISPLAY_UNIT). La unidad de lo que se TIPEA se elige
 *     al lado del campo, por entrada (components/AmountUnit.tsx). No hubo
 *     migración de datos: la base siempre guardó ml y sigue igual.
 *   · **"Poner en cero la leche".** El total de /pumping ya no se puede
 *     reiniciar desde la app. La columna `babies.pumping_reset_at` sigue
 *     existiendo y /pumping la sigue respetando, así que un reset hecho
 *     antes se mantiene; lo que no hay es forma de hacer uno nuevo.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useBaby } from '@/lib/useBaby'
import { Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { Banner } from '@/components/Banner'
import { NursingAlerts } from '@/components/NursingAlerts'
import { calendarFeed, familySettings, saveFamilySettings, type CalendarFeedInfo } from '@/lib/db'
import { timeAgo } from '@/lib/format'
import {
  DEFAULT_FAMILY_SETTINGS,
  MAX_THRESHOLD_MINUTES,
  MIN_THRESHOLD_MINUTES,
  checkThreshold,
  type FamilySettings,
} from '@/lib/schedule'
import { createClient } from '@/lib/supabaseClient'
import { forgetSeen } from '@/lib/lastSeen'
import { forgetAlertsOnSignOut } from '@/lib/push/client'
import { useTheme, type Theme } from '@/lib/theme'
import { useLanguageChoice, useT } from '@/lib/i18n/react'
import type { LangChoice, MessageKey } from '@/lib/i18n'

const THEMES: { value: Theme; label: MessageKey }[] = [
  { value: 'light', label: 'theme.light' },
  { value: 'dark', label: 'theme.dark' },
  { value: 'system', label: 'theme.system' },
]

// Same shape as the theme picker, right under it. "System" first: it is what
// a device gets until someone chooses, and it follows the phone's language.
const LANGUAGES: { value: LangChoice; label: MessageKey }[] = [
  { value: 'system', label: 'language.system' },
  { value: 'en', label: 'language.en' },
  { value: 'es', label: 'language.es' },
]

export default function Settings() {
  const { baby, loading, unreachable } = useBaby()
  const router = useRouter()
  const { t } = useT()
  const [theme, setTheme] = useTheme()
  const [langChoice, setLangChoice] = useLanguageChoice()
  const familyId = baby?.family_id ?? null

  async function signOut() {
    // First, and whatever signOut() does offline: this screen is shared,
    // and the family's rows saved for offline must not outlive the session.
    forgetSeen()
    // Then this device's nursing alerts: the next person on this screen must
    // not get this family's notifications. Before signOut() — deleting the
    // server row needs the session — and bounded, so it can't block it.
    await forgetAlertsOnSignOut()
    await createClient().auth.signOut()
    router.push('/login')
  }

  // Esta pantalla no depende del bebé para nada salvo los avisos de
  // lactancia —tema e idioma son del dispositivo, y cerrar sesión siempre
  // tiene que poder hacerse—, así que no rebota a NoBaby.
  if (loading)
    return (
      <Page>
        <Nav />
        <p className="empty loading-note">{t('common.loading')}</p>
      </Page>
    )

  return (
    <Page>
      <Nav />
      <h1 className="title">{t('settings.title')}</h1>

      <Grid>
        <Card>
          <div className="setting-group" role="radiogroup" aria-labelledby="theme-label">
            <div className="label" id="theme-label">
              {t('menu.theme')}
            </div>
            <div className="seg">
              {THEMES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.value}
                  className="seg-btn"
                  onClick={() => setTheme(option.value)}
                >
                  {t(option.label)}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-group" role="radiogroup" aria-labelledby="language-label">
            <div className="label" id="language-label">
              {t('menu.language')}
            </div>
            <div className="seg">
              {LANGUAGES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={langChoice === option.value}
                  className="seg-btn"
                  // Each language is named in itself; this tells a screen
                  // reader to read "Español" with Spanish rules.
                  lang={option.value === 'system' ? undefined : option.value}
                  onClick={() => setLangChoice(option.value)}
                >
                  {t(option.label)}
                </button>
              ))}
            </div>
          </div>

          <NursingAlerts babyId={baby?.id} />
        </Card>

        <ScheduleSettings familyId={familyId} />
        <CalendarFeedSettings familyId={familyId} />

        <Card>
          <Label>{t('settings.account')}</Label>
          <p className="setting-note">
            {unreachable ? t('settings.signOutOffline') : t('settings.signOutNote')}
          </p>
          <div className="row-tight">
            <Btn variant="quiet" onClick={signOut}>
              {t('menu.signOut')}
            </Btn>
          </div>
        </Card>
      </Grid>
    </Page>
  )
}

/**
 * Los dos umbrales del countdown de Today. **Dato de FAMILIA, no de este
 * dispositivo** — al revés que Theme, Language y Nursing alerts, que están
 * arriba en esta misma pantalla y viven en `localStorage`. Los dos padres
 * tienen que ver el mismo número, y el servidor lo lee para decidir si manda
 * el aviso (0012). La nota lo dice con todas las letras: sin eso, la pantalla
 * sugiere que es una preferencia de este teléfono como las tres de arriba.
 *
 * Y no pasa por la cola offline, a propósito (lib/db.ts lo explica): sin
 * conexión no se guarda nada y la pantalla lo dice, en vez de mostrar un
 * número como guardado que después podría pisar el del otro padre (§5.5).
 */
function ScheduleSettings({ familyId }: { familyId: string | null }) {
  const { t } = useT()
  const [feed, setFeed] = useState(String(DEFAULT_FAMILY_SETTINGS.feed_threshold_minutes))
  const [nap, setNap] = useState(String(DEFAULT_FAMILY_SETTINGS.nap_threshold_minutes))
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!familyId) return
    let cancelled = false
    familySettings(familyId).then((res) => {
      if (cancelled) return
      if (res.error) {
        setErr(t('settings.thresholdCouldNotLoad', { error: res.error }))
        return
      }
      if (res.data) {
        setFeed(String(res.data.feed_threshold_minutes))
        setNap(String(res.data.nap_threshold_minutes))
      }
    })
    return () => {
      cancelled = true
    }
  }, [familyId, t])

  const save = useCallback(
    async (patch: FamilySettings) => {
      if (!familyId || busy) return
      setBusy(true)
      setErr(null)
      setFlash(null)
      const res = await saveFamilySettings(familyId, patch)
      setBusy(false)
      if (res.error) setErr(t('settings.thresholdCouldNotSave', { error: res.error }))
      else setFlash(t('settings.thresholdSaved'))
    },
    [familyId, busy, t],
  )

  function commit(which: 'feed' | 'nap', raw: string) {
    const minutes = Number(raw)
    // Se valida acá y no solo contra el CHECK de la columna, para que el error
    // se lea como una frase y no como un mensaje de Postgres (§5.5).
    const problem = checkThreshold(minutes)
    if (problem) {
      setFlash(null)
      setErr(
        problem === 'notNumber'
          ? t('settings.thresholdNotNumber')
          : t('settings.thresholdOutOfRange', {
              min: MIN_THRESHOLD_MINUTES,
              max: MAX_THRESHOLD_MINUTES,
            }),
      )
      return
    }
    void save({
      feed_threshold_minutes: which === 'feed' ? minutes : Number(feed),
      nap_threshold_minutes: which === 'nap' ? minutes : Number(nap),
    })
  }

  return (
    <Card>
      <Label>{t('settings.schedule')}</Label>
      <p className="setting-note">{t('settings.scheduleNote')}</p>

      <div className="setting-group">
        <label className="label" htmlFor="feed-threshold">
          {t('settings.feedEvery')}
        </label>
        <div className="row-tight">
          <input
            id="feed-threshold"
            className="input narrow"
            type="number"
            inputMode="numeric"
            min={MIN_THRESHOLD_MINUTES}
            max={MAX_THRESHOLD_MINUTES}
            value={feed}
            disabled={!familyId || busy}
            onChange={(e) => setFeed(e.target.value)}
            onBlur={(e) => commit('feed', e.target.value)}
          />
          <span className="meta">{t('settings.minutes')}</span>
        </div>
      </div>

      <div className="setting-group">
        <label className="label" htmlFor="nap-threshold">
          {t('settings.napAfter')}
        </label>
        <div className="row-tight">
          <input
            id="nap-threshold"
            className="input narrow"
            type="number"
            inputMode="numeric"
            min={MIN_THRESHOLD_MINUTES}
            max={MAX_THRESHOLD_MINUTES}
            value={nap}
            disabled={!familyId || busy}
            onChange={(e) => setNap(e.target.value)}
            onBlur={(e) => commit('nap', e.target.value)}
          />
          <span className="meta">{t('settings.minutes')}</span>
        </div>
      </div>

      <p className="setting-note">
        {t('settings.thresholdRange', { min: MIN_THRESHOLD_MINUTES, max: MAX_THRESHOLD_MINUTES })}
      </p>
      {flash && <Banner kind="ok">{flash}</Banner>}
      {err && <Banner kind="error">{err}</Banner>}
    </Card>
  )
}

/**
 * El feed .ics de los turnos médicos.
 *
 * El token en claro se muestra UNA vez: la base guarda solo el sha-256 (0012),
 * así que ni esta pantalla ni nadie puede volver a armar el link. Si se pierde,
 * se reemplaza — y reemplazarlo es también la forma de rotarlo si alguien lo
 * compartió sin querer, por eso el confirm dice que el anterior deja de
 * funcionar en el acto (§5.6: la confirmación dice qué se pierde).
 */
function CalendarFeedSettings({ familyId }: { familyId: string | null }) {
  const { t, lang } = useT()
  const [info, setInfo] = useState<CalendarFeedInfo | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!familyId) return
    let cancelled = false
    calendarFeed(familyId).then((res) => {
      if (cancelled) return
      if (res.error) setErr(t('calendar.couldNotLoad', { error: res.error }))
      else setInfo(res.data)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [familyId, t])

  async function issue(rotate: boolean) {
    if (busy) return
    if (rotate && !window.confirm(t('calendar.rotateConfirm'))) return
    setBusy(true)
    setErr(null)
    setCopied(false)
    try {
      const res = await fetch('/api/calendar/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotate }),
      })
      const body: unknown = await res.json()
      const payload = body as { url?: string; error?: string }
      if (!res.ok || !payload.url) {
        setErr(t('calendar.couldNotCreate', { error: payload.error ?? String(res.status) }))
      } else {
        setUrl(payload.url)
        if (familyId) {
          const again = await calendarFeed(familyId)
          if (!again.error) setInfo(again.data)
        }
      }
    } catch (e) {
      // Offline: el link necesita el servidor. No se encola — no hay nada que
      // encolar, el valor lo genera el servidor (§5.5).
      setErr(
        navigator.onLine === false
          ? t('calendar.offline')
          : t('calendar.couldNotCreate', {
              error: e instanceof Error ? e.message : String(e),
            }),
      )
    }
    setBusy(false)
  }

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // Sin permiso de portapapeles el texto sigue ahí y es `user-select: all`:
      // se selecciona de un toque. No se muestra un error por esto.
    }
  }

  return (
    <Card>
      <Label>{t('calendar.title')}</Label>
      <p className="setting-note">{t('calendar.note')}</p>

      {loaded && !info && !url && <p className="setting-note">{t('calendar.none')}</p>}
      {info && (
        <p className="setting-note">
          {t('calendar.createdOn', {
            when: timeAgo(info.rotated_at ?? info.created_at, Date.now(), lang),
          })}{' '}
          {info.last_fetched_at
            ? t('calendar.lastRead', { when: timeAgo(info.last_fetched_at, Date.now(), lang) })
            : t('calendar.neverRead')}
        </p>
      )}

      {url && (
        <>
          <p className="setting-note">{t('calendar.showOnce')}</p>
          <code className="feed-url">{url}</code>
          <p className="setting-note">{t('calendar.howTo')}</p>
          <div className="row-tight">
            <Btn variant="quiet" onClick={copy}>
              {copied ? t('calendar.copied') : t('calendar.copy')}
            </Btn>
          </div>
        </>
      )}

      <div className="row-tight">
        <Btn variant="quiet" disabled={!familyId || busy} onClick={() => issue(Boolean(info))}>
          {info ? t('calendar.rotate') : t('calendar.create')}
        </Btn>
      </div>
      {err && <Banner kind="error">{err}</Banner>}
    </Card>
  )
}
