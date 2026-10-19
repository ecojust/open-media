<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { clampImageCrop, imageCropFromPoints, imageRulerTicks, moveImageCrop, resizeImageCrop, type ImageCrop, type ImageCropHandle, type ImagePoint } from '../core/image-crop'
import { drawImageAnnotations, type ImageAnnotation } from '../core/image-annotations'

const props = withDefaults(defineProps<{ source: string; width: number; height: number; modelValue?: ImageCrop; disabled?: boolean; annotations?: ImageAnnotation[] }>(), { disabled: false, annotations: () => [] })
const emit = defineEmits<{ 'update:modelValue': [crop: ImageCrop | undefined] }>()
const viewport = ref<HTMLDivElement | null>(null)
const stage = ref<HTMLDivElement | null>(null)
const annotationCanvas = ref<HTMLCanvasElement | null>(null)
const metrics = reactive({ width: 600, height: 320, left: 0, top: 0 })
const zoom = ref('fit')
const tool = ref<'draw' | 'move'>('draw')
const snapStep = ref(1)
const showGrid = ref(true)
const imageReady = ref(false)
const imageFailed = ref(false)
const local = ref<ImageCrop | undefined>(props.modelValue ? { ...props.modelValue } : undefined)
const sourceWidth = computed(() => Math.max(1, Math.round(props.width)))
const sourceHeight = computed(() => Math.max(1, Math.round(props.height)))
const crop = computed(() => clampImageCrop(local.value || { x: 0, y: 0, width: sourceWidth.value, height: sourceHeight.value }, sourceWidth.value, sourceHeight.value))
const scale = computed(() => zoom.value === 'fit' ? Math.min(1, metrics.width / sourceWidth.value, metrics.height / sourceHeight.value) : Number(zoom.value) / 100)
const stageStyle = computed(() => ({ width: `${sourceWidth.value * scale.value}px`, height: `${sourceHeight.value * scale.value}px` }))
const selectionStyle = computed(() => ({ left: `${crop.value.x * scale.value}px`, top: `${crop.value.y * scale.value}px`, width: `${crop.value.width * scale.value}px`, height: `${crop.value.height * scale.value}px` }))
const gridStep = computed(() => {
  const minimum = Math.max(snapStep.value, 8 / scale.value)
  const power = 10 ** Math.floor(Math.log10(minimum))
  const interval = [1, 2, 5, 10].find(value => value * power >= minimum)! * power
  return Math.max(snapStep.value, Math.ceil(interval / snapStep.value) * snapStep.value)
})
const gridStyle = computed(() => ({ backgroundSize: `${gridStep.value * scale.value}px ${gridStep.value * scale.value}px` }))
const horizontalTicks = computed(() => imageRulerTicks(sourceWidth.value, scale.value, metrics.left, metrics.width))
const verticalTicks = computed(() => imageRulerTicks(sourceHeight.value, scale.value, metrics.top, metrics.height))
const maskPath = computed(() => {
  const { x, y, width, height } = crop.value
  return `M0 0H${sourceWidth.value}V${sourceHeight.value}H0Z M${x} ${y}V${y + height}H${x + width}V${y}Z`
})
const handles: { id: ImageCropHandle; label: string }[] = [
  { id: 'nw', label: '左上角' }, { id: 'n', label: '上边' }, { id: 'ne', label: '右上角' }, { id: 'e', label: '右边' },
  { id: 'se', label: '右下角' }, { id: 's', label: '下边' }, { id: 'sw', label: '左下角' }, { id: 'w', label: '左边' },
]
const fields: { key: keyof ImageCrop; label: string }[] = [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }, { key: 'width', label: '宽' }, { key: 'height', label: '高' }]
let observer: ResizeObserver | undefined
let annotationFrame = 0
let drag: { pointerId: number; kind: 'draw' | 'move' | ImageCropHandle; start: ImagePoint; crop: ImageCrop; original: ImageCrop | undefined; changed: boolean } | undefined

