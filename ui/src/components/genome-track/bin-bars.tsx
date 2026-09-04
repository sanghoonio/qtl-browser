import type { TrackLayout } from './use-track-layout'
import type { TrackBin } from './types'

/**
 * Downward bars, one per genomic window, hanging from `topY`. Values above `cap` are
 * drawn at full height with a notch so the reader knows they are clipped; the exact value
 * stays in the hover readout. `threshold` draws a dashed reference line in data units.
 */
export function BinBars({ bins, layout, topY, height, cap, threshold, unit }: {
  bins: TrackBin[]; layout: TrackLayout; topY: number; height: number; cap: number; threshold?: number; unit?: string
}) {
  const scale = (v: number) => (Math.min(v, cap) / cap) * height
  const last = layout.chroms[layout.chroms.length - 1]
  const xEnd = last ? layout.bpToPixel(last.name, last.length) : 0
  return (
    <g>
      {threshold != null && threshold < cap && (
        <line x1={0} x2={xEnd} y1={topY + scale(threshold)} y2={topY + scale(threshold)}
          className="stroke-error/50" strokeWidth={0.75} strokeDasharray="3,3" />
      )}
      {bins.map((b, i) => {
        if (!layout.offsets.has(b.chr)) return null
        const x0 = layout.bpToPixel(b.chr, b.start), x1 = layout.bpToPixel(b.chr, b.end)
        const w = Math.max(1, x1 - x0 - 1)
        const h = scale(b.value)
        const clipped = b.value > cap
        return (
          // grows down from the baseline on mount, sweeping left to right across the genome
          // (inline style: the per-bar delay is computed from its position)
          <g key={i} pointerEvents="all" className="animate-grow-down origin-top [transform-box:fill-box]"
            style={{ animationDelay: `${xEnd ? (x0 / xEnd) * 250 : 0}ms` }}>
            <rect x={x0 + 0.5} y={topY} width={w} height={Math.max(h, 0.5)} rx={0.5}
              className={b.sig ? 'fill-error' : 'fill-base-content/20'} />
            {clipped && <rect x={x0 + 0.5} y={topY + height - 2} width={w} height={2} className="fill-base-100" />}
            {b.title && <title>{b.title}{clipped ? ` (bar clipped at ${cap}${unit ? ` ${unit}` : ''})` : ''}</title>}
          </g>
        )
      })}
    </g>
  )
}
