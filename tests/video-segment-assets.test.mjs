import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { VIDEO_SEGMENT_PRESETS as ALL_VIDEO_SEGMENT_PRESETS } from '../src/core/video-segment-presets.ts'

const VIDEO_SEGMENT_PRESETS = ALL_VIDEO_SEGMENT_PRESETS.filter(item => !item.collection)

const directory = new URL('../src/assets/video-segments/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'))
const available = command => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0

test('十种原创动态片头片尾全部本地提供，大小与校验一致，五种片头与五种片尾', () => {
  assert.equal(VIDEO_SEGMENT_PRESETS.length, 10)
  assert.equal(VIDEO_SEGMENT_PRESETS.filter(item => item.placement === 'prepend').length, 5)
  assert.equal(VIDEO_SEGMENT_PRESETS.filter(item => item.placement === 'append').length, 5)
  assert.equal(manifest.items.length, 10)
  for (const key of ['id', 'style', 'heading']) assert.equal(new Set(VIDEO_SEGMENT_PRESETS.map(item => item[key])).size, 10)
  assert.equal(new Set(manifest.items.map(item => item.sha256)).size, 10)
  assert.ok(manifest.items.reduce((sum, item) => sum + item.size, 0) < 5_000_000)
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.webm')).sort(), manifest.items.map(item => item.filename).sort())
  for (const item of manifest.items) {
    assert.ok(VIDEO_SEGMENT_PRESETS.find(preset => preset.id === item.id))
    const bytes = readFileSync(new URL(item.filename, directory))
    assert.equal(bytes.length, item.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256)
    assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3')
    assert.ok(readFileSync(new URL(item.poster, directory)).length > 1000)
  }
  assert.equal(manifest.author, 'Open Media'); assert.equal(manifest.license, 'MIT')
})

test('实际解码十种 WebM：5 秒、120 帧、兼容像素格式，前中后画面确实变化', { skip: !available('ffmpeg') || !available('ffprobe') }, () => {
  for (const item of manifest.items) {
    const path = fileURLToPath(new URL(item.filename, directory))
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-count_frames', '-show_format', '-of', 'json', path], { encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)
    const info = JSON.parse(probe.stdout)
    assert.equal(info.streams.length, 1)
    const stream = info.streams[0]
    assert.equal(stream.codec_name, 'vp9'); assert.equal(stream.pix_fmt, 'yuv420p')
    assert.equal(stream.width, 1280); assert.equal(stream.height, 720); assert.equal(stream.nb_read_frames, '120')
    assert.equal(Number(info.format.duration), 5)
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', "select='eq(n,0)+eq(n,60)+eq(n,119)'", '-vsync', '0', '-f', 'framemd5', 'pipe:1'], { encoding: 'utf8' })
    assert.equal(decode.status, 0, decode.stderr)
    const frameHashes = decode.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim())
    assert.equal(frameHashes.length, 3)
    assert.equal(new Set(frameHashes).size, 3, `${item.id} must contain genuine animation`)
  }
})
