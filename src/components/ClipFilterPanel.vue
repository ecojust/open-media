<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { ClipFilters } from '../core/types'
import { CLIP_FILTER_PRESETS, DEFAULT_CLIP_FILTERS, getClipSvgColorMatrix, matchClipFilterPreset } from '../core/clip-filters'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ filters?: ClipFilters; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ change: [filters: ClipFilters | undefined, label: string] }>()
const instanceId = useId()
const draft = ref<ClipFilters>({ ...DEFAULT_CLIP_FILTERS, ...props.filters })
watch(() => props.filters, value => { draft.value = { ...DEFAULT_CLIP_FILTERS, ...value } }, { deep: true })
const selectedPreset = computed(() => matchClipFilterPreset(draft.value))
const presetName = computed(() => CLIP_FILTER_PRESETS.find(preset => preset.id === selectedPreset.value)?.name || '自定义')
const modified = computed(() => Object.entries(DEFAULT_CLIP_FILTERS).some(([key, value]) => draft.value[key as keyof ClipFilters] !== value))
const adjustments = [
  { key: 'brightness', label: '亮度', min: -1, max: 1, neutral: 0 },
  { key: 'contrast', label: '对比度', min: 0, max: 2, neutral: 1 },
  { key: 'saturation', label: '饱和度', min: 0, max: 2, neutral: 1 },
  { key: 'temperature', label: '色温', min: -1, max: 1, neutral: 0 },
  { key: 'tint', label: '色调', min: -1, max: 1, neutral: 0 },
  { key: 'sepia', label: '褐色调', min: 0, max: 1, neutral: 0 },
] as const

function commitFilters(filters: ClipFilters, label: string): void {
  if (props.disabled) return
  const current = { ...DEFAULT_CLIP_FILTERS, ...props.filters }
  if (Object.entries(current).every(([key, value]) => filters[key as keyof ClipFilters] === value)) return
  emit('change', { ...filters }, label)
}
function applyPreset(id: string): void {
  const preset = CLIP_FILTER_PRESETS.find(item => item.id === id)
  if (!preset || props.disabled) return
  draft.value = { ...preset.filters }
  commitFilters(draft.value, `应用${preset.name}滤镜`)
}
function adjust(label: string): void { commitFilters(draft.value, `调整滤镜${label}`) }
function toggle(event: Event): void {
  draft.value.enabled = (event.target as HTMLInputElement).checked
  commitFilters(draft.value, draft.value.enabled ? '启用片段滤镜' : '停用片段滤镜')
}
function reset(): void {
  if (props.disabled) return
  draft.value = { ...DEFAULT_CLIP_FILTERS }
  emit('change', undefined, '重置片段滤镜')
}
function displayValue(value: number, neutral = 0): string {
  const amount = Math.round((value - neutral) * 100)
  return `${amount > 0 ? '+' : ''}${amount}`
}
</script>

<template>
  <div class="clip-filter-panel" data-testid="clip-filter-panel">
    <div class="filter-toolbar">
      <label class="filter-switch"><input type="checkbox" role="switch" aria-label="启用滤镜" :checked="draft.enabled" :disabled="disabled" @change="toggle" /><span class="filter-switch-track" aria-hidden="true" /><span>启用滤镜</span></label>
      <button type="button" class="filter-reset" :disabled="disabled || !modified" aria-label="重置滤镜" title="重置滤镜" @click="reset"><Icon name="refresh" :size="13" />重置</button>
    </div>
    <p class="filter-hint">{{ draft.enabled ? '关闭滤镜可对比原片，已调参数会保留。' : '正在显示原片，打开滤镜即可恢复效果。' }}</p>
    <div class="filter-section-heading"><strong>预设效果</strong><span>{{ presetName }}</span></div>
    <div class="filter-presets" role="group" aria-label="滤镜预设">
      <button v-for="preset in CLIP_FILTER_PRESETS" :key="preset.id" type="button" class="filter-preset" :data-filter-preset="preset.id" :aria-label="`应用${preset.name}滤镜`" :aria-pressed="selectedPreset === preset.id" :title="preset.description" :disabled="disabled" @click="applyPreset(preset.id)">
        <svg class="filter-artwork" viewBox="0 0 96 62" fill="none" aria-hidden="true">
          <defs>
            <linearGradient :id="`${instanceId}-sky-${preset.id}`" x1="48" y1="0" x2="48" y2="62" gradientUnits="userSpaceOnUse"><stop stop-color="#7aabc6" /><stop offset="1" stop-color="#ebc7a3" /></linearGradient>
            <filter :id="`${instanceId}-look-${preset.id}`" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" :values="getClipSvgColorMatrix(preset.filters).join(' ')" /></filter>
          </defs>
          <g :filter="`url(#${instanceId}-look-${preset.id})`">
            <path :fill="`url(#${instanceId}-sky-${preset.id})`" d="M0 0h96v62H0z" />
            <circle cx="72" cy="16" r="9" fill="#ffdb91" />
            <path d="M0 36 24 10l31 29 15-16 26 16v23H0Z" fill="#486b8a" />
            <path d="m13 22 11-12 15 14-11-4-6 5Z" fill="#e6e6dc" />
            <path d="M0 43c24-10 57-6 96 0v19H0Z" fill="#75b7b8" />
            <path d="M0 49c22-2 36 5 50 13H0ZM70 52l26-11v21H55Z" fill="#355e4f" />
            <path d="M51 37h17v13H51Z" fill="#df9871" /><path d="m48 38 11-9 12 9Z" fill="#704d41" /><path d="M57 43h5v7h-5Z" fill="#675449" />
            <path d="m12 31 8 19H4Zm69 11 7 17H74Z" fill="#284d43" /><path d="M40 49h21m-27 5h12m16-11h14" stroke="#c4d7c8" stroke-width="1.4" stroke-linecap="round" />
          </g>
        </svg>
        <span class="filter-preset-caption">{{ preset.name }}<Icon v-if="selectedPreset === preset.id" name="check" :size="11" /></span>
      </button>
    </div>
    <label class="filter-adjustment filter-intensity"><span>滤镜强度<output>{{ Math.round(draft.intensity * 100) }}%</output></span><input v-model.number="draft.intensity" type="range" min="0" max="1" step="0.01" aria-label="滤镜强度" :disabled="disabled" @change="adjust('强度')" /></label>
    <div class="filter-section-heading filter-adjustment-heading"><strong>画面微调</strong><span>拖动后松开应用</span></div>
    <label v-for="adjustment in adjustments" :key="adjustment.key" class="filter-adjustment"><span>{{ adjustment.label }}<output>{{ displayValue(draft[adjustment.key], adjustment.neutral) }}</output></span><input v-model.number="draft[adjustment.key]" type="range" :min="adjustment.min" :max="adjustment.max" step="0.01" :aria-label="adjustment.label" :disabled="disabled" @change="adjust(adjustment.label)" /></label>
  </div>
