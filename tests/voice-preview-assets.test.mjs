import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { VOICE_GROUPS } from '../src/core/voice-groups.ts'
import { VOICE_PROFILE_SOURCE } from '../src/core/voice-profiles.ts'

const assets = new URL('../src/assets/voice-previews/', import.meta.url)
const lock = JSON.parse(readFileSync(new URL('../scripts/speech-runtime.lock.json', import.meta.url), 'utf8'))
const digest = content => createHash('sha256').update(content).digest('hex')

const PREVIEW_TEXT = '欢迎使用 Open Media。你可以录制屏幕、剪辑视频、编辑图片，还能生成配音，让创作更轻松。'

function verifyGenerator(generator) {
  for (const key of ['script', 'helper', 'adapter', 'deviceRuntime']) {
    if (!generator[key]) continue
    assert.ok(generator[key].startsWith('scripts/') || generator[key].startsWith('src/assets/voice-previews/provenance/'))
    assert.ok(!generator[key].split('/').includes('..'))
    assert.equal(generator[`${key}Sha256`], digest(readFileSync(new URL(`../${generator[key]}`, import.meta.url))), 'recordings must retain the code actually used for synthesis')
  }
}

test('all fixed and fallback auditions introduce Open Media using the same text', () => {
  const bundled = JSON.parse(readFileSync(new URL('manifest.json', assets), 'utf8'))
  const optional = JSON.parse(readFileSync(new URL('optional-manifest.json', assets), 'utf8'))
  const male = JSON.parse(readFileSync(new URL('male-manifest.json', assets), 'utf8'))
  assert.deepEqual(Object.values(bundled.texts), [PREVIEW_TEXT, PREVIEW_TEXT])
  for (const manifest of [optional, male]) {
    assert.equal(manifest.text, PREVIEW_TEXT)
    assert.ok(manifest.previews.every(preview => preview.text === PREVIEW_TEXT))
  }
  const client = readFileSync(new URL('../src/core/voice-previews.ts', import.meta.url), 'utf8')
  const fallbackTexts = [...client.matchAll(/\b(?:zh|en): '([^']+)'/g)].map(match => match[1])
  assert.deepEqual(fallbackTexts, [PREVIEW_TEXT, PREVIEW_TEXT], 'missing local files must not change the audition text')
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

test('optional auditions are newly synthesized introductions using the locked models and preserved licenses', () => {
  const manifest = JSON.parse(readFileSync(new URL('optional-manifest.json', assets), 'utf8'))
  const catalog = JSON.parse(readFileSync(new URL('../src-tauri/resources/speech-models.json', import.meta.url), 'utf8'))
  assert.equal(manifest.schema, 3)
  assert.equal(manifest.text, PREVIEW_TEXT)
  assert.deepEqual(manifest.previews.map(preview => preview.voiceId), ['zipvoice_zh_female', 'f5_zh_female', 'qwen3_serena'])
  assert.equal(new Set(manifest.previews.map(preview => preview.sha256)).size, 3)
  for (const preview of manifest.previews) {
    const model = catalog.models.find(model => model.id === preview.modelId)
    assert.equal(model?.voices.find(voice => voice.id === preview.voiceId)?.gender, 'female')
    assert.equal(preview.source.kind, 'actual-model-synthesis')
    assert.equal(preview.source.textId, 'open-media-introduction-20261018')
    assert.deepEqual(preview.modelFiles, model.files.map(file => ({ path: file.path, bytes: file.size, sha256: file.sha256 })))
    assert.equal(preview.file, `${preview.voiceId}.mp3`)
    assert.equal(preview.language, 'zh-CN')
    const bytes = readFileSync(new URL(preview.file, assets))
    assert.equal(bytes.length, preview.bytes)
    assert.equal(digest(bytes), preview.sha256)
    assert.match(preview.wavSha256, /^[a-f0-9]{64}$/)
    assert.equal(preview.text, PREVIEW_TEXT)
    assert.equal(preview.sampleRate, 24000)
    assert.equal(preview.channels, 1)
    assert.ok(preview.durationSeconds > 1 && preview.durationSeconds < 40)
    assert.ok(preview.generationSeconds > 0)
    assert.ok(preview.peak > 0.01 && preview.decodedPeak > 0.01)
    assert.ok(Math.abs(preview.durationSeconds - preview.decodedDurationSeconds) <= 1 / preview.sampleRate)
    assert.ok(preview.licenseFiles.length > 0)
    for (const license of preview.licenseFiles) assert.equal(digest(readFileSync(new URL(license.path, assets))), license.sha256)
    verifyGenerator(preview.generator)
  }
  assert.ok(manifest.previews.reduce((total, item) => total + item.bytes, 0) < 1024 * 1024)
})

test('male introductions use real distinct voices and keep their independent reference audio', () => {
  const manifest = JSON.parse(readFileSync(new URL('male-manifest.json', assets), 'utf8'))
  const catalog = JSON.parse(readFileSync(new URL('../src-tauri/resources/speech-models.json', import.meta.url), 'utf8'))
  assert.equal(manifest.schema, 3)
  assert.deepEqual(manifest.previews.map(preview => preview.voiceId).sort(), ['f5_zh_male', 'qwen3_uncle_fu', 'zipvoice_zh_male'])
  const female = JSON.parse(readFileSync(new URL('optional-manifest.json', assets), 'utf8'))
  const all = [...manifest.previews, ...female.previews]
  assert.equal(new Set(all.map(preview => preview.sha256)).size, all.length, 'male recordings cannot reuse a female sample or another model sample')
  const reference = JSON.parse(readFileSync(new URL('../scripts/optional-speech-assets/male-reference.json', import.meta.url), 'utf8'))
  assert.equal(reference.sha256, digest(readFileSync(new URL('../scripts/optional-speech-assets/male-reference.wav', import.meta.url))))
  assert.notEqual(reference.text, PREVIEW_TEXT, 'reference speech must remain independent of the new audition')
  verifyGenerator(reference.generator)
  for (const preview of manifest.previews) {
    const model = catalog.models.find(model => model.id === preview.modelId)
    assert.equal(model?.voices.find(voice => voice.id === preview.voiceId)?.gender, 'male')
    assert.equal(preview.text, PREVIEW_TEXT)
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
    if (preview.voiceId.startsWith('qwen3_')) assert.equal(preview.referenceAudio, null)
    else assert.equal(preview.referenceAudio.sha256, reference.sha256)
    verifyGenerator(preview.generator)
  }
})

test('previous auditions and their original provenance remain byte-for-byte archived', () => {
  const archive = new URL('provenance/pre-introduction-20261018/', assets)
  const index = JSON.parse(readFileSync(new URL('archive-index.json', archive), 'utf8'))
  assert.equal(index.schema, 1)
  assert.equal(index.files.filter(file => file.file.endsWith('.mp3')).length, 7)
  for (const file of index.files) {
    const bytes = readFileSync(new URL(file.file, archive))
    assert.equal(bytes.length, file.bytes)
    assert.equal(digest(bytes), file.sha256)
    if (file.file.endsWith('.mp3')) {
      assert.notEqual(digest(readFileSync(new URL(file.file, assets))), file.sha256,
        'every current audition must contain the new introduction rather than an archived recording')
    }
  }
  const old = JSON.parse(readFileSync(new URL('optional-manifest.json', archive), 'utf8'))
  assert.equal(old.text, '这是一款全程由AI接管并生成的软件')
  assert.notEqual(old.text, PREVIEW_TEXT)
  for (const preview of old.previews) assert.equal(digest(readFileSync(new URL(preview.file, archive))), preview.sha256)
})
