/**
 * Which linked plot is under the pointer. Decided geometrically on every pointer move rather
 * than with enter/leave events: the plots' overflow-visible labels and rings can hang over a
 * neighbor and keep enter/leave from firing where the eye expects.
 */
const CLASS = 'plot-hovered'

export function onPlotPointerMove(e: PointerEvent | React.PointerEvent) {
  const x = e.clientX, y = e.clientY
  document.querySelectorAll<HTMLElement>('.plot-host').forEach(el => {
    const r = el.getBoundingClientRect()
    const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    el.classList.toggle(CLASS, inside)
  })
}

export function clearPlotHover() {
  document.querySelectorAll<HTMLElement>(`.plot-host.${CLASS}`).forEach(el => el.classList.remove(CLASS))
}
