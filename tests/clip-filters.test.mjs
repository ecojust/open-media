import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CLIP_FILTERS, CLIP_FILTER_PRESETS, getClipColorMatrix, getClipSvgColorMatrix, applyClipColorMatrix, isClipFilterIdentity, matchClipFilterPreset } from '../src/core/clip-filters.ts'
import { createProject, createClip, createTextClip, validateProject } from '../src/core/project.ts'
import { addAsset, addClip, updateClip, findClip, createHistory, commitHistory, undoHistory, redoHistory, splitClip, duplicateClip, moveClip } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

function fixture(kind = 'image') {
  const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR3sAAAAASUVORK5CYII=', 'base64'))
  const blob = new Blob([bytes], { type: kind === 'image' ? 'image/png' : 'video/webm' })
  const asset = { id: 'filter-asset', name: '滤镜测试素材', kind, url: URL.createObjectURL(blob), width: 320, height: 180, duration: 5, size: blob.size, mime: blob.type }
  let project = addAsset(createProject('滤镜测试', { width: 320, height: 180 }), asset)
  const clip = createClip(asset, project)
  project = addClip(project, project.tracks.find(track => track.kind === 'video').id, clip)
  return { project, clip, asset, blob, cleanup: () => URL.revokeObjectURL(asset.url) }
}

function pixels(values, filters) {
  const data = new Uint8ClampedArray(values)
  applyClipColorMatrix(data, getClipColorMatrix(filters))
  return [...data]
}

test('旧项目无滤镜、原色、关闭和零强度均保持原始 RGBA', () => {
  const source = [230, 40, 90, 112, 0, 255, 255, 0]
  const changed = { ...DEFAULT_CLIP_FILTERS, contrast: 2, saturation: 0, brightness: 0.8 }
  for (const filters of [undefined, DEFAULT_CLIP_FILTERS, { ...changed, enabled: false }, { ...changed, intensity: 0 }]) {
    assert.equal(isClipFilterIdentity(filters), true)
    assert.deepEqual(pixels(source, filters), source)
  }
  const { project, clip, cleanup } = fixture()
  try { assert.equal(findClip(validateProject(project), clip.id).clip.filters, undefined) } finally { cleanup() }
})

test('黑白按亮度加权转换，色温与色调不改变 alpha', () => {
  assert.deepEqual(pixels([255, 0, 0, 127, 0, 255, 0, 255, 0, 0, 255, 0], { ...DEFAULT_CLIP_FILTERS, saturation: 0 }), [54, 54, 54, 127, 182, 182, 182, 255, 18, 18, 18, 0])
  assert.deepEqual(pixels([100, 100, 100, 73], { ...DEFAULT_CLIP_FILTERS, temperature: 1, tint: 1 }), [138, 74, 87, 73])
  assert.deepEqual(pixels([128, 128, 128, 200], { ...DEFAULT_CLIP_FILTERS, contrast: 0, brightness: 0.1 }), [153, 153, 153, 200])
})

test('混合滤镜一次夹限并在最终颜色与原色间调整强度', () => {
  const filters = { ...DEFAULT_CLIP_FILTERS, intensity: 0.75, brightness: 0.08, contrast: 1.3, saturation: 0.65, temperature: 0.4, tint: -0.2, sepia: 0.3 }
  const matrix = getClipColorMatrix(filters)
  const expectedMatrix = [0.848533363675, 0.4159678536, 0.063166282725, -0.03552825, 0.143321654775, 1.0829761258, 0.058079719425, -0.04069725, 0.122892559725, 0.3409759782, 0.742703962075, -0.08900775]
  matrix.forEach((value, index) => assert.ok(Math.abs(value - expectedMatrix[index]) < 1e-10))
  assert.deepEqual(pixels([220, 90, 30, 110, 5, 200, 250, 255], filters), [217, 120, 57, 110, 94, 221, 232, 255])
  // Without the final-only clamp, contrast would lose this red highlight before reducing saturation.
  assert.deepEqual(pixels([255, 0, 0, 77], { ...DEFAULT_CLIP_FILTERS, contrast: 2, saturation: 0 }), [0, 0, 0, 77])
  assert.deepEqual(pixels([255, 0, 0, 77], { ...DEFAULT_CLIP_FILTERS, contrast: 2, saturation: 0, intensity: 0.5 }), [118, 0, 0, 77])
})

test('12 种预设参数有效、效果互异，强度和开关不影响预设匹配', () => {
  assert.equal(CLIP_FILTER_PRESETS.length, 12)
  assert.equal(new Set(CLIP_FILTER_PRESETS.map(preset => preset.id)).size, 12)
  assert.equal(new Set(CLIP_FILTER_PRESETS.map(preset => JSON.stringify(getClipColorMatrix(preset.filters)))).size, 12)
  const { project, clip, cleanup } = fixture()
  try {
    for (const preset of CLIP_FILTER_PRESETS) {
      assert.deepEqual(findClip(updateClip(project, clip.id, { filters: { ...preset.filters } }), clip.id).clip.filters, preset.filters)
      assert.equal(matchClipFilterPreset({ ...preset.filters, enabled: false, intensity: 0.33 }), preset.id)
    }
    assert.equal(matchClipFilterPreset({ ...DEFAULT_CLIP_FILTERS, brightness: 0.123 }), undefined)
  } finally { cleanup() }
})

