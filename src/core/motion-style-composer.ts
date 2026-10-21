import { cloneProject, createClip, createTextClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, newId, validateProject } from './project.ts'
import { projectDuration } from './timeline.ts'
import { videoWorkingCopyResolver } from './video-working-copies.ts'
import { getMotionStyle, MOTION_STYLES } from './motion-style-catalog.ts'
import type { MotionStyle, MotionStyleId } from './motion-style-catalog.ts'
import type { AnimationEasing, Clip, ClipKeyframe, ClipKeyframes, MediaAsset, Project, Track } from './types.ts'

export interface MotionSceneInput { assetId: string; heading?: string; caption?: string; duration?: number; trimIn?: number }
export interface MotionComposeOptions {
  styleId: string
  scenes: MotionSceneInput[]
  placement?: 'append' | 'prepend'
  title?: string
  accent?: string
  background?: string
  textColor?: string
  musicAssetId?: string
  musicVolume?: number
  sourceAudio?: boolean
  tempo?: 'calm' | 'balanced' | 'energetic'
  logoAssetId?: string
}
export type MotionCompositionOptions = MotionComposeOptions
export interface MotionPlannedScene { assetId: string; heading: string; caption: string; duration: number; trimIn: number; start: number }
export interface MotionCompositionPlan {
  styleId: MotionStyleId
  title: string
  placement: 'append' | 'prepend'
  start: number
  duration: number
  scenes: MotionPlannedScene[]
  warnings: string[]
  palette: MotionStyle['palette']
  tempo: 'calm' | 'balanced' | 'energetic'
  sourceAudio: boolean
  musicAssetId?: string
  musicVolume: number
  logoAssetId?: string
}
export interface MotionCompositionResources { background: MediaAsset; decoration: MediaAsset }
export interface MotionCompositionResult {
  project: Project
  data: { styleId: MotionStyleId; title: string; placement: 'append' | 'prepend'; start: number; duration: number; sceneCount: number; clipIds: string[]; trackIds: string[]; warnings: string[] }
  selection: { trackId: string; clipId: string }
}

const OPTION_KEYS = new Set(['styleId', 'scenes', 'placement', 'title', 'accent', 'background', 'textColor', 'musicAssetId', 'musicVolume', 'sourceAudio', 'tempo', 'logoAssetId'])
const SCENE_KEYS = new Set(['assetId', 'heading', 'caption', 'duration', 'trimIn'])

