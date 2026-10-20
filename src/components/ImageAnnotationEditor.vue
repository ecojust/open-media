<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, toRaw, watch } from 'vue'
import Icon from './Icon.vue'
import ImageCanvasViewport from './ImageCanvasViewport.vue'
import type { ImageCrop } from '../core/image-crop'
import { cloneImageAnnotations, drawImageAnnotations, hitImageAnnotation, imageAnnotationBounds, MAX_IMAGE_ANNOTATION_POINTS, MAX_IMAGE_ANNOTATION_TEXT, type ImageAnnotation } from '../core/image-annotations'

const props = defineProps<{ source: string; width: number; height: number; crop?: ImageCrop; modelValue: ImageAnnotation[]; initialTool: 'select' | 'text' | 'stroke'; propertiesTarget?: HTMLElement; hideToolbar?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: ImageAnnotation[]]; 'tool-change': [tool: 'select' | 'stroke'] }>()
const items = ref<ImageAnnotation[]>(cloneImageAnnotations(toRaw(props.modelValue)))
const selectedId = ref('')
const selected = computed(() => items.value.find(item => item.id === selectedId.value))
const textItem = computed(() => selected.value?.kind === 'text' ? selected.value : undefined)
const strokeItem = computed(() => selected.value?.kind === 'stroke' ? selected.value : undefined)
const tool = ref<'select' | 'stroke'>(props.initialTool === 'stroke' ? 'stroke' : 'select')
const brush = reactive({ color: '#ef4444', width: Math.max(2, Math.round(Math.min(props.width, props.height) / 80)), opacity: 1, style: 'pen' as 'pen' | 'marker' | 'dashed' })
const viewport = ref<InstanceType<typeof ImageCanvasViewport>>()
const inlineInput = ref<HTMLTextAreaElement>()
const editingTextId = ref('')
const composing = ref(false)
const inlineText = computed(() => items.value.find(item => item.id === editingTextId.value && item.kind === 'text'))
const swatches = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff', '#111827']
const brushStyles = [{ id: 'pen', label: '画笔' }, { id: 'marker', label: '荧光笔' }, { id: 'dashed', label: '虚线' }] as const
const canvas = ref<HTMLCanvasElement>()
const scale = ref(1)
const imageReady = ref(false)
const imageError = ref(false)
const editNotice = ref('')
const pointCount = computed(() => items.value.reduce((count, item) => count + (item.kind === 'stroke' ? item.points.length : 0), 0))
const past = shallowRef<ImageAnnotation[][]>([])
const future = shallowRef<ImageAnnotation[][]>([])
const canUndo = computed(() => past.value.length > 0)
const canRedo = computed(() => future.value.length > 0)
const inlineStyle = computed(() => {
  const item = inlineText.value
  if (item?.kind !== 'text') return {}
  const bounds = imageAnnotationBounds(toRaw(item), canvas.value?.getContext('2d') ?? undefined)
  return { left: `${item.x}px`, top: `${item.y}px`, width: `${Math.max(item.fontSize * 2, Math.min(props.width - item.x, bounds.width + item.fontSize * 2))}px`, height: `${Math.max(item.fontSize * 1.25, bounds.height)}px`, font: `${item.fontWeight} ${item.fontSize}px/${1.25} ${item.fontFamily}`, color: item.color, opacity: item.opacity, '--editor-border': `${1 / scale.value}px` }
})
let lastPublished: ImageAnnotation[] | undefined
let paintFrame = 0
let gestureLayers: { before?: HTMLCanvasElement; after?: HTMLCanvasElement } | undefined
let fieldBefore: ImageAnnotation[] | undefined
let gesture: { pointer: number; start: { x: number; y: number }; before: ImageAnnotation[]; item: ImageAnnotation; kind: 'stroke' | 'move' } | undefined

