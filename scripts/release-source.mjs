import { execFileSync } from 'node:child_process'

export function verifySourceContents(archive, prefix, expectedFiles) {
  // Hash required archive entries in one streaming pass, including model weights
  // and the complete dependency sources, without extracting executable files.
  execFileSync('python3', ['-c', `
import hashlib,json,pathlib,sys,tarfile
archive,prefix=sys.argv[1:]
expected=json.load(sys.stdin)
seen=set()
with tarfile.open(archive,mode='r|gz') as source:
    for item in source:
        path=pathlib.PurePosixPath(item.name)
        if path.is_absolute() or '..' in path.parts or '\\\\' in item.name or not path.parts or path.parts[0]!=prefix: raise ValueError('Unsafe corresponding source entry')
        if item.isdir(): continue
        if not item.isfile(): raise ValueError('Unsupported corresponding source entry')
        name='/'.join(path.parts[1:])
        if name in seen: raise ValueError('Duplicate corresponding source entry')
        seen.add(name)
        if name not in expected: continue
        if item.size>512*1024*1024: raise ValueError('Corresponding source entry exceeds verification limit')
        h=hashlib.sha256()
        with source.extractfile(item) as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''): h.update(chunk)
        if h.hexdigest()!=expected[name]: raise ValueError('Corresponding source checksum mismatch: '+name)
missing=set(expected)-seen
if missing: raise ValueError('Missing corresponding source files: '+', '.join(sorted(missing)))
`, archive, prefix], { input: JSON.stringify(Object.fromEntries(expectedFiles)), maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
}
