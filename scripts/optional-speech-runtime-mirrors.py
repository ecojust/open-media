#!/usr/bin/env python3
"""Verify published runtime download routes without downloading entire archives.

The input metadata must match an independently supplied complete SHA-256.
Archive prefix probes establish availability and route consistency only; the
application must still verify each complete archive before extracting it.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

PROXIES = ("https://ghfast.top/", "https://ghproxy.net/", "https://gh-proxy.com/")
PLATFORMS = {"macos-arm64", "macos-x64", "windows-x64"}
RELEASE = "https://github.com/ecojust/open-media/releases/download/speech-runtime-v1/"
PREFIX_BYTES = 4096
MAX_METADATA_BYTES = 4 * 1024**2


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_string(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("A complete lowercase SHA-256 digest is required")
    return value


def source_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.username
            or parsed.password or parsed.port or parsed.query or parsed.fragment
            or "/releases/download/" not in parsed.path):
        raise ValueError("Use a fixed public HTTPS release asset URL without credentials or query parameters")
    return value


def request(url: str, *, headers=None, timeout: float):
    values = {"Accept-Encoding": "identity", "Cache-Control": "no-cache",
              "User-Agent": "Open-Media-runtime-mirror-audit/1"}
    values.update(headers or {})
    return urllib.request.urlopen(urllib.request.Request(url, headers=values), timeout=timeout)


def read_metadata(source: str, expected_sha256: str, timeout: float) -> tuple[list, dict]:
    if source.startswith("https://"):
        source_url(source)
        with request(source, timeout=timeout) as response:
            if response.status != 200:
                raise ValueError("Metadata must be returned in full with HTTP 200")
            raw = response.read(MAX_METADATA_BYTES + 1)
        identity = source
    else:
        path = Path(source)
        if path.stat().st_size > MAX_METADATA_BYTES:
            raise ValueError("Metadata exceeds the size limit")
        raw = path.read_bytes()
        identity = path.name
    if len(raw) > MAX_METADATA_BYTES or digest(raw) != expected_sha256:
        raise ValueError("Metadata size or complete SHA-256 does not match the pinned input")
    document = json.loads(raw)
    if not isinstance(document, list) or len(document) != len(PLATFORMS):
        raise ValueError("Published runtime metadata must contain exactly three platforms")
    seen, commits = set(), set()
    for item in document:
        if not isinstance(item, dict) or item.get("platform") not in PLATFORMS:
            raise ValueError("Unknown runtime platform")
        platform = item["platform"]
        if platform in seen:
            raise ValueError("Duplicate runtime platform")
        seen.add(platform)
        if item.get("id") != "python-cpu-v1" or item.get("version") != 1:
            raise ValueError("Unexpected runtime identity")
        if item.get("validated") is not True or set(item.get("validatedModels", [])) != {
                "f5-v1-base-fp32", "qwen3-tts-1.7b-serena"}:
            raise ValueError("Runtime has not passed both real model validation checks")
        commit = item.get("sourceCommit", "")
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("Runtime metadata lacks a fixed source commit")
        commits.add(commit)
        filename = f"speech-runtime-python-cpu-v1-{platform}.zip"
        if item.get("filename") != filename or item.get("url") != RELEASE + filename:
            raise ValueError("Runtime metadata does not identify the fixed release archive")
        source_url(item["url"])
        if not isinstance(item.get("size"), int) or isinstance(item["size"], bool) or item["size"] <= 0:
            raise ValueError("Runtime archive size must be a positive integer")
        sha256_string(item.get("sha256", ""))
    if seen != PLATFORMS or len(commits) != 1:
        raise ValueError("All platforms must come from one validated source commit")
    return document, {"source": identity, "size": len(raw), "sha256": digest(raw), "matchesPinnedSha256": True}


def probe(url: str, size: int, timeout: float) -> dict:
    wanted = min(PREFIX_BYTES, size)
    evidence = {"url": url, "expectedSize": size, "requestedBytes": wanted, "available": False}
    try:
        with request(url, headers={"Range": f"bytes=0-{wanted - 1}"}, timeout=timeout) as response:
            evidence.update(httpStatus=response.status,
                            finalHost=urllib.parse.urlsplit(response.url).hostname,
                            contentLength=response.headers.get("Content-Length"),
                            contentRange=response.headers.get("Content-Range"))
            # A proxy may ignore Range and stream a complete multi-GB response.
            # Never read more than the requested prefix in that case.
            prefix = response.read(wanted)
            evidence.update(bytesRead=len(prefix), prefixSha256=digest(prefix))
            if len(prefix) != wanted:
                raise ValueError("Response ended before the requested prefix was read")
            if response.status == 206:
                match = re.fullmatch(r"bytes 0-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                if not match or int(match[1]) != wanted - 1 or int(match[2]) != size:
                    raise ValueError("Partial response range does not match the pinned archive size")
                length = response.headers.get("Content-Length")
                if length is not None and length != str(wanted):
                    raise ValueError("Partial response length does not match its range")
            elif response.status == 200:
                if response.headers.get("Content-Length") != str(size):
                    raise ValueError("Full response length does not match the pinned archive size")
                evidence["rangeIgnored"] = True
            else:
                raise ValueError("Unexpected HTTP status")
            evidence["available"] = True
    except urllib.error.HTTPError as error:
        evidence.update(httpStatus=error.code, error=f"HTTP {error.code}")
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        # Exception URLs can contain expiring redirect signatures. Retain only
        # the error class; fixed requested URLs and final host are already above.
        evidence["error"] = type(error).__name__
    except ValueError as error:
        evidence["error"] = str(error)
    return evidence


def local_reference(path: Path, size: int, expected_sha256: str) -> dict:
    if not path.is_file() or path.stat().st_size != size:
        raise ValueError("Local reference archive size differs from the pinned metadata")
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        prefix = stream.read(min(PREFIX_BYTES, size))
        checksum.update(prefix)
        while chunk := stream.read(4 * 1024**2):
            checksum.update(chunk)
    if checksum.hexdigest() != expected_sha256:
        raise ValueError("Local reference archive complete SHA-256 differs from the pinned metadata")
    return {"kind": "local-full-sha256", "filename": path.name, "size": size,
            "sha256": checksum.hexdigest(), "prefixSha256": digest(prefix)}


def verify_asset(item: dict, timeout: float, archive: Path | None = None) -> tuple[dict, list[str]]:
    original = item["url"]
    urls = [original, *(prefix + original for prefix in PROXIES)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(urls)) as executor:
        responses = list(executor.map(lambda url: probe(url, item["size"], timeout), urls))
    result = {"filename": item["filename"], "size": item["size"], "sha256": item["sha256"],
              "probes": responses, "verifiedMirrors": []}
    if item.get("platform"):
        result["platform"] = item["platform"]
    if archive is not None:
        reference = local_reference(archive, item["size"], item["sha256"])
    elif responses[0]["available"]:
        reference = {"kind": "original-release-prefix", "prefixSha256": responses[0]["prefixSha256"]}
        if item["size"] <= PREFIX_BYTES and reference["prefixSha256"] != item["sha256"]:
            result["error"] = "Original release file does not match its complete pinned SHA-256"
            return result, []
    else:
        result["error"] = "No trusted prefix reference: the original release is unreachable and no verified local archive was provided"
        return result, []
    result["reference"] = reference
    for response in responses:
        response["matchesReference"] = response["available"] and response.get("prefixSha256") == reference["prefixSha256"]
        if response["url"] != original and response["matchesReference"]:
            result["verifiedMirrors"].append(response["url"])
    if not result["verifiedMirrors"]:
        result["error"] = "No mirror passed the pinned-size and trusted-prefix checks"
    return result, result["verifiedMirrors"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--metadata", help="Published runtime metadata URL or local file")
    mode.add_argument("--probe-url", help="Probe an existing release asset without producing runtime metadata")
    parser.add_argument("--sha256", required=True, help="Pinned complete SHA-256 of the metadata, or of --probe-url")
    parser.add_argument("--size", type=int, help="Required complete byte size for --probe-url")
    parser.add_argument("--archives", type=Path, help="Optional original archives, verified in full before use as prefix references")
    parser.add_argument("--output", type=Path, help="Runtime metadata containing only successfully verified mirror URLs")
    parser.add_argument("--evidence", required=True, type=Path, help="Availability evidence JSON, including failed routes")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    sha256_string(args.sha256)
    if args.timeout <= 0 or args.timeout > 60:
        parser.error("--timeout must be greater than zero and at most 60 seconds")
    report = {"schema": 1, "checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
              "scope": "Current execution network; mainland China carrier connectivity is not established by this test.",
              "method": "At most 4096 bytes per route; fixed size and prefix agreement. Complete archive SHA-256 remains mandatory at installation.",
              "assets": []}
    if args.probe_url:
        if args.output or args.size is None or args.size <= 0:
            parser.error("--probe-url requires a positive --size and cannot produce --output metadata")
        source_url(args.probe_url)
        item = {"url": args.probe_url, "filename": args.probe_url.rsplit("/", 1)[1],
                "size": args.size, "sha256": args.sha256}
        archive = args.archives / item["filename"] if args.archives else None
        evidence, mirrors = verify_asset(item, args.timeout, archive)
        report.update(mode="asset-probe", assets=[evidence], passed=bool(mirrors))
        write_json(args.evidence, report)
        print(f"Release asset probe: {len(mirrors)} verified mirrors; evidence: {args.evidence}")
        return 0 if mirrors else 1
    if args.output is None or args.size is not None:
        parser.error("--metadata requires --output and does not accept --size")
    if args.output.resolve() == args.evidence.resolve():
        parser.error("Metadata output and evidence must use different files")
    if not args.metadata.startswith("https://") and args.output.resolve() == Path(args.metadata).resolve():
        parser.error("Preserve the pinned input metadata by selecting a separate output file")
    document, metadata_evidence = read_metadata(args.metadata, args.sha256, args.timeout)
    report.update(mode="runtime-release", metadata=metadata_evidence)
    passed = True
    for item in document:
        archive = args.archives / item["filename"] if args.archives else None
        evidence, mirrors = verify_asset(item, args.timeout, archive)
        report["assets"].append(evidence)
        item["mirrors"] = mirrors
        passed = passed and bool(mirrors)
    report["passed"] = passed
    if passed:
        write_json(args.output, document)
        report["outputMetadataSha256"] = digest(args.output.read_bytes())
    write_json(args.evidence, report)
    print(f"Runtime mirrors {'verified' if passed else 'failed'}; evidence: {args.evidence}")
    if not passed:
        print("No runtime metadata was written because at least one platform lacks a verified mirror.", file=sys.stderr)
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        # Network error strings may contain signed redirected URLs.
        message = type(error).__name__ if isinstance(error, (OSError, urllib.error.URLError)) else str(error)
        print(f"Mirror verification failed: {message}", file=sys.stderr)
        raise SystemExit(1)
