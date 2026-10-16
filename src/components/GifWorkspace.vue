<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
import type { MediaAsset } from '../core/types'
import { createVideoGif, gifFrameCount, validateGifSegments, type GifQuality, type GifSegment } from '../core/gif'
import { beginMediaJob, cancelMediaJob, getMediaJobs } from '../native'

const props = defineProps<{ assets: MediaAsset[]; native: boolean }>()
const emit = defineEmits<{ imported: [file: File]; status: [message: string] }>()
const selectedId = ref('')
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
const videos = computed(() => props.assets.filter(asset => asset.kind === 'video'))
const selected = computed(() => videos.value.find(asset => asset.id === selectedId.value))
const duration = computed(() => selected.value?.duration ?? 0)
const invalid = computed(() => validateGifSegments(segments.value, duration.value))
const outputDuration = computed(() => segments.value.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0))
const outputHeight = computed(() => {
  if (!selected.value?.width) return 0
  const raw = Math.min(width.value, selected.value.width) * selected.value.height / selected.value.width
  return props.native ? Math.max(2, Math.round(raw / 2) * 2) : Math.max(1, Math.round(raw))
})

watch(videos, (values, previous = []) => {
  if (awaitingImport && values.some(asset => !previous.some(old => old.id === asset.id))) { selectedId.value = values.at(-1)?.id ?? ''; awaitingImport = false }
  else if (!values.some(asset => asset.id === selectedId.value)) selectedId.value = values.at(-1)?.id ?? ''
}, { immediate: true })
watch(selectedId, () => {
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
function finishJob(): void { clearInterval(pollTimer); pollTimer = undefined; jobId.value = ''; exporting.value = false }
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
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法读取导出进度。' }
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
  video.value?.pause()
  clearResult()
  try {
    if (props.native) {
      const job = await beginMediaJob({ kind: 'gif', asset: source, segments: clips, width: Math.min(width.value, source.width || width.value), fps: fps.value, loop: loop.value })
      if (!job) { exporting.value = false; return }
      jobId.value = job.id
      if (destroyed) { await cancelMediaJob(job.id); finishJob(); return }
      pollTimer = setInterval(() => { void pollJob() }, 400)
      await pollJob()
    } else {
      abort = new AbortController()
      const blob = await createVideoGif(source.url, source.duration, clips, { width: width.value, fps: fps.value, loop: loop.value, quality: quality.value, signal: abort.signal, onProgress: value => { progress.value = value } })
      if (destroyed) return
      resultUrl.value = URL.createObjectURL(blob)
      resultSize.value = `${(blob.size / 1024 / 1024).toFixed(2)} MB`
      download(blob, `${source.name.replace(/\.[^.]+$/, '')}-片段.gif`)
      exporting.value = false
      emit('status', 'GIF 已生成并下载。')
    }
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') emit('status', '已取消 GIF 导出。')
    else error.value = cause instanceof Error ? cause.message : 'GIF 导出失败。'
    finishJob()
  }
}
async function cancel(): Promise<void> {
  abort?.abort()
  if (jobId.value) {
    try { await cancelMediaJob(jobId.value); finishJob(); emit('status', '已取消 GIF 导出。') }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '取消失败，请重试。' }
  }
}
onBeforeUnmount(() => { destroyed = true; abort?.abort(); if (jobId.value) void cancelMediaJob(jobId.value).catch(() => {}); finishJob(); clearResult() })
</script>

