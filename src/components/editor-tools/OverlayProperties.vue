<script setup lang="ts">
import type { Clip, ClipOverlay } from '../../core/types'
import { OVERLAY_PRESETS } from '../../core/visual-animation'

const props = defineProps<{ clip: Clip; disabled?: boolean }>()
const emit = defineEmits<{ change: [patch: Partial<Clip>, label: string] }>()
function update(patch: Partial<ClipOverlay>): void {
  if (props.disabled || !props.clip.overlay) return
  const overlay = { ...props.clip.overlay, ...patch }
  if (overlay.kind === 'spotlight' && !overlay.region) {
    const width = Math.max(1, props.clip.width * .5), height = Math.max(1, props.clip.height * .5)
    overlay.region = { x: (props.clip.width - width) / 2, y: (props.clip.height - height) / 2, width, height }
  }
  if (overlay.kind !== 'spotlight') delete overlay.region
  emit('change', { overlay }, '更新标注样式')
}
function number(event: Event, field: 'strokeWidth' | 'blurRadius'): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value >= 1 && value <= (field === 'strokeWidth' ? 100 : 50)) update({ [field]: value })
}
</script>

<template>
  <section v-if="clip.overlay" class="overlay-properties" data-testid="overlay-properties">
    <h3>视觉标注</h3>
    <label>标注类型<select :value="clip.overlay.kind" :disabled="disabled" aria-label="片段标注类型" @change="update({ kind: ($event.target as HTMLSelectElement).value as ClipOverlay['kind'] })"><option v-for="item in OVERLAY_PRESETS" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
    <div class="overlay-style-grid">
      <label v-if="clip.overlay.kind !== 'blur'">颜色<input type="color" :value="clip.overlay.color" :disabled="disabled" aria-label="片段标注颜色" @input="update({ color: ($event.target as HTMLInputElement).value })" /></label>
      <label v-if="clip.overlay.kind === 'blur'">模糊半径<input type="number" :value="clip.overlay.blurRadius" min="1" max="50" :disabled="disabled" aria-label="片段标注模糊半径" @change="number($event, 'blurRadius')" /></label>
      <label v-else-if="!['mask', 'highlight', 'spotlight'].includes(clip.overlay.kind)">线宽 / 像素<input type="number" :value="clip.overlay.strokeWidth" min="1" max="100" :disabled="disabled" aria-label="片段标注线宽" @change="number($event, 'strokeWidth')" /></label>
    </div>
    <p>位置、尺寸和旋转可在下方画面变换或预览中调整。</p>
  </section>
</template>

<style scoped>
.overlay-properties{margin:12px 0}.overlay-properties label{display:flex;flex-direction:column;gap:6px;margin:10px 0;color:var(--ed-muted);font-size:11px}.overlay-properties input,.overlay-properties select{width:100%;min-width:0;box-sizing:border-box;height:32px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-bg);color:var(--ed-text);padding:5px 7px;font:inherit}.overlay-properties input[type=color]{padding:3px}.overlay-style-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.overlay-properties p{font-size:10px;color:var(--ed-muted);line-height:1.6;margin:8px 0}
</style>
