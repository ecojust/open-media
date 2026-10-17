import argparse
import shutil
import hashlib
import json
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.output.resolve()
root.mkdir(parents=True,exist_ok=True)
manifest = json.loads((Path(__file__).parent / 'f5-sources.json').read_text())
for item in manifest['files']:
    path = root / item['path']
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists() and path.stat().st_size == item['bytes']:
        digest = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
        if not item['sha256'] or item['sha256'] == digest:
            item['sha256'] = digest
            print('cached', item['path'], flush=True)
            continue
    start = time.perf_counter()
    temporary = path.with_suffix(path.suffix + '.part')
    with urllib.request.urlopen(item['url'], timeout=60) as response, temporary.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    assert temporary.stat().st_size == item['bytes'], item
    digest = hashlib.file_digest(temporary.open('rb'), 'sha256').hexdigest()
    assert not item['sha256'] or item['sha256'] == digest, item
    temporary.rename(path)
    item['sha256'] = digest
    print('downloaded', item['path'], item['bytes'], round(time.perf_counter() - start, 1), flush=True)
(root / 'sources.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
