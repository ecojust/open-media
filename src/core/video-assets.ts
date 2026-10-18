import type { MediaAsset } from './types.ts'

/** Older documents have no timestamp; their append order still records import order. */
export function recentVideoAssets(assets: readonly MediaAsset[]): MediaAsset[] {
  return assets.map((asset, index) => ({ asset, index, time: asset.addedAt ? Date.parse(asset.addedAt) || 0 : 0 }))
    .filter(item => item.asset.kind === 'video')
    .sort((a, b) => b.time - a.time || b.index - a.index)
    .map(item => item.asset)
}

export function videoAssetKey(asset: MediaAsset): string {
  if (!asset.nativePath) return `id:${asset.id}`
  const path = asset.nativePath.replace(/\\/g, '/')
  return `path:${/^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path}`
}

/** Browse the shared library without adding its files to the current project. */
export function mergeStoredVideoAssets(project: readonly MediaAsset[], stored: readonly MediaAsset[]): MediaAsset[] {
  const assets = new Map<string, MediaAsset>()
  for (const asset of stored) if (asset.kind === 'video') assets.set(videoAssetKey(asset), asset)
  for (const asset of project) {
    if (asset.kind !== 'video') continue
    const key = videoAssetKey(asset), libraryAsset = assets.get(key)
    assets.set(key, libraryAsset ? { ...libraryAsset, ...asset, addedAt: libraryAsset.addedAt ?? asset.addedAt } : asset)
  }
  return recentVideoAssets([...assets.values()])
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
export function videoImportedTime(asset: MediaAsset): string {
  const time = asset.addedAt ? Date.parse(asset.addedAt) : NaN
  return Number.isFinite(time) ? dateFormat.format(new Date(time)) : '导入时间未记录'
}

export function videoDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
