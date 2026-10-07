import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { exposeEnvToRouteHandlers } from '../helpers/supabase'
import { hasMilkV5 } from '../helpers/milkV5'
import { cleanupUiFamily, seedUiFamily, type UiFamily } from './seed'
import { en } from '@/lib/i18n/en'
import { es } from '@/lib/i18n/es'

// Matriz de layout: cada página × 4 viewports × ES/EN × tema, más Inicio con
// TODOS sus estados a la vez (dos combos: con y sin lactancia abierta), los
// menús abiertos y encadenados. El auditor (audit.browser.js) mide; acá solo
// se arma el estado y se junta la tabla. Cómo correrlo: tests/e2e/README.md.

const PORT = Number(process.env.E2E_PORT ?? 3107)
const BASE = `http://127.0.0.1:${PORT}`
const VIEWPORTS = (process.env.E2E_VIEWPORTS ?? '360x640,390x844,430x932,768x1024')
  .split(',')
  .map((s) => s.split('x').map(Number) as [number, number])
const LANGS = (process.env.E2E_LANGS ?? 'es,en').split(',') as ('es' | 'en')[]
const THEMES = (process.env.E2E_THEMES ?? 'dark,light').split(',')
const PAGES = (
  process.env.E2E_PAGES ??
  '/dashboard,/feeding,/diapers,/sleep,/pumping,/statistics,/growth,/appointments,/history,/settings,/version,/login'
).split(',')

const AUDIT_SRC = readFileSync(join(__dirname, 'audit.browser.js'), 'utf8')
const DICT = { en, es } as const

type Audit = {
  hscroll: number
  counts: Record<string, number>
  overlaps: unknown[]
  layers: unknown[]
  covered: unknown[]
  offViewport: unknown[]
  boxOverflow: unknown[]
  smallTargets: unknown[]
  lowContrast: unknown[]
}
type Cell = {
  page: string
  state: string
  vp: string
  lang: string
  theme: string
  menusOpen: number
  audit: Audit
  extra?: string[]
}

const CHECKS = [
  'hscroll',
  'overlaps',
  'layers',
  'covered',
  'offViewport',
  'boxOverflow',
  'smallTargets',
  'lowContrast',
] as const

function failsOf(c: Cell): string[] {
  const f: string[] = CHECKS.filter((k) => (c.audit.counts[k] ?? 0) > 0).map(
    (k) => `${k}=${c.audit.counts[k]}`,
  )
  if (c.menusOpen > 1) f.push(`menusOpen=${c.menusOpen}`)
  for (const e of c.extra ?? []) f.push(e)
  return f
}

async function audit(page: Page): Promise<Audit> {
  return page.evaluate(
    `(${AUDIT_SRC.replace(/^[\s\S]*?function ameliaAudit/, 'function ameliaAudit')})({ max: 6 })`,
  )
}

const SHOTS = process.env.E2E_SHOTS
async function shot(page: Page, c: Pick<Cell, 'page' | 'state' | 'vp' | 'lang' | 'theme'>) {
  if (!SHOTS) return
  const name = `${c.vp}-${c.lang}-${c.theme}${c.page.replace(/\//g, '_')}-${c.state}`.replace(
    /[^\w.+-]+/g,
    '_',
  )
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }).catch(() => {})
}

async function push(page: Page, c: Omit<Cell, 'audit' | 'menusOpen'>) {
  const cell: Cell = { ...c, audit: await audit(page), menusOpen: await menusOpen(page) }
  cells.push(cell)
  if (failsOf(cell).length) await shot(page, c)
  else if (process.env.E2E_SHOTS_ALL) await shot(page, c)
}

async function menusOpen(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll('[role="menu"]')).filter((m) => {
        const r = m.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }).length,
  )
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page
    .waitForFunction(() => !document.querySelector('.loading-note'), null, { timeout: 15_000 })
    .catch(() => {})
  // Hasta que termine de entrar: medir a mitad del fundido da contrastes falsos.
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, {
      timeout: 5_000,
    })
    .catch(() => {})
  await page.waitForTimeout(150)
}

