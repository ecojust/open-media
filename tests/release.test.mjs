import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateBuild, verifyDigest, verifyMetadata, digest, verifySpeechMetadata, sourceChecksums, speechSourceRequirements } from '../scripts/release-validation.mjs';
import { verifySourceContents } from '../scripts/release-source.mjs';

const commit = 'a'.repeat(40);
function fixture() {
  return {
    run: { id: 7, head_sha: commit, status: 'completed', conclusion: 'success', path: '.github/workflows/desktop-build.yml' },
    jobs: ['Application checks', 'Corresponding media source', 'windows-x64', 'macos-arm64', 'macos-x64'].map(name => ({ name, status: 'completed', conclusion: 'success' })),
    artifacts: ['windows-x64', 'macos-arm64', 'macos-x64', 'runtime-source'].map(platform => ({ name: `open-media-${platform}-7`, expired: false, size_in_bytes: 1, digest: `sha256:${'a'.repeat(64)}` })),
  };
}
test('release requires the same successful source commit and all platform checks', () => {
  const { run, jobs, artifacts } = fixture();
  assert.equal(validateBuild(run, jobs, artifacts, commit).length, 4);
  assert.throws(() => validateBuild({ ...run, head_sha: 'b'.repeat(40) }, jobs, artifacts, commit));
  assert.throws(() => validateBuild(run, jobs.filter(job => job.name !== 'Application checks'), artifacts, commit));
  assert.throws(() => validateBuild(run, jobs.map(job => job.name === 'windows-x64' ? { ...job, conclusion: 'failure' } : job), artifacts, commit));
});
test('media binaries cannot be released without the complete corresponding source artifact', () => {
  const { run, jobs, artifacts } = fixture();
  assert.throws(() => validateBuild(run, jobs, artifacts.filter(artifact => !artifact.name.includes('runtime-source')), commit));
  assert.throws(() => validateBuild(run, jobs.filter(job => job.name !== 'Corresponding media source'), artifacts, commit));
  assert.throws(() => validateBuild(run, jobs, artifacts.map(artifact => ({ ...artifact, expired: true })), commit));
});
test('installer digest and provenance must match before publishing', () => {
  const bytes = Buffer.from('installer');
  verifyDigest(bytes, `sha256:${digest(bytes)}`);
  assert.throws(() => verifyDigest(Buffer.from('changed'), `sha256:${digest(bytes)}`));
  verifyMetadata({ commit, version: '0.1.0', platform: 'windows-x64' }, 'windows-x64', commit, '0.1.0');
  assert.throws(() => verifyMetadata({ commit, version: '0.1.0', platform: 'macos-x64' }, 'windows-x64', commit, '0.1.0'));
});
function speechFixture() {
  const expected = { sourceLockSha256: 'a'.repeat(64), prepareScriptSha256: 'b'.repeat(64), runnerSourceSha256: 'c'.repeat(64), runnerManifestSha256: 'd'.repeat(64), model: { id: 'offline-voices', version: '1.0', license: 'Apache-2.0' } };
  const files = ['manifest.json', 'source-lock.json', 'runtime/bin/open-media-speech', 'model/voices.bin', 'licenses/NOTICE'].map(path => ({ path, sha256: 'a'.repeat(64) }));
  const runtime = { schema: 1, platform: 'darwin', arch: 'arm64', ...expected, files, licenses: [files.at(-1)] };
  return { expected, runtime };
}
test('offline speech release requires the exact platform, runner, model and original notices', () => {
  const { expected, runtime } = speechFixture();
  verifySpeechMetadata(runtime, 'macos-arm64', expected);
  assert.throws(() => verifySpeechMetadata(undefined, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata(runtime, 'macos-x64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, runnerSourceSha256: 'e'.repeat(64) }, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, model: { ...runtime.model, license: 'unknown' } }, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, licenses: [] }, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, files: runtime.files.filter(file => !file.path.startsWith('model/')) }, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, files: [...runtime.files, { path: '../outside', sha256: 'a'.repeat(64) }] }, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, licenses: [{ path: 'licenses/NOTICE', sha256: 'e'.repeat(64) }] }, 'macos-arm64', expected));
});
test('corresponding source checksums require both media and speech archives exactly once', () => {
  const media = `${'a'.repeat(64)}  open-media-runtime-source.tar.gz`;
  const speech = `${'b'.repeat(64)}  open-media-speech-source.tar.gz`;
  assert.equal(sourceChecksums(`${media}\n${speech}\n`).size, 2);
  assert.throws(() => sourceChecksums(media));
  assert.throws(() => sourceChecksums(speech));
  assert.throws(() => sourceChecksums(`${media}\n${speech}\n${speech}`));
});
test('streaming source verification rejects missing dependencies and modified model bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-media-release-'));
  try {
    const archive = join(directory, 'source.tar.gz');
    const sources = [
      { id: 'engine', archive: 'engine.tar.gz', kind: 'source', bytes: 'complete engine source' },
      { id: 'dependency', archive: 'dependency.tar.gz', kind: 'source', bytes: 'complete dependency source and license' },
      { id: 'model', archive: 'model.tar.gz', kind: 'model', bytes: 'original model weights and license' },
      { id: 'vocoder', archive: 'vocoder.onnx', kind: 'vocoder', bytes: 'original vocoder weights' },
      { id: 'runtime', archive: 'runtime.tar.gz', kind: 'runtime', bytes: 'verified runtime release' },
    ].map(source => ({ ...source, sha256: digest(Buffer.from(source.bytes)) }));
    const expected = speechSourceRequirements({ sources });
    const writeArchive = files => execFileSync('python3', ['-c', `
import io,json,sys,tarfile
with tarfile.open(sys.argv[1],'w:gz') as archive:
    for file in json.load(sys.stdin):
        data=file['bytes'].encode()
        entry=tarfile.TarInfo('speech-runtime-source/.speech-runtime/downloads/'+file['archive'])
        entry.size=len(data)
        archive.addfile(entry,io.BytesIO(data))
`, archive], { input: JSON.stringify(files) });
    writeArchive(sources);
    verifySourceContents(archive, 'speech-runtime-source', expected);
    writeArchive(sources.filter(source => source.id !== 'dependency'));
    assert.throws(() => verifySourceContents(archive, 'speech-runtime-source', expected), /Missing corresponding source files/);
    writeArchive(sources.filter(source => source.id !== 'vocoder'));
    assert.throws(() => verifySourceContents(archive, 'speech-runtime-source', expected), /Missing corresponding source files/);
    writeArchive(sources.map(source => source.id === 'model' ? { ...source, bytes: 'modified weights' } : source));
    assert.throws(() => verifySourceContents(archive, 'speech-runtime-source', expected), /checksum mismatch/);
    assert.throws(() => speechSourceRequirements({ sources: sources.filter(source => source.kind !== 'source') }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(repository, path));
test('offline speech notices retain original model and dependency license bytes', () => {
  const lock = JSON.parse(read('scripts/speech-runtime.lock.json'));
  const inventory = JSON.parse(read('licenses/speech-runtime/manifest.json'));
  const sources = new Map(lock.sources.map(source => [source.id, source]));
  assert.equal(inventory.schema, 1);
  assert.ok(inventory.files.length);
  const paths = new Set();
  for (const file of inventory.files) {
    assert.ok(sources.has(file.sourceId), `Unknown speech license source: ${file.sourceId}`);
    assert.ok(file.sourcePath, 'Preserve the original source path of each notice.');
    assert.ok(!paths.has(file.path), `Duplicate speech notice: ${file.path}`);
    paths.add(file.path);
    assert.equal(digest(read(`licenses/speech-runtime/${file.path}`)), file.sha256, `Original speech notice was modified: ${file.path}`);
  }
  for (const source of lock.sources.filter(source => source.kind === 'model')) assert.ok(inventory.files.some(file => file.sourceId === source.id), `Missing model license: ${source.id}`);
});
test('native dependency notices cover locked archives and retain verified original texts', () => {
  const base = 'licenses/application/cargo';
  const inventory = JSON.parse(read(`${base}/manifest.json`));
  const lock = read('src-tauri/Cargo.lock');
  assert.equal(inventory.sourceLockSha256, digest(lock), 'Refresh the dependency inventory after changing the lock file.');
  const packages = lock.toString().split('[[package]]').filter(block => /source = "registry\+/.test(block)).map(block => ({
    name: /^name = "([^"]+)"/m.exec(block)[1],
    version: /^version = "([^"]+)"/m.exec(block)[1],
    checksum: /^checksum = "([^"]+)"/m.exec(block)[1],
  }));
  assert.equal(inventory.packages.length, packages.length);
  for (const item of packages) {
    const entry = inventory.packages.find(value => value.name === item.name && value.version === item.version);
    assert.ok(entry, `Missing notices for ${item.name} ${item.version}`);
    assert.equal(entry.archiveSha256, item.checksum);
    assert.ok(entry.notices.length, `Missing original license texts for ${item.name}`);
    for (const notice of entry.notices) assert.equal(digest(read(`${base}/${notice.file}`)), notice.sha256);
  }
});

test('frontend dependency notices match audited inputs and include vendored helper permissions', () => {
  const inventory = JSON.parse(read('licenses/application/frontend/manifest.json'));
  for (const input of inventory.inputs) assert.equal(digest(read(input.path)), input.sha256, `Refresh the frontend inventory after changing ${input.path}.`);
  for (const entry of inventory.packages) {
    assert.ok(entry.licenses.length);
    for (const license of entry.licenses) assert.equal(digest(read(license.bundledPath)), license.sha256);
  }
  for (const entry of inventory.vendoredComponents) {
    assert.equal(digest(read(entry.bundledLicensePath)), entry.licenseSha256);
    assert.equal(digest(read(entry.sourcePath)), entry.sourceFileSha256);
  }
});
