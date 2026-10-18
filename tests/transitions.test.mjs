import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTrack, validateProject } from '../src/core/project.ts'
import { addAsset, addClip, addTrack, clipDuration, commitHistory, createHistory, deleteClip, duplicateClip, findClip, moveClip, projectDuration, redoHistory, removeTrack, setTrack, splitClip, trimClip, undoHistory, updateClip } from '../src/core/timeline.ts'
import { closeTimelineGaps, trimClipAtPlayhead } from '../src/core/timeline-editing.ts'
import { addTransition, findTransitionCut, reconcileTransitions, TRANSITION_PRESETS, TRANSITION_COLLECTIONS, transitionBlindRects, transitionVisual, transitionVisualAt, transitionVisualForParameters, updateTransition } from '../src/core/transitions.ts'
import { visibleVisualClips } from '../src/core/preview-position.ts'

function fixture(offset = 0) {
  let project = createProject('转场验证', { width: 320, height: 180, fps: 20 })
  const video = { id: 'source', name: '视频.mp4', kind: 'video', url: 'blob:test', duration: 20, width: 320, height: 180, size: 200, mime: 'video/mp4' }
  project = addAsset(project, video)
  const trackId = project.tracks[1].id
  for (const [id, start, trimIn, trimOut] of [['first', offset, 0, 4], ['second', offset + 4, 4, 8], ['third', offset + 8, 8, 12]]) {
    project = addClip(project, trackId, createClip(video, project, { id, start, trimIn, trimOut }))
  }
  return { project, trackId, video }
}
const effectClips = project => project.tracks.filter(track => track.kind === 'transition').flatMap(track => track.clips)

test('通用转场分类完整，添加参数与实际时间线一致，重选时清除旧参数', () => {
  assert.deepEqual(TRANSITION_COLLECTIONS.flatMap(group => group.effects).sort(), TRANSITION_PRESETS.map(item => item.id).sort())
  const { project, trackId } = fixture(), original = structuredClone(project)
  const parameters = { direction: 'up', easing: 'ease-out', scope: 'incoming' }
  const next = addTransition(project, 4, 'slide-left', 2, trackId, parameters)
  assert.equal(transitionVisualAt(next, 'first', 3.5), undefined)
  assert.deepEqual(transitionVisualAt(next, 'second', 4.5), transitionVisualForParameters('slide-left', .5, parameters))
  assert(transitionVisualAt(next, 'second', 4.5).translateY < 0)
  const replaced = addTransition(next, 4, 'defocus', 1, trackId, { easing: 'linear', blur: 0, scope: 'both' })
  assert.equal(effectClips(replaced).length, 1)
  assert.equal(effectClips(replaced)[0].transition.direction, undefined)
  assert.equal(transitionVisualAt(replaced, 'second', 4.25).blur, 0)
  assert.deepEqual(project, original)
  assert.throws(() => addTransition(project, 4, 'fade', 1, trackId, { blur: -1 }), /模糊/)
})

test('降低项目帧率会将最短转场扩至新帧率的两帧，锁定转场则拒绝隐式改动', () => {
  const { project } = fixture()
  project.fps = 60
  const before = addTransition(project, 4, 'fade', 2 / 60)
  const next = structuredClone(before)
  next.fps = 24
  reconcileTransitions(next, before)
  assert.equal(effectClips(validateProject(next))[0].trimOut, 2 / 24)
  assert.equal(effectClips(next)[0].start + effectClips(next)[0].trimOut / 2, 4)
  const locked = setTrack(before, before.tracks.find(track => track.kind === 'transition').id, { locked: true })
  const attempted = structuredClone(locked)
  attempted.fps = 24
  assert.throws(() => reconcileTransitions(attempted, locked), /解锁转场轨道/)
  assert.equal(effectClips(locked)[0].trimOut, 2 / 60)
})

test('转场预设绑定最近切点，居中且不改变时间线总长度', () => {
  const { project, trackId } = fixture()
  assert.equal(TRANSITION_PRESETS.length, 23)
  assert.equal(new Set(TRANSITION_PRESETS.map(item => item.id)).size, 23)
  assert.deepEqual(findTransitionCut(project, 3.7), { trackId, fromClipId: 'first', toClipId: 'second', time: 4, maxDuration: 4 })
  for (const preset of TRANSITION_PRESETS) {
    const edited = addTransition(project, 5, preset.id, 2)
    const [transition] = effectClips(edited)
    assert.equal(transition.start, 3)
    assert.equal(clipDuration(transition), 2)
    assert.equal(transition.transition.fromClipId, 'first')
    assert.equal(transition.transition.toClipId, 'second')
    assert.equal(projectDuration(edited), 12)
    assert.equal(validateProject(edited).tracks[0].kind, 'transition')
  }
  assert.equal(effectClips(project).length, 0)
})

