<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { microphoneRecordingErrorMessage, startMicrophoneRecording, type MicrophoneRecording, type RecordedMicrophoneAudio } from '../core/microphone-recording'
import { downloadBlob } from '../core/media-import'
import { isDesktop, saveBytes } from '../native'
import Icon from './Icon.vue'

const props = defineProps<{
  projectId: string
  start: number
  disabled?: boolean
  save: (audio: RecordedMicrophoneAudio, start: number, projectId: string) => Promise<void>
}>()
const emit = defineEmits<{ busy: [value: boolean]; status: [message: string]; release: [audio: RecordedMicrophoneAudio] }>()
const phase = ref<'idle' | 'requesting' | 'recording' | 'saving' | 'recovery'>('idle')
const elapsed = ref(0), error = ref(''), downloading = ref(false)
const label = computed(() => ({ idle: '开始录音', requesting: '取消麦克风授权', recording: '停止录音', saving: '正在保存录音', recovery: '重试添加录音' }[phase.value]))
const time = computed(() => `${Math.floor(elapsed.value / 60).toString().padStart(2, '0')}:${Math.floor(elapsed.value % 60).toString().padStart(2, '0')}`)
let controller: MicrophoneRecording | undefined
let request: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
let generation = 0
let destroyed = false
let pending: { audio: RecordedMicrophoneAudio; start: number; projectId: string } | undefined

function report(cause: unknown): void {
  error.value = microphoneRecordingErrorMessage(cause)
  emit('status', error.value)
}
function clearClock(): void { clearInterval(timer); timer = undefined }
function idle(): void { clearClock(); controller = undefined; request = undefined; phase.value = 'idle'; emit('busy', false) }
function discard(): void {
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
  if (props.disabled || phase.value !== 'idle') return
  const token = ++generation, start = props.start, projectId = props.projectId
  const abort = new AbortController()
  request = abort; error.value = ''; elapsed.value = 0
  phase.value = 'requesting'; emit('busy', true)
  try {
    const recording = await startMicrophoneRecording({ signal: abort.signal })
    if (destroyed || token !== generation) { recording.cancel(); return }
    controller = recording
    phase.value = 'recording'
    timer = setInterval(() => { elapsed.value = recording.elapsed }, 100)
    void recording.finished.then(async audio => {
      if (destroyed || token !== generation) return
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
onBeforeUnmount(() => { destroyed = true; discard() })
</script>

<template>
  <span class="voice-recorder" :class="{ 'is-recording': phase === 'recording' }">
    <button type="button" class="voice-record-button" :disabled="phase === 'idle' && disabled || phase === 'saving' || downloading" :title="label" :aria-label="label" :aria-pressed="phase === 'recording'" :aria-busy="phase === 'requesting' || phase === 'saving'" data-testid="preview-record" @click="toggle"><Icon :name="phase === 'recording' ? 'stop' : phase === 'requesting' ? 'close' : phase === 'saving' ? 'clock' : phase === 'recovery' ? 'refresh' : 'mic'" :size="18" /></button>
    <span v-if="phase !== 'idle'" class="voice-record-time" data-testid="preview-record-status" :title="phase === 'requesting' ? '等待麦克风授权，可点击取消' : phase === 'saving' ? '正在添加录音' : '录音时长'">{{ phase === 'requesting' ? '等待授权' : phase === 'saving' ? '正在添加…' : time }}</span>
    <template v-if="phase === 'recovery'"><button type="button" :disabled="downloading" title="保存录音文件" aria-label="保存录音文件" @click="download"><Icon name="download" :size="16" /></button><button type="button" :disabled="downloading" title="放弃这段录音" aria-label="放弃这段录音" @click="discard"><Icon name="close" :size="16" /></button></template>
    <span v-if="error" class="voice-record-error" role="alert" :title="error" data-testid="preview-record-error">{{ error }}</span>
  </span>
</template>

<style scoped>
.voice-recorder{display:inline-flex;align-items:center;justify-content:center;gap:6px;position:relative}
.voice-record-button{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;min-width:34px;padding:0;border:1px solid var(--ed-border);border-radius:50%;background:var(--ed-panel);color:var(--ed-text)}
.voice-record-button:hover:not(:disabled){border-color:#dc5664;color:#dc5664}
.is-recording .voice-record-button{background:#d83d50;color:#fff;border-color:#d83d50}
.voice-record-time{font-size:10px;font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--ed-muted)}
.is-recording .voice-record-time{color:#d83d50}
.voice-record-error{position:absolute;top:calc(100% + 5px);left:50%;transform:translateX(-50%);z-index:2;max-width:min(300px,65vw);width:max-content;padding:5px 8px;border-radius:5px;background:var(--ed-panel);border:1px solid var(--ed-border);color:#d83d50;font-size:10px;line-height:1.5;white-space:normal;box-shadow:0 2px 8px #0001}
@media(max-width:600px){.voice-record-button{width:28px;height:28px;min-width:28px}}
</style>
