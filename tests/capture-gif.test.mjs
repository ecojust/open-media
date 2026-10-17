import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GifEncoder, quantizeGifFrame, validateGifSegments } from '../src/core/gif.ts'
import { recordingFileName, captureErrorMessage, browserCaptureAvailable } from '../src/core/capture.ts'

test('segment validation permits deliberate overlap and ordering while rejecting invalid ranges', () => {
  assert.equal(validateGifSegments([{ start: 4, end: 8 }, { start: 1, end: 6 }], 10), null)
  for (const segments of [[], [{ start: -1, end: 2 }], [{ start: 1, end: 1 }], [{ start: 1, end: 11 }], [{ start: NaN, end: 3 }]]) assert.equal(typeof validateGifSegments(segments, 10), 'string')
  assert.equal(typeof validateGifSegments([{ start: 0, end: 1 }], Infinity), 'string')
})

test('palette preserves primary colors and composites transparent pixels on white', () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0])
  assert.deepEqual([...quantizeGifFrame(rgba, 4, 'fast')], [224, 28, 3, 255])
})

test('encoder guards malformed frames, dimensions and closed streams', async () => {
  assert.throws(() => new GifEncoder(0, 8))
  const empty = new GifEncoder(2, 2)
  assert.throws(() => empty.finish())
  assert.throws(() => empty.addFrame(new Uint8Array(15), 0.1))
  empty.addFrame(new Uint8Array(16).fill(255), 0.1)
  const blob = empty.finish()
  assert.equal(blob.type, 'image/gif')
  assert.equal(new TextDecoder().decode((await blob.arrayBuffer()).slice(0, 6)), 'GIF89a')
  assert.throws(() => empty.addFrame(new Uint8Array(16), 0.1))
  assert.throws(() => empty.finish())
})

const hasDecoder = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0
test('actual GIF decoder verifies frames, timing, color pixels and dictionary resets', { skip: !hasDecoder && 'media decoder unavailable' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-media-gif-'))
  try {
    const width = 192, height = 128
    const encoder = new GifEncoder(width, height, true)
    const frames = []
    let seed = 34234
    for (let frame = 0; frame < 5; frame++) {
      const rgba = new Uint8Array(width * height * 4)
      for (let pixel = 0; pixel < width * height; pixel++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const value = seed >>> 24
        rgba[pixel * 4] = Math.round(((value >> 5) & 7) * 255 / 7)
        rgba[pixel * 4 + 1] = Math.round(((value >> 2) & 7) * 255 / 7)
        rgba[pixel * 4 + 2] = Math.round((value & 3) * 255 / 3)
        rgba[pixel * 4 + 3] = 255
      }
      frames.push(rgba)
      encoder.addFrame(rgba, 0.1 + frame * 0.01, 'fast')
    }
    const file = join(directory, 'frames.gif')
    writeFileSync(file, Buffer.from(await encoder.finish().arrayBuffer()))
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }))
    assert.equal(probe.streams[0].width, width)
    assert.equal(probe.streams[0].height, height)
    assert.equal(Number(probe.streams[0].nb_read_frames), 5)
    assert.ok(Math.abs(Number(probe.streams[0].duration) - 0.6) < 0.011)
    const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 8 * 1024 * 1024 })
    assert.equal(pixels.length, width * height * 3 * frames.length)
    for (let frame = 0; frame < frames.length; frame++) for (let pixel = 0; pixel < width * height; pixel++) for (let channel = 0; channel < 3; channel++) {
      assert.equal(pixels[frame * width * height * 3 + pixel * 3 + channel], frames[frame][pixel * 4 + channel], `frame ${frame}, pixel ${pixel}, channel ${channel}`)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('recording names use an extension matching the actual container', () => {
  const date = new Date('2026-10-16T03:00:00Z')
  assert.equal(recordingFileName('video/mp4', date), '录屏-2026-10-16T03-00-00.mp4')
  assert.match(recordingFileName('video/webm;codecs=vp9', date), /\.webm$/)
  assert.match(captureErrorMessage(new DOMException('denied', 'NotAllowedError')), /权限/)
  assert.match(captureErrorMessage(new DOMException('missing input', 'OverconstrainedError')), /所选麦克风当前不可用/)
  assert.equal(browserCaptureAvailable(), false)
})