test('转场长度受两段视频限制，重复添加替换原切点效果，邻接转场不重叠', () => {
  const { project } = fixture()
  const first = addTransition(project, 4, 'fade', 80)
  const old = effectClips(first)[0]
  assert.equal(clipDuration(old), 4)
  const changed = addTransition(first, 4, 'wipe-up', 3)
  assert.equal(effectClips(changed).length, 1)
  assert.equal(effectClips(changed)[0].id, old.id)
  const both = addTransition(first, 8, 'zoom', 100)
  const [left, right] = effectClips(both)
  assert.equal(left.start + clipDuration(left), right.start)
  assert.equal(clipDuration(effectClips(updateTransition(first, old.id, 'zoom', 0.01))[0]), 0.1)
  assert.throws(() => addTransition(project, 4, 'fade', NaN), /时长/)
})

test('无切点、间隙、交叠、图片片段与跨轨道片段不能应用转场', () => {
  const { project, trackId, video } = fixture()
  const gap = updateClip(project, 'second', { start: 5 })
  assert.equal(findTransitionCut(gap, 4), undefined)
  const overlap = addClip(project, trackId, createClip(video, project, { id: 'overlap', start: 3, trimOut: 6 }))
  assert.equal(findTransitionCut(overlap, 4), undefined)
  const missing = removeTrack(project, trackId)
  assert.throws(() => addTransition(missing, 4, 'fade'), /首尾相接/)
  const image = { ...video, id: 'image', kind: 'image', mime: 'image/png' }
  const picture = addAsset(missing, image)
  const imageTrack = createTrack('video')
  imageTrack.clips = [createClip(image, picture, { id: 'image-clip', trimOut: 4 }), createClip(image, picture, { id: 'image-clip2', start: 4, trimOut: 4 })]
  assert.equal(findTransitionCut(addTrack(picture, imageTrack), 4), undefined)
})

test('优先当前视频轨道，锁定视频或转场轨道不允许新增/修改', () => {
  let { project, video, trackId } = fixture()
  const other = createTrack('video')
  other.clips = [createClip(video, project, { id: 'other-first', trimOut: 2 }), createClip(video, project, { id: 'other-second', start: 2, trimOut: 2 })]
  project = addTrack(project, other)
  assert.equal(findTransitionCut(project, 3.9, other.id).trackId, other.id)
  assert.equal(findTransitionCut(setTrack(project, other.id, { locked: true }), 3.9, other.id).trackId, trackId)
  const withEffect = addTransition(project, 4, 'fade')
  const transition = effectClips(withEffect)[0], effectTrack = withEffect.tracks[0]
  assert.throws(() => addTransition(setTrack(withEffect, effectTrack.id, { locked: true }), 4, 'zoom'), /解锁/)
  assert.throws(() => updateTransition(setTrack(withEffect, trackId, { locked: true }), transition.id, 'zoom', 2), /解锁/)
})

test('删除、移动及裁剪视频清理失效转场，分割前一段保留切点引用', () => {
  const { project, trackId } = fixture()
  const edited = addTransition(project, 4, 'fade', 2)
  const original = effectClips(edited)[0]
  assert.equal(effectClips(deleteClip(edited, 'second')).length, 0)
  assert.equal(effectClips(moveClip(edited, 'first', trackId, 0.5)).length, 0)
  assert.equal(effectClips(trimClip(edited, 'first', 0, 3)).length, 0)
  const split = splitClip(edited, 'first', 3)
  const rebound = effectClips(split)[0]
  assert.equal(rebound.id, original.id)
  assert.notEqual(rebound.transition.fromClipId, 'first')
  assert.equal(rebound.transition.toClipId, 'second')
  assert.equal(clipDuration(rebound), 1)
  assert.equal(rebound.start, 3.5)
  const splitIncoming = splitClip(edited, 'second', 5)
  assert.equal(effectClips(splitIncoming)[0].transition.toClipId, 'second')
  assert.equal(clipDuration(effectClips(splitIncoming)[0]), 1)
  const locked = setTrack(edited, edited.tracks[0].id, { locked: true })
  assert.throws(() => deleteClip(locked, 'second'), /解锁转场/)
  assert.throws(() => splitClip(locked, 'first', 2), /解锁转场/)
})

