import type { EditorToolContext, EditorToolProgress, PreparedEditorTool } from './editor-tool-service.ts'
import type { MediaAsset, Project } from './types.ts'
import type { BrowserVideoExportOptions } from './browser-export.ts'
import { MOTION_STYLES, getMotionStyle, type MotionStyle } from './motion-style-catalog.ts'
import { composeMotionProject, getMotionPresetStyle, planMotionComposition, type MotionComposeOptions, type MotionCompositionPlan } from './motion-style-composer.ts'
import { assertProjectRevision } from './project-operations.ts'
import { cloneProject, createClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from './project.ts'
import { clipEnd, projectDuration } from './timeline.ts'
import { videoWorkingCopyResolver } from './video-working-copies.ts'
import { assertMcpMotionRequest } from './mcp-motion.ts'

export interface MotionClipGenerateOptions extends Omit<MotionComposeOptions, 'placement' | 'styleId'> {
  styleId?: string
  destination?: 'assets' | 'timeline'
  insert?: { trackId?: string; start?: number }
}
export interface MotionClipGenerationPlan extends Omit<MotionCompositionPlan, 'placement'> {
  destination: 'assets' | 'timeline'
  insert?: { trackId?: string; start: number }
  sourceAssetIds: string[]
  width: number
  height: number
}
export interface MotionRenderedClip {
  asset: MediaAsset
  accept: () => Promise<void>
  discard: () => void | Promise<void>
}
export interface MotionStyleDependencies {
  renderArt: (styleId: string, palette: Partial<MotionStyle['palette']>, width: number, height: number) => Promise<{ background: Blob; decoration: Blob }>
  isDesktop: () => boolean
  renderNative: (project: Project, signal: AbortSignal, onProgress: (update: EditorToolProgress) => void) => Promise<MotionRenderedClip>
  renderBrowser: (project: Project, options: BrowserVideoExportOptions) => Promise<Blob>
  importBrowser: (file: File) => Promise<MediaAsset>
  revokeAsset: (asset: MediaAsset) => void
}

async function defaults(): Promise<MotionStyleDependencies> {
  const [{ renderMotionStyleArt }, native, media, browser] = await Promise.all([
    import('./motion-style-art.ts'), import('../native.ts'), import('./media-import.ts'), import('./browser-export.ts'),
  ])
  return { renderArt: renderMotionStyleArt, isDesktop: native.isDesktop, renderNative: async (...args) => (await import('../native-motion-clip.ts')).renderMotionClip(...args), renderBrowser: browser.exportTimelineWebM, importBrowser: media.importMediaFile, revokeAsset: media.revokeMediaAsset }
}
function check(context: EditorToolContext): void { context.signal.throwIfAborted(); context.assertCurrent?.() }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效。`)
  return value as Record<string, unknown>
}
function freeAt(project: Project, trackId: string, start: number, duration: number): boolean {
  return project.tracks.find(track => track.id === trackId)!.clips.every(clip => clipEnd(clip) <= start + 1e-8 || clip.start >= start + duration - 1e-8)
}

function planInternal(project: Project, options: MotionClipGenerateOptions): { temporary: Project; options: MotionComposeOptions; plan: MotionClipGenerationPlan } {
  const input = assertMcpMotionRequest(project,object(options, '效果短片参数'))
  getMotionPresetStyle(input.styleId as string)
  if ('placement' in input) throw new Error('效果短片使用 destination 和 insert 选择生成位置，不支持 placement。')
  const { destination = 'assets', insert, ...compositionInput } = input
  if (destination !== 'assets' && destination !== 'timeline') throw new Error('效果短片目标需为素材库或时间线。')
  if (insert !== undefined && destination !== 'timeline') throw new Error('只有添加到时间线时可以设置插入位置。')
  const current = validateProject(project, { trusted: true })
  if (current.assets.length >= MAX_ASSETS) throw new Error(`项目最多容纳 ${MAX_ASSETS} 个素材，请先移除不用的素材。`)
  const resolve = videoWorkingCopyResolver(current), sourceAssets = new Map<string, MediaAsset>()
  const include = (id: unknown): string | unknown => {
    if (typeof id !== 'string') return id
    const selected = current.assets.find(asset => asset.id === id)
    if (!selected) return id
    const working = resolve(selected)
    // Render the selected working bytes without materializing historical originals.
    const { compression: _compression, ...asset } = working
    sourceAssets.set(asset.id, asset)
    return asset.id
  }
  const scenes = Array.isArray(compositionInput.scenes) ? compositionInput.scenes.map(scene => {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return scene
    return { ...scene, assetId: include((scene as Record<string, unknown>).assetId) }
  }) : compositionInput.scenes
  include(compositionInput.musicAssetId); include(compositionInput.logoAssetId)
  const temporary = cloneProject({ ...current, assets: [...sourceAssets.values()], tracks: [], markers: [] })
  delete temporary.mcpMotion
  const composeOptions = { ...compositionInput, scenes, placement: 'append' } as unknown as MotionComposeOptions
  const { placement: _placement, ...compositionPlan } = planMotionComposition(temporary, composeOptions)
  temporary.title = compositionPlan.title
  let insertion: MotionClipGenerationPlan['insert']
  if (destination === 'timeline') {
    const requested = insert === undefined ? {} : object(insert, '插入位置')
    if (Object.keys(requested).some(key => key !== 'trackId' && key !== 'start')) throw new Error('插入位置包含不支持的参数。')
    const start = requested.start === undefined ? projectDuration(current) : requested.start
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || start + compositionPlan.duration > MAX_PROJECT_DURATION) throw new Error('效果短片插入时间无效，或会超过 24 小时时间线。')
    const targetId = requested.trackId
    let target
    if (targetId !== undefined) {
      if (typeof targetId !== 'string' || !targetId.trim()) throw new Error('目标视频轨道无效。')
      target = current.tracks.find(track => track.id === targetId)
      if (!target || target.kind !== 'video') throw new Error('请选择当前工程中的视频轨道。')
      if (target.locked) throw new Error('请先解锁目标视频轨道。')
      if (!freeAt(current, target.id, start, compositionPlan.duration)) throw new Error('目标轨道的插入位置已有片段，请选择空白位置或其他轨道。')
    }
    if (!target && current.tracks.length >= MAX_TRACKS) throw new Error(`项目最多容纳 ${MAX_TRACKS} 条轨道，请为短片选择现有视频轨道。`)
    if (current.tracks.reduce((count, track) => count + track.clips.length, 0) >= MAX_CLIPS) throw new Error(`项目最多容纳 ${MAX_CLIPS} 个片段。`)
    insertion = { ...(target ? { trackId: target.id } : {}), start }
    const nativeCount = current.tracks.filter(track => track.kind !== 'transition').reduce((count, track) => count + track.clips.length, 0) + 1
    if (nativeCount > 500) compositionPlan.warnings.push(`添加后共有 ${nativeCount} 个非转场片段；当前桌面视频导出最多支持 500 个，请在导出前减少片段或分成多个工程。`)
  }
  return { temporary, options: composeOptions, plan: { ...compositionPlan, destination, ...(insertion ? { insert: insertion } : {}), sourceAssetIds: [...new Set([...compositionPlan.scenes.map(scene => scene.assetId), compositionPlan.musicAssetId, compositionPlan.logoAssetId].filter((id): id is string => Boolean(id)))], width: current.width, height: current.height } }
}

/** Plan an authorized request without changing the current timeline. */
export function planMotionClipGeneration(project: Project, options: MotionClipGenerateOptions): MotionClipGenerationPlan {
  return planInternal(project, options).plan
}

/** Render in isolation; commit only the finished video to the current project. */
export async function prepareMotionStyleTool(name: string, args: Record<string, unknown>, context: EditorToolContext, dependencies?: MotionStyleDependencies): Promise<PreparedEditorTool> {
  check(context)
  assertProjectRevision(args.expectedRevision as number | undefined, context.revision)
  if (args.expectedProjectId !== undefined && args.expectedProjectId !== context.project.id) throw new Error('当前工程已经变化，请重新读取工程后操作。')
  if (name === 'open_media_motion_style_list') return { data: { items: structuredClone(MOTION_STYLES), total: MOTION_STYLES.length } }
  if (name !== 'open_media_motion_clip_generate') throw new Error('未知效果短片工具。')
  if (context.source !== 'mcp') throw new Error('效果短片仅供 MCP 客户端调用，请在 MCP 设置中选择素材和风格后交由 AI 规划。')
  const { dryRun, expectedRevision: _revision, expectedProjectId: _projectId, ...input } = args
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw new Error('预检查选项必须为布尔值。')
  context.onProgress({ stage: '正在检查素材与短片安排', progress: 0 })
  const { temporary, options, plan } = planInternal(context.project, input as unknown as MotionClipGenerateOptions)
  check(context)
  if (dryRun) return { data: { ...plan, dryRun: true } }

  const deps = dependencies ?? await defaults(), artwork: MediaAsset[] = []
  const originalUrls = new Set(context.project.assets.flatMap(asset => [asset.url, asset.sourceUrl].filter((url): url is string => Boolean(url))))
  let finalAsset: MediaAsset | undefined, finalBlob: Blob | undefined, nativeOutput: MotionRenderedClip | undefined
  let accepted = false, discarded = false
  const release = (asset: MediaAsset) => {
    if (!originalUrls.has(asset.url)) deps.revokeAsset(asset)
    if (asset.sourceUrl?.startsWith('blob:') && asset.sourceUrl !== asset.url && !originalUrls.has(asset.sourceUrl)) URL.revokeObjectURL(asset.sourceUrl)
  }
  const releaseArtwork = () => { for (const asset of artwork.splice(0)) release(asset) }
  const discard = async () => {
    if (accepted || discarded) return
    discarded = true
    releaseArtwork()
    if (nativeOutput) await nativeOutput.discard()
    else if (finalAsset) release(finalAsset)
  }
  try {
    check(context)
    context.onProgress({ stage: '正在准备短片背景与装饰', progress: .05 })
    const art = await deps.renderArt(plan.styleId, plan.palette, plan.width, plan.height)
    check(context)
    const style = getMotionStyle(plan.styleId)
    for (const [key, label] of [['background', '背景'], ['decoration', '装饰']] as const) {
      const blob = art[key]
      if (!(blob instanceof Blob) || !blob.size || blob.type !== 'image/png') throw new Error(`风格${label}未能生成有效图片。`)
      check(context)
      const imported = await deps.importBrowser(new File([blob], `临时短片-${style.name}-${label}.png`, { type: 'image/png' }))
      artwork.push(imported)
      check(context)
      if (imported.kind !== 'image' || !imported.id || !imported.url || !(imported.width > 0) || !(imported.height > 0)) throw new Error(`风格${label}图片导入失败。`)
    }
    const composition = composeMotionProject(temporary, options, { background: artwork[0]!, decoration: artwork[1]! }).project
    check(context)
    const desktop = deps.isDesktop()
    context.onProgress({ stage: '正在编码效果短片', progress: .2, cancelable: true })
    if (desktop) {
      nativeOutput = await deps.renderNative(composition, context.signal, update => context.onProgress({ ...update, stage: `效果短片 · ${update.stage}`, ...(typeof update.progress === 'number' && Number.isFinite(update.progress) ? { progress: .2 + Math.max(0,Math.min(1,update.progress)) * .72 } : {}) }))
      finalAsset = nativeOutput.asset
      check(context)
    } else {
      finalBlob = await deps.renderBrowser(composition, { width: plan.width, height: plan.height, fps: composition.fps, signal: context.signal, onProgress: progress => context.onProgress({ stage: '正在编码效果短片', progress: .2 + Math.max(0,Math.min(1,progress)) * .72, cancelable: true }) })
      check(context)
      if (!(finalBlob instanceof Blob) || !finalBlob.size || !finalBlob.type.startsWith('video/')) throw new Error('效果短片没有生成可用的视频文件。')
      context.onProgress({ stage: '正在读取生成的视频素材', progress: .94 })
      finalAsset = await deps.importBrowser(new File([finalBlob], `${plan.title}.webm`, { type: finalBlob.type }))
      check(context)
    }
    releaseArtwork()
    const outputWidth = desktop ? Math.floor(plan.width/2)*2 : plan.width, outputHeight = desktop ? Math.floor(plan.height/2)*2 : plan.height
    if (!finalAsset || finalAsset.kind !== 'video' || !Number.isFinite(finalAsset.duration) || finalAsset.duration <= 0 || finalAsset.width !== outputWidth || finalAsset.height !== outputHeight || !finalAsset.url || !(finalAsset.size > 0)) throw new Error('生成的视频无法读取，或画面尺寸与当前工程不一致。')
    if (Math.abs(finalAsset.duration-plan.duration) > Math.max(.15,2/composition.fps)) throw new Error('生成的视频时长与计划不符，可能未完成编码，请重试。')
    const { libraryRole: _role, ...ordinaryAsset } = finalAsset
    finalAsset = { ...ordinaryAsset, name: `${plan.title}.${desktop ? 'mp4' : 'webm'}`, addedAt: new Date().toISOString() }
    const next = cloneProject(context.project)
    next.assets.push(finalAsset)
    let selection: PreparedEditorTool['selection'], insertionData: { clipId?: string; trackId?: string; start?: number } = {}
    if (plan.destination === 'timeline') {
      const start = plan.insert!.start
      if (start + finalAsset.duration > MAX_PROJECT_DURATION) throw new Error('生成的视频添加后会超过 24 小时时间线。')
      const existing = plan.insert!.trackId ? next.tracks.find(track => track.id === plan.insert!.trackId)! : undefined
      if (existing && !freeAt(next,existing.id,start,finalAsset.duration)) throw new Error('编码后的视频略长于计划时长，请选择更宽裕的空白位置。')
      const track = existing ?? createTrack('video','效果短片轨道')
      const clip = createClip(finalAsset,next,{start,fit:'contain'})
      track.clips.push(clip)
      if (!existing) next.tracks.unshift(track)
      selection = { trackId:track.id,clipId:clip.id }
      insertionData = { ...selection,start }
    }
    next.updatedAt = new Date().toISOString()
    const result = validateProject(next,{trusted:true})
    check(context)
    context.onProgress({ stage: '效果短片已生成', progress: 1 })
    check(context)
    return {
      project: result,
      data: { assetId:finalAsset.id,sourceAssetIds:plan.sourceAssetIds,styleId:plan.styleId,title:plan.title,duration:finalAsset.duration,width:finalAsset.width,height:finalAsset.height,destination:plan.destination,renderer:desktop?'native':'browser',...insertionData,warnings:plan.warnings,dryRun:false },
      label: `生成${style.name}效果短片`,
      assets: [{ asset:finalAsset,...(finalBlob?{blob:finalBlob}:{}) }],
      ...(selection ? { selection } : {}),
      accept: async () => { if (accepted || discarded) return; accepted = true; await nativeOutput?.accept() },
      discard,
    }
  } catch (cause) { try { await discard() } catch { /* Preserve the original generation failure. */ } throw cause }
}
