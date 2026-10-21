import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue'
import type { MediaAsset } from './types'
import { videoAssetKey } from './video-assets'
import { prepareStoredVideoPreview } from '../native'
import { listWorkspaceAssets, openWorkspaceDirectory, type WorkspaceMediaCategory } from '../native-media-library'

const categoryKind: Record<WorkspaceMediaCategory, MediaAsset['kind']> = {
  recording: 'video', screenshot: 'image', videogen: 'video', imagegen: 'image', musicgen: 'audio',
}
const sourceKey = (asset: MediaAsset) => `${asset.nativePath ?? asset.url}:${asset.size}:${asset.addedAt ?? ''}`

/** Shared directories and explicit workspace imports never modify an editing project. */
export function useWorkspaceMedia(categories: () => readonly WorkspaceMediaCategory[], native: () => boolean, localAssets: () => MediaAsset[] = () => []) {
  const stored = shallowRef<MediaAsset[]>([])
  const directories = shallowRef<Partial<Record<WorkspaceMediaCategory, string>>>({})
  const directory = computed(() => categories().map(category => directories.value[category]).find(Boolean) ?? '')
  const loading = ref(false), error = ref(''), warnings = ref<string[]>([]), preparing = ref(false)
  const prepared = shallowRef(new Map<string, { source: string; asset: MediaAsset }>())
  const pendingPreviews = new Map<string, Promise<void>>()
  let active = true, disposed = false, request = 0, previewEpoch = 0, rescan = false
  let scanning: Promise<void> | undefined
  const message = (cause: unknown) => cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '无法读取素材目录，请重试。'
  const assets = computed(() => {
    const kinds = new Set(categories().map(category => categoryKind[category]))
    const combined = new Map<string, MediaAsset>()
    for (const asset of native() ? stored.value : []) if (kinds.has(asset.kind)) combined.set(videoAssetKey(asset), asset)
    for (const asset of localAssets()) {
      if (!kinds.has(asset.kind)) continue
      const key = videoAssetKey(asset), saved = combined.get(key)
      combined.set(key, saved ? { ...saved, ...asset, addedAt: saved.addedAt ?? asset.addedAt } : asset)
    }
    return [...combined.values()].map((asset, index) => ({ asset, index, time: asset.addedAt ? Date.parse(asset.addedAt) || 0 : 0 }))
      .sort((a, b) => b.time - a.time || (a.asset.kind === 'image' && b.asset.kind === 'image' ? a.index - b.index : b.index - a.index))
      .map(({ asset }) => {
        const preview = prepared.value.get(videoAssetKey(asset))
        return preview?.source === sourceKey(asset) ? { ...asset, url: preview.asset.url, sourceUrl: preview.asset.sourceUrl } : asset
      })
  })
  function refresh(): Promise<void> {
    if (!native() || !active || disposed) return Promise.resolve()
    if (scanning) return scanning
    const generation = ++request, wanted = [...categories()]
    loading.value = true; error.value = ''
    scanning = (async () => {
      try {
        const result = await listWorkspaceAssets(wanted)
        if (disposed || !active || generation !== request || !native()) return
        directories.value = result.directories; stored.value = result.assets; warnings.value = result.warnings
        const keys = new Set([...result.assets, ...localAssets()].map(videoAssetKey))
        prepared.value = new Map([...prepared.value].filter(([key]) => keys.has(key)))
      } catch (cause) { if (!disposed && generation === request) error.value = message(cause) }
      finally {
        if (generation === request) {
          loading.value = false; scanning = undefined
          if (rescan) { rescan = false; void refresh() }
        }
      }
    })()
    return scanning
  }
  async function reveal(category = categories()[0]): Promise<void> {
    if (!native() || disposed || !category) return
    try { await openWorkspaceDirectory(category) }
    catch (cause) { if (!disposed) error.value = message(cause) }
  }
  function preparePreview(asset: MediaAsset): Promise<void> {
    if (!native() || !active || disposed || !asset.nativePath || asset.kind !== 'video') return Promise.resolve()
    const key = videoAssetKey(asset), source = sourceKey(asset)
    if (prepared.value.get(key)?.source === source) return Promise.resolve()
    const epoch = previewEpoch, pendingKey = `${epoch}:${key}:${source}`, pending = pendingPreviews.get(pendingKey)
    if (pending) return pending
    preparing.value = true
    const work = (async () => {
      try {
        const result = await prepareStoredVideoPreview(asset)
        if (!disposed && active && native() && epoch === previewEpoch && assets.value.some(item => videoAssetKey(item) === key && sourceKey(item) === source)) prepared.value = new Map(prepared.value).set(key, { source, asset: result })
      } catch (cause) { if (!disposed && active && epoch === previewEpoch) error.value = message(cause) }
      finally { pendingPreviews.delete(pendingKey); if (!disposed) preparing.value = pendingPreviews.size > 0 }
    })()
    pendingPreviews.set(pendingKey, work)
    return work
  }
  function invalidate(): void { request++; previewEpoch++; scanning = undefined; rescan = false; loading.value = false; pendingPreviews.clear(); preparing.value = false }
  function focus(): void { if (active) void refresh() }
  onMounted(() => { window.addEventListener('focus', focus); void refresh() })
  onActivated(() => { active = true; void refresh() })
  onDeactivated(() => { active = false; invalidate() })
  watch(() => `${native()}:${categories().join(',')}`, () => {
    invalidate(); stored.value = []; directories.value = {}; warnings.value = []; prepared.value = new Map()
    if (native()) void refresh()
  })
  watch(() => JSON.stringify(localAssets().map(asset => [asset.id, asset.nativePath, asset.size, asset.addedAt])), () => {
    if (!native() || !active || disposed) return
    if (scanning) rescan = true
    else void refresh()
  })
  onBeforeUnmount(() => { disposed = true; active = false; invalidate(); window.removeEventListener('focus', focus) })
  return { assets, directories, directory, loading, error, warnings, preparing, refresh, reveal, preparePreview }
}
