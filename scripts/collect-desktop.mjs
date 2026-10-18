import { createHash } from 'node:crypto';
import { readdirSync, statSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { digest, verifySpeechMetadata, verifyDigest, verifySpeechSynthesis } from './release-validation.mjs';

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
const speechRoot = 'src-tauri/resources/speech';
const speechLockBytes = readFileSync('scripts/speech-runtime.lock.json');
const speechLock = JSON.parse(speechLockBytes);
const speechRuntime = verifySpeechMetadata(JSON.parse(readFileSync(join(speechRoot, 'runtime.json'), 'utf8')), process.env.MEDIA_PLATFORM, {
  sourceLockSha256: digest(speechLockBytes),
  prepareScriptSha256: digest(readFileSync('scripts/speech-runtime.mjs')),
  runnerSourceSha256: digest(readFileSync('scripts/speech-runtime-runner.c')),
  runnerManifestSha256: digest(readFileSync('scripts/speech-runtime-runner.manifest')),
  model: speechLock.model,
});
for (const file of speechRuntime.files) verifyDigest(readFileSync(join(speechRoot, file.path)), `sha256:${file.sha256}`);
const speechEvidenceRoot = '.speech-runtime/installed-voice-validation';
const speechEvidencePath = join(speechEvidenceRoot, 'summary.json');
const speechEvidenceBytes = readFileSync(speechEvidencePath);
const speechEvidence = verifySpeechSynthesis(JSON.parse(speechEvidenceBytes), process.env.MEDIA_PLATFORM, process.env.MEDIA_COMMIT);
for (const voice of speechEvidence.voices) {
  const audioBytes = readFileSync(join(speechEvidenceRoot, voice.audio.path));
  if (audioBytes.length !== voice.audio.bytes) throw new Error(`Generated speech size changed: ${voice.voiceId}`);
  verifyDigest(audioBytes, `sha256:${voice.audio.sha256}`);
}
copyFileSync(speechEvidencePath, 'desktop-artifacts/speech-verification.json');
const speechVerification = { file: 'speech-verification.json', sha256: digest(speechEvidenceBytes), bytes: speechEvidenceBytes.length };
writeFileSync('desktop-artifacts/build.json', JSON.stringify({ commit: process.env.MEDIA_COMMIT, platform: process.env.MEDIA_PLATFORM, version: JSON.parse(readFileSync('package.json', 'utf8')).version, runtime: JSON.parse(readFileSync('src-tauri/resources/media/runtime.json', 'utf8')), speechRuntime, speechVerification }, null, 2) + '\n');
copyFileSync('LICENSE', 'desktop-artifacts/LICENSE');
copyFileSync('THIRD_PARTY_NOTICES.md', 'desktop-artifacts/THIRD_PARTY_NOTICES.md');
