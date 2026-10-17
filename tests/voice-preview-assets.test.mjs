import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { VOICE_GROUPS } from '../src/core/voice-groups.ts'

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
  assert.equal(manifest.settings.silenceScale, 1)
  assert.equal(manifest.settings.sampleRate, 24000)
  assert.equal(manifest.settings.channels, 1)
  assert.equal(manifest.settings.bitrate, 64000)
  assert.deepEqual(manifest.previews.map(preview => preview.voiceId).sort(), VOICE_GROUPS.map(group => group.representative).sort())
  assert.deepEqual(readdirSync(assets).filter(file => file.endsWith('.mp3')).sort(), manifest.previews.map(preview => preview.file).sort())
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
    ['runnerSourceSha256', '../scripts/speech-runtime-runner.c'],
    ['voiceGroupsSha256', '../src/core/voice-groups.ts'],
  ]) assert.equal(manifest.generator[field], digest(readFileSync(new URL(path, import.meta.url))), `${field} must describe the source used to generate bundled recordings`)
})
