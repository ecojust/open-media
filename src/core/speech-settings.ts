export interface SpeechSettings {
  voiceId: string
  rate: number
  alignText: boolean
}

const STORAGE_KEY = 'open-media:speech-settings'
export const DEFAULT_SPEECH_VOICE = 'matcha_zh_en_female'
const defaults: Readonly<SpeechSettings> = Object.freeze({ voiceId: DEFAULT_SPEECH_VOICE, rate: 1, alignText: true })
const listeners = new Set<(settings: SpeechSettings) => void>()

export function validateSpeechSettings(value: unknown, base: Readonly<SpeechSettings> = defaults): SpeechSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配音设置必须是对象。')
  const patch = value as Record<string, unknown>
  if (Object.keys(patch).some(key => !['voiceId', 'rate', 'alignText'].includes(key))) throw new Error('配音设置仅支持 voiceId、rate 和 alignText。')
  const result = { ...base, ...patch } as SpeechSettings
  if (typeof result.voiceId !== 'string' || result.voiceId.length > 200 || /[\u0000-\u001f]/.test(result.voiceId)) throw new Error('声音标识无效。')
  if (typeof result.rate !== 'number' || !Number.isFinite(result.rate) || result.rate < 0.5 || result.rate > 2) throw new Error('配音语速必须在 0.5 到 2 之间。')
  if (typeof result.alignText !== 'boolean') throw new Error('文字时长对齐选项必须为布尔值。')
  return result
}

function readSettings(): SpeechSettings {
  try {
    const saved = validateSpeechSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'))
    return { ...saved, voiceId: saved.voiceId || DEFAULT_SPEECH_VOICE }
  }
  catch { return { ...defaults } }
}

let settings = readSettings()

export function getSpeechSettings(): SpeechSettings { return { ...settings } }

/** Remote callers may confirm the user's choice, but cannot select another voice. */
export function resolveMcpSpeechVoice(requested?: unknown): string {
  const selected = getSpeechSettings().voiceId
  if (!selected) throw new Error('请先在配音面板选择声音，MCP 只能使用用户当前选中的音色。')
  if (requested !== undefined && requested !== selected) throw new Error(`MCP 只能使用用户当前选中的音色 ${selected}，请在配音面板修改选择。`)
  return selected
}

export function assertMcpSpeechVoice(voiceId: string): void {
  if (getSpeechSettings().voiceId !== voiceId) throw new Error('用户选择的配音音色已经变化，请使用当前音色重新生成。')
}

export function validateMcpSpeechSettings(value: unknown): SpeechSettings {
  const next = validateSpeechSettings(value, getSpeechSettings())
  next.voiceId = resolveMcpSpeechVoice(next.voiceId)
  return next
}

/** The panel and remote operations use the same preferences, including while the editor is closed. */
export function updateSpeechSettings(patch: Partial<SpeechSettings>): SpeechSettings {
  const next = validateSpeechSettings(patch, settings)
  if (next.voiceId === settings.voiceId && next.rate === settings.rate && next.alignText === settings.alignText) return getSpeechSettings()
  settings = next
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch { /* Preferences still apply during this session. */ }
  for (const listener of listeners) listener(getSpeechSettings())
  return getSpeechSettings()
}

export function subscribeSpeechSettings(listener: (settings: SpeechSettings) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
