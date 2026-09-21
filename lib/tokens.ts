/**
 * Design tokens for the Amelia app.
 *
 * CONVENTIONS.md §3: "Design tokens live in `packages/ui`. No hardcoded
 * hex values in an app." That package does not exist yet, so this file
 * is its stand-in — shaped so the move is a copy, not a rewrite.
 *
 * The values are emitted as CSS custom properties by app/globals.css.
 * Components reference the variables, never these constants directly;
 * this module exists so the token names have one authoritative list and
 * so non-CSS consumers (charts, canvas, meta theme-color) can read them.
 */

export const color = {
  bg: '#211D1B',
  surface: '#332B27',
  surfaceRaised: '#3D342F',
  line: 'rgba(237, 230, 214, 0.12)',
  text: '#EDE6D6',
  muted: '#C9BFA9',
  accent: '#E8A33D',
  action: '#8C3B2E',
  /** Semantic, deliberately separate from the accent. */
  live: '#5C8A6B',
  danger: '#C4574A',
} as const

/**
 * The pastel light theme (app/globals.css, `:root[data-theme='light']`).
 * Only what a non-CSS consumer needs: the browser chrome color. The dark
 * palette above stays the default and the manifest's colors.
 */
export const lightColor = {
  bg: '#F7EAE3',
} as const

/**
 * Two surfaces, one component set.
 *
 * ARCHITECTURE.md makes the 27" wall HMI the primary target and phones
 * secondary. Rather than fork the components, the scale tokens change at
 * the wall breakpoint and every size in the app is expressed in them —
 * so one stylesheet renders a thumb-sized phone column and a display
 * readable from across the living room.
 */
export const surface = {
  /** Below this, lay out as the one-handed phone column. */
  wallMinWidth: 1180,
} as const

export type ColorToken = keyof typeof color
