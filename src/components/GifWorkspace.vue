<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
import ToolWorkspace from './ToolWorkspace.vue'
import RuntimeCheck from './RuntimeCheck.vue'
import MediaAssetMenu from './MediaAssetMenu.vue'
import VideoLibraryToolbar from './VideoLibraryToolbar.vue'
import VideoLibraryActions from './VideoLibraryActions.vue'
import type { MediaAsset } from '../core/types'
import { videoDuration, videoImportedTime } from '../core/video-assets'
import { useStoredVideos } from '../core/stored-videos'
import { createVideoGif, gifFrameCount, validateGifSegments, type GifQuality, type GifSegment } from '../core/gif'
import { beginMediaJob, cancelMediaJob, getMediaJobs } from '../native'

const props = defineProps<{ assets: MediaAsset[]; native: boolean }>()
const emit = defineEmits<{ imported: [file: File]; status: [message: string]; 'busy-change': [busy: boolean] }>()
const selectedId = ref('')
const assetMenu = ref<InstanceType<typeof MediaAssetMenu>>()
const video = ref<HTMLVideoElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const segments = ref<(GifSegment & { id: number })[]>([])
const fps = ref(12)
const width = ref(640)
const loop = ref(true)
const quality = ref<GifQuality>('balanced')
const playhead = ref(0)
let previewEnd: number | undefined
const error = ref('')
const exporting = ref(false)
watch(exporting, value => emit('busy-change', value), { flush: 'sync' })
const progress = ref(0)
const jobId = ref('')
const resultUrl = ref('')
const resultSize = ref('')
let awaitingImport = false
let nextSegmentId = 1
let abort: AbortController | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let polling = false
let destroyed = false
const { assets: videos, directory, loading: libraryLoading, error: libraryError, warnings: libraryWarnings, preparing: previewPreparing, refresh: refreshVideos, reveal: revealVideoDirectory, preparePreview } = useStoredVideos(() => props.assets, () => props.native)
const selected = computed(() => videos.value.find(asset => asset.id === selectedId.value))
const duration = computed(() => selected.value?.duration ?? 0)
const invalid = computed(() => validateGifSegments(segments.value, duration.value))
const outputDuration = computed(() => segments.value.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0))
function errorMessage(cause: unknown, fallback: string): string { return cause instanceof Error ? cause.message : typeof cause === 'string' && cause.trim() ? cause : fallback }
const outputHeight = computed(() => {
  if (!selected.value?.width) return 0
  const raw = Math.min(width.value, selected.value.width) * selected.value.height / selected.value.width
  return props.native ? Math.max(2, Math.round(raw / 2) * 2) : Math.max(1, Math.round(raw))
})

