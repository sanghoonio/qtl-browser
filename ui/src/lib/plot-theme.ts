/**
 * Chart colors for credible-set membership (categorical, one slot per set, fixed).
 *
 * Hues are the dataviz reference palette's blue, aqua, yellow, green, red. No five-hue subset
 * of that palette passes the all-pairs checks on both surfaces (best: light CVD ΔE 6.9 /
 * normal 15.6, dark CVD 6.5 / normal 11.9, run 2026-09-04 against the theme surfaces #ffffff
 * and #1f1615), so each set also gets its own marker shape as the secondary encoding, and the
 * credible-set table below the plot is the table view. Variants in no set are the neutral
 * background, a warm gray matched to each surface.
 */
export const CS_DOMAIN = ['none', '1', '2', '3', '4', '5'] as const
export const CS_COLORS = {
  light: ['#b8b3b1', '#2a78d6', '#1baf7a', '#eda100', '#008300', '#e34948'],
  dark: ['#5a4d4a', '#3987e5', '#199e70', '#c98500', '#008300', '#e66767'],
}
// the neutral background keeps the plain circle; every credible set gets its own shape
export const CS_SYMBOLS = ['circle', 'diamond2', 'square', 'triangle', 'star', 'hexagon']   // diamond2 = rotated square
/** CSS clip-paths that echo the plot symbols in the legend swatches. */
export const CS_SWATCH_CLIP: Record<string, string | undefined> = {
  circle: undefined,
  square: 'inset(10%)',
  triangle: 'polygon(50% 5%, 95% 95%, 5% 95%)',
  diamond2: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
  star: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
  hexagon: 'polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0% 50%)',
}
export function isDark(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'topchef-dark'
}
