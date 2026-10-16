import { createHash } from 'node:crypto'

export const platforms = ['windows-x64', 'macos-arm64', 'macos-x64']
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function validateBuild(run, jobs, artifacts, expectedCommit) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit)) throw new Error('Expected commit must be a full SHA.')
  if (run.head_sha !== expectedCommit || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('The requested build is not a successful build of the expected commit.')
  if (run.path !== '.github/workflows/desktop-build.yml') throw new Error('Unexpected source workflow.')
  for (const name of ['Application checks', 'Corresponding media source', ...platforms]) {
    const matching = jobs.filter(job => job.name === name)
    if (matching.length !== 1 || matching[0].status !== 'completed' || matching[0].conclusion !== 'success') throw new Error(`Required job did not pass: ${name}`)
  }
  return [...platforms, 'runtime-source'].map(platform => {
    const matching = artifacts.filter(item => item.name === `open-media-${platform}-${run.id}`)
    if (matching.length !== 1 || matching[0].expired || matching[0].size_in_bytes < 1 || !/^sha256:[a-f0-9]{64}$/.test(matching[0].digest || '')) throw new Error(`Missing or invalid artifact: ${platform}`)
    return { platform, artifact: matching[0] }
  })
}
export function verifyDigest(bytes, expected) {
  if (`sha256:${digest(bytes)}` !== expected) throw new Error('Artifact or release asset SHA-256 mismatch.')
}
export function verifyMetadata(meta, platform, commit, version) {
  if (meta.commit !== commit || meta.platform !== platform || meta.version !== version) throw new Error(`Installer metadata mismatch: ${platform}`)
}
export function validateAssetMetadata(asset, name, bytes) {
  if (asset.name !== name || asset.state !== 'uploaded' || asset.size !== bytes.length) throw new Error(`Incomplete release asset: ${name}`)
  verifyDigest(bytes, asset.digest)
}
