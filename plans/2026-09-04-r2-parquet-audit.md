---
date: 2026-09-04
status: complete
model: Claude Fable 5.1
description: Read-only audit of the R2 parquet layout and DuckDB-WASM range-read efficiency
---

# R2 parquet layout and DuckDB-WASM read efficiency

Read-only audit. Nothing under the repo was changed except this file. Every number is tagged
**measured** (pyarrow metadata, DuckDB `EXPLAIN ANALYZE`, curl, or the shipped DuckDB-WASM
binary driven from Node) or **estimated** (arithmetic on measured pieces).

## Summary, ranked by impact

1. **The deployed app downloads whole parquet files, not ranges.** DuckDB-WASM
   `1.33.1-dev57.0` (the version in `ui/package.json` and what jsDelivr serves) emits
   `forceFullHttpReads: true` for every HTTP file unless `db.open({filesystem: {...}})` is
   called, and `ui/src/lib/db.ts` never calls `open`. Measured by running the shipped
   `duckdb-eh.wasm` with an instrumented `XMLHttpRequest`: a cold FLNC page fetched
   `cis_eqtl_nominal/chr=chr7` (155.4 MB), `gwas_dcm/chr=chr7` (17.4 MB), `genes` (3.6 MB),
   `credible_sets` (6.3 MB) and `exons` (8.1 MB) in full: 191 MB for one gene page, 636 MB for
   the whole tour below. With `forceFullHTTPReads: false` the same binary range-reads the same
   tour in 34.8 MB. The whole-file mode also keeps each file in WASM memory
   (`DataProtocol::BUFFER`), so a session that visits several chromosomes holds hundreds of MB
   in the worker heap. The `value_or(true)` default is present in the v1.31.0, v1.32.0,
   v1.33.0 tags and `main`, so pinning a release does not fix it; the one-line `open` call
   does. Confirm in DevTools before anything else: the R2 responses should be `206` with a
   `Range` request header, not `200` at full `Content-Length`.
2. **After that fix, request count, not bytes, is the cost.** A cold FLNC eQTL page issues
   61 HTTP requests for 2.8 MB (measured), and DuckDB-WASM issues them strictly one after
   another (single-threaded `eh` bundle, synchronous XHR, one connection processed query by
   query). At the measured 86 ms per request on a kept-alive connection that is 5.2 s of pure
   latency before transfer; 6.7 s estimated total. Three mechanics cause the count:
   `WebFileSystem::OnDiskFile()` returns `true`, which disables core's row-group prefetch and
   coalescing, so a row group is read column chunk by column chunk through a 16 KB, ×4
   read-ahead (a 165 KB row group costs 16K + 64K + 256K + three or four 16–64K jumps, 6 GETs,
   430 KB); every `read_parquet` on a URL does a `HEAD` for `FileExists` plus a second `HEAD`
   on first open; and a footer is read as 3–5 GETs.
3. **Footers of the per-gene nominal tables are 5× the data a gene page needs.** chr7 eQTL:
   874 KB footer vs 165 KB row group; chr1: 1.89 MB. Footer size is 69 B per column chunk ×
   908 row groups × 14 columns; statistics are 7% of it (measured on chr22: 476 KB as built,
   461 KB with `gene_id` stats only, 441 KB with none). Only fewer row groups, fewer columns,
   or smaller files shrink it. Splitting each chromosome into TSS-binned files (~100 genes each)
   cuts the per-page footer to ~100 KB without touching the one-row-group-per-gene rule.
4. **The four small per-gene lookups cost more requests than the locus.** `genes` (12
   requests, 270 KB), `credible_sets` (10, 362 KB), `exons` (12, 391 KB) and `splice_phenotypes`
   (13, 326 KB) each pay a footer (120–241 KB, 4 GETs), 2–3 admitted row groups, and 1–2 HEADs.
   36 of the 61 requests on a cold gene page are these lookups; the locus itself is 23. The
   credible-set rows are already in the nominal row group (`pip`, `cs_id`), and the gene
   window could come from `search_index` if it carried `start`, `end`, `strand`, `biotype`
   (+~300 KB at boot).
5. **Single-row lookups in 20k–100k-row groups fetch 0.6–4.4 MB each.** `variants_by_rsid`
   (100k rows/group): 1.8 MB, 13 requests for one row. `variants_by_position`: 4.4 MB (the
   read-ahead accelerates to a 2.8 MB read inside a 1.7 MB group). `trans_by_variant` and
   `trans_pairs` (20k rows/group): 1.4–1.8 MB, 10–13 requests. A variant page is 32 requests
   and 3.7 MB before the optional scan; the scan adds 37 requests and 13 MB.
