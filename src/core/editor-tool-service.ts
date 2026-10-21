import type { ImportedProject, MediaAsset, Project } from './types.ts'

export interface EditorToolProgress { stage: string; progress?: number; cancelable?: boolean; encodedFrames?: number; outputTime?: number; elapsedSeconds?: number }
export interface EditorToolRunOptions {
  signal: AbortSignal
  onProgress: (update: EditorToolProgress) => void
}
export type EditorToolRunner = (name: string, args: Record<string, unknown>, options: EditorToolRunOptions) => Promise<unknown>

/** Preparation never changes the live project. The host checks its revision and commits once. */
export interface EditorToolContext extends EditorToolRunOptions {
  project: Project
  revision: number
  blobs: Map<string, Blob>
  source: 'gui' | 'mcp'
  assertCurrent?: () => void
  hydrate?: (imported: ImportedProject) => Promise<Project>
}
export interface PreparedEditorTool {
  project?: Project
  irreversible?: boolean
  data: unknown
  label?: string
  selection?: { trackId?: string; clipId?: string }
  assets?: { asset: MediaAsset; blob?: Blob }[]
  /** Acknowledge prepared output after a successful commit or accepted read-only result. */
  accept?: () => Promise<void>
  /** Called only if a prepared result cannot be committed. */
  discard?: () => void | Promise<void>
}

const EXTRA_NAMES = new Set(['asset_upload', 'asset_import_url', 'asset_probe', 'asset_get_frame', 'asset_storyboard', 'asset_detect_scenes', 'asset_detect_idle', 'asset_ocr', 'timeline_get_frame', 'preview_render', 'audio_preview', 'artifact_read', 'timeline_batch_edit', 'project_snapshot', 'export_validate', 'project_video_compress', 'project_video_restore', 'clip_split_idle', 'motion_style_list', 'motion_compose'].map(name => `open_media_${name}`))
export function isSharedEditorTool(name: string): boolean { return EXTRA_NAMES.has(name) || isAudioEditorTool(name) }

import { executeProjectTool, isProjectTool, validateMcpToolArguments } from './mcp-tools.ts'
import { assertProjectRevision, executeTimelineBatch, type TimelineBatchOptions } from './project-operations.ts'
import { isAudioEditorTool, prepareAudioEditorTool } from './audio-editor-tools.ts'
import { addAssets } from './timeline.ts'
import { adoptFirstVideoSize } from './project-size.ts'

