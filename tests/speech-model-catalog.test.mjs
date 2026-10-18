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
// Pin the shipped catalogue independently of the removed research archive.
// These checks protect download identities; they do not claim model execution.
const publishedArchives = {
  'python-cpu-v1': {
    'macos-arm64': '56486d0dcc2d7193df6e869bd1a0dfb97e0ae582779630b9b180723764d3c10b',
    'macos-x64': '9bee9c08138da6646fb57f3babeca077d0f0ce694021efe9b4e7d23800772e7f',
    'windows-x64': 'a7a262995383a5357c9b4720e4709dd5d9b10d484c1af256512fb593d62049f2',
  },
  'python-cuda-v1': { 'windows-x64': 'e6f17f57481a500fa2c591b65edb8cf4b78d4fe8ad17e42402d686598408e58b' },
  'native-cuda-v1': { 'windows-x64': '8f7dcdaa183afcbcfef9f07cfce8c7a9e06fb0601bac7f3d90d4a490a976f2af' },
}
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const verifyArchiveIdentity = (id, platform, archive) => assert.equal(
  digest(Buffer.from(JSON.stringify(stable(archive)))), publishedArchives[id]?.[platform],
  'Published package hashes, entry points, download routes and every part must retain their pinned identity',
)

function pinnedAcceleratedRuntime(id, releaseTag, prefix) {
  const runtime = catalog.runtimes.find(item => item.id === id)
  assert.ok(runtime, `Final catalogue must include the pinned ${id} runtime`)
  assert.equal(runtime.version, 1)
  assert.deepEqual(Object.keys(runtime.platforms), ['windows-x64'], 'Do not advertise an accelerated package for a platform without a published archive')
  const archive = runtime.platforms['windows-x64']
  verifyArchiveIdentity(id, 'windows-x64', archive)
  const filename = `${prefix}-${id}-windows-x64.zip`
  const release = `https://github.com/ecojust/open-media/releases/download/${releaseTag}/`
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
  return archive
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

test('accelerated downloads preserve every published ordinary runtime and both model fallback bindings', () => {
  const runtime = catalog.runtimes.find(item => item.id === 'python-cpu-v1')
  assert.ok(runtime)
  assert.equal(runtime.version, 1)
  assert.deepEqual(Object.keys(runtime.platforms).sort(), ['macos-arm64', 'macos-x64', 'windows-x64'])
  for (const [platform, archive] of Object.entries(runtime.platforms)) verifyArchiveIdentity(runtime.id, platform, archive)
  for (const model of catalog.models.filter(item => item.model.kind !== 'zipvoice')) {
    assert.equal(model.runtimeId, 'python-cpu-v1', `${model.id} retains its ordinary fallback runtime`)
    assert.equal(model.acceleratedRuntimeId, 'python-cuda-v1', `${model.id} shares the reviewed accelerated Python runtime`)
  }
  const nativeModel = catalog.models.find(item => item.model.kind === 'zipvoice')
  assert.equal(nativeModel.runtimeId, undefined, 'The native model keeps the bundled ordinary runtime')
  assert.equal(nativeModel.acceleratedRuntimeId, undefined, 'The native model must not be routed into the Python runtime')
  assert.deepEqual(catalog.runtimes.map(item => item.id).sort(), ['native-cuda-v1', 'python-cpu-v1', 'python-cuda-v1'])
})

test('native acceleration catalogue pins its published parts and native entry point', () => {
  const archive = pinnedAcceleratedRuntime('native-cuda-v1', 'speech-native-cuda-v1', 'open-media')
  assert.equal(catalog.nativeAccelerationRuntimeId, 'native-cuda-v1')
  assert.equal(archive.kind, 'native')
  assert.equal(archive.executable, 'bin/open-media-speech.exe')
  assert.equal(archive.script, archive.executable)
})

test('Python acceleration catalogue pins its published parts and isolated interpreter entry points', () => {
  const archive = pinnedAcceleratedRuntime('python-cuda-v1', 'speech-runtime-cuda-v1', 'speech-runtime')
  assert.equal(archive.kind, undefined)
  assert.equal(archive.executable, 'python/python.exe')
  assert.equal(archive.script, 'runner/tts.py')
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
      assert.ok(file.copiedFrom, 'Preserve the historical copy origin even when the research archive is removed')
      safeRelative(file.copiedFrom)
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
