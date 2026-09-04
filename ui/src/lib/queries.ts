/** Every SQL string in one place. Table paths match data/derived/manifest.json. */
import { lit, one, parquet, rows, type Row } from './db'

export interface SearchHit extends Row {
  gene_id: string; symbol: string | null; chr: string; tss: number
  tested: boolean; is_egene: boolean | null; n_sqtl_sig: number
}

export interface Gene extends Row {
  gene_id: string; gene_id_version: string; symbol: string | null; chr: string
  start: number; end: number; strand: string; tss: number; biotype: string; tested: boolean
  num_var: number | null; lead_position: number | null; lead_A1: string | null; lead_A2: string | null
  lead_rsid: string | null; lead_af: number | null; lead_tss_distance: number | null
  slope: number | null; slope_se: number | null; pval_nominal: number | null; pval_perm: number | null
  pval_beta: number | null; qval: number | null; is_egene: boolean | null
  n_credible_sets: number; n_trans_pairs: number
}

export interface CredibleSetRow extends Row {
  qtl_type: string; phenotype_id: string; chr: string; position: number; A1: string; A2: string
  rsid: string | null; af: number; cs_id: number; pip: number
}

export interface CisRow extends Row {
  position: number; A1: string; A2: string; rs_number: number | null; tss_distance: number
  af: number; ma_samples: number; ma_count: number; pval_nominal: number; slope: number
  slope_se: number; pip: number | null; cs_id: number | null; phenotype_id?: string
}

export interface SplicePhenotype extends Row {
  phenotype_id: string; gene_id: string; symbol: string | null; chr: string
  intron_start: number; intron_end: number; cluster_id: string; strand: string; tss: number
  num_var: number; lead_position: number; lead_A1: string; lead_A2: string; lead_rsid: string | null
  lead_af: number; lead_tss_distance: number; slope: number; slope_se: number
  pval_nominal: number; pval_perm: number; pval_beta: number; qval: number; is_sqtl: boolean
  n_credible_sets: number
}

export interface TransRow extends Row {
  qtl_type: string; phenotype_id: string; gene_id: string; symbol: string | null
  gene_chr: string; variant_chr: string; position: number; rsid: string | null; af: number
  pval: number; beta: number; beta_se: number; r2: number
}

export const searchGenes = (q: string, limit = 12) =>
  rows<SearchHit>(`
    SELECT * FROM search_index
    WHERE upper(symbol) LIKE ${lit(q.toUpperCase() + '%')} OR upper(gene_id) LIKE ${lit(q.toUpperCase() + '%')}
    ORDER BY tested DESC, is_egene DESC NULLS LAST, length(symbol), symbol LIMIT ${limit}`)

export const searchBySymbols = (symbols: string[]) =>
  rows<SearchHit>(`SELECT * FROM search_index WHERE symbol IN (${symbols.map(lit).join(',')})`)

export const resolveGene = (id: string) =>
  one<SearchHit>(`SELECT * FROM search_index WHERE gene_id = ${lit(id)} OR upper(symbol) = ${lit(id.toUpperCase())}
                  ORDER BY tested DESC LIMIT 1`)

export const geneRow = (hit: SearchHit) =>
  one<Gene>(`SELECT * FROM ${parquet('genes.parquet')}
             WHERE chr = ${lit(hit.chr)} AND tss = ${hit.tss} AND gene_id = ${lit(hit.gene_id)}`)

export const credibleSets = (hit: SearchHit, qtlType: 'e' | 's') =>
  rows<CredibleSetRow>(`SELECT * FROM ${parquet('credible_sets.parquet')}
    WHERE chr = ${lit(hit.chr)} AND tss = ${hit.tss} AND gene_id = ${lit(hit.gene_id)} AND qtl_type = ${lit(qtlType)}
    ORDER BY phenotype_id, cs_id, pip DESC`)

export const splicePhenotypes = (hit: SearchHit) =>
  rows<SplicePhenotype>(`SELECT * FROM ${parquet('splice_phenotypes.parquet')}
    WHERE chr = ${lit(hit.chr)} AND tss = ${hit.tss} AND gene_id = ${lit(hit.gene_id)}
    ORDER BY cluster_id, intron_start, intron_end`)

export const transPairs = (hit: SearchHit) =>
  rows<TransRow>(`SELECT * FROM ${parquet(`trans_pairs/chr=${hit.chr}/data.parquet`)}
    WHERE gene_id = ${lit(hit.gene_id)} ORDER BY pval LIMIT 2000`)

