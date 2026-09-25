import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { en, type MessageKey, type Plural } from '@/lib/i18n/en'
import { es } from '@/lib/i18n/es'
import { LANG_BOOT_SCRIPT, LANG_KEY } from '@/lib/i18n/boot'
import { detectLang, isLangChoice, resolveLang, translate } from '@/lib/i18n'
import {
  ageFrom,
  apptWhen,
  clockTime,
  durationBetween,
  dueRelative,
  growthInputToMetric,
  emptyGrowthInput,
  longDate,
  measuredOn,
  timeAgo,
} from '@/lib/format'
import { buildActivity } from '@/lib/db'

const keys = Object.keys(en) as MessageKey[]
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
const texts = (entry: string | Plural) =>
  typeof entry === 'string' ? [entry] : [entry.one, entry.other]

// Iguales en los dos idiomas a propósito: nombres propios de idioma, y
// abreviaturas que se dicen igual.
const SAME_ON_PURPOSE = new Set<MessageKey>([
  'language.en',
  'language.es',
  'duration.mins',
  // Símbolos de unidad y la abreviatura de minutos: se escriben igual.
  'unit.oz',
  'unit.ml',
  'offset.minutes',
  'settings.minutes',
  // Puro andamiaje: no tienen una sola palabra propia, solo variables y
  // puntuación. Traducirlas sería inventar una diferencia que no existe.
  'week.range',
  'stats.chartSummary',
  'stats.chartDayValue',
])

describe('diccionarios', () => {
  it('es tiene exactamente las claves de en', () => {
    expect(Object.keys(es).sort()).toEqual([...keys].sort())
  })

  it('ninguna traducción vacía, y los plurales siguen siendo plurales', () => {
    for (const key of keys) {
      const source = en[key] as string | Plural
      const target = es[key] as string | Plural
      expect(typeof target, key).toBe(typeof source)
      for (const text of texts(target)) expect(text.trim(), key).not.toBe('')
    }
  })

  it('ninguna clave quedó en inglés sin traducir', () => {
    const untranslated = keys.filter(
      (key) =>
        !SAME_ON_PURPOSE.has(key) &&
        JSON.stringify(en[key]) === JSON.stringify(es[key as keyof typeof es]),
    )
    expect(untranslated).toEqual([])
  })

  it('cada traducción usa las mismas variables que el original', () => {
    for (const key of keys) {
      const source = texts(en[key] as string | Plural)
      const target = texts(es[key] as string | Plural)
      source.forEach((text, i) => expect(placeholders(target[i]), key).toEqual(placeholders(text)))
    }
  })
})

describe('translate con una clave armada desde datos que no existe', () => {
  it('muestra el último segmento (el valor crudo) y avisa solo fuera de producción', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(translate('es', 'diaper.purple' as MessageKey)).toBe('purple')
      expect(translate('en', 'activity.sideDetail.middle' as MessageKey)).toBe('middle')
      expect(warn).toHaveBeenCalledTimes(2)

      vi.stubEnv('NODE_ENV', 'production')
      warn.mockClear()
      expect(translate('es', 'diaper.purple' as MessageKey)).toBe('purple')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      warn.mockRestore()
    }
  })
})

describe('translate', () => {
  it('interpola variables', () => {
    expect(translate('en', 'offset.moved', { minutes: '5' })).toBe('Start moved back 5 min')
    expect(translate('es', 'offset.moved', { minutes: '5' })).toBe(
      'Inicio corrido 5 min hacia atrás',
    )
    expect(translate('es', 'dash.nextFeeding', { time: '19:00', due: 'en 45 min' })).toBe(
      'Próxima toma 19:00 · en 45 min',
    )
  })

  it('deja a la vista una variable que falta en vez de borrarla', () => {
    expect(translate('en', 'offset.moved')).toBe('Start moved back {minutes} min')
  })

  it('elige singular o plural por count', () => {
    expect(translate('en', 'milk.counted', { count: 1 })).toBe('1 session counted')
    expect(translate('en', 'milk.counted', { count: 0 })).toBe('0 sessions counted')
    expect(translate('es', 'milk.counted', { count: 1 })).toBe('1 sesión contada')
    expect(translate('es', 'milk.counted', { count: 3 })).toBe('3 sesiones contadas')
    expect(translate('es', 'sync.offlinePending', { count: 2 })).toBe(
      'Sin conexión · 2 registros guardados en este dispositivo, todavía sin sincronizar.',
    )
  })
})

describe('detección de idioma', () => {
  it('sigue al dispositivo: es-* → español, cualquier otro → inglés', () => {
    expect(detectLang(['es-AR'])).toBe('es')
    expect(detectLang(['ES'])).toBe('es')
    expect(detectLang(['fr'])).toBe('en')
    expect(detectLang(['en-US', 'es-AR'])).toBe('en')
    expect(detectLang([])).toBe('en')
  })

  it('toma el primer idioma soportado de la lista de preferencias', () => {
    expect(detectLang(['fr-FR', 'es-MX'])).toBe('es')
    expect(detectLang(['de', 'en-GB', 'es'])).toBe('en')
  })

  it('una elección guardada gana; "system" y basura siguen al dispositivo', () => {
    expect(resolveLang('en', ['es-AR'])).toBe('en')
    expect(resolveLang('es', ['en-US'])).toBe('es')
    expect(resolveLang('system', ['es-AR'])).toBe('es')
    expect(resolveLang(null, ['fr'])).toBe('en')
    expect(resolveLang('klingon', ['es'])).toBe('es')
  })

  it('isLangChoice solo acepta los tres valores del selector', () => {
    expect(['en', 'es', 'system'].every(isLangChoice)).toBe(true)
    expect(isLangChoice('fr')).toBe(false)
    expect(isLangChoice(null)).toBe(false)
  })
})

