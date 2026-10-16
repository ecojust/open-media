<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Project } from '../core/types'
import { alignTextToSpeech, applySpeechResults, planSpeech, validateSpeechPlanCapacity, type SpeechSource } from '../core/speech'
import { compactVoiceCatalog } from '../core/voice-catalog'
import { acceptSpeechJobs, beginSpeechJob, cancelSpeechJob, discardSpeechJob, getSpeechJob, getSpeechStatus, isDesktop, type SpeechJob, type SpeechStatus } from '../native'
import Icon from './Icon.vue'
import VoicePicker from './VoicePicker.vue'

const props = defineProps<{ project: Project; selectedClipId: string; active: boolean; inDialog?: boolean }>()
const emit = defineEmits<{ change: [project: Project, label: string]; status: [message: string]; busy: [value: boolean] }>()
const desktop = isDesktop()
const status = ref<SpeechStatus>({ ready: false, voices: [] })
const loading = ref(false), busy = ref(false), cancelling = ref(false), finalizing = ref(false), error = ref(''), notice = ref('')
const voiceId = ref(''), speed = ref(1), alignText = ref(true)
const previewUrl = ref(''), player = ref<HTMLAudioElement | null>(null)
const previewVoiceId = ref(''), previewPlaying = ref(false), previewLoading = ref(false)
const previewState = computed(() => previewLoading.value ? 'loading' : previewPlaying.value ? 'playing' : 'idle')
const operationKind = ref<'all' | 'selected' | 'preview'>('all')
const generationLabel = computed(() => cancelling.value ? '正在取消…' : finalizing.value ? '正在加入时间线…' : '正在生成…')
const allPlan = computed(() => planSpeech(props.project))
const selectedPlan = computed(() => planSpeech(props.project, props.selectedClipId ? [props.selectedClipId] : []))
const selectedLinked = computed(() => props.project.tracks.some(track => track.clips.some(clip => clip.speech?.textClipId === props.selectedClipId)))
let statusPromise: Promise<void> | undefined
let disposed = false, previewJobId = ''
interface Operation { project: Project; controller: AbortController; jobs: Set<string>; current: string; applying: boolean; reason: string }
let operation: Operation | undefined

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
async function loadStatus(): Promise<void> {
  if (!desktop || disposed) return
  if (statusPromise) return statusPromise
  loading.value = true
  statusPromise = (async () => {
    try {
      const result = await getSpeechStatus()
      if (disposed) return
      status.value = result
      if (!result.voices.some(voice => voice.id === voiceId.value)) {
        const catalog = compactVoiceCatalog(result.voices)
        voiceId.value = catalog.find(voice => voice.language.toLowerCase().startsWith('zh'))?.id || catalog[0]?.id || ''
      }
    } catch (cause) { if (!disposed) status.value = { ready: false, voices: [], error: errorText(cause) } }
    finally { loading.value = false; statusPromise = undefined }
  })()
  return statusPromise
}
function checkOperation(active: Operation): void {
  if (disposed || operation !== active || active.controller.signal.aborted) throw new Error(active.reason || '已取消语音生成。')
  if (props.project !== active.project) throw new Error('项目已经变化，本次语音未写入时间线，请重新生成。')
}
function waitForPoll(active: Operation): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = () => { clearTimeout(timer); reject(new Error(active.reason || '已取消语音生成。')) }
    const timer = setTimeout(() => { active.controller.signal.removeEventListener('abort', stopped); resolve() }, 350)
    if (active.controller.signal.aborted) stopped()
    else active.controller.signal.addEventListener('abort', stopped, { once: true })
  })
}
async function discardJobs(ids: Iterable<string>): Promise<void> {
  await Promise.allSettled([...ids].map(id => discardSpeechJob(id)))
}
function clearPreview(): void {
  player.value?.pause()
  if (player.value) { player.value.removeAttribute('src'); player.value.load() }
  if (previewUrl.value) notice.value = ''
  previewUrl.value = ''
  previewVoiceId.value = ''; previewPlaying.value = false
  if (previewJobId) { const id = previewJobId; previewJobId = ''; void discardJobs([id]) }
}
async function previewVoice(id: string): Promise<void> {
  if (busy.value) return
  const voice = status.value.voices.find(item => item.id === id)
  if (!voice) return
  if (previewVoiceId.value === id && previewUrl.value && player.value) {
    if (previewPlaying.value) player.value.pause()
    else { if (player.value.ended) player.value.currentTime = 0; await player.value.play().catch(() => {}) }
    return
  }
  await run(undefined, {
    voiceId: id,
    text: voice.language.toLowerCase().startsWith('en')
      ? 'Hello, this is a voice preview. Let your story come to life with a clear and natural voice.'
      : '你好，这是一段语音试听。让文字拥有清晰自然的声音。',
  })
}
async function synthesize(active: Operation, text: string, voice: string, rate: number): Promise<NonNullable<SpeechJob['asset']>> {
  checkOperation(active)
  const requestId = crypto.randomUUID()
  active.current = requestId; active.jobs.add(requestId)
  let job = await beginSpeechJob({ requestId, text, voiceId: voice, speed: rate })
  if (job.id !== requestId) { active.jobs.delete(requestId); active.jobs.add(job.id); active.current = job.id }
  if (active.controller.signal.aborted || disposed) { await cancelSpeechJob(job.id).catch(() => {}); checkOperation(active) }
  while (true) {
    checkOperation(active)
    if (job.state === 'failed') throw new Error(job.error || '语音生成失败，请重试。')
    if (job.state === 'cancelled') throw new Error('语音生成已取消。')
    if (job.state === 'completed') {
      if (!job.asset || job.asset.kind !== 'audio' || !Number.isFinite(job.asset.duration) || job.asset.duration <= 0) throw new Error('生成结果没有可用的音频，请重试。')
      active.current = ''
      return job.asset
    }
    await waitForPoll(active)
    job = await getSpeechJob(job.id)
  }
}
async function cancel(reason = '已取消语音生成，时间线保持原样。'): Promise<void> {
  const active = operation
  if (!active || active.controller.signal.aborted || active.applying) return
  cancelling.value = true; active.reason = reason; active.controller.abort()
  if (active.current) await cancelSpeechJob(active.current).catch(() => {})
}
async function run(sources?: SpeechSource[], audition?: { voiceId: string; text: string }, target: 'all' | 'selected' = 'all'): Promise<void> {
  if (busy.value || disposed) return
  if (!desktop) { error.value = '内置离线语音由桌面端提供。'; return }
  error.value = ''; notice.value = ''
  const active: Operation = { project: props.project, controller: new AbortController(), jobs: new Set(), current: '', applying: false, reason: '' }
  operation = active; busy.value = true; emit('busy', true)
  operationKind.value = sources ? target : 'preview'
  try {
    clearPreview()
    if (!status.value.ready) await loadStatus()
    checkOperation(active)
    const chosenVoice = audition?.voiceId || voiceId.value, rate = speed.value, shouldAlign = alignText.value
    if (!status.value.ready || !status.value.voices.some(voice => voice.id === chosenVoice)) throw new Error(status.value.error || '内置语音组件暂不可用，请检查安装文件。')
    if (!sources) {
      if (!audition) throw new Error('请从声音卡片开始试听。')
      previewVoiceId.value = chosenVoice; previewLoading.value = true
      const asset = await synthesize(active, audition.text, chosenVoice, rate)
      checkOperation(active)
      previewJobId = [...active.jobs][0] || ''; active.jobs.clear()
      previewUrl.value = asset.url
      notice.value = '试听已就绪，未添加到时间线。'
      await nextTick()
      checkOperation(active)
      if (!disposed && !active.controller.signal.aborted) await player.value?.play().catch(() => {})
    } else {
      const results = []
      for (const source of sources) {
        const asset = await synthesize(active, source.text, chosenVoice, rate)
        results.push({ source, asset, voiceId: chosenVoice, rate })
        validateSpeechPlanCapacity(active.project, { sources, skipped: [] }, new Map(results.map(item => [item.source.clipId, item.asset.duration])))
      }
      checkOperation(active)
      const result = applySpeechResults(props.project, results, { alignText: shouldAlign })
      active.applying = true; finalizing.value = true
      emit('change', result.project, `已为 ${sources.length} 段文字生成语音`)
      await nextTick()
      if (!results.every(item => props.project.assets.some(asset => asset.id === item.asset.id)) || !result.audioClipIds.every(id => props.project.tracks.some(track => track.clips.some(clip => clip.id === id)))) throw new Error('语音没有写入项目，时间线保持原样，请重试。')
      const acceptedIds = [...active.jobs]
      active.jobs.clear()
      notice.value = `已添加 ${sources.length} 段语音${shouldAlign ? '，文字时长已对齐' : ''}。${result.overlaps.length ? '部分片段时间重叠，语音可能同时播放；请在时间线中调整位置。' : ''}`
      try { await acceptSpeechJobs(acceptedIds) } catch { notice.value += ' 音频已保留，完成记录暂未同步。' }
      emit('status', notice.value)
    }
  } catch (cause) {
    if (!sources) clearPreview()
    if (!disposed) {
      if (active.controller.signal.aborted) notice.value = active.reason
      else { error.value = errorText(cause); emit('status', error.value) }
    }
    if (active.current) await cancelSpeechJob(active.current).catch(() => {})
  } finally {
    await discardJobs(active.jobs)
    if (operation === active) { operation = undefined; busy.value = false; cancelling.value = false; finalizing.value = false; previewLoading.value = false; emit('busy', false) }
  }
}
async function generate(clipIds?: string[]): Promise<void> {
  if (busy.value) return
  const plan = planSpeech(props.project, clipIds)
  if (!plan.sources.length) { error.value = plan.skipped[0]?.reason || '请先在时间线中添加文字。'; return }
  try { validateSpeechPlanCapacity(props.project, plan) } catch (cause) { error.value = errorText(cause); return }
  await run(plan.sources, undefined, clipIds ? 'selected' : 'all')
}
function align(clipIds?: string[]): void {
  if (busy.value) return
  error.value = ''; notice.value = ''
  try {
    const result = alignTextToSpeech(props.project, clipIds)
    emit('change', result.project, '文字已对齐语音')
    notice.value = `文字起点和时长已对齐关联语音。${result.overlaps.length ? '部分片段时间重叠，语音可能同时播放；请检查时间线。' : ''}`
    emit('status', notice.value)
  } catch (cause) { error.value = errorText(cause) }
}
watch(() => props.active, active => {
  if (active && !status.value.ready) void loadStatus()
  if (!active) { clearPreview(); if (operation) void cancel('配音面板已关闭，语音生成已取消。') }
}, { immediate: true })
watch(() => props.project, value => { if (operation && !operation.applying && value !== operation.project) void cancel('项目已经变化，本次语音未写入时间线，请重新生成。') }, { flush: 'sync' })
watch([voiceId, speed], clearPreview)
onBeforeUnmount(() => { disposed = true; clearPreview(); void cancel('已离开剪辑页面，语音生成已取消。') })
defineExpose({ generate, align, cancel })
</script>

