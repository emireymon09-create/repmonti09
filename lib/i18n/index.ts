/**
 * Interface language. Tiny and dependency-free on purpose: two languages,
 * a flat dictionary each, `{name}` interpolation and one/other plurals.
 *
 * The choice is a per-device display preference, like the theme and the
 * oz/ml unit, so it lives in localStorage (LANG_KEY), not the database.
 * No choice — or "system" — follows the device's languages.
 *
 * Safe on the server and in plain modules (lib/format.ts, lib/db.ts); the
 * React side (provider + useT) is lib/i18n/react.tsx.
 */

import { en, type Dictionary, type MessageKey, type Plural } from './en'
import { es } from './es'
import { LANG_KEY } from './boot'

export { LANG_KEY }
export type { MessageKey }

export type Lang = 'en' | 'es'
export type LangChoice = Lang | 'system'
export type Vars = Record<string, string | number>

export const LANGS: Lang[] = ['en', 'es']

const DICTIONARIES: Record<Lang, Dictionary> = { en, es }

/**
 * Locale handed to Intl for dates and times. English is pinned to en-US —
 * the household is in Los Angeles — instead of following the device, so a
 * device set to Spanish that picks English still reads "7:00 PM". Spanish
 * uses the plain `es` data: a 24-hour clock, compact at 3am and on the wall.
 */
const INTL_LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es' }

export function intlLocale(lang: Lang): string {
  return INTL_LOCALE[lang]
}

export function isLangChoice(value: unknown): value is LangChoice {
  return value === 'en' || value === 'es' || value === 'system'
}

/**
 * The device's languages, most preferred first: the first one we support
 * wins ("fr, es-AR" → es), and nothing supported means English.
 */
export function detectLang(languages: readonly string[]): Lang {
  for (const raw of languages) {
    const tag = String(raw || '').toLowerCase()
    if (tag.startsWith('es')) return 'es'
    if (tag.startsWith('en')) return 'en'
  }
  return 'en'
}

/** A saved explicit choice wins; otherwise (or on "system") the device decides. */
export function resolveLang(choice: string | null | undefined, languages: readonly string[]): Lang {
  if (choice === 'en' || choice === 'es') return choice
  return detectLang(languages)
}

/** navigator.languages with the fallbacks old browsers need. */
export function navigatorLanguages(): string[] {
  if (typeof navigator === 'undefined') return []
  if (navigator.languages && navigator.languages.length) return [...navigator.languages]
  return navigator.language ? [navigator.language] : []
}

/**
 * The language the page is showing, for code outside React that has to
 * produce text (an error from lib/db.ts). I18nProvider keeps <html lang>
 * in sync; before it runs, and on the server, this is English.
 */
export function documentLang(): Lang {
  if (typeof document === 'undefined') return 'en'
  return document.documentElement.lang === 'es' ? 'es' : 'en'
}

function pick(entry: string | Plural, vars?: Vars): string {
  if (typeof entry === 'string') return entry
  return vars?.count === 1 ? entry.one : entry.other
}

/**
 * `translate('es', 'milk.counted', { count: 3 })` → "3 sesiones contadas".
 * A `{name}` with no value is left as-is, so a forgotten variable shows up
 * on screen instead of vanishing.
 */
export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  const entry = DICTIONARIES[lang][key] ?? en[key]
  return pick(entry, vars).replace(/\{(\w+)\}/g, (whole, name: string) =>
    vars && name in vars ? String(vars[name]) : whole,
  )
}

export type Translate = (key: MessageKey, vars?: Vars) => string