6. **r2.dev is HTTP/1.1 only, sends no `Cache-Control`, and has no edge cache** (measured:
   ALPN accepts `http/1.1` only; no `cache-control` or `cf-cache-status` header). A custom
   domain in front of the bucket adds edge caching (TTFB ~30–50 ms instead of 120–150 ms on
   hits), HTTP/2/3, and honoured `Cache-Control`; with `immutable` headers the browser can
   serve repeat visits from disk. HTTP/2 multiplexing by itself changes nothing here because
   the reads are serial.

## 1. Tables

All numbers measured with pyarrow on `data/derived/` (same bytes as the bucket; `_full/`,
`_tmp/`, `.done/`, `*.log` confirmed absent from R2 with a 404 probe).

| table | files | bytes | rows | row groups | rows/rg (config) | footer bytes | footer % | B per rg | B per rg per col | stats columns | sort order |
|---|---|---|---|---|---|---|---|---|---|---|---|
| search_index | 1 | 959,397 | 60,624 | 1 | 100,000 | 1,455 | 0.15 | 1,455 | 208 | all (default) | chr, tss, gene_id |
| genes | 1 | 3,575,863 | 60,624 | 61 | 1,000 | 120,216 | 3.36 | 1,971 | 76 | chr, tss, gene_id | chr, tss, gene_id |
| splice_phenotypes | 1 | 7,486,457 | 80,750 | 81 | 1,000 | 151,890 | 2.03 | 1,875 | 78 | chr, tss, gene_id, lead_position | chr, tss, gene_id, phenotype_id |
| credible_sets | 1 | 6,316,695 | 461,784 | 231 | 2,000 | 241,022 | 3.82 | 1,043 | 80 | chr, tss, gene_id, position | chr, tss, gene_id, phenotype_id, cs_id, pip desc |
| exons | 1 | 8,125,171 | 1,378,020 | 276 | 5,000 | 183,506 | 2.26 | 665 | 95 | gene_id, chr, start, end | chr, gene_id, start, end |
| gene_annotation | 1 | 1,872,629 | 60,624 | 1 | 100,000 | 1,922 | 0.10 | 1,922 | 214 | all | GTF order (not read by the UI) |
| variants_by_rsid | 1 | 117,228,246 | 8,872,018 | 89 | 100,000 | 55,253 | 0.05 | 621 | 89 | rsid, rs_number | rs_number |
| variants_by_position | 23 | 154,057,650 | 8,872,723 | 101 | 100,000 | 73,721 | 0.05 | 730 | 104 | position | position, A1, A2 |
| cis_eqtl_nominal | 23 | 3,321,198,198 | 123,458,578 | 19,423 | one gene | 18,709,150 | 0.56 | 963 | 69 | gene_id, position | tss, gene_id, position |
| cis_sqtl_nominal | 23 | 1,984,849,997 | 84,498,302 | 5,584 | one gene (sig. introns) | 6,656,302 | 0.34 | 1,192 | 79 | phenotype_id, gene_id, position | tss, gene_id, phenotype_id, position |
| trans_pairs | 24 | 468,865,990 | 15,862,525 | 808 | 20,000 | 988,537 | 0.21 | 1,223 | 87 | gene_id, phenotype_id, position | gene_id, phenotype_id, pval |
| trans_by_variant | 23 | 562,835,336 | 15,862,525 | 805 | 20,000 | 927,825 | 0.16 | 1,153 | 82 | position, gene_id | position, pval |
| gwas_dcm | 22 | 297,667,634 | 12,504,079 | 1,262 | 10,000 | 864,951 | 0.29 | 685 | 76 | position | position, ea, nea |
| gwas_dcm_bins | 1 | 22,223 | 569 | 1 | 10,000 | 2,117 | 9.5 | 2,117 | 212 | all | chr, bin_start |
| coloc | 1 | 1,963 | 0 | 1 | | 1,698 | 86.5 | | | none | empty stub |

Per-chromosome detail for the worked examples (measured):

