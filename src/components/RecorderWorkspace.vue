<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import type { MediaAsset } from '../core/types'
import { browserCaptureAvailable, captureErrorMessage, startBrowserCapture, type BrowserCapture } from '../core/capture'
import { cancelCaptureStart, getCaptureStatus, listCaptureDevices, pauseCapture, resumeCapture, startCapture, stopCapture, type CaptureDevice, type CaptureStatus, type CaptureSize } from '../native'

const props = defineProps<{ assets: MediaAsset[]; native: boolean }>()
const emit = defineEmits<{ captured: [blob: Blob, name: string]; asset: [asset: MediaAsset]; status: [message: string]; 'add-to-timeline': [assetId: string]; 'recording-change': [active: boolean] }>()
const phase = ref<'idle' | 'starting' | 'recording' | 'paused' | 'stopping'>('idle')
const elapsed = ref(0)
const fps = ref(30)
const microphone = ref(false)
const systemAudio = ref(true)
const countdown = ref(3)
const remaining = ref(0)
const error = ref('')
const screenId = ref('')
const windowId = ref('')
const sourceType = ref<'screen' | 'window' | 'region'>('screen')
const outputPreset = ref<'original' | '1080p' | '720p' | 'custom'>('original')
const outputWidth = ref(1920)
const outputHeight = ref(1080)
const regionX = ref(0)
const regionY = ref(0)
const regionWidth = ref(1280)
const regionHeight = ref(720)
const audioDevice = ref('')
const devices = ref<CaptureDevice[]>([])
const devicesLoading = ref(false)
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
let deviceRequest = 0
const deviceError = ref('')
const active = computed(() => phase.value !== 'idle')
watch(active, value => emit('recording-change', value))
const screens = computed(() => devices.value.filter(item => item.kind === 'screen'))
const windows = computed(() => devices.value.filter(item => item.kind === 'window'))
const microphones = computed(() => devices.value.filter(item => item.kind === 'audio'))
const availableSources = computed(() => sourceType.value === 'window' ? windows.value : screens.value)
const selectedSourceId = computed({ get: () => sourceType.value === 'window' ? windowId.value : screenId.value, set: value => { if (sourceType.value === 'window') windowId.value = value; else screenId.value = value } })
const selectedSource = computed(() => availableSources.value.find(device => device.id === selectedSourceId.value))
const region = computed(() => ({ x: regionX.value, y: regionY.value, width: regionWidth.value, height: regionHeight.value }))
const outputSize = computed<CaptureSize | undefined>(() => outputPreset.value === 'original' ? undefined : outputPreset.value === '1080p' ? { width: 1920, height: 1080 } : outputPreset.value === '720p' ? { width: 1280, height: 720 } : { width: outputWidth.value, height: outputHeight.value })
const configurationError = computed(() => {
  if (props.native && !selectedSource.value) return sourceType.value === 'window' ? '请选择一个可用窗口；窗口关闭后需要刷新列表。' : '请选择一个可用屏幕。'
  if (sourceType.value === 'region') {
    const value = region.value
    if (![value.x, value.y, value.width, value.height].every(Number.isInteger) || value.x < 0 || value.y < 0 || value.width < 16 || value.height < 16) return '录制区域需使用整数像素，起点不能为负，宽高至少为 16。'
    const source = selectedSource.value
    if (props.native && source?.width && source?.height && (value.x + value.width > source.width || value.y + value.height > source.height)) return `录制区域超出屏幕范围（${source.width} × ${source.height}）。`
  }
  const size = outputSize.value
  if (size && (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 16 || size.height < 16 || size.width > 7680 || size.height > 4320 || size.width % 2 || size.height % 2)) return '输出宽高需为偶数整数，范围为 16–7680 × 16–4320。'
  return ''
})
const regionBounds = computed(() => props.native && selectedSource.value?.width && selectedSource.value?.height ? `${selectedSource.value.width} × ${selectedSource.value.height}` : '')
const liveBorder = computed(() => !props.native && (phase.value === 'recording' || phase.value === 'paused'))
watch(screenId, (value, previous) => {
  if (active.value || !value || value === previous) return
  const screen = screens.value.find(device => device.id === value)
  regionX.value = 0; regionY.value = 0
  regionWidth.value = Math.min(1280, screen?.width ?? 1280)
  regionHeight.value = Math.min(720, screen?.height ?? 720)
})
watch([selectedSourceId, sourceType], () => { if (!active.value && selectedSource.value) deviceError.value = '' })
const clockLabel = computed(() => {
  const value = Math.floor(elapsed.value)
  return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
})
const phaseLabel = computed(() => ({ idle: '准备录制', starting: remaining.value ? `${remaining.value} 秒后开始` : '正在准备', recording: '正在录制', paused: '已暂停', stopping: '正在保存录制' })[phase.value])
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
async function loadDevices(requestPermission = false): Promise<void> {
  if (!props.native || active.value || devicesLoading.value) return
  const request = ++deviceRequest
  const firstLoad = !devices.value.length && !screenId.value && !windowId.value
  devicesLoading.value = true
  try {
    const result = await listCaptureDevices(requestPermission)
    if (destroyed || request !== deviceRequest || active.value) return
    const previousId = selectedSourceId.value
    devices.value = result
    if (!screens.value.some(device => device.id === screenId.value)) screenId.value = firstLoad ? screens.value[0]?.id ?? '' : ''
    if (!windows.value.some(device => device.id === windowId.value)) windowId.value = firstLoad ? windows.value[0]?.id ?? '' : ''
    if (!microphones.value.some(device => device.id === audioDevice.value)) audioDevice.value = microphones.value[0]?.id ?? ''
    deviceError.value = previousId && !selectedSource.value ? '原录制来源已不可用，请重新选择。' : ''
    error.value = ''
  } catch (cause) { if (!destroyed && request === deviceRequest) deviceError.value = captureErrorMessage(cause) }
  finally { if (!destroyed && request === deviceRequest) devicesLoading.value = false }
}
function updateNativeSource(status: CaptureStatus): void {
  const source = devices.value.find(device => device.id === status.sourceId) ?? selectedSource.value
  const previous = actualSource.value
  const width = status.sourceWidth ?? source?.width ?? previous?.width ?? 0
  const height = status.sourceHeight ?? source?.height ?? previous?.height ?? 0
  const target = status.outputSize ?? outputSize.value ?? (sourceType.value === 'region' ? region.value : { width, height })
  actualSource.value = { label: status.sourceName ?? source?.name ?? previous?.label ?? '录制来源', width, height, outputWidth: target.width, outputHeight: target.height }
}
async function begin(): Promise<void> {
  if (active.value || devicesLoading.value) return
  if (configurationError.value || (props.native && deviceError.value)) { error.value = configurationError.value || deviceError.value; return }
  error.value = ''
  recoveryError = ''
  actualSource.value = undefined
  elapsed.value = 0
  phase.value = 'starting'
  nativeStateVersion++
  startAbort = new AbortController()
  clearPreview()
  let nativeStarted = false
  try {
    if (props.native) {
      for (let count = countdown.value; count > 0; count--) {
        if (startAbort.signal.aborted) throw new DOMException('已取消录制。', 'AbortError')
        remaining.value = count
        await new Promise<void>(resolve => setTimeout(resolve, 1000))
      }
      remaining.value = 0
      if (startAbort.signal.aborted) throw new DOMException('已取消录制。', 'AbortError')
      const requestId = crypto.randomUUID()
      const cancelPendingStart = () => { void cancelCaptureStart(requestId).catch(() => {}) }
      startAbort.signal.addEventListener('abort', cancelPendingStart, { once: true })
      let result: CaptureStatus
      try {
        result = await startCapture({ requestId, fps: fps.value, microphone: microphone.value, sourceId: selectedSourceId.value, ...(audioDevice.value ? { audioDevice: audioDevice.value } : {}), ...(sourceType.value === 'region' ? { region: region.value } : {}), ...(outputSize.value ? { outputSize: outputSize.value } : {}) })
      } finally { startAbort.signal.removeEventListener('abort', cancelPendingStart) }
      nativeStarted = true
      updateNativeSource(result)
      if (destroyed || startAbort.signal.aborted) { const asset = await stopCapture(); if (asset) emit('asset', asset); phase.value = 'idle'; return }
      phase.value = result.state === 'paused' ? 'paused' : 'recording'
      elapsed.value = result.elapsed
    } else {
      controller = await startBrowserCapture({
        fps: fps.value, microphone: microphone.value, systemAudio: systemAudio.value,
        sourceType: sourceType.value, ...(sourceType.value === 'region' ? { region: region.value } : {}), ...(outputSize.value ? { outputSize: outputSize.value } : {}),
        countdown: countdown.value, signal: startAbort.signal,
        onCountdown: value => { remaining.value = value },
        onFinished: result => finished(result.blob, result.name),
        onError: cause => { error.value = captureErrorMessage(cause) },
        onPhase: value => { if (value === 'paused' || value === 'recording') phase.value = value; else if (phase.value !== 'stopping') phase.value = 'idle' },
      })
      if (destroyed || startAbort.signal.aborted) { await controller.stop(); return }
      actualSource.value = { ...controller.source }
      phase.value = 'recording'
      await nextTick()
      if (preview.value) { preview.value.muted = true; preview.value.srcObject = controller.stream; await preview.value.play().catch(() => {}) }
    }
  } catch (cause) {
    remaining.value = 0
    if (nativeStarted) await recoverNativeStop(cause)
    else { error.value = captureErrorMessage(cause); phase.value = 'idle' }
  }
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
  if (phase.value === 'starting') { startAbort?.abort(); return }
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
  void loadDevices()
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
  deviceRequest++
  startAbort?.abort()
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
          <div v-if="(!active && !latestName) || (native && active)" class="capture-placeholder"><div class="capture-symbol"><Icon :name="sourceType === 'region' ? 'crop' : sourceType === 'window' ? 'panel' : 'monitor'" :size="46" /></div><h2>{{ native && active ? (phase === 'starting' ? '正在准备录制' : '正在录制所选画面') : '让想法被看见' }}</h2><p>{{ native && active ? '红色边框标示当前录制范围，可随时返回这里暂停或停止。' : '选择录制来源和尺寸，让每一步操作都清晰呈现。' }}</p><span v-if="!active">{{ native ? '屏幕 / 窗口 / 区域 · 分段暂停 · 麦克风' : '屏幕 / 窗口 / 区域 · 分段暂停 · 音频' }}</span></div>
          <div v-if="remaining" class="capture-countdown" aria-live="assertive">{{ remaining }}</div>
          <div v-if="phase === 'paused'" class="paused-overlay"><Icon name="pause" :size="26" />录制已暂停</div>
        </div>
        <div v-if="active && actualSource" class="actual-source" data-testid="recording-source"><Icon :name="sourceType === 'region' ? 'crop' : 'monitor'" :size="15" /><div><strong>{{ actualSource.label }}</strong><span v-if="actualSource.width && actualSource.height">来源 {{ actualSource.width }} × {{ actualSource.height }}<template v-if="sourceType === 'region'"> · 区域 {{ regionWidth }} × {{ regionHeight }}</template><template v-if="actualSource.outputWidth && actualSource.outputHeight"> · 输出 {{ actualSource.outputWidth }} × {{ actualSource.outputHeight }}</template></span></div><span class="recording-tag">{{ phase === 'paused' ? '已暂停' : '录制范围' }}</span></div>
        <div class="capture-bottom"><span><Icon name="shield" :size="16" />仅在你点击开始后采集</span><span v-if="capturedCount">本次已录制 {{ capturedCount }} 段</span><span v-else>停止后自动加入素材库</span></div>
      </div>
      <aside class="capture-settings">
        <h2>录制设置</h2>
        <div class="source-settings">
          <span class="field-title">录制范围</span>
          <div class="source-tabs" role="group" aria-label="录制范围">
            <button :class="{ selected: sourceType === 'screen' }" :aria-pressed="sourceType === 'screen'" :disabled="active || devicesLoading" data-testid="capture-mode-screen" @click="sourceType = 'screen'"><Icon name="monitor" :size="15" />屏幕</button>
            <button :class="{ selected: sourceType === 'window' }" :aria-pressed="sourceType === 'window'" :disabled="active || devicesLoading" data-testid="capture-mode-window" @click="sourceType = 'window'"><Icon name="panel" :size="15" />窗口</button>
            <button :class="{ selected: sourceType === 'region' }" :aria-pressed="sourceType === 'region'" :disabled="active || devicesLoading" data-testid="capture-mode-region" @click="sourceType = 'region'"><Icon name="crop" :size="15" />区域</button>
          </div>
          <div v-if="native" class="source-picker">
            <label class="field">{{ sourceType === 'window' ? '选择窗口' : '选择屏幕' }}<select v-model="selectedSourceId" :disabled="active || devicesLoading" data-testid="capture-source"><option disabled value="">{{ devicesLoading ? '正在获取来源…' : '请选择录制来源' }}</option><option v-for="device in availableSources" :key="device.id" :value="device.id">{{ device.name }}{{ device.width && device.height ? ` · ${device.width} × ${device.height}` : '' }}</option></select></label>
            <button class="refresh-devices" :disabled="active || devicesLoading" aria-label="授权并刷新录制来源" title="授权并刷新录制来源" @click="loadDevices(true)"><Icon name="refresh" :size="16" :class="{ spinning: devicesLoading }" /></button>
          </div>
          <p v-if="native && !devicesLoading && !availableSources.length" class="field-hint">点击右侧刷新按钮，授权并重新读取{{ sourceType === 'window' ? '窗口' : '屏幕' }}列表。</p>
          <p v-if="!native" class="field-hint">{{ sourceType === 'region' ? '开始后请选择整个屏幕，再按下方坐标截取区域。' : '开始时打开系统来源选择器，最终录制来源以你的授权选择为准。' }}</p>
          <div v-if="sourceType === 'region'" class="region-settings">
            <div class="dimension-grid"><label class="field">起点 X<input v-model.number="regionX" type="number" min="0" step="1" :disabled="active" data-testid="capture-region-x" /></label><label class="field">起点 Y<input v-model.number="regionY" type="number" min="0" step="1" :disabled="active" data-testid="capture-region-y" /></label><label class="field">区域宽度<input v-model.number="regionWidth" type="number" min="16" step="1" :max="selectedSource?.width" :disabled="active" data-testid="capture-region-width" /></label><label class="field">区域高度<input v-model.number="regionHeight" type="number" min="16" step="1" :max="selectedSource?.height" :disabled="active" data-testid="capture-region-height" /></label></div>
            <p class="field-hint">以所选屏幕左上角为原点，单位为像素。{{ regionBounds ? `屏幕范围 ${regionBounds}。` : '开始时将校验实际屏幕范围。' }}</p>
          </div>
        </div>
        <div class="output-settings">
          <label class="field">输出尺寸<select v-model="outputPreset" :disabled="active" data-testid="capture-output"><option value="original">原始尺寸</option><option value="1080p">1920 × 1080</option><option value="720p">1280 × 720</option><option value="custom">自定义尺寸</option></select></label>
          <div v-if="outputPreset === 'custom'" class="dimension-grid"><label class="field">输出宽度<input v-model.number="outputWidth" type="number" min="16" max="7680" step="2" :disabled="active" data-testid="capture-output-width" /></label><label class="field">输出高度<input v-model.number="outputHeight" type="number" min="16" max="4320" step="2" :disabled="active" data-testid="capture-output-height" /></label></div>
          <p v-if="outputPreset !== 'original'" class="field-hint">保持画面比例，尺寸不一致时自动留边。</p>
          <p v-if="!native && (outputPreset !== 'original' || sourceType === 'region')" class="field-hint">网页裁切与缩放期间请保持本录制页面可见，避免浏览器降低处理频率。</p>
        </div>
        <label class="field">帧率<select v-model.number="fps" :disabled="active"><option :value="15">15 FPS · 演示文稿</option><option :value="30">30 FPS · 日常录制</option><option :value="60">60 FPS · 流畅动态</option></select></label>
        <label class="toggle-row"><span><Icon name="mic" :size="18" /><span>录制麦克风<small>讲解与旁白</small></span></span><input v-model="microphone" type="checkbox" role="switch" :disabled="active" /></label>
        <label v-if="native && microphone && microphones.length" class="field">麦克风<select v-model="audioDevice" :disabled="active"><option v-for="device in microphones" :key="device.id" :value="device.id">{{ device.name }}</option></select></label>
        <label v-if="!native" class="toggle-row"><span><Icon name="volume" :size="18" /><span>录制共享音频<small>需要在来源选择器中允许</small></span></span><input v-model="systemAudio" type="checkbox" role="switch" :disabled="active" /></label>
        <label class="field">开始倒计时<select v-model.number="countdown" :disabled="active"><option :value="0">立即开始</option><option :value="3">3 秒</option><option :value="5">5 秒</option></select></label>
        <div v-if="error || (!active && !devicesLoading && (deviceError || configurationError))" class="capture-error" role="alert">{{ error || deviceError || configurationError }}</div>
        <div v-if="!native && !browserCaptureAvailable()" class="capture-error">此浏览器无法采集屏幕，请在桌面端使用录制功能。</div>
        <button v-if="!active" class="record-start" :disabled="devicesLoading || !!configurationError || (native && !!deviceError) || (!native && !browserCaptureAvailable())" data-testid="record-start" @click="begin"><Icon name="record" :size="18" />{{ devicesLoading ? '正在获取来源…' : '开始录制' }}</button>
        <div v-else class="record-actions"><button v-if="phase === 'recording' || phase === 'paused'" @click="pauseOrResume"><Icon :name="phase === 'paused' ? 'play' : 'pause'" :size="17" />{{ phase === 'paused' ? '继续' : '暂停' }}</button><button class="stop-recording" :disabled="phase === 'stopping'" data-testid="record-stop" @click="stop"><Icon name="stop" :size="17" />{{ phase === 'starting' ? '取消' : '停止' }}</button></div>
        <p class="settings-hint">{{ native ? '录制时使用红框标出实际范围，暂停后仍可继续，停止时自动合并片段。' : '红框标示画面预览中的录制范围；桌面上的共享标识由浏览器提供。共享音频取决于所选来源。' }}</p>
      </aside>
    </div>
    <div v-if="recentVideos.length" class="recent-captures"><div class="section-title"><h2>最近的视频素材</h2><span>继续创作</span></div><div class="recent-grid"><button v-for="asset in recentVideos" :key="asset.id" @click="emit('add-to-timeline', asset.id)"><span class="recent-thumb"><Icon name="video" :size="24" /></span><span class="recent-info"><strong>{{ asset.name }}</strong><small>{{ asset.width }} × {{ asset.height }} · {{ Math.round(asset.duration) }} 秒</small></span><Icon name="plus" :size="17" /></button></div></div>
  </section>
</template>

<style scoped>
.source-settings,.output-settings,.region-settings{display:grid;gap:10px;min-width:0}.source-settings,.output-settings{grid-column:1/-1}.field-title{font-size:11px;font-weight:600}.source-tabs{display:flex;gap:3px;padding:3px;background:var(--ui-surface-2,#f7f8fc);border:1px solid var(--ui-border,#e5e8f0);border-radius:7px}.source-tabs button{display:flex;align-items:center;justify-content:center;gap:5px;flex:1;min-width:0;padding:7px 3px;border:0;border-radius:4px;background:transparent;color:var(--ui-muted,#7c8492);font-size:11px;cursor:pointer;transition:none}.source-tabs button.selected{background:var(--ui-panel,#fff);color:var(--ui-accent,#6257db);box-shadow:0 1px 5px #2530440d}.source-tabs button:disabled,.refresh-devices:disabled{cursor:default;opacity:.55}.source-picker{display:grid;grid-template-columns:minmax(0,1fr) 33px;gap:7px;align-items:end}.refresh-devices{display:grid;place-items:center;height:35px;border:1px solid var(--ui-border,#e5e8f0);border-radius:6px;background:var(--ui-surface-2,#f7f8fc);color:var(--ui-text,#253044);cursor:pointer}.field-hint{margin:0;font-size:10px;line-height:1.7;color:var(--ui-muted,#7c8492)}.dimension-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.dimension-grid .field{min-width:0;gap:5px}.field input[type=number]{width:100%;min-width:0;box-sizing:border-box;height:33px;border:1px solid var(--ui-border,#e5e8f0);border-radius:6px;background:var(--ui-surface-2,#f7f8fc);color:var(--ui-text,#253044);padding:0 8px;font:inherit;font-weight:400}.field input:disabled,.field select:disabled{opacity:.6}.actual-source{display:flex;align-items:center;gap:9px;padding:11px 15px;border-bottom:1px solid var(--ui-border,#e5e8f0);color:var(--ui-danger,#cf4961)}.actual-source>svg{flex-shrink:0}.actual-source>div{display:grid;gap:5px;min-width:0;flex:1}.actual-source strong{font-size:11px;font-weight:600;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--ui-text,#253044)}.actual-source div span{font-size:10px;color:var(--ui-muted,#7c8492);line-height:1.5}.recording-tag{font-size:10px;white-space:nowrap;padding:4px 7px;border:1px solid currentColor;border-radius:4px}.capture-video-wrap.recording-border:after{content:'';position:absolute;inset:0;border:3px solid #ef4557;z-index:4;pointer-events:none}.spinning{animation:device-refresh 1s linear infinite}@keyframes device-refresh{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinning{animation:none}}@media(max-width:450px){.actual-source{padding:10px}.recording-tag{display:none}}
.recorder-workspace{height:100%;overflow:auto;padding:30px 36px;color:var(--ui-text,#253044)}.capture-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:26px}.eyebrow{font-size:10px;letter-spacing:2px;font-weight:700;color:var(--ui-accent,#6257db)}h1{font-size:27px;margin:7px 0 8px;letter-spacing:-.7px}.capture-heading p,.settings-hint{color:var(--ui-muted,#7c8492);font-size:12px;line-height:1.8;margin:0}.capture-platform{display:flex;align-items:center;gap:7px;border:1px solid var(--ui-border,#e5e8f0);background:var(--ui-panel,#fff);padding:7px 11px;border-radius:7px;font-size:11px;color:var(--ui-muted,#7c8492);white-space:nowrap}.capture-grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:22px;align-items:start}.capture-stage{border:1px solid var(--ui-border,#e5e8f0);border-radius:13px;overflow:hidden;background:var(--ui-panel,#fff);box-shadow:0 5px 25px #26325c05}.stage-toolbar{height:49px;display:flex;justify-content:space-between;align-items:center;padding:0 20px;font-size:11px;color:var(--ui-muted,#7c8492)}.stage-toolbar span:first-child{display:flex;align-items:center;gap:7px}.stage-toolbar i{width:6px;height:6px;background:#a8afba;border-radius:50%}.stage-toolbar i.live{background:#ed6073;box-shadow:0 0 0 4px #ed607318}.stage-toolbar i.paused{background:#dfab35}.stage-toolbar strong{font-family:monospace;font-size:16px;font-variant-numeric:tabular-nums;color:var(--ui-text,#253044)}.capture-video-wrap{position:relative;aspect-ratio:16/10;min-height:250px;background:var(--ui-surface-2,#f7f8fc);border-top:1px solid var(--ui-border,#e5e8f0);border-bottom:1px solid var(--ui-border,#e5e8f0);overflow:hidden}.capture-video-wrap video{width:100%;height:100%;object-fit:contain;display:none;background:#151820}.capture-video-wrap video.visible{display:block}.capture-placeholder{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:25px;text-align:center;background-image:radial-gradient(var(--ui-border,#dfe3ec) .8px,transparent .8px);background-size:18px 18px}.capture-symbol{width:100px;height:100px;display:grid;place-items:center;background:var(--ui-panel,#fff);border:1px solid var(--ui-border,#e5e8f0);border-radius:23px;color:var(--ui-accent,#6257db);box-shadow:0 10px 30px #3035620a}.capture-placeholder h2{font-size:18px;letter-spacing:-.4px;margin:20px 0 9px}.capture-placeholder p{font-size:12px;color:var(--ui-muted,#7c8492);max-width:320px;line-height:1.8;margin:0}.capture-placeholder>span{font-size:10px;color:var(--ui-muted,#7c8492);margin-top:20px;letter-spacing:.2px}.capture-bottom{display:flex;justify-content:space-between;gap:12px;padding:14px 18px;font-size:10px;color:var(--ui-muted,#7c8492)}.capture-bottom>span{display:flex;align-items:center;gap:6px}.capture-settings{border:1px solid var(--ui-border,#e5e8f0);border-radius:12px;background:var(--ui-panel,#fff);padding:20px;display:grid;gap:15px}.capture-settings h2{font-size:14px;margin:0 0 1px}.field{display:grid;gap:8px;font-size:11px;font-weight:600}.field select{width:100%;min-width:0;background:var(--ui-surface-2,#f7f8fc);color:var(--ui-text,#253044);border:1px solid var(--ui-border,#e5e8f0);height:35px;border-radius:6px;padding:0 9px;font:inherit;font-weight:400}.source-note{display:flex;gap:10px;align-items:center;padding:13px 10px;border:1px solid var(--ui-border,#e5e8f0);border-radius:7px;color:var(--ui-accent,#6257db)}.source-note>div{display:grid;gap:5px}.source-note strong{font-size:11px;color:var(--ui-text,#253044)}.source-note span{font-size:9px;color:var(--ui-muted,#7c8492)}.toggle-row{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:11px}.toggle-row>span{display:flex;align-items:center;gap:9px}.toggle-row>span>span{display:grid;gap:5px}.toggle-row small{color:var(--ui-muted,#7c8492);font-size:9px}.toggle-row input{appearance:none;width:29px;height:17px;border-radius:20px;background:var(--ui-border,#d8dce7);position:relative;cursor:pointer;flex-shrink:0}.toggle-row input:after{content:'';position:absolute;left:3px;top:3px;width:11px;height:11px;background:#fff;border-radius:50%;transition:transform .15s}.toggle-row input:checked{background:var(--ui-accent,#6257db)}.toggle-row input:checked:after{transform:translateX(12px)}.toggle-row input:focus-visible{outline:2px solid var(--ui-accent,#6257db);outline-offset:3px}.record-start,.record-actions button{display:flex;align-items:center;justify-content:center;gap:8px;border:none;border-radius:7px;min-height:39px;font-size:12px;font-weight:600;cursor:pointer}.record-start{background:var(--ui-accent,#6257db);color:white}.record-start:disabled{opacity:.45;cursor:not-allowed}.record-actions{display:flex;gap:8px}.record-actions button{flex:1;background:var(--ui-surface-2,#f1f3f9);color:var(--ui-text,#253044)}.record-actions .stop-recording{background:color-mix(in srgb,var(--ui-danger,#cf4961) 10%,var(--ui-panel,#fff));color:var(--ui-danger,#cf4961)}.capture-error{font-size:11px;line-height:1.7;color:var(--ui-danger,#c34e59);background:color-mix(in srgb,var(--ui-danger,#c34e59) 10%,var(--ui-panel,#fff));padding:9px 11px;border-radius:7px}.settings-hint{font-size:10px}.capture-countdown,.paused-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#11172677;color:white}.capture-countdown{font-size:90px;font-weight:700}.paused-overlay{gap:10px;font-size:17px}.recent-captures{margin-top:28px}.section-title{display:flex;align-items:center;justify-content:space-between}.section-title h2{font-size:13px;margin:0 0 14px}.section-title>span{font-size:10px;color:var(--ui-muted,#7c8492)}.recent-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.recent-grid button{display:flex;align-items:center;gap:11px;padding:12px;border:1px solid var(--ui-border,#e5e8f0);border-radius:9px;background:var(--ui-panel,#fff);color:var(--ui-text,#253044);text-align:left;cursor:pointer}.recent-thumb{display:grid;place-items:center;width:48px;height:39px;border-radius:5px;background:var(--ui-surface-2,#f7f8fc);color:var(--ui-accent,#6257db);flex-shrink:0}.recent-info{display:grid;gap:5px;flex:1;min-width:0}.recent-info strong{font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recent-info small{font-size:9px;color:var(--ui-muted,#7c8492)}@media(max-width:1100px){.recorder-workspace{padding:22px}.capture-grid{grid-template-columns:minmax(0,1fr) 240px;gap:14px}.capture-settings{padding:16px}.capture-heading p{max-width:340px}}@media(max-width:800px){.capture-grid{grid-template-columns:1fr}.capture-settings{grid-template-columns:1fr 1fr}.capture-settings h2,.capture-error,.record-start,.record-actions,.settings-hint{grid-column:1/-1}.capture-platform{display:none}.recent-grid{grid-template-columns:1fr}}@media(max-width:450px){.recorder-workspace{padding:15px}.capture-settings{grid-template-columns:1fr}.capture-bottom{font-size:9px;flex-wrap:wrap}.capture-placeholder p{font-size:11px}.capture-placeholder>span{font-size:9px}.capture-symbol{width:70px;height:70px}.capture-video-wrap{min-height:240px}}
</style>
