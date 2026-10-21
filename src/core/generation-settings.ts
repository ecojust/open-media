export type GenerationProvider = 'image' | 'music' | 'video'
export type GenerationModels = Record<GenerationProvider, string>

const STORAGE_KEY = 'open-media:generation-models:v1'
const defaults: Readonly<GenerationModels> = Object.freeze({ image: 'z-image-turbo', music: 'ace-step-1.5-turbo', video: 'h3-base-fl2va' })
const labels: Record<GenerationProvider, string> = { image: '图像', music: '音乐', video: '视频' }
const listeners = new Set<(models: GenerationModels) => void>()

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
function assertProvider(provider: GenerationProvider): void {
  if (!Object.hasOwn(defaults, provider)) throw new Error('生成模型类别无效。')
}
function readObject(key: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}
function readModels(): GenerationModels {
  const saved = readObject(STORAGE_KEY)
  const result = { ...defaults }
  for (const provider of Object.keys(defaults) as GenerationProvider[]) {
    const draft = readObject(provider === 'video' ? 'open-media:video-generation-draft:v1' : `open-media:ai-${provider}-draft:v1`)
    if (validId(saved[provider])) result[provider] = saved[provider]
    else if (validId(draft.modelId) && draft.modelId) result[provider] = draft.modelId
  }
  return result
}

let models = readModels()

/** Selected models are shared before any generation workspace is mounted. */
export function getGenerationModel(provider: GenerationProvider): string { assertProvider(provider); return models[provider] }

/** Only user-facing model controls should change this preference; MCP may read it. */
export function setGenerationModel(provider: GenerationProvider, id: string): string {
  assertProvider(provider)
  if (!validId(id)) throw new Error('生成模型标识无效。')
  if (models[provider] === id) return id
  models = { ...models, [provider]: id }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(models)) } catch { /* The current session retains the user's choice. */ }
  for (const listener of listeners) listener({ ...models })
  return id
}

export function subscribeGenerationModels(listener: (models: GenerationModels) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function resolveMcpGenerationModel(provider: GenerationProvider, requestedId?: unknown): string {
  const selected = getGenerationModel(provider)
  if (!selected) throw new Error(`尚未选择${labels[provider]}生成模型，请用户先在${labels[provider]}生成页面选择模型。`)
  if (requestedId !== undefined && requestedId !== selected) throw new Error(`MCP 只能使用用户当前选择的${labels[provider]}模型「${selected}」，不能切换为其他模型。`)
  return selected
}

export function assertMcpGenerationModel(provider: GenerationProvider, id: string): void {
  resolveMcpGenerationModel(provider, id)
}
