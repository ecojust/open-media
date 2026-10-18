import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, validateProject } from '../src/core/project.ts'
import { executeProjectTool, validateMcpToolArguments } from '../src/core/mcp-tools.ts'
import { executeTimelineBatch } from '../src/core/project-operations.ts'
import { commitHistory, createHistory, findClip, redoHistory, undoHistory, updateClip } from '../src/core/timeline.ts'
import { animatedClipAt } from '../src/core/visual-animation.ts'

const run = (project, tool, args) => executeProjectTool(project, `open_media_${tool}`, args)
const titleArgs = { preset: 'lower-third', text: '标题位置', start: 2, duration: 4, animation: 'slide' }
const operation = args => ({ tool: 'open_media_clip_update', arguments: args })
const batchContext = { revision: 7, execute: executeProjectTool }
const updaters = [
  ['项目工具', (project, id, patch, translate) => run(project, 'clip_update', {
    clipId: id, patch, ...(translate === undefined ? {} : { translatePositionKeyframes: translate }),
  }).project],
  ['共享时间线', (project, id, patch, translate) => updateClip(project, id, patch,
    translate === undefined ? undefined : { translatePositionKeyframes: translate })],
]

function clipOf(project, id) {
  const found = findClip(project, id)
  assert.ok(found, `片段 ${id} 应存在`)
  return found.clip
}

function fixture() {
  let project = createProject('标题定位', { width: 1080, height: 1920, fps: 30 })
  const asset = { id: 'video-source', kind: 'video', name: '场景', url: 'blob:video', duration: 8, width: 1080, height: 1920, size: 100, mime: 'video/mp4' }
  project.assets.push(asset)
  project.tracks.find(track => track.kind === 'video').clips.push(createClip(asset, project, { id: 'video-clip', start: 2, trimOut: 4 }))
  const added = run(project, 'title_add', titleArgs)
  project = added.project
  const ids = { title: added.selection.clipId, video: 'video-clip' }
  for (const [kind, id] of Object.entries(ids)) {
    Object.assign(clipOf(project, id), {
      x: 100, y: 500, width: 700, height: 210, opacity: 0.65,
      animationOffset: 0.25, fadeIn: 0.1, fadeOut: 0.2, rotation: 5,
      keyframes: {
        x: [{ time: 0, value: -20, easing: 'ease-in' }, { time: 0.5, value: 100, easing: 'step' }, { time: 2, value: 160 }],
        y: [{ time: 0, value: 596, easing: 'ease-out' }, { time: 0.5, value: 500, easing: 'ease-in-out' }, { time: 2, value: 530 }],
        opacity: [{ time: 0, value: 0 }, { time: 0.5, value: 0.8 }, { time: 4, value: 0.2 }],
        scaleX: [{ time: 0, value: 0.8, easing: 'ease-out' }, { time: 2, value: 1.2 }],
        scaleY: [{ time: 0, value: 1 }, { time: 2, value: 1.1 }],
        rotation: [{ time: 0, value: 5 }, { time: 2, value: 20 }],
        ...(kind === 'video' ? { volume: [{ time: 0, value: 0.4 }, { time: 2, value: 0.9 }] } : {}),
      },
    })
  }
  return { project: validateProject(project, { trusted: true }), ids }
}

function expectedTranslation(clip, patch) {
  const expected = structuredClone(clip)
  Object.assign(expected, patch)
  for (const axis of ['x', 'y']) {
    if (patch[axis] !== undefined && clip.keyframes?.[axis]) {
      expected.keyframes[axis] = clip.keyframes[axis].map(frame => ({ ...frame, value: frame.value + patch[axis] - clip[axis] }))
    }
  }
  return expected
}

function assertAtomicFailure(project, action, pattern = /范围|有效数字|格式|开关|布尔|boolean|不支持/) {
  const original = structuredClone(project)
  assert.throws(action, pattern)
  assert.deepEqual(project, original)
}

