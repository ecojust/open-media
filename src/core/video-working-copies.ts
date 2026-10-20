import type { MediaAsset, Project } from './types.ts'
import { videoAssetKey } from './video-assets.ts'

type VideoProject = Pick<Project, 'assets' | 'tracks'>

/** Old projects identify their working copies through timeline references. */
export function activeCompressedVideos(project: VideoProject): MediaAsset[] {
  const referenced = new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.assetId)))
  const copies = new Map<string, MediaAsset>()
  for (const asset of project.assets) {
    const compression = asset.compression
    if (asset.kind !== 'video' || !compression || !(compression.active === true || compression.active === undefined && referenced.has(asset.id))) continue
    const previous = copies.get(compression.originalAssetId)
    if (previous?.compression?.active === true && compression.active !== true) continue
    copies.set(compression.originalAssetId, asset)
  }
  return [...copies.values()]
}

/** Resolve newly added clips and library cards to the project's current working media. */
export function videoWorkingCopyResolver(project: VideoProject): (asset: MediaAsset) => MediaAsset {
  const originals = project.assets.filter(asset => asset.kind === 'video' && !asset.compression)
  const byId = new Map(originals.map(asset => [asset.id, asset]))
  const byPath = new Map(originals.map(asset => [videoAssetKey(asset), asset]))
  const copies = activeCompressedVideos(project)
  const byOriginal = new Map(copies.map(asset => [asset.compression!.originalAssetId, asset]))
  const bySource = new Map(copies.flatMap(asset => {
    const original = byId.get(asset.compression!.originalAssetId)
    return original ? [[videoAssetKey(original), asset] as const] : []
  }))
  return asset => {
    if (asset.kind !== 'video') return asset
    const original = asset.compression ? byId.get(asset.compression.originalAssetId) : byId.get(asset.id) ?? byPath.get(videoAssetKey(asset))
    if (!original) return asset
    return byOriginal.get(original.id) ?? bySource.get(videoAssetKey(original)) ?? original
  }
}

export function workingVideoAsset(project: VideoProject, asset: MediaAsset): MediaAsset {
  return videoWorkingCopyResolver(project)(asset)
}

/** Keep recoverable originals and historical copies out of the visible working library. */
export function projectWorkingAssets(project: VideoProject): MediaAsset[] {
  const resolve = videoWorkingCopyResolver(project)
  return [...new Map(project.assets.filter(asset => !asset.compression).map(asset => {
    const current = resolve(asset)
    return [current.id, current] as const
  })).values()]
}
