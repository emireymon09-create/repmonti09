// Auditor de layout que corre DENTRO de la página (page.evaluate). JS plano y
// sin imports a propósito: se serializa como texto, así que no puede depender
// de nada de afuera ni de helpers que agregue el transpilador.
//
// Mide, no opina. Devuelve números y los primeros casos de cada falla:
//  - hscroll: scroll horizontal de la página (px).
//  - overlaps: pares de texto/controles/íconos del flujo cuyos rectángulos se
//    intersectan (> 1 px en las dos dimensiones) sin que uno contenga al otro.
//  - layers: pares de capas (position fixed/sticky/absolute o role=menu
//    abierto) que se intersectan entre sí.
//  - covered: controles de una capa abierta (menú) que NO son lo que está
//    arriba en su centro (otra cosa los tapa: p. ej. la barra de abajo).
//  - offViewport: elementos visibles que se salen del ancho de la ventana, o
//    ítems de un menú abierto que quedan fuera del alto.
//  - boxOverflow: contenedores cuyo contenido se sale de su caja
//    (scrollWidth - clientWidth > 1) — la métrica de CLAUDE.md §6 (v0.10.3).
//  - smallTargets: controles habilitados de menos de 44 px en alguna dimensión.
//  - lowContrast: texto por debajo de 4.5:1 (3:1 si es grande), con el fondo
//    efectivo y la opacidad de los ancestros compuestos.
// eslint-disable-next-line no-unused-vars
function ameliaAudit(opts) {
  const MAX = (opts && opts.max) || 6
  const vw = window.innerWidth
  const vh = window.innerHeight
  const out = {
    vw,
    vh,
    hscroll: 0,
    overlaps: [],
    layers: [],
    covered: [],
    offViewport: [],
    boxOverflow: [],
    smallTargets: [],
    lowContrast: [],
    counts: {},
  }
  const se = document.scrollingElement || document.documentElement
  out.hscroll = Math.max(0, se.scrollWidth - se.clientWidth)

  const desc = (el) => {
    if (!el) return '?'
    let s = el.tagName.toLowerCase()
    if (el.id) s += '#' + el.id
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3)
    if (cls.length) s += '.' + cls.join('.')
    const txt = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')
    if (txt) s += ' "' + txt.slice(0, 40) + '"'
    return s
  }
  const isShown = (el) => {
    // checkVisibility ve lo que el CSS no dice: el contenido de un <details>
    // cerrado tiene caja pero no se pinta (content-visibility).
    if (
      el.checkVisibility &&
      !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })
    )
      return false
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
    }
    const r = el.getBoundingClientRect()
    return r.width > 0.5 && r.height > 0.5
  }
  const inter = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return w > 1 && h > 1 ? { w: +w.toFixed(1), h: +h.toFixed(1) } : null
  }
  const nav = document.querySelector('nav.nav')
  const openMenus = Array.from(document.querySelectorAll('[role="menu"]')).filter(isShown)
  const inLayer = (el) => openMenus.some((m) => m.contains(el))
  const inNav = (el) => !!(nav && nav.contains(el))

  // ---------- ítems del flujo: líneas de texto, controles, íconos ----------
  const CONTROL =
    'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="radio"], [role="switch"], [role="menuitem"], [role="tab"]'
  const items = []
  const controls = Array.from(document.querySelectorAll(CONTROL)).filter(isShown)
  const controlOf = (el) => (el.closest ? el.closest(CONTROL) : null)
  for (const c of controls) {
    if (c.matches('input[type="checkbox"], input[type="radio"]') && c.closest('label')) continue
    items.push({ kind: 'control', el: c, owner: c, r: c.getBoundingClientRect() })
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue
    const p = n.parentElement
    if (!p || p.closest('script, style, noscript, title')) continue
    if (!isShown(p)) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 0.5 || r.height < 0.5) continue
      items.push({ kind: 'text', el: p, owner: controlOf(p) || p, r, text: n.nodeValue.trim() })
    }
  }
  for (const svg of Array.from(document.querySelectorAll('svg')).filter(isShown)) {
    if (controlOf(svg)) continue
    items.push({ kind: 'icon', el: svg, owner: svg, r: svg.getBoundingClientRect() })
  }
  out.counts.items = items.length

  const related = (a, b) =>
    a.owner === b.owner || a.owner.contains(b.owner) || b.owner.contains(a.owner)
  const flow = items.filter((i) => !inLayer(i.el) && !inNav(i.el))
  flow.sort((a, b) => a.r.top - b.r.top)
  let overlapCount = 0
  for (let i = 0; i < flow.length; i++) {
    const a = flow[i]
    for (let j = i + 1; j < flow.length; j++) {
      const b = flow[j]
      if (b.r.top >= a.r.bottom) break
      if (related(a, b)) continue
      // Dos líneas del MISMO nodo de texto nunca se pisan; dos rects de la
      // misma etiqueta (texto partido por <span>) tampoco cuentan.
      if (a.el === b.el && a.kind === 'text' && b.kind === 'text') continue
      const x = inter(a.r, b.r)
      if (!x) continue
      overlapCount++
      if (out.overlaps.length < MAX) out.overlaps.push({ a: desc(a.owner), b: desc(b.owner), ...x })
    }
  }
  out.counts.overlaps = overlapCount

  // ---------- capas ----------
  const layerEls = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const pos = getComputedStyle(el).position
    return (pos === 'fixed' || pos === 'sticky' || pos === 'absolute') && isShown(el)
  })
  for (const m of openMenus) if (!layerEls.includes(m)) layerEls.push(m)
  out.counts.layers = layerEls.length
  out.layerList = layerEls.map((el) => {
    const cs = getComputedStyle(el)
    return { el: desc(el), position: cs.position, zIndex: cs.zIndex }
  })
  let layerHits = 0
  for (let i = 0; i < layerEls.length; i++) {
    for (let j = i + 1; j < layerEls.length; j++) {
      const a = layerEls[i]
      const b = layerEls[j]
      if (a.contains(b) || b.contains(a)) continue
      // La barra sticky viaja con el scroll sobre el contenido; contra una capa
      // EN FLUJO (el ícono de una tarjeta) cruzarse al scrollear es scroll, no
      // un encimado. Contra un menú abierto sí cuenta (y lo mide `covered`).
      // Un menú abierto TAPA lo que tiene debajo: para eso existe. Lo que se
      // mide de un menú es que quede ARRIBA y entero (`covered`, `offViewport`),
      // salvo contra la barra, que es la otra capa que flota.
      const posA = getComputedStyle(a).position
      const posB = getComputedStyle(b).position
      const menuA = a.getAttribute('role') === 'menu'
      const menuB = b.getAttribute('role') === 'menu'
      if (menuA && posB !== 'sticky' && posB !== 'fixed') continue
      if (menuB && posA !== 'sticky' && posA !== 'fixed') continue
      if ((posA === 'sticky' && !menuB) || (posB === 'sticky' && !menuA)) continue
      const x = inter(a.getBoundingClientRect(), b.getBoundingClientRect())
      if (x) {
        layerHits++
        if (out.layers.length < MAX) out.layers.push({ a: desc(a), b: desc(b), ...x })
      }
    }
  }
  out.counts.layers = layerHits

  // ---------- menús abiertos: ¿se ven, están arriba, entran? ----------
  // La CAJA del menú tiene que entrar entera en la ventana. Un menú largo en
  // un teléfono bajo scrollea por dentro (max-height): cada ítem se trae a la
  // vista dentro de su menú antes de preguntar quién está arriba en su centro.
  const topmost = (it, r) => {
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + 2],
      [r.right - 2, r.bottom - 2],
    ]
    for (const [x, y] of pts) {
      const top = document.elementFromPoint(x, y)
      if (top && !it.contains(top) && !top.contains(it))
        return { by: desc(top), x: Math.round(x), y: Math.round(y) }
    }
    return null
  }
  for (const m of openMenus) {
    const mr = m.getBoundingClientRect()
    if (mr.top < -1 || mr.bottom > vh + 1 || mr.left < -1 || mr.right > vw + 1) {
      out.offViewport.push({
        el: desc(m),
        top: +mr.top.toFixed(1),
        bottom: +mr.bottom.toFixed(1),
        vh,
      })
      continue
    }
    for (const it of Array.from(m.querySelectorAll('[role="menuitem"]')).filter(isShown)) {
      const sy = window.scrollY
      let scroller = it.parentElement
      while (scroller && scroller !== m.parentElement) {
        const oy = getComputedStyle(scroller).overflowY
        if (oy === 'auto' || oy === 'scroll') break
        scroller = scroller.parentElement
      }
      if (scroller && scroller !== m.parentElement) {
        const sr = scroller.getBoundingClientRect()
        const ir = it.getBoundingClientRect()
        if (ir.top < sr.top) scroller.scrollTop -= sr.top - ir.top
        else if (ir.bottom > sr.bottom) scroller.scrollTop += ir.bottom - sr.bottom
      }
      window.scrollTo(window.scrollX, sy)
      const r = it.getBoundingClientRect()
      if (r.top < -1 || r.bottom > vh + 1 || r.left < -1 || r.right > vw + 1) {
        out.offViewport.push({
          el: desc(it),
          top: +r.top.toFixed(1),
          bottom: +r.bottom.toFixed(1),
          vh,
        })
        continue
      }
      const hit = topmost(it, r)
      if (hit) out.covered.push({ el: desc(it), ...hit })
    }
  }

  // ---------- ancho de ventana ----------
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!isShown(el)) continue
    const r = el.getBoundingClientRect()
    if (r.right > vw + 1 || r.left < -1) {
      // Un hijo de algo que ya se reportó no suma ruido.
      if (out.offViewport.some((o) => o.node && o.node.contains(el))) continue
      out.offViewport.push({
        node: el,
        el: desc(el),
        left: +r.left.toFixed(1),
        right: +r.right.toFixed(1),
        vw,
      })
    }
  }
  out.offViewport = out.offViewport.map(({ node, ...rest }) => rest)
  out.counts.offViewport = out.offViewport.length
  out.offViewport = out.offViewport.slice(0, MAX)

  // ---------- cajas que desbordan ----------
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!isShown(el)) continue
    if (el.matches('input, select, textarea, svg, svg *, html, body, nav.nav')) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'inline') continue
    const over = el.scrollWidth - el.clientWidth
    if (over > 1 && el.clientWidth > 0) {
      out.boxOverflow.push({ el: desc(el), over })
    }
  }
  out.counts.boxOverflow = out.boxOverflow.length
  out.boxOverflow = out.boxOverflow.slice(0, MAX)

  // ---------- objetivos táctiles ----------
  for (const c of controls) {
    if (c.disabled || c.getAttribute('aria-disabled') === 'true') continue
    let target = c
    if (c.matches('input[type="checkbox"], input[type="radio"]')) target = c.closest('label') || c
    const r = target.getBoundingClientRect()
    if (r.width < 44 - 0.5 || r.height < 44 - 0.5) {
      out.smallTargets.push({ el: desc(target), w: +r.width.toFixed(1), h: +r.height.toFixed(1) })
    }
  }
  out.counts.smallTargets = out.smallTargets.length
  out.smallTargets = out.smallTargets.slice(0, MAX)

  // ---------- botones que no se ven como botones ----------
  // Un `.btn` (sea <button> o un <a> con esa clase) lleva el texto centrado
  // en vertical y sin subrayado. Un enlace con forma de botón heredaba el
  // subrayado y el texto arriba a la izquierda.
  out.btnText = []
  for (const b of Array.from(document.querySelectorAll('.btn')).filter(isShown)) {
    const cs = getComputedStyle(b)
    const br = b.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(b)
    const tr = range.getBoundingClientRect()
    const dy = Math.abs(tr.top + tr.height / 2 - (br.top + br.height / 2))
    const underline = cs.textDecorationLine.includes('underline')
    if (underline || (tr.height > 0 && dy > 4))
      out.btnText.push({ el: desc(b), dy: +dy.toFixed(1), underline })
  }
  out.counts.btnText = out.btnText.length
  out.btnText = out.btnText.slice(0, MAX)

  // ---------- contraste ----------
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  })
  const lum = (c) => {
    const f = (v) => {
      v /= 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const bgOf = (el) => {
    const stack = []
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor)
      if (c && c.a > 0) stack.push(c)
      if (c && c.a >= 1) break
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 }
    for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg)
    return bg
  }
  const seen = new Set()
  let lowCount = 0
  for (const it of items) {
    if (it.kind !== 'text' || seen.has(it.el)) continue
    seen.add(it.el)
    const ctl = controlOf(it.el)
    if (ctl && (ctl.disabled || ctl.getAttribute('aria-disabled') === 'true')) continue
    const cs = getComputedStyle(it.el)
    let fg = parse(cs.color)
    if (!fg) continue
    let opacity = 1
    for (let e = it.el; e && e.nodeType === 1; e = e.parentElement)
      opacity *= Number(getComputedStyle(e).opacity)
    const bg = bgOf(it.el)
    fg = over({ ...fg, a: fg.a * opacity }, bg)
    const l1 = lum(fg)
    const l2 = lum(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    const size = parseFloat(cs.fontSize)
    const bold = Number(cs.fontWeight) >= 700
    // Un glifo suelto que no es letra ni número (✓, ⋯, →) funciona como ícono:
    // se mide como gráfico (WCAG 1.4.11, 3:1), no como texto.
    const glyph = !/[\p{L}\p{N}]/u.test(it.text)
    const min = glyph || size >= 24 || (bold && size >= 18.66) ? 3 : 4.5
    if (ratio < min - 0.01) {
      lowCount++
      if (out.lowContrast.length < MAX)
        out.lowContrast.push({ el: desc(it.el), ratio: +ratio.toFixed(2), min })
    }
  }
  out.counts.lowContrast = lowCount
  // Informativo (no es FAIL): alto del documento y del renglón que reserva el
  // atajo de cada tarjeta, para medir el costo de no encimar.
  out.docH = Math.round(se.scrollHeight)
  out.quickRow = Array.from(document.querySelectorAll('.card.has-quick > .card-quick + *')).map(
    (e) => +e.getBoundingClientRect().height.toFixed(1),
  )
  out.counts.hscroll = out.hscroll
  out.counts.covered = out.covered.length
  return out
}
