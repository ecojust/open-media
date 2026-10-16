import { createHash } from 'node:crypto';
import { readdirSync, statSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const directory = `src-tauri/target/${process.env.MEDIA_TARGET}/release/bundle`;
const collect = (root) => readdirSync(root).flatMap(name => {
  const file = join(root, name);
  return statSync(file).isDirectory() ? collect(file) : /\.(exe|dmg)$/.test(name) ? [file] : [];
});
const files = collect(directory);
if (files.length !== 1) throw new Error(`Expected one installer, found ${files.length}`);
mkdirSync('desktop-artifacts', { recursive: true });
const checksums = files.map(file => {
  if (!statSync(file).size) throw new Error(`Empty installer: ${file}`);
  copyFileSync(file, join('desktop-artifacts', basename(file)));
  return `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${basename(file)}`;
});
writeFileSync('desktop-artifacts/SHA256SUMS', checksums.join('\n') + '\n');
writeFileSync('desktop-artifacts/build.json', JSON.stringify({ commit: process.env.MEDIA_COMMIT, platform: process.env.MEDIA_PLATFORM, version: JSON.parse(readFileSync('package.json', 'utf8')).version, runtime: JSON.parse(readFileSync('src-tauri/resources/media/runtime.json', 'utf8')) }, null, 2) + '\n');
copyFileSync('LICENSE', 'desktop-artifacts/LICENSE');
copyFileSync('THIRD_PARTY_NOTICES.md', 'desktop-artifacts/THIRD_PARTY_NOTICES.md');