test('接拢空隙同步移动转场；转场禁止自由移动、裁剪、复制和分割', () => {
  const { project, trackId } = fixture(3)
  const edited = addTransition(project, 7, 'fade')
  const effect = effectClips(edited)[0]
  const compacted = closeTimelineGaps(edited)
  assert.equal(findClip(compacted, 'first').clip.start, 0)
  assert.equal(effectClips(compacted)[0].start, 3.5)
  assert.throws(() => moveClip(edited, effect.id, trackId, 0), /固定/)
  assert.throws(() => duplicateClip(edited, effect.id), /不能直接复制/)
  assert.throws(() => splitClip(edited, effect.id, 7), /不能分割/)
  assert.throws(() => trimClipAtPlayhead(edited, effect.id, 7, 'start'), /不能按播放头裁剪/)
  assert.throws(() => updateClip(edited, effect.id, { start: 0 }), /转场属性/)
  assert.throws(() => closeTimelineGaps(setTrack(edited, edited.tracks[0].id, { locked: true })), /解锁转场/)
})

test('保存校验拒绝无效引用、脱离切点、超时长及重复切点', () => {
  const { project, trackId } = fixture()
  const edited = addTransition(project, 4, 'fade')
  for (const mutate of [
    effect => { effect.transition.toClipId = 'missing' },
    effect => { effect.start += 0.2 },
    effect => { effect.trimOut = 5; effect.start = 1.5 },
    effect => { effect.speed = 2 },
    effect => { effect.assetId = 'source' },
    effect => { effect.transition.effect = 'unknown' },
  ]) {
    const copy = structuredClone(edited); mutate(effectClips(copy)[0]); assert.throws(() => validateProject(copy))
  }
  const duplicate = structuredClone(edited); duplicate.tracks[0].clips.push({ ...effectClips(duplicate)[0], id: 'duplicate' })
  assert.throws(() => validateProject(duplicate), /只能使用一个/)
  const misplaced = structuredClone(edited); misplaced.tracks.find(track => track.id === trackId).clips[0].transition = effectClips(edited)[0].transition
  assert.throws(() => validateProject(misplaced), /只能用于转场轨道/)
})

test('预览效果、边界和静音开关正确，转场不成为预览选择对象', () => {
  const { project } = fixture()
  for (const { id } of TRANSITION_PRESETS) {
    const edited = addTransition(project, 4, id, 2)
    const before = transitionVisualAt(edited, 'first', 3.5)
    const after = transitionVisualAt(edited, 'second', 4.5)
    assert.equal(before.visibility, 0.5)
    assert.deepEqual(before, after)
    assert.equal(transitionVisualAt(edited, 'second', 4).visibility, 0)
    assert.equal(transitionVisualAt(edited, 'first', 4), undefined)
    assert.equal(transitionVisualAt(edited, 'second', 5), undefined)
    assert.equal(transitionVisualAt(setTrack(edited, edited.tracks[0].id, { muted: true }), 'first', 3.5), undefined)
    assert(!visibleVisualClips(edited, 3.5).some(item => item.track.kind === 'transition'))
  }
  const fade = transitionVisualAt(addTransition(project, 4, 'fade', 2), 'first', 3.5)
  assert.equal(fade.opacity, 0.5)
  const up = transitionVisualAt(addTransition(project, 4, 'wipe-up', 2), 'first', 3.5)
  assert.deepEqual(up.mask, { x: 0, y: 0.5, width: 1, height: 0.5 })
  const zoom = transitionVisualAt(addTransition(project, 4, 'zoom', 2), 'first', 3.5)
  assert.equal(zoom.opacity, 0.5); assert.equal(zoom.scale, 0.5)
})

