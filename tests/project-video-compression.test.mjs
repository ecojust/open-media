import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { createClip, createProject, createSubtitleClip, validateProject } from '../src/core/project.ts'
import { commitHistory, createHistory, undoHistory, redoHistory } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'
import { saveProject, loadProject } from '../src/core/storage.ts'
import { prepareSnapshotRestore } from '../src/core/project-snapshots.ts'
import { applyProjectVideoCompression, compressionSummary, prepareProjectCompressionTool, projectCompressionSources, projectCompressedSources, restoreProjectVideos } from '../src/core/project-video-compression.ts'
import { isSharedEditorTool } from '../src/core/editor-tool-service.ts'
import { projectWorkingAssets, workingVideoAsset } from '../src/core/video-working-copies.ts'
import { MCP_TOOLS, validateMcpToolArguments } from '../src/core/mcp-tools.ts'
import projectTools from '../src/mcp-project-tools.json' with { type: 'json' }

function source(id = 'source', size = 1000) { return { id, name: `${id}.mp4`, kind: 'video', url: `asset://localhost/${id}.mp4`, nativePath: `/media/${id}.mp4`, width: 1280, height: 720, duration: 600, size, mime: 'video/mp4' } }
function fixture() {
  const project = createProject('工程压缩', { width: 1280, height: 720, fps: 30 }), video = source()
  project.assets.push(video)
  project.tracks[1].clips.push(createClip(video, project, { id: 'part-one', trimOut: 120, x: 33, volume: .8, keyframes: { x: [{ time: 0, value: 33 }, { time: 3, value: 50 }] } }), createClip(video, project, { id: 'part-two', start: 120, trimIn: 120, trimOut: 600 }))
  project.tracks[2].clips.push(createClip(video, project, { id: 'original-sound', trimIn: 100, trimOut: 130, start: 200, volume: .5 }))
  project.tracks[0].clips.push(createSubtitleClip(project, { id: 'subtitle', text: '不修改字幕', start: 50 }))
  return project
}
function output(id = 'compressed', size = 400) { return { ...source(id, size), sourceUrl: undefined } }
function item(asset = output(), sourceIds = ['source']) { return { state: 'completed', sourceIds, sourceSize: 1000, outputSize: asset.size, asset } }
function done(items = [item()]) { return { id: 'compression-job', state: 'completed', progress: 1, stage: '已完成', current: items.length, total: items.length, elapsedSeconds: 1, items } }
function context(project = fixture(), controller = new AbortController()) { return { project, revision: 1, blobs: new Map(), source: 'gui', signal: controller.signal, onProgress() {} } }
function dependencies(overrides = {}) {
  const calls = [], native = {
    async beginProjectVideoCompression(request) { calls.push(['begin', request]); return done() },
    async getProjectVideoCompressionJob(id) { calls.push(['get', id]); return done() },
    async cancelProjectVideoCompression(id) { calls.push(['cancel', id]) },
    async acceptProjectVideoCompression(id) { calls.push(['accept', id]) },
    async discardProjectVideoCompression(id) { calls.push(['discard', id]) },
    async prepareProjectCompressionAsset(asset) { calls.push(['preview', asset.id]); return asset },
    async prepareProjectVideoOriginal(asset) { calls.push(['restore-preview', asset.id]); return asset },
    ...overrides,
  }
  return { native, calls, pollMs: 0 }
}
const prepare = (project, deps, args = { mode: 'quality', quality: 'high' }, ctx = context(project)) => prepareProjectCompressionTool('open_media_project_video_compress', args, ctx, deps)
const sourceReferences = project => project.tracks.flatMap(track => track.clips).filter(clip => clip.assetId).map(clip => clip.assetId)

test('默认包含已导入但未剪辑的视频，分割视频与其原声只压缩一次', () => {
  const project = fixture(); project.assets.push(source('unused'))
  assert.deepEqual(projectCompressionSources(project).map(asset => asset.id), ['source', 'unused'])
  assert.deepEqual(compressionSummary(project), { sourceCount: 2, compressedCount: 0, sourceBytes: 2000, currentBytes: 2000 })
  assert.deepEqual(projectCompressionSources(project, ['unused']).map(asset => asset.id), ['unused'])
  assert.throws(() => projectCompressionSources(project, ['source', 'source']), /不重复/)
  assert.throws(() => projectCompressionSources(project, ['missing']), /不存在/)
})

