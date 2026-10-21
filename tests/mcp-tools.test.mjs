import test from 'node:test'
import assert from 'node:assert/strict'
import { MCP_TOOLS, executeProjectTool, inspectMcpProject, isProjectTool, validateMcpToolArguments } from '../src/core/mcp-tools.ts'
import { createClip, createProject, createSubtitleClip, validateProject } from '../src/core/project.ts'
import { addAsset, addClip, findClip, setTrack, projectDuration } from '../src/core/timeline.ts'
import { addTransition, TRANSITION_PRESETS } from '../src/core/transitions.ts'
import { applySpeechResults, planSpeech } from '../src/core/speech.ts'
import { MOTION_STYLES } from '../src/core/motion-style-catalog.ts'
import aiTools from '../src/mcp-ai-tools.json' with { type: 'json' }

function fixture() {
  let project = createProject('MCP 编辑', { width: 640, height: 360, fps: 30 })
  const video = { id: 'video-source', name: '场景.mp4', kind: 'video', url: 'blob:private-url', sourceUrl: 'https://private.example/?token=secret', nativePath: '/private/media.mp4', duration: 20, width: 640, height: 360, size: 500, mime: 'video/mp4' }
  const audio = { id: 'audio-source', name: '声音.wav', kind: 'audio', url: 'blob:audio', duration: 4, width: 0, height: 0, size: 100, mime: 'audio/wav' }
  project = addAsset(addAsset(project, video), audio)
  const textId = project.tracks[0].id, videoId = project.tracks[1].id, audioId = project.tracks[2].id
  project = addClip(project, videoId, createClip(video, project, { id: 'first', trimOut: 5 }))
  project = addClip(project, videoId, createClip(video, project, { id: 'second', start: 5, trimIn: 5, trimOut: 10 }))
  project = addClip(project, textId, createSubtitleClip(project, { id: 'subtitle-first', text: '测试第一段', trimOut: 3 }))
  project = addClip(project, textId, createSubtitleClip(project, { id: 'subtitle-second', text: '测试第二段', start: 5, trimOut: 2 }))
  return { project, textId, videoId, audioId, audio }
}
const exec = (project, tool, args = {}) => executeProjectTool(project, `open_media_${tool}`, args)

function assertUnchangedAfterFailure(project, tool, args, regex) {
  const before = structuredClone(project)
  assert.throws(() => exec(project, tool, args), regex)
  assert.deepEqual(project, before)
}

test('MCP catalog is unique, restrictive and contains the declared runtime and editing operations', () => {
  assert.equal(MCP_TOOLS.length, 99)
  assert.equal(new Set(MCP_TOOLS.map(tool => tool.name)).size, MCP_TOOLS.length)
  assert.equal(MCP_TOOLS.filter(tool => isProjectTool(tool.name)).length, 39)
  for (const tool of MCP_TOOLS) {
    assert.match(tool.name, /^open_media_[a-z_]+$/)
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean')
    assert.ok(tool.inputSchema.properties.expectedRevision)
    assert.deepEqual(tool.inputSchema.properties.expectedProjectId.type, 'string')
    assert.throws(() => validateMcpToolArguments(tool.name, { undocumented: true }), /不支持参数|缺少必填/)
  }
  assert.equal(isProjectTool('open_media_export_start'), false)
  for (const name of ['open_media_project_new', 'open_media_project_open']) assert.equal(MCP_TOOLS.some(tool => tool.name === name), false)
  const save = MCP_TOOLS.find(tool => tool.name === 'open_media_project_save')
  assert.deepEqual(Object.keys(save.inputSchema.properties).sort(), ['expectedProjectId', 'expectedRevision'])
})

test('shared AI tool contracts are identical to the published aggregate catalog', () => {
  assert.equal(aiTools.length, 7)
  for (const tool of aiTools) assert.deepEqual(MCP_TOOLS.find(item => item.name === tool.name), tool)
  for (const tool of aiTools.filter(item => item._meta['openmedia/execution'].mode === 'asynchronous')) {
    assert.equal(tool._meta['openmedia/execution'].pollingTool, 'open_media_job_get')
    assert.equal(tool._meta['openmedia/execution'].cancelTool, 'open_media_job_cancel')
  }
})

