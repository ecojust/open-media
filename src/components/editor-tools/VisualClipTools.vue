<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Clip, NormalizedRect } from '../../core/types'
import { clipDuration } from '../../core/timeline'
import { buildFocusAnimation, hasFocusAnimation } from '../../core/focus-region'
import type { EditorToolRunner } from './types'
import { useEditorTool } from './use-editor-tool'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'

const props = defineProps<{ clip: Clip; kind: 'video' | 'image' | 'text' | 'audio' | 'transition'; time: number; run: EditorToolRunner; disabled?: boolean; focusRegion?: NormalizedRect; pickingFocus?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; pickFocus: [] }>()
const task = useEditorTool(() => props.run, busy => emit('busy', busy))
const easingOptions = [{ value: 'linear', label: '匀速' }, { value: 'ease-in', label: '缓入' }, { value: 'ease-out', label: '缓出' }, { value: 'ease-in-out', label: '缓入缓出' }, { value: 'step', label: '阶跃' }]
const property = ref('opacity'), easing = ref('ease-in-out')
const points = ref<{ time: number; value: number; easing?: string }[]>([])
const properties = computed(() => props.kind === 'audio' ? [{ value: 'volume', label: '音量' }] : [{ value: 'x', label: '水平位置' }, { value: 'y', label: '垂直位置' }, { value: 'scaleX', label: '水平缩放' }, { value: 'scaleY', label: '垂直缩放' }, { value: 'opacity', label: '不透明度' }, { value: 'rotation', label: '旋转角度' }])
const limits = computed(() => property.value === 'opacity' ? [0, 1] : property.value === 'volume' ? [0, 2] : property.value.startsWith('scale') ? [.01, 32] : [-65536, 65536])
const area = ref({ x: 0, y: 0, width: 100, height: 100 })
const focusSection = ref<HTMLDetailsElement>(), focusArea = ref<NormalizedRect>({ x: .25, y: .25, width: .5, height: .5 })
const focusStart = ref(0), focusDuration = ref(.6), focusHold = ref(1.5), focusReturn = ref(.6), focusMaxScale = ref(3), focusStrength = ref(100), focusReplace = ref(false)
const focusArgs = computed(() => ({ region: focusArea.value, start: focusStart.value, duration: focusDuration.value, holdDuration: focusHold.value, returnDuration: focusReturn.value, maxScale: focusMaxScale.value, strength: focusStrength.value / 100, easing: easing.value, replaceExisting: focusReplace.value }))
const focusConflict = computed(() => hasFocusAnimation(props.clip))
const focusIssue = computed(() => { try { buildFocusAnimation(props.clip, focusArgs.value); return '' } catch (error) { return error instanceof Error ? error.message : String(error) } })
const freezeTime = ref(props.clip.trimIn), freezeDuration = ref(2)
const ramp = ref([{ position: 0, speed: 1 }, { position: .5, speed: 2 }, { position: 1, speed: 1 }]), preservePitch = ref(true)
const direction = ref('left'), transitionColor = ref('#000000'), blur = ref(0), scope = ref('both')
const blocked = computed(() => props.disabled || task.busy.value)
function readPoints(): void {
  const clip = props.clip as unknown as Record<string, unknown>
  const all = clip.keyframes as Record<string, typeof points.value> | undefined
  points.value = (all?.[property.value] ?? []).map(point => ({ ...point, easing: point.easing || 'linear' }))
}
function reset(): void {
  if (props.kind === 'audio') property.value = 'volume'
  const clip = props.clip as unknown as Record<string, unknown>
  const crop = clip.crop as typeof area.value | undefined
  area.value = crop ? { x: crop.x * 100, y: crop.y * 100, width: crop.width * 100, height: crop.height * 100 } : { x: 0, y: 0, width: 100, height: 100 }
  freezeTime.value = props.clip.trimIn
  if (props.clip.freezeFrame) freezeTime.value = props.clip.freezeFrame.sourceTime
  freezeDuration.value = props.clip.freezeFrame ? clipDuration(props.clip) : 2
  ramp.value = props.clip.speedRamp?.points.map(point => ({ ...point })) ?? [{ position: 0, speed: 1 }, { position: .5, speed: 2 }, { position: 1, speed: 1 }]
  preservePitch.value = props.clip.speedRamp?.preservePitch ?? true
  if (props.clip.transition) { direction.value = props.clip.transition.direction || 'left'; transitionColor.value = props.clip.transition.color || '#000000'; blur.value = props.clip.transition.blur || 0; scope.value = props.clip.transition.scope || 'both'; easing.value = props.clip.transition.easing || 'linear' }
  else easing.value = props.clip.speedRamp?.easing || 'ease-in-out'
  readPoints()
}
function addPoint(): void {
  if (blocked.value || points.value.length >= 128) return
  const time = Math.max(0, Math.min(clipDuration(props.clip), props.time - props.clip.start))
  const value = property.value.startsWith('scale') ? 1 : Number((props.clip as unknown as Record<string, unknown>)[property.value] ?? 0)
  const old = points.value.find(point => Math.abs(point.time - time) < .001)
  if (old) { old.value = value; old.easing = easing.value }
  else points.value.push({ time: Number(time.toFixed(3)), value, easing: easing.value })
  points.value.sort((a, b) => a.time - b.time)
}
async function run(name: string, args: Record<string, unknown>, notice: string): Promise<unknown> { const result = await task.execute(`open_media_${name}`, { clipId: props.clip.id, ...args }, notice); if (result !== undefined) { await nextTick(); reset() }; return result }
function normalizedArea(): Record<string, number> { return Object.fromEntries(Object.entries(area.value).map(([key, value]) => [key, Number(value) / 100])) }
function focusFromPlayhead(): void {
  const available = Math.max(.01, clipDuration(props.clip))
  focusStart.value = Math.max(0, Math.min(available - .01, props.time - props.clip.start))
  const remaining = available - focusStart.value, total = focusDuration.value + focusHold.value + focusReturn.value
  if (total > remaining) {
    focusDuration.value = Math.min(.6, Math.max(.01, remaining / 4))
    focusReturn.value = Math.min(.6, Math.max(0, (remaining - focusDuration.value) / 3))
    focusHold.value = Math.max(0, remaining - focusDuration.value - focusReturn.value)
  }
}
focusFromPlayhead()
watch(() => props.focusRegion, value => { if (value) { focusArea.value = { ...value }; focusFromPlayhead(); if (focusSection.value) focusSection.value.open = true } })
watch(() => props.clip, () => { if (!task.busy.value) reset() }, { immediate: true })
watch(property, readPoints)
</script>
<template>
  <section class="et-panel et-inline" data-testid="visual-clip-tools">
    <template v-if="kind === 'transition'">
      <details class="et-section"><summary>转场参数</summary><fieldset :disabled="blocked"><label class="et-field">运动方向<select v-model="direction" aria-label="转场运动方向"><option value="left">向左</option><option value="right">向右</option><option value="up">向上</option><option value="down">向下</option></select></label><label class="et-field">缓动<select v-model="easing" aria-label="转场缓动"><option v-for="item in easingOptions" :key="item.value" :value="item.value">{{ item.label }}</option></select></label><div class="et-grid"><label class="et-field">过渡颜色<input v-model="transitionColor" type="color" aria-label="转场颜色" /></label><label class="et-field">模糊半径<input v-model.number="blur" type="number" min="0" max="50" aria-label="转场模糊半径" /></label></div><label class="et-field">作用范围<select v-model="scope" aria-label="转场作用范围"><option value="both">前后两侧</option><option value="outgoing">仅前段结束</option><option value="incoming">仅后段开始</option></select></label><div class="et-actions"><button class="et-primary" @click="run('transition_parameters_set', { direction, easing, color: transitionColor, blur, scope }, '转场参数已更新')">应用参数</button><button @click="run('transition_parameters_set', { clear: true }, '转场参数已恢复')">恢复默认</button></div></fieldset></details>
    </template>
    <template v-else>
      <details class="et-section"><summary>动画关键帧</summary><fieldset :disabled="blocked"><label class="et-field">动画属性<select v-model="property" aria-label="关键帧属性"><option v-for="item in properties" :key="item.value" :value="item.value">{{ item.label }}</option></select></label><div class="keyframe-list"><div v-for="(point, index) in points" :key="index" class="keyframe-point"><div class="et-grid"><label class="et-field">时间 / 秒<input v-model.number="point.time" type="number" min="0" :max="clipDuration(clip)" step=".01" :aria-label="`关键帧 ${index + 1} 时间`" /></label><label class="et-field">数值<input v-model.number="point.value" type="number" :min="limits[0]" :max="limits[1]" step=".01" :aria-label="`关键帧 ${index + 1} 数值`" /></label></div><div class="keyframe-row"><select v-model="point.easing" :aria-label="`关键帧 ${index + 1} 缓动`"><option v-for="item in easingOptions" :key="item.value" :value="item.value">{{ item.label }}</option></select><button :aria-label="`删除关键帧 ${index + 1}`" @click="points.splice(index, 1)"><Icon name="trash" :size="13" /></button></div></div></div><p v-if="!points.length" class="et-note">在当前播放位置添加关键帧，然后调整时间和数值。</p><div class="et-actions"><button :disabled="points.length >= 128" @click="addPoint"><Icon name="plus" :size="13" />当前帧</button><button class="et-primary" :disabled="!points.length" @click="run('clip_keyframes_set', { keyframes: { [property]: points } }, '关键帧已应用')">应用</button><button @click="run('clip_keyframes_set', { clear: true }, '动画关键帧已清除')">清除动画</button></div></fieldset></details>
      <details v-if="kind === 'video' || kind === 'image'" class="et-section"><summary>源画面裁切</summary><fieldset :disabled="blocked"><div class="et-grid"><label v-for="(label, key) in { x: '左边距', y: '上边距', width: '宽度', height: '高度' }" :key="key" class="et-field">{{ label }} / %<input v-model.number="area[key]" type="number" min="0" max="100" step="1" :aria-label="`源画面${label}`" /></label></div><div class="et-actions"><button class="et-primary" @click="run('clip_crop', { crop: normalizedArea() }, '源画面裁切已应用')">应用裁切</button><button @click="run('clip_crop', { clear: true }, '源画面裁切已清除')">清除裁切</button></div></fieldset></details>
      <details v-if="kind === 'video' || kind === 'image'" ref="focusSection" class="et-section" data-focus-settings><summary>重点区域放大</summary><fieldset :disabled="blocked">
        <button class="et-primary" :disabled="pickingFocus" @click="emit('pickFocus')"><Icon name="zoom-in" :size="13" />{{ pickingFocus ? '正在预览中框选…' : '在预览中框选' }}</button>
        <p class="et-note">等比放大重点、停留后恢复原画面；保留原片段尺寸和裁切。区域以当前显示框为准。</p>
        <div class="et-grid"><label v-for="(label, key) in { x: '左边距', y: '上边距', width: '宽度', height: '高度' }" :key="key" class="et-field">{{ label }} / %<input :value="Number((focusArea[key] * 100).toFixed(2))" type="number" :min="key === 'width' || key === 'height' ? .1 : 0" max="100" step=".1" :aria-label="`聚焦区域${label}`" @input="focusArea[key] = Number(($event.target as HTMLInputElement).value) / 100" /></label></div>
        <div class="et-grid"><label class="et-field">起点 / 秒<input v-model.number="focusStart" type="number" min="0" :max="clipDuration(clip)" step=".1" aria-label="聚焦开始时间" /></label><label class="et-field">放大 / 秒<input v-model.number="focusDuration" type="number" min=".01" :max="clipDuration(clip)" step=".1" aria-label="聚焦放大时长" /></label><label class="et-field">停留 / 秒<input v-model.number="focusHold" type="number" min="0" :max="clipDuration(clip)" step=".1" aria-label="聚焦停留时长" /></label><label class="et-field">恢复 / 秒<input v-model.number="focusReturn" type="number" min="0" :max="clipDuration(clip)" step=".1" aria-label="聚焦恢复时长" /></label><label class="et-field">最大倍数<input v-model.number="focusMaxScale" type="number" min="1" max="16" step=".1" aria-label="聚焦最大倍数" /></label><label class="et-field">强度 / %<input v-model.number="focusStrength" type="number" min="5" max="100" step="5" aria-label="聚焦强度" /></label></div>
        <label class="et-field">缓动<select v-model="easing" aria-label="聚焦缓动"><option v-for="item in easingOptions.filter(item => item.value !== 'step')" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
        <label v-if="focusConflict" class="et-check"><input v-model="focusReplace" type="checkbox" />替换此片段已有的位置与缩放动画</label>
        <p v-if="focusIssue" class="et-note" role="status">{{ focusIssue }}</p>
        <div class="et-actions"><button @click="focusFromPlayhead">起点使用播放头</button><button class="et-primary" :disabled="!!focusIssue || pickingFocus" @click="run('focus_region', focusArgs, '重点区域放大动画已应用，可直接播放预览')"><Icon name="zoom-in" :size="13" />应用聚焦</button></div>
      </fieldset></details>
      <details v-if="kind === 'video'" class="et-section"><summary>定格画面</summary><fieldset :disabled="blocked"><div class="et-grid"><label class="et-field">源视频时间 / 秒<input v-model.number="freezeTime" type="number" min="0" step=".1" aria-label="定格源画面时间" /></label><label class="et-field">定格时长 / 秒<input v-model.number="freezeDuration" type="number" min=".01" step=".1" aria-label="定格时长" /></label></div><div class="et-actions"><button class="et-primary" @click="run('clip_freeze_frame', { sourceTime: freezeTime, duration: freezeDuration }, '定格画面已应用')">应用定格</button><button @click="run('clip_freeze_frame', { clear: true }, '已恢复原始视频片段')">恢复视频</button></div></fieldset></details>
      <details v-if="kind === 'video' || kind === 'audio'" class="et-section"><summary>变速曲线</summary><fieldset :disabled="blocked"><div v-for="(point, index) in ramp" :key="index" class="et-grid"><label class="et-field">源位置 / %<input :value="point.position * 100" type="number" min="0" max="100" :disabled="index === 0 || index === ramp.length - 1" :aria-label="`变速节点 ${index + 1} 位置`" @input="point.position = Number(($event.target as HTMLInputElement).value) / 100" /></label><label class="et-field">速度倍数<input v-model.number="point.speed" type="number" min=".1" max="16" step=".1" :aria-label="`变速节点 ${index + 1} 速度`" /></label></div><label class="et-field">曲线缓动<select v-model="easing" aria-label="变速缓动"><option v-for="item in easingOptions" :key="item.value" :value="item.value">{{ item.label }}</option></select></label><label class="et-check"><input v-model="preservePitch" type="checkbox" />保持音调</label><div class="et-actions"><button class="et-primary" @click="run('clip_speed_ramp', { points: ramp, easing, preservePitch }, '变速曲线已应用')">应用曲线</button><button @click="run('clip_speed_ramp', { clear: true }, '变速曲线已清除')">恢复匀速</button></div></fieldset></details>
    </template>
    <EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
  </section>
</template>
<style src="./editor-tools.css"></style>
<style scoped>
.keyframe-list{max-height:240px;overflow:auto}.keyframe-point{padding:8px 0;border-bottom:1px solid var(--ed-border)}.keyframe-row{display:flex;gap:6px;align-items:center}.keyframe-row select{flex:1;min-width:0}.keyframe-row button{flex:none}.keyframe-point .et-field{margin-bottom:6px}
</style>
