<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { zipSync } from 'fflate'
import Icon from './Icon.vue'
import RuntimeCheck from './RuntimeCheck.vue'
import MediaAssetMenu from './MediaAssetMenu.vue'
import VideoLibraryToolbar from './VideoLibraryToolbar.vue'
import EditorDialog from './EditorDialog.vue'
import ImageCropEditor from './ImageCropEditor.vue'
import ImageAnnotationEditor from './ImageAnnotationEditor.vue'
import type { MediaAsset } from '../core/types'
import { videoImportedTime } from '../core/video-assets'
import { useStoredVideos } from '../core/stored-videos'
import { convertImage, convertedImageName, getSupportedImageFormats, imageDefaults, imageDimensions, imageFormatOptions, standardIconSizes, type ImageConvertOptions } from '../core/image-convert'
import { validateImageCrop, type ImageCrop } from '../core/image-crop'
import { cloneImageAnnotations, validateImageAnnotations, type ImageAnnotation } from '../core/image-annotations'
import { copyImageToClipboard, imageClipboardError } from '../core/image-clipboard'
import { downloadBlob } from '../core/media-import'
import { createClip, createProject, createTrack, newId } from '../core/project'
import { browserVideoExportSupported, exportTimelineWebM } from '../core/browser-export'
import { beginMediaJob, cancelMediaJob, getMediaJobs, getRuntimeStatus, saveBytes, type MediaJob } from '../native'

const props = defineProps<{ assets: MediaAsset[]; mode: 'image' | 'video'; native: boolean; focusAssetId?: string }>()
const emit = defineEmits<{ import: [files?: File[]]; status: [message: string]; result: [asset: MediaAsset]; 'busy-change': [busy: boolean, mode: 'image' | 'video'] }>()
interface Result {
  id: string; sourceId: string; mode: 'image' | 'video'; name: string
  state: 'waiting' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number; blob?: Blob; url?: string; path?: string; message?: string; width?: number; height?: number
}
const { assets: storedVideos, directory, loading: libraryLoading, error: libraryError, warnings: libraryWarnings, preparing: previewPreparing, refresh: refreshVideos, reveal: revealVideoDirectory, preparePreview } = useStoredVideos(() => props.assets, () => props.native && props.mode === 'video')
const available = computed(() => props.mode === 'image' ? props.assets.filter(asset => asset.kind === 'image') : storedVideos.value)
const assetMenu = ref<InstanceType<typeof MediaAssetMenu>>()
const selectedIds = ref<string[]>([])
const selected = computed(() => available.value.filter(asset => selectedIds.value.includes(asset.id)))
const activeId = ref('')
const active = computed(() => available.value.find(asset => asset.id === activeId.value) ?? selected.value[0] ?? available.value[0])
watch(() => props.native && props.mode === 'video' ? active.value : undefined, asset => { if (asset) void preparePreview(asset).catch(cause => emit('status', cause instanceof Error ? cause.message : String(cause))) }, { immediate: true })
const busy = ref(false)
const message = ref('')
const copyingImage = ref(false)
const copyMessage = ref('')
const copyFailed = ref(false)
const dragging = ref(false)
const image = reactive<ImageConvertOptions>({ ...imageDefaults })
const supportedFormats = ref(imageFormatOptions.filter(format => format.value !== 'avif'))
const formatDetails = computed(() => imageFormatOptions.find(format => format.value === image.format)!)
const iconSizes = ref<number[]>([...standardIconSizes])
const imageCrops = reactive<Record<string, ImageCrop>>({})
const imageAnnotations = reactive<Record<string, ImageAnnotation[]>>({})
const activeCrop = computed(() => active.value ? imageCrops[active.value.id] : undefined)
const activeAnnotations = computed(() => active.value ? imageAnnotations[active.value.id] ?? [] : [])
const cropOpen = ref(false)
const cropAsset = ref<MediaAsset>()
const cropDraft = ref<ImageCrop>()
const annotationsOpen = ref(false)
const annotationsTool = ref<'text' | 'stroke'>('text')
const annotationsAsset = ref<MediaAsset>()
const annotationsDraft = ref<ImageAnnotation[]>([])
const annotationsError = ref('')
const previewOriginal = ref(false)
const previewConverted = ref(false)
const editedPreview = ref<{ sourceId: string; url: string; width: number; height: number }>()
const previewBusy = ref(false)
const previewError = ref('')
const sizeWidth = ref<number | ''>('')
const sizeHeight = ref<number | ''>('')
const video = reactive({ format: props.native ? 'mp4' : 'webm', resolution: 'source', fps: 30, bitrate: 5000, audioBitrate: 192, sampleRate: 48000, quality: 'balanced' as 'draft' | 'balanced' | 'high', trim: false, trimStart: 0, trimEnd: 0 })
const audioOnly = computed(() => ['mp3', 'wav', 'aac', 'flac'].includes(video.format))
const results = ref<Result[]>([])
const visibleResults = computed(() => results.value.filter(item => item.mode === props.mode))
const completed = computed(() => visibleResults.value.filter(item => item.state === 'done' && item.blob))
const latestImage = computed(() => [...visibleResults.value].reverse().find(item => item.sourceId === active.value?.id && item.state === 'done' && item.url))
const previewResult = computed(() => !previewOriginal.value && previewConverted.value ? latestImage.value : undefined)
const previewImageUrl = computed(() => previewOriginal.value ? active.value?.url : previewResult.value?.url ?? (editedPreview.value?.sourceId === active.value?.id ? editedPreview.value.url : active.value?.url))
const currentProgress = computed(() => {
  const items = visibleResults.value.filter(item => currentBatch.has(item.id))
  return items.length ? items.reduce((sum, item) => sum + (['done', 'error', 'cancelled'].includes(item.state) ? 1 : item.progress), 0) / items.length : 0
})
const codecLabel = computed(() => ({ mp4: 'H.264 / AAC', mov: 'H.264 / AAC', mkv: 'H.264 / AAC', webm: props.native ? 'VP9 / Opus' : 'VP9 或 VP8 · Opus', mp3: 'MP3', wav: 'PCM', aac: 'AAC', flac: 'FLAC' }[video.format]))
let abort: AbortController | null = null
let copyAbort: AbortController | null = null
let previewAbort: AbortController | undefined
let previewTimer: ReturnType<typeof setTimeout> | undefined
let deactivated = false
let nativeJobId: string | null = null
let currentBatch = new Set<string>()
let destroyed = false
let knownAssetIds = new Set<string>()
let videoSelectionInitialized = false
let focusedAssetId = ''
const outputAssetIds = new Set<string>()
const resultPreviewUrls = new Set<string>()
watch(busy, value => emit('busy-change', value, props.mode), { flush: 'sync' })
watch(activeId, () => { previewOriginal.value = false; previewConverted.value = false })
watch(() => props.mode, () => { cropOpen.value = false; annotationsOpen.value = false })
watch([() => active.value?.id, () => props.mode], cancelImageCopy)
watch(() => [props.mode, active.value?.id, active.value?.url, { ...image }, sizeWidth.value, sizeHeight.value, [...iconSizes.value], activeCrop.value, activeAnnotations.value], scheduleEditedPreview, { deep: true, immediate: true })
onDeactivated(() => { deactivated = true; cancelImageCopy(); stopPreview(); cropOpen.value = false; annotationsOpen.value = false })
onActivated(() => { deactivated = false; scheduleEditedPreview() })
onMounted(async () => {
  const formats = await getSupportedImageFormats()
  if (!destroyed) supportedFormats.value = imageFormatOptions.filter(format => formats.includes(format.value))
})

