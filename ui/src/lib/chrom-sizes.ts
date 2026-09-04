/** Chromosome sizes from the seqcol API, cached per build in localStorage (as in pegasus-v2f-ui). */

export type ChromSizes = { names: string[]; lengths: number[] }

const SEQCOL_API = 'https://seqcolapi.databio.org'
const SEQCOL_DIGESTS: Record<string, string> = {
  hg38: 'NTeQ1GQMt2ocCFkS8Z3_qkvetZjabWSt',
  GRCh38: 'NTeQ1GQMt2ocCFkS8Z3_qkvetZjabWSt',
}
const STANDARD_CHROMS = [...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`), 'chrX', 'chrY']
const CACHE_KEY_PREFIX = 'topchef.chromSizes.'

export async function fetchChromSizes(genomeBuild = 'GRCh38'): Promise<ChromSizes> {
  const cacheKey = CACHE_KEY_PREFIX + genomeBuild
  const cached = localStorage.getItem(cacheKey)
  if (cached) {
    try { return JSON.parse(cached) as ChromSizes } catch { /* re-fetch */ }
  }
  const digest = SEQCOL_DIGESTS[genomeBuild]
  if (!digest) throw new Error(`No seqcol digest known for genome build '${genomeBuild}'`)
  const resp = await fetch(`${SEQCOL_API}/collection/${digest}?level=2`)
  if (!resp.ok) throw new Error(`seqcol fetch failed: ${resp.status}`)
  const data = (await resp.json()) as { names: string[]; lengths: number[] }
  const lookup = new Map<string, number>()
  data.names.forEach((n, i) => lookup.set(n, data.lengths[i]!))
  const names: string[] = [], lengths: number[] = []
  for (const chrom of STANDARD_CHROMS) {
    const len = lookup.get(chrom)
    if (len != null) { names.push(chrom); lengths.push(len) }
  }
  const result = { names, lengths }
  localStorage.setItem(cacheKey, JSON.stringify(result))
  return result
}
