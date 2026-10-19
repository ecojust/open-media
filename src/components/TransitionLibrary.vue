<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TRANSITION_PRESETS, TRANSITION_COLLECTIONS, type TransitionCut, type TransitionParameters } from '../core/transitions'
import type { TransitionEffect } from '../core/types'
import Icon from './Icon.vue'
import TransitionPreview from './TransitionPreview.vue'

const props = defineProps<{ cut?: TransitionCut; fps: number; fromName?: string; toName?: string; error?: string }>()
const emit = defineEmits<{ select: [effect: TransitionEffect, duration: number, parameters: TransitionParameters] }>()
const selected = ref<TransitionEffect>('fade'), length = ref(1), phase = ref(0)
const collection = ref('all')
const direction = ref<NonNullable<TransitionParameters['direction']>>('left'), easing = ref<NonNullable<TransitionParameters['easing']>>('ease-in-out')
const scope = ref<NonNullable<TransitionParameters['scope']>>('both'), color = ref('#fff9e8'), blur = ref(16)
const directional = computed(() => selected.value.startsWith('wipe-') || selected.value.startsWith('slide-'))
const parameters = computed<TransitionParameters>(() => ({ easing: easing.value, scope: scope.value, ...(directional.value ? { direction: direction.value } : {}), ...(selected.value === 'flash-white' ? { color: color.value } : {}), ...(selected.value === 'defocus' ? { blur: blur.value } : {}) }))
const visiblePresets = computed(() => TRANSITION_PRESETS.filter(item => collection.value === 'all' || TRANSITION_COLLECTIONS.find(group => group.id === collection.value)?.effects.some(effect => effect === item.id)))
function selectCollection(value: string): void {
  hovered.value = undefined; focused.value = undefined
  collection.value = value
  if (!visiblePresets.value.some(item => item.id === selected.value)) selected.value = visiblePresets.value[0]!.id
}
watch(selected, effect => { if (effect.startsWith('wipe-') || effect.startsWith('slide-')) direction.value = effect.split('-')[1] as typeof direction.value })
const minimum = computed(() => 2 / props.fps)
const actualLength = computed(() => props.cut ? Math.max(minimum.value, Math.min(Number(length.value) || minimum.value, props.cut.maxDuration)) : 0)
const hovered = ref<TransitionEffect>(), focused = ref<TransitionEffect>()
const reducedMotion = ref(false), pageVisible = ref(true)
const animatedEffect = computed(() => reducedMotion.value || !pageVisible.value ? undefined : hovered.value ?? focused.value ?? selected.value)
const emptyParameters: TransitionParameters = {}
let animation = 0, origin: number | undefined
let motionQuery: MediaQueryList | undefined
function tick(time: number): void {
  origin ??= time
  phase.value = ((time - origin) % 3200) / 3200
  animation = requestAnimationFrame(tick)
}
function updateAnimation(): void {
  cancelAnimationFrame(animation)
  origin = undefined
  phase.value = 0
  if (animatedEffect.value) animation = requestAnimationFrame(tick)
}
function updateMotion(): void { reducedMotion.value = motionQuery?.matches ?? false }
function updateVisibility(): void { pageVisible.value = !document.hidden }
watch(animatedEffect, updateAnimation)
onMounted(() => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  updateMotion()
  updateVisibility()
  motionQuery.addEventListener('change', updateMotion)
  document.addEventListener('visibilitychange', updateVisibility)
  updateAnimation()
})
onBeforeUnmount(() => {
  cancelAnimationFrame(animation)
  motionQuery?.removeEventListener('change', updateMotion)
  document.removeEventListener('visibilitychange', updateVisibility)
})
</script>