test('motion clip generation advertises real-video destinations, bounded inputs and distinct execution contracts', () => {
  const list = MCP_TOOLS.find(tool => tool.name === 'open_media_motion_style_list')
  const compose = MCP_TOOLS.find(tool => tool.name === 'open_media_motion_clip_generate')
  assert.equal(list.annotations.readOnlyHint, true)
  assert.equal(list._meta['openmedia/execution'].mode, 'synchronous')
  assert.equal(compose.annotations.readOnlyHint, false)
  assert.equal(compose.annotations.idempotentHint, false)
  assert.equal(compose._meta['openmedia/execution'].mode, 'asynchronous')
  assert.equal(compose._meta['openmedia/execution'].pollingTool, 'open_media_job_get')
  assert.equal(compose._meta['openmedia/execution'].cancelTool, 'open_media_job_cancel')
  assert.equal(MCP_TOOLS.some(tool => tool.name === 'open_media_motion_compose'), false)
  assert.equal(compose.inputSchema.properties.destination.default, 'assets')
  assert.deepEqual(compose.inputSchema.properties.destination.enum, ['assets', 'timeline'])
  assert.deepEqual(compose.inputSchema.properties.styleId.enum, MOTION_STYLES.map(style => style.id))
  const validate = args => validateMcpToolArguments(compose.name, args)
  const scene = { assetId: 'existing-video', heading: '标题', caption: '素材说明', duration: 4, trimIn: 1 }
  const base = { styleId: 'tech-hud', scenes: [scene] }
  assert.doesNotThrow(() => validate({ ...base, destination: 'timeline', insert: { trackId: 'existing-track', start: 12 }, title: '说明片', accent: '#abcdef', background: '#010203', textColor: '#FFFFFF', musicAssetId: 'existing-audio', musicVolume: 0.25, sourceAudio: true, tempo: 'energetic', logoAssetId: 'existing-image', dryRun: true, expectedRevision: 7, expectedProjectId: 'current-project' }))
  assert.doesNotThrow(() => validate({ ...base, scenes: Array.from({ length: 16 }, () => ({ ...scene, heading: '字'.repeat(120), caption: '字'.repeat(240), duration: 12 })) }))
  for (const patch of [
    { styleId: 'unknown-style' }, { scenes: [] }, { scenes: Array(17).fill(scene) },
    { scenes: [{ ...scene, duration: 1.99 }] }, { scenes: [{ ...scene, duration: 12.01 }] },
    { scenes: [{ ...scene, trimIn: -1 }] }, { scenes: [{ ...scene, duration: NaN }] },
    { scenes: [{ ...scene, heading: '字'.repeat(121) }] }, { scenes: [{ ...scene, caption: '字'.repeat(241) }] },
    { scenes: [{ assetId: '  ' }] }, { scenes: [{ ...scene, url: 'https://example.test/source.mp4' }] },
    { title: '字'.repeat(121) }, { accent: 'red' }, { textColor: '#fff' }, { background: 'url(file:///private/source)' },
    { musicVolume: -0.01 }, { musicVolume: 1.01 }, { placement: 'append' }, { tempo: 'random' },
    { destination: 'generated' }, { destination: 'timeline', insert: { trackId: ' ' } },
    { destination: 'timeline', insert: { start: -1 } }, { destination: 'timeline', insert: { start: Infinity } },
    { destination: 'timeline', insert: { start: 86401 } }, { destination: 'timeline', insert: { path: '/tmp/video.mp4' } },
    { outputPath: '/tmp/video.mp4' }, { project: { title: 'temporary-project' } },
    { width: 1920 }, { sourceAudio: 'yes' }, { dryRun: 'yes' },
  ]) assert.throws(() => validate({ ...base, ...patch }), undefined, JSON.stringify(patch))
  assert.throws(() => validateMcpToolArguments(list.name, { search: '字'.repeat(201) }), /长度/)
})