function scheduleAnnotations(): void {
  if (!annotationFrame) annotationFrame = requestAnimationFrame(() => { annotationFrame = 0; drawAnnotations() })
}
function drawAnnotations(): void {
  const element = annotationCanvas.value
  if (!element) return
  if (!props.annotations.length) { element.width = 0; element.height = 0; return }
  const width = sourceWidth.value, height = sourceHeight.value
  // Keep a bounded backing surface even when zooming into a very large image.
  const renderScale = Math.min(scale.value * Math.min(2, window.devicePixelRatio || 1), 4096 / width, 4096 / height, Math.sqrt(8_000_000 / (width * height)))
  const renderWidth = Math.max(1, Math.round(width * renderScale)), renderHeight = Math.max(1, Math.round(height * renderScale))
  if (element.width !== renderWidth || element.height !== renderHeight) { element.width = renderWidth; element.height = renderHeight }
  const context = element.getContext('2d')
  if (!context) return
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, renderWidth, renderHeight)
  context.setTransform(renderWidth / width, 0, 0, renderHeight / height, 0, 0)
  drawImageAnnotations(context, props.annotations)
}
function syncMetrics(): void {
  const element = viewport.value
  if (!element) return
  metrics.width = Math.max(1, element.clientWidth)
  metrics.height = Math.max(1, element.clientHeight)
  metrics.left = element.scrollLeft
  metrics.top = element.scrollTop
}
function commit(value: ImageCrop | undefined): void {
  if (props.disabled) return
  local.value = value ? { ...value } : undefined
  emit('update:modelValue', value ? { ...value } : undefined)
}
function point(event: PointerEvent): ImagePoint {
  const rect = stage.value!.getBoundingClientRect()
  return { x: (event.clientX - rect.left) / scale.value, y: (event.clientY - rect.top) / scale.value }
}
function begin(event: PointerEvent, kind: 'draw' | 'move' | ImageCropHandle): void {
  if (props.disabled || !imageReady.value || event.button !== 0 || !event.isPrimary || !stage.value) return
  event.preventDefault()
  stage.value.focus({ preventScroll: true })
  stage.value.setPointerCapture(event.pointerId)
  drag = { pointerId: event.pointerId, kind, start: point(event), crop: { ...crop.value }, original: local.value ? { ...local.value } : undefined, changed: false }
}
function update(event: PointerEvent): void {
  if (!drag || drag.pointerId !== event.pointerId || props.disabled) return
  const current = point(event)
  const delta = { x: current.x - drag.start.x, y: current.y - drag.start.y }
  if (!drag.changed && Math.hypot(delta.x * scale.value, delta.y * scale.value) < 2) return
  drag.changed = true
  if (drag.kind === 'draw') commit(imageCropFromPoints(drag.start, current, sourceWidth.value, sourceHeight.value, snapStep.value))
  else if (drag.kind === 'move') commit(moveImageCrop(drag.crop, delta, sourceWidth.value, sourceHeight.value, snapStep.value))
  else commit(resizeImageCrop(drag.crop, drag.kind, delta, sourceWidth.value, sourceHeight.value, snapStep.value))
}
function finish(event?: PointerEvent): void {
  if (!drag || (event && event.pointerId !== drag.pointerId)) return
  if (event) update(event)
  const completed = drag
  drag = undefined
  if (stage.value?.hasPointerCapture(completed.pointerId)) stage.value.releasePointerCapture(completed.pointerId)
  if (completed.changed) tool.value = 'move'
}
function cancelDrag(): void {
  if (!drag) return
  const original = drag.original
  const pointerId = drag.pointerId
  drag = undefined
  if (!props.disabled) commit(original)
  if (stage.value?.hasPointerCapture(pointerId)) stage.value.releasePointerCapture(pointerId)
}
function editField(key: keyof ImageCrop, event: Event): void {
  const input = event.target as HTMLInputElement
  if (!props.disabled && input.value.trim() && Number.isFinite(input.valueAsNumber)) {
    const current = { ...crop.value }
    const value = Math.round(input.valueAsNumber)
    if (key === 'x') current.x = Math.min(sourceWidth.value - current.width, Math.max(0, value))
    else if (key === 'y') current.y = Math.min(sourceHeight.value - current.height, Math.max(0, value))
    else if (key === 'width') current.width = Math.min(sourceWidth.value - current.x, Math.max(1, value))
    else current.height = Math.min(sourceHeight.value - current.y, Math.max(1, value))
    commit(current)
    tool.value = 'move'
  }
  input.value = String(crop.value[key])
}
function maximum(key: keyof ImageCrop): number {
  if (key === 'x') return sourceWidth.value - crop.value.width
  if (key === 'y') return sourceHeight.value - crop.value.height
  if (key === 'width') return sourceWidth.value - crop.value.x
  return sourceHeight.value - crop.value.y
}
function keyboard(event: KeyboardEvent): void {
  if (props.disabled) return
  if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); cancelDrag(); return }
  const step = event.shiftKey ? 10 : 1
  const deltas: Record<string, ImagePoint> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }
  if (!deltas[event.key]) return
  event.preventDefault()
  event.stopPropagation()
  commit(moveImageCrop(crop.value, deltas[event.key], sourceWidth.value, sourceHeight.value))
  tool.value = 'move'
  void nextTick(keepSelectionVisible)
}
function keepSelectionVisible(): void {
  const element = viewport.value
  if (!element) return
  const left = crop.value.x * scale.value, top = crop.value.y * scale.value
  const right = (crop.value.x + crop.value.width) * scale.value, bottom = (crop.value.y + crop.value.height) * scale.value
  if (left < element.scrollLeft) element.scrollLeft = left
  else if (right > element.scrollLeft + element.clientWidth && right - left <= element.clientWidth) element.scrollLeft = right - element.clientWidth
  if (top < element.scrollTop) element.scrollTop = top
  else if (bottom > element.scrollTop + element.clientHeight && bottom - top <= element.clientHeight) element.scrollTop = bottom - element.clientHeight
  syncMetrics()
}
function reset(): void { cancelDrag(); commit(undefined); tool.value = 'draw' }
function setZoom(): void {
  finish()
  void nextTick(() => {
    const element = viewport.value
    if (!element) return
    element.scrollLeft = zoom.value === 'fit' ? 0 : Math.max(0, (crop.value.x + crop.value.width / 2) * scale.value - element.clientWidth / 2)
    element.scrollTop = zoom.value === 'fit' ? 0 : Math.max(0, (crop.value.y + crop.value.height / 2) * scale.value - element.clientHeight / 2)
    syncMetrics()
  })
}
watch(() => props.modelValue, value => { local.value = value ? { ...value } : undefined }, { deep: true })
watch(() => [props.source, props.width, props.height], (value, previous) => {
  finish()
  local.value = props.modelValue ? { ...props.modelValue } : undefined
  if (value[0] !== previous[0]) { imageReady.value = false; imageFailed.value = false }
  zoom.value = 'fit'
  tool.value = 'draw'
  void nextTick(() => { if (viewport.value) { viewport.value.scrollLeft = 0; viewport.value.scrollTop = 0 }; syncMetrics() })
})
watch(() => props.disabled, value => { if (value) finish() })
watch([() => props.annotations, sourceWidth, sourceHeight, scale], scheduleAnnotations, { deep: true, flush: 'post' })
onMounted(() => {
  syncMetrics()
  scheduleAnnotations()
  observer = new ResizeObserver(syncMetrics)
  if (viewport.value) observer.observe(viewport.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  cancelAnimationFrame(annotationFrame)
  if (annotationCanvas.value) { annotationCanvas.value.width = 0; annotationCanvas.value.height = 0 }
  finish()
})
</script>

<template>
  <div class="image-crop-editor" data-testid="image-crop-editor">
    <div class="crop-toolbar">
      <div class="crop-tools" role="group" aria-label="框选工具">
        <button type="button" :aria-pressed="tool === 'draw'" :disabled="disabled" title="重新拖动框选" @click="tool = 'draw'"><Icon name="crop" :size="15" />框选</button>
        <button type="button" :aria-pressed="tool === 'move'" :disabled="disabled" title="拖动选区移动位置" @click="tool = 'move'"><Icon name="move" :size="15" />移动</button>
      </div>
      <label class="crop-inline">缩放<select v-model="zoom" aria-label="框选预览缩放" :disabled="disabled" @change="setZoom"><option value="fit">适应画布</option><option value="50">50%</option><option value="100">100%</option><option value="200">200%</option><option value="400">400%</option><option value="800">800%</option></select></label>
      <button class="crop-reset" type="button" :disabled="disabled" @click="reset"><Icon name="refresh" :size="14" />全图</button>
    </div>
    <div class="crop-fields">
      <label v-for="field in fields" :key="field.key"><span>{{ field.label }}</span><input type="number" :aria-label="`框选${field.label}`" :value="crop[field.key]" :min="field.key === 'x' || field.key === 'y' ? 0 : 1" :max="maximum(field.key)" step="1" :disabled="disabled" @change="editField(field.key, $event)" /><span class="crop-unit">px</span></label>
    </div>
    <div class="crop-grid-options">
      <label class="crop-grid-toggle"><input v-model="showGrid" type="checkbox" :disabled="disabled" />显示网格</label>
      <label class="crop-inline">吸附<select v-model.number="snapStep" aria-label="框选吸附步长" :disabled="disabled"><option :value="1">1 px</option><option :value="2">2 px</option><option :value="5">5 px</option><option :value="10">10 px</option><option :value="20">20 px</option><option :value="50">50 px</option><option :value="100">100 px</option></select></label>
      <span class="crop-scale-info">{{ Math.round(scale * 100) }}%<template v-if="showGrid"> · 网格 {{ gridStep }} px</template></span>
    </div>
    <div class="crop-stage-layout" :class="{ 'crop-disabled': disabled }">
      <div class="crop-ruler-corner" aria-hidden="true">px</div>
      <svg class="crop-ruler crop-ruler-top" :style="{ width: `${metrics.width}px` }" :viewBox="`0 0 ${metrics.width} 24`" preserveAspectRatio="none" aria-label="原图横向像素刻度">
        <g v-for="tick in horizontalTicks" :key="tick.value"><path :d="`M${tick.offset} ${tick.major ? 14 : 19}V24`" /><text v-if="tick.major" :x="tick.offset + 3" y="11">{{ tick.value }}</text></g>
      </svg>
      <svg class="crop-ruler crop-ruler-left" :style="{ height: `${metrics.height}px` }" :viewBox="`0 0 28 ${metrics.height}`" preserveAspectRatio="none" aria-label="原图纵向像素刻度">
        <g v-for="tick in verticalTicks" :key="tick.value"><path :d="`M${tick.major ? 18 : 23} ${tick.offset}H28`" /><text v-if="tick.major" :transform="`translate(11 ${tick.offset + 3}) rotate(90)`">{{ tick.value }}</text></g>
      </svg>
      <div ref="viewport" class="crop-viewport" data-testid="crop-viewport" @scroll="syncMetrics">
        <div ref="stage" class="crop-stage" :class="{ 'crop-draw': tool === 'draw', 'crop-pixelated': scale >= 2 }" :style="stageStyle" :tabindex="disabled ? -1 : 0" role="group" aria-label="图片框选画布，方向键移动选区" @pointerdown="begin($event, tool)" @pointermove="update" @pointerup="finish" @pointercancel="cancelDrag" @lostpointercapture="finish()" @keydown="keyboard">
          <img :src="source" alt="原图框选预览" draggable="false" @load="imageReady = true" @error="imageFailed = true; imageReady = false" />
          <canvas ref="annotationCanvas" class="crop-annotations" width="0" height="0" data-testid="crop-annotations" aria-hidden="true" />
          <div v-if="showGrid" class="crop-grid" :style="gridStyle" aria-hidden="true" />
          <svg class="crop-mask" :viewBox="`0 0 ${sourceWidth} ${sourceHeight}`" preserveAspectRatio="none" aria-hidden="true"><path :d="maskPath" fill-rule="evenodd" /></svg>
          <div class="crop-selection" :style="selectionStyle" data-testid="crop-selection" aria-hidden="true">
            <button v-for="handle in handles" :key="handle.id" class="crop-handle" :class="`crop-handle-${handle.id}`" type="button" tabindex="-1" :disabled="disabled" :title="`拖动调整${handle.label}`" :data-crop-handle="handle.id" @pointerdown.stop="begin($event, handle.id)" />
          </div>
        </div>
      </div>
    </div>
    <p v-if="imageFailed" class="crop-error" role="alert">无法加载原图，请关闭框选后重新打开图片。</p>
    <p v-else class="crop-help">{{ tool === 'draw' ? '拖动框选，拖动边角调整范围。' : '拖动选区移动，点击“框选”可重新选择。' }}方向键微调 1 px，Shift + 方向键移动 10 px。</p>
    <div class="crop-summary" role="status"><span>原图 {{ sourceWidth }} × {{ sourceHeight }} px</span><strong>选区 {{ crop.width }} × {{ crop.height }} px</strong></div>
  </div>
</template>

<style scoped>
.image-crop-editor{box-sizing:border-box;width:100%;padding:12px;min-width:0;color:var(--ui-text);font-size:12px;container:crop-editor / inline-size}
.crop-toolbar,.crop-grid-options{display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-width:0}
.crop-tools{display:flex;gap:4px}.crop-toolbar button{height:32px;padding:0 9px;font-size:12px}.crop-tools button[aria-pressed=true]{background:var(--ui-accent-soft);border-color:var(--ui-accent);color:var(--ui-accent)}
.crop-inline{display:flex;align-items:center;gap:6px;margin:0;font-size:11px;white-space:nowrap}.crop-inline select{width:104px}.crop-toolbar>.crop-inline{margin-left:auto}.crop-reset{flex-shrink:0}
.crop-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:13px 0 10px}.crop-fields>label{display:flex;align-items:center;gap:5px;min-width:0;font-size:11px}.crop-fields input{width:100%;min-width:0;height:32px;padding:0 5px;font-size:12px;font-variant-numeric:tabular-nums}.crop-unit{font-size:10px;color:var(--ui-muted)}
.crop-grid-options{margin-bottom:11px}.crop-grid-toggle{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:11px}.crop-grid-toggle input{margin:0}.crop-grid-options select{width:84px}.crop-scale-info{margin-left:auto;color:var(--ui-muted);font-size:10px;font-variant-numeric:tabular-nums}
.crop-stage-layout{display:grid;grid-template-columns:28px minmax(0,1fr);grid-template-rows:24px minmax(0,1fr);height:clamp(220px,43dvh,400px);border:1px solid var(--ui-line);border-radius:6px;overflow:hidden;background:var(--ui-surface-2)}
.crop-ruler-corner{grid-row:1;grid-column:1;display:flex;align-items:center;justify-content:center;color:var(--ui-muted);font-size:9px;border-right:1px solid var(--ui-line);border-bottom:1px solid var(--ui-line)}
.crop-ruler{display:block;width:100%;height:100%;color:var(--ui-muted);overflow:hidden;user-select:none}.crop-ruler-top{grid-row:1;grid-column:2;border-bottom:1px solid var(--ui-line)}.crop-ruler-left{grid-row:2;grid-column:1;border-right:1px solid var(--ui-line)}.crop-ruler path{stroke:currentColor;stroke-width:1;opacity:.65}.crop-ruler text{fill:currentColor;font-family:inherit;font-size:9px;font-variant-numeric:tabular-nums}
.crop-viewport{grid-row:2;grid-column:2;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ui-border-strong) var(--ui-surface-2)}
.crop-stage{position:relative;isolation:isolate;touch-action:none;user-select:none;cursor:move;background-color:var(--ui-surface);background-image:linear-gradient(45deg,var(--ui-line) 25%,transparent 25%),linear-gradient(-45deg,var(--ui-line) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--ui-line) 75%),linear-gradient(-45deg,transparent 75%,var(--ui-line) 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}
.crop-stage:focus-visible{outline:2px solid var(--ui-accent);outline-offset:-2px}.crop-stage.crop-draw{cursor:crosshair}.crop-stage>img{display:block;position:absolute;inset:0;width:100%;height:100%;max-width:none;pointer-events:none}.crop-stage.crop-pixelated>img{image-rendering:pixelated}
.crop-annotations,.crop-grid,.crop-mask{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.crop-grid{background-image:linear-gradient(to right,#fff4 1px,transparent 1px),linear-gradient(to bottom,#fff4 1px,transparent 1px);filter:drop-shadow(0 0 1px #0008)}.crop-mask{fill:#07101f73}
.crop-selection{position:absolute;box-sizing:border-box;border:1px solid #fff;outline:1px solid var(--ui-accent);outline-offset:-2px}.crop-selection::before{content:'';position:absolute;inset:0;border:1px dashed var(--ui-accent);pointer-events:none}
.crop-handle{position:absolute;z-index:1;width:10px;height:10px;min-width:0;min-height:0;padding:0;border:1px solid var(--ui-accent);border-radius:2px;background:#fff;transform:translate(-50%,-50%);box-shadow:0 0 0 1px #0003}.crop-handle:hover:enabled{background:var(--ui-accent-soft);border-color:var(--ui-accent)}
.crop-handle-nw{left:0;top:0;cursor:nwse-resize}.crop-handle-n{left:50%;top:0;cursor:ns-resize}.crop-handle-ne{left:100%;top:0;cursor:nesw-resize}.crop-handle-e{left:100%;top:50%;cursor:ew-resize}.crop-handle-se{left:100%;top:100%;cursor:nwse-resize}.crop-handle-s{left:50%;top:100%;cursor:ns-resize}.crop-handle-sw{left:0;top:100%;cursor:nesw-resize}.crop-handle-w{left:0;top:50%;cursor:ew-resize}
.crop-disabled{opacity:.6}.crop-disabled .crop-stage{cursor:default}.crop-help{font-size:10px;color:var(--ui-muted);line-height:1.7;margin:10px 0 6px}.crop-error{font-size:11px;color:var(--ui-danger);margin:10px 0 6px}.crop-summary{display:flex;justify-content:space-between;flex-wrap:wrap;gap:5px;color:var(--ui-muted);font-size:10px;font-variant-numeric:tabular-nums}.crop-summary strong{font-weight:500;color:var(--ui-text)}
@container crop-editor (max-width:450px){.crop-toolbar>.crop-inline{margin-left:0}.crop-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.crop-toolbar{gap:8px}.crop-reset{margin-left:auto}.crop-scale-info{width:100%;margin-left:0}.crop-stage-layout{height:300px}.crop-fields{gap:8px 12px}.crop-inline select{width:95px}}
@container crop-editor (max-width:320px){.crop-toolbar{gap:6px}.crop-toolbar>.crop-inline{order:3;width:100%;justify-content:space-between}.crop-toolbar>.crop-inline select{width:120px}.crop-fields{gap:8px}.crop-unit{display:none}.crop-help{font-size:10px}}
@media(max-height:600px){.crop-stage-layout{height:220px}}
</style>