watch(available, assets => {
  const ids = new Set(assets.map(asset => asset.id))
  selectedIds.value = selectedIds.value.filter(id => ids.has(id))
  const importedIds = new Set(props.assets.map(asset => asset.id))
  for (const asset of assets) if (!knownAssetIds.has(asset.id) && !outputAssetIds.has(asset.id) && !(busy.value && props.focusAssetId === asset.id) && (props.mode === 'image' || importedIds.has(asset.id))) selectedIds.value.push(asset.id)
  if (props.mode === 'video' && !videoSelectionInitialized && assets.length) {
    if (!selectedIds.value.length) selectedIds.value = [assets[0]!.id]
    videoSelectionInitialized = true
  }
  knownAssetIds = ids
  if (!ids.has(activeId.value)) activeId.value = assets[0]?.id ?? ''
  for (const id of Object.keys(imageCrops)) if (!ids.has(id)) delete imageCrops[id]
  for (const id of Object.keys(imageAnnotations)) if (!ids.has(id)) delete imageAnnotations[id]
  if (cropAsset.value && !ids.has(cropAsset.value.id)) cropOpen.value = false
  if (annotationsAsset.value && !ids.has(annotationsAsset.value.id)) annotationsOpen.value = false
}, { immediate: true })

watch([() => props.focusAssetId, available, busy], ([id, assets, processing]) => {
  if (!id) { focusedAssetId = ''; return }
  if (processing || id === focusedAssetId || !assets.some(asset => asset.id === id)) return
  selectedIds.value = [id]
  activeId.value = id
  message.value = ''
  focusedAssetId = id
}, { immediate: true })

