import test from 'node:test'
import assert from 'node:assert/strict'
import { TimelinePreview } from '../src/core/preview.ts'
import { createProject, createClip } from '../src/core/project.ts'
import { addAsset, addClip } from '../src/core/timeline.ts'

function playbackHarness(t, { pending = false, ready = true } = {}) {
  const elements = []
  class Media extends EventTarget {
    readyState = ready ? 4 : 0
    paused = true
    seeking = false
    duration = 30
    _time = 0
    _rate = 1
    _volume = 1
    _muted = false
    seeks = []
    rateWrites = 0
    volumeWrites = 0
    mutedWrites = 0
    plays = 0
    pauses = 0
    get currentTime() { return this._time }
    set currentTime(time) { this._time = time; this.seeks.push(time); this.seeking = true }
    get playbackRate() { return this._rate }
    set playbackRate(rate) { this._rate = rate; this.rateWrites++ }
    get volume() { return this._volume }
    set volume(volume) { this._volume = volume; this.volumeWrites++ }
    get muted() { return this._muted }
    set muted(muted) { this._muted = muted; this.mutedWrites++ }
    play() {
      this.plays++
      if (pending) return new Promise((resolve, reject) => { this.resolvePlay = resolve; this.rejectPlay = reject })
      this.paused = false
      return Promise.resolve()
    }
    pause() { this.pauses++; this.paused = true }
    removeAttribute() {}
    load() {}
    finishSeek() { this.seeking = false; this.dispatchEvent(new Event('seeked')) }
  }
  class Image {}
  const replacements = {
    HTMLMediaElement: Media, HTMLVideoElement: Media, HTMLImageElement: Image,
    document: { createElement: () => { const element = new Media(); elements.push(element); return element } },
    window: { setTimeout, clearTimeout },
  }
  const original = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => {
    preview.dispose()
    for (const [key, value] of Object.entries(original)) {
      if (value) Object.defineProperty(globalThis, key, value)
      else delete globalThis[key]
    }
  })
  let project = createProject('连续音频验证', { width: 32, height: 32 })
  const asset = { id: 'tone', name: 'tone.wav', kind: 'audio', duration: 30, width: 0, height: 0, size: 1, mime: 'audio/wav', url: 'blob:tone' }
  project = addAsset(project, asset)
  project = addClip(project, project.tracks.find(track => track.kind === 'audio').id, createClip(asset, project, { trimOut: 20, speed: 1.5 }))
  const ctx = { save() {}, restore() {}, setTransform() {}, fillRect() {}, translate() {}, rotate() {}, beginPath() {}, rect() {}, clip() {} }
  const errors = []
  const preview = new TimelinePreview({ width: 32, height: 32, getContext: () => ctx }, project, error => errors.push(error))
  return { preview, media: elements[0], errors }
}

test('连续播放和待完成的启动不会逐帧重写速度或重复启动音轨', async t => {
  const { preview, media } = playbackHarness(t, { pending: true })
  for (let frame = 0; frame < 120; frame++) {
    media._time = frame / 60 * 1.5
    preview.render(frame / 60, true)
  }
  assert.equal(media.plays, 1)
  assert.equal(media.rateWrites, 1)
  assert.equal(media.volumeWrites, 0)
  assert.equal(media.mutedWrites, 0)
  assert.deepEqual(media.seeks, [])
  media.resolvePlay()
  await Promise.resolve()
})

test('播放中的小幅手动定位立即生效，未完成的定位不会被每一帧重新开始', t => {
  const { preview, media } = playbackHarness(t)
  preview.render(0, true)
  preview.seek(0.1, true)
  assert.equal(media.seeks.length, 1)
  assert(Math.abs(media.seeks[0] - 0.15) < 1e-9)
  for (let frame = 1; frame < 120; frame++) preview.render(0.1 + frame / 60, true)
  assert.equal(media.seeks.length, 1)
  media.finishSeek()
  preview.seek(4, true)
  assert.equal(media.seeks.at(-1), 6)
  assert.equal(media.plays, 1)
})

test('素材加载期间暂停会取消旧播放请求，加载完成后不自行播放', async t => {
  const { preview, media } = playbackHarness(t, { ready: false })
  const start = preview.playReady(0)
  preview.pause()
  media.readyState = 4
  media.dispatchEvent(new Event('loadeddata'))
  await assert.rejects(start, error => error.name === 'AbortError')
  assert.equal(media.plays, 0)
  assert.equal(media.paused, true)
})

test('定位期间取消播放不会在 seeked 回调之后重新启动', async t => {
  const { preview, media } = playbackHarness(t)
  const start = preview.playReady(2)
  await new Promise(setImmediate)
  assert.equal(media.seeking, true)
  preview.pause()
  media.finishSeek()
  await assert.rejects(start, error => error.name === 'AbortError')
  assert.equal(media.plays, 0)
})

test('等待素材时取消信号立即结束播放准备', async t => {
  const { preview, media } = playbackHarness(t, { ready: false })
  const controller = new AbortController()
  const start = preview.playReady(0, controller.signal)
  controller.abort()
  await assert.rejects(start, error => error.name === 'AbortError')
  assert.equal(media.plays, 0)
})

for (const event of ['canplay', 'seeked']) {
  test(`定位后仅触发 ${event} 也能恢复播放，媒体未就绪时继续等待`, { timeout: 1000 }, async t => {
    const { preview, media } = playbackHarness(t)
    const controller = new AbortController()
    t.after(() => controller.abort())
    media.readyState = 1
    media.seeking = true
    media._time = 3
    const start = preview.playReady(2, controller.signal)
    media.dispatchEvent(new Event(event))
    await new Promise(setImmediate)
    assert.equal(media.plays, 0)
    media.readyState = 4
    media.seeking = false
    media.dispatchEvent(new Event(event))
    await start
    assert.equal(media.plays, 1)
    assert.equal(media.paused, false)
  })
}

test('暂停造成的旧启动错误不会提示权限错误，也不会污染后续播放', async t => {
  const { preview, media, errors } = playbackHarness(t, { pending: true })
  preview.render(0, true)
  const rejectOldStart = media.rejectPlay
  preview.pause()
  preview.render(0, true)
  rejectOldStart(new DOMException('interrupted', 'AbortError'))
  await Promise.resolve()
  await Promise.resolve()
  media.resolvePlay()
  assert.equal(media.plays, 2)
  assert.deepEqual(errors, [])
})

test('旧启动的取消信号不会暂停已经替换它的新一次播放', async t => {
  const { preview, media } = playbackHarness(t, { pending: true })
  const controller = new AbortController()
  const first = preview.playReady(0, controller.signal)
  await new Promise(setImmediate)
  const resolveFirst = media.resolvePlay
  preview.pause()
  const second = preview.playReady(0)
  await new Promise(setImmediate)
  assert.equal(media.plays, 2)
  assert.equal(media.pauses, 1, '待完成的 play 也必须通过 pause 取消')
  const cancelled = assert.rejects(first, error => error.name === 'AbortError')
  controller.abort()
  await cancelled
  assert.equal(media.pauses, 1)
  resolveFirst()
  media.resolvePlay()
  await second
})

test('音频到达文件尾部后不会在下一个绘制帧重新从头播放', t => {
  const { preview, media } = playbackHarness(t)
  preview.render(0, true)
  media.paused = true
  media.ended = true
  media._time = 6
  preview.render(4, true)
  assert.equal(media.plays, 1)
})
