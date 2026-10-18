export interface MediaToolResource { assetId?: string; clipId?: string; name: string }
export interface MediaToolErrorContext { time?: number; start?: number; end?: number; width?: number }
export interface MediaToolDiagnostic {
  stage: string
  resource?: MediaToolResource
  /** Related inputs, not a claim that every listed input caused the error. */
  relatedResources?: MediaToolResource[]
  context?: MediaToolErrorContext
}

export class MediaToolError extends Error implements MediaToolDiagnostic {
  readonly code = 'MEDIA_TOOL_FAILED'
  readonly stage: string
  readonly resource?: MediaToolResource
  readonly relatedResources?: MediaToolResource[]
  readonly context?: MediaToolErrorContext
  constructor(message: string, cause: unknown, diagnostic: MediaToolDiagnostic) {
    super(message, { cause })
    this.name = 'MediaToolError'
    this.stage = diagnostic.stage
    this.resource = diagnostic.resource
    this.relatedResources = diagnostic.relatedResources
    this.context = diagnostic.context
  }
}

/** Retain the most specific failure and the cancellation contract through wrappers. */
export function mediaToolError(stage: string, cause: unknown, diagnostic: Omit<MediaToolDiagnostic, 'stage'> = {}, label?: string): Error {
  if (cause && typeof cause === 'object' && 'name' in cause && cause.name === 'AbortError') return cause as Error
  const inner = cause instanceof MediaToolError ? cause : undefined
  const resource = inner?.resource ?? diagnostic.resource
  const resourceLabel = resource ? `，${resource.assetId ? '素材' : '片段'}“${resource.name}”（${resource.assetId ?? resource.clipId ?? '未知标识'}）` : ''
  const message = cause instanceof Error ? cause.message : String(cause)
  return new MediaToolError(`${label ?? stage}失败${inner ? '' : resourceLabel}：${message}`, cause, {
    stage: inner?.stage ?? stage, resource,
    relatedResources: inner?.relatedResources ?? diagnostic.relatedResources,
    context: { ...diagnostic.context, ...inner?.context },
  })
}
