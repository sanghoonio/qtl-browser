---
date: 2026-09-03
status: in-progress
model: Claude Fable 5.1
description: Static browser UI prototype over the derived parquet (DuckDB-WASM + Mosaic/vgplot, Tailwind + DaisyUI), served from local files until the R2 upload
---

# UI prototype

## Goal

A static single-page app that answers the three query types (gene, variant, region) against
`data/derived/` with tables first and one interactive locus plot per gene, styled with Tailwind
and DaisyUI, all computation in the browser through DuckDB-WASM. During the prototype the
parquet is served by the Vite dev server from a symlink into `data/derived/`; switching to R2
later is a one-line base-URL change.

Not in scope: the R2 upload and CORS setup (next plan), LocusCompare and LD (need GWAS stats and
LD from the authors), the coloc table content (stub is empty), user accounts, server code.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Build | Vite 7 + TypeScript | static output, fast dev, serves `public/` with HTTP range support |
| UI | React 19 + TypeScript | Sam's choice; `lucide-react` icons, function components with Tailwind classes |
| Styling | Tailwind 4.3 + DaisyUI 5.7 + @tailwindcss/typography | per `/tailwind-ui-styling`; `lucide-react` icons |
| Query | `@duckdb/duckdb-wasm` 1.33 (DuckDB 1.4-line) | reads our zstd/delta/byte-stream-split parquet; verified with DuckDB CLI 1.5 |
| Plots and cross-filter | `@uwdata/mosaic-core` + `@uwdata/vgplot` 0.31 with the wasm connector | plots and tables driven by the same DuckDB instance, brush-to-filter for free |
| Routing | `BrowserRouter`, clean paths (`/gene/ENSG…`) | deploy target is Cloudflare Pages/Workers, which rewrite unknown paths to `index.html` via `public/_redirects` |
| Charts guidance | `/dataviz` skill loaded before the first plot is written | palette, marks, tooltips |

## Data access pattern

Startup (once per session), kept under about 1 MB of data:
- Instantiate DuckDB-WASM, enable httpfs, `SET parquet_metadata_cache = true`.
- `CREATE TABLE search_index AS SELECT * FROM read_parquet('<base>/search_index.parquet')`:
  gene_id, symbol, chr, tss, tested, is_egene, n_sqtl_sig for all 60k GENCODE genes, measured at
  ~0.7 MB. This drives typeahead, gene → chromosome resolution, and the region page.
- Read `manifest.json` (a few KB) for table paths and the About panel.
- Nothing else is loaded whole. `genes`, `splice_phenotypes`, `credible_sets`, and `coloc` are
  range-read per page like the big tables, which needs them re-written with small row groups
  and statistics on `gene_id` (a parquet-build follow-up, step 0 below).
- The DuckDB-WASM bundle itself (~5 MB wasm, ~2 MB over the wire with brotli) is the fixed cost
  of the query engine and is cached by the browser after the first visit.

Per page (range reads):
- Gene page: `read_parquet('<base>/cis_eqtl_nominal/chr=<chr>/data.parquet') WHERE gene_id = ?`.
  The chromosome comes from the in-memory genes table, so the app always names the exact
  partition file; there is no directory listing over HTTP. One row group per gene means one
  small range read after the footer.
- sQTL: same against `cis_sqtl_nominal/chr=<chr>/` filtered by `gene_id`, then by
  `phenotype_id` for the selected intron.
- Trans: `trans_pairs/chr=<gene chr>/` filtered by `gene_id`.
- Variant page: rsID → `variants_by_rsid.parquet` (range read on `rs_number`) → chr:pos →
  lead-variant hits from `genes` and `splice_phenotypes` (range-read by chr, position stats),
  credible-set hits (`credible_sets` sorted by chr, position copy), plus trans. The
  cross-gene nominal lookup (every gene window covering the position) is a button-triggered
  slow path in phase 1, revisited under plan D8 of the parquet build.
- Region page: `search_index` filtered by chr and span (in memory), then `genes` range-read
  for the rows shown.

## Pages and components

1. **Home** `/`: search input (symbol, Ensembl ID, rsID, `chr:pos`, `chr:start-end`, with
   typeahead from the genes table), the 21 eQTL + 4 sQTL colocalized genes as cards with lead
   variant and eGene badge, dataset counts from the manifest, link to the preprint and Zenodo.
