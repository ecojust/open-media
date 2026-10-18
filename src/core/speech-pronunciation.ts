export interface PronunciationEntry { text: string; pronunciation: string }
const KEY = 'open-media:speech-pronunciation'
export function validateSpeechPronunciation(value: unknown): PronunciationEntry[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('读法词典最多支持 200 条。')
  const seen = new Set<string>()
  return value.map(entry => {
    if (!entry || typeof entry.text !== 'string' || typeof entry.pronunciation !== 'string' || !entry.text.trim() || !entry.pronunciation.trim() || entry.text.length > 80 || entry.pronunciation.length > 160 || /[\u0000-\u001f]/.test(entry.text + entry.pronunciation)) throw new Error('每条读法需要有效原文和读音，原文最多 80 字，读音最多 160 字。')
    if (seen.has(entry.text)) throw new Error(`读法词典包含重复原文：${entry.text}`)
    seen.add(entry.text)
    return { text: entry.text, pronunciation: entry.pronunciation }
  })
}
let entries: PronunciationEntry[] = []
try { entries = validateSpeechPronunciation(JSON.parse(localStorage.getItem(KEY) || '[]')) } catch { /* Use an empty dictionary when unavailable. */ }
export function getSpeechPronunciation(): PronunciationEntry[] { return entries.map(entry => ({ ...entry })) }
export function setSpeechPronunciation(value: unknown): PronunciationEntry[] {
  entries = validateSpeechPronunciation(value)
  try { localStorage.setItem(KEY, JSON.stringify(entries)) } catch { /* Retain session preferences. */ }
  return getSpeechPronunciation()
}
/** Literal longest-first replacements are performed once, never recursively. */
export function applySpeechPronunciation(text: string, dictionary: readonly PronunciationEntry[] = entries): string {
  const ordered = [...dictionary].sort((a, b) => b.text.length - a.text.length)
  if (!ordered.length) return text
  const replacements = new Map(ordered.map(entry => [entry.text, entry.pronunciation]))
  const pattern = ordered.map(entry => entry.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const spoken = text.replace(new RegExp(pattern, 'g'), value => replacements.get(value)!)
  if ([...spoken].length > 4000) throw new Error('替换读法后超过单段 4000 字上限，请缩短字幕或读法。')
  return spoken
}