watch(videos, values => {
  if (!values.some(asset => asset.id === selectedId.value)) selectedId.value = values[0]?.id ?? ''
}, { immediate: true })
watch(() => props.assets.filter(asset => asset.kind === 'video'), (values, previous = []) => {
  if (!awaitingImport) return
  const imported = values.find(asset => !previous.some(old => old.id === asset.id))
  if (imported) { selectedId.value = imported.id; awaitingImport = false }
})
watch(() => props.native ? selected.value : undefined, asset => { if (asset) void preparePreview(asset).catch(cause => emit('status', errorMessage(cause, '无法准备视频预览。'))) }, { immediate: true })
watch(selectedId, () => {
  video.value?.pause()
  previewEnd = undefined
  segments.value = duration.value > 0 ? [{ id: nextSegmentId++, start: 0, end: Math.min(5, duration.value) }] : []
  playhead.value = 0
  error.value = ''
  clearResult()
}, { immediate: true })
function clearResult(): void { if (resultUrl.value) URL.revokeObjectURL(resultUrl.value); resultUrl.value = ''; resultSize.value = '' }
function importFile(event: Event): void {
  const input = event.target as HTMLInputElement
  awaitingImport = !!input.files?.length
  for (const file of Array.from(input.files ?? [])) emit('imported', file)
  input.value = ''
}
function addSegment(): void {
  if (!selected.value || exporting.value) return
  const start = Math.min(playhead.value, Math.max(0, duration.value - 0.1))
  segments.value.push({ id: nextSegmentId++, start: Math.round(start * 100) / 100, end: Math.min(duration.value, start + 3) })
}
function moveSegment(index: number, direction: number): void {
  const next = index + direction
  if (next < 0 || next >= segments.value.length) return
  const item = segments.value.splice(index, 1)[0]!
  segments.value.splice(next, 0, item)
}
function seek(position: number): void { if (video.value) { video.value.currentTime = Math.max(0, Math.min(duration.value, position)); playhead.value = video.value.currentTime } }
function mark(index: number, side: 'start' | 'end'): void { const segment = segments.value[index]; if (segment) segment[side] = Math.round(playhead.value * 100) / 100 }
function previewSegment(segment: GifSegment): void {
  if (!video.value) return
  seek(segment.start)
  previewEnd = segment.end
  void video.value.play().catch(() => { error.value = '视频暂时无法播放，请检查素材格式。' })
}
function updatePlayhead(): void {
  if (!video.value) return
  playhead.value = video.value.currentTime
  if (previewEnd !== undefined && playhead.value >= previewEnd) { video.value.pause(); previewEnd = undefined }
}
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
function finishJob(): void { clearInterval(pollTimer); pollTimer = undefined; jobId.value = ''; exporting.value = false; abort = undefined }
async function pollJob(): Promise<void> {
  if (!jobId.value || polling) return
  const currentId = jobId.value
  polling = true
  try {
    const job = (await getMediaJobs()).find(item => item.id === currentId)
    if (!job || currentId !== jobId.value) return
    progress.value = job.progress
    if (job.state === 'completed') { progress.value = 1; finishJob(); emit('status', `GIF 已导出${job.outputPath ? `：${job.outputPath}` : '。'}`) }
    else if (job.state === 'failed') { error.value = job.error || 'GIF 导出失败。'; finishJob() }
    else if (job.state === 'cancelled') { finishJob(); emit('status', '已取消 GIF 导出。') }
  } catch (cause) { error.value = errorMessage(cause, '无法读取导出进度。') }
  finally { polling = false }
}
async function exportGif(): Promise<void> {
  if (!selected.value || exporting.value) return
  if (invalid.value) { error.value = invalid.value; return }
  const source = selected.value
  const clips = segments.value.map(({ start, end }) => ({ start, end }))
  error.value = ''
  progress.value = 0
  exporting.value = true
  abort = new AbortController()
  const signal = abort.signal
  video.value?.pause()
  clearResult()
  try {
    if (props.native) {
      const job = await beginMediaJob({ kind: 'gif', asset: source, segments: clips, width: Math.min(width.value, source.width || width.value), fps: fps.value, loop: loop.value })
      if (!job) { finishJob(); return }
      jobId.value = job.id
      if (destroyed || signal.aborted) { await cancelMediaJob(job.id); finishJob(); if (!destroyed) emit('status', '已取消 GIF 导出。'); return }
      pollTimer = setInterval(() => { void pollJob() }, 400)
      await pollJob()
    } else {
      const blob = await createVideoGif(source.url, source.duration, clips, { width: width.value, fps: fps.value, loop: loop.value, quality: quality.value, signal, onProgress: value => { progress.value = value } })
      if (destroyed) return
      resultUrl.value = URL.createObjectURL(blob)
      resultSize.value = `${(blob.size / 1024 / 1024).toFixed(2)} MB`
      download(blob, `${source.name.replace(/\.[^.]+$/, '')}-片段.gif`)
      exporting.value = false
      emit('status', 'GIF 已生成并下载。')
    }
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') emit('status', '已取消 GIF 导出。')
    else error.value = errorMessage(cause, 'GIF 导出失败。')
    finishJob()
  }
}
async function cancel(): Promise<void> {
  abort?.abort()
  if (jobId.value) {
    try { await cancelMediaJob(jobId.value); finishJob(); emit('status', '已取消 GIF 导出。') }
    catch (cause) { error.value = errorMessage(cause, '取消失败，请重试。') }
  }
}
onBeforeUnmount(() => { destroyed = true; abort?.abort(); if (jobId.value) void cancelMediaJob(jobId.value).catch(() => {}); finishJob(); clearResult(); emit('busy-change', false) })
</script>

