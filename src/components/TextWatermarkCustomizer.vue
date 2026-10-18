<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { WatermarkMaterial } from '../core/watermark-library'
import { addTextWatermark, type TextWatermarkOptions } from '../core/watermark-track'
import { createProject } from '../core/project'
import { animatedClipAt } from '../core/visual-animation'
import { drawTextClip } from '../core/preview'
import { clipOpacityAt } from '../core/timeline'
import { VISUAL_MOTION_PRESETS, type VisualMotionPreset } from '../core/visual-motion-presets'
import Icon from './Icon.vue'

const props = defineProps<{ material: WatermarkMaterial; busy?: boolean; projectWidth?: number; projectHeight?: number; error?: string }>()
const emit = defineEmits<{ back: []; add: [options: TextWatermarkOptions] }>()
const text = ref(''), color = ref('#ffffff'), background = ref('#172333'), transparent = ref(true), duration = ref(5)
const placement = ref<TextWatermarkOptions['placement']>('center'), animation = ref<VisualMotionPreset>('fade')
const canvas = ref<HTMLCanvasElement>(), previewError = ref(''), playing = ref(false), position = ref(0)
const previewProject = computed(() => createProject('样式预览', { width: props.projectWidth ?? 960, height: props.projectHeight ?? 540, fps: 30 }))
const scale = computed(() => Math.min(960 / previewProject.value.width, 540 / previewProject.value.height))
const canvasWidth = computed(() => Math.round(previewProject.value.width * scale.value)), canvasHeight = computed(() => Math.round(previewProject.value.height * scale.value))
let frame = 0, started = 0, reduceMotion = false
const options = computed<TextWatermarkOptions>(() => ({ text: text.value, color: color.value, background: transparent.value ? 'transparent' : background.value, duration: duration.value, placement: placement.value, animation: animation.value }))
const clip = computed(() => {
  try {
    const added = addTextWatermark(previewProject.value, props.material, 0, options.value)
    return added.project.tracks.flatMap(track => track.clips).find(item => item.id === added.clipId)
  } catch { return undefined }
})
function stop(): void { cancelAnimationFrame(frame); frame = 0; playing.value = false }
function paint(): void {
  const context = canvas.value?.getContext('2d')
  if (!context) return
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvasWidth.value, canvasHeight.value)
  if (!clip.value) { previewError.value = '请输入文字及有效的时长。'; return }
  previewError.value = ''
  const visible = animatedClipAt(clip.value, position.value)
  context.save()
  context.scale(scale.value, scale.value)
  context.globalAlpha = clipOpacityAt(visible, position.value)
  context.translate(visible.x, visible.y)
  context.scale(visible.width / clip.value.width, visible.height / clip.value.height)
  context.beginPath(); context.rect(0, 0, clip.value.width, clip.value.height); context.clip()
  drawTextClip(context, { ...visible, width: clip.value.width, height: clip.value.height })
  context.restore()
}
function tick(now: number): void {
  position.value = Math.min(duration.value, (now - started) / 1000)
  paint()
  if (position.value >= duration.value) { stop(); return }
  frame = requestAnimationFrame(tick)
}
function play(): void {
  if (!clip.value) return
  stop(); playing.value = true; position.value = 0; started = performance.now(); frame = requestAnimationFrame(tick)
}
watch(() => props.material, item => {
  const template = item.textTemplate!
  text.value = template.text; color.value = template.color; transparent.value = template.background === 'transparent'
  background.value = transparent.value ? '#172333' : template.background
  duration.value = item.duration; placement.value = item.placement ?? 'center'; animation.value = template.animation ?? 'fade'
}, { immediate: true })
watch(options, async () => { stop(); position.value = Math.max(0, duration.value / 2); await nextTick(); paint() }, { deep: true })
function submit(): void { if (clip.value && !props.busy) emit('add', { ...options.value }) }
onMounted(() => { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; position.value = duration.value / 2; paint(); if (!reduceMotion) play() })
onBeforeUnmount(stop)
</script>

