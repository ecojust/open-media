<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { microphoneRecordingErrorMessage, startMicrophoneRecording, type MicrophoneRecording, type RecordedMicrophoneAudio } from '../core/microphone-recording'
import { authorizeBrowserMicrophones, listBrowserMicrophones, readMicrophonePreference, writeMicrophonePreference, type BrowserMicrophoneDevice } from '../core/microphone-devices'
import { downloadBlob } from '../core/media-import'
import { isDesktop, saveBytes } from '../native'
import Icon from './Icon.vue'

const props = defineProps<{
  projectId: string
  start: number
  disabled?: boolean
  save: (audio: RecordedMicrophoneAudio, start: number, projectId: string) => Promise<void>
}>()
const emit = defineEmits<{ busy: [value: boolean]; status: [message: string]; release: [audio: RecordedMicrophoneAudio]; started: [start: number, projectId: string, elapsed: () => number]; stopped: [] }>()
const phase = ref<'idle' | 'requesting' | 'recording' | 'saving' | 'recovery'>('idle')
const elapsed = ref(0), error = ref(''), downloading = ref(false)
const sourcePreference = ref(readMicrophonePreference('editor'))
const sourceDevices = ref<BrowserMicrophoneDevice[]>([])
const sourceOpen = ref(false), sourceLoading = ref(false), sourceBusy = ref(false), sourceError = ref('')
const sourceNeedsPermission = ref(true), sourcesLoaded = ref(false)
const sourceTrigger = ref<HTMLButtonElement>(), sourcePanel = ref<HTMLElement>()
const sourcePosition = ref({ left: '8px', top: '8px' })
const sourceName = computed(() => sourcePreference.value.deviceId ? sourceDevices.value.find(device => device.id === sourcePreference.value.deviceId)?.name || sourcePreference.value.name || '所选麦克风' : '系统默认麦克风')
const sourceMissing = computed(() => !!sourcePreference.value.deviceId && sourcesLoaded.value && !sourceNeedsPermission.value && !sourceDevices.value.some(device => device.id === sourcePreference.value.deviceId))
const label = computed(() => ({ idle: '开始录音', requesting: '取消麦克风授权', recording: '停止录音', saving: '正在保存录音', recovery: '重试添加录音' }[phase.value]))
const time = computed(() => `${Math.floor(elapsed.value / 60).toString().padStart(2, '0')}:${Math.floor(elapsed.value % 60).toString().padStart(2, '0')}`)
let controller: MicrophoneRecording | undefined
let request: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
let generation = 0
let destroyed = false
let pending: { audio: RecordedMicrophoneAudio; start: number; projectId: string } | undefined
let recordingActive = false
let sourceRequest: AbortController | undefined
let sourceGeneration = 0

