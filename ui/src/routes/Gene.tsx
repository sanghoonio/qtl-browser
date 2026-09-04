import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import ExternalLink from '@/components/ExternalLink'
import { Page } from '@/components/page'
import { PageHeader } from '@/components/page-header'
import { SectionPanel } from '@/components/section-panel'
import { KvTable } from '@/components/kv-table'
import { Tooltip } from '@/components/tooltip'
import { Segmented } from '@/components/segmented'
import { DetailSkeleton, Empty, TableSkeleton, TabSkeleton } from '@/components/states'
import CredibleSetTable from '@/components/CredibleSetTable'
import CisTable from '@/components/CisTable'
import LocusPlot, { LocusLegend } from '@/components/LocusPlot'
import { COLOC_EQTL_GENES, COLOC_SQTL_GENES } from '@/lib/coloc'
import { ensemblGene, gtexGene, ucsc } from '@/lib/links'
import { fmtBp, fmtInt, fmtNum, fmtP, fmtPhenotype, fmtSlopeSE } from '@/lib/format'
import { credibleSets, geneRow, resolveGene, splicePhenotypes, transPairs,
  type CredibleSetRow, type Gene as GeneRow, type SearchHit, type SplicePhenotype, type TransRow } from '@/lib/queries'

type Tab = 'eqtl' | 'sqtl' | 'trans'

export default function Gene() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'eqtl'
  const [hit, setHit] = useState<SearchHit | null | undefined>(undefined)
  const [gene, setGene] = useState<GeneRow | null>(null)

  useEffect(() => {
    setHit(undefined); setGene(null)
    resolveGene(id).then(h => { setHit(h); if (h) geneRow(h).then(setGene) })
  }, [id])

  if (hit === undefined) return <Page><DetailSkeleton plot /></Page>
  if (hit === null) return <Page><Empty label={`No gene matches “${id}”.`} /></Page>

  const sym = hit.symbol ?? hit.gene_id
  const g = gene
  const tabs = [
    { value: 'eqtl' as Tab, label: 'eQTL' },
    { value: 'sqtl' as Tab, label: `sQTL${hit.n_sqtl_sig ? ` (${hit.n_sqtl_sig})` : ''}` },
    { value: 'trans' as Tab, label: `trans${g ? ` (${g.n_trans_pairs})` : ''}` },
  ]
  return (
    <Page>
      <PageHeader
        crumbs={[{ to: '/genes', label: 'Genes' }, { label: sym }]}
        title={sym}
        meta={hit.gene_id}
        description={<span className="mt-1 flex flex-wrap items-center gap-1.5">
          {hit.is_egene && <Chip cls="badge-primary" tip="Significant cis-eQTL: permutation p < 0.05">eGene</Chip>}
          {hit.n_sqtl_sig > 0 && <Chip cls="badge-secondary" tip="Introns with a significant cis-sQTL (permutation p < 0.05)">{hit.n_sqtl_sig} sQTL intron{hit.n_sqtl_sig > 1 ? 's' : ''}</Chip>}
          {COLOC_EQTL_GENES.includes(sym) && <Chip cls="badge-accent" tip="eQTL colocalizes with the Jurgens et al. 2024 DCM GWAS (coloc PP.H4 > 0.8)">DCM coloc · eQTL</Chip>}
          {COLOC_SQTL_GENES.includes(sym) && <Chip cls="badge-accent badge-outline" tip="sQTL colocalizes with the Jurgens et al. 2024 DCM GWAS (coloc PP.H4 > 0.8)">DCM coloc · sQTL</Chip>}
          {!hit.tested && <Chip cls="badge-ghost" tip="Filtered out before QTL mapping (expression or mappability)">not tested</Chip>}
        </span>}
        actions={hit.tested ? <Segmented nav value={tab} onChange={t => setParams({ tab: t })} options={tabs} /> : undefined}
      />
      {!hit.tested ? (
        <Empty label={`${sym} is annotated in GENCODE v34 but was not tested for QTL (filtered out by expression or mappability).`} />
      ) : (
        <>
          {tab === 'eqtl' && (g ? <EqtlTab hit={hit} g={g} /> : <TabSkeleton plot chr={hit.chr} />)}
          {tab === 'sqtl' && (g ? <><GeneTable g={g} /><SqtlTab hit={hit} /></> : <TabSkeleton kvRows={4} />)}
          {tab === 'trans' && (g ? <><GeneTable g={g} /><TransTab hit={hit} /></> : <TabSkeleton kvRows={4} />)}
        </>
      )}
    </Page>
  )
}

