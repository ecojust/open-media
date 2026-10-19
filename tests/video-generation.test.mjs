import test from 'node:test'
import assert from 'node:assert/strict'
import { videoGenerationRequestError, videoGenerationActualSeconds } from '../src/core/video-generation.ts'

function request(patch = {}) {
  return { requestId: 'request-1', modelId: 'h3-base-fl2va', mode: 'prompt', width: 512, height: 512, steps: 20, seed: 42, lowMemory: true, joinShots: false, shots: [{ id: 'shot-1', title: '开场', prompt: '暖色书桌，镜头缓慢推进，窗外的树叶轻轻摆动。', seconds: 2 }], ...patch }
}
const image = { id: 'image-1', kind: 'image', duration: 0 }
const video = { id: 'video-1', kind: 'video', duration: 5 }
const audio = { id: 'audio-1', kind: 'audio', duration: 5 }
const error = value => videoGenerationRequestError(value)

test('文字和多镜头首尾帧请求通过同一验证', () => {
  assert.equal(error(request()), undefined)
  const r = request({ mode: 'storyboard', joinShots: true })
  r.shots[0].firstFrame = image
  r.shots.push({ id: 'shot-2', title: '结尾', prompt: '镜头拉远，保持暖色光照。', seconds: 4, lastFrame: image })
  assert.equal(error(r), undefined)
  assert.equal(error(request({ mode: 'image', shots: [{ ...r.shots[0], lastFrame: image }] })), undefined)
})

test('错误模型与生成模式不会静默替换', () => {
  for (const patch of [{ modelId: 'toString' }, { modelId: 'unknown' }, { modelId: 'h3-base-ref2va' }, { mode: 'reference' }, { mode: 'unknown' }]) assert.ok(error(request(patch)))
  const r = request({ modelId: 'h3-base-ref2va', mode: 'reference' })
  r.shots[0].references = [{ kind: 'image', asset: image }, { kind: 'audio', asset: audio }]
  assert.equal(error(r), undefined)
  r.mode = 'storyboard'
  assert.match(error(r), /模型/)
})

test('分镜草稿损坏、重复标识与越界参数在执行前被拦截', () => {
  for (const patch of [{ requestId: '../escape' }, { width: 513 }, { width: 1920, height: 1080 }, { width: NaN }, { steps: 3 }, { steps: 51 }, { seed: -1 }, { seed: 2 ** 32 }, { lowMemory: 'true' }, { joinShots: null }, { shots: [] }, { shots: null }, { shots: [null] }]) assert.ok(error(request(patch)), JSON.stringify(patch))
  const r = request({ mode: 'storyboard' })
  r.shots.push({ ...r.shots[0] })
  assert.match(error(r), /标识/)
  r.shots = Array.from({ length: 21 }, (_, i) => ({ ...r.shots[0], id: `shot-${i}` }))
  assert.match(error(r), /分镜数量/)
})

test('空提示词、过长文本、无效时长与不合法首尾帧会定位镜头', () => {
  for (const patch of [{ prompt: '  ' }, { prompt: 'x'.repeat(8001) }, { prompt: 'x\0y' }, { prompt: null }, { seconds: NaN }, { seconds: 16 }, { seconds: 0 }, { title: 'x'.repeat(201) }, { firstFrame: video }]) {
    const r = request({ mode: 'storyboard' }); Object.assign(r.shots[0], patch)
    assert.match(error(r), /第 1 个分镜/)
  }
})

test('图片模式必须选择图片，文字模式不能暗中使用图片', () => {
  assert.match(error(request({ mode: 'image' })), /请选择首帧/)
  const r = request(); r.shots[0].firstFrame = image
  assert.match(error(r), /图片生成/)
})

test('参考必须有视觉输入，音视频限制按声音轨道分别累计', () => {
  const r = request({ modelId: 'h3-base-ref2va', mode: 'reference' })
  r.shots[0].references = [{ kind: 'audio', asset: audio }]
  assert.match(error(r), /图片或一段视频/)
  r.shots[0].references = [{ kind: 'video', asset: video, includeAudio: true }, { kind: 'audio', asset: { ...audio, duration: 11 } }]
  assert.match(error(r), /总时长/)
  r.shots[0].references[0].includeAudio = false
  assert.equal(error(r), undefined)
  r.shots[0].references[1].asset.duration = NaN
  assert.match(error(r), /参考音视频/)
})

test('首尾帧与参考素材不能混用，错误参考类型不能执行', () => {
  const r = request({ modelId: 'h3-base-ref2va', mode: 'reference' })
  r.shots[0].references = [{ kind: 'image', asset: image }]
  r.shots[0].firstFrame = image
  assert.match(error(r), /不能与首尾帧/)
  delete r.shots[0].firstFrame
  for (const refs of ['invalid', [null], [{ kind: 'image', asset: video }], [{ kind: 'video', asset: video, includeAudio: 'yes' }]]) {
    r.shots[0].references = refs
    assert.ok(error(r))
  }
})

test('参考视频原声需要至少56个输出帧，静音视频可使用短预览', () => {
  const r = request({ modelId: 'h3-base-ref2va', mode: 'reference' })
  r.shots[0].seconds = 1
  r.shots[0].references = [{ kind: 'video', asset: video, includeAudio: true }]
  assert.match(error(r), /至少为 2 秒/)
  r.shots[0].seconds = 2
  assert.equal(error(r), undefined)
  r.shots[0].seconds = 1; r.shots[0].references[0].includeAudio = false
  assert.equal(error(r), undefined)
})

test('画幅按真实引擎32倍数和总像素约束，允许横竖画幅', () => {
  assert.equal(error(request({ width: 1344, height: 768 })), undefined)
  assert.equal(error(request({ width: 768, height: 1344 })), undefined)
  assert.ok(error(request({ width: 1344, height: 800 })))
  assert.ok(error(request({ width: 128, height: 128 })))
})

test('时长显示遵循24fps和5+17n帧约束，不伪报用户输入时长', () => {
  assert.equal(videoGenerationActualSeconds(10), 243 / 24)
  assert.equal(videoGenerationActualSeconds(15), 362 / 24)
  for (let seconds = 1; seconds <= 15; seconds += 0.25) {
    const actual = videoGenerationActualSeconds(seconds), frames = actual * 24
    assert.ok(actual >= seconds)
    assert.ok(actual - seconds < 17 / 24)
    assert.equal((Math.round(frames) - 5) % 17, 0)
  }
})
