<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TRANSITION_PRESETS, TRANSITION_COLLECTIONS, type TransitionCut, type TransitionParameters } from '../core/transitions'
import { TRANSITION_SOUNDS, type TransitionSoundItem } from '../core/transition-sound-catalog'
import type { TransitionEffect } from '../core/types'
import Icon from './Icon.vue'
import TransitionPreview from './TransitionPreview.vue'

const props = defineProps<{ cut?: TransitionCut; soundCut?: TransitionCut; fps: number; fromName?: string; toName?: string; error?: string; soundError?: string; busy?: boolean }>()
const emit = defineEmits<{ select: [effect: TransitionEffect, duration: number, parameters: TransitionParameters]; 'select-sound': [item: TransitionSoundItem] }>()
const tab = ref<'picture' | 'sound'>('picture')
const selectedSoundId = ref(''), previewSoundId = ref(''), soundLoading = ref(false), soundPlaying = ref(false), previewError = ref('')
const selectedSound = computed(() => TRANSITION_SOUNDS.find(item => item.id === selectedSoundId.value))
let audio: HTMLAudioElement | undefined, soundGeneration = 0
function stopSound(): void {
  soundGeneration++
  previewSoundId.value = ''; soundLoading.value = false; soundPlaying.value = false
  if (!audio) return
  audio.onended = null; audio.onerror = null
  audio.pause(); audio.removeAttribute('src'); audio.load(); audio = undefined
}
async function previewSound(item: TransitionSoundItem): Promise<void> {
  if (props.busy) return
  const wasPlaying = previewSoundId.value === item.id
  stopSound(); previewError.value = ''
  if (wasPlaying) return
  const token = soundGeneration, media = new Audio(item.url)
  audio = media; media.volume = 0.7
  previewSoundId.value = item.id; soundLoading.value = true
  const fail = () => { if (token === soundGeneration) { stopSound(); previewError.value = `“${item.title}”暂时无法试听，请重试。` } }
  media.onerror = fail
  media.onended = () => { if (token === soundGeneration) stopSound() }
  try {
    await media.play()
    if (token !== soundGeneration) { media.pause(); return }
    soundLoading.value = false; soundPlaying.value = true
  } catch { fail() }
}
function addSound(): void {
  if (!selectedSound.value || !props.soundCut || props.busy) return
  stopSound(); previewError.value = ''
  emit('select-sound', selectedSound.value)
}
watch(tab, stopSound)
watch(selectedSoundId, () => { stopSound(); previewError.value = '' })
watch(() => props.busy, value => { if (value) stopSound() })
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
const animatedEffect = computed(() => tab.value !== 'picture' || reducedMotion.value || !pageVisible.value ? undefined : hovered.value ?? focused.value ?? selected.value)
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
function updateVisibility(): void { pageVisible.value = !document.hidden; if (document.hidden) stopSound() }
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
  stopSound()
  cancelAnimationFrame(animation)
  motionQuery?.removeEventListener('change', updateMotion)
  document.removeEventListener('visibilitychange', updateVisibility)
})
</script>

