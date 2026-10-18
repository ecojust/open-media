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
    if (platforms.includes(name)) {
      const speechChecks = (matching[0].steps || []).filter(step => step.name === 'Verify every installed speech voice')
      if (speechChecks.length !== 1 || speechChecks[0].status !== 'completed' || speechChecks[0].conclusion !== 'success') throw new Error(`Installed speech verification did not pass: ${name}`)
    }
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
const validSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const safeRelativePath = value => typeof value === 'string' && value.length > 0 && !/[\\\0:]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..')
export const installedSpeechVoiceIds = ['matcha_zh_en_female', 'zipvoice_zh_female', 'zipvoice_zh_male', 'f5_zh_female', 'f5_zh_male', 'qwen3_serena', 'qwen3_uncle_fu']
const speechVerificationText = '这是一款全程由AI接管并生成的软件'
export function verifySpeechSynthesis(summary, platform, commit) {
  if (!platforms.includes(platform) || !/^[a-f0-9]{40}$/.test(commit) || summary?.schema !== 1 || summary.platform !== platform || summary.sourceCommit !== commit || summary.status !== 'passed') throw new Error(`Installed speech evidence provenance mismatch: ${platform}`)
  if (summary.text !== speechVerificationText) throw new Error('Installed speech verification must use the common test text.')
  if (summary.runtimeIntegrity?.unchanged !== true || summary.installationIntegrity?.unchanged !== true) throw new Error('Installed speech verification must preserve the model, runtime and installation.')
  const availability = summary.availability?.python
  if (typeof availability?.mpsAvailable !== 'boolean' || typeof availability.cudaAvailable !== 'boolean' || !Number.isSafeInteger(availability.cudaDeviceCount) || availability.cudaDeviceCount < 0 || (availability.cudaAvailable && availability.cudaDeviceCount < 1)) throw new Error('Installed speech device availability evidence is missing or inconsistent.')
  if (!Array.isArray(summary.voices) || summary.voices.length !== installedSpeechVoiceIds.length) throw new Error('Every installed speech voice must be verified exactly once.')
  const voices = new Set(), paths = new Set(), hashes = new Set()
  for (const voice of summary.voices) {
    if (!voice || !installedSpeechVoiceIds.includes(voice.voiceId) || voices.has(voice.voiceId) || voice.status !== 'passed') throw new Error('Missing, repeated or failed installed speech voice.')
    if (voice.text !== speechVerificationText || voice.productionPath !== 'SpeechRuntime::command + generate_wave' || voice.completionVerified !== true || (voice.voiceId.startsWith('qwen3_') && voice.eosVerified !== true)) throw new Error(`Installed speech did not finish through the production path: ${voice.voiceId}`)
    const gpuVerified = voice.backend === 'coreml' ? null : ['mps', 'cuda'].includes(voice.backend)
    if (voice.requestedDevice !== 'auto' || voice.gpuInferenceVerified !== gpuVerified) throw new Error(`Installed speech must record automatic device selection and actual GPU evidence: ${voice.voiceId}`)
    voices.add(voice.voiceId)
    const audio = voice.audio
    if (!audio || !safeRelativePath(audio.path) || !audio.path.endsWith('.wav') || paths.has(audio.path) || !validSha256(audio.sha256) || hashes.has(audio.sha256) || !Number.isSafeInteger(audio.bytes) || audio.bytes <= 44 || audio.bytes > 100 * 1024 * 1024) throw new Error(`Invalid generated speech audio evidence: ${voice.voiceId}`)
    const sampleRate = voice.voiceId === 'matcha_zh_en_female' ? 16000 : 24000
    if (audio.finite !== true || audio.sampleRate !== sampleRate || audio.channels !== 1 || !Number.isFinite(audio.durationSeconds) || audio.durationSeconds < 0.25 || audio.durationSeconds > 120 || !Number.isFinite(audio.peak) || audio.peak <= 0.0001 || !Number.isFinite(audio.rms) || audio.rms <= 0.00001 || audio.rms > audio.peak) throw new Error(`Generated speech must contain finite audible samples: ${voice.voiceId}`)
    paths.add(audio.path); hashes.add(audio.sha256)
    if (!['cpu', 'mps', 'cuda', 'coreml'].includes(voice.backend) || !Array.isArray(voice.events) || !voice.events.length || voice.events.some(event => typeof event !== 'string') || !Array.isArray(voice.partial) || voice.partial.some(event => typeof event !== 'string') || !Array.isArray(voice.fallback) || voice.fallback.some(event => typeof event !== 'string')) throw new Error(`Missing actual speech backend evidence: ${voice.voiceId}`)
    const deviceEvents = voice.events.filter(event => event.startsWith('stage=device,'))
    const device = /(?:^|,)device=([^,\r\n]+)/.exec(deviceEvents.at(-1) || '')?.[1]
    if (device !== voice.backend) throw new Error(`Speech backend differs from the production event: ${voice.voiceId}`)
    if (!/^stage=complete(?:,|$)/.test(voice.events.at(-1))) throw new Error(`Speech production did not report completion: ${voice.voiceId}`)
    if ((voice.backend === 'mps' && (platform === 'windows-x64' || !availability.mpsAvailable)) || (voice.backend === 'cuda' && (platform !== 'windows-x64' || !availability.cudaAvailable))) throw new Error(`Speech GPU execution lacks device availability evidence: ${voice.voiceId}`)
    if (voice.backend === 'coreml' && (platform === 'windows-x64' || summary.availability?.native?.operatorPlacementMeasured !== false || typeof voice.backendNote !== 'string' || !voice.backendNote.trim())) throw new Error(`CoreML evidence must distinguish provider selection from operator placement: ${voice.voiceId}`)
  }
  return summary
}
export function verifySpeechMetadata(runtime, platform, expected) {
  const target = { 'windows-x64': ['win32', 'x64'], 'macos-arm64': ['darwin', 'arm64'], 'macos-x64': ['darwin', 'x64'], 'linux-x64': ['linux', 'x64'] }[platform]
  if (!target || runtime?.schema !== 1 || runtime.platform !== target[0] || runtime.arch !== target[1]) throw new Error(`Speech runtime platform mismatch: ${platform}`)
  if (runtime.sourceLockSha256 !== expected.sourceLockSha256 || runtime.prepareScriptSha256 !== expected.prepareScriptSha256) throw new Error(`Installer contains a stale speech runtime: ${platform}`)
  for (const field of ['runnerSourceSha256', 'runnerManifestSha256']) if (!validSha256(expected[field]) || runtime[field] !== expected[field]) throw new Error(`Speech runner source provenance mismatch: ${field}`)
  for (const field of ['id', 'version', 'license']) {
    if (!expected.model?.[field] || runtime.model?.[field] !== expected.model[field]) throw new Error(`Speech model provenance mismatch: ${field}`)
  }
  if (!Array.isArray(runtime.files) || !runtime.files.length || !Array.isArray(runtime.licenses) || !runtime.licenses.length) throw new Error('Speech files and original license inventory are required.')
  const files = new Map()
  for (const file of runtime.files) {
    if (!safeRelativePath(file.path) || !validSha256(file.sha256) || files.has(file.path)) throw new Error('Speech file inventory is invalid.')
    files.set(file.path, file.sha256)
  }
  if (!files.has('manifest.json') || !files.has('source-lock.json') || ![...files.keys()].some(path => path.startsWith('model/')) || ![...files.keys()].some(path => path.startsWith('runtime/'))) throw new Error('Speech runtime is missing its model, executable, or configuration provenance.')
  const licenses = new Set()
  for (const license of runtime.licenses) {
    if (!safeRelativePath(license.path) || !license.path.startsWith('licenses/') || !validSha256(license.sha256) || files.get(license.path) !== license.sha256 || licenses.has(license.path)) throw new Error('Speech original license inventory is invalid.')
    licenses.add(license.path)
  }
  if (files.get('source-lock.json') !== expected.sourceLockSha256) throw new Error('Bundled speech source lock differs from the release commit.')
  return runtime
}
export function sourceChecksums(text) {
  const required = ['open-media-runtime-source.tar.gz', 'open-media-speech-source.tar.gz']
  const entries = new Map()
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line)
    if (!match || !required.includes(match[2]) || entries.has(match[2])) throw new Error('Invalid corresponding source checksum entry.')
    entries.set(match[2], match[1])
  }
  if (required.some(name => !entries.has(name))) throw new Error('Both complete media and speech corresponding source archives are required.')
  return entries
}
export function verifySpeechSourceArchives(lock, archivedFile) {
  for (const [path, sha256] of speechSourceRequirements(lock)) verifyDigest(archivedFile(path), `sha256:${sha256}`)
}
export function speechSourceRequirements(lock) {
  if (!Array.isArray(lock.sources) || !lock.sources.length || !lock.sources.some(source => source.kind === 'source') || !lock.sources.some(source => source.kind === 'model') || !lock.sources.some(source => source.kind === 'runtime')) throw new Error('Complete speech sources, model, and runtime archives are required.')
  const archives = new Map()
  for (const source of lock.sources) {
    if (!safeRelativePath(source.archive) || source.archive.includes('/') || !validSha256(source.sha256)) throw new Error('Speech source archive inventory is invalid.')
    if (archives.has(source.archive) && archives.get(source.archive) !== source.sha256) throw new Error('Conflicting speech source archive hashes.')
    archives.set(source.archive, source.sha256)
  }
  return new Map([...archives].map(([archive, sha256]) => [`.speech-runtime/downloads/${archive}`, sha256]))
}
export function validateAssetMetadata(asset, name, bytes) {
  if (asset.name !== name || asset.state !== 'uploaded' || asset.size !== bytes.length) throw new Error(`Incomplete release asset: ${name}`)
  verifyDigest(bytes, asset.digest)
}
