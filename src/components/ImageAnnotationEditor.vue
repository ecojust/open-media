<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, toRaw, watch } from 'vue'
import Icon from './Icon.vue'
import type { ImageCrop } from '../core/image-crop'
import { cloneImageAnnotations, drawImageAnnotations, hitImageAnnotation, imageAnnotationBounds, MAX_IMAGE_ANNOTATION_POINTS, MAX_IMAGE_ANNOTATION_TEXT, type ImageAnnotation } from '../core/image-annotations'

const props = defineProps<{ source: string; width: number; height: number; crop?: ImageCrop; modelValue: ImageAnnotation[]; initialTool: 'text' | 'stroke' }>()
const emit = defineEmits<{ 'update:modelValue': [value: ImageAnnotation[]] }>()
const items = ref<ImageAnnotation[]>(cloneImageAnnotations(toRaw(props.modelValue)))
const selectedId = ref('')
const selected = computed(() => items.value.find(item => item.id === selectedId.value))
const textItem = computed(() => selected.value?.kind === 'text' ? selected.value : undefined)
const strokeItem = computed(() => selected.value?.kind === 'stroke' ? selected.value : undefined)
const tool = ref<'select' | 'stroke'>(props.initialTool === 'stroke' ? 'stroke' : 'select')
const brush = reactive({ color: '#ef4444', width: Math.max(2, Math.round(Math.min(props.width, props.height) / 80)), opacity: 1, style: 'pen' as 'pen' | 'marker' | 'dashed' })
const viewport = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const scale = ref(1)
const imageReady = ref(false)
const imageError = ref(false)
const editNotice = ref('')
const pointCount = computed(() => items.value.reduce((count, item) => count + (item.kind === 'stroke' ? item.points.length : 0), 0))
const past = shallowRef<ImageAnnotation[][]>([])
const future = shallowRef<ImageAnnotation[][]>([])
const stageStyle = computed(() => ({ width: `${props.width * scale.value}px`, height: `${props.height * scale.value}px` }))
let observer: ResizeObserver | undefined
let paintFrame = 0
let gestureLayers: { before?: HTMLCanvasElement; after?: HTMLCanvasElement } | undefined
let fieldBefore: ImageAnnotation[] | undefined
let gesture: { pointer: number; start: { x: number; y: number }; before: ImageAnnotation[]; item: ImageAnnotation; kind: 'stroke' | 'move' } | undefined

