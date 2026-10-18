import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const catalog = JSON.parse(read('src-tauri/resources/speech-models.json'))
const bundled = JSON.parse(read('scripts/speech-runtime.lock.json'))
const expectedModels = ['zipvoice-distill-fp32', 'f5-v1-base-fp32', 'qwen3-tts-1.7b-serena']
const expectedVoices = ['zipvoice_zh_female', 'zipvoice_zh_male', 'f5_zh_female', 'f5_zh_male', 'qwen3_serena', 'qwen3_uncle_fu']
const safeRelative = path => assert.doesNotMatch(path, /(^\/|[\\,:]|(^|\/)\.\.(\/|$))/)
const httpsSource = source => {
  const url = new URL(source)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.username, '')
  assert.equal(url.password, '')
}
const archiveKeys = ['url', 'size', 'unpackedSize', 'sha256', 'manifestSha256', 'executable', 'script']
const archiveFromMetadata = metadata => ({
  ...Object.fromEntries(archiveKeys.map(key => [key, metadata[key]])),
  mirrors: metadata.mirrors ?? [],
  ...(metadata.kind === 'native' ? { kind: 'native' } : {}),
  ...(metadata.parts ? { parts: metadata.parts } : {}),
})

function verifiedAcceleratedRuntime(id, releaseTag, prefix) {
  const metadata = JSON.parse(read(`test/optional-speech-runtime/${id}-runtime-metadata.json`))
  const runtime = catalog.runtimes.find(item => item.id === id)
  assert.ok(runtime, `Final catalogue must include the reviewed ${id} runtime`)
  assert.equal(metadata.id, id)
  assert.equal(metadata.version, 1)
  assert.equal(metadata.platform, 'windows-x64')
  assert.equal(metadata.validated, true)
  assert.match(metadata.sourceCommit, /^[a-f0-9]{40}$/)
  assert.equal(runtime.version, metadata.version)
  assert.deepEqual(Object.keys(runtime.platforms), ['windows-x64'], 'Do not advertise an accelerated package for a platform without a verified archive')
  const archive = runtime.platforms['windows-x64']
  assert.deepEqual(archive, archiveFromMetadata(metadata), 'Published package hashes, entry points and every part must match the reviewed metadata exactly')
  const filename = `${prefix}-${id}-windows-x64.zip`
  const release = `https://github.com/ecojust/open-media/releases/download/${releaseTag}/`
  assert.equal(metadata.filename, filename)
  assert.equal(archive.url, release + filename)
  assert.ok(Number.isSafeInteger(archive.size) && archive.size > 0)
  assert.ok(Number.isSafeInteger(archive.unpackedSize) && archive.unpackedSize >= archive.size)
  for (const field of ['sha256', 'manifestSha256']) assert.match(archive[field], /^[a-f0-9]{64}$/)
  safeRelative(archive.executable); safeRelative(archive.script)
  for (const source of [archive.url, ...archive.mirrors]) httpsSource(source)
  assert.ok(archive.parts.length >= 2 && archive.parts.length <= 16, 'Large accelerated archives must retain their separately published parts')
  assert.equal(archive.parts.reduce((sum, part) => sum + part.size, 0), archive.size)
  const urls = new Set(), hashes = new Set()
  for (const [index, part] of archive.parts.entries()) {
    const partName = `${filename}.part${String(index + 1).padStart(3, '0')}`
    assert.equal(part.filename, partName)
    assert.equal(part.url, release + partName)
    assert.ok(Number.isSafeInteger(part.size) && part.size > 0 && part.size <= 1_800_000_000)
    assert.match(part.sha256, /^[a-f0-9]{64}$/)
    assert.ok(!urls.has(part.url) && !hashes.has(part.sha256), 'Duplicated or reordered parts cannot produce the verified archive')
    urls.add(part.url); hashes.add(part.sha256)
    assert.ok(part.mirrors.length >= 1 && part.mirrors.length <= 8, 'Every actual downloadable part needs alternate routes')
    assert.equal(new Set([part.url, ...part.mirrors]).size, 1 + part.mirrors.length)
    for (const source of [part.url, ...part.mirrors]) httpsSource(source)
  }
  return metadata
}

