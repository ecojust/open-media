import type { MediaAsset } from './types.ts'

export type VideoGenerationMode = 'prompt' | 'image' | 'reference' | 'storyboard'
export type VideoGenerationModelState = 'not-downloaded' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'unsupported' | 'update-available'
export interface VideoGenerationModel {
  id: string
  name: string
  version: string
  modes: VideoGenerationMode[]
  size: number
  downloadedBytes: number
  state: VideoGenerationModelState
  error?: string
  licenseUrl: string
  hardware: string
}
export interface VideoGenerationStatus {
  supported: boolean
  reason?: string
  runtimeReady: boolean
  runtimeVersion?: string
  device?: string
  memoryBytes?: number
  models: VideoGenerationModel[]
}
export interface VideoGenerationReference {
  asset: MediaAsset
  kind: 'image' | 'video' | 'audio'
  includeAudio?: boolean
}
export interface VideoGenerationShot {
  id: string
  title: string
  prompt: string
  seconds: number
  firstFrame?: MediaAsset
  lastFrame?: MediaAsset
  references?: VideoGenerationReference[]
}
export interface VideoGenerationRequest {
  requestId: string
  modelId: string
  mode: VideoGenerationMode
  width: number
  height: number
  steps: number
  seed: number
  lowMemory: boolean
  joinShots: boolean
  shots: VideoGenerationShot[]
}
export interface VideoGenerationJob {
  id: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  stage: string
  progress?: number
  shotIndex: number
  shotCount: number
  startedAt: number
  elapsedSeconds: number
  assets: MediaAsset[]
  combinedAsset?: MediaAsset
  error?: string
  warning?: string
}

export const VIDEO_GENERATION_MAX_SHOTS = 20
export const VIDEO_GENERATION_MAX_PROMPT = 8000
export const VIDEO_GENERATION_MODELS = {
  'h3-base-fl2va': ['prompt', 'image', 'storyboard'],
  'h3-base-ref2va': ['reference'],
} as const

export function videoGenerationRequestError(request: VideoGenerationRequest): string | undefined {
  if (!request || typeof request !== 'object') return '生成请求格式无效。'
  if (!['prompt', 'image', 'reference', 'storyboard'].includes(request.mode)) return '请选择有效的生成方式。'
  if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.requestId)) return '生成请求标识无效。'
  const modes = Object.hasOwn(VIDEO_GENERATION_MODELS, request.modelId) ? VIDEO_GENERATION_MODELS[request.modelId as keyof typeof VIDEO_GENERATION_MODELS] as readonly string[] : undefined
  if (!modes || !modes.includes(request.mode)) return '所选模型不支持此生成方式。'
  if (typeof request.lowMemory !== 'boolean' || typeof request.joinShots !== 'boolean') return '生成开关值无效。'
  if (![request.width, request.height].every(value => Number.isInteger(value) && value >= 256 && value % 32 === 0) || request.width * request.height > 768 * 1344) return '宽高需为不小于 256 的 32 倍数，画幅最多为 1344 × 768 像素。'
  if (!Number.isInteger(request.steps) || request.steps < 4 || request.steps > 50) return '生成步数需为 4–50 的整数。'
  if (!Number.isSafeInteger(request.seed) || request.seed < 0 || request.seed > 4294967295) return '随机种子需为 0–4294967295 的整数。'
  if (!Array.isArray(request.shots) || !request.shots.length || request.shots.length > VIDEO_GENERATION_MAX_SHOTS) return `分镜数量需为 1–${VIDEO_GENERATION_MAX_SHOTS}。`
  if (request.shots.some(shot => !shot || typeof shot !== 'object' || typeof shot.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(shot.id))) return '分镜标识无效。'
  if (request.mode !== 'storyboard' && request.shots.length !== 1) return '多镜头请使用分镜生成。'
  if (new Set(request.shots.map(shot => shot.id)).size !== request.shots.length || request.shots.some(shot => !shot.id)) return '分镜标识不能重复或为空。'
  for (const [index, shot] of request.shots.entries()) {
    const label = `第 ${index + 1} 个分镜`
    if (typeof shot.title !== 'string' || shot.title.length > 200 || /\0/.test(shot.title)) return `${label}标题无效或超过 200 个字符。`
    if (typeof shot.prompt !== 'string' || !shot.prompt.trim() || shot.prompt.length > VIDEO_GENERATION_MAX_PROMPT || /\0/.test(shot.prompt)) return `${label}提示词需为 1–${VIDEO_GENERATION_MAX_PROMPT} 个字符。`
    if (!Number.isFinite(shot.seconds) || shot.seconds < 1 || shot.seconds > 15) return `${label}时长需为 1–15 秒。`
    if ([shot.firstFrame, shot.lastFrame].some(asset => asset && asset.kind !== 'image')) return `${label}首尾帧必须为图片。`
    if (request.mode === 'image' && !shot.firstFrame && !shot.lastFrame) return '请选择首帧或尾帧图片。'
    if (shot.references !== undefined && !Array.isArray(shot.references)) return `${label}参考素材列表无效。`
    const refs = shot.references ?? []
    if (request.mode === 'prompt' && (shot.firstFrame || shot.lastFrame)) return '包含首尾帧时请使用图片生成。'
    if (request.mode !== 'reference' && refs.length) return '参考素材请使用参考生成方式。'
    if (request.mode === 'reference' && (shot.firstFrame || shot.lastFrame)) return '参考素材不能与首尾帧同时使用。'
    if (refs.length && (shot.firstFrame || shot.lastFrame)) return `${label}参考素材不能与首尾帧同时使用。`
    if (refs.some(ref => !ref || !ref.asset || !['image', 'video', 'audio'].includes(ref.kind) || ref.asset.kind !== ref.kind || ref.includeAudio !== undefined && typeof ref.includeAudio !== 'boolean')) return `${label}参考素材类型不匹配。`
    if (refs.length > 12 || refs.filter(ref => ref.kind === 'image').length > 9 || refs.filter(ref => ref.kind === 'video').length > 3) return `${label}参考素材最多 12 个，其中图片最多 9 张、视频最多 3 段。`
    if (request.mode === 'reference' && !refs.some(ref => ref.kind !== 'audio')) return '参考生成至少需要一张图片或一段视频。'
    const videos = refs.filter(ref => ref.kind === 'video')
    const audio = refs.filter(ref => ref.kind === 'audio' || ref.kind === 'video' && ref.includeAudio)
    if (videos.some(ref => ref.includeAudio) && videoGenerationActualSeconds(shot.seconds) * 24 < 56) return `${label}使用视频原声时，请求时长至少为 2 秒。`
    if ([...videos, ...audio].some(ref => !Number.isFinite(ref.asset.duration) || ref.asset.duration < 2 || ref.asset.duration > 15) || videos.reduce((sum, ref) => sum + ref.asset.duration, 0) > 15 || audio.length > 3 || audio.reduce((sum, ref) => sum + ref.asset.duration, 0) > 15) return `${label}参考音视频每段需为 2–15 秒，视频、音频各自总时长不得超过 15 秒，音频最多 3 段。`
  }
  return undefined
}

export function videoGenerationActualSeconds(seconds: number): number {
  const requested = Math.ceil(seconds * 24)
  return (5 + 17 * Math.max(0, Math.ceil((requested - 5) / 17))) / 24
}