test('项目拒绝错误滤镜字段、未知字段、非数值和越界值，关闭也不能绕过检查', () => {
  const { project, clip, cleanup } = fixture()
  try {
    const parameters = { intensity: [-0.1, 1.01], brightness: [-1.01, 1.01], contrast: [-0.01, 2.01], saturation: [-0.01, 2.01], temperature: [-1.01, 1.01], tint: [-1.01, 1.01], sepia: [-0.01, 1.01] }
    for (const [key, invalid] of Object.entries(parameters)) {
      for (const value of [...invalid, '1', null, undefined]) {
        const copy = structuredClone(project)
        findClip(copy, clip.id).clip.filters = { ...DEFAULT_CLIP_FILTERS, enabled: false, [key]: value }
        assert.throws(() => validateProject(copy), /滤镜/)
      }
    }
    for (const value of [null, [], { ...DEFAULT_CLIP_FILTERS, enabled: 'true' }, { ...DEFAULT_CLIP_FILTERS, saturation: Infinity }, { ...DEFAULT_CLIP_FILTERS, brightness: NaN }, { ...DEFAULT_CLIP_FILTERS, unknown: 0 }]) {
      const copy = structuredClone(project)
      findClip(copy, clip.id).clip.filters = value
      assert.throws(() => validateProject(copy), /滤镜/)
    }
  } finally { cleanup() }
})

test('滤镜仅允许视频轨道的图片和视频，不作用于字幕和音频轨道', () => {
  const { project, clip, cleanup } = fixture('video')
  try {
    const audio = structuredClone(project)
    const videoTrack = audio.tracks.find(track => track.kind === 'video')
    const audioTrack = audio.tracks.find(track => track.kind === 'audio')
    audioTrack.clips = videoTrack.clips
    videoTrack.clips = []
    audioTrack.clips[0].filters = { ...DEFAULT_CLIP_FILTERS }
    assert.throws(() => validateProject(audio), /滤镜只能用于/)
    const subtitle = structuredClone(project)
    subtitle.tracks.find(track => track.kind === 'text').clips.push(createTextClip(project, { filters: { ...DEFAULT_CLIP_FILTERS } }))
    assert.throws(() => validateProject(subtitle), /滤镜只能用于/)
    assert.ok(findClip(updateClip(project, clip.id, { filters: { ...DEFAULT_CLIP_FILTERS } }), clip.id).clip.filters)
  } finally { cleanup() }
})

test('滤镜保留在撤销重做、分割和复制中，后续修改不污染原片段', () => {
  const { project, clip, cleanup } = fixture()
  try {
    const filters = { ...CLIP_FILTER_PRESETS.find(preset => preset.id === 'warm').filters, intensity: 0.42 }
    const edited = updateClip(project, clip.id, { filters })
    const history = commitHistory(createHistory(project), edited)
    assert.equal(findClip(undoHistory(history).present, clip.id).clip.filters, undefined)
    assert.deepEqual(findClip(redoHistory(undoHistory(history)).present, clip.id).clip.filters, filters)
    for (const next of [splitClip(edited, clip.id, 2), duplicateClip(edited, clip.id)]) {
      const clips = next.tracks.find(track => track.kind === 'video').clips
      assert.deepEqual(clips.map(item => item.filters), [filters, filters])
      assert.notEqual(clips[0].filters, clips[1].filters)
      clips[1].filters.temperature = -1
      assert.equal(clips[0].filters.temperature, filters.temperature)
    }
    assert.equal(findClip(project, clip.id).clip.filters, undefined)
  } finally { cleanup() }
})

test('滤镜视频移至音轨后只保留音频属性，原项目和撤销记录保留滤镜', () => {
  const { project, clip, cleanup } = fixture('video')
  try {
    const filters = { ...CLIP_FILTER_PRESETS.find(preset => preset.id === 'warm').filters }
    const edited = updateClip(project, clip.id, { filters, volume: 0.6, speed: 1.5 })
    const audioTrack = edited.tracks.find(track => track.kind === 'audio')
    const moved = moveClip(edited, clip.id, audioTrack.id, 1)
    const result = findClip(moved, clip.id)
    assert.equal(result.track.kind, 'audio')
    assert.equal(result.clip.filters, undefined)
    assert.equal(result.clip.assetId, clip.assetId)
    assert.equal(result.clip.volume, 0.6)
    assert.equal(result.clip.speed, 1.5)
    assert.deepEqual(findClip(edited, clip.id).clip.filters, filters)
    assert.deepEqual(findClip(undoHistory(commitHistory(createHistory(edited), moved)).present, clip.id).clip.filters, filters)
  } finally { cleanup() }
})

test('便携项目文件保存和重新导入精确保留滤镜及素材字节', async () => {
  const { project, clip, asset, blob, cleanup } = fixture()
  try {
    const filters = { ...CLIP_FILTER_PRESETS.find(preset => preset.id === 'retro').filters, enabled: false, intensity: 0.57 }
    const file = await exportProjectFile(updateClip(project, clip.id, { filters }))
    const imported = await importProjectFile(file)
    try {
      assert.deepEqual(findClip(imported.project, clip.id).clip.filters, filters)
      assert.deepEqual(await imported.blobs.get(asset.id).arrayBuffer(), await blob.arrayBuffer())
    } finally { imported.revoke() }
  } finally { cleanup() }
})

test('SVG 缩略图使用同一 RGB 矩阵并维持透明度', () => {
  const filters = CLIP_FILTER_PRESETS.find(preset => preset.id === 'sunset').filters
  const matrix = getClipColorMatrix(filters), svg = getClipSvgColorMatrix(filters)
  assert.equal(svg.length, 20)
  for (let row = 0; row < 3; row++) assert.deepEqual(svg.slice(row * 5, row * 5 + 5), [...matrix.slice(row * 4, row * 4 + 3), 0, matrix[row * 4 + 3]])
  assert.deepEqual(svg.slice(15), [0, 0, 0, 1, 0])
})
