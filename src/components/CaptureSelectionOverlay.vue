<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { completeCapturePicker, getCapturePickerContext, readyCapturePicker } from '../core/capture-picker-client'
import { drawSelection, limitPoint, logicalSelection, moveSelection, physicalSelection, resizeSelection, selectionAtPoint, validateSelection } from '../core/capture-selection'
import type { CaptureSelection, CaptureSelectionContext, CaptureSelectionMode, SelectionHandle, SelectionPoint, SelectionRect } from '../core/capture-selection'

const props = withDefaults(defineProps<{ context?: CaptureSelectionContext | null; embedded?: boolean; purpose?: 'record' | 'screenshot' }>(), { context: null, embedded: false })
const emit = defineEmits<{ confirm: [selection: CaptureSelection]; cancel: [] }>()
const nativeContext = ref<CaptureSelectionContext | null>(null)
const context = computed(() => props.context ?? nativeContext.value)
const isScreenshot = computed(() => (context.value?.preferences?.purpose ?? props.purpose) === 'screenshot')
const actionName = computed(() => isScreenshot.value ? '截屏' : '录制')
const requestId = new URLSearchParams(location.search).get('capture-picker') ?? ''
const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
const root = ref<HTMLElement>()
const stage = ref<HTMLElement>()
const mode = ref<CaptureSelectionMode>('region')
const selectedId = ref('')
const hoveredId = ref('')
const region = ref<SelectionRect | null>(null)
const preset = ref('original')
const outputWidth = ref(1920)
const outputHeight = ref(1080)
const error = ref('')
const loading = ref(false)
const busy = ref(false)
const handles: SelectionHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
let destroyed = false
let drag: { pointerId: number; start: SelectionPoint; original: SelectionRect | null; action: 'draw' | 'move' | SelectionHandle } | null = null

const availableModes = computed<CaptureSelectionMode[]>(() => context.value?.availableModes ?? ['region', 'window', 'screen'])
const screen = computed(() => context.value?.targets.find(target => target.kind === 'screen'))
const selected = computed(() => context.value?.targets.find(target => target.id === selectedId.value))
const hovered = computed(() => context.value?.targets.find(target => target.id === hoveredId.value))
const frame = computed(() => mode.value === 'region' ? region.value : (selected.value ?? hovered.value)?.rect)
const physical = computed(() => region.value && context.value ? physicalSelection(region.value, context.value.display) : null)
const dimensions = computed(() => mode.value === 'region' ? physical.value : (selected.value ?? hovered.value) && { width: (selected.value ?? hovered.value)!.sourceWidth, height: (selected.value ?? hovered.value)!.sourceHeight })
const outputSize = computed(() => isScreenshot.value || preset.value === 'original' ? undefined : preset.value === '1080p' ? { width: 1920, height: 1080 } : preset.value === '720p' ? { width: 1280, height: 720 } : { width: outputWidth.value, height: outputHeight.value })
const selection = computed<CaptureSelection | null>(() => {
  if (mode.value === 'region') return screen.value && physical.value ? { sourceId: screen.value.id, region: physical.value, outputSize: outputSize.value } : null
  return selected.value ? { sourceId: selected.value.id, outputSize: outputSize.value } : null
})
const validation = computed(() => {
  const message = selection.value && context.value ? validateSelection(selection.value, context.value) : ''
  return isScreenshot.value ? message?.replaceAll('录制', '截屏') : message
})
const selectionName = computed(() => mode.value === 'region' ? '自定义区域' : (selected.value ?? hovered.value)?.name ?? '')
const hint = computed(() => mode.value === 'region' ? region.value ? '拖动选区移动，拖动边角调整；方向键微调，Shift 加速' : `按住鼠标拖动，框选需要${actionName.value}的区域` : mode.value === 'window' ? selected.value ? '已选择窗口，点击其他窗口可更换' : context.value?.targets.some(target => target.kind === 'window') ? '移动鼠标高亮窗口，点击选择' : '当前屏幕没有可选窗口，请选择区域或屏幕' : `点击屏幕，确认${actionName.value}完整画面`)
const frameStyle = computed(() => {
  if (!frame.value || !context.value) return {}
  const { logicalWidth: width, logicalHeight: height } = context.value.display
  return { left: `${frame.value.x / width * 100}%`, top: `${frame.value.y / height * 100}%`, width: `${frame.value.width / width * 100}%`, height: `${frame.value.height / height * 100}%` }
})
const maskPath = computed(() => {
  if (!context.value) return ''
  const { logicalWidth: w, logicalHeight: h } = context.value.display
  let path = `M0 0H${w}V${h}H0Z`
  if (frame.value) { const { x, y, width, height } = frame.value; path += `M${x} ${y}H${x + width}V${y + height}H${x}Z` }
  return path
})
const stageStyle = computed(() => {
  if (!props.embedded || !context.value) return {}
  const ratio = context.value.display.logicalWidth / context.value.display.logicalHeight
  return { width: `min(calc(100vw - 32px), calc((100dvh - 235px) * ${ratio}))`, aspectRatio: `${ratio}` }
})

