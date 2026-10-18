import test from 'node:test'
import assert from 'node:assert/strict'
import { TimelinePreview } from '../src/core/preview.ts'
import { createProject, createClip } from '../src/core/project.ts'
import { addAsset, addClip, splitClip, updateClip } from '../src/core/timeline.ts'

function playbackHarness(t, { pending = false, ready = true, video = false, frameReady = false } = {}) {
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
    videoWidth = ready ? 32 : 0
    videoHeight = ready ? 32 : 0
    frameCallbacks = new Map()
    frameCancels = []
    plays = 0
    pauses = 0
    loads = 0
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
    removeAttribute(name) { if (name === 'src') this.src = '' }
    load() { this.loads++ }
    finishSeek() { this.seeking = false; this.dispatchEvent(new Event('seeked')) }
  }
  if (frameReady) {
    Media.prototype.requestVideoFrameCallback = function (callback) { const id = this.frameCallbacks.size + 1; this.frameCallbacks.set(id, callback); return id }
    Media.prototype.cancelVideoFrameCallback = function (id) { this.frameCallbacks.delete(id); this.frameCancels.push(id) }
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
  const asset = { id: 'tone', name: video ? 'frame.webm' : 'tone.wav', kind: video ? 'video' : 'audio', duration: 30, width: video ? 32 : 0, height: video ? 32 : 0, size: 1, mime: video ? 'video/webm' : 'audio/wav', url: 'blob:tone' }
  project = addAsset(project, asset)
  project = addClip(project, project.tracks.find(track => track.kind === (video ? 'video' : 'audio')).id, createClip(asset, project, { trimOut: 20, speed: 1.5 }))
  let imagesDrawn = 0
  const ctx = { save() {}, restore() {}, setTransform() {}, fillRect() {}, translate() {}, rotate() {}, scale() {}, beginPath() {}, rect() {}, clip() {}, drawImage() { imagesDrawn++ } }
  const errors = []
  const preview = new TimelinePreview({ width: 32, height: 32, getContext: () => ctx }, project, error => errors.push(error))
  return { preview, media: elements[0], project, elements, errors, get imagesDrawn() { return imagesDrawn } }
}

test('视频分割边界沿用正在解码的画面与音频，不再次定位或启动播放器', t => {
  const { preview, media, project } = playbackHarness(t, { video: true })
  const original = project.tracks.find(track => track.kind === 'video').clips[0]
  const divided = splitClip(project, original.id, 2)
  const [left, right] = divided.tracks.find(track => track.kind === 'video').clips
  preview.setProject(divided)
  const waiting = preview.entries.get(right.id).media
  preview.render(0, true)
  media._time = 2.97
  preview.render(1.98, true)
  media._time = 2.995
  preview.render(2.01, true)
  assert.equal(preview.entries.get(right.id).media, media)
  assert.equal(preview.entries.has(left.id), false, '越过切点后释放旧片段的位置')
  assert.equal(waiting.src, '', '已交接的占位播放器应卸载媒体源')
  assert.equal(waiting.loads, 1)
  assert.equal(media.src, 'blob:tone', '连续播放的源不能被释放')
  assert.deepEqual(media.seeks, [], '切换片段时不应对已连续播放的源重新定位')
  assert.equal(media.plays, 1)
  assert.equal(media.pauses, 0, '视频自带音频也应继续播放')
})

test('暂停时在当前刻度分割立即保留已解码画面', t => {
  const { preview, media, project } = playbackHarness(t, { video: true })
  const original = project.tracks.find(track => track.kind === 'video').clips[0]
  media._time = 3
  preview.render(2)
  const divided = splitClip(project, original.id, 2)
  preview.setProject(divided)
  const right = divided.tracks.find(track => track.kind === 'video').clips[1]
  assert.equal(preview.entries.get(right.id).media, media)
  assert.deepEqual(media.seeks, [])
})

