import test from 'node:test'
import assert from 'node:assert/strict'
import { createChromaKey, validateChromaKey, applyChromaKey, chromaKeyColor } from '../src/core/chroma-key.ts'
import { createProject, createClip, createTextClip, validateProject } from '../src/core/project.ts'
import { addAsset, addClip, updateClip, findClip, createHistory, commitHistory, undoHistory, redoHistory, splitClip, duplicateClip, moveClip } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

function fixture() {
  const blob = new Blob(['encoded fixture bytes'], { type: 'video/mp4' })
  const asset = { id: 'key-source', name: '绿幕素材.mp4', kind: 'video', url: URL.createObjectURL(blob), width: 320, height: 180, duration: 5, size: blob.size, mime: blob.type }
  let project = addAsset(createProject('抠像测试', { width: 320, height: 180 }), asset)
  const clip = createClip(asset, project)
  project = addClip(project, project.tracks.find(track => track.kind === 'video').id, clip)
  return { project, clip, asset, blob, cleanup: () => URL.revokeObjectURL(asset.url) }
}

test('抠像删除指定颜色，保留前景 RGB 与既有透明度，关闭后保持原样', () => {
  const source = [0, 255, 0, 255, 2, 248, 3, 128, 255, 30, 70, 96, 40, 60, 250, 0]
  const pixels = new Uint8ClampedArray(source)
  applyChromaKey(pixels, createChromaKey())
  assert.deepEqual([...pixels], [0, 255, 0, 0, 2, 248, 3, 0, 255, 30, 70, 96, 40, 60, 250, 0])
  for (const key of [undefined, createChromaKey({ enabled: false })]) {
    const unchanged = new Uint8ClampedArray(source)
    applyChromaKey(unchanged, key)
    assert.deepEqual([...unchanged], source)
  }
  assert.deepEqual(chromaKeyColor(createChromaKey({ color: '#FF0000' })), [1, 0, 0])
})

test('边缘柔化采用归一化 RGB 距离，零柔化是硬边，半透明源保留 alpha 比例', () => {
  const similarity = 0.1, blend = 0.2
  const key = createChromaKey({ similarity, blend })
  const pixels = new Uint8ClampedArray([50, 255, 0, 255, 100, 255, 0, 128, 160, 255, 0, 255])
  applyChromaKey(pixels, key)
  const alpha = (red, original) => Math.round(original * Math.max(0, Math.min(1, (red / 255 / Math.sqrt(3) - similarity) / blend)))
  assert.equal(pixels[3], alpha(50, 255))
  assert.equal(pixels[7], alpha(100, 128))
  assert.equal(pixels[11], alpha(160, 255))
  const hard = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 128])
  applyChromaKey(hard, createChromaKey({ blend: 0 }))
  assert.deepEqual([...hard], [0, 255, 0, 0, 255, 0, 0, 128])
})

test('抠像参数严格校验，关闭仍拒绝无效颜色、范围和任意滤镜文本', () => {
  for (const value of [null, [], {}, true, 'green']) assert.throws(() => validateChromaKey(value), /抠像/)
  for (const [field, values] of Object.entries({ enabled: [1, 'true', null], color: ['green', '#fff', '#12345678', '#00ff00;movie=x', null], similarity: [0, 1.1, Infinity, NaN, '0.2', null], blend: [-0.1, 1.1, '0.1', null], extra: [true] })) {
    for (const value of values) assert.throws(() => validateChromaKey({ ...createChromaKey({ enabled: false }), [field]: value }), /抠像/)
  }
  assert.equal(validateChromaKey({ ...createChromaKey(), color: '#AABBCC' }).color, '#aabbcc')
})

test('项目只允许视觉片段抠像，并在移至音轨时移除画面属性', () => {
  const { project, clip, cleanup } = fixture()
  try {
    assert.equal(findClip(validateProject(project), clip.id).clip.chromaKey, undefined)
    const key = createChromaKey()
    const changed = updateClip(project, clip.id, { chromaKey: key })
    assert.deepEqual(findClip(changed, clip.id).clip.chromaKey, key)
    const invalid = structuredClone(project)
    invalid.tracks[0].clips = [createTextClip(project, { chromaKey: key })]
    assert.throws(() => validateProject(invalid), /抠像只能用于/)
    const audioTrack = changed.tracks.find(track => track.kind === 'audio')
    const moved = moveClip(changed, clip.id, audioTrack.id, 0)
    assert.equal(findClip(moved, clip.id).clip.chromaKey, undefined)
    assert.deepEqual(findClip(changed, clip.id).clip.chromaKey, key)
    findClip(moved, clip.id).clip.chromaKey = key
    assert.throws(() => validateProject(moved), /抠像只能用于/)
  } finally { cleanup() }
})

test('抠像可撤销重做、分割复制、便携保存重开且不共享配置对象', async () => {
  const { project, clip, asset, blob, cleanup } = fixture()
  try {
    const key = createChromaKey({ color: '#2244dd', similarity: 0.3, blend: 0.12 })
    const changed = updateClip(project, clip.id, { chromaKey: key })
    const history = commitHistory(createHistory(project), changed)
    assert.equal(findClip(undoHistory(history).present, clip.id).clip.chromaKey, undefined)
    assert.deepEqual(findClip(redoHistory(undoHistory(history)).present, clip.id).clip.chromaKey, key)
    for (const result of [splitClip(changed, clip.id, 2), duplicateClip(changed, clip.id)]) {
      const clips = result.tracks.find(track => track.kind === 'video').clips
      assert.deepEqual(clips.map(item => item.chromaKey), [key, key])
      assert.notEqual(clips[0].chromaKey, clips[1].chromaKey)
    }
    const file = await exportProjectFile(changed)
    const imported = await importProjectFile(file)
    try {
      assert.deepEqual(findClip(imported.project, clip.id).clip.chromaKey, key)
      assert.deepEqual(await imported.blobs.get(asset.id).arrayBuffer(), await blob.arrayBuffer())
    } finally { imported.revoke() }
  } finally { cleanup() }
})
