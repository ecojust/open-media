import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import ts from 'typescript'
import { renderTransitionSound, SAMPLE_RATE, SOUND_DEFINITIONS } from '../scripts/generate-transition-sounds.mjs'

const root = new URL('../src/assets/transition-sounds/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'))
const source = readFileSync(new URL('../src/core/transition-sound-catalog.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const output = {}
new Function('exports', 'require', compiled)(output, name => ({ default: name }))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('十段原创本地音效的目录、重音位置与清单一致，总体积小于 1 MB', () => {
  assert.equal(manifest.sounds.length, 10)
  assert.equal(output.TRANSITION_SOUNDS.length, 10)
  assert.equal(manifest.license, 'MIT')
  assert.match(manifest.provenance, /原创确定性合成/)
  assert.match(manifest.provenance, /无外部录音或采样/)
  for (const key of ['id', 'title', 'filename', 'sha256']) assert.equal(new Set(manifest.sounds.map(item => item[key])).size, 10)
  assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.wav')).sort(), manifest.sounds.map(item => item.filename).sort())
  assert.ok(manifest.sounds.reduce((sum, item) => sum + item.bytes, 0) < 1_000_000)
  for (const item of output.TRANSITION_SOUNDS) {
    const recorded = manifest.sounds.find(sound => sound.id === item.id)
    assert.ok(recorded)
    for (const key of ['title', 'description', 'duration', 'anchor', 'filename']) assert.equal(item[key], recorded[key])
    assert.equal(item.url, `../assets/transition-sounds/${item.filename}?url`)
    assert.ok(item.anchor >= 0 && item.anchor < item.duration)
    assert.ok(item.duration > 0.2 && item.duration <= 1.5)
  }
})

test('每段音效含真实、非静音、无削波的 PCM 音频，实际时长符合目录', () => {
  for (const item of manifest.sounds) {
    const bytes = readFileSync(new URL(item.filename, root))
    assert.equal(bytes.length, item.bytes)
    assert.equal(hash(bytes), item.sha256)
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
    assert.equal(bytes.toString('ascii', 8, 16), 'WAVEfmt ')
    assert.equal(bytes.readUInt16LE(20), 1)
    assert.equal(bytes.readUInt16LE(22), 1)
    assert.equal(bytes.readUInt32LE(24), SAMPLE_RATE)
    assert.equal(bytes.readUInt16LE(34), 16)
    assert.equal(bytes.readUInt32LE(40), bytes.length - 44)
    assert.equal((bytes.length - 44) / 2 / SAMPLE_RATE, item.duration)
    let peak = 0, energy = 0, audible = 0
    for (let index = 44; index < bytes.length; index += 2) {
      const value = bytes.readInt16LE(index) / 32768
      peak = Math.max(peak, Math.abs(value))
      energy += value * value
      if (Math.abs(value) > 0.01) audible++
    }
    const samples = (bytes.length - 44) / 2
    assert.ok(peak > 0.7 && peak < 0.8, `${item.title} 应留有混音余量`)
    assert.ok(Math.sqrt(energy / samples) > 0.025, `${item.title} 不应为静音`)
    assert.ok(audible > samples * 0.12, `${item.title} 应包含完整声音`)
    assert.equal(bytes.readInt16LE(44), 0)
    assert.equal(bytes.readInt16LE(bytes.length - 2), 0)
  }
})

test('生成器可在内存中逐字节重现全部原创音效', () => {
  for (const definition of SOUND_DEFINITIONS) {
    const item = manifest.sounds.find(sound => sound.id === definition.id)
    assert.equal(hash(renderTransitionSound(definition)), item.sha256)
  }
})
