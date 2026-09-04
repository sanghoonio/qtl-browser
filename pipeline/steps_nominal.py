"""Step 7: re-encode the cis nominal pair files, one row group per gene.

Memory-bounded: DuckDB writes the joined, sorted rows to a temporary parquet under its own
memory limit (spilling to disk if needed); pyarrow then streams that file batch by batch and
re-emits it with one row group per gene. Nothing holds a whole chromosome in memory.

Encodings (measured on chr22, 2026-09-03): per-gene row groups lose the cross-gene repetition
that dictionary encoding exploits in the raw million-row groups, so positions use
DELTA_BINARY_PACKED, floats use BYTE_STREAM_SPLIT, and rsIDs are stored as integer rs_number
(delta for eQTL, dictionary for sQTL where the same variant repeats across a gene's phenotypes).
Result: eQTL files ~10% smaller than raw, sQTL ~12% smaller than the plain-dictionary version.

`sqtl_nominal: significant` in the config keeps sQTL rows only for introns flagged is_sqtl in
splice_phenotypes (84.5M of 499.6M rows, 1.8 GB instead of 10.8), which is what fits the R2
free tier. eQTL rows are always kept for every tested gene.
"""
import shutil
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from .common import CHROMS, Config, connect, log
from .steps_tables import SPLICE_PARSE

STATS = {"e": ["gene_id", "position"], "s": ["gene_id", "phenotype_id", "position"]}
FLOATS = ("af", "slope", "slope_se", "pval_nominal", "pip")
ENCODING = {
    "e": {"position": "DELTA_BINARY_PACKED", "tss_distance": "DELTA_BINARY_PACKED", "rs_number": "DELTA_BINARY_PACKED",
          **{c: "BYTE_STREAM_SPLIT" for c in FLOATS}},
    "s": {"position": "DELTA_BINARY_PACKED", "tss_distance": "DELTA_BINARY_PACKED",
          **{c: "BYTE_STREAM_SPLIT" for c in FLOATS}},
}


def _regroup(src: Path, out: Path, group_col: str, stats_columns: list[str], encoding: dict[str, str]) -> int:
    """Stream `src` (sorted by group_col) into `out` with one row group per group value."""
    pf = pq.ParquetFile(src)
    writer = pq.ParquetWriter(out, pf.schema_arrow, compression="zstd", compression_level=9,
                              use_dictionary=[c for c in pf.schema_arrow.names if c not in encoding],
                              column_encoding=encoding, write_statistics=stats_columns)
    buf: list[pa.Table] = []
    cur = None
    n = 0

    def flush():
        nonlocal buf, n
        if buf:
            t = pa.concat_tables(buf)
            writer.write_table(t, row_group_size=t.num_rows)
            n += 1
            buf = []

    try:
        for batch in pf.iter_batches(batch_size=250_000):
            t = pa.Table.from_batches([batch])
            col = t[group_col].combine_chunks()
            if len(col) == 0:
                continue
            shifted = col.slice(1)
            idx = pc.indices_nonzero(pc.not_equal(col.slice(0, len(col) - 1), shifted)).to_pylist()
            starts = [0] + [i + 1 for i in idx]
            ends = starts[1:] + [t.num_rows]
            for s, e in zip(starts, ends):
                g = col[s].as_py()
                if g != cur:
                    flush()
                    cur = g
                buf.append(t.slice(s, e - s))
        flush()
    finally:
        writer.close()
    return n


