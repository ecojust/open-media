import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { VOICE_GROUPS } from '../src/core/voice-groups.ts'
import { VOICE_PROFILE_SOURCE } from '../src/core/voice-profiles.ts'

const assets = new URL('../src/assets/voice-previews/', import.meta.url)
const lock = JSON.parse(readFileSync(new URL('../scripts/speech-runtime.lock.json', import.meta.url), 'utf8'))
const digest = content => createHash('sha256').update(content).digest('hex')

test('all fixed and fallback auditions use the first Chinese comparison text', () => {
  const corpus = JSON.parse(readFileSync(new URL('../test/chinese-tts-benchmark/corpus.json', import.meta.url), 'utf8'))
  const text = corpus.find(sample => sample.id === '01').text
  const bundled = JSON.parse(readFileSync(new URL('manifest.json', assets), 'utf8'))
  const optional = JSON.parse(readFileSync(new URL('optional-manifest.json', assets), 'utf8'))
  const male = JSON.parse(readFileSync(new URL('male-manifest.json', assets), 'utf8'))
  assert.deepEqual(Object.values(bundled.texts), [text, text])
  assert.equal(optional.text, text)
  assert.equal(male.text, text)
  assert.ok(male.previews.every(preview => preview.text === text))
  assert.ok(optional.previews.every(preview => preview.text === text && preview.source.sampleId === '01'))
  const client = readFileSync(new URL('../src/core/voice-previews.ts', import.meta.url), 'utf8')
  const fallbackTexts = [...client.matchAll(/\b(?:zh|en): '([^']+)'/g)].map(match => match[1])
  assert.deepEqual(fallbackTexts, [text, text], 'missing local files must not change the audition text')
})

test('every representative has its own verified local sample matching the locked voice and synthesis settings', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', assets), 'utf8'))
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.model.id, lock.model.id)
  assert.equal(manifest.model.version, lock.model.version)
  assert.equal(manifest.engine.version, lock.engine.version)
  assert.equal(manifest.settings.speed, 1)
  assert.equal(manifest.settings.silenceScale, 0.2)
  assert.equal(manifest.settings.sampleRate, 16000)
  assert.equal(manifest.settings.noiseScale, 1)
  assert.equal(manifest.model.sha256, VOICE_PROFILE_SOURCE.modelSha256)
  assert.equal(manifest.model.vocoderSha256, VOICE_PROFILE_SOURCE.vocoderSha256)
  assert.equal(manifest.previews.length, 1)
  assert.equal(manifest.settings.channels, 1)
  assert.equal(manifest.settings.bitrate, 64000)
  assert.deepEqual(manifest.previews.map(preview => preview.voiceId).sort(), VOICE_GROUPS.map(group => group.representative).sort())
  const optional = JSON.parse(readFileSync(new URL('optional-manifest.json', assets), 'utf8'))
  const male = JSON.parse(readFileSync(new URL('male-manifest.json', assets), 'utf8'))
  assert.deepEqual(readdirSync(assets).filter(file => file.endsWith('.mp3')).sort(), [...manifest.previews, ...optional.previews, ...male.previews].map(preview => preview.file).sort())
  assert.equal(new Set(manifest.previews.map(preview => preview.sha256)).size, manifest.previews.length, 'different voices must not point to duplicate recordings')
  for (const preview of manifest.previews) {
    const voice = lock.voices.find(voice => voice.id === preview.voiceId)
    assert.ok(voice)
    assert.equal(preview.speakerId, voice.speakerId)
    assert.equal(preview.language, voice.language)
    assert.equal(preview.file, `${voice.id}.mp3`)
    const content = readFileSync(new URL(preview.file, assets))
    assert.equal(content.length, preview.bytes)
    assert.equal(digest(content), preview.sha256)
    assert.ok(preview.durationSeconds > 1 && preview.durationSeconds < 40)
    assert.ok(preview.peak > 0.01 && preview.decodedPeak > 0.01, 'speech recordings must contain audible audio')
    assert.match(preview.wavSha256, /^[a-f0-9]{64}$/)
  }
  assert.ok(manifest.previews.reduce((total, preview) => total + preview.bytes, 0) < 3 * 1024 * 1024, 'fixed samples must keep the offline package lightweight')
  for (const [field, path] of [
    ['scriptSha256', '../scripts/generate-voice-previews.py'],
    ['voiceGroupsSha256', '../src/core/voice-groups.ts'],
  ]) assert.equal(manifest.generator[field], digest(readFileSync(new URL(path, import.meta.url))), `${field} must describe the source used to generate bundled recordings`)
})

