import { easeProgress, validateTransitionParameters, visualClipDuration } from './visual-animation.ts'
import { cloneProject, createTrack, newId, validateProject } from './project.ts'
import type { Clip, ClipTransition, Project, TransitionEffect } from './types.ts'

export type TransitionParameters = Pick<ClipTransition, 'direction' | 'easing' | 'color' | 'blur' | 'scope'>
export const TRANSITION_COLLECTIONS = [
  { id: 'dissolve', name: '淡化与柔焦', effects: ['fade', 'flash-white', 'defocus'] },
  { id: 'direction', name: '方向移动', effects: ['wipe-up', 'wipe-down', 'wipe-left', 'wipe-right', 'slide-left', 'slide-right'] },
  { id: 'geometry', name: '几何开幕', effects: ['close-vertical', 'close-horizontal', 'diagonal', 'radial', 'iris', 'diamond', 'blinds'] },
  { id: 'zoom', name: '缩放衔接', effects: ['zoom', 'zoom-fade', 'zoom-fade-left', 'zoom-fade-right', 'zoom-fade-up', 'zoom-fade-down', 'zoom-through'] },
  { id: 'fragments', name: '碎片', effects: ['fragment-burst', 'fragment-vortex', 'fragment-collapse', 'pixel-dissolve', 'pixel-wave', 'tile-orbit'] },
  { id: 'slices', name: '动感切片', effects: ['slice-stagger', 'slice-vertical', 'checker-flip', 'glitch-slices', 'zipper-slices', 'stepped-shutter'] },
] as const

export const TRANSITION_PRESETS: readonly { id: TransitionEffect; name: string; description: string }[] = [
  { id: 'fade', name: '淡出淡入', description: '前段淡出至项目背景，后段逐渐显现' },
  { id: 'wipe-up', name: '向上擦除', description: '画面从顶部收起，再从底部向上展开' },
  { id: 'wipe-down', name: '向下展开', description: '画面从底部收起，再从顶部向下展开' },
  { id: 'wipe-left', name: '向左擦除', description: '画面向右侧收起，再向左侧展开' },
  { id: 'wipe-right', name: '向右展开', description: '画面向左侧收起，再向右侧展开' },
  { id: 'close-vertical', name: '纵向开合', description: '上下边缘向中心收拢，再纵向展开' },
  { id: 'close-horizontal', name: '横向开合', description: '左右边缘向中心收拢，再横向展开' },
  { id: 'slide-left', name: '向左滑动', description: '前段滑向左侧，后段从左侧滑入' },
  { id: 'slide-right', name: '向右滑动', description: '前段滑向右侧，后段从右侧滑入' },
  { id: 'zoom', name: '缩放显现', description: '前段缩小淡出，后段从中心放大显现' },
  { id: 'zoom-fade', name: '缩放淡入淡出', description: '居中缩放：前段从 100% 缩至 80% 并淡出，后段从 80% 放至 100% 并淡入' },
  { id: 'zoom-fade-left', name: '靠左缩放淡化', description: '固定左侧：前段从 100% 缩至 80% 并淡出，后段从 80% 放至 100% 并淡入' },
  { id: 'zoom-fade-right', name: '靠右缩放淡化', description: '固定右侧：前段从 100% 缩至 80% 并淡出，后段从 80% 放至 100% 并淡入' },
  { id: 'zoom-fade-up', name: '靠上缩放淡化', description: '固定顶部：前段从 100% 缩至 80% 并淡出，后段从 80% 放至 100% 并淡入' },
  { id: 'zoom-fade-down', name: '靠下缩放淡化', description: '固定底部：前段从 100% 缩至 80% 并淡出，后段从 80% 放至 100% 并淡入' },
  { id: 'diagonal', name: '斜向揭幕', description: '画面沿对角线收起与展开，以干净的斜切连接两个场景' },
  { id: 'radial', name: '环弧开幕', description: '从顶部顺时针展开扇形视野，适合圆形结构与周期主题' },
  { id: 'iris', name: '圆形光圈', description: '圆形视野向中心收拢，再展开至完整画面，适合聚焦观察对象' },
  { id: 'diamond', name: '菱形开幕', description: '几何菱形收拢与展开，以简洁的切面衔接章节' },
  { id: 'blinds', name: '阶梯百叶', description: '八道横向切片依次收起与展开，呈现有层次的节奏' },
  { id: 'flash-white', name: '柔光闪白', description: '画面渐变至暖白柔光，再显现下一镜头，适合重要发现' },
  { id: 'defocus', name: '失焦叠化', description: '画面柔化并淡出，下一镜头从朦胧中逐渐清晰' },
  { id: 'zoom-through', name: '推近穿越', description: '前段轻推至 112% 并淡出，后段从 112% 回到原比例，衔接宏观与细节' },
  { id: 'fragment-burst', name: '碎片爆散', description: '真实画面分解为旋转碎片向外散开，下一镜头从碎片中聚合' },
  { id: 'fragment-vortex', name: '旋涡碎片', description: '画面碎片沿旋涡扩散，再旋转汇聚为完整镜头' },
  { id: 'fragment-collapse', name: '碎片聚拢', description: '画面碎片向中心旋转收拢，再由中心向外展开' },
  { id: 'pixel-dissolve', name: '像素消散', description: '画面分解为错落收缩的像素块，再逐块还原下一镜头' },
  { id: 'pixel-wave', name: '像素波浪', description: '像素块沿对角方向错峰消散与重组，形成流动的画面波浪' },
  { id: 'slice-stagger', name: '交错横切', description: '横向画面切片交错滑向两侧，再从两侧交错拼回' },
  { id: 'slice-vertical', name: '交错纵切', description: '纵向画面切片交错滑向上下，再从上下交错拼回' },
  { id: 'checker-flip', name: '棋盘翻片', description: '画面切成棋盘格交错翻转收起，再翻开为下一镜头' },
  { id: 'tile-orbit', name: '环绕重组', description: '画面碎片沿中心环绕散开，保持画面朝向并回旋重组' },
  { id: 'glitch-slices', name: '数字故障', description: '画面切片高速横向错位，呈现数字信号扰动与恢复的节奏' },
  { id: 'zipper-slices', name: '拉链开幕', description: '两侧切片错峰向外拉开，再逐行合拢下一镜头' },
  { id: 'stepped-shutter', name: '阶梯折屏', description: '竖向画面切片沿右边缘依次折叠与展开，形成阶梯推进感' },
]