2. **Gene** `/gene/<ENSG>`: header (symbol, ID, chr:start-end, strand, biotype, eGene and
   sQTL badges, coloc badge when present). Tabs:
   - *eQTL*: summary stat tiles (lead variant with rsID, slope ± SE, permutation p, q-value, AF,
     distance to TSS, credible sets); locus plot; credible-set table; full cis-window table.
   - *sQTL*: phenotypes grouped by leafcutter cluster with intron coordinates and significance;
     selecting one swaps the locus plot and table to that phenotype.
   - *trans*: table of trans pairs for the gene.
   Every table has column sort, a p-value or PIP filter, and a CSV download of the current
   query. Every rsID links to dbSNP; every position links to the UCSC browser at GRCh38.
3. **Variant** `/variant/<rsID or chr:pos>`: variant facts (alleles, AF, rsID, dbSNP link) and
   a table of everything it leads or fine-maps, plus trans targets.
4. **Region** `/region/chr:start-end`: genes in the region with eGene/sQTL status and lead
   variants; click through to gene pages.
5. **About** `/about`: methods summary, significance rule, source versions, build date.

Locus plot (vgplot): x = position, y = -log10 p, dots colored by credible-set membership with
PIP as opacity, TSS rule mark, hover tooltip (rsID, alleles, p, slope), brush selection that
filters the cis-window table below through a Mosaic selection. Y-axis capped by the data.

Tables: vgplot's `table` component bound to the same Mosaic coordinator for the large
cis-window table (virtual scrolling, server-side sort via DuckDB); plain Svelte tables for the
small in-memory ones. Consistent cell formatting: `tabular-nums`, p-values in scientific
notation with 2 significant digits, slopes to 3 decimals.

## Code layout

    ui/
      package.json  vite.config.ts  tsconfig.json
      public/data -> ../../data/derived      (symlink, dev only; gitignored)
      src/
        app.css                 Tailwind + DaisyUI entry
        main.tsx  App.tsx       shell, router
        lib/db.ts               DuckDB-WASM bootstrap, base URL, search_index load
        lib/queries.ts          every SQL string in one place
        lib/format.ts           number/pvalue/rsid formatting
        lib/links.ts            dbSNP, UCSC, Ensembl URL builders
        routes/Home.tsx  Gene.tsx  Variant.tsx  Region.tsx  About.tsx
        components/Search.tsx  LocusPlot.tsx  CisTable.tsx  StatTile.tsx
                   CredibleSetTable.tsx  SplicePhenotypeList.tsx  TransTable.tsx

`VITE_DATA_BASE` env var: `/data` in dev, the R2 URL in production. Nothing else changes.

## Steps

0. Parquet-build follow-up (`pipeline/steps_tables.py`): emit `search_index.parquet`; re-write
   `genes` sorted by chr, tss with ~1k-row groups and stats on chr, tss, gene_id;
   `splice_phenotypes` and `credible_sets` sorted by gene_id with small row groups and stats on
   gene_id, plus a position-sorted `credible_sets_by_position` for the variant page. Rebuild,
   regenerate the manifest, validate. Minutes.
1. Scaffold `ui/` (Vite + React + TS), Tailwind/DaisyUI config, hash router, app shell with
   header and theme toggle. Symlink `public/data`. Confirm Vite serves a parquet with a
   `Range` request (curl check).
2. `db.ts`: DuckDB-WASM init, startup tables, a `query(sql, params)` helper returning Arrow.
   Smoke test: FLNC returns 6,050 rows and 40 credible-set variants, matching the CLI.
3. Search + Home page + coloc cards.
4. Gene page eQTL tab: stat tiles, credible-set table, cis-window table with sort/filter/CSV.
5. Locus plot with Mosaic brush linked to the table. Load `/dataviz` first.
6. sQTL tab and trans tab.
7. Variant and Region pages, About page.
8. Polish: loading states, empty states (untested gene, no sQTL), error toasts, keyboard
   search, responsive layout, dark theme check.
9. `npm run build`; confirm the `dist/` works from a plain static file server (e.g. `npx serve`)
   with the data base URL pointed at the same local files, which is the R2 rehearsal.

## Decisions & ownership