test('optional auditions use the three exact Chinese benchmark voices without resynthesis', () => {
  const manifest = JSON.parse(readFileSync(new URL('optional-manifest.json', assets), 'utf8'))
  const benchmark = JSON.parse(readFileSync(new URL('../test/chinese-tts-benchmark/manifest.json', import.meta.url), 'utf8'))
  assert.equal(manifest.schema, 2)
  assert.equal(manifest.text, '这是一款全程由AI接管并生成的软件')
  assert.deepEqual(manifest.previews.map(preview => preview.voiceId), ['zipvoice_zh_female', 'f5_zh_female', 'qwen3_serena'])
  assert.equal(new Set(manifest.previews.map(preview => preview.sha256)).size, 3)
  for (const preview of manifest.previews) {
    const model = benchmark.models.find(model => model.id === preview.source.benchmarkModelId)
    assert.ok(model)
    const original = model.samples.find(sample => sample.id === preview.source.sampleId)
    const sourceBytes = readFileSync(new URL(`../${preview.source.mp3}`, import.meta.url))
    const bytes = readFileSync(new URL(preview.file, assets))
    assert.deepEqual(bytes, sourceBytes, 'card auditions must remain the exact audio the user compared')
    assert.equal(preview.file, `${preview.voiceId}.mp3`)
    assert.equal(preview.language, 'zh-CN')
    assert.equal(bytes.length, preview.bytes)
    assert.equal(digest(bytes), preview.sha256)
    assert.equal(preview.sha256, original.mp3_sha256)
    assert.equal(preview.wavSha256, original.wav_sha256)
    assert.equal(preview.text, manifest.text)
    assert.equal(preview.text, original.text)
    assert.equal(preview.sampleRate, original.sample_rate)
    assert.equal(preview.channels, original.channels)
    assert.deepEqual(preview.settings, model.settings)
    assert.deepEqual(preview.referenceAudio, model.reference_audio)
    assert.deepEqual(preview.license, model.license)
    assert.ok(preview.peak > 0.01 && preview.decodedPeak > 0.01)
    assert.ok(Math.abs(preview.durationSeconds - preview.decodedDurationSeconds) <= 1 / preview.sampleRate)
    assert.ok(preview.licenseFiles.length > 0)
    for (const license of preview.licenseFiles) assert.equal(digest(readFileSync(new URL(license.path, assets))), license.sha256)
  }
  assert.ok(manifest.previews.reduce((total, item) => total + item.bytes, 0) < 300000)
})

test('male auditions are distinct real model outputs using the same comparison sentence', () => {
  const manifest = JSON.parse(readFileSync(new URL('male-manifest.json', assets), 'utf8'))
  const catalog = JSON.parse(readFileSync(new URL('../src-tauri/resources/speech-models.json', import.meta.url), 'utf8'))
  assert.equal(manifest.schema, 1)
  assert.deepEqual(manifest.previews.map(preview => preview.voiceId).sort(), ['f5_zh_male', 'qwen3_uncle_fu', 'zipvoice_zh_male'])
  const female = JSON.parse(readFileSync(new URL('optional-manifest.json', assets), 'utf8'))
  const all = [...manifest.previews, ...female.previews]
  assert.equal(new Set(all.map(preview => preview.sha256)).size, all.length, 'male recordings cannot reuse a female sample or another model sample')
  for (const preview of manifest.previews) {
    const model = catalog.models.find(model => model.id === preview.modelId)
    assert.equal(model?.voices.find(voice => voice.id === preview.voiceId)?.gender, 'male')
    assert.equal(preview.text, manifest.text)
    assert.equal(preview.file, `${preview.voiceId}.mp3`)
    const bytes = readFileSync(new URL(preview.file, assets))
    assert.equal(bytes.length, preview.bytes)
    assert.equal(digest(bytes), preview.sha256)
    assert.match(preview.wavSha256, /^[a-f0-9]{64}$/)
    assert.equal(preview.sampleRate, 24000)
    assert.equal(preview.channels, 1)
    assert.ok(preview.durationSeconds > 1 && preview.durationSeconds < 40)
    assert.ok(Math.abs(preview.durationSeconds - preview.decodedDurationSeconds) <= 1 / preview.sampleRate)
    assert.ok(preview.peak > 0.01 && preview.decodedPeak > 0.01)
  }
  const reference = JSON.parse(readFileSync(new URL('../scripts/optional-speech-assets/male-reference.json', import.meta.url), 'utf8'))
  for (const generator of [manifest.generator, reference.generator, ...manifest.previews.map(preview => preview.generator)]) {
    for (const [pathKey, hashKey] of [['script', 'scriptSha256'], ['adapter', 'adapterSha256']]) {
      assert.match(generator[pathKey], /^(?:src\/assets\/voice-previews\/provenance\/male-20261018\/|scripts\/)[a-z-]+\.py$/)
      assert.equal(generator[hashKey], digest(readFileSync(new URL(`../${generator[pathKey]}`, import.meta.url))), 'historical recordings must retain their actual generating code')
    }
    if (generator.deviceRuntime) {
      assert.equal(generator.deviceRuntime, 'scripts/speech-device-runtime.py')
      assert.equal(generator.deviceRuntimeSha256, digest(readFileSync(new URL(`../${generator.deviceRuntime}`, import.meta.url))))
    }
  }
})