/** Status chip with a hover explanation, since the label alone is terse. */
function Chip({ cls, tip, children }: { cls: string; tip: string; children: ReactNode }) {
  return <Tooltip tip={tip}><span className={`badge badge-sm cursor-help ${cls}`}>{children}</span></Tooltip>
}

function geneRows(g: GeneRow) {
  return [
    { label: 'Location', value: <span className="tabular-nums">{g.chr}:{fmtInt(g.start)}-{fmtInt(g.end)} ({g.strand})</span> },
    { label: 'TSS', value: <span className="tabular-nums">{g.chr}:{fmtInt(g.tss)}</span> },
    { label: 'Biotype', value: g.biotype.replace(/_/g, ' ') },
    { label: 'Ensembl ID', value: g.gene_id_version },
    { label: 'Links', value: <span className="flex flex-wrap gap-x-4">
      <ExternalLink icon href={ucsc(g.chr, g.start, g.end)}>UCSC</ExternalLink>
      <ExternalLink icon href={ensemblGene(g.gene_id)}>Ensembl</ExternalLink>
      {g.symbol && <ExternalLink icon href={gtexGene(g.symbol)}>GTEx</ExternalLink>}
    </span> },
  ]
}

function GeneTable({ g }: { g: GeneRow }) {
  return <div className="mb-8 grid items-start gap-4 md:grid-cols-2"><KvTable rows={geneRows(g)} /></div>
}

function EqtlTab({ hit, g }: { hit: SearchHit; g: GeneRow }) {
  const [cs, setCs] = useState<CredibleSetRow[] | null>(null)
  const [nVar, setNVar] = useState<number | null>(null)
  const [legend, setLegend] = useState<string[] | null>(null)
  const [exportMenu, setExportMenu] = useState<ReactNode>(null)
  useEffect(() => { setCs(null); setNVar(null); credibleSets(hit, 'e').then(setCs) }, [hit])
  const sym = hit.symbol ?? hit.gene_id
  return (
    <div className="space-y-8">
      <div className="grid items-start gap-4 md:grid-cols-2">
        <KvTable rows={[
          ...geneRows(g),
          { label: 'Lead variant', value: <Link className="link-quiet" to={`/variant/${g.lead_rsid ?? `${g.chr}:${g.lead_position}`}`}>{g.lead_rsid ?? `${g.chr}:${fmtInt(g.lead_position)}`}</Link> },
          { label: 'Lead position', value: <span className="tabular-nums">{g.chr}:{fmtInt(g.lead_position)}</span> },
          { label: 'A1 / A2', value: `${g.lead_A1} / ${g.lead_A2}` },
          { label: 'A1 frequency', value: fmtNum(g.lead_af) },
        ]} />
        <KvTable align="right" rows={[
          { label: 'Distance to TSS', value: fmtBp(g.lead_tss_distance) },
          { label: 'Variants tested', value: fmtInt(g.num_var) },
          { label: 'Slope ± SE', value: fmtSlopeSE(g.slope, g.slope_se) },
          { label: 'Nominal p', value: fmtP(g.pval_nominal) },
          { label: 'Permutation p', value: fmtP(g.pval_perm) },
          { label: 'Beta-approximated p', value: fmtP(g.pval_beta) },
          { label: 'q-value', value: fmtP(g.qval) },
          { label: 'Credible sets', value: String(g.n_credible_sets) },
        ]} />
      </div>
      <SectionPanel title="Locus"
        description={<span className="inline-flex items-center gap-3 tabular-nums"><span>{g.chr}:{fmtInt(g.tss - 1_000_000)}–{fmtInt(g.tss + 1_000_000)}{nVar != null && ` · ${fmtInt(nVar)} variants`}</span>{exportMenu}</span>}
        action={legend && <LocusLegend sets={legend} />}>
        <LocusPlot spec={{ hit, qtlType: 'e', tss: g.tss }} onCount={setNVar} onLegend={setLegend} onExportMenu={setExportMenu} />
      </SectionPanel>
      <SectionPanel title="SuSiE 95% credible sets">
        {cs === null ? <TableSkeleton columns={[{ w: 'w-4' }, { w: 'w-12' }, { w: 'w-8', align: 'right' }, { w: 'w-24' }, { w: 'w-10', align: 'right' }, { w: 'w-10', align: 'right' }, { w: 'w-16', align: 'right' }]} rows={2} /> : <CredibleSetTable rows={cs} />}
      </SectionPanel>
      <SectionPanel title="All variants in the cis window" description="±1 Mb of the TSS; rows tinted when the variant is in a credible set.">
        <CisTable query={{ hit, qtlType: 'e' }} fileStem={`${sym}_cis_eqtl`} />
      </SectionPanel>
    </div>
  )
}