test('optional downloads pin independent Chinese models, reference audio and platform runtimes', () => {
  assert.equal(catalog.schema, 2)
  assert.deepEqual(catalog.models.map(model => model.id), expectedModels)
  assert.deepEqual(catalog.models.flatMap(model => model.voices.map(voice => voice.id)), expectedVoices)
  const voiceIds = new Set(bundled.voices.map(voice => voice.id))
  for (const pack of catalog.models) {
    assert.equal(pack.modelSize, pack.files.reduce((sum, file) => sum + file.size, 0))
    assert.equal(pack.downloadSize, pack.files.filter(file => !file.embedded).reduce((sum, file) => sum + file.size, 0))
    const files = new Set()
    for (const file of pack.files) {
      assert.ok(!files.has(file.path))
      files.add(file.path)
      safeRelative(file.path)
      httpsSource(file.url)
      assert.ok(Number.isSafeInteger(file.size) && file.size > 0)
      assert.match(file.sha256, /^[a-f0-9]{64}$/)
      for (const mirror of file.mirrors || []) httpsSource(mirror)
      if (file.embedded) {
        safeRelative(file.embedded)
        const bytes = read(`scripts/optional-speech-assets/${file.embedded}`)
        assert.equal(bytes.length, file.size)
        assert.equal(digest(bytes), file.sha256)
      }
    }
    assert.equal(pack.voices.length, 2)
    assert.deepEqual(pack.voices.map(voice => voice.gender), ['female', 'male'], 'both voices share one model download')
    for (const voice of pack.voices) {
      assert.ok(!voiceIds.has(voice.id), 'Optional voices cannot override a bundled voice')
      voiceIds.add(voice.id)
      assert.equal(voice.language, 'zh-CN')
    }
    assert.equal(pack.model.sampleRate, 24000)
    if (pack.model.kind === 'zipvoice') {
      for (const path of [pack.model.encoder, pack.model.decoder, pack.model.tokens, pack.model.vocoder, pack.model.referenceAudio, pack.model.referenceText, ...pack.model.lexicons]) assert.ok(files.has(path), `Missing resource ${path}`)
      assert.equal(pack.model.dataDir, '@bundled/model/espeak-ng-data')
      assert.equal(pack.license, 'CC-BY-NC')
      assert.equal(pack.runtimeId, undefined)
    } else {
      assert.ok(files.has(pack.model.config))
      assert.equal(pack.runtimeId, 'python-cpu-v1')
      assert.equal(pack.license, pack.model.kind === 'f5' ? 'CC-BY-NC-4.0' : 'Apache-2.0')
    }
  }
  const runtime = catalog.runtimes.find(runtime => runtime.id === 'python-cpu-v1')
  assert.ok(runtime, 'Downloadable models require a real platform runtime inventory')
  for (const target of ['macos-arm64', 'macos-x64', 'windows-x64']) {
    const platform = runtime.platforms[target]
    assert.ok(platform, `Missing ${target} runtime package`)
    httpsSource(platform.url)
    assert.ok(platform.mirrors?.length, `Missing verified alternate sources for ${target}`)
    for (const mirror of platform.mirrors) httpsSource(mirror)
    assert.ok(Number.isSafeInteger(platform.size) && platform.size > 0)
    assert.ok(Number.isSafeInteger(platform.unpackedSize) && platform.unpackedSize >= platform.size)
    assert.match(platform.sha256, /^[a-f0-9]{64}$/)
    assert.match(platform.manifestSha256, /^[a-f0-9]{64}$/)
    safeRelative(platform.executable); safeRelative(platform.script)
  }
})

test('model downloads retain independent domestic sources and fallback addresses', () => {
  let independentFiles = 0
  for (const file of catalog.models.flatMap(model => model.files).filter(file => !file.embedded)) {
    assert.ok(file.mirrors?.length >= 2, `Missing alternate sources for ${file.path}`)
    const sources = [file.url, ...file.mirrors]
    assert.equal(new Set(sources).size, sources.length)
    for (const source of sources) httpsSource(source)
    if (new URL(file.url).hostname === 'modelscope.cn') {
      independentFiles += 1
      assert.ok(file.mirrors.some(source => new URL(source).hostname === 'huggingface.co'))
      assert.ok(file.mirrors.some(source => new URL(source).hostname === 'hf-mirror.com'))
    } else {
      assert.equal(file.path, 'vocos_24khz.onnx')
      assert.equal(new URL(file.url).hostname, 'github.com')
    }
  }
  assert.equal(independentFiles, 18)
})