test('project inspection returns IDs and timing while omitting private asset capabilities', () => {
  const { project } = fixture()
  const { data } = exec(project, 'project_get')
  const json = JSON.stringify(data)
  for (const forbidden of ['private-url', 'private.example', '/private/', 'nativePath', 'sourceUrl']) assert.ok(!json.includes(forbidden))
  assert.equal(data.duration, 10)
  assert.equal(data.tracks[1].clips[0].end, 5)
  assert.equal(data.tracks[0].clipCount, 2)
  data.tracks[0].clips[0].text = '外部修改'
  assert.equal(findClip(project, 'subtitle-first').clip.text, '测试第一段')
  assert.deepEqual(exec(project, 'asset_list', { kind: 'audio' }).data.assets.map(asset => asset.id), ['audio-source'])
  assert.equal(inspectMcpProject(project).id, project.id)
})

test('strict arguments reject forged identity, provenance, unsafe values and incompatible variants before mutation', () => {
  const { project } = fixture()
  for (const patch of [{ id: 'hijack' }, { assetId: 'audio-source' }, { speech: { voiceId: 'fake' } }, { generatedAt: 'today' }, { transition: {} }, { x: NaN }, { color: 'url(http://bad)' }, { filters: { shell: 'x' } }]) {
    assertUnchangedAfterFailure(project, 'clip_update', { clipId: 'first', patch }, /不支持|格式|有效数字/)
  }
  assertUnchangedAfterFailure(project, 'clip_update', { clipId: 'first', patch: { text: '丢失的文字' } }, /文字属性/)
  assertUnchangedAfterFailure(project, 'clip_update', { clipId: 'first' }, /至少/)
  assertUnchangedAfterFailure(project, 'clip_trim', { clipId: 'first', trimIn: 0 }, /裁剪需提供/)
  assertUnchangedAfterFailure(project, 'clip_trim', { clipId: 'first', trimIn: 0, trimOut: 2, time: 1, side: 'start' }, /不能混用/)
  assert.throws(() => validateMcpToolArguments('open_media_speech_model', { action: 'repair' }), /modelId/)
  assert.throws(() => validateMcpToolArguments('open_media_export_start', { outputPath: 'x.mp4', format: 'mp4', quality: 'small' }), /选项/)
  assert.throws(() => validateMcpToolArguments('open_media_export_start', { outputPath: 'x.mp4', format: 'mp4', fps: 61 }), /范围/)
  assert.throws(() => validateMcpToolArguments('open_media_asset_import', { paths: ['/a', '/a'] }), /重复/)
  assert.throws(() => validateMcpToolArguments('open_media_project_get', { expectedRevision: -1 }), /范围/)
  for (const expectedProjectId of ['', ' ', 1, 'x'.repeat(201)]) assert.throws(() => validateMcpToolArguments('open_media_project_get', { expectedProjectId }), /长度|空白|文字/)
  for (const name of ['playback_set', 'speech_settings_set']) assert.throws(() => validateMcpToolArguments(`open_media_${name}`, { expectedProjectId: project.id, expectedRevision: 1 }), /至少提供/)
  assert.throws(() => validateMcpToolArguments('open_media_unknown', {}), /未知/)
  assert.throws(() => exec(project, 'playback_get'), /桌面运行时/)
})

test('pure project operations validate expected identity before inspecting or editing a project', () => {
  const { project } = fixture()
  for (const [tool, args] of [['project_get', {}], ['project_update', { patch: { title: '不应更新' } }]]) {
    assertUnchangedAfterFailure(project, tool, { ...args, expectedProjectId: 'another-project' }, /当前工程已变化/)
  }
  const next = exec(project, 'project_update', { expectedProjectId: project.id, patch: { title: '当前工程' } }).project
  assert.equal(next.id, project.id)
  assert.equal(next.title, '当前工程')
})

test('project settings resize actual geometry and revalidate transitions atomically', () => {
  const { project } = fixture()
  const next = exec(project, 'project_update', { patch: { width: 1280, height: 720, fps: 24, title: '更新工程', background: '#ffffff' } }).project
  assert.equal(next.width, 1280)
  assert.equal(findClip(next, 'first').clip.width, 1280)
  assert.equal(findClip(next, 'subtitle-first').clip.fontSize, 128)
  assert.equal(next.title, '更新工程')
  assert.equal(project.width, 640)
  assertUnchangedAfterFailure(project, 'project_update', { patch: { width: 0 } }, /范围/)
  const transition = addTransition(project, 5, 'fade', 2 / 30)
  const locked = setTrack(transition, transition.tracks.find(track => track.kind === 'transition').id, { locked: true })
  assertUnchangedAfterFailure(locked, 'project_update', { patch: { fps: 10 } }, /解锁转场/)
})

