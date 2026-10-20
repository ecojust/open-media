import { cloneProject, MAX_ASSETS, newId, validateProject } from './project.ts'
import { videoAssetKey } from './video-assets.ts'
import type { MediaAsset, Project } from './types.ts'
import type { EditorToolContext, PreparedEditorTool } from './editor-tool-service.ts'
import type { CompressionItem, CompressionJob, CompressionMode, CompressionQuality } from '../native-project-compression.ts'

export interface CompressionReportItem {
  sourceIds: string[]
  originalAssetIds: string[]
  originalName: string
  sourceSize: number
  outputSize?: number
  assetId?: string
  assetIds?: string[]
  state: 'completed' | 'skipped'
  message?: string
}
export interface CompressionReport {
  mode: CompressionMode
  quality?: CompressionQuality
  items: CompressionReportItem[]
  processedCount: number
  skippedCount: number
  sourceBytes: number
  outputBytes: number
  savedBytes: number
}
export interface CompressionRestoreReport { restoredCount: number; restoredAssetIds: string[] }
export interface CompressionDependencies {
  native: Pick<typeof import('../native-project-compression.ts'), 'beginProjectVideoCompression' | 'getProjectVideoCompressionJob' | 'cancelProjectVideoCompression' | 'acceptProjectVideoCompression' | 'discardProjectVideoCompression' | 'prepareProjectCompressionAsset'>
  materialize?: (projectId: string, asset: MediaAsset, context: EditorToolContext) => Promise<MediaAsset>
  pollMs?: number
}

function rootAsset(asset: MediaAsset, byId: Map<string, MediaAsset>): MediaAsset {
  const original = asset.compression ? byId.get(asset.compression.originalAssetId) : asset
  if (!original || original.kind !== 'video' || original.compression) throw new Error(`视频“${asset.name}”缺少可恢复的原件。`)
  return original
}
function referencedVideos(project: Project): MediaAsset[] {
  const ids = new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.assetId)))
  return project.assets.filter(asset => asset.kind === 'video' && ids.has(asset.id))
}
function selectedVideos(project: Project, assetIds?: string[]): MediaAsset[] {
  if (assetIds === undefined) return referencedVideos(project)
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > MAX_ASSETS || new Set(assetIds).size !== assetIds.length) throw new Error('请选择不重复的视频素材。')
  return assetIds.map(id => {
    const asset = project.assets.find(asset => asset.id === id)
    if (!asset || asset.kind !== 'video') throw new Error('所选视频素材不存在，请刷新工程后重试。')
    return asset
  })
}
/** One input per original ID; the native worker additionally coalesces equal paths. */
export function projectCompressionSources(project: Project, assetIds?: string[]): MediaAsset[] {
  const byId = new Map(project.assets.map(asset => [asset.id, asset]))
  const roots = new Map<string, MediaAsset>()
  for (const asset of selectedVideos(project, assetIds)) {
    const original = rootAsset(asset, byId)
    roots.set(original.id, original)
  }
  return [...roots.values()]
}
export function projectCompressedSources(project: Project): MediaAsset[] { return referencedVideos(project).filter(asset => asset.compression) }
export function compressionSummary(project: Project): { sourceCount: number; compressedCount: number; sourceBytes: number; currentBytes: number } {
  const sources = new Map(projectCompressionSources(project).map(asset => [videoAssetKey(asset), asset]))
  const current = new Map(referencedVideos(project).map(asset => [videoAssetKey(asset), asset]))
  const byId = new Map(project.assets.map(asset => [asset.id, asset]))
  const compressed = new Set(projectCompressedSources(project).map(asset => videoAssetKey(rootAsset(asset, byId))))
  return { sourceCount: sources.size, compressedCount: compressed.size, sourceBytes: [...sources.values()].reduce((sum, asset) => sum + asset.size, 0), currentBytes: [...current.values()].reduce((sum, asset) => sum + asset.size, 0) }
}
function affectedAssets(project: Project, roots: MediaAsset[]): Map<string, MediaAsset> {
  const byId = new Map(project.assets.map(asset => [asset.id, asset])), keys = new Set(roots.map(videoAssetKey))
  return new Map(project.assets.filter(asset => asset.kind === 'video' && keys.has(videoAssetKey(rootAsset(asset, byId)))).map(asset => [asset.id, rootAsset(asset, byId)]))
}
function assertUnlocked(project: Project, affected: Set<string>): void {
  const track = project.tracks.find(track => track.locked && track.clips.some(clip => clip.assetId && affected.has(clip.assetId)))
  if (track) throw new Error(`轨道“${track.name}”引用了待替换视频，请先解锁该轨道。`)
}

