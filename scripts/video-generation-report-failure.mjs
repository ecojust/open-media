import { existsSync, readFileSync } from 'node:fs';

// Keep failures visible in check annotations when archived logs are unavailable.
for (const path of ['.video-generation-check/native-build.log', '.video-generation-check/evidence.json']) {
  if (!existsSync(path)) continue;
  const raw = readFileSync(path, 'utf8');
  const lines = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split('\n');
  const detail = `${path}\n${lines.slice(-140).join('\n')}`.slice(-45000)
    .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::error::${detail}`);
  // Some runners truncate diagnostics with control characters. ASCII chunks
  // retain an exact, decodable tail alongside the human-readable summary.
  const encoded = Buffer.from(raw.slice(-16000)).toString('base64');
  for (let offset = 0; offset < encoded.length; offset += 3000) {
    console.log(`::error title=Native diagnostic ${offset / 3000 + 1}::${encoded.slice(offset, offset + 3000)}`);
  }
}
