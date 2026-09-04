import { useEffect } from 'react'

// lucide "croissant" (ISC license), stroked with the live theme's primary color
const PATHS = [
  'M10.2 18H4.774a1.5 1.5 0 0 1-1.352-.97 11 11 0 0 1 .132-6.487',
  'M18 10.2V4.774a1.5 1.5 0 0 0-.97-1.352 11 11 0 0 0-6.486.132',
  'M18 5a4 3 0 0 1 4 3 2 2 0 0 1-2 2 10 10 0 0 0-5.139 1.42',
  'M5 18a3 4 0 0 0 3 4 2 2 0 0 0 2-2 10 10 0 0 1 1.42-5.14',
  'M8.709 2.554a10 10 0 0 0-6.155 6.155 1.5 1.5 0 0 0 .676 1.626l9.807 5.42a2 2 0 0 0 2.718-2.718l-5.42-9.807a1.5 1.5 0 0 0-1.626-.676',
]

function svg(color: string): string {
  const body = PATHS.map(d => `<path d="${d}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

/** Read a DaisyUI theme token as a resolved color string. */
function themeColor(token: string): string {
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const c = getComputedStyle(probe).color
  probe.remove()
  return c
}

/** Favicon and browser theme-color follow the active theme, so nothing is hard-coded. */
export function useThemedFavicon() {
  useEffect(() => {
    const apply = () => {
      const primary = themeColor('--color-primary')
      const surface = themeColor('--color-base-100')
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
      link.type = 'image/svg+xml'
      link.href = `data:image/svg+xml;utf8,${encodeURIComponent(svg(primary))}`
      let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta) }
      meta.content = surface
    }
    apply()
    const obs = new MutationObserver(apply)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
}
