<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { TRANSITION_PRESETS, TRANSITION_COLLECTIONS, transitionBlindRects, transitionVisualForParameters, type TransitionCut, type TransitionParameters } from '../core/transitions'
import type { TransitionEffect } from '../core/types'
import Icon from './Icon.vue'

const props = defineProps<{ cut?: TransitionCut; fps: number; fromName?: string; toName?: string; error?: string }>()
const emit = defineEmits<{ select: [effect: TransitionEffect, duration: number, parameters: TransitionParameters] }>()
const selected = ref<TransitionEffect>('fade'), length = ref(1), phase = ref(0)
const collection = ref('all')
const direction = ref<NonNullable<TransitionParameters['direction']>>('left'), easing = ref<NonNullable<TransitionParameters['easing']>>('ease-in-out')
const scope = ref<NonNullable<TransitionParameters['scope']>>('both'), color = ref('#fff9e8'), blur = ref(16)
const directional = computed(() => selected.value.startsWith('wipe-') || selected.value.startsWith('slide-'))
const parameters = computed<TransitionParameters>(() => ({ easing: easing.value, scope: scope.value, ...(directional.value ? { direction: direction.value } : {}), ...(selected.value === 'flash-white' ? { color: color.value } : {}), ...(selected.value === 'defocus' ? { blur: blur.value } : {}) }))
const visiblePresets = computed(() => TRANSITION_PRESETS.filter(item => collection.value === 'all' || TRANSITION_COLLECTIONS.find(group => group.id === collection.value)?.effects.some(effect => effect === item.id)))
function selectCollection(value: string): void { collection.value = value; if (!visiblePresets.value.some(item => item.id === selected.value)) selected.value = visiblePresets.value[0]!.id }
watch(selected, effect => { if (effect.startsWith('wipe-') || effect.startsWith('slide-')) direction.value = effect.split('-')[1] as typeof direction.value })
const minimum = computed(() => 2 / props.fps)
const actualLength = computed(() => props.cut ? Math.max(minimum.value, Math.min(Number(length.value) || minimum.value, props.cut.maxDuration)) : 0)
let animation = 0, origin = 0
function tick(time: number): void {
  origin ||= time
  phase.value = ((time - origin) % 3200) / 3200
  animation = requestAnimationFrame(tick)
}
const galleryId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const demos = computed(() => {
  const p = phase.value, v = p < .2 || p > .8 ? 1 : p < .5 ? (.5 - p) / .3 : (p - .5) / .3
  return Object.fromEntries(TRANSITION_PRESETS.map(({ id }) => [id, transitionVisualForParameters(id, (id === selected.value && ((scope.value === 'incoming' && p < .5) || (scope.value === 'outgoing' && p >= .5))) ? 1 : v, id === selected.value ? parameters.value : {})])) as Record<TransitionEffect, ReturnType<typeof transitionVisualForParameters>>
})
function demoTransform(effect: TransitionEffect): string {
  const visual = demos.value[effect]
  return `translate(${visual.translateX * 160} ${visual.translateY * 100}) translate(80 50) scale(${visual.scale}) translate(-80 -50)`
}
function diamondPath(effect: TransitionEffect): string {
  const v = demos.value[effect].visibility
  return `M80 ${50 - 100 * v} L${80 + 160 * v} 50 L80 ${50 + 100 * v} L${80 - 160 * v} 50Z`
}
function radialPath(effect: TransitionEffect): string {
  const v = demos.value[effect].visibility, r = Math.hypot(160, 100) / 2, angle = 2 * Math.PI * v
  return `M80 50 L80 ${50 - r} A${r} ${r} 0 ${v > .5 ? 1 : 0} 1 ${80 + r * Math.sin(angle)} ${50 - r * Math.cos(angle)}Z`
}
onMounted(() => {
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) animation = requestAnimationFrame(tick)
  else phase.value = .35
})
onBeforeUnmount(() => cancelAnimationFrame(animation))
</script>

