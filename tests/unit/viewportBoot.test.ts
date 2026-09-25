import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { VIEWPORT_BOOT_SCRIPT, VIEWPORT_VAR } from '@/lib/viewportBoot'

type Focusable = { tagName: string; isContentEditable?: boolean } | null

/**
 * Corre el script inlineado del <head> contra un navegador falso y devuelve
 * los mandos para moverlo: cambiar el alto, disparar eventos, mover el foco.
 */
function boot({ innerHeight = 844, hasVisualViewport = true } = {}) {
  const props = new Map<string, string>()
  const listeners = new Map<string, (() => void)[]>()
  const vvListeners = new Map<string, (() => void)[]>()
  const deferred: (() => void)[] = []

  const doc = {
    documentElement: { style: { setProperty: (k: string, v: string) => props.set(k, v) } },
    activeElement: null as Focusable,
  }
  const win = {
    innerHeight,
    visualViewport: hasVisualViewport
      ? {
          addEventListener: (k: string, fn: () => void) => {
            if (!vvListeners.has(k)) vvListeners.set(k, [])
            vvListeners.get(k)!.push(fn)
          },
        }
      : undefined,
  }

  const ctx: Record<string, unknown> = {
    document: doc,
    window: win,
    visualViewport: win.visualViewport,
    addEventListener: (k: string, fn: () => void) => {
      if (!listeners.has(k)) listeners.set(k, [])
      listeners.get(k)!.push(fn)
    },
    // El script difiere el reintento de `focusout` un tick; acá se junta y se
    // corre a mano con flush(), para que el test no dependa de timers reales.
    setTimeout: (fn: () => void) => {
      deferred.push(fn)
      return 0
    },
  }
  runInNewContext(VIEWPORT_BOOT_SCRIPT, ctx)

  return {
    value: () => props.get(VIEWPORT_VAR),
    writes: () => props.size,
    resize: (h: number) => {
      win.innerHeight = h
      listeners.get('resize')?.forEach((fn) => fn())
    },
    vvResize: (h: number) => {
      win.innerHeight = h
      vvListeners.get('resize')?.forEach((fn) => fn())
    },
    fire: (evt: string) => listeners.get(evt)?.forEach((fn) => fn()),
    focus: (el: Focusable) => {
      doc.activeElement = el
    },
    flush: () => {
      const queued = deferred.splice(0)
      queued.forEach((fn) => fn())
    },
    listenerNames: () => [...listeners.keys()].sort(),
    hasVvListener: () => (vvListeners.get('resize')?.length ?? 0) > 0,
  }
}

describe('script de arranque del viewport (lib/viewportBoot.ts)', () => {
  it('escribe el alto medido en píxeles antes de cualquier evento', () => {
    const b = boot({ innerHeight: 844 })
    expect(b.value()).toBe('844px')
  })

  it('vuelve a medir cuando la ventana cambia de alto', () => {
    const b = boot({ innerHeight: 844 })
    b.resize(812)
    expect(b.value()).toBe('812px')
    b.vvResize(700)
    expect(b.value()).toBe('700px')
  })

  it('escucha los cuatro eventos de ventana y el del visual viewport', () => {
    const b = boot()
    expect(b.listenerNames()).toEqual(['focusout', 'orientationchange', 'pageshow', 'resize'])
    expect(b.hasVvListener()).toBe(true)
  })

  it('no explota sin visualViewport', () => {
    const b = boot({ hasVisualViewport: false })
    expect(b.value()).toBe('844px')
    expect(b.hasVvListener()).toBe(false)
  })

  // El guard del teclado. En Android Chrome el teclado achica innerHeight; sin
  // esto, abrir el teclado subiría la barra por encima del contenido.
  for (const el of [
    { tagName: 'INPUT' },
    { tagName: 'TEXTAREA' },
    { tagName: 'SELECT' },
    { tagName: 'DIV', isContentEditable: true },
  ]) {
    it(`no actualiza mientras hay foco en ${el.tagName}${el.isContentEditable ? ' (contenteditable)' : ''}`, () => {
      const b = boot({ innerHeight: 844 })
      b.focus(el)
      b.resize(420) // el teclado "abre"
      expect(b.value()).toBe('844px')
    })
  }

  it('un DIV común no cuenta como campo: sí actualiza', () => {
    const b = boot({ innerHeight: 844 })
    b.focus({ tagName: 'DIV' })
    b.resize(420)
    expect(b.value()).toBe('420px')
  })

  it('aplica la medición pendiente al salir del campo', () => {
    const b = boot({ innerHeight: 844 })
    b.focus({ tagName: 'INPUT' })
    b.resize(420)
    expect(b.value()).toBe('844px')

    // El teclado se cierra y el foco se va: recién ahí se mide.
    b.focus(null)
    b.fire('focusout')
    b.flush()
    expect(b.value()).toBe('420px')
  })

  it('saltar de un campo al siguiente no cuenta como salir', () => {
    const b = boot({ innerHeight: 844 })
    b.focus({ tagName: 'INPUT' })
    b.resize(420)

    // focusout del primero; el diferido corre cuando el segundo ya tiene foco.
    b.fire('focusout')
    b.focus({ tagName: 'INPUT' })
    b.flush()
    expect(b.value()).toBe('844px')

    // Y cuando de verdad se sale, la medición pendiente se aplica.
    b.focus(null)
    b.fire('focusout')
    b.flush()
    expect(b.value()).toBe('420px')
  })

  it('un focusout sin nada pendiente no escribe de nuevo', () => {
    const b = boot({ innerHeight: 844 })
    const before = b.writes()
    b.fire('focusout')
    b.flush()
    expect(b.writes()).toBe(before)
  })
})