let server: ChildProcess | undefined
let browser: Browser
const families: { a?: UiFamily; b?: UiFamily } = {}
const cells: Cell[] = []
let skip = false

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  if (!(await hasMilkV5())) {
    skip = true
    return
  }
  const up = await fetch(`${BASE}/login`).then(
    (r) => r.ok,
    () => false,
  )
  if (!up) {
    server = spawn('node', ['scripts/next-loopback.mjs', 'start', '-p', String(PORT)], {
      stdio: 'ignore',
    })
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (
        await fetch(`${BASE}/login`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break
    }
  }
  browser = await chromium.launch({ headless: true })
  families.a = await seedUiFamily('e2e-ui-a', { nursingActive: true })
  families.b = await seedUiFamily('e2e-ui-b', { nursingActive: false })
})

afterAll(async () => {
  await browser?.close()
  await cleanupUiFamily(families.a)
  await cleanupUiFamily(families.b)
  server?.kill('SIGTERM')
  const out = process.env.E2E_OUT ?? join(tmpdir(), 'amelia-layout.json')
  writeFileSync(out, JSON.stringify(cells, null, 1))
  const rows = cells.map((c) => {
    const f = failsOf(c)
    return `${f.length ? 'FAIL' : 'PASS'} | ${c.vp} | ${c.lang} | ${c.theme} | ${c.page} | ${c.state} | hs=${c.audit.hscroll} ov=${c.audit.counts.overlaps} ly=${c.audit.counts.layers} cov=${c.audit.counts.covered} off=${c.audit.counts.offViewport} box=${c.audit.counts.boxOverflow} tap=${c.audit.counts.smallTargets} con=${c.audit.counts.lowContrast} menus=${c.menusOpen}${f.length ? ' | ' + f.join(' ') : ''}`
  })
  console.log(['RESULTADO | vp | idioma | tema | página | estado | medidas', ...rows].join('\n'))
  console.log(
    `celdas=${cells.length} fail=${cells.filter((c) => failsOf(c).length).length} json=${out}`,
  )
})

async function newContext(lang: string, theme: string, vp: [number, number]) {
  const ctx = await browser.newContext({
    viewport: { width: vp[0], height: vp[1] },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    locale: lang === 'es' ? 'es-AR' : 'en-US',
    timezoneId: 'America/Los_Angeles',
  })
  await ctx.addInitScript(
    ([l, t]) => {
      try {
        localStorage.setItem('amelia:lang', l)
        localStorage.setItem('amelia:theme', t)
      } catch {}
    },
    [lang, theme],
  )
  return ctx
}

