'use client'

import { useEffect, useRef, useState } from 'react'
import { Banner } from '@/components/Banner'
import { useT } from '@/lib/i18n/react'
import { LONG_NURSING_MINUTES } from '@/lib/push/nursing'
import {
  alertsState,
  turnAlertsOff,
  turnAlertsOn,
  updateAlertsLang,
  type AlertsError,
  type AlertsState,
} from '@/lib/push/client'
import type { MessageKey } from '@/lib/i18n'

/**
 * "Nursing alerts" on the Settings screen, under Language, with the same
 * segment shape. Per device: it says what THIS browser will do.
 *
 * It lived inside the gear menu until 22 sep 2026; it moved with the rest of
 * the settings, and its segments are now plain radios on a page, not
 * menuitemradios inside a role="menu".
 *
 * Nothing claims more than is true: "On" only once the browser subscription
 * and the server row both exist (lib/push/client.ts); a browser that can't,
 * or that blocked notifications, says so and why instead of offering a
 * switch that does nothing; a failure shows up as a banner with the reason.
 */
export function NursingAlerts({ babyId }: { babyId?: string }) {
  const { t, lang } = useT()
  const [state, setState] = useState<AlertsState | null>(null)
  const [busy, setBusy] = useState<'on' | 'off' | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The language the server was last told. */
  const sentLang = useRef(lang)
  /** The language right now, readable from inside an in-flight promise. */
  const currentLang = useRef(lang)
  currentLang.current = lang

  // Each time the menu opens: "On" only after the server confirms its row.
  useEffect(() => {
    let cancelled = false
    const asked = lang
    alertsState(asked, babyId).then((res) => {
      if (cancelled) return
      setState(res.state)
      if (res.error) setError(t('alerts.couldNotCheck', { error: res.error }))
      if (res.state !== 'on') return
      sentLang.current = asked
      // The language changed while this check was in flight: the effect below
      // saw `state` still null and skipped, so the server has the old one.
      if (currentLang.current !== asked) sendLang(currentLang.current, () => cancelled)
    })
    return () => {
      cancelled = true
    }
    // Once per mount: a language change is handled below, and re-checking on
    // every render would re-send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The language changed while alerts are on: the server writes the
  // notification, so it has to learn the new one.
  useEffect(() => {
    // Still checking (`state === null`): the mount effect above compares the
    // language it asked with this one and sends it. Not on: nothing to update —
    // turning it on later sends whatever the language is then.
    if (lang === sentLang.current || state !== 'on') return
    sendLang(lang, () => false)
    // Only on a language change; `state`/`t` changing must not re-send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])

  function sendLang(next: typeof lang, cancelled: () => boolean) {
    sentLang.current = next
    updateAlertsLang(next, babyId).then((failed) => {
      if (failed && !cancelled()) setError(t('alerts.couldNotUpdate', { error: failed }))
    })
  }

  function explain(e: AlertsError, fallback: MessageKey): string {
    if (e.kind === 'other') return t(fallback, { error: e.detail })
    return t(e.kind === 'noWorker' ? 'alerts.noWorker' : 'alerts.notGranted')
  }

  async function choose(next: 'on' | 'off') {
    if (busy || state === next) return
    setError(null)
    setBusy(next)
    // turnAlertsOn asks for permission first thing: it has to run inside this
    // tap, before any other await.
    const asked = lang
    const res = next === 'on' ? await turnAlertsOn(asked, babyId) : await turnAlertsOff()
    setBusy(null)
    setState(res.state)
    // turnAlertsOn wrote the row in the language of the tap: that's what the
    // server has now, and what a later change has to be compared against.
    if (next === 'on' && res.state === 'on') {
      sentLang.current = asked
      if (currentLang.current !== asked) sendLang(currentLang.current, () => false)
    }
    if (res.error) {
      setError(
        explain(res.error, next === 'on' ? 'alerts.couldNotTurnOn' : 'alerts.couldNotTurnOff'),
      )
    }
  }

  const cannot = state === 'unsupported' || state === 'install' || state === 'unavailable'
  const note =
    busy === 'on'
      ? t('alerts.turningOn')
      : busy === 'off'
        ? t('alerts.turningOff')
        : state === 'unsupported'
          ? t('alerts.unsupported')
          : state === 'install'
            ? t('alerts.install')
            : state === 'unavailable'
              ? t('alerts.unavailable')
              : state === 'denied'
                ? t('alerts.denied')
                : state === 'unknown'
                  ? t('alerts.unknown')
                  : t('alerts.about', { minutes: LONG_NURSING_MINUTES })

  return (
    <div className="setting-group" role="radiogroup" aria-labelledby="alerts-label">
      <div className="label" id="alerts-label">
        {t('menu.nursingAlerts')}
      </div>
      <div className="seg" aria-busy={busy !== null}>
        {(['off', 'on'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={state === value || (value === 'off' && state === 'denied')}
            className="seg-btn"
            // Nothing to switch where the browser can't do it; "On" stays
            // tappable when blocked only to re-read the permission after the
            // user allows it in the site settings.
            disabled={state === null || cannot || busy !== null}
            onClick={() => choose(value)}
          >
            {t(value === 'on' ? 'alerts.on' : 'alerts.off')}
          </button>
        ))}
      </div>
      <p className="setting-note" role="status">
        {note}
      </p>
      {error && <Banner kind="error">{error}</Banner>}
    </div>
  )
}