export interface CisQuery {
  hit: SearchHit
  qtlType: 'e' | 's'
  phenotypeId?: string          // sQTL only
  maxP?: number                 // filter
  search?: string               // rsID or position, prefix match
  orderBy?: string
  desc?: boolean
  limit?: number
  offset?: number
}

function cisWhere(q: CisQuery): string {
  const table = q.qtlType === 'e' ? 'cis_eqtl_nominal' : 'cis_sqtl_nominal'
  const parts = [`gene_id = ${lit(q.hit.gene_id)}`]
  if (q.qtlType === 's' && q.phenotypeId) parts.push(`phenotype_id = ${lit(q.phenotypeId)}`)
  if (q.maxP != null) parts.push(`pval_nominal <= ${q.maxP}`)
  const s = q.search?.trim()
  if (s) {
    const rs = /^rs(\d+)$/i.exec(s)
    const pos = /^(?:chr[0-9xy]+:)?([\d,]+)$/i.exec(s)
    if (rs) parts.push(`CAST(rs_number AS VARCHAR) LIKE ${lit(rs[1] + '%')}`)
    else if (pos) parts.push(`CAST(position AS VARCHAR) LIKE ${lit(pos[1].replace(/,/g, '') + '%')}`)
    else parts.push('false')
  }
  return `FROM ${parquet(`${table}/chr=${q.hit.chr}/data.parquet`)} WHERE ${parts.join(' AND ')}`
}

const CIS_SORTABLE = new Set(['position', 'pval_nominal', 'slope', 'af', 'pip', 'tss_distance', 'ma_count'])

export const cisRows = (q: CisQuery) => {
  const col = q.orderBy && CIS_SORTABLE.has(q.orderBy) ? q.orderBy : 'pval_nominal'
  return rows<CisRow>(`SELECT * ${cisWhere(q)} ORDER BY ${col} ${q.desc ? 'DESC' : 'ASC'} NULLS LAST
                       LIMIT ${q.limit ?? 50} OFFSET ${q.offset ?? 0}`)
}

export const cisCount = async (q: CisQuery) =>
  Number((await one<{ n: number }>(`SELECT count(*) AS n ${cisWhere(q)}`))?.n ?? 0)

/** Full cis window for plotting/CSV (thousands of rows, one row group). */
export const cisAll = (q: CisQuery) =>
  rows<CisRow>(`SELECT * ${cisWhere({ ...q, maxP: undefined, search: undefined })} ORDER BY position`)

export const genesInRegion = (chr: string, start: number, end: number) =>
  rows<SearchHit>(`SELECT * FROM search_index WHERE chr = ${lit(chr)} AND tss BETWEEN ${start} AND ${end} ORDER BY tss`)

export const manifest = () => fetch(`${(import.meta.env.VITE_DATA_BASE as string | undefined) ?? '/data'}/manifest.json`).then(r => r.json())

// ---- variant page ---------------------------------------------------------------------------

export interface VariantRow extends Row {
  chr: string; position: number; A1: string; A2: string; rsid: string | null; rs_number: number | null; match: string
}

export const variantByRsid = (rsNumber: number) =>
  rows<VariantRow>(`SELECT * FROM ${parquet('variants_by_rsid.parquet')} WHERE rs_number = ${rsNumber} ORDER BY chr, position, A1`)

export const variantByPosition = (chr: string, pos: number) =>
  rows<VariantRow>(`SELECT * FROM ${parquet(`variants_by_position/chr=${chr}/data.parquet`)} WHERE position = ${pos} ORDER BY A1`)

/** Genes whose lead eQTL variant is this position. TSS is within 1 Mb by construction, which
 *  is what lets DuckDB prune genes.parquet row groups on (chr, tss). */
export const leadGenesAt = (chr: string, pos: number) =>
  rows<Gene>(`SELECT * FROM ${parquet('genes.parquet')}
    WHERE chr = ${lit(chr)} AND tss BETWEEN ${pos - 1_000_000} AND ${pos + 1_000_000} AND lead_position = ${pos} ORDER BY pval_perm`)

export const leadPhenotypesAt = (chr: string, pos: number) =>
  rows<SplicePhenotype>(`SELECT * FROM ${parquet('splice_phenotypes.parquet')}
    WHERE chr = ${lit(chr)} AND tss BETWEEN ${pos - 1_000_000} AND ${pos + 1_000_000} AND lead_position = ${pos} ORDER BY pval_perm`)