</template>

<style scoped>
.clip-filter-panel{container-type:inline-size;padding-top:14px;color:var(--ed-text)}
.filter-toolbar{display:flex;align-items:center;justify-content:space-between;gap:5px}
.filter-switch{display:flex;align-items:center;gap:7px;position:relative;font-size:11px;cursor:pointer;margin:0;min-width:0}
.filter-switch input{position:absolute;width:28px;height:18px;margin:0;opacity:0;cursor:pointer}
.filter-switch-track{display:block;width:28px;height:16px;border-radius:10px;background:var(--ed-border);flex-shrink:0;position:relative;transition:background .15s}
.filter-switch-track:after{content:'';position:absolute;left:2px;top:2px;width:12px;height:12px;background:white;border-radius:50%;box-shadow:0 1px 2px #0002;transition:transform .15s}
.filter-switch input:checked+.filter-switch-track{background:var(--ed-accent)}
.filter-switch input:checked+.filter-switch-track:after{transform:translateX(12px)}
.filter-switch input:focus-visible+.filter-switch-track{outline:2px solid var(--ed-accent);outline-offset:3px}
.filter-switch:has(input:disabled){opacity:.5;cursor:not-allowed}
.filter-reset{display:flex;align-items:center;justify-content:center;gap:4px;border:0;border-radius:5px;background:transparent;color:var(--ed-muted);padding:4px;font-size:10px;cursor:pointer;min-height:26px;flex-shrink:0}
.filter-reset:hover:not(:disabled){color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 9%,transparent)}
.filter-hint{margin:5px 0 15px;color:var(--ed-muted);font-size:9px;line-height:1.65}
.filter-section-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;margin-bottom:9px}
.filter-section-heading strong{font-weight:600}
.filter-section-heading>span{font-size:9px;color:var(--ed-muted);white-space:nowrap}
.filter-presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
.filter-preset{display:flex;flex-direction:column;align-items:stretch;padding:0;border:1px solid var(--ed-border);border-radius:6px;overflow:hidden;background:var(--ed-panel);color:var(--ed-text);min-width:0;cursor:pointer}
.filter-preset:hover:not(:disabled){border-color:var(--ed-accent)}
.filter-preset[aria-pressed=true]{border-color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 9%,var(--ed-panel));color:var(--ed-accent)}
.filter-artwork{width:100%;height:auto;aspect-ratio:96/62;display:block;background:#7aabc6}
.filter-preset-caption{display:flex;align-items:center;justify-content:center;gap:2px;min-height:24px;padding:0 1px;font-size:10px;white-space:nowrap}
.filter-preset-caption>svg{flex-shrink:0}
.filter-adjustment{display:flex;flex-direction:column;gap:4px;margin:0 0 10px;color:var(--ed-muted);font-size:10px}
.filter-adjustment>span{display:flex;align-items:center;justify-content:space-between;gap:8px}
.filter-adjustment output{position:static;color:var(--ed-text);font-size:10px;font-variant-numeric:tabular-nums}
.filter-adjustment input{width:100%;height:19px;min-height:0;padding:0;margin:0;border:0;accent-color:var(--ed-accent);cursor:pointer}
.filter-intensity{margin-top:16px}
.filter-adjustment-heading{border-top:1px solid var(--ed-border);padding-top:13px;margin-top:13px;margin-bottom:13px}
button:disabled,input:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,input:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}
@container (max-width:185px){.filter-presets{grid-template-columns:repeat(2,minmax(0,1fr))}.filter-section-heading>span{font-size:8px}.filter-switch{font-size:10px;gap:5px}.filter-reset{font-size:9px}}
@container (min-width:330px){.filter-presets{grid-template-columns:repeat(4,minmax(0,1fr))}}
</style>
