import type { McpMotionConfig, MediaAsset, Project } from './types.ts'
import { MOTION_STYLES, type MotionStyle } from './motion-style-catalog.ts'
import { videoWorkingCopyResolver } from './video-working-copies.ts'

export type { McpMotionConfig } from './types.ts'
export const MAX_MCP_MOTION_ASSETS = 16
export const MAX_MCP_MOTION_PROMPT = 4000

/** Validate stored values while permitting an unfinished user configuration. */
export function normalizeMcpMotion(value?: unknown): McpMotionConfig {
  if (value === undefined) return { enabled: false, assetIds: [], styleId: '' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('素材二创配置格式无效。')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['enabled', 'assetIds', 'styleId', 'prompt'].includes(key))) throw new Error('素材二创配置包含不支持的字段。')
  const enabled = input.enabled === undefined ? false : input.enabled, assetIds = input.assetIds === undefined ? [] : input.assetIds, styleId = input.styleId === undefined ? '' : input.styleId
  if (typeof enabled !== 'boolean') throw new Error('素材二创开关必须为布尔值。')
  if (!Array.isArray(assetIds) || assetIds.length > MAX_MCP_MOTION_ASSETS
    || assetIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id))
    || new Set(assetIds).size !== assetIds.length) throw new Error('素材二创最多选择 16 个不重复的素材标识。')
  if (typeof styleId !== 'string' || styleId !== '' && !MOTION_STYLES.some(style => style.id === styleId)) throw new Error('素材二创风格不受支持。')
  if (input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.length > MAX_MCP_MOTION_PROMPT || input.prompt.includes('\0'))) throw new Error('素材二创要求需为不超过 4000 字的文本。')
  return { enabled, assetIds: [...assetIds] as string[], styleId, ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}) }
}

export interface McpMotionAsset {
  id: string
  selectedAssetId: string
  name: string
  kind: 'image' | 'video'
  duration: number
  width: number
  height: number
  size: number
  mime: string
}

export interface McpMotionBrief {
  projectId: string
  enabled: boolean
  ready: boolean
  errors: string[]
  configuredAssetIds: string[]
  /** Resolved current working copies to use in the agent's scene plan. */
  assetIds: string[]
  assets: McpMotionAsset[]
  styleId: string
  style: MotionStyle | null
  prompt: string
  instructions: string[]
  workflow: {
    generationTool: string
    inspectionTools: string[]
    editingTools: string[]
    validationTools: string[]
    jobTools: string[]
  }
}

function publicAsset(asset: MediaAsset, selectedAssetId: string): McpMotionAsset {
  return { id: asset.id, selectedAssetId, name: asset.name, kind: asset.kind as 'image' | 'video',
    duration: asset.duration, width: asset.width, height: asset.height, size: asset.size, mime: asset.mime }
}

