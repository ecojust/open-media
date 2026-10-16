<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Clip, Project } from '../core/types'
import { clipDuration } from '../core/timeline'
import { TimelinePreview } from '../core/preview'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ project: Project; clip: Clip; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ 'play-request': []; status: [message: string] }>()
const asset = computed(() => props.project.assets.find(item => item.id === props.clip.assetId))
const track = computed(() => props.project.tracks.find(item => item.kind === 'audio' && item.clips.some(clip => clip.id === props.clip.id)))
const duration = computed(() => clipDuration(props.clip))
const available = computed(() => Boolean(track.value && asset.value && asset.value.kind !== 'image' && duration.value > 0))
const elapsed = ref(0)
const playing = ref(false)
const preparing = ref(false)
const error = ref('')
const playLabel = computed(() => preparing.value ? '取消片段试听加载' : playing.value ? '暂停片段试听' : '单独播放片段')
let preview: TimelinePreview | undefined
let playbackAbort: AbortController | undefined
let playbackRequest = 0
let resourceVersion = 0
let frame = 0
let clockStarted = 0
let clockOffset = 0
let scrubbing = false
let resumeAfterScrub = false

function formatTime(value: number): string {
  const tenths = Math.floor(Math.max(0, value) * 10)
  return `${Math.floor(tenths / 600)}:${Math.floor(tenths / 10 % 60).toString().padStart(2, '0')}.${tenths % 10}`
}

function pause(): void {
  if (playing.value) elapsed.value = Math.min(duration.value, clockOffset + (performance.now() - clockStarted) / 1000)
  playbackRequest++
  playbackAbort?.abort()
  playbackAbort = undefined
  cancelAnimationFrame(frame)
  preparing.value = false
  playing.value = false
  preview?.pause()
}

function release(): void {
  resourceVersion++
  const previous = preview
  preview = undefined
  previous?.dispose()
}

function stop(): void {
  pause()
  release()
  elapsed.value = 0
  error.value = ''
  scrubbing = false
  resumeAfterScrub = false
}

function fail(message: string): void {
  stop()
  error.value = message
  emit('status', message)
}

function createPreview(): TimelinePreview {
  if (preview) return preview
  if (!asset.value || !track.value) throw new Error('当前片段的音频素材不可用')
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const clip = { ...props.clip, start: 0 }
  delete clip.filters
  const isolated: Project = {
    ...props.project,
    width: 1,
    height: 1,
    assets: [{ ...asset.value }],
    tracks: [{ ...track.value, muted: false, clips: [clip] }],
  }
  const version = ++resourceVersion
  let constructing = true
  let constructionError = ''
  const renderer = new TimelinePreview(canvas, isolated, message => {
    if (constructing) constructionError = message
    else if (version === resourceVersion) fail(message)
  })
  constructing = false
  if (constructionError) {
    resourceVersion++
    renderer.dispose()
    throw new Error(constructionError)
  }
  preview = renderer
  return renderer
}

async function start(): Promise<void> {
  if (props.disabled || !available.value) return
  // The editor pauses its own transport before this playback request is created.
  emit('play-request')
  if (props.disabled || !available.value) return
  error.value = ''
  if (elapsed.value >= duration.value) elapsed.value = 0
  const request = ++playbackRequest
  const abort = new AbortController()
  playbackAbort = abort
  preparing.value = true
  try {
    const renderer = createPreview()
    if (request !== playbackRequest || abort.signal.aborted) { release(); return }
    await renderer.enableAudio()
    if (request !== playbackRequest || abort.signal.aborted) return
    await renderer.playReady(elapsed.value, abort.signal)
    if (request !== playbackRequest || abort.signal.aborted) return
    preparing.value = false
    playing.value = true
    clockOffset = elapsed.value
    clockStarted = performance.now()
    const tick = () => {
      if (!playing.value || request !== playbackRequest) return
      elapsed.value = Math.min(duration.value, clockOffset + (performance.now() - clockStarted) / 1000)
      if (elapsed.value >= duration.value) {
        pause()
        release()
        return
      }
      renderer.render(elapsed.value, true)
      frame = requestAnimationFrame(tick)
    }
    tick()
  } catch (cause) {
    if (request !== playbackRequest) return
    if (cause instanceof DOMException && cause.name === 'AbortError') pause()
    else fail(`无法试听片段：${cause instanceof Error ? cause.message : String(cause)}`)
  } finally {
    if (request === playbackRequest) {
      preparing.value = false
      playbackAbort = undefined
    }
  }
}

function toggle(): void {
  if (playing.value || preparing.value) pause()
  else void start()
}

function beginScrub(): void {
  if (props.disabled || scrubbing) return
  resumeAfterScrub = playing.value || preparing.value
  scrubbing = true
  pause()
}

