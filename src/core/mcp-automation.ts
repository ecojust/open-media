import type { ImportedProject, MediaAsset, Project } from './types.ts'
import type { MediaJob, ProjectFileTarget } from '../native.ts'
import { acceptSpeechJobs, beginSpeechJob, beginSpeechModelDownload, cancelMediaJob, cancelSpeechJob, cancelSpeechModelDownload, discardSpeechJob, getMediaJobs, getSpeechJob, getSpeechStatus, repairSpeechModel, revealMediaJobOutput } from '../native.ts'
import { beginMcpMediaJob, importMcpMediaPaths, saveMcpProjectFile } from '../native-mcp-files.ts'
import { cloneProject, newId } from './project.ts'
import { addAssets, findClip } from './timeline.ts'
import { adoptFirstVideoSize } from './project-size.ts'
import { prepareNativeProjectArchive } from '../native-project-files.ts'
import { prepareNativeProject } from './native-project.ts'
import { executeProjectTool, inspectMcpProject, isProjectTool, validateMcpToolArguments } from './mcp-tools.ts'
import { createMcpSpeechJobs, type McpSpeechJob } from './mcp-speech-jobs.ts'
import { isSharedEditorTool, prepareEditorTool } from './editor-tool-service.ts'
import { getSpeechSettings, updateSpeechSettings } from './speech-settings.ts'
import { McpBusyError, mcpBlockingJob, mcpJobResponse, mcpSynchronousResponse, serializeMcpError, type McpBlockingOperation, type McpJobProtocol } from './mcp-response.ts'
import { beginVideoGeneration, beginVideoModelDownload, cancelVideoGeneration, cancelVideoModelDownload, getVideoGenerationJob, getVideoGenerationStatus } from '../native-video-generation.ts'
import { applyMcpVideoGeneration, prepareMcpVideoGeneration } from './mcp-video-generation.ts'
import { beginAiGeneration, cancelAiJob, cancelAiModelDownload, downloadAiModel, getAiJob, getAiStatus, repairAiModel } from '../native-ai.ts'
import { applyMcpAiGeneration, prepareMcpAiGeneration, publicAiJob, publicAiStatus } from './mcp-ai-generation.ts'

export interface McpPlayback { time: number; playing: boolean; selectedClipId: string }
export interface McpAutomationHost {
  getProject(): Project
  getRevision(): number
  getProjectSession?(): number
  isBusy(): boolean
  getBlockingOperation?(): McpBlockingOperation | undefined
  getBlobs(): Map<string, Blob>
  getSaveTarget(): ProjectFileTarget | undefined
  commit(project: Project, label: string, expected: { projectId: string; revision: number; projectSession?: number }): boolean
  hydrate(imported: ImportedProject): Promise<Project>
  didSave(project: Project, target: ProjectFileTarget, expected: { projectId: string; projectSession?: number }): Promise<void>
  history(direction: 'undo' | 'redo'): void
  getPlayback(): McpPlayback
  setPlayback(patch: Partial<McpPlayback>): Promise<McpPlayback>
  ownAsset(asset: MediaAsset, blob?: Blob): void
  onBusy(value: boolean): void
  onJobsChanged(): void
  announce(message: string): void
}
export interface McpAutomationJob {
  id: string
  name: string
  kind: string
  tool: string
  projectId: string
  revision: number
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  cancelable: boolean
  cancelling?: boolean
  startedAt: number
  finishedAt?: number
  elapsedSeconds: number
  progress?: number
  encodedFrames?: number
  outputTime?: number
  stage: string
  error?: string
  errorDetails?: Record<string, unknown>
  warning?: string
  result?: unknown
}
interface Operation {
  job: McpAutomationJob
  source: Project
  projectSession?: number
  controller: AbortController
  cancelNative?: () => Promise<void>
  irrevocable?: boolean
}
interface ProjectSession { projectId: string; projectSession?: number }
const message = (cause: unknown) => cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string' ? cause.message : String(cause)

