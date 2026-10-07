import { describe, expect, it } from 'vitest'
import { createPopoverBus, placePopover } from '@/lib/popover'

describe('popoverBus: uno solo abierto a la vez', () => {
  it('abrir uno cierra a todos los demás, nunca a sí mismo', () => {
    const bus = createPopoverBus()
    const closed: string[] = []
    bus.subscribe('menu', () => closed.push('menu'))
    bus.subscribe('fila-1', () => closed.push('fila-1'))
    bus.subscribe('fila-2', () => closed.push('fila-2'))
    bus.opened('fila-1')
    expect(closed.sort()).toEqual(['fila-2', 'menu'])
  })

  it('una baja deja de recibir avisos, y una baja vieja no borra a la nueva', () => {
    const bus = createPopoverBus()
    const closed: string[] = []
    const off = bus.subscribe('menu', () => closed.push('viejo'))
    off()
    bus.opened('fila')
    expect(closed).toEqual([])
    const offViejo = bus.subscribe('menu', () => closed.push('viejo'))
    bus.subscribe('menu', () => closed.push('nuevo'))
    offViejo()
    bus.opened('fila')
    expect(closed).toEqual(['nuevo'])
  })
})

describe('placePopover: abre donde entra', () => {
  // 390×844 con la barra de abajo arrancando en 782: el caso medido de
  // /history, el ⋯ de la última fila.
  const base = { limitTop: 0, limitBottom: 782, gap: 4, popoverHeight: 100 }

  it('abajo cuando entra abajo', () => {
    expect(placePopover({ ...base, anchorTop: 300, anchorBottom: 344 })).toBe('down')
  })

  it('arriba cuando abajo lo taparía la barra (el defecto de /history)', () => {
    expect(placePopover({ ...base, anchorTop: 720, anchorBottom: 764 })).toBe('up')
  })

  it('el borde exacto: 678 + 4 + 100 = 782 entra abajo; un píxel más, arriba', () => {
    expect(placePopover({ ...base, anchorTop: 634, anchorBottom: 678 })).toBe('down')
    expect(placePopover({ ...base, anchorTop: 635, anchorBottom: 679 })).toBe('up')
  })

  it('si no entra en ninguno, el lado con más lugar', () => {
    const tall = { ...base, popoverHeight: 900 }
    expect(placePopover({ ...tall, anchorTop: 100, anchorBottom: 144 })).toBe('down')
    expect(placePopover({ ...tall, anchorTop: 700, anchorBottom: 744 })).toBe('up')
  })
})
