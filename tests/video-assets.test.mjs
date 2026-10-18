import test from 'node:test'
import assert from 'node:assert/strict'
import { recentVideoAssets, videoImportedTime, videoDuration } from '../src/core/video-assets.ts'

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
