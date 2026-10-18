export interface McpToolLink { tool: string; arguments: Record<string, unknown> }
export interface McpBlockingOperation {
  jobId: string | null
  kind: string
  tool?: string
  name?: string
  state: string
  stage?: string
  cancelable: boolean
  cancelling?: boolean
  poll: McpToolLink | null
  cancel: McpToolLink | null
  source: 'mcp' | 'local'
}
export interface McpJobProtocol {
  responseType: 'job'
  execution: 'asynchronous'
  jobId: string
  status: string
  final: boolean
  pollAfterMs: number
  poll: McpToolLink
  cancel: McpToolLink | null
  errorDetails?: Record<string, unknown>
}
interface JobLike { id: string; state: string; cancelable: boolean; cancelling?: boolean; kind: string; name: string; stage: string; tool?: string; error?: string; errorDetails?: Record<string, unknown> }

/** Retain legacy id/state/result fields and add a self-contained polling contract. */
export function mcpJobResponse<T extends JobLike>(job: T): T & McpJobProtocol {
  const final = job.state !== 'running'
  const errorDetails = job.errorDetails ?? (job.error ? serializeMcpError(job.state === 'cancelled' ? new DOMException(job.error, 'AbortError') : new Error(job.error)) : undefined)
  return { ...job, ...(errorDetails ? { errorDetails } : {}), responseType: 'job', execution: 'asynchronous', jobId: job.id, status: job.state, final,
    pollAfterMs: final ? 0 : 500,
    poll: { tool: 'open_media_job_get', arguments: { id: job.id } },
    cancel: !final && job.cancelable && !job.cancelling ? { tool: 'open_media_job_cancel', arguments: { id: job.id } } : null }
}

export function mcpBlockingJob(job: JobLike): McpBlockingOperation {
  const response = mcpJobResponse(job)
  return { jobId: job.id, kind: job.kind, tool: job.tool ?? (job.kind === 'speech' ? 'open_media_speech_generate' : undefined), name: job.name,
    state: job.state, stage: job.stage, cancelable: response.cancel !== null, cancelling: job.cancelling,
    poll: response.poll, cancel: response.cancel, source: 'mcp' }
}

export class McpBusyError extends Error {
  readonly code = 'PROJECT_BUSY'
  readonly retryable = true
  readonly retryAfterMs = 500
  readonly blockingJob: McpBlockingOperation
  constructor(blockingJob: McpBlockingOperation) {
    super(`当前项目正在处理其他操作${blockingJob.name ? `：${blockingJob.name}` : ''}。请先查询阻塞任务，等待完成${blockingJob.cancelable ? '或取消任务' : ''}后重试。`)
    this.name = 'McpBusyError'
    this.blockingJob = blockingJob
  }
}

export function mcpSynchronousResponse(value: unknown): unknown {
  // Existing clients expect job_list to remain an array; each item is self-describing.
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && ['job', 'model-status'].includes(String((value as { responseType?: unknown }).responseType))) return value
  return { ...(value && typeof value === 'object' ? value : { result: value }), responseType: 'result', execution: 'synchronous', final: true }
}

function safeResource(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const object = value as Record<string, unknown>
  const entries = ['assetId', 'clipId', 'name'].flatMap(key => typeof object[key] === 'string' ? [[key, (object[key] as string).slice(0, 1024)]] : [])
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** Error details are an allowlist: local paths, URLs and arbitrary exception fields stay private. */
export function serializeMcpError(cause: unknown): Record<string, unknown> {
  const object = cause && typeof cause === 'object' ? cause as Record<string, unknown> : {}
  const error = typeof object.message === 'string' ? object.message : String(cause)
  const details: Record<string, unknown> = {}
  if (typeof object.stage === 'string') details.stage = object.stage.slice(0, 256)
  const resource = safeResource(object.resource)
  if (resource) details.resource = resource
  if (Array.isArray(object.relatedResources)) details.relatedResources = object.relatedResources.slice(0, 100).map(safeResource).filter(Boolean)
  if (object.context && typeof object.context === 'object') {
    const context = object.context as Record<string, unknown>
    details.context = Object.fromEntries(['time', 'start', 'end', 'width'].flatMap(key => typeof context[key] === 'number' && Number.isFinite(context[key]) ? [[key, context[key]]] : []))
  }
  return { responseType: 'error', error, code: typeof object.code === 'string' ? object.code : object.name === 'AbortError' ? 'CANCELLED' : 'TOOL_FAILED',
    retryable: object.retryable === true,
    ...(Object.keys(details).length ? { details } : {}),
    ...(cause instanceof McpBusyError ? { blockingJob: cause.blockingJob, retryAfterMs: cause.retryAfterMs } : {}) }
}
