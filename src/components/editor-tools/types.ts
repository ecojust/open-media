export type { EditorToolProgress, EditorToolRunOptions as EditorToolOptions, EditorToolRunner } from '../../core/editor-tool-service'
export type AssetToolAction = 'probe' | 'frame' | 'storyboard' | 'scenes' | 'idle' | 'ocr' | 'url'

export function toolData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : record
}