async function refreshSources(): Promise<void> {
  const token = ++sourceGeneration
  sourceLoading.value = true
  sourceError.value = ''
  try {
    const result = await listBrowserMicrophones()
    if (destroyed || token !== sourceGeneration) return
    sourceDevices.value = result.devices
    sourceNeedsPermission.value = result.permissionRequired
    sourcesLoaded.value = true
    const selected = result.devices.find(device => device.id === sourcePreference.value.deviceId)
    if (selected && selected.name !== sourcePreference.value.name) {
      sourcePreference.value = { deviceId: selected.id, name: selected.name }
      writeMicrophonePreference('editor', sourcePreference.value)
    }
  } catch (cause) {
    if (!destroyed && token === sourceGeneration) sourceError.value = microphoneRecordingErrorMessage(cause)
  } finally { if (!destroyed && token === sourceGeneration) sourceLoading.value = false }
}
function chooseSource(event: Event): void {
  const deviceId = (event.target as HTMLSelectElement).value
  sourcePreference.value = { deviceId, name: sourceDevices.value.find(device => device.id === deviceId)?.name || '' }
  writeMicrophonePreference('editor', sourcePreference.value)
  error.value = ''; sourceError.value = ''
}
function closeSources(): void {
  sourceOpen.value = false
  sourceRequest?.abort(); sourceRequest = undefined
  if (sourceBusy.value) { sourceBusy.value = false; if (phase.value === 'idle') emit('busy', false) }
}
async function toggleSources(): Promise<void> {
  if (sourceOpen.value) { closeSources(); return }
  if (props.disabled || phase.value !== 'idle') return
  sourceOpen.value = true
  await nextTick()
  placeSources()
  void refreshSources()
}
function placeSources(): void {
  if (!sourceOpen.value || !sourceTrigger.value || !sourcePanel.value) return
  const anchor = sourceTrigger.value.getBoundingClientRect(), bounds = sourcePanel.value.getBoundingClientRect()
  sourcePosition.value = {
    left: `${Math.max(8, Math.min(window.innerWidth - bounds.width - 8, anchor.right - bounds.width))}px`,
    top: `${Math.max(8, Math.min(window.innerHeight - bounds.height - 8, anchor.top - bounds.height - 8))}px`,
  }
}
async function authorizeSources(): Promise<void> {
  if (sourceBusy.value || sourceLoading.value || props.disabled || phase.value !== 'idle') return
  if (!sourceNeedsPermission.value) { await refreshSources(); return }
  const abort = new AbortController()
  sourceRequest = abort; sourceBusy.value = true; sourceError.value = ''
  emit('busy', true)
  try {
    await authorizeBrowserMicrophones(abort.signal)
    if (destroyed || sourceRequest !== abort) return
    await refreshSources()
  } catch (cause) {
    if (!destroyed && sourceRequest === abort && !abort.signal.aborted) sourceError.value = microphoneRecordingErrorMessage(cause)
  } finally {
    if (sourceRequest === abort) { sourceRequest = undefined; sourceBusy.value = false; emit('busy', false) }
  }
}
function outsideSources(event: PointerEvent): void {
  if (sourceOpen.value && event.target instanceof Node && !sourceTrigger.value?.contains(event.target) && !sourcePanel.value?.contains(event.target)) closeSources()
}
function sourceEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && sourceOpen.value) { event.stopPropagation(); closeSources(); sourceTrigger.value?.focus() }
}

function report(cause: unknown): void {
  error.value = microphoneRecordingErrorMessage(cause)
  emit('status', error.value)
}
function clearClock(): void { clearInterval(timer); timer = undefined }
function stopPlayback(): void { if (recordingActive) { recordingActive = false; emit('stopped') } }
function idle(): void { stopPlayback(); clearClock(); controller = undefined; request = undefined; phase.value = 'idle'; emit('busy', false) }
function discard(): void {
  closeSources()
  stopPlayback()
  generation++
  request?.abort()
  controller?.cancel()
  if (pending) emit('release', pending.audio)
  pending = undefined
  error.value = ''
  elapsed.value = 0
  idle()
}
async function savePending(): Promise<void> {
  const result = pending, token = generation
  if (!result || downloading.value) return
  phase.value = 'saving'; error.value = ''
  try {
    await props.save(result.audio, result.start, result.projectId)
    if (destroyed || token !== generation) return
    emit('release', result.audio)
    pending = undefined
    idle()
    emit('status', '录音已添加到配音轨道。')
  } catch (cause) {
    if (destroyed || token !== generation) return
    phase.value = 'recovery'
    report(cause)
  }
}
async function begin(): Promise<void> {
  if (props.disabled || phase.value !== 'idle' || sourceBusy.value) return
  closeSources()
  if (sourceMissing.value) { report(new DOMException('所选麦克风不可用', 'OverconstrainedError')); return }
  const token = ++generation, start = props.start, projectId = props.projectId
  const abort = new AbortController()
  request = abort; error.value = ''; elapsed.value = 0
  phase.value = 'requesting'; emit('busy', true)
  try {
    const recording = await startMicrophoneRecording({ signal: abort.signal, deviceId: sourcePreference.value.deviceId })
    if (destroyed || token !== generation) { recording.cancel(); return }
    controller = recording
    phase.value = 'recording'
    recordingActive = true; emit('started', start, projectId, () => recording.elapsed)
    void refreshSources()
    timer = setInterval(() => { elapsed.value = recording.elapsed }, 100)
    void recording.finished.then(async audio => {
      if (destroyed || token !== generation) return
      stopPlayback()
      elapsed.value = recording.elapsed
      clearClock(); controller = undefined; request = undefined
      pending = { audio, start, projectId }
      await savePending()
    }, cause => {
      if (destroyed || token !== generation) return
      idle()
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) report(cause)
    })
  } catch (cause) {
    if (destroyed || token !== generation) return
    idle()
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) report(cause)
  }
}
function toggle(): void {
  if (phase.value === 'requesting') { discard(); return }
  if (phase.value === 'recording' && controller) {
    stopPlayback()
    elapsed.value = controller.elapsed
    phase.value = 'saving'; clearClock()
    void controller.stop().catch(() => {})
    return
  }
  if (phase.value === 'recovery') { void savePending(); return }
  if (phase.value === 'idle') void begin()
}
async function download(): Promise<void> {
  const result = pending, token = generation
  if (!result || downloading.value) return
  downloading.value = true
  try {
    if (isDesktop()) {
      const path = await saveBytes(result.audio.name, new Uint8Array(await result.audio.blob.arrayBuffer()))
      if (!path) return
    } else downloadBlob(result.audio.blob, result.audio.name)
    if (destroyed || token !== generation) return
    discard()
    emit('status', '录音文件已保存，可重新导入剪辑。')
  } catch (cause) { if (!destroyed && token === generation) report(cause) }
  finally { downloading.value = false }
}
watch(() => props.projectId, discard, { flush: 'sync' })
watch([sourceDevices, sourceBusy, sourceError], () => { void nextTick(placeSources) })
onMounted(() => {
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshSources)
  document.addEventListener('pointerdown', outsideSources)
  document.addEventListener('keydown', sourceEscape, true)
  window.addEventListener('resize', placeSources)
})
onBeforeUnmount(() => {
  destroyed = true; sourceGeneration++; discard()
  navigator.mediaDevices?.removeEventListener?.('devicechange', refreshSources)
  document.removeEventListener('pointerdown', outsideSources)
  document.removeEventListener('keydown', sourceEscape, true)
  window.removeEventListener('resize', placeSources)
})
</script>