<template>
  <section class="speech-panel" aria-label="文字转语音" data-testid="speech-panel">
    <header v-if="!inDialog"><Icon name="audio" :size="17" /><strong>文字转语音</strong><span>离线生成</span></header>
    <p v-if="!desktop" class="speech-note">内置模型和多种声音随桌面端提供，安装后即可离线生成语音。</p>
    <p v-else-if="loading" class="speech-note" role="status"><span class="speech-spinner" />正在检查内置声音…</p>
    <div v-else-if="!status.ready" class="speech-error" role="alert"><p>{{ status.error || '内置语音组件暂不可用。' }}</p><button :disabled="busy" @click="loadStatus"><Icon name="refresh" :size="13" />重新检查</button></div>
    <template v-if="desktop">
      <fieldset :disabled="busy || !status.ready">
        <VoicePicker v-model="voiceId" :voices="status.voices" :disabled="busy || !status.ready" :preview-voice-id="previewVoiceId" :preview-state="previewState" @preview="previewVoice" />
        <label>语速 <output>{{ speed.toFixed(2).replace(/0$/, '') }}×</output><input v-model.number="speed" type="range" min="0.5" max="2" step="0.05" aria-label="配音语速" /></label>
        <label class="speech-check"><input v-model="alignText" type="checkbox" aria-label="文字时长对齐语音" /><span>文字时长对齐语音</span></label>
        <p class="speech-note">保留每段文字的开始位置，按语音长度调整时长。不会移动其他片段。</p>
      </fieldset>
      <div class="speech-actions" aria-live="polite">
        <button class="speech-primary" :disabled="busy || !status.ready || !allPlan.sources.length" :aria-busy="busy && operationKind === 'all'" data-testid="speech-generate-all" @click="generate()"><template v-if="busy && operationKind === 'all'"><span class="speech-spinner" />{{ generationLabel }}</template><template v-else><Icon name="audio" :size="14" />全部文字转语音 <span class="speech-count">{{ allPlan.sources.length }}</span></template></button>
        <button :disabled="busy || !status.ready || !selectedPlan.sources.length" :aria-busy="busy && operationKind === 'selected'" data-testid="speech-generate-selected" @click="generate([selectedClipId])"><template v-if="busy && operationKind === 'selected'"><span class="speech-spinner" />{{ generationLabel }}</template><template v-else><Icon name="text" :size="14" />选中文字转语音</template></button>
        <div v-if="busy" class="speech-cancel-row"><span v-if="operationKind === 'preview'" role="status"><span class="speech-spinner" />{{ cancelling ? '正在取消…' : '正在准备试听…' }}</span><button :disabled="cancelling || finalizing" @click="cancel()"><Icon name="close" :size="13" />取消生成</button></div>
      </div>
      <audio v-if="previewUrl" ref="player" :src="previewUrl" hidden preload="metadata" aria-label="生成的试听音频" @play="previewPlaying = true" @pause="previewPlaying = false" @ended="previewPlaying = false" />
    </template>
    <div class="speech-align"><button :disabled="busy || !selectedLinked" data-testid="speech-align-selected" @click="align([selectedClipId])"><Icon name="clock" :size="14" />选中文字对齐已有语音</button><button :disabled="busy || !project.tracks.some(track => track.clips.some(clip => clip.speech?.textClipId))" @click="align()">全部文字对齐已有语音</button></div>
    <details v-if="allPlan.skipped.length" class="speech-skipped"><summary>{{ allPlan.skipped.length }} 段文字不可生成，将跳过</summary><ul><li v-for="item in allPlan.skipped" :key="item.clipId">{{ item.name }}：{{ item.reason }}</li></ul></details>
    <p v-if="error" class="speech-error" role="alert">{{ error }}</p><p v-if="notice" class="speech-notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.speech-panel{font-size:11px;overflow:auto;padding:13px 14px;min-height:0;line-height:1.55}.speech-panel header{display:flex;align-items:center;gap:7px;margin-bottom:15px}.speech-panel header>span{font-size:9px;margin-left:auto;color:var(--ed-muted)}.speech-panel fieldset{border:0;padding:0;margin:0;min-width:0}.speech-panel label{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;position:relative;color:var(--ed-muted)}.speech-panel output{position:absolute;right:0;color:var(--ed-text)}.speech-panel input[type=range]{width:100%;accent-color:var(--ed-accent)}.speech-panel button{font:inherit;display:flex;align-items:center;justify-content:center;gap:5px;width:100%;min-height:31px;border:1px solid var(--ed-border);border-radius:6px;padding:5px 7px;background:var(--ed-panel);color:var(--ed-text);cursor:pointer;white-space:normal;line-height:1.4}.speech-panel button:disabled,.speech-panel fieldset:disabled{opacity:.5;cursor:not-allowed}.speech-panel button:hover:not(:disabled){color:var(--ed-accent);border-color:var(--ed-accent)}.speech-panel select{width:100%}.speech-panel button:focus-visible,.speech-panel select:focus-visible,.speech-panel summary:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}.speech-panel .speech-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:#fff!important}.speech-actions{display:grid;gap:7px}.speech-primary>.speech-count{font-size:10px;border-radius:4px;background:#ffffff25;padding:0 5px}.speech-panel label.speech-check{flex-direction:row;align-items:flex-start;gap:7px;color:var(--ed-text);margin-bottom:5px}.speech-check input{margin:3px 0 0;accent-color:var(--ed-accent);flex-shrink:0}.speech-note{font-size:10px;color:var(--ed-muted);margin:7px 0 12px;overflow-wrap:anywhere}.speech-align{border-top:1px solid var(--ed-border);margin-top:15px;padding-top:12px;display:grid;gap:7px}.speech-align>button:last-child{border-color:transparent;font-size:10px;color:var(--ed-muted)}.speech-cancel-row{display:flex;align-items:center;justify-content:flex-end;gap:8px;font-size:10px}.speech-cancel-row>span{display:flex;align-items:center;gap:5px;margin-right:auto;color:var(--ed-muted)}.speech-panel .speech-cancel-row>button{width:auto;min-height:26px;padding:3px 8px}.speech-spinner{display:inline-block;width:11px;height:11px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:speech-spin .8s linear infinite;vertical-align:-1px;flex-shrink:0}.speech-error,.speech-notice{font-size:10px;padding:9px;border-radius:6px;overflow-wrap:anywhere;white-space:pre-line}.speech-error{background:color-mix(in srgb,#e15b53 10%,var(--ed-panel));color:#bc423a}.speech-error p{margin:0 0 8px}.speech-notice{background:color-mix(in srgb,var(--ed-accent) 7%,var(--ed-panel));color:var(--ed-text)}.speech-skipped{font-size:10px;margin:12px 0;color:var(--ed-muted)}.speech-skipped summary{cursor:pointer}.speech-skipped ul{padding-left:16px;overflow-wrap:anywhere}.speech-skipped li{margin:5px 0}@keyframes speech-spin{to{transform:rotate(360deg)}}
</style>
