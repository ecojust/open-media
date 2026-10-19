import { existsSync, readFileSync } from 'node:fs';

// Keep failures visible in check annotations when archived logs are unavailable.
for (const path of ['.video-generation-check/native-build.log', '.video-generation-check/evidence.json']) {
  if (!existsSync(path)) continue;
  const lines = readFileSync(path, 'utf8').split('\n');
  const detail = `${path}\n${lines.slice(-140).join('\n')}`.slice(-45000)
    .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::error::${detail}`);
}
