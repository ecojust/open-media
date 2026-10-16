<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Icon from './Icon.vue'
import CaptureSelectionOverlay from './CaptureSelectionOverlay.vue'
import ScreenshotControls from './ScreenshotControls.vue'
import RuntimeCheck from './RuntimeCheck.vue'
import type { CaptureSelectionContext, CaptureSelection as OverlaySelection } from '../core/capture-selection'
import type { MediaAsset } from '../core/types'
import { browserCaptureAvailable, captureErrorMessage, startBrowserCapture, type BrowserCapture, type BrowserCaptureSelectionRequest } from '../core/capture'
import { cancelCapturePicker, cancelCaptureStart, getCaptureStatus, pauseCapture, pickCaptureSource, resumeCapture, startCapture, stopCapture, type CaptureSelection, type CapturePickerPreferences, type CaptureStatus } from '../native'

const props = withDefaults(defineProps<{ assets: MediaAsset[]; native: boolean; screenshotShortcut?: string | null; screenshotBusy?: boolean; screenshotDisabled?: boolean; screenshotError?: string; screenshotConfiguring?: boolean }>(), { screenshotShortcut: null, screenshotBusy: false, screenshotDisabled: false, screenshotError: '', screenshotConfiguring: false })
const emit = defineEmits<{ captured: [blob: Blob, name: string]; asset: [asset: MediaAsset]; status: [message: string]; 'add-to-timeline': [assetId: string]; 'recording-change': [active: boolean]; screenshot: []; 'screenshot-shortcut-change': [shortcut: string | null] }>()
const phase = ref<'idle' | 'selecting' | 'starting' | 'recording' | 'paused' | 'stopping'>('idle')
const elapsed = ref(0)
const fps = ref(30)
const microphone = ref(false)
const systemAudio = ref(true)
const countdown = ref(3)
const remaining = ref(0)
const error = ref('')
const selection = ref<CaptureSelection>()
const pickerPreferences = ref<CapturePickerPreferences>({ mode: 'region' })
const sourceType = computed(() => selection.value?.region ? 'region' : selection.value?.sourceId.startsWith('window:') ? 'window' : 'screen')
const browserPicker = shallowRef<{ context: CaptureSelectionContext; stream: MediaStream }>()
let finishBrowserChoice: ((selection: OverlaySelection | null) => void) | undefined
const actualSource = ref<{ label: string; width: number; height: number; outputWidth: number; outputHeight: number }>()
const preview = ref<HTMLVideoElement | null>(null)
const finishedUrl = ref('')
const latestName = ref('')
const capturedCount = ref(0)
let controller: BrowserCapture | undefined
let startAbort: AbortController | undefined
let clock: ReturnType<typeof setInterval> | undefined
let polling = false
let nativeStateVersion = 0
let recoveryError = ''
let destroyed = false
const active = computed(() => phase.value !== 'idle')
watch(active, value => emit('recording-change', value), { flush: 'sync' })
const liveBorder = computed(() => !props.native && (phase.value === 'recording' || phase.value === 'paused'))
const clockLabel = computed(() => {
  const value = Math.floor(elapsed.value)
  return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
})
const phaseLabel = computed(() => ({ idle: '准备录制', selecting: '正在选择录制范围', starting: remaining.value ? `${remaining.value} 秒后开始` : '正在准备', recording: '正在录制', paused: '已暂停', stopping: '正在保存录制' })[phase.value])
const recentVideos = computed(() => props.assets.filter(item => item.kind === 'video').slice(-4).reverse())

