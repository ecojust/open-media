import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { VIDEO_SEGMENT_PRESETS } from '../src/core/video-segment-presets.ts'
import { createProject } from '../src/core/project.ts'
import { insertVideoSegment } from '../src/core/video-segment-track.ts'

const directory = new URL('../src/assets/science-segments/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'))
const presets = VIDEO_SEGMENT_PRESETS.filter(item => item.collection === 'science')
const available = command => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0

test('科普精选保留六款片头及六款片尾，原创媒体独立校验并且标题可编辑', () => {
  assert.equal(presets.length, 12)
  assert.equal(presets.filter(item => item.placement === 'prepend').length, 6)
  assert.equal(presets.filter(item => item.placement === 'append').length, 6)
  assert.equal(VIDEO_SEGMENT_PRESETS.filter(item => item.collection !== 'general').length, 22)
  for (const key of ['id', 'style', 'heading']) assert.equal(new Set(presets.map(item => item[key])).size, 12)
  assert.equal(manifest.items.length, 12)
  assert.equal(new Set(manifest.items.map(item => item.sha256)).size, 12)
  assert.ok(manifest.items.reduce((sum, item) => sum + item.size, 0) < 12_000_000)
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.webm')).sort(), manifest.items.map(item => item.filename).sort())
  for (const item of manifest.items) {
    const preset = presets.find(entry => entry.id === item.id)
    assert.ok(preset)
    const bytes = readFileSync(new URL(item.filename, directory))
    assert.equal(bytes.length, item.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256)
    assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3')
    assert.ok(readFileSync(new URL(item.poster, directory)).length > 1000)
    const project = createProject()
    const asset = { id: item.id, name: preset.title, kind: 'video', url: `blob:${item.id}`, duration: item.duration, width: item.width, height: item.height, size: item.size, mime: 'video/webm' }
    const result = insertVideoSegment(project, asset, preset.placement, preset)
    const text = result.project.tracks.flatMap(track => track.clips).filter(clip => clip.text)
    assert.deepEqual(text.map(clip => clip.text), [preset.heading, preset.subheading])
    assert(text.every(clip => clip.textRole === 'watermark' && clip.start === result.start && clip.trimOut === item.duration))
    assert.equal(result.project.width, project.width)
  }
  assert.equal(manifest.author, 'Open Media')
  assert.equal(manifest.license, 'MIT')
})

test('科普片头片尾真实解码：入场、阅读和收束画面不同，均为完整五秒视频', { skip: !available('ffmpeg') || !available('ffprobe') }, () => {
  for (const item of manifest.items) {
    const path = fileURLToPath(new URL(item.filename, directory))
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-count_frames', '-show_format', '-of', 'json', path], { encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)
    const info = JSON.parse(probe.stdout), stream = info.streams[0]
    assert.equal(info.streams.length, 1)
    assert.equal(stream.codec_name, 'vp9')
    assert.equal(stream.pix_fmt, 'yuv420p')
    assert.equal(stream.width, 1280)
    assert.equal(stream.height, 720)
    assert.equal(stream.nb_read_frames, '120')
    assert.equal(Number(info.format.duration), 5)
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', "select='eq(n,8)+eq(n,57)+eq(n,115)'", '-vsync', '0', '-f', 'framemd5', 'pipe:1'], { encoding: 'utf8' })
    assert.equal(decode.status, 0, decode.stderr)
    const hashes = decode.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim())
    assert.equal(hashes.length, 3)
    assert.equal(new Set(hashes).size, 3, `${item.id} should contain genuine staged motion`)
  }
})
