<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Clip } from '../../core/types'
import { applyVisualMotionPreset, VISUAL_MOTION_PRESETS, type VisualMotionPreset } from '../../core/visual-motion-presets'

const props = defineProps<{ clip: Clip; disabled?: boolean }>()
const emit = defineEmits<{ change: [patch: Partial<Clip>, label: string] }>()
const preset = ref<VisualMotionPreset>('fade'), error = ref('')
watch(() => props.clip.id, () => { preset.value = 'fade'; error.value = '' })
watch(preset, () => { error.value = '' })

function apply(): void {
  if (props.disabled) return
  try {
    const result = applyVisualMotionPreset(props.clip, preset.value)
    error.value = ''
    emit('change', { keyframes: result.keyframes ?? {}, fadeIn: result.fadeIn, fadeOut: result.fadeOut }, '应用入退场动画')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法应用入退场动画。'
  }
}
</script>

<template>
  <details class="motion-presets" data-testid="motion-preset-controls">
    <summary>入退场动画</summary>
    <fieldset :disabled="disabled">
      <label>选择预设<select v-model="preset" aria-label="片段入退场动画预设"><option v-for="item in VISUAL_MOTION_PRESETS" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
      <p>应用后替换位置、缩放、透明度动画及淡入淡出设置，保留旋转和音量动画。选择预设后点击按钮生效。</p>
      <button type="button" data-testid="motion-preset-apply" @click="apply">应用动画</button>
      <p v-if="error" class="motion-preset-error" role="alert">{{ error }}</p>
    </fieldset>
  </details>
</template>

<style scoped>
.motion-presets{margin:12px 0;color:var(--ed-text);font-size:11px}.motion-presets summary{cursor:pointer;font-weight:600;padding:5px 0}.motion-presets fieldset{border:0;padding:0;margin:8px 0 0;min-width:0}.motion-presets label{display:flex;flex-direction:column;gap:6px;color:var(--ed-muted)}.motion-presets select,.motion-presets button{box-sizing:border-box;width:100%;height:32px;padding:5px 7px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-bg);color:var(--ed-text);font:inherit}.motion-presets button{cursor:pointer;background:var(--ed-panel)}.motion-presets button:disabled,.motion-presets select:disabled{opacity:.5;cursor:default}.motion-presets p{font-size:10px;color:var(--ed-muted);line-height:1.6;margin:8px 0}.motion-presets .motion-preset-error{color:var(--ui-danger,#bd4141)}
</style>
