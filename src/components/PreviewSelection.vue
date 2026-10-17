<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { findClip } from '../core/timeline'
import { snapClipPosition, visibleVisualClips } from '../core/preview-position'
import type { PreviewGuides, PreviewPosition } from '../core/preview-position'
import type { Clip, Project } from '../core/types'

const props = defineProps<{ project: Project; clipId: string; time: number; disabled: boolean }>()
const emit = defineEmits<{ start: []; move: [position: PreviewPosition]; finish: []; cancel: []; nudge: [position: PreviewPosition] }>()
const svg = ref<SVGSVGElement>()
const dragging = ref(false)
const guides = ref<PreviewGuides>({ x: null, y: null })
const visible = computed(() => visibleVisualClips(props.project, props.time))
const selected = computed(() => {
  if (props.disabled) return undefined
  const item = dragging.value ? findClip(props.project, props.clipId) : visible.value.find(item => item.clip.id === props.clipId)
  return item && !item.track.locked ? item.clip : undefined
})
let drag: { pointerId: number; handle: SVGRectElement; original: Clip; start: PreviewPosition; inverse: DOMMatrix; scale: number; others: Clip[]; moved: boolean; lastEvent: PointerEvent } | undefined

function point(event: PointerEvent, inverse: DOMMatrix): PreviewPosition {
  const transformed = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse)
  return { x: transformed.x, y: transformed.y }
}
function start(event: PointerEvent): void {
  if (event.button !== 0 || !event.isPrimary || !selected.value || drag) return
  const matrix = svg.value?.getScreenCTM()
  if (!matrix) return
  event.preventDefault(); event.stopPropagation()
  const handle = event.currentTarget as SVGRectElement
  handle.focus({ preventScroll: true })
  const original = { ...selected.value }
  const inverse = matrix.inverse()
  drag = { pointerId: event.pointerId, handle, original, start: point(event, inverse), inverse, scale: Math.hypot(matrix.a, matrix.b), others: visible.value.filter(item => item.clip.id !== original.id).map(item => ({ ...item.clip })), moved: false, lastEvent: event }
  dragging.value = true
  emit('start')
  if (!drag) return
  try { handle.setPointerCapture(event.pointerId) } catch { /* Window listeners also handle pointers without capture. */ }
  handle.addEventListener('lostpointercapture', cancelPointer)
  window.addEventListener('pointermove', move, { passive: false })
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', cancelPointer)
  window.addEventListener('keydown', dragKeyboard, true)
  window.addEventListener('keyup', dragKeyboard, true)
  window.addEventListener('blur', cancel)
  window.addEventListener('resize', cancel)
}
function move(event: PointerEvent, bypass = event.altKey): void {
  if (!drag || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  drag.lastEvent = event
  const current = point(event, drag.inverse)
  const dx = current.x - drag.start.x, dy = current.y - drag.start.y
  if (!drag.moved && Math.hypot(dx, dy) * drag.scale < 2) return
  drag.moved = true
  const result = snapClipPosition(drag.original, { x: drag.original.x + dx, y: drag.original.y + dy }, props.project, drag.others, 6 / drag.scale, !bypass)
  guides.value = result.guides
  emit('move', { x: result.x, y: result.y })
}
function clear(): boolean {
  const current = drag
  drag = undefined
  dragging.value = false
  guides.value = { x: null, y: null }
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerup', finish)
  window.removeEventListener('pointercancel', cancelPointer)
  window.removeEventListener('keydown', dragKeyboard, true)
  window.removeEventListener('keyup', dragKeyboard, true)
  window.removeEventListener('blur', cancel)
  window.removeEventListener('resize', cancel)
  if (current) {
    current.handle.removeEventListener('lostpointercapture', cancelPointer)
    try { if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId) } catch { /* The handle can already be detached when a project changes. */ }
  }
  return !!current
}
function finish(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return
  // A click selects the box without nudging it toward a nearby alignment target.
  if (drag.moved) move(event)
  clear(); emit('finish')
}
function cancel(): void { if (clear()) emit('cancel') }
function cancelPointer(event: PointerEvent): void { if (drag?.pointerId === event.pointerId) cancel() }
function dragKeyboard(event: KeyboardEvent): void {
  if (!drag) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
  else if (event.key === 'Alt') { event.preventDefault(); move(drag.lastEvent, event.type === 'keydown') }
}
function nudge(event: KeyboardEvent): void {
  if (!selected.value || drag || event.metaKey || event.ctrlKey || event.altKey) return
  const directions: Record<string, PreviewPosition> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } }
  const direction = directions[event.key]
  if (!direction) return
  event.preventDefault(); event.stopPropagation()
  const step = event.shiftKey ? 10 : 1
  emit('nudge', { x: Math.max(-65536, Math.min(65536, selected.value.x + direction.x * step)), y: Math.max(-65536, Math.min(65536, selected.value.y + direction.y * step)) })
}
watch([() => props.clipId, () => props.project.id, () => props.project.width, () => props.project.height, () => props.time, () => props.disabled], cancel)
onBeforeUnmount(cancel)
defineExpose({ cancel })
</script>

<template>
  <svg v-if="selected" ref="svg" class="preview-selection" :class="{ dragging }" :viewBox="`0 0 ${project.width} ${project.height}`" preserveAspectRatio="xMidYMid meet" data-testid="preview-selection">
    <rect class="selection-shadow" :x="selected.x" :y="selected.y" :width="selected.width" :height="selected.height" :transform="`rotate(${selected.rotation} ${selected.x + selected.width / 2} ${selected.y + selected.height / 2})`" vector-effect="non-scaling-stroke" aria-hidden="true" />
    <rect class="selection-box" :x="selected.x" :y="selected.y" :width="selected.width" :height="selected.height" :transform="`rotate(${selected.rotation} ${selected.x + selected.width / 2} ${selected.y + selected.height / 2})`" vector-effect="non-scaling-stroke" tabindex="0" role="button" :aria-label="`调整${selected.name}的位置，拖动或使用方向键`" data-testid="preview-selected-clip" :data-preview-clip-id="selected.id" :data-x="selected.x" :data-y="selected.y" @pointerdown="start" @keydown="nudge" @contextmenu.prevent>
      <title>拖动调整位置，自动吸附边缘与中心；Alt 临时关闭吸附，方向键微调，Shift + 方向键移动 10 像素。</title>
    </rect>
    <line v-if="guides.x !== null" class="alignment-guide" :x1="guides.x" :x2="guides.x" y1="0" :y2="project.height" vector-effect="non-scaling-stroke" data-testid="preview-snap-x" aria-hidden="true" />
    <line v-if="guides.y !== null" class="alignment-guide" x1="0" :x2="project.width" :y1="guides.y" :y2="guides.y" vector-effect="non-scaling-stroke" data-testid="preview-snap-y" aria-hidden="true" />
  </svg>
</template>

<style scoped>
.preview-selection{position:absolute;inset:0;width:100%;height:100%;overflow:hidden;pointer-events:none;user-select:none}
.selection-shadow{fill:none;stroke:#111a;stroke-width:4;pointer-events:none}
.selection-box{fill:transparent;stroke:#c3a4ff;stroke-width:1.5;pointer-events:all;cursor:move;touch-action:none;outline:none}
.selection-box:focus-visible{stroke:#fff;stroke-dasharray:5 3}
.dragging .selection-box{cursor:grabbing;stroke:#e5d6ff;stroke-dasharray:none}
.alignment-guide{stroke:#fa73bd;stroke-width:1;stroke-dasharray:5 3;pointer-events:none}
</style>