function clearPreview(): void {
  if (finishedUrl.value) URL.revokeObjectURL(finishedUrl.value)
  finishedUrl.value = ''
  if (preview.value) { preview.value.pause(); preview.value.srcObject = null; preview.value.removeAttribute('src'); preview.value.load() }
}
function finished(blob: Blob, name: string): void {
  phase.value = 'idle'
  remaining.value = 0
  controller = undefined
  emit('captured', blob, name)
  capturedCount.value++
  latestName.value = name
  clearPreview()
  if (destroyed) return
  finishedUrl.value = URL.createObjectURL(blob)
  void nextTick(() => { if (preview.value) { preview.value.srcObject = null; preview.value.src = finishedUrl.value; preview.value.muted = false } })
}
function updateNativeSource(status: CaptureStatus): void {
  const selected = selection.value
  const previous = actualSource.value
  const width = status.sourceWidth ?? selected?.sourceWidth ?? previous?.width ?? 0
  const height = status.sourceHeight ?? selected?.sourceHeight ?? previous?.height ?? 0
  const target = status.outputSize ?? selected?.outputSize ?? selected?.region ?? { width, height }
  actualSource.value = { label: status.sourceName ?? selected?.sourceName ?? previous?.label ?? '录制来源', width, height, outputWidth: target.width, outputHeight: target.height }
}
function connectPickerPreview(element: unknown): void {
  if (!(element instanceof HTMLVideoElement) || !browserPicker.value) return
  element.srcObject = browserPicker.value.stream
  void element.play().catch(() => {})
}
function chooseBrowserSource(request: BrowserCaptureSelectionRequest): Promise<OverlaySelection | null> {
  const { source, stream, signal } = request
  const sourceId = source.type === 'screen' ? 'screen:browser' : 'window:browser'
  const mode = source.type === 'screen' ? 'region' : 'window'
  const width = source.width, height = source.height
  return new Promise(resolve => {
    const complete = (chosen: OverlaySelection | null) => {
      signal.removeEventListener('abort', cancel)
      browserPicker.value = undefined
      finishBrowserChoice = undefined
      if (chosen) {
        selection.value = { ...chosen, sourceName: source.label, sourceWidth: width, sourceHeight: height }
        pickerPreferences.value = { mode: chosen.region ? 'region' : source.type === 'screen' ? 'screen' : 'window', ...(chosen.outputSize ? { outputSize: chosen.outputSize } : {}) }
        phase.value = 'starting'
      }
      resolve(chosen)
    }
    const cancel = () => complete(null)
    finishBrowserChoice = complete
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted || destroyed) { cancel(); return }
    browserPicker.value = {
      stream,
      context: {
        requestId: crypto.randomUUID(), displayId: sourceId,
        display: { id: sourceId, name: source.label, logicalWidth: width, logicalHeight: height, pixelWidth: width, pixelHeight: height },
        targets: [{ id: sourceId, name: source.label, kind: source.type === 'screen' ? 'screen' : 'window', rect: { x: 0, y: 0, width, height }, sourceWidth: width, sourceHeight: height }],
        availableModes: source.type === 'screen' ? ['region', 'screen'] : ['window'],
        preferences: { mode, sourceId, outputSize: pickerPreferences.value.outputSize },
      },
    }
  })
}
async function begin(): Promise<void> {
  if (active.value || props.screenshotBusy) return
  error.value = ''
  recoveryError = ''
  actualSource.value = undefined
  elapsed.value = 0
  phase.value = 'selecting'
  nativeStateVersion++
  const abort = new AbortController()
  startAbort = abort
  clearPreview()
  let nativeStarted = false
  try {
    if (props.native) {
      const requestId = crypto.randomUUID()
      const cancelPicker = () => { void cancelCapturePicker(requestId).catch(() => {}) }
      abort.signal.addEventListener('abort', cancelPicker, { once: true })
      let chosen: CaptureSelection | null
      try { chosen = await pickCaptureSource(requestId, pickerPreferences.value) }
      finally { abort.signal.removeEventListener('abort', cancelPicker) }
      if (!chosen || destroyed || abort.signal.aborted) { phase.value = 'idle'; return }
      selection.value = chosen
      pickerPreferences.value = { mode: sourceType.value, sourceId: chosen.sourceId, ...(chosen.outputSize ? { outputSize: chosen.outputSize } : {}) }
      phase.value = 'starting'
      for (let count = countdown.value; count > 0; count--) {
        if (abort.signal.aborted) throw new DOMException('已取消录制。', 'AbortError')
        remaining.value = count
        await new Promise<void>(resolve => setTimeout(resolve, 1000))
      }
      remaining.value = 0
      if (abort.signal.aborted) throw new DOMException('已取消录制。', 'AbortError')
      const cancelPendingStart = () => { void cancelCaptureStart(requestId).catch(() => {}) }
      abort.signal.addEventListener('abort', cancelPendingStart, { once: true })
      let result: CaptureStatus
      try {
        result = await startCapture({ requestId, fps: fps.value, microphone: microphone.value, sourceId: chosen.sourceId, ...(chosen.region ? { region: chosen.region } : {}), ...(chosen.outputSize ? { outputSize: chosen.outputSize } : {}) })
      } finally { abort.signal.removeEventListener('abort', cancelPendingStart) }
      nativeStarted = true
      updateNativeSource(result)
      if (destroyed || abort.signal.aborted) { const asset = await stopCapture(); if (asset) emit('asset', asset); phase.value = 'idle'; return }
      phase.value = result.state === 'paused' ? 'paused' : 'recording'
      elapsed.value = result.elapsed
    } else {
      controller = await startBrowserCapture({
        fps: fps.value, microphone: microphone.value, systemAudio: systemAudio.value, chooseSource: chooseBrowserSource,
        countdown: countdown.value, signal: abort.signal,
        onCountdown: value => { remaining.value = value; phase.value = 'starting' },
        onFinished: result => finished(result.blob, result.name),
        onError: cause => { error.value = captureErrorMessage(cause) },
        onPhase: value => { if (value === 'paused' || value === 'recording') phase.value = value; else if (phase.value !== 'stopping') phase.value = 'idle' },
      })
      if (destroyed || abort.signal.aborted) { await controller.stop(); return }
      actualSource.value = { ...controller.source }
      phase.value = 'recording'
      await nextTick()
      if (preview.value) { preview.value.muted = true; preview.value.srcObject = controller.stream; await preview.value.play().catch(() => {}) }
    }
  } catch (cause) {
    remaining.value = 0
    if (nativeStarted) await recoverNativeStop(cause)
    else { error.value = abort.signal.aborted || cause instanceof DOMException && cause.name === 'AbortError' ? '' : captureErrorMessage(cause); phase.value = 'idle' }
  } finally { if (startAbort === abort) startAbort = undefined }
}
async function recoverNativeStop(cause: unknown): Promise<void> {
  const originalError = captureErrorMessage(cause)
  recoveryError = originalError
  error.value = originalError
  try {
    const status = await getCaptureStatus()
    if (destroyed) return
    updateNativeSource(status)
    elapsed.value = status.elapsed
    phase.value = status.state === 'idle' || status.state === 'recording' ? status.state : 'paused'
  } catch {
    if (!destroyed) phase.value = 'paused'
  }
  error.value = originalError
}
async function pauseOrResume(): Promise<void> {
  if (phase.value !== 'paused' && phase.value !== 'recording') return
  const version = ++nativeStateVersion
  try {
    if (props.native) { const result = phase.value === 'paused' ? await resumeCapture() : await pauseCapture(); if (version !== nativeStateVersion || destroyed) return; updateNativeSource(result); phase.value = result.state === 'paused' ? 'paused' : 'recording'; elapsed.value = result.elapsed; recoveryError = ''; error.value = result.error ?? '' }
    else if (phase.value === 'paused') controller?.resume()
    else controller?.pause()
  } catch (cause) { error.value = captureErrorMessage(cause) }
}
async function stop(): Promise<void> {
  if (phase.value === 'selecting' || phase.value === 'starting') { startAbort?.abort(); return }
  if (phase.value !== 'recording' && phase.value !== 'paused') return
  nativeStateVersion++
  phase.value = 'stopping'
  try {
    if (props.native) {
      const asset = await stopCapture()
      if (asset) {
        emit('asset', asset)
        latestName.value = asset.name
        capturedCount.value++
        await nextTick()
        if (preview.value) { preview.value.src = asset.url; preview.value.muted = false }
      }
      recoveryError = ''
      error.value = ''
      phase.value = 'idle'
    } else await controller?.stop()
  } catch (cause) {
    if (!props.native) { error.value = captureErrorMessage(cause); phase.value = 'idle'; return }
    await recoverNativeStop(cause)
  }
}
function beforeUnload(event: BeforeUnloadEvent): void { if (active.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  clock = setInterval(() => {
    if (controller) { elapsed.value = controller.elapsed; actualSource.value = { ...controller.source } }
    else if (props.native && ['recording', 'paused'].includes(phase.value) && !polling) {
      polling = true
      const version = nativeStateVersion
      void getCaptureStatus().then(value => {
        if (destroyed || version !== nativeStateVersion || !['recording', 'paused'].includes(phase.value)) return
        elapsed.value = value.elapsed
        updateNativeSource(value)
        error.value = recoveryError || value.error || ''
        if (value.state === 'idle' || value.state === 'paused' || value.state === 'recording') phase.value = value.state
      }).catch(cause => { if (!destroyed && version === nativeStateVersion && ['recording', 'paused'].includes(phase.value)) error.value = recoveryError || captureErrorMessage(cause) }).finally(() => { polling = false })
    }
  }, 300)
})
onBeforeUnmount(() => {
  destroyed = true
  startAbort?.abort()
  finishBrowserChoice?.(null)
  clearInterval(clock)
  window.removeEventListener('beforeunload', beforeUnload)
  if (controller) void controller.stop().catch(() => {})
  if (props.native && ['recording', 'paused'].includes(phase.value)) void stopCapture().then(asset => { if (asset) emit('asset', asset) }).catch(() => {})
  clearPreview()
})
defineExpose({ isRecording: () => active.value, stop })
</script>

