#!/usr/bin/env python3
"""Upload verified runtime bytes to an existing, exactly pinned draft release."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

REPO = 'ecojust/open-media'
TAG = 'ai-runtime-v1'


def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{REPO}/{path}'], text=True))


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        while data := source.read(4 * 1024**2):
            result.update(data)
    return result.hexdigest()


def progress(stage):
    print(stage, flush=True)
    commit = os.environ.get('GITHUB_SHA', '')
    if re.fullmatch('[a-f0-9]{40}', commit):
        payload = dict(name='AI runtime publication progress', head_sha=commit,
            status='completed', conclusion='neutral', output=dict(title=stage,
            summary=f'Run {os.environ.get("GITHUB_RUN_ID", "")}: {stage}'))
        subprocess.run(['gh', 'api', '-X', 'POST', f'repos/{REPO}/check-runs', '--input', '-'],
                       input=json.dumps(payload), text=True, stdout=subprocess.DEVNULL, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    if not re.fullmatch('[0-9]+', args.release) or not re.fullmatch('[a-f0-9]{40}', args.commit):
        raise ValueError('Expected an existing draft release ID and exact source commit')
    release = api(f'releases/{args.release}')
    if (release['tag_name'] != TAG or release['target_commitish'] != args.commit
            or not release['draft'] or not release['prerelease']):
        raise ValueError('Refusing to change an unrecognized or already published release')
    tag = api(f'git/ref/tags/{TAG}')['object']
    if tag['type'] != 'commit' or tag['sha'] != args.commit:
        raise ValueError('Published component tag does not match its verified source')
    paths = {}
    metadata = json.loads((args.root / 'runtime-metadata.json').read_text())
    for runtime in metadata:
        for item in runtime.get('parts') or [runtime]:
            path = args.root / f'ai-runtime-v1-{runtime["platform"]}' / item['filename']
            if path.stat().st_size != item['size'] or digest(path) != item['sha256']:
                raise ValueError('Runtime bytes changed after provenance validation')
            paths[path.name] = (path, item['sha256'])
    for name in ('ai-runtime-models.json', 'runtime-metadata.json', 'SHA256SUMS.txt', 'artifact-provenance.json'):
        path = args.root / name
        paths[name] = (path, digest(path))
    assets = {item['name']: item for item in api(f'releases/{args.release}/assets?per_page=100')}
    if set(assets) - set(paths):
        raise ValueError('Draft contains unexpected assets; refusing to alter it')
    progress('Verified existing draft and source tag; uploading immutable runtime assets')
    for index, (name, (path, expected)) in enumerate(paths.items(), start=1):
        if name not in assets:
            subprocess.run(['gh', 'release', 'upload', TAG, str(path), '--repo', REPO], check=True, timeout=1800)
        current = {item['name']: item for item in api(f'releases/{args.release}/assets?per_page=100')}[name]
        if current['size'] != path.stat().st_size or current.get('digest') != 'sha256:' + expected:
            raise ValueError(f'Release asset differs from its verified bytes: {name}')
        progress(f'Uploaded and verified {index}/{len(paths)} runtime assets: {name}')
    subprocess.run(['gh', 'release', 'edit', TAG, '--repo', REPO, '--draft=false',
                    '--prerelease', '--latest=false', '--title', 'Open Media AI Runtime v1'], check=True)
    final = api(f'releases/{args.release}')
    if final['draft'] or not final['prerelease']:
        raise ValueError('Runtime release visibility does not match the requested prerelease')
    (args.root / 'release-verification.json').write_text(json.dumps(dict(release=final['html_url'],
        sourceCommit=args.commit, assets=[dict(name=name, sha256=value[1]) for name, value in paths.items()]), indent=2)+'\n')
    progress('Published verified independent AI runtime components')


if __name__ == '__main__':
    main()