export interface CredibleSetHit extends CredibleSetRow { gene_id: string; symbol: string | null; tss: number }
export const credibleSetsAt = (chr: string, pos: number) =>
  rows<CredibleSetHit>(`SELECT * FROM ${parquet('credible_sets.parquet')}
    WHERE chr = ${lit(chr)} AND tss BETWEEN ${pos - 1_000_000} AND ${pos + 1_000_000} AND position = ${pos} ORDER BY pip DESC`)

/** Trans associations of one variant, from the variant-keyed copy of the trans table. */
export const transAt = (chr: string, pos: number) =>
  rows<TransRow>(`SELECT * FROM ${parquet(`trans_by_variant/chr=${chr}/data.parquet`)} WHERE position = ${pos} ORDER BY pval LIMIT 2000`)

export interface CisHit extends Row {
  gene_id: string; symbol: string | null; phenotype_id?: string; tss_distance: number
  pval_nominal: number; slope: number; slope_se: number; af: number; pip: number | null; cs_id: number | null
}
/** Every gene (or splice phenotype) whose cis window covers this position: one nominal row
 *  each. Touches every row group whose position range spans `pos` (~30 genes' worth), so it
 *  runs on demand, not on page load. */
export const cisHitsAt = (chr: string, pos: number, qtlType: 'e' | 's') => {
  const table = qtlType === 'e' ? 'cis_eqtl_nominal' : 'cis_sqtl_nominal'
  return rows<CisHit>(`
    SELECT n.gene_id, s.symbol, ${qtlType === 's' ? 'n.phenotype_id,' : ''} n.tss_distance, n.pval_nominal, n.slope, n.slope_se, n.af, n.pip, n.cs_id
    FROM ${parquet(`${table}/chr=${chr}/data.parquet`)} n
    LEFT JOIN search_index s USING (gene_id)
    WHERE n.position = ${pos}
    ORDER BY n.pval_nominal`)
}

// ---- colocalized loci on the landing page ---------------------------------------------------

/** Full gene rows for a handful of known genes: one OR term per (chr, tss, gene_id) so row
 *  groups prune on chr/tss statistics instead of reading the whole file. */
export const geneRowsFor = (hits: SearchHit[]) =>
  hits.length === 0 ? Promise.resolve([] as Gene[]) : rows<Gene>(`SELECT * FROM ${parquet('genes.parquet')} WHERE ${
    hits.map(h => `(chr = ${lit(h.chr)} AND tss = ${h.tss} AND gene_id = ${lit(h.gene_id)})`).join(' OR ')}`)

export interface GwasBin extends Row {
  chr: string; bin_start: number; bin_end: number; min_p: number; lead_position: number; lead_rsid: string | null
  lead_beta: number; lead_ea: string; n_gws: number; n_variants: number
}
/** DCM GWAS strongest signal per fixed window (tiny table, read whole). */
export const gwasBins = () => rows<GwasBin>(`SELECT * FROM ${parquet('gwas_dcm_bins.parquet')} ORDER BY chr, bin_start`)

// ---- gene track under the locus plot --------------------------------------------------------

export interface WindowGene extends Row { gene_id: string; symbol: string | null; start: number; end: number; strand: string; tss: number; biotype: string }
/** Genes overlapping a window; genes.parquet row groups prune on (chr, tss). */
export const genesInWindow = (chr: string, lo: number, hi: number) =>
  rows<WindowGene>(`SELECT gene_id, symbol, start, "end", strand, tss, biotype FROM ${parquet('genes.parquet')}
    WHERE chr = ${lit(chr)} AND tss BETWEEN ${lo - 3_000_000} AND ${hi + 3_000_000} AND "end" >= ${lo} AND start <= ${hi}
    ORDER BY start`)

export interface Exon extends Row { start: number; end: number }
/** Collapsed gene model: union of all transcripts' exons. */
export const collapsedExons = (chr: string, geneId: string) =>
  rows<Exon>(`
    WITH e AS (SELECT start, "end" FROM ${parquet('exons.parquet')} WHERE gene_id = ${lit(geneId)} AND chr = ${lit(chr)}),
    o AS (SELECT start, "end", max("end") OVER (ORDER BY start, "end" ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max FROM e),
    g AS (SELECT start, "end", sum(CASE WHEN prev_max IS NULL OR start > prev_max THEN 1 ELSE 0 END) OVER (ORDER BY start, "end") AS grp FROM o)
    SELECT min(start) AS start, max("end") AS "end" FROM g GROUP BY grp ORDER BY start`)