async function login(ctx: BrowserContext, fam: UiFamily) {
  const page = await ctx.newPage()
  await page.goto(`${BASE}/login`)
  await page.fill('#email', fam.email)
  await page.fill('#password', fam.password)
  await Promise.all([
    page.waitForURL('**/dashboard', { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ])
  await page.close()
}

/** Mide la página tal cual, con el menú abierto, con un ⋯ abierto y encadenados. */
async function measure(
  page: Page,
  base: Omit<Cell, 'state' | 'audit' | 'menusOpen'>,
  state: string,
) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await push(page, { ...base, state })

  // El menú de navegación, desde la barra: abre, se mide, Escape lo cierra y
  // el foco vuelve al botón.
  await page.click('button.gear')
  await page.waitForTimeout(100)
  const extraMenu: string[] = []
  await push(page, { ...base, state: `${state}+menú`, extra: extraMenu })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(60)
  const afterEsc = await page.evaluate(() => ({
    open: document.querySelectorAll('.nav-menu').length,
    focus: document.activeElement?.className ?? '',
  }))
  if (afterEsc.open !== 0) extraMenu.push('escNoCierra')
  if (!String(afterEsc.focus).includes('gear')) extraMenu.push('focoNoVuelve')

  // El ⋯ de la ÚLTIMA fila (la que queda pegada a la barra) y el encadenado.
  const kebabs = page.locator('button.kebab:not([disabled])')
  const n = await kebabs.count()
  if (n > 0) {
    const last = kebabs.nth(n - 1)
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight))
    await last.scrollIntoViewIfNeeded()
    await last.click()
    await page.waitForTimeout(80)
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight))
    await page.waitForTimeout(60)
    const extraRow: string[] = []
    await push(page, { ...base, state: `${state}+⋯última`, extra: extraRow })
    // Encadenado: con el ⋯ abierto, abrir el menú de navegación. La política
    // es "uno a la vez": el nuevo reemplaza al anterior.
    await page.click('button.gear')
    await page.waitForTimeout(100)
    await push(page, { ...base, state: `${state}+⋯→menú` })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(60)
    // Y al revés: menú abierto, tocar un ⋯ que el menú NO tape (tocar uno
    // tapado sería tocar un enlace del menú, y eso navega).
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.click('button.gear')
    await page.waitForTimeout(80)
    const freeIdx = await page.evaluate(() => {
      const menu = document.querySelector('.nav-menu')?.getBoundingClientRect()
      const ks = Array.from(
        document.querySelectorAll<HTMLButtonElement>('button.kebab:not([disabled])'),
      )
      return ks.findIndex((k) => {
        const r = k.getBoundingClientRect()
        const inView = r.top >= 0 && r.bottom <= window.innerHeight
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        const free =
          !menu ||
          r.bottom < menu.top ||
          r.top > menu.bottom ||
          r.right < menu.left ||
          r.left > menu.right
        return inView && free && !!hit && k.contains(hit)
      })
    })
    if (freeIdx >= 0) {
      await kebabs.nth(freeIdx).click()
      await page.waitForTimeout(100)
      await push(page, { ...base, state: `${state}+menú→⋯` })
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(60)
    // Activación SIN puntero (lo que hace un lector de pantalla: un `click`
    // sin pointerdown y sin mover el foco). Política: uno a la vez.
    await page.click('button.gear')
    await page.waitForTimeout(80)
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('button.kebab:not([disabled])')?.click(),
    )
    await page.waitForTimeout(100)
    await push(page, { ...base, state: `${state}+menú→⋯(sin puntero)` })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(60)
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('button.kebab:not([disabled])')?.click(),
    )
    await page.waitForTimeout(80)
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('button.gear')?.click())
    await page.waitForTimeout(100)
    await push(page, { ...base, state: `${state}+⋯→menú(sin puntero)` })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(60)
    // Y el foco: abrir el primer ⋯ con el teclado.
    await page.evaluate(() => window.scrollTo(0, 0))
    await kebabs.first().focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(80)
    // Escape cierra el ⋯ y devuelve el foco a ESE botón.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(60)
    const rowEsc = await page.evaluate(() => ({
      open: document.querySelectorAll('.row-menu-list').length,
      focus: document.activeElement?.className ?? '',
    }))
    if (rowEsc.open !== 0) extraRow.push('escNoCierra⋯')
    if (!String(rowEsc.focus).includes('kebab')) extraRow.push('focoNoVuelve⋯')
  }
}

/** Corta la red y anota un pañal: queda en la cola, "sin sincronizar". */
async function goOfflineWithPending(ctx: BrowserContext, page: Page, wet: string) {
  await ctx.setOffline(true)
  await page.waitForFunction(() => !navigator.onLine, null, { timeout: 5_000 })
  const btn = page.getByRole('button', { name: wet, exact: true }).first()
  await btn.waitFor({ state: 'visible' })
  await page.waitForFunction(
    (el) => !(el as HTMLButtonElement).disabled,
    await btn.elementHandle(),
    {
      timeout: 10_000,
    },
  )
  await btn.click()
  await page.waitForSelector('.pending-tag, .syncbar.has-pending', { timeout: 20_000 })
  await page.waitForTimeout(200)
}