<template>
  <section class="text-customizer" data-testid="watermark-customizer">
    <header><button type="button" :disabled="busy" @click="emit('back')"><Icon name="chevron-left" :size="15" />返回素材库</button><strong>{{ material.name }}</strong></header>
    <div class="customizer-layout">
      <div class="customizer-preview"><canvas ref="canvas" :width="canvasWidth" :height="canvasHeight" :style="{ aspectRatio: `${canvasWidth} / ${canvasHeight}` }" aria-label="文字样式预览" /><div class="preview-controls"><button type="button" :disabled="!clip" @click="playing ? stop() : play()"><Icon :name="playing ? 'pause' : 'play'" :size="15" />{{ playing ? '暂停预览' : '播放动画' }}</button><span>{{ position.toFixed(1) }} / {{ duration }} 秒</span></div><p>文字、颜色与动画均可修改，添加后可在预览中拖动。</p></div>
      <fieldset :disabled="busy" class="customizer-fields">
        <label class="wide">文字<textarea v-model="text" aria-label="水印文字" rows="4" maxlength="20000" /></label>
        <label>文字颜色<input v-model="color" type="color" aria-label="水印文字颜色" /></label>
        <label>背景颜色<input v-model="background" type="color" aria-label="水印背景颜色" :disabled="transparent" /></label>
        <label class="checkbox wide"><input v-model="transparent" type="checkbox" />透明背景</label>
        <label>时长 / 秒<input v-model.number="duration" type="number" min="0.5" max="120" step="0.5" aria-label="水印时长" /></label>
        <label>位置<select v-model="placement" aria-label="水印位置"><option value="center">居中</option><option value="top-left">左上</option><option value="top-right">右上</option><option value="bottom-left">左下</option><option value="bottom-right">右下</option><option value="bottom-center">底部居中</option></select></label>
        <label class="wide">入退场动画<select v-model="animation" aria-label="水印动画"><option v-for="item in VISUAL_MOTION_PRESETS" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
        <p v-if="previewError || error" class="customizer-error wide" role="alert">{{ previewError || error }}</p>
        <button type="button" class="add-customized wide" :disabled="!clip" data-testid="watermark-customizer-add" @click="submit"><Icon name="plus" :size="16" />添加到时间线</button>
      </fieldset>
    </div>
  </section>
</template>

<style scoped>
.text-customizer{padding:16px;color:var(--ed-text);font-size:12px}.text-customizer header{display:flex;align-items:center;gap:16px;margin-bottom:16px}.text-customizer header strong{font-size:13px}.text-customizer button{display:flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:5px 10px;border:1px solid var(--ed-border);border-radius:7px;background:var(--ed-panel);color:var(--ed-text);font:inherit;cursor:pointer}.customizer-layout{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(210px,1fr);gap:18px}.customizer-preview canvas{display:block;width:100%;max-height:300px;object-fit:contain;background:#172333;background-image:conic-gradient(#1e2d3b 25%,transparent 0 50%,#1e2d3b 0 75%,transparent 0);background-size:24px 24px;border:1px solid var(--ed-border);border-radius:8px}.preview-controls{display:flex;justify-content:space-between;align-items:center;margin-top:9px}.preview-controls span{font-size:10px;font-variant-numeric:tabular-nums;color:var(--ed-muted)}.customizer-preview p{color:var(--ed-muted);font-size:11px;line-height:1.7}.customizer-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px;border:0;margin:0;padding:0;min-width:0}.customizer-fields label{display:flex;flex-direction:column;gap:6px;min-width:0;color:var(--ed-muted);font-size:11px}.customizer-fields .wide{grid-column:1/-1}.customizer-fields input,.customizer-fields select,.customizer-fields textarea{box-sizing:border-box;width:100%;height:32px;padding:6px 8px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-bg);color:var(--ed-text);font:inherit}.customizer-fields textarea{height:auto;resize:vertical;min-height:78px;max-height:180px}.customizer-fields input[type=color]{padding:3px}.customizer-fields .checkbox{flex-direction:row;align-items:center}.checkbox input{width:14px;height:14px}.customizer-fields .add-customized{background:var(--ed-accent);border-color:var(--ed-accent);color:white;min-height:36px}.customizer-error{color:var(--ui-danger,#bd4141);margin:0;line-height:1.6}.text-customizer button:disabled{opacity:.5;cursor:default}@media(max-width:600px){.customizer-layout{grid-template-columns:1fr}.customizer-preview canvas{max-height:200px}}
</style>
