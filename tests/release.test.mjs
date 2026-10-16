import test from 'node:test';
import assert from 'node:assert/strict';
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
