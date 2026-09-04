"""Push data/derived to the R2 bucket in config.yaml and check that it range-reads.

    # <repo>/.env (gitignored):  R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=...
    # token: Object Read & Write on this bucket. Exported variables override the file.
    uv run python -m pipeline.upload cors             # apply the CORS rule from config
    uv run python -m pipeline.upload sync --dryrun    # list what would upload
    uv run python -m pipeline.upload sync             # upload (re-runnable; only changed files)
    uv run python -m pipeline.upload sync --delete    # also remove bucket keys no longer local
    uv run python -m pipeline.upload check            # HEAD + range GET against the public URL

Uses the aws CLI against the R2 S3 endpoint. The checksum variables stop aws-cli 2.23+ from
sending CRC headers that R2 rejects.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

from .common import ROOT, Config, log

EXPOSE = ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"]


def _dotenv() -> dict[str, str]:
    """KEY=VALUE lines from <repo>/.env (gitignored); the shell environment wins over it."""
    path = ROOT / ".env"
    out = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip().removeprefix("export ").strip()] = v.strip().strip("'\"")
    return out


def _env(cfg: Config) -> dict[str, str]:
    merged = {**_dotenv(), **os.environ}
    key, secret = merged.get("R2_ACCESS_KEY_ID"), merged.get("R2_SECRET_ACCESS_KEY")
    if not (key and secret):
        sys.exit("put R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in .env at the repo root or export them "
                 "(Cloudflare dashboard > R2 > Manage API tokens)")
    return {
        **os.environ,
        "AWS_ACCESS_KEY_ID": key, "AWS_SECRET_ACCESS_KEY": secret, "AWS_DEFAULT_REGION": "auto",
        "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required", "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required",
    }


def _aws(cfg: Config, *args: str, **kw) -> subprocess.CompletedProcess:
    cmd = ["aws", "--endpoint-url", cfg["r2"]["endpoint"], *args]
    log(" ".join(cmd))
    return subprocess.run(cmd, env=_env(cfg), **kw)


def cors(cfg: Config, print_only: bool = False) -> None:
    rule = {"CORSRules": [{
        "AllowedOrigins": cfg["r2"]["allowed_origins"],
        "AllowedMethods": ["GET", "HEAD"],
        "AllowedHeaders": ["Range", "If-Match", "If-None-Match", "Content-Type"],
        "ExposeHeaders": EXPOSE,
        "MaxAgeSeconds": 86400,
    }]}
    if print_only:
        # paste into dashboard > R2 > bucket > Settings > CORS policy (the dashboard takes the rules array)
        print(json.dumps(rule["CORSRules"], indent=2))
        return
    r = _aws(cfg, "s3api", "put-bucket-cors", "--bucket", cfg["r2"]["bucket"], "--cors-configuration", json.dumps(rule),
             capture_output=True, text=True)
    if r.returncode:
        if "AccessDenied" in r.stderr:
            sys.exit("PutBucketCors needs an Admin Read & Write token; an Object Read & Write token cannot set it. "
                     "Either use an admin token here or paste `upload.py cors --print` into the dashboard CORS policy.")
        sys.exit(r.stderr.strip())
    r = _aws(cfg, "s3api", "get-bucket-cors", "--bucket", cfg["r2"]["bucket"], capture_output=True, text=True)
    print(r.stdout)


def sync(cfg: Config, dryrun: bool, delete: bool) -> None:
    args = ["s3", "sync", str(cfg.derived), f"s3://{cfg['r2']['bucket']}", "--no-progress"]
    for pat in cfg["r2"]["exclude"]:
        args += ["--exclude", pat]
    if dryrun:
        args.append("--dryrun")
    if delete:
        args.append("--delete")
    r = _aws(cfg, *args)
    sys.exit(r.returncode)


def check(cfg: Config) -> None:
    """The reads DuckDB-WASM makes on startup, from a browser-like origin."""
    base = cfg["r2"]["public_url"].rstrip("/")
    origin = cfg["r2"]["allowed_origins"][0]
    url = f"{base}/search_index.parquet"
    ok = True

    def fetch(method: str, headers: dict[str, str]):
        # r2.dev returns 403 (error 1010) to the default Python-urllib user agent
        req = urllib.request.Request(url, method=method, headers={"Origin": origin, "User-Agent": "Mozilla/5.0 (qtl-browser check)", **headers})
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read(64)
        except urllib.error.HTTPError as e:
            return e.code, {k.lower(): v for k, v in e.headers.items()}, b""

    status, h, _ = fetch("HEAD", {})
    log(f"HEAD {url} -> {status}, length {h.get('content-length')}, accept-ranges {h.get('accept-ranges')}")
    ok &= status == 200 and h.get("accept-ranges") == "bytes"

    status, h, body = fetch("GET", {"Range": "bytes=-8"})
    log(f"GET last 8 bytes -> {status}, content-range {h.get('content-range')}, magic {body[-4:]!r}")
    ok &= status == 206 and body[-4:] == b"PAR1"

    acao, expose = h.get("access-control-allow-origin"), h.get("access-control-expose-headers", "")
    log(f"CORS allow-origin {acao!r}, expose-headers {expose!r}")
    ok &= acao in (origin, "*") and all(x.lower() in expose.lower() for x in EXPOSE[:3])

    log("check: " + ("OK" if ok else "FAILED"))
    sys.exit(0 if ok else 1)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cors")
    c.add_argument("--print", action="store_true", help="print the rules for pasting into the dashboard instead of applying")
    s = sub.add_parser("sync")
    s.add_argument("--dryrun", action="store_true")
    s.add_argument("--delete", action="store_true", help="remove bucket keys that no longer exist locally")
    sub.add_parser("check")
    a = ap.parse_args()
    cfg = Config()
    if a.cmd == "cors":
        cors(cfg, a.print)
    elif a.cmd == "sync":
        sync(cfg, a.dryrun, a.delete)
    else:
        check(cfg)


if __name__ == "__main__":
    main()
