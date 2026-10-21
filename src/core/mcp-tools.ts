import catalog from '../mcp-tools.json' with { type: 'json' }
import { cloneProject, createClip, createSubtitleClip, createTextClip, createTrack, newId, validateProject } from './project.ts'
import { addClip, addTrack, applySubtitleStyleToTrack, clipDuration, clipEnd, deleteClip, duplicateClip, findClip, moveClip, projectDuration, removeAsset, removeTrack, reorderTrack, setTrack, splitClip, trimClip, updateClip } from './timeline.ts'
import { closeTimelineGaps, deleteClipAndCloseGap, restoreAudioClipLength, trimClipAtPlayhead } from './timeline-editing.ts'
import { resizeProject } from './project-size.ts'
import { CLIP_FILTER_PRESETS, DEFAULT_CLIP_FILTERS } from './clip-filters.ts'
import { DEFAULT_CHROMA_KEY } from './chroma-key.ts'
import { addTransition, findTransitionCut, reconcileTransitions, TRANSITION_PRESETS, updateTransition } from './transitions.ts'
import { trackSubtitleIssues } from './subtitle-validation.ts'
import { alignTextToSpeech, planSpeech, validateSpeechPlanCapacity } from './speech.ts'
import { executeVisualTool } from './visual-tools.ts'
import { setTimelineMarkers } from './project-operations.ts'
import { classifyVideoClip } from './clip-idle.ts'
import { getMcpMotionBrief } from './mcp-motion.ts'
import type { Clip, ClipChromaKey, ClipFilters, MediaAsset, Project, Track, TrackKind, TransitionEffect } from './types.ts'

export interface McpSchema {
  type?: string
  properties?: Record<string, McpSchema>
  required?: string[]
  additionalProperties?: boolean
  minProperties?: number
  items?: McpSchema
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  enum?: unknown[]
  anyOf?: McpSchema[]
}
export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: McpSchema
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
}
export const MCP_TOOLS = catalog as unknown as McpToolDefinition[]
const definitions = new Map(MCP_TOOLS.map(tool => [tool.name, tool]))

/** Enforce exactly the documented schema before any editor or native action. */
function validateSchema(value: unknown, schema: McpSchema, path: string): void {
  const invalid = (message: string): never => { throw new Error(`${path}: ${message}`) }
  if (schema.anyOf) {
    if (!schema.anyOf.some(branch => { try { validateSchema(value, branch, path); return true } catch { return false } })) invalid('参数不匹配允许的格式。')
    return
  }
  if (schema.enum && !schema.enum.includes(value)) invalid('参数不在允许的选项中。')
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('必须为对象。')
      const object = value as Record<string, unknown>
      const keys = Object.keys(object)
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) invalid('至少需要提供一个修改字段。')
      for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) invalid(`缺少必填参数 ${key}。`)
      for (const key of keys) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          if (schema.additionalProperties === false) invalid(`不支持参数 ${key}。`)
        } else validateSchema(object[key], schema.properties![key]!, `${path}.${key}`)
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) invalid('必须为数组。')
      const array = value as unknown[]
      if (schema.minItems !== undefined && array.length < schema.minItems || schema.maxItems !== undefined && array.length > schema.maxItems) invalid('数组项目数量超出允许范围。')
      if (schema.uniqueItems && new Set(array.map(item => JSON.stringify(item))).size !== array.length) invalid('数组不能包含重复项。')
      if (schema.items) array.forEach((item, index) => validateSchema(item, schema.items!, `${path}[${index}]`))
      break
    }
    case 'string': {
      if (typeof value !== 'string') invalid('必须为文字。')
      const string = value as string
      if (string.includes('\0')) invalid('文字不能包含空字符。')
      if (schema.minLength !== undefined && string.length < schema.minLength || schema.maxLength !== undefined && string.length > schema.maxLength) invalid('文字长度超出允许范围。')
      if (schema.minLength && !string.trim()) invalid('文字不能为空白。')
      if (schema.pattern && !new RegExp(schema.pattern).test(string)) invalid('文字格式无效。')
      break
    }
    case 'number': case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value)) invalid('必须为有效数字。')
      if (schema.minimum !== undefined && (value as number) < schema.minimum || schema.maximum !== undefined && (value as number) > schema.maximum) invalid('数字超出允许范围。')
      break
    case 'boolean': if (typeof value !== 'boolean') invalid('必须为开关值。'); break
    case 'null': if (value !== null) invalid('必须为 null。'); break
    default: invalid('工具参数定义无效。')
  }
}

