import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { VOICE_GROUPS } from '../src/core/voice-groups.ts'
import { VOICE_PROFILE_SOURCE } from '../src/core/voice-profiles.ts'

const assets = new URL('../src/assets/voice-previews/', import.meta.url)
const lock = JSON.parse(readFileSync(new URL('../scripts/speech-runtime.lock.json', import.meta.url), 'utf8'))
const digest = content => createHash('sha256').update(content).digest('hex')

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
  assert.deepEqual(readdirSync(assets).filter(file => file.endsWith('.mp3')).sort(), [...manifest.previews, ...optional.previews].map(preview => preview.file).sort())
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

test('optional voices have distinct local auditions from their pinned model and speaker IDs', () => {
  const catalog = JSON.parse(readFileSync(new URL('../src-tauri/resources/speech-models.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(readFileSync(new URL('optional-manifest.json', assets), 'utf8'))
  const model = catalog.models.find(model => model.id === manifest.model.id)
  assert.ok(model)
  assert.equal(manifest.model.version, model.version)
  assert.equal(manifest.model.sha256, model.files.find(file => file.path === model.model.file).sha256)
  assert.equal(manifest.model.voicesSha256, model.files.find(file => file.path === model.model.voices).sha256)
  assert.equal(manifest.engine.version, lock.engine.version)
  assert.equal(manifest.settings.sampleRate, model.model.sampleRate)
  assert.equal(manifest.settings.silenceScale, 1)
  assert.equal(manifest.settings.speed, 1)
  assert.deepEqual(manifest.texts, JSON.parse(readFileSync(new URL('manifest.json', assets), 'utf8')).texts)
  assert.deepEqual(manifest.previews.map(preview => preview.voiceId).sort(), model.voices.map(voice => voice.id).sort())
  assert.equal(new Set(manifest.previews.map(preview => preview.sha256)).size, model.voices.length)
  for (const preview of manifest.previews) {
    const voice = model.voices.find(voice => voice.id === preview.voiceId)
    assert.equal(preview.speakerId, voice.speakerId)
    assert.equal(preview.language, voice.language)
    const bytes = readFileSync(new URL(preview.file, assets))
    assert.equal(bytes.length, preview.bytes)
    assert.equal(digest(bytes), preview.sha256)
    assert.ok(preview.peak > 0.01 && preview.decodedPeak > 0.01)
    assert.ok(Math.abs(preview.durationSeconds - preview.decodedDurationSeconds) <= 576 / model.model.sampleRate)
  }
  assert.ok(manifest.previews.reduce((total, item) => total + item.bytes, 0) < 300000)
})