test('所有分段与原声同时切换新ID，时间线其余属性完全保持，原件内容未改', () => {
  const project = fixture(), before = structuredClone(project)
  const result = applyProjectVideoCompression(project, projectCompressionSources(project), [item()], 'quality', 'high')
  assert.deepEqual(sourceReferences(result.project), ['compressed', 'compressed', 'compressed'])
  const restoredClips = structuredClone(result.project.tracks)
  for (const track of restoredClips) for (const clip of track.clips) if (clip.assetId === 'compressed') clip.assetId = 'source'
  assert.deepEqual(restoredClips, before.tracks)
  assert.deepEqual(result.project.assets[0], before.assets[0]); assert.deepEqual(project, before)
  assert.equal(result.assets[0].compression.originalAssetId, 'source')
  assert.deepEqual(compressionSummary(result.project), { sourceCount: 1, compressedCount: 1, sourceBytes: 1000, currentBytes: 400 })
  assert.equal(result.report.savedBytes, 600)
})

test('同一原文件多个ID共享一份输出，但恢复各自原ID且按文件统计', () => {
  const project = fixture(), alias = { ...project.assets[0], id: 'source-alias', name: '另一个素材名.mp4' }
  project.assets.push(alias); project.tracks[1].clips[1].assetId = alias.id
  const result = applyProjectVideoCompression(project, projectCompressionSources(project), [item(output(), ['source', 'source-alias'])], 'quality', 'balanced')
  assert.equal(result.assets.length, 2)
  assert.equal(result.assets[0].nativePath, result.assets[1].nativePath)
  assert.notEqual(result.assets[0].id, result.assets[1].id)
  assert.deepEqual(result.assets.map(asset => asset.compression.originalAssetId), ['source', 'source-alias'])
  assert.equal(result.report.processedCount, 1); assert.equal(result.report.outputBytes, 400)
  assert.equal(compressionSummary(result.project).currentBytes, 400)
  assert.deepEqual(restoreProjectVideos(result.project).project.tracks, project.tracks)
})

test('明确选一个源时也更新同路径别名，恢复不混淆归属', () => {
  const project = fixture(), alias = { ...project.assets[0], id: 'alias' }; project.assets.push(alias); project.tracks[2].clips[0].assetId = alias.id
  const result = applyProjectVideoCompression(project, projectCompressionSources(project, ['source']), [item()], 'quality')
  assert.equal(result.assets.length, 2)
  assert.deepEqual(restoreProjectVideos(result.project).project.tracks, project.tracks)
})

test('重复压缩始终从最初原件读取，恢复和历史操作都保留文件引用', () => {
  const original = fixture()
  const first = applyProjectVideoCompression(original, projectCompressionSources(original), [item()], 'quality', 'high').project
  assert.deepEqual(projectCompressionSources(first).map(asset => asset.id), ['source'])
  const second = applyProjectVideoCompression(first, projectCompressionSources(first), [item(output('compressed-again', 300))], 'quality', 'compact').project
  assert.equal(second.assets.at(-1).compression.originalAssetId, 'source')
  const restored = restoreProjectVideos(second)
  assert.equal(restored.project.assets.length, 3)
  assert.deepEqual(restored.project.tracks, original.tracks)
  const history = commitHistory(createHistory(second), restored.project)
  assert.deepEqual(undoHistory(history).present, second)
  assert.deepEqual(redoHistory(undoHistory(history)).present, restored.project)
})

test('较大文件跳过不替换素材，结果报告保留原因', async () => {
  const deps = dependencies({ beginProjectVideoCompression: async () => done([{ sourceIds: ['source'], sourceSize: 1000, outputSize: 1200, state: 'skipped', message: '没有缩小' }]) })
  const result = await prepare(fixture(), deps)
  assert.equal(result.project, undefined); assert.equal(result.data.processedCount, 0); assert.equal(result.data.skippedCount, 1)
  assert.equal(result.data.savedBytes, 0); assert.equal(result.data.outputBytes, 1000)
  assert.equal(result.data.items[0].message, '没有缩小'); await result.accept()
  assert.deepEqual(deps.calls, [['accept', 'compression-job']])
})

test('不完整、重复ID、更大或尺寸改变的输出不产生部分工程', () => {
  const project = fixture(), before = structuredClone(project), roots = projectCompressionSources(project)
  for (const items of [[], [item(), item(output('duplicate'))], [item({ ...output(), id: 'source' })], [item(output('bigger', 1200))], [item({ ...output(), width: 640 })]]) assert.throws(() => applyProjectVideoCompression(project, roots, items, 'quality'), /结果|标识|缩小/)
  assert.deepEqual(project, before)
})