test('标题自定义绝对位置尺寸在生成动画前生效，slide 到达 y=1510', () => {
  const project = createProject('竖屏标题', { width: 1080, height: 1920 })
  const original = structuredClone(project)
  for (const animation of ['none', 'fade', 'slide', 'zoom']) {
    const result = run(project, 'title_add', { ...titleArgs, animation, x: 120, y: 1510, width: 840, height: 220 })
    const clip = clipOf(result.project, result.selection.clipId)
    assert.deepEqual({ x: clip.x, y: clip.y, width: clip.width, height: clip.height }, { x: 120, y: 1510, width: 840, height: 220 })
    const settled = animatedClipAt(clip, clip.start + 0.5)
    assert.deepEqual({ x: settled.x, y: settled.y, width: settled.width, height: settled.height }, { x: 120, y: 1510, width: 840, height: 220 })
    if (animation === 'slide') {
      assert.deepEqual(clip.keyframes.y, [{ time: 0, value: 1606, easing: 'ease-out' }, { time: 0.5, value: 1510 }])
      assert.equal(animatedClipAt(clip, clip.start + 0.25).y, 1534)
    }
    if (animation === 'none') assert.equal(clip.keyframes, undefined)
  }
  assert.deepEqual(project, original)
})

test('省略标题定位参数保留四类预设布局，单独指定 y 不改变其他默认几何', () => {
  const project = createProject('默认标题', { width: 1080, height: 1920 })
  for (const [preset, factor] of [['chapter', 0.39], ['lower-third', 0.72], ['corner', 0.06], ['subtitle', 0.72]]) {
    const result = run(project, 'title_add', { ...titleArgs, preset })
    const clip = clipOf(result.project, result.selection.clipId)
    assert.deepEqual({ x: clip.x, y: clip.y, width: clip.width, height: clip.height }, {
      x: project.width * 0.08, y: project.height * factor, width: project.width * 0.84, height: project.height * 0.22,
    })
    assert.equal(clip.keyframes.y.at(-1).value, clip.y)
    const moved = run(project, 'title_add', { ...titleArgs, preset, y: 1510 })
    const custom = clipOf(moved.project, moved.selection.clipId)
    assert.deepEqual([custom.x, custom.width, custom.height], [clip.x, clip.width, clip.height])
    assert.equal(custom.keyframes.y.at(-1).value, 1510)
  }
})

test('已有 slide 标题移动到 y=1510 后保持入场轨迹并落到新位置', () => {
  const added = run(createProject('移动标题', { width: 1080, height: 1920 }), 'title_add', titleArgs)
  const before = clipOf(added.project, added.selection.clipId)
  const result = run(added.project, 'clip_update', { clipId: before.id, patch: { y: 1510 }, translatePositionKeyframes: true })
  const after = clipOf(result.project, before.id)
  assert.deepEqual(after.keyframes.y, [{ time: 0, value: 1606, easing: 'ease-out' }, { time: 0.5, value: 1510 }])
  assert.deepEqual(after.keyframes.opacity, before.keyframes.opacity)
  assert.equal(animatedClipAt(after, after.start).y, 1606)
  assert.equal(animatedClipAt(after, after.start + 0.25).y, 1534)
  assert.equal(animatedClipAt(after, after.start + 0.5).y, 1510)
  assert.equal(animatedClipAt(after, after.start + 3).y, 1510)
  assert.equal(before.keyframes.y.at(-1).value, 1920 * 0.72)
})

test('标题位置尺寸接受边界像素值，非法值和 slide 关键帧溢出原子拒绝', () => {
  const project = createProject('标题边界', { width: 1080, height: 1920 })
  for (const geometry of [
    { x: -65536, y: 65536, width: 1, height: 65536 },
    { x: 65536, y: -65536, width: 65536, height: 1 },
    { x: -12.5, y: 1510.25, width: 840.5, height: 220.75 },
  ]) {
    const result = run(project, 'title_add', { ...titleArgs, animation: 'none', ...geometry })
    const clip = clipOf(result.project, result.selection.clipId)
    for (const [key, value] of Object.entries(geometry)) assert.equal(clip[key], value)
  }
  for (const geometry of [
    { x: -65537 }, { x: 65537 }, { y: -65537 }, { y: 65537 },
    { width: 0 }, { width: 65537 }, { height: 0 }, { height: 65537 },
    { x: NaN }, { y: Infinity }, { width: '840' }, { height: null },
  ]) assertAtomicFailure(project, () => run(project, 'title_add', { ...titleArgs, ...geometry }))
  assertAtomicFailure(project, () => run(project, 'title_add', { ...titleArgs, y: 65536 }))
  const locked = structuredClone(project)
  locked.tracks[0].locked = true
  assertAtomicFailure(locked, () => run(locked, 'title_add', { ...titleArgs, trackId: locked.tracks[0].id, y: 1510 }), /锁定|解锁/)
})

