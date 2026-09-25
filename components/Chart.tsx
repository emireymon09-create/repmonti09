'use client'

/**
 * Las dos gráficas de /statistics. SVG inline, dibujado a mano.
 *
 * POR QUÉ A MANO Y NO CON UNA LIBRERÍA
 * ------------------------------------
 * Este repo no tiene ninguna instalada —package.json tiene seis dependencias
 * de runtime y ninguna es de gráficas— y los trece íconos del nav ya son SVG
 * de trazo escritos a mano (design.md §8). Traer una librería de gráficas por
 * dos formas sería agregar un bundle entero a una app que tiene que abrir sin
 * conexión y renderizar en una pantalla de pared en modo kiosco.
 *
 * REGLAS QUE ESTO RESPETA (design.md)
 * -----------------------------------
 *   · **Ni un hex ni un px acá.** Los colores salen de `currentColor` y de
 *     `var(--c-…)` en el CSS; el tamaño sale de `viewBox` + el `aspect-ratio`
 *     de `.chart`, así que la misma gráfica escala sola de la columna del
 *     teléfono a la pared sin un segundo componente (§1: no se bifurca).
 *   · El `viewBox` es una grilla propia de 100×60 — coordenadas sin unidad,
 *     no píxeles. Un px en un `viewBox` no es un px en pantalla.
 *   · **No compite con `.card.is-live`** (§2, economía del color): las barras
 *     van en `--c-accent`, que ya es el color de "esto es un dato", y la
 *     línea de peso también. El borde de color sigue gastándose en un solo
 *     lugar, la sesión en curso.
 *   · **Accesible:** el `<svg>` lleva `role="img"` y un `aria-label` que dice
 *     los valores en palabras. Una gráfica que solo existe como dibujo es una
 *     gráfica que a las 3 de la mañana, con el teléfono leyendo en voz alta,
 *     no dice nada.
 *
 * LAS ETIQUETAS DEL EJE SON HTML, NO `<text>` DENTRO DEL SVG (24 sep 2026)
 * -----------------------------------------------------------------------
 * `preserveAspectRatio="none"` es lo que deja que la gráfica llene el ancho
 * de la tarjeta, pero estira los ejes X e Y por separado — y eso **deforma
 * cualquier texto que viva adentro**. Medido con `<text>` adentro:
 *
 *   390px  → escala X 3,24 / Y 3,04 → deformación 1,07× ; "Mon" 34,1×18,4 px
 *   1440px → escala X 4,01 / Y 2,86 → deformación **1,40×** ; "Mon" 42,2×16,4
 *
 * O sea: en la PARED, que es el objetivo primario de diseño (design.md §1),
 * las letras salían un 40 % más anchas que altas, y con 14,3 px de alto
 * efectivo — **más chicas que en el teléfono**, que es exactamente al revés de
 * lo que esa pantalla necesita. Sacándolas del SVG el texto vuelve a ser texto
 * de la página: sin deformar, y con `--t-meta`, que ya se re-apunta de 12 px a
 * 17 px en el breakpoint de 1180px.
 *
 * El `<svg>` se quedó solo con geometría (barras, línea, puntos), y el eje
 * pasó a ser un borde en CSS: un `<line>` dentro de un viewBox estirado
 * tampoco tenía por qué seguir ahí.
 */

import { useT } from '@/lib/i18n/react'

const VIEW_W = 100
const VIEW_H = 50

export type ChartPoint = {
  /** La etiqueta del eje: un día, una medición. */
  label: string
  value: number
  /** Cómo se dice el valor en voz alta ("3 feedings", "5.1 oz"). */
  spoken: string
}

function summary(title: string, points: readonly ChartPoint[], t: ReturnType<typeof useT>['t']) {
  return t('stats.chartSummary', {
    title,
    values: points
      .map((p) => t('stats.chartDayValue', { day: p.label, value: p.spoken }))
      .join(', '),
  })
}

/**
 * Barras por día. Es la forma correcta para "cuántas veces pasó algo cada
 * día": cantidades discretas que se comparan entre sí, no una magnitud que
 * evoluciona de forma continua.
 *
 * Con todos los valores en cero no se dibuja ninguna barra pero sí la línea de
 * base: una gráfica vacía tiene que verse como una semana sin datos, no como
 * un error de render.
 */
export function BarChart({ title, points }: { title: string; points: readonly ChartPoint[] }) {
  const { t } = useT()
  const max = Math.max(1, ...points.map((p) => p.value))
  const slot = VIEW_W / Math.max(1, points.length)
  // Un cuarto del hueco de aire entre barras: suficiente para separarlas sin
  // que una semana de siete queden como hilos.
  const width = slot * 0.62

  return (
    <figure className="chart-figure">
      <svg
        className="chart"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary(title, points, t)}
      >
        {points.map((p, i) => {
          const h = p.value === 0 ? 0 : Math.max(1.5, (p.value / max) * VIEW_H)
          return (
            <rect
              key={p.label}
              className="chart-bar"
              x={i * slot + (slot - width) / 2}
              y={VIEW_H - h}
              width={width}
              height={h}
              rx="1"
            />
          )
        })}
      </svg>
      <div className="chart-axis-line" />
      <div className="chart-labels" aria-hidden="true">
        {points.map((p) => (
          <span key={p.label}>{p.label}</span>
        ))}
      </div>
    </figure>
  )
}

/**
 * Línea con un punto por medición. Para el peso, que es una magnitud continua
 * que sube: unas barras sugerirían que cada visita es independiente de la
 * anterior, y lo que importa acá es justamente la pendiente.
 *
 * El eje Y **no arranca en cero**, a propósito: entre 3,9 y 4,3 kg, un eje
 * desde cero dibuja una línea plana y esconde el único dato que la gráfica
 * tiene para dar. Lo que se lee es la forma de la curva; los números exactos
 * están en los KPIs de arriba y en /growth.
 */
export function LineChart({ title, points }: { title: string; points: readonly ChartPoint[] }) {
  const { t } = useT()
  if (points.length < 2) return null

  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  // Con todas las mediciones iguales el rango es 0 y la división explotaría:
  // se dibuja la línea a media altura, que es lo que significa "no cambió".
  const span = max - min || 1
  const usable = VIEW_H
  const at = (i: number) => (points.length === 1 ? VIEW_W / 2 : (i / (points.length - 1)) * VIEW_W)
  const y = (v: number) => usable - ((v - min) / span) * (usable - 6) - 3

  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${at(i)},${y(p.value)}`).join(' ')

  return (
    <figure className="chart-figure">
      <svg
        className="chart"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary(title, points, t)}
      >
        <path className="chart-line" d={d} />
        {points.map((p, i) => (
          <circle key={p.label} className="chart-dot" cx={at(i)} cy={y(p.value)} r="1.6" />
        ))}
      </svg>
      <div className="chart-axis-line" />
      <div className="chart-labels chart-labels-ends" aria-hidden="true">
        <span>{points[0].label}</span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </figure>
  )
}