/** Runs the inlined <head> script against a fake browser. */
function boot(saved: string | null, languages: string[], storageThrows = false) {
  const attrs = new Map<string, string>()
  const html = {
    lang: 'en',
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
  }
  runInNewContext(LANG_BOOT_SCRIPT, {
    document: { documentElement: html },
    navigator: { languages, language: languages[0] },
    localStorage: {
      getItem: (k: string) => {
        if (storageThrows) throw new Error('private mode')
        return k === LANG_KEY ? saved : null
      },
    },
    setTimeout: () => 0,
  })
  return { lang: html.lang, pending: attrs.has('data-lang-pending') }
}

describe('script de arranque (lib/i18n/boot.ts)', () => {
  const cases: [string | null, string[]][] = [
    [null, ['es-AR']],
    [null, ['en-US']],
    [null, ['fr']],
    [null, ['fr-FR', 'es-MX']],
    [null, ['en-GB', 'es']],
    ['system', ['es-AR']],
    ['en', ['es-AR']],
    ['es', ['en-US']],
    ['garbage', ['es']],
  ]

  it.each(cases)(
    'decide lo mismo que resolveLang (guardado %s, dispositivo %j)',
    (saved, langs) => {
      expect(boot(saved, langs).lang).toBe(resolveLang(saved, langs))
    },
  )

  it('oculta la página solo cuando el idioma no es el que mandó el server', () => {
    expect(boot(null, ['es-AR']).pending).toBe(true)
    expect(boot(null, ['en-US']).pending).toBe(false)
    expect(boot('en', ['es-AR']).pending).toBe(false)
  })

  it('sin localStorage sigue al dispositivo', () => {
    expect(boot(null, ['es-AR'], true).lang).toBe('es')
  })
})

describe('lib/format.ts en español (misma TZ del hogar)', () => {
  it('fechas y horas', () => {
    // 2026-01-16T03:00Z es todavía el 15 en Los Angeles — igual que en inglés.
    expect(clockTime('2026-01-15T16:00:00Z', 'es')).toBe('8:00')
    expect(longDate('2026-01-16T03:00:00Z', 'es')).toBe('jueves, 15 de enero')
    expect(apptWhen('2026-01-16T03:00:00Z', 'es')).toBe('jue, 15 ene, 19:00')
    expect(measuredOn('2026-01-15', 'es')).toBe('15 de enero de 2026')
  })

  it('relativos, duraciones y predicciones', () => {
    const now = Date.parse('2026-01-15T16:00:00Z')
    expect(timeAgo('2026-01-15T15:59:30Z', now, 'es')).toBe('recién')
    expect(timeAgo('2026-01-15T15:18:00Z', now, 'es')).toBe('hace 42 min')
    expect(timeAgo('2026-01-15T12:50:00Z', now, 'es')).toBe('hace 3 h 10 min')
    expect(timeAgo('2026-01-13T22:14:00Z', now, 'es')).toBe('mar, 14:14')
    expect(timeAgo(null, now, 'es')).toBe('nunca')
    expect(durationBetween('2026-01-15T16:00:00Z', '2026-01-15T18:15:00Z', 'es')).toBe('2 h 15 min')
    expect(dueRelative('2026-01-15T16:45:00Z', now, 'es')).toBe('en 45 min')
    expect(dueRelative('2026-01-15T15:50:00Z', now, 'es')).toBe('10 min de atraso')
    expect(dueRelative('2026-01-15T16:00:20Z', now, 'es')).toBe('toca ahora')
  })

  it('edad, con singular y plural', () => {
    const now = new Date('2026-01-16T03:00:00Z')
    expect(ageFrom('2026-01-14', now, 'es')).toBe('1 día')
    expect(ageFrom('2026-01-02', now, 'es')).toBe('13 días')
    expect(ageFrom('2026-01-01', now, 'es')).toBe('2 semanas')
    expect(ageFrom('2025-11-15', now, 'es')).toBe('2 meses')
    // Un mes justo ya no dice "1 months old" en inglés.
    expect(ageFrom('2025-11-15', new Date('2026-01-14T20:00:00Z'))).toBe('1 month old')
  })

  it('errores del formulario de crecimiento', () => {
    expect(growthInputToMetric(emptyGrowthInput(true), 'es')).toEqual({
      error: 'Ingresá un peso, una talla o los dos.',
    })
  })
})

describe('buildActivity en español', () => {
  const at = '2026-09-20T12:00:00.000Z'
  const entries = buildActivity(
    [{ id: 'f1', fed_at: at, feeding_type: 'bottle', amount_ml: 120, notes: null }],
    [{ id: 'n1', side: 'left', started_at: at, ended_at: at }],
    [{ id: 'd1', changed_at: at, diaper_type: 'wet', pending: true }],
    [{ id: 's1', started_at: at, ended_at: at, source: 'nuc_derived' }],
    0,
    'ml',
    'es',
  )
  const byId = (id: string) => entries.find((e) => e.id === id)!

  it('traduce el texto del feed y el detalle', () => {
    expect(byId('f1').what).toBe('Biberón · 120 ml')
    expect(byId('n1').what).toBe('Tomó pecho · izquierdo')
    expect(byId('n1').detail).toBe('Lado izquierdo')
    expect(byId('d1').what).toBe('Pañal · mojado · sin sincronizar')
    expect(byId('d1').detail).toBe('Mojado · sin sincronizar')
    expect(byId('s1').what).toBe('Se despertó (detectado)')
  })
})