watch(context, value => {
  if (!value) return
  const preferences = value.preferences
  const preferredMode = preferences?.mode ?? 'region'
  mode.value = availableModes.value.includes(preferredMode) ? preferredMode : availableModes.value[0] ?? 'screen'
  selectedId.value = ''
  region.value = null
  hoveredId.value = ''
  const initial = value.targets.find(target => target.id === preferences?.sourceId && target.kind === mode.value)
  if (initial) selectedId.value = initial.id
  if (mode.value === 'screen') selectedId.value = screen.value?.id ?? ''
  if (mode.value === 'window' && value.availableModes?.length === 1) selectedId.value = value.targets.find(target => target.kind === 'window')?.id ?? ''
  const size = preferences?.outputSize
  preset.value = !size ? 'original' : size.width === 1920 && size.height === 1080 ? '1080p' : size.width === 1280 && size.height === 720 ? '720p' : 'custom'
  if (size) { outputWidth.value = size.width; outputHeight.value = size.height }
  void nextTick(focusPicker)
}, { immediate: true })

function focusPicker(): void {
  if (!destroyed) (stage.value ?? root.value)?.focus({ preventScroll: true })
}

function changeMode(value: CaptureSelectionMode) {
  mode.value = value
  selectedId.value = value === 'screen' ? screen.value?.id ?? '' : ''
  hoveredId.value = ''
  error.value = ''
  drag = null
}

function pointerPoint(event: PointerEvent): SelectionPoint {
  const bounds = stage.value!.getBoundingClientRect(), display = context.value!.display
  return limitPoint({ x: (event.clientX - bounds.left) / bounds.width * display.logicalWidth, y: (event.clientY - bounds.top) / bounds.height * display.logicalHeight }, display)
}

function startPointer(event: PointerEvent, action: 'draw' | 'move' | SelectionHandle = 'draw') {
  if (event.button !== 0 || !context.value || busy.value) return
  event.preventDefault()
  stage.value?.focus({ preventScroll: true })
  error.value = ''
  const point = pointerPoint(event)
  if (mode.value !== 'region') {
    const target = selectionAtPoint(context.value.targets.filter(target => target.kind === mode.value), point)
    selectedId.value = target?.id ?? ''
    hoveredId.value = ''
    return
  }
  drag = { pointerId: event.pointerId, start: point, original: region.value && { ...region.value }, action }
  if (action === 'draw') region.value = drawSelection(point, point, context.value.display)
  stage.value?.setPointerCapture(event.pointerId)
}

function movePointer(event: PointerEvent) {
  if (!context.value || busy.value) return
  const point = pointerPoint(event)
  if (!drag) {
    if (mode.value === 'window' && !selectedId.value) hoveredId.value = selectionAtPoint(context.value.targets.filter(target => target.kind === 'window'), point)?.id ?? ''
    return
  }
  if (drag.pointerId !== event.pointerId) return
  const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y }
  if (drag.action === 'draw') region.value = drawSelection(drag.start, point, context.value.display)
  else if (drag.original) region.value = drag.action === 'move' ? moveSelection(drag.original, delta, context.value.display) : resizeSelection(drag.original, drag.action, delta, context.value.display)
}

function endPointer(event: PointerEvent) {
  if (drag?.pointerId !== event.pointerId) return
  if (stage.value?.hasPointerCapture(event.pointerId)) stage.value.releasePointerCapture(event.pointerId)
  drag = null
  if (physical.value && (physical.value.width < 16 || physical.value.height < 16)) { region.value = null; error.value = '请框选至少 16 × 16 像素的区域。' }
}

function updateRegionSize(axis: 'width' | 'height', event: Event) {
  if (!physical.value || !context.value) return
  const value = Number((event.target as HTMLInputElement).value)
  const maximum = axis === 'width' ? context.value.display.pixelWidth - physical.value.x : context.value.display.pixelHeight - physical.value.y
  if (!Number.isInteger(value) || value < 16 || value > maximum) { error.value = `选区${axis === 'width' ? '宽' : '高'}度需为 16–${maximum} 像素。`; return }
  region.value = logicalSelection({ ...physical.value, [axis]: value }, context.value.display)
  error.value = ''
}

