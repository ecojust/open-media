<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import RecordingToolbar from './RecordingToolbar.vue'
import type { CaptureControlAction, CaptureControlsSnapshot } from '../core/capture-controls'
import { captureControlsReady, onCaptureControlsState, requestCaptureControlAction } from '../native'

const snapshot = ref<CaptureControlsSnapshot>({ phase: 'starting', elapsed: 0, muted: false, audioAvailable: false, busy: true })
const receivedAt = ref(performance.now()), now = ref(receivedAt.value)
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
  if (snapshot.value.busy) return
  snapshot.value = { ...snapshot.value, busy: true }
  try { await requestCaptureControlAction(value) }
  catch (cause) { if (!disposed) snapshot.value = { ...snapshot.value, busy: false, error: String(cause) } }
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

<template><RecordingToolbar :snapshot="displayed" @action="action" /></template>

<style>
html[data-recording-controls],html[data-recording-controls] body,html[data-recording-controls] #app{margin:0!important;padding:0!important;width:100%;height:100%;min-width:0!important;min-height:0!important;overflow:hidden!important;background:transparent!important}
</style>
