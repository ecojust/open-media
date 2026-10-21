<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Project } from '../core/types.ts'
import { renderDuration } from '../core/timeline.ts'
import { exportTimelineWebM } from '../core/browser-export.ts'
import { downloadBlob } from '../core/media-import.ts'
import { prepareNativeProject } from '../core/native-project.ts'
import { beginMediaJob, cancelMediaJob, getMediaJobs, revealMediaJobOutput, type ExportConfig, type MediaJob } from '../native.ts'
import Icon from './Icon.vue'
import RuntimeCheck from './RuntimeCheck.vue'

const props = defineProps<{ project: Project; native: boolean; open: boolean }>()
const emit = defineEmits<{ close: []; status: [message: string]; busy: [value: boolean]; job: [job: MediaJob] }>()
function exportSize(width: number, height: number) {
  return props.native ? { width: Math.ceil(width / 2) * 2, height: Math.ceil(height / 2) * 2 } : { width, height }
}
const initialSize = exportSize(props.project.width, props.project.height)
const config = ref<ExportConfig>({ format: props.native ? 'mp4' : 'webm', ...initialSize, fps: props.project.fps, quality: 'balanced' })
const exporting = ref(false), cancelling = ref(false), progress = ref(0), error = ref(''), completed = ref('')
const elapsedSeconds = ref(0), revealing = ref(false)
let elapsedTimer: ReturnType<typeof setInterval> | undefined, elapsedStartedAt = 0
let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
let destroyed = false
const job = ref<MediaJob>()
const duration = computed(() => renderDuration(props.project))
const showAdjustedSize = computed(() => config.value.width !== props.project.width || config.value.height !== props.project.height)
const dimensionError = computed(() => config.value.width > 7680 || config.value.height > 7680 ? '导出尺寸最大支持 7680 × 7680，请在预览上方调整画面尺寸。' : '')
const outputProgress = computed(() => {
  const idle = job.value?.outputIdleSeconds
  if (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0) return undefined
  const frames = job.value?.encodedFrames, time = job.value?.outputTime
  const encodedFrames = typeof frames === 'number' && Number.isFinite(frames) && frames >= 0 ? Math.floor(frames) : undefined
  const outputTime = typeof time === 'number' && Number.isFinite(time) && time >= 0 ? time : undefined
  return { idleSeconds: Math.floor(idle), encodedFrames, outputTime, hasOutput: (encodedFrames ?? 0) > 0 || (outputTime ?? 0) > 0 }
})
const elapsedLabel = computed(() => {
  const seconds = Math.max(0, Math.floor(elapsedSeconds.value))
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0'))
  if (seconds >= 3600) parts.unshift(String(Math.floor(seconds / 3600)).padStart(2, '0'))
  return parts.join(':')
})
const valid = computed(() => duration.value > 0 && Number.isInteger(config.value.width) && Number.isInteger(config.value.height) && config.value.width >= 16 && config.value.width <= 7680 && config.value.height >= 16 && config.value.height <= 7680 && config.value.fps >= 1 && config.value.fps <= 60)
function applySize(width: number, height: number) {
  const next = exportSize(width, height)
  config.value.width = next.width; config.value.height = next.height
}
watch([() => props.project.width, () => props.project.height, () => props.native], () => { if (!exporting.value) applySize(props.project.width, props.project.height) })
watch(() => props.open, open => {
  if (!open) { stopElapsed(); return }
  if (exporting.value) { resumeElapsed(); return }
  applySize(props.project.width, props.project.height); config.value.fps = Math.min(60, props.project.fps); error.value = ''; completed.value = ''; elapsedSeconds.value = 0
})
watch(exporting, value => { emit('busy', value); if (!value) stopElapsed() })
function updateElapsed(): void {
  const actual = job.value?.elapsedSeconds
  elapsedSeconds.value = Math.max(elapsedSeconds.value, elapsedStartedAt ? (performance.now() - elapsedStartedAt) / 1000 : 0, Number.isFinite(actual) && (actual || 0) >= 0 ? actual || 0 : 0)
}
function stopElapsed(): void { if (elapsedTimer !== undefined) updateElapsed(); clearInterval(elapsedTimer); elapsedTimer = undefined }
function resumeElapsed(): void { clearInterval(elapsedTimer); if (props.open && !destroyed) elapsedTimer = setInterval(updateElapsed, 250) }
async function revealOutput(): Promise<void> {
  if (!props.native || job.value?.state !== 'completed' || !job.value.outputPath || revealing.value) return
  revealing.value = true; error.value = ''
  try { await revealMediaJobOutput(job.value.id) } catch (cause) { error.value = `无法打开文件夹：${cause instanceof Error ? cause.message : String(cause)}` }
  finally { revealing.value = false }
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
    if (current.state === 'completed') { updateElapsed(); completed.value = current.outputPath || '导出完成'; exporting.value = false; emit('status', '视频导出完成。'); return }
    if (current.state === 'failed' || current.state === 'cancelled') { error.value = current.error || (current.state === 'cancelled' ? '已取消导出。' : '导出失败。'); exporting.value = false; return }
    timer = setTimeout(() => void poll(), 600)
  } catch (cause) { if (!destroyed) { error.value = cause instanceof Error ? cause.message : String(cause); timer = setTimeout(() => void poll(), 1500) } }
}
async function start() {
  if (!valid.value || exporting.value) return
  clearTimeout(timer)
  applySize(props.project.width, props.project.height)
  elapsedStartedAt = performance.now(); elapsedSeconds.value = 0; resumeElapsed()
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
          catch (cause) { if (!destroyed) { error.value = `取消失败，请重试。${cause instanceof Error ? cause.message : String(cause)}`; cancelling.value = false; resumeElapsed(); emit('job', result); void poll() }; return }
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
  stopElapsed()
  controller?.abort()
  if (job.value?.state === 'running') {
    try { await cancelMediaJob(job.value.id); void poll() } catch (cause) { cancelling.value = false; resumeElapsed(); error.value = cause instanceof Error ? cause.message : String(cause) }
  }
}
onBeforeUnmount(() => { destroyed = true; controller?.abort(); clearTimeout(timer); stopElapsed(); if (job.value?.state === 'running') void cancelMediaJob(job.value.id).catch(() => {}) })
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
          <label>宽度<input :value="config.width" readonly aria-readonly="true" aria-label="导出宽度" aria-describedby="export-size-help"/></label>
          <label>高度<input :value="config.height" readonly aria-readonly="true" aria-label="导出高度" aria-describedby="export-size-help"/></label>
          <label>帧率<select v-model.number="config.fps" :disabled="exporting"><option v-for="fps in [12,15,24,25,30,60]" :key="fps" :value="fps">{{ fps }} fps</option></select></label>
          <label v-if="native">画质<select v-model="config.quality" :disabled="exporting"><option value="draft">较小文件</option><option value="balanced">均衡</option><option value="high">高画质</option></select></label>
        </div>
        <p id="export-size-help" class="note">画面尺寸可在预览上方调整，此处仅显示输出尺寸。</p>
        <p v-if="dimensionError" class="error-message" role="alert" data-testid="export-dimension-error">{{ dimensionError }}</p>
        <p v-if="showAdjustedSize" class="note" role="status" data-testid="export-dimension-adjustment">导出尺寸已按偶数要求调整：源 {{ project.width }} × {{ project.height }} → 导出 {{ config.width }} × {{ config.height }}。项目尺寸保持不变。</p>
        <p v-if="!native" class="note"><Icon name="info" :size="15"/>网页按播放时长实时生成 WebM，请保持当前窗口在前台。桌面端可导出更多格式。</p>
        <p v-if="config.format==='gif'" class="note">GIF 不包含声音。</p>
        <div v-if="exporting" class="export-progress" role="status">
          <div class="progress-track"><i :style="{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }"/></div>
          <span>{{ cancelling ? (native && !job ? '正在取消，请关闭尚未结束的文件选择窗口…' : '正在取消…') : job || !native ? `正在导出 ${Math.round(progress * 100)}%` : '正在准备素材与字幕…' }}</span>
          <span v-if="job?.stage" class="export-stage" data-testid="export-stage">{{ job.stage }}<template v-if="job.backend"> · {{ job.backend }}</template></span>
          <span v-else-if="job?.backend" class="export-stage" data-testid="export-stage">{{ job.backend }}</span>
          <div v-if="outputProgress" class="export-output-progress" data-testid="export-output-progress">
            <span v-if="outputProgress.hasOutput" data-testid="export-output-count">已输出 {{ outputProgress.encodedFrames ?? '—' }} 帧 · 媒体时间 {{ outputProgress.outputTime?.toFixed(2) ?? '—' }} 秒</span>
            <span v-else data-testid="export-output-count">尚未输出首帧</span>
            <span v-if="outputProgress.idleSeconds >= 1" data-testid="export-output-idle">{{ outputProgress.hasOutput ? `已 ${outputProgress.idleSeconds} 秒没有新的输出进度` : `已等待 ${outputProgress.idleSeconds} 秒` }}</span>
            <span v-if="outputProgress.idleSeconds >= 60 && !cancelling" class="export-output-hint" data-testid="export-output-hint">请检查素材是否可正常读取；也可取消导出后重试。</span>
          </div>
          <span v-if="job?.fallbackReason" class="export-fallback" data-testid="export-fallback">{{ job.fallbackReason }}</span>
          <span role="timer" aria-live="off" data-testid="export-elapsed">已用时 {{ elapsedLabel }}</span>
        </div>
        <p v-if="error" class="error-message" role="alert">{{ error }}</p>
        <div v-if="completed" class="export-completion" role="status"><p class="success-message"><Icon name="check"/>{{ completed }}</p><span data-testid="export-completed-elapsed">耗时 {{ elapsedLabel }}</span><span v-if="job?.backend" class="export-stage">{{ job.backend }}</span><p v-if="job?.fallbackReason" class="export-fallback" data-testid="export-fallback">{{ job.fallbackReason }}</p><button v-if="native && job?.state === 'completed' && job.outputPath" type="button" :disabled="revealing" @click="revealOutput"><Icon name="folder" :size="15" />{{ revealing ? '正在打开…' : '打开文件夹' }}</button></div>
      </div>
      <footer><button v-if="exporting" :disabled="cancelling" @click="cancel">{{ cancelling ? '正在取消' : '取消导出' }}</button><button v-else @click="emit('close')">关闭</button><button class="primary" :disabled="!valid || exporting" data-testid="start-export" @click="start"><Icon name="export" :size="16"/>{{ exporting ? '正在导出' : '开始导出' }}</button></footer>
    </section>
  </div>
</template>

<style scoped>
.export-dialog{width:480px}.export-progress{display:grid;gap:8px;font-size:12px;color:var(--ui-muted);margin-top:20px}.success-message{display:flex;gap:8px;align-items:flex-start;overflow-wrap:anywhere;font-size:12px;color:var(--ui-success)}
.export-stage,.export-fallback{overflow-wrap:anywhere;line-height:1.6}.export-fallback{color:var(--ui-muted)}.export-completion{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:16px;font-size:11px;color:var(--ui-muted)}.export-completion .success-message,.export-completion .export-fallback{flex-basis:100%;margin:0}.export-completion button{font-size:11px}.export-progress [role=timer],.export-completion>span{font-variant-numeric:tabular-nums}.form-grid input[readonly]{color:var(--ui-muted);background:var(--ui-surface-2);cursor:text}
.export-output-progress{display:grid;gap:3px;line-height:1.5;font-variant-numeric:tabular-nums}.export-output-hint{font-size:11px;overflow-wrap:anywhere}
</style>