const EPSILON = 1e-6
const durationOf = visualClipDuration
const endOf = (clip: Clip) => clip.start + durationOf(clip)

export interface TransitionCut {
  trackId: string
  fromClipId: string
  toClipId: string
  time: number
  maxDuration: number
}

function cuts(project: Project): TransitionCut[] {
  const assets = new Map(project.assets.map(asset => [asset.id, asset]))
  return project.tracks.filter(track => track.kind === 'video').flatMap(track => {
    const sorted = [...track.clips].sort((a, b) => a.start - b.start || endOf(a) - endOf(b))
    let maximumEarlierEnd = -Infinity
    return sorted.slice(1).flatMap((to, index) => {
      const from = sorted[index]!
      const covered = maximumEarlierEnd > to.start + EPSILON
      maximumEarlierEnd = Math.max(maximumEarlierEnd, endOf(from))
      if (assets.get(from.assetId!)?.kind !== 'video' || assets.get(to.assetId!)?.kind !== 'video') return []
      if (Math.abs(endOf(from) - to.start) > EPSILON) return []
      // Reject a cut covered by another clip on the same track.
      if (covered) return []
      return [{ trackId: track.id, fromClipId: from.id, toClipId: to.id, time: to.start, maxDuration: Math.min(durationOf(from), durationOf(to)) }]
    })
  })
}

