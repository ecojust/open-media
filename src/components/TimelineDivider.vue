<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ target: HTMLElement | null; viewport?: HTMLElement | null; content?: HTMLElement | null; modelValue: number; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: number]; size: [height: number] }>()
const divider = ref<HTMLElement | null>(null)
const available = ref(0)
const contentLimit = ref(Number.POSITIVE_INFINITY)
const height = ref(0)
const dragging = ref(false)
const controlledPanelId = ref<string>()
const DEFAULT_RATIO = 0.4
const MIN_PREVIEW = 180
const MIN_TIMELINE = 150
const limits = computed(() => {
  const scale = Math.min(1, available.value / (MIN_PREVIEW + MIN_TIMELINE))
  const max = Math.max(0, Math.min(contentLimit.value, available.value - MIN_PREVIEW * scale))
  return { min: Math.min(MIN_TIMELINE * scale, max), max }
})
const percentage = computed(() => available.value ? Math.round(height.value / available.value * 100) : 40)
const minimumPercentage = computed(() => available.value ? Math.round(limits.value.min / available.value * 100) : 0)
const maximumPercentage = computed(() => available.value ? Math.round(limits.value.max / available.value * 100) : 100)
let observer: ResizeObserver | undefined
let resizeFrame = 0
let dragStyle: HTMLStyleElement | undefined
let gesture: { pointerId: number; startY: number; startHeight: number; startRatio: number; element: HTMLElement } | undefined

function clampHeight(value: number): number {
  return Math.max(limits.value.min, Math.min(limits.value.max, value))
}

function setHeight(value: number, updateRatio = false): void {
  const next = Math.round(clampHeight(value) * 100) / 100
  if (Math.abs(next - height.value) > 0.01) {
    height.value = next
    emit('size', next)
  }
  if (updateRatio && available.value) emit('update:modelValue', next / available.value)
}

function measure(): void {
  const root = props.target, handle = divider.value
  const preview = handle?.previousElementSibling
  if (!root || !handle || !(preview instanceof HTMLElement) || !root.contains(handle)) return
  const rootBounds = root.getBoundingClientRect()
  const paddingBottom = Number.parseFloat(getComputedStyle(root).paddingBottom) || 0
  const bottom = rootBounds.top + root.clientTop + root.clientHeight - paddingBottom
  available.value = Math.max(0, bottom - preview.getBoundingClientRect().top - handle.getBoundingClientRect().height)
  const panel = handle.nextElementSibling, viewport = props.viewport, content = props.content
  controlledPanelId.value = panel?.id || undefined
  contentLimit.value = Number.POSITIVE_INFINITY
  if (panel instanceof HTMLElement && viewport && content && panel.contains(viewport) && viewport.contains(content)) {
    // scrollHeight is at least the viewport height, so it cannot detect empty
    // space below the last track. Measure the natural content and real chrome.
    const chrome = Math.max(0, panel.getBoundingClientRect().height - viewport.getBoundingClientRect().height)
    const scrollbarAndBorders = Math.max(0, viewport.offsetHeight - viewport.clientHeight)
    contentLimit.value = chrome + content.getBoundingClientRect().height + scrollbarAndBorders
  }
  const ratio = Number.isFinite(props.modelValue) ? props.modelValue : DEFAULT_RATIO
  setHeight(available.value * Math.max(0, Math.min(1, ratio)))
}

function scheduleMeasure(): void {
  if (resizeFrame) return
  resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; measure() })
}

function endDrag(): void {
  const previous = gesture
  gesture = undefined
  dragging.value = false
  dragStyle?.remove()
  dragStyle = undefined
  if (previous?.element.hasPointerCapture(previous.pointerId)) previous.element.releasePointerCapture(previous.pointerId)
}

function startDrag(event: PointerEvent): void {
  if (props.disabled || event.button !== 0 || !event.isPrimary) return
  measure()
  if (!available.value || !divider.value) return
  endDrag()
  const element = divider.value
  try { element.setPointerCapture(event.pointerId) } catch { return }
  event.preventDefault()
  element.focus({ preventScroll: true })
  gesture = { pointerId: event.pointerId, startY: event.clientY, startHeight: height.value, startRatio: height.value / available.value, element }
  dragging.value = true
  // Remove this temporary stylesheet as a unit, without replacing existing page styles.
  dragStyle = document.createElement('style')
  dragStyle.textContent = 'html,body,body *{cursor:row-resize!important;user-select:none!important;-webkit-user-select:none!important}'
  document.head.append(dragStyle)
}