<template>
  <section class="transition-library" data-testid="transition-library">
    <div class="transition-tabs" role="tablist" aria-label="转场类型">
      <button id="picture-transition-tab" type="button" role="tab" :aria-selected="tab === 'picture'" aria-controls="picture-transition-panel" :disabled="busy" @click="tab = 'picture'"><Icon name="transition" :size="15" />画面转场</button>
      <button id="sound-transition-tab" type="button" role="tab" :aria-selected="tab === 'sound'" aria-controls="sound-transition-panel" :disabled="busy" data-testid="transition-sound-tab" @click="tab = 'sound'"><Icon name="audio" :size="15" />转场音效 <span>{{ TRANSITION_SOUNDS.length }}</span></button>
    </div>
    <div v-if="tab === 'picture'" id="picture-transition-panel" role="tabpanel" aria-labelledby="picture-transition-tab">
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
    <footer><span>{{ TRANSITION_PRESETS.find(item => item.id === selected)?.description }}</span><button type="button" data-testid="transition-apply" :disabled="busy || !cut || !Number.isFinite(Number(length)) || Number(length) <= 0" @click="emit('select', selected, actualLength, parameters)"><Icon name="plus" :size="15" />应用转场</button></footer>
    </div>
    <div v-else id="sound-transition-panel" role="tabpanel" aria-labelledby="sound-transition-tab" :aria-busy="busy">
      <div v-if="soundCut" class="transition-target"><Icon name="scissors" :size="17" /><div><strong>重音对齐切点 {{ soundCut.time.toFixed(2) }} 秒</strong><span>优先选中转场，否则使用离播放头最近的视频切点</span></div></div>
      <p v-else class="transition-empty" role="status">先分割视频或将两个视频片段首尾接拢，即可添加转场音效。现在可以试听。</p>
      <p class="transition-preview-note">10 种原创短音效 · 离线可用 · 可单独配合视频切点使用</p>
      <div class="sound-grid" role="group" aria-label="选择转场音效">
        <article v-for="item in TRANSITION_SOUNDS" :key="item.id" class="sound-card" :class="{ selected: selectedSoundId === item.id }" data-testid="transition-sound-item" :data-sound-id="item.id">
          <label class="sound-choice"><input v-model="selectedSoundId" type="radio" name="transition-sound" :value="item.id" :disabled="busy" :aria-label="`选择 ${item.title}`" /><span class="sound-art" aria-hidden="true"><Icon name="audio" :size="22" /></span><span class="sound-detail"><strong>{{ item.title }}<Icon v-if="selectedSoundId === item.id" name="check" :size="12" /></strong><span>{{ item.description }}</span><small>{{ item.duration.toFixed(2) }} 秒</small></span></label>
          <button type="button" class="sound-preview" :disabled="busy" :aria-label="`${previewSoundId === item.id ? '停止试听' : '试听'} ${item.title}`" :aria-pressed="previewSoundId === item.id" :data-sound-preview="item.id" @click="previewSound(item)"><Icon :name="previewSoundId === item.id && soundLoading ? 'clock' : previewSoundId === item.id && soundPlaying ? 'stop' : 'play'" :size="16" /></button>
        </article>
      </div>
      <p class="transition-note">加入独立“转场音效”轨道，可继续移动、裁剪和调整音量；超出项目首尾的部分会裁掉。</p>
      <p v-if="soundError || previewError" class="transition-error" role="alert" data-testid="transition-sound-error">{{ soundError || previewError }}</p>
      <footer><span>{{ selectedSound ? `已选择：${selectedSound.title}` : '选择音效，可先点击播放试听' }}</span><button type="button" data-testid="transition-sound-add" :disabled="busy || !soundCut || !selectedSound" @click="addSound"><Icon :name="busy ? 'clock' : 'plus'" :size="15" />{{ busy ? '正在添加…' : '添加转场音效' }}</button></footer>
    </div>
  </section>
</template>