<template>
  <span class="voice-recorder" :class="{ 'is-recording': phase === 'recording' }">
    <button type="button" class="voice-record-button" :disabled="phase === 'idle' && disabled || phase === 'saving' || downloading || sourceBusy" :title="`${label} · ${sourceName}`" :aria-label="label" :aria-pressed="phase === 'recording'" :aria-busy="phase === 'requesting' || phase === 'saving'" data-testid="preview-record" @click="toggle"><Icon :name="phase === 'recording' ? 'stop' : phase === 'requesting' ? 'close' : phase === 'saving' ? 'clock' : phase === 'recovery' ? 'refresh' : 'mic'" :size="18" /></button>
    <button ref="sourceTrigger" type="button" class="voice-source-button" :class="{ 'is-unavailable': sourceMissing }" :disabled="phase !== 'idle' || disabled" :title="`麦克风来源：${sourceName}${sourceMissing ? '（已断开）' : ''}`" aria-label="选择录音麦克风" aria-haspopup="dialog" :aria-expanded="sourceOpen" data-testid="preview-record-source" @click="toggleSources"><Icon name="chevron-down" :size="13" /></button>
    <span v-if="phase !== 'idle'" class="voice-record-time" data-testid="preview-record-status" :title="phase === 'requesting' ? '等待麦克风授权，可点击取消' : phase === 'saving' ? '正在添加录音' : '录音时长'">{{ phase === 'requesting' ? '等待授权' : phase === 'saving' ? '正在添加…' : time }}</span>
    <template v-if="phase === 'recovery'"><button type="button" :disabled="downloading" title="保存录音文件" aria-label="保存录音文件" @click="download"><Icon name="download" :size="16" /></button><button type="button" :disabled="downloading" title="放弃这段录音" aria-label="放弃这段录音" @click="discard"><Icon name="close" :size="16" /></button></template>
    <span v-if="error" class="voice-record-error" role="alert" :title="error" data-testid="preview-record-error">{{ error }}</span>
    <Teleport to="body">
      <div v-if="sourceOpen" ref="sourcePanel" class="voice-source-panel" :style="sourcePosition" role="dialog" aria-label="选择录音麦克风" data-testid="preview-record-source-panel">
        <header><strong>麦克风来源</strong><button type="button" aria-label="关闭麦克风来源" title="关闭" @click="closeSources"><Icon name="close" :size="15" /></button></header>
        <select :value="sourcePreference.deviceId" :disabled="sourceBusy || sourceLoading" aria-label="录音麦克风来源" data-testid="preview-record-device" @change="chooseSource">
          <option value="">系统默认麦克风</option>
          <option v-if="sourcePreference.deviceId && !sourceDevices.some(device => device.id === sourcePreference.deviceId)" :value="sourcePreference.deviceId">{{ sourceName }}{{ sourceMissing ? '（已断开）' : '（待确认）' }}</option>
          <option v-for="device in sourceDevices" :key="device.id" :value="device.id">{{ device.name }}</option>
        </select>
        <p v-if="sourceMissing" class="source-warning" role="alert">所选麦克风已断开，请重新连接或选择其他来源。</p>
        <p v-else-if="sourceNeedsPermission">允许麦克风访问后，可显示设备名称并选择来源。</p>
        <p v-else>录音使用此来源，选择会自动记住。</p>
        <p v-if="sourceError" class="source-warning" role="alert">{{ sourceError }}</p>
        <footer><button type="button" :disabled="sourceBusy || sourceLoading" data-testid="preview-record-source-refresh" @click="authorizeSources"><Icon :name="sourceBusy || sourceLoading ? 'clock' : 'refresh'" :size="14" />{{ sourceBusy ? '等待授权…' : sourceLoading ? '正在读取…' : sourceNeedsPermission ? '授权并刷新' : '刷新设备' }}</button><button v-if="sourceBusy" type="button" @click="closeSources">取消</button></footer>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.voice-recorder{display:inline-flex;align-items:center;justify-content:center;gap:6px;position:relative}