<template>
  <section class="transition-library" data-testid="transition-library">
    <div class="transition-target" v-if="cut"><Icon name="scissors" :size="17" /><div><strong>切点 {{ cut.time.toFixed(2) }} 秒</strong><span>{{ fromName }} <span aria-hidden="true">→</span> {{ toName }}</span></div></div>
    <p v-else class="transition-empty" role="status">需要两个首尾相接的视频片段。请先分割视频或接拢片段，并解锁视频轨道。</p>
    <div class="transition-collections" role="group" aria-label="转场分类"><button type="button" :aria-pressed="collection === 'all'" @click="selectCollection('all')">全部 <span>{{ TRANSITION_PRESETS.length }}</span></button><button v-for="group in TRANSITION_COLLECTIONS" :key="group.id" type="button" :aria-pressed="collection === group.id" @click="selectCollection(group.id)">{{ group.name }} <span>{{ group.effects.length }}</span></button></div>
    <p class="transition-preview-note">{{ reducedMotion ? '已根据系统设置静态展示效果' : '悬停或选中预览 · 退场与入场连续演示' }}</p>
    <div class="transition-grid" :class="{ focused: collection !== 'all' }" role="radiogroup" aria-label="转场效果">
      <label v-for="item in visiblePresets" :key="item.id" class="transition-card" :class="{ selected: selected === item.id }" :title="item.description" @mouseenter="hovered = item.id" @mouseleave="hovered = undefined" @focusin="focused = item.id" @focusout="focused = undefined">
        <input v-model="selected" type="radio" name="transition-effect" :value="item.id" :aria-label="item.name" />
        <TransitionPreview :effect="item.id" :phase="animatedEffect === item.id ? phase : .35" :parameters="selected === item.id ? parameters : emptyParameters" :active="animatedEffect === item.id" />
        <span class="transition-name">{{ item.name }}<Icon v-if="selected === item.id" name="check" :size="13" /></span>
      </label>
    </div>
    <div class="transition-options"><label>转场时长<input v-model.number="length" type="number" :min="minimum" :max="cut?.maxDuration || 30" step="0.1" aria-label="转场时长" /><span>秒</span></label><span v-if="cut">前后各 {{ (actualLength / 2).toFixed(2) }} 秒<span v-if="Number(length) > cut.maxDuration">（已适应片段长度）</span></span></div>
    <div class="transition-tuning">
      <label>动画节奏<select v-model="easing" aria-label="转场动画节奏"><option value="linear">匀速</option><option value="ease-in">缓入</option><option value="ease-out">缓出</option><option value="ease-in-out">缓入缓出</option></select></label>
      <label>作用范围<select v-model="scope" aria-label="转场作用范围"><option value="both">前后两段</option><option value="outgoing">仅前段退场</option><option value="incoming">仅后段入场</option></select></label>
      <label v-if="directional">方向<select v-model="direction" aria-label="转场方向"><option value="left">向左</option><option value="right">向右</option><option value="up">向上</option><option value="down">向下</option></select></label>
      <label v-if="selected === 'flash-white'">过渡颜色<input v-model="color" type="color" aria-label="转场过渡颜色" /></label>
      <label v-if="selected === 'defocus'">模糊强度<input v-model.number="blur" type="number" min="0" max="50" aria-label="转场模糊强度" /></label>
    </div>
    <p class="transition-note">根据播放头寻找最近切点，优先使用选中的视频轨道。效果加入转场轨道，可继续更换或删除；项目时长保持不变。</p>
    <p v-if="error" class="transition-error" role="alert">{{ error }}</p>
    <footer><span>{{ TRANSITION_PRESETS.find(item => item.id === selected)?.description }}</span><button type="button" data-testid="transition-apply" :disabled="!cut || !Number.isFinite(Number(length)) || Number(length) <= 0" @click="emit('select', selected, actualLength, parameters)"><Icon name="plus" :size="15" />应用转场</button></footer>
  </section>
</template>

<style scoped>
.transition-library{padding:18px;color:var(--ed-text);font-size:12px}.transition-target{display:flex;gap:10px;align-items:center;margin-bottom:15px}.transition-target>svg{color:var(--ed-accent)}.transition-target>div{display:flex;flex-direction:column;gap:4px;min-width:0}.transition-target strong{font-size:13px}.transition-target span{color:var(--ed-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.transition-empty{padding:11px;background:var(--ed-bg);border-radius:8px;line-height:1.7;color:var(--ed-muted)}.transition-collections{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.transition-collections button{display:flex;align-items:center;gap:6px;background:var(--ed-bg);border:1px solid var(--ed-border);border-radius:6px;padding:6px 9px;font:inherit;color:var(--ed-muted);cursor:pointer}.transition-collections button[aria-pressed=true]{border-color:var(--ed-accent);color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 8%,var(--ed-panel))}.transition-collections span{font-size:10px;opacity:.8}.transition-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.transition-grid.focused{grid-template-columns:repeat(4,minmax(0,1fr))}.transition-card{display:flex;flex-direction:column;gap:7px;position:relative;min-width:0;padding:6px;border:1px solid var(--ed-border);border-radius:8px;cursor:pointer;background:var(--ed-panel)}.transition-card.selected{border-color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 7%,var(--ed-panel))}.transition-card:has(input:focus-visible){outline:2px solid var(--ed-accent);outline-offset:2px}.transition-card input{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}.transition-name{display:flex;justify-content:space-between;align-items:center;gap:3px;font-size:11px}.transition-name svg{color:var(--ed-accent)}.transition-preview-note{margin:0 0 10px;color:var(--ed-muted);font-size:10px;line-height:1.6}.transition-options{display:flex;gap:15px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:17px;font-size:11px}.transition-options label{display:flex;align-items:center;gap:7px}.transition-options input{box-sizing:border-box;width:78px;height:32px;padding:4px 7px;background:var(--ed-bg);border:1px solid var(--ed-border);border-radius:5px;color:var(--ed-text);font:inherit}.transition-options>span,.transition-note{color:var(--ed-muted)}.transition-note{font-size:11px;line-height:1.7;margin:12px 0}.transition-error{color:var(--ui-danger,#bd4141)}footer{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--ed-border);padding-top:13px}footer>span{font-size:11px;color:var(--ed-muted)}footer button{display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:6px;padding:9px 12px;font:inherit;background:var(--ed-accent);color:#fff;white-space:nowrap;cursor:pointer}footer button:disabled{opacity:.45;cursor:default}@media(max-width:600px){.transition-grid,.transition-grid.focused{grid-template-columns:repeat(3,minmax(0,1fr))}.transition-library{padding:12px}}
.transition-tuning{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}.transition-tuning label{display:flex;flex-direction:column;gap:6px;color:var(--ed-muted);font-size:11px}.transition-tuning select,.transition-tuning input{box-sizing:border-box;width:100%;height:32px;padding:5px 7px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-bg);color:var(--ed-text);font:inherit}.transition-tuning input[type=color]{padding:3px}@media(max-width:500px){.transition-tuning{grid-template-columns:1fr 1fr}}
</style>