export function validateMcpToolArguments(name: string, args: unknown): Record<string, unknown> {
  const tool = definitions.get(name)
  if (!tool) throw new Error(`未知的 MCP 工具：${name}`)
  validateSchema(args, tool.inputSchema, name)
  const result = args as Record<string, unknown>
  if (name === 'open_media_clip_update' && !result.filterPreset && !Object.keys((result.patch ?? {}) as object).length) throw new Error('至少提供一个片段属性或滤镜预设。')
  if (name === 'open_media_clip_trim') {
    const source = result.trimIn !== undefined || result.trimOut !== undefined
    const playhead = result.side !== undefined || result.time !== undefined
    if (source === playhead || source && (result.trimIn === undefined || result.trimOut === undefined) || playhead && (result.side === undefined || result.time === undefined)) throw new Error('裁剪需提供 trimIn 和 trimOut，或 side 和 time，不能混用。')
  }
  if (name === 'open_media_speech_model' && result.action !== 'status' && !result.modelId) throw new Error('此模型操作需要 modelId。')
  if (name === 'open_media_project_video_compress' && result.mode === 'lossless' && result.quality !== undefined) throw new Error('无损压缩不能指定有损质量。')
  if (['open_media_playback_set', 'open_media_speech_settings_set'].includes(name) && !Object.keys(result).some(key => !['expectedRevision', 'expectedProjectId'].includes(key))) throw new Error('至少提供一个设置字段。')
  if (name === 'open_media_material_add') {
    if (result.kind === 'video_segment' && result.start !== undefined) throw new Error('视频片段通过 placement 指定前插或后插，不使用 start。')
    if (result.kind !== 'video_segment' && ['placement', 'heading', 'subheading', 'titleLayout'].some(key => result[key] !== undefined)) throw new Error('placement、heading、subheading 和 titleLayout 仅适用于视频片段模板。')
    if (result.kind !== 'transition_sound' && ['time', 'transitionClipId', 'anchor'].some(key => result[key] !== undefined)) throw new Error('time、transitionClipId 和 anchor 仅适用于转场音效。')
    if (result.kind === 'transition_sound' && result.start !== undefined) throw new Error('转场音效通过 time 或 transitionClipId 选择切点，不使用 start。')
    if (result.kind === 'transition_sound' && result.duration !== undefined) throw new Error('转场音效的时长请通过音频片段属性调整。')
  }
  return result
}

const VISUAL_TOOLS = new Set(['clip_keyframes_set', 'clip_crop', 'focus_region', 'overlay_add', 'title_add', 'template_customize', 'clip_freeze_frame', 'clip_speed_ramp', 'transition_parameters_set'].map(name => `open_media_${name}`))
const PROJECT_TOOLS = new Set([
  ...VISUAL_TOOLS, 'open_media_timeline_markers_set', ...[
  'project_get', 'project_validate', 'project_update', 'asset_list', 'asset_remove', 'track_add', 'track_update', 'track_remove', 'track_reorder',
  'clip_add', 'text_add', 'clip_update', 'clip_move', 'clip_split', 'clip_classify', 'clip_trim', 'clip_duplicate', 'clip_remove', 'clip_restore_audio_length', 'clip_extract_audio',
  'subtitle_apply_style', 'timeline_close_gaps', 'filter_list', 'transition_list', 'transition_add', 'transition_update', 'transition_remove', 'speech_plan', 'speech_align',
].map(name => `open_media_${name}`)])
export function isProjectTool(name: string): boolean { return PROJECT_TOOLS.has(name) }
export interface McpProjectToolResult {
  project?: Project
  data: unknown
  label?: string
  selection?: { trackId?: string; clipId?: string }
}

