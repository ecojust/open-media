import type { MediaAsset, Project } from './types.ts'
import type { SpeechJob, SpeechRequest, SpeechStatus } from '../native.ts'
import { cloneProject } from './project.ts'
import { applySpeechResults, planSpeech, validateSpeechPlanCapacity, type SpeechPlan, type SpeechResult, type SpeechOverlap } from './speech.ts'
import { getSpeechSettings, validateSpeechSettings, type SpeechSettings } from './speech-settings.ts'
import { compactVoiceCatalog } from './voice-catalog.ts'
import { voiceReady } from './voice-downloads.ts'
import { applySpeechPronunciation } from './speech-pronunciation.ts'
import { getSpeechAlignment } from './speech-timing.ts'

export interface McpSpeechRequest { clipIds?: string[]; voiceId?: string; rate?: number; alignText?: boolean }
export interface McpSpeechJob {
  id: string
  name: string
  kind: 'speech'
  projectId: string
  revision: number
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  cancelling: boolean
  cancelable: boolean
  startedAt: number
  finishedAt?: number
  elapsedSeconds: number
  total: number
  completed: number
  currentClipId?: string
  progress?: number
  stage: string
  voiceId: string
  rate: number
  alignText: boolean
  skipped: SpeechPlan['skipped']
  error?: string
  warning?: string
  result?: { assetIds: string[]; audioClipIds: string[]; overlaps: SpeechOverlap[] }
}

export interface McpSpeechNative {
  getSpeechStatus(): Promise<SpeechStatus>
  beginSpeechJob(request: SpeechRequest): Promise<SpeechJob>
  getSpeechJob(id: string): Promise<SpeechJob>
  cancelSpeechJob(id: string): Promise<void>
  discardSpeechJob(id: string): Promise<void>
  acceptSpeechJobs(ids: string[]): Promise<void>
}

export interface McpSpeechJobsOptions {
  getProject(): Project
  getRevision(): number
  getProjectSession?(): number
  isBusy(): boolean
  onBusy(value: boolean): void
  prepareProject?(project: Project, options: { signal: AbortSignal; assertCurrent: () => void }): Promise<Project>
  /** Must synchronously reject a stale revision or commit the whole project as one undo step. */
  commit(project: Project, label: string, expected: { projectId: string; revision: number; projectSession?: number }): boolean | void
  onAssets?(assets: MediaAsset[]): void
  onChange?(job: McpSpeechJob): void
  native: McpSpeechNative
  pollIntervalMs?: number
}

interface Operation {
  job: McpSpeechJob
  project: Project
  projectSession?: number
  controller: AbortController
  nativeJobs: Set<string>
  currentNativeJob?: string
  committed: boolean
  done?: Promise<void>
}

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }

