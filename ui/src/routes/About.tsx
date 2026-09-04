import { useEffect, useState } from 'react'
import ExternalLink from '@/components/ExternalLink'
import { Page } from '@/components/page'
import { PageHeader } from '@/components/page-header'
import { KvTable } from '@/components/kv-table'
import { SectionPanel } from '@/components/section-panel'
import { PIPELINE, PREPRINT, ZENODO } from '@/lib/links'
import { manifest } from '@/lib/queries'

const GWAS_PAPER = 'https://doi.org/10.1038/s41588-024-01975-5'
const CVDKP = 'https://kp4cd.org/dataset_downloads/mi'
const SEQCOL = 'https://seqcolapi.databio.org'
const REPO = 'https://github.com/sanghoonio/qtl-browser'

export default function About() {
  const [m, setM] = useState<Record<string, unknown> | null>(null)
  useEffect(() => { manifest().then(setM).catch(() => {}) }, [])
  const sources = (m?.sources ?? {}) as Record<string, { version: string; description: string }>
  const tables = (m?.tables ?? {}) as Record<string, { rows: number; bytes: number; load: string }>
  const counts = (m?.counts ?? {}) as Record<string, number>
  return (
    <Page>
      <div className="mx-auto max-w-4xl">
        <PageHeader title="About" description="What this browser shows, how the numbers are defined, and where the data comes from." />
        <div className="space-y-10">
          <div className="prose prose-sm max-w-none">
            <p>
              TOPCHeF (Trans-Omics for Precision Medicine in Congestive Heart Failure) paired whole-genome and RNA sequencing
              from left-ventricle tissue of dilated cardiomyopathy, ischemic cardiomyopathy, and non-failing donors, and mapped
              cis and trans expression (eQTL) and splicing (sQTL) quantitative trait loci with TensorQTL and SuSiE. Methods,
              sample counts, and the colocalization with dilated cardiomyopathy risk are in the{' '}
              <ExternalLink href={PREPRINT}>preprint</ExternalLink>. This site serves the published summary statistics.
            </p>
            <h2>Definitions</h2>
            <ul>
              <li><strong>eGene, sQTL intron</strong>: permutation p-value below 0.05. A Benjamini-Hochberg q-value on the beta-approximated permutation p is listed alongside.</li>
              <li><strong>Lead variant</strong>: the variant with the smallest nominal p-value in the cis window, ±1 Mb of the transcription start site.</li>
              <li><strong>Credible sets and PIP</strong>: SuSiE 95% credible sets; PIP is the posterior inclusion probability. A variant in two sets of one phenotype is shown with its higher-PIP membership.</li>
              <li><strong>A1 and A2</strong>: A1 is the effect allele, the minor allele in TOPCHeF; A2 is the reference allele. Slopes are in standard-deviation units of the phenotype per A1 allele.</li>
              <li><strong>Splice phenotypes</strong>: leafcutter intron excision ratios, shown as intron coordinates and strand. Introns sharing a splice site share a cluster. Every tested intron has its permutation result; per-variant nominal statistics are stored for the significant introns only.</li>
              <li><strong>Colocalized loci</strong>: the 21 eQTL and 4 sQTL genes with coloc PP.H4 above 0.8 against the DCM GWAS. PJVK and CDKN1A are not eGenes by the permutation rule; their colocalization used nominal statistics.</li>
            </ul>
            <h2>Coordinates and identifiers</h2>
            <ul>
              <li>Coordinates are GRCh38. Genes follow GENCODE v34; gene models on the locus plot are the union of each gene's transcript exons.</li>
              <li>rsIDs are assigned from dbSNP by position and alleles. Variants with no dbSNP record are shown as chr:position.</li>
              <li>Chromosome lengths for the genome track come from the <ExternalLink href={SEQCOL}>seqcol</ExternalLink> GRCh38 reference.</li>
            </ul>
            <h2>DCM GWAS comparison</h2>
            <p>
              The landing track and the QTL-versus-GWAS panel use the dilated cardiomyopathy meta-analysis of{' '}
              <ExternalLink href={GWAS_PAPER}>Jurgens et al. 2024</ExternalLink> from the{' '}
              <ExternalLink href={CVDKP}>Cardiovascular Disease Knowledge Portal</ExternalLink>. Variants are matched on GRCh38
              position and alleles in either orientation, and the GWAS effect is signed to the QTL effect allele. The landing
              track shows the strongest GWAS p-value per 5 Mb window, red where the window holds a genome-wide significant
              variant; the gene page panel plots every shared variant in the cis window.
            </p>
            <h2>How it works</h2>
            <p>
              The site is static. Summary statistics are stored as parquet files laid out so that a gene page reads only the
              row groups it needs, and an in-browser DuckDB engine runs every query over HTTP range requests. Source for the
              data pipeline and the interface is on <ExternalLink href={REPO}>GitHub</ExternalLink>.
            </p>
          </div>

          {m && (
            <KvTable title="Counts" align="right" rows={[
              { label: 'Genes tested', value: counts.genes_tested?.toLocaleString() },
              { label: 'eGenes', value: counts.egenes?.toLocaleString() },
              { label: 'Splice phenotypes tested', value: (tables.splice_phenotypes?.rows ?? 0).toLocaleString() },
              { label: 'Significant sQTL introns', value: `${counts.sqtl_sig_phenotypes?.toLocaleString()} in ${counts.sqtl_sig_genes?.toLocaleString()} genes` },
              { label: 'Variants in cis windows', value: (tables.variants_by_position?.rows ?? 0).toLocaleString() },
              { label: 'DCM GWAS variants', value: (tables.gwas_dcm?.rows ?? 0).toLocaleString() },
            ]} />
          )}

          <KvTable title="Data versions" rows={Object.entries(sources).map(([k, v]) => ({ label: k, value: <span><span className="font-medium text-base-content">{v.version}</span> · {v.description}</span> }))} />

          <SectionPanel title="Tables" description={m ? `Built ${String(m.built)}` : undefined}>
            <div className="overflow-x-auto rounded-lg border border-base-300">
              <table className="table table-sm">
                <thead><tr><th>Table</th><th className="text-right">Rows</th><th className="text-right">Size</th><th>Loaded</th></tr></thead>
                <tbody>
                  {Object.entries(tables).map(([k, t]) => (
                    <tr key={k}><td className="font-mono text-xs">{k}</td><td className="text-right tabular-nums">{t.rows.toLocaleString()}</td>
                      <td className="text-right tabular-nums">{(t.bytes / 1e6).toFixed(1)} MB</td><td className="text-base-content/60">{t.load === 'whole' ? 'at startup' : 'per query (range reads)'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionPanel>

          <div className="flex flex-wrap gap-x-4 text-sm">
            <ExternalLink href={PREPRINT}>Preprint</ExternalLink>
            <ExternalLink href={ZENODO}>Summary statistics on Zenodo</ExternalLink>
            <ExternalLink href={PIPELINE}>QTL mapping pipeline (nf-eqtls)</ExternalLink>
            <ExternalLink href={REPO}>Browser source</ExternalLink>
          </div>
        </div>
      </div>
    </Page>
  )
}