<template>
  <ToolWorkspace class="gif-workspace" data-testid="gif-workspace" title="片段转 GIF" icon="film" description="截取视频片段，自由组合顺序并导出动态图片。" library-label="视频素材库" settings-label="输出设置">
    <template #actions><button class="import-button" :disabled="exporting" @click="fileInput?.click()"><Icon name="plus" :size="16" />导入视频</button><input ref="fileInput" type="file" accept="video/*,.mkv,.mov,.avi" hidden @change="importFile" /></template>
    <template #library>
      <aside class="gif-sources" aria-label="GIF 视频素材">
        <header><h2>视频素材 <span>{{ videos.length }}</span></h2><VideoLibraryActions v-if="native" :directory="directory" :loading="libraryLoading" :disabled="exporting" @refresh="refreshVideos" @reveal="revealVideoDirectory" /></header>
        <VideoLibraryToolbar v-if="native" :loading="libraryLoading" :preparing="previewPreparing" :error="libraryError" :warnings="libraryWarnings" />
        <div class="gif-source-list" data-testid="gif-source-list">
          <button v-for="asset in videos" :key="asset.id" class="gif-source" :class="{ active: selectedId === asset.id }" :data-source-asset-id="asset.id" :aria-pressed="selectedId === asset.id" :disabled="exporting" @click="selectedId = asset.id" @contextmenu="assetMenu?.open($event, asset)" @keydown.shift.f10="assetMenu?.open($event, asset)" @keydown.context-menu="assetMenu?.open($event, asset)">
            <span class="gif-source-icon"><Icon name="video" :size="20" /></span><span class="gif-source-details"><strong :title="asset.name">{{ asset.name }}</strong><small>{{ videoDuration(asset.duration) }} · {{ asset.width }} × {{ asset.height }}</small><time :datetime="asset.addedAt" :title="`视频时间：${videoImportedTime(asset)}`">{{ videoImportedTime(asset) }}</time></span>
          </button>
          <p v-if="!videos.length" class="gif-source-empty">{{ native ? libraryLoading ? '正在读取本机视频…' : '保存目录暂无视频，也可以导入视频' : '导入视频后显示在这里' }}</p>
        </div>
      </aside>
    </template>
    <template #default>
      <div class="gif-main">
        <div class="video-card"><div class="video-toolbar"><span><Icon name="video" :size="16" />视频来源</span><select v-model="selectedId" aria-label="GIF 视频来源" :disabled="exporting || !videos.length"><option v-if="!videos.length" value="">暂无视频素材</option><option v-for="asset in videos" :key="asset.id" :value="asset.id">{{ asset.name }}</option></select><span v-if="selected">{{ duration.toFixed(1) }} 秒</span></div><div class="gif-preview"><video v-if="selected" ref="video" :key="selected.id" :src="selected.url" controls playsinline preload="metadata" aria-label="GIF 来源视频预览" @timeupdate="updatePlayhead" /><div v-else class="empty-video"><div><Icon name="film" :size="40" /></div><h2>把视频变成一个精彩瞬间</h2><p>导入视频，或从素材库中选择已经添加的视频。</p><button class="import-button" @click="fileInput?.click()"><Icon name="plus" :size="15" />选择视频</button></div></div></div>
        <div class="segments-card"><div class="segments-heading"><div><h2>截取片段 <span>{{ segments.length }}</span></h2><p>按列表顺序拼接，可重复截取同一段内容。</p></div><button :disabled="!selected || exporting || segments.length >= 100" @click="addSegment"><Icon name="plus" :size="15" />添加片段</button></div><div v-if="!segments.length" class="empty-segments">选择视频后，即可添加截取片段。</div><div v-for="(segment,index) in segments" :key="segment.id" class="segment-row"><span class="segment-number">{{ String(index + 1).padStart(2,'0') }}</span><div class="time-field"><label :for="`gif-start-${segment.id}`">开始时间</label><div><input :id="`gif-start-${segment.id}`" v-model.number="segment.start" type="number" min="0" :max="duration" step="0.01" :disabled="exporting" /><button title="将当前播放位置设为开始时间" aria-label="将当前播放位置设为开始时间" :disabled="exporting" @click="mark(index,'start')"><Icon name="mark-in" :size="14" /></button></div></div><span class="time-divider">—</span><div class="time-field"><label :for="`gif-end-${segment.id}`">结束时间</label><div><input :id="`gif-end-${segment.id}`" v-model.number="segment.end" type="number" min="0" :max="duration" step="0.01" :disabled="exporting" /><button title="将当前播放位置设为结束时间" aria-label="将当前播放位置设为结束时间" :disabled="exporting" @click="mark(index,'end')"><Icon name="mark-out" :size="14" /></button></div></div><span class="segment-duration">{{ Math.max(0,segment.end - segment.start).toFixed(1) }}s</span><div class="segment-actions"><button title="预览片段" aria-label="预览片段" :disabled="exporting" @click="previewSegment(segment)"><Icon name="play" :size="14" /></button><button title="上移片段" aria-label="上移片段" :disabled="index === 0 || exporting" @click="moveSegment(index,-1)"><Icon name="chevron-up" :size="14" /></button><button title="下移片段" aria-label="下移片段" :disabled="index === segments.length - 1 || exporting" @click="moveSegment(index,1)"><Icon name="chevron-down" :size="14" /></button><button title="删除片段" aria-label="删除片段" :disabled="exporting" @click="segments.splice(index,1)"><Icon name="trash" :size="14" /></button></div></div><p v-if="selected && invalid" class="validation-error" role="alert">{{ invalid }}</p></div>
        <div v-if="resultUrl" class="gif-result"><img :src="resultUrl" alt="已生成的 GIF 预览" /><span>已生成 · {{ resultSize }}</span></div>
      </div>
    </template>
    <template #settings>
      <aside class="gif-settings"><h2>输出设置</h2><RuntimeCheck v-if="native" :disabled="exporting" /><label class="field">输出宽度<select v-model.number="width" :disabled="exporting"><option :value="320">320 px · 轻量</option><option :value="480">480 px · 紧凑</option><option :value="640">640 px · 推荐</option><option :value="960">960 px · 清晰</option><option :value="1280">1280 px · 高清</option></select></label><label class="field">帧率<select v-model.number="fps" :disabled="exporting"><option :value="6">6 FPS · 小体积</option><option :value="10">10 FPS · 标准</option><option :value="12">12 FPS · 推荐</option><option :value="15">15 FPS · 流畅</option><option :value="24">24 FPS · 更流畅</option></select></label><label v-if="!native" class="field">色彩处理<select v-model="quality" :disabled="exporting"><option value="fast">快速 · 无抖动</option><option value="balanced">均衡 · 柔和抖动</option><option value="high">细腻 · 渐变抖动</option></select></label><label class="loop-control"><span><Icon name="repeat" :size="17" />循环播放</span><input v-model="loop" type="checkbox" role="switch" :disabled="exporting" /></label><div class="output-summary"><div><span>总时长</span><strong>{{ outputDuration.toFixed(2) }} 秒</strong></div><div><span>输出尺寸</span><strong>{{ selected ? `${Math.min(width,selected.width)} × ${outputHeight}` : '—' }}</strong></div><div><span>预计帧数</span><strong>{{ segments.reduce((sum,item) => sum + gifFrameCount(item,fps),0) }} 帧</strong></div><div><span>输出格式</span><strong>GIF</strong></div></div><div v-if="error" class="validation-error" role="alert">{{ error }}</div><div v-if="exporting" class="export-progress" role="status"><span>正在生成 {{ Math.round(progress*100) }}%</span><progress :value="progress" max="1" /><button @click="cancel">取消导出</button></div><button v-else class="export-button" :disabled="!selected || !!invalid" data-testid="export-gif" @click="exportGif"><Icon name="download" :size="17" />导出 GIF</button><p class="export-note">{{ native ? '逐片段截取并拼接，自动优化调色板，导出到选择的位置。' : '在本地浏览器中编码。较长片段建议降低尺寸和帧率，或在桌面端导出。' }}</p></aside>
    </template>
    <template #overlays><MediaAssetMenu ref="assetMenu" :native="native" @error="error = $event" />
    </template>
  </ToolWorkspace>
