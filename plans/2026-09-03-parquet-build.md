---
date: 2026-09-03
status: complete
model: Claude Fable 5.1
description: Build step that turns the raw TOPCHeF Zenodo archives, GENCODE v34, and dbSNP b157 into browser-ready parquet tables for DuckDB-WASM over R2
---

# Parquet build step

## Goal

One reproducible command that reads `data/raw/` and writes `data/derived/`: a set of parquet
tables laid out so a static site running DuckDB-WASM can answer gene, region, and variant queries
with HTTP range requests against Cloudflare R2. Small tables are loaded whole by the browser;
large tables are pruned by row-group statistics.

Out of scope here: the R2 upload, the web app, GWAS summary stats, LD, and the coloc tables we
do not yet have from the authors. Each of those is a later plan; this one only has to leave
hooks for them (a `gwas_dcm` slot in the manifest, a `coloc` table stub).

## Inputs (all present and md5-verified, see `data/raw/sources.yaml`)

| Source | Path | Notes |
|---|---|---|
| TOPCHeF QTL | `data/raw/zenodo_21382723/*.tar.gz` | 8 archives, per-chromosome parquet inside, written from R data.table (snappy, ~1M-row row groups). Variant IDs are `chr:pos`; A1 = effect/minor allele, A2 = reference. |
| GENCODE v34 | `data/raw/gencode_v34/gencode.v34.annotation.gtf.gz` | release TOPCHeF quantified against |
| dbSNP b157 | `data/raw/dbsnp_b157/GCF_000001405.40.gz` + `.tbi` + assembly report | 29.5 GB, chromosomes named by RefSeq accession |

Raw schemas are recorded in memory note `topchef-zenodo-data` and summarized here:

- cis nominal: `phenotype_id, variant_id, start_distance, af, ma_samples, ma_count, pval_nominal, slope, slope_se, chr, position, A1, A2`. Rows contiguous per phenotype. eQTL: 19,423 genes, ~90M rows. sQTL: 80,750 phenotypes, largest file chr1 at 1.2 GB.
- cis permutation: nominal columns plus `num_var, beta_shape1, beta_shape2, true_df, pval_true_df, end_distance, pval_perm, pval_beta`. One row per phenotype.
- SuSiE: `phenotype_id, variant_id, pip, af, cs_id, chr, position, A1, A2`.
- trans: `variant_id, phenotype_id, pval, b, b_se, r2, af, __index_level_0__`. Files named by variant chromosome.
- sQTL phenotype_id: `chr:start:end:clu_N_strand:ENSG.version`. eQTL phenotype_id: unversioned ENSG.

## Machine

38 GB RAM, 14 cores. The largest single raw file (sQTL chr1, 1.2 GB parquet, roughly 40M rows) fits
in memory several times over, so the build processes one chromosome file at a time and never
needs out-of-core tricks. No bcftools/tabix installed; see decision D6.

## Outputs: `data/derived/`

Every table: zstd, dictionary encoding on, pandas/R metadata stripped. Column conventions
across all tables: `gene_id` is unversioned ENSG, `symbol` is the GENCODE gene_name,
`chr` is `chr1`..`chrX`, `position` is 1-based GRCh38, `A1`/`A2` as in the raw files,
`rsid` is a string like `rs123` or null.

### Small tables (browser loads whole at startup), one file each

**`genes.parquet`** (~19.4k rows, from GTF + eQTL permutation)
`gene_id, gene_id_version, symbol, chr, start, end, strand, tss, biotype, tested (bool),
num_var, lead_position, lead_A1, lead_A2, lead_rsid, lead_af, lead_tss_distance, slope,
slope_se, pval_nominal, pval_perm, pval_beta, qval, is_egene (bool), n_credible_sets (int),
n_trans_pairs (int)`
Includes all GENCODE genes so symbol search resolves untested genes too; `tested=false`
rows have null QTL columns.