test('锁定视频或原声音轨预检查，压缩前拒绝且恢复不会绕过锁定', async () => {
  const project = fixture(), deps = dependencies(); project.tracks[2].locked = true
  await assert.rejects(prepare(project, deps), /解锁/); assert.deepEqual(deps.calls, [])
  project.tracks[2].locked = false
  const compressed = applyProjectVideoCompression(project, projectCompressionSources(project), [item()], 'quality').project
  compressed.tracks[1].locked = true
  assert.throws(() => restoreProjectVideos(compressed), /解锁/)
})

test('成功处理仅准备结果，接收后保留文件，原件和预览URL独立', async () => {
  const project = fixture(), before = structuredClone(project), deps = dependencies(), stages = []
  const result = await prepare(project, deps, { mode: 'quality' }, { ...context(project), onProgress: update => stages.push(update) })
  assert.deepEqual(project, before); assert.equal(deps.calls.some(call => call[0] === 'accept'), false)
  assert.equal(result.assets[0].asset.nativePath, '/media/compressed.mp4')
  assert.notEqual(result.assets[0].asset.url, project.assets[0].url)
  assert.equal(result.assets[0].asset.sourceUrl, undefined)
  assert.ok(stages.some(stage => stage.stage.includes('预览')))
  await result.accept(); assert.equal(deps.calls.at(-1)[0], 'accept')
})

test('开始调用返回前取消仍清理迟到的工作副本', async () => {
  const controller = new AbortController(), deps = dependencies({ beginProjectVideoCompression: async () => { controller.abort(); return done() } })
  await assert.rejects(prepare(fixture(), deps, { mode: 'lossless' }, context(fixture(), controller)), /abort/i)
  assert.ok(deps.calls.some(call => call[0] === 'cancel')); assert.ok(deps.calls.some(call => call[0] === 'discard'))
  assert.equal(deps.calls.some(call => call[0] === 'accept'), false)
})

test('预览生成期间取消或版本变化不会提交，输出被清理', async () => {
  const project = fixture(), controller = new AbortController(), deps = dependencies({ prepareProjectCompressionAsset: async asset => { controller.abort(); return asset } })
  await assert.rejects(prepare(project, deps, { mode: 'quality' }, context(project, controller)), /abort/i)
  assert.ok(deps.calls.some(call => call[0] === 'discard'))
  let current = true
  const stale = dependencies({ beginProjectVideoCompression: async () => { current = false; return done() } })
  await assert.rejects(prepare(project, stale, { mode: 'quality' }, { ...context(project), assertCurrent() { if (!current) throw Error('版本变化') } }), /版本变化/)
  assert.ok(stale.calls.some(call => call[0] === 'discard'))
})

test('失败、无效输出和预览失败均不保留工作文件', async () => {
  for (const override of [{ beginProjectVideoCompression: async () => ({ ...done(), state: 'failed', error: '编码失败' }) }, { prepareProjectCompressionAsset: async () => { throw Error('预览失败') } }, { beginProjectVideoCompression: async () => done([item({ ...output(), duration: 590 })]) }]) {
    const deps = dependencies(override)
    await assert.rejects(prepare(fixture(), deps))
    assert.ok(deps.calls.some(call => call[0] === 'discard'))
    assert.equal(deps.calls.some(call => call[0] === 'accept'), false)
  }
})

test('非原生素材先通过流式素材准备，避免把大视频读入内存', async () => {
  const project = fixture(); delete project.assets[0].nativePath
  const deps = dependencies(), materialized = []
  deps.materialize = async (projectId, asset, ctx) => { materialized.push({ projectId, assetId: asset.id, signal: ctx.signal }); return { ...asset, nativePath: '/media/materialized.mp4' } }
  const result = await prepare(project, deps)
  assert.equal(materialized.length, 1)
  assert.equal(deps.calls.find(call => call[0] === 'begin')[1].assets[0].nativePath, '/media/materialized.mp4')
  await result.discard()
})

test('元数据校验保留来源关系，拒绝自引用、循环、缺失原件和无损质量', () => {
  const project = applyProjectVideoCompression(fixture(), projectCompressionSources(fixture()), [item()], 'quality', 'high').project
  assert.equal(validateProject(project, { trusted: true }).assets[1].compression.originalAssetId, 'source')
  assert.equal(validateProject(project).assets[1].compression.originalAssetId, 'source')
  for (const patch of [{ originalAssetId: 'compressed' }, { originalAssetId: 'missing' }, { mode: 'lossless', quality: 'high' }]) {
    const bad = structuredClone(project); Object.assign(bad.assets[1].compression, patch)
    assert.throws(() => validateProject(bad), /原视频|原件|无损/)
  }
  const bad = structuredClone(project); bad.assets[0].compression = { ...bad.assets[1].compression, originalAssetId: 'compressed' }
  assert.throws(() => validateProject(bad), /原件/)
})