for (const [label, update] of updaters) {
  test(`${label}仅平移指定轴的标题与视频关键帧，并保留动画元数据和其他属性`, () => {
    const { project, ids } = fixture()
    const original = structuredClone(project)
    for (const id of Object.values(ids)) {
      const before = clipOf(project, id)
      for (const patch of [{ x: 430, y: 1510 }, { x: 430 }, { y: 1510 }]) {
        const next = update(project, id, patch, true)
        const after = clipOf(next, id)
        assert.deepEqual(after, expectedTranslation(before, patch))
        for (const elapsed of [0, 0.125, 0.5, 1, 3.5]) {
          const oldFrame = animatedClipAt(before, before.start + elapsed)
          const newFrame = animatedClipAt(after, after.start + elapsed)
          for (const axis of ['x', 'y']) {
            const delta = patch[axis] === undefined ? 0 : patch[axis] - before[axis]
            assert.ok(Math.abs(newFrame[axis] - oldFrame[axis] - delta) < 1e-9)
          }
          for (const key of ['width', 'height', 'rotation', 'opacity', 'volume']) assert.equal(newFrame[key], oldFrame[key])
        }
        for (const otherId of Object.values(ids).filter(other => other !== id)) assert.deepEqual(clipOf(next, otherId), clipOf(project, otherId))
      }
    }
    assert.deepEqual(project, original)
  })

  test(`${label}默认与显式 false 保留绝对关键帧语义`, () => {
    const { project, ids } = fixture()
    for (const id of Object.values(ids)) for (const translate of [undefined, false]) {
      const before = clipOf(project, id)
      const after = clipOf(update(project, id, { x: 430, y: 1510 }, translate), id)
      assert.deepEqual(after, { ...before, x: 430, y: 1510 })
      for (const elapsed of [0, 0.5, 2]) {
        const oldFrame = animatedClipAt(before, before.start + elapsed)
        const newFrame = animatedClipAt(after, after.start + elapsed)
        assert.deepEqual([newFrame.x, newFrame.y], [oldFrame.x, oldFrame.y])
      }
    }
  })

  test(`${label}普通片段与缺少位置动画的片段不创建关键帧`, () => {
    const { project, ids } = fixture()
    for (const id of Object.values(ids)) {
      delete clipOf(project, id).keyframes
      delete clipOf(project, id).animationOffset
      let next = update(project, id, { x: 430, y: 1510 }, true)
      assert.deepEqual(clipOf(next, id), { ...clipOf(project, id), x: 430, y: 1510 })
      assert.equal(clipOf(next, id).keyframes, undefined)
      clipOf(project, id).keyframes = { opacity: [{ time: 0, value: 0.2 }, { time: 2, value: 0.8 }] }
      next = update(project, id, { x: 430, y: 1510 }, true)
      assert.deepEqual(clipOf(next, id).keyframes, clipOf(project, id).keyframes)
    }
  })

  test(`${label}未指定位置时保留动画，关键帧越界和锁定时所有属性原子回滚`, () => {
    const { project, ids } = fixture()
    for (const id of Object.values(ids)) {
      const before = clipOf(project, id)
      const after = clipOf(update(project, id, { width: 800, opacity: 0.4 }, true), id)
      assert.deepEqual(after, { ...before, width: 800, opacity: 0.4 })
      for (const patch of [{ x: 65536, y: 1510, opacity: 0.4 }, { x: -65536 }, { y: 65536 }]) {
        assertAtomicFailure(project, () => update(project, id, patch, true))
      }
      const negative = structuredClone(project)
      clipOf(negative, id).keyframes.y[0].value = -65530
      assertAtomicFailure(negative, () => update(negative, id, { x: 430, y: 490 }, true))
      const locked = structuredClone(project)
      findClip(locked, id).track.locked = true
      assertAtomicFailure(locked, () => update(locked, id, { x: 430, y: 1510 }, true), /解锁/)
    }
  })
}

