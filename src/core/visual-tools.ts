import { cloneProject, createClip, createTextClip, createTrack, newId, validateProject } from './project.ts'
import { clipDuration, findClip } from './timeline.ts'
import { reconcileTransitions } from './transitions.ts'
import { OVERLAY_PRESETS, ANIMATION_EASINGS, validateKeyframes, validateNormalizedRect, validateSpeedRamp, validateTransitionParameters, visualChoice, visualColor, visualNumber, visualRecord } from './visual-animation.ts'
import { applyVisualMotionPreset, VISUAL_MOTION_PRESETS } from './visual-motion-presets.ts'
import type { Clip, ClipKeyframes, Project, Track } from './types.ts'

export interface VisualToolResult { project: Project; data: Record<string, unknown>; label: string; selection?: string }
export type TitlePreset = 'chapter' | 'lower-third' | 'corner' | 'subtitle'
export function titleBoundsForPreset(project: Pick<Project, 'width' | 'height'>, preset: TitlePreset): Pick<Clip, 'x' | 'y' | 'width' | 'height'> {
  return { x: project.width * 0.08, y: project.height * (preset === 'chapter' ? 0.39 : preset === 'corner' ? 0.06 : 0.72), width: project.width * 0.84, height: project.height * 0.22 }
}
function requiredText(value: unknown, label: string, max = 160): string { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label}无效。`); return value }
function target(project: Project, value: unknown): { clip: Clip; track: Track } {
  const found = findClip(project, requiredText(value, '片段标识'))
  if (!found) throw new Error('片段不存在。')
  if (found.track.locked) throw new Error('请先解锁此轨道。')
  return found
}
function textTrack(project: Project, trackId: unknown, name: string): Track {
  let track = trackId === undefined ? project.tracks.find(t => t.kind === 'text' && t.name === name && !t.locked) : project.tracks.find(t => t.id === requiredText(trackId, '轨道标识'))
  if (trackId !== undefined && !track) throw new Error('轨道不存在。')
  if (track && (track.kind !== 'text' || track.locked)) throw new Error('请选择未锁定的文字轨道。')
  if (!track) { track = createTrack('text', name); project.tracks.unshift(track) }
  return track
}
function trimAnimation(clip: Clip): void {
  const duration = clipDuration(clip)
  clip.fadeIn = Math.min(clip.fadeIn, duration); clip.fadeOut = Math.min(clip.fadeOut, duration)

}

/** Synchronous operations are committed as one validated, undoable project revision. */
export function executeVisualTool(project: Project, name: string, value: unknown): VisualToolResult {
  const args = visualRecord(value, '视觉工具参数'), next = cloneProject(project)
  const tool = name.replace(/^open_media_/, '')
  let label = '', selection: string | undefined, data: Record<string, unknown> = {}
  if (['clip_keyframes_set', 'clip_crop', 'focus_region', 'clip_freeze_frame', 'clip_speed_ramp', 'transition_parameters_set'].includes(tool)) {
    const { clip, track } = target(next, args.clipId); selection = clip.id
    if (tool !== 'transition_parameters_set' && track.kind === 'transition') throw new Error('请使用转场参数工具编辑转场。')
    if (tool === 'clip_keyframes_set') {
      if (args.clear === true) delete clip.keyframes
      if (args.keyframes !== undefined) {
        const frames = validateKeyframes(args.keyframes, clipDuration(clip))
        if (track.kind === 'audio' && Object.keys(frames).some(key => key !== 'volume')) throw new Error('音频片段只支持音量关键帧。')
        if (frames.volume && (track.kind === 'text' || next.assets.find(asset => asset.id === clip.assetId)?.kind === 'image')) throw new Error('该片段没有可调节的音频。')
        if (clip.animationOffset) for (const group of Object.values(frames)) for (const frame of group) frame.time += clip.animationOffset
        clip.keyframes = { ...clip.keyframes, ...frames }
      }
      if (args.clear !== true && args.keyframes === undefined) throw new Error('请提供关键帧或清除指令。')
      label = '设置关键帧'
    } else if (tool === 'clip_crop') {
      if (track.kind !== 'video') throw new Error('请选择视频或图片片段。')
      if (args.clear === true) delete clip.crop
      else clip.crop = validateNormalizedRect(args.crop)
      label = '裁剪源画面'
    } else if (tool === 'focus_region') {
      if (track.kind !== 'video') throw new Error('请选择视频或图片片段。')
      const r = validateNormalizedRect(args.region), length = clipDuration(clip)
      const start = visualNumber(args.start ?? 0, '聚焦开始时间', 0, length)
      const duration = visualNumber(args.duration ?? Math.min(1, length - start), '聚焦时长', 0.01, length - start)
      const easing = visualChoice(args.easing ?? 'ease-in-out', ANIMATION_EASINGS, '缓动')
      clip.x = 0; clip.y = 0; clip.width = next.width; clip.height = next.height; clip.fit = 'fill'; delete clip.crop
      const endX = next.width * ((1 / r.width - 1) / 2 - r.x / r.width), endY = next.height * ((1 / r.height - 1) / 2 - r.y / r.height)
      const frames = (from: number, to: number) => [{ time: start + (clip.animationOffset ?? 0), value: from, easing }, { time: start + duration + (clip.animationOffset ?? 0), value: to }]
      clip.keyframes = { ...clip.keyframes, x: frames(0, endX), y: frames(0, endY), scaleX: frames(1, 1 / r.width), scaleY: frames(1, 1 / r.height) }
      label = '聚焦画面区域'
    } else if (tool === 'clip_freeze_frame') {
      const asset = next.assets.find(a => a.id === clip.assetId)
      if (track.kind !== 'video' || asset?.kind !== 'video') throw new Error('停帧只适用于视频片段。')
      if (args.clear === true) {
        if (clip.freezeFrame) { Object.assign(clip, clip.freezeFrame.original); delete clip.freezeFrame }
      } else {
        const sourceTime = visualNumber(args.sourceTime, '停帧源时间', 0, asset.duration - 0.000001)
        const duration = visualNumber(args.duration ?? 3, '停帧时长', 0.01, 86400)
        clip.freezeFrame = { sourceTime, original: clip.freezeFrame?.original ?? { trimIn: clip.trimIn, trimOut: clip.trimOut, speed: clip.speed, volume: clip.volume, ...(clip.speedRamp ? { speedRamp: clip.speedRamp } : {}) } }
        clip.trimIn = 0; clip.trimOut = duration; clip.speed = 1; clip.volume = 0; delete clip.speedRamp
      }
      trimAnimation(clip); label = '设置停帧'
    } else if (tool === 'clip_speed_ramp') {
      const asset = next.assets.find(a => a.id === clip.assetId)
      if (!['video', 'audio'].includes(track.kind) || !asset || asset.kind === 'image' || clip.freezeFrame) throw new Error('请选择非停帧的视频或音频片段。')
      if (args.clear === true) delete clip.speedRamp
      else clip.speedRamp = { ...validateSpeedRamp(args), sourceRange: { start: clip.trimIn, end: clip.trimOut } }
      trimAnimation(clip); label = '设置变速曲线'
    } else {
      if (track.kind !== 'transition' || !clip.transition) throw new Error('请选择转场片段。')
      for (const id of [clip.transition.fromClipId, clip.transition.toClipId]) if (findClip(next, id)?.track.locked) throw new Error('请先解锁关联的视频轨道。')
      if (args.clear === true) clip.transition = { effect: clip.transition.effect, fromClipId: clip.transition.fromClipId, toClipId: clip.transition.toClipId }
      Object.assign(clip.transition, validateTransitionParameters(args)); label = '设置转场参数'
    }
    data = { clipId: clip.id, duration: clipDuration(clip) }
  } else if (tool === 'overlay_add') {
    const kind = visualChoice(args.kind, OVERLAY_PRESETS.map(item => item.id), '标注类型')
    const x = visualNumber(args.x, '横坐标', -65536, 65536), y = visualNumber(args.y, '纵坐标', -65536, 65536)
    const width = visualNumber(args.width, '宽度', 1, 65536), height = visualNumber(args.height, '高度', 1, 65536)
    const track = textTrack(next, args.trackId, '视觉标注轨道')
    const clip = createTextClip(next, { name: kind === 'arrow' ? '箭头标注' : kind === 'rectangle' ? '矩形标注' : kind === 'highlight' ? '区域高亮' : OVERLAY_PRESETS.find(item => item.id === kind)!.label, text: '', textRole: 'watermark', start: visualNumber(args.start, '开始时间', 0, 86400), trimOut: visualNumber(args.duration, '时长', 0.001, 86400), x, y, width, height, rotation: visualNumber(args.rotation ?? 0, '旋转', -3600, 3600), opacity: visualNumber(args.opacity ?? (kind === 'highlight' ? 0.3 : kind === 'spotlight' ? 0.7 : 1), '不透明度', 0, 1), overlay: { kind, color: visualColor(args.color ?? (kind === 'mask' || kind === 'spotlight' ? '#000000' : '#f7c948')), strokeWidth: visualNumber(args.strokeWidth ?? 6, '线宽', 1, 100), blurRadius: visualNumber(args.blurRadius ?? 12, '模糊半径', 1, 50) } })
    if (kind === 'spotlight') { clip.overlay!.region = { x, y, width, height }; clip.x = 0; clip.y = 0; clip.width = next.width; clip.height = next.height }
    if (args.animation !== undefined) Object.assign(clip, applyVisualMotionPreset(clip, visualChoice(args.animation, VISUAL_MOTION_PRESETS.map(item => item.id), '标注动画')))
    track.clips.push(clip); selection = clip.id; label = '添加视觉标注'; data = { clipId: clip.id, trackId: track.id }
  } else if (tool === 'title_add') {
    const preset = visualChoice(args.preset, ['chapter', 'lower-third', 'corner', 'subtitle'], '标题类型'), duration = visualNumber(args.duration, '标题时长', 0.01, 86400)
    const bounds = titleBoundsForPreset(next, preset)
    for (const axis of ['x', 'y'] as const) if (args[axis] !== undefined) bounds[axis] = visualNumber(args[axis], axis === 'x' ? '标题横坐标' : '标题纵坐标', -65536, 65536)
    for (const dimension of ['width', 'height'] as const) if (args[dimension] !== undefined) bounds[dimension] = visualNumber(args[dimension], dimension === 'width' ? '标题宽度' : '标题高度', 1, 65536)
    const track = textTrack(next, args.trackId, preset === 'subtitle' ? '字幕轨道' : '标题轨道')
    const clip = createTextClip(next, { text: requiredText(args.text, '标题文字', 20000), name: { chapter: '章节标题', 'lower-third': '下三分之一标题', corner: '角标', subtitle: '字幕' }[preset], start: visualNumber(args.start, '开始时间', 0, 86400), trimOut: duration, ...bounds, fontSize: visualNumber(args.fontSize ?? Math.max(4, next.height * (preset === 'chapter' ? 0.09 : 0.05)), '字号', 4, 2048), fontFamily: args.fontFamily === undefined ? 'sans-serif' : requiredText(args.fontFamily, '字体', 200), color: visualColor(args.color ?? '#ffffff'), background: args.background === undefined ? 'transparent' : visualColor(args.background), textRole: preset === 'subtitle' ? 'subtitle' : 'watermark', textAlign: preset === 'corner' || preset === 'lower-third' ? 'left' : 'center' })
    const animation = visualChoice(args.animation ?? 'fade', ['none', 'fade', 'slide', 'zoom'], '标题动画'), enter = Math.min(0.5, duration / 3)
    if (animation !== 'none') clip.keyframes = { opacity: [{ time: 0, value: 0 }, { time: enter, value: 1 }, { time: duration - enter, value: 1 }, { time: duration, value: 0 }] }
    if (animation === 'slide') clip.keyframes!.y = [{ time: 0, value: clip.y + next.height * 0.05, easing: 'ease-out' }, { time: enter, value: clip.y }]
    if (animation === 'zoom') { const frames = [{ time: 0, value: 0.8, easing: 'ease-out' as const }, { time: enter, value: 1 }]; clip.keyframes!.scaleX = frames; clip.keyframes!.scaleY = frames }
    track.clips.push(clip); selection = clip.id; label = '添加动画标题'; data = { clipId: clip.id, trackId: track.id }
  } else if (tool === 'template_customize') {
    if (!Array.isArray(args.clipIds) || args.clipIds.length < 1 || args.clipIds.length > 100 || new Set(args.clipIds).size !== args.clipIds.length) throw new Error('请选择 1 至 100 个不同片段。')
    const clips = args.clipIds.map(id => { const result = target(next, id); if (result.track.kind === 'transition' || result.track.kind === 'audio') throw new Error('模板定制只适用于视觉片段。'); return result.clip })
    for (const clip of clips) {
      if (clip.text === undefined && ['color', 'background', 'fontFamily', 'fontSize'].some(key => args[key] !== undefined)) throw new Error('颜色、背景与字体定制只适用于可编辑文字或视觉标注，请单独选择相关片段。')
      if (args.color !== undefined) { clip.color = visualColor(args.color); if (clip.overlay) clip.overlay.color = clip.color }
      if (args.background !== undefined) clip.background = visualColor(args.background)
      if (args.fontFamily !== undefined) clip.fontFamily = requiredText(args.fontFamily, '字体', 200)
      if (args.fontSize !== undefined) clip.fontSize = visualNumber(args.fontSize, '字号', 4, 2048)
      if (args.opacity !== undefined) clip.opacity = visualNumber(args.opacity, '不透明度', 0, 1)
      if (args.duration !== undefined) { if (clip.speedRamp) throw new Error('请先清除变速曲线再统一设置时长。'); clip.trimOut = clip.trimIn + visualNumber(args.duration, '时长', 0.01, 86400) * clip.speed; trimAnimation(clip) }
      if (args.layout !== undefined) { const layout = visualChoice(args.layout, ['center', 'lower-third', 'top-left', 'top-right'], '布局'); clip.x = layout === 'top-left' ? next.width * 0.05 : layout === 'top-right' ? next.width * 0.95 - clip.width : (next.width - clip.width) / 2; clip.y = layout.startsWith('top') ? next.height * 0.05 : layout === 'lower-third' ? next.height * 0.8 - clip.height / 2 : (next.height - clip.height) / 2; delete clip.keyframes?.x; delete clip.keyframes?.y }
    }
    if (args.logoAssetId !== undefined) {
      const asset = next.assets.find(a => a.id === requiredText(args.logoAssetId, 'Logo素材'))
      if (asset?.kind !== 'image') throw new Error('Logo需要已有的图片素材。')
      const track = createTrack('video', 'Logo轨道'), start = Math.min(...clips.map(c => c.start)), end = Math.max(...clips.map(c => c.start + clipDuration(c)))
      track.clips.push(createClip(asset, next, { id: newId('clip'), name: 'Logo', start, trimOut: end - start, x: next.width * 0.82, y: next.height * 0.05, width: next.width * 0.13, height: next.height * 0.13, volume: 0 }))
      next.tracks.unshift(track)
    }
    selection = clips[0]!.id; label = '定制模板'; data = { clipIds: clips.map(c => c.id) }
  } else throw new Error(`未知视觉工具：${name}`)
  reconcileTransitions(next, project)
  next.updatedAt = new Date().toISOString()
  return { project: validateProject(next, { trusted: true }), data, label, selection }
}
