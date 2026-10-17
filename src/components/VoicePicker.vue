<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import type { SpeechVoice } from '../native'
import { compactVoiceCatalog, VOICE_CATEGORIES, voiceCategory, voiceSearchText, voiceStyle, voiceTypeLabel, type VoiceCategoryId } from '../core/voice-catalog'
import { voiceReady, voiceDownloading, voiceDownloadProgress, voiceModelSize } from '../core/voice-downloads'
import { bundledVoicePreviewUrl } from '../core/voice-previews'
import Icon from './Icon.vue'
import voicePortraits from '../assets/voices/voice-portraits.png'

const props = withDefaults(defineProps<{
  voices: SpeechVoice[]
  modelValue: string
  disabled?: boolean
  previewVoiceId?: string
  previewState?: 'idle' | 'loading' | 'playing'
  pendingModels?: string[]
}>(), { disabled: false, previewVoiceId: '', previewState: 'idle', pendingModels: () => [] })
const emit = defineEmits<{ 'update:modelValue': [id: string]; preview: [id: string]; download: [modelId: string]; cancelDownload: [modelId: string] }>()
const instanceId = useId(), search = ref(''), activeTab = ref<VoiceCategoryId>('zh-female')
const tabs = ref<HTMLElement | null>(null), scroller = ref<HTMLElement | null>(null)
const catalog = computed(() => compactVoiceCatalog(props.voices, props.modelValue))
const categories = computed(() => VOICE_CATEGORIES.map(category => ({ ...category, voices: catalog.value.filter(voice => voiceCategory(voice) === category.id) })).filter(category => category.voices.length))
const selectedVoice = computed(() => catalog.value.find(voice => voice.id === props.modelValue))
const visibleVoices = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return catalog.value.filter(voice => voiceCategory(voice) === activeTab.value && (!query || voiceSearchText(voice).includes(query)))
})
const categoryLabel = computed(() => VOICE_CATEGORIES.find(category => category.id === activeTab.value)?.label || '声音')
const hasDownloads = computed(() => catalog.value.some(voice => voice.modelId && voice.status !== 'bundled'))

watch([() => props.modelValue, () => selectedVoice.value && voiceCategory(selectedVoice.value)], ([, category]) => {
  if (category) activeTab.value = category
}, { immediate: true })
watch(categories, groups => {
  if (!groups.some(category => category.id === activeTab.value) && groups[0]) activeTab.value = groups[0].id
}, { immediate: true })
watch([activeTab, search], () => { if (scroller.value) scroller.value.scrollTop = 0 })