test('缩放淡化在两侧严格保持80%至100%，固定锚边且支持缓动与保存重开', () => {
  const { project } = fixture()
  for (const id of ['zoom-fade', 'zoom-fade-left', 'zoom-fade-right', 'zoom-fade-up', 'zoom-fade-down']) {
    const edited = validateProject(JSON.parse(JSON.stringify(addTransition(project, 4, id, 2))))
    const start = transitionVisualAt(edited, 'first', 3)
    const cut = transitionVisualAt(edited, 'second', 4)
    assert.equal(start.scale, 1); assert.equal(start.opacity, 1)
    assert.equal(cut.scale, 0.8); assert.equal(cut.opacity, 0)
    for (const time of [3.25, 3.5, 3.75, 3.99]) {
      const out = transitionVisualAt(edited, 'first', time)
      const incoming = transitionVisualAt(edited, 'second', 8 - time)
      assert.deepEqual(out, incoming, '切点两侧相同时距应有相同尺寸与透明度')
      assert.ok(out.scale >= 0.8 && out.scale <= 1)
      const left = (1 - out.scale) / 2 + out.translateX
      const top = (1 - out.scale) / 2 + out.translateY
      if (id.endsWith('-left')) assert.ok(Math.abs(left) < 1e-10)
      if (id.endsWith('-right')) assert.ok(Math.abs(left + out.scale - 1) < 1e-10)
      if (id.endsWith('-up')) assert.ok(Math.abs(top) < 1e-10)
      if (id.endsWith('-down')) assert.ok(Math.abs(top + out.scale - 1) < 1e-10)
    }
    const mid = transitionVisualAt(edited, 'first', 3.5)
    assert.equal(mid.scale, 0.9); assert.equal(mid.opacity, 0.5)
    effectClips(edited)[0].transition.easing = 'ease-in'
    const eased = transitionVisualAt(edited, 'second', 4.5)
    assert.equal(eased.opacity, 0.25)
    assert.ok(Math.abs(eased.scale - 0.85) < 1e-10)
    effectClips(edited)[0].transition.scope = 'outgoing'
    assert.equal(transitionVisualAt(edited, 'second', 4.5), undefined)
    assert.equal(projectDuration(edited), projectDuration(project))
  }
})

test('一次添加/调整可撤销和重做，历史保留完整转场引用', () => {
  const { project } = fixture()
  let history = createHistory(project)
  history = commitHistory(history, addTransition(project, 4, 'fade'))
  const transition = effectClips(history.present)[0]
  history = commitHistory(history, updateTransition(history.present, transition.id, 'zoom', 2))
  assert.equal(effectClips(undoHistory(history).present)[0].transition.effect, 'fade')
  assert.equal(effectClips(undoHistory(undoHistory(history)).present).length, 0)
  assert.equal(effectClips(redoHistory(undoHistory(history)).present)[0].transition.effect, 'zoom')
})


test('科普转场保持明确端点，保存重开支持形状、柔光与自定义参数', () => {
  const { project } = fixture()
  for (const id of ['iris', 'diamond', 'blinds', 'flash-white', 'defocus', 'zoom-through', 'diagonal', 'radial']) {
    const edited = validateProject(JSON.parse(JSON.stringify(addTransition(project, 4, id, 2))))
    const start = transitionVisualAt(edited, 'first', 3)
    const cut = transitionVisualAt(edited, 'second', 4)
    assert.equal(start.visibility, 1)
    assert.equal(start.opacity, 1)
    assert.equal(start.scale, 1)
    assert.equal(cut.visibility, 0)
    if (['flash-white', 'defocus', 'zoom-through'].includes(id)) assert.equal(cut.opacity, 0)
    assert.deepEqual(transitionVisualAt(edited, 'first', 3.3), transitionVisualAt(edited, 'second', 4.7))
    assert.equal(projectDuration(edited), projectDuration(project))
  }
  assert.equal(transitionVisual('iris', .5).aperture, 'circle')
  assert.equal(transitionVisual('diamond', .5).aperture, 'diamond')
  assert.equal(transitionVisual('zoom-through', 0).scale, 1.12)
  assert.equal(transitionVisual('zoom-through', .5).scale, 1.06)
  assert(transitionBlindRects(0).every(strip => strip.height === 0))
  assert(transitionBlindRects(1).every(strip => strip.height === 1 / 8))
  const halfway = transitionBlindRects(.5)
  assert(halfway[0].height > halfway[7].height, '各切片依次展开')
  const soft = addTransition(project, 4, 'defocus', 2)
  assert.equal(transitionVisualAt(soft, 'first', 3.5).blur, 16)
  effectClips(soft)[0].transition.blur = 0
  assert.equal(transitionVisualAt(soft, 'first', 3.5).blur, 0, '显式关闭柔化应保留')
  const flash = addTransition(project, 4, 'flash-white', 2)
  assert.equal(transitionVisualAt(flash, 'first', 3.5).color, '#fff9e8')
  effectClips(flash)[0].transition.color = '#ccbbaa'
  assert.equal(transitionVisualAt(flash, 'first', 3.5).color, '#ccbbaa')
})
