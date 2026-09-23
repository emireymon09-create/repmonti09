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

import { useRouter } from 'next/navigation'
import { useBaby } from '@/lib/useBaby'
import { Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { NursingAlerts } from '@/components/NursingAlerts'
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
