#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Download raw data sources listed in sources.yaml into <dest>/<source dir>/.

    ./download.py                 # fetch everything not yet present and verified
    ./download.py --only dbsnp    # one source (repeatable)
    ./download.py --list          # show status without downloading
    ./download.py --config other.yaml

Downloads resume (curl -C -), md5 is verified when the config gives one, and a
file that another process is currently writing is skipped rather than clobbered.
"""
import argparse
import hashlib
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 24), b""):
            h.update(chunk)
    return h.hexdigest()


def being_written(path: Path) -> bool:
    """True if some other process has this path open for writing (macOS/Linux)."""
    try:
        out = subprocess.run(["lsof", "-F", "a", "--", str(path)], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return False
    return any(line.startswith("a") and ("w" in line or "u" in line) for line in out.splitlines())


def resolve(src: dict, entry: dict) -> tuple[str, str]:
    """Return (url, basename) for a file entry."""
    if "url" in entry:
        return entry["url"], entry.get("file") or entry["url"].rstrip("/").rsplit("/", 1)[-1]
    if "url_base" not in src:
        sys.exit(f"{src['name']}: file entry {entry} has no url and source has no url_base")
    return src["url_base"].format(file=entry["file"]), entry["file"]


def expected_md5(entry: dict) -> str | None:
    if "md5" in entry:
        return entry["md5"].lower()
    if "md5_url" in entry:
        with urllib.request.urlopen(entry["md5_url"], timeout=60) as r:
            return r.read().decode().split()[0].lower()
    return None


def status(dest: Path, entry: dict, md5: str | None) -> str:
    if not dest.exists():
        return "missing"
    if being_written(dest):
        return "in-progress"
    size = entry.get("size")
    if size is not None and dest.stat().st_size != size:
        return "partial"
    if md5 is not None:
        return "verified" if md5_of(dest) == md5 else "md5-mismatch"
    return "present"


def fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["curl", "-L", "--fail", "--retry", "5", "--retry-delay", "10", "-C", "-", "-o", str(dest), url]
    subprocess.run(cmd, check=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=HERE / "sources.yaml")
    ap.add_argument("--only", action="append", metavar="SOURCE", help="restrict to this source name (repeatable)")
    ap.add_argument("--list", action="store_true", help="report status only, download nothing")
    args = ap.parse_args()

    cfg = yaml.safe_load(args.config.read_text())
    root = args.config.resolve().parent
    # `dest` in the config is relative to the repo root, which is two levels above data/raw/sources.yaml
    dest_root = (root.parents[1] / cfg["dest"]).resolve() if not Path(cfg["dest"]).is_absolute() else Path(cfg["dest"])

    failures = 0
    for src in cfg["sources"]:
        if args.only and src["name"] not in args.only:
            continue
        print(f"== {src['name']}: {src.get('version', '')}")
        for entry in src["files"]:
            url, name = resolve(src, entry)
            dest = dest_root / src["dir"] / name
            md5 = expected_md5(entry)
            st = status(dest, entry, md5)
            if args.list or st in ("verified", "present", "in-progress"):
                print(f"  {st:13s} {name}")
                continue
            if st == "md5-mismatch":
                print(f"  md5 mismatch, re-downloading {name}")
                dest.unlink()
            print(f"  fetching      {name}  <- {url}")
            try:
                fetch(url, dest)
            except subprocess.CalledProcessError as e:
                print(f"  FAILED        {name} (curl exit {e.returncode})")
                failures += 1
                continue
            st = status(dest, entry, md5)
            print(f"  {st:13s} {name}")
            if st not in ("verified", "present"):
                failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
