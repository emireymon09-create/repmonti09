import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { FLASH_MIN_MS, flashMs } from '@/lib/flash'
import { translate } from '@/lib/i18n'

// QA H5 (6 oct 2026): el aviso de D-9 ("1 oz no volvió a M8: ese biberón se
// desechó o ya tiene otra extracción.") salía en el mismo banner que
// "Guardado" y se iba a los 2,5 s — medido en el navegador: 2523 ms a la vista
// para una frase de 16 palabras. Es lo único que le dice a la familia que esa
// leche no volvió a la heladera (spec D-9: "la pantalla lo dice").

const READ_MS_PER_WORD = 250 // lectura rápida, de día; a las 3 a.m. es más lenta

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

describe('flashMs', () => {
  it('"Saved" / "Guardado" keeps the short flash it always had', () => {
    expect(flashMs(translate('en', 'common.saved'))).toBe(FLASH_MIN_MS)
    expect(flashMs(translate('es', 'common.deleted'))).toBe(FLASH_MIN_MS)
    expect(FLASH_MIN_MS).toBe(2500)
  })

  it('the D-9 notice stays long enough to be read, in both languages', () => {
    for (const lang of ['en', 'es'] as const) {
      const msg = [
        translate(lang, 'common.deleted'),
        translate(lang, 'milk.notReturned', { amount: '1 oz', label: 'M8' }),
      ].join(' ')
      expect(flashMs(msg)).toBeGreaterThanOrEqual(words(msg) * READ_MS_PER_WORD)
      expect(flashMs(msg)).toBeGreaterThan(FLASH_MIN_MS)
    }
  })

  it('grows with the text and never goes below the minimum', () => {
    expect(flashMs('')).toBe(FLASH_MIN_MS)
    expect(flashMs('a b c d e f g h i j k l m n o p q r s t')).toBeGreaterThan(
      flashMs('a b c d e f g h i j'),
    )
  })

  it('History and the section pages time their banner with it', () => {
    for (const file of ['app/history/page.tsx', 'components/SectionPage.tsx']) {
      const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
      expect(src, file).toMatch(/setTimeout\(\(\) => setFlash\(null\), flashMs\(message\)\)/)
    }
  })
})