function publish() { scheduleDraw(); emit('update:modelValue', cloneImageAnnotations(toRaw(items.value))) }
function scheduleDraw() {
  if (!paintFrame) paintFrame = requestAnimationFrame(() => { paintFrame = 0; draw() })
}
function releaseGestureLayers() {
  for (const layer of [gestureLayers?.before, gestureLayers?.after]) if (layer) { layer.width = 0; layer.height = 0 }
  gestureLayers = undefined
}
function remember(before: ImageAnnotation[]) {
  if (JSON.stringify(before) === JSON.stringify(toRaw(items.value))) return
  past.value = [...past.value.slice(-79), before]
  future.value = []
}
function change(update: () => void) {
  cancelGesture()
  finishField()
  const before = cloneImageAnnotations(toRaw(items.value))
  update()
  remember(before)
  publish()
}
function beginField() { if (!fieldBefore) fieldBefore = cloneImageAnnotations(toRaw(items.value)) }
function finishField() { if (fieldBefore) { remember(fieldBefore); fieldBefore = undefined } }
function patchSelected(patch: Record<string, unknown>) {
  if (!selected.value) return
  beginField()
  if (typeof patch.text === 'string') {
    const otherText = items.value.reduce((count, item) => count + (item.kind === 'text' && item.id !== selectedId.value ? item.text.length : 0), 0)
    if (patch.text.length + otherText > MAX_IMAGE_ANNOTATION_TEXT) { patch.text = patch.text.slice(0, MAX_IMAGE_ANNOTATION_TEXT - otherText); editNotice.value = '文字总量已达上限，请先精简已有文字。' }
  }
  Object.assign(selected.value, patch)
  publish()
}
function numberValue(event: Event, minimum: number, maximum: number): number | undefined {
  const value = Number((event.target as HTMLInputElement).value)
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : undefined
}
function setTextNumber(key: 'x' | 'y' | 'fontSize' | 'opacity', event: Event) {
  const value = numberValue(event, key === 'fontSize' ? 4 : 0, key === 'x' ? props.width - 1 : key === 'y' ? props.height - 1 : key === 'fontSize' ? 512 : 1)
  if (value !== undefined) patchSelected({ [key]: value })
}
function setBrush(key: 'color' | 'width' | 'opacity' | 'style', event: Event) {
  const input = event.target as HTMLInputElement
  const value = key === 'width' ? numberValue(event, 1, 256) : key === 'opacity' ? numberValue(event, 0.05, 1) : input.value
  if (value === undefined) return
  beginField()
  Object.assign(brush, { [key]: value })
  if (key === 'style') brush.opacity = value === 'marker' ? 0.35 : 1
  if (strokeItem.value) Object.assign(strokeItem.value, { [key]: value, ...(key === 'style' ? { opacity: brush.opacity } : {}) })
  publish()
}
function selectItem(item: ImageAnnotation) {
  finishField()
  selectedId.value = item.id
  tool.value = 'select'
  if (item.kind === 'stroke') Object.assign(brush, { color: item.color, width: item.width, opacity: item.opacity, style: item.style })
}
function addText() {
  if (items.value.length >= 200) { editNotice.value = '最多添加 200 个标注，请先删除不需要的内容。'; return }
  if (items.value.reduce((count, item) => count + (item.kind === 'text' ? item.text.length : 0), 0) > MAX_IMAGE_ANNOTATION_TEXT - 10) { editNotice.value = '文字总量已达上限，请先精简已有文字。'; return }
  change(() => {
    const region = props.crop ?? { x: 0, y: 0, width: props.width, height: props.height }
    const fontSize = props.crop ? Math.min(96, Math.max(4, Math.min(Math.round(region.width / 16), Math.floor(region.height * 0.65)))) : Math.min(96, Math.max(12, Math.round(region.width / 16)))
    const item: ImageAnnotation = { id: `text-${crypto.randomUUID()}`, kind: 'text', x: region.x + Math.floor(region.width * 0.1), y: region.y + Math.floor(region.height * 0.1), text: '请输入文字', fontSize, color: '#ef4444', opacity: 1, fontFamily: 'sans-serif', fontWeight: 600 }
    items.value.push(item)
    selectedId.value = item.id
    tool.value = 'select'
  })
}
function activateTool(nextTool: 'text' | 'stroke') {
  if (nextTool === 'text') { addText(); return }
  cancelGesture()
  finishField()
  tool.value = 'stroke'
  selectedId.value = ''
  scheduleDraw()
}
defineExpose({ activateTool })
function removeSelected() {
  if (!selected.value) return
  change(() => { items.value = items.value.filter(item => item.id !== selectedId.value); selectedId.value = '' })
}
function undo() {
  if (cancelGesture()) return
  finishField()
  const previous = past.value.at(-1)
  if (!previous) return
  future.value = [...future.value, cloneImageAnnotations(toRaw(items.value))]
  items.value = cloneImageAnnotations(previous)
  past.value = past.value.slice(0, -1)
  if (!items.value.some(item => item.id === selectedId.value)) selectedId.value = ''
  publish()
}
function redo() {
  if (cancelGesture()) return
  finishField()
  const next = future.value.at(-1)
  if (!next) return
  past.value = [...past.value, cloneImageAnnotations(toRaw(items.value))]
  items.value = cloneImageAnnotations(next)
  future.value = future.value.slice(0, -1)
  publish()
}
function fit() {
  const element = viewport.value
  if (!element) return
  const nextScale = Math.min(1, Math.max(1, element.clientWidth - 32) / props.width, Math.max(140, Math.min(520, innerHeight * 0.5)) / props.height)
  if (Math.abs(nextScale - scale.value) > 0.000001) cancelGesture()
  scale.value = nextScale
  void nextTick(scheduleDraw)
}
function resize() { cancelGesture(); fit() }
function draw() {
  const element = canvas.value
  if (!element) return
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(props.width * scale.value * ratio))
  const height = Math.max(1, Math.round(props.height * scale.value * ratio))
  if (element.width !== width || element.height !== height) { element.width = width; element.height = height; releaseGestureLayers() }
  const context = element.getContext('2d')
  if (!context) return
  const renderedScale = element.width / props.width
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, width, height)
  context.setLineDash([])
  const annotations = toRaw(items.value)
  const activeIndex = gesture ? annotations.findIndex(item => item.id === gesture!.item.id) : -1
  if (activeIndex >= 0 && !gestureLayers) {
    const layer = (contents: ImageAnnotation[]) => {
      if (!contents.length) return undefined
      const result = document.createElement('canvas'); result.width = width; result.height = height
      const layerContext = result.getContext('2d')
      if (!layerContext) { result.width = 0; result.height = 0; return undefined }
      layerContext.scale(renderedScale, height / props.height)
      drawImageAnnotations(layerContext, contents)
      return result
    }
    // Preserve the selected annotation's position between the unchanged layers.
    gestureLayers = { before: layer(annotations.slice(0, activeIndex)), after: layer(annotations.slice(activeIndex + 1)) }
    if ((activeIndex > 0 && !gestureLayers.before) || (activeIndex < annotations.length - 1 && !gestureLayers.after)) releaseGestureLayers()
  }
  if (activeIndex >= 0 && gestureLayers) {
    if (gestureLayers.before) context.drawImage(gestureLayers.before, 0, 0)
    context.setTransform(renderedScale, 0, 0, height / props.height, 0, 0)
    drawImageAnnotations(context, [annotations[activeIndex]!])
    context.setTransform(1, 0, 0, 1, 0, 0)
    if (gestureLayers.after) context.drawImage(gestureLayers.after, 0, 0)
  } else {
    context.setTransform(renderedScale, 0, 0, height / props.height, 0, 0)
    drawImageAnnotations(context, annotations)
  }
  context.setTransform(renderedScale, 0, 0, height / props.height, 0, 0)
  if (props.crop) {
    const region = props.crop
    context.fillStyle = '#0b132b80'
    context.beginPath()
    context.rect(0, 0, props.width, props.height)
    context.rect(region.x, region.y, region.width, region.height)
    context.fill('evenodd')
    context.strokeStyle = '#3267f6'
    context.lineWidth = 1.5 / renderedScale
    context.strokeRect(region.x, region.y, region.width, region.height)
  }
  if (selected.value) {
    const bounds = imageAnnotationBounds(toRaw(selected.value), context)
    context.strokeStyle = '#3267f6'
    context.lineWidth = 1.5 / renderedScale
    context.setLineDash([5 / renderedScale, 3 / renderedScale])
    const padding = 4 / renderedScale
    context.strokeRect(bounds.x - padding, bounds.y - padding, bounds.width + padding * 2, bounds.height + padding * 2)
  }
}
function pointerPoint(event: PointerEvent) {
  const rect = canvas.value!.getBoundingClientRect()
  return { x: Math.max(0, Math.min(props.width, (event.clientX - rect.left) * props.width / rect.width)), y: Math.max(0, Math.min(props.height, (event.clientY - rect.top) * props.height / rect.height)) }
}
function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary || !imageReady.value || !canvas.value || gesture) return
  event.preventDefault()
  finishField()
  canvas.value.focus({ preventScroll: true })
  const point = pointerPoint(event)
  const before = cloneImageAnnotations(toRaw(items.value))
  let item: ImageAnnotation | undefined
  if (tool.value === 'stroke') {
    if (items.value.length >= 200) { editNotice.value = '最多添加 200 个标注，请先删除不需要的内容。'; return }
    if (pointCount.value >= MAX_IMAGE_ANNOTATION_POINTS) { editNotice.value = '笔触复杂度已达上限，请先删除不需要的笔触。'; return }
    item = { id: `stroke-${crypto.randomUUID()}`, kind: 'stroke', points: [point], ...brush }
    items.value.push(item)
  } else item = [...items.value].reverse().find(candidate => hitImageAnnotation(candidate, point, 6 / scale.value, canvas.value!.getContext('2d') ?? undefined))
  if (!item) { selectedId.value = ''; return }
  selectedId.value = item.id
  if (item.kind === 'stroke') Object.assign(brush, { color: item.color, width: item.width, opacity: item.opacity, style: item.style })
  gesture = { pointer: event.pointerId, start: point, before, item: cloneImageAnnotations([toRaw(item)])[0]!, kind: tool.value === 'stroke' ? 'stroke' : 'move' }
  canvas.value.setPointerCapture(event.pointerId)
  scheduleDraw()
}
function pointerMove(event: PointerEvent) {
  if (!gesture || gesture.pointer !== event.pointerId) return
  const item = items.value.find(value => value.id === gesture!.item.id)
  if (!item) return
  const point = pointerPoint(event)
  if (gesture.kind === 'stroke' && item.kind === 'stroke') {
    const last = item.points.at(-1)!
    if (Math.hypot(point.x - last.x, point.y - last.y) * scale.value >= 1) {
      if (item.points.length < 5000 && pointCount.value < MAX_IMAGE_ANNOTATION_POINTS) item.points.push(point)
      else editNotice.value = pointCount.value >= MAX_IMAGE_ANNOTATION_POINTS ? '笔触复杂度已达上限，请先删除不需要的笔触。' : '这条笔触已达长度上限，可松开后继续绘制。'
    }
  } else {
    const original = gesture.item
    const bounds = imageAnnotationBounds(original, canvas.value?.getContext('2d') ?? undefined)
    const dx = Math.max(-bounds.x, Math.min(props.width - bounds.x - Math.min(bounds.width, props.width), point.x - gesture.start.x))
    const dy = Math.max(-bounds.y, Math.min(props.height - bounds.y - Math.min(bounds.height, props.height), point.y - gesture.start.y))
    if (item.kind === 'text' && original.kind === 'text') { item.x = original.x + dx; item.y = original.y + dy }
    else if (item.kind === 'stroke' && original.kind === 'stroke') item.points = original.points.map(value => ({ x: value.x + dx, y: value.y + dy }))
  }
  scheduleDraw()
}
function pointerEnd(event: PointerEvent, cancelled = false) {
  if (!gesture || gesture.pointer !== event.pointerId) return
  if (!cancelled) pointerMove(event)
  const before = gesture.before
  gesture = undefined
  releaseGestureLayers()
  if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId)
  if (cancelled) items.value = cloneImageAnnotations(before)
  else remember(before)
  publish()
}
function cancelGesture() {
  if (!gesture) return false
  const current = gesture
  gesture = undefined
  releaseGestureLayers()
  if (canvas.value?.hasPointerCapture(current.pointer)) canvas.value.releasePointerCapture(current.pointer)
  items.value = cloneImageAnnotations(current.before)
  if (!items.value.some(item => item.id === selectedId.value)) selectedId.value = ''
  publish()
  return true
}
function keyboard(event: KeyboardEvent) {
  if (event.target instanceof HTMLElement && event.target.matches('input,textarea,select,[contenteditable="true"]')) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); event.shiftKey ? redo() : undo() }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopPropagation(); redo() }
  else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); removeSelected() }
}
watch(selectedId, scheduleDraw, { flush: 'post' })
onMounted(() => {
  window.addEventListener('blur', cancelGesture)
  window.addEventListener('resize', resize)
  observer = new ResizeObserver(fit)
  if (viewport.value) observer.observe(viewport.value)
  fit()
  if (props.initialTool === 'text') addText()
})
onBeforeUnmount(() => { observer?.disconnect(); gesture = undefined; cancelAnimationFrame(paintFrame); releaseGestureLayers(); window.removeEventListener('blur', cancelGesture); window.removeEventListener('resize', resize) })
</script>