test('track add, order, mute, lock and remove use existing locking semantics', () => {
  const { project } = fixture()
  const added = exec(project, 'track_add', { kind: 'audio', name: '配乐', index: 0 })
  const id = added.selection.trackId
  assert.equal(added.project.tracks[0].id, id)
  const moved = exec(added.project, 'track_reorder', { trackId: id, index: 3 }).project
  assert.equal(moved.tracks[3].id, id)
  const locked = exec(moved, 'track_update', { trackId: id, patch: { muted: true, locked: true } }).project
  assert.equal(locked.tracks[3].muted, true)
  assertUnchangedAfterFailure(locked, 'track_remove', { trackId: id }, /解锁/)
  const unlocked = exec(locked, 'track_update', { trackId: id, patch: { locked: false } }).project
  assert.ok(!exec(unlocked, 'track_remove', { trackId: id }).project.tracks.some(track => track.id === id))
  assertUnchangedAfterFailure(project, 'track_reorder', { trackId: project.tracks[0].id, index: 99 }, /超出/)
})

test('clip add, duplicate, split, trim and move keep media and timing valid', () => {
  const { project, videoId, audioId } = fixture()
  const added = exec(project, 'clip_add', { trackId: videoId, assetId: 'video-source', options: { start: 10, trimIn: 10, trimOut: 15 } })
  const duplicate = exec(added.project, 'clip_duplicate', { clipId: added.selection.clipId, start: 15 })
  assert.equal(findClip(duplicate.project, duplicate.selection.clipId).clip.start, 15)
  const split = exec(duplicate.project, 'clip_split', { clipId: 'first', time: 2 })
  assert.equal(findClip(split.project, split.selection.clipId).clip.trimIn, 2)
  const trimmed = exec(split.project, 'clip_trim', { clipId: split.selection.clipId, side: 'start', time: 3 })
  assert.equal(findClip(trimmed.project, split.selection.clipId).clip.start, 3)
  const moved = exec(trimmed.project, 'clip_move', { clipId: duplicate.selection.clipId, trackId: audioId, start: 0 })
  assert.equal(findClip(moved.project, duplicate.selection.clipId).track.id, audioId)
  assert.deepEqual(validateProject(moved.project, { trusted: true }), moved.project)
  assertUnchangedAfterFailure(project, 'asset_remove', { assetId: 'video-source' }, /正在时间线/)
  assert.equal(exec(project, 'asset_remove', { assetId: 'audio-source' }).project.assets.length, 1)
})

test('subtitle style is inherited, edit is live, same-track apply preserves text and timing', () => {
  const { project, textId } = fixture()
  const changed = exec(project, 'clip_update', { clipId: 'subtitle-first', patch: { text: '文字已保存', fontSize: 42, color: '#ffcc00', background: '#202020', textVerticalAlign: 'top', x: 30 } }).project
  const added = exec(changed, 'text_add', { trackId: textId, text: '新增字幕', start: 8, duration: 2 })
  assert.equal(findClip(added.project, added.selection.clipId).clip.color, '#ffcc00')
  const applied = exec(added.project, 'subtitle_apply_style', { clipId: 'subtitle-first' }).project
  const second = findClip(applied, 'subtitle-second').clip
  assert.equal(second.fontSize, 42)
  assert.equal(second.text, '测试第二段')
  assert.equal(second.start, 5)
  const watermark = exec(applied, 'text_add', { trackId: textId, text: '品牌', role: 'watermark', style: { x: 0, y: 0 } })
  assert.equal(findClip(watermark.project, watermark.selection.clipId).clip.textRole, 'watermark')
  assertUnchangedAfterFailure(watermark.project, 'subtitle_apply_style', { clipId: watermark.selection.clipId }, /请选择字幕/)
})

