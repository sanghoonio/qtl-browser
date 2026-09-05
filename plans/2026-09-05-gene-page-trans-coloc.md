---
date: 2026-09-05
status: complete
model: Claude Fable 5.1
description: Fold the trans tab into the eQTL and sQTL tabs, and add a DCM colocalization placeholder section to the gene page
---

# Gene page: trans under each tab, coloc placeholder

## Why

The trans tab mixes eQTL and sQTL rows, so it needs a Type column and a Phenotype column.
On the gene page both are noise: the phenotype is the gene the reader is already on, and
for eQTL rows the column literally says "expression". Splitting trans across the two tabs
removes both columns and puts the trans hits next to the cis results they complement.

Colocalization with the Jurgens 2024 DCM GWAS is the preprint's headline result, but the
browser only has a hard-coded gene list and a badge. A section on the gene page makes the
gap explicit and reserves the place where PP.H4 and sentinels will go once the authors
share the coloc tables. The SuSiE files on Zenodo are single-trait fine-mapping only;
nothing on disk can produce coloc statistics.

## Changes

1. `Gene.tsx`: tabs become eQTL and sQTL. `?tab=trans` in a URL falls back to eQTL.
   Trans rows are fetched once per gene in the page component (same `transPairs` query)
   and passed to both tabs; each tab filters by `qtl_type`.
2. eQTL tab, after the credible sets: a **DCM GWAS colocalization** section, then the cis
   table, then a **trans associations** section with variant-only columns (variant
   chromosome, position, rsID, AF, p, beta ± SE, r²). Rows link to the variant page.
3. sQTL tab: the coloc section sits inside the selected-intron block after its credible
   sets, since sQTL coloc is per intron. The trans section comes last and covers every
   intron of the gene, with an Intron column, since trans hits are sparse and hiding them
   behind the intron picker would lose most of them.
4. Coloc placeholder text: for genes in the coauthor's list, "Reported as colocalized with
   the DCM GWAS (coloc PP.H4 > 0.8); the coloc table with posterior probabilities and
   sentinel variants is not yet available." For everyone else, "Not among the genes reported
   as colocalized with the DCM GWAS (coloc PP.H4 > 0.8)." Same `Empty` box as the credible
   set table's empty state.
5. `Variant.tsx`: trans rows navigate to `?tab=sqtl` or no tab, never `?tab=trans`.
6. The trans count moves from the tab label into each section title.

## Decisions & ownership

| # | Decision | Owner | Note |
|---|---|---|---|
| D1 | Trans lives under eQTL / sQTL tabs, no trans tab | user-owned, surfaced | Sam proposed it |
| D2 | sQTL trans section shows all introns of the gene, not just the selected one | AI-owned, defended | trans sQTL rows are per intron and sparse; the picker is about the cis locus |
| D3 | Coloc placeholder is a static text state driven by the hard-coded gene lists | AI-owned, defended | no coloc data exists on disk; the section is a reminder and a slot |
| D4 | Coloc section placement: after credible sets, before the cis table | AI-owned, default | keeps it next to LocusCompare and fine-mapping, which it will eventually reference |
| D5 | `n_trans_pairs` from `gene_detail` no longer shown anywhere | AI-owned, default | counts now come from the fetched rows; the column stays in the parquet |
| D6 | Trans fetch moves to the page component | AI-owned, defended | one read per gene instead of one per tab visit |

## What this changes elsewhere

- Variant page links: `?tab=trans` would land on eQTL anyway via the fallback, but the link
  is corrected so the URL is honest.
- `gene_detail.n_trans_pairs` becomes an unused column in the UI; the pipeline is untouched.
- Cold gene page: the trans read (~350 KB on a large chromosome) now happens on first load
  rather than only on the trans tab. It is one range read and runs in parallel with
  `gene_detail`.
- No data, pipeline, or R2 changes.

## Implementation log

2026-09-05. `ui/src/routes/Gene.tsx`: `Tab` is `'eqtl' | 'sqtl'`; an unknown `?tab=` value
falls back to the default. The page component fetches `transPairs` alongside `gene_detail`
and splits the rows by `qtl_type` for the two tabs. New `ColocSection` (static text from
`COLOC_EQTL_GENES` / `COLOC_SQTL_GENES`) sits after the credible sets on the eQTL tab and
inside the selected-intron block on the sQTL tab. New `TransSection` replaces `TransTab`:
no Type or Phenotype column; the sQTL variant adds an Intron column and covers every intron
of the gene. Section title carries the row count. `ui/src/routes/Variant.tsx`: trans rows
link to `/gene/<id>` or `?tab=sqtl`. `tsc -b` clean; oxlint warning count unchanged from
main (30, all pre-existing set-state-in-effect style warnings).

Follow-ups the same day from Sam's review: the eQTL header stat is labelled "Lead distance
to TSS" (it is the lead variant's distance); the coloc section is titled "GWAS
colocalization" with one-line placeholders ("Reported as colocalized (PP.H4 > 0.8); coloc
statistics not yet available." / "No reported colocalization."); `CisTable` rows navigate
to the variant page on click like the trans rows; the rsID cell is plain text since the row
already navigates. Cis and trans section headers use the same title and description shape.

Later the same day: `transPairs` no longer caps at 2,000 rows (busiest gene has 25,828;
the query reads the gene's row groups regardless, so the cap only truncated what reached
the browser). New `ui/src/components/TransTable.tsx` gives the trans section the cis
table's control bar: rsID/position search, p threshold (1e-6, 1e-8, 1e-10), sortable
columns, CSV export of the filtered rows.

Then, for consistency and a future trans plot, both tables now page off materialized DuckDB
tables instead of one reading parquet per page and the other holding a JS array.
`db.ts` `materialize(sql, prefix)` replaces `materializeLocus`. The gene page materializes
`trans_N` once per gene (`transSQL`) and drops it on gene change; `TransTable` pages off it
with `transRows` / `transCount` / `transAll`, chromosome-aware position sort, rsID search on
`substr(rsid, 3)`. `LocusPlot` adds `tss_distance`, `ma_samples`, `ma_count` to the locus
table and reports its name through `onTable(name, failed)`; each tab holds that and passes
it to `CisTable`, whose queries now target the table (`CisQuery.table`) instead of
re-reading the nominal parquet. Cis therefore no longer depends on the browser HTTP cache
to make page two cheap. SQL shapes were checked against the local parquet in DuckDB.
Lint warning count 32 (two more set-state-in-effect, same pattern as the rest).