function toggle(id: string) {
  if (busy.value) return
  selectedIds.value = selectedIds.value.includes(id) ? selectedIds.value.filter(value => value !== id) : [...selectedIds.value, id]
  activeId.value = id
}
function selectSource(id: string): void { if (!busy.value) activeId.value = id }
function selectAll() { selectedIds.value = selected.value.length === available.value.length ? [] : available.value.map(asset => asset.id) }
function imageSettings(asset: MediaAsset): ImageConvertOptions {
  return { ...image, iconSizes: [...iconSizes.value], width: sizeWidth.value === '' ? undefined : Number(sizeWidth.value), height: sizeHeight.value === '' ? undefined : Number(sizeHeight.value), crop: imageCrops[asset.id] ? { ...imageCrops[asset.id]! } : undefined, annotations: cloneImageAnnotations(imageAnnotations[asset.id] ?? []) }
}
function stopPreview() { clearTimeout(previewTimer); previewAbort?.abort(); previewAbort = undefined; previewBusy.value = false }
function clearPreviewUrl() { if (editedPreview.value) URL.revokeObjectURL(editedPreview.value.url); editedPreview.value = undefined }
function scheduleEditedPreview() {
  stopPreview()
  previewOriginal.value = false
  previewConverted.value = false
  previewError.value = ''
  if (editedPreview.value?.sourceId !== active.value?.id) clearPreviewUrl()
  if (destroyed || deactivated || props.mode !== 'image' || active.value?.kind !== 'image') return
  const asset = active.value
  const settings = imageSettings(asset)
  const controller = new AbortController()
  previewAbort = controller
  previewBusy.value = true
  previewTimer = setTimeout(async () => {
    try {
      const crop = validateImageCrop(settings.crop, asset.width, asset.height)
      const iconSize = settings.format === 'ico' ? Math.max(...(settings.iconSizes?.length ? settings.iconSizes : [256])) : undefined
      const dimensions = imageDimensions(crop.width, crop.height, iconSize ? { ...settings, width: iconSize, height: iconSize, keepAspect: true } : settings)
      const ratio = Math.min(1, 1600 / Math.max(dimensions.width, dimensions.height))
      const previewSettings: ImageConvertOptions = settings.format === 'ico' ? settings : {
        ...settings, format: 'png', quality: 1,
        width: Math.max(1, Math.round(dimensions.drawWidth * ratio)), height: Math.max(1, Math.round(dimensions.drawHeight * ratio)),
        keepAspect: false, allowUpscale: true,
        transparent: settings.transparent && imageFormatOptions.find(format => format.value === settings.format)!.supportsTransparency,
      }
      const result = await convertImage(asset.url, previewSettings, controller.signal)
      if (destroyed || deactivated || controller.signal.aborted) return
      clearPreviewUrl()
      editedPreview.value = { sourceId: asset.id, url: URL.createObjectURL(result.previewBlob ?? result.blob), width: settings.format === 'ico' ? result.width : dimensions.width, height: settings.format === 'ico' ? result.height : dimensions.height }
    } catch (cause) {
      if (!destroyed && !deactivated && !controller.signal.aborted) { clearPreviewUrl(); previewError.value = cause instanceof Error ? cause.message : String(cause) }
    } finally {
      if (!destroyed && previewAbort === controller) { previewAbort = undefined; previewBusy.value = false }
    }
  }, 80)
}
function openAnnotations(tool: 'text' | 'stroke') {
  if (busy.value || active.value?.kind !== 'image') return
  annotationsAsset.value = active.value
  annotationsTool.value = tool
  annotationsError.value = ''
  annotationsDraft.value = cloneImageAnnotations(imageAnnotations[active.value.id] ?? [])
  annotationsOpen.value = true
}
function applyAnnotations() {
  const asset = annotationsAsset.value
  if (!asset || busy.value || !available.value.some(item => item.id === asset.id)) return
  try {
    imageAnnotations[asset.id] = validateImageAnnotations(annotationsDraft.value)
    annotationsOpen.value = false
    previewOriginal.value = false
    previewConverted.value = false
    message.value = ''
  } catch (cause) { annotationsError.value = cause instanceof Error ? cause.message : String(cause) }
}
function openCrop() {
  if (busy.value || active.value?.kind !== 'image') return
  cropAsset.value = active.value
  cropDraft.value = activeCrop.value ? { ...activeCrop.value } : undefined
  cropOpen.value = true
}
function applyCrop() {
  const asset = cropAsset.value
  if (!asset || busy.value) return
  if (cropDraft.value) imageCrops[asset.id] = validateImageCrop(cropDraft.value, asset.width, asset.height)
  else delete imageCrops[asset.id]
  if (active.value?.id === asset.id) { previewOriginal.value = false; previewConverted.value = false }
  cropOpen.value = false
}
function clearCrop() {
  if (busy.value || !active.value) return
  delete imageCrops[active.value.id]
  previewOriginal.value = false
  previewConverted.value = false
}
function cancelImageCopy() {
  copyAbort?.abort()
  copyAbort = null
  if (!destroyed) {
    copyingImage.value = false
    copyMessage.value = ''
    copyFailed.value = false
  }
}
async function copyCurrentImage() {
  const asset = active.value
  if (destroyed || busy.value || copyingImage.value || props.mode !== 'image' || asset?.kind !== 'image') return
  const controller = new AbortController()
  copyAbort = controller
  copyingImage.value = true
  copyMessage.value = ''
  copyFailed.value = false
  const settings = imageSettings(asset)
  try {
    const content = convertImage(asset.url, settings, controller.signal).then(result => result.previewBlob ?? result.blob)
    await copyImageToClipboard(content, props.native, controller.signal)
    if (!destroyed && !controller.signal.aborted) copyMessage.value = '图片已复制'
  } catch (error) {
    if (!destroyed && !controller.signal.aborted) {
      copyFailed.value = true
      copyMessage.value = imageClipboardError(error)
    }
  } finally {
    if (!destroyed && copyAbort === controller) {
      copyAbort = null
      copyingImage.value = false
    }
  }
}
function fileSize(size: number) { return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB` }
function duration(seconds: number) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` }
function resultState(item: Result) { return { waiting: '等待转换', running: `转换中 ${Math.round(item.progress * 100)}%`, done: '已完成', error: '转换失败', cancelled: '已取消' }[item.state] }
function drop(event: DragEvent) {
  dragging.value = false
  if (!busy.value && event.dataTransfer?.files.length) emit('import', [...event.dataTransfer.files])
}
function publishResult(item: Result, blob: Blob, source: MediaAsset, dimensions: { width: number; height: number; duration?: number; previewBlob?: Blob }) {
  item.blob = blob
  item.width = dimensions.width
  item.height = dimensions.height
  item.sourceId = source.id
  const downloadOnly = blob.type === 'image/tiff' || blob.type === 'image/x-icon'
  if (!downloadOnly) {
    const asset: MediaAsset = { id: newId('asset'), name: item.name, kind: item.mode === 'image' ? 'image' : 'video', url: URL.createObjectURL(blob), mime: blob.type, size: blob.size, width: dimensions.width, height: dimensions.height, duration: dimensions.duration ?? 0 }
    outputAssetIds.add(asset.id)
    item.url = asset.url
    emit('result', asset)
  }
  if (dimensions.previewBlob) {
    item.url = URL.createObjectURL(dimensions.previewBlob)
    resultPreviewUrls.add(item.url)
  }
  if (downloadOnly) item.message = '已生成，可下载或打包保存；此格式保留在转换队列中。'
  if (source.id === active.value?.id) { previewOriginal.value = false; previewConverted.value = false }
}
function videoDimensions(asset: MediaAsset) {
  const targetHeight = video.resolution === 'source' ? asset.height : Number(video.resolution)
  const ratio = Math.min(1, targetHeight / Math.max(1, asset.height))
  return { width: Math.max(16, Math.floor(asset.width * ratio / 2) * 2), height: Math.max(16, Math.floor(asset.height * ratio / 2) * 2) }
}
function videoRange(asset: MediaAsset) {
  const start = video.trim ? Number(video.trimStart) : 0
  const end = video.trim && Number(video.trimEnd) > 0 ? Number(video.trimEnd) : asset.duration
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end || end > asset.duration + 0.01) throw new Error(`「${asset.name}」的截取范围无效；总时长为 ${asset.duration.toFixed(2)} 秒。`)
  return { start, end }
}
async function waitJob(id: string, item: Result, signal: AbortSignal): Promise<MediaJob> {
  while (true) {
    signal.throwIfAborted()
    const job = (await getMediaJobs()).find(value => value.id === id)
    if (!job) throw new Error('转换任务已丢失，请重新转换。')
    item.progress = Math.max(0, Math.min(1, job.progress))
    if (job.state !== 'running') return job
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, 450)
      signal.addEventListener('abort', stop, { once: true })
    })
  }
}
async function convertVideo(asset: MediaAsset, item: Result, signal: AbortSignal) {
  if (asset.kind === 'audio' && !audioOnly.value) throw new Error('纯音频素材请选择音频输出格式。')
  if (!audioOnly.value && (!Number.isFinite(Number(video.bitrate)) || Number(video.bitrate) < 100 || Number(video.bitrate) > 100000)) throw new Error('视频码率须在 100 至 100000 kbps 之间。')
  const range = videoRange(asset)
  const dimensions = videoDimensions(asset)
  if (props.native) {
    const job = await beginMediaJob({ kind: 'convert', asset, format: video.format, ...(!audioOnly.value ? dimensions : {}), fps: Number(video.fps), quality: video.quality, audioOnly: audioOnly.value, sampleRate: Number(video.sampleRate), videoBitrate: Number(video.bitrate), audioBitrate: Number(video.audioBitrate), trimStart: range.start, trimEnd: range.end })
    if (!job) { item.state = 'cancelled'; item.message = '已取消选择保存位置'; return }
    nativeJobId = job.id
    if (signal.aborted) { await cancelMediaJob(job.id); signal.throwIfAborted() }
    const final = await waitJob(job.id, item, signal)
    nativeJobId = null
    if (final.state === 'cancelled') { item.state = 'cancelled'; return }
    if (final.state !== 'completed') throw new Error(final.error || '媒体编码失败。')
    item.path = final.outputPath
    item.state = 'done'
    item.progress = 1
    return
  }
  if (video.format !== 'webm') throw new Error('这个输出格式需要桌面端。网页端请选择 WebM。')
  if (asset.kind !== 'video') throw new Error('网页端暂不支持纯音频格式转换，请使用桌面端。')
  if (!browserVideoExportSupported()) throw new Error('当前环境不支持视频编码，请使用桌面端。')
  const project = createProject(asset.name, { ...dimensions, fps: Number(video.fps), background: '#000000' })
  project.assets = [asset]
  const track = createTrack('video')
  track.clips = [createClip(asset, project, { trimIn: range.start, trimOut: range.end })]
  project.tracks = [track]
  const blob = await exportTimelineWebM(project, { ...dimensions, fps: Number(video.fps), videoBitsPerSecond: Number(video.bitrate) * 1000, signal, onProgress: progress => { item.progress = progress } })
  signal.throwIfAborted()
  publishResult(item, blob, asset, { ...dimensions, duration: range.end - range.start })
  item.state = 'done'
  item.progress = 1
}
async function run() {
  if (busy.value || !selected.value.length) return
  message.value = ''
  const batchMode = props.mode
  const batch = selected.value.map(asset => ({ asset, result: { id: newId('result'), sourceId: asset.id, mode: props.mode, name: props.mode === 'image' ? convertedImageName(asset.name, image.format) : `${asset.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || '媒体'}.${video.format}`, state: 'waiting', progress: 0 } as Result }))
  busy.value = true
  abort = new AbortController()
  const signal = abort.signal
  currentBatch = new Set(batch.map(item => item.result.id))
  results.value.push(...batch.map(item => item.result))
  const settings: ImageConvertOptions = { ...image, iconSizes: [...iconSizes.value], width: sizeWidth.value === '' ? undefined : Number(sizeWidth.value), height: sizeHeight.value === '' ? undefined : Number(sizeHeight.value) }
  const crops = new Map(batch.map(({ asset }) => [asset.id, imageCrops[asset.id] ? { ...imageCrops[asset.id] } : undefined]))
  const annotations = new Map(batch.map(({ asset }) => [asset.id, cloneImageAnnotations(imageAnnotations[asset.id] ?? [])]))
  try {
    if (batchMode === 'video' && props.native) {
      const runtime = await getRuntimeStatus()
      if (!runtime.ready) throw new Error(runtime.error || '请在下方「媒体处理检查」中选择本机编码工具。')
    }
    for (const entry of batch) {
      const item = results.value.find(value => value.id === entry.result.id)!
      if (signal.aborted) { item.state = 'cancelled'; continue }
      item.state = 'running'
      try {
        if (batchMode === 'image') {
          const converted = await convertImage(entry.asset.url, { ...settings, crop: crops.get(entry.asset.id), annotations: annotations.get(entry.asset.id) }, signal)
          if (destroyed) return
          publishResult(item, converted.blob, entry.asset, converted)
          item.state = 'done'
          item.progress = 1
        } else await convertVideo(entry.asset, item, signal)
      } catch (error) {
        item.state = signal.aborted ? 'cancelled' : 'error'
        item.message = signal.aborted ? '用户已取消' : error instanceof Error ? error.message : String(error)
      }
    }
    const count = results.value.filter(item => currentBatch.has(item.id) && item.state === 'done').length
    message.value = signal.aborted ? `已取消，保留 ${count} 个已完成结果。` : `已完成 ${count} / ${batch.length} 个转换。`
    emit('status', message.value)
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
    for (const item of results.value) if (currentBatch.has(item.id) && item.state === 'waiting') { item.state = 'error'; item.message = message.value }
  } finally {
    busy.value = false
    abort = null
    nativeJobId = null
  }
}
async function cancel() {
  abort?.abort()
  if (nativeJobId) {
    try { await cancelMediaJob(nativeJobId) } catch (error) { message.value = error instanceof Error ? error.message : String(error) }
  }
}
async function downloadAll() {
  try {
    const entries: Record<string, Uint8Array> = {}
    for (const item of completed.value) {
      let name = item.name
      let index = 2
      while (entries[name]) name = item.name.replace(/(\.[^.]+)$/, ` (${index++})$1`)
      entries[name] = new Uint8Array(await item.blob!.arrayBuffer())
    }
    await saveOutput(new Blob([zipSync(entries, { level: 0 })]), `${props.mode === 'image' ? '图片' : '视频'}转换结果.zip`)
  } catch (error) { message.value = `打包失败：${error instanceof Error ? error.message : String(error)}` }
}
async function saveOutput(blob: Blob, name: string) {
  try {
    if (props.native) {
      const path = await saveBytes(name, new Uint8Array(await blob.arrayBuffer()))
      if (path) { message.value = `已保存：${path}`; emit('status', `已保存 ${name}`) }
    } else downloadBlob(blob, name)
  } catch (error) { message.value = `保存失败：${error instanceof Error ? error.message : String(error)}` }
}
function beforeUnload(event: BeforeUnloadEvent) { if (busy.value) { event.preventDefault(); event.returnValue = '' } }
window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => { destroyed = true; cancelImageCopy(); stopPreview(); clearPreviewUrl(); void cancel(); emit('busy-change', false, props.mode); window.removeEventListener('beforeunload', beforeUnload); for (const url of resultPreviewUrls) URL.revokeObjectURL(url) })
</script>

