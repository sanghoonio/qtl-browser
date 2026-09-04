"""Shared helpers: config, paths, DuckDB connections, parquet writing."""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import yaml

ROOT = Path(__file__).resolve().parents[1]
CHROMS = [f"chr{i}" for i in range(1, 23)] + ["chrX"]


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


class Config:
    def __init__(self, path: Path | None = None):
        path = path or ROOT / "pipeline" / "config.yaml"
        self.cfg = yaml.safe_load(path.read_text())
        self.raw = ROOT / self.cfg["raw"]
        self.derived = ROOT / self.cfg["derived"]
        self.zenodo = self.raw / self.cfg["zenodo_dir"]
        self.gtf = self.raw / self.cfg["gencode_gtf"]
        self.dbsnp_vcf = self.raw / self.cfg["dbsnp_vcf"]
        self.assembly_report = self.raw / self.cfg["dbsnp_assembly_report"]
        self.tmp = self.derived / "_tmp"
        self.done_dir = self.derived / ".done"

    def __getitem__(self, k):
        return self.cfg[k]

    def raw_dir(self, name: str) -> Path:
        """Extracted per-chromosome parquet dir for one Zenodo archive."""
        return self.zenodo / name

    def raw_glob(self, name: str) -> str:
        return str(self.raw_dir(name) / "*.parquet")

    def mark_done(self, step: str) -> None:
        self.done_dir.mkdir(parents=True, exist_ok=True)
        (self.done_dir / step).write_text(dt.datetime.now().isoformat())

    def is_done(self, step: str) -> bool:
        return (self.done_dir / step).exists()


def connect(cfg: Config, memory_limit: str | None = None, threads: int | None = None,
            temp_dir: Path | None = None) -> duckdb.DuckDBPyConnection:
    """Open an in-memory DuckDB. Concurrent processes MUST pass their own `temp_dir`: DuckDB
    spill files have fixed names, so two processes sharing one temp directory corrupt each other."""
    con = duckdb.connect()
    temp_dir = temp_dir or cfg.tmp
    temp_dir.mkdir(parents=True, exist_ok=True)
    con.execute(f"SET temp_directory = '{temp_dir}'")
    con.execute("SET preserve_insertion_order = false")
    con.execute("SET enable_progress_bar = false")
    if memory_limit:
        con.execute(f"SET memory_limit = '{memory_limit}'")
    if threads:
        con.execute(f"SET threads = {threads}")
    return con


def strip_metadata(table: pa.Table) -> pa.Table:
    return table.replace_schema_metadata(None)


def write_parquet(table: pa.Table, path: Path, row_group_size: int, stats_columns: list[str] | None = None) -> None:
    """Plain parquet: zstd, dictionary, fixed row-group size."""
    path.parent.mkdir(parents=True, exist_ok=True)
    table = strip_metadata(table)
    pq.write_table(
        table, path, compression="zstd", compression_level=9, use_dictionary=True,
        row_group_size=row_group_size, write_statistics=stats_columns if stats_columns else True,
    )


def write_parquet_grouped(table: pa.Table, path: Path, group_col: str, stats_columns: list[str]) -> int:
    """One row group per run of equal `group_col` values. `table` must already be sorted so
    that each group's rows are contiguous. Returns the number of row groups written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    table = strip_metadata(table)
    if table.num_rows == 0:
        pq.write_table(table, path, compression="zstd")
        return 0
    col = table[group_col].combine_chunks()
    # boundaries where the value changes
    shifted = col.slice(1)
    changes = pc.not_equal(col.slice(0, len(col) - 1), shifted)
    idx = pc.indices_nonzero(changes).to_numpy()
    starts = [0] + [int(i) + 1 for i in idx]
    ends = starts[1:] + [table.num_rows]
    writer = pq.ParquetWriter(
        path, table.schema, compression="zstd", compression_level=9, use_dictionary=True,
        write_statistics=stats_columns,
    )
    n = 0
    try:
        for s, e in zip(starts, ends):
            writer.write_table(table.slice(s, e - s), row_group_size=e - s)
            n += 1
    finally:
        writer.close()
    return n


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)
