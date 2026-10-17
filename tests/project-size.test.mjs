import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createSubtitleClip, validateProject } from '../src/core/project.ts'
import { adoptFirstVideoSize } from '../src/core/project-size.ts'
import { addAssets, addClip, commitHistory, createHistory, redoHistory, undoHistory, updateClip } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

const video = (id, width, height) => ({ id, name: `${id}.webm`, kind: 'video', width, height, duration: 1, url: '', size: 0, mime: 'video/webm' })
const portrait = video('portrait', 1080, 1920), landscape = video('landscape', 3840, 2160)
function importAssets(project, assets) { return adoptFirstVideoSize(addAssets(project, assets), assets) }

test('默认项目仅跟随第一次有效视频的原始尺寸，横竖屏与批量导入均保持来源顺序', () => {
  const initial = createProject()
  assert.equal(initial.autoSizeFromVideo, true)
  for (const asset of [portrait, landscape, video('odd-size', 853, 479)]) {
    const next = importAssets(initial, [asset])
    assert.deepEqual([next.width, next.height, next.autoSizeFromVideo], [asset.width, asset.height, false])
    assert.equal(next.assets[0].id, asset.id)
    const later = importAssets(next, [video('later', 1280, 720)])
    assert.deepEqual([later.width, later.height], [asset.width, asset.height])
  }
  const batch = importAssets(initial, [portrait, landscape])
  assert.deepEqual([batch.width, batch.height], [1080, 1920])
  assert.equal(initial.autoSizeFromVideo, true)
  assert.deepEqual([initial.width, initial.height], [1920, 1080])
})

test('图片和音频不抢占源尺寸，无法用于项目尺寸的视频也不消耗首次匹配', () => {
  const initial = createProject()
  const other = [
    { ...portrait, id: 'still', name: 'still.png', kind: 'image', mime: 'image/png', duration: 0 },
    { ...portrait, id: 'sound', name: 'sound.wav', kind: 'audio', mime: 'audio/wav', width: 0, height: 0 },
  ]
  let next = importAssets(initial, other)
  assert.deepEqual([next.width, next.height, next.autoSizeFromVideo], [1920, 1080, true])
  next = importAssets(next, [video('tiny', 8, 8), video('oversized', 20000, 20000)])
  assert.equal(next.autoSizeFromVideo, true)
  next = importAssets(next, [portrait])
  assert.deepEqual([next.width, next.height, next.autoSizeFromVideo], [1080, 1920, false])
})

test('手动尺寸、旧项目与再次打开的已有项目均保持原设置，修改帧率不取消匹配', () => {
  for (const options of [{ width: 1280 }, { height: 720 }, { width: 2560, height: 1440 }]) {
    const project = createProject('自定尺寸', options)
    assert.equal(project.autoSizeFromVideo, false)
    const next = importAssets(project, [portrait])
    assert.deepEqual([next.width, next.height], [project.width, project.height])
  }
  const legacy = createProject()
  delete legacy.autoSizeFromVideo
  const reopened = validateProject(JSON.parse(JSON.stringify(legacy)), { trusted: true })
  assert.equal(reopened.autoSizeFromVideo, undefined)
  assert.deepEqual([importAssets(reopened, [portrait]).width, importAssets(reopened, [portrait]).height], [1920, 1080])
  const fps = createProject('高帧率', { fps: 60, background: '#ffffff' })
  assert.equal(importAssets(fps, [portrait]).width, 1080)
  assert.equal(importAssets(fps, [portrait]).fps, 60)
  assert.throws(() => validateProject({ ...fps, autoSizeFromVideo: 'true' }), /开关/)
})

test('首次导入按比例移动现有画面与字幕样式，不改内容、时间或音频几何，输入保持不可变', () => {
  let project = createProject()
  const subtitle = createSubtitleClip(project, { text: '沿用字幕配置', start: 2, color: '#ffcc55', textAlign: 'right' })
  project = addClip(project, project.tracks[0].id, subtitle)
  project = updateClip(project, subtitle.id, { x: 240, width: 1200 })
  const audio = { ...portrait, id: 'voice', kind: 'audio', width: 0, height: 0, mime: 'audio/wav' }
  project = addAssets(project, [audio])
  project = addClip(project, project.tracks[2].id, createClip(audio, project))
  const original = structuredClone(project)
  const next = importAssets(project, [portrait]), clip = next.tracks[0].clips[0]
  const sx = 1080 / 1920, sy = 1920 / 1080
  for (const item of [clip, next.subtitleStyle]) {
    assert.equal(item.x, 240 * sx); assert.equal(item.y, subtitle.y * sy)
    assert.equal(item.width, 1200 * sx); assert.equal(item.height, subtitle.height * sy)
    assert.equal(item.fontSize, subtitle.fontSize * sx)
    assert.equal(item.color, subtitle.color); assert.equal(item.textAlign, subtitle.textAlign)
  }
  assert.equal(clip.text, subtitle.text); assert.equal(clip.start, subtitle.start)
  assert.equal(clip.generatedAt, subtitle.generatedAt)
  assert.deepEqual(next.tracks[2], project.tracks[2])
  assert.deepEqual(project, original)
  const tiny = importAssets(project, [video('small', 16, 16)])
  assert.equal(tiny.tracks[0].clips[0].fontSize, 4)
})

test('源尺寸状态与导入一起撤销重做，并在项目文件中持久化', async () => {
  const initial = createProject()
  const next = importAssets(initial, [portrait])
  const history = commitHistory(createHistory(initial), next)
  const undo = undoHistory(history), redo = redoHistory(undo)
  assert.equal(undo.present.autoSizeFromVideo, true)
  assert.deepEqual([undo.present.width, undo.present.height], [1920, 1080])
  assert.equal(redo.present.autoSizeFromVideo, false)
  assert.deepEqual([redo.present.width, redo.present.height], [1080, 1920])
  for (const source of [initial, { ...next, assets: [] }]) {
    const loaded = await importProjectFile(await exportProjectFile(source))
    try {
      assert.equal(loaded.project.autoSizeFromVideo, source.autoSizeFromVideo)
      assert.deepEqual([loaded.project.width, loaded.project.height], [source.width, source.height])
    } finally { loaded.revoke() }
  }
})
