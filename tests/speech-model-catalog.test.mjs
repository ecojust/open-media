import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const catalog = JSON.parse(read('src-tauri/resources/speech-models.json'))
const bundled = JSON.parse(read('scripts/speech-runtime.lock.json'))
const expectedModels = ['zipvoice-distill-fp32', 'f5-v1-base-fp32', 'qwen3-tts-1.7b-serena']
const expectedVoices = ['zipvoice_zh_female', 'f5_zh_female', 'qwen3_serena']
const safeRelative = path => assert.doesNotMatch(path, /(^\/|[\\,:]|(^|\/)\.\.(\/|$))/)
const httpsSource = source => {
  const url = new URL(source)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.username, '')
  assert.equal(url.password, '')
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
    assert.equal(pack.voices.length, 1)
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