/** The displayed project remains authoritative; remote edits use its undo and save path. */
export function createMcpAutomation(host: McpAutomationHost) {
  const operations = new Map<string, Operation>()
  const transfers = new Map<string, ProjectSession>()
  const speechSessions = new Map<string, ProjectSession>()
  let active: Operation | undefined, disposed = false
  const speech = createMcpSpeechJobs({
    getProject: host.getProject, getRevision: host.getRevision, getProjectSession: host.getProjectSession, isBusy: () => !!active || host.isBusy(),
    onBusy: host.onBusy, commit: host.commit, onAssets: assets => assets.forEach(asset => host.ownAsset(asset)),
    onChange: () => host.onJobsChanged(),
    native: { getSpeechStatus, beginSpeechJob, getSpeechJob, cancelSpeechJob, discardSpeechJob, acceptSpeechJobs },
  })
  function available(): void {
    if (disposed) throw new Error('应用正在关闭，MCP 操作已停止。')
    const blocking = active?.job ?? speech.summaries().find(job => job.state === 'running')
    if (blocking) throw new McpBusyError(mcpBlockingJob(blocking))
    if (host.isBusy()) throw new McpBusyError(host.getBlockingOperation?.() ?? { jobId: null, kind: 'local-interaction', state: 'running', cancelable: false, poll: null, cancel: null, source: 'local' })
  }
  function currentSession(): ProjectSession { return { projectId: host.getProject().id, projectSession: host.getProjectSession?.() } }
  function sameSession(session: ProjectSession): boolean { return host.getProject().id === session.projectId && host.getProjectSession?.() === session.projectSession }
  function transferOwner(kind: 'upload' | 'artifact', id: unknown, cleanup = false): ProjectSession {
    const owner = typeof id === 'string' ? transfers.get(`${kind}:${id}`) : undefined
    if (!owner || !cleanup && !sameSession(owner)) throw new Error(kind === 'upload' ? '上传不属于当前打开的工程会话或已失效，请在当前工程重新开始上传。' : '预览文件不属于当前打开的工程会话或已失效，请在当前工程重新生成预览。')
    return owner
  }
  function rememberTransfers(value: unknown, owner: ProjectSession, seen = new WeakSet<object>()): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'uploadId' || key === 'artifactId') && typeof item === 'string') transfers.set(`${key === 'uploadId' ? 'upload' : 'artifact'}:${item}`, owner)
      else if (item && typeof item === 'object') rememberTransfers(item, owner, seen)
    }
    // Native uploads and cached artifacts expire independently; retain a bounded set of local capabilities.
    while (transfers.size > 512) transfers.delete(transfers.keys().next().value!)
  }
  function check(operation: Operation): void {
    if (disposed || operation.controller.signal.aborted) throw new DOMException('MCP 任务已取消。', 'AbortError')
    if (host.getProject().id !== operation.job.projectId || host.getRevision() !== operation.job.revision || host.getProjectSession?.() !== operation.projectSession) throw new Error('项目已发生变化，本次操作未写入项目。请重新读取项目后重试。')
  }
  function changed(operation: Operation, stage?: string, progress?: number, metrics?: { encodedFrames?: number; outputTime?: number }): void {
    if (stage) operation.job.stage = stage
    operation.job.progress = progress
    if (metrics?.encodedFrames !== undefined) operation.job.encodedFrames = metrics.encodedFrames
    if (metrics?.outputTime !== undefined) operation.job.outputTime = metrics.outputTime
    host.onJobsChanged()
  }
  function snapshot(operation: Operation, includeResult = true): McpAutomationJob & McpJobProtocol {
    const { result, ...status } = operation.job
    return mcpJobResponse(structuredClone({ ...status, ...(includeResult && result !== undefined ? { result } : {}), elapsedSeconds: Math.max(0, ((operation.job.finishedAt ?? Date.now()) - operation.job.startedAt) / 1000) }))
  }
  function start(kind: string, name: string, action: (operation: Operation) => Promise<unknown>, tool: string): McpAutomationJob & McpJobProtocol {
    available()
    const source = cloneProject(host.getProject())
    const operation: Operation = { source, projectSession: host.getProjectSession?.(), controller: new AbortController(), job: {
      id: newId('mcp-job'), name, kind, tool, projectId: source.id, revision: host.getRevision(), state: 'running',
      cancelable: true, startedAt: Date.now(), elapsedSeconds: 0, stage: '正在准备',
    } }
    active = operation; operations.set(operation.job.id, operation); host.onBusy(true); host.onJobsChanged()
    while (operations.size > 100) {
      const oldest = [...operations.values()].find(item => item !== active && item.job.state !== 'running')
      if (!oldest) break
      operations.delete(oldest.job.id)
    }
    void Promise.resolve().then(() => { check(operation); return action(operation) }).then(result => {
      rememberTransfers(result, { projectId: operation.job.projectId, projectSession: operation.projectSession })
      operation.job.result = result; operation.job.state = 'completed'; operation.job.progress = 1; operation.job.stage = '已完成'
      host.announce(`MCP：${name}已完成${operation.job.warning ? `；${operation.job.warning}` : ''}`)
    }).catch(async cause => {
      if (!operation.irrevocable) await operation.cancelNative?.().catch(() => {})
      operation.job.state = (operation.controller.signal.aborted || !!cause && typeof cause === 'object' && 'name' in cause && cause.name === 'AbortError') && !operation.irrevocable ? 'cancelled' : 'failed'
      operation.job.error = message(cause); operation.job.errorDetails = serializeMcpError(cause); operation.job.stage = operation.job.state === 'cancelled' ? '已取消' : '失败'
      host.announce(`MCP：${name}${operation.job.state === 'cancelled' ? '已取消' : `失败：${message(cause)}`}`)
    }).finally(() => {
      operation.job.finishedAt = Date.now(); operation.job.cancelable = false; operation.job.cancelling = false
      if (active === operation) { active = undefined; host.onBusy(false) }
      host.onJobsChanged()
    })
    return snapshot(operation)
  }
  function commit(operation: Operation, project: Project, label: string): void {
    check(operation)
    if (!host.commit(project, `MCP：${label}`, { projectId: operation.job.projectId, revision: operation.job.revision, projectSession: operation.projectSession })) throw new Error('项目拒绝了本次修改，请重新读取项目。')
    operation.irrevocable = true; operation.job.cancelable = false
  }
  function wait(operation: Operation, milliseconds = 400): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); operation.controller.signal.removeEventListener('abort', abort); reject(new DOMException('已取消', 'AbortError')) }
      const timer = setTimeout(() => { operation.controller.signal.removeEventListener('abort', abort); resolve() }, milliseconds)
      operation.controller.signal.addEventListener('abort', abort, { once: true })
      if (operation.controller.signal.aborted) abort()
    })
  }
  async function executeInner(name: string, input: unknown): Promise<unknown> {
    if (disposed) throw new Error('MCP 操作已停止。')
    if (name === 'open_media_project_new' || name === 'open_media_project_open') throw new Error('MCP 只能处理当前打开的工程。请在软件界面中新建或打开工程，再重新读取当前工程。')
    const { expectedProjectId, ...args } = validateMcpToolArguments(name, input)
    if (expectedProjectId !== undefined && expectedProjectId !== host.getProject().id) throw new Error(`当前工程已变化：当前 projectId=${host.getProject().id}，请先重新读取当前工程。`)
    const startTool = (kind: string, label: string, action: (operation: Operation) => Promise<unknown>) => start(kind, label, action, name)
    if (args.expectedRevision !== undefined && args.expectedRevision !== host.getRevision()) throw new Error(`项目版本已变化：当前 revision=${host.getRevision()}，请先重新读取项目。`)
    if (isProjectTool(name)) {
      const revision = host.getRevision(), projectSession = host.getProjectSession?.(), source = host.getProject(), result = executeProjectTool(source, name, args)
      if (result.project) {
        available()
        if (!host.commit(result.project, `MCP：${result.label || '编辑项目'}`, { projectId: source.id, revision, projectSession })) throw new Error('项目拒绝了本次修改。')
      }
      if (result.selection?.clipId) void host.setPlayback({ selectedClipId: result.selection.clipId }).catch(() => {})
      return { ...(result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : { data: result.data }), projectId: host.getProject().id, revision: host.getRevision() }
    }
    if (isSharedEditorTool(name)) {
      let transferSession = currentSession()
      if (name === 'open_media_asset_upload' && args.action !== 'begin') transferSession = transferOwner('upload', args.uploadId, args.action === 'abort')
      if (name === 'open_media_artifact_read') transferSession = transferOwner('artifact', args.artifactId)
      // Chunk transfer and artifact reads are short protocol operations, not editor jobs.
      if (name === 'open_media_artifact_read' || name === 'open_media_asset_upload' && args.action !== 'commit' || name === 'open_media_audio_transcribe' && ['status', 'cancel'].includes(args.action as string) || ['open_media_speech_pronunciation_get', 'open_media_speech_alignment_get'].includes(name)) {
        const prepared = await prepareEditorTool(name, args, { project: cloneProject(host.getProject()), revision: host.getRevision(), blobs: host.getBlobs(), source: 'mcp', signal: new AbortController().signal, onProgress: () => {} })
        rememberTransfers(prepared.data, transferSession)
        if (name === 'open_media_asset_upload' && args.action === 'abort') transfers.delete(`upload:${args.uploadId}`)
        else if (['open_media_artifact_read', 'open_media_asset_upload'].includes(name) && !sameSession(transferSession)) throw new Error('当前工程会话已变化，本次传输结果不能用于新工程，请重新开始。')
        return prepared.data
      }
      return startTool('editor-tool', name.replace(/^open_media_/, ''), async operation => {
        const prepared = await prepareEditorTool(name, args, { project: operation.source, revision: operation.job.revision, blobs: host.getBlobs(), source: 'mcp', hydrate: host.hydrate, assertCurrent: () => check(operation),
          signal: operation.controller.signal, onProgress: update => changed(operation, update.stage, update.progress, update) })
        if (prepared.irreversible) { operation.irrevocable = true; operation.job.cancelable = false }
        try {
          if (!prepared.irreversible) check(operation)
          if (prepared.project) commit(operation, prepared.project, prepared.label || '编辑项目')
          if (prepared.accept) { operation.irrevocable = true; operation.job.cancelable = false; changed(operation, '正在保存处理结果', 1) }
          try { prepared.assets?.forEach(({ asset, blob }) => host.ownAsset(asset, blob)) }
          finally { await prepared.accept?.() }
          operation.irrevocable = true; operation.job.cancelable = false
          if (prepared.selection?.clipId) void host.setPlayback({ selectedClipId: prepared.selection.clipId }).catch(() => {})
          return { ...(prepared.data && typeof prepared.data === 'object' && !Array.isArray(prepared.data) ? prepared.data : { data: prepared.data }), projectId: host.getProject().id, revision: host.getRevision() }
        } catch (cause) { if (!operation.irrevocable) await prepared.discard?.(); throw cause }
      })
    }
    switch (name) {
      case 'open_media_project_history': {
        available(); host.history(args.direction as 'undo' | 'redo')
        return { projectId: host.getProject().id, revision: host.getRevision(), project: inspectMcpProject(host.getProject()) }
      }
      case 'open_media_project_save':
        return startTool('save', '保存工程', async operation => {
          const token = host.getSaveTarget()?.token
          if (!token) throw new Error('当前工程尚无保存位置，请先在软件界面中保存工程。MCP 只能保存到当前工程已有的位置。')
          const prepared = await prepareNativeProjectArchive(operation.source, { blobs: host.getBlobs(), signal: operation.controller.signal,
            onProgress: (done, total) => changed(operation, '正在准备项目素材', done / Math.max(1, total) * .9) })
          check(operation)
          if (host.getSaveTarget()?.token !== token) throw new Error('当前工程的保存位置已变化，请重新读取当前工程后再保存。')
          operation.irrevocable = true; operation.job.cancelable = false; changed(operation, '正在写入项目文件', .95)
          const saved = await saveMcpProjectFile(prepared, { token })
          await host.didSave(operation.source, saved, { projectId: operation.job.projectId, projectSession: operation.projectSession })
          return { projectId: operation.source.id, path: saved.path, revision: host.getRevision() }
        })
      case 'open_media_asset_import':
        return startTool('import', '导入素材', async operation => {
          changed(operation, '正在读取和准备媒体')
          const assets = await importMcpMediaPaths(args.paths as string[])
          check(operation)
          const next = adoptFirstVideoSize(addAssets(operation.source, assets), assets)
          commit(operation, next, '导入素材'); assets.forEach(asset => host.ownAsset(asset))
          return { assetIds: assets.map(asset => asset.id), revision: host.getRevision() }
        })
      case 'open_media_playback_get': return host.getPlayback()
      case 'open_media_playback_set': {
        available()
        return host.setPlayback({ ...(args.time !== undefined ? { time: args.time as number } : {}), ...(args.playing !== undefined ? { playing: args.playing as boolean } : {}), ...(args.selectedClipId !== undefined ? { selectedClipId: args.selectedClipId as string } : {}) })
      }
      case 'open_media_speech_voices': return getSpeechStatus()
      case 'open_media_speech_settings_get': return getSpeechSettings()
      case 'open_media_speech_settings_set': {
        available()
        const { expectedRevision: _revision, ...patch } = args
        return updateSpeechSettings(patch)
      }
      case 'open_media_speech_generate': {
        available()
        const owner = currentSession()
        const job = speech.startSpeech({
          ...(args.clipIds !== undefined ? { clipIds: args.clipIds as string[] } : {}),
          ...(args.voiceId !== undefined ? { voiceId: args.voiceId as string } : {}),
          ...(args.rate !== undefined ? { rate: args.rate as number } : {}),
          ...(args.alignText !== undefined ? { alignText: args.alignText as boolean } : {}),
        })
        speechSessions.set(job.id, owner)
        while (speechSessions.size > 50) speechSessions.delete(speechSessions.keys().next().value!)
        return mcpJobResponse(job)
      }
      case 'open_media_speech_model': {
        const modelId = args.modelId as string
        if (args.action === 'status') return getSpeechStatus()
        if (!modelId) throw new Error('请提供 modelId。')
        if (args.action === 'cancel') return cancelSpeechModelDownload(modelId)
        available()
        const status = await (args.action === 'repair' ? repairSpeechModel(modelId) : beginSpeechModelDownload(modelId))
        return { ...status, responseType: 'model-status', execution: 'asynchronous', final: false, modelId,
          poll: { tool: 'open_media_speech_model', arguments: { action: 'status', modelId } },
          cancel: { tool: 'open_media_speech_model', arguments: { action: 'cancel', modelId } } }
      }
      case 'open_media_video_generation_status': return getVideoGenerationStatus()
      case 'open_media_ai_status': return publicAiStatus(await getAiStatus(args.probeRuntime === true))
      case 'open_media_ai_job_get': return publicAiJob(await getAiJob(args.id as string))
      case 'open_media_ai_job_cancel': {
        const job = await getAiJob(args.id as string)
        if (job.cancelable) await cancelAiJob(job.id)
        return { cancelRequested: job.cancelable, job: publicAiJob(await getAiJob(job.id)) }
      }
      case 'open_media_ai_model_download':
      case 'open_media_ai_model_repair':
        return startTool('ai-model-download', name.endsWith('_repair') ? '修复 AI 模型' : '下载 AI 模型', async operation => {
          const modelId = args.modelId as string
          let modelStatus = await getAiStatus()
          check(operation)
          const initial = modelStatus.models.find(model => model.id === modelId)
          if (!initial) throw new Error('模型不在全局 AI 模型目录中，请先查询 ai_status。')
          if (initial.state === 'unsupported') throw new Error(initial.error || initial.runtime.reason || '当前设备不支持所选模型。')
          operation.cancelNative = async () => { await cancelAiModelDownload(modelId) }
          modelStatus = await (name.endsWith('_repair') ? repairAiModel : downloadAiModel)(modelId, args.acceptedLicense === true)
          while (true) {
            check(operation)
            const model = modelStatus.models.find(item => item.id === modelId)
            if (!model) throw new Error('模型已不在全局目录中。')
            const preparingRuntime = ['downloading', 'verifying'].includes(model.runtime.state)
            changed(operation, preparingRuntime ? model.runtime.reason || '正在准备 AI 推理环境' : model.state === 'verifying' ? `正在校验 ${model.name}` : model.state === 'ready' && model.runtime.state !== 'ready' ? '正在准备 AI 推理环境' : `正在下载 ${model.name}`, !preparingRuntime && model.size > 0 ? Math.min(1, model.downloadedBytes / model.size) : undefined)
            if (model.state === 'ready' && model.runtime.state === 'ready') return { modelId, model }
            if (model.state === 'failed' || model.state === 'unsupported' || ['failed', 'unsupported', 'unavailable'].includes(model.runtime.state)) throw new Error(model.error || model.runtime.reason || '模型或运行环境安装失败。')
            if (model.state === 'not-downloaded') throw new DOMException('模型下载已取消。', 'AbortError')
            await wait(operation)
            modelStatus = await getAiStatus()
          }
        })
      case 'open_media_image_generate':
      case 'open_media_music_generate': {
        const provider = name === 'open_media_image_generate' ? 'image' : 'music'
        const prepared = prepareMcpAiGeneration(host.getProject(), provider, args)
        return startTool(`${provider}-generation`, provider === 'image' ? '生成图片' : '生成歌曲', async operation => {
          const modelStatus = await getAiStatus()
          check(operation)
          const model = modelStatus.models.find(item => item.id === prepared.request.request.modelId)
          if (!model || model.provider !== provider) throw new Error('所选模型不支持此生成类型，请查询 ai_status。')
          if (model.state !== 'ready' || model.runtime.state !== 'ready') throw new Error(model.error || model.runtime.reason || '请先下载或修复所选模型与推理环境。')
          changed(operation, provider === 'image' ? '正在启动图像生成' : '正在启动歌曲生成')
          // The request is not a registered native job yet. Keep an early abort
          // pending until begin returns the provider-prefixed job ID to cancel.
          let nativeJob = await beginAiGeneration(prepared.request)
          operation.cancelNative = () => cancelAiJob(nativeJob.id)
          if (operation.controller.signal.aborted) await operation.cancelNative()
          while (true) {
            check(operation)
            changed(operation, nativeJob.stage, nativeJob.progress)
            if (nativeJob.warning) operation.job.warning = nativeJob.warning
            if (nativeJob.state === 'completed') {
              const result = applyMcpAiGeneration(operation.source, nativeJob, prepared)
              if (result.project) {
                commit(operation, result.project, provider === 'image' ? '添加生成图片' : '添加生成歌曲')
                result.assets.forEach(asset => host.ownAsset(asset))
                if (result.result.clipIds[0]) void host.setPlayback({ selectedClipId: result.result.clipIds[0] }).catch(() => {})
              }
              return { ...result.result, projectId: host.getProject().id, revision: host.getRevision() }
            }
            if (nativeJob.state === 'failed') throw new Error(nativeJob.error || 'AI 生成失败。')
            if (nativeJob.state === 'cancelled') throw new DOMException('AI 生成已取消。', 'AbortError')
            await wait(operation)
            nativeJob = await getAiJob(nativeJob.id)
          }
        })
      }
      case 'open_media_video_model_download':
        return startTool('video-model-download', '下载视频生成模型', async operation => {
          const modelId = args.modelId as string
          let status = await getVideoGenerationStatus()
          check(operation)
          if (!status.supported) throw new Error(status.reason || '当前平台暂不支持本地视频生成。')
          if (!status.models.some(model => model.id === modelId)) throw new Error('未知的视频生成模型。')
          // License consent is explicit in the schema and verified again by the native manager.
          operation.cancelNative = async () => { await cancelVideoModelDownload(modelId) }
          status = await beginVideoModelDownload(modelId, args.acceptedLicense === true)
          while (true) {
            check(operation)
            const model = status.models.find(item => item.id === modelId)
            if (!model) throw new Error('视频生成模型已不在当前清单中。')
            changed(operation, model.state === 'verifying' ? '正在校验视频生成模型' : `正在下载 ${model.name}`, model.size > 0 ? Math.min(1, model.downloadedBytes / model.size) : undefined)
            if (model.state === 'ready' && status.runtimeReady) return { modelId, status }
            if (model.state === 'failed' || model.state === 'unsupported') throw new Error(model.error || status.reason || '视频模型下载失败。')
            if (model.state === 'not-downloaded') throw new DOMException('模型下载已取消。', 'AbortError')
            await wait(operation)
            status = await getVideoGenerationStatus()
          }
        })
      case 'open_media_video_generation_start': {
        const prepared = prepareMcpVideoGeneration(host.getProject(), args)
        return startTool('video-generation', '生成视频', async operation => {
          const status = await getVideoGenerationStatus()
          check(operation)
          if (!status.supported) throw new Error(status.reason || '当前平台暂不支持本地视频生成。')
          const model = status.models.find(item => item.id === prepared.request.modelId)
          if (!model || !model.modes.includes(prepared.request.mode)) throw new Error('所选模型不支持此生成方式。')
          if (!status.runtimeReady || model.state !== 'ready') throw new Error('请先下载并完成校验所选视频生成模型。')
          changed(operation, '正在启动视频生成')
          operation.cancelNative = () => cancelVideoGeneration(prepared.request.requestId)
          let nativeJob = await beginVideoGeneration(prepared.request)
          operation.cancelNative = () => cancelVideoGeneration(nativeJob.id)
          while (true) {
            check(operation)
            changed(operation, `${nativeJob.stage} · 镜头 ${Math.min(nativeJob.shotCount, nativeJob.shotIndex + 1)}/${nativeJob.shotCount}`, nativeJob.progress)
            if (nativeJob.warning) operation.job.warning = nativeJob.warning
            if (nativeJob.state === 'completed') {
              const result = applyMcpVideoGeneration(operation.source, nativeJob, prepared.request, prepared.insert)
              commit(operation, result.project, '添加生成视频')
              result.assets.forEach(asset => host.ownAsset(asset))
              if (result.result.clipIds[0]) void host.setPlayback({ selectedClipId: result.result.clipIds[0] }).catch(() => {})
              return { ...result.result, projectId: host.getProject().id, revision: host.getRevision() }
            }
            if (nativeJob.state === 'failed') throw new Error(nativeJob.error || '视频生成失败。')
            if (nativeJob.state === 'cancelled') throw new DOMException('视频生成已取消。', 'AbortError')
            await wait(operation)
            nativeJob = await getVideoGenerationJob(nativeJob.id)
          }
        })
      }
      case 'open_media_job_list': return summaries().map(job => remoteJobResponse(job.id))
      case 'open_media_job_get': return remoteJobResponse(args.id as string)
      case 'open_media_job_cancel': {
        await cancel(args.id as string)
        return remoteJobResponse(args.id as string)
      }
      case 'open_media_material_list': {
        const { listMcpMaterials } = await import('./mcp-materials.ts')
        return listMcpMaterials(args as unknown as Parameters<typeof listMcpMaterials>[0])
      }
      case 'open_media_material_add':
        return startTool('material', '添加内置素材', async operation => {
          const { prepareMcpMaterial } = await import('./mcp-materials.ts')
          check(operation)
          const playback = host.getPlayback()
          const timing = args.kind === 'transition_sound'
            ? { time: args.time ?? playback.time, ...(args.transitionClipId === undefined && args.time === undefined && findClip(operation.source, playback.selectedClipId)?.clip.transition ? { transitionClipId: playback.selectedClipId } : {}) }
            : args.kind !== 'video_segment' ? { start: args.start ?? playback.time } : {}
          const result = await prepareMcpMaterial(operation.source, { ...args, ...timing } as Parameters<typeof prepareMcpMaterial>[1], { signal: operation.controller.signal })
          try { check(operation); commit(operation, result.project, result.label) }
          catch (cause) {
            for (const { asset } of result.assets ?? []) for (const url of new Set([asset.url, asset.sourceUrl])) if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
            throw cause
          }
          result.assets?.forEach(({ asset, blob }) => host.ownAsset(asset, blob))
          if (result.selection?.clipId) void host.setPlayback({ selectedClipId: result.selection.clipId }).catch(() => {})
          return { ...result.selection, revision: host.getRevision() }
        })
      case 'open_media_export_start':
        return startTool('export', '导出视频', async operation => {
          changed(operation, '正在准备导出图层')
          const config = { format: args.format as 'mp4' | 'webm' | 'mov' | 'gif', width: Math.ceil(operation.source.width / 2) * 2, height: Math.ceil(operation.source.height / 2) * 2, fps: args.fps as number | undefined ?? Math.min(60, operation.source.fps), quality: (args.quality as 'draft' | 'balanced' | 'high' | undefined) ?? 'balanced' }
          const prepared = await prepareNativeProject(operation.source, operation.controller.signal)
          check(operation)
          let job: MediaJob = await beginMcpMediaJob({ kind: 'timeline', ...prepared, config }, args.outputPath as string, args.overwrite === true)
          operation.cancelNative = () => cancelMediaJob(job.id)
          if (operation.controller.signal.aborted) await operation.cancelNative()
          while (true) {
            check(operation)
            changed(operation, job.stage || '正在导出', job.progress, job)
            if (job.state === 'completed') {
              operation.irrevocable = true; operation.job.cancelable = false
              let folderOpened = false
              try { await revealMediaJobOutput(job.id); folderOpened = true }
              catch (cause) { operation.job.warning = `无法自动打开导出文件夹：${message(cause)}` }
              return { outputPath: job.outputPath, nativeJobId: job.id, backend: job.backend, elapsedSeconds: job.elapsedSeconds, fallbackReason: job.fallbackReason, folderOpened }
            }
            if (job.state === 'failed') throw new Error(job.error || '视频导出失败。')
            if (job.state === 'cancelled') throw new DOMException('导出已取消。', 'AbortError')
            await wait(operation)
            const current = (await getMediaJobs()).find(item => item.id === job.id)
            if (!current) throw new Error('导出任务已不存在。')
            job = current
          }
        })
      default: throw new Error('此 MCP 工具尚未接入。')
    }
  }
  async function execute(name: string, input: unknown): Promise<unknown> {
    return mcpSynchronousResponse(await executeInner(name, input))
  }
  function list(): ((McpAutomationJob | McpSpeechJob) & McpJobProtocol)[] {
    return [...[...operations.values()].map(operation => snapshot(operation)), ...speech.list().map(mcpJobResponse)].sort((a, b) => b.startedAt - a.startedAt)
  }
  /** Frequent interface updates need status, not copies of accumulated frame/artifact payloads. */
  function summaries(): ((McpAutomationJob | McpSpeechJob) & McpJobProtocol)[] {
    return [...[...operations.values()].map(operation => snapshot(operation, false)), ...speech.summaries().map(mcpJobResponse)].sort((a, b) => b.startedAt - a.startedAt)
  }
  function status(id: string): (McpAutomationJob | McpSpeechJob) & McpJobProtocol {
    const operation = operations.get(id)
    if (operation) return snapshot(operation)
    return mcpJobResponse(speech.status(id))
  }
  function remoteJobResponse(id: string) {
    const operation = operations.get(id)
    // Model installation belongs to the application, independent of its editor project.
    if (operation && ['ai-model-download', 'video-model-download'].includes(operation.job.kind)) return { ...snapshot(operation), scope: 'application' as const }
    const owner = operation ? { projectId: operation.job.projectId, projectSession: operation.projectSession } : speechSessions.get(id)
    if (owner && sameSession(owner)) return { ...status(id), projectCurrent: true }
    const job = operation ? snapshot(operation, false) : mcpJobResponse(speech.status(id))
    // Retain cleanup/progress metadata only. Names, stages, errors, skipped subtitles and
    // inline media results can contain project content even without an artifact token.
    return mcpJobResponse({ id: job.id, projectId: job.projectId, revision: job.revision, kind: job.kind,
      ...('tool' in job ? { tool: job.tool } : {}), name: '其他工程会话的任务',
      state: job.state, cancelable: job.cancelable, cancelling: job.cancelling,
      startedAt: job.startedAt, finishedAt: job.finishedAt, elapsedSeconds: job.elapsedSeconds, progress: job.progress,
      stage: job.state === 'running' ? '正在处理其他工程会话的任务' : job.state === 'completed' ? '已完成' : job.state === 'cancelled' ? '已取消' : '失败',
      projectCurrent: false, resultAvailable: false, resultUnavailableReason: '任务属于其他工程会话，仅可查询状态或取消；请在当前工程重新执行以获取结果。' })
  }
  async function cancel(id: string): Promise<unknown> {
    const operation = operations.get(id)
    if (!operation) return mcpJobResponse(await speech.cancel(id))
    if (operation.job.state !== 'running') return snapshot(operation)
    if (!operation.job.cancelable || operation.irrevocable) throw new Error('任务正在写入最终结果，已经无法取消。')
    operation.controller.abort(); operation.job.cancelling = true; changed(operation, '正在取消')
    await operation.cancelNative?.()
    return snapshot(operation)
  }
  async function cancelAll(): Promise<void> {
    await Promise.allSettled(summaries().filter(job => job.state === 'running' && job.cancelable).map(job => cancel(job.id)))
  }
  async function dispose(): Promise<void> { disposed = true; await cancelAll(); await speech.dispose() }
  return { execute, list, summaries, status, cancel, cancelAll, dispose }
}
