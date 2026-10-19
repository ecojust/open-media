import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createClip, validateProject } from '../src/core/project.ts'
import { animatedClipAt } from '../src/core/visual-animation.ts'
import { focusLocalPoint, buildFocusAnimation } from '../src/core/focus-region.ts'
import { executeVisualTool } from '../src/core/visual-tools.ts'
import { createHistory, commitHistory, undoHistory } from '../src/core/timeline.ts'

function fixture(patch = {}) {
  const project = createProject('重点放大', { width: 640, height: 360 })
  const asset = { id: 'source', kind: 'video', name: '视频', url: 'blob:source', duration: 20, width: 640, height: 360, size: 10, mime: 'video/mp4' }
  project.assets.push(asset)
  project.tracks.find(track => track.kind === 'video').clips.push(createClip(asset, project, { id: 'clip', start: 2, trimOut: 8, ...patch }))
  return project
}
const find = project => project.tracks.flatMap(track => track.clips).find(clip => clip.id === 'clip')
const request = { clipId: 'clip', region: { x: .5, y: .25, width: .5, height: .5 }, start: 1, duration: .5, holdDuration: 1, returnDuration: .5 }

test('聚焦完整保留位置尺寸裁切，以等比动画放大、保持并恢复，支持单步撤销', () => {
  const project = fixture({ x: 100, y: 50, width: 320, height: 180, fit: 'contain', crop: { x: .1, y: .2, width: .7, height: .6 }, opacity: .8 })
  const original = structuredClone(project), result = executeVisualTool(project, 'focus_region', request), clip = find(result.project)
  for (const key of ['x', 'y', 'width', 'height', 'fit', 'crop', 'opacity']) assert.deepEqual(clip[key], find(project)[key])
  const before = animatedClipAt(clip, 2.5), peak = animatedClipAt(clip, 3.5), hold = animatedClipAt(clip, 4), after = animatedClipAt(clip, 5.5)
  assert.equal(before.width, 320); assert.equal(before.x, 100)
  assert.equal(peak.width, 640); assert.equal(peak.height, 360); assert.equal(peak.x, -220)
  assert.equal(peak.x + peak.width * .75, 260)
  assert.deepEqual(hold, peak)
  assert.equal(after.width, 320); assert.equal(after.x, 100); assert.equal(after.y, 50)
  assert.equal(result.data.focus.end, 3)
  assert.deepEqual(project, original)
  assert.deepEqual(undoHistory(commitHistory(createHistory(project), result.project)).present, original)
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(result.project))).tracks, result.project.tracks)
})

test('边缘的小目标受倍数与强度限制，整个过程不新增露底', () => {
  const project = fixture(), result = executeVisualTool(project, 'focus_region', { ...request, region: { x: .95, y: .95, width: .05, height: .05 }, maxScale: 3, strength: .5 })
  const clip = find(result.project)
  assert.equal(result.data.focus.scale, 2)
  for (let t = 3; t <= 5; t += .025) {
    const rendered = animatedClipAt(clip, t)
    assert.ok(rendered.x <= 1e-8 && rendered.y <= 1e-8)
    assert.ok(rendered.x + rendered.width >= 640 - 1e-8)
    assert.ok(rendered.y + rendered.height >= 360 - 1e-8)
  }
  const unequal = buildFocusAnimation(find(project), { ...request, region: { x: .25, y: .25, width: .2, height: .5 } })
  assert.equal(unequal.scale, 2)
  assert.deepEqual(unequal.keyframes.scaleX, unequal.keyframes.scaleY)
})

test('位置缩放动画必须明确替换，保留其他关键帧且失败不污染项目', () => {
  const project = fixture({ keyframes: { x: [{ time: 0, value: 20 }, { time: 2, value: 40 }], opacity: [{ time: 0, value: .2 }, { time: 1, value: .8 }], volume: [{ time: 0, value: .5 }] } })
  const original = structuredClone(project)
  assert.throws(() => executeVisualTool(project, 'focus_region', request), /已有位置或缩放动画/)
  assert.deepEqual(project, original)
  const result = executeVisualTool(project, 'focus_region', { ...request, replaceExisting: true })
  assert.deepEqual(find(result.project).keyframes.opacity, find(project).keyframes.opacity)
  assert.deepEqual(find(result.project).keyframes.volume, find(project).keyframes.volume)
  assert.equal(find(result.project).keyframes.x.length, 4)
  assert.throws(() => executeVisualTool(project, 'focus_region', { ...request, replaceExisting: 'true' }), /开关/)
})