test('accelerated downloads preserve every reviewed ordinary runtime and both model fallback bindings', () => {
  const metadata = JSON.parse(read('test/optional-speech-runtime/runtime-metadata.json'))
  const runtime = catalog.runtimes.find(item => item.id === 'python-cpu-v1')
  assert.ok(runtime)
  assert.equal(runtime.version, 1)
  assert.deepEqual(Object.keys(runtime.platforms).sort(), ['macos-arm64', 'macos-x64', 'windows-x64'])
  for (const record of metadata) {
    assert.equal(record.id, 'python-cpu-v1')
    assert.equal(record.validated, true)
    assert.deepEqual(runtime.platforms[record.platform], archiveFromMetadata(record), 'Acceleration must not replace or change the already published ordinary runtime')
  }
  for (const model of catalog.models.filter(item => item.model.kind !== 'zipvoice')) {
    assert.equal(model.runtimeId, 'python-cpu-v1', `${model.id} retains its ordinary fallback runtime`)
    assert.equal(model.acceleratedRuntimeId, 'python-cuda-v1', `${model.id} shares the reviewed accelerated Python runtime`)
  }
  const nativeModel = catalog.models.find(item => item.model.kind === 'zipvoice')
  assert.equal(nativeModel.runtimeId, undefined, 'The native model keeps the bundled ordinary runtime')
  assert.equal(nativeModel.acceleratedRuntimeId, undefined, 'The native model must not be routed into the Python runtime')
  assert.deepEqual(catalog.runtimes.map(item => item.id).sort(), ['native-cuda-v1', 'python-cpu-v1', 'python-cuda-v1'])
})

test('native acceleration catalogue pins the published parts and all three verified native voices', () => {
  const metadata = verifiedAcceleratedRuntime('native-cuda-v1', 'speech-native-cuda-v1', 'open-media')
  assert.equal(catalog.nativeAccelerationRuntimeId, metadata.id)
  assert.equal(metadata.kind, 'native')
  assert.deepEqual([...metadata.validatedModels].sort(), ['matcha-icefall-zh-en', 'zipvoice-distill-fp32'])
  const voices = ['matcha_zh_en_female', 'zipvoice_zh_female', 'zipvoice_zh_male']
  assert.deepEqual([...metadata.validatedVoices].sort(), [...voices].sort())
  assert.equal(metadata.validation.status, 'passed')
  assert.deepEqual(metadata.validation.voices.map(item => item.voiceId).sort(), [...voices].sort())
  for (const voice of metadata.validation.voices) {
    assert.ok(Number.isFinite(voice.rms) && voice.rms > 0.00001)
    assert.ok(voice.sampleCount > 0)
    assert.equal(voice.sampleRate, voice.voiceId === 'matcha_zh_en_female' ? 16000 : 24000)
    assert.match(voice.sha256, /^[a-f0-9]{64}$/)
    assert.equal(voice.attempts.at(-1).exitCode, 0)
    assert.equal(voice.attempts.at(-1).backend, voice.actualDevice)
    if (voice.actualDevice === 'cpu') assert.equal(voice.gpuInferenceVerified, false, 'A successful fallback must never be labelled GPU verification')
  }
})