<template>
  <section class="transition-library" data-testid="transition-library">
    <div class="transition-target" v-if="cut"><Icon name="scissors" :size="17" /><div><strong>切点 {{ cut.time.toFixed(2) }} 秒</strong><span>{{ fromName }} <span aria-hidden="true">→</span> {{ toName }}</span></div></div>
    <p v-else class="transition-empty" role="status">需要两个首尾相接的视频片段。请先分割视频或接拢片段，并解锁视频轨道。</p>
    <div class="transition-collections" role="group" aria-label="转场分类"><button type="button" :aria-pressed="collection === 'all'" @click="selectCollection('all')">全部 <span>{{ TRANSITION_PRESETS.length }}</span></button><button v-for="group in TRANSITION_COLLECTIONS" :key="group.id" type="button" :aria-pressed="collection === group.id" @click="selectCollection(group.id)">{{ group.name }} <span>{{ group.effects.length }}</span></button></div>
    <div class="transition-grid" :class="{ focused: collection !== 'all' }" role="radiogroup" aria-label="转场效果">
      <label v-for="item in visiblePresets" :key="item.id" class="transition-card" :class="{ selected: selected === item.id }" :title="item.description">
        <input v-model="selected" type="radio" name="transition-effect" :value="item.id" :aria-label="item.name" />
        <svg class="transition-demo" aria-hidden="true" viewBox="0 0 160 100">
          <defs>
            <clipPath :id="`${galleryId}-${item.id}-mask`">
              <rect v-if="demos[item.id].visibility <= 0 && demos[item.id].aperture" width="0" height="0" />
              <circle v-else-if="demos[item.id].aperture === 'circle' && demos[item.id].visibility < 1" cx="80" cy="50" :r="Math.hypot(160, 100) / 2 * demos[item.id].visibility" />
              <path v-else-if="demos[item.id].aperture === 'radial' && demos[item.id].visibility < 1" :d="radialPath(item.id)" />
              <path v-else-if="demos[item.id].aperture === 'diagonal' && demos[item.id].visibility < 1" :d="`M0 0H${320 * demos[item.id].visibility}L0 ${200 * demos[item.id].visibility}Z`" />
              <path v-else-if="demos[item.id].aperture === 'diamond' && demos[item.id].visibility < 1" :d="diamondPath(item.id)" />
              <template v-else-if="demos[item.id].aperture === 'blinds' && demos[item.id].visibility < 1"><rect v-for="(strip, index) in transitionBlindRects(demos[item.id].visibility)" :key="index" x="0" :y="strip.y * 100" width="160" :height="strip.height * 100" /></template>
              <rect v-else :x="demos[item.id].mask.x * 160" :y="demos[item.id].mask.y * 100" :width="demos[item.id].mask.width * 160" :height="demos[item.id].mask.height * 100" />
            </clipPath>
            <filter :id="`${galleryId}-${item.id}-soften`" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur :stdDeviation="Math.min(8, (demos[item.id].blur ?? 0) / 5)" /></filter>
            <linearGradient :id="`${galleryId}-${item.id}-backdrop`" x2="1" y2="1"><stop :stop-color="phase >= .5 ? '#38265c' : '#153c57'" /><stop offset="1" :stop-color="phase >= .5 ? '#111b38' : '#101d35'" /></linearGradient>
            <g :id="`${galleryId}-${item.id}-scene`">
              <rect width="160" height="100" :fill="`url(#${galleryId}-${item.id}-backdrop)`" />
              <path d="M0 25H160M0 50H160M0 75H160M40 0V100M80 0V100M120 0V100" stroke="#fff" stroke-opacity=".07" stroke-width=".6" />
              <g :fill="phase >= .5 ? '#c1a1ff' : '#6ee3df'">
                <rect x="75" y="28" width="60" height="43" rx="5" fill-opacity=".2" transform="rotate(-12 105 50)" />
                <rect x="81" y="32" width="54" height="40" rx="4" fill-opacity=".65" />
                <circle cx="104" cy="47" r="8" fill="#fcf6e7" /><path d="M84 68l14-14 9 8 9-12 16 18Z" fill="#101d35" fill-opacity=".55" />
              </g>
              <text x="12" y="21" fill="#d7e3f4" font-size="8" font-family="system-ui" letter-spacing="1">{{ phase >= .5 ? '02 · 画面 B' : '01 · 画面 A' }}</text>
              <path d="M12 67H44M12 72H34" stroke="#d7e3f4" stroke-opacity=".65" stroke-width="2" />
              <path d="M12 87H148" stroke="#d7e3f4" stroke-opacity=".2" /><path d="M12 87H54" :stroke="phase >= .5 ? '#c1a1ff' : '#6ee3df'" />
            </g>
          </defs>
          <rect width="160" height="100" fill="#101827" />
          <g :clip-path="`url(#${galleryId}-${item.id}-mask)`">
            <rect v-if="demos[item.id].color" width="160" height="100" :fill="demos[item.id].color" />
            <g :transform="demoTransform(item.id)" :opacity="demos[item.id].opacity">
              <use :href="`#${galleryId}-${item.id}-scene`" />
              <use v-if="demos[item.id].blur" :href="`#${galleryId}-${item.id}-scene`" :filter="`url(#${galleryId}-${item.id}-soften)`" :opacity="demos[item.id].blurStrength" />
            </g>
          </g>
        </svg>
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
.transition-library{padding:18px;color:var(--ed-text);font-size:12px}.transition-target{display:flex;gap:10px;align-items:center;margin-bottom:15px}.transition-target>svg{color:var(--ed-accent)}.transition-target>div{display:flex;flex-direction:column;gap:4px;min-width:0}.transition-target strong{font-size:13px}.transition-target span{color:var(--ed-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.transition-empty{padding:11px;background:var(--ed-bg);border-radius:8px;line-height:1.7;color:var(--ed-muted)}.transition-collections{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.transition-collections button{display:flex;align-items:center;gap:6px;background:var(--ed-bg);border:1px solid var(--ed-border);border-radius:6px;padding:6px 9px;font:inherit;color:var(--ed-muted);cursor:pointer}.transition-collections button[aria-pressed=true]{border-color:var(--ed-accent);color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 8%,var(--ed-panel))}.transition-collections span{font-size:10px;opacity:.8}.transition-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.transition-grid.focused{grid-template-columns:repeat(4,minmax(0,1fr))}.transition-card{display:flex;flex-direction:column;gap:7px;position:relative;min-width:0;padding:6px;border:1px solid var(--ed-border);border-radius:8px;cursor:pointer;background:var(--ed-panel)}.transition-card.selected{border-color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 7%,var(--ed-panel))}.transition-card:has(input:focus-visible){outline:2px solid var(--ed-accent);outline-offset:2px}.transition-card input{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}.transition-name{display:flex;justify-content:space-between;align-items:center;gap:3px;font-size:11px}.transition-name svg{color:var(--ed-accent)}.transition-demo{display:block;position:relative;overflow:hidden;width:100%;aspect-ratio:1.6;background:#101827;border-radius:5px}.transition-options{display:flex;gap:15px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:17px;font-size:11px}.transition-options label{display:flex;align-items:center;gap:7px}.transition-options input{box-sizing:border-box;width:78px;height:32px;padding:4px 7px;background:var(--ed-bg);border:1px solid var(--ed-border);border-radius:5px;color:var(--ed-text);font:inherit}.transition-options>span,.transition-note{color:var(--ed-muted)}.transition-note{font-size:11px;line-height:1.7;margin:12px 0}.transition-error{color:var(--ui-danger,#bd4141)}footer{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--ed-border);padding-top:13px}footer>span{font-size:11px;color:var(--ed-muted)}footer button{display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:6px;padding:9px 12px;font:inherit;background:var(--ed-accent);color:#fff;white-space:nowrap;cursor:pointer}footer button:disabled{opacity:.45;cursor:default}@media(max-width:600px){.transition-grid,.transition-grid.focused{grid-template-columns:repeat(3,minmax(0,1fr))}.transition-library{padding:12px}}
.transition-tuning{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}.transition-tuning label{display:flex;flex-direction:column;gap:6px;color:var(--ed-muted);font-size:11px}.transition-tuning select,.transition-tuning input{box-sizing:border-box;width:100%;height:32px;padding:5px 7px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-bg);color:var(--ed-text);font:inherit}.transition-tuning input[type=color]{padding:3px}@media(max-width:500px){.transition-tuning{grid-template-columns:1fr 1fr}}
</style>