export function createMcpSpeechJobs(options: McpSpeechJobsOptions) {
  const operations = new Map<string, Operation>()
  let active: Operation | undefined
  let disposed = false

  function snapshot(operation: Operation, includeResult = true): McpSpeechJob {
    const { result, ...status } = operation.job
    return structuredClone({ ...status, ...(includeResult && result !== undefined ? { result } : {}), elapsedSeconds: Math.max(0, Math.floor(((operation.job.finishedAt ?? Date.now()) - operation.job.startedAt) / 1000)) })
  }
  function publish(operation: Operation): void { options.onChange?.(snapshot(operation)) }
  function check(operation: Operation): void {
    if (operation.controller.signal.aborted || disposed) throw new Error('已取消语音生成，时间线保持原样。')
    if (options.getProject().id !== operation.job.projectId || options.getRevision() !== operation.job.revision || options.getProjectSession?.() !== operation.projectSession) throw new Error('项目已经变化，本次语音未写入时间线，请重新生成。')
  }
  function wait(operation: Operation): Promise<void> {
    return new Promise((resolve, reject) => {
      const stopped = () => { clearTimeout(timer); operation.controller.signal.removeEventListener('abort', stopped); reject(new Error('已取消语音生成。')) }
      const timer = setTimeout(() => { operation.controller.signal.removeEventListener('abort', stopped); resolve() }, options.pollIntervalMs ?? 350)
      if (operation.controller.signal.aborted) stopped()
      else operation.controller.signal.addEventListener('abort', stopped, { once: true })
    })
  }
  function progress(operation: Operation, job: SpeechJob): void {
    const reported = job.progress
    const current = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 && reported <= 1 ? reported : undefined
    operation.job.progress = current === undefined && !operation.job.completed ? undefined : Math.min(0.99, (operation.job.completed + (current ?? 0)) / operation.job.total)
    operation.job.stage = job.stage || '正在生成语音'
    publish(operation)
  }
  async function synthesize(operation: Operation, result: SpeechResult['source']): Promise<MediaAsset> {
    check(operation)
    operation.job.currentClipId = result.clipId
    operation.job.stage = `正在生成第 ${operation.job.completed + 1} / ${operation.job.total} 段`
    publish(operation)
    const requestId = crypto.randomUUID()
    operation.nativeJobs.add(requestId)
    operation.currentNativeJob = requestId
    let job = await options.native.beginSpeechJob({ requestId, text: applySpeechPronunciation(result.text), voiceId: operation.job.voiceId, speed: operation.job.rate })
    if (job.id !== requestId) { operation.nativeJobs.delete(requestId); operation.nativeJobs.add(job.id); operation.currentNativeJob = job.id }
    while (true) {
      check(operation)
      if (job.state === 'failed') throw new Error(job.error || '语音生成失败，请重试。')
      if (job.state === 'cancelled') { operation.controller.abort(); throw new Error('语音生成已取消。') }
      if (job.state === 'completed') {
        const asset = job.asset
        if (!asset || asset.kind !== 'audio' || !Number.isFinite(asset.duration) || asset.duration <= 0 || !asset.nativePath || !asset.url || asset.url.startsWith('blob:')) throw new Error('语音生成结果缺少可用的本地音频文件。')
        operation.currentNativeJob = undefined
        return asset
      }
      progress(operation, job)
      await wait(operation)
      job = await options.native.getSpeechJob(job.id)
    }
  }
  async function run(operation: Operation, plan: SpeechPlan): Promise<void> {
    try {
      const status = await options.native.getSpeechStatus()
      check(operation)
      if (!operation.job.voiceId) {
        const voices = compactVoiceCatalog(status.voices).filter(voiceReady)
        operation.job.voiceId = voices.find(voice => voice.language.toLowerCase().startsWith('zh'))?.id || voices[0]?.id || ''
      }
      if (!status.ready) throw new Error(status.error || '语音组件暂不可用。')
      if (!voiceReady(status.voices.find(voice => voice.id === operation.job.voiceId))) throw new Error('所选声音尚不可用，请先下载或修复模型。')
      const results: SpeechResult[] = []
      for (const source of plan.sources) {
        const asset = await synthesize(operation, source)
        check(operation)
        results.push({ source, asset, voiceId: operation.job.voiceId, rate: operation.job.rate })
        validateSpeechPlanCapacity(operation.project, plan, new Map(results.map(item => [item.source.clipId, item.asset.duration])))
        operation.job.completed = results.length
        operation.job.progress = Math.min(0.99, results.length / plan.sources.length)
        publish(operation)
      }
      check(operation)
      const edit = applySpeechResults(operation.project, results, { alignText: operation.job.alignText, alignment: getSpeechAlignment() })
      operation.job.stage = '正在归档工程配音素材'
      publish(operation)
      const project = options.prepareProject ? await options.prepareProject(edit.project, { signal: operation.controller.signal, assertCurrent: () => check(operation) }) : edit.project
      check(operation)
      if (project.id !== operation.job.projectId) throw new Error('工程配音归档返回了其他工程，本次语音未写入时间线。')
      operation.job.cancelable = false
      operation.job.stage = '正在加入时间线'
      publish(operation)
      check(operation)
      const accepted = options.commit(project, `MCP 已为 ${results.length} 段文字生成语音`, { projectId: operation.job.projectId, revision: operation.job.revision, projectSession: operation.projectSession })
      if (accepted === false || options.getProject().id !== operation.job.projectId || !results.every(item => options.getProject().assets.some(asset => asset.id === item.asset.id)) || !edit.audioClipIds.every(id => options.getProject().tracks.some(track => track.clips.some(clip => clip.id === id)))) throw new Error('语音没有写入项目，请重试。')
      operation.committed = true
      operation.job.result = { assetIds: results.map(item => item.asset.id), audioClipIds: edit.audioClipIds, overlaps: edit.overlaps }
      try { options.onAssets?.(results.map(item => project.assets.find(asset => asset.id === item.asset.id)!)) } catch { operation.job.warning = '语音已加入项目，素材列表刷新失败。' }
      const ids = [...operation.nativeJobs]
      operation.nativeJobs.clear()
      try { await options.native.acceptSpeechJobs(ids) }
      catch { operation.job.warning = [operation.job.warning, '音频已保留，完成记录暂未同步。'].filter(Boolean).join(' ') }
      operation.job.state = 'completed'
      operation.job.stage = '语音已加入时间线'
      operation.job.progress = 1
    } catch (cause) {
      operation.job.state = operation.controller.signal.aborted || disposed ? 'cancelled' : 'failed'
      operation.job.error = errorText(cause)
      operation.job.stage = operation.job.state === 'cancelled' ? '已取消' : '生成失败'
      if (operation.currentNativeJob) await options.native.cancelSpeechJob(operation.currentNativeJob).catch(() => {})
    } finally {
      // Files referenced by a committed project must never be discarded, even if acknowledgement fails.
      if (!operation.committed) await Promise.allSettled([...operation.nativeJobs].map(id => options.native.discardSpeechJob(id)))
      operation.nativeJobs.clear()
      operation.job.currentClipId = undefined
      operation.job.cancelable = false
      operation.job.cancelling = false
      operation.job.finishedAt = Date.now()
      if (active === operation) { active = undefined; options.onBusy(false) }
      publish(operation)
    }
  }
  function startSpeech(request: McpSpeechRequest = {}): McpSpeechJob {
    if (disposed) throw new Error('配音服务已经关闭。')
    if (active || options.isBusy()) throw new Error('当前项目正在处理其他操作，请稍后再生成语音。')
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['clipIds', 'voiceId', 'rate', 'alignText'].includes(key))) throw new Error('配音请求参数无效。')
    if (request.clipIds !== undefined && (!Array.isArray(request.clipIds) || request.clipIds.some(id => typeof id !== 'string' || !id))) throw new Error('字幕标识必须是字符串数组。')
    const patch = Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'clipIds')) as Partial<SpeechSettings>
    const settings = validateSpeechSettings(patch, getSpeechSettings())
    const project = cloneProject(options.getProject())
    const revision = options.getRevision()
    const plan = planSpeech(project, request.clipIds)
    if (!plan.sources.length) throw new Error(plan.skipped[0]?.reason || '请先在时间线中添加字幕。')
    if (request.clipIds && plan.skipped.length) throw new Error(`部分指定字幕无法生成：${plan.skipped.map(item => `${item.name}：${item.reason}`).join('；')}`)
    validateSpeechPlanCapacity(project, plan)
    const job: McpSpeechJob = { id: crypto.randomUUID(), name: `字幕转语音 · ${plan.sources.length} 段`, kind: 'speech', projectId: project.id, revision, state: 'running', cancelling: false, cancelable: true, startedAt: Date.now(), elapsedSeconds: 0, total: plan.sources.length, completed: 0, stage: '正在检查声音', ...settings, skipped: plan.skipped }
    const operation: Operation = { job, project, projectSession: options.getProjectSession?.(), controller: new AbortController(), nativeJobs: new Set(), committed: false }
    while (operations.size >= 50) { const oldest = operations.keys().next().value; if (oldest) operations.delete(oldest); else break }
    active = operation
    operations.set(job.id, operation)
    options.onBusy(true)
    publish(operation)
    operation.done = run(operation, plan)
    return snapshot(operation)
  }
  function find(id: string): Operation {
    const operation = operations.get(id)
    if (!operation) throw new Error('配音任务不存在或已过期。')
    return operation
  }
  async function cancel(id: string): Promise<McpSpeechJob> {
    const operation = find(id)
    if (operation.job.state !== 'running' || !operation.job.cancelable || operation.job.cancelling) return snapshot(operation)
    operation.job.cancelling = true
    operation.job.cancelable = false
    operation.job.stage = '正在取消'
    operation.controller.abort()
    publish(operation)
    if (operation.currentNativeJob) await options.native.cancelSpeechJob(operation.currentNativeJob).catch(() => {})
    return snapshot(operation)
  }
  async function dispose(): Promise<void> {
    disposed = true
    const operation = active
    if (operation) { await cancel(operation.job.id); await operation.done }
  }
  return { startSpeech, status: (id: string) => snapshot(find(id)), list: () => [...operations.values()].reverse().map(operation => snapshot(operation)),
    summaries: () => [...operations.values()].reverse().map(operation => snapshot(operation, false)), cancel, dispose }
}