function moveDrag(event: PointerEvent): void {
  if (!gesture || gesture.pointerId !== event.pointerId) return
  if (props.disabled || event.buttons === 0) { endDrag(); return }
  event.preventDefault()
  setHeight(gesture.startHeight + gesture.startY - event.clientY, true)
}

function finishPointer(event: PointerEvent): void {
  if (gesture?.pointerId === event.pointerId) endDrag()
}

function resetSize(): void {
  if (props.disabled) return
  endDrag()
  measure()
  setHeight(available.value * DEFAULT_RATIO, true)
}

function keyboard(event: KeyboardEvent): void {
  if (props.disabled) return
  if (event.key === 'Escape' && gesture) {
    event.preventDefault()
    setHeight(available.value * gesture.startRatio, true)
    endDrag()
    return
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Enter') { resetSize(); return }
  measure()
  const step = event.shiftKey ? 40 : 12
  const next = event.key === 'Home' ? limits.value.min : event.key === 'End' ? limits.value.max : height.value + (event.key === 'ArrowUp' ? step : -step)
  setHeight(next, true)
}

watch(() => props.modelValue, scheduleMeasure)
watch(() => props.disabled, value => { if (value) endDrag() })
watch([() => props.target, () => props.viewport, () => props.content, divider], ([target, viewport, content, handle]) => {
  endDrag()
  observer?.disconnect()
  if (target) {
    observer = new ResizeObserver(scheduleMeasure)
    const panel = handle?.nextElementSibling
    const elements = new Set<Element>([target])
    for (const element of [handle, panel, viewport, content, ...Array.from(panel?.children ?? [])]) {
      if (element && target.contains(element)) elements.add(element)
    }
    for (const element of elements) observer.observe(element)
    scheduleMeasure()
  }
}, { flush: 'post', immediate: true })

onMounted(() => {
  window.addEventListener('resize', scheduleMeasure)
  window.addEventListener('blur', endDrag)
  scheduleMeasure()
})

onBeforeUnmount(() => {
  endDrag()
  observer?.disconnect()
  cancelAnimationFrame(resizeFrame)
  window.removeEventListener('resize', scheduleMeasure)
  window.removeEventListener('blur', endDrag)
})
</script>

<template>
  <div ref="divider" class="timeline-divider" :class="{ dragging, disabled }" role="separator" aria-orientation="horizontal" aria-label="调整时间线高度" :aria-controls="controlledPanelId" :aria-disabled="disabled || undefined" :aria-valuemin="minimumPercentage" :aria-valuemax="maximumPercentage" :aria-valuenow="percentage" :aria-valuetext="`时间线占用 ${percentage}% 高度`" :tabindex="disabled ? -1 : 0" title="上下拖动调整时间线高度 · 双击恢复默认 · 方向键微调" data-testid="timeline-divider" @pointerdown.stop="startDrag" @pointermove.stop="moveDrag" @pointerup.stop="finishPointer" @pointercancel.stop="finishPointer" @lostpointercapture="finishPointer" @dblclick.stop.prevent="resetSize" @keydown.stop="keyboard">
    <svg viewBox="0 0 28 6" width="28" height="6" aria-hidden="true"><path d="M4 3h20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
  </div>
</template>

<style scoped>
.timeline-divider{height:9px;flex:0 0 9px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;background:var(--ed-bg,#f5f6fa);border-top:1px solid var(--ed-border,#e3e6ed);color:var(--ed-muted,#858b9a);cursor:row-resize;touch-action:none;user-select:none;position:relative;z-index:11;outline:none}
.timeline-divider svg{pointer-events:none;transition:color .12s}
.timeline-divider:hover:not(.disabled),.timeline-divider.dragging,.timeline-divider:focus-visible{background:color-mix(in srgb,var(--ed-accent,#3267f6) 12%,var(--ed-panel,#fff));color:var(--ed-accent,#3267f6)}
.timeline-divider:focus-visible{box-shadow:inset 0 0 0 1px var(--ed-accent,#3267f6)}
.timeline-divider.disabled{cursor:default;opacity:.55}
@media(pointer:coarse){.timeline-divider{height:15px;flex-basis:15px}}
</style>