test('聚焦校验时长边界和参数；恢复时长为零保持聚焦兼容旧调用', () => {
  const project = fixture(), original = structuredClone(project)
  for (const patch of [{ start: 8 }, { holdDuration: 8 }, { returnDuration: -1 }, { maxScale: 17 }, { strength: 0 }, { region: { x: .95, y: 0, width: .1, height: .5 } }]) {
    assert.throws(() => executeVisualTool(project, 'focus_region', { ...request, ...patch }))
    assert.deepEqual(project, original)
  }
  const clip = find(executeVisualTool(project, 'focus_region', { clipId: 'clip', region: request.region, duration: 1 }).project)
  assert.equal(animatedClipAt(clip, 9).width, 1280)
})

test('分割后的动画偏移和旋转显示矩形坐标保持一致', () => {
  const project = fixture({ x: 100, y: 50, width: 320, height: 180, animationOffset: 5, rotation: 90 })
  const clip = find(executeVisualTool(project, 'focus_region', request).project)
  assert.deepEqual(clip.keyframes.scaleX.map(frame => frame.time), [6, 6.5, 7.5, 8])
  const focused = animatedClipAt(clip, 3.5)
  assert.ok(Math.abs(focused.x + focused.width / 2 - 260) < 1e-8)
  assert.ok(Math.abs(focused.y + focused.height / 2 - (140 - 160)) < 1e-8)
  const point = focusLocalPoint({ x: 100, y: 50, width: 320, height: 180, rotation: 90 }, { x: 260, y: 220 })
  assert.ok(Math.abs(point.x - .75) < 1e-8); assert.ok(Math.abs(point.y - .5) < 1e-8)
})

test('聚焦阻止生效区间的动态旋转，保留静态和区间外的旋转动画', () => {
  const active = { ...request, start: 0, duration: 1, holdDuration: 0, returnDuration: 1 }
  for (const rotation of [
    [{ time: 0, value: 0 }, { time: 1, value: 90 }],
    [{ time: 0, value: 0 }, { time: 1, value: 90 }, { time: 2, value: 0 }],
    [{ time: .5, value: 90 }, { time: 1, value: 0 }],
    [{ time: 0, value: 0, easing: 'step' }, { time: 1, value: 90 }],
  ]) {
    const project = fixture({ keyframes: { rotation } }), original = structuredClone(project)
    assert.throws(() => executeVisualTool(project, 'focus_region', active), /聚焦生效期间存在旋转动画/)
    assert.deepEqual(project, original)
  }
  for (const rotation of [
    [{ time: 0, value: 30 }, { time: 8, value: 30 }],
    [{ time: 0, value: 0 }, { time: 1, value: 90 }],
    [{ time: 0, value: 0 }, { time: 4, value: 0 }, { time: 6, value: 90 }],
    [{ time: 0, value: 0, easing: 'step' }, { time: 6, value: 90 }],
  ]) {
    const project = fixture({ keyframes: { rotation } })
    const result = executeVisualTool(project, 'focus_region', { ...request, start: 1.5 })
    assert.deepEqual(find(result.project).keyframes.rotation, rotation)
  }
  const later = fixture({ keyframes: { rotation: [{ time: 0, value: 0 }, { time: 4, value: 0 }, { time: 6, value: 90 }] } })
  assert.throws(() => executeVisualTool(later, 'focus_region', { ...active, returnDuration: 0 }), /旋转动画/, '不恢复的聚焦在片段剩余时间仍生效')
  const offset = fixture({ animationOffset: 5, keyframes: { rotation: [{ time: 5, value: 0 }, { time: 6, value: 90 }] } })
  assert.throws(() => executeVisualTool(offset, 'focus_region', active), /旋转动画/)
  assert.doesNotThrow(() => executeVisualTool(offset, 'focus_region', { ...request, start: 1.5 }))
})