function publicData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicData)
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>, asset = typeof object.id === 'string' && typeof object.name === 'string' && typeof object.kind === 'string' && typeof object.url === 'string'
  return Object.fromEntries(Object.entries(object).filter(([key]) => !asset || !['url', 'sourceUrl', 'nativePath'].includes(key)).map(([key, item]) => [key, publicData(item)]))
}
/** Both trusted GUI actions and remote tools use this validated preparation/commit boundary. */
export async function prepareEditorTool(name: string, input: Record<string, unknown>, context: EditorToolContext): Promise<PreparedEditorTool> {
  context.signal.throwIfAborted()
  const { asset: guiAsset, ...withoutAsset } = input
  const args = validateMcpToolArguments(name, context.source === 'gui' ? withoutAsset : input)
  assertProjectRevision(args.expectedRevision as number | undefined, context.revision)
  if (isProjectTool(name)) return executeProjectTool(context.project, name, args)
  let result: PreparedEditorTool
  if (name === 'open_media_motion_style_list' || name === 'open_media_motion_compose') {
    const { prepareMotionStyleTool } = await import('./motion-style-service.ts')
    result = await prepareMotionStyleTool(name, args, context)
  } else if (name === 'open_media_clip_split_idle') {
    const { prepareIdleSplit } = await import('./clip-idle.ts')
    result = await prepareIdleSplit(args, context)
  } else if (name === 'open_media_project_video_compress' || name === 'open_media_project_video_restore') {
    const { prepareProjectCompressionTool } = await import('./project-video-compression.ts')
    result = await prepareProjectCompressionTool(name, args, context)
  } else if (isAudioEditorTool(name)) {
    result = await prepareAudioEditorTool(name, args, context)
    if (name === 'open_media_speech_generate_preview') {
      const data = result.data as { asset: MediaAsset }, { artifactFromAsset } = await import('./editor-preview-tools.ts')
      try {
        const artifact = await artifactFromAsset(data.asset, context)
        result.data = { ...data, asset: publicData(data.asset), ...artifact }
        const discard = result.discard
        // A read-only audition lives in the bounded artifact cache, never the project library.
        result.accept = async () => { await discard?.() }
      } catch (cause) { await result.discard?.(); throw cause }
    }
  } else if (name === 'open_media_timeline_batch_edit') {
    result = executeTimelineBatch(context.project, args as unknown as TimelineBatchOptions, { revision: context.revision, execute: executeProjectTool })
  } else if (name === 'open_media_project_snapshot') {
    const snapshots = await import('./project-snapshots.ts')
    const options = { assertCurrent: context.assertCurrent, blobs: context.blobs, sourceRevision: context.revision, signal: context.signal, onProgress: (done: number, total: number) => context.onProgress({ stage: '正在保存项目与素材版本', progress: done / Math.max(total, 1) }) }
    switch (args.action) {
      case 'list': result = { data: { snapshots: await snapshots.listProjectSnapshots(context.project.id) } }; break
      case 'create': {
        if (typeof args.name !== 'string') throw new Error('创建版本需要提供名称。')
        result = { data: await snapshots.createProjectSnapshot(context.project, args.name, options), irreversible: true }; break
      }
      case 'delete': {
        if (typeof args.id !== 'string') throw new Error('删除版本需要提供版本标识。')
        await snapshots.deleteProjectSnapshot(context.project.id, args.id, options)
        result = { data: { deletedId: args.id }, irreversible: true }; break
      }
      case 'compare': {
        if (typeof args.id !== 'string') throw new Error('比较版本需要提供版本标识。')
        result = { data: await snapshots.compareProjectSnapshot(context.project, args.id, args.comparisonId as string | undefined, options) }; break
      }
      case 'restore': {
        if (typeof args.id !== 'string') throw new Error('恢复版本需要提供版本标识。')
        const imported = snapshots.prepareSnapshotRestore(await snapshots.loadProjectSnapshot(context.project.id, args.id, options))
        try {
          const project = context.hydrate ? await context.hydrate(imported) : imported.project
          context.signal.throwIfAborted()
          result = { project, data: { restoredId: args.id }, label: '恢复项目版本', assets: project.assets.map(asset => ({ asset, blob: imported.blobs.get(asset.id) })),
            accept: async () => { if (!project.assets.some(asset => imported.project.assets.some(original => original.url === asset.url || original.url === asset.sourceUrl))) imported.revoke() }, discard: imported.revoke }
        } catch (cause) { imported.revoke(); throw cause }
        break
      }
      default: throw new Error('未知项目版本操作。')
    }
  } else if (['open_media_timeline_get_frame', 'open_media_preview_render', 'open_media_audio_preview', 'open_media_export_validate'].includes(name)) {
    const { preparePreviewTool } = await import('./editor-preview-tools.ts')
    result = await preparePreviewTool(name, args, context)
  } else if (name === 'open_media_artifact_read') {
    const { readToolArtifact } = await import('./tool-artifacts.ts')
    result = { data: await readToolArtifact(args.artifactId as string, args.offset as number | undefined, args.length as number | undefined) }
  } else if (name.startsWith('open_media_asset_')) {
    const { runAssetTool } = await import('../native-asset-tools.ts')
    const operation = name.replace(/^open_media_/, '')
    if (operation === 'asset_upload' || operation === 'asset_import_url') {
      const action = operation === 'asset_upload' ? args.action as string : undefined
      if (action && !['begin', 'chunk', 'status', 'commit', 'abort'].includes(action)) throw new Error('未知上传操作。')
      const { action: _action, expectedRevision: _revision, ...parameters } = args
      const data = await runAssetTool(operation === 'asset_upload' ? `asset_upload_${action}` as import('../native-asset-tools.ts').AssetToolOperation : 'asset_import_url', parameters, context)
      if (operation === 'asset_import_url' || action === 'commit') {
        const imported = data as unknown as import('../native-asset-tools.ts').ImportedAssetResult
        const asset = { ...imported.asset, provenance: imported.source }
        result = { project: adoptFirstVideoSize(addAssets(context.project, [asset]), [asset]), data: { assetId: asset.id, asset }, label: '导入媒体素材', assets: [{ asset }] }
      } else result = { data, irreversible: true }
    } else {
      const projectAsset = context.project.assets.find(asset => asset.id === args.assetId)
      const asset = projectAsset ?? (context.source === 'gui' && guiAsset && typeof guiAsset === 'object' && (guiAsset as MediaAsset).id === args.assetId ? guiAsset as MediaAsset : undefined)
      if (!asset) throw new Error('素材不存在，请重新读取素材列表。')
      const { assetId: _id, expectedRevision: _revision, ...parameters } = args
      if (operation === 'asset_ocr') {
        const frame = await runAssetTool<import('../native-asset-tools.ts').AssetFrame>('asset_get_frame', { asset, time: args.time ?? 0, maxWidth: args.width ?? 1920 }, context)
        const { recognizeImageText } = await import('./image-ocr.ts'), { base64Blob } = await import('./tool-artifacts.ts')
        result = { data: { ...await recognizeImageText(base64Blob(frame.base64, frame.mimeType), (args.language ?? 'zh-en') as 'zh-en' | 'en', context), assetId: asset.id, sourceTime: frame.sourceTime, requestedTime: frame.requestedTime, width: frame.width, height: frame.height } }
      } else {
        const data = await runAssetTool(operation as import('../native-asset-tools.ts').AssetToolOperation, { ...parameters, asset }, context)
        if (operation === 'asset_get_frame') {
          const { storeToolArtifact, base64Blob } = await import('./tool-artifacts.ts')
          result = { data: { ...data, ...await storeToolArtifact(base64Blob(data.base64 as string, 'image/png'), `源画面-${Number(args.time ?? 0).toFixed(3)}秒.png`, context.signal) } }
        } else if (operation === 'asset_storyboard') {
          const { storyboardSheet } = await import('./editor-preview-tools.ts')
          result = { data: { ...data, sheet: await storyboardSheet(data.frames as import('../native-asset-tools.ts').AssetFrame[], context) } }
        } else result = { data }
      }
    }
  } else throw new Error('未知编辑工具。')
  if (!result.irreversible) {
    try { context.signal.throwIfAborted() } catch (cause) { await result.discard?.(); throw cause }
  }
  if (context.source === 'mcp') result.data = publicData(result.data)
  return result
}