function record(value: unknown, keys: Set<string>, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效。`)
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${label}包含不支持的参数：${key}。`)
  return value as Record<string, unknown>
}
function finite(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}需为 ${min} 至 ${max} 之间的数字。`)
  return value
}
function text(value: unknown, max: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || /\0/.test(value) || (!allowEmpty && !value.trim())) throw new Error(`${label}格式无效或超过 ${max} 个字符。`)
  return value.trim()
}
function color(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error('风格颜色需使用六位十六进制颜色。')
  return value
}
function selectedAsset(project: Project, value: unknown, kind: 'audio' | 'image', label: string): string | undefined {
  if (value === undefined) return undefined
  const id = text(value, 160, label), asset = project.assets.find(item => item.id === id)
  if (!asset || asset.kind !== kind || !asset.url) throw new Error(`${label}需要选择项目内可用的${kind === 'audio' ? '音频' : '图片'}素材。`)
  return id
}

/** An external-code direction must never silently fall back to a different preset. */
export function getMotionPresetStyle(id: string): MotionStyle {
  const style = getMotionStyle(id)
  if (!style.presetSupported) throw new Error(`“${style.name}”需要外部 Agent 根据默认提示词编写动画代码并渲染视频，不支持内置二维预设。请读取 open_media_motion_brief_get，渲染后通过 open_media_asset_upload 或 open_media_asset_import_url 回传工程。`)
  return style
}

/** Validate and plan without creating IDs, media or timeline changes. */
export function planMotionComposition(project: Project, options: MotionComposeOptions): MotionCompositionPlan {
  const input = record(options, OPTION_KEYS, '风格成片参数')
  const current = validateProject(project, { trusted: true })
  const style = getMotionPresetStyle(text(input.styleId, 80, '风格'))
  const placement = input.placement === undefined ? 'append' : input.placement
  if (placement !== 'append' && placement !== 'prepend') throw new Error('请选择向前或向后添加。')
  const tempo = input.tempo === undefined ? 'balanced' : input.tempo
  if (tempo !== 'calm' && tempo !== 'balanced' && tempo !== 'energetic') throw new Error('动画节奏无效。')
  if (input.sourceAudio !== undefined && typeof input.sourceAudio !== 'boolean') throw new Error('保留原声需为开关值。')
  if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 16) throw new Error('风格成片需要 1 至 16 个场景。')
  const title = input.title === undefined ? `${style.name}成片` : text(input.title, 120, '成片名称')
  const palette = { ...style.palette, background: color(input.background, style.palette.background), accent: color(input.accent, style.palette.accent), textColor: color(input.textColor, style.palette.textColor) }
  const musicAssetId = selectedAsset(current, input.musicAssetId, 'audio', '背景音乐')
  const logoAssetId = selectedAsset(current, input.logoAssetId, 'image', '标志图片')
  const musicVolume = input.musicVolume === undefined ? .22 : finite(input.musicVolume, 0, 1, '背景音乐音量')
  const start = placement === 'append' ? projectDuration(current) : 0
  const warnings: string[] = []
  const workingAsset = videoWorkingCopyResolver(current)
  let duration = 0
  const scenes = input.scenes.map((value, index): MotionPlannedScene => {
    const scene = record(value, SCENE_KEYS, `第 ${index + 1} 个场景`)
    const requestedAssetId = text(scene.assetId, 160, '场景素材'), selected = current.assets.find(item => item.id === requestedAssetId)
    if (!selected || (selected.kind !== 'image' && selected.kind !== 'video') || !selected.url) throw new Error(`第 ${index + 1} 个场景需要项目内可用的图片或视频。`)
    const asset = workingAsset(selected), assetId = asset.id
    const requested = scene.duration === undefined ? 4 : finite(scene.duration, 2, 12, '场景时长')
    let actual = requested, trimIn = 0
    if (asset.kind === 'image' && scene.trimIn !== undefined) throw new Error('只有视频场景支持设置素材起点。')
    if (asset.kind === 'video') {
      trimIn = scene.trimIn === undefined ? 0 : finite(scene.trimIn, 0, asset.duration, '视频素材起点')
      const remaining = asset.duration - trimIn
      if (remaining < .25 - 1e-8) throw new Error(`第 ${index + 1} 个场景的视频剩余时长不足 0.25 秒。`)
      actual = Math.min(requested, remaining)
      if (actual < requested) warnings.push(`场景 ${index + 1}“${asset.name}”剩余 ${actual.toFixed(2)} 秒，已缩短场景时长；原视频保持正常速度。`)
    }
    const fallback = index === 0 && input.title !== undefined ? title : asset.name.replace(/\.[^.]+$/, '').slice(0, 120)
    const heading = scene.heading === undefined ? fallback : text(scene.heading, 120, '场景标题', true)
    const caption = scene.caption === undefined ? '' : text(scene.caption, 240, '场景说明', true)
    const planned = { assetId, heading, caption, duration: actual, trimIn, start: start + duration }
    duration += actual
    return planned
  })
  if (projectDuration(current) + duration > MAX_PROJECT_DURATION) throw new Error('添加后时间线将超过 24 小时，请先缩短项目。')
  if (placement === 'prepend') {
    const locked = current.tracks.find(track => track.locked && track.clips.length > 0)
    if (locked) throw new Error(`向前添加需要整体后移现有片段，请先解锁“${locked.name}”。`)
    if (current.markers?.some(marker => marker.time + duration > MAX_PROJECT_DURATION)) throw new Error('向前添加后，已有标记将超过 24 小时。')
  }
  if ((current.markers?.length ?? 0) + scenes.length > 1000) throw new Error('添加场景章节后将超过 1000 个标记。')
  const trackCount = 5 + Number(scenes.some(scene => scene.heading)) + Number(scenes.some(scene => scene.caption)) + Number(Boolean(logoAssetId)) + Number(Boolean(musicAssetId))
  const clipCount = 1 + scenes.length * 5 + scenes.filter(scene => scene.heading).length + scenes.filter(scene => scene.caption).length + Number(Boolean(logoAssetId)) + Number(Boolean(musicAssetId))
  if (current.tracks.length + trackCount > MAX_TRACKS) throw new Error(`项目最多容纳 ${MAX_TRACKS} 条轨道，请先移除不用的轨道。`)
  if (current.tracks.reduce((count, track) => count + track.clips.length, 0) + clipCount > MAX_CLIPS) throw new Error(`项目最多容纳 ${MAX_CLIPS} 个片段。`)
  const nativeClipCount = current.tracks.filter(track => track.kind !== 'transition').reduce((count, track) => count + track.clips.length, 0) + clipCount
  if (nativeClipCount > 500) warnings.push(`添加后共有 ${nativeClipCount} 个非转场片段；当前桌面视频导出最多支持 500 个，请在导出前减少片段或分成多个工程。`)
  // Preparation always creates these two shared images, not one file per scene.
  if (current.assets.length + 2 > MAX_ASSETS) throw new Error(`项目最多容纳 ${MAX_ASSETS} 个素材，请预留两张风格图像的位置。`)
  return { styleId: style.id, title, placement, start, duration, scenes, warnings, palette, tempo, sourceAudio: input.sourceAudio === true, musicAssetId, musicVolume, logoAssetId }
}

type Box = { x: number; y: number; width: number; height: number }
type RatioBox = readonly [number, number, number, number]
interface SceneLayout { media: Box; heading: Box; caption: Box; align: 'left' | 'center' | 'right'; headingSize: number }

// Separate compositions give each style its own reading order and negative space.
const LANDSCAPE: Partial<Record<MotionStyleId, readonly [RatioBox, RatioBox, RatioBox]>> = {
  'paper-ink': [[.49,.19,.43,.62],[.08,.22,.34,.25],[.08,.55,.34,.15]],
  'iso-cards': [[.21,.25,.66,.52],[.08,.075,.66,.13],[.08,.82,.75,.09]],
  'flat-pop': [[.08,.25,.54,.63],[.67,.21,.25,.3],[.67,.6,.25,.19]],
  'line-focus': [[.20,.25,.60,.52],[.16,.075,.68,.115],[.20,.81,.60,.08]],
  'studio-depth': [[.17,.23,.66,.52],[.20,.07,.60,.12],[.24,.80,.52,.09]],
  'shape-rhythm': [[.29,.16,.62,.57],[.08,.76,.60,.14],[.08,.07,.60,.07]],
  'sticker-notes': [[.44,.16,.48,.67],[.08,.25,.29,.26],[.08,.57,.29,.17]],
  'tech-hud': [[.42,.22,.50,.62],[.08,.18,.29,.27],[.08,.54,.29,.22]],
  'editorial-collage': [[.40,.19,.50,.65],[.075,.08,.65,.12],[.075,.47,.28,.25]],
  'aurora-glass': [[.20,.27,.60,.48],[.15,.08,.70,.12],[.18,.81,.64,.09]],
  'geometric-grid': [[.09,.21,.51,.61],[.65,.16,.27,.28],[.65,.54,.27,.20]],
  'neon-retro': [[.17,.29,.66,.48],[.10,.09,.80,.11],[.16,.82,.68,.07]],
  'pixel-arcade': [[.14,.26,.72,.52],[.14,.08,.72,.11],[.14,.84,.72,.07]],
  'liquid-color': [[.16,.24,.68,.54],[.12,.075,.76,.12],[.16,.84,.68,.07]],
  'expressive-type': [[.10,.32,.58,.50],[.12,.09,.76,.19],[.73,.39,.20,.27]],
}
function layoutFor(project: Project, style: MotionStyle, sceneIndex: number): SceneLayout {
  const index = MOTION_STYLES.findIndex(item => item.id === style.id)
  let boxes = LANDSCAPE[style.id]
  if (!style.presetSupported || !boxes) throw new Error('当前风格没有内置二维预设布局，请由外部 Agent 按默认提示词渲染。')
  if (project.height > project.width * 1.12) {
    const top = style.layout === 'collage' ? .25 : style.layout === 'stack' ? .30 : .28
    const inset = .085 + (index % 4) * .008
    boxes = [[inset,top,1-inset*2,.43 + (index % 3) * .015],[.09,.075,.82,.13],[.10,.79,.80,.12]]
  } else if (project.width < project.height * 1.3) {
    boxes = [[.12,.28,.76,.46],[.10,.075,.80,.14],[.12,.81,.76,.1]]
  }
  const mirrored = project.width >= project.height * 1.3 && style.layout === 'split' && sceneIndex % 2 === 1
  const pixelBox = ([x,y,width,height]: RatioBox): Box => ({ x: (mirrored ? 1-x-width : x) * project.width, y: y * project.height, width: width * project.width, height: height * project.height })
  return { media: pixelBox(boxes[0]), heading: pixelBox(boxes[1]), caption: pixelBox(boxes[2]), align: style.layout === 'center' || project.width < project.height * 1.3 ? 'center' : mirrored ? 'right' : 'left', headingSize: style.id === 'expressive-type' ? .075 : style.id === 'tech-hud' ? .045 : .058 }
}

function sequence(duration: number, times: number[], values: number[], easing: AnimationEasing = 'ease-in-out'): ClipKeyframe[] {
  return times.map((time, index) => ({ time: time * duration, value: values[index]!, easing }))
}
function motion(clip: Clip, style: MotionStyle, duration: number, tempo: MotionCompositionPlan['tempo'], role: 'media' | 'text' | 'decoration', variation: number): ClipKeyframes {
  const direction = variation % 2 ? -1 : 1
  const energy = tempo === 'calm' ? .65 : tempo === 'energetic' ? 1.25 : 1
  const entrance = tempo === 'calm' ? .23 : tempo === 'energetic' ? .12 : .18
  const exit = tempo === 'calm' ? .87 : tempo === 'energetic' ? .92 : .89
  const times = [0, entrance, .5, exit, 1]
  const distance = Math.min(48, Math.min(clip.width, clip.height) * .055) * energy
  // Use native scaling/translation and fades throughout. Even small affine or
  // alpha expressions become expensive when many decorated scenes are exported.
  if (role === 'text') return { y: sequence(duration, times, [clip.y+distance*.5,clip.y,clip.y,clip.y,clip.y-distance*.25], 'ease-out') }
  const keyframes: ClipKeyframes = {}
  if (style.motion === 'bounce') {
    const pulse = role === 'decoration' ? 1.055 : 1.025
    const bounceTimes = [0, entrance * .75, entrance * 1.5, exit, 1]
    keyframes.scaleX = sequence(duration, bounceTimes, [.88,pulse,1,1,.96], 'ease-out')
    keyframes.scaleY = sequence(duration, bounceTimes, [.88,pulse,1,1,.96], 'ease-out')
    keyframes.y = sequence(duration, times, [clip.y+distance,clip.y,clip.y,clip.y,clip.y-distance*.3], 'ease-out')
  } else if (style.motion === 'slide') {
    keyframes.x = sequence(duration, times, [clip.x+distance*direction,clip.x,clip.x,clip.x,clip.x-distance*.5*direction], 'ease-out')
    if (style.id === 'tech-hud') keyframes.scaleY = sequence(duration, times, [.94,1,1,1,.98])
  } else if (style.motion === 'step') {
    const stepTimes = [0,.06,.12,.18,.40,.60,.82,.94,1]
    const delta = Math.min(6, distance * .18)
    keyframes.x = sequence(duration, stepTimes, [clip.x+distance*direction,clip.x+distance*.4*direction,clip.x-delta,clip.x,clip.x+delta,clip.x,clip.x-delta,clip.x,clip.x], 'step')
    keyframes.scaleX = sequence(duration, stepTimes, [.94,.97,1,1,1,1,1,.98,.96], 'step')
    keyframes.scaleY = sequence(duration, stepTimes, [.94,.97,1,1,1,1,1,.98,.96], 'step')
  } else if (style.motion === 'orbit') {
    keyframes.x = sequence(duration, times, [clip.x-distance*.25,clip.x,clip.x+distance*.12,clip.x,clip.x-distance*.25])
    keyframes.y = sequence(duration, times, [clip.y+distance*.5,clip.y,clip.y-distance*.12,clip.y,clip.y-distance*.5])
    keyframes.scaleX = sequence(duration, times, [.93,1,1.02,1,.96])
    keyframes.scaleY = sequence(duration, times, [.93,1,1.02,1,.96])
  } else {
    keyframes.y = sequence(duration, times, [clip.y+distance*.5,clip.y,clip.y-distance*.12,clip.y,clip.y-distance*.3])
    const finalScale = style.id === 'neon-retro' ? 1.04 : 1.015
    keyframes.scaleX = sequence(duration, times, [.96,1,finalScale,finalScale,1])
    keyframes.scaleY = sequence(duration, times, [.96,1,finalScale,finalScale,1])
  }
  return keyframes
}
function fontSize(value: string, box: Box, desired: number): number {
  // Match the renderer's 24px inset and 1.35 line spacing. Area estimates miss
  // discrete wraps in narrow cards; explicit empty lines consume height too.
  const width = Math.max(1, box.width - 24) * .96
  const height = Math.max(1, box.height - Math.min(24, box.height * .12))
  const paragraphs = value.split('\n').map(paragraph => [...paragraph].map(char => /[MW@#%]/.test(char) || char.charCodeAt(0) >= 256 ? 1.08 : .75))
  const fits = (size: number): boolean => {
    const capacity = width / size
    let lines = 0
    for (const paragraph of paragraphs) {
      let occupied = 0
      lines++
      for (const glyph of paragraph) {
        if (occupied > 0 && occupied + glyph > capacity) { lines++; occupied = glyph }
        else occupied += glyph
      }
    }
    return lines * size * 1.35 <= height
  }
  let low = 4, high = Math.max(4, Math.min(2048, desired, height / 1.35))
  for (let step = 0; step < 24; step++) {
    const candidate = (low + high) / 2
    if (fits(candidate)) low = candidate
    else high = candidate
  }
  return low
}
function fades(duration: number, tempo: MotionCompositionPlan['tempo']): Pick<Clip, 'fadeIn' | 'fadeOut'> {
  return { fadeIn: duration * (tempo === 'calm' ? .20 : tempo === 'energetic' ? .10 : .15), fadeOut: duration * (tempo === 'calm' ? .13 : tempo === 'energetic' ? .08 : .11) }
}
function ensureResources(project: Project, resources: MotionCompositionResources): void {
  if (!resources || typeof resources !== 'object') throw new Error('缺少生成的风格背景和装饰。')
  const seen = new Set(project.assets.map(asset => asset.id))
  for (const [label, asset] of [['背景', resources.background], ['装饰', resources.decoration]] as const) {
    if (!asset || asset.kind !== 'image' || !asset.id || !asset.url || !Number.isFinite(asset.size) || asset.size <= 0 || !Number.isFinite(asset.width) || asset.width < 1 || !Number.isFinite(asset.height) || asset.height < 1) throw new Error(`风格${label}需要可用的图片素材。`)
    if (seen.has(asset.id)) throw new Error('生成的风格图像标识重复，请重新准备素材。')
    seen.add(asset.id)
  }
}

/** Build editable native layers and return one detached project for a single undo step. */
export function composeMotionProject(project: Project, options: MotionComposeOptions, resources: MotionCompositionResources): MotionCompositionResult {
  const plan = planMotionComposition(project, options), style = getMotionStyle(plan.styleId)
  ensureResources(project, resources)
  const next = cloneProject(project)
  if (plan.placement === 'prepend') {
    for (const track of next.tracks) for (const clip of track.clips) clip.start += plan.duration
    for (const marker of next.markers ?? []) marker.time += plan.duration
  }
  next.assets.push({ ...resources.background }, { ...resources.decoration })
  const assets = new Map(next.assets.map(asset => [asset.id, asset]))
  const layer = (kind: Track['kind'], name: string) => createTrack(kind, `${plan.title} · ${name}`)
  const headings = layer('text', '标题'), captions = layer('text', '说明'), accents = layer('text', '强调线')
  const media = layer('video', '素材卡片'), frames = layer('text', '卡片底板'), decorations = layer('video', '图形装饰'), backgrounds = layer('video', '背景')
  const logo = plan.logoAssetId ? layer('video', '标志') : undefined, music = plan.musicAssetId ? layer('audio', '背景音乐') : undefined
  backgrounds.clips.push(createClip(resources.background, next, { name: `${style.name}背景`, start: plan.start, trimIn: 0, trimOut: plan.duration, volume: 0, fit: 'cover' }))
  for (const [index, scene] of plan.scenes.entries()) {
    const layout = layoutFor(next, style, index), asset = assets.get(scene.assetId)!
    const source = createClip(asset, next, { name: scene.heading || asset.name, ...layout.media, ...fades(scene.duration,plan.tempo), start: scene.start, trimIn: scene.trimIn, trimOut: scene.trimIn + scene.duration, volume: asset.kind === 'video' && plan.sourceAudio ? 1 : 0, fit: 'contain' })
    source.keyframes = motion(source, style, scene.duration, plan.tempo, 'media', index)
    media.clips.push(source)
    const border = Math.max(1, Math.min(next.width, next.height) * .012)
    const frame = createTextClip(next, { name: '素材卡片底板', text: '', textRole: 'watermark', ...fades(scene.duration,plan.tempo), start: scene.start, trimOut: scene.duration, x: source.x-border, y: source.y-border, width: source.width+border*2, height: source.height+border*2, opacity: style.id === 'aurora-glass' ? .24 : .82, overlay: { kind: 'highlight', color: plan.palette.secondary, strokeWidth: 1, blurRadius: 1 } })
    frame.keyframes = Object.fromEntries(Object.entries(source.keyframes).map(([property,frames]) => [property,frames.map(keyframe => ({...keyframe,value:keyframe.value - (property === 'x' || property === 'y' ? border : 0)}))]))
    frames.clips.push(frame)
    for (const [value, box, target, isHeading] of [[scene.heading,layout.heading,headings,true],[scene.caption,layout.caption,captions,false]] as const) {
      if (!value) continue
      const textClip = createTextClip(next, { name: isHeading ? `场景 ${index+1} 标题` : `场景 ${index+1} 说明`, text: value, textRole: 'watermark', ...fades(scene.duration,plan.tempo), start: scene.start, trimOut: scene.duration, ...box, fontFamily: style.fontFamily, fontSize: fontSize(value, box, Math.min(next.width,next.height) * (isHeading ? layout.headingSize * 1.7 : .031)), fontWeight: isHeading ? 700 : 400, color: plan.palette.textColor, background: 'transparent', textAlign: layout.align, textVerticalAlign: 'middle' })
      textClip.keyframes = motion(textClip, style, scene.duration, plan.tempo, 'text', index)
      target.clips.push(textClip)
    }
    const accentWidth = Math.min(layout.heading.width * .28, Math.min(next.width,next.height) * .18)
    const accent = createTextClip(next, { name: `场景 ${index+1} 强调线`, text: '', textRole: 'watermark', ...fades(scene.duration,plan.tempo), start: scene.start, trimOut: scene.duration, x: layout.align === 'center' ? layout.heading.x+(layout.heading.width-accentWidth)/2 : layout.align === 'right' ? layout.heading.x+layout.heading.width-accentWidth : layout.heading.x, y: Math.max(next.height*.05,layout.heading.y-Math.min(next.width,next.height)*.012), width: accentWidth, height: Math.max(1,Math.min(next.width,next.height) * (style.id === 'tech-hud' || style.id === 'line-focus' ? .002 : .006)), overlay: { kind: 'highlight', color: plan.palette.accent, strokeWidth: 1, blurRadius: 1 } })
    accent.keyframes = { scaleX: sequence(scene.duration, [0,.2,.9,1], [.6,1,1,.8], 'ease-out') }
    accents.clips.push(accent)
    for (let part = 0; part < 2; part++) {
      const side = Math.min(next.width,next.height) * (part ? .20 : .24)
      const decoration = createClip(resources.decoration, next, { name: `场景 ${index+1} 装饰 ${part+1}`, ...fades(scene.duration,plan.tempo), start: scene.start, trimOut: scene.duration, volume: 0, width: side, height: side, x: part ? next.width-side*.82 : -side*.22, y: part ? next.height-side*.93 : next.height*.03, opacity: style.id === 'tech-hud' ? .6 : .72, fit: 'contain' })
      decoration.keyframes = motion(decoration, style, scene.duration, plan.tempo, 'decoration', index+part)
      decorations.clips.push(decoration)
    }
  }
  if (logo && plan.logoAssetId) {
    const side = Math.min(next.width,next.height)*.075
    logo.clips.push(createClip(assets.get(plan.logoAssetId)!,next,{name:'品牌标志',start:plan.start,trimOut:plan.duration,x:next.width*.94-side,y:next.height*.055,width:side,height:side,volume:0,fit:'contain'}))
  }
  if (music && plan.musicAssetId) music.clips.push(createClip(assets.get(plan.musicAssetId)!,next,{name:'成片背景音乐',start:plan.start,trimOut:plan.duration,volume:plan.musicVolume,fadeIn:Math.min(.45,plan.duration*.15),fadeOut:Math.min(.7,plan.duration*.2)}))
  const tracks = [logo,headings,captions,accents,media,frames,decorations,backgrounds,music].filter((track): track is Track => Boolean(track?.clips.length))
  next.tracks.unshift(...tracks)
  next.markers = [...(next.markers ?? []), ...plan.scenes.map((scene,index) => ({ id: newId('marker'), time: scene.start, label: scene.heading || `场景 ${index+1}`, kind: 'chapter' as const, color: plan.palette.accent }))].sort((a,b) => a.time-b.time)
  next.updatedAt = new Date().toISOString()
  const result = validateProject(next, { trusted: true })
  return { project: result, data: { styleId: plan.styleId, title: plan.title, placement: plan.placement, start: plan.start, duration: plan.duration, sceneCount: plan.scenes.length, clipIds: tracks.flatMap(track => track.clips.map(clip => clip.id)), trackIds: tracks.map(track => track.id), warnings: [...plan.warnings] }, selection: { trackId: media.id, clipId: media.clips[0]!.id } }
}