| # | Decision | Owner / status | Rationale and what it forces |
|---|---|---|---|
| D1 | React 19 + Vite + TypeScript | user-owned, confirmed 2026-09-03 | Sam chose React over Svelte/vanilla. Forces `lucide-react`, function components, and `react-router`. |
| D2 | New top-level `ui/` directory for the app | user-owned, confirmed 2026-09-03 | Sam chose `ui/`. |
| D3 | Mosaic coordinator over DuckDB-WASM for both plots and the large table | AI-owned, defended | One query engine, cross-filtering by construction, virtual-scroll tables. Forces Mosaic's API conventions and its Observable Plot rendering; d3 stays available for anything custom. |
| D4 | Dev data served from a `public/data` symlink into `data/derived/` | AI-owned, defended | Zero copy, same URL shape as R2. Forces `follow symlinks` in Vite (default) and gitignoring the link. |
| D5 | Startup loads only a ~0.7 MB `search_index`; every other table is range-read per page | user-owned, confirmed 2026-09-03 | Sam judged 10 to 16 MB per visit too large. Forces step 0 (small row groups and gene_id statistics on the four formerly whole-loaded tables) and one extra range read per gene page for each of genes, splice_phenotypes, credible_sets. |
| D6 | Variant page phase 1 shows lead/credible-set/trans hits only; the cross-gene nominal scan is an explicit button | AI-owned, defended | Keeps the page fast; the scan touches ~30 row groups. Full solution is parquet-build D8. |
| D7 | Path routing with a Cloudflare `_redirects` rewrite | user-owned, confirmed 2026-09-03 | Sam: deploy is Cloudflare Pages or a Worker, so hash routing has no benefit. Forces the `/* /index.html 200` rule; the site will not work on a host without rewrites (e.g. GitHub Pages). |
| D8 | Number formatting rules (p to 2 sig figs sci, slope 3 dp, AF 3 dp) | AI-owned, default | Consistency across tables; CSV export keeps full precision. |
| D9 | `rs_number` integer in nominal tables rendered as `rs…` in the UI | inherited from parquet plan D12 | SQL does `'rs' \|\| rs_number`; nothing else. |
| D10 | Locus plot y-axis is -log10 p uncapped | AI-owned, default | Simple; a cap can be added if outliers squash the plot. |
| D11 | No GWAS overlay, no LD coloring in phase 1 | open (blocked on authors) | Inputs do not exist yet. The plot component leaves a slot for a second track. |

## What this changes elsewhere

- **Repo**: new `ui/` tree with `node_modules` (gitignored) and a lockfile; `.gitignore`
  gains `ui/node_modules`, `ui/dist`, `ui/public/data`.
- **Data contract**: the app hard-codes table paths and column names from `manifest.json`.
  Any parquet rebuild that renames a column breaks the UI; the manifest is the contract.
- **R2 plan**: the app expects the same directory layout under one base URL, range requests,
  and CORS allowing the site origin. `parquet_metadata_cache` means footers are fetched once
  per file per session (chr1 eQTL footer ~2 MB).
- **Performance budget**: first visit downloads DuckDB-WASM (~2 MB compressed) plus ~0.7 MB
  of search index; each gene page adds a footer and one row group per table touched (five
  tables on the eQTL tab). Worth measuring in step 9 before the upload plan decides on the
  sQTL filter.
- **Parquet build**: step 0 changes the four small tables' layout and adds two files; the
  manifest `load` field becomes `whole` for search_index only.
- **Author asks** unchanged: coloc tables, GWAS stats, LD, eGene rule confirmation.

## Implementation log

### 2026-09-03 to 2026-09-04

Steps 0 through 7 are done; 8 (polish) is partly done; 9 (static build rehearsal) is not.

**Built.** `ui/` on React 19 + Vite + TypeScript with `@` aliasing. DuckDB-WASM boots in the
background with only `search_index` loaded whole; every other table is range-read. Pages:
Home, Genes (in-memory browse of the search index with filter, sort, pager), Gene (eQTL,
sQTL, trans tabs), Variant, Region, About. Mosaic/vgplot locus plot with credible-set color
and shape encoding, Observable Plot tooltips, underflow handling for p = 0, and a collapsed
exon gene track on a shared x axis beneath it. Expandable credible-set rows. Cis-window table
with rsID/position search, a p-value threshold select, sort, pager, CSV export.

**Decisions made after the plan was written** (added to the ledger by reference here):

- D5 revisited: startup loads only `search_index` (~0.9 MB) plus, for the landing track,
  `gwas_dcm_bins` (22 KB). The parquet build gained `search_index`, small row groups on the
  summary tables, `exons` re-written per gene, and a `gwas_bins` step.
- D7 changed to path routing with `public/_redirects` for Cloudflare (Sam, 2026-09-03).
- No brushing on the locus plot (Sam judged it not useful here); no marker outlines; lower
  opacity; legend in the section header; x axis on the scatter, gene track beneath with no
  axis; variant count in the section description.
- Styling was first ported from drumbeat-atlas (shell, page header, segmented tabs, sortable
  headers, pager, kv tables, skeletons), then the atlas rail was replaced by a top navbar with
  text links only, shared container inset, no sticky header, breadcrumbs in the page header.