test('filter and chroma patches merge defaults, support preset and clear safely', () => {
  const { project } = fixture()
  const next = exec(project, 'clip_update', { clipId: 'first', filterPreset: 'warm', patch: { filters: { intensity: 0.5 }, chromaKey: { color: '#00ff00', spillSuppression: true } } }).project
  const clip = findClip(next, 'first').clip
  assert.equal(clip.filters.temperature, 0.65)
  assert.equal(clip.filters.intensity, 0.5)
  assert.equal(clip.chromaKey.similarity, 0.18)
  const cleared = exec(next, 'clip_update', { clipId: 'first', patch: { filters: null, chromaKey: null } }).project
  assert.equal(findClip(cleared, 'first').clip.filters, undefined)
  assert.equal(findClip(cleared, 'first').clip.chromaKey, undefined)
  assert.equal(exec(project, 'filter_list').data.presets.length, 12)
})

test('transitions use nearest cut and reconcile deletion, with locked affected tracks rejecting atomically', () => {
  const { project } = fixture()
  assert.equal(exec(project, 'transition_list', { time: 4.8 }).data.nearestCut.time, 5)
  const added = exec(project, 'transition_add', { time: 4.8, effect: 'fade', duration: 2 })
  const transitionId = added.selection.clipId
  assert.equal(findClip(added.project, transitionId).clip.start, 4)
  const changed = exec(added.project, 'transition_update', { clipId: transitionId, effect: 'zoom', duration: 1 }).project
  assert.equal(findClip(changed, transitionId).clip.transition.effect, 'zoom')
  const locked = setTrack(changed, added.selection.trackId, { locked: true })
  assertUnchangedAfterFailure(locked, 'clip_remove', { clipId: 'first' }, /解锁转场/)
  assert.ok(!findClip(exec(changed, 'clip_remove', { clipId: 'first' }).project, transitionId))
  assert.ok(!findClip(exec(changed, 'transition_remove', { clipId: transitionId }).project, transitionId))
  assertUnchangedAfterFailure(project, 'transition_remove', { clipId: 'first' }, /不是转场/)
})

test('MCP discovers, adds and updates every new transition preset with matching schema choices', () => {
  const { project } = fixture()
  const presets = exec(project, 'transition_list').data.presets
  const expectedEffects = TRANSITION_PRESETS.map(preset => preset.id).sort()
  for (const name of ['open_media_transition_add', 'open_media_transition_update']) {
    assert.deepEqual([...MCP_TOOLS.find(tool => tool.name === name).inputSchema.properties.effect.enum].sort(), expectedEffects)
  }
  for (const effect of expectedEffects) {
    assert.ok(presets.some(preset => preset.id === effect))
    validateMcpToolArguments('open_media_transition_add', { time: 5, effect, duration: 2 })
    const added = exec(project, 'transition_add', { time: 5, effect, duration: 2 })
    const clip = findClip(added.project, added.selection.clipId).clip
    assert.equal(clip.transition.effect, effect)
    assert.equal(clip.start, 4)
    const args = { clipId: clip.id, effect, duration: 1 }
    validateMcpToolArguments('open_media_transition_update', args)
    assert.equal(findClip(exec(added.project, 'transition_update', args).project, clip.id).clip.trimOut, 1)
  }
})

test('audio loops can be lengthened and restored, ripple and global gaps preserve common occupancy', () => {
  const { project, audioId } = fixture()
  const added = exec(project, 'clip_add', { trackId: audioId, assetId: 'audio-source', options: { start: 15, trimOut: 12 } })
  assert.equal(projectDuration(added.project), 27)
  const restored = exec(added.project, 'clip_restore_audio_length', { clipId: added.selection.clipId }).project
  assert.equal(findClip(restored, added.selection.clipId).clip.trimOut, 4)
  const closed = exec(restored, 'timeline_close_gaps').project
  assert.equal(findClip(closed, added.selection.clipId).clip.start, 10)
  const removed = exec(closed, 'clip_remove', { clipId: added.selection.clipId, ripple: true }).project
  assert.equal(projectDuration(removed), 10)
})