<template>
  <section class="recorder-workspace" data-testid="recorder-workspace">
    <div class="capture-heading"><div><span class="eyebrow">CAPTURE STUDIO</span><h1>屏幕录制</h1><p>记录屏幕、窗口或演示，录制完成后直接开始剪辑。</p></div><span class="capture-platform"><Icon :name="native ? 'monitor' : 'globe'" :size="15" />{{ native ? '桌面录制' : '网页录制' }}</span></div>
    <div class="capture-grid">
      <div class="capture-stage">
        <div class="stage-toolbar"><span><i :class="{ live: phase === 'recording', paused: phase === 'paused' }" />{{ phaseLabel }}</span><strong>{{ clockLabel }}</strong><span>{{ fps }} FPS</span></div>
        <div class="capture-video-wrap" :class="{ 'recording-border': liveBorder }" data-testid="recording-preview">
          <video ref="preview" playsinline :controls="!active" :class="{ visible: active && !native || !!latestName }" aria-label="录制画面预览" />
          <div v-if="(!active && !latestName) || (native && active)" class="capture-placeholder"><div class="capture-symbol"><Icon :name="sourceType === 'region' ? 'crop' : sourceType === 'window' ? 'panel' : 'monitor'" :size="46" /></div><h2>{{ native && active ? (phase === 'selecting' ? '选择要录制的范围' : phase === 'starting' ? '正在准备录制' : '正在录制所选画面') : '让想法被看见' }}</h2><p>{{ native && active ? (phase === 'selecting' ? '拖动框选区域，或点击窗口；确认后才会开始录制。' : '红色边框标示当前录制范围，可随时返回这里暂停或停止。') : '点击开始录制，直接选择想要记录的画面。' }}</p><span v-if="!active">{{ native ? '屏幕 / 窗口 / 区域 · 分段暂停 · 麦克风' : '屏幕 / 窗口 / 区域 · 分段暂停 · 音频' }}</span></div>
          <div v-if="remaining" class="capture-countdown" aria-live="assertive">{{ remaining }}</div>
          <div v-if="phase === 'paused'" class="paused-overlay"><Icon name="pause" :size="26" />录制已暂停</div>
        </div>
        <div v-if="active && actualSource" class="actual-source" data-testid="recording-source"><Icon :name="sourceType === 'region' ? 'crop' : 'monitor'" :size="15" /><div><strong>{{ actualSource.label }}</strong><span v-if="actualSource.width && actualSource.height">来源 {{ actualSource.width }} × {{ actualSource.height }}<template v-if="sourceType === 'region'"> · 区域 {{ selection?.region?.width }} × {{ selection?.region?.height }}</template><template v-if="actualSource.outputWidth && actualSource.outputHeight"> · 输出 {{ actualSource.outputWidth }} × {{ actualSource.outputHeight }}</template></span></div><span class="recording-tag">{{ phase === 'paused' ? '已暂停' : '录制范围' }}</span></div>
        <div class="capture-bottom"><span><Icon name="shield" :size="16" />仅在你点击开始后采集</span><span v-if="capturedCount">本次已录制 {{ capturedCount }} 段</span><span v-else>停止后自动加入素材库</span></div>
      </div>
      <aside class="capture-settings">
        <h2>录制设置</h2>
        <RuntimeCheck v-if="native" :disabled="active || screenshotBusy" />
        <div class="source-note"><Icon name="crop" :size="23" /><div><strong>点击开始后选择录制范围</strong><span>{{ native ? '在桌面框选区域，或选择窗口、整块屏幕。' : '先授权共享画面，再选择范围和输出尺寸。' }}</span></div></div>
        <label class="field">帧率<select v-model.number="fps" :disabled="active"><option :value="15">15 FPS · 演示文稿</option><option :value="30">30 FPS · 日常录制</option><option :value="60">60 FPS · 流畅动态</option></select></label>
        <label class="toggle-row"><span><Icon name="mic" :size="18" /><span>录制麦克风<small>讲解与旁白</small></span></span><input v-model="microphone" type="checkbox" role="switch" :disabled="active" /></label>
        <label v-if="!native" class="toggle-row"><span><Icon name="volume" :size="18" /><span>录制共享音频<small>需要在来源选择器中允许</small></span></span><input v-model="systemAudio" type="checkbox" role="switch" :disabled="active" /></label>
        <label class="field">开始倒计时<select v-model.number="countdown" :disabled="active"><option :value="0">立即开始</option><option :value="3">3 秒</option><option :value="5">5 秒</option></select></label>
        <div v-if="error" class="capture-error" role="alert">{{ error }}</div>
        <div v-if="!native && !browserCaptureAvailable()" class="capture-error">此浏览器无法采集屏幕，请在桌面端使用录制功能。</div>
        <button v-if="!active" class="record-start" :disabled="screenshotBusy || !native && !browserCaptureAvailable()" data-testid="record-start" @click="begin"><Icon name="record" :size="18" />开始录制</button>
        <div v-else class="record-actions"><button v-if="phase === 'recording' || phase === 'paused'" @click="pauseOrResume"><Icon :name="phase === 'paused' ? 'play' : 'pause'" :size="17" />{{ phase === 'paused' ? '继续' : '暂停' }}</button><button class="stop-recording" :disabled="phase === 'stopping'" data-testid="record-stop" @click="stop"><Icon name="stop" :size="17" />{{ phase === 'selecting' || phase === 'starting' ? '取消' : '停止' }}</button></div>
        <p class="settings-hint">{{ native ? '录制时使用红框标出实际范围，暂停后仍可继续，停止时自动合并片段。' : '红框标示画面预览中的录制范围；桌面上的共享标识由浏览器提供。共享音频取决于所选来源。' }}</p>
        <ScreenshotControls :native="native" :shortcut="screenshotShortcut" :busy="screenshotBusy" :disabled="active || screenshotDisabled" :error="screenshotError" :configuring="screenshotConfiguring" @capture="emit('screenshot')" @shortcut-change="emit('screenshot-shortcut-change', $event)" />
      </aside>
    </div>
    <div v-if="recentVideos.length" class="recent-captures"><div class="section-title"><h2>最近的视频素材</h2><span>继续创作</span></div><div class="recent-grid"><button v-for="asset in recentVideos" :key="asset.id" @click="emit('add-to-timeline', asset.id)"><span class="recent-thumb"><Icon name="video" :size="24" /></span><span class="recent-info"><strong>{{ asset.name }}</strong><small>{{ asset.width }} × {{ asset.height }} · {{ Math.round(asset.duration) }} 秒</small></span><Icon name="plus" :size="17" /></button></div></div>
    <Teleport to="body">
      <div v-if="browserPicker">
        <CaptureSelectionOverlay :context="browserPicker.context" embedded @confirm="finishBrowserChoice?.($event)" @cancel="finishBrowserChoice?.(null)">
          <template #background><video :ref="connectPickerPreview" autoplay muted playsinline aria-label="待录制来源预览" /></template>
        </CaptureSelectionOverlay>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.actual-source{display:flex;align-items:center;gap:9px;padding:11px 15px;border-bottom:1px solid var(--ui-border,#e5e8f0);color:var(--ui-danger,#cf4961)}.actual-source>svg{flex-shrink:0}.actual-source>div{display:grid;gap:5px;min-width:0;flex:1}.actual-source strong{font-size:11px;font-weight:600;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--ui-text,#253044)}.actual-source div span{font-size:10px;color:var(--ui-muted,#7c8492);line-height:1.5}.recording-tag{font-size:10px;white-space:nowrap;padding:4px 7px;border:1px solid currentColor;border-radius:4px}.capture-video-wrap.recording-border:after{content:'';position:absolute;inset:0;border:3px solid #ef4557;z-index:4;pointer-events:none}@media(max-width:450px){.actual-source{padding:10px}.recording-tag{display:none}}
.recorder-workspace{height:100%;overflow:auto;padding:30px 36px;color:var(--ui-text,#253044)}.capture-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:26px}.eyebrow{font-size:10px;letter-spacing:2px;font-weight:700;color:var(--ui-accent,#6257db)}h1{font-size:27px;margin:7px 0 8px;letter-spacing:-.7px}.capture-heading p,.settings-hint{color:var(--ui-muted,#7c8492);font-size:12px;line-height:1.8;margin:0}.capture-platform{display:flex;align-items:center;gap:7px;border:1px solid var(--ui-border,#e5e8f0);background:var(--ui-panel,#fff);padding:7px 11px;border-radius:7px;font-size:11px;color:var(--ui-muted,#7c8492);white-space:nowrap}.capture-grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:22px;align-items:start}.capture-stage{border:1px solid var(--ui-border,#e5e8f0);border-radius:13px;overflow:hidden;background:var(--ui-panel,#fff);box-shadow:0 5px 25px #26325c05}.stage-toolbar{height:49px;display:flex;justify-content:space-between;align-items:center;padding:0 20px;font-size:11px;color:var(--ui-muted,#7c8492)}.stage-toolbar span:first-child{display:flex;align-items:center;gap:7px}.stage-toolbar i{width:6px;height:6px;background:#a8afba;border-radius:50%}.stage-toolbar i.live{background:#ed6073;box-shadow:0 0 0 4px #ed607318}.stage-toolbar i.paused{background:#dfab35}.stage-toolbar strong{font-family:monospace;font-size:16px;font-variant-numeric:tabular-nums;color:var(--ui-text,#253044)}.capture-video-wrap{position:relative;aspect-ratio:16/10;min-height:250px;background:var(--ui-surface-2,#f7f8fc);border-top:1px solid var(--ui-border,#e5e8f0);border-bottom:1px solid var(--ui-border,#e5e8f0);overflow:hidden}.capture-video-wrap video{width:100%;height:100%;object-fit:contain;display:none;background:#151820}.capture-video-wrap video.visible{display:block}.capture-placeholder{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:25px;text-align:center;background-image:radial-gradient(var(--ui-border,#dfe3ec) .8px,transparent .8px);background-size:18px 18px}.capture-symbol{width:100px;height:100px;display:grid;place-items:center;background:var(--ui-panel,#fff);border:1px solid var(--ui-border,#e5e8f0);border-radius:23px;color:var(--ui-accent,#6257db);box-shadow:0 10px 30px #3035620a}.capture-placeholder h2{font-size:18px;letter-spacing:-.4px;margin:20px 0 9px}.capture-placeholder p{font-size:12px;color:var(--ui-muted,#7c8492);max-width:320px;line-height:1.8;margin:0}.capture-placeholder>span{font-size:10px;color:var(--ui-muted,#7c8492);margin-top:20px;letter-spacing:.2px}.capture-bottom{display:flex;justify-content:space-between;gap:12px;padding:14px 18px;font-size:10px;color:var(--ui-muted,#7c8492)}.capture-bottom>span{display:flex;align-items:center;gap:6px}.capture-settings{border:1px solid var(--ui-border,#e5e8f0);border-radius:12px;background:var(--ui-panel,#fff);padding:20px;display:grid;gap:15px}.capture-settings h2{font-size:14px;margin:0 0 1px}.field{display:grid;gap:8px;font-size:11px;font-weight:600}.field select{width:100%}.source-note{display:flex;gap:10px;align-items:center;padding:13px 10px;border:1px solid var(--ui-border,#e5e8f0);border-radius:7px;color:var(--ui-accent,#6257db)}.source-note{grid-column:1/-1}.source-note>svg{flex-shrink:0}.source-note>div{display:grid;gap:6px;line-height:1.7}.source-note strong{font-size:11px;color:var(--ui-text,#253044)}.source-note span{font-size:9px;color:var(--ui-muted,#7c8492)}.toggle-row{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:11px}.toggle-row>span{display:flex;align-items:center;gap:9px}.toggle-row>span>span{display:grid;gap:5px}.toggle-row small{color:var(--ui-muted,#7c8492);font-size:9px}.toggle-row input{appearance:none;width:29px;height:17px;border-radius:20px;background:var(--ui-border,#d8dce7);position:relative;cursor:pointer;flex-shrink:0}.toggle-row input:after{content:'';position:absolute;left:3px;top:3px;width:11px;height:11px;background:#fff;border-radius:50%;transition:transform .15s}.toggle-row input:checked{background:var(--ui-accent,#6257db)}.toggle-row input:checked:after{transform:translateX(12px)}.toggle-row input:focus-visible{outline:2px solid var(--ui-accent,#6257db);outline-offset:3px}.record-start,.record-actions button{display:flex;align-items:center;justify-content:center;gap:8px;border:none;border-radius:7px;min-height:39px;font-size:12px;font-weight:600;cursor:pointer}.record-start{background:var(--ui-accent,#6257db);color:white}.record-start:disabled{opacity:.45;cursor:not-allowed}.record-actions{display:flex;gap:8px}.record-actions button{flex:1;background:var(--ui-surface-2,#f1f3f9);color:var(--ui-text,#253044)}.record-actions .stop-recording{background:color-mix(in srgb,var(--ui-danger,#cf4961) 10%,var(--ui-panel,#fff));color:var(--ui-danger,#cf4961)}.capture-error{font-size:11px;line-height:1.7;color:var(--ui-danger,#c34e59);background:color-mix(in srgb,var(--ui-danger,#c34e59) 10%,var(--ui-panel,#fff));padding:9px 11px;border-radius:7px}.settings-hint{font-size:10px}.capture-countdown,.paused-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#11172677;color:white}.capture-countdown{font-size:90px;font-weight:700}.paused-overlay{gap:10px;font-size:17px}.recent-captures{margin-top:28px}.section-title{display:flex;align-items:center;justify-content:space-between}.section-title h2{font-size:13px;margin:0 0 14px}.section-title>span{font-size:10px;color:var(--ui-muted,#7c8492)}.recent-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.recent-grid button{display:flex;align-items:center;gap:11px;padding:12px;border:1px solid var(--ui-border,#e5e8f0);border-radius:9px;background:var(--ui-panel,#fff);color:var(--ui-text,#253044);text-align:left;cursor:pointer}.recent-thumb{display:grid;place-items:center;width:48px;height:39px;border-radius:5px;background:var(--ui-surface-2,#f7f8fc);color:var(--ui-accent,#6257db);flex-shrink:0}.recent-info{display:grid;gap:5px;flex:1;min-width:0}.recent-info strong{font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recent-info small{font-size:9px;color:var(--ui-muted,#7c8492)}@media(max-width:1100px){.recorder-workspace{padding:22px}.capture-grid{grid-template-columns:minmax(0,1fr) 240px;gap:14px}.capture-settings{padding:16px}.capture-heading p{max-width:340px}}@media(max-width:800px){.capture-grid{grid-template-columns:1fr}.capture-settings{grid-template-columns:1fr 1fr}.capture-settings h2,.capture-error,.record-start,.record-actions,.settings-hint{grid-column:1/-1}.capture-platform{display:none}.recent-grid{grid-template-columns:1fr}}@media(max-width:450px){.recorder-workspace{padding:15px}.capture-settings{grid-template-columns:1fr}.capture-bottom{font-size:9px;flex-wrap:wrap}.capture-placeholder p{font-size:11px}.capture-placeholder>span{font-size:9px}.capture-symbol{width:70px;height:70px}.capture-video-wrap{min-height:240px}}
</style>