async function confirm() {
  if (busy.value || !selection.value || validation.value || error.value) return
  error.value = ''
  if (props.embedded) { emit('confirm', selection.value); return }
  busy.value = true
  try { await completeCapturePicker(requestId, selection.value) } catch (reason) { error.value = String(reason); busy.value = false }
}

async function cancel() {
  if (busy.value) return
  if (props.embedded) { emit('cancel'); return }
  busy.value = true
  try { await completeCapturePicker(requestId, null) } catch (reason) { error.value = String(reason); busy.value = false }
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); void cancel(); return }
  if (event.key === 'Tab') {
    const controls = [...root.value!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')]
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && (!root.value?.contains(document.activeElement) || document.activeElement === first)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (!root.value?.contains(document.activeElement) || document.activeElement === last)) { event.preventDefault(); first?.focus() }
    return
  }
  const element = event.target as HTMLElement
  if (element.matches('input,select,textarea,button')) return
  if (event.key === 'Enter') { event.preventDefault(); void confirm(); return }
  if (!context.value || !region.value || mode.value !== 'region' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const pixels = event.shiftKey ? 10 : 1, display = context.value.display
  region.value = moveSelection(region.value, { x: (event.key === 'ArrowLeft' ? -pixels : event.key === 'ArrowRight' ? pixels : 0) * display.logicalWidth / display.pixelWidth, y: (event.key === 'ArrowUp' ? -pixels : event.key === 'ArrowDown' ? pixels : 0) * display.logicalHeight / display.pixelHeight }, display)
}

async function loadContext() {
  if (props.embedded || props.context || !requestId) return
  loading.value = true
  error.value = ''
  try { const value = await getCapturePickerContext(requestId); if (!destroyed) nativeContext.value = value } catch (reason) { error.value = String(reason) }
  finally {
    loading.value = false
    await nextTick()
    if (!destroyed) try { await readyCapturePicker(requestId) } catch (reason) { error.value = String(reason) }
  }
}

onMounted(() => { window.addEventListener('keydown', keydown); void nextTick(focusPicker); void loadContext() })
onBeforeUnmount(() => {
  destroyed = true
  window.removeEventListener('keydown', keydown)
  drag = null
  void nextTick(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }) })
})
</script>

