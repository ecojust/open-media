<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { SpeechVoice } from '../native'
import { compactVoiceCatalog, voiceActionName, voiceModelName, voiceSearchText, voiceStyle, voiceTypeLabel } from '../core/voice-catalog'
import { voiceReady, voiceDownloading, voiceRuntimeUpgrade, voiceUnsupported } from '../core/voice-downloads'
import { bundledVoicePreviewUrl } from '../core/voice-previews'
import Icon from './Icon.vue'
import voicePortraits from '../assets/voices/voice-portraits.png'

const props = withDefaults(defineProps<{
  voices: SpeechVoice[]
  modelValue: string
  disabled?: boolean
  previewVoiceId?: string
  previewState?: 'idle' | 'loading' | 'playing'
}>(), { disabled: false, previewVoiceId: '', previewState: 'idle' })
const emit = defineEmits<{ 'update:modelValue': [id: string]; preview: [id: string]; 'open-models': [provider: 'speech'] }>()
const instanceId = useId(), search = ref('')
const scroller = ref<HTMLElement | null>(null)
const catalog = computed(() => compactVoiceCatalog(props.voices, props.modelValue))
const selectedVoice = computed(() => catalog.value.find(voice => voice.id === props.modelValue))
const visibleVoices = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return catalog.value.filter(voice => !query || voiceSearchText(voice).includes(query))
})

watch(search, () => { if (scroller.value) scroller.value.scrollTop = 0 })

function artwork(voice: SpeechVoice): Record<string, string> {
  const portrait = voiceStyle(voice).portrait
  // Crop a square inside each portrait; the generated sheet has unequal row heights.
  const left = [11, 373, 735][portrait % 3]!, top = [10, 367, 717, 1080][Math.floor(portrait / 3)]!
  return { backgroundImage: `url(${voicePortraits})`, backgroundSize: `${1086 / 340 * 100}% ${1448 / 340 * 100}%`, backgroundPosition: `${left / (1086 - 340) * 100}% ${top / (1448 - 340) * 100}%` }
}
function playing(voice: SpeechVoice): boolean { return props.previewVoiceId === voice.id && props.previewState === 'playing' }
function loading(voice: SpeechVoice): boolean { return props.previewVoiceId === voice.id && props.previewState === 'loading' }
function canPreview(voice: SpeechVoice): boolean { return voiceReady(voice) || !!bundledVoicePreviewUrl(voice.id) }
function modelState(voice: SpeechVoice): string {
  if (voiceDownloading(voice)) return '模型准备中'
  if (voiceUnsupported(voice)) return '当前平台不可用'
  if (voiceReady(voice)) return voiceRuntimeUpgrade(voice) ? '已就绪 · 加速组件可更新' : '已就绪'
  return voice.status === 'failed' || voice.runtimeStatus === 'failed' ? '模型需要检查' : '待下载'
}
</script>

