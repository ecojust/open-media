<script setup lang="ts">
import { computed, useId } from 'vue'
import { fragmentTransitionPlan, isFragmentEffect } from '../core/fragment-transitions'
import { transitionBlindRects, transitionVisualForParameters, type TransitionParameters } from '../core/transitions'
import type { TransitionEffect } from '../core/types'

const props = defineProps<{ effect: TransitionEffect; phase: number; parameters: TransitionParameters; active: boolean }>()
const id = `transition-preview-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const incoming = computed(() => props.phase >= .5)
const visual = computed(() => {
  const p = props.phase
  const excluded = (props.parameters.scope === 'incoming' && p < .5) || (props.parameters.scope === 'outgoing' && p >= .5)
  const visibility = excluded || p < .2 || p > .8 ? 1 : p < .5 ? (.5 - p) / .3 : (p - .5) / .3
  return transitionVisualForParameters(props.effect, visibility, props.parameters)
})
const fragment = computed(() => isFragmentEffect(props.effect) ? fragmentTransitionPlan(props.effect, visual.value.visibility, 160, 100) : undefined)
const transform = computed(() => `translate(${visual.value.translateX * 160} ${visual.value.translateY * 100}) translate(80 50) scale(${visual.value.scale}) translate(-80 -50)`)
const diamond = computed(() => {
  const v = visual.value.visibility
  return `M80 ${50 - 100 * v} L${80 + 160 * v} 50 L80 ${50 + 100 * v} L${80 - 160 * v} 50Z`
})
const radial = computed(() => {
  const v = visual.value.visibility, r = Math.hypot(160, 100) / 2, angle = 2 * Math.PI * v
  return `M80 50 L80 ${50 - r} A${r} ${r} 0 ${v > .5 ? 1 : 0} 1 ${80 + r * Math.sin(angle)} ${50 - r * Math.cos(angle)}Z`
})
</script>

<template>
  <svg class="transition-demo" aria-hidden="true" viewBox="0 0 160 100" :data-effect="effect" :data-animated="active" :data-visibility="visual.visibility">
    <defs>
      <clipPath :id="`${id}-bounds`"><rect width="160" height="100" /></clipPath>
      <clipPath :id="`${id}-mask`">
        <rect v-if="visual.visibility <= 0 && visual.aperture" width="0" height="0" />
        <circle v-else-if="visual.aperture === 'circle' && visual.visibility < 1" cx="80" cy="50" :r="Math.hypot(160, 100) / 2 * visual.visibility" />
        <path v-else-if="visual.aperture === 'radial' && visual.visibility < 1" :d="radial" />
        <path v-else-if="visual.aperture === 'diagonal' && visual.visibility < 1" :d="`M0 0H${320 * visual.visibility}L0 ${200 * visual.visibility}Z`" />
        <path v-else-if="visual.aperture === 'diamond' && visual.visibility < 1" :d="diamond" />
        <template v-else-if="visual.aperture === 'blinds' && visual.visibility < 1"><rect v-for="(strip, index) in transitionBlindRects(visual.visibility)" :key="index" x="0" :y="strip.y * 100" width="160" :height="strip.height * 100" /></template>
        <rect v-else :x="visual.mask.x * 160" :y="visual.mask.y * 100" :width="visual.mask.width * 160" :height="visual.mask.height * 100" />
      </clipPath>
      <filter :id="`${id}-soften`" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur :stdDeviation="Math.min(8, (visual.blur ?? 0) / 5)" /></filter>
      <linearGradient :id="`${id}-backdrop`" x2="1" y2="1"><stop :stop-color="incoming ? '#9b61dc' : '#268faf'" /><stop offset="1" :stop-color="incoming ? '#4e6acb' : '#3a57b2'" /></linearGradient>
      <g :id="`${id}-scene`">
        <rect width="160" height="100" :fill="`url(#${id}-backdrop)`" />
        <path d="M0 25H160M0 50H160M0 75H160M40 0V100M80 0V100M120 0V100" stroke="#fff" stroke-opacity=".12" stroke-width=".6" />
        <g :fill="incoming ? '#c1a1ff' : '#6ee3df'">
          <rect x="75" y="28" width="60" height="43" rx="5" fill-opacity=".2" transform="rotate(-12 105 50)" />
          <rect x="81" y="32" width="54" height="40" rx="4" fill-opacity=".65" />
          <circle cx="104" cy="47" r="8" fill="#fcf6e7" /><path d="M84 68l14-14 9 8 9-12 16 18Z" fill="#101d35" fill-opacity=".55" />
        </g>
        <text x="12" y="21" fill="#d7e3f4" font-size="8" font-family="system-ui" letter-spacing="1">{{ incoming ? '02 · 画面 B' : '01 · 画面 A' }}</text>
        <path d="M12 67H44M12 72H34" stroke="#d7e3f4" stroke-opacity=".65" stroke-width="2" />
        <path d="M12 87H148" stroke="#d7e3f4" stroke-opacity=".2" /><path d="M12 87H54" :stroke="incoming ? '#c1a1ff' : '#6ee3df'" />
      </g>
      <g :id="`${id}-composite`">
        <use :href="`#${id}-scene`" />
        <use v-if="visual.blur" :href="`#${id}-scene`" :filter="`url(#${id}-soften)`" :opacity="visual.blurStrength" />
      </g>
    </defs>
    <rect width="160" height="100" fill="#101827" />
    <g v-if="fragment" :clip-path="`url(#${id}-bounds)`">
      <rect v-if="visual.color" width="160" height="100" :fill="visual.color" />
      <use v-if="fragment.visibility >= 1" :href="`#${id}-composite`" />
      <g v-else-if="fragment.visibility > 0" :transform="`rotate(${fragment.rotation * 180 / Math.PI} 80 50)`" data-fragment-plan>
        <g v-for="(piece, index) in fragment.pieces" :key="index" :opacity="piece.opacity" :transform="`translate(${piece.center.x} ${piece.center.y}) rotate(${piece.rotation * 180 / Math.PI}) scale(${piece.scaleX} ${piece.scaleY})`">
          <svg :x="-piece.sourceRect.width / 2" :y="-piece.sourceRect.height / 2" :width="piece.sourceRect.width" :height="piece.sourceRect.height" :viewBox="`${piece.sourceRect.x} ${piece.sourceRect.y} ${piece.sourceRect.width} ${piece.sourceRect.height}`" overflow="hidden">
            <use :href="`#${id}-composite`" />
          </svg>
        </g>
      </g>
    </g>
    <g v-else :clip-path="`url(#${id}-mask)`">
      <rect v-if="visual.color" width="160" height="100" :fill="visual.color" />
      <g :transform="transform" :opacity="visual.opacity"><use :href="`#${id}-composite`" /></g>
    </g>
  </svg>
</template>

<style scoped>
.transition-demo{display:block;position:relative;overflow:hidden;width:100%;aspect-ratio:1.6;background:#101827;border-radius:5px}
</style>
