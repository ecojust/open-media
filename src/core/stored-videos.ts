import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue'
import type { MediaAsset } from './types'
import { mergeStoredVideoAssets, recentVideoAssets, videoAssetKey } from './video-assets'
import { listStoredVideos, openMediaLibraryDirectory, prepareStoredVideoPreview } from '../native'

export function useStoredVideos(projectAssets: () => MediaAsset[], enabled: () => boolean) {
  const stored = shallowRef<MediaAsset[]>([])
  const directory = ref(''), loading = ref(false), error = ref(''), warnings = ref<string[]>([]), preparing = ref(false)
  const prepared = shallowRef(new Map<string, { source: string; asset: MediaAsset }>())
  const pendingPreviews = new Map<string, Promise<void>>()
  let active = true, disposed = false, request = 0, previewEpoch = 0
  let scanning: Promise<void> | undefined
  const message = (cause: unknown) => cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '无法读取录屏保存目录，请重试。'
  const assets = computed(() => {
    const values = enabled() ? mergeStoredVideoAssets(projectAssets(), stored.value) : recentVideoAssets(projectAssets())
    return values.map(asset => {
      const result = prepared.value.get(videoAssetKey(asset))
      return result?.source === previewSource(asset) ? { ...asset, url: result.asset.url, sourceUrl: result.asset.sourceUrl } : asset
    })
  })
  const recordings = computed(() => {
    if (!enabled()) return []
    const keys = new Set(stored.value.map(videoAssetKey))
    return assets.value.filter(asset => keys.has(videoAssetKey(asset)))
  })
  function previewSource(asset: MediaAsset): string { return `${asset.nativePath ?? asset.url}:${asset.size}:${asset.addedAt ?? ''}` }
  function refresh(): Promise<void> {
    if (!enabled() || !active || disposed) return Promise.resolve()
    if (scanning) return scanning
    const generation = ++request
    loading.value = true
    error.value = ''
    scanning = (async () => {
      try {
        const result = await listStoredVideos()
        if (disposed || !active || generation !== request || !enabled()) return
        directory.value = result.directory
        stored.value = result.assets
        warnings.value = result.warnings
        const keys = new Set([...result.assets, ...projectAssets()].map(videoAssetKey))
        prepared.value = new Map([...prepared.value].filter(([key]) => keys.has(key)))
      } catch (cause) { if (!disposed && generation === request) error.value = message(cause) }
      finally { if (generation === request) { loading.value = false; scanning = undefined } }
    })()
    return scanning
  }
  async function reveal(): Promise<void> {
    if (!enabled() || disposed) return
    try { await openMediaLibraryDirectory() }
    catch (cause) { if (!disposed) error.value = message(cause) }
  }
  function preparePreview(asset: MediaAsset): Promise<void> {
    if (!enabled() || !active || disposed || !asset.nativePath) return Promise.resolve()
    const key = videoAssetKey(asset), source = previewSource(asset)
    if (prepared.value.get(key)?.source === source) return Promise.resolve()
    const epoch = previewEpoch, pendingKey = `${epoch}:${key}:${source}`
    const pending = pendingPreviews.get(pendingKey)
    if (pending) return pending
    preparing.value = true
    const work = (async () => {
      try {
        const result = await prepareStoredVideoPreview(asset)
        if (!disposed && active && enabled() && epoch === previewEpoch && assets.value.some(item => videoAssetKey(item) === key && previewSource(item) === source)) prepared.value = new Map(prepared.value).set(key, { source, asset: result })
      } catch (cause) { if (!disposed && active && epoch === previewEpoch) error.value = message(cause) }
      finally { pendingPreviews.delete(pendingKey); if (!disposed) preparing.value = pendingPreviews.size > 0 }
    })()
    pendingPreviews.set(pendingKey, work)
    return work
  }
  function invalidate(): void { request++; previewEpoch++; scanning = undefined; loading.value = false; pendingPreviews.clear(); preparing.value = false }
  function focus(): void { if (active) void refresh() }
  onMounted(() => { window.addEventListener('focus', focus); void refresh() })
  onActivated(() => { active = true; void refresh() })
  onDeactivated(() => { active = false; invalidate() })
  watch(enabled, value => { if (value) void refresh(); else invalidate() })
  onBeforeUnmount(() => { disposed = true; active = false; invalidate(); window.removeEventListener('focus', focus) })
  return { assets, recordings, directory, loading, error, warnings, preparing, refresh, reveal, preparePreview }
}
