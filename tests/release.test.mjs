import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBuild, verifyDigest, verifyMetadata, digest } from '../scripts/release-validation.mjs';

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

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(repository, path));
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