<template>
  <div class="voice-picker" data-testid="voice-picker">
    <div class="voice-picker-heading"><strong :id="`${instanceId}-heading`">{{ catalog.length === 1 ? '内置声音' : '选择声音' }}</strong><span v-if="selectedVoice" class="voice-current" :title="`${voiceModelName(selectedVoice)} · ${voiceTypeLabel(selectedVoice)}`"><Icon name="check" :size="12" />{{ voiceModelName(selectedVoice) }}<template v-if="selectedVoice.gender === 'male' || selectedVoice.gender === 'female'"> · {{ selectedVoice.gender === 'male' ? '男声' : '女声' }}</template></span></div>
    <div class="voice-search"><Icon name="search" :size="14" /><input v-model="search" type="search" :disabled="disabled" aria-label="搜索声音" placeholder="搜索名称、语言或声音类型" autocomplete="off" spellcheck="false" /><span aria-live="polite">{{ visibleVoices.length }} 个</span></div>
    <div :id="`${instanceId}-voices`" ref="scroller" class="voice-grid-scroll" role="region" :aria-labelledby="`${instanceId}-heading`" tabindex="0">
      <div v-if="visibleVoices.length" class="voice-grid">
        <div v-for="voice in visibleVoices" :key="voice.id" class="voice-card" :class="{ selected: modelValue === voice.id, previewing: playing(voice) }" :data-voice-id="voice.id">
          <button type="button" class="voice-choice" :disabled="disabled || !voiceReady(voice)" :aria-label="`选择 ${voiceActionName(voice)}`" :aria-description="`${voiceStyle(voice).label}，${voiceTypeLabel(voice)}${voiceUnsupported(voice) ? '，当前平台不可用' : !voiceReady(voice) ? '，模型和运行组件校验完成后可使用' : ''}`" :aria-pressed="modelValue === voice.id" @click="emit('update:modelValue', voice.id)">
            <span class="voice-artwork" :style="artwork(voice)" aria-hidden="true"><span class="voice-style" :data-voice-style="voiceStyle(voice).id">{{ voiceStyle(voice).label }}</span></span>
            <span v-if="modelValue === voice.id" class="voice-check" aria-hidden="true"><Icon name="check" :size="12" /></span>
            <span class="voice-card-copy"><strong :title="voiceModelName(voice)">{{ voiceModelName(voice) }}</strong><span>{{ voiceTypeLabel(voice) }}</span></span>
          </button>
          <button type="button" class="voice-preview-button" :disabled="disabled || !canPreview(voice)" :aria-label="`试听 ${voiceActionName(voice)}`" :aria-pressed="playing(voice)" :aria-busy="loading(voice) || undefined" :title="loading(voice) ? '正在准备试听' : playing(voice) ? '暂停试听' : canPreview(voice) ? '试听声音' : '下载模型后可试听'" @click="emit('preview', voice.id)"><Icon :name="loading(voice) ? 'refresh' : playing(voice) ? 'pause' : 'volume'" :class="{ 'voice-loading': loading(voice) }" :size="15" /></button>
          <div class="voice-model" :data-model-status="voice.status || 'ready'">
            <span class="voice-model-dependency">依靠 {{ voiceModelName(voice) }} 模型</span>
            <span class="voice-model-state">{{ modelState(voice) }}</span>
            <button v-if="!voiceReady(voice) || voiceRuntimeUpgrade(voice)" type="button" class="voice-model-link" :disabled="disabled" :aria-label="`前往 Info 管理 ${voiceActionName(voice)}`" @click="emit('open-models', 'speech')"><Icon name="info" :size="12" />{{ !voiceReady(voice) && !voiceDownloading(voice) && !voiceUnsupported(voice) ? '请前往下载' : '前往模型管理' }}</button>
          </div>
        </div>
      </div>
      <p v-else class="voice-empty" role="status">{{ voices.length ? '没有找到匹配的声音，试试其他名称、语言或类型。' : '暂时没有可用的声音。' }}</p>
    </div>
    <button type="button" class="voice-manage-link" :disabled="disabled" @click="emit('open-models', 'speech')"><Icon name="info" :size="13" />在 Info 中管理配音模型</button>
  </div>
</template>