| file | bytes | rows | row groups | footer | footer B/rg | median rows/rg | median rg bytes | p10–p90 rg bytes |
|---|---|---|---|---|---|---|---|---|
| cis_eqtl_nominal/chr7 | 155,414,796 | 5,763,882 | 908 | 873,695 | 962 | 6,293 | 169,232 | 121–224 KB |
| cis_eqtl_nominal/chr10 | 131,096,670 | 4,883,496 | 738 | 710,076 | 962 | 6,566 | 174,612 | 118–232 KB |
| cis_eqtl_nominal/chr1 | 311,862,997 | 11,542,941 | 1,959 | 1,893,274 | 966 | 5,964 | 160,601 | 118–195 KB |
| cis_eqtl_nominal/chr22 | 84,390,638 | 3,136,856 | 496 | 475,963 | 960 | 6,088 | 163,128 | 129–219 KB |
| cis_sqtl_nominal/chr7 | 125,215,719 | 5,413,708 | 323 | 385,448 | 1,193 | 12,612 | 302,870 | 143–761 KB |
| cis_sqtl_nominal/chr10 | 90,266,627 | 3,853,898 | 241 | 287,651 | 1,194 | 9,860 | 257,931 | 155–802 KB |
| trans_pairs/chr7 | 24,194,534 | 820,746 | 42 | 51,057 | 1,216 | 20,000 | 593,256 | 543–610 KB |
| trans_by_variant/chr10 | 27,185,493 | 764,124 | 39 | 44,786 | 1,148 | 20,000 | 720,729 | 597–790 KB |
| gwas_dcm/chr7 | 17,419,474 | 731,848 | 74 | 50,487 | 682 | 10,000 | 237,270 | 234–242 KB |
| variants_by_position/chr10 | 7,681,386 | 447,865 | 5 | 3,550 | 710 | 100,000 | 1,710,798 | |
| variants_by_rsid | 117,228,246 | 8,872,018 | 89 | 55,253 | 621 | 100,000 | 1,266,258 | |

Column chunk sizes in one FLNC-sized eQTL row group (chr7, 6,050 rows, 165 KB compressed):
`pval_nominal` 36 KB, `rs_number` 20 KB, `slope` 18 KB, `af` 16 KB, `slope_se` 17 KB,
`position` 6.6 KB, `tss_distance` 6.6 KB, `ma_samples` 6.6 KB, `ma_count` 6.9 KB, `A2` 2.7 KB,
`A1` 2.2 KB, `gene_id` 120 B, `pip` 55 B, `cs_id` 69 B. The locus query's projection is 141 KB
of the 165 KB.

### Pruning (local `EXPLAIN ANALYZE`, DuckDB 1.5.5, exact SQL shapes from `queries.ts`)

Every filter the UI writes on a statistics column is pushed into the scan (`Filters:` block in
the plan) and prunes row groups. Row groups admitted per query, computed from the same min/max
statistics DuckDB uses (measured):

| query | file | rgs admitted | rows in them | data bytes | note |
|---|---|---|---|---|---|
| geneRow FLNC / MYOZ1 | genes | 2 / 3 | 2,000 / 3,000 | 111 / 171 KB | one extra group each: the group spanning a chromosome boundary has `chr` min/max `chr6..chr7` and admits any chr7 tss |
| credibleSets FLNC / MYOZ1 | credible_sets | 3 / 3 | 6,000 | 88 / 87 KB | `qtl_type` has no stats; filtered in-scan |
| splicePhenotypes FLNC / SYNPO2L | splice_phenotypes | 2 / 3 | 2–3,000 | 183 / 277 KB | |
| transPairs FLNC / MYOZ1 | trans_pairs/chr | 1 / 1 | 20,000 | 601 / 596 KB | 330 / 1,943 result rows |
| cis nominal FLNC / MYOZ1 | cis_eqtl_nominal/chr | 1 / 1 | 6,050 / 4,454 | 165 / 113 KB | the layout rule holds |
| cis sQTL SYNPO2L intron | cis_sqtl_nominal/chr10 | 1 | 13,305 (3 introns) | 280 KB | `phenotype_id` stats prune nothing extra; the gene's group holds all its introns |
| gwas ±1 Mb FLNC / MYOZ1 | gwas_dcm/chr | 1 / 1 | 10,000 | 241 / 243 KB | 8,466 / 6,735 rows in the window |
| genesInWindow (tss ±4 Mb) | genes | 2 / 3 | | 111 / 171 KB | `start`/`end` have no stats; tss prunes |
| collapsedExons FLNC / MYOZ1 / SYNPO2L | exons | 3 / 3 / 3 | 15,000 | 85 / 96 / 95 KB | 99 / 6 / 9 result rows |
| variantByRsid rs10824026 | variants_by_rsid | 1 | 100,000 | 1,266 KB | one result row |
| variantByPosition | variants_by_position/chr10 | 1 | 100,000 | 1,711 KB | one result row |
| leadGenesAt / leadPhenotypesAt | genes / splice_phenotypes | 3 / 4 | | 171 / 368 KB | `lead_position` has no stats in genes and useless ones in splice_phenotypes (sorted by tss); the tss ±1 Mb band does the pruning |
| credibleSetsAt | credible_sets | 3 | 6,000 | 87 KB | `position` stats add nothing beyond the tss band |
| transAt | trans_by_variant/chr10 | 1 | 20,000 | 603 KB | one result row |
| cisHitsAt e / s | cis_*_nominal/chr10 | 42 / 15 | 197,001 / 141,630 | 5.0 / 3.2 MB | every gene whose window covers the position |

