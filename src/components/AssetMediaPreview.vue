<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{ src: string; kind: 'video' | 'audio'; active: boolean }>()
const emit = defineEmits<{ 'preview-start': []; 'preview-stop': [] }>()
const root = ref<HTMLElement | null>(null)
const media = ref<HTMLMediaElement | null>(null)
const state = ref<'idle' | 'loading' | 'playing' | 'blocked' | 'error'>('idle')
const hint = computed(() => state.value === 'blocked' ? '点击试听' : state.value === 'error' ? '无法预览，点击重试' : state.value === 'loading' ? '正在加载' : props.kind === 'video' ? '静音预览' : '正在试听')
let observer: IntersectionObserver | undefined
let visible = false
let disposed = false
let request = 0
let startTimer: ReturnType<typeof setTimeout> | undefined

function wanted(): boolean { return !disposed && visible && props.active && !document.hidden }
function attach(): void {
  const element = media.value
  if (disposed || !visible || !element || !props.src || props.kind === 'audio' && !wanted()) return
  if (element.getAttribute('src') !== props.src) element.src = props.src
}
function stop(release = false): void {
  request++
  clearTimeout(startTimer); startTimer = undefined
  state.value = 'idle'
  const element = media.value
  if (!element) return
  element.pause()
  if (release || props.kind === 'audio') {
    if (element.hasAttribute('src')) { element.removeAttribute('src'); element.load() }
  } else {
    element.preload = 'metadata'
    if (element.readyState > 0 && element.currentTime > 0) {
      try { element.currentTime = 0 } catch { /* A detached decoder may no longer accept seeks. */ }
    }
  }
}
async function start(): Promise<void> {
  clearTimeout(startTimer); startTimer = undefined
  if (!wanted() || state.value === 'playing') return
  const element = media.value
  if (!element) return
  const current = ++request
  state.value = 'loading'
  attach()
  element.preload = 'auto'
  emit('preview-start')
  try {
    await element.play()
    if (current !== request || !wanted()) { if (!wanted()) element.pause(); return }
    state.value = 'playing'
  } catch (cause) {
    if (current !== request || !wanted()) return
    state.value = cause instanceof DOMException && cause.name === 'NotAllowedError' ? 'blocked' : 'error'
  }
}
function schedule(): void {
  if (!wanted()) { stop(!visible || document.hidden); return }
  clearTimeout(startTimer)
  // Passing the pointer across the library should not start a succession of decoders.
  startTimer = setTimeout(() => { void start() }, 180)
}
function visibilityChanged(): void {
  if (document.hidden) { stop(true); emit('preview-stop') }
  // Returning to the application waits for a new pointer or keyboard interaction.
}
function failed(): void { if (wanted() && media.value?.error) state.value = 'error' }
function playFromGesture(): void { if (wanted()) void start() }

watch(() => props.active, schedule, { flush: 'sync' })
watch(() => props.src, () => { stop(true); attach(); schedule() })
onMounted(() => {
  const element = root.value
  if (!element) return
  document.addEventListener('visibilitychange', visibilityChanged)
  if (typeof IntersectionObserver === 'undefined') { visible = true; attach(); schedule(); return }
  observer = new IntersectionObserver(entries => {
    if (disposed) return
    visible = entries.some(entry => entry.isIntersecting)
    if (visible) { attach(); schedule() } else { stop(true); if (props.active) emit('preview-stop') }
  }, { root: element.closest('.asset-list'), rootMargin: '0px' })
  observer.observe(element)
})
onBeforeUnmount(() => {
  disposed = true
  observer?.disconnect()
  document.removeEventListener('visibilitychange', visibilityChanged)
  stop(true)
})
defineExpose({ playFromGesture, stop })
</script>

<template>
  <div ref="root" class="asset-media-preview" :class="{ 'asset-media-audio': kind === 'audio', 'asset-media-playing': state === 'playing' }" :data-preview-state="state">
    <video v-if="kind === 'video'" ref="media" preload="metadata" muted playsinline loop @error="failed" />
    <template v-else><audio ref="media" preload="none" loop @error="failed" /><Icon name="audio" :size="28" /><span v-if="state === 'playing'" class="asset-audio-bars" aria-hidden="true"><i /><i /><i /><i /></span></template>
    <span v-if="active && state !== 'idle'" class="asset-preview-hint" :class="{ 'asset-preview-error': state === 'error' }" role="status"><Icon :name="state === 'loading' ? 'clock' : state === 'playing' ? kind === 'video' ? 'volume-off' : 'volume' : 'play'" :size="10" />{{ hint }}</span>
  </div>
</template>

<style scoped>
.asset-media-preview{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;overflow:hidden}
.asset-media-preview video{display:block;width:100%;height:100%;object-fit:cover}.asset-media-preview audio{display:none}
.asset-preview-hint{position:absolute;display:flex;align-items:center;gap:3px;left:4px;top:4px;max-width:calc(100% - 8px);box-sizing:border-box;padding:2px 4px;border-radius:3px;background:#151824cc;color:#fff;font-size:8px;line-height:12px;white-space:normal;text-align:left;pointer-events:none}
.asset-preview-hint>svg{flex:none}.asset-preview-error{background:#6b3339e6}
.asset-audio-bars{position:absolute;bottom:7px;left:50%;transform:translateX(-50%);display:flex;align-items:end;gap:3px;height:10px}
.asset-audio-bars i{display:block;width:3px;height:5px;background:currentColor;border-radius:2px;animation:asset-audio-wave .65s ease-in-out infinite alternate}.asset-audio-bars i:nth-child(2){height:9px;animation-delay:-.2s}.asset-audio-bars i:nth-child(3){height:7px;animation-delay:-.45s}.asset-audio-bars i:nth-child(4){height:4px;animation-delay:-.1s}
@keyframes asset-audio-wave{to{height:2px;opacity:.5}}
@media(prefers-reduced-motion:reduce){.asset-audio-bars i{animation:none}}
</style>
