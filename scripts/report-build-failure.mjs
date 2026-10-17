import { existsSync, readFileSync } from 'node:fs';

const escapeAnnotation = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').replace(/\u001b\[[0-9;]*m/g, '').trim().split(/\r?\n/);
  const excerpt = lines.slice(-40).join('\n').slice(-6000);
  for (let offset = 0; offset < excerpt.length; offset += 1200) {
    const part = Math.floor(offset / 1200) + 1;
    console.log(`::error title=${escapeAnnotation(file)} (${part})::${escapeAnnotation(excerpt.slice(offset, offset + 1200))}`);
  }
}