Filters that are not pushed down (evaluated after the scan, harmless because the group is
already selected): `CAST(position AS VARCHAR) LIKE`, `CAST(rs_number AS VARCHAR) LIKE`,
`pval_nominal <= p` (no stats), `qtl_type = 'e'`, `lead_position = pos`, `"end" >= lo AND start <= hi`.
`cisRows` with `LIMIT` plans as TOP-N on `pval_nominal` plus a semi-join re-scan of the same
row group for the other columns; both scans hit the group already in memory, measured 0
extra GETs.

## 2. How DuckDB-WASM 1.33.1-dev57.0 actually reads (measured)

Method: the shipped `ui/node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm` and
`duckdb-browser-blocking.cjs` (same `BROWSER_RUNTIME` as the worker bundle the app loads from
jsDelivr) run under Node with a synchronous `XMLHttpRequest` polyfill backed by `curl`, logging
method, `Range`, and bytes of every request against the public bucket. Sources checked:
`lib/src/io/web_filesystem.cc`, `readahead_buffer.h`, `config.h` (duckdb-wasm `main` and tags
v1.31.0–v1.33.0), core `parquet_reader.cpp` and `caching_file_system.cpp` at v1.4.0 (the wasm
embeds v1.5.4 strings; the relevant code is unchanged).

- **Open.** `WriteFileInfo` emits `forceFullHttpReads: true` when the config value is unset
  (`force_full_http_reads.value_or(true)`). The JS `openFile` then skips the
  `HEAD + Range: bytes=0-` probe and the `GET bytes=0-0` probe and does one full `GET`. With
  `open({filesystem: {forceFullHTTPReads: false}})` the probe runs; R2 answers `206` with
  `Content-Length`, and reads become ranged. Verified both ways with the same binary.
- **Per query, per file.** DuckDB globs the URL, which calls `FileExists` → one `HEAD` (no
  `Range`) every query; the first open of a file adds a `HEAD` with `Range`. With
  `registerFileURL(name, url)` and `read_parquet('name')` both disappear after the first
  query (measured: 0 HEADs on later queries).
- **Footer.** `OnDiskFile()` is `true`, so core does not use its 16–256 KB footer prefetch:
  it reads the last 8 bytes (served as a 1–15 KB tail read), then the footer through the
  read-ahead: 16K, 64K, then the remainder. genes (120 KB footer): 4 GETs; chr7 eQTL
  (874 KB): 12K + 16K + 64K + 256K + 524K = 5 GETs; chr1 (1.89 MB) would be 6.
  `parquet_metadata_cache = true` holds the parsed footer for the session (measured: 0 footer
  reads on later queries); DuckDB still opens the file each query (the `HEAD`s above).
- **Row group.** Without prefetch, each column chunk is a separate read. Reads that continue
  exactly where the previous one ended go through a per-thread `ReadAheadBuffer` (10 heads,
  speed 16 KB ×4 per hit, max 16 MB), so a contiguous row group costs 16K, 64K, 256K, 1M, 4M…
  until covered, plus small cold reads where the reader jumps (filter column first, then the
  rest). Measured: FLNC 165 KB group → 6 GETs, 430 KB; trans 600 KB group → 4 GETs, 1.36 MB;
  variants 1.3 MB group → 4 GETs, 1.4 MB; 1.7 MB group → 5 GETs, 4.2 MB.