<template>
  <div class="image-annotation-editor" @keydown="keyboard">
    <div class="annotation-toolbar" aria-label="图片编辑工具">
      <button :class="{ selected: tool === 'select' }" :aria-pressed="tool === 'select'" @click="finishField(); tool = 'select'"><Icon name="move" :size="15" />选择 / 移动</button>
      <button :disabled="items.length >= 200" data-testid="image-annotation-add-text" @click="addText"><Icon name="text" :size="15" />插入文字</button>
      <button :class="{ selected: tool === 'stroke' }" :aria-pressed="tool === 'stroke'" data-testid="image-annotation-brush" @click="activateTool('stroke')"><Icon name="pen" :size="15" />自定义笔触</button>
      <span class="annotation-toolbar-spacer" />
      <button :disabled="!past.length" aria-label="撤销图片编辑" data-testid="image-annotation-undo" @click="undo"><Icon name="undo" :size="15" /></button>
      <button :disabled="!future.length" aria-label="重做图片编辑" data-testid="image-annotation-redo" @click="redo"><Icon name="redo" :size="15" /></button>
      <button :disabled="!selected" aria-label="删除选中标注" data-testid="image-annotation-delete" @click="removeSelected"><Icon name="trash" :size="15" /></button>
    </div>
    <p v-if="editNotice" class="annotation-limit-notice" role="status">{{ editNotice }}</p>
    <div class="annotation-layout">
      <div ref="viewport" class="annotation-viewport">
        <div class="annotation-stage" :style="stageStyle">
          <img :src="source" alt="编辑原图" draggable="false" @load="imageReady = true; imageError = false" @error="imageReady = false; imageError = true">
          <canvas ref="canvas" tabindex="0" aria-label="图片标注画布" data-testid="image-annotation-canvas" :class="{ drawing: tool === 'stroke' }" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerEnd($event)" @pointercancel="pointerEnd($event, true)" @lostpointercapture="pointerEnd($event, true)" />
        </div>
        <p v-if="imageError" class="annotation-error" role="alert">原图无法读取，请重新导入图片。</p>
        <p class="annotation-coordinate-note">按原图 {{ width }} × {{ height }} 像素编辑；文字和笔触会与图片一起裁剪、缩放及旋转。<br v-if="crop"><span v-if="crop" data-testid="image-annotation-crop-hint">蓝框为保留区域（{{ crop.width }} × {{ crop.height }}），暗色区域的内容不会导出。</span></p>
      </div>
      <aside class="annotation-properties" aria-label="标注属性">
        <template v-if="textItem">
          <h3>文字</h3>
          <label>文字内容<textarea :value="textItem.text" maxlength="2000" rows="4" aria-label="图片文字内容" @focus="beginField" @input="patchSelected({ text: ($event.target as HTMLTextAreaElement).value })" @change="finishField" @blur="finishField" /></label>
          <div class="annotation-pair"><label>字号<input :value="textItem.fontSize" type="number" min="4" max="512" aria-label="图片文字字号" @focus="beginField" @input="setTextNumber('fontSize', $event)" @change="finishField" @blur="finishField"></label><label>颜色<input :value="textItem.color" type="color" aria-label="图片文字颜色" @focus="beginField" @input="patchSelected({ color: ($event.target as HTMLInputElement).value })" @change="finishField" @blur="finishField"></label></div>
          <div class="annotation-pair"><label>X<input :value="Math.round(textItem.x)" type="number" min="0" :max="width - 1" aria-label="图片文字 X" @focus="beginField" @input="setTextNumber('x', $event)" @change="finishField" @blur="finishField"></label><label>Y<input :value="Math.round(textItem.y)" type="number" min="0" :max="height - 1" aria-label="图片文字 Y" @focus="beginField" @input="setTextNumber('y', $event)" @change="finishField" @blur="finishField"></label></div>
          <label>透明度 {{ Math.round(textItem.opacity * 100) }}%<input :value="textItem.opacity" type="range" min="0" max="1" step="0.05" aria-label="图片文字透明度" @focus="beginField" @input="setTextNumber('opacity', $event)" @change="finishField" @blur="finishField"></label>
        </template>
        <template v-else>
          <h3>自定义笔触</h3>
          <label>笔触<select :value="strokeItem?.style ?? brush.style" aria-label="图片笔触类型" @change="setBrush('style', $event); finishField()"><option value="pen">画笔</option><option value="marker">荧光笔</option><option value="dashed">虚线</option></select></label>
          <div class="annotation-pair"><label>宽度<input :value="strokeItem?.width ?? brush.width" type="number" min="1" max="256" aria-label="图片笔触宽度" @focus="beginField" @input="setBrush('width', $event)" @change="finishField" @blur="finishField"></label><label>颜色<input :value="strokeItem?.color ?? brush.color" type="color" aria-label="图片笔触颜色" @focus="beginField" @input="setBrush('color', $event)" @change="finishField" @blur="finishField"></label></div>
          <label>透明度 {{ Math.round((strokeItem?.opacity ?? brush.opacity) * 100) }}%<input :value="strokeItem?.opacity ?? brush.opacity" type="range" min="0.05" max="1" step="0.05" aria-label="图片笔触透明度" @focus="beginField" @input="setBrush('opacity', $event)" @change="finishField" @blur="finishField"></label>
          <p class="annotation-help">在图片上拖动画线；切换“选择 / 移动”可拖动已有文字和笔触。</p>
        </template>
        <div class="annotation-items" aria-label="已有标注">
          <p>{{ items.length }} 个标注</p>
          <button v-for="(item, index) in items" :key="item.id" :class="{ selected: selectedId === item.id }" data-testid="image-annotation-item" @click="selectItem(item)"><Icon :name="item.kind === 'text' ? 'text' : 'pen'" :size="13" /><span>{{ item.kind === 'text' ? item.text || '空文字' : `${item.style === 'marker' ? '荧光笔' : item.style === 'dashed' ? '虚线' : '画笔'} ${index + 1}` }}</span></button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.image-annotation-editor{width:100%;min-width:0;font-size:12px;color:var(--ui-text);container:annotation-editor / inline-size}.annotation-toolbar{display:flex;align-items:center;gap:6px;padding:10px 14px;border-bottom:1px solid var(--ui-line);flex-wrap:wrap}.annotation-toolbar button,.annotation-items button{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:5px 9px;border:1px solid var(--ui-line);border-radius:6px;background:var(--ui-panel);color:inherit;font:inherit;cursor:pointer}.annotation-toolbar button.selected,.annotation-items button.selected{border-color:var(--ui-accent);color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 10%,var(--ui-panel))}.annotation-toolbar button:disabled{opacity:.4;cursor:not-allowed}.annotation-toolbar-spacer{flex:1}.annotation-layout{display:grid;grid-template-columns:minmax(0,1fr) 220px;min-height:300px}.annotation-viewport{min-width:0;padding:16px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;overflow:auto;background:var(--ui-bg)}.annotation-stage{position:relative;flex-shrink:0;background-color:#e4e7ed;background-image:linear-gradient(45deg,#f7f8fa 25%,transparent 25%),linear-gradient(-45deg,#f7f8fa 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#f7f8fa 75%),linear-gradient(-45deg,transparent 75%,#f7f8fa 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}.annotation-stage img,.annotation-stage canvas{display:block;width:100%;height:100%;position:absolute;inset:0}.annotation-stage img{pointer-events:none;user-select:none}.annotation-stage canvas{touch-action:none;cursor:default}.annotation-stage canvas.drawing{cursor:crosshair}.annotation-stage canvas:focus-visible{outline:2px solid var(--ui-accent);outline-offset:3px}.annotation-coordinate-note{margin:12px 0 0;font-size:10px;line-height:1.6;color:var(--ui-muted);align-self:stretch;text-align:center}.annotation-properties{min-width:0;padding:14px;border-left:1px solid var(--ui-line);display:flex;flex-direction:column;gap:12px;overflow:auto;max-height:600px}.annotation-properties h3{font-size:12px;margin:0}.annotation-properties label{display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--ui-muted);min-width:0}.annotation-properties input:not([type=range]),.annotation-properties textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--ui-line);border-radius:6px;background:var(--ui-bg);color:var(--ui-text);padding:7px;font:inherit}.annotation-properties input[type=color]{height:32px;padding:3px}.annotation-properties input[type=range]{width:100%;accent-color:var(--ui-accent)}.annotation-properties textarea{resize:vertical;min-height:70px}.annotation-properties select{width:100%}.annotation-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.annotation-help{font-size:10px;color:var(--ui-muted);line-height:1.7;margin:0}.annotation-items{display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--ui-line);padding-top:10px;max-height:190px;min-width:0;overflow:auto}.annotation-items p{font-size:10px;margin:0 0 4px;color:var(--ui-muted)}.annotation-items button{justify-content:flex-start;flex-shrink:0;text-align:left;width:100%}.annotation-items button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.annotation-error{color:#d45355}.annotation-limit-notice{margin:0;padding:8px 14px;color:var(--ui-muted);font-size:11px;line-height:1.6}
@container annotation-editor (max-width:640px){.annotation-layout{grid-template-columns:1fr}.annotation-properties{border-left:0;border-top:1px solid var(--ui-line);max-height:none;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.annotation-properties h3,.annotation-items,.annotation-help{grid-column:1 / -1}.annotation-toolbar{padding:8px;gap:4px}.annotation-toolbar button{font-size:10px;padding:4px 6px}.annotation-viewport{min-height:180px}.annotation-properties>label:has(textarea){grid-column:1 / -1}.annotation-items{max-height:150px}}
@container annotation-editor (max-width:360px){.annotation-properties{padding:10px;gap:10px}.annotation-toolbar-spacer{display:none}.annotation-viewport{padding:16px}.annotation-pair{gap:6px}.annotation-toolbar button{gap:4px}}
</style>