def _one(args) -> tuple[str, str, int, int]:
    qtl_type, chrom, src, out = args
    out = Path(out)
    cfg = Config()
    work_tmp = cfg.tmp / f"nominal-{qtl_type}-{chrom}"
    con = connect(cfg, memory_limit=cfg["duckdb_memory_limit"], threads=cfg["duckdb_threads"], temp_dir=work_tmp)
    con.execute("SET preserve_insertion_order = true")
    ann = cfg.derived / "gene_annotation.parquet"
    vpos = cfg.derived / "variants_by_position" / f"chr={chrom}" / "data.parquet"
    susie = cfg.raw_dir("cis_eQTL_SuSiE" if qtl_type == "e" else "cis_sQTL_SuSiE") / (
        f"topchef_{chrom}_MaxPC70.SuSiE_summary.parquet" if qtl_type == "e" else f"topchefSplice_{chrom}_MaxPC25.SuSiE_summary.parquet")
    con.execute(f"CREATE TABLE v AS SELECT position, A1, A2, rs_number FROM '{vpos}'")
    # a variant can belong to two credible sets of one phenotype: keep the higher-PIP membership
    con.execute(f"""CREATE TABLE s AS
        SELECT phenotype_id, position, A1, A2, max(pip)::FLOAT AS pip, arg_max(cs_id, pip)::TINYINT AS cs_id
        FROM '{susie}' GROUP BY 1, 2, 3, 4""")
    con.execute(f"CREATE TABLE g AS SELECT gene_id, tss FROM '{ann}' WHERE chr = '{chrom}'")
    if qtl_type == "e":
        con.execute(f"CREATE VIEW n AS SELECT *, phenotype_id AS gene_id FROM '{src}'")
        select_extra, order = "", "g.tss, n.gene_id, n.position"
    elif cfg["sqtl_nominal"] == "significant":
        sp = cfg.derived / "splice_phenotypes.parquet"
        con.execute(f"""CREATE VIEW n AS SELECT r.*, {SPLICE_PARSE.replace('phenotype_id', 'r.phenotype_id')}
            FROM '{src}' r SEMI JOIN (SELECT phenotype_id FROM '{sp}' WHERE is_sqtl) k USING (phenotype_id)""")
        select_extra, order = "n.phenotype_id,", "g.tss, n.gene_id, n.phenotype_id, n.position"
    else:
        con.execute(f"CREATE VIEW n AS SELECT *, {SPLICE_PARSE} FROM '{src}'")
        select_extra, order = "n.phenotype_id,", "g.tss, n.gene_id, n.phenotype_id, n.position"
    tmp = out.with_suffix(".sorted.tmp.parquet")
    out.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"""
        COPY (
            SELECT {select_extra} n.gene_id, n.position::INTEGER AS position, n.A1, n.A2, v.rs_number,
                   n.start_distance::INTEGER AS tss_distance, n.af::FLOAT AS af,
                   n.ma_samples::SMALLINT AS ma_samples, n.ma_count::SMALLINT AS ma_count,
                   n.pval_nominal, n.slope::FLOAT AS slope, n.slope_se::FLOAT AS slope_se,
                   s.pip, s.cs_id
            FROM n
            LEFT JOIN g ON g.gene_id = n.gene_id
            LEFT JOIN v ON v.position = n.position AND v.A1 = n.A1 AND v.A2 = n.A2
            LEFT JOIN s ON s.phenotype_id = n.phenotype_id AND s.position = n.position AND s.A1 = n.A1 AND s.A2 = n.A2
            ORDER BY {order}
        ) TO '{tmp}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 250000)
    """)
    raw_n = con.execute("SELECT count(*) FROM n").fetchone()[0]
    tmp_n = pq.read_metadata(tmp).num_rows
    if tmp_n != raw_n:
        tmp.unlink()
        raise RuntimeError(f"{src}: row count changed {raw_n} -> {tmp_n} (join duplicated rows)")
    con.close()
    shutil.rmtree(work_tmp, ignore_errors=True)
    groups = _regroup(tmp, out, "gene_id", STATS[qtl_type], ENCODING[qtl_type])
    tmp.unlink()
    return qtl_type, chrom, raw_n, groups


def run(cfg: Config, force: bool = False) -> None:
    jobs = []
    for qtl_type, src_dir, out_dir, pat in [
        ("e", "cis_eQTL_nominal", "cis_eqtl_nominal", "topchef_{c}_MaxPC70.cis_qtl_pairs.{c}.parquet"),
        ("s", "cis_sQTL_nominal", "cis_sqtl_nominal", "topchefSplice_{c}_MaxPC25.cis_qtl_pairs.{c}.parquet"),
    ]:
        for c in CHROMS:
            src = cfg.raw_dir(src_dir) / pat.format(c=c)
            out = cfg.derived / out_dir / f"chr={c}" / "data.parquet"
            if not src.exists():
                log(f"nominal: missing raw file {src.name}, skipping")
                continue
            if not force and out.exists() and out.stat().st_mtime > src.stat().st_mtime:
                continue
            jobs.append((qtl_type, c, str(src), str(out)))
    jobs.sort(key=lambda j: -Path(j[2]).stat().st_size)  # biggest first
    log(f"nominal: {len(jobs)} files to build with {cfg['workers']} workers")
    with ProcessPoolExecutor(max_workers=cfg["workers"]) as ex:
        futs = {ex.submit(_one, j): j for j in jobs}
        for f in as_completed(futs):
            qtl_type, c, n, groups = f.result()
            log(f"nominal: {qtl_type} {c}: {n:,} rows in {groups} row groups")