function publicAsset(asset: MediaAsset): Omit<MediaAsset, 'url' | 'sourceUrl' | 'nativePath'> {
  const { url: _url, sourceUrl: _sourceUrl, nativePath: _nativePath, ...metadata } = asset
  return { ...metadata }
}
/** Return a detached view without capability URLs or local filesystem paths. */
export function inspectMcpProject(project: Project) {
  const copy = cloneProject(project)
  return { ...copy, assets: copy.assets.map(publicAsset), duration: projectDuration(project), mcpMotionBrief: getMcpMotionBrief(project),
    tracks: copy.tracks.map(track => ({ ...track, clipCount: track.clips.length, clips: track.clips.map(clip => ({ ...clip, duration: clipDuration(clip), end: clipEnd(clip) })), subtitleIssues: trackSubtitleIssues(track) })) }
}
function requireTrack(project: Project, id: string): Track {
  const track = project.tracks.find(track => track.id === id)
  if (!track) throw new Error('轨道不存在。')
  return track
}
function requireClip(project: Project, id: string) {
  const result = findClip(project, id)
  if (!result) throw new Error('片段不存在。')
  return result
}
function requireAsset(project: Project, id: string) {
  const asset = project.assets.find(asset => asset.id === id)
  if (!asset) throw new Error('素材不存在。')
  return asset
}
function changed(project: Project, data: unknown, label: string, selection?: McpProjectToolResult['selection']): McpProjectToolResult {
  return { project, data, label, ...(selection ? { selection } : {}) }
}
function editedClip(project: Project, clipId: string, label: string): McpProjectToolResult {
  const { clip, track } = requireClip(project, clipId)
  return changed(project, { trackId: track.id, clip: JSON.parse(JSON.stringify(clip)), duration: clipDuration(clip) }, label, { clipId, trackId: track.id })
}