function SqtlTab({ hit }: { hit: SearchHit }) {
  const [phens, setPhens] = useState<SplicePhenotype[] | null>(null)
  const [cs, setCs] = useState<CredibleSetRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [nVar, setNVar] = useState<number | null>(null)
  const [legend, setLegend] = useState<string[] | null>(null)
  const [exportMenu, setExportMenu] = useState<ReactNode>(null)
  useEffect(() => {
    setPhens(null); setSelected(null); setNVar(null)
    splicePhenotypes(hit).then(p => { setPhens(p); setSelected(p.find(x => x.is_sqtl)?.phenotype_id ?? null) })
    credibleSets(hit, 's').then(setCs)
  }, [hit])
  if (phens === null) return <TableSkeleton columns={[{ w: 'w-20' }, { w: 'w-40' }, { w: 'w-20' }, { w: 'w-20', align: 'right' }, { w: 'w-14', align: 'right' }, { w: 'w-6', align: 'right' }]} rows={5} />
  if (!phens.length) return <Empty label="No splicing phenotypes were tested for this gene." />
  const visible = phens.filter(p => p.is_sqtl)
  const sel = phens.find(p => p.phenotype_id === selected) ?? null
  const sym = hit.symbol ?? hit.gene_id
  return (
    <div className="space-y-8">
      <SectionPanel title="Splice phenotypes"
        description={`${fmtInt(visible.length)} of ${fmtInt(phens.length)} tested introns with a significant sQTL; click a row to load its locus.`}>
        {visible.length === 0 ? <Empty label={`None of the ${fmtInt(phens.length)} tested introns has a significant sQTL.`} /> : (
          <div className="overflow-x-auto rounded-lg border border-base-300">
            <table className="table table-sm">
              <thead><tr><th>Cluster</th><th>Intron</th><th>Lead variant</th><th className="text-right">Slope ± SE</th><th className="text-right">Perm p</th><th className="text-right">Sets</th></tr></thead>
              <tbody>
                {visible.map(p => (
                  <tr key={p.phenotype_id} onClick={() => setSelected(p.phenotype_id)}
                    className={`cursor-pointer transition-colors ${p.phenotype_id === selected ? 'bg-base-200' : 'hover:bg-base-200/60'}`}>
                    <td className="font-mono text-xs text-base-content/60">{p.cluster_id}</td>
                    <td className="tabular-nums">{fmtInt(p.intron_start)}–{fmtInt(p.intron_end)} <span className="text-base-content/50">({fmtBp(p.intron_end - p.intron_start)})</span></td>
                    <td><Link className="link-quiet" to={`/variant/${p.lead_rsid ?? `${p.chr}:${p.lead_position}`}`}>{p.lead_rsid ?? `${p.chr}:${fmtInt(p.lead_position)}`}</Link></td>
                    <td className="text-right tabular-nums">{fmtSlopeSE(p.slope, p.slope_se)}</td>
                    <td className="text-right tabular-nums">{fmtP(p.pval_perm)}</td>
                    <td className="text-right tabular-nums">{p.n_credible_sets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>
      {sel && (
        <>
          <SectionPanel title="Locus"
            description={<span className="inline-flex items-center gap-3 tabular-nums"><span>intron {fmtPhenotype(sel.phenotype_id)}{nVar != null && ` · ${fmtInt(nVar)} variants`}</span>{exportMenu}</span>}
            action={legend && <LocusLegend sets={legend} />}>
            <LocusPlot spec={{ hit, qtlType: 's', phenotypeId: sel.phenotype_id, tss: sel.tss, intron: { start: sel.intron_start, end: sel.intron_end } }} onCount={setNVar} onLegend={setLegend} onExportMenu={setExportMenu} />
          </SectionPanel>
          <SectionPanel title="SuSiE 95% credible sets"><CredibleSetTable rows={cs.filter(c => c.phenotype_id === sel.phenotype_id)} /></SectionPanel>
          <SectionPanel title="All variants in the cis window">
            <CisTable query={{ hit, qtlType: 's', phenotypeId: sel.phenotype_id }} fileStem={`${sym}_${sel.cluster_id}_${sel.intron_start}_${sel.intron_end}_cis_sqtl`} />
          </SectionPanel>
        </>
      )}
    </div>
  )
}

function TransTab({ hit }: { hit: SearchHit }) {
  const [t, setT] = useState<TransRow[] | null>(null)
  useEffect(() => { setT(null); transPairs(hit).then(setT) }, [hit])
  if (t === null) return <TableSkeleton columns={[{ w: 'w-10' }, { w: 'w-40' }, { w: 'w-24' }, { w: 'w-20' }, { w: 'w-10', align: 'right' }, { w: 'w-14', align: 'right' }, { w: 'w-20', align: 'right' }, { w: 'w-10', align: 'right' }]} />
  if (!t.length) return <Empty label="No significant trans associations for this gene." />
  return (
    <SectionPanel title="trans associations" description="Variants outside the cis window associated with this gene's expression (e) or splicing (s); up to 2,000 by p-value.">
      <div className="overflow-x-auto rounded-lg border border-base-300">
        <table className="table table-sm">
          <thead><tr><th>Type</th><th>Phenotype</th><th>Variant</th><th>rsID</th><th className="text-right">AF</th><th className="text-right">p</th><th className="text-right">Beta ± SE</th><th className="text-right">r²</th></tr></thead>
          <tbody>
            {t.map((r, i) => (
              <tr key={i} className="hover:bg-base-200">
                <td><span className={`badge badge-xs ${r.qtl_type === 'e' ? 'badge-primary' : 'badge-secondary'}`}>{r.qtl_type === 'e' ? 'eQTL' : 'sQTL'}</span></td>
                <td className="tabular-nums text-base-content/60">{r.qtl_type === 'e' ? 'expression' : fmtPhenotype(r.phenotype_id)}</td>
                <td className="tabular-nums"><Link className="link-quiet" to={`/variant/${r.variant_chr}:${r.position}`}>{r.variant_chr}:{fmtInt(r.position)}</Link></td>
                <td>{r.rsid ? <Link className="link-quiet" to={`/variant/${r.rsid}`}>{r.rsid}</Link> : ''}</td>
                <td className="text-right tabular-nums text-base-content/60">{fmtNum(r.af)}</td>
                <td className="text-right tabular-nums">{fmtP(r.pval)}</td>
                <td className="text-right tabular-nums">{fmtSlopeSE(r.beta, r.beta_se)}</td>
                <td className="text-right tabular-nums text-base-content/60">{fmtNum(r.r2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionPanel>
  )
}
