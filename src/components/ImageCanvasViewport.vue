<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { imageRulerTicks } from '../core/image-crop'
import { fitImageCanvas, IMAGE_CANVAS_MAX_SCALE, IMAGE_CANVAS_MIN_SCALE, resizeImageCanvas, revealImageCanvasBounds, zoomImageCanvas, type ImageCanvasBounds, type ImageCanvasPoint, type ImageCanvasView } from '../core/image-canvas-viewport'

const props = withDefaults(defineProps<{ width: number; height: number; disabled?: boolean; label?: string; readonly?: boolean; rulers?: boolean }>(), { disabled: false, label: '图片画布', readonly: false, rulers: false })
const emit = defineEmits<{ 'view-change': [view: ImageCanvasView]; 'select-tool': [] }>()
const viewport = ref<HTMLDivElement>()
const view = reactive<ImageCanvasView>({ scale: 1, offsetX: 0, offsetY: 0, viewportWidth: 1, viewportHeight: 1 })
const fitted = ref(true), grid = ref(true), hand = ref(false), space = ref(false), dragging = ref(false)
const pointerInside = ref(false), pointerOverSurface = ref(false)
let observer: ResizeObserver | undefined
let pan: { id: number; x: number; y: number; offsetX: number; offsetY: number } | undefined
let suppressClick = false
const canPan = computed(() => hand.value || space.value || props.readonly)
const percentage = computed(() => `${Number((view.scale * 100).toFixed(view.scale < .01 ? 2 : 0))}%`)
const stageStyle = computed(() => ({ width: `${Math.max(1, props.width)}px`, height: `${Math.max(1, props.height)}px`, transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})` }))
const horizontalTicks = computed(() => props.rulers ? imageRulerTicks(props.width, view.scale, -view.offsetX, view.viewportWidth) : [])
const verticalTicks = computed(() => props.rulers ? imageRulerTicks(props.height, view.scale, -view.offsetY, view.viewportHeight) : [])

function update(next: ImageCanvasView): void {
  Object.assign(view, next)
  emit('view-change', { ...view })
}
function fit(): void {
  fitted.value = true
  update(fitImageCanvas(props.width, props.height, viewport.value?.clientWidth || view.viewportWidth, viewport.value?.clientHeight || view.viewportHeight))
}
function setZoom(scale: number, anchor?: ImageCanvasPoint): void {
  if (props.disabled) return
  fitted.value = false
  update(zoomImageCanvas(view, scale, anchor))
}
function actualSize(): void { setZoom(1) }
function zoomIn(): void { setZoom(view.scale * 1.25) }
function zoomOut(): void { setZoom(view.scale / 1.25) }
function selectTool(): void { hand.value = false; space.value = false; endPan() }
function ensureVisible(bounds: ImageCanvasBounds): void {
  const next = revealImageCanvasBounds(view, bounds)
  if (next.offsetX === view.offsetX && next.offsetY === view.offsetY) return
  fitted.value = false
  update(next)
}
function measure(): void {
  const element = viewport.value
  if (!element || element.clientWidth < 1 || element.clientHeight < 1) return
  if (fitted.value) fit()
  else update(resizeImageCanvas(view, element.clientWidth, element.clientHeight))
}
function editableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
}
function controlsTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest('.image-canvas-navigation') || (!!target.closest('button, a') && !target.closest('.image-canvas-stage'))
}
function pointerDown(event: PointerEvent): void {
  suppressClick = false
  if (props.disabled || controlsTarget(event.target) || editableTarget(event.target)) return
  if (event.button !== 1 && !(event.button === 0 && canPan.value)) return
  event.preventDefault(); event.stopPropagation()
  viewport.value?.focus({ preventScroll: true })
  pan = { id: event.pointerId, x: event.clientX, y: event.clientY, offsetX: view.offsetX, offsetY: view.offsetY }
  suppressClick = true
  dragging.value = true
  viewport.value?.setPointerCapture(event.pointerId)
}
function click(event: MouseEvent): void {
  if (!suppressClick) return
  suppressClick = false
  event.preventDefault(); event.stopPropagation()
}
function pointerMove(event: PointerEvent): void {
  if (!pan || event.pointerId !== pan.id) return
  event.preventDefault(); event.stopPropagation()
  fitted.value = false
  update({ ...view, offsetX: pan.offsetX + event.clientX - pan.x, offsetY: pan.offsetY + event.clientY - pan.y })
}
function pointerUp(event: PointerEvent): void {
  if (!pan || event.pointerId !== pan.id) return
  event.preventDefault(); event.stopPropagation(); endPan()
}
function endPan(): void {
  const id = pan?.id
  pan = undefined; dragging.value = false
  if (id !== undefined && viewport.value?.hasPointerCapture(id)) viewport.value.releasePointerCapture(id)
}
function releaseKeys(): void { space.value = false; endPan() }
function focusOut(event: FocusEvent): void {
  if (!(event.relatedTarget instanceof Node) || !viewport.value?.contains(event.relatedTarget)) releaseKeys()
}
function keyDown(event: KeyboardEvent, fromOutside = false): void {
  if (props.disabled || editableTarget(event.target) || (!fromOutside && controlsTarget(event.target)) || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.code === 'Space') { event.preventDefault(); event.stopPropagation(); space.value = true }
  else if (event.key.toLowerCase() === 'h') { event.preventDefault(); event.stopPropagation(); hand.value = true }
  else if (event.key.toLowerCase() === 'v') { event.preventDefault(); event.stopPropagation(); selectTool(); emit('select-tool') }
}
function hoveredKeyDown(event: KeyboardEvent): void {
  if (!pointerInside.value || !pointerOverSurface.value || editableTarget(document.activeElement)) return
  if (event.target instanceof Node && viewport.value?.contains(event.target) && !controlsTarget(event.target)) return
  keyDown(event, true)
  if (event.defaultPrevented) viewport.value?.focus({ preventScroll: true })
}
function keyUp(event: KeyboardEvent): void {
  if (event.code === 'Space' && space.value) { event.preventDefault(); event.stopPropagation(); space.value = false; endPan() }
}
function wheel(event: WheelEvent): void {
  if (props.disabled || editableTarget(event.target) || controlsTarget(event.target)) return
  event.preventDefault(); event.stopPropagation()
  viewport.value?.focus({ preventScroll: true })
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.viewportHeight : 1
  const deltaX = event.deltaX * factor, deltaY = event.deltaY * factor
  if (event.ctrlKey || event.metaKey) {
    const bounds = viewport.value!.getBoundingClientRect()
    setZoom(view.scale * Math.exp(-Math.max(-150, Math.min(150, deltaY)) * .008), { x: event.clientX - bounds.left, y: event.clientY - bounds.top })
  } else {
    fitted.value = false
    update({ ...view, offsetX: view.offsetX - (event.shiftKey && !deltaX ? deltaY : deltaX), offsetY: view.offsetY - (event.shiftKey && !deltaX ? 0 : deltaY) })
  }
}
watch(() => [props.width, props.height], fit)
watch(() => props.disabled, disabled => { if (disabled) releaseKeys() })
onMounted(() => {
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(viewport.value!)
  viewport.value!.addEventListener('wheel', wheel, { passive: false })
  window.addEventListener('blur', releaseKeys)
  window.addEventListener('keydown', hoveredKeyDown, true)
  window.addEventListener('keyup', keyUp)
})
onBeforeUnmount(() => {
  endPan(); observer?.disconnect()
  viewport.value?.removeEventListener('wheel', wheel)
  window.removeEventListener('blur', releaseKeys)
  window.removeEventListener('keydown', hoveredKeyDown, true)
  window.removeEventListener('keyup', keyUp)
})
defineExpose({ fit, actualSize, zoomIn, zoomOut, setZoom, ensureVisible, selectTool })
</script>

<template>
  <div ref="viewport" class="image-canvas-viewport" :class="{ 'has-grid': grid, 'can-pan': canPan, 'is-panning': dragging, 'has-rulers': rulers }" data-testid="image-canvas-viewport" :aria-label="label" role="group" tabindex="0" @keydown.capture="keyDown" @focusout="focusOut" @pointerenter="pointerInside = true" @pointerover="pointerOverSurface = !controlsTarget($event.target) && !editableTarget($event.target)" @pointerleave="pointerInside = false; pointerOverSurface = false" @pointerdown.capture="pointerDown" @pointermove.capture="pointerMove" @pointerup.capture="pointerUp" @pointercancel.capture="pointerUp" @lostpointercapture="endPan" @click.capture="click">
    <div class="image-canvas-stage" data-testid="image-canvas-stage" :style="stageStyle">
      <slot v-bind="view" />
    </div>
    <template v-if="rulers">
      <svg class="image-canvas-ruler image-canvas-ruler-top" aria-hidden="true" :width="view.viewportWidth" height="22">
        <g v-for="tick in horizontalTicks" :key="tick.value" :transform="`translate(${tick.offset},0)`"><path :d="`M0 ${tick.major ? 14 : 18}V22`"/><text v-if="tick.major" x="3" y="10">{{ tick.value }}</text></g>
      </svg>
      <svg class="image-canvas-ruler image-canvas-ruler-left" aria-hidden="true" width="22" :height="view.viewportHeight">
        <g v-for="tick in verticalTicks" :key="tick.value" :transform="`translate(0,${tick.offset})`"><path :d="`M${tick.major ? 14 : 18} 0H22`"/><text v-if="tick.major" x="3" y="-4" transform="rotate(-90 9 0)">{{ tick.value }}</text></g>
      </svg>
      <span class="image-canvas-ruler-origin" aria-hidden="true">px</span>
    </template>
    <div class="image-canvas-navigation" role="toolbar" aria-label="画布视图">
      <button type="button" :aria-pressed="grid" title="显示点阵网格" aria-label="显示点阵网格" :disabled="disabled" @click="grid = !grid"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle v-for="point in [[5,5],[12,5],[19,5],[5,12],[12,12],[19,12],[5,19],[12,19],[19,19]]" :key="point.join(',')" :cx="point[0]" :cy="point[1]" r="1.2"/></svg></button>
      <button type="button" :aria-pressed="hand" title="手形工具 (H)，选择工具 (V)" aria-label="手形工具" :disabled="disabled" @click="hand = !hand"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M7.5 12V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-7a1.5 1.5 0 0 1 3 0v8-5a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6 7h-1c-2 0-3.5-1-4.5-2.5l-4-6a1.5 1.5 0 0 1 2.3-1.9l2.2 2.4"/></svg></button>
      <span class="image-canvas-nav-divider"/>
      <button type="button" title="缩小" aria-label="缩小画布" :disabled="disabled || view.scale <= IMAGE_CANVAS_MIN_SCALE" @click="zoomOut"><Icon name="zoom-out" :size="17"/></button>
      <button type="button" class="image-canvas-percentage" title="实际像素 (100%)" aria-label="画布实际大小" :disabled="disabled" @click="actualSize">{{ percentage }}</button>
      <button type="button" title="放大" aria-label="放大画布" :disabled="disabled || view.scale >= IMAGE_CANVAS_MAX_SCALE" @click="zoomIn"><Icon name="zoom-in" :size="17"/></button>
      <span class="image-canvas-nav-divider"/>
      <button type="button" :aria-pressed="fitted" title="适应画布" aria-label="适应画布" :disabled="disabled" @click="fit"><Icon name="fit" :size="17"/></button>
    </div>
  </div>
</template>

<style scoped>
.image-canvas-viewport{position:relative;isolation:isolate;flex:1;min-width:0;min-height:280px;height:100%;overflow:hidden;overscroll-behavior:none;touch-action:none;outline:none;background:var(--ui-bg,#f2f4f8);--canvas-dot:color-mix(in srgb,var(--ui-muted,#7f8999) 26%,transparent)}
.image-canvas-viewport.has-grid{background-image:radial-gradient(circle,var(--canvas-dot) .8px,transparent .9px);background-size:18px 18px}
.image-canvas-viewport:focus-visible{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ui-accent,#5378ef) 45%,transparent)}
.image-canvas-stage{position:absolute;left:0;top:0;transform-origin:0 0;box-shadow:0 0 0 1px color-mix(in srgb,var(--ui-muted,#7f8999) 30%,transparent),0 12px 38px #00000018;background-color:var(--ui-surface,#fff);background-image:linear-gradient(45deg,#9297a319 25%,transparent 25%),linear-gradient(-45deg,#9297a319 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#9297a319 75%),linear-gradient(-45deg,transparent 75%,#9297a319 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}
.image-canvas-stage:deep(>img),.image-canvas-stage:deep(>canvas){display:block;width:100%;height:100%;max-width:none;max-height:none;user-select:none;-webkit-user-drag:none}
.image-canvas-viewport.can-pan,.image-canvas-viewport.can-pan :deep(.image-canvas-stage *){cursor:grab!important}
.image-canvas-viewport.is-panning,.image-canvas-viewport.is-panning :deep(*){cursor:grabbing!important;user-select:none!important}
.image-canvas-ruler{position:absolute;z-index:2;pointer-events:none;background:color-mix(in srgb,var(--ui-surface,#fff) 92%,transparent);color:var(--ui-muted,#7f8999)}
.image-canvas-ruler path{stroke:currentColor;stroke-width:.65;opacity:.65}.image-canvas-ruler text{fill:currentColor;font:9px ui-monospace,monospace}
.image-canvas-ruler-top{left:0;top:0;border-bottom:1px solid var(--ui-line,#dfe4ec)}.image-canvas-ruler-left{top:0;left:0;border-right:1px solid var(--ui-line,#dfe4ec)}
.image-canvas-ruler-origin{position:absolute;top:0;left:0;z-index:3;width:22px;height:22px;display:grid;place-items:center;background:var(--ui-surface,#fff);border-right:1px solid var(--ui-line,#dfe4ec);border-bottom:1px solid var(--ui-line,#dfe4ec);font:9px ui-monospace,monospace;color:var(--ui-muted,#7f8999);pointer-events:none}
.image-canvas-navigation{position:absolute;right:14px;bottom:14px;z-index:4;display:flex;align-items:center;gap:2px;padding:4px;background:color-mix(in srgb,var(--ui-surface,#fff) 94%,transparent);border:1px solid var(--ui-line,#dfe4ec);border-radius:10px;box-shadow:0 4px 18px #00000012;backdrop-filter:blur(12px)}
.image-canvas-navigation button{display:inline-flex;align-items:center;justify-content:center;width:29px;height:29px;padding:4px;border:0;border-radius:6px;background:transparent;color:var(--ui-muted,#7f8999);flex-shrink:0}
.image-canvas-navigation button:hover:not(:disabled){background:var(--ui-hover,#eef2f9);color:var(--ui-text,#263249)}.image-canvas-navigation button[aria-pressed=true]{background:var(--ui-accent-soft,#eaf0ff);color:var(--ui-accent,#5378ef)}
.image-canvas-navigation .image-canvas-percentage{width:50px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--ui-text,#263249)}.image-canvas-nav-divider{height:16px;width:1px;background:var(--ui-line,#dfe4ec);margin:0 3px}
@media(max-width:500px){.image-canvas-navigation{right:8px;bottom:8px;gap:1px;padding:3px}.image-canvas-navigation button{width:26px;height:28px}.image-canvas-navigation .image-canvas-percentage{width:45px}.image-canvas-nav-divider{margin:0 1px}}
</style>