/** Pure transaction: the input project is never changed, including validation failures. */
export function executeProjectTool(project: Project, name: string, rawArgs: unknown): McpProjectToolResult {
  const { expectedProjectId, ...args } = validateMcpToolArguments(name, rawArgs)
  if (expectedProjectId !== undefined && expectedProjectId !== project.id) throw new Error(`当前工程已变化：当前 projectId=${project.id}，请先重新读取当前工程。`)
  if (!isProjectTool(name)) throw new Error('此工具需要桌面运行时执行。')
  if (VISUAL_TOOLS.has(name)) {
    const result = executeVisualTool(project, name, args)
    return { ...result, selection: result.selection ? { clipId: result.selection } : undefined }
  }
  if (name === 'open_media_timeline_markers_set') return setTimelineMarkers(project, args as unknown as Parameters<typeof setTimelineMarkers>[1])
  const string = (key: string) => args[key] as string
  const number = (key: string) => args[key] as number
  switch (name) {
    case 'open_media_project_get': return { data: inspectMcpProject(project) }
    case 'open_media_project_validate': {
      const errors: string[] = []
      try { validateProject(project, { trusted: true }) } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
      const subtitleIssues = project.tracks.flatMap(track => trackSubtitleIssues(track).map(issue => ({ trackId: track.id, ...issue })))
      return { data: { valid: !errors.length, errors, subtitleIssues } }
    }
    case 'open_media_project_update': {
      const patch = args.patch as Partial<Pick<Project, 'title' | 'width' | 'height' | 'fps' | 'background'>>
      let next = cloneProject(project)
      if (patch.width !== undefined || patch.height !== undefined) next = resizeProject(next, patch.width ?? next.width, patch.height ?? next.height)
      Object.assign(next, patch)
      reconcileTransitions(next, project)
      next.updatedAt = new Date().toISOString()
      next = validateProject(next, { trusted: true })
      return changed(next, { title: next.title, width: next.width, height: next.height, fps: next.fps, background: next.background }, '更新项目设置')
    }
    case 'open_media_asset_list': return { data: { assets: project.assets.filter(asset => !args.kind || asset.kind === args.kind).map(publicAsset) } }
    case 'open_media_asset_remove': requireAsset(project, string('assetId')); return changed(removeAsset(project, string('assetId')), { removedAssetId: args.assetId }, '移除素材')
    case 'open_media_track_add': {
      const track = createTrack(string('kind') as TrackKind, args.name as string | undefined)
      let next = addTrack(project, track)
      if (args.index !== undefined) next = reorderTrack(next, track.id, number('index'))
      return changed(next, { track }, '添加轨道', { trackId: track.id })
    }
    case 'open_media_track_update': {
      const next = setTrack(project, string('trackId'), args.patch as Partial<Pick<Track, 'name' | 'muted' | 'locked'>>)
      return changed(next, { track: JSON.parse(JSON.stringify(requireTrack(next, string('trackId')))) }, '更新轨道')
    }
    case 'open_media_track_remove': return changed(removeTrack(project, string('trackId')), { removedTrackId: args.trackId }, '删除轨道')
    case 'open_media_track_reorder': {
      if (number('index') >= project.tracks.length) throw new Error('目标轨道位置超出当前轨道数量。')
      return changed(reorderTrack(project, string('trackId'), number('index')), { trackId: args.trackId, index: args.index }, '调整轨道顺序')
    }
    case 'open_media_clip_add': {
      const track = requireTrack(project, string('trackId'))
      if (track.kind !== 'video' && track.kind !== 'audio') throw new Error('媒体片段只能添加到视频或音频轨道。')
      const clip = createClip(requireAsset(project, string('assetId')), project, (args.options ?? {}) as Partial<Clip>)
      return editedClip(addClip(project, track.id, clip), clip.id, '添加媒体片段')
    }
    case 'open_media_text_add': {
      const track = requireTrack(project, string('trackId'))
      if (track.kind !== 'text') throw new Error('字幕或文字水印只能添加到文字轨道。')
      const options: Partial<Clip> = { ...(args.style as Partial<Clip> ?? {}), text: string('text'), start: number('start') ?? 0, trimOut: number('duration') ?? 5, textRole: args.role === 'watermark' ? 'watermark' : 'subtitle' }
      if (args.name !== undefined) options.name = string('name')
      const clip = options.textRole === 'watermark' ? createTextClip(project, options) : createSubtitleClip(project, options)
      return editedClip(addClip(project, track.id, clip), clip.id, options.textRole === 'watermark' ? '添加文字水印' : '添加字幕')
    }
    case 'open_media_clip_update': {
      const { clip, track } = requireClip(project, string('clipId'))
      const input = (args.patch ?? {}) as Record<string, unknown>
      const textFields = ['text', 'textRole', 'fontSize', 'fontFamily', 'fontWeight', 'color', 'background', 'textAlign', 'textVerticalAlign']
      if (track.kind !== 'text' && textFields.some(key => Object.hasOwn(input, key))) throw new Error('文字属性只能用于字幕或文字水印片段。')
      const patch = { ...input } as Partial<Clip>
      if (args.filterPreset) patch.filters = { ...CLIP_FILTER_PRESETS.find(preset => preset.id === args.filterPreset)!.filters }
      if (Object.hasOwn(input, 'filters')) patch.filters = input.filters === null ? undefined : { ...DEFAULT_CLIP_FILTERS, ...clip.filters, ...patch.filters, ...(input.filters as Partial<ClipFilters>) }
      if (Object.hasOwn(input, 'chromaKey')) patch.chromaKey = input.chromaKey === null ? undefined : { ...DEFAULT_CHROMA_KEY, ...clip.chromaKey, ...(input.chromaKey as Partial<ClipChromaKey>) }
      return editedClip(updateClip(project, clip.id, patch, { translatePositionKeyframes: args.translatePositionKeyframes === true }), clip.id, '更新片段属性')
    }
    case 'open_media_clip_classify': return classifyVideoClip(project, string('clipId'), string('classification') as 'repeat' | 'normal')
    case 'open_media_clip_move': return editedClip(moveClip(project, string('clipId'), string('trackId'), number('start')), string('clipId'), '移动片段')
    case 'open_media_clip_split': case 'open_media_clip_duplicate': {
      const oldIds = new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.id)))
      const next = name === 'open_media_clip_split' ? splitClip(project, string('clipId'), number('time')) : duplicateClip(project, string('clipId'), args.start as number | undefined)
      const added = next.tracks.flatMap(track => track.clips).find(clip => !oldIds.has(clip.id))!
      return editedClip(next, added.id, name === 'open_media_clip_split' ? '分割片段' : '复制片段')
    }
    case 'open_media_clip_trim': {
      const next = args.side ? trimClipAtPlayhead(project, string('clipId'), number('time'), args.side as 'start' | 'end') : trimClip(project, string('clipId'), number('trimIn'), number('trimOut'))
      return editedClip(next, string('clipId'), '裁剪片段')
    }
    case 'open_media_clip_remove': {
      const { track } = requireClip(project, string('clipId'))
      const next = args.ripple ? deleteClipAndCloseGap(project, string('clipId')) : deleteClip(project, string('clipId'))
      return changed(next, { removedClipId: args.clipId }, '删除片段', { trackId: track.id })
    }
    case 'open_media_clip_restore_audio_length': return editedClip(restoreAudioClipLength(project, string('clipId')), string('clipId'), '恢复音频原长度')
    case 'open_media_clip_extract_audio': {
      const current = requireClip(project, string('clipId'))
      if (current.track.locked) throw new Error('请先解锁此视频轨道。')
      if (current.track.kind !== 'video' || !current.clip.assetId) throw new Error('请选择视频轨道中的视频片段。')
      const asset = requireAsset(project, current.clip.assetId)
      if (asset.kind !== 'video') throw new Error('只有视频素材可以分离声音。')
      let next = project
      let track = next.tracks.find(track => track.kind === 'audio' && !track.locked)
      if (!track) { track = createTrack('audio'); next = addTrack(next, track) }
      const audio = createClip(asset, next, { ...current.clip, id: newId('clip'), name: `${current.clip.name} · 音轨` })
      delete audio.filters
      delete audio.chromaKey
      delete audio.transition
      next = addClip(next, track.id, audio)
      next = updateClip(next, current.clip.id, { volume: 0 })
      return { ...editedClip(next, audio.id, '分离片段音轨'), data: { sourceClipId: current.clip.id, audioClipId: audio.id, trackId: track.id } }
    }
    case 'open_media_subtitle_apply_style': {
      const next = applySubtitleStyleToTrack(project, string('clipId'))
      const { track } = requireClip(next, string('clipId'))
      return changed(next, { trackId: track.id, sourceClipId: args.clipId, clipIds: track.clips.filter(clip => clip.textRole === 'subtitle').map(clip => clip.id) }, '统一轨道字幕样式')
    }
    case 'open_media_timeline_close_gaps': {
      const next = closeTimelineGaps(project)
      return changed(next, { beforeDuration: projectDuration(project), duration: projectDuration(next) }, '接拢轨道空白')
    }
    case 'open_media_filter_list': return { data: { presets: JSON.parse(JSON.stringify(CLIP_FILTER_PRESETS)) } }
    case 'open_media_transition_list': return { data: { presets: TRANSITION_PRESETS.map(preset => ({ ...preset })), transitions: project.tracks.filter(track => track.kind === 'transition').flatMap(track => track.clips.map(clip => ({ trackId: track.id, clip: JSON.parse(JSON.stringify(clip)) }))), ...(args.time !== undefined ? { nearestCut: findTransitionCut(project, number('time'), args.trackId as string | undefined) ?? null } : {}) } }
    case 'open_media_transition_add': {
      if (args.trackId !== undefined && requireTrack(project, string('trackId')).kind !== 'video') throw new Error('首选转场轨道必须为视频轨道。')
      const cut = findTransitionCut(project, number('time'), args.trackId as string | undefined)
      const next = addTransition(project, number('time'), string('effect') as TransitionEffect, args.duration as number | undefined, args.trackId as string | undefined)
      const clip = next.tracks.flatMap(track => track.clips).find(clip => clip.transition?.fromClipId === cut?.fromClipId && clip.transition?.toClipId === cut?.toClipId)!
      return editedClip(next, clip.id, '添加转场')
    }
    case 'open_media_transition_update': return editedClip(updateTransition(project, string('clipId'), string('effect') as TransitionEffect, number('duration')), string('clipId'), '更新转场')
    case 'open_media_transition_remove': {
      const { track } = requireClip(project, string('clipId'))
      if (track.kind !== 'transition') throw new Error('指定片段不是转场。')
      return changed(deleteClip(project, string('clipId')), { removedClipId: args.clipId }, '删除转场', { trackId: track.id })
    }
    case 'open_media_speech_plan': {
      const plan = planSpeech(project, args.clipIds as string[] | undefined)
      validateSpeechPlanCapacity(project, plan)
      return { data: plan }
    }
    case 'open_media_speech_align': {
      const result = alignTextToSpeech(project, args.clipIds as string[] | undefined)
      return changed(result.project, { audioClipIds: result.audioClipIds, overlaps: result.overlaps }, '字幕对齐配音')
    }
    default: throw new Error('未知的项目工具。')
  }
}
