import { existsSync, readFileSync } from 'node:fs';

const escapeAnnotation = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').replace(/\u001b\[[0-9;]*m/g, '').trim().split(/\r?\n/);
  const excerpt = lines.slice(-40).join('\n').slice(-6000);
  if (excerpt) console.log(`::error title=${escapeAnnotation(file)}::${escapeAnnotation(excerpt)}`);
}
