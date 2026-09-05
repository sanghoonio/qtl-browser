---
date: 2026-09-05
status: complete
model: Claude Fable 5.1
description: Re-encode the sQTL nominal cis files with one row group per intron instead of per gene, so a gene page reads one intron's rows
---

# sQTL nominal: one row group per intron

## Why

The sQTL tab is slow for genes with several significant introns. The nominal parquet had
one row group per gene, rows sorted by intron then position. Every UI query filters on
gene and intron, but DuckDB reads whole row groups, so the first intron's locus pulled the
entire gene block and filtered in memory. Measured on the derived files:

| Gene | Sig introns | eQTL row group | sQTL row group (per gene) |
|---|---|---|---|
| CAMK2D | 9 | 180 KB | 1,360 KB |
| LMF1 | 4 | 221 KB | 778 KB |
| TKT | 5 | 150 KB | 628 KB |
| SYNPO2L | 3 | 112 KB | 280 KB |

## Change

`pipeline/steps_nominal.py`: `_regroup` groups on `phenotype_id` for sQTL (still `gene_id`
for eQTL). Rows are already sorted `bin, tss, gene_id, phenotype_id, position`, so introns
are contiguous. `phenotype_id` statistics were already written, so DuckDB prunes to one
row group per intron query. No UI change.

`pipeline/steps_finish.py` validate: each of CAMK2D's nine significant introns must touch
exactly one row group in its chr4 bin file.

Rebuild: the old output was moved to `data/derived/cis_sqtl_nominal.old` and
`steps_nominal.run(Config())` re-ran (freshness check rebuilds only the missing sQTL
files). Log in `data/derived/build_11_sqtl_intron_rowgroups.log`.

## Decisions & ownership

| # | Decision | Owner | Note |
|---|---|---|---|
| D1 | Regroup per intron | user-owned, surfaced | Sam asked for it after the measurement |
| D2 | No R2 upload until local testing and Sam's explicit go-ahead | user-owned, surfaced | 10 GB free-tier cap must not be exceeded |
| D3 | Rebuild via the step function directly, old output kept beside it | AI-owned, defended | `build --step nominal --force` would also redo the 3.1 GB eQTL files; keeping the old dir allows size comparison and rollback |
| D4 | eQTL layout unchanged | AI-owned, defended | one gene is one phenotype there |
| D5 | Validate check uses CAMK2D | AI-owned, default | the coloc gene with the most significant introns |

## What this changes elsewhere

- **Footers grow.** Row groups go from one per gene (5,584) to one per significant intron
  (13,540) across the sQTL bin files, so per-file footer size roughly doubles. Still below
  the eQTL footers.
- **R2 sync replaces files in place.** `cis_sqtl_nominal` is ~1.8 GB; `upload sync` will
  re-upload every bin file. The bucket total should stay about the same since the rows and
  encodings do not change, but the exact delta is checked locally before any upload.
- `data/derived/cis_sqtl_nominal.old` occupies 1.8 GB locally until deleted after
  comparison.
- The `nominal` step stays marked done; the manifest step needs a re-run so
  `manifest.json` reflects the new files.

## Implementation log

2026-09-05. Rebuilt sQTL nominal twice (each run about 45 s with 3 workers): first with
the grouping change alone, then with `rs_number` switched to DELTA_BINARY_PACKED for sQTL
as well, since the dictionary encoding had been chosen for cross-intron repetition that no
longer exists inside a row group. Row-group total is exactly 13,540, one per significant
intron. Validate passes, including the CAMK2D check (nine introns, one row group each, 94 KB
footer). `manifest.json` refreshed.

| Layout | sQTL nominal total | CAMK2D first-intron read | Mean / max footer |
|---|---|---|---|
| per gene (old) | 1.99 GB | 1,360 KB | 31 / 59 KB |
| per intron, dictionary rs_number | 2.40 GB | 190 KB | 74 / 177 KB |
| per intron, delta rs_number (kept) | 2.28 GB | ~180 KB | 74 / 177 KB |

The growth is in the variant-level columns (rs_number, af, ma_count, alleles) that repeat
per intron and were previously compressed across the gene block. Upload set (everything
under `data/derived` minus the excludes and the `.old` dir) is 7.25 GB, up from 6.96 GB.
Uploaded to R2 on Sam's go-ahead (2026-09-05, log `data/derived/upload_03_sqtl_introns.log`):
218 objects, the 217 sQTL bin files replacing the same keys plus `manifest.json`. Bucket went
from 6.95 GB (760 objects) to 7.25 GB (760 objects). `upload check` passes and CAMK2D's
chr4 bin 4 file range-reads at its local size. The old per-gene build sits in
`data/derived/_tmp/cis_sqtl_nominal.old` (excluded from sync) and can be deleted.
