import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, validateProject } from '../src/core/project.ts'
import { addTrack, commitHistory, createHistory, removeTrack, reorderTrack, undoHistory } from '../src/core/timeline.ts'
import { trackZIndex } from '../src/core/track-layers.ts'

// There is one source of truth: editing array order is also compositing order.
test('默认轨道以主画面为底层，文字处于上层，z-index 从数组顺序派生', () => {
  const project = createProject()
  assert.deepEqual(project.tracks.map(track => track.kind), ['video', 'audio', 'text'])
  assert.deepEqual(project.tracks.map(track => trackZIndex(project, track.id)), [0, 1, 2])
  assert.equal(trackZIndex(project, 'missing'), -1)
})

test('排序、增删、保存与撤销同步层级，不保留独立的过期 z-index', () => {
  const original = createProject()
  const video = original.tracks[0]
  const reordered = reorderTrack(original, video.id, original.tracks.length - 1)
  assert.equal(trackZIndex(reordered, video.id), 2)
  assert.equal(trackZIndex(original, video.id), 0)
  const restored = validateProject(JSON.parse(JSON.stringify(reordered)), { trusted: true })
  assert.deepEqual(restored.tracks.map(track => track.id), reordered.tracks.map(track => track.id))
  const appended = addTrack(restored, 'video', '装饰')
  assert.equal(trackZIndex(appended, appended.tracks.at(-1).id), 3)
  const removed = removeTrack(appended, appended.tracks[0].id)
  assert.equal(trackZIndex(removed, appended.tracks.at(-1).id), 2)
  assert.deepEqual(undoHistory(commitHistory(createHistory(original), reordered)).present, original)
})