test('保存重开和快照恢复后原件关联仍可正确恢复', async () => {
  const project = applyProjectVideoCompression(fixture(), projectCompressionSources(fixture()), [item()], 'quality', 'high').project
  const blobs = new Map(project.assets.map(asset => [asset.id, new Blob([new Uint8Array(asset.size)], { type: asset.mime })]))
  const archive = await exportProjectFile(project, { blobs }), imported = await importProjectFile(archive)
  assert.equal(imported.project.assets[1].compression.originalAssetId, imported.project.assets[0].id)
  const snapshot = prepareSnapshotRestore(imported)
  try {
    assert.notEqual(snapshot.project.assets[0].id, 'source')
    assert.equal(snapshot.project.assets[1].compression.originalAssetId, snapshot.project.assets[0].id)
    const restored = restoreProjectVideos(snapshot.project)
    assert.ok(sourceReferences(restored.project).every(id => id === snapshot.project.assets[0].id))
  } finally { snapshot.revoke() }
})

test('本地草稿保存压缩关系但不复制已有原生大文件', async () => {
  globalThis.indexedDB = new IDBFactory()
  const original = fixture(), project = applyProjectVideoCompression(original, projectCompressionSources(original), [item()], 'quality').project
  await saveProject(project)
  const loaded = await loadProject(project.id)
  try { assert.equal(loaded.blobs.size, 0); assert.deepEqual(restoreProjectVideos(loaded.project).project.tracks, original.tracks) }
  finally { loaded.revoke() }
})

test('压缩与恢复MCP共用任务协议，架构声明与实际工具清单一致', () => {
  for (const name of ['open_media_project_video_compress', 'open_media_project_video_restore']) {
    assert.equal(isSharedEditorTool(name), true)
    assert.deepEqual(MCP_TOOLS.find(tool => tool.name === name), projectTools.find(tool => tool.name === name))
    assert.equal(MCP_TOOLS.find(tool => tool.name === name)._meta['openmedia/execution'].mode, 'asynchronous')
  }
  assert.throws(() => validateMcpToolArguments('open_media_project_video_compress', { mode: 'lossless', quality: 'high' }), /无损/)
  assert.throws(() => validateMcpToolArguments('open_media_project_video_compress', { mode: 'quality', quality: 'bad' }), /选项/)
  assert.throws(() => validateMcpToolArguments('open_media_project_video_restore', { assetIds: [] }), /数量/)
})


test('未加入时间线即可压缩，激活剪辑副本，恢复与撤销不依赖片段引用', async () => {
  const original = createProject('先压缩再剪辑'), video = source()
  original.assets.push(video)
  const prepared = await prepare(original, dependencies())
  const project = prepared.project
  assert.equal(project.tracks.flatMap(track => track.clips).length, 0)
  assert.equal(project.assets[1].compression.active, true)
  assert.deepEqual(project.assets[0], video)
  assert.equal(workingVideoAsset(project, video).id, 'compressed')
  assert.deepEqual(projectWorkingAssets(project).map(asset => asset.id), ['compressed'])
  assert.deepEqual(compressionSummary(project), { sourceCount: 1, compressedCount: 1, sourceBytes: 1000, currentBytes: 400 })
  const restored = await prepareProjectCompressionTool('open_media_project_video_restore', {}, context(project), dependencies())
  assert.equal(restored.data.restoredCount, 1)
  assert.equal(restored.project.assets[1].compression.active, false)
  assert.equal(workingVideoAsset(restored.project, video).id, 'source')
  assert.deepEqual(projectWorkingAssets(restored.project).map(asset => asset.id), ['source'])
  assert.equal(compressionSummary(restored.project).compressedCount, 0)
  const history = commitHistory(createHistory(project), restored.project)
  assert.equal(workingVideoAsset(undoHistory(history).present, video).id, 'compressed')
  assert.equal(workingVideoAsset(redoHistory(undoHistory(history)).present, video).id, 'source')
})

