#!/usr/bin/env python3
"""Probe real published runtime assets before adding optional download mirrors.

This compares bounded first/last ranges and total byte counts. It does not claim
to validate a multi-gigabyte mirror in full: the installer still verifies every
locked SHA-256 before extracting or executing a downloaded component.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

MIRRORS = ("https://ghfast.top/", "https://gh-proxy.com/")
RANGE_BYTES = 64 * 1024


def read_range_once(url: str, start: int, end: int, size: int) -> dict:
    request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}",
        "Accept": "application/octet-stream", "User-Agent": "Open-Media-Runtime-Validation/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 206:
            raise ValueError(f"Expected a bounded partial response, received HTTP {response.status}")
        if response.headers.get("Content-Range") != f"bytes {start}-{end}/{size}":
            raise ValueError("Range response does not match the locked asset size and offset")
        data = response.read(end - start + 2)
        if len(data) != end - start + 1:
            raise ValueError("Partial response length does not match the requested range")
    return {"start": start, "end": end, "sha256": hashlib.sha256(data).hexdigest()}


def read_range(url: str, start: int, end: int, size: int) -> dict:
    # Public proxies may briefly serve an HTML busy response or an unbounded
    # response while caching the upstream asset. Never accept those as proof.
    for attempt in range(3):
        try:
            return read_range_once(url, start, end, size)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    raise AssertionError("Unreachable")


def probe(item: dict) -> tuple[list[str], dict]:
    parsed = urllib.parse.urlparse(item["url"])
    if (parsed.scheme != "https" or parsed.netloc != "github.com"
            or not parsed.path.startswith("/ecojust/open-media/releases/download/")
            or parsed.query or parsed.fragment or item["size"] <= 0
            or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])):
        raise ValueError("Only verified, already published project runtime assets may be probed")
    count = min(RANGE_BYTES, item["size"])
    ranges = [(0, count - 1), (item["size"] - count, item["size"] - 1)]
    original = [read_range(item["url"], start, end, item["size"]) for start, end in ranges]

    def check(prefix: str) -> dict:
        url = prefix + item["url"]
        try:
            actual = [read_range(url, start, end, item["size"]) for start, end in ranges]
            if actual != original:
                raise ValueError("Mirrored ranges differ from the published source")
            return dict(url=url, matched=True, ranges=actual)
        except Exception as error:
            return dict(url=url, matched=False, error=str(error)[:300])

    with ThreadPoolExecutor(max_workers=len(MIRRORS)) as executor:
        results = list(executor.map(check, MIRRORS))
    return [r["url"] for r in results if r["matched"]], dict(url=item["url"], size=item["size"],
        expectedFullSha256=item["sha256"], originalRanges=original, mirrors=results)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    if catalog.get("schemaVersion") != 1 or not catalog.get("runtimes"):
        raise ValueError("A non-empty catalog from the actual component release is required")
    evidence = []
    for runtime in catalog["runtimes"]:
        for platform, archive in runtime["platforms"].items():
            # Split archives use the real part URLs; the logical full ZIP URL is
            # never fetched, so adding an unresolvable mirror for it is avoided.
            items = archive.get("parts") or [archive]
            if archive.get("parts"):
                archive.pop("mirrors", None)
            for item in items:
                item["mirrors"], result = probe(item)
                result.update(runtime=runtime["id"], platform=platform)
                evidence.append(result)
                print(json.dumps(dict(platform=platform, filename=Path(urllib.parse.urlparse(item["url"]).path).name,
                                      verifiedMirrors=len(item["mirrors"])), ensure_ascii=False), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.evidence.write_text(json.dumps(dict(schema=1, checkedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
        verification="Matching bounded first/last ranges and total byte size; full SHA-256 enforced by installer",
        assets=evidence), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
