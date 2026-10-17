<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Project } from '../core/types.ts'
import { projectDuration } from '../core/timeline.ts'
import { exportTimelineWebM } from '../core/browser-export.ts'
import { downloadBlob } from '../core/media-import.ts'
import { prepareNativeProject } from '../core/native-project.ts'
import { beginMediaJob, cancelMediaJob, getMediaJobs, type ExportConfig, type MediaJob } from '../native.ts'
import Icon from './Icon.vue'
import RuntimeCheck from './RuntimeCheck.vue'

const props = defineProps<{ project: Project; native: boolean; open: boolean }>()
const emit = defineEmits<{ close: []; status: [message: string]; busy: [value: boolean]; job: [job: MediaJob] }>()
function exportSize(width: number, height: number) {
  return props.native ? { width: Math.ceil(width / 2) * 2, height: Math.ceil(height / 2) * 2 } : { width, height }
}
const initialSize = exportSize(props.project.width, props.project.height)
const config = ref<ExportConfig>({ format: props.native ? 'mp4' : 'webm', ...initialSize, fps: props.project.fps, quality: 'balanced' })
const adjustedSize = ref<{ width: number; height: number } | null>(initialSize.width !== props.project.width || initialSize.height !== props.project.height ? initialSize : null)
const exporting = ref(false), cancelling = ref(false), progress = ref(0), error = ref(''), completed = ref('')
let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
let destroyed = false
const job = ref<MediaJob>()
const duration = computed(() => projectDuration(props.project))
const needsEvenSize = computed(() => props.native && ((Number.isInteger(config.value.width) && config.value.width % 2 !== 0) || (Number.isInteger(config.value.height) && config.value.height % 2 !== 0)))
const showAdjustedSize = computed(() => adjustedSize.value?.width === config.value.width && adjustedSize.value?.height === config.value.height)
const valid = computed(() => duration.value > 0 && Number.isInteger(config.value.width) && Number.isInteger(config.value.height) && config.value.width >= 16 && config.value.width <= 7680 && config.value.height >= 16 && config.value.height <= 7680 && config.value.fps >= 1 && config.value.fps <= 60 && !needsEvenSize.value)
function applySize(width: number, height: number) {
  const next = exportSize(width, height)
  adjustedSize.value = next.width !== width || next.height !== height ? next : null
  config.value.width = next.width; config.value.height = next.height
}
watch(() => props.open, open => { if (open && !exporting.value) { applySize(props.project.width, props.project.height); config.value.fps = Math.min(60, props.project.fps); error.value = ''; completed.value = '' } })
watch(exporting, value => emit('busy', value))
function preset(value: string) {
  if (value === 'source') { applySize(props.project.width, props.project.height); return }
  const height = Number(value); applySize(Math.round(height * props.project.width / props.project.height), height)
}
async function poll() {
  clearTimeout(timer)
  if (!job.value || destroyed) return
  const id = job.value.id
  try {
    const current = (await getMediaJobs()).find(item => item.id === id)
    if (destroyed || job.value?.id !== id) return
    if (!current) throw new Error('导出任务已不存在。')
    job.value = current; progress.value = current.progress
    if (current.state === 'completed') { completed.value = current.outputPath || '导出完成'; exporting.value = false; emit('status', '视频导出完成。'); return }
    if (current.state === 'failed' || current.state === 'cancelled') { error.value = current.error || (current.state === 'cancelled' ? '已取消导出。' : '导出失败。'); exporting.value = false; return }
    timer = setTimeout(() => void poll(), 600)
  } catch (cause) { if (!destroyed) { error.value = cause instanceof Error ? cause.message : String(cause); timer = setTimeout(() => void poll(), 1500) } }
}
async function start() {
  if (!valid.value || exporting.value) return
  clearTimeout(timer)
  controller = new AbortController()
  const signal = controller.signal
  exporting.value = true; cancelling.value = false; error.value = ''; completed.value = ''; progress.value = 0; job.value = undefined
  try {
    if (props.native) {
      const prepared = await prepareNativeProject(props.project, signal)
      signal.throwIfAborted()
      const result = await beginMediaJob({ kind: 'timeline', ...prepared, config: { ...config.value } })
      if (signal.aborted || destroyed) {
        if (result) {
          job.value = result
          try { await cancelMediaJob(result.id); job.value = { ...result, state: 'cancelled' } }
          catch (cause) { if (!destroyed) { error.value = `取消失败，请重试。${cause instanceof Error ? cause.message : String(cause)}`; cancelling.value = false; emit('job', result); void poll() }; return }
        }
        signal.throwIfAborted()
        return
      }
      if (!result) { exporting.value = false; return }
      job.value = result; emit('job', result); void poll()
    } else {
      const blob = await exportTimelineWebM(props.project, { width: config.value.width, height: config.value.height, fps: config.value.fps, signal, onProgress: value => { progress.value = value } })
      signal.throwIfAborted()
      downloadBlob(blob, `${props.project.title.replace(/[\\/:*?"<>|]/g, '-') || '视频'}.webm`)
      completed.value = '视频已导出，请查看下载文件。'; exporting.value = false; progress.value = 1; emit('status', '视频导出完成。')
    }
  } catch (cause) { error.value = signal.aborted ? '已取消导出。' : cause instanceof Error ? cause.message : String(cause); exporting.value = false }
}
async function cancel() {
  cancelling.value = true
  controller?.abort()
  if (job.value?.state === 'running') {
    try { await cancelMediaJob(job.value.id); void poll() } catch (cause) { cancelling.value = false; error.value = cause instanceof Error ? cause.message : String(cause) }
  }
}
onBeforeUnmount(() => { destroyed = true; controller?.abort(); clearTimeout(timer); if (job.value?.state === 'running') void cancelMediaJob(job.value.id).catch(() => {}) })
</script>