test('Python acceleration catalogue pins the published parts and all four production voice checks', () => {
  const metadata = verifiedAcceleratedRuntime('python-cuda-v1', 'speech-runtime-cuda-v1', 'speech-runtime')
  assert.deepEqual([...metadata.validatedModels].sort(), ['f5-v1-base-fp32', 'qwen3-tts-1.7b-serena'])
  assert.equal(metadata.productionValidated, true)
  assert.deepEqual([...metadata.productionVoiceIds].sort(), ['f5_zh_female', 'f5_zh_male', 'qwen3_serena', 'qwen3_uncle_fu'])
  assert.match(metadata.applicationValidationSha256, /^[a-f0-9]{64}$/)
  assert.equal(typeof metadata.gpuInferenceValidated, 'boolean')
  assert.equal(typeof metadata.cudaProbe.cudaAvailable, 'boolean')
  if (!metadata.cudaProbe.cudaAvailable) assert.equal(metadata.gpuInferenceValidated, false, 'An unavailable accelerator cannot count as tested GPU inference')
  const evidenceBytes = read('test/optional-speech-runtime/python-cuda-v1-application-validation.json')
  assert.equal(digest(evidenceBytes), metadata.applicationValidationSha256, 'The public production evidence must remain byte-for-byte identical')
  const evidence = JSON.parse(evidenceBytes)
  assert.equal(evidence.schema, 1)
  assert.equal(evidence.sourceCommit, metadata.sourceCommit)
  assert.equal(evidence.platform, 'windows-x64')
  assert.equal(evidence.status, 'passed')
  assert.equal(evidence.requestedDevice, 'auto')
  assert.deepEqual(evidence.hardware, metadata.cudaProbe)
  assert.deepEqual(evidence.voices.map(voice => voice.voiceId), metadata.productionVoiceIds)
  const audioHashes = new Set()
  for (const voice of evidence.voices) {
    assert.equal(voice.status, 'passed')
    assert.equal(voice.completionVerified, true)
    assert.equal(voice.productionPath, 'SpeechRuntime::command + generate_wave')
    assert.equal(voice.requestedDevice, 'auto')
    assert.ok(['cpu', 'cuda'].includes(voice.backend))
    assert.equal(voice.gpuInferenceVerified, voice.backend === 'cuda')
    assert.ok(voice.events.length > 0 && voice.events.every(event => typeof event === 'string'))
    const lastDevice = voice.events.filter(event => event.startsWith('stage=device,')).at(-1)
    assert.equal(/(?:^|,)device=([^,\r\n]+)/.exec(lastDevice ?? '')?.[1], voice.backend)
    assert.match(voice.events.at(-1), /^stage=complete(?:,|$)/)
    assert.deepEqual(voice.fallback, voice.events.filter(event => event.startsWith('stage=fallback,')))
    assert.deepEqual(voice.partial, voice.events.filter(event => event.includes('partial=')))
    if (voice.voiceId.startsWith('qwen3_')) assert.equal(voice.eosVerified, true)
    if (voice.backend === 'cuda') {
      assert.equal(metadata.cudaProbe.cudaAvailable, true)
      assert.ok(metadata.cudaProbe.cudaDeviceCount >= 1)
    }
    const audio = voice.audio
    assert.equal(audio.finite, true)
    assert.equal(audio.sampleRate, 24000)
    assert.equal(audio.channels, 1)
    assert.ok(Number.isSafeInteger(audio.bytes) && audio.bytes > 44)
    assert.match(audio.sha256, /^[a-f0-9]{64}$/)
    assert.ok(!audioHashes.has(audio.sha256), 'Each production voice must have its own generated waveform')
    audioHashes.add(audio.sha256)
    assert.ok(Number.isFinite(audio.durationSeconds) && audio.durationSeconds >= 0.25 && audio.durationSeconds <= 120)
    assert.ok(Number.isFinite(audio.peak) && audio.peak > 0.001)
    assert.ok(Number.isFinite(audio.rms) && audio.rms > 0.00001 && audio.rms <= audio.peak)
  }
  const allCuda = evidence.voices.every(voice => voice.backend === 'cuda')
  assert.equal(evidence.gpuInferenceVerified, allCuda)
  assert.equal(metadata.gpuInferenceValidated, allCuda)
})

test('optional model publisher notices retain exact originals with distinct model and code licenses', () => {
  const base = 'licenses/application/optional-speech'
  const inventory = JSON.parse(read(`${base}/manifest.json`))
  assert.equal(inventory.schema, 2)
  assert.deepEqual(inventory.models.map(model => model.modelId), expectedModels)
  assert.deepEqual(inventory.models.map(model => model.weightLicense), ['CC-BY-NC', 'CC-BY-NC-4.0', 'Apache-2.0'])
  assert.deepEqual(inventory.models.map(model => model.implementationLicense), ['Apache-2.0', 'MIT', 'Apache-2.0'])
  for (const model of inventory.models) {
    assert.ok(model.files.length >= 2)
    for (const file of model.files) {
      safeRelative(file.path)
      const bytes = read(`${base}/${file.path}`)
      assert.equal(bytes.length, file.bytes)
      assert.equal(digest(bytes), file.sha256)
      assert.deepEqual(bytes, read(file.copiedFrom), 'Publisher text must remain byte-for-byte identical')
      if (file.source) httpsSource(file.source)
    }
  }
  for (const component of inventory.applicationComponents) {
    for (const file of component.files) {
      const bytes = read(`${base}/${file.path}`)
      assert.equal(bytes.length, file.bytes)
      assert.equal(digest(bytes), file.sha256)
    }
  }
  const normalizer = JSON.parse(read(`${base}/cn2an/fixture-source.json`))
  assert.equal(normalizer.version, '0.5.23')
  assert.equal(normalizer.fixtures, 1538)
  assert.equal(digest(read('tests/fixtures/speech-chinese-normalizer.tsv')), normalizer.sha256)
  assert.deepEqual(read(`${base}/cn2an/LICENSE`), read('licenses/speech-models/cn2an-LICENSE'))
  const old = JSON.parse(read(`${base}/${inventory.historicalNotices[0].manifest}`))
  assert.equal(old.modelId, 'multivoice-zh-en-v1')
  assert.ok(!inventory.models.some(model => model.modelId === old.modelId))
  for (const file of old.files) assert.equal(digest(read(`${base}/legacy-multivoice/${file.path}`)), file.sha256)
})