<style scoped>
.transition-library{padding:18px;color:var(--ed-text);font-size:12px}.transition-target{display:flex;gap:10px;align-items:center;margin-bottom:15px}.transition-target>svg{color:var(--ed-accent)}.transition-target>div{display:flex;flex-direction:column;gap:4px;min-width:0}.transition-target strong{font-size:13px}.transition-target span{color:var(--ed-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.transition-empty{padding:11px;background:var(--ed-bg);border-radius:8px;line-height:1.7;color:var(--ed-muted)}.transition-collections{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.transition-collections button{display:flex;align-items:center;gap:6px;background:var(--ed-bg);border:1px solid var(--ed-border);border-radius:6px;padding:6px 9px;font:inherit;color:var(--ed-muted);cursor:pointer}.transition-collections button[aria-pressed=true]{border-color:var(--ed-accent);color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 8%,var(--ed-panel))}.transition-collections span{font-size:10px;opacity:.8}.transition-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.transition-grid.focused{grid-template-columns:repeat(4,minmax(0,1fr))}.transition-card{display:flex;flex-direction:column;gap:7px;position:relative;min-width:0;padding:6px;border:1px solid var(--ed-border);border-radius:8px;cursor:pointer;background:var(--ed-panel)}.transition-card.selected{border-color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 7%,var(--ed-panel))}.transition-card:has(input:focus-visible){outline:2px solid var(--ed-accent);outline-offset:2px}.transition-card input{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}.transition-name{display:flex;justify-content:space-between;align-items:center;gap:3px;font-size:11px}.transition-name svg{color:var(--ed-accent)}.transition-preview-note{margin:0 0 10px;color:var(--ed-muted);font-size:10px;line-height:1.6}.transition-options{display:flex;gap:15px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:17px;font-size:11px}.transition-options label{display:flex;align-items:center;gap:7px}.transition-options input{box-sizing:border-box;width:78px;height:32px;padding:4px 7px;background:var(--ed-bg);border:1px solid var(--ed-border);border-radius:5px;color:var(--ed-text);font:inherit}.transition-options>span,.transition-note{color:var(--ed-muted)}.transition-note{font-size:11px;line-height:1.7;margin:12px 0}.transition-error{color:var(--ui-danger,#bd4141)}footer{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--ed-border);padding-top:13px}footer>span{font-size:11px;color:var(--ed-muted)}footer button{display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:6px;padding:9px 12px;font:inherit;background:var(--ed-accent);color:#fff;white-space:nowrap;cursor:pointer}footer button:disabled{opacity:.45;cursor:default}@media(max-width:600px){.transition-grid,.transition-grid.focused{grid-template-columns:repeat(3,minmax(0,1fr))}.transition-library{padding:12px}}
.transition-tuning{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}.transition-tuning label{display:flex;flex-direction:column;gap:6px;color:var(--ed-muted);font-size:11px}.transition-tuning select,.transition-tuning input{box-sizing:border-box;width:100%;height:32px;padding:5px 7px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-bg);color:var(--ed-text);font:inherit}.transition-tuning input[type=color]{padding:3px}@media(max-width:500px){.transition-tuning{grid-template-columns:1fr 1fr}}
.transition-tabs{display:flex;gap:6px;margin-bottom:17px;padding-bottom:12px;border-bottom:1px solid var(--ed-border)}.transition-tabs button{display:flex;align-items:center;gap:7px;border:1px solid transparent;background:var(--ed-bg);color:var(--ed-muted);border-radius:7px;padding:8px 12px;font:inherit;cursor:pointer}.transition-tabs button[aria-selected=true]{border-color:var(--ed-accent);color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 8%,var(--ed-panel))}.transition-tabs button>span{font-size:10px}.sound-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;max-height:min(430px,calc(100dvh - 340px));overflow:auto;padding:2px}.sound-card{display:flex;align-items:center;min-width:0;border:1px solid var(--ed-border);border-radius:9px;background:var(--ed-panel)}.sound-card.selected{border-color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 6%,var(--ed-panel))}.sound-choice{display:flex;align-items:center;gap:9px;padding:10px 4px 10px 10px;min-width:0;flex:1;cursor:pointer}.sound-choice input{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}.sound-card:has(input:focus-visible){outline:2px solid var(--ed-accent);outline-offset:1px}.sound-art{width:34px;height:40px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:7px;color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 10%,var(--ed-bg))}.sound-detail{display:flex;flex-direction:column;gap:4px;min-width:0}.sound-detail strong{display:flex;align-items:center;gap:7px;font-weight:600;font-size:12px}.sound-detail>span{font-size:10px;color:var(--ed-muted);line-height:1.5}.sound-detail small{font-size:10px;color:var(--ed-muted);font-variant-numeric:tabular-nums}.sound-preview{display:flex;align-items:center;justify-content:center;width:29px;height:29px;flex-shrink:0;margin:0 8px;padding:0;background:var(--ed-bg);border:1px solid var(--ed-border);border-radius:50%;color:var(--ed-muted);cursor:pointer}.sound-preview[aria-pressed=true]{color:var(--ed-accent);border-color:var(--ed-accent)}.sound-preview:disabled,.transition-tabs button:disabled{opacity:.45;cursor:default}@media(max-width:500px){.sound-grid{grid-template-columns:minmax(0,1fr)}.transition-tabs button{padding:7px 9px}}
</style>