test('重复压缩只激活最新副本，跳过不会改变原有工作副本，未使用的库素材不参与默认压缩', () => {
  const original = createProject('预处理'), video = source()
  original.assets.push(video, { ...source('watermark'), libraryRole: 'watermark' })
  assert.deepEqual(projectCompressionSources(original).map(asset => asset.id), ['source'])
  const first = applyProjectVideoCompression(original, [video], [item()], 'quality').project
  const second = applyProjectVideoCompression(first, [video], [item(output('smaller', 250))], 'quality').project
  assert.equal(second.assets.find(asset => asset.id === 'compressed').compression.active, false)
  assert.equal(second.assets.find(asset => asset.id === 'smaller').compression.active, true)
  assert.deepEqual(projectCompressedSources(second).map(asset => asset.id), ['smaller'])
  assert.deepEqual(projectWorkingAssets(second).map(asset => asset.id), ['smaller', 'watermark'])
  const skipped = applyProjectVideoCompression(second, [video], [{ state: 'skipped', sourceIds: [video.id], sourceSize: video.size }], 'lossless').project
  assert.equal(workingVideoAsset(skipped, video).id, 'smaller')
  const duplicateActive = structuredClone(second); duplicateActive.assets[2].compression.active = true
  assert.throws(() => validateProject(duplicateActive), /只能启用一个/)
  const badActive = structuredClone(second); badActive.assets[3].compression.active = 'yes'
  assert.throws(() => validateProject(badActive), /开关/)
})

test('显式恢复后旧副本不会重新激活，旧工程仅由时间线识别当前压缩副本', () => {
  const original = fixture(), compressed = applyProjectVideoCompression(original, projectCompressionSources(original), [item()], 'quality').project
  delete compressed.assets[1].compression.active
  assert.equal(projectCompressedSources(compressed).length, 1)
  assert.equal(workingVideoAsset(compressed, compressed.assets[0]).id, 'compressed')
  const restored = restoreProjectVideos(compressed)
  assert.equal(restored.report.restoredCount, 1)
  assert.equal(restored.project.assets[1].compression.active, false)
  assert.equal(workingVideoAsset(restored.project, restored.project.assets[1]).id, 'source')
  compressed.tracks.forEach(track => { track.clips = [] })
  assert.equal(projectCompressedSources(compressed).length, 0)
  assert.equal(workingVideoAsset(compressed, compressed.assets[0]).id, 'source')
})

test('空时间线工作副本经保存、重开和快照恢复后仍会被用于剪辑', async () => {
  const original = createProject('预处理存档'); original.assets.push(source())
  const project = applyProjectVideoCompression(original, projectCompressionSources(original), [item()], 'quality').project
  const blobs = new Map(project.assets.map(asset => [asset.id, new Blob([new Uint8Array(asset.size)], { type: asset.mime })]))
  const imported = await importProjectFile(await exportProjectFile(project, { blobs }))
  const snapshot = prepareSnapshotRestore(imported)
  try {
    assert.equal(snapshot.project.assets[1].compression.active, true)
    assert.equal(workingVideoAsset(snapshot.project, snapshot.project.assets[0]).id, snapshot.project.assets[1].id)
    assert.equal(restoreProjectVideos(snapshot.project).report.restoredCount, 1)
  } finally { snapshot.revoke() }
})

test('恢复先准备可播放原视频，失败、取消或版本冲突不提交半恢复工程', async () => {
  const original = fixture(), compressed = applyProjectVideoCompression(original, projectCompressionSources(original), [item()], 'quality').project
  const before = structuredClone(compressed)
  const prepared = await prepareProjectCompressionTool('open_media_project_video_restore', {}, context(compressed), dependencies({
    prepareProjectVideoOriginal: async asset => ({ ...asset, url: 'asset://localhost/original-preview.mp4', sourceUrl: asset.url }),
  }))
  assert.ok(sourceReferences(prepared.project).every(id => id === 'source'))
  assert.equal(prepared.project.assets[0].url, 'asset://localhost/original-preview.mp4')
  assert.equal(prepared.project.assets[0].sourceUrl, original.assets[0].url)
  assert.equal(prepared.project.assets[0].nativePath, original.assets[0].nativePath)
  assert.deepEqual(compressed, before)
  for (const failure of ['failure', 'cancel', 'revision']) {
    const controller = new AbortController(), ctx = context(compressed, controller)
    if (failure === 'revision') ctx.assertCurrent = () => { if (revisionChanged) throw Error('项目已变化') }
    let revisionChanged = false
    const deps = dependencies({ prepareProjectVideoOriginal: async asset => {
      if (failure === 'failure') throw Error('无法准备原片')
      if (failure === 'cancel') controller.abort()
      revisionChanged = true
      return asset
    } })
    await assert.rejects(prepareProjectCompressionTool('open_media_project_video_restore', {}, ctx, deps))
    assert.deepEqual(compressed, before)
  }
})
