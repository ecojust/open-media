import type { Clip, MediaAsset, Project, Track, TrackKind } from './types.ts'
import { validateClipFilters } from './clip-filters.ts'
import { validateChromaKey } from './chroma-key.ts'

export const MAX_PROJECT_DURATION = 24 * 60 * 60
export const MAX_ASSETS = 1000
export const MAX_TRACKS = 100
export const MAX_CLIPS = 10000

export function newId(prefix = ''): string {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues) throw new Error('当前环境无法生成安全的项目标识。')
  let id: string
  if (typeof cryptoApi.randomUUID === 'function') id = cryptoApi.randomUUID()
  else {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 15) | 64
    bytes[8] = (bytes[8]! & 63) | 128
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
    id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return prefix ? `${prefix}-${id}` : id
}

export function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project
}

export function createTrack(kind: TrackKind = 'video', name?: string): Track {
  return { id: newId('track'), name: name ?? ({ video: '视频轨道', audio: '音频轨道', text: '字幕轨道' }[kind]), kind, muted: false, locked: false, clips: [] }
}

export function createProject(title = '未命名项目', options: Partial<Pick<Project, 'width' | 'height' | 'fps' | 'background'>> = {}): Project {
  const now = new Date().toISOString()
  return validateProject({ version: 1, id: newId('project'), title, width: 1920, height: 1080, fps: 30, background: '#101018', ...options, createdAt: now, updatedAt: now, assets: [], tracks: [createTrack('text'), createTrack('video'), createTrack('audio')] }, { trusted: true })
}

export function createClip(asset: MediaAsset, project: Pick<Project, 'width' | 'height'>, options: Partial<Clip> = {}): Clip {
  const duration = asset.kind === 'image' ? Math.max(5, asset.duration) : asset.duration
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('素材时长无效，无法添加到时间线。')
  return { id: newId('clip'), generatedAt: new Date().toISOString(), assetId: asset.id, name: asset.name, start: 0, trimIn: 0, trimOut: duration, speed: 1, volume: 1, opacity: 1, x: 0, y: 0, width: project.width, height: project.height, rotation: 0, fit: 'contain', fadeIn: 0, fadeOut: 0, ...options }
}

export function createTextClip(project: Pick<Project, 'width' | 'height'>, options: Partial<Clip> = {}): Clip {
  return { id: newId('clip'), generatedAt: new Date().toISOString(), name: '文本字幕', start: 0, trimIn: 0, trimOut: 5, speed: 1, volume: 0, opacity: 1, x: project.width * 0.1, y: project.height * 0.75, width: project.width * 0.8, height: project.height * 0.2, rotation: 0, fit: 'contain', fadeIn: 0, fadeOut: 0, text: '双击编辑字幕', fontSize: 64, fontFamily: 'sans-serif', fontWeight: 600, color: '#ffffff', background: 'transparent', textAlign: 'center', ...options }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效。`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max = 300, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /\0/.test(value)) throw new Error(`${label}无效。`)
  return value
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}超出允许范围。`)
  return value
}

function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label}无效。`)
  return value as T
}

function boolean(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error('项目开关值无效。')
  return value
}

function color(value: unknown, label: string): string {
  const result = text(value, label, 80)
  if (!/^(?:#[0-9a-fA-F]{3,8}|transparent|black|white|rgba?\([\d.,%\s]+\))$/.test(result)) throw new Error(`${label}格式无效。`)
  return result
}

function iso(value: unknown, label = '项目时间'): string {
  const result = text(value, label, 40)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label}无效。`)
  return new Date(result).toISOString()
}

export interface ValidateProjectOptions { trusted?: boolean }