<template>
  <section class="convert-workspace" :class="{ 'is-dragging': dragging }" data-testid="convert-workspace" @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="drop">
    <header class="convert-toolbar">
      <div><h1>{{ mode === 'image' ? '图片编辑' : '视频转换' }}</h1><p>{{ mode === 'image' ? '文字标注、自由绘制、裁剪与格式导出' : '转换格式、压缩画质或提取音频' }}</p></div>
      <button class="convert-button" :disabled="busy" @click="emit('import')"><Icon name="upload" />导入{{ mode === 'image' ? '图片' : '视频' }}</button>
    </header>
    <div class="convert-layout">
      <aside class="convert-sources" aria-label="待转换素材">
        <div class="convert-section-title"><h2>{{ mode === 'image' ? '素材' : '视频' }} <span>{{ available.length }}</span></h2><button :disabled="busy || !available.length" @click="selectAll">{{ selected.length === available.length && available.length ? '取消全选' : '全选' }}</button></div>
        <VideoLibraryToolbar v-if="native && mode === 'video'" :directory="directory" :loading="libraryLoading" :preparing="previewPreparing" :error="libraryError" :warnings="libraryWarnings" :disabled="busy" @refresh="refreshVideos" @reveal="revealVideoDirectory" />
        <div v-if="!available.length" class="convert-empty"><Icon :name="mode === 'image' ? 'image' : 'video'" :size="36" /><p>拖入文件开始转换</p><button class="convert-button" @click="emit('import')">选择文件</button></div>
        <div v-for="asset in available" :key="asset.id" class="convert-source" :class="{ active: active?.id === asset.id }" :data-source-asset-id="asset.id" @click="selectSource(asset.id)" @contextmenu="mode === 'video' && assetMenu?.open($event, asset)">
          <input type="checkbox" :checked="selectedIds.includes(asset.id)" :aria-label="`选择 ${asset.name}`" :disabled="busy" @click.stop @change="toggle(asset.id)">
          <img v-if="asset.kind === 'image'" :src="asset.url" alt="" loading="lazy"><span v-else class="source-icon"><Icon :name="asset.kind === 'audio' ? 'audio' : 'video'" /></span>
          <button class="source-details" :title="asset.name" :disabled="busy" @click="selectSource(asset.id)" @keydown.shift.f10="mode === 'video' && assetMenu?.open($event, asset)" @keydown.context-menu="mode === 'video' && assetMenu?.open($event, asset)"><strong>{{ asset.name }}</strong><small>{{ asset.kind === 'image' ? `${asset.width} × ${asset.height}` : duration(asset.duration) }} · {{ fileSize(asset.size) }}</small><time v-if="mode === 'video'" class="source-imported-time" :datetime="asset.addedAt" :title="`视频时间：${videoImportedTime(asset)}`">{{ videoImportedTime(asset) }}</time><small v-if="imageCrops[asset.id]" class="source-cropped">已框选 {{ imageCrops[asset.id]!.width }} × {{ imageCrops[asset.id]!.height }}</small></button>
        </div>
        <p v-if="available.length" class="source-selection">已选 {{ selected.length }} 项</p>
      </aside>
      <main class="convert-preview">
        <div class="preview-heading"><span>{{ mode === 'image' ? '图片预览' : '原始媒体' }}</span><span v-if="active">{{ active.name }}</span></div>
        <div v-if="mode === 'image' && active" class="image-preview-tools">
          <button :disabled="busy" data-testid="image-crop-open" @click="openCrop"><Icon name="crop" :size="14" />框选裁剪</button>
          <button :disabled="busy" data-testid="image-add-text" @click="openAnnotations('text')"><Icon name="text" :size="14" />插入文字</button>
          <button :disabled="busy" data-testid="image-add-stroke" @click="openAnnotations('stroke')"><Icon name="pen" :size="14" />自定义笔触</button>
          <button :disabled="busy || copyingImage || (image.format === 'ico' && !iconSizes.length)" :aria-busy="copyingImage" title="复制当前图片，包含文字、笔触、裁剪与方向设置" data-testid="image-copy" @click="copyCurrentImage"><Icon :name="copyingImage ? 'clock' : 'copy'" :size="14" />复制图片</button>
          <button v-if="activeCrop" :disabled="busy" data-testid="image-crop-clear" @click="clearCrop">清除裁剪</button>
          <span v-if="copyMessage" class="image-copy-feedback" :class="{ 'copy-error': copyFailed }" role="status" data-testid="image-copy-status">{{ copyMessage }}</span>
          <button class="preview-switch" :aria-pressed="previewOriginal" data-testid="image-preview-original" @click="previewOriginal = !previewOriginal; previewConverted = false">{{ previewOriginal ? '返回编辑预览' : '查看原图' }}</button>
          <button v-if="latestImage" :aria-pressed="previewConverted" data-testid="image-preview-result" @click="previewConverted = !previewConverted; previewOriginal = false">{{ previewConverted ? '返回编辑预览' : '查看导出结果' }}</button>
        </div>
        <div class="preview-stage" :class="{ checkerboard: mode === 'image' }">
          <template v-if="active">
            <img v-if="active.kind === 'image'" :src="previewImageUrl" :alt="active.name" data-testid="convert-image-preview">
            <video v-else-if="active.kind === 'video'" :key="active.id" :src="active.url" controls playsinline preload="metadata" />
            <div v-else class="audio-preview"><Icon name="audio" :size="52" /><audio :src="active.url" controls preload="metadata" /></div>
          </template>
          <div v-else class="preview-placeholder"><Icon :name="mode === 'image' ? 'image' : 'video'" :size="52" /><p>选择素材预览</p></div>
        </div>
        <div class="preview-caption" data-testid="image-preview-caption"><template v-if="mode === 'image' && active"><span v-if="previewOriginal">原图 · {{ active.width }} × {{ active.height }}</span><span v-else-if="previewResult">导出结果 · {{ previewResult.width }} × {{ previewResult.height }} · {{ previewResult.name }}</span><span v-else-if="previewBusy" role="status">正在更新编辑预览…</span><span v-else-if="previewError" role="alert">{{ previewError }}</span><span v-else-if="editedPreview">编辑预览 · {{ editedPreview.width }} × {{ editedPreview.height }}<template v-if="activeAnnotations.length"> · {{ activeAnnotations.length }} 个标注</template></span><span v-else>原始文件始终保留</span></template><span v-else>原始文件始终保留</span></div>
        <section class="convert-results" aria-label="转换结果">
          <div class="convert-section-title"><h2>{{ mode === 'image' ? '导出结果' : '转换队列' }} <span>{{ visibleResults.length }}</span></h2><button v-if="completed.length" data-testid="convert-download-all" @click="downloadAll"><Icon name="download" />打包下载</button></div>
          <div v-if="!visibleResults.length" class="results-empty">{{ mode === 'image' ? '编辑完成后，点击「导出图片」' : '选择格式后，点击「开始转换」' }}</div>
          <article v-for="item in visibleResults" :key="item.id" class="convert-result" :class="item.state" data-testid="convert-result">
            <Icon :name="item.state === 'done' ? 'check' : item.state === 'error' ? 'alert' : mode === 'image' ? 'image' : 'video'" />
            <div class="result-description"><strong>{{ item.name }}</strong><span>{{ resultState(item) }}<template v-if="item.blob"> · {{ fileSize(item.blob.size) }}</template></span><small v-if="item.message">{{ item.message }}</small><small v-if="item.path" :title="item.path">已保存：{{ item.path }}</small><progress v-if="item.state === 'running'" :value="item.progress" max="1" :aria-label="`${item.name} 转换进度`" /></div>
            <button v-if="item.blob" class="result-download" :aria-label="`下载 ${item.name}`" @click="saveOutput(item.blob!, item.name)"><Icon name="download" /></button>
          </article>
        </section>
      </main>
      <aside class="convert-settings" aria-label="转换设置">
        <h2>输出设置</h2>
        <fieldset :disabled="busy">
          <template v-if="mode === 'image'">
            <label>输出格式<select v-model="image.format" data-testid="convert-format"><option v-for="format in supportedFormats" :key="format.value" :value="format.value">{{ format.label }}</option></select></label>
            <p class="setting-help">{{ formatDetails.description }}</p>
            <label v-if="formatDetails.supportsQuality">图片质量 <span>{{ Math.round(image.quality * 100) }}%</span><input v-model.number="image.quality" type="range" min="0.1" max="1" step="0.01" aria-label="图片质量"></label>
            <div v-if="image.format === 'ico'" class="icon-options">
              <h3>图标尺寸 · px</h3>
              <div class="icon-size-grid"><label v-for="size in standardIconSizes" :key="size" class="check-label"><input v-model="iconSizes" type="checkbox" :value="size" :aria-label="`图标 ${size} 像素`">{{ size }} × {{ size }}</label></div>
              <p class="setting-help">一个 ICO 文件包含所选全部尺寸，保持图片比例并居中显示。</p>
              <p v-if="!iconSizes.length" class="error-message" role="alert">请至少选择一种图标尺寸。</p>
            </div>
            <div class="settings-divider" />
            <h3>尺寸与方向</h3>
            <div v-if="image.format !== 'ico'" class="settings-pair"><label>宽度<input v-model="sizeWidth" type="number" min="1" max="16384" placeholder="裁剪后原始宽度" data-testid="convert-width"></label><label>高度<input v-model="sizeHeight" type="number" min="1" max="16384" placeholder="裁剪后原始高度" data-testid="convert-height"></label></div>
            <label v-if="image.format !== 'ico'" class="check-label"><input v-model="image.keepAspect" type="checkbox">保持原始比例</label><p v-if="image.keepAspect && image.format !== 'ico'" class="setting-help">先按每张图片的框选范围裁剪，再等比缩放到所填宽高内。</p>
            <label class="check-label"><input v-model="image.allowUpscale" type="checkbox">允许放大小图</label>
            <label>旋转<select v-model.number="image.rotation" aria-label="图片旋转"><option :value="0">不旋转</option><option :value="90">顺时针 90°</option><option :value="180">旋转 180°</option><option :value="270">逆时针 90°</option></select></label>
            <div class="settings-pair"><label class="check-label"><input v-model="image.flipX" type="checkbox">水平翻转</label><label class="check-label"><input v-model="image.flipY" type="checkbox">垂直翻转</label></div>
            <div class="settings-divider" />
            <h3>背景</h3>
            <label v-if="formatDetails.supportsTransparency" class="check-label"><input v-model="image.transparent" type="checkbox">保留透明背景</label>
            <label v-if="!image.transparent || !formatDetails.supportsTransparency" class="color-label">背景颜色<input v-model="image.background" type="color" aria-label="图片背景颜色"></label>
            <p v-if="!formatDetails.supportsTransparency" class="setting-help">此格式不支持透明，将使用背景颜色填充。</p>
            <p class="setting-help">动态图片转换为静态图片。</p>
          </template>
          <template v-else>
            <label>输出格式<select v-model="video.format" data-testid="convert-format"><optgroup label="视频"><option value="mp4">MP4</option><option value="webm">WebM</option><option value="mov">MOV</option><option value="mkv">MKV</option></optgroup><optgroup label="提取音频"><option value="mp3">MP3</option><option value="wav">WAV</option><option value="aac">AAC</option><option value="flac">FLAC</option></optgroup></select></label>
            <p class="setting-help">编码：{{ codecLabel }}</p>
            <template v-if="!audioOnly">
              <label>分辨率<select v-model="video.resolution"><option value="source">原始尺寸</option><option value="2160">最高 2160p</option><option value="1440">最高 1440p</option><option value="1080">最高 1080p</option><option value="720">最高 720p</option><option value="480">最高 480p</option></select></label>
              <div class="settings-pair"><label>帧率<select v-model.number="video.fps"><option :value="24">24 fps</option><option :value="25">25 fps</option><option :value="30">30 fps</option><option :value="50">50 fps</option><option :value="60">60 fps</option></select></label><label>码率 · kbps<input v-model.number="video.bitrate" type="number" min="100" max="100000"></label></div>
              <label v-if="native">编码质量<select v-model="video.quality"><option value="draft">快速</option><option value="balanced">均衡</option><option value="high">高质量</option></select></label>
            </template>
            <div v-if="native" class="settings-pair"><label>音频 · kbps<select v-model.number="video.audioBitrate"><option :value="96">96</option><option :value="128">128</option><option :value="192">192</option><option :value="256">256</option><option :value="320">320</option></select></label><label>采样率<select v-model.number="video.sampleRate"><option :value="44100">44.1 kHz</option><option :value="48000">48 kHz</option></select></label></div>
            <div class="settings-divider" />
            <label class="check-label"><input v-model="video.trim" type="checkbox">截取指定时间段</label>
            <div v-if="video.trim" class="settings-pair"><label>起点 · 秒<input v-model.number="video.trimStart" type="number" min="0" step="0.1"></label><label>终点 · 秒<input v-model.number="video.trimEnd" type="number" min="0" step="0.1"></label></div>
            <p v-if="video.trim" class="setting-help">终点为 0 时截取到结尾；该范围应用于所有选中素材。</p>
            <p v-if="native" class="setting-help">转换前会逐个选择保存位置，原始文件不会被覆盖。</p>
            <p v-else class="setting-help browser-notice">网页端支持 WebM 实时转换，请保持窗口在前台，耗时接近片段时长。其他格式及音频提取由桌面端提供。</p>
            <RuntimeCheck v-if="native" :disabled="busy" />
          </template>
        </fieldset>
        <div class="convert-actions">
          <progress v-if="busy" :value="currentProgress" max="1" aria-label="批量转换进度" />
          <button v-if="busy" class="convert-button cancel-button" data-testid="convert-cancel" @click="cancel"><Icon name="stop" />取消转换</button>
          <button v-else class="convert-button primary" :disabled="!selected.length || (mode === 'image' && image.format === 'ico' && !iconSizes.length)" data-testid="convert-start" @click="run"><Icon :name="mode === 'image' ? 'export' : 'convert'" />{{ mode === 'image' ? '导出图片' : '开始转换' }} <span v-if="selected.length">{{ selected.length }} 项</span></button>
          <p v-if="mode === 'image'" class="setting-help export-edit-help">导出后将兼容图片加入素材库，原图保持不变。</p>
          <p v-if="message" class="conversion-message" role="status">{{ message }}</p>
        </div>
      </aside>
    </div>
    <EditorDialog :open="cropOpen" title="框选裁剪" icon="crop" class="image-crop-dialog" wide @close="cropOpen = false">
      <template v-if="cropOpen && cropAsset">
        <p class="crop-source-name">{{ cropAsset.name }} · {{ cropAsset.width }} × {{ cropAsset.height }} px</p>
        <ImageCropEditor :key="cropAsset.id" v-model="cropDraft" :source="cropAsset.url" :width="cropAsset.width" :height="cropAsset.height" />
        <p class="crop-scope-note">裁剪范围仅应用于这张图片。按原始像素选择，转换时再应用尺寸和方向设置。</p>
      </template>
      <template #footer><button @click="cropOpen = false">取消</button><button class="primary" data-testid="image-crop-apply" @click="applyCrop">应用裁剪</button></template>
    </EditorDialog>
    <EditorDialog :open="annotationsOpen" :title="annotationsTool === 'text' ? '插入文字' : '自定义笔触'" :icon="annotationsTool === 'text' ? 'text' : 'pen'" class="image-annotations-dialog" wide @close="annotationsOpen = false">
      <ImageAnnotationEditor v-if="annotationsOpen && annotationsAsset" :key="annotationsAsset.id" v-model="annotationsDraft" :source="annotationsAsset.url" :width="annotationsAsset.width" :height="annotationsAsset.height" :crop="imageCrops[annotationsAsset.id]" :initial-tool="annotationsTool" />
      <p v-if="annotationsError" class="annotation-apply-error" role="alert">{{ annotationsError }}</p>
      <template #footer><button @click="annotationsOpen = false">取消</button><button class="primary" data-testid="image-annotations-apply" @click="applyAnnotations">应用编辑</button></template>
    </EditorDialog>
    <MediaAssetMenu ref="assetMenu" :native="native" @error="message = $event" />
  </section>
