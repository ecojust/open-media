import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createTextClip } from '../src/core/project.ts'
import { animatedClipAt, visualClipDuration } from '../src/core/visual-animation.ts'
import { applyVisualMotionPreset, VISUAL_MOTION_PRESETS } from '../src/core/visual-motion-presets.ts'

const close = (actual, expected, label) => assert(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`)
const clipAt = (clip, time) => animatedClipAt(clip, clip.start + time)
const baseClip = overrides => createTextClip(createProject(), { start: 3.25, trimOut: 5, x: 240, y: 120, width: 600, height: 160, opacity: .8, ...overrides })

test('八种入退场预设使用不同动作，阅读阶段固定且末帧接近透明', () => {
  assert.deepEqual(VISUAL_MOTION_PRESETS.map(item => item.id), ['none', 'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'push-in', 'pull-back'])
  const signatures = new Set()
  for (const { id } of VISUAL_MOTION_PRESETS) {
    const source = baseClip(), before = structuredClone(source), clip = applyVisualMotionPreset(source, id)
    assert.deepEqual(source, before, `${id} 不应修改原片段`)
    const first = clipAt(clip, 0), entering = clipAt(clip, .2), middle = clipAt(clip, 2.5), later = clipAt(clip, 4)
    signatures.add(JSON.stringify(['x', 'y', 'width', 'height', 'opacity'].map(key => entering[key])))
    for (const key of ['x', 'y', 'width', 'height', 'opacity']) {
      close(middle[key], source[key], `${id} 稳定位置 ${key}`)
      close(later[key], middle[key], `${id} 阅读时不循环 ${key}`)
    }
    assert.equal(clip.fadeIn, 0); assert.equal(clip.fadeOut, 0)
    if (id === 'none') { assert.equal(clip.keyframes, undefined); continue }
    assert.equal(first.opacity, 0)
    assert(entering.opacity > 0 && entering.opacity < source.opacity)
    assert(clipAt(clip, 5 - 1 / 24).opacity < .025, `${id} 末帧不应突然截断`)
    assert.equal(clipAt(clip, 5).opacity, 0)
    if (id === 'slide-up') assert(first.y > source.y && clipAt(clip, 5).y < source.y)
    if (id === 'slide-down') assert(first.y < source.y && clipAt(clip, 5).y > source.y)
    if (id === 'slide-left') assert(first.x > source.x && clipAt(clip, 5).x < source.x)
    if (id === 'slide-right') assert(first.x < source.x && clipAt(clip, 5).x > source.x)
    if (id === 'push-in' || id === 'pull-back') {
      assert.equal(first.width < source.width, id === 'push-in')
      close(first.x + first.width / 2, source.x + source.width / 2, `${id} 横向中心`)
      close(first.y + first.height / 2, source.y + source.height / 2, `${id} 纵向中心`)
    }
  }
  assert.equal(signatures.size, 8, '预设不能只是重复改名')
})

test('短片段、裁切和变速按实际时间线时长分配入场/阅读/退场', () => {
  for (const duration of [.001, .1, 1, 5]) for (const { id } of VISUAL_MOTION_PRESETS.filter(item => item.id !== 'none')) {
    const source = baseClip({ trimOut: duration }), clip = applyVisualMotionPreset(source, id)
    for (const frames of Object.values(clip.keyframes)) {
      assert.equal(frames[0].time, 0); assert.equal(frames.at(-1).time, duration)
      assert(frames.every((frame, index) => index === 0 || frame.time > frames[index - 1].time))
      assert(frames[1].time < duration / 2 && frames[2].time > duration / 2)
    }
    close(clipAt(clip, duration / 2).opacity, source.opacity, `${id} 极短片段阅读阶段`)
  }
  const sped = applyVisualMotionPreset(baseClip({ trimIn: 2, trimOut: 12, speed: 2 }), 'fade')
  assert.equal(sped.keyframes.opacity.at(-1).time, 5)
  const rampedSource = baseClip({ speedRamp: { points: [{ position: 0, speed: 1 }, { position: 1, speed: 2 }], easing: 'linear', preservePitch: true } })
  const ramped = applyVisualMotionPreset(rampedSource, 'fade')
  assert.equal(ramped.keyframes.opacity.at(-1).time, visualClipDuration(rampedSource))
})

test('切分后的动画偏移被保留，旋转和音量曲线不丢失且与原对象隔离', () => {
  const source = baseClip({ animationOffset: 2, fadeIn: .8, fadeOut: .7, keyframes: {
    x: [{ time: 0, value: 50 }, { time: 5, value: 200 }],
    opacity: [{ time: 0, value: .3 }, { time: 5, value: .9 }],
    rotation: [{ time: 0, value: -20 }, { time: 10, value: 20 }],
    volume: [{ time: 0, value: 0 }, { time: 10, value: 1 }],
  } })
  const before = structuredClone(source), clip = applyVisualMotionPreset(source, 'slide-up')
  assert.equal(clip.animationOffset, 2)
  assert.equal(clip.keyframes.opacity[0].time, 2); assert.equal(clip.keyframes.opacity.at(-1).time, 7)
  assert.equal(clipAt(clip, 0).opacity, 0); close(clipAt(clip, 2.5).opacity, .8, '偏移后的阅读阶段')
  for (const time of [0, .2, 2.5, 5]) for (const property of ['rotation', 'volume']) {
    assert.equal(clipAt(clip, time)[property], clipAt(source, time)[property])
  }
  assert.equal(clip.keyframes.x, undefined)
  assert.notEqual(clip.keyframes.rotation, source.keyframes.rotation)
  clip.keyframes.rotation[0].value = 99
  assert.deepEqual(source, before)
  const stopped = applyVisualMotionPreset(source, 'none')
  assert.deepEqual(Object.keys(stopped.keyframes).sort(), ['rotation', 'volume'])
  assert.equal(stopped.fadeIn, 0); assert.equal(stopped.fadeOut, 0)
})

test('未知预设和无效动画时间明确失败，不修改原片段', () => {
  const source = baseClip(), before = structuredClone(source)
  for (const value of ['unknown', '', null, undefined]) assert.throws(() => applyVisualMotionPreset(source, value), /动画无效/)
  for (const trimOut of [0, -.1, NaN, Infinity]) assert.throws(() => applyVisualMotionPreset({ ...source, trimOut }, 'fade'), /时长/)
  for (const animationOffset of [-1, NaN, Infinity]) assert.throws(() => applyVisualMotionPreset({ ...source, animationOffset }, 'fade'), /起点/)
  assert.deepEqual(source, before)
})
