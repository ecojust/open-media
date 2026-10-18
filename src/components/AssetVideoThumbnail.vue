<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ src: string }>()
const video = ref<HTMLVideoElement | null>(null)
let observer: IntersectionObserver | undefined
let visible = false
let disposed = false

function release(): void {
  const element = video.value
  if (!element?.hasAttribute('src')) return
  element.pause()
  element.removeAttribute('src')
  element.load()
}
function attach(): void {
  if (disposed || !visible || !video.value || !props.src) return
  if (video.value.getAttribute('src') !== props.src) video.value.src = props.src
}
watch(() => props.src, () => { release(); attach() })
onMounted(() => {
  const element = video.value
  if (!element || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver(entries => {
    if (disposed) return
    visible = entries.some(entry => entry.isIntersecting)
    if (visible) attach()
    else release()
  }, { root: element.closest('.asset-list'), rootMargin: '96px 0px' })
  observer.observe(element)
})
onBeforeUnmount(() => { disposed = true; observer?.disconnect(); release() })
</script>

<template>
  <video ref="video" preload="metadata" muted playsinline />
</template>