function publish() { scheduleDraw(); lastPublished = cloneImageAnnotations(toRaw(items.value)); emit('update:modelValue', lastPublished) }
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
  finishInline()
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
  finishInline()
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
  void nextTick(() => beginInline(selectedId.value))
}
function activateTool(nextTool: 'select' | 'text' | 'stroke') {
  if (nextTool === 'text') { addText(); return }
  cancelGesture()
  finishInline()
  finishField()
  tool.value = nextTool
  viewport.value?.selectTool()
  if (nextTool === 'stroke') selectedId.value = ''
  scheduleDraw()
}
function flush() {
  if (gesture) finishGesture(false)
  finishInline()
  finishField()
}
defineExpose({ activateTool, flush, undo, redo, canUndo, canRedo })
function removeSelected() {
  if (!selected.value) return
  change(() => { items.value = items.value.filter(item => item.id !== selectedId.value); selectedId.value = '' })
}
function undo() {
  if (cancelGesture()) return
  finishInline()
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
  finishInline()
  finishField()
  const next = future.value.at(-1)
  if (!next) return
  past.value = [...past.value, cloneImageAnnotations(toRaw(items.value))]
  items.value = cloneImageAnnotations(next)
  future.value = future.value.slice(0, -1)
  publish()
}
function viewChanged(view: { scale: number }) {
  if (Math.abs(view.scale - scale.value) <= 0.000001) return
  cancelGesture()
  scale.value = view.scale
  scheduleDraw()
}
function beginInline(id: string) {
  const item = items.value.find(candidate => candidate.id === id)
  if (item?.kind !== 'text') return
  finishInline()
  selectedId.value = id
  tool.value = 'select'
  viewport.value?.selectTool()
  editingTextId.value = id
  beginField()
  scheduleDraw()
  void nextTick(() => { inlineInput.value?.focus({ preventScroll: true }); inlineInput.value?.select() })
}
function finishInline() {
  if (!editingTextId.value) return
  editingTextId.value = ''
  composing.value = false
  finishField()
  scheduleDraw()
}
function inlineKeyboard(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.isComposing || composing.value) return
  if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) {
    event.preventDefault()
    finishInline()
    canvas.value?.focus({ preventScroll: true })
  }
}
function doubleClick(event: MouseEvent) {
  if (!imageReady.value || !canvas.value || tool.value === 'stroke') return
  const point = pointerPoint(event)
  const item = [...items.value].reverse().find(candidate => hitImageAnnotation(candidate, point, 6 / scale.value, canvas.value!.getContext('2d') ?? undefined))
  if (item?.kind === 'text') { event.preventDefault(); beginInline(item.id) }
}
function setColor(value: string) {
  if (textItem.value) patchSelected({ color: value })
  else {
    beginField()
    brush.color = value
    if (strokeItem.value) strokeItem.value.color = value
    publish()
  }
  finishField()
}
function chooseBrush(style: 'pen' | 'marker' | 'dashed') {
  beginField()
  brush.style = style
  brush.opacity = style === 'marker' ? 0.35 : 1
  if (strokeItem.value) Object.assign(strokeItem.value, { style, opacity: brush.opacity })
  else tool.value = 'stroke'
  publish()
  finishField()
}
function moveSelection(dx: number, dy: number) {
  if (!selected.value) return
  change(() => {
    const item = selected.value
    if (!item) return
    const bounds = imageAnnotationBounds(toRaw(item), canvas.value?.getContext('2d') ?? undefined)
    const x = Math.max(-bounds.x, Math.min(props.width - bounds.x - Math.min(bounds.width, props.width), dx))
    const y = Math.max(-bounds.y, Math.min(props.height - bounds.y - Math.min(bounds.height, props.height), dy))
    if (item.kind === 'text') { item.x += x; item.y += y }
    else item.points = item.points.map(point => ({ x: point.x + x, y: point.y + y }))
  })
}
function duplicateSelected() {
  const original = selected.value
  if (!original || items.value.length >= 200) return
  if (original.kind === 'stroke' && pointCount.value + original.points.length > MAX_IMAGE_ANNOTATION_POINTS) { editNotice.value = '笔触复杂度已达上限，请先删除不需要的笔触。'; return }
  if (original.kind === 'text' && items.value.reduce((count, item) => count + (item.kind === 'text' ? item.text.length : 0), 0) + original.text.length > MAX_IMAGE_ANNOTATION_TEXT) { editNotice.value = '文字总量已达上限，请先精简已有文字。'; return }
  change(() => {
    const item = cloneImageAnnotations([toRaw(original)])[0]!
    item.id = `${item.kind}-${crypto.randomUUID()}`
    const bounds = imageAnnotationBounds(item, canvas.value?.getContext('2d') ?? undefined)
    const offsetX = Math.max(0, Math.min(16, props.width - bounds.x - bounds.width))
    const offsetY = Math.max(0, Math.min(16, props.height - bounds.y - bounds.height))
    if (item.kind === 'text') { item.x += offsetX; item.y += offsetY }
    else item.points = item.points.map(point => ({ x: point.x + offsetX, y: point.y + offsetY }))
    items.value.push(item)
    selectedId.value = item.id
  })
}
function orderSelected(direction: 'front' | 'back') {
  if (!selected.value) return
  change(() => {
    const index = items.value.findIndex(item => item.id === selectedId.value)
    const [item] = items.value.splice(index, 1)
    if (item) direction === 'front' ? items.value.push(item) : items.value.unshift(item)
  })
}
function draw() {
  const element = canvas.value
  if (!element) return
  const renderedRatio = Math.min(scale.value * Math.min(2, window.devicePixelRatio || 1), 4096 / props.width, 4096 / props.height, Math.sqrt(8_000_000 / (props.width * props.height)))
  const width = Math.max(1, Math.floor(props.width * renderedRatio))
  const height = Math.max(1, Math.floor(props.height * renderedRatio))
  if (element.width !== width || element.height !== height) { element.width = width; element.height = height; releaseGestureLayers() }
  const context = element.getContext('2d')
  if (!context) return
  const renderedScale = element.width / props.width
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, width, height)
  context.setLineDash([])
  const annotations = toRaw(items.value).filter(item => item.id !== editingTextId.value)
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
    context.lineWidth = 1.5 / scale.value
    context.strokeRect(region.x, region.y, region.width, region.height)
  }
  if (selected.value) {
    const bounds = imageAnnotationBounds(toRaw(selected.value), context)
    context.strokeStyle = '#3267f6'
    context.lineWidth = 1.5 / scale.value
    context.setLineDash([5 / scale.value, 3 / scale.value])
    const padding = 4 / scale.value
    context.strokeRect(bounds.x - padding, bounds.y - padding, bounds.width + padding * 2, bounds.height + padding * 2)
  }
}
function pointerPoint(event: MouseEvent) {
  const rect = canvas.value!.getBoundingClientRect()
  return { x: Math.max(0, Math.min(props.width, (event.clientX - rect.left) * props.width / rect.width)), y: Math.max(0, Math.min(props.height, (event.clientY - rect.top) * props.height / rect.height)) }
}
function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary || !imageReady.value || !canvas.value || gesture) return
  event.preventDefault()
  finishInline()
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
  if (!item) { selectedId.value = ''; scheduleDraw(); return }
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
  finishGesture(cancelled)
}
function finishGesture(cancelled: boolean) {
  if (!gesture) return
  const { before, pointer } = gesture
  gesture = undefined
  releaseGestureLayers()
  if (canvas.value?.hasPointerCapture(pointer)) canvas.value.releasePointerCapture(pointer)
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
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); event.stopPropagation(); duplicateSelected() }
  else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); removeSelected() }
  else if (selected.value && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation()
    const amount = event.shiftKey ? 10 : 1
    moveSelection(event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0, event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0)
  }
}
watch(selectedId, scheduleDraw, { flush: 'post' })
watch(tool, value => emit('tool-change', value))
watch(() => props.modelValue, value => {
  if (toRaw(value) === lastPublished) return
  const incoming = cloneImageAnnotations(toRaw(value))
  if (JSON.stringify(incoming) === JSON.stringify(toRaw(items.value))) return
  if (gesture) {
    const pointer = gesture.pointer
    gesture = undefined
    releaseGestureLayers()
    if (canvas.value?.hasPointerCapture(pointer)) canvas.value.releasePointerCapture(pointer)
  }
  finishInline()
  fieldBefore = undefined
  items.value = incoming
  past.value = []; future.value = []
  if (!items.value.some(item => item.id === selectedId.value)) selectedId.value = ''
  scheduleDraw()
})
watch(() => props.crop, scheduleDraw, { deep: true })
onMounted(() => {
  window.addEventListener('blur', cancelGesture)
  scheduleDraw()
  if (props.initialTool === 'text') addText()
})
onBeforeUnmount(() => { gesture = undefined; cancelAnimationFrame(paintFrame); releaseGestureLayers(); window.removeEventListener('blur', cancelGesture) })
</script>
<template>
  <div class="image-annotation-editor" :class="{ 'external-properties': propertiesTarget }" @keydown="keyboard">
    <div v-if="!hideToolbar" class="annotation-toolbar" aria-label="图片编辑工具">
      <div class="annotation-tool-group">
        <button :class="{ selected: tool === 'select' }" :aria-pressed="tool === 'select'" @click="activateTool('select')"><Icon name="move" :size="15" />选择 / 移动</button>
        <button :disabled="items.length >= 200" data-testid="image-annotation-add-text" @click="addText"><Icon name="text" :size="15" />插入文字</button>
        <button :class="{ selected: tool === 'stroke' }" :aria-pressed="tool === 'stroke'" data-testid="image-annotation-brush" @click="activateTool('stroke')"><Icon name="pen" :size="15" />自定义笔触</button>
      </div>
      <span class="annotation-toolbar-spacer" />
      <div class="annotation-tool-group">
        <button :disabled="!canUndo" aria-label="撤销图片编辑" data-testid="image-annotation-undo" @click="undo"><Icon name="undo" :size="15" /></button>
        <button :disabled="!canRedo" aria-label="重做图片编辑" data-testid="image-annotation-redo" @click="redo"><Icon name="redo" :size="15" /></button>
      </div>
    </div>
    <p v-if="editNotice" class="annotation-limit-notice" role="status">{{ editNotice }}</p>
    <div class="annotation-layout">
      <ImageCanvasViewport ref="viewport" :width="width" :height="height" label="图片标注视口" @view-change="viewChanged" @select-tool="activateTool('select')">
        <div class="annotation-stage">
          <img :src="source" alt="编辑原图" draggable="false" @load="imageReady = true; imageError = false" @error="imageReady = false; imageError = true">
          <canvas ref="canvas" tabindex="0" aria-label="图片标注画布" data-testid="image-annotation-canvas" :class="{ drawing: tool === 'stroke' }" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerEnd($event)" @pointercancel="pointerEnd($event, true)" @lostpointercapture="pointerEnd($event, true)" @dblclick="doubleClick" />
          <textarea v-if="inlineText?.kind === 'text'" ref="inlineInput" class="annotation-inline-text" :style="inlineStyle" :value="inlineText.text" maxlength="2000" aria-label="画布文字编辑" data-testid="image-annotation-inline-text" spellcheck="false" @pointerdown.stop @dblclick.stop @keydown="inlineKeyboard" @compositionstart="composing = true" @compositionend="composing = false; patchSelected({ text: ($event.target as HTMLTextAreaElement).value })" @input="patchSelected({ text: ($event.target as HTMLTextAreaElement).value })" @blur="finishInline" />
        </div>
      </ImageCanvasViewport>
      <Teleport :to="propertiesTarget ?? 'body'" :disabled="!propertiesTarget">
        <aside class="annotation-properties" :class="{ teleported: propertiesTarget }" aria-label="标注属性" @keydown="keyboard">
          <div v-if="propertiesTarget" class="annotation-coordinate-note properties-coordinates"><span>{{ width }} × {{ height }} px</span><span v-if="crop" data-testid="image-annotation-crop-hint">蓝框保留 {{ crop.width }} × {{ crop.height }} px</span></div>
          <template v-if="textItem">
            <div class="annotation-property-heading"><Icon name="text" :size="16" /><h3>文字</h3><span>双击画布文字直接编辑</span></div>
            <label>文字内容<textarea :value="textItem.text" maxlength="2000" rows="3" aria-label="图片文字内容" @focus="beginField" @input="patchSelected({ text: ($event.target as HTMLTextAreaElement).value })" @change="finishField" @blur="finishField" /></label>
            <div class="annotation-pair"><label>字体<select :value="textItem.fontFamily" aria-label="图片文字字体" @change="patchSelected({ fontFamily: ($event.target as HTMLSelectElement).value }); finishField()"><option value="sans-serif">无衬线</option><option value="serif">衬线</option><option value="monospace">等宽</option></select></label><label>字重<select :value="textItem.fontWeight" aria-label="图片文字字重" @change="patchSelected({ fontWeight: Number(($event.target as HTMLSelectElement).value) }); finishField()"><option :value="400">常规</option><option :value="600">中粗</option><option :value="700">粗体</option></select></label></div>
            <div class="annotation-pair"><label>字号<input :value="textItem.fontSize" type="number" min="4" max="512" aria-label="图片文字字号" @focus="beginField" @input="setTextNumber('fontSize', $event)" @change="finishField" @blur="finishField"></label><label>颜色<input :value="textItem.color" type="color" aria-label="图片文字颜色" @focus="beginField" @input="patchSelected({ color: ($event.target as HTMLInputElement).value })" @change="finishField" @blur="finishField"></label></div>
            <div class="annotation-pair"><label>X<input :value="Math.round(textItem.x)" type="number" min="0" :max="width - 1" aria-label="图片文字 X" @focus="beginField" @input="setTextNumber('x', $event)" @change="finishField" @blur="finishField"></label><label>Y<input :value="Math.round(textItem.y)" type="number" min="0" :max="height - 1" aria-label="图片文字 Y" @focus="beginField" @input="setTextNumber('y', $event)" @change="finishField" @blur="finishField"></label></div>
            <label>透明度 {{ Math.round(textItem.opacity * 100) }}%<input :value="textItem.opacity" type="range" min="0" max="1" step="0.05" aria-label="图片文字透明度" @focus="beginField" @input="setTextNumber('opacity', $event)" @change="finishField" @blur="finishField"></label>
          </template>
          <template v-else-if="tool === 'stroke' || strokeItem">
            <div class="annotation-property-heading"><Icon name="pen" :size="16" /><h3>自定义笔触</h3></div>
            <div class="annotation-brush-cards" role="group" aria-label="选择笔触">
              <button v-for="style in brushStyles" :key="style.id" :class="{ selected: (strokeItem?.style ?? brush.style) === style.id }" :aria-pressed="(strokeItem?.style ?? brush.style) === style.id" :aria-label="`使用${style.label}`" @click="chooseBrush(style.id)"><svg viewBox="0 0 58 24" aria-hidden="true"><path d="M5 17C15 0 26 24 53 7" fill="none" :stroke="strokeItem?.color ?? brush.color" :stroke-width="style.id === 'marker' ? 9 : 3" :stroke-linecap="style.id === 'marker' ? 'butt' : 'round'" :stroke-dasharray="style.id === 'dashed' ? '6 5' : undefined" :opacity="style.id === 'marker' ? 0.45 : 1" /></svg><span>{{ style.label }}</span></button>
            </div>
            <label class="annotation-accessible-select">笔触<select :value="strokeItem?.style ?? brush.style" aria-label="图片笔触类型" @change="setBrush('style', $event); finishField()"><option value="pen">画笔</option><option value="marker">荧光笔</option><option value="dashed">虚线</option></select></label>
            <div class="annotation-pair"><label>宽度<input :value="strokeItem?.width ?? brush.width" type="number" min="1" max="256" aria-label="图片笔触宽度" @focus="beginField" @input="setBrush('width', $event)" @change="finishField" @blur="finishField"></label><label>颜色<input :value="strokeItem?.color ?? brush.color" type="color" aria-label="图片笔触颜色" @focus="beginField" @input="setBrush('color', $event)" @change="finishField" @blur="finishField"></label></div>
            <label>透明度 {{ Math.round((strokeItem?.opacity ?? brush.opacity) * 100) }}%<input :value="strokeItem?.opacity ?? brush.opacity" type="range" min="0.05" max="1" step="0.05" aria-label="图片笔触透明度" @focus="beginField" @input="setBrush('opacity', $event)" @change="finishField" @blur="finishField"></label>
          </template>
          <div v-else class="annotation-selection-help"><Icon name="move" :size="26" /><h3>选择图片上的标注</h3><p>点击文字或笔触调整属性；双击文字直接输入。空格拖动画布，Ctrl / ⌘ + 滚轮缩放。</p></div>
          <div v-if="selected || tool === 'stroke'" class="annotation-swatches" role="group" aria-label="快捷颜色"><button v-for="color in swatches" :key="color" :style="{ '--swatch': color }" :aria-label="`颜色 ${color}`" :aria-pressed="(selected?.color ?? brush.color) === color" @click="setColor(color)" /></div>
          <div v-if="selected" class="annotation-object-actions" role="group" aria-label="选中标注操作"><button title="复制标注（Ctrl / ⌘ + D）" aria-label="复制选中标注" data-testid="image-annotation-duplicate" @click="duplicateSelected"><Icon name="copy" :size="15" />复制</button><button title="移至最上层" data-testid="image-annotation-front" @click="orderSelected('front')"><Icon name="chevron-up" :size="15" />置顶</button><button title="移至最下层" data-testid="image-annotation-back" @click="orderSelected('back')"><Icon name="chevron-down" :size="15" />置底</button><button aria-label="删除选中标注" data-testid="image-annotation-delete" @click="removeSelected"><Icon name="trash" :size="15" />删除</button></div>
          <div class="annotation-items" aria-label="已有标注">
            <div class="annotation-layer-heading"><Icon name="layers" :size="14" /><span>标注图层</span><span>{{ items.length }}</span></div>
            <p v-if="!items.length" class="annotation-empty-layers">添加文字或笔触后会显示在这里</p>
            <button v-for="(item, index) in items" :key="item.id" :class="{ selected: selectedId === item.id }" data-testid="image-annotation-item" @click="selectItem(item)" @dblclick="item.kind === 'text' && beginInline(item.id)"><Icon :name="item.kind === 'text' ? 'text' : 'pen'" :size="13" /><span>{{ item.kind === 'text' ? item.text || '空文字' : `${item.style === 'marker' ? '荧光笔' : item.style === 'dashed' ? '虚线' : '画笔'} ${index + 1}` }}</span></button>
          </div>
        </aside>
      </Teleport>
    </div>
    <p v-if="imageError" class="annotation-error" role="alert">原图无法读取，请重新导入图片。</p>
    <div v-if="!propertiesTarget" class="annotation-coordinate-note"><span>{{ width }} × {{ height }} px</span><span v-if="crop" data-testid="image-annotation-crop-hint">蓝框保留 {{ crop.width }} × {{ crop.height }} px</span><span v-else>原图保留 · 编辑可撤销</span></div>
  </div>