<template>
  <section class="gif-workspace" data-testid="gif-workspace">
    <div class="gif-heading"><div><span class="eyebrow">MOTION TO MOMENTS</span><h1>片段转 GIF</h1><p>截取精彩片段，自由组合顺序，让动态表达更轻盈。</p></div><button class="import-button" :disabled="exporting" @click="fileInput?.click()"><Icon name="plus" :size="16" />导入视频</button><input ref="fileInput" type="file" accept="video/*,.mkv,.mov,.avi" hidden @change="importFile" /></div>
    <div class="gif-grid">
      <div class="gif-main">
        <div class="video-card"><div class="video-toolbar"><span><Icon name="video" :size="16" />视频来源</span><select v-model="selectedId" aria-label="GIF 视频来源" :disabled="exporting || !videos.length"><option v-if="!videos.length" value="">暂无视频素材</option><option v-for="asset in videos" :key="asset.id" :value="asset.id">{{ asset.name }}</option></select><span v-if="selected">{{ duration.toFixed(1) }} 秒</span></div><div class="gif-preview"><video v-if="selected" ref="video" :key="selected.id" :src="selected.url" controls playsinline preload="metadata" aria-label="GIF 来源视频预览" @timeupdate="updatePlayhead" /><div v-else class="empty-video"><div><Icon name="film" :size="40" /></div><h2>把视频变成一个精彩瞬间</h2><p>导入视频，或从素材库中选择已经添加的视频。</p><button class="import-button" @click="fileInput?.click()"><Icon name="plus" :size="15" />选择视频</button></div></div></div>
        <div class="segments-card"><div class="segments-heading"><div><h2>截取片段 <span>{{ segments.length }}</span></h2><p>按列表顺序拼接，可重复截取同一段内容。</p></div><button :disabled="!selected || exporting || segments.length >= 100" @click="addSegment"><Icon name="plus" :size="15" />添加片段</button></div><div v-if="!segments.length" class="empty-segments">选择视频后，即可添加截取片段。</div><div v-for="(segment,index) in segments" :key="segment.id" class="segment-row"><span class="segment-number">{{ String(index + 1).padStart(2,'0') }}</span><div class="time-field"><label :for="`gif-start-${segment.id}`">开始时间</label><div><input :id="`gif-start-${segment.id}`" v-model.number="segment.start" type="number" min="0" :max="duration" step="0.01" :disabled="exporting" /><button title="将当前播放位置设为开始时间" aria-label="将当前播放位置设为开始时间" :disabled="exporting" @click="mark(index,'start')"><Icon name="mark-in" :size="14" /></button></div></div><span class="time-divider">—</span><div class="time-field"><label :for="`gif-end-${segment.id}`">结束时间</label><div><input :id="`gif-end-${segment.id}`" v-model.number="segment.end" type="number" min="0" :max="duration" step="0.01" :disabled="exporting" /><button title="将当前播放位置设为结束时间" aria-label="将当前播放位置设为结束时间" :disabled="exporting" @click="mark(index,'end')"><Icon name="mark-out" :size="14" /></button></div></div><span class="segment-duration">{{ Math.max(0,segment.end - segment.start).toFixed(1) }}s</span><div class="segment-actions"><button title="预览片段" aria-label="预览片段" :disabled="exporting" @click="previewSegment(segment)"><Icon name="play" :size="14" /></button><button title="上移片段" aria-label="上移片段" :disabled="index === 0 || exporting" @click="moveSegment(index,-1)"><Icon name="chevron-up" :size="14" /></button><button title="下移片段" aria-label="下移片段" :disabled="index === segments.length - 1 || exporting" @click="moveSegment(index,1)"><Icon name="chevron-down" :size="14" /></button><button title="删除片段" aria-label="删除片段" :disabled="exporting" @click="segments.splice(index,1)"><Icon name="trash" :size="14" /></button></div></div><p v-if="selected && invalid" class="validation-error" role="alert">{{ invalid }}</p></div>
      </div>
      <aside class="gif-settings"><h2>输出设置</h2><label class="field">输出宽度<select v-model.number="width" :disabled="exporting"><option :value="320">320 px · 轻量</option><option :value="480">480 px · 紧凑</option><option :value="640">640 px · 推荐</option><option :value="960">960 px · 清晰</option><option :value="1280">1280 px · 高清</option></select></label><label class="field">帧率<select v-model.number="fps" :disabled="exporting"><option :value="6">6 FPS · 小体积</option><option :value="10">10 FPS · 标准</option><option :value="12">12 FPS · 推荐</option><option :value="15">15 FPS · 流畅</option><option :value="24">24 FPS · 更流畅</option></select></label><label v-if="!native" class="field">色彩处理<select v-model="quality" :disabled="exporting"><option value="fast">快速 · 无抖动</option><option value="balanced">均衡 · 柔和抖动</option><option value="high">细腻 · 渐变抖动</option></select></label><label class="loop-control"><span><Icon name="repeat" :size="17" />循环播放</span><input v-model="loop" type="checkbox" role="switch" :disabled="exporting" /></label><div class="output-summary"><div><span>总时长</span><strong>{{ outputDuration.toFixed(2) }} 秒</strong></div><div><span>输出尺寸</span><strong>{{ selected ? `${Math.min(width,selected.width)} × ${outputHeight}` : '—' }}</strong></div><div><span>预计帧数</span><strong>{{ segments.reduce((sum,item) => sum + gifFrameCount(item,fps),0) }} 帧</strong></div><div><span>输出格式</span><strong>GIF</strong></div></div><div v-if="error" class="validation-error" role="alert">{{ error }}</div><div v-if="exporting" class="export-progress" role="status"><span>正在生成 {{ Math.round(progress*100) }}%</span><progress :value="progress" max="1" /><button @click="cancel">取消导出</button></div><button v-else class="export-button" :disabled="!selected || !!invalid" data-testid="export-gif" @click="exportGif"><Icon name="download" :size="17" />导出 GIF</button><p class="export-note">{{ native ? '逐片段截取并拼接，自动优化调色板，导出到选择的位置。' : '在本地浏览器中编码。较长片段建议降低尺寸和帧率，或在桌面端导出。' }}</p><div v-if="resultUrl" class="gif-result"><img :src="resultUrl" alt="已生成的 GIF 预览" /><span>已生成 · {{ resultSize }}</span></div></aside>
    </div>
  </section>
