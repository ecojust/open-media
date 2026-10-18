import test from 'node:test'
import assert from 'node:assert/strict'
import { recentVideoAssets, videoImportedTime, videoDuration, mergeStoredVideoAssets } from '../src/core/video-assets.ts'

test('视频素材按真实导入时间降序，同批和旧项目使用倒序加入顺序且不混入图片音频', () => {
  const assets = [
    { id: 'legacy-first', kind: 'video' },
    { id: 'older', kind: 'video', addedAt: '2026-10-18T09:00:00+08:00' },
    { id: 'audio', kind: 'audio', addedAt: '2030-01-01T00:00:00Z' },
    { id: 'same-first', kind: 'video', addedAt: '2026-10-18T02:00:00Z' },
    { id: 'image', kind: 'image', addedAt: '2030-01-01T00:00:00Z' },
    { id: 'newest', kind: 'video', addedAt: '2026-10-18T03:00:00Z' },
    { id: 'same-last', kind: 'video', addedAt: '2026-10-18T02:00:00Z' },
    { id: 'legacy-last', kind: 'video' },
  ]
  const before = structuredClone(assets)
  assert.deepEqual(recentVideoAssets(assets).map(asset => asset.id), ['newest', 'same-last', 'same-first', 'older', 'legacy-last', 'legacy-first'])
  assert.deepEqual(assets, before, '工作区展示排序不能重排项目素材或修改时间戳')
  assert.equal(videoImportedTime(assets[0]), '导入时间未记录')
  assert.equal(videoImportedTime({ addedAt: 'invalid' }), '导入时间未记录')
  assert.match(videoImportedTime(assets[5]), /2026/)
  assert.equal(videoDuration(125.7), '2:05')
})

test('目录视频按文件路径去重并保留工程标识、名称与预览，不改写工程', () => {
  const project = [{ id: 'project-recording', kind: 'video', nativePath: '/media/recording.mp4', name: '屏幕录制.mp4', url: 'blob:compatible', addedAt: '2026-10-18T09:00:00Z' }]
  const stored = [
    { id: 'library-recording', kind: 'video', nativePath: '/media/recording.mp4', name: 'recording.mp4', url: 'asset://recording', addedAt: '2026-10-17T09:00:00Z' },
    { id: 'other-project', kind: 'video', nativePath: '/media/other.mp4', addedAt: '2026-10-18T08:00:00Z' },
    { id: 'image', kind: 'image' },
  ]
  const before = structuredClone({ project, stored })
  const merged = mergeStoredVideoAssets(project, stored)
  assert.deepEqual(merged.map(asset => asset.id), ['other-project', 'project-recording'])
  assert.equal(merged[1].name, '屏幕录制.mp4')
  assert.equal(merged[1].url, 'blob:compatible')
  assert.equal(merged[1].addedAt, stored[0].addedAt)
  assert.deepEqual({ project, stored }, before)
})

test('视频路径在不同平台正确去重，网页素材保留', () => {
  const merged = mergeStoredVideoAssets([
    { id: 'windows-project', kind: 'video', nativePath: 'C:\\Media\\Record.MP4' },
    { id: 'web', kind: 'video', url: 'blob:recording' },
    { id: 'audio', kind: 'audio' },
  ], [
    { id: 'windows-library', kind: 'video', nativePath: 'c:/media/record.mp4' },
    { id: 'upper', kind: 'video', nativePath: '/media/Record.mp4' },
    { id: 'lower', kind: 'video', nativePath: '/media/record.mp4' },
  ])
  assert.deepEqual(new Set(merged.map(asset => asset.id)), new Set(['windows-project', 'web', 'upper', 'lower']))
})
