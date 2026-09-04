"""Step 1: untar the Zenodo archives in place."""
import tarfile

from .common import Config, log

ARCHIVES = [
    "cis_eQTL_permutation", "cis_eQTL_SuSiE", "cis_eQTL_nominal",
    "cis_sQTL_permutation", "cis_sQTL_SuSiE", "cis_sQTL_nominal",
    "trans_eQTL", "trans_sQTL",
]


def run(cfg: Config) -> None:
    for name in ARCHIVES:
        out = cfg.raw_dir(name)
        tgz = cfg.zenodo / f"{name}.tar.gz"
        if out.is_dir() and any(out.glob("*.parquet")):
            log(f"extract: {name} already present")
            continue
        log(f"extract: {name} ({tgz.stat().st_size / 1e9:.2f} GB)")
        with tarfile.open(tgz) as tf:
            members = [m for m in tf.getmembers() if m.isfile() and m.name.endswith(".parquet")]
            for m in members:
                m.name = m.name.split("/")[-1]  # flatten: archive has a top-level dir of the same name
            tf.extractall(out, members=members, filter="data")
        log(f"extract: {name} -> {len(list(out.glob('*.parquet')))} files")