/** Arma un estado y lo mide; si no se pudo armar, la celda es FAIL con el motivo. */
async function stateCell(
  page: Page,
  base: Omit<Cell, 'state' | 'audit' | 'menusOpen'>,
  state: string,
  arrange: () => Promise<void>,
) {
  try {
    await arrange()
  } catch (e) {
    await shot(page, { ...base, state: `${state}-ERROR` })
    cells.push({
      ...base,
      state,
      audit: {
        hscroll: 0,
        counts: {},
        overlaps: [],
        layers: [],
        covered: [],
        offViewport: [],
        boxOverflow: [],
        smallTargets: [],
        lowContrast: [],
      },
      menusOpen: 0,
      extra: [
        `noSeArmó:${String((e as Error).message)
          .split('\n')[0]
          .slice(0, 120)}`,
      ],
    })
    return
  }
  await measure(page, base, state)
}

describe('layout: matriz completa', () => {
  it('mide cada celda', async () => {
    if (skip) return
    const { a, b } = families as { a: UiFamily; b: UiFamily }
    for (const vp of VIEWPORTS) {
      for (const lang of LANGS) {
        for (const theme of THEMES) {
          const tag = { vp: `${vp[0]}x${vp[1]}`, lang, theme }
          const t = DICT[lang]

          // Combo B: sin lactancia → receta, avisos de fórmula, empezado
          // vencido, enfriando, sueño abierto, turno, panel del biberón y cola.
          const ctxB = await newContext(lang, theme, vp)
          await ctxB.clock.setFixedTime(b.t0 + 60_000)
          await login(ctxB, b)
          const pB = await ctxB.newPage()
          for (const path of PAGES.filter((p) => p !== '/login')) {
            await pB.goto(`${BASE}${path}`)
            await settle(pB)
            await measure(pB, { page: path, ...tag }, 'datos')
          }
          await stateCell(
            pB,
            { page: '/dashboard', ...tag },
            'comboB+biberón+offline',
            async () => {
              await pB.goto(`${BASE}/dashboard`)
              await settle(pB)
              await pB.getByRole('button', { name: t['dash.bottle'], exact: true }).click()
              await pB.waitForTimeout(150)
              await goOfflineWithPending(ctxB, pB, t['diaperButton.wet'])
            },
          )
          await ctxB.setOffline(false)
          await pB
            .waitForFunction(() => !document.querySelector('.syncbar.has-pending'), null, {
              timeout: 30_000,
            })
            .catch(() => {})
          await ctxB.close()

          // Combo A: lactancia Y sueño abiertos + toda la leche + cola.
          const ctxA = await newContext(lang, theme, vp)
          await ctxA.clock.setFixedTime(a.t0 + 60_000)
          await login(ctxA, a)
          const pA = await ctxA.newPage()
          await stateCell(
            pA,
            { page: '/dashboard', ...tag },
            'comboA+lactancia+sueño+offline',
            async () => {
              await pA.goto(`${BASE}/dashboard`)
              await settle(pA)
              await goOfflineWithPending(ctxA, pA, t['diaperButton.wet'])
            },
          )
          await ctxA.setOffline(false)
          await ctxA.close()

          // Sin sesión.
          if (PAGES.includes('/login')) {
            const ctxL = await newContext(lang, theme, vp)
            const pL = await ctxL.newPage()
            await pL.goto(`${BASE}/login`)
            await settle(pL)
            await push(pL, { page: '/login', ...tag, state: 'sin sesión' })
            await ctxL.close()
          }
        }
      }
    }
    const failed = cells.filter((c) => failsOf(c).length)
    expect(
      failed.map(
        (c) => `${c.vp} ${c.lang} ${c.theme} ${c.page} ${c.state}: ${failsOf(c).join(' ')}`,
      ),
    ).toEqual([])
  })
})
