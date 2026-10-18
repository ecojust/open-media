<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { ClipOverlay, Project } from '../../core/types'
import { createTextClip } from '../../core/project'
import { drawClipOverlay, OVERLAY_PRESETS } from '../../core/visual-animation'
import { VISUAL_MOTION_PRESETS, type VisualMotionPreset } from '../../core/visual-motion-presets'
import { titleBoundsForPreset, type TitlePreset } from '../../core/visual-tools'
import type { EditorToolRunner } from './types'
import { useEditorTool } from './use-editor-tool'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'
const props = defineProps<{ project: Project; time: number; run: EditorToolRunner; selectedClipId?: string }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const task = useEditorTool(() => props.run, busy => emit('busy', busy))
const tab = ref<'overlay' | 'title' | 'customize'>('overlay'), kind = ref<ClipOverlay['kind']>('arrow'), preset = ref<TitlePreset>('lower-third'), animation = ref('fade')
const overlayAnimation = ref<VisualMotionPreset>('none'), overlayPreview = ref<HTMLCanvasElement>()
const text = ref(''), duration = ref(5), color = ref('#ffffff'), background = ref('#152238'), opacity = ref(.8), strokeWidth = ref(5), blurRadius = ref(12), rotation = ref(0)
const x = ref(Math.round(props.project.width * .2)), y = ref(Math.round(props.project.height * .35)), width = ref(Math.round(props.project.width * .6)), height = ref(Math.round(props.project.height * .2))
const fontFamily = ref('sans-serif'), fontSize = ref(Math.max(24, Math.round(props.project.height * .07))), layout = ref('lower-third'), logoAssetId = ref('')
const imageAssets = computed(() => props.project.assets.filter(asset => asset.kind === 'image'))
const customizedClip = computed(() => props.project.tracks.flatMap(track => track.clips).find(clip => clip.id === props.selectedClipId))
const customizeText = computed(() => customizedClip.value?.text !== undefined)
const titleBounds = reactive(titleBoundsForPreset(props.project, preset.value))
function resetTitleBounds(): void {
  Object.assign(titleBounds, titleBoundsForPreset(props.project, preset.value))
  for (const key of ['x', 'y', 'width', 'height'] as const) titleBounds[key] = Math.round(titleBounds[key] * 10) / 10
}
watch([preset, () => props.project.width, () => props.project.height], resetTitleBounds, { immediate: true })
function drawOverlayPreview(): void {
  const canvas = overlayPreview.value, ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  const w = Math.max(1, Number(width.value) || 1), h = Math.max(1, Number(height.value) || 1), padding = 14
  const angle = (Number(rotation.value) || 0) * Math.PI / 180
  const rotatedWidth = Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle)), rotatedHeight = Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle))
  const scale = Math.min((canvas.width - padding * 2) / rotatedWidth, (canvas.height - padding * 2) / rotatedHeight)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.save(); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.scale(scale, scale); ctx.rotate(angle); ctx.translate(-w / 2, -h / 2)
  const overlay: ClipOverlay = { kind: kind.value, color: color.value, strokeWidth: Math.max(1, Number(strokeWidth.value) || 1), blurRadius: Math.max(1, Number(blurRadius.value) || 1) }
  if (kind.value === 'spotlight') overlay.region = { x: w * .25, y: h * .25, width: w * .5, height: h * .5 }
  ctx.globalAlpha = Math.max(0, Math.min(1, Number(opacity.value) || 0))
  if (kind.value === 'blur') {
    ctx.fillStyle = '#6e84a5'; ctx.fillRect(0, 0, w, h); ctx.filter = `blur(${Math.min(12, overlay.blurRadius * scale)}px)`
    ctx.fillStyle = '#d9e8ff'; ctx.fillRect(w * .25, h * .2, w * .15, h * .6); ctx.fillRect(w * .6, h * .2, w * .15, h * .6)
  } else drawClipOverlay(ctx, createTextClip(props.project, { width: w, height: h, overlay, text: '' }))
  ctx.restore()
}
watch([tab, kind, width, height, color, strokeWidth, blurRadius, opacity, rotation], drawOverlayPreview, { flush: 'post' })
onMounted(drawOverlayPreview)
async function run(): Promise<void> {
  if (tab.value === 'overlay') await task.execute('open_media_overlay_add', { kind: kind.value, start: props.time, duration: duration.value, x: x.value, y: y.value, width: width.value, height: height.value, color: color.value, opacity: opacity.value, strokeWidth: strokeWidth.value, blurRadius: blurRadius.value, rotation: rotation.value, animation: overlayAnimation.value }, '视觉标注已添加到时间线')
  else if (tab.value === 'title') await task.execute('open_media_title_add', { preset: preset.value, text: text.value.trim(), start: props.time, duration: duration.value, animation: animation.value, color: color.value, background: background.value, fontFamily: fontFamily.value, fontSize: fontSize.value, ...titleBounds }, '标题已添加到时间线')
  else if (props.selectedClipId) await task.execute('open_media_template_customize', { clipIds: [props.selectedClipId], ...(customizeText.value ? { color: color.value, background: background.value, fontFamily: fontFamily.value, fontSize: fontSize.value } : {}), opacity: opacity.value, layout: layout.value, duration: duration.value, ...(logoAssetId.value ? { logoAssetId: logoAssetId.value } : {}) }, '当前片段样式已更新')
}
</script>
<template>
  <section class="et-panel" data-testid="visual-elements-panel"><div class="et-tabs" aria-label="画面元素"><button :aria-pressed="tab === 'overlay'" :disabled="task.busy.value" @click="tab = 'overlay'">画面标注</button><button :aria-pressed="tab === 'title'" :disabled="task.busy.value" @click="tab = 'title'">动态标题</button><button v-if="selectedClipId" :aria-pressed="tab === 'customize'" :disabled="task.busy.value" @click="tab = 'customize'">定制当前片段</button></div><fieldset :disabled="task.busy.value"><template v-if="tab === 'overlay'"><label class="et-field">标注类型<select v-model="kind" aria-label="画面标注类型"><option v-for="item in OVERLAY_PRESETS" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><div class="overlay-preview"><canvas ref="overlayPreview" width="640" height="240" aria-label="标注形状预览" /></div><label class="et-field">入退场动画<select v-model="overlayAnimation" aria-label="标注入退场动画"><option v-for="item in VISUAL_MOTION_PRESETS" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><div class="et-grid"><label class="et-field">X / 像素<input v-model.number="x" type="number" aria-label="标注水平位置" /></label><label class="et-field">Y / 像素<input v-model.number="y" type="number" aria-label="标注垂直位置" /></label><label class="et-field">宽度 / 像素<input v-model.number="width" type="number" min="1" aria-label="标注宽度" /></label><label class="et-field">高度 / 像素<input v-model.number="height" type="number" min="1" aria-label="标注高度" /></label><label class="et-field">旋转 / 度<input v-model.number="rotation" type="number" min="-3600" max="3600" aria-label="标注旋转角度" /></label><label v-if="kind === 'blur'" class="et-field">模糊半径<input v-model.number="blurRadius" type="number" min="1" max="50" aria-label="标注模糊半径" /></label><label v-else class="et-field">线宽 / 像素<input v-model.number="strokeWidth" type="number" min="1" max="100" aria-label="标注线宽" /></label></div></template><template v-else><template v-if="tab === 'title'"><label class="et-field">标题布局<select v-model="preset" aria-label="动态标题布局"><option value="chapter">章节标题</option><option value="lower-third">底部信息条</option><option value="corner">角标</option><option value="subtitle">字幕</option></select></label><details class="et-section"><summary>位置与尺寸</summary><div class="et-grid"><label class="et-field">X / 像素<input v-model.number="titleBounds.x" type="number" min="-65536" max="65536" aria-label="标题水平位置" /></label><label class="et-field">Y / 像素<input v-model.number="titleBounds.y" type="number" min="-65536" max="65536" aria-label="标题垂直位置" /></label><label class="et-field">宽度 / 像素<input v-model.number="titleBounds.width" type="number" min="1" max="65536" aria-label="标题区域宽度" /></label><label class="et-field">高度 / 像素<input v-model.number="titleBounds.height" type="number" min="1" max="65536" aria-label="标题区域高度" /></label></div><button type="button" @click="resetTitleBounds">恢复布局位置与尺寸</button><p class="et-note">动画在此位置生成；切换布局会恢复对应的默认位置与尺寸。</p></details><label class="et-field">标题文字<textarea v-model="text" maxlength="20000" rows="3" aria-label="动态标题文字" /></label><label class="et-field">进入动画<select v-model="animation" aria-label="标题进入动画"><option value="none">无</option><option value="fade">淡入</option><option value="slide">滑入</option><option value="zoom">缩放</option></select></label></template><template v-else><label class="et-field">布局<select v-model="layout" aria-label="片段定制布局"><option value="center">居中</option><option value="lower-third">底部信息条</option><option value="top-left">左上角</option><option value="top-right">右上角</option></select></label><label class="et-field">Logo 素材<select v-model="logoAssetId" aria-label="定制Logo素材"><option value="">不添加</option><option v-for="asset in imageAssets" :key="asset.id" :value="asset.id">{{ asset.name }}</option></select></label></template><div v-if="tab === 'title' || customizeText" class="et-grid"><label class="et-field">字体<select v-model="fontFamily" aria-label="标题字体"><option value="sans-serif">无衬线</option><option value="serif">衬线</option><option value="monospace">等宽</option></select></label><label class="et-field">字号<input v-model.number="fontSize" type="number" min="4" max="2048" aria-label="标题字号" /></label><label class="et-field">背景颜色<input v-model="background" type="color" aria-label="标题背景颜色" /></label></div></template><div class="et-grid"><label v-if="tab !== 'customize' || customizeText" class="et-field">颜色<input v-model="color" type="color" aria-label="画面元素颜色" /></label><label class="et-field">时长 / 秒<input v-model.number="duration" type="number" min=".01" max="86400" step=".1" aria-label="画面元素时长" /></label><label v-if="tab !== 'title'" class="et-field">不透明度<input v-model.number="opacity" type="number" min="0" max="1" step=".05" aria-label="画面元素不透明度" /></label></div><p v-if="tab !== 'customize'" class="et-note">从当前播放位置 {{ time.toFixed(2) }} 秒开始，加入后可以在片段属性中继续调整。</p><button class="et-primary" :disabled="tab === 'title' && !text.trim()" @click="run"><Icon :name="tab === 'customize' ? 'check' : 'plus'" :size="14" />{{ tab === 'customize' ? '应用到当前片段' : '添加到时间线' }}</button></fieldset><EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" /></section>
</template>
<style src="./editor-tools.css"></style>

<style scoped>
.overlay-preview{margin:10px 0 14px;border:1px solid var(--ed-border);border-radius:8px;overflow:hidden;background-color:#182133;background-image:linear-gradient(45deg,#ffffff06 25%,transparent 25%),linear-gradient(-45deg,#ffffff06 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ffffff06 75%),linear-gradient(-45deg,transparent 75%,#ffffff06 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}.overlay-preview canvas{display:block;width:100%;height:auto;max-height:150px;object-fit:contain}
</style>