/** Prefer the selected video track, then the nearest unambiguous cut elsewhere. */
export function findTransitionCut(project: Project, time: number, preferredTrackId?: string, options: { includeLocked?: boolean; minimumDuration?: number } = {}): TransitionCut | undefined {
  if (!Number.isFinite(time)) return undefined
  const candidates = cuts(project).filter(cut => !project.tracks.find(track => track.id === cut.trackId)!.hidden && (options.includeLocked || !project.tracks.find(track => track.id === cut.trackId)!.locked) && cut.maxDuration >= (options.minimumDuration ?? 2 / project.fps) - EPSILON)
  const preferred = candidates.filter(cut => cut.trackId === preferredTrackId)
  return (preferred.length ? preferred : candidates).sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time) || a.time - b.time)[0]
}

function effectName(effect: TransitionEffect): string {
  const preset = TRANSITION_PRESETS.find(preset => preset.id === effect)
  if (!preset) throw new Error('转场效果无效。')
  return preset.name
}

function boundedDuration(project: Project, cut: TransitionCut, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) throw new Error('转场时长必须大于零。')
  if (cut.maxDuration < 2 / project.fps - EPSILON) throw new Error('相邻视频片段太短，无法应用转场。')
  return Math.max(2 / project.fps, Math.min(requested, cut.maxDuration))
}

function finish(project: Project): Project {
  project.updatedAt = new Date().toISOString()
  return validateProject(project, { trusted: true })
}

export function addTransition(project: Project, time: number, effect: TransitionEffect, duration = 1, preferredTrackId?: string, parameters?: TransitionParameters): Project {
  effectName(effect)
  const options = parameters ? validateTransitionParameters(parameters) : {}
  const cut = findTransitionCut(project, time, preferredTrackId)
  if (!cut) throw new Error('需要两个首尾相接的视频片段。请先分割视频或将两个视频片段接拢，并解锁视频轨道。')
  const length = boundedDuration(project, cut, duration)
  const next = cloneProject(project)
  const existing = next.tracks.flatMap(track => track.clips.map(clip => ({ track, clip })))
    .find(({ clip }) => clip.transition?.fromClipId === cut.fromClipId && clip.transition.toClipId === cut.toClipId)
  if (existing) {
    const updated = updateTransition(project, existing.clip.id, effect, length)
    if (parameters) {
      const clip = updated.tracks.flatMap(track => track.clips).find(clip => clip.id === existing.clip.id)!
      clip.transition = { effect, fromClipId: cut.fromClipId, toClipId: cut.toClipId, ...options }
    }
    return finish(updated)
  }
  let track = next.tracks.find(track => track.kind === 'transition')
  if (track?.locked) throw new Error('请先解锁转场轨道。')
  if (!track) { track = createTrack('transition'); next.tracks.unshift(track) }
  track.clips.push({ id: newId('clip'), generatedAt: new Date().toISOString(), name: effectName(effect), start: cut.time - length / 2,
    trimIn: 0, trimOut: length, speed: 1, volume: 0, opacity: 1, x: 0, y: 0, width: project.width, height: project.height,
    rotation: 0, fit: 'contain', fadeIn: 0, fadeOut: 0, transition: { effect, fromClipId: cut.fromClipId, toClipId: cut.toClipId, ...options } })
  return finish(next)
}

export function updateTransition(project: Project, clipId: string, effect: TransitionEffect, duration: number): Project {
  effectName(effect)
  const next = cloneProject(project)
  const track = next.tracks.find(track => track.kind === 'transition' && track.clips.some(clip => clip.id === clipId))
  const clip = track?.clips.find(clip => clip.id === clipId)
  if (!track || !clip?.transition) throw new Error('转场不存在。')
  if (track.locked) throw new Error('请先解锁转场轨道。')
  const cut = cuts(next).find(cut => cut.fromClipId === clip.transition!.fromClipId && cut.toClipId === clip.transition!.toClipId)
  if (!cut) throw new Error('转场关联的视频片段已经不再相邻。')
  if (next.tracks.find(track => track.id === cut.trackId)!.locked) throw new Error('请先解锁关联的视频轨道。')
  const length = boundedDuration(next, cut, duration)
  clip.name = effectName(effect)
  clip.transition.effect = effect
  clip.start = cut.time - length / 2
  clip.trimOut = length
  return finish(next)
}

