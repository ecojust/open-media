import { cloneProject, MAX_PROJECT_DURATION, newId, validateProject } from './project.ts'
import type { Project } from './types.ts'

export interface ProjectOperationResult { project?: Project; data: unknown; label?: string; selection?: { trackId?: string; clipId?: string } }
export interface TimelineBatchOperation { tool: string; arguments: Record<string, unknown> }
export interface TimelineBatchOptions { operations: TimelineBatchOperation[]; dryRun?: boolean; expectedRevision?: number }
export interface TimelineBatchContext {
  revision: number
  execute(project: Project, tool: string, args: unknown): ProjectOperationResult
}
/** Only synchronous, in-memory mutations may participate in one editor transaction. */
export const BATCH_EDIT_TOOLS = new Set([
  'project_update', 'asset_remove', 'track_add', 'track_update', 'track_remove', 'track_reorder',
  'clip_add', 'text_add', 'clip_update', 'clip_move', 'clip_split', 'clip_classify', 'clip_trim', 'clip_duplicate', 'clip_remove',
  'clip_restore_audio_length', 'clip_extract_audio', 'subtitle_apply_style', 'timeline_close_gaps',
  'transition_add', 'transition_update', 'transition_remove', 'speech_align', 'timeline_markers_set',
  'clip_keyframes_set', 'clip_crop', 'focus_region', 'overlay_add', 'title_add', 'template_customize',
  'clip_freeze_frame', 'clip_speed_ramp', 'transition_parameters_set',
].map(name => `open_media_${name}`))

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label}必须为对象。`)
  return value as Record<string, unknown>
}

export function assertProjectRevision(expected: number | undefined, actual: number): void {
  if (!Number.isSafeInteger(actual) || actual < 0) throw new Error('当前项目版本无效。')
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected !== actual)) throw new Error(`项目版本已变化：当前 revision=${actual}，请先重新读取项目。`)
}

/** Execute against detached copies. The caller publishes the final project exactly once. */
export function executeTimelineBatch(project: Project, options: TimelineBatchOptions, context: TimelineBatchContext): ProjectOperationResult {
  assertProjectRevision(options.expectedRevision, context.revision)
  if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') throw new Error('dryRun 必须为开关值。')
  if (!Array.isArray(options.operations) || !options.operations.length || options.operations.length > 100) throw new Error('一次批量编辑需要 1 至 100 个操作。')
  // Check every operation before invoking even the first executor.
  const operations = options.operations.map((raw, index) => {
    const item = object(raw, `第 ${index + 1} 个操作`)
    if (Object.keys(item).some(key => !['tool', 'arguments'].includes(key)) || typeof item.tool !== 'string' || !BATCH_EDIT_TOOLS.has(item.tool)) throw new Error(`第 ${index + 1} 个操作不是可批量执行的项目编辑工具。`)
    const args = object(item.arguments, `第 ${index + 1} 个操作的 arguments`)
    if (args.expectedRevision !== undefined) assertProjectRevision(args.expectedRevision as number, context.revision)
    return { tool: item.tool, arguments: structuredClone(args) }
  })
  let next = validateProject(cloneProject(project), { trusted: true })
  let selection: ProjectOperationResult['selection']
  const results: { index: number; tool: string; data: unknown }[] = []
  for (const [index, operation] of operations.entries()) {
    try {
      const result = context.execute(cloneProject(next), operation.tool, operation.arguments)
      if (!result || typeof (result as unknown as { then?: unknown }).then === 'function' || !result.project) throw new Error('批量操作必须同步返回已编辑项目，不能执行异步任务或外部操作。')
      if (result.project.id !== project.id) throw new Error('批量编辑不能切换工程。')
      next = validateProject(result.project, { trusted: true })
      results.push({ index, tool: operation.tool, data: structuredClone(result.data) })
      if (result.selection) selection = structuredClone(result.selection)
    } catch (cause) {
      throw new Error(`批量编辑第 ${index + 1} 项（${operation.tool}）失败，全部修改均未写入：${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
  }
  return { ...(options.dryRun ? {} : { project: next, selection }), label: `批量编辑 ${operations.length} 项`,
    data: { dryRun: options.dryRun === true, valid: true, operationCount: operations.length, results, baseRevision: context.revision } }
}

export interface TimelineMarkerInput { id?: string; time: number; label: string; kind: 'chapter' | 'highlight' | 'review'; color?: string }
export function setTimelineMarkers(project: Project, options: { markers: TimelineMarkerInput[] }): ProjectOperationResult {
  if (!Array.isArray(options.markers) || options.markers.length > 1000) throw new Error('最多支持 1000 个时间线标记。')
  const ids = new Set<string>()
  const markers = options.markers.map((raw, index) => {
    const item = object(raw, `第 ${index + 1} 个标记`)
    if (Object.keys(item).some(key => !['id', 'time', 'label', 'kind', 'color'].includes(key))) throw new Error('标记包含不支持的字段。')
    const id = item.id === undefined ? newId('marker') : item.id
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id) || ids.has(id)) throw new Error('标记 ID 无效或重复。')
    if (typeof item.time !== 'number' || !Number.isFinite(item.time) || item.time < 0 || item.time > MAX_PROJECT_DURATION) throw new Error('标记时间必须在 0 至 24 小时之间。')
    if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 300 || item.label.includes('\0')) throw new Error('标记名称需要 1 至 300 个字符。')
    if (!['chapter', 'highlight', 'review'].includes(item.kind as string)) throw new Error('标记类型必须为章节、重点或待检查。')
    if (item.color !== undefined && (typeof item.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(item.color))) throw new Error('标记颜色必须为六位十六进制色值。')
    ids.add(id)
    return { id, time: item.time, label: item.label.trim(), kind: item.kind as TimelineMarkerInput['kind'], ...(item.color ? { color: item.color as string } : {}) }
  }).sort((left, right) => left.time - right.time || left.id.localeCompare(right.id))
  const next = cloneProject(project)
  Object.assign(next, { markers })
  next.updatedAt = new Date().toISOString()
  return { project: validateProject(next, { trusted: true }), label: '更新时间线标记', data: { markers } }
}
