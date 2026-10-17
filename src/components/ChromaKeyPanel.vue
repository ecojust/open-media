<script setup lang="ts">
import { computed } from 'vue'
import type { ClipChromaKey } from '../core/types'
import { chromaKeySpillChannel, createChromaKey } from '../core/chroma-key'

const props = defineProps<{ value?: ClipChromaKey; disabled?: boolean }>()
const emit = defineEmits<{ change: [value: ClipChromaKey, label: string] }>()
const current = computed(() => props.value ?? createChromaKey({ enabled: false }))
function update(patch: Partial<ClipChromaKey>): void {
  if (!props.disabled) emit('change', createChromaKey({ ...current.value, ...patch }), '调整绿幕去底')
}
</script>

<template>
  <section class="chroma-key-panel" data-testid="chroma-key-panel">
    <label class="chroma-key-toggle"><input type="checkbox" :checked="current.enabled" :disabled="disabled" aria-label="绿幕去底" data-testid="chroma-key-enabled" @change="update({ enabled: ($event.target as HTMLInputElement).checked })"><span>绿幕去底</span></label>
    <div v-if="current.enabled" class="chroma-key-controls">
      <label class="key-color">去除颜色<input type="color" :value="current.color" :disabled="disabled" aria-label="去底颜色" @change="update({ color: ($event.target as HTMLInputElement).value })"></label>
      <label>颜色容差<output>{{ Math.round(current.similarity * 100) }}%</output><input type="range" min="0.01" max="1" step="0.01" :value="current.similarity" :disabled="disabled" aria-label="去底颜色容差" @change="update({ similarity: Number(($event.target as HTMLInputElement).value) })"></label>
      <label>边缘柔和<output>{{ Math.round(current.blend * 100) }}%</output><input type="range" min="0" max="1" step="0.01" :value="current.blend" :disabled="disabled" aria-label="去底边缘柔和" @change="update({ blend: Number(($event.target as HTMLInputElement).value) })"></label>
      <label class="chroma-key-toggle spill-toggle"><input type="checkbox" :checked="current.spillSuppression === true" :disabled="disabled || !chromaKeySpillChannel(current)" aria-label="抑制边缘溢色" data-testid="chroma-key-spill" @change="update({ spillSuppression: ($event.target as HTMLInputElement).checked })"><span>抑制边缘溢色</span></label>
      <p>调整容差去掉背景残留。溢色抑制适用于绿色或蓝色背景，会降低前景中残留的同色分量；需要保留该颜色时可关闭。</p>
    </div>
  </section>
</template>

<style scoped>
.chroma-key-panel{margin:12px 0;padding:10px;border:1px solid var(--ed-border);border-radius:7px;grid-column:1/-1}
.chroma-key-toggle{display:flex!important;flex-direction:row!important;align-items:center;gap:7px!important;margin:0!important;font-size:11px!important;color:var(--ed-text)!important;cursor:pointer}
.chroma-key-toggle input{width:14px;height:14px;margin:0;accent-color:var(--ed-accent)}
.chroma-key-controls .spill-toggle{margin:3px 0 10px!important}
.chroma-key-controls{padding-top:12px}.chroma-key-controls label{display:flex;flex-direction:column;gap:6px;position:relative;font-size:10px;color:var(--ed-muted);margin-bottom:10px}.chroma-key-controls output{position:absolute;right:0;color:var(--ed-text)}.chroma-key-controls input[type=range]{width:100%}.chroma-key-controls .key-color{display:flex;flex-direction:row;align-items:center;justify-content:space-between}.key-color input{width:38px;height:26px;padding:2px}.chroma-key-controls p{font-size:10px;color:var(--ed-muted);line-height:1.6;margin:0}
</style>
