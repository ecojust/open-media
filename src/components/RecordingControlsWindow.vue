<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import RecordingToolbar from './RecordingToolbar.vue'
import Icon from './Icon.vue'
import type { CaptureControlAction, CaptureControlsSnapshot } from '../core/capture-controls'
import { captureControlsReady, onCaptureControlsState, requestCaptureControlAction } from '../native'

const snapshot = ref<CaptureControlsSnapshot>({ phase: 'starting', elapsed: 0, muted: false, audioAvailable: false, microphoneEnabled: false, busy: true })
const receivedAt = ref(performance.now()), now = ref(receivedAt.value)
const cancelling = ref(false)
const displayed = computed<CaptureControlsSnapshot>(() => ({ ...snapshot.value, elapsed: snapshot.value.elapsed + (snapshot.value.phase === 'recording' ? Math.max(0, now.value - receivedAt.value) / 1000 : 0) }))
let disposed = false, unlisten: (() => void) | undefined
let revision = 0
let timer: ReturnType<typeof setInterval> | undefined
function receive(value: CaptureControlsSnapshot): void {
  if (disposed) return
  receivedAt.value = performance.now(); now.value = receivedAt.value
  snapshot.value = value
}
async function action(value: CaptureControlAction): Promise<void> {
  const cancelStart = value === 'stop' && snapshot.value.phase === 'starting'
  if (cancelling.value || snapshot.value.busy && !(value === 'stop' && (snapshot.value.microphonePending || cancelStart))) return
  if (cancelStart) cancelling.value = true
  snapshot.value = { ...snapshot.value, busy: true }
  try { await requestCaptureControlAction(value) }
  catch (cause) { if (!disposed) { cancelling.value = false; snapshot.value = { ...snapshot.value, busy: false, error: String(cause) } } }
}
onMounted(async () => {
  // Keep the visible clock moving when the main workspace is in the background.
  // Native state updates remain authoritative; paused time is never accumulated.
  timer = setInterval(() => { now.value = performance.now() }, 250)
  try {
    const stop = await onCaptureControlsState(value => { revision++; receive(value) })
    if (disposed) { stop(); return }
    unlisten = stop
    const requestedAt = revision
    const initial = await captureControlsReady()
    if (!disposed && revision === requestedAt) receive(initial)
  } catch (cause) { if (!disposed) snapshot.value = { ...snapshot.value, error: String(cause) } }
})
onBeforeUnmount(() => { disposed = true; clearInterval(timer); unlisten?.() })
</script>

<template>
  <div v-if="snapshot.phase === 'starting'" class="recording-countdown" data-testid="recording-countdown" aria-live="assertive">
    <span class="countdown-caption">{{ snapshot.countdown ? '即将开始录制' : '正在准备录制' }}</span>
    <strong v-if="snapshot.countdown" class="countdown-number">{{ snapshot.countdown }}</strong>
    <Icon v-else name="refresh" :size="40" class="countdown-spinner" />
    <button type="button" :disabled="cancelling" @click="action('stop')"><Icon name="close" :size="14" />{{ cancelling ? '正在取消' : '取消录制' }}</button>
    <span v-if="snapshot.error" class="countdown-error" role="alert">{{ snapshot.error }}</span>
  </div>
  <RecordingToolbar v-else :snapshot="displayed" @action="action" />
</template>

<style>
html[data-recording-controls],html[data-recording-controls] body,html[data-recording-controls] #app{margin:0!important;padding:0!important;width:100%;height:100%;min-width:0!important;min-height:0!important;overflow:hidden!important;background:transparent!important}
.recording-countdown{box-sizing:border-box;position:relative;width:100%;height:100%;display:grid;place-items:center;background:#181d29e8;border:1px solid #f0647280;border-radius:24px;color:#fff;user-select:none;font-family:system-ui,sans-serif}.countdown-caption{position:absolute;top:16px;font-size:12px;color:#e2e6ef}.countdown-number{font-size:72px;line-height:1;font-variant-numeric:tabular-nums}.recording-countdown button{position:absolute;bottom:12px;display:flex;align-items:center;gap:5px;background:#ffffff16;border:1px solid #ffffff30;border-radius:7px;color:#fff;padding:6px 10px;font-size:12px;cursor:pointer}.recording-countdown button:disabled{opacity:.6;cursor:default}.recording-countdown button:hover:not(:disabled){background:#ffffff2b}.recording-countdown button:focus-visible{outline:2px solid #fff;outline-offset:2px}.countdown-spinner{animation:countdown-spin 1.2s linear infinite}.countdown-error{position:absolute;inset:38px 8px 48px;display:grid;place-items:center;background:#181d29;font-size:11px;line-height:1.5;color:#ffb5be;text-align:center}@keyframes countdown-spin{to{transform:rotate(360deg)}}
</style>
