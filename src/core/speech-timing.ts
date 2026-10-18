import type { Project } from './types.ts'
import { planSpeech } from './speech.ts'
import { applySpeechPronunciation } from './speech-pronunciation.ts'

export interface SpeechAlignmentSettings { mode: 'subtitle' | 'ripple' | 'extend_visual'; gap: number }
const KEY = 'open-media:speech-alignment'
let alignment: SpeechAlignmentSettings = { mode: 'subtitle', gap: 0 }
export function validateSpeechAlignment(value: unknown): SpeechAlignmentSettings {
  if (!value || typeof value !== 'object') throw new Error('配音对齐设置无效。')
  const candidate = value as SpeechAlignmentSettings
  if (!['subtitle', 'ripple', 'extend_visual'].includes(candidate.mode) || typeof candidate.gap !== 'number' || !Number.isFinite(candidate.gap) || candidate.gap < 0 || candidate.gap > 5) throw new Error('请选择字幕对齐、顺延后文或延长画面；间隔应在 0 到 5 秒之间。')
  return { mode: candidate.mode, gap: candidate.gap }
}
try { alignment = validateSpeechAlignment(JSON.parse(localStorage.getItem(KEY) || 'null')) } catch { /* Keep compatible defaults. */ }
export function getSpeechAlignment(): SpeechAlignmentSettings { return { ...alignment } }
export function setSpeechAlignment(value: { mode: SpeechAlignmentSettings['mode']; gap?: number }): SpeechAlignmentSettings {
  alignment = validateSpeechAlignment({ ...value, gap: value.gap ?? 0 })
  try { localStorage.setItem(KEY, JSON.stringify(alignment)) } catch { /* Retain session preferences. */ }
  return getSpeechAlignment()
}
export function speechTimingPlan(project: Project, options: { clipIds?: string[]; rate?: number } = {}) {
  const rate = options.rate ?? 1
  if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new Error('配音语速必须在 0.5 到 2 之间。')
  const plan = planSpeech(project, options.clipIds)
  const segments = plan.sources.map(source => {
    const text = applySpeechPronunciation(source.text)
    const chinese = [...text].filter(char => /\p{Script=Han}/u.test(char)).length
    const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !/\p{Script=Han}/u.test(word)).length
    const pauses = (text.match(/[，。！？；、,.!?;:]/g) ?? []).length
    const estimateSeconds = Math.max(0.35, (chinese / 4.2 + words / 2.5 + pauses * 0.18) / rate)
    const range = { min: Math.round(estimateSeconds * 0.75 * 100) / 100, max: Math.round(estimateSeconds * 1.35 * 100) / 100 }
    return { clipId: source.clipId, text: source.text, estimateSeconds: Math.round(estimateSeconds * 100) / 100, range, availableSeconds: source.duration, risk: estimateSeconds > source.duration ? 'likely-overflow' : range.max > source.duration ? 'possible-overflow' : 'fits-estimate' }
  })
  return { estimate: true, measured: false, method: '文字数量与标点估时，实际时长以模型生成结果为准。', segments, skipped: plan.skipped, totalEstimateSeconds: Math.round(segments.reduce((sum, item) => sum + item.estimateSeconds, 0) * 100) / 100 }
}
