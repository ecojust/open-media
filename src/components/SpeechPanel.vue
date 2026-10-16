<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Project } from '../core/types'
import { alignTextToSpeech, applySpeechResults, planSpeech, validateSpeechPlanCapacity, type SpeechSource } from '../core/speech'
import { acceptSpeechJobs, beginSpeechJob, cancelSpeechJob, discardSpeechJob, getSpeechJob, getSpeechStatus, isDesktop, type SpeechJob, type SpeechStatus } from '../native'
import Icon from './Icon.vue'

const props = defineProps<{ project: Project; selectedClipId: string; active: boolean }>()
const emit = defineEmits<{ change: [project: Project, label: string]; status: [message: string]; busy: [value: boolean] }>()
const desktop = isDesktop()
const status = ref<SpeechStatus>({ ready: false, voices: [] })
const voiceGroups = computed(() => [
  { label: '中文', voices: status.value.voices.filter(voice => voice.language.toLowerCase().startsWith('zh')) },
  { label: '英语', voices: status.value.voices.filter(voice => voice.language.toLowerCase().startsWith('en')) },
  { label: '其他语言', voices: status.value.voices.filter(voice => !/^(zh|en)/i.test(voice.language)) },
].filter(group => group.voices.length))
const loading = ref(false), busy = ref(false), cancelling = ref(false), finalizing = ref(false), error = ref(''), notice = ref('')
const voiceId = ref(''), speed = ref(1), alignText = ref(true)
const previewText = ref('你好，这是一段语音试听。让文字拥有清晰自然的声音。')
const previewUrl = ref(''), previewDuration = ref(0), player = ref<HTMLAudioElement | null>(null)
const completed = ref(0), total = ref(0), stage = ref(''), currentName = ref(''), currentProgress = ref(0)
const allPlan = computed(() => planSpeech(props.project))
const selectedPlan = computed(() => planSpeech(props.project, props.selectedClipId ? [props.selectedClipId] : []))
const selectedLinked = computed(() => props.project.tracks.some(track => track.clips.some(clip => clip.speech?.textClipId === props.selectedClipId)))
const progress = computed(() => total.value ? Math.min(1, (completed.value + currentProgress.value) / total.value) : 0)
let statusPromise: Promise<void> | undefined
let disposed = false, previewJobId = ''
interface Operation { project: Project; controller: AbortController; jobs: Set<string>; current: string; applying: boolean; reason: string }
let operation: Operation | undefined

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function voiceLanguage(language: string): string {
  const normalized = language.toLowerCase()
  if (normalized.startsWith('zh')) return '中文'
  if (normalized === 'en-us') return '英语 · 美国'
  if (normalized === 'en-gb') return '英语 · 英国'
  if (normalized.startsWith('en')) return '英语'
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'language', fallback: 'none' }).of(language) || '其他语言' } catch { return '其他语言' }
}
async function loadStatus(): Promise<void> {
  if (!desktop || disposed) return
  if (statusPromise) return statusPromise
  loading.value = true
  statusPromise = (async () => {
    try {
      const result = await getSpeechStatus()
      if (disposed) return
      status.value = result
      if (!result.voices.some(voice => voice.id === voiceId.value)) voiceId.value = result.voices.find(voice => voice.language.toLowerCase().startsWith('zh'))?.id || result.voices[0]?.id || ''
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
  previewUrl.value = ''; previewDuration.value = 0
  if (previewJobId) { const id = previewJobId; previewJobId = ''; void discardJobs([id]) }
}
async function synthesize(active: Operation, text: string, voice: string, rate: number): Promise<NonNullable<SpeechJob['asset']>> {
  checkOperation(active)
  const requestId = crypto.randomUUID()
  active.current = requestId; active.jobs.add(requestId)
  currentProgress.value = 0; stage.value = '正在准备声音…'
  let job = await beginSpeechJob({ requestId, text, voiceId: voice, speed: rate })
  if (job.id !== requestId) { active.jobs.delete(requestId); active.jobs.add(job.id); active.current = job.id }
  if (active.controller.signal.aborted || disposed) { await cancelSpeechJob(job.id).catch(() => {}); checkOperation(active) }
  while (true) {
    checkOperation(active)
    currentProgress.value = Math.max(0, Math.min(1, job.progress || 0))
    stage.value = job.message || job.stage || '正在生成语音…'
    if (job.state === 'failed') throw new Error(job.error || '语音生成失败，请重试。')
    if (job.state === 'cancelled') throw new Error('语音生成已取消。')
    if (job.state === 'completed') {
      if (!job.asset || job.asset.kind !== 'audio' || !Number.isFinite(job.asset.duration) || job.asset.duration <= 0) throw new Error('生成结果没有可用的音频，请重试。')
      active.current = ''; currentProgress.value = 0
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
async function run(sources?: SpeechSource[]): Promise<void> {
  if (busy.value || disposed) return
  if (!desktop) { error.value = '内置离线语音由桌面端提供。'; return }
  error.value = ''; notice.value = ''
  const active: Operation = { project: props.project, controller: new AbortController(), jobs: new Set(), current: '', applying: false, reason: '' }
  operation = active; busy.value = true; emit('busy', true)
  completed.value = 0; total.value = sources?.length || 1; currentName.value = ''; currentProgress.value = 0
  try {
    clearPreview()
    if (!status.value.ready) await loadStatus()
    checkOperation(active)
    if (!status.value.ready || !voiceId.value) throw new Error(status.value.error || '内置语音组件暂不可用，请检查安装文件。')
    const chosenVoice = voiceId.value, rate = speed.value, shouldAlign = alignText.value
    if (!sources) {
      const text = previewText.value.trim()
      if (!text) throw new Error('请输入试听文本。')
      currentName.value = '声音试听'
      const asset = await synthesize(active, text, chosenVoice, rate)
      checkOperation(active)
      previewJobId = [...active.jobs][0] || ''; active.jobs.clear()
      previewUrl.value = asset.url; previewDuration.value = asset.duration; completed.value = 1
      notice.value = '试听已就绪，未添加到时间线。'
      await nextTick()
      checkOperation(active)
      if (!disposed && !active.controller.signal.aborted) await player.value?.play().catch(() => {})
    } else {
      const results = []
      for (const source of sources) {
        currentName.value = source.name
        const asset = await synthesize(active, source.text, chosenVoice, rate)
        results.push({ source, asset, voiceId: chosenVoice, rate }); completed.value++
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
    if (operation === active) { operation = undefined; busy.value = false; cancelling.value = false; finalizing.value = false; emit('busy', false) }
  }
}
async function generate(clipIds?: string[]): Promise<void> {
  if (busy.value) return
  const plan = planSpeech(props.project, clipIds)
  if (!plan.sources.length) { error.value = plan.skipped[0]?.reason || '请先在时间线中添加文字。'; return }
  try { validateSpeechPlanCapacity(props.project, plan) } catch (cause) { error.value = errorText(cause); return }
  await run(plan.sources)
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
watch(() => props.active, active => { if (active && !status.value.ready) void loadStatus() }, { immediate: true })
watch(() => props.project, value => { if (operation && !operation.applying && value !== operation.project) void cancel('项目已经变化，本次语音未写入时间线，请重新生成。') }, { flush: 'sync' })
watch([voiceId, speed], clearPreview)
onBeforeUnmount(() => { disposed = true; clearPreview(); void cancel('已离开剪辑页面，语音生成已取消。') })
defineExpose({ generate, align, cancel })
</script>

<template>
  <section class="speech-panel" aria-label="文字转语音" data-testid="speech-panel">
    <header><Icon name="audio" :size="17" /><strong>文字转语音</strong><span>离线生成</span></header>
    <p v-if="!desktop" class="speech-note">内置模型和多种声音随桌面端提供，安装后即可离线生成语音。</p>
    <p v-else-if="loading" class="speech-note" role="status"><span class="speech-spinner" />正在检查内置声音…</p>
    <div v-else-if="!status.ready" class="speech-error" role="alert"><p>{{ status.error || '内置语音组件暂不可用。' }}</p><button :disabled="busy" @click="loadStatus"><Icon name="refresh" :size="13" />重新检查</button></div>
    <template v-if="desktop">
      <fieldset :disabled="busy || !status.ready">
        <label>声音<select v-model="voiceId" aria-label="配音声音"><optgroup v-for="group in voiceGroups" :key="group.label" :label="group.label"><option v-for="voice in group.voices" :key="voice.id" :value="voice.id">{{ voice.name }} · {{ voiceLanguage(voice.language) }}</option></optgroup></select></label>
        <label>语速 <output>{{ speed.toFixed(2).replace(/0$/, '') }}×</output><input v-model.number="speed" type="range" min="0.5" max="2" step="0.05" aria-label="配音语速" /></label>
        <details class="voice-preview"><summary>试听声音</summary><textarea v-model="previewText" maxlength="200" rows="2" aria-label="试听文本" /><button :disabled="!previewText.trim()" @click="run()"><Icon name="play" :size="13" />生成试听</button></details>
        <label class="speech-check"><input v-model="alignText" type="checkbox" aria-label="文字时长对齐语音" /><span>文字时长对齐语音</span></label>
        <p class="speech-note">保留每段文字的开始位置，按语音长度调整时长。不会移动其他片段。</p>
        <div class="speech-actions"><button class="speech-primary" :disabled="!allPlan.sources.length" data-testid="speech-generate-all" @click="generate()"><Icon name="audio" :size="14" />全部文字转语音 <span>{{ allPlan.sources.length }}</span></button><button :disabled="!selectedPlan.sources.length" data-testid="speech-generate-selected" @click="generate([selectedClipId])"><Icon name="text" :size="14" />选中文字转语音</button></div>
      </fieldset>
      <audio v-if="previewUrl" ref="player" :src="previewUrl" controls preload="metadata" aria-label="生成的试听音频" /><p v-if="previewUrl" class="speech-note">试听音频 {{ previewDuration.toFixed(1) }} 秒</p>
      <div v-if="busy" class="speech-progress" role="status" aria-live="polite"><strong><span class="speech-spinner" />{{ cancelling ? '正在取消…' : `已完成 ${completed} / ${total}` }}</strong><progress :value="progress" max="1" aria-label="语音生成进度" /><span class="speech-current">{{ currentName }}</span><span>{{ cancelling ? '正在停止生成并清理临时音频' : finalizing ? '正在加入时间线…' : stage }}</span><button :disabled="cancelling || finalizing" @click="cancel()"><Icon name="close" :size="13" />取消生成</button></div>
    </template>
    <div class="speech-align"><button :disabled="busy || !selectedLinked" data-testid="speech-align-selected" @click="align([selectedClipId])"><Icon name="clock" :size="14" />选中文字对齐已有语音</button><button :disabled="busy || !project.tracks.some(track => track.clips.some(clip => clip.speech?.textClipId))" @click="align()">全部文字对齐已有语音</button></div>
    <details v-if="allPlan.skipped.length" class="speech-skipped"><summary>{{ allPlan.skipped.length }} 段文字不可生成，将跳过</summary><ul><li v-for="item in allPlan.skipped" :key="item.clipId">{{ item.name }}：{{ item.reason }}</li></ul></details>
    <p v-if="error" class="speech-error" role="alert">{{ error }}</p><p v-if="notice" class="speech-notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.speech-panel{font-size:11px;overflow:auto;padding:13px 14px;min-height:0;line-height:1.55}.speech-panel header{display:flex;align-items:center;gap:7px;margin-bottom:15px}.speech-panel header>span{font-size:9px;margin-left:auto;color:var(--ed-muted)}.speech-panel fieldset{border:0;padding:0;margin:0;min-width:0}.speech-panel label{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;position:relative;color:var(--ed-muted)}.speech-panel output{position:absolute;right:0;color:var(--ed-text)}.speech-panel select,.speech-panel textarea{font:inherit;box-sizing:border-box;width:100%;min-width:0;padding:7px;border:1px solid var(--ed-border);border-radius:6px;color:var(--ed-text);background:var(--ed-panel)}.speech-panel textarea{resize:vertical;margin:8px 0 5px}.speech-panel input[type=range]{width:100%;accent-color:var(--ed-accent)}.speech-panel button{font:inherit;display:flex;align-items:center;justify-content:center;gap:5px;width:100%;min-height:31px;border:1px solid var(--ed-border);border-radius:6px;padding:5px 7px;background:var(--ed-panel);color:var(--ed-text);cursor:pointer;white-space:normal;line-height:1.4}.speech-panel button:disabled,.speech-panel fieldset:disabled{opacity:.5;cursor:not-allowed}.speech-panel button:hover:not(:disabled){color:var(--ed-accent);border-color:var(--ed-accent)}.speech-panel button:focus-visible,.speech-panel select:focus-visible,.speech-panel textarea:focus-visible,.speech-panel summary:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}.speech-panel .speech-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:#fff!important}.speech-actions{display:grid;gap:7px}.speech-primary>span{font-size:10px;border-radius:4px;background:#ffffff25;padding:0 5px}.voice-preview{margin-bottom:14px}.voice-preview summary{cursor:pointer;color:var(--ed-accent)}.speech-panel label.speech-check{flex-direction:row;align-items:flex-start;gap:7px;color:var(--ed-text);margin-bottom:5px}.speech-check input{margin:3px 0 0;accent-color:var(--ed-accent);flex-shrink:0}.speech-note{font-size:10px;color:var(--ed-muted);margin:7px 0 12px;overflow-wrap:anywhere}.speech-panel audio{width:100%;height:32px;margin-top:12px}.speech-align{border-top:1px solid var(--ed-border);margin-top:15px;padding-top:12px;display:grid;gap:7px}.speech-align>button:last-child{border-color:transparent;font-size:10px;color:var(--ed-muted)}.speech-progress{margin-top:12px;padding:10px;border:1px solid var(--ed-border);border-radius:7px;display:grid;gap:7px;font-size:10px}.speech-progress strong{display:flex;align-items:center;gap:6px;font-size:11px}.speech-progress>span{color:var(--ed-muted);overflow-wrap:anywhere}.speech-progress progress{width:100%;height:5px;accent-color:var(--ed-accent)}.speech-current{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.speech-spinner{display:inline-block;width:11px;height:11px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:speech-spin .8s linear infinite;vertical-align:-1px;flex-shrink:0}.speech-error,.speech-notice{font-size:10px;padding:9px;border-radius:6px;overflow-wrap:anywhere;white-space:pre-line}.speech-error{background:color-mix(in srgb,#e15b53 10%,var(--ed-panel));color:#bc423a}.speech-error p{margin:0 0 8px}.speech-notice{background:color-mix(in srgb,var(--ed-accent) 7%,var(--ed-panel));color:var(--ed-text)}.speech-skipped{font-size:10px;margin:12px 0;color:var(--ed-muted)}.speech-skipped summary{cursor:pointer}.speech-skipped ul{padding-left:16px;overflow-wrap:anywhere}.speech-skipped li{margin:5px 0}@keyframes speech-spin{to{transform:rotate(360deg)}}
</style>