**`splice_phenotypes.parquet`** (80,750 rows, from sQTL permutation)
`phenotype_id, gene_id, symbol, chr, intron_start, intron_end, cluster_id, strand, tss,
num_var, lead_position, lead_A1, lead_A2, lead_rsid, lead_af, lead_tss_distance, slope,
slope_se, pval_nominal, pval_perm, pval_beta, qval, is_sqtl (bool), n_credible_sets`

**`credible_sets.parquet`** (~462k rows, eQTL + sQTL SuSiE)
`qtl_type ('e'|'s'), phenotype_id, gene_id, symbol, chr, position, A1, A2, rsid, af, cs_id, pip`

**`coloc.parquet`** (stub, 0 rows until the authors' tables arrive)
`qtl_type, gene_id, symbol, phenotype_id, sentinel_rsid, sentinel_chr, sentinel_position, pp_h4, gwas_beta, qtl_beta, source`

### Large tables (range-fetched), hive-partitioned by chromosome

**`cis_eqtl_nominal/chr=chrN/data.parquet`** (123M rows, 3.3 GB)
`gene_id, position, A1, A2, rs_number (int64, null if no rsID), tss_distance (int32), af (f32),
ma_samples (i16), ma_count (i16), pval_nominal (f64), slope (f32), slope_se (f32), pip (f32,
null unless in a credible set), cs_id (i8, null)`
rsIDs are integers here (`'rs' || rs_number` in SQL) because the string form costs ~45 bits per
row at per-gene row-group size; every other table keeps the `rsid` string.
Sorted by gene TSS then gene_id then position. **One row group per gene** so a
`WHERE gene_id = ?` query reads exactly that gene's bytes (~150 KB median).

**`cis_sqtl_nominal/chr=chrN/data.parquet`** (500M rows, 10.8 GB for all phenotypes)
`phenotype_id, gene_id, position, A1, A2, rs_number, tss_distance, af, ma_samples, ma_count,
pval_nominal, slope, slope_se, pip, cs_id`
Sorted by gene TSS, gene_id, phenotype_id, position. **One row group per gene** (all of a
gene's phenotypes together), not per phenotype: 80k row groups would bloat footers, and the
gene page wants all phenotypes of a gene anyway.

**`trans_pairs/chr=chrN/data.parquet`** (~3M+ rows, ~0.4 GB), partitioned by the **gene's**
chromosome, not the variant's as in the raw files
`qtl_type, phenotype_id, gene_id, symbol, variant_chr, position, A1, A2, rsid, af, pval, beta,
beta_se, r2`
Sorted by gene then pval. Row groups of ~50k rows.

**`variants_by_position/chr=chrN/data.parquet`** and **`variants_by_rsid.parquet`**
(8.87M rows each, ~150 MB each; only variants inside cis windows exist in the raw files)
`chr, position, A1, A2, rsid, rs_number (int64), match ('exact'|'position'|'none')`
by_position sorted by position with ~100k-row groups; by_rsid sorted by rs_number.

### `manifest.json`

Table names, paths, row counts, byte sizes, column lists, build timestamp, git commit of the
pipeline, and the `version` strings copied from `sources.yaml`. The browser's About page and
the R2 sync read this.

## Steps

Each step is idempotent and skips when its outputs are newer than its inputs; `--force`
rebuilds. Steps run in this order because of the dependencies noted.

1. **extract**: untar each archive into `data/raw/zenodo_21382723/<name>/` (gitignored, +12 GB).
   Keep the tarballs as the verified originals.
2. **genes_from_gtf**: parse `gene` records from the GTF into an annotation table
   (`gene_id_version, gene_id, symbol, chr, start, end, strand, tss, biotype`). Also write
   `exons.parquet` (`gene_id, transcript_id, exon_number, start, end`) for future gene-model
   tracks; ~1.4M rows, cheap.
3. **variants_collect**: distinct `(chr, position, A1, A2)` across every raw file (nominal,
   permutation, SuSiE, trans). DuckDB `UNION` over the parquet globs. Expect ~44M rows.
4. **variants_rsid**: stream the dbSNP VCF once and assign rsIDs. See D6 for the tool.
   Matching rule: same chromosome and position, and `{A1, A2}` equals `{REF, one ALT}`
   in either orientation → `match='exact'`. If no allele match but a record exists at the
   position → the lowest rs number at that position, `match='position'`. Else null,
   `match='none'`. Report the three rates; expect exact well above 95% for SNPs.
   Writes both variant tables.
5. **permutation_tables**: build `genes.parquet` and `splice_phenotypes.parquet` from the
   permutation files joined to the annotation and variant tables. `is_egene` / `is_sqtl` is
   `pval_perm < 0.05` (the paper's wording). `qval` (Benjamini-Hochberg on `pval_beta`) is
   written alongside for later use. Record the eGene count next to the paper's 10,241 in the
   manifest.
6. **credible_sets**: concatenate the SuSiE files with `qtl_type`, join symbol and rsid.
7. **nominal**: per chromosome file, per QTL type: read raw parquet → DuckDB join to gene TSS,
   rsid, and SuSiE pip/cs_id → cast types → sort → pyarrow `ParquetWriter`, calling
   `write_table` once per gene so each gene is one row group. Parallelize across chromosome
   files with a process pool of 4 (memory-bound: ~4 × 3 GB peak for the biggest sQTL files).
8. **trans**: concatenate, drop the pandas index column, join symbol and rsid, repartition by
   gene chromosome, sort by gene then pval.
9. **coloc_stub**: write the empty-schema table.
10. **manifest**: row counts via DuckDB over the outputs, sizes from disk, versions from
    `sources.yaml`.
11. **validate** (runs last, fails the build on any miss):
    - row counts of every derived nominal partition equal the raw file's row count;
    - every `gene_id` in nominal appears in `genes` with `tested=true`;
    - eGene count within 2% of 10,241 and sQTL phenotype count within 2% of 13,540;
    - the paper's named variants resolve to the paper's rsIDs through the variant table:
      chr1:2212668 → rs2503715, chr1:236689867 → rs4659701, chr7:128829863 → rs73238147,
      chr10:73646383 → rs10824026, chr4:113537246 → rs734348, chr16:918717 → rs9889137;
    - row-group pruning works: `EXPLAIN ANALYZE SELECT ... WHERE gene_id = 'ENSG00000128591'`
      (FLNC) against `cis_eqtl_nominal` scans one row group;
    - rsID exact-match rate reported and above 90%.

## Code layout and invocation

Proposed: a small Python package `pipeline/` at the repo root with one module per step and a
`pyproject.toml` at the root managed by uv (deps: duckdb, pyarrow, pyyaml; bcftools per D6).

    uv run python -m pipeline build            # all steps, skip up-to-date
    uv run python -m pipeline build --step nominal --force
    uv run python -m pipeline validate

Config: `pipeline/config.yaml` holds paths (`raw`, `derived`), the qval threshold, the
row-group sizes, and the process-pool size, so nothing is hard-coded.

## Decisions & ownership

| # | Decision | Owner / status | Rationale and what it forces |
|---|---|---|---|
| D1 | Build the sQTL nominal table for **all 80,750 phenotypes** (~7 GB), and let the upload step optionally filter to significant ones | user-owned, confirmed 2026-09-03 | Keeps the build complete and the storage choice separate. Forces ~7 GB of local disk and roughly the longest step in the build. The alternative, build significant-only (~1.2 GB), makes the browser unable to show nominal stats for non-significant introns. |
| D2 | eGene / sQTL significance = `pval_perm < 0.05`, matching the paper's wording ("permutation p-value < 0.05"); a BH `qval` column is still written for later use | user-owned, confirmed 2026-09-03 | Gives 10,220 eGenes vs the paper's 10,241; Sam judged the 90-gene gap between rules not worth a different definition. Confirm the exact rule with the authors later; the manifest records the count. |
| D3 | One row group **per gene** in both nominal tables (sQTL: all phenotypes of a gene in one group) | AI-owned, defended | Makes gene queries read only that gene's bytes. Per-phenotype groups for sQTL would mean ~80k row groups and multi-MB footers per file. Forces the sort order and means a region query reads whole-gene groups, which is fine. |
| D4 | Add sparse `pip` and `cs_id` columns to the nominal tables | AI-owned, default | Saves a client-side join for the locus plot; measured cost under 0.1 bit per row. A variant in two credible sets of one phenotype keeps the higher-PIP membership. |
| D12 | Nominal-table encodings: per-gene row groups kept; DELTA_BINARY_PACKED for position/tss_distance, BYTE_STREAM_SPLIT for floats, rsID as integer `rs_number` | AI-owned, defended | Per-gene groups lose the cross-gene repetition the raw million-row groups compress with (each variant sits in ~30 gene windows), so a plain rewrite came out 60% larger than raw. Measured on chr22: these encodings bring eQTL 10% below raw and sQTL 12% below the plain rewrite. Floats are two thirds of every row and set the floor. |
| D5 | Hive partition by chromosome; trans partitioned by **gene** chromosome | AI-owned, defended | Matches the raw layout for cis and lets DuckDB prune partitions by `chr`. Trans is re-keyed to the gene because the gene page is the consumer. Forces a variant-centric trans query to scan all partitions (small table, acceptable). |
| D6 | Use **bcftools** (`brew install bcftools`) to stream the dbSNP VCF, with DuckDB `read_csv` as the fallback | AI-owned, defended | bcftools handles the RefSeq accession rename, multi-allelic splitting, and streams 29 GB in about an hour. DuckDB on a single gzip stream is slower and needs INFO-column handling. Forces a Homebrew install on this machine. |
| D7 | Include **all GENCODE genes** in `genes.parquet`, not just tested ones | AI-owned, default | Lets search resolve any symbol and say "not tested" rather than "not found". Adds ~40k rows to a table the browser loads anyway. |
| D8 | Second, position-sorted copy of `cis_eqtl_nominal` for fast variant lookup | **open** | Doubles eQTL storage (+2 GB). Not built in this plan; the gene-sorted table can serve variant queries slowly. Decide after measuring query latency in the browser. |
| D9 | Code lives in a new top-level `pipeline/` package with a root `pyproject.toml` | user-owned, confirmed 2026-09-03 | New top-level directory; Sam's rule is to ask before creating one. Alternatives: `scripts/` with a single file, or `src/qtlbrowser/`. |
| D10 | Extract tarballs in place under `data/raw/zenodo_21382723/` rather than reading through tar | AI-owned, default | +12 GB disk, but every later step becomes plain parquet reads. Disk is not a constraint (266 GB free). |
| D11 | rsID position-fallback (`match='position'`) when alleles do not match | AI-owned, defended | Indels and strand-flipped records would otherwise have no rsID at all. The `match` column keeps the distinction visible so the browser can mark inexact IDs. |

## What this changes elsewhere

- **Disk**: +12 GB extracted raw, +~11 GB derived (D1 at full), all gitignored. Tarballs stay.
- **Browser design**: the query patterns are now fixed by the sort orders. Gene and region
  queries are cheap; variant queries against nominal tables are slow until D8 is decided.
  The client must load four small tables at startup (~10 MB).
- **R2 upload plan** (next): consumes `manifest.json`; must apply the D1 filter if we stay
  inside the 10 GB free tier; needs a CORS rule and custom domain.
- **Significance labels in the UI**: `pval_perm < 0.05` becomes the browser's definition of
  eGene (10,220 vs the paper's 10,241). If the authors used a different rule, the counts on
  the site will disagree slightly with the paper until rebuilt.
- **Author asks**: D2 confirmation, the coloc tables for `coloc.parquet`, harmonized GWAS
  stats, LD at coloc loci. None block this build.
- **Reproducibility**: `sources.yaml` versions flow into `manifest.json`, so a dbSNP or
  GENCODE bump is visible on the site.
- **Machine setup**: D6 installs bcftools via Homebrew.

## Estimated runtime

Extraction ~10 min. dbSNP stream ~1 h (dominant). Nominal re-encoding ~30 to 45 min with 4
workers. Everything else minutes. Total under 2.5 h; rerunning a single step is fast.

## Implementation log (2026-09-03)

Built by Claude Fable 5.1 in one session. All steps in `pipeline/`, run as `uv run python -m
pipeline build` then `validate`. Wall time roughly 25 minutes of compute across the day; the
longest step (nominal re-encoding of 46 files) takes 2.4 minutes with 3 workers.

What happened, in order:

1. extract (2.2 min), gtf (8 s): 60,624 genes, 1.38M exons.
2. variants_collect: 8,872,723 distinct (chr, position, A1, A2) across all cis files in 2 s.
   Far below the 44M genome-wide SNPs because only cis-window variants exist in the files.
3. variants_rsid: bcftools with `-T` on 8.87M target positions streamed the 29.5 GB dbSNP VCF
   in 4.5 min (the plan's one-hour estimate assumed no target filtering). 9.72M dbSNP records
   at those positions. Match rates: exact 99.48%, position-only 0.51%, none 0.01%.
4. permutation_tables: 10,220 eGenes (`pval_perm < 0.05`), 13,540 significant splice
   phenotypes in 5,584 genes, both the paper's exact sQTL numbers. 0 tested genes missing from
   the GTF.
5. credible_sets: 461,784 rows.
6. nominal, three failures before it ran clean:
   - Workers died with `BrokenProcessPool`. Cause: all DuckDB workers shared one
     `temp_directory`, and DuckDB spill files have fixed names, so concurrent processes
     clobbered each other. Same class as the Rmd gotcha in CLAUDE.md. Fixed by a per-worker
     temp dir in `connect()`. Saved to memory as `duckdb-concurrent-temp-dir`.
   - sQTL chr2 gained 12 rows through the SuSiE join: 12 (phenotype, variant) keys appear in
     two credible sets. Fixed by keeping the max-PIP membership per key (D4).
   - Output was larger than raw (4.3 GB vs 2.7 GB eQTL). Fixed by D12; final 3.3 GB.
   Also rewritten from "materialize the whole chromosome in Python" to a streaming DuckDB
   COPY plus pyarrow regroup, so memory is bounded regardless of file size.
7. trans: 15,862,525 pairs (2.68M eQTL + 13.18M sQTL), repartitioned by gene chromosome.
8. validate: all 13 checks pass. One check was corrected: the paper's eQTL text places
   rs10824026 at chr10:73,646,383, but dbSNP and the paper's own sQTL section put it at
   73,661,450; 73,646,383 is rs3740293. The config now uses the dbSNP position.

Final `data/derived/` is 14.9 GB:

| Table | Rows | Size |
|---|---|---|
| cis_sqtl_nominal | 499.6M | 10.8 GB |
| cis_eqtl_nominal | 123.5M | 3.3 GB |
| trans_pairs | 15.9M | 449 MB |
| variants_by_position + variants_by_rsid | 8.87M each | 271 MB |
| genes, splice_phenotypes, credible_sets, coloc | 60k / 81k / 462k / 0 | 15.5 MB |
| gene_annotation, exons | 60k / 1.38M | 10.4 MB |

Things learned that affect the next plans:

- PJVK and CDKN1A, two of the 21 coloc eGenes, are not eGenes under the permutation rule
  (pval_perm 0.15 and 0.39). Their coloc must have used nominal stats. The browser needs to
  show coloc hits independently of the eGene flag.
- The paper reports the GWAS sentinel per locus, not the lead eQTL variant, so lead SNPs in
  `genes.parquet` differ from the paper's rsIDs for most loci (SKI is the exception, where the
  two coincide at rs2503715).
- The R2 free tier (10 GB) is exceeded by the sQTL nominal table alone. Either filter to
  significant phenotypes at upload or accept roughly a dollar a year in overage.
- D8 (position-sorted eQTL copy for variant queries) remains open.