test('同源重叠视频保留两个播放器，手动跨边界定位仍准确定位目标片段', t => {
  const { preview, media, project } = playbackHarness(t, { video: true })
  const original = project.tracks.find(track => track.kind === 'video').clips[0]
  const divided = splitClip(project, original.id, 2)
  const [left, right] = divided.tracks.find(track => track.kind === 'video').clips
  preview.setProject(updateClip(divided, right.id, { start: 1.9 }))
  preview.render(0, true)
  media._time = 2.925
  preview.render(1.95, true)
  const second = preview.entries.get(right.id).media
  assert.notEqual(second, media)
  assert.equal(media.paused, false)
  assert.equal(second.paused, false, '重叠片段必须能够同时播放')
  preview.pause()
  preview.setProject(divided)
  preview.seek(2.1)
  assert.equal(preview.entries.has(left.id), false, '定位后离开范围的旧片段不再保留解码器')
  assert.equal(media.src, '')
  assert.equal(media.loads, 1)
  assert.equal(media.paused, true)
  assert.equal(preview.entries.get(right.id).media, second)
  assert(Math.abs(second.seeks.at(-1) - 3.15) < 1e-8)
  preview.seek(1.2)
  const returnedLeft = preview.entries.get(left.id).media
  assert.notEqual(returnedLeft, media, '反向定位重新加载已释放的片段')
  assert.equal(returnedLeft.src, 'blob:tone')
  assert(Math.abs(returnedLeft.seeks.at(-1) - 1.8) < 1e-8)
  assert.equal(returnedLeft.paused, true, '暂停状态下反向定位不能自行播放')
})

test('暂停预览在首帧实际可绘制后重新绘制，移除素材和销毁会取消待处理回调', t => {
  const first = playbackHarness(t, { video: true, ready: false, frameReady: true })
  first.media.readyState = 2
  first.media.dispatchEvent(new Event('loadeddata'))
  assert.equal(first.imagesDrawn, 0, '加载事件发生时图像尺寸尚未就绪')
  first.media.videoWidth = first.media.videoHeight = 32
  const callback = [...first.media.frameCallbacks.values()][0]
  callback()
  assert.equal(first.imagesDrawn, 1, '帧呈现回调应更新静止画面，无需用户先定位')
  first.preview.dispose()
  assert.deepEqual(first.media.frameCancels, [], '已完成的回调无需取消')
})

test('尚未呈现首帧时移除或销毁素材释放帧回调，迟到回调不再绘制', t => {
  const harness = playbackHarness(t, { video: true, ready: false, frameReady: true })
  const callback = [...harness.media.frameCallbacks.values()][0]
  harness.preview.setProject(createProject('空项目', { width: 32, height: 32 }))
  assert.deepEqual(harness.media.frameCancels, [1])
  assert.equal(harness.media.frameCallbacks.size, 0)
  harness.preview.dispose()
  callback()
  assert.equal(harness.imagesDrawn, 0)
})

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

test('输入设备切换后被中断的音频输出会恢复，而不是只处理 suspended', async t => {
  const { preview } = playbackHarness(t)
  let resumed = 0
  const context = { state: 'interrupted', resume: async () => { resumed++; context.state = 'running' }, close: async () => {} }
  preview.audioContext = context
  preview.destination = { stream: 'restored-stream' }
  assert.equal(await preview.enableAudio(), 'restored-stream')
  assert.equal(resumed, 1)
})

test('音频输出恢复未返回时仍能立即取消播放准备', async t => {
  const { preview } = playbackHarness(t)
  preview.audioContext = { state: 'interrupted', resume: () => new Promise(() => {}), close: async () => {} }
  const controller = new AbortController()
  const start = preview.enableAudio(true, controller.signal)
  controller.abort()
  await assert.rejects(start, error => error.name === 'AbortError')
})

test('音频输出恢复无响应时会超时退出，不会永久处于准备状态', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { preview } = playbackHarness(t)
  preview.audioContext = { state: 'interrupted', resume: () => new Promise(() => {}), close: async () => {} }
  const start = preview.enableAudio()
  const rejected = assert.rejects(start, /音频输出未能恢复/)
  t.mock.timers.tick(10000)
  await rejected
})

test('媒体启动无响应会结束准备并暂停，可再次启动且旧请求不影响新播放', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { preview, media } = playbackHarness(t, { pending: true })
  const start = preview.playReady(0)
  const rejected = assert.rejects(start, /素材播放启动超时/)
  await new Promise(setImmediate)
  const resolveOld = media.resolvePlay
  t.mock.timers.tick(10000)
  await rejected
  assert.equal(media.paused, true)
  const retry = preview.playReady(0)
  await new Promise(setImmediate)
  assert.equal(media.plays, 2)
  resolveOld()
  media.resolvePlay()
  await retry
})
