<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { TRANSITION_PRESETS, transitionVisual, type TransitionCut } from '../core/transitions'
import type { TransitionEffect } from '../core/types'
import Icon from './Icon.vue'

const props = defineProps<{ cut?: TransitionCut; fps: number; fromName?: string; toName?: string; error?: string }>()
const emit = defineEmits<{ select: [effect: TransitionEffect, duration: number] }>()
const selected = ref<TransitionEffect>('fade'), length = ref(1), phase = ref(0)
const minimum = computed(() => 2 / props.fps)
const actualLength = computed(() => props.cut ? Math.max(minimum.value, Math.min(Number(length.value) || minimum.value, props.cut.maxDuration)) : 0)
let animation = 0, origin = 0
function tick(time: number): void {
  origin ||= time
  phase.value = ((time - origin) % 3200) / 3200
  animation = requestAnimationFrame(tick)
}
function demo(effect: TransitionEffect): Record<string, string | number> {
  const p = phase.value, v = p < .2 || p > .8 ? 1 : p < .5 ? (.5 - p) / .3 : (p - .5) / .3
  const visual = transitionVisual(effect, v), mask = visual.mask
  return { opacity: visual.opacity, clipPath: `inset(${mask.y * 100}% ${(1 - mask.x - mask.width) * 100}% ${(1 - mask.y - mask.height) * 100}% ${mask.x * 100}%)`, transform: `translateX(${visual.translateX * 100}%) scale(${visual.scale})` }
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
    <div class="transition-grid" role="radiogroup" aria-label="转场效果">
      <label v-for="item in TRANSITION_PRESETS" :key="item.id" class="transition-card" :class="{ selected: selected === item.id }" :title="item.description">
        <input v-model="selected" type="radio" name="transition-effect" :value="item.id" :aria-label="item.name" />
        <span class="transition-demo" aria-hidden="true"><span class="demo-scene" :class="{ second: phase >= .5 }" :style="demo(item.id)"><i /><b /><em /></span></span>
        <span class="transition-name">{{ item.name }}<Icon v-if="selected === item.id" name="check" :size="13" /></span>
      </label>
    </div>
    <div class="transition-options"><label>转场时长<input v-model.number="length" type="number" :min="minimum" :max="cut?.maxDuration || 30" step="0.1" aria-label="转场时长" /><span>秒</span></label><span v-if="cut">前后各 {{ (actualLength / 2).toFixed(2) }} 秒<span v-if="Number(length) > cut.maxDuration">（已适应片段长度）</span></span></div>
    <p class="transition-note">根据播放头寻找最近切点，优先使用选中的视频轨道。效果加入转场轨道，可继续更换或删除；项目时长保持不变。</p>
    <p v-if="error" class="transition-error" role="alert">{{ error }}</p>
    <footer><span>{{ TRANSITION_PRESETS.find(item => item.id === selected)?.description }}</span><button type="button" data-testid="transition-apply" :disabled="!cut || !Number.isFinite(Number(length)) || Number(length) <= 0" @click="emit('select', selected, actualLength)"><Icon name="plus" :size="15" />应用转场</button></footer>
  </section>
</template>

<style scoped>
.transition-library{padding:18px;color:var(--ed-text);font-size:12px}.transition-target{display:flex;gap:10px;align-items:center;margin-bottom:15px}.transition-target>svg{color:var(--ed-accent)}.transition-target>div{display:flex;flex-direction:column;gap:4px;min-width:0}.transition-target strong{font-size:13px}.transition-target span{color:var(--ed-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.transition-empty{padding:11px;background:var(--ed-bg);border-radius:8px;line-height:1.7;color:var(--ed-muted)}.transition-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.transition-card{display:flex;flex-direction:column;gap:7px;position:relative;min-width:0;padding:6px;border:1px solid var(--ed-border);border-radius:8px;cursor:pointer;background:var(--ed-panel)}.transition-card.selected{border-color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 7%,var(--ed-panel))}.transition-card:has(input:focus-visible){outline:2px solid var(--ed-accent);outline-offset:2px}.transition-card input{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}.transition-name{display:flex;justify-content:space-between;align-items:center;gap:3px;font-size:11px}.transition-name svg{color:var(--ed-accent)}.transition-demo{display:block;position:relative;overflow:hidden;aspect-ratio:1.55;background:#151e31;border-radius:5px}.demo-scene{position:absolute;inset:0;background:linear-gradient(145deg,#c1cde9,#728db9);overflow:hidden}.demo-scene.second{background:linear-gradient(145deg,#f7d5a7,#cba686)}.demo-scene i{position:absolute;width:23%;aspect-ratio:1;right:15%;top:17%;background:#f8f0d6;border-radius:50%}.demo-scene b,.demo-scene em{position:absolute;width:90%;height:100%;background:#4c727b;transform:rotate(40deg);left:-13%;top:49%;border-radius:13%}.demo-scene em{background:#365465;left:38%;top:66%}.demo-scene.second b{background:#b77f75}.demo-scene.second em{background:#805f79}.transition-options{display:flex;gap:15px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:17px;font-size:11px}.transition-options label{display:flex;align-items:center;gap:7px}.transition-options input{box-sizing:border-box;width:78px;height:32px;padding:4px 7px;background:var(--ed-bg);border:1px solid var(--ed-border);border-radius:5px;color:var(--ed-text);font:inherit}.transition-options>span,.transition-note{color:var(--ed-muted)}.transition-note{font-size:11px;line-height:1.7;margin:12px 0}.transition-error{color:var(--ui-danger,#bd4141)}footer{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--ed-border);padding-top:13px}footer>span{font-size:11px;color:var(--ed-muted)}footer button{display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:6px;padding:9px 12px;font:inherit;background:var(--ed-accent);color:#fff;white-space:nowrap;cursor:pointer}footer button:disabled{opacity:.45;cursor:default}@media(max-width:600px){.transition-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.transition-library{padding:12px}}
</style>