/** Re-anchor after a timeline edit; invalidated cuts are removed, never moved freely. */
export function reconcileTransitions(project: Project, previous?: Project): void {
  const transitionTracks = project.tracks.filter(track => track.kind === 'transition' && track.clips.length)
  if (!transitionTracks.length) return
  const available = new Map(cuts(project).map(cut => [`${cut.fromClipId}:${cut.toClipId}`, cut]))
  for (const track of transitionTracks) {
    const previousTrack = previous?.tracks.find(item => item.id === track.id)
    track.clips = track.clips.filter(clip => {
      const cut = clip.transition && available.get(`${clip.transition.fromClipId}:${clip.transition.toClipId}`)
      const prior = previousTrack?.clips.find(item => item.id === clip.id)
      if (!cut || cut.maxDuration < 2 / project.fps - EPSILON) {
        if (track.locked) throw new Error('此次编辑会移除关联转场，请先解锁转场轨道。')
        return false
      }
      const length = boundedDuration(project, cut, durationOf(clip))
      const start = cut.time - length / 2
      if (track.locked && prior && (Math.abs(prior.start - start) > EPSILON || Math.abs(durationOf(prior) - length) > EPSILON || JSON.stringify(prior.transition) !== JSON.stringify(clip.transition))) throw new Error('此次编辑会调整关联转场，请先解锁转场轨道。')
      clip.start = start; clip.trimIn = 0; clip.trimOut = length; clip.speed = 1
      return true
    })
  }
}

/** Validate references after every track and media clip has been decoded. */
export function validateTransitionBindings(project: Pick<Project, 'tracks' | 'assets' | 'fps'>): void {
  const transitionTracks = project.tracks.filter(track => track.kind === 'transition' && track.clips.length)
  if (!transitionTracks.length) return
  const available = new Map(cuts(project as Project).map(cut => [`${cut.fromClipId}:${cut.toClipId}`, cut]))
  const used = new Set<string>()
  for (const track of transitionTracks) for (const clip of track.clips) {
    if (!clip.transition) throw new Error('转场缺少关联的视频片段。')
    const binding = clip.transition
    const key = `${binding.fromClipId}:${binding.toClipId}`
    if (used.has(key)) throw new Error('同一视频切点只能使用一个转场。')
    used.add(key)
    const cut = available.get(key)
    if (!cut) throw new Error('转场必须关联同一轨道上首尾相接的两个视频片段。')
    const length = durationOf(clip)
    if (clip.trimIn !== 0 || clip.speed !== 1 || length < 2 / project.fps - EPSILON || length > cut.maxDuration + EPSILON || Math.abs(clip.start + length / 2 - cut.time) > EPSILON) throw new Error('转场时长或位置无效，必须以视频切点为中心。')
  }
}

export interface TransitionVisual {
  effect: TransitionEffect
  visibility: number
  opacity: number
  /** Normalized clip-local visible rectangle. */
  mask: { x: number; y: number; width: number; height: number }
  aperture?: 'circle' | 'diamond' | 'blinds' | 'diagonal' | 'radial'
  translateX: number
  translateY: number
  color?: string
  blur?: number
  blurStrength?: number
  scale: number
}