function scrub(event: Event): void {
  if (props.disabled || !available.value) return
  beginScrub()
  elapsed.value = Math.max(0, Math.min(duration.value, Number((event.target as HTMLInputElement).value)))
}

function finishScrub(): void {
  const resume = scrubbing && resumeAfterScrub
  scrubbing = false
  resumeAfterScrub = false
  if (resume && elapsed.value < duration.value) void start()
}

function cancelScrub(): void { scrubbing = false; resumeAfterScrub = false }

// Unrelated project edits do not interrupt the selected clip's audition.
watch(() => JSON.stringify([
  props.project.id, track.value?.id, props.clip.id, props.clip.assetId,
  props.clip.start, props.clip.trimIn, props.clip.trimOut, props.clip.speed,
  props.clip.volume, props.clip.fadeIn, props.clip.fadeOut,
  asset.value?.url, asset.value?.kind, asset.value?.duration,
]), stop, { flush: 'sync' })
watch(() => props.disabled, disabled => { if (disabled) stop() }, { flush: 'sync' })
onBeforeUnmount(stop)
defineExpose({ stop })
</script>

<template>
  <section class="audio-clip-player" data-testid="audio-clip-player" aria-label="片段试听">
    <div class="audio-clip-controls">
      <button type="button" class="audio-clip-play" :disabled="disabled || !available" :aria-label="playLabel" :title="playLabel" :aria-busy="preparing" @click="toggle">
        <Icon :name="preparing ? 'clock' : playing ? 'pause' : 'play'" :size="15" />
        <span>{{ preparing ? '加载中' : playing ? '暂停' : '单独播放' }}</span>
      </button>
      <button type="button" class="audio-clip-stop" :disabled="disabled || (!playing && !preparing && elapsed === 0)" aria-label="停止片段试听" title="停止并回到片段开头" @click="stop"><Icon name="stop" :size="14" /></button>
      <span class="audio-clip-time">{{ formatTime(elapsed) }}<span> / {{ formatTime(duration) }}</span></span>
    </div>
    <input type="range" min="0" :max="duration || 1" step="0.01" :value="elapsed" :disabled="disabled || !available" aria-label="片段试听进度" :aria-valuetext="`${formatTime(elapsed)}，共 ${formatTime(duration)}`" @pointerdown="beginScrub" @pointerup="finishScrub" @pointercancel="cancelScrub" @input="scrub" @change="finishScrub" @blur="finishScrub" />
    <p v-if="error" class="audio-clip-error" role="alert">{{ error }}</p>
    <p v-else class="audio-clip-hint">仅试听当前片段，按裁剪、速度、音量和淡入淡出播放；轨道静音不影响试听。</p>
  </section>
</template>

<style scoped>
.audio-clip-player{display:grid;gap:8px;min-width:0;padding:10px;border:1px solid var(--ed-border,#e3e6ed);border-radius:7px;background:var(--ed-bg,#f5f6fa);color:var(--ed-text,#202638)}
.audio-clip-controls{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.audio-clip-controls>button{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:29px;padding:5px 8px;font:inherit;font-size:10px;flex:none;border:1px solid var(--ed-border,#e3e6ed);border-radius:6px;background:var(--ed-panel,#fff);color:inherit;cursor:pointer}
.audio-clip-controls>button:hover:not(:disabled){border-color:var(--ed-accent,#3267f6)}
.audio-clip-controls>button:disabled{opacity:.4;cursor:not-allowed}
.audio-clip-controls>button:focus-visible,.audio-clip-player>input:focus-visible{outline:2px solid var(--ed-accent,#3267f6);outline-offset:2px}
.audio-clip-controls>.audio-clip-play{color:var(--ed-accent,#3267f6);border-color:color-mix(in srgb,var(--ed-accent,#3267f6) 15%,transparent);background:color-mix(in srgb,var(--ed-accent,#3267f6) 10%,transparent)}
.audio-clip-controls>.audio-clip-stop{width:29px;padding:5px}
.audio-clip-time{margin-left:auto;font-size:10px;white-space:nowrap;font-variant-numeric:tabular-nums}
.audio-clip-time>span{color:var(--ed-muted,#858b9a)}
.audio-clip-player>input[type=range]{width:100%;min-width:0;height:16px;padding:0;margin:0;border:0;accent-color:var(--ed-accent,#3267f6)}
.audio-clip-hint,.audio-clip-error{margin:0;font-size:10px;line-height:1.6;overflow-wrap:anywhere;color:var(--ed-muted,#858b9a)}
.audio-clip-error{color:var(--ui-danger,#bd4039)}
</style>