<style scoped>
.voice-picker{min-width:0;margin-bottom:16px;font-size:11px;color:var(--ed-text);line-height:1.4;container-type:inline-size}
.voice-picker-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px;min-width:0}
.voice-picker-heading>strong{font-size:11px;font-weight:600;flex-shrink:0}
.voice-current{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ed-accent);font-size:10px}
.voice-current svg{flex-shrink:0}
.voice-search{position:relative;display:flex;align-items:center;margin-bottom:8px;color:var(--ed-muted)}
.voice-search>svg{position:absolute;left:9px;pointer-events:none}
.voice-picker .voice-search input{width:100%;min-width:0;box-sizing:border-box;padding:7px 46px 7px 29px;border:1px solid var(--ed-border);border-radius:7px;background:var(--ed-panel);color:var(--ed-text);font:inherit;font-size:11px;line-height:1.4}
.voice-search>span{position:absolute;right:9px;font-size:10px;pointer-events:none}
.voice-search input::-webkit-search-cancel-button{-webkit-appearance:none}
.voice-grid-scroll{max-height:340px;overflow:auto;overscroll-behavior:contain;padding:2px 4px 3px 2px;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent;min-height:110px}
.voice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.voice-card{position:relative;min-width:0;border-radius:9px}
.voice-model{display:flex;flex-direction:column;gap:5px;padding:9px 5px 3px;font-size:9px;line-height:1.4}
.voice-model-dependency,.voice-model-state{color:var(--ed-muted);overflow-wrap:anywhere}
.voice-picker .voice-model-link,.voice-picker .voice-manage-link{display:flex;align-items:center;justify-content:center;gap:4px;min-height:28px;padding:4px 6px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-panel);color:var(--ed-accent);font:inherit;font-size:10px;cursor:pointer}
.voice-picker .voice-manage-link{margin-top:10px;width:100%}
.voice-picker .voice-model-link:hover:not(:disabled),.voice-picker .voice-manage-link:hover:not(:disabled){border-color:var(--ed-accent)}
.voice-picker .voice-card .voice-choice{position:relative;box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:0;overflow:hidden;width:100%;min-height:0;padding:0;border:1px solid var(--ed-border);border-radius:9px;background:var(--ed-panel);color:var(--ed-text);font:inherit;text-align:left;line-height:1.4;cursor:pointer}
.voice-picker .voice-card .voice-choice:hover:not(:disabled){border-color:var(--ed-accent);background:var(--ed-panel);color:var(--ed-text)}
.voice-picker .voice-card.selected .voice-choice{border-color:var(--ed-accent);box-shadow:0 0 0 1px var(--ed-accent)}
.voice-artwork{position:relative;display:block;width:100%;aspect-ratio:1;user-select:none;background-color:#e4edf0;background-repeat:no-repeat}
.voice-style{position:absolute;left:7px;bottom:7px;display:block;padding:3px 8px;border:1px solid #ffffff75;border-radius:5px;background:#172435d9;color:#fff;font-size:11px;font-weight:600;letter-spacing:.04em;line-height:1.4;box-shadow:0 1px 5px #142d3920}
.voice-card-copy{display:flex;flex-direction:column;gap:3px;min-width:0;padding:8px 8px 9px}
.voice-card-copy>strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:28px;font-size:10px;font-weight:600;overflow-wrap:anywhere}
.voice-card-copy>span{font-size:9px;color:var(--ed-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.voice-check{position:absolute;top:6px;left:6px;display:flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:50%;background:var(--ed-accent);color:#fff;box-shadow:0 1px 4px #0002}
.voice-picker .voice-card .voice-preview-button{position:absolute;right:6px;top:6px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:26px;height:26px;min-height:26px;padding:0;border:1px solid #fff9;border-radius:50%;background:#fffffff0;color:#35495a;cursor:pointer;box-shadow:0 1px 5px #142d3918}
.voice-picker .voice-card .voice-preview-button:hover:not(:disabled),.voice-picker .voice-card.previewing .voice-preview-button{background:var(--ed-accent);border-color:var(--ed-accent);color:#fff}
.voice-picker button:disabled,.voice-picker input:disabled{opacity:.5;cursor:not-allowed}
.voice-picker button:focus-visible,.voice-picker input:focus-visible,.voice-grid-scroll:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}
.voice-empty{margin:0;padding:28px 16px;text-align:center;color:var(--ed-muted);font-size:11px;line-height:1.7}
.voice-loading{animation:voice-turn .9s linear infinite}
@keyframes voice-turn{to{transform:rotate(360deg)}}
@container(min-width:480px){.voice-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.voice-grid-scroll{max-height:380px}}
@container(max-width:219px){.voice-grid{grid-template-columns:1fr}}
@media(max-width:420px){.voice-grid-scroll{max-height:340px}.voice-current{max-width:55%}}
@media(prefers-reduced-motion:reduce){.voice-loading{animation:none}}
</style>