</template>

<style scoped>
.gif-workspace{height:100%;overflow:auto;padding:30px 36px;color:var(--ui-text,#253044)}.gif-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:26px}.eyebrow{font-size:10px;letter-spacing:2px;font-weight:700;color:var(--ui-accent,#6257db)}h1{font-size:27px;margin:7px 0 8px;letter-spacing:-.7px}.gif-heading p{color:var(--ui-muted,#7c8492);font-size:12px;line-height:1.8;margin:0}.import-button,.segments-heading button{display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--ui-border,#e5e8f0);background:var(--ui-panel,#fff);color:var(--ui-text,#253044);padding:9px 12px;border-radius:7px;font-size:11px;white-space:nowrap;cursor:pointer}.gif-grid{display:grid;grid-template-columns:minmax(0,1fr) 265px;gap:22px;align-items:start}.gif-main{display:grid;gap:20px;min-width:0}.video-card,.segments-card,.gif-settings{border:1px solid var(--ui-border,#e5e8f0);background:var(--ui-panel,#fff);border-radius:12px;overflow:hidden}.video-toolbar{display:flex;align-items:center;gap:14px;padding:13px 17px;color:var(--ui-muted,#7c8492);font-size:10px}.video-toolbar>span:first-child{display:flex;align-items:center;gap:7px;white-space:nowrap}.video-toolbar select{flex:1;min-width:0;max-width:70%;border:0;background:transparent;color:var(--ui-text,#253044);font:inherit;text-overflow:ellipsis}.video-toolbar>span:last-child{margin-left:auto;white-space:nowrap}.gif-preview{aspect-ratio:16/9;min-height:240px;background:var(--ui-surface-2,#f7f8fc);border-top:1px solid var(--ui-border,#e5e8f0)}.gif-preview video{display:block;width:100%;height:100%;object-fit:contain;background:#141820}.empty-video{height:100%;min-height:240px;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:24px;background-image:radial-gradient(var(--ui-border,#dfe3ec) .8px,transparent .8px);background-size:18px 18px;text-align:center}.empty-video>div{width:78px;height:78px;display:grid;place-items:center;background:var(--ui-panel,#fff);color:var(--ui-accent,#6257db);border:1px solid var(--ui-border,#e5e8f0);border-radius:20px;box-shadow:0 7px 25px #3035620a}.empty-video h2{font-size:16px;margin:16px 0 8px}.empty-video p{font-size:11px;color:var(--ui-muted,#7c8492);margin:0 0 18px;line-height:1.7}.segments-card{padding:18px}.segments-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:16px}.segments-heading h2{font-size:13px;margin:0;display:flex;align-items:center;gap:8px}.segments-heading h2>span{background:var(--ui-surface-2,#f1f3f9);font-size:10px;padding:3px 7px;border-radius:5px;color:var(--ui-muted,#7c8492)}.segments-heading p{font-size:10px;color:var(--ui-muted,#7c8492);margin:6px 0 0}.segments-heading button{padding:7px 9px;font-size:10px}.empty-segments{padding:23px;text-align:center;border:1px dashed var(--ui-border,#e5e8f0);border-radius:8px;font-size:11px;color:var(--ui-muted,#7c8492)}.segment-row{display:flex;align-items:center;gap:10px;padding:13px 10px;border:1px solid var(--ui-border,#e5e8f0);border-radius:8px;margin-top:9px;background:var(--ui-surface-2,#f7f8fc)}.segment-number{font-size:10px;font-weight:600;color:var(--ui-accent,#6257db);width:19px;flex-shrink:0}.time-field{display:grid;gap:5px;min-width:0;flex:1}.time-field label{font-size:9px;color:var(--ui-muted,#7c8492)}.time-field>div{display:flex;align-items:center;border:1px solid var(--ui-border,#e5e8f0);background:var(--ui-panel,#fff);border-radius:5px;overflow:hidden}.time-field input{width:100%;min-width:42px;padding:5px 6px;border:0;background:transparent;color:var(--ui-text,#253044);font-size:11px;font-variant-numeric:tabular-nums}.time-field button{background:transparent;border:none;display:grid;place-items:center;padding:5px;color:var(--ui-muted,#7c8492);cursor:pointer}.time-divider{font-size:11px;color:var(--ui-muted,#7c8492);margin-top:12px}.segment-duration{font-size:10px;white-space:nowrap;color:var(--ui-muted,#7c8492);margin-top:12px}.segment-actions{display:flex;gap:2px;align-items:center;margin-top:12px}.segment-actions button{display:grid;place-items:center;width:24px;height:26px;border:none;border-radius:4px;background:transparent;color:var(--ui-muted,#7c8492);cursor:pointer}.segment-actions button:hover{background:var(--ui-border,#e5e8f0)}button:disabled{opacity:.35;cursor:not-allowed}.gif-settings{padding:20px;display:grid;gap:20px}.gif-settings h2{font-size:14px;margin:0}.field{display:grid;gap:8px;font-size:11px;font-weight:600}.field select{width:100%;min-width:0;background:var(--ui-surface-2,#f7f8fc);color:var(--ui-text,#253044);border:1px solid var(--ui-border,#e5e8f0);height:35px;border-radius:6px;padding:0 9px;font:inherit;font-weight:400}.loop-control{display:flex;align-items:center;justify-content:space-between;font-size:11px}.loop-control>span{display:flex;align-items:center;gap:8px}.loop-control input{appearance:none;width:29px;height:17px;border-radius:20px;background:var(--ui-border,#d8dce7);position:relative;cursor:pointer;flex-shrink:0}.loop-control input:after{content:'';position:absolute;left:3px;top:3px;width:11px;height:11px;background:#fff;border-radius:50%;transition:transform .15s}.loop-control input:checked{background:var(--ui-accent,#6257db)}.loop-control input:checked:after{transform:translateX(12px)}.loop-control input:focus-visible{outline:2px solid var(--ui-accent,#6257db);outline-offset:3px}.output-summary{display:grid;gap:12px;border-top:1px solid var(--ui-border,#e5e8f0);padding-top:18px}.output-summary>div{display:flex;justify-content:space-between;gap:10px;font-size:10px}.output-summary span{color:var(--ui-muted,#7c8492)}.output-summary strong{font-weight:500;font-variant-numeric:tabular-nums}.export-button{display:flex;align-items:center;justify-content:center;gap:8px;border:none;border-radius:7px;min-height:39px;font-size:12px;font-weight:600;cursor:pointer;background:var(--ui-accent,#6257db);color:white}.export-note{font-size:10px;color:var(--ui-muted,#7c8492);line-height:1.8;margin:0}.validation-error{font-size:11px;line-height:1.7;color:var(--ui-danger,#c34e59);background:color-mix(in srgb,var(--ui-danger,#c34e59) 10%,var(--ui-panel,#fff));padding:9px 11px;border-radius:7px;margin:0}.segments-card>.validation-error{margin-top:12px}.export-progress{display:grid;gap:8px;font-size:11px;color:var(--ui-accent,#6257db)}.export-progress progress{width:100%;height:6px;accent-color:var(--ui-accent,#6257db)}.export-progress button{justify-self:end;background:transparent;border:none;color:var(--ui-muted,#7c8492);font-size:10px;cursor:pointer}.gif-result{border:1px solid var(--ui-border,#e5e8f0);border-radius:7px;overflow:hidden}.gif-result img{width:100%;display:block}.gif-result span{display:block;font-size:10px;padding:8px;color:var(--ui-muted,#7c8492)}@media(max-width:1100px){.gif-workspace{padding:22px}.gif-grid{grid-template-columns:minmax(0,1fr) 225px;gap:14px}.gif-settings{padding:16px}.segment-row{gap:6px}.segment-actions{flex-wrap:wrap;width:48px;flex-shrink:0}.segment-duration{display:none}}@media(max-width:850px){.gif-grid{grid-template-columns:1fr}.gif-settings{grid-template-columns:1fr 1fr}.gif-settings h2,.output-summary,.export-button,.export-note,.export-progress,.validation-error,.gif-result{grid-column:1/-1}.segment-actions{flex-wrap:nowrap;width:auto}}@media(max-width:500px){.gif-workspace{padding:15px}.gif-heading{gap:10px}.gif-heading>button{padding:8px;font-size:10px}.gif-heading p{font-size:11px}.gif-settings{grid-template-columns:1fr}.segment-row{flex-wrap:wrap}.segment-number{width:16px}.segment-actions{width:100%;justify-content:flex-end;margin:0}.time-field{max-width:calc(50% - 24px)}.segments-card{padding:12px}.video-toolbar>span:last-child{display:none}}
</style>
