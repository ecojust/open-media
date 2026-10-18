#!/usr/bin/env python3
"""Keep published metadata immutable and record measured alternate download routes."""
import argparse
import concurrent.futures
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

PREFIXES = ['https://ghfast.top/', 'https://ghproxy.net/', 'https://gh-proxy.com/']
SAMPLE_BYTES = 65536


def probe(url, size):
    request = Request(url, headers={'Range': f'bytes=0-{min(size, SAMPLE_BYTES)-1}',
                                    'User-Agent': 'Open-Media-Runtime-Verification',
                                    'Accept-Encoding': 'identity'})
    with urlopen(request, timeout=30) as response:
        if response.status not in (200, 206):
            raise ValueError('Unexpected HTTP status')
        declared = response.headers.get('Content-Range', '')
        if response.status == 206:
            if declared != f'bytes 0-{min(size, SAMPLE_BYTES)-1}/{size}':
                raise ValueError('Partial response has a different offset or total size')
        elif response.headers.get('Content-Length') != str(size):
            raise ValueError('Full response has a different total size')
        prefix = response.read(min(size, SAMPLE_BYTES))
        if len(prefix) != min(size, SAMPLE_BYTES):
            raise ValueError('Incomplete sample')
        return dict(status=response.status, sampleBytes=len(prefix),
                    sampleSha256=hashlib.sha256(prefix).hexdigest(), totalBytes=size)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--metadata', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    raw = args.metadata.read_bytes()
    metadata = json.loads(raw)
    records = metadata.get('parts') or [metadata]
    evidence = []
    for record in records:
        url, size = record['url'], record['size']
        if not url.startswith('https://github.com/ecojust/open-media/releases/download/'):
            raise ValueError('Only this application\'s immutable release URLs are accepted')
        original = probe(url, size)
        candidates = [prefix + url for prefix in PREFIXES]
        routes, attempts = [], []
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(candidates)) as pool:
            pending = [(address, pool.submit(probe, address, size)) for address in candidates]
            for address, task in pending:
                try:
                    sample = task.result()
                    if sample['sampleSha256'] != original['sampleSha256']:
                        raise ValueError('Alternate response differs from the release sample')
                    routes.append(address)
                    attempts.append(dict(url=address, matched=True, **sample))
                except Exception as error:
                    attempts.append(dict(url=address, matched=False, error=type(error).__name__,
                                         httpStatus=getattr(error, 'code', None)))
        if not routes:
            raise ValueError(f'No verified alternate route for {record.get("filename", "archive")}')
        record['mirrors'] = routes
        evidence.append(dict(url=url, original=original, attempts=attempts))
        print(json.dumps(dict(file=record.get('filename'), verifiedAlternates=len(routes))), flush=True)
    metadata['mirrorAudit'] = dict(
        checkedAt=datetime.now(timezone.utc).isoformat(),
        publishedMetadataSha256=hashlib.sha256(raw).hexdigest(),
        scope='Availability and identical prefix samples measured from the development workspace. '
              'Mainland China carrier connectivity is not directly tested. Full SHA-256 and byte '
              'size remain mandatory when installing every part and the combined archive.',
        samples=evidence)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(metadata, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