export function transitionVisual(effect: TransitionEffect, visibility: number): TransitionVisual {
  const v = Math.min(1, Math.max(0, visibility))
  const result: TransitionVisual = { effect, visibility: v, opacity: 1, mask: { x: 0, y: 0, width: 1, height: 1 }, translateX: 0, translateY: 0, scale: 1 }
  switch (effect) {
    case 'fade': result.opacity = v; break
    case 'wipe-up': result.mask = { x: 0, y: 1 - v, width: 1, height: v }; break
    case 'wipe-down': result.mask.height = v; break
    case 'wipe-left': result.mask = { x: 1 - v, y: 0, width: v, height: 1 }; break
    case 'wipe-right': result.mask.width = v; break
    case 'close-vertical': result.mask = { x: 0, y: (1 - v) / 2, width: 1, height: v }; break
    case 'close-horizontal': result.mask = { x: (1 - v) / 2, y: 0, width: v, height: 1 }; break
    case 'slide-left': result.translateX = -(1 - v); break
    case 'slide-right': result.translateX = 1 - v; break
    case 'zoom': result.scale = v; result.opacity = v; break
    case 'diagonal': result.aperture = 'diagonal'; break
    case 'radial': result.aperture = 'radial'; break
    case 'iris': result.aperture = 'circle'; break
    case 'diamond': result.aperture = 'diamond'; break
    case 'blinds': result.aperture = 'blinds'; break
    case 'flash-white': result.opacity = v; result.color = '#fff9e8'; break
    case 'defocus': result.opacity = v; result.blur = 16; result.blurStrength = 1 - v; break
    case 'zoom-through': result.scale = 1 + 0.12 * (1 - v); result.opacity = v; break
    case 'zoom-fade':
    case 'zoom-fade-left':
    case 'zoom-fade-right':
    case 'zoom-fade-up':
    case 'zoom-fade-down':
      result.scale = 0.8 + 0.2 * v
      result.opacity = v
      if (effect === 'zoom-fade-left') result.translateX = -0.1 * (1 - v)
      if (effect === 'zoom-fade-right') result.translateX = 0.1 * (1 - v)
      if (effect === 'zoom-fade-up') result.translateY = -0.1 * (1 - v)
      if (effect === 'zoom-fade-down') result.translateY = 0.1 * (1 - v)
      break
  }
  return result
}

/** Eight staggered strips, normalized to the original clip rectangle. */
export function transitionBlindRects(visibility: number): { x: number; y: number; width: number; height: number }[] {
  const v = Math.max(0, Math.min(1, visibility))
  return Array.from({ length: 8 }, (_, row) => ({ x: 0, y: row / 8, width: 1, height: Math.max(0, Math.min(1, (v - 0.22 * row / 7) / 0.78)) / 8 }))
}

/** Shared by the material gallery and the timeline so customization previews match output. */
export function transitionVisualForParameters(sourceEffect: TransitionEffect, visibility: number, parameters: TransitionParameters = {}): TransitionVisual {
  let effect = sourceEffect
  if (parameters.direction && effect.startsWith('wipe-')) effect = `wipe-${parameters.direction}` as TransitionEffect
  if (parameters.direction && effect.startsWith('slide-')) effect = parameters.direction === 'left' || parameters.direction === 'up' ? 'slide-left' : 'slide-right'
  const visual = transitionVisual(effect, easeProgress(visibility, parameters.easing))
  if (parameters.direction && sourceEffect.startsWith('slide-') && ['up', 'down'].includes(parameters.direction)) { visual.translateY = visual.translateX; visual.translateX = 0 }
  if (parameters.color) visual.color = parameters.color
  if (parameters.blur !== undefined) { visual.blur = parameters.blur; visual.blurStrength = 1 - visual.visibility }
  return visual
}

/** Matching native export semantics: each side fades/masks toward the cut. */
export function transitionVisualAt(project: Project, clipId: string, time: number): TransitionVisual | undefined {
  if (project.tracks.some(track => track.hidden && track.clips.some(clip => clip.id === clipId))) return undefined
  for (const track of project.tracks) {
    if (track.kind !== 'transition' || track.hidden || track.muted) continue
    for (const clip of track.clips) {
      const binding = clip.transition
      if (!binding || (binding.fromClipId !== clipId && binding.toClipId !== clipId) || time < clip.start || time >= endOf(clip)) continue
      const middle = clip.start + durationOf(clip) / 2
      const outgoing = binding.fromClipId === clipId
      if ((outgoing && time >= middle) || (!outgoing && time < middle)) continue
      const v = Math.min(1, Math.max(0, (outgoing ? middle - time : time - middle) / (durationOf(clip) / 2)))
      if ((binding.scope === 'outgoing' && !outgoing) || (binding.scope === 'incoming' && outgoing)) continue
      return transitionVisualForParameters(binding.effect, v, binding)
    }
  }
  return undefined
}