- Theme: "Myocardium" (oxblood primary for eQTL, slate blue secondary for sQTL, rose accent
  for both, orange-red error for GWAS windows) on plain white with neutral grays. The brand
  color is confined to actions, the active nav item, the wordmark, eGene badges, and eQTL
  markers; in-content links are ink with hover underline (`link-quiet`). Favicon and
  theme-color are generated from the live theme tokens (lucide croissant).
- Landing page: hero, three-line description with counts from the manifest, search, example
  links, then the paper's colocalized loci on a static whole-genome track (ported from
  pegasus-v2f-ui: seqcol chromosome sizes kept, DOM show/hide pattern kept in the zoomable
  mode, rough edges fixed) with always-on labels that magnify on hover and open the gene, and
  a Miami-style lower half: DCM GWAS strongest −log10 p per 5 Mb window, red where genome-wide
  significant, capped at 20, autosomes only. The summary tiles and gene cards were dropped.
- Jurgens et al. 2024 DCM GWAS summary statistics are public on the CVD Knowledge Portal and
  are now in `data/raw/dcm_gwas_jurgens2024/` via `sources.yaml`; only the binned table is
  derived so far. LocusCompare (full position-sorted parquet) is the next data step.
- rsIDs everywhere on gene pages link to the internal variant page; dbSNP, gnomAD, Open
  Targets, and Ensembl links live on the variant page.
- Pagination: 10 rows default on the gene page tables, 25 on the Genes page.
- Working rules recorded in memory: Sam runs dev servers himself; code changes go through
  Edit/Write so rewind can revert them.

### 2026-09-04, step 9: static build rehearsal

- `vite build` had been copying the `public/data` symlink into `dist/` (15 GB). Replaced by a
  Vite plugin that serves `../data/derived` at `/data` with HTTP Range support in both `vite`
  and `vite preview`; `dist/` is now 76 MB, all of it app assets.
- First-visit download: DuckDB-WASM `eh` bundle 36 MB raw, 8.1 MB gzip, 5.3 MB brotli (the
  `mvp` bundle also ships but only one loads); app JS 299 KB gzip; `search_index.parquet`
  937 KB; `gwas_dcm_bins.parquet` 22 KB; manifest 7 KB. The wasm dominates: the deployment
  plan must confirm Cloudflare Pages serves `application/wasm` compressed, or pre-compress.
- Per-page reads measured from parquet metadata (footer once per file per session, then the
  matching row groups), FLNC as the example: eQTL nominal 853 KB footer + 161 KB; genes
  117 + 109 KB; credible sets 235 + 86 KB; exons 179 + 83 KB; splice phenotypes 148 + 179 KB;
  sQTL nominal 804 KB footer + 415 KB; trans 21 KB + ~570 KB.
- Two layouts were wrong and are fixed in the pipeline: `exons` was in GTF order so a gene
  touched 16 row groups (464 KB, now 3 groups / 83 KB); `trans_pairs` was sorted by TSS so a
  gene read the whole partition (21.7 MB, now one 20k-row group).

**Open.** Browser confirmation of the preview build (Sam runs `npm run preview`); LocusCompare; variant-sorted trans
table and the D8 position-sorted eQTL copy; dark-theme and narrow-screen sweeps; the coloc
table content, LD, and the eGene rule confirmation from the authors.

### 2026-09-04, R2 sizing

- D12 (Sam): sQTL nominal rows are kept only for the 13,540 significant introns
  (`sqtl_nominal: significant`), 84.5M of 499.6M rows, 2.0 GB instead of 10.8. Alternatives
  measured: all introns of sGenes 6.3 GB (bucket over 10 GB), a global p cutoff (breaks the
  locus plot). Every intron keeps its permutation row; the sQTL tab shows an Empty panel for a
  non-significant intron instead of the locus plot, credible sets, and cis table. The
  all-introns build is parked at `data/derived/_full/cis_sqtl_nominal`, never uploaded.
- D13 (Sam): `gwas_dcm` row groups 50k → 10k so a 2 Mb LocusCompare window reads one or two
  groups. chr7: footer 11 → 50 KB, FLNC read 1,053 → 487 KB.
- Upload set (everything but `_tmp`, `_full`, logs, `.done`): 7.0 GB. eQTL nominal 3.3,
  sQTL nominal 2.0, trans both copies 1.0, gwas_dcm 0.3, variants 0.27, small tables 0.03.
- `validate` compares sQTL partitions to the raw rows of significant introns when the
  config says so; the manifest records `tables.cis_sqtl_nominal.scope`.
- R2 requirements noted for the deployment plan: custom domain rather than r2.dev, CORS
  allowing GET/HEAD with the Range header and exposing Content-Range, Content-Length,
  Accept-Ranges; each range request is one Class B operation of the 10M/month allowance.