- **Re-reads.** Ranges read earlier in the session are served locally (the read-ahead heads
  and core's external file cache both hold them). Measured 0 GETs for `cisRows`, `cisCount`,
  `cisAll`, a second intron of the same gene, and `credibleSets` for a gene in an
  already-read group. This is not guaranteed across many files (10 LRU heads).
- **Concurrency.** None. The `eh` bundle is single-threaded and every XHR is synchronous;
  `Promise.all` in the UI only changes queue order in the worker.
- **Extension.** First `read_parquet` fetches
  `https://extensions.duckdb.org/v1.5.4/wasm_eh/parquet.duckdb_extension.wasm` (3.2 MB, no
  `Cache-Control`, ETag only) in addition to the 36 MB `duckdb-eh.wasm` from jsDelivr
  (`immutable`, one-year cache).

Native DuckDB 1.5.5 `httpfs` against the same URLs, cold (`EXPLAIN ANALYZE` HTTP stats; 1 MiB
read-ahead and request merging differ from WASM, so indicative only):

| query | HEAD | GET | bytes in | s |
|---|---|---|---|---|
| search_index whole | 1 | 2 | 959 KB | 0.52 |
| geneRow FLNC / MYOZ1 | 1 / 1 | 5 / 7 | 243 / 352 KB | 0.56 / 0.50 |
| credibleSets e FLNC | 1 | 6 | 345 KB | 0.52 |
| splicePhenotypes SYNPO2L | 1 | 6 | 533 KB | 0.52 |
| transPairs FLNC / MYOZ1 | 1 / 1 | 3 / 3 | 685 / 672 KB | 0.75 / 0.70 |
| cisAll e FLNC | 1 | 4 | 1.26 MB | 0.69 |
| locusSQL e FLNC / MYOZ1 | 2 / 2 | 10 / 10 | 1.47 / 1.26 MB | 1.78 / 1.68 |
| collapsedExons FLNC | 1 | 7 | 218 KB | 0.65 |
| variantByRsid / variantByPosition | 1 / 1 | 4 / 4 | 1.36 / 1.68 MB | 1.32 / 1.06 |
| transAt | 1 | 5 | 681 KB | 0.99 |
| cisHitsAt e / s | 1 / 1 | 170 / 62 | 4.5 / 2.7 MB | 4.7 / 2.2 |

Warm re-runs in the same native connection are 0 HEAD, 0 GET (external file cache).

R2 transport (curl from this machine, IAD colo): HTTP/1.1 only; fresh-connection TTFB
120–160 ms for any range size; on a kept-alive connection 86 ms mean for 16 KB ranges (12
samples, 57–178 ms), 100–140 ms total for 256 KB, 150–250 ms for 1 MB; 5.6 MB/s on a 10 MB
range. Six parallel 8-byte requests took 0.19 s versus 1.40 s sequential. CORS preflight
`Access-Control-Max-Age: 86400`. No `Cache-Control`, `Age`, or `cf-cache-status` on any
response; `ETag` and `Last-Modified` present. The default curl, python-requests, and duckdb
user agents all got 200 today.

## 3. Per-page request budgets

All counts measured with the WASM harness in one session in the order listed, with
`parquet_metadata_cache = true` and `forceFullHTTPReads: false` (the state after fixing
finding 1). "Serial" is the whole column: nothing overlaps. Wall time is estimated as
requests × 0.1 s + bytes at 5 MB/s; the harness itself measured higher because each request
paid a curl process and a fresh TLS handshake.

| page | query | HEAD | GET | bytes | note |
|---|---|---|---|---|---|
| boot | `CREATE TABLE search_index` | 2 | 8 | 1,050 KB | plus 36 MB wasm (jsDelivr, cached) and 3.2 MB parquet extension |
| landing | `gwasBins` | 2 | 3 | 22 KB | plus `manifest.json` (1) and seqcol chrom sizes (external, then localStorage) |
| **gene FLNC, eQTL tab, chr7 cold** | `geneRow` | 2 | 10 | 270 KB | genes footer 120 KB + 2 groups |
| | `credibleSets e` | 2 | 8 | 362 KB | footer 241 KB + 3 groups |
| | `locusSQL` (materialize) | 4 | 19 | 1,736 KB | chr7 eQTL footer 874 KB in 5 GETs; nominal group 6 GETs; gwas footer 3 GETs + group 3 GETs |
| | `cisRows` + `cisCount` | 2 | 0 | 0 | served from memory |
| | `genesInWindow` | 1 | 1 | 16 KB | |
| | `collapsedExons` | 2 | 10 | 391 KB | exons footer 184 KB + 3 groups |
| | **total** | **15** | **48** | **2.8 MB** | **63 requests, est. 6.9 s; harness 11.4 s** |
| gene FLNC, trans tab | `transPairs` | 2 | 8 | 1,465 KB | footer 51 KB; one 600 KB group read as 16K+64K+256K+1M |
| **gene MYOZ1, eQTL tab, chr10 cold, small-table footers warm** | `geneRow` | 1 | 7 | 459 KB | |
| | `credibleSets e` | 1 | 5 | 131 KB | |
| | `locusSQL` | 4 | 17 | 1,482 KB | chr10 eQTL footer 710 KB |
| | `cisRows` + `cisCount` | 2 | 0 | 0 | |
| | `genesInWindow` | 1 | 3 | 49 KB | |
| | `collapsedExons` | 1 | 6 | 197 KB | |
| | **total** | **10** | **38** | **2.3 MB** | **48 requests, est. 5.3 s** |
| second gene on a warm chromosome | `cisAll` for another chr7 gene | 1 | 3 | 344 KB | footer cached: 16K+64K+256K |
| | `geneRow` for it | 1 | 0 | 0 | group already read |
| **gene SYNPO2L, sQTL tab, one intron** | `splicePhenotypes` | 2 | 11 | 326 KB | footer 152 KB + 3 groups |
| | `credibleSets s` | 1 | 0 | 0 | same groups as MYOZ1's |
| | `locusSQL s` | 3 | 13 | 1,079 KB | chr10 sQTL footer 288 KB; gene group 280 KB (all 3 introns) |
| | `cisRows` + `cisCount` | 2 | 0 | 0 | |
| | `collapsedExons` | 1 | 3 | 98 KB | |
| | second intron (locus) | 1 | 0 | 0 | same row group |
| | **total (first intron, plus GeneTrack ~4)** | **9** | **27** | **1.5 MB** | **~40 requests, est. 4.3 s** |
| **variant rs10824026** | `variantByRsid` | 2 | 11 | 1,804 KB | footer 55 KB; one 1.27 MB group |
| | `leadGenesAt` | 1 | 1 | 16 KB | |
| | `leadPhenotypesAt` | 1 | 2 | 33 KB | |
| | `credibleSetsAt` | 1 | 0 | 0 | |
| | `transAt` | 2 | 11 | 1,795 KB | footer 45 KB; one 720 KB group |
| | **total before scan** | **7** | **25** | **3.6 MB** | **32 requests, est. 3.9 s** |
| | `cisHitsAt e` | 1 | 15 | 6,144 KB | 42 groups, 5 MB admitted |
| | `cisHitsAt s` | 1 | 20 | 6,816 KB | 15 groups, 3.2 MB admitted |
| | **scan** | **2** | **35** | **13 MB** | **+37 requests, est. 6.3 s** |
| | `variantByPosition` (chr:pos URL) | 2 | 9 | 4,369 KB | one 1.7 MB group; read-ahead grew to 2.8 MB |
| region | `genesInRegion` | 0 | 0 | 0 | search_index in memory |
| genes list | `SELECT * FROM search_index` | 0 | 0 | 0 | |
| CSV export | `cisAll` after the page | 1 | 0 | 0 | |
| whole tour | | | | **34.8 MB, 267 requests** | **636 MB, 56 requests in the shipped configuration** |

## 4. Footer overhead

First gene-page visit on a chromosome, nominal file only (measured bytes as fetched by WASM):

| file | footer fetched | data fetched for the gene | footer share |
|---|---|---|---|
| cis_eqtl_nominal/chr7 (FLNC) | 872 KB in 5 GETs | 430 KB in 6 GETs (165 KB group) | 67% |
| cis_eqtl_nominal/chr10 (MYOZ1) | 704 KB in 5 GETs | 430 KB (113 KB group) | 62% |
| cis_eqtl_nominal/chr1 | 1.89 MB, 6 GETs (est.) | ~430 KB | 81% |
| cis_sqtl_nominal/chr10 (SYNPO2L) | 302 KB in 4 GETs | 750 KB (280 KB group) | 29% |

Across the 23 eQTL files the footers total 18.7 MB, one per chromosome per session.

What shrinks a footer (chr22 eQTL rewritten in memory with pyarrow, measured):

| variant | row groups | footer | B/rg | file size |
|---|---|---|---|---|
| as built (stats gene_id + position, one gene per group) | 496 | 475,963 | 960 | 84,390,638 |
| stats on gene_id only | 496 | 461,075 | 930 | 84,361,862 |
| no statistics | 496 | 441,234 | 890 | 84,323,173 |
| two genes per group | 248 | 246,849 | 995 | 75,868,292 |
| four genes per group | 124 | 124,661 | 1,005 | 73,356,766 |
| drop ma_samples, ma_count, tss_distance | 496 | 374,556 | 755 | 72,135,414 |

Dropping `position` statistics saves 3%; dropping all statistics 7%. Each column chunk costs
~69 B of footer whether or not it has statistics (path, encodings, offsets, sizes, codec), so
footer ≈ 69 B × columns × row groups. Halving the row groups halves the footer but doubles the
per-gene read (330 KB instead of 165 KB) and breaks the one-gene-per-group rule. Dropping the
three columns the UI could compute or drop (`tss_distance` = position − tss; `ma_samples` is
never shown; `ma_count` is one table column) saves 21% of footer and 14% of file. The lever
that keeps the per-gene read at 165 KB is fewer row groups *per file*: partitioning each
chromosome into TSS bins of ~100 genes gives ~100 KB footers (1 GET) with no other change.

## 5. Latency ranking and the critical path

Per-request cost with the fix in place: 86 ms measured mean on a kept-alive connection;
120–160 ms on a fresh one. Every request is serial.

| page (cold session, after wasm) | requests | bytes | est. wall (0.1 s/req + transfer) |
|---|---|---|---|
| variant page + scan | 69 | 16.6 MB | 10.2 s |
| gene eQTL tab, first gene on a chromosome | 63 | 2.8 MB | 6.9 s |
| gene eQTL tab, another chromosome, small tables warm | 48 | 2.3 MB | 5.3 s |
| sQTL tab (after an eQTL tab) | ~40 | 1.5 MB | 4.3 s |
| variant page without scan | 32 | 3.6 MB | 3.9 s |
| gene eQTL tab, second gene on a warm chromosome | ~30 (est.) | ~1.2 MB | ~3.2 s |
| landing | 15 + manifest + seqcol | 1.1 MB | 1.8 s |
| trans tab | 10 | 1.5 MB | 1.3 s |
| region, genes list | 0 | 0 | 0 |

In the shipped configuration the first gene page instead transfers 191 MB (chr7) or 146 MB
(chr10): 30–60 s on a 30–50 Mbit/s link, and a repeat visit to a gene on the same chromosome
is then free because the file sits in WASM memory.

Critical path in `Gene.tsx`: `getDB()` (boot, 10 requests) → `resolveGene` (memory) →
`geneRow` (12 requests) → tab renders → `LocusPlot` effect → `materializeLocus` (23) → local
aggregate queries → `GeneTrack` mounts only when the plot is ready → `genesInWindow` and
`collapsedExons` (2 + 12). `credibleSets` and `CisTable`'s two queries are queued on the same
connection and run whenever the worker gets to them. Because the worker serializes everything,
the order of `useEffect` registration is what decides what paints first: the plot appears after
about 35 requests (~3.5 s), the gene track after ~49, the tables interleaved. Nothing on the
page can overlap with the 5-GET footer read of the nominal file; it sits inside the locus
query, third in the chain.

`Variant.tsx`: `variantByRsid` (13) gates everything; then `Promise.all(leadGenesAt,
leadPhenotypesAt, credibleSetsAt)` and `transAt` queue behind it (5 + 13). The scan is on a
button.

## 6. Options

Each with estimated effect (from the measured budgets above) and cost. README rule changes are
flagged.

| option | effect | cost | changes a README rule? |
|---|---|---|---|
| **A. `await db.open({ filesystem: { forceFullHTTPReads: false, allowFullHTTPReads: true, reliableHeadRequests: true } })` after `instantiate` in `db.ts`** | 191 MB → 2.8 MB on the first gene page; whole tour 636 MB → 35 MB; frees the worker heap | one line; verify in DevTools that R2 responses are 206 | no |
| B. Register every table URL at boot with `registerFileURL` and query by name | −1 request per query per file (FLNC page 63 → ~54); −2 on first open | ~90 registrations built from `manifest.json`; `parquet()` in `db.ts` returns the name | no |
| C. Custom domain with Cloudflare cache in front of the bucket (Cache Rule for `.parquet`, `Cache-Control: public, max-age=31536000, immutable` set at upload, versioned paths on rebuild) | per-request TTFB ~130 → ~30–50 ms on cache hits (est.: FLNC page 6.9 → ~3 s); HTTP/2/3; browser disk cache serves repeat visits (206 responses are cached by Chrome and Firefox against `ETag`) | DNS + a Cache Rule; `upload.py` sets `CacheControl`; first request per range still goes to R2; check Cloudflare's 512 MB cacheable-object ceiling is above every file (largest: chr1 eQTL 312 MB, chr2 210 MB) | no |
| D. Partition nominal files by chromosome + TSS bin (~100 genes, ~2–4 Mb) instead of by chromosome alone | footer per first visit 874 KB / 5 GETs → ~100 KB / 1 GET on chr7; 1.89 MB → ~100 KB on chr1; ~800 files instead of 46 | pipeline change in `steps_nominal`; UI computes the bin from `tss` it already has; `cisHitsAt` scans a chromosome's bins (position ±1 Mb → 1–3 files) | yes: extends "hive-partitioned by chromosome" to chromosome + bin; the app still names the exact file |
| E. One row group per gene in `trans_pairs` (like nominal) or 5k-row groups | per-gene read 1.36 MB / 4 GETs → ~340 KB / 3 GETs; footer 51 → ~200 KB on chr7 (est., 20k → 5k) | `row_group_sizes.trans` in config | no (row-group size is config) |
| F. `variants_by_rsid` and `variants_by_position` at 10k rows/group | one-row lookup 1.4–4.4 MB → ~340 KB; footers 55 KB → ~550 KB (rsid file, 887 groups) and 3.5 KB → ~35 KB per chromosome | config | no |
| G. Merge the per-gene lookups into one `gene_detail` table (genes row + collapsed exon model as a list column + credible sets as a list column + splice phenotypes as a list column), one row group per gene, partitioned like D | cold gene page 63 → ~25 requests (est.); credible sets and exons come with the gene row | new pipeline step; `Gene.tsx` reads one row; the variant page still needs `credible_sets` by position, so keep that table | yes: adds a table; the per-gene rule ("`gene_id` stats, or `chr` + `tss`") covers it |
| H. Derive eQTL credible sets from the materialized locus table (`cs_id IS NOT NULL`) instead of querying `credible_sets` | −10 requests, −362 KB on a cold gene page; `rsid` would come from `rs_number` | `EqtlTab` waits for the locus table; the sQTL tab already filters `cs` client-side | no |
| I. Add `start`, `end`, `strand`, `biotype` to `search_index` and serve `genesInWindow` from memory | −1 to −7 requests per gene page; boot +~300 KB (est.: four small columns × 60k rows) | pipeline + `queries.ts` | no |
| J. Precompute collapsed exons per gene (one row, `list<struct<start,end>>`, ~60k rows, est. 3–4 MB) or load `exons` whole at boot | `collapsedExons` 12 requests → 1–4, or 0 with whole-load (+8 MB boot, too much) | pipeline | no |
| K. Ship `gwas_dcm_bins` (22 KB) as a JSON asset in the app bundle | −5 requests on landing | `steps_gwas` also writes JSON; `ColocLoci` fetches it | no |
| L. Drop `ma_samples`, `ma_count`, `tss_distance` from the nominal tables | footer −21%, files −14% (chr22 measured: 84.4 → 72.1 MB) | table column `MA count` disappears or is recomputed; `tss_distance` = position − tss | no |
| M. `SET prefetch_all_parquet_files = true` | coalesces some row-group reads (trans 8 → 6 GETs, 1.47 → 0.66 MB) but adds a HEAD and a re-open per query; net 129 → 142 requests on the test subset | one line | no |
| N. Column statistics changes | nothing measurable: 3–7% of footer | | |
| O. Dictionary / encoding changes | nothing for requests; files are already 10–12% below plain dictionary (`steps_nominal.py` header) | | |
| P. `coi` bundle with COOP/COEP headers from Workers (`_headers`) and threads | row groups of one query scanned in parallel threads with separate read-ahead heads; queries still serialize | `wrangler` headers; jsDelivr worker must be loadable cross-origin-isolated; test | no |

Order of value: A (mandatory, verify first), then C or D (both cut the footer cost, C also
the per-request latency), then B, then G/H/I/J as one "gene page in one read" redesign, then
E/F for the variant page.

## 7. Wrong or risky

1. `db.ts` never calls `open`; with this DuckDB-WASM version that means full-file HTTP reads
   (finding 1). The README's "a gene page fetches only its own bytes" and the manifest's
   `"load": "range"` describe the intended behaviour, not the shipped one. The transcripts
   show range reads were verified with curl against R2, never from the browser.
2. `variants_by_rsid` and `variants_by_position` use 100k-row groups for a one-row lookup
   (1.3–1.7 MB admitted, 1.8–4.4 MB fetched). `trans_pairs` and `trans_by_variant` use 20k
   (600–720 KB admitted, 1.4–1.8 MB fetched).
3. `exons.parquet`: a gene touches 3 of 276 groups plus a 184 KB footer; 12 requests for 6–99
   rows.
4. `genes`, `splice_phenotypes`, `credible_sets`: 1k–2k-row groups whose `chr` min/max spans
   a chromosome boundary admit every tss on the next chromosome; +1 group per lookup. Sorting
   is fine; padding groups to chromosome boundaries (or partitioning by chromosome) removes it.
5. `leadPhenotypesAt` carries `lead_position` statistics that cannot prune (file sorted by
   tss); harmless, but the stats rule in the README says stats exist for filtered columns and
   this one does nothing.
6. `cisHitsAt` admits 42 eQTL and 15 sQTL groups for one chr10 position and fetches 13 MB in
   37 requests; the read-ahead's ×4 growth reaches 4 MB reads inside it. Fine on a button, but
   the description "~30 genes' worth" undercounts eQTL (42).
7. The parquet extension is fetched from `extensions.duckdb.org` on first use (3.2 MB, no
   `Cache-Control`); it is a third origin the app depends on, along with jsDelivr and seqcol.
8. `gene_annotation.parquet` (1.9 MB) and `geneRowsFor` are not used by the UI.
9. r2.dev is documented by Cloudflare as rate-limited and not for production; the app's
   correctness under a burst of sequential range requests from many users is untested.
10. `search_index` is loaded with `CREATE TABLE ... AS SELECT * FROM read_parquet(url)`; it is
    one row group and comes down in 8 GETs (16K, 64K, 256K, 601K…) because of the read-ahead
    ramp. `fetch` of the whole file into a buffer and `registerFileBuffer` would make it one
    request.

## Appendix: measurement scripts

Scratch only (not in the repo): a Python query-shape module mirroring `queries.ts` and
`locusSQL`, run through local DuckDB `EXPLAIN ANALYZE`, native `httpfs` against the bucket,
and a Node harness that loads `duckdb-browser-blocking.cjs` + `duckdb-eh.wasm` from
`ui/node_modules` with a curl-backed synchronous `XMLHttpRequest` that logs every request. The
harness needs three shims to run under Node: `JS_SHA256_NO_NODE_JS = true`, a `fetch` that
serves `file://` for the wasm module, and `self`/`window` aliases. Repeat with
`db.open({filesystem: {forceFullHTTPReads: false}})` to switch modes.