</template>

<style scoped>
.convert-sources>.video-library-toolbar{margin:0 5px 10px}@media(max-width:800px){.convert-sources:has(>.video-library-toolbar){min-height:106px;max-height:106px}.convert-sources>.video-library-toolbar{flex:0 0 205px;margin:0;max-height:85px;overflow:auto}}
.source-imported-time{font-size:9px;white-space:nowrap;color:var(--ui-muted,#959aad);font-variant-numeric:tabular-nums}.source-details:disabled{cursor:not-allowed}
.convert-workspace{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--ui-text,#e5e7ef);background:var(--ui-bg,#11131b)}
.convert-toolbar{display:flex;align-items:center;gap:16px;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--ui-line,#2a2d3a)}
.convert-toolbar h1{font-size:18px;margin:0 0 5px;font-weight:650}.convert-toolbar p{font-size:12px;margin:0;color:var(--ui-muted,#959aad)}
.convert-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:9px 13px;border:1px solid var(--ui-line,#34384a);border-radius:8px;background:var(--ui-panel,#1b1e2a);color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}.convert-button.primary{background:var(--ui-accent,#8b74ed);border-color:var(--ui-accent,#8b74ed);color:#fff;font-weight:600}.convert-button:disabled,button:disabled{opacity:.45;cursor:not-allowed}.convert-button:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--ui-accent,#8b74ed);outline-offset:3px}
.convert-layout{display:grid;grid-template-columns:220px minmax(220px,1fr) 268px;flex:1;min-height:0;overflow:hidden}.convert-sources{border-right:1px solid var(--ui-line,#2a2d3a);padding:16px 10px;overflow:auto}.convert-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 4px 14px}.convert-section-title h2,.convert-settings h2{font-size:12px;line-height:1.5;font-weight:650;margin:0}.convert-section-title h2 span{font-size:11px;color:var(--ui-muted,#959aad);margin-left:5px}.convert-section-title>button{display:flex;align-items:center;gap:5px;border:0;background:none;color:var(--ui-muted,#959aad);font-size:11px;cursor:pointer;padding:2px}.convert-source{display:flex;align-items:center;gap:9px;padding:9px 7px;margin-bottom:4px;border:1px solid transparent;border-radius:8px;cursor:pointer}.convert-source.active{background:color-mix(in srgb,var(--ui-accent,#8b74ed) 10%,transparent);border-color:color-mix(in srgb,var(--ui-accent,#8b74ed) 35%,transparent)}.convert-source>input{width:13px;height:13px;accent-color:var(--ui-accent,#8b74ed);flex-shrink:0}.convert-source>img,.source-icon{width:38px;height:38px;object-fit:contain;border-radius:5px;background:var(--ui-panel,#202330);flex-shrink:0}.source-icon{display:grid;place-items:center;color:var(--ui-muted,#959aad)}.source-details{display:flex;min-width:0;flex-direction:column;gap:5px;border:0;background:none;color:inherit;text-align:left;padding:0;cursor:pointer}.source-details strong{font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.source-details small{font-size:10px;color:var(--ui-muted,#959aad)}.source-selection{font-size:11px;color:var(--ui-muted,#959aad);padding:10px}.convert-empty{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;margin:70px 0;color:var(--ui-muted,#959aad);font-size:12px}.convert-empty p{margin:0}.convert-preview{display:flex;flex-direction:column;min-width:0;overflow:auto;padding:18px 22px;gap:12px}.preview-heading{display:flex;justify-content:space-between;gap:12px;min-width:0;font-size:11px;color:var(--ui-muted,#959aad)}.preview-heading span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%}.preview-stage{display:flex;align-items:center;justify-content:center;min-height:220px;height:clamp(220px,36vh,480px);flex-shrink:0;border:1px solid var(--ui-line,#2a2d3a);border-radius:10px;background:#090b11;overflow:hidden}.checkerboard{background-color:#1b1e27;background-image:linear-gradient(45deg,#242834 25%,transparent 25%),linear-gradient(-45deg,#242834 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#242834 75%),linear-gradient(-45deg,transparent 75%,#242834 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}.preview-stage>img,.preview-stage>video{display:block;max-width:100%;max-height:100%;object-fit:contain}.audio-preview,.preview-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;color:var(--ui-muted,#959aad);font-size:12px}.audio-preview audio{max-width:100%}.preview-caption{font-size:10px;text-align:center;color:var(--ui-muted,#959aad);min-height:13px}.convert-results{margin-top:12px;border-top:1px solid var(--ui-line,#2a2d3a);padding-top:18px}.results-empty{font-size:11px;color:var(--ui-muted,#959aad);padding:20px 4px}.convert-result{display:flex;align-items:center;gap:12px;padding:12px 4px;border-bottom:1px solid var(--ui-line,#2a2d3a)}.convert-result>svg{color:var(--ui-muted,#959aad);flex-shrink:0}.convert-result.done>svg{color:#54bc91}.convert-result.error>svg{color:#f18f87}.result-description{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}.result-description strong{font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.result-description span,.result-description small{font-size:10px;color:var(--ui-muted,#959aad);overflow-wrap:anywhere}.result-description small{line-height:1.5}.convert-result.error .result-description small{color:#f18f87}.result-download{display:flex;border:1px solid var(--ui-line,#34384a);border-radius:6px;background:none;color:inherit;padding:6px;cursor:pointer}.convert-settings{padding:20px 18px;border-left:1px solid var(--ui-line,#2a2d3a);background:var(--ui-panel,#171923);overflow:auto}.convert-settings>h2{margin-bottom:22px}.convert-settings fieldset{border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:16px;min-width:0}.convert-settings label{display:flex;flex-direction:column;gap:8px;font-size:11px;color:var(--ui-muted,#a3a8bb);min-width:0}.convert-settings label>span{float:right;color:var(--ui-text,#e5e7ef)}.convert-settings input:not([type=checkbox]):not([type=range]):not([type=color]){width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--ui-line,#34384a);background:var(--ui-bg,#11131b);border-radius:6px;color:var(--ui-text,#e5e7ef);padding:8px;font-size:11px;font-family:inherit;line-height:1.3}.convert-settings select{width:100%}.convert-settings input[type=range]{width:100%;accent-color:var(--ui-accent,#8b74ed);margin:0}.settings-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.convert-settings h3{font-size:11px;font-weight:600;margin:0}.settings-divider{height:1px;background:var(--ui-line,#2a2d3a);margin:2px 0}.convert-settings .check-label{display:flex;flex-direction:row;align-items:center;gap:7px;font-size:11px}.check-label>input{margin:0;width:13px;height:13px;accent-color:var(--ui-accent,#8b74ed)}.setting-help{font-size:10px;line-height:1.7;margin:-7px 0 0;color:var(--ui-muted,#959aad)}.convert-settings .color-label{flex-direction:row;justify-content:space-between;align-items:center}.color-label input{height:28px;width:52px;border:1px solid var(--ui-line,#34384a);padding:2px;border-radius:5px;background:transparent}.browser-notice{padding:10px;border-radius:7px;background:color-mix(in srgb,var(--ui-accent,#8b74ed) 9%,transparent);margin-top:0}.runtime-select{border:0;background:none;color:var(--ui-muted,#959aad);display:flex;align-items:center;justify-content:center;gap:7px;font-size:11px;cursor:pointer}.convert-actions{margin-top:24px;display:flex;flex-direction:column;gap:12px}.convert-actions .convert-button{width:100%;box-sizing:border-box}.convert-actions .convert-button span{font-size:10px;margin-left:auto;opacity:.8}.conversion-message{font-size:11px;line-height:1.7;margin:0;color:var(--ui-muted,#a3a8bb);overflow-wrap:anywhere}progress{height:4px;border:0;width:100%;accent-color:var(--ui-accent,#8b74ed);border-radius:4px;overflow:hidden}progress::-webkit-progress-bar{background:var(--ui-line,#34384a)}progress::-webkit-progress-value{background:var(--ui-accent,#8b74ed)}.is-dragging{outline:2px dashed var(--ui-accent,#8b74ed);outline-offset:-5px}
.image-preview-tools{display:flex;align-items:center;flex-wrap:wrap;gap:7px}.image-preview-tools button{display:inline-flex;align-items:center;gap:6px;font-size:11px;height:32px;padding:0 10px}.image-preview-tools .preview-switch{margin-left:auto}.image-copy-feedback{font-size:11px;color:var(--ui-muted,#959aad);overflow-wrap:anywhere}.image-copy-feedback.copy-error{color:#db625c}.source-details .source-cropped{color:var(--ui-accent)}.icon-options{display:grid;gap:12px}.icon-size-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.icon-options .setting-help{margin:0}.image-crop-dialog.editor-dialog,.image-annotations-dialog.editor-dialog{--ed-panel:var(--ui-surface,#fff);--ed-bg:var(--ui-bg,#f7f9fc);--ed-text:var(--ui-text,#263044);--ed-muted:var(--ui-muted,#8995a9);--ed-border:var(--ui-line,#e4e9f2);--ed-accent:var(--ui-accent,#3267f6);width:min(1100px,calc(100vw - 24px))}.crop-source-name,.crop-scope-note{font-size:11px;color:var(--ui-muted);margin:12px 16px;overflow-wrap:anywhere}.image-crop-dialog :deep(.editor-dialog-footer),.image-annotations-dialog :deep(.editor-dialog-footer){gap:8px}.export-edit-help{margin:0}.annotation-apply-error{margin:10px 16px;color:#db625c;font-size:12px;line-height:1.6}
@media(max-width:1100px){.convert-layout{grid-template-columns:180px minmax(180px,1fr) 240px}.convert-preview{padding:16px 14px}.convert-sources{padding:16px 6px}.convert-source{gap:6px;padding:8px 4px}.convert-source>img,.source-icon{width:30px;height:30px}.convert-settings{padding:18px 14px}}
@media(max-width:800px){.convert-layout{grid-template-columns:minmax(240px,1fr) 240px;overflow:auto}.convert-sources{grid-column:1 / -1;display:flex;align-items:center;gap:8px;overflow:auto;border-right:0;border-bottom:1px solid var(--ui-line,#2a2d3a);padding:10px;max-height:96px}.convert-sources .convert-section-title{flex-shrink:0;margin:0 5px}.convert-source{width:180px;flex-shrink:0;margin:0}.source-selection{display:none}.convert-empty{margin:0;flex-direction:row;gap:12px}.convert-empty>svg{display:none}.convert-preview,.convert-settings{overflow:visible}.convert-layout{grid-template-rows:auto 1fr}.convert-toolbar{padding:14px 16px}}
@media(max-width:560px){.convert-layout{display:flex;flex-direction:column;overflow:auto}.convert-sources{flex-shrink:0;min-height:62px}.convert-preview{overflow:visible;flex-shrink:0}.convert-settings{overflow:visible;border-left:0;border-top:1px solid var(--ui-line,#2a2d3a)}.preview-stage{height:220px;min-height:180px}.convert-toolbar h1{font-size:16px}.convert-toolbar p{font-size:10px}.convert-toolbar{gap:8px;padding:12px}.convert-toolbar .convert-button{font-size:11px;padding:8px}.convert-settings fieldset{display:grid;grid-template-columns:1fr 1fr;gap:16px}.convert-settings fieldset>.settings-pair,.convert-settings fieldset>.settings-divider,.convert-settings fieldset>.setting-help,.convert-settings fieldset>h3,.convert-settings fieldset>.runtime-select,.convert-settings fieldset>.icon-options{grid-column:1 / -1}.convert-actions{position:static}.convert-preview .convert-results{max-height:340px;overflow:auto}}
</style>