</template>

<style scoped>
.gif-sources>.video-library-toolbar{margin:0 0 9px}
.gif-sources{display:flex;flex-direction:column;min-width:0;min-height:100%}.gif-sources header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0;padding:0 0 14px}.gif-sources h2{font-size:12px;margin:0;white-space:nowrap}.gif-sources h2 span{font-size:10px;font-weight:400;color:var(--ui-muted,#7c8492);margin-left:5px}.gif-source-list{display:flex;flex-direction:column;gap:5px;min-height:0;padding:0}.gif-source{display:flex;align-items:center;justify-content:flex-start;gap:9px;width:100%;min-height:76px;flex-shrink:0;padding:9px 7px;text-align:left;border:1px solid transparent;border-radius:7px;background:transparent;color:inherit;cursor:pointer}.gif-source.active{background:color-mix(in srgb,var(--ui-accent,#6257db) 9%,transparent);border-color:color-mix(in srgb,var(--ui-accent,#6257db) 35%,transparent)}.gif-source:focus-visible{outline:2px solid var(--ui-accent,#6257db);outline-offset:-2px}.gif-source-icon{display:grid;place-items:center;flex-shrink:0;width:30px;height:36px;border-radius:5px;background:var(--ui-surface-2,#f7f8fc);color:var(--ui-muted,#7c8492)}.gif-source-details{display:flex;flex-direction:column;gap:6px;min-width:0}.gif-source-details strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:500}.gif-source-details small,.gif-source-details time{font-size:9px;color:var(--ui-muted,#7c8492);font-variant-numeric:tabular-nums;white-space:nowrap}.gif-source-empty{padding:20px 8px;color:var(--ui-muted,#7c8492);font-size:11px;text-align:center}
.import-button,.segments-heading button{display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--ui-border,#e5e8f0);background:var(--ui-panel,#fff);color:var(--ui-text,#253044);padding:9px 12px;border-radius:7px;font-size:11px;white-space:nowrap;cursor:pointer}.gif-main{display:grid;gap:12px;min-width:0}.video-card,.segments-card{background:var(--ui-panel,#fff);overflow:hidden}.segments-card{border-top:1px solid var(--ui-border)}.video-toolbar{display:flex;align-items:center;gap:14px;padding:13px 17px;color:var(--ui-muted,#7c8492);font-size:10px}.video-toolbar>span:first-child{display:flex;align-items:center;gap:7px;white-space:nowrap}.video-toolbar select{flex:1;max-width:70%}.video-toolbar>span:last-child{margin-left:auto;white-space:nowrap}.gif-preview{height:clamp(220px,36vh,480px);min-height:220px;background:var(--ui-surface-2,#f7f8fc);border-top:1px solid var(--ui-border,#e5e8f0)}.gif-preview video{display:block;width:100%;height:100%;object-fit:contain;background:#141820}.empty-video{height:100%;min-height:220px;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:24px;background-image:radial-gradient(var(--ui-border,#dfe3ec) .8px,transparent .8px);background-size:18px 18px;text-align:center}.empty-video>div{width:78px;height:78px;display:grid;place-items:center;background:var(--ui-panel,#fff);color:var(--ui-accent,#6257db);border:1px solid var(--ui-border,#e5e8f0);border-radius:20px;box-shadow:0 7px 25px #3035620a}.empty-video h2{font-size:16px;margin:16px 0 8px}.empty-video p{font-size:11px;color:var(--ui-muted,#7c8492);margin:0 0 18px;line-height:1.7}.segments-card{padding:18px}.segments-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:16px}.segments-heading h2{font-size:13px;margin:0;display:flex;align-items:center;gap:8px}.segments-heading h2>span{background:var(--ui-surface-2,#f1f3f9);font-size:10px;padding:3px 7px;border-radius:5px;color:var(--ui-muted,#7c8492)}.segments-heading p{font-size:10px;color:var(--ui-muted,#7c8492);margin:6px 0 0}.segments-heading button{padding:7px 9px;font-size:10px}.empty-segments{padding:23px;text-align:center;border:1px dashed var(--ui-border,#e5e8f0);border-radius:8px;font-size:11px;color:var(--ui-muted,#7c8492)}.segment-row{display:flex;align-items:center;gap:10px;padding:13px 10px;border:1px solid var(--ui-border,#e5e8f0);border-radius:8px;margin-top:9px;background:var(--ui-surface-2,#f7f8fc)}.segment-number{font-size:10px;font-weight:600;color:var(--ui-accent,#6257db);width:19px;flex-shrink:0}.time-field{display:grid;gap:5px;min-width:0;flex:1}.time-field label{font-size:9px;color:var(--ui-muted,#7c8492)}.time-field>div{display:flex;align-items:center;border:1px solid var(--ui-border,#e5e8f0);background:var(--ui-panel,#fff);border-radius:5px;overflow:hidden}.time-field input{width:100%;min-width:42px;padding:5px 6px;border:0;background:transparent;color:var(--ui-text,#253044);font-size:11px;font-variant-numeric:tabular-nums}.time-field button{background:transparent;border:none;display:grid;place-items:center;padding:5px;color:var(--ui-muted,#7c8492);cursor:pointer}.time-divider{font-size:11px;color:var(--ui-muted,#7c8492);margin-top:12px}.segment-duration{font-size:10px;white-space:nowrap;color:var(--ui-muted,#7c8492);margin-top:12px}.segment-actions{display:flex;gap:2px;align-items:center;margin-top:12px}.segment-actions button{display:grid;place-items:center;width:24px;height:26px;border:none;border-radius:4px;background:transparent;color:var(--ui-muted,#7c8492);cursor:pointer}.segment-actions button:hover{background:var(--ui-border,#e5e8f0)}button:disabled{opacity:.35;cursor:not-allowed}.gif-settings{padding:0;display:grid;gap:16px;align-content:start}.gif-settings h2{font-size:12px;margin:0}.field{display:grid;gap:8px;font-size:11px;font-weight:600}.field select{width:100%}.loop-control{display:flex;align-items:center;justify-content:space-between;font-size:11px}.loop-control>span{display:flex;align-items:center;gap:8px}.loop-control input{appearance:none;width:29px;height:17px;border-radius:20px;background:var(--ui-border,#d8dce7);position:relative;cursor:pointer;flex-shrink:0}.loop-control input:after{content:'';position:absolute;left:3px;top:3px;width:11px;height:11px;background:#fff;border-radius:50%;transition:transform .15s}.loop-control input:checked{background:var(--ui-accent,#6257db)}.loop-control input:checked:after{transform:translateX(12px)}.loop-control input:focus-visible{outline:2px solid var(--ui-accent,#6257db);outline-offset:3px}.output-summary{display:grid;gap:12px;border-top:1px solid var(--ui-border,#e5e8f0);padding-top:18px}.output-summary>div{display:flex;justify-content:space-between;gap:10px;font-size:10px}.output-summary span{color:var(--ui-muted,#7c8492)}.output-summary strong{font-weight:500;font-variant-numeric:tabular-nums}.export-button{display:flex;align-items:center;justify-content:center;gap:8px;border:none;border-radius:7px;min-height:39px;font-size:12px;font-weight:600;cursor:pointer;background:var(--ui-accent,#6257db);color:white}.export-note{font-size:10px;color:var(--ui-muted,#7c8492);line-height:1.8;margin:0}.validation-error{font-size:11px;line-height:1.7;color:var(--ui-danger,#c34e59);background:color-mix(in srgb,var(--ui-danger,#c34e59) 10%,var(--ui-panel,#fff));padding:9px 11px;border-radius:7px;margin:0}.segments-card>.validation-error{margin-top:12px}.export-progress{display:grid;gap:8px;font-size:11px;color:var(--ui-accent,#6257db)}.export-progress progress{width:100%;height:6px;accent-color:var(--ui-accent,#6257db)}.export-progress button{justify-self:end;background:transparent;border:none;color:var(--ui-muted,#7c8492);font-size:10px;cursor:pointer}.gif-result{border:1px solid var(--ui-border,#e5e8f0);border-radius:7px;overflow:hidden}.gif-result img{width:100%;display:block}.gif-result span{display:block;font-size:10px;padding:8px;color:var(--ui-muted,#7c8492)}@media(max-width:1100px){.segment-row{gap:6px}.segment-actions{flex-wrap:wrap;width:48px;flex-shrink:0}.segment-duration{display:none}}@media(max-width:950px){.segment-actions{flex-wrap:nowrap;width:auto}}@media(max-width:500px){.segment-row{flex-wrap:wrap}.segment-number{width:16px}.segment-actions{width:100%;justify-content:flex-end;margin:0}.time-field{max-width:calc(50% - 24px)}.segments-card{padding:12px}.video-toolbar>span:last-child{display:none}}
</style>