function artwork(voice: SpeechVoice): Record<string, string> {
  const portrait = voiceStyle(voice).portrait
  // Crop a square inside each portrait; the generated sheet has unequal row heights.
  const left = [11, 373, 735][portrait % 3]!, top = [10, 367, 717, 1080][Math.floor(portrait / 3)]!
  return { backgroundImage: `url(${voicePortraits})`, backgroundSize: `${1086 / 340 * 100}% ${1448 / 340 * 100}%`, backgroundPosition: `${left / (1086 - 340) * 100}% ${top / (1448 - 340) * 100}%` }
}
function playing(voice: SpeechVoice): boolean { return props.previewVoiceId === voice.id && props.previewState === 'playing' }
function loading(voice: SpeechVoice): boolean { return props.previewVoiceId === voice.id && props.previewState === 'loading' }
function modelPending(voice: SpeechVoice): boolean { return !!voice.modelId && props.pendingModels.includes(voice.modelId) }
function sharedVoices(voice: SpeechVoice): number { return voice.modelId ? catalog.value.filter(item => item.modelId === voice.modelId).length : 1 }
function canPreview(voice: SpeechVoice): boolean { return voiceReady(voice) || !!bundledVoicePreviewUrl(voice.id) }
function chooseCategory(id: VoiceCategoryId): void { if (!props.disabled) activeTab.value = id }
function tabKeyboard(event: KeyboardEvent, id: VoiceCategoryId): void {
  if (props.disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault(); event.stopPropagation()
  const list = categories.value, index = list.findIndex(category => category.id === id)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length
  const category = list[next]
  if (!category) return
  activeTab.value = category.id
  void nextTick(() => tabs.value?.querySelector<HTMLButtonElement>(`[data-voice-category="${category.id}"]`)?.focus())
}
</script>

<template>
  <div class="voice-picker" data-testid="voice-picker">
    <div class="voice-picker-heading"><strong>{{ catalog.length === 1 ? '内置声音' : '选择声音' }}</strong><span v-if="selectedVoice" class="voice-current" :title="selectedVoice.name"><Icon name="check" :size="12" />{{ selectedVoice.name }}</span></div>
    <div ref="tabs" class="voice-categories" role="tablist" aria-label="声音分类">
      <button v-for="category in categories" :id="`${instanceId}-${category.id}`" :key="category.id" type="button" role="tab" :data-voice-category="category.id" :aria-selected="activeTab === category.id" :aria-controls="`${instanceId}-voices`" :tabindex="activeTab === category.id ? 0 : -1" :disabled="disabled" @click="chooseCategory(category.id)" @keydown="tabKeyboard($event, category.id)">{{ category.label }}<span>{{ category.voices.length }}</span></button>
    </div>
    <div class="voice-search"><Icon name="search" :size="14" /><input v-model="search" type="search" :disabled="disabled" aria-label="搜索声音" :placeholder="`搜索${categoryLabel}名称或类型`" autocomplete="off" spellcheck="false" /><span aria-live="polite">{{ visibleVoices.length }} 个</span></div>
    <p v-if="hasDownloads" class="voice-download-help">更多声音可按需下载，下载后即可离线使用。试听无需下载模型。</p>
    <div :id="`${instanceId}-voices`" ref="scroller" class="voice-grid-scroll" role="tabpanel" :aria-labelledby="`${instanceId}-${activeTab}`" tabindex="0">
      <div v-if="visibleVoices.length" class="voice-grid">
        <div v-for="voice in visibleVoices" :key="voice.id" class="voice-card" :class="{ selected: modelValue === voice.id, previewing: playing(voice) }" :data-voice-id="voice.id">
          <button type="button" class="voice-choice" :disabled="disabled || !voiceReady(voice)" :aria-label="`选择 ${voice.name}`" :aria-description="`${voiceStyle(voice).label}，${voiceTypeLabel(voice)}${!voiceReady(voice) ? '，下载模型后可使用' : ''}`" :aria-pressed="modelValue === voice.id" @click="emit('update:modelValue', voice.id)">
            <span class="voice-artwork" :style="artwork(voice)" aria-hidden="true"><span class="voice-style" :data-voice-style="voiceStyle(voice).id">{{ voiceStyle(voice).label }}</span></span>
            <span v-if="modelValue === voice.id" class="voice-check" aria-hidden="true"><Icon name="check" :size="12" /></span>
            <span class="voice-card-copy"><strong :title="voice.name">{{ voice.name }}</strong><span>{{ voiceTypeLabel(voice) }}</span></span>
          </button>
          <button type="button" class="voice-preview-button" :disabled="disabled || !canPreview(voice)" :aria-label="`试听 ${voice.name}`" :aria-pressed="playing(voice)" :aria-busy="loading(voice) || undefined" :title="loading(voice) ? '正在准备试听' : playing(voice) ? '暂停试听' : canPreview(voice) ? '试听声音' : '下载模型后可试听'" @click="emit('preview', voice.id)"><Icon :name="loading(voice) ? 'refresh' : playing(voice) ? 'pause' : 'volume'" :class="{ 'voice-loading': loading(voice) }" :size="15" /></button>
          <div v-if="voice.status || voice.modelSize" class="voice-model" :data-model-status="voice.status || 'ready'">
            <span class="voice-model-size">{{ voice.status === 'bundled' ? '已内置' : voiceReady(voice) ? '已下载' : '模型' }}<template v-if="voiceModelSize(voice.modelSize)"> · {{ voiceModelSize(voice.modelSize) }}</template></span>
            <span v-if="sharedVoices(voice) > 1" class="voice-model-shared">共享模型 · {{ sharedVoices(voice) }} 种声音</span>
            <template v-if="voiceDownloading(voice)">
              <progress :value="voiceDownloadProgress(voice)" max="100" :aria-label="`${voice.name} 模型下载进度`" />
              <span class="voice-model-state">{{ voice.status === 'verifying' ? '正在校验模型…' : `正在下载 ${voiceDownloadProgress(voice)}%` }}</span>
              <button type="button" class="voice-download-button" :disabled="disabled || modelPending(voice)" :aria-label="`取消下载 ${voice.name}`" @click="voice.modelId && emit('cancelDownload', voice.modelId)"><Icon name="close" :size="12" />{{ modelPending(voice) ? '正在取消…' : '取消下载' }}</button>
            </template>
            <template v-else-if="!voiceReady(voice) && voice.modelId">
              <span v-if="voice.status === 'failed'" class="voice-model-error" :title="voice.error">{{ voice.error || '下载失败，请重试' }}</span>
              <button type="button" class="voice-download-button" :disabled="disabled || modelPending(voice)" :aria-label="`${voice.status === 'failed' ? '重试下载' : '下载'} ${voice.name}`" @click="emit('download', voice.modelId)"><Icon :name="modelPending(voice) ? 'refresh' : 'download'" :class="{ 'voice-loading': modelPending(voice) }" :size="12" />{{ modelPending(voice) ? '正在准备…' : voice.status === 'failed' ? '重试下载' : '下载' }}<span v-if="!modelPending(voice) && voiceModelSize(voice.downloadSize)">{{ voiceModelSize(voice.downloadSize) }}</span></button>
            </template>
          </div>
        </div>
      </div>
      <p v-else class="voice-empty" role="status">{{ voices.length ? '没有找到匹配的声音，试试其他名称或分类。' : '暂时没有可用的声音。' }}</p>
    </div>
  </div>
</template>

<style scoped>
.voice-picker{min-width:0;margin-bottom:16px;font-size:11px;color:var(--ed-text);line-height:1.4;container-type:inline-size}
.voice-picker-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px;min-width:0}
.voice-picker-heading>strong{font-size:11px;font-weight:600;flex-shrink:0}
.voice-current{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ed-accent);font-size:10px}
.voice-current svg{flex-shrink:0}
.voice-categories{display:flex;flex-wrap:wrap;gap:4px;padding:3px;background:var(--ed-bg);border-radius:8px;margin-bottom:8px}
.voice-picker .voice-categories button{display:flex;flex:1 0 auto;align-items:center;justify-content:center;gap:4px;width:auto;min-height:29px;padding:5px 6px;border:1px solid transparent;border-radius:6px;font:inherit;font-size:10px;line-height:1.3;white-space:nowrap;background:transparent;color:var(--ed-muted);cursor:pointer}
.voice-picker .voice-categories button[aria-selected=true]{color:var(--ed-accent);background:var(--ed-panel);border-color:var(--ed-border);box-shadow:0 1px 2px #00000006}
.voice-categories button>span{font-size:9px;opacity:.8}
.voice-search{position:relative;display:flex;align-items:center;margin-bottom:8px;color:var(--ed-muted)}
.voice-search>svg{position:absolute;left:9px;pointer-events:none}
.voice-picker .voice-search input{width:100%;min-width:0;box-sizing:border-box;padding:7px 46px 7px 29px;border:1px solid var(--ed-border);border-radius:7px;background:var(--ed-panel);color:var(--ed-text);font:inherit;font-size:11px;line-height:1.4}
.voice-search>span{position:absolute;right:9px;font-size:10px;pointer-events:none}
.voice-search input::-webkit-search-cancel-button{-webkit-appearance:none}
.voice-grid-scroll{max-height:340px;overflow:auto;overscroll-behavior:contain;padding:2px 4px 3px 2px;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent;min-height:110px}
.voice-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.voice-card{position:relative;min-width:0;border-radius:9px}
.voice-download-help{margin:0 0 8px;font-size:10px;color:var(--ed-muted);line-height:1.6}
.voice-model{display:flex;flex-direction:column;gap:5px;padding:9px 5px 3px;font-size:9px;line-height:1.4}
.voice-model-size{color:var(--ed-text)}.voice-model-shared,.voice-model-state{color:var(--ed-muted)}
.voice-model progress{display:block;width:100%;height:4px;border:0;border-radius:3px;overflow:hidden;accent-color:var(--ed-accent);background:var(--ed-border)}
.voice-model progress::-webkit-progress-bar{background:var(--ed-border)}.voice-model progress::-webkit-progress-value{background:var(--ed-accent)}
.voice-picker .voice-card .voice-download-button{display:flex;align-items:center;justify-content:center;gap:4px;box-sizing:border-box;width:100%;min-height:28px;padding:4px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-panel);color:var(--ed-accent);font:inherit;font-size:9px;cursor:pointer}
.voice-picker .voice-card .voice-download-button:hover:not(:disabled){border-color:var(--ed-accent)}
.voice-model-error{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:#bc423a;overflow-wrap:anywhere}
.voice-picker .voice-card .voice-choice{position:relative;box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:0;overflow:hidden;width:100%;min-height:0;padding:0;border:1px solid var(--ed-border);border-radius:9px;background:var(--ed-panel);color:var(--ed-text);font:inherit;text-align:left;line-height:1.4;cursor:pointer}
.voice-picker .voice-card .voice-choice:hover:not(:disabled){border-color:var(--ed-accent);background:var(--ed-panel);color:var(--ed-text)}
.voice-picker .voice-card.selected .voice-choice{border-color:var(--ed-accent);box-shadow:0 0 0 1px var(--ed-accent)}
.voice-artwork{position:relative;display:block;width:100%;aspect-ratio:1;user-select:none;background-color:#e4edf0;background-repeat:no-repeat}
.voice-style{position:absolute;left:7px;bottom:7px;display:block;padding:3px 8px;border:1px solid #ffffff75;border-radius:5px;background:#172435d9;color:#fff;font-size:11px;font-weight:600;letter-spacing:.04em;line-height:1.4;box-shadow:0 1px 5px #142d3920}
.voice-card-copy{display:flex;flex-direction:column;gap:3px;min-width:0;padding:8px 8px 9px}
.voice-card-copy>strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:600}
.voice-card-copy>span{font-size:9px;color:var(--ed-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.voice-check{position:absolute;top:6px;left:6px;display:flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:50%;background:var(--ed-accent);color:#fff;box-shadow:0 1px 4px #0002}
.voice-picker .voice-card .voice-preview-button{position:absolute;right:6px;top:6px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:26px;height:26px;min-height:26px;padding:0;border:1px solid #fff9;border-radius:50%;background:#fffffff0;color:#35495a;cursor:pointer;box-shadow:0 1px 5px #142d3918}
.voice-picker .voice-card .voice-preview-button:hover:not(:disabled),.voice-picker .voice-card.previewing .voice-preview-button{background:var(--ed-accent);border-color:var(--ed-accent);color:#fff}
.voice-picker button:disabled,.voice-picker input:disabled{opacity:.5;cursor:not-allowed}
.voice-picker button:focus-visible,.voice-picker input:focus-visible,.voice-grid-scroll:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}
.voice-empty{margin:0;padding:28px 16px;text-align:center;color:var(--ed-muted);font-size:11px;line-height:1.7}
.voice-loading{animation:voice-turn .9s linear infinite}
@keyframes voice-turn{to{transform:rotate(360deg)}}
@container(min-width:560px){.voice-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(max-width:420px){.voice-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.voice-grid-scroll{max-height:340px}.voice-current{max-width:55%}}
@media(prefers-reduced-motion:reduce){.voice-loading{animation:none}}
</style>