/** Detached current-project brief; it never includes local paths or media URLs. */
export function getMcpMotionBrief(project: Project): McpMotionBrief {
  const config = normalizeMcpMotion(project.mcpMotion), errors: string[] = []
  const byId = new Map(project.assets.map(asset => [asset.id, asset])), resolve = videoWorkingCopyResolver(project)
  const selected = new Map<string, McpMotionAsset>()
  if (!config.enabled) errors.push('请由用户在 MCP 设置中开启素材二创。')
  if (!config.assetIds.length) errors.push('请由用户选择当前工程中的图片或视频素材。')
  if (!config.styleId) errors.push('请由用户选择一种素材二创风格。')
  for (const id of config.assetIds) {
    const original = byId.get(id)
    if (!original) { errors.push(`已选素材 ${id} 已从当前工程移除，请重新选择。`); continue }
    const asset = resolve(original)
    if (!['image', 'video'].includes(asset.kind) || original.libraryRole !== undefined || asset.libraryRole !== undefined) {
      errors.push(`素材“${original.name}”不是可用于二创的工程图片或视频。`)
      continue
    }
    if (!selected.has(asset.id)) selected.set(asset.id, publicAsset(asset, id))
  }
  const assets = [...selected.values()]
  return {
    projectId: project.id, enabled: config.enabled, ready: config.enabled && errors.length === 0,
    errors, configuredAssetIds: [...config.assetIds], assetIds: assets.map(asset => asset.id), assets,
    styleId: config.styleId, style: config.styleId ? structuredClone(MOTION_STYLES.find(style => style.id === config.styleId)!) : null,
    prompt: config.prompt ?? '',
    instructions: [
      '先读取当前工程的素材二创要求；只有 ready=true 时可以生成，配置由用户在 MCP 设置中修改。',
      '查看所选素材的元数据、联系表或关键帧，结合用户要求和所选风格，自行规划素材顺序、截取范围、标题、说明与节奏。',
      '只使用本要求中的视觉素材；素材发生压缩替换时使用返回的当前工作副本标识。品牌图片也必须来自所选视觉素材，配乐可引用当前工程中的音频。',
      '调用 open_media_motion_clip_generate 并提供 scenes；可先 dryRun 预检查。生成真实视频素材后，可用现有轨道、片段、字幕、转场和音频工具与完整工程融合。',
      '生成操作返回异步任务，请查询任务进度和最终 assetId；用取帧或区间预览检查结果，并使用当前 projectId/revision 防止操作旧工程。',
    ],
    workflow: {
      generationTool: 'open_media_motion_clip_generate',
      inspectionTools: ['open_media_asset_probe', 'open_media_asset_storyboard', 'open_media_asset_get_frame'],
      editingTools: ['open_media_track_add', 'open_media_clip_add', 'open_media_clip_update', 'open_media_text_add', 'open_media_transition_add', 'open_media_audio_ducking', 'open_media_timeline_batch_edit'],
      validationTools: ['open_media_timeline_get_frame', 'open_media_preview_render', 'open_media_export_validate'],
      jobTools: ['open_media_job_get', 'open_media_job_cancel'],
    },
  }
}

/** Enforce the user's selected scope without changing their project configuration. */
export function assertMcpMotionRequest<T extends object>(project: Project, args: T): T & { styleId: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('素材二创请求格式无效。')
  const brief = getMcpMotionBrief(project)
  if (!brief.ready) throw new Error(`素材二创尚未就绪：${brief.errors.join(' ')}`)
  const input = args as Record<string, unknown>
  if (input.styleId !== undefined && input.styleId !== brief.styleId) throw new Error('请求风格与用户在 MCP 设置中选择的风格不一致。')
  if (!Array.isArray(input.scenes) || !input.scenes.length || input.scenes.length > MAX_MCP_MOTION_ASSETS) throw new Error('请为所选素材规划 1 至 16 个分镜。')
  const selected = new Set(brief.assetIds), byId = new Map(project.assets.map(asset => [asset.id, asset])), resolve = videoWorkingCopyResolver(project)
  const assertVisual = (id: unknown, label: string) => {
    const asset = typeof id === 'string' ? byId.get(id) : undefined
    if (!asset || !['image', 'video'].includes(asset.kind) || asset.libraryRole !== undefined || !selected.has(resolve(asset).id)) throw new Error(`${label}必须使用用户已选的当前工程视觉素材。`)
    return asset
  }
  input.scenes.forEach((scene, index) => {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error(`第 ${index + 1} 个分镜格式无效。`)
    assertVisual((scene as Record<string, unknown>).assetId, `第 ${index + 1} 个分镜`)
  })
  if (input.logoAssetId !== undefined && assertVisual(input.logoAssetId, '品牌图片').kind !== 'image') throw new Error('品牌图片需选择已选素材中的图片。')
  if (input.musicAssetId !== undefined) {
    const music = typeof input.musicAssetId === 'string' ? byId.get(input.musicAssetId) : undefined
    if (music?.kind !== 'audio') throw new Error('配乐需使用当前工程中的音频素材。')
  }
  return { ...args, styleId: brief.styleId }
}
