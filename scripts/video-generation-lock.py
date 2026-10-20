#!/usr/bin/env python3
"""Refresh the pinned optional model inventory without downloading weights."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'MiniMaxAI/MiniMax-H3'
REVISION = '42ed227ee7df40d41602854ae760620d6eb651fe'
ENGINE_REVISION = '8974cc055ea9c02fcd14cc27dfda3e1027c05153'
ORIGINS = ['https://huggingface.co', 'https://hf-mirror.com']


def fetch(url):
    with urllib.request.urlopen(url, timeout=90) as response:
        return response.read()


def needed(entry):
    path = entry['path']
    return entry['type'] == 'file' and path.startswith(('FL2VA/', 'Ref2VA/')) and (
        path.endswith('.safetensors') or path.endswith('model.safetensors.index.json')
        or path.split('/', 1)[1] in ('transformer/config.json', 'text_encoder/config.json',
                                   'tokenizer/tokenizer.json', 'audio_vae/config.json',
                                   'video_vae/config.json', 'video_vae/source/config.json'))


def file_entry(entry):
    path = entry['path']
    urls = [f'{origin}/{REPOSITORY}/resolve/{REVISION}/{path}' for origin in ORIGINS]
    digest = entry.get('lfs', {}).get('oid')
    if not digest:
        # Only small metadata and the tokenizer are fetched; no weight payload.
        assert entry['size'] < 10_000_000, f'unexpected untracked large file: {path}'
        payload = fetch(urls[0])
        assert len(payload) == entry['size'], f'size mismatch: {path}'
        blob_sha = hashlib.sha1(f'blob {len(payload)}\0'.encode() + payload).hexdigest()
        assert blob_sha == entry['oid'], f'Git blob mismatch: {path}'
        digest = hashlib.sha256(payload).hexdigest()
    assert len(digest) == 64
    return {'path': path, 'size': entry['size'], 'sha256': digest, 'urls': urls}


def main():
    tree = json.loads(fetch(f'{ORIGINS[0]}/api/models/{REPOSITORY}/tree/{REVISION}?recursive=true&limit=1000'))
    entries = sorted((entry for entry in tree if needed(entry)), key=lambda entry: entry['path'])
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        files = list(pool.map(file_entry, entries))
    license_url = f'{ORIGINS[0]}/{REPOSITORY}/resolve/{REVISION}/LICENSE'
    license_bytes = fetch(license_url)
    license_path = ROOT / 'licenses/video-generation/MiniMax-H3/LICENSE'
    license_path.write_bytes(license_bytes)
    models = []
    shared = set()
    for family, model_id, name, modes, requires in [
        ('FL2VA', 'h3-base-fl2va', 'MiniMax H3 · 基础生成', ['prompt', 'image', 'storyboard'], []),
        ('Ref2VA', 'h3-base-ref2va', 'MiniMax H3 · 多模态参考', ['reference'], ['h3-base-fl2va']),
    ]:
        selected = [entry for entry in files if entry['path'].startswith(family + '/')]
        unique = {entry['sha256']: entry['size'] for entry in selected}
        models.append({'id': model_id, 'name': name, 'modes': modes, 'requires': requires,
                       'totalBytes': sum(entry['size'] for entry in selected),
                       'uniqueBytes': sum(size for digest, size in unique.items() if digest not in shared),
                       'files': selected})
        shared.update(unique)
    manifest = {
        'schemaVersion': 1,
        'engine': {'id': 'h3-metal', 'version': ENGINE_REVISION, 'platforms': ['macos-arm64'],
                   'minimumMacos': '15.0', 'executable': 'open-media-video-generation',
                   'shader': 'h3_shaders.metal'},
        'repository': REPOSITORY, 'revision': REVISION,
        'license': {'id': 'MiniMax H3 Community License Agreement',
                    'path': 'licenses/video-generation/MiniMax-H3/LICENSE', 'url': license_url,
                    'sha256': hashlib.sha256(license_bytes).hexdigest(), 'text': license_bytes.decode(),
                    'notice': (ROOT / 'licenses/video-generation/MiniMax-H3/NOTICE').read_text(),
                    'excludedTerritories': ['European Union', 'United Kingdom', 'Republic of Korea', 'United States of America'],
                    'commercialAttribution': 'MiniMax H3'},
        'models': models,
    }
    (ROOT / 'src-tauri/resources/video-generation-models.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    (ROOT / 'licenses/video-generation/MiniMax-H3/metadata.json').write_text(
        json.dumps({'repository': REPOSITORY, 'revision': REVISION,
                    'entries': entries}, ensure_ascii=False, indent=2) + '\n')
    for model in models:
        print(model['id'], len(model['files']), model['totalBytes'], model['uniqueBytes'])


if __name__ == '__main__':
    main()