test('speech eligibility reports placeholder subtitles, alignment uses genuine audio bindings', () => {
  const { project, audio } = fixture()
  const plan = exec(project, 'speech_plan', { clipIds: ['subtitle-first'] }).data
  assert.equal(plan.sources[0].text, '测试第一段')
  const speech = applySpeechResults(project, [{ source: planSpeech(project, ['subtitle-first']).sources[0], asset: { ...audio, id: 'speech-asset' }, voiceId: 'voice-test', rate: 1 }]).project
  const aligned = exec(speech, 'speech_align', { clipIds: ['subtitle-first'] }).project
  assert.equal(findClip(aligned, 'subtitle-first').clip.trimOut, 4)
  const placeholder = exec(project, 'clip_update', { clipId: 'subtitle-first', patch: { text: '' } }).project
  const validation = exec(placeholder, 'project_validate').data
  assert.equal(validation.valid, true)
  assert.equal(validation.subtitleIssues[0].reason, 'empty')
})

test('extract audio retains timing and volume, removes visual effects and mutes source atomically', () => {
  const { project, audioId, videoId } = fixture()
  const styled = exec(project, 'clip_update', { clipId: 'first', filterPreset: 'cinematic', patch: { volume: 0.7, speed: 1.25, fadeIn: 0.5, chromaKey: { color: '#00ff00' } } }).project
  const before = structuredClone(styled)
  const result = exec(styled, 'clip_extract_audio', { clipId: 'first' })
  const extracted = findClip(result.project, result.data.audioClipId)
  assert.equal(extracted.track.id, audioId)
  assert.equal(extracted.clip.assetId, 'video-source')
  assert.equal(extracted.clip.volume, .7)
  assert.equal(extracted.clip.speed, 1.25)
  assert.equal(extracted.clip.trimIn, 0)
  assert.equal(extracted.clip.trimOut, 5)
  assert.equal(extracted.clip.fadeIn, .5)
  assert.equal(extracted.clip.filters, undefined)
  assert.equal(extracted.clip.chromaKey, undefined)
  assert.equal(extracted.clip.transition, undefined)
  assert.equal(findClip(result.project, 'first').clip.volume, 0)
  assert.equal(findClip(result.project, 'first').clip.filters.temperature, -.2)
  assert.deepEqual(styled, before)
  const lockedAudio = setTrack(styled, audioId, { locked: true })
  const newTrack = exec(lockedAudio, 'clip_extract_audio', { clipId: 'first' })
  assert.notEqual(newTrack.data.trackId, audioId)
  assert.equal(newTrack.project.tracks.length, styled.tracks.length + 1)
  assertUnchangedAfterFailure(setTrack(project, videoId, { locked: true }), 'clip_extract_audio', { clipId: 'first' }, /解锁/)
  assertUnchangedAfterFailure(project, 'clip_extract_audio', { clipId: 'subtitle-first' }, /视频片段/)
})

test('material text and speech settings schema match actual implementation limits', () => {
  assert.throws(() => validateMcpToolArguments('open_media_material_add', { kind: 'video_segment', id: 'midnight-orbit', heading: '甲'.repeat(121) }), /长度/)
  assert.throws(() => validateMcpToolArguments('open_media_material_add', { kind: 'video_segment', id: 'midnight-orbit', subheading: '甲'.repeat(241) }), /长度/)
  assert.doesNotThrow(() => validateMcpToolArguments('open_media_material_add', { kind: 'video_segment', id: 'midnight-orbit', heading: '甲'.repeat(120), subheading: '甲'.repeat(240) }))
  assert.doesNotThrow(() => validateMcpToolArguments('open_media_material_list', { kind: 'transition_sound', search: '风掠', limit: 10 }))
  assert.doesNotThrow(() => validateMcpToolArguments('open_media_material_add', { kind: 'transition_sound', id: 'air-sweep', time: 4, transitionClipId: 'transition-1', anchor: 0.2 }))
  for (const patch of [{ start: 4 }, { duration: 1 }, { heading: '标题' }, { time: -1 }, { anchor: NaN }, { transitionClipId: '' }]) {
    assert.throws(() => validateMcpToolArguments('open_media_material_add', { kind: 'transition_sound', id: 'air-sweep', ...patch }), /start|时长|仅适用|范围|有效数字|长度/)
  }
  for (const patch of [{ time: 4 }, { transitionClipId: 'transition-1' }, { anchor: 0.2 }]) {
    assert.throws(() => validateMcpToolArguments('open_media_material_add', { kind: 'music', id: 'piano', ...patch }), /仅适用/)
  }
})