</template>

<style scoped>
.image-annotation-editor{width:100%;height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;font-size:12px;color:var(--ui-text);container:annotation-editor / inline-size}
.annotation-toolbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--ui-line);flex-wrap:wrap;flex:none}.annotation-tool-group{display:flex;align-items:center;gap:4px}.annotation-toolbar button,.annotation-items button,.annotation-object-actions button{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:5px 9px;border:1px solid var(--ui-line);border-radius:6px;background:var(--ui-panel);color:inherit;font:inherit;cursor:pointer}.annotation-toolbar button.selected,.annotation-items button.selected{border-color:var(--ui-accent);color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 10%,var(--ui-panel))}.annotation-toolbar button:disabled{opacity:.4;cursor:not-allowed}.annotation-toolbar-spacer{flex:1}
.annotation-layout{display:grid;grid-template-columns:minmax(0,1fr) 220px;min-height:340px;flex:1;overflow:hidden}.external-properties .annotation-layout{grid-template-columns:minmax(0,1fr);min-height:280px}.annotation-stage{position:relative;width:100%;height:100%;background-color:#e4e7ed;background-image:linear-gradient(45deg,#f7f8fa 25%,transparent 25%),linear-gradient(-45deg,#f7f8fa 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#f7f8fa 75%),linear-gradient(-45deg,transparent 75%,#f7f8fa 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}.annotation-stage img,.annotation-stage canvas{display:block;width:100%;height:100%;position:absolute;inset:0}.annotation-stage img{pointer-events:none;user-select:none}.annotation-stage canvas{touch-action:none;cursor:default}.annotation-stage canvas.drawing{cursor:crosshair}.annotation-stage canvas:focus-visible{outline:2px solid var(--ui-accent);outline-offset:3px}
.annotation-inline-text{position:absolute;box-sizing:content-box;display:block;resize:none;margin:0;padding:0;border:0;outline:var(--editor-border) solid var(--ui-accent);outline-offset:var(--editor-border);border-radius:0;background:transparent;white-space:pre;overflow:hidden;overflow-wrap:normal;min-height:0;min-width:0;text-align:left;letter-spacing:normal;z-index:2}
.annotation-coordinate-note{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0;padding:6px 10px;font-size:10px;color:var(--ui-muted);border-top:1px solid var(--ui-line);background:var(--ui-panel);flex:none}.annotation-properties{box-sizing:border-box;min-width:0;padding:14px;border-left:1px solid var(--ui-line);display:flex;flex-direction:column;gap:14px;overflow:auto;max-height:600px;background:var(--ui-panel);color:var(--ui-text);font-size:12px}.annotation-coordinate-note.properties-coordinates{padding:0 0 10px;border-top:0;border-bottom:1px solid var(--ui-line);background:none}.annotation-properties.teleported{height:100%;max-height:none;border-left:0;overscroll-behavior:contain}.annotation-properties h3{font-size:12px;margin:0}.annotation-properties label{display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--ui-muted);min-width:0}.annotation-properties input:not([type=range]),.annotation-properties textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--ui-line);border-radius:6px;background:var(--ui-bg);color:var(--ui-text);padding:7px;font:inherit}.annotation-properties input:not([type=range]){height:32px}.annotation-properties input[type=color]{padding:3px}.annotation-properties input[type=range]{width:100%;accent-color:var(--ui-accent)}.annotation-properties textarea{resize:vertical;min-height:68px}.annotation-properties select{width:100%;height:32px}.annotation-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.annotation-property-heading{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.annotation-property-heading>span{font-size:10px;color:var(--ui-muted);width:100%;padding-left:22px}.annotation-selection-help{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;padding:18px 3px;color:var(--ui-muted)}.annotation-selection-help h3{color:var(--ui-text)}.annotation-selection-help p{margin:0;font-size:11px;line-height:1.8}.annotation-brush-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.annotation-brush-cards button{padding:7px 3px;display:flex;flex-direction:column;gap:4px;align-items:center;border:1px solid var(--ui-line);border-radius:7px;background:var(--ui-bg);color:var(--ui-muted);cursor:pointer;font:inherit;font-size:10px}.annotation-brush-cards button.selected{border-color:var(--ui-accent);background:var(--ui-accent-soft);color:var(--ui-text)}.annotation-brush-cards svg{width:100%;height:24px}.annotation-properties .annotation-accessible-select{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.annotation-accessible-select select{width:1px;height:1px}.annotation-swatches{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.annotation-swatches button{width:20px;height:20px;min-width:20px;padding:0;border:2px solid var(--ui-panel);border-radius:50%;background:var(--swatch);box-shadow:0 0 0 1px var(--ui-line);cursor:pointer}.annotation-swatches button[aria-pressed=true]{box-shadow:0 0 0 2px var(--ui-accent)}.annotation-object-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}.annotation-object-actions button{justify-content:center;font-size:11px}
.annotation-items{display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--ui-line);padding-top:12px;min-height:60px;min-width:0}.annotation-layer-heading{display:flex;align-items:center;gap:6px;margin-bottom:4px;color:var(--ui-muted);font-size:11px}.annotation-layer-heading>span:last-child{margin-left:auto;font-variant-numeric:tabular-nums}.annotation-items button{justify-content:flex-start;flex-shrink:0;text-align:left;width:100%}.annotation-items button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.annotation-empty-layers{font-size:10px;margin:0;padding:8px 0;color:var(--ui-muted);line-height:1.6}.annotation-error{color:var(--ui-danger);padding:0 12px}.annotation-limit-notice{margin:0;padding:8px 14px;color:var(--ui-muted);font-size:11px;line-height:1.6;flex:none}
@container annotation-editor (max-width:640px){.image-annotation-editor:not(.external-properties) .annotation-layout{grid-template-columns:1fr}.image-annotation-editor:not(.external-properties) .annotation-properties{border-left:0;border-top:1px solid var(--ui-line);max-height:300px}.annotation-toolbar{padding:8px;gap:4px}.annotation-toolbar button{font-size:10px;padding:4px 6px}.annotation-coordinate-note{font-size:9px}}
</style>