test('关键帧平移开关仅接受工具顶层布尔值', () => {
  const args = { clipId: 'video-clip', patch: { y: 1510 } }
  for (const flag of [true, false]) assert.doesNotThrow(() => validateMcpToolArguments('open_media_clip_update', { ...args, translatePositionKeyframes: flag }))
  for (const flag of [1, 'true', null]) assert.throws(() => validateMcpToolArguments('open_media_clip_update', { ...args, translatePositionKeyframes: flag }), /布尔|开关|boolean|格式/)
  assert.throws(() => validateMcpToolArguments('open_media_clip_update', { ...args, patch: { y: 1510, translatePositionKeyframes: true } }), /不支持/)
})

test('共享时间线拒绝同时替换与平移关键帧，原项目保持完整', () => {
  const { project, ids } = fixture()
  assertAtomicFailure(project, () => updateClip(project, ids.title, {
    y: 1510, keyframes: { y: [{ time: 0, value: 1606 }, { time: 0.5, value: 1510 }] },
  }, { translatePositionKeyframes: true }), /同时|关键帧/)
})

test('标题位置与动画平移一次提交，撤销和重做恢复整个项目', () => {
  const { project, ids } = fixture()
  const initial = createHistory(project)
  const next = run(initial.present, 'clip_update', { clipId: ids.title, patch: { x: 430, y: 1510 }, translatePositionKeyframes: true }).project
  const history = commitHistory(initial, next)
  assert.equal(history.past.length, 1)
  assert.deepEqual(clipOf(history.present, ids.title), expectedTranslation(clipOf(project, ids.title), { x: 430, y: 1510 }))
  const undone = undoHistory(history)
  assert.deepEqual(undone.present, project)
  assert.equal(undone.past.length, 0)
  assert.deepEqual(redoHistory(undone).present, next)
  assert.deepEqual(initial.present, project)
})

test('同一标题连续两次批量定位按最新基础位置平移，只需一次历史提交', () => {
  const { project, ids } = fixture()
  const original = structuredClone(project)
  const initial = createHistory(project)
  const seen = []
  const result = executeTimelineBatch(initial.present, {
    expectedRevision: 7,
    operations: [
      operation({ clipId: ids.title, patch: { x: 200, y: 800 }, translatePositionKeyframes: true }),
      operation({ clipId: ids.title, patch: { x: 430, y: 1510 }, translatePositionKeyframes: true }),
    ],
  }, { revision: 7, execute(source, name, args) {
    seen.push([clipOf(source, ids.title).x, clipOf(source, ids.title).y])
    return executeProjectTool(source, name, args)
  } })
  assert.deepEqual(seen, [[100, 500], [200, 800]])
  assert.deepEqual(clipOf(result.project, ids.title), expectedTranslation(clipOf(project, ids.title), { x: 430, y: 1510 }))
  assert.equal(result.data.results.length, 2)
  assert.equal(result.data.baseRevision, 7)
  assert.deepEqual(initial, createHistory(project))
  const history = commitHistory(initial, result.project)
  assert.equal(history.past.length, 1)
  const undone = undoHistory(history)
  assert.deepEqual(undone.present, original)
  assert.equal(undone.past.length, 0)
  assert.deepEqual(redoHistory(undone).present, result.project)
  assert.deepEqual(project, original)
})

test('批量位置预检与第二步关键帧越界均不修改原项目或历史', () => {
  const { project, ids } = fixture()
  const original = structuredClone(project)
  const history = createHistory(project)
  const originalHistory = structuredClone(history)
  const first = operation({ clipId: ids.title, patch: { y: 1510 }, translatePositionKeyframes: true })
  const second = operation({ clipId: ids.video, patch: { x: 430, y: 1510 }, translatePositionKeyframes: true })
  const dryRun = executeTimelineBatch(history.present, { dryRun: true, operations: [first, second] }, batchContext)
  assert.equal(dryRun.project, undefined)
  assert.equal(dryRun.selection, undefined)
  assert.equal(dryRun.data.dryRun, true)
  assert.equal(dryRun.data.valid, true)
  assert.equal(dryRun.data.operationCount, 2)
  assert.deepEqual(history, originalHistory)
  const overflowing = operation({ clipId: ids.title, patch: { x: 65536, opacity: 0.4 }, translatePositionKeyframes: true })
  for (const dryRunFlag of [false, true]) {
    assert.throws(() => executeTimelineBatch(history.present, { dryRun: dryRunFlag, operations: [first, overflowing] }, batchContext), /第 2 项.*全部修改均未写入/)
    assert.deepEqual(history, originalHistory)
    assert.deepEqual(project, original)
  }
})
