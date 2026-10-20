<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ active: boolean; working: boolean }>()
const canvas = ref<HTMLCanvasElement>()
const motion = ref<'animated' | 'static' | 'paused' | 'inactive'>('inactive')
const frameInterval = 1000 / 30, turn = Math.PI * 2
let context: CanvasRenderingContext2D | null = null
let observer: ResizeObserver | undefined, motionQuery: MediaQueryList | undefined
let border: Path2D | undefined, base: CanvasGradient | undefined
let width = 0, height = 0, ratio = 1, frame = 0, lastFrame = 0, phase = .2
let mounted = false

function stop(): void {
  cancelAnimationFrame(frame)
  frame = 0; lastFrame = 0
}
function animate(): boolean {
  return mounted && props.active && !document.hidden && !motionQuery?.matches && !!context && width > 20 && height > 20
}
function paint(): void {
  const ctx = context
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)
  if (!props.active || !border || !base) return

  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.lineWidth = 1; ctx.globalAlpha = props.working ? .5 : .3
  ctx.strokeStyle = base; ctx.stroke(border)

  // A single small gradient follows the cached outline; no geometry or layout work per frame.
  const light = typeof ctx.createConicGradient === 'function'
    ? ctx.createConicGradient(phase, width / 2, height / 2)
    : ctx.createLinearGradient(width / 2 + Math.cos(phase) * width / 2, height / 2 + Math.sin(phase) * height / 2,
      width / 2 - Math.cos(phase) * width / 2, height / 2 - Math.sin(phase) * height / 2)
  light.addColorStop(0, '#22d3ee00')
  light.addColorStop(.08, '#22d3ee00')
  light.addColorStop(.16, '#22d3ee55')
  light.addColorStop(.21, '#67e8f9ef')
  light.addColorStop(.225, '#cffafe')
  light.addColorStop(.23, '#22d3ee00')
  light.addColorStop(.5, '#a78bfa00')
  light.addColorStop(.58, '#a78bfa00')
  light.addColorStop(.66, '#a78bfa55')
  light.addColorStop(.71, '#c4b5fdef')
  light.addColorStop(.725, '#ede9fe')
  light.addColorStop(.73, '#a78bfa00')
  light.addColorStop(1, '#22d3ee00')
  ctx.strokeStyle = light
  ctx.lineWidth = props.working ? 2.2 : 1.8
  ctx.globalAlpha = props.working ? 1 : .8
  ctx.shadowColor = '#7195ff'; ctx.shadowBlur = props.working ? 8 : 5
  ctx.stroke(border)
  ctx.shadowBlur = 0; ctx.lineWidth = 1.2
  ctx.stroke(border)
  ctx.globalAlpha = 1
}
function tick(time: number): void {
  frame = 0
  if (!animate()) { sync(); return }
  if (!lastFrame) lastFrame = time
  const elapsed = time - lastFrame
  if (elapsed >= frameInterval) {
    phase = (phase + Math.min(elapsed, 100) / (props.working ? 4200 : 9000) * turn) % turn
    lastFrame = time - elapsed % frameInterval
    paint()
  }
  frame = requestAnimationFrame(tick)
}
function sync(): void {
  if (!mounted) return
  stop()
  if (!props.active) { motion.value = 'inactive'; paint(); return }
  if (document.hidden) { motion.value = 'paused'; return }
  paint()
  if (animate()) { motion.value = 'animated'; frame = requestAnimationFrame(tick) }
  else motion.value = 'static'
}
function measure(): void {
  const element = canvas.value
  if (!mounted || !element || !context) return
  const rect = element.getBoundingClientRect()
  const nextRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  if (rect.width === width && rect.height === height && nextRatio === ratio && border) return
  width = rect.width; height = rect.height; ratio = nextRatio
  element.width = Math.ceil(width * ratio); element.height = Math.ceil(height * ratio)
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  // The canvas extends ten pixels beyond the host; the outline sits on its outer border.
  const left = 9, top = 9, right = Math.max(left, width - 9), bottom = Math.max(top, height - 9)
  const radius = Math.max(0, Math.min(10, (right - left) / 2, (bottom - top) / 2))
  border = new Path2D()
  border.moveTo(left + radius, top); border.lineTo(right - radius, top)
  border.arcTo(right, top, right, top + radius, radius); border.lineTo(right, bottom - radius)
  border.arcTo(right, bottom, right - radius, bottom, radius); border.lineTo(left + radius, bottom)
  border.arcTo(left, bottom, left, bottom - radius, radius); border.lineTo(left, top + radius)
  border.arcTo(left, top, left + radius, top, radius); border.closePath()
  base = context.createLinearGradient(left, top, right, bottom)
  base.addColorStop(0, '#22d3ee'); base.addColorStop(.5, '#a78bfa'); base.addColorStop(1, '#2dd4bf')
  sync()
}

watch([() => props.active, () => props.working], sync, { flush: 'post' })
onMounted(() => {
  mounted = true
  context = canvas.value?.getContext('2d') ?? null
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  motionQuery.addEventListener('change', sync)
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('resize', measure)
  const host = canvas.value?.parentElement
  if (host) { observer = new ResizeObserver(measure); observer.observe(host) }
  measure()
})
onBeforeUnmount(() => {
  mounted = false; stop(); observer?.disconnect()
  motionQuery?.removeEventListener('change', sync)
  document.removeEventListener('visibilitychange', sync)
  window.removeEventListener('resize', measure)
  context = null; border = undefined; base = undefined
})
</script>

<template>
  <canvas ref="canvas" class="mcp-status-glow" data-testid="mcp-status-glow" :data-motion="motion" :data-mode="working ? 'working' : 'waiting'" aria-hidden="true"/>
</template>

<style scoped>
.mcp-status-glow{position:absolute;inset:-10px;width:calc(100% + 20px);height:calc(100% + 20px);pointer-events:none;user-select:none}
</style>
