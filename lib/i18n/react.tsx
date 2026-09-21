'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'
import {
  isLangChoice,
  LANG_KEY,
  navigatorLanguages,
  resolveLang,
  translate,
  type Lang,
  type LangChoice,
  type Translate,
} from '@/lib/i18n'

type I18n = {
  lang: Lang
  choice: LangChoice
  setChoice: (choice: LangChoice) => void
}

const I18nContext = createContext<I18n>({ lang: 'en', choice: 'system', setChoice: () => {} })

// Layout effects run after hydration but before the browser paints, so the
// switch to the device's language never shows the English markup the server
// sent. The server has no layout effects — useEffect there is a no-op too,
// without React's warning.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Holds the interface language for the whole app (mounted once, in
 * app/layout.tsx). Starts in English — exactly what the server rendered, so
 * hydration matches — and resolves the saved choice / device language right
 * after, before the first paint. lib/i18n/boot.ts keeps the page hidden
 * until then when the answer isn't English.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<LangChoice>('system')
  const [lang, setLang] = useState<Lang>('en')

  useIsoLayoutEffect(() => {
    let saved: string | null = null
    try {
      saved = window.localStorage.getItem(LANG_KEY)
    } catch {
      // Storage unavailable (private mode, etc.) — follow the device.
    }
    const initial = isLangChoice(saved) ? saved : 'system'
    setChoiceState(initial)
    setLang(resolveLang(initial, navigatorLanguages()))
  }, [])

  useIsoLayoutEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.removeAttribute('data-lang-pending')
  }, [lang])

  // "System" keeps following the device if its language changes while open.
  useEffect(() => {
    if (choice !== 'system') return
    const onChange = () => setLang(resolveLang('system', navigatorLanguages()))
    window.addEventListener('languagechange', onChange)
    return () => window.removeEventListener('languagechange', onChange)
  }, [choice])

  const setChoice = useCallback((next: LangChoice) => {
    setChoiceState(next)
    setLang(resolveLang(next, navigatorLanguages()))
    try {
      window.localStorage.setItem(LANG_KEY, next)
    } catch {
      // Best-effort; this tab still switches either way.
    }
  }, [])

  const value = useMemo(() => ({ lang, choice, setChoice }), [lang, choice, setChoice])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** `const { t, lang } = useT()` — `t('milk.counted', { count: 3 })`. */
export function useT(): { t: Translate; lang: Lang } {
  const { lang } = useContext(I18nContext)
  const t = useCallback<Translate>((key, vars) => translate(lang, key, vars), [lang])
  return { t, lang }
}

/** The saved choice and its setter, for the language picker in the settings menu. */
export function useLanguageChoice(): [LangChoice, (choice: LangChoice) => void] {
  const { choice, setChoice } = useContext(I18nContext)
  return [choice, setChoice]
}
