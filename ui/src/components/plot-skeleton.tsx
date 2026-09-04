/**
 * Placeholders shaped like the plots they precede: the same margins, axis lines, axis titles,
 * TSS rule, and gene-track lane as LocusPlot / GeneTrack / LocusCompare, so the loaded plot
 * lands in the frame already on screen. Only the data area shimmers; nothing pretends to be data.
 */
import type { ReactNode } from 'react'

// mirrors LocusPlot / LocusCompare / GeneTrack layout constants (kept local to avoid an import cycle)
const ML = 48
const MR = 20
const PLOT_MARGIN_TOP = 20
const PLOT_MARGIN_BOTTOM = 36
const SCATTER_H = 290

const AXIS = 'absolute border-base-content/20'

/** Axis frame shared by both plots: y axis on the left, x axis at the bottom, shimmering data area. */
function Frame({ height, xTitle, yTitle, children }: { height: number; xTitle: string; yTitle: string; children?: ReactNode }) {
  const mt = PLOT_MARGIN_TOP, mb = PLOT_MARGIN_BOTTOM
  return (
    <div className="relative w-full" style={{ height }} aria-busy="true">
      <div className="skeleton absolute rounded-none opacity-30" style={{ left: ML + 1, right: MR, top: mt, bottom: mb + 1 }} />
      <div className={`${AXIS} border-l`} style={{ left: ML, top: mt, bottom: mb }} />
      <div className={`${AXIS} border-t`} style={{ left: ML, right: MR, bottom: mb }} />
      <span className="absolute left-0 top-1/2 origin-center -translate-y-1/2 -rotate-90 whitespace-nowrap text-[10px] text-base-content/40"
        style={{ left: -22 }}>{yTitle}</span>
      <span className="absolute bottom-0 whitespace-nowrap text-[10px] text-base-content/40" style={{ left: ML, right: MR, textAlign: 'center' }}>{xTitle}</span>
      {children}
    </div>
  )
}

/** Locus scatter with the TSS rule. The gene track is not sketched; it appears with the plot. */
export function LocusSkeleton({ chr }: { chr?: string }) {
  return (
    <Frame height={SCATTER_H} yTitle="−log₁₀ p" xTitle={`${chr ?? 'chr'} position (Mb)`}>
      <div className="absolute border-l border-dashed border-base-content/25" style={{ left: `calc(${ML}px + (100% - ${ML + MR}px) / 2)`, top: PLOT_MARGIN_TOP, bottom: PLOT_MARGIN_BOTTOM }} />
    </Frame>
  )
}

/** LocusCompare square: same frame, GWAS on x and QTL on y. */
export function CompareSkeleton() {
  return <Frame height={SCATTER_H} yTitle="QTL −log₁₀ p" xTitle="DCM GWAS −log₁₀ p" />
}