/** Replace source references without changing clip timing, layout, audio or animation. */
export function applyProjectVideoCompression(project: Project, roots: MediaAsset[], items: CompressionItem[], mode: CompressionMode, quality?: CompressionQuality): { project: Project; report: CompressionReport; assets: MediaAsset[] } {
  const selected = new Map(roots.map(asset => [asset.id, asset])), seenSources = new Set<string>(), seenOutputs = new Set(project.assets.map(asset => asset.id))
  const affected = affectedAssets(project, roots)
  assertUnlocked(project, new Set(affected.keys()))
  const next = cloneProject(project), replacements = new Map<string, string>(), assets: MediaAsset[] = [], reportItems: CompressionReportItem[] = []
  for (const item of items) {
    if (!item.sourceIds.length || !Number.isFinite(item.sourceSize) || item.sourceSize <= 0) throw new Error('视频压缩结果缺少有效源素材。')
    const originals = item.sourceIds.map(id => {
      if (seenSources.has(id) || !selected.has(id)) throw new Error('视频压缩结果的源素材标识不匹配。')
      seenSources.add(id); return selected.get(id)!
    })
    const original = originals[0]!
    if (originals.some(asset => asset.width !== original.width || asset.height !== original.height || Math.abs(asset.duration - original.duration) > 1e-6)) throw new Error('视频压缩结果混合了不同源文件。')
    const entry: CompressionReportItem = { sourceIds: [...item.sourceIds], originalAssetIds: originals.map(asset => asset.id), originalName: original.name, sourceSize: item.sourceSize, state: item.state === 'completed' ? 'completed' : 'skipped', ...(item.message ? { message: item.message } : {}) }
    if (item.state === 'skipped') {
      if (item.asset) throw new Error('跳过的视频不应替换工程素材。')
      entry.outputSize = item.outputSize
    } else if (item.state === 'completed') {
      const output = item.asset
      if (!output || output.kind !== 'video' || !output.nativePath || !output.url || !output.size || seenOutputs.has(output.id) || output.width !== original.width || output.height !== original.height || Math.abs(output.duration - original.duration) > Math.max(.1, 2 / project.fps) || item.outputSize !== output.size || output.size >= item.sourceSize) throw new Error('压缩视频结果无效或没有缩小，工程未修改。')
      const originalIds = new Set(originals.map(asset => asset.id)), sourceKeys = new Set(originals.map(videoAssetKey))
      const related = [...affected].filter(([, source]) => originalIds.has(source.id) || sourceKeys.has(videoAssetKey(source)))
      const sourceAssets = new Map([...originals, ...related.map(([, source]) => source)].map(asset => [asset.id, asset]))
      const copies = new Map<string, string>()
      for (const source of sourceAssets.values()) {
        // Aliases can share bytes while keeping their own original ID for restoration.
        const asset: MediaAsset = { ...output, id: copies.size ? newId('compressed-asset') : output.id, duration: source.duration, ...(source.libraryRole ? { libraryRole: source.libraryRole } : {}), compression: { originalAssetId: source.id, mode, ...(mode === 'quality' ? { quality: quality ?? 'high' } : {}), createdAt: new Date().toISOString() } }
        seenOutputs.add(asset.id); copies.set(source.id, asset.id); assets.push(asset); next.assets.push(asset)
      }
      for (const [id, source] of related) replacements.set(id, copies.get(source.id)!)
      entry.assetId = copies.get(original.id)!; entry.assetIds = [...copies.values()]; entry.outputSize = output.size
    } else throw new Error('视频压缩尚未完成，工程未修改。')
    reportItems.push(entry)
  }
  if (seenSources.size !== selected.size) throw new Error('视频压缩结果不完整，工程未修改。')
  for (const track of next.tracks) for (const clip of track.clips) if (clip.assetId && replacements.has(clip.assetId)) clip.assetId = replacements.get(clip.assetId)!
  const sourceBytes = reportItems.reduce((sum, item) => sum + item.sourceSize, 0)
  const outputBytes = reportItems.reduce((sum, item) => sum + (item.state === 'completed' ? item.outputSize! : item.sourceSize), 0)
  const processedCount = reportItems.filter(item => item.state === 'completed').length
  return { project: validateProject(next, { trusted: true }), assets, report: { mode, ...(mode === 'quality' ? { quality: quality ?? 'high' } : {}), items: reportItems, processedCount, skippedCount: reportItems.length - processedCount, sourceBytes, outputBytes, savedBytes: Math.max(0, sourceBytes - outputBytes) } }
}
export function restoreProjectVideos(project: Project, assetIds?: string[]): { project: Project; report: CompressionRestoreReport } {
  const selectedIds = assetIds ?? projectCompressedSources(project).map(asset => asset.id)
  if (!selectedIds.length) return { project: cloneProject(project), report: { restoredCount: 0, restoredAssetIds: [] } }
  const sources = projectCompressionSources(project, selectedIds)
  const affected = affectedAssets(project, sources), compressed = new Set([...affected.keys()].filter(id => project.assets.find(asset => asset.id === id)?.compression))
  assertUnlocked(project, compressed)
  const next = cloneProject(project), restored = new Set<string>()
  for (const track of next.tracks) for (const clip of track.clips) if (clip.assetId && compressed.has(clip.assetId)) { restored.add(clip.assetId); clip.assetId = affected.get(clip.assetId)!.id }
  return { project: validateProject(next, { trusted: true }), report: { restoredCount: restored.size, restoredAssetIds: [...restored] } }
}