/** Untrusted documents never retain machine paths or active external URLs. */
export function validateProject(value: unknown, options: ValidateProjectOptions = {}): Project {
  const root = record(value, '项目')
  if (root.version !== 1) throw new Error('暂不支持此项目版本。')
  if (!Array.isArray(root.assets) || root.assets.length > MAX_ASSETS) throw new Error('项目素材列表无效或数量过多。')
  if (!Array.isArray(root.tracks) || root.tracks.length > MAX_TRACKS) throw new Error('项目轨道列表无效或数量过多。')
  const ids = new Set<string>()
  function id(value: unknown): string {
    const result = text(value, '项目标识', 160)
    if (!/^[a-zA-Z0-9_-]+$/.test(result) || ids.has(result)) throw new Error('项目包含无效或重复的标识。')
    ids.add(result)
    return result
  }
  const projectId = id(root.id)
  const assets = root.assets.map((item): MediaAsset => {
    const a = record(item, '素材')
    const kind = choice(a.kind, ['video', 'audio', 'image'] as const, '素材类型')
    const asset: MediaAsset = { id: id(a.id), name: text(a.name, '素材名称', 1000), kind, url: '', duration: number(a.duration, '素材时长', kind === 'image' ? 0 : 0.001, MAX_PROJECT_DURATION), width: number(a.width, '素材宽度', kind === 'audio' ? 0 : 1, 65536), height: number(a.height, '素材高度', kind === 'audio' ? 0 : 1, 65536), size: number(a.size, '素材大小', 0, Number.MAX_SAFE_INTEGER), mime: text(a.mime, '素材格式', 200, true) }
    if (options.trusted) {
      const url = text(a.url ?? '', '素材地址', 2 * 1024 * 1024, true)
      if (url && !/^(?:blob:|data:(?:image|video|audio)\/|https?:\/\/|asset:\/\/)/i.test(url)) throw new Error('素材地址协议不受支持。')
      asset.url = url
      if (a.sourceUrl !== undefined) {
        const sourceUrl = text(a.sourceUrl, '原始素材地址', 2 * 1024 * 1024)
        if (!/^(?:blob:|data:(?:image|video|audio)\/|https?:\/\/|asset:\/\/)/i.test(sourceUrl)) throw new Error('原始素材地址协议不受支持。')
        asset.sourceUrl = sourceUrl
      }
      if (a.nativePath !== undefined) asset.nativePath = text(a.nativePath, '素材文件路径', 32768)
    }
    return asset
  })
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]))
  let clipCount = 0
  const tracks = root.tracks.map((item): Track => {
    const t = record(item, '轨道')
    if (!Array.isArray(t.clips)) throw new Error('轨道片段列表无效。')
    clipCount += t.clips.length
    if (clipCount > MAX_CLIPS) throw new Error('项目片段数量过多。')
    const kind = choice(t.kind, ['video', 'audio', 'text'] as const, '轨道类型')
    const trackId = id(t.id)
    const clips = t.clips.map((item): Clip => {
      const c = record(item, '片段')
      const clip: Clip = { id: id(c.id), name: text(c.name, '片段名称', 1000), start: number(c.start, '片段开始时间', 0, MAX_PROJECT_DURATION), trimIn: number(c.trimIn, '片段源起点', 0, MAX_PROJECT_DURATION), trimOut: number(c.trimOut, '片段源终点', 0.001, MAX_PROJECT_DURATION), speed: number(c.speed, '播放速度', 0.1, 16), volume: number(c.volume, '音量', 0, 2), opacity: number(c.opacity, '不透明度', 0, 1), x: number(c.x, '横坐标', -65536, 65536), y: number(c.y, '纵坐标', -65536, 65536), width: number(c.width, '片段宽度', 1, 65536), height: number(c.height, '片段高度', 1, 65536), rotation: number(c.rotation, '旋转角度', -3600, 3600), fit: choice(c.fit, ['contain', 'cover', 'fill'] as const, '画面适配'), fadeIn: number(c.fadeIn ?? 0, '淡入时间', 0, MAX_PROJECT_DURATION), fadeOut: number(c.fadeOut ?? 0, '淡出时间', 0, MAX_PROJECT_DURATION) }
      if (c.generatedAt !== undefined) clip.generatedAt = iso(c.generatedAt, '片段生成时间')
      const duration = (clip.trimOut - clip.trimIn) / clip.speed
      if (duration < 1 / 1000 || clip.start + duration > MAX_PROJECT_DURATION + 1e-6) throw new Error('片段时长无效或时间线超过 24 小时。')
      if (clip.fadeIn > duration + 1e-6 || clip.fadeOut > duration + 1e-6) throw new Error('淡入淡出时间不能超过片段时长。')
      if (kind === 'text') {
        if (c.assetId !== undefined) throw new Error('字幕轨道不能引用媒体素材。')
        clip.text = text(c.text ?? '', '字幕文字', 20000, true)
        clip.fontSize = number(c.fontSize ?? 64, '字号', 4, 2048)
        clip.fontFamily = text(c.fontFamily ?? 'sans-serif', '字体', 200)
        clip.fontWeight = number(c.fontWeight ?? 600, '字重', 100, 900)
        clip.color = color(c.color ?? '#ffffff', '文字颜色')
        clip.background = color(c.background ?? 'transparent', '文字背景')
        clip.textAlign = choice(c.textAlign ?? 'center', ['left', 'center', 'right'] as const, '文字对齐')
      } else {
        clip.assetId = text(c.assetId, '片段素材标识', 160)
        const asset = assetMap.get(clip.assetId)
        if (!asset) throw new Error('片段引用的素材不存在。')
        if (kind === 'video' && asset.kind === 'audio') throw new Error('视频轨道不能放置纯音频素材。')
        if (kind === 'audio' && asset.kind === 'image') throw new Error('音频轨道不能放置图片素材。')
        if (asset.kind !== 'image' && clip.trimOut > asset.duration + 1e-6) throw new Error('片段裁剪范围超出素材时长。')
      }
      if (c.speech !== undefined) {
        if (kind !== 'audio' || assetMap.get(clip.assetId!)?.kind !== 'audio') throw new Error('文字配音信息只能用于音频轨道中的音频素材。')
        const speech = record(c.speech, '文字配音信息')
        clip.speech = { text: text(speech.text, '配音文字', 20000), voiceId: text(speech.voiceId, '配音声音', 1000), rate: number(speech.rate, '配音语速', 0.25, 4) }
        if (speech.textClipId !== undefined) clip.speech.textClipId = text(speech.textClipId, '配音字幕标识', 160)
      }
      if (c.filters !== undefined) {
        if (kind !== 'video' || !['video', 'image'].includes(assetMap.get(clip.assetId!)?.kind ?? '')) throw new Error('滤镜只能用于视频轨道中的视频或图片片段。')
        clip.filters = validateClipFilters(c.filters)
      }
      if (c.chromaKey !== undefined) {
        if (kind !== 'video' || !['video', 'image'].includes(assetMap.get(clip.assetId!)?.kind ?? '')) throw new Error('抠像只能用于视频轨道中的视频或图片片段。')
        clip.chromaKey = validateChromaKey(c.chromaKey)
      }
      return clip
    })
    return { id: trackId, name: text(t.name, '轨道名称', 300), kind, muted: boolean(t.muted), locked: boolean(t.locked), clips }
  })
  const textIds = new Set(tracks.filter((track) => track.kind === 'text').flatMap((track) => track.clips.map((clip) => clip.id)))
  const speechTextIds = new Set<string>()
  for (const clip of tracks.flatMap((track) => track.clips)) {
    const textClipId = clip.speech?.textClipId
    if (textClipId === undefined) continue
    if (!textIds.has(textClipId)) throw new Error('配音关联的字幕不存在。')
    if (speechTextIds.has(textClipId)) throw new Error('同一字幕不能关联多个配音片段。')
    speechTextIds.add(textClipId)
  }
  return { version: 1, id: projectId, title: text(root.title, '项目名称', 300), width: number(root.width, '项目宽度', 16, 16384), height: number(root.height, '项目高度', 16, 16384), fps: number(root.fps, '帧率', 1, 240), background: color(root.background, '项目背景'), createdAt: iso(root.createdAt), updatedAt: iso(root.updatedAt), assets, tracks }
}
