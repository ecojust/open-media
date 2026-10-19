<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Clip, NormalizedRect, Project } from '../core/types'
import { clipDuration, findClip } from '../core/timeline'
import { animatedClipAt } from '../core/visual-animation'
import { focusLocalPoint } from '../core/focus-region'

const props = defineProps<{ project: Project; clipId: string; time: number; active: boolean; disabled?: boolean }>()
const emit = defineEmits<{ select: [region: NormalizedRect]; cancel: [] }>()
const svg = ref<SVGSVGElement>(), region = ref<NormalizedRect>()
const selected = computed(() => {
  if (!props.active || props.disabled) return undefined
  const found = findClip(props.project, props.clipId)
  if (!found || found.track.kind !== 'video' || found.track.locked || props.time < found.clip.start || props.time >= found.clip.start + clipDuration(found.clip)) return undefined
  return animatedClipAt(found.clip, props.time)
})
const selection = computed(() => {
  const clip = selected.value, r = region.value
  return clip && r ? { x: clip.x + r.x * clip.width, y: clip.y + r.y * clip.height, width: r.width * clip.width, height: r.height * clip.height } : undefined
})
let drag: { pointerId: number; handle: SVGSVGElement; clip: Clip; inverse: DOMMatrix; start: { x: number; y: number }; screen: { x: number; y: number } } | undefined
function localPoint(event: PointerEvent, inverse: DOMMatrix, clip: Clip): { x: number; y: number } {
  const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse)
  return focusLocalPoint(clip, p)
}
function start(event: PointerEvent): void {
  if (event.button !== 0 || !event.isPrimary || !selected.value || drag) return
  const matrix = svg.value?.getScreenCTM(), handle = svg.value
  if (!matrix || !handle) return
  const clip = { ...selected.value }, inverse = matrix.inverse(), point = localPoint(event, inverse, clip)
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return
  event.preventDefault(); event.stopPropagation(); region.value = undefined
  drag = { pointerId: event.pointerId, handle, clip, inverse, start: point, screen: { x: event.clientX, y: event.clientY } }
  try { handle.setPointerCapture(event.pointerId) } catch { /* Window listeners also cover pointer capture loss. */ }
  window.addEventListener('pointermove', move, { passive: false })
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', cancelPointer)
  window.addEventListener('blur', cancel)
  window.addEventListener('resize', cancel)
}
function move(event: PointerEvent): void {
  if (!drag || drag.pointerId !== event.pointerId) return
  event.preventDefault()
  const p = localPoint(event, drag.inverse, drag.clip), x = Math.max(0, Math.min(1, p.x)), y = Math.max(0, Math.min(1, p.y))
  region.value = { x: Math.min(x, drag.start.x), y: Math.min(y, drag.start.y), width: Math.abs(x - drag.start.x), height: Math.abs(y - drag.start.y) }
}
function clear(): void {
  const previous = drag; drag = undefined
  window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish)
  window.removeEventListener('pointercancel', cancelPointer); window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel)
  if (previous) try { if (previous.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId) } catch { /* A changing preview can detach the selection. */ }
}
function finish(event: PointerEvent): void {
  if (!drag || drag.pointerId !== event.pointerId) return
  move(event)
  const distance = Math.hypot(event.clientX - drag.screen.x, event.clientY - drag.screen.y), value = region.value
  clear()
  if (distance >= 6 && value && value.width >= .001 && value.height >= .001) emit('select', { ...value })
  else region.value = undefined
}
function cancel(): void { clear(); region.value = undefined; if (props.active) emit('cancel') }
function cancelPointer(event: PointerEvent): void { if (drag?.pointerId === event.pointerId) cancel() }
function keydown(event: KeyboardEvent): void { if (props.active && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() } }
watch(() => props.active, active => { clear(); region.value = undefined; if (active) window.addEventListener('keydown', keydown, true); else window.removeEventListener('keydown', keydown, true) }, { immediate: true })
watch([() => props.clipId, () => props.project.id, () => props.project.width, () => props.project.height, () => props.time, () => props.disabled], () => { if (props.active) cancel() })
onBeforeUnmount(() => { clear(); window.removeEventListener('keydown', keydown, true) })
</script>

<template>
  <div v-if="active" class="focus-region-overlay" data-testid="preview-focus-region">
    <svg v-if="selected" ref="svg" class="focus-region-canvas" :viewBox="`0 0 ${project.width} ${project.height}`" preserveAspectRatio="xMidYMid meet" aria-label="在预览画面拖动框选重点区域" @pointerdown="start" @contextmenu.prevent>
      <g :transform="`rotate(${selected.rotation} ${selected.x + selected.width / 2} ${selected.y + selected.height / 2})`">
        <rect class="focus-source" :x="selected.x" :y="selected.y" :width="selected.width" :height="selected.height" vector-effect="non-scaling-stroke" />
        <rect v-if="selection" class="focus-picked" v-bind="selection" vector-effect="non-scaling-stroke" data-testid="focus-selection-box" />
      </g>
    </svg>
    <div class="focus-instruction"><span>{{ selected ? '拖动框选重点区域 · Esc 取消' : '请先定位到选中片段的画面' }}</span><button type="button" @click.stop="cancel">取消</button></div>
  </div>
</template>

<style scoped>
.focus-region-overlay{position:absolute;inset:0;z-index:4;pointer-events:none;overflow:hidden}.focus-region-canvas{width:100%;height:100%;pointer-events:all;cursor:crosshair;touch-action:none;user-select:none}.focus-source{fill:#15192720;stroke:#c8b6ff;stroke-dasharray:5 4;stroke-width:1}.focus-picked{fill:#b29aff30;stroke:#f0eaff;stroke-width:2}.focus-instruction{position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid #bba1ff80;border-radius:8px;background:#202139e8;box-shadow:0 3px 15px #0004;color:#f2edff;white-space:nowrap;font-size:12px;pointer-events:all}.focus-instruction button{border:1px solid #c1b5e980;background:transparent;color:inherit;border-radius:5px;padding:3px 7px;font:inherit;cursor:pointer}
</style>
