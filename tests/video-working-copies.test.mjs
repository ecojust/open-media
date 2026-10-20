import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, validateProject } from '../src/core/project.ts'
import { addClip, addClips } from '../src/core/timeline.ts'
import { addEditorAssetToTimeline, projectSourceAssets } from '../src/core/editor-assets.ts'
import { workingVideoAsset, activeCompressedVideos } from '../src/core/video-working-copies.ts'
import { restoreProjectVideos } from '../src/core/project-video-compression.ts'
import { executeProjectTool } from '../src/core/mcp-tools.ts'

function fixture() {
  const project = createProject('先压缩再剪辑', { width: 1280, height: 720 })
  const original = { id: 'original', name: '录屏.mp4', kind: 'video', url: 'asset://localhost/original', nativePath: '/media/recordings/source.mp4', width: 1280, height: 720, duration: 600, size: 1500000000, mime: 'video/mp4' }
  const copy = { ...original, id: 'working', name: '录屏（质量压缩）.mp4', url: 'asset://localhost/working', nativePath: '/media/compressed/source.mp4', size: 400000000, compression: { originalAssetId: original.id, mode: 'quality', quality: 'high', createdAt: '2026-10-20T00:00:00.000Z', active: true } }
  project.assets.push(original, copy)
  return { project: validateProject(project, { trusted: true }), original, copy }
}

test('导入后未添加任何片段，也展示工作副本并用于后续拖入视频和原声轨道', () => {
  const { project, original, copy } = fixture(), before = structuredClone(project)
  assert.deepEqual(projectSourceAssets(project).map(asset => asset.id), [copy.id])
  for (const track of project.tracks.filter(track => track.kind !== 'text')) {
    const inserted = addEditorAssetToTimeline(project, original, { trackId: track.id, start: 4 })
    assert.equal(inserted.assetId, copy.id)
    assert.equal(inserted.addedAsset, false)
    assert.equal(inserted.project.tracks.find(item => item.id === track.id).clips[0].assetId, copy.id)
    assert.equal(inserted.project.assets.length, 2)
  }
  assert.deepEqual(project, before)
})

test('MCP和批量新增片段使用当前工作副本，仍保留指定的裁剪、速度和位置', () => {
  const { project, original, copy } = fixture(), track = project.tracks[1]
  const options = { trimIn: 30, trimOut: 50, start: 7, speed: 2, x: 100 }
  const result = executeProjectTool(project, 'open_media_clip_add', { trackId: track.id, assetId: original.id, options })
  const clip = result.project.tracks[1].clips[0]
  assert.equal(clip.assetId, copy.id)
  for (const [key, value] of Object.entries(options)) assert.equal(clip[key], value)
  const batch = addClips(project, track.id, [createClip(original, project, options), createClip(copy, project, { start: 50 })])
  assert.ok(batch.tracks[1].clips.every(item => item.assetId === copy.id))
})

test('录屏目录刷新后的不同ID仍按原路径找到已压缩副本，不重新登记或读取原视频', () => {
  const { project, original, copy } = fixture()
  const refreshed = { ...original, id: 'catalog-refreshed', name: '目录视频.mp4' }
  assert.equal(workingVideoAsset(project, refreshed).id, copy.id)
  const inserted = addEditorAssetToTimeline(project, refreshed)
  assert.equal(inserted.assetId, copy.id)
  assert.equal(inserted.addedAsset, false)
  assert.equal(inserted.project.assets.length, 2)
})

test('恢复后卡片和后续添加都采用原件，旧副本保留但不会自动重新启用', () => {
  const { project, original, copy } = fixture()
  const restored = restoreProjectVideos(project).project
  assert.deepEqual(projectSourceAssets(restored).map(asset => asset.id), [original.id])
  assert.equal(restored.assets.length, 2)
  assert.deepEqual(activeCompressedVideos(restored), [])
  assert.equal(addEditorAssetToTimeline(restored, original).assetId, original.id)
  assert.equal(addClip(restored, restored.tracks[1].id, createClip(copy, restored)).tracks[1].clips[0].assetId, original.id)
})

test('旧工程按时间线推断当前副本，没有使用的旧压缩文件不抢占新素材', () => {
  const { project, original, copy } = fixture()
  delete project.assets[1].compression.active
  assert.equal(workingVideoAsset(project, original).id, original.id)
  project.tracks[1].clips.push(createClip(copy, project))
  assert.equal(workingVideoAsset(project, original).id, copy.id)
  assert.deepEqual(projectSourceAssets(project).map(asset => asset.id), [copy.id])
})