<template>
  <div v-if="open" class="modal-shade" @click.self="!exporting && emit('close')">
    <section class="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" data-testid="export-dialog">
      <header><span><Icon name="export"/><strong id="export-title">导出视频</strong></span><button class="icon-button" aria-label="关闭导出" :disabled="exporting" @click="emit('close')"><Icon name="close"/></button></header>
      <div class="dialog-content">
        <p class="dialog-intro">{{ project.title }} · {{ duration.toFixed(2) }} 秒 · {{ project.width }} × {{ project.height }}</p>
        <RuntimeCheck v-if="native" :disabled="exporting" />
        <div class="form-grid">
          <label>文件格式<select v-model="config.format" :disabled="exporting" data-testid="export-format"><option v-if="native" value="mp4">MP4</option><option value="webm">WebM</option><option v-if="native" value="mov">MOV</option><option v-if="native" value="gif">GIF 动图</option></select></label>
          <label>清晰度<select aria-label="清晰度" :disabled="exporting" @change="preset(($event.target as HTMLSelectElement).value)"><option value="source">与项目相同</option><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option></select></label>
          <label>宽度<input v-model.number="config.width" type="number" min="16" max="7680" :disabled="exporting" aria-label="导出宽度"/></label>
          <label>高度<input v-model.number="config.height" type="number" min="16" max="7680" :disabled="exporting" aria-label="导出高度"/></label>
          <label>帧率<select v-model.number="config.fps" :disabled="exporting"><option v-for="fps in [12,15,24,25,30,60]" :key="fps" :value="fps">{{ fps }} fps</option></select></label>
          <label v-if="native">画质<select v-model="config.quality" :disabled="exporting"><option value="draft">较小文件</option><option value="balanced">均衡</option><option value="high">高画质</option></select></label>
        </div>
        <p v-if="needsEvenSize" class="error-message export-size-notice" role="status" data-testid="export-dimension-error"><span>桌面导出的宽度和高度必须为偶数。</span><button type="button" :disabled="exporting" @click="applySize(config.width, config.height)">调整为偶数</button></p>
        <p v-else-if="showAdjustedSize" class="note" role="status" data-testid="export-dimension-adjustment">导出尺寸已按偶数要求调整：源 {{ project.width }} × {{ project.height }} → 导出 {{ config.width }} × {{ config.height }}。项目尺寸保持不变。</p>
        <p v-if="!native" class="note"><Icon name="info" :size="15"/>网页按播放时长实时生成 WebM，请保持当前窗口在前台。桌面端可导出更多格式。</p>
        <p v-if="config.format==='gif'" class="note">GIF 不包含声音。</p>
        <div v-if="exporting" class="export-progress" role="status"><div class="progress-track"><i :style="{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }"/></div><span>{{ cancelling ? (native && !job ? '正在取消，请关闭尚未结束的文件选择窗口…' : '正在取消…') : job || !native ? `正在导出 ${Math.round(progress * 100)}%` : '正在准备素材与字幕…' }}</span></div>
        <p v-if="error" class="error-message" role="alert">{{ error }}</p>
        <p v-if="completed" class="success-message" role="status"><Icon name="check"/>{{ completed }}</p>
      </div>
      <footer><button v-if="exporting" :disabled="cancelling" @click="cancel">{{ cancelling ? '正在取消' : '取消导出' }}</button><button v-else @click="emit('close')">关闭</button><button class="primary" :disabled="!valid || exporting" data-testid="start-export" @click="start"><Icon name="export" :size="16"/>{{ exporting ? '正在导出' : '开始导出' }}</button></footer>
    </section>
  </div>
</template>

<style scoped>
.export-dialog{width:480px}.export-progress{display:grid;gap:8px;font-size:12px;color:var(--ui-muted);margin-top:20px}.success-message{display:flex;gap:8px;align-items:flex-start;overflow-wrap:anywhere;font-size:12px;color:var(--ui-success)}
.export-size-notice{display:flex;align-items:center;justify-content:space-between;gap:10px}.export-size-notice button{flex:none}
</style>
