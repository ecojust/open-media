#!/usr/bin/env python3
"""Recover verified runtime artifacts without rebuilding the environments."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

REPOSITORY = 'ecojust/open-media'
PLATFORMS = ('macos-arm64', 'windows-x64', 'linux-x64')


def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{REPOSITORY}/{path}'], text=True))


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        while data := source.read(4 * 1024**2):
            value.update(data)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9]+', args.run) or not re.fullmatch(r'[a-f0-9]{40}', args.commit):
        raise ValueError('Expected an exact workflow run and source commit')
    run = api(f'actions/runs/{args.run}')
    if (run['repository']['full_name'] != REPOSITORY or run['head_sha'] != args.commit
            or run['path'] != '.github/workflows/ai-runtime-build.yml'):
        raise ValueError('Runtime build provenance does not match the requested source')
    artifacts = api(f'actions/runs/{args.run}/artifacts?per_page=100')['artifacts']
    evidence = []
    args.root.mkdir(parents=True, exist_ok=True)
    for platform in PLATFORMS:
        name = f'ai-runtime-v1-{platform}'
        matches = [item for item in artifacts if item['name'] == name and not item['expired']]
        if len(matches) != 1:
            raise ValueError(f'Expected one verified artifact for {platform}')
        item = matches[0]
        if (item['workflow_run']['head_sha'] != args.commit
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', item.get('digest', ''))):
            raise ValueError('Runtime artifact is missing the source commit or server digest')
        archive = args.root / (name + '.artifact.zip')
        print(f'Downloading verified artifact {item["id"]}: {name}', flush=True)
        with archive.open('xb') as output:
            subprocess.run(['gh', 'api', f'repos/{REPOSITORY}/actions/artifacts/{item["id"]}/zip'],
                           stdout=output, check=True, timeout=1800)
        actual = digest(archive)
        if archive.stat().st_size != item['size_in_bytes'] or f'sha256:{actual}' != item['digest']:
            raise ValueError('Downloaded Actions artifact differs from its API digest')
        target = args.root / name
        target.mkdir()
        with zipfile.ZipFile(archive) as source:
            seen = set()
            for entry in source.infolist():
                filename = entry.filename
                if (filename in seen or Path(filename).name != filename or '\\' in filename
                        or filename not in ('runtime-metadata.json', 'SHA256SUMS.txt')
                        and not re.fullmatch(re.escape(name) + r'\.zip(?:\.part[0-9]{3})?', filename)
                        or entry.file_size > item['size_in_bytes']):
                    raise ValueError('Unexpected artifact entry')
                seen.add(filename)
                with source.open(entry) as data, (target / filename).open('xb') as output:
                    shutil.copyfileobj(data, output, 4 * 1024**2)
        archive.unlink()
        evidence.append(dict(id=item['id'], name=name, size=item['size_in_bytes'],
                             digest=item['digest'], sourceCommit=args.commit, artifactDigestVerified=True))
    (args.root / 'artifact-provenance.json').write_text(json.dumps(dict(buildRun=args.run,
        sourceCommit=args.commit, artifacts=evidence), indent=2) + '\n')
    subprocess.run(['python', str(Path(__file__).with_name('ai-runtime-publish.py')),
                    '--root', str(args.root), '--commit', args.commit], check=True)


if __name__ == '__main__':
    main()
