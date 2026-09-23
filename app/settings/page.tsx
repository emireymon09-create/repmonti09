'use client'

/**
 * Settings — la pantalla de ajustes (22 sep 2026).
 *
 * Todo esto vivía adentro del menú desplegable del engranaje: tema, idioma,
 * avisos de lactancia, la unidad de volumen, el reset del total de leche y
 * cerrar sesión. Un menú que era a la vez navegación y panel de control
 * crecía sin techo y obligaba a mantener abierto un desplegable para cambiar
 * algo. Ahora el menú es solo navegación (components/ui.tsx) y los ajustes
 * son una pantalla, con lugar para explicar qué hace cada uno.
 *
 * No hay duplicados: ninguno de estos controles quedó en el menú.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useBaby } from '@/lib/useBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { NursingAlerts } from '@/components/NursingAlerts'
import { createClient } from '@/lib/supabaseClient'
import { resetPumpingTotal } from '@/lib/db'
import { forgetSeen } from '@/lib/lastSeen'
import { forgetAlertsOnSignOut } from '@/lib/push/client'
import { useVolumeUnit } from '@/lib/useVolumeUnit'
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
  const [unit, setUnit] = useVolumeUnit()
  const [theme, setTheme] = useTheme()
  const [langChoice, setLangChoice] = useLanguageChoice()
  const [resetting, setResetting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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

  function switchUnit() {
    setUnit(unit === 'oz' ? 'ml' : 'oz')
    // Every page that shows an amount reads the unit once on mount —
    // reloading is the simplest way to make the switch take everywhere
    // at once, matching how "Reset milk total" already refreshes.
    window.location.reload()
  }

  async function resetMilkTotal() {
    if (!baby || resetting) return
    if (!window.confirm(t('menu.resetConfirm'))) return
    setErr(null)
    setResetting(true)
    const { error } = await resetPumpingTotal(baby.id)
    setResetting(false)
    if (error) {
      setErr(t('menu.resetFailed', { error }))
      return
    }
    window.location.reload()
  }

  // Esta pantalla no depende del bebé para casi nada —tema, idioma y unidad
  // son del dispositivo, y cerrar sesión siempre tiene que poder hacerse—,
  // así que no rebota a NoBaby: solo el reset de leche se esconde sin bebé.
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
      {err && <Banner kind="error">{err}</Banner>}

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

        <Card>
          <Label>{t('settings.units')}</Label>
          <p className="setting-note">{t('settings.unitsNote', { unit })}</p>
          <div className="row-tight">
            <Btn variant="quiet" onClick={switchUnit}>
              {t('menu.switchUnit', { unit: unit === 'oz' ? 'ml' : 'oz' })}
            </Btn>
          </div>

          {baby && (
            <>
              <Label>{t('settings.milk')}</Label>
              <p className="setting-note">{t('settings.milkNote')}</p>
              <div className="row-tight">
                <Btn variant="quiet" onClick={resetMilkTotal} disabled={resetting}>
                  {resetting ? t('menu.resetting') : t('menu.resetMilk')}
                </Btn>
              </div>
            </>
          )}

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
