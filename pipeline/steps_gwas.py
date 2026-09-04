"""DCM GWAS (Jurgens et al. 2024) summarized into fixed genomic windows for the landing track.

One row per window: the strongest variant (min p, its position and rsID), how many variants
in the window pass genome-wide significance, and how many were tested. Read straight from the
raw meta-analysis TSV; GRCh38 coordinates come from its CHRBP_B38 column.
"""
from .common import Config, connect, log, write_parquet

COLUMNS = ("{'CHRBP_B37':'VARCHAR','CHRBP_B38':'VARCHAR','ID_B38':'VARCHAR','CHR':'VARCHAR','POS':'BIGINT','EA':'VARCHAR',"
           "'NEA':'VARCHAR','BETA':'DOUBLE','SE':'DOUBLE','P':'DOUBLE','EAFREQ':'DOUBLE','HetDf':'INTEGER','HetPVal':'DOUBLE',"
           "'N':'BIGINT','N_cases':'BIGINT','N_controls':'BIGINT','rsID':'VARCHAR','ID_B37':'VARCHAR','INDEL':'VARCHAR'}")


def full(cfg: Config) -> None:
    """Full meta-analysis as position-sorted per-chromosome parquet for LocusCompare: the
    browser range-reads a gene's ±1 Mb window and joins it to the QTL rows on position and
    alleles (either orientation)."""
    from .common import CHROMS
    src = cfg.raw / cfg["dcm_gwas"]
    con = connect(cfg)
    con.execute(f"""
        CREATE TABLE g AS
        SELECT 'chr' || split_part(CHRBP_B38, ':', 1) AS chr, split_part(CHRBP_B38, ':', 2)::INTEGER AS position,
               EA AS ea, NEA AS nea, BETA::FLOAT AS beta, SE::FLOAT AS se, P AS p, EAFREQ::FLOAT AS eaf,
               CASE WHEN rsID LIKE 'rs%' THEN rsID END AS rsid, N::INTEGER AS n
        FROM read_csv('{src}', delim='\\t', header=true, columns={COLUMNS})
        WHERE CHRBP_B38 IS NOT NULL AND CHRBP_B38 <> '' AND P > 0
    """)
    total = 0
    for c in CHROMS:
        t = con.execute("SELECT position, ea, nea, beta, se, p, eaf, rsid, n FROM g WHERE chr = ? ORDER BY position, ea, nea", [c]).fetch_arrow_table()
        if t.num_rows == 0:
            continue
        write_parquet(t, cfg.derived / "gwas_dcm" / f"chr={c}" / "data.parquet", int(cfg["row_group_sizes"]["gwas"]), stats_columns=["position"])
        total += t.num_rows
    log(f"gwas_full: {total:,} variants -> gwas_dcm/chr=*/data.parquet")


def run(cfg: Config) -> None:
    src = cfg.raw / cfg["dcm_gwas"]
    bin_bp = int(cfg["gwas_bin_bp"])
    con = connect(cfg)
    t = con.execute(f"""
        WITH v AS (
            SELECT 'chr' || split_part(CHRBP_B38, ':', 1) AS chr,
                   split_part(CHRBP_B38, ':', 2)::BIGINT AS position,
                   P AS p, rsID AS rsid, EA, NEA, BETA AS beta
            FROM read_csv('{src}', delim='\\t', header=true, columns={COLUMNS})
            WHERE CHRBP_B38 IS NOT NULL AND CHRBP_B38 <> '' AND P > 0
        )
        SELECT chr, (position // {bin_bp}) * {bin_bp} AS bin_start, (position // {bin_bp}) * {bin_bp} + {bin_bp} AS bin_end,
               min(p) AS min_p, arg_min(position, p) AS lead_position, arg_min(rsid, p) AS lead_rsid,
               arg_min(beta, p) AS lead_beta, arg_min(EA, p) AS lead_ea,
               count(*) FILTER (WHERE p < 5e-8)::INTEGER AS n_gws, count(*)::INTEGER AS n_variants
        FROM v GROUP BY 1, 2, 3 ORDER BY 1, 2
    """).fetch_arrow_table()
    out = cfg.derived / "gwas_dcm_bins.parquet"
    write_parquet(t, out, 10_000)
    n_gws = sum(1 for x in t.column("n_gws").to_pylist() if x > 0)
    log(f"gwas_bins: {t.num_rows} windows of {bin_bp // 1_000_000} Mb, {n_gws} with genome-wide significant variants -> {out.name}")