function wait(signal: AbortSignal, ms: number): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('处理已取消。', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
function check(context: EditorToolContext): void { context.signal.throwIfAborted(); context.assertCurrent?.() }
async function defaults(): Promise<CompressionDependencies> {
  return { native: await import('../native-project-compression.ts'), materialize: async (projectId, asset, context) => {
    const { materializeProjectAsset } = await import('../native-project-files.ts')
    return materializeProjectAsset(projectId, asset, { blobs: context.blobs, signal: context.signal })
  } }
}
export async function prepareProjectCompressionTool(name: string, args: Record<string, unknown>, context: EditorToolContext, dependencies?: CompressionDependencies): Promise<PreparedEditorTool> {
  check(context)
  const assetIds = args.assetIds as string[] | undefined
  if (name === 'open_media_project_video_restore') {
    const result = restoreProjectVideos(context.project, assetIds)
    return { ...(result.report.restoredCount ? { project: result.project } : {}), data: result.report, label: '恢复工程原视频' }
  }
  if (name !== 'open_media_project_video_compress') throw new Error('未知工程视频处理操作。')
  const mode = args.mode as CompressionMode, quality = mode === 'quality' ? (args.quality ?? 'high') as CompressionQuality : undefined
  if (!['lossless', 'quality'].includes(mode) || quality && !['high', 'balanced', 'compact'].includes(quality) || mode === 'lossless' && args.quality !== undefined) throw new Error('工程视频压缩模式或质量无效。')
  const roots = projectCompressionSources(context.project, assetIds)
  if (!roots.length) throw new Error('当前工程没有可压缩的视频，请先把视频加入时间线。')
  const affected = affectedAssets(context.project, roots)
  if (context.project.assets.length + new Set([...affected.values()].map(asset => asset.id)).size > MAX_ASSETS) throw new Error('工程素材数量已达到上限，请先移除不再使用的素材。')
  assertUnlocked(context.project, new Set(affected.keys()))
  const deps = dependencies ?? await defaults(), inputs: MediaAsset[] = []
  for (const asset of roots) {
    check(context)
    context.onProgress({ stage: `正在准备原视频：${asset.name}`, progress: 0, cancelable: true })
    if (!asset.nativePath && !deps.materialize) throw new Error('视频缺少本地文件，请重新导入。')
    inputs.push(asset.nativePath ? asset : await deps.materialize!(context.project.id, asset, context))
  }
  let id: string | undefined
  const abort = () => { if (id) void deps.native.cancelProjectVideoCompression(id).catch(() => {}) }
  context.signal.addEventListener('abort', abort, { once: true })
  try {
    check(context)
    let job: CompressionJob = await deps.native.beginProjectVideoCompression({ assets: inputs, mode, ...(quality ? { quality } : {}) })
    id = job.id
    for (;;) {
      check(context)
      context.onProgress({ stage: job.message ? `${job.stage} · ${job.message}` : job.stage, progress: Math.max(0, Math.min(1, job.progress || 0)) * .94, elapsedSeconds: job.elapsedSeconds, cancelable: true })
      if (job.state === 'failed' || job.state === 'cancelled') throw new Error(job.error || '工程视频压缩已取消。')
      if (job.state === 'completed') break
      await wait(context.signal, deps.pollMs ?? 250)
      job = await deps.native.getProjectVideoCompressionJob(id)
    }
    const items: CompressionItem[] = []
    for (const [index, item] of job.items.entries()) {
      check(context)
      context.onProgress({ stage: `正在准备压缩视频预览 ${index + 1}/${job.items.length}`, progress: .94 + .05 * index / Math.max(1, job.items.length), elapsedSeconds: job.elapsedSeconds, cancelable: true })
      items.push(item.asset ? { ...item, asset: await deps.native.prepareProjectCompressionAsset(item.asset, context.signal, id) } : item)
    }
    check(context)
    const applied = applyProjectVideoCompression(context.project, roots, items, mode, quality)
    return { ...(applied.assets.length ? { project: applied.project } : {}), data: applied.report, label: '压缩工程视频', assets: applied.assets.map(asset => ({ asset })), accept: () => deps.native.acceptProjectVideoCompression(id!), discard: () => deps.native.discardProjectVideoCompression(id!) }
  } catch (cause) {
    if (id) await Promise.allSettled([deps.native.cancelProjectVideoCompression(id), deps.native.discardProjectVideoCompression(id)])
    throw cause
  } finally { context.signal.removeEventListener('abort', abort) }
}