.voice-record-button{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;min-width:34px;padding:0;border:1px solid var(--ed-border);border-radius:50%;background:var(--ed-panel);color:var(--ed-text)}
.voice-record-button:hover:not(:disabled){border-color:#dc5664;color:#dc5664}
.voice-source-button{display:inline-flex;align-items:center;justify-content:center;width:19px;min-width:19px;min-height:28px;padding:0;margin-left:-4px;color:var(--ed-muted);background:transparent;border:0;border-radius:5px;cursor:pointer}
.voice-source-button.is-unavailable{color:#d83d50}.voice-source-button:disabled{opacity:.4;cursor:not-allowed}
.voice-source-panel{position:fixed;z-index:100;width:270px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;box-sizing:border-box;padding:12px;background:var(--ui-surface,#fff);color:var(--ui-text,#202638);border:1px solid var(--ui-line,#e3e6ed);border-radius:9px;box-shadow:0 8px 30px #0003;font-size:12px}
.voice-source-panel header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:9px}.voice-source-panel header strong{font-size:12px;font-weight:600}
.voice-source-panel button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:28px;padding:4px 7px;border:1px solid var(--ui-line,#e3e6ed);border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:pointer}.voice-source-panel header button{border:0;padding:3px;min-height:24px}.voice-source-panel button:disabled{opacity:.5;cursor:not-allowed}.voice-source-panel button:hover:not(:disabled){color:var(--ui-accent,#3267f6);background:var(--ui-accent-soft,#edf2ff)}
.voice-source-panel select{width:100%}.voice-source-panel p{font-size:11px;line-height:1.6;color:var(--ui-muted,#858b9a);margin:8px 0;overflow-wrap:anywhere}.voice-source-panel p.source-warning{color:#d83d50}.voice-source-panel footer{display:flex;align-items:center;gap:6px;justify-content:flex-end;margin-top:9px}
.is-recording .voice-record-button{background:#d83d50;color:#fff;border-color:#d83d50}
.voice-record-time{font-size:10px;font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--ed-muted)}
.is-recording .voice-record-time{color:#d83d50}
.voice-record-error{position:absolute;top:calc(100% + 5px);left:50%;transform:translateX(-50%);z-index:2;max-width:min(300px,65vw);width:max-content;padding:5px 8px;border-radius:5px;background:var(--ed-panel);border:1px solid var(--ed-border);color:#d83d50;font-size:10px;line-height:1.5;white-space:normal;box-shadow:0 2px 8px #0001}
@media(max-width:600px){.voice-record-button{width:28px;height:28px;min-width:28px}}
</style>