<template>
  <section ref="root" tabindex="-1" class="capture-selector" :class="{ embedded }" role="dialog" aria-modal="true" :aria-label="`选择${actionName}范围`" data-testid="capture-picker">
    <div v-if="context" ref="stage" class="capture-selection-stage" :class="{ 'region-mode': mode === 'region' }" :style="stageStyle" tabindex="0" :aria-label="`拖动选择${actionName}区域`" data-testid="capture-selection-stage" @pointerdown="startPointer($event)" @pointermove="movePointer" @pointerup="endPointer" @pointercancel="endPointer">
      <div class="selection-background"><slot name="background" /></div>
      <svg class="selection-shade" :viewBox="`0 0 ${context.display.logicalWidth} ${context.display.logicalHeight}`" preserveAspectRatio="none" aria-hidden="true"><path :d="maskPath" fill-rule="evenodd" /></svg>
      <div v-if="frame" class="selection-frame" :class="{ editable: mode === 'region' }" :style="frameStyle" data-testid="capture-selection-frame" @pointerdown.stop="startPointer($event, 'move')">
        <span class="selection-caption">{{ selectionName }}<b v-if="dimensions">{{ dimensions.width }} × {{ dimensions.height }}</b></span>
        <template v-if="mode === 'region' && region">
          <span v-for="handle in handles" :key="handle" class="selection-handle" :class="`handle-${handle}`" :data-testid="`capture-handle-${handle}`" aria-hidden="true" @pointerdown.stop="startPointer($event, handle)" />
          <Icon class="selection-move" name="move" :size="20" />
        </template>
      </div>
    </div>
    <header class="selection-topline"><span><Icon :name="isScreenshot ? 'camera' : 'record'" :size="17" />选择{{ actionName }}范围</span><span v-if="context" class="display-name">{{ context.display.name }}</span><button title="取消选择（Esc）" aria-label="取消选择" data-testid="capture-picker-cancel" :disabled="busy" @click="cancel"><Icon name="close" :size="17" /></button></header>
    <div class="selection-dock">
      <p v-if="error || validation" class="selection-error" role="alert"><Icon name="alert" :size="15" /><span>{{ error || validation }}</span><button v-if="!context && !loading" @click="loadContext">重试</button></p>
      <p v-else class="selection-hint" aria-live="polite">{{ loading ? `正在准备${actionName}范围…` : hint }}<span>Esc 取消</span></p>
      <div class="selection-toolbar">
        <div class="selection-modes" role="group" :aria-label="`${actionName}方式`">
          <button v-if="availableModes.includes('region')" :aria-pressed="mode === 'region'" :disabled="busy || !context" data-testid="picker-mode-region" @click="changeMode('region')"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 2v5M2 4h5M17 4h5M20 2v5M4 17v5M2 20h5M17 20h5M20 17v5M9 4h6M4 9v6M20 9v6M9 20h6" /></svg>区域</button>
          <button v-if="availableModes.includes('window')" :aria-pressed="mode === 'window'" :disabled="busy || !context" data-testid="picker-mode-window" @click="changeMode('window')"><Icon name="panel" :size="17" />窗口</button>
          <button v-if="availableModes.includes('screen')" :aria-pressed="mode === 'screen'" :disabled="busy || !context" data-testid="picker-mode-screen" @click="changeMode('screen')"><Icon name="screen" :size="17" />屏幕</button>
        </div>
        <span class="toolbar-divider" />
        <div v-if="mode === 'region' && physical" class="selection-size"><label>宽<input :value="physical.width" aria-label="选区宽度" type="number" min="16" :max="context!.display.pixelWidth - physical.x" :disabled="busy" @change="updateRegionSize('width', $event)"></label><span>×</span><label>高<input :value="physical.height" aria-label="选区高度" type="number" min="16" :max="context!.display.pixelHeight - physical.y" :disabled="busy" @change="updateRegionSize('height', $event)"></label><small>px</small></div>
        <span v-else class="selection-summary">{{ dimensions ? `${dimensions.width} × ${dimensions.height} px` : '请在画面上选择' }}</span>
        <label v-if="!isScreenshot" class="selection-output">输出<select v-model="preset" aria-label="输出尺寸" :disabled="busy"><option value="original">原始尺寸</option><option value="1080p">1920 × 1080</option><option value="720p">1280 × 720</option><option value="custom">自定义</option></select></label>
        <div v-if="!isScreenshot && preset === 'custom'" class="selection-custom"><input v-model.number="outputWidth" aria-label="输出宽度" type="number" min="16" max="7680" step="2" :disabled="busy"><span>×</span><input v-model.number="outputHeight" aria-label="输出高度" type="number" min="16" max="4320" step="2" :disabled="busy"></div>
        <button class="selection-confirm" :disabled="busy || !selection || !!validation || !!error" data-testid="capture-picker-confirm" @click="confirm"><svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><circle cx="10" cy="10" r="6" fill="currentColor" /></svg>{{ busy ? '正在确认…' : isScreenshot ? '截取图片' : '开始录制' }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.capture-selector{--ui-select-arrow:var(--ui-select-arrow-light);--ui-text:#283345;color-scheme:light;--ui-line:#e3e8ef;--ui-surface:#fff;--ui-hover:#f2f5fa;--ui-border-strong:#c6d0de;--ui-accent:#3267f6;position:fixed;inset:0;z-index:10000;color:#283345;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;user-select:none;overflow:hidden}.capture-selector.embedded{background:#151a25ed;display:flex;justify-content:center;align-items:flex-start;padding-top:58px;backdrop-filter:blur(5px)}.capture-selection-stage{position:absolute;inset:0;touch-action:none;cursor:default;overflow:hidden}.embedded .capture-selection-stage{position:relative;inset:auto;flex:none;border-radius:4px;box-shadow:0 12px 60px #0006}.capture-selection-stage.region-mode{cursor:crosshair}.selection-background{position:absolute;inset:0;pointer-events:none}.selection-background :deep(video){display:block;width:100%;height:100%;object-fit:fill}.selection-shade{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.selection-shade path{fill:#101a2e48}.selection-frame{position:absolute;box-shadow:inset 0 0 0 2px #f24759,0 0 0 1px #fff7;pointer-events:none}.selection-frame.editable{pointer-events:auto;cursor:move}.selection-caption{position:absolute;top:7px;left:8px;max-width:calc(100% - 16px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#172034df;border:1px solid #ffffff3b;border-radius:5px;padding:5px 7px;color:#fff;display:flex;gap:12px;align-items:center;font-size:11px;pointer-events:none}.selection-caption b{font-weight:600;font-variant-numeric:tabular-nums}.selection-move{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:white;filter:drop-shadow(0 1px 3px #000);pointer-events:none}.selection-handle{position:absolute;width:10px;height:10px;background:white;border:2px solid #f24759;border-radius:2px;transform:translate(-50%,-50%)}.handle-nw{left:0;top:0;cursor:nwse-resize}.handle-n{left:50%;top:0;cursor:ns-resize}.handle-ne{left:100%;top:0;cursor:nesw-resize}.handle-e{left:100%;top:50%;cursor:ew-resize}.handle-se{left:100%;top:100%;cursor:nwse-resize}.handle-s{left:50%;top:100%;cursor:ns-resize}.handle-sw{left:0;top:100%;cursor:nesw-resize}.handle-w{left:0;top:50%;cursor:ew-resize}.selection-topline{position:absolute;top:14px;left:16px;right:16px;display:flex;align-items:center;gap:12px;pointer-events:none;color:white;font-size:12px;text-shadow:0 1px 3px #0009}.selection-topline>span:first-child{display:flex;align-items:center;gap:7px}.display-name{font-size:10px;opacity:.8}.selection-topline>button{margin-left:auto;pointer-events:auto;background:#172034d9;color:#fff;border:1px solid #ffffff50;border-radius:6px;width:29px;height:29px;padding:5px}.selection-dock{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);width:max-content;max-width:calc(100% - 28px);display:grid;gap:9px;justify-items:center;pointer-events:none}.selection-hint,.selection-error{margin:0;max-width:100%;display:flex;gap:12px;align-items:center;color:#fff;background:#182338e8;box-shadow:0 3px 20px #0002;border:1px solid #ffffff26;border-radius:7px;padding:8px 12px;font-size:11px;line-height:1.6;pointer-events:auto}.selection-hint>span{white-space:nowrap;opacity:.65}.selection-error{color:#ffb9c2}.selection-error>span{overflow-wrap:anywhere}.selection-error button{padding:3px 7px;white-space:nowrap;background:#fff;color:#283345}.selection-toolbar{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:10px;padding:10px;background:#fff;box-shadow:0 8px 40px #10172a38;border:1px solid #d6dde8;border-radius:10px;max-width:100%;pointer-events:auto}.selection-modes{display:flex;gap:3px;padding:3px;background:#f1f4f8;border-radius:7px}.selection-modes>button{padding:6px 9px;background:transparent;border-color:transparent;font-size:12px;white-space:nowrap}.selection-modes>button[aria-pressed=true]{background:#fff;color:#df3d51;box-shadow:0 1px 5px #15284d12}.toolbar-divider{height:24px;width:1px;background:#e3e8ef}.selection-size,.selection-custom{display:flex;align-items:center;gap:6px}.selection-size label{display:flex;align-items:center;gap:4px;font-size:10px;color:#7a8698}.selection-size input,.selection-custom input{width:65px;padding:6px 4px;text-align:center;font-variant-numeric:tabular-nums;font-size:12px}.selection-size small{font-size:10px;color:#8b96a8}.selection-size>span,.selection-custom>span{color:#a2acba}.selection-summary{font-size:11px;color:#6b778c;white-space:nowrap}.selection-output{display:flex;align-items:center;gap:6px;font-size:11px;color:#7a8698}.selection-confirm{background:#df3d51!important;border:1px solid #df3d51!important;color:#fff!important;border-radius:6px;padding:8px 12px;font-weight:600;white-space:nowrap}.selection-confirm:hover:not(:disabled){background:#c92c40!important}.selection-confirm:disabled{opacity:.42}.selection-toolbar input:focus-visible,.selection-toolbar select:focus-visible,.selection-toolbar button:focus-visible{outline:2px solid #3267f6;outline-offset:2px}.selection-toolbar input::-webkit-inner-spin-button{appearance:none}.selection-toolbar input[type=number]{appearance:textfield}@media(max-width:680px){.selection-dock{bottom:12px;max-width:calc(100% - 16px)}.selection-toolbar{gap:8px;padding:8px}.selection-hint{font-size:10px;padding:6px 9px;gap:6px}.selection-hint>span{display:none}.toolbar-divider{display:none}.selection-topline{top:10px;left:12px;right:12px}.selection-modes>button{padding:5px 8px;font-size:11px}.selection-size input,.selection-custom input{width:57px}.selection-confirm{padding:8px 10px;font-size:11px}.selection-caption{font-size:10px}.display-name{max-width:35%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.capture-selector.embedded{padding-top:54px}}
</style>
