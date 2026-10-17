import type { Project } from './types.ts'

/** Keep portable timestamps explicit about their time zone. */
export function normalizeAssetAddedAt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('素材加入时间无效。')
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts) throw new Error('素材加入时间无效。')
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts
  const year = Number(yearText), month = Number(monthText), day = Number(dayText)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const timestamp = Date.parse(value)
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 || !Number.isFinite(timestamp)) throw new Error('素材加入时间无效。')
  return new Date(timestamp).toISOString()
}

/** Stamp additions once, without assigning invented dates to existing legacy assets. */
export function stampNewAssets(next: Project, previous: Project, now = new Date().toISOString()): Project {
  const timestamp = normalizeAssetAddedAt(now)
  const existing = new Map(previous.id === next.id ? previous.assets.map(asset => [asset.id, asset]) : [])
  return {
    ...next,
    assets: next.assets.map(asset => {
      const previousAsset = existing.get(asset.id)
      const addedAt = previousAsset ? previousAsset.addedAt : asset.addedAt ?? timestamp
      const result = { ...asset }
      if (addedAt === undefined) delete result.addedAt
      else result.addedAt = normalizeAssetAddedAt(addedAt)
      return result
    }),
  }
}
