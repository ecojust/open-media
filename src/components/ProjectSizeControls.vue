<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Project } from '../core/types'
import { cloneProject, newId } from '../core/project'
import { MAX_PROJECT_SIZE, MIN_PROJECT_SIZE, projectSizeError, resizeProject } from '../core/project-size'
import Icon from './Icon.vue'

const props = defineProps<{ project: Project; disabled?: boolean }>()
const emit = defineEmits<{ change: [project: Project, label: string, historyGroup?: string] }>()
const presets: Record<string, [number, number]> = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080], cinema: [2560, 1080] }
const controls = ref<HTMLElement | null>(null), widthInput = ref<HTMLInputElement | null>(null)
const width = ref(String(props.project.width)), height = ref(String(props.project.height))
const custom = ref(false), error = ref('')
const preset = computed(() => custom.value ? 'custom' : Object.entries(presets).find(([, size]) => size[0] === props.project.width && size[1] === props.project.height)?.[0] ?? 'custom')
let baseline: Project | undefined, historyGroup: string | undefined, expected = '', disposed = false

// The parent validates and clones a change, and may replace its modification time.
// Compare document content so an external undo or edit ends the resize session.
function contentKey(project: Project): string { return JSON.stringify({ ...project, updatedAt: '' }) }
function finishSession(): void { baseline = undefined; historyGroup = undefined; expected = '' }
function syncDraft(): void { width.value = String(props.project.width); height.value = String(props.project.height); error.value = '' }
function beginSession(): void {
  if (props.disabled || baseline) return
  baseline = cloneProject(props.project)
  historyGroup = newId('project-size')
}
function publish(next: Project, label: string, group?: string): boolean {
  if (props.disabled || disposed) return false
  if (contentKey(next) === contentKey(props.project)) return true
  expected = contentKey(next)
  emit('change', next, label, group)
  return true
}
function applyInput(event: Event, dimension: 'width' | 'height'): void {
  if (props.disabled) return
  beginSession()
  if (dimension === 'width') width.value = (event.target as HTMLInputElement).value
  else height.value = (event.target as HTMLInputElement).value
  custom.value = true
  const w = Number(width.value), h = Number(height.value)
  error.value = projectSizeError(w, h) || ''
  if (error.value) return
  try {
    // Resize from the focus-entry snapshot: intermediate values such as 19 must
    // not permanently clamp fonts or geometry before the user finishes 1920.
    publish(resizeProject(baseline ?? props.project, w, h), `项目尺寸已设为 ${w} × ${h}`, historyGroup)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
function choosePreset(event: Event): void {
  if (props.disabled) return
  const value = (event.target as HTMLSelectElement).value
  finishSession(); syncDraft()
  custom.value = value === 'custom'
  if (custom.value) { void nextTick(() => widthInput.value?.focus()); return }
  const size = presets[value]
  if (!size) return
  try {
    width.value = String(size[0]); height.value = String(size[1])
    publish(resizeProject(props.project, size[0], size[1]), '调整画面比例')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
function leaveControls(event: FocusEvent): void {
  if (event.relatedTarget instanceof Node && controls.value?.contains(event.relatedTarget)) return
  finishSession()
}
function cancelDraft(event: KeyboardEvent): void {
  // Valid input is already applied; Escape discards only an unfinished draft.
  finishSession(); syncDraft()
  ;(event.target as HTMLElement).blur()
}
function setSourceSize(w: number, h: number): boolean {
  if (props.disabled || disposed) return false
  finishSession()
  error.value = projectSizeError(w, h) || ''
  if (error.value) return false
  try {
    custom.value = true; width.value = String(w); height.value = String(h)
    const applied = publish(resizeProject(props.project, w, h), `项目尺寸已设为 ${w} × ${h}`)
    void nextTick(() => {
      if (disposed || props.disabled) return
      controls.value?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      widthInput.value?.focus({ preventScroll: true })
      widthInput.value?.select()
    })
    return applied
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); return false }
}
watch(() => props.project, project => {
  if (expected && contentKey(project) === expected) return
  finishSession(); syncDraft(); custom.value = false
})
watch(() => props.disabled, disabled => { if (disabled) { finishSession(); syncDraft() } })
onBeforeUnmount(() => { disposed = true; finishSession() })
defineExpose({ setSourceSize })
</script>

<template>
  <div ref="controls" class="project-size-controls" data-testid="project-size-controls" @focusout="leaveControls" @keydown.esc.stop.prevent="cancelDraft">
    <span class="size-title"><Icon name="fit" :size="15" />画面</span>
    <select aria-label="画面比例" :value="preset" :disabled="disabled" @change="choosePreset">
      <option value="landscape">横屏 16:9</option><option value="portrait">竖屏 9:16</option><option value="square">方形 1:1</option><option value="cinema">宽银幕 21:9</option><option value="custom">自定义尺寸</option>
    </select>
    <div class="size-dimensions">
      <label><span>宽</span><input ref="widthInput" type="number" inputmode="numeric" aria-label="项目宽度" :aria-invalid="!!error" :value="width" :min="MIN_PROJECT_SIZE" :max="MAX_PROJECT_SIZE" step="1" :disabled="disabled" title="修改后实时应用；按 Esc 放弃未完成的输入" @focus="beginSession" @input="applyInput($event, 'width')" /></label>
      <span class="size-cross" aria-hidden="true">×</span>
      <label><span>高</span><input type="number" inputmode="numeric" aria-label="项目高度" :aria-invalid="!!error" :value="height" :min="MIN_PROJECT_SIZE" :max="MAX_PROJECT_SIZE" step="1" :disabled="disabled" title="修改后实时应用；按 Esc 放弃未完成的输入" @focus="beginSession" @input="applyInput($event, 'height')" /></label>
      <span class="size-unit">px</span>
    </div>
    <span v-if="error" class="size-error" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.project-size-controls{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;min-width:0;box-sizing:border-box;padding:7px 10px;border-bottom:1px solid var(--ed-border);background:var(--ed-panel);color:var(--ed-text);font-size:11px;line-height:1.4}
.size-title{display:flex;align-items:center;gap:5px;flex:none;color:var(--ed-muted)}
.size-dimensions{display:flex;align-items:center;gap:5px;min-width:0}
.size-dimensions label{display:flex;align-items:center;gap:4px;color:var(--ed-muted)}
.project-size-controls select,.project-size-controls input{height:28px;min-height:28px;box-sizing:border-box;border:1px solid var(--ed-border);border-radius:5px;background:var(--ed-bg);color:var(--ed-text);font:inherit;outline:none}
.project-size-controls select{width:116px;padding:2px 5px}
.project-size-controls input{width:75px;min-width:0;padding:3px 5px;font-variant-numeric:tabular-nums}
.project-size-controls :is(select,input):focus-visible{border-color:var(--ed-accent);outline:2px solid color-mix(in srgb,var(--ed-accent) 25%,transparent);outline-offset:1px}
.project-size-controls :is(select,input):disabled{opacity:.5;cursor:not-allowed}
.project-size-controls input[aria-invalid=true]{border-color:var(--ed-danger,#d55454)}
.size-cross,.size-unit{color:var(--ed-muted)}
.size-error{flex-basis:100%;color:var(--ed-danger,#d55454);font-size:11px}
</style>
