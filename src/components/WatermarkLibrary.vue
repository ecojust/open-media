<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { applyChromaKey, createChromaKey } from '../core/chroma-key'
import { WATERMARK_CATEGORIES, WATERMARK_MATERIALS, type WatermarkMaterial } from '../core/watermark-library'
import { chooseWatermarkSource } from '../core/watermark-source'
import type { TextWatermarkOptions } from '../core/watermark-track'
import TextWatermarkCustomizer from './TextWatermarkCustomizer.vue'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ busy?: boolean; error?: string; projectWidth?: number; projectHeight?: number }>(), { busy: false, error: '' })
const emit = defineEmits<{ select: [material: WatermarkMaterial, options?: TextWatermarkOptions]; 'import-local': [] }>()
const search = ref(''), category = ref('全部'), activePreviewId = ref(''), previewReady = ref(false), failedPreviewId = ref('')
const collection = ref<'all' | 'science' | 'general'>('general')
const customizing = ref<WatermarkMaterial>()
const generalCount = WATERMARK_MATERIALS.filter(material => material.collection === 'general').length
const scienceCount = WATERMARK_MATERIALS.filter(material => material.collection === 'science').length
const collectionMaterials = computed(() => WATERMARK_MATERIALS.filter(material => collection.value === 'all' || material.collection === collection.value))
const scroller = ref<HTMLElement | null>(null)
const categories = ['全部', ...WATERMARK_CATEGORIES]
const page = ref(1), pageSize = 24
const categoryCounts = computed(() => Object.fromEntries(categories.map(item => [item, item === '全部' ? collectionMaterials.value.length : collectionMaterials.value.filter(material => material.category === item).length])))
const visibleCategories = computed(() => categories.filter(item => collection.value === 'all' || categoryCounts.value[item]))
const filteredMaterials = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return collectionMaterials.value.filter(material => (category.value === '全部' || material.category === category.value)
    && (!query || [material.name, material.category, material.textTemplate?.text ?? '', ...material.tags].join(' ').toLocaleLowerCase().includes(query)))
})
const pageCount = computed(() => Math.max(1, Math.ceil(filteredMaterials.value.length / pageSize)))
const visibleMaterials = computed(() => filteredMaterials.value.slice((page.value - 1) * pageSize, page.value * pageSize))
let video: HTMLVideoElement | null = null, previewCanvas: HTMLCanvasElement | null = null
let frame = 0, generation = 0, lastFrame = 0

function bindCanvas(element: Element | ComponentPublicInstance | null): void {
  previewCanvas = element instanceof HTMLCanvasElement ? element : null
}
function stopPreview(): void {
  generation += 1
  cancelAnimationFrame(frame)
  frame = 0
  activePreviewId.value = ''
  previewReady.value = false
  if (video) {
    video.onerror = null
    video.pause()
    video.removeAttribute('src')
    video.load()
    video = null
  }
}
function failedPreview(id: string, token: number): void {
  if (token !== generation) return
  stopPreview()
  failedPreviewId.value = id
}
async function startPreview(material: WatermarkMaterial, explicit = false): Promise<void> {
  if (props.busy || material.kind !== 'video' || activePreviewId.value === material.id) return
  if (!explicit && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  stopPreview()
  const token = generation
  const greenKey = createChromaKey({ spillSuppression: material.spillSuppression })
  activePreviewId.value = material.id
  failedPreviewId.value = ''
  const media = document.createElement('video')
  video = media
  media.muted = true
  media.defaultMuted = true
  media.loop = true
  media.playsInline = true
  media.preload = 'auto'
  media.crossOrigin = 'anonymous'
  media.src = chooseWatermarkSource(material, media)
  media.onerror = () => failedPreview(material.id, token)
  await nextTick()
  if (token !== generation) return
  try {
    await media.play()
    if (token !== generation) return
    const canvas = previewCanvas
    if (!canvas) { stopPreview(); return }
    const context = canvas.getContext('2d', { willReadFrequently: !!material.chromaKey })
    if (!context) throw new Error('预览暂时不可用')
    canvas.width = 320
    canvas.height = Math.max(1, Math.round(320 * material.height / material.width))
    lastFrame = 0
    const draw = (time: number): void => {
      if (token !== generation) return
      if (time - lastFrame >= 1000 / 24 && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
          context.clearRect(0, 0, canvas.width, canvas.height)
          context.drawImage(media, 0, 0, canvas.width, canvas.height)
          if (material.chromaKey) {
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
            applyChromaKey(pixels.data, greenKey)
            context.putImageData(pixels, 0, 0)
          }
          previewReady.value = true
          lastFrame = time
        } catch { failedPreview(material.id, token); return }
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
  } catch { failedPreview(material.id, token) }
}
function togglePreview(material: WatermarkMaterial): void {
  if (material.kind === 'text') { add(material); return }
  if (activePreviewId.value === material.id) stopPreview()
  else void startPreview(material, true)
}
function focusPreview(event: FocusEvent, material: WatermarkMaterial): void {
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.matches(':focus-visible')) void startPreview(material)
}
function leavePreview(id: string): void { if (activePreviewId.value === id) stopPreview() }
function add(material: WatermarkMaterial): void {
  if (props.busy) return
  stopPreview()
  if (material.kind === 'text' && material.collection === 'general') { customizing.value = material; return }
  emit('select', material)
}
function addCustomized(options: TextWatermarkOptions): void { if (customizing.value && !props.busy) emit('select', customizing.value, options) }
function importLocal(): void { if (!props.busy) { stopPreview(); emit('import-local') } }
function visibilityChanged(): void { if (document.hidden) stopPreview() }
function resetPagePreview(): void { stopPreview(); failedPreviewId.value = ''; if (scroller.value) scroller.value.scrollTop = 0 }
watch([search, category], () => { page.value = 1; resetPagePreview() })
watch(collection, () => { category.value = '全部'; page.value = 1; resetPagePreview() })
watch(page, resetPagePreview)
watch(() => props.busy, busy => { if (busy) stopPreview() })
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged))
onBeforeUnmount(() => { document.removeEventListener('visibilitychange', visibilityChanged); stopPreview() })
</script>

<template>
  <TextWatermarkCustomizer v-if="customizing" :material="customizing" :busy="busy" :project-width="projectWidth" :project-height="projectHeight" :error="error" @back="customizing = undefined" @add="addCustomized" />
  <section v-else class="watermark-library" :class="{ 'science-collection': collection !== 'all' }" data-testid="watermark-library" aria-label="水印素材库" :aria-busy="busy">
    <div class="library-toolbar">
      <label class="material-search"><Icon name="search" :size="16" /><input v-model="search" type="search" aria-label="搜索水印素材" placeholder="搜索题材、动画、文字…" autocomplete="off" :disabled="busy" data-testid="watermark-search" /></label>
      <button type="button" class="import-local" :disabled="busy" data-testid="watermark-import-local" @click="importLocal"><Icon name="import" :size="15" /><span>导入素材</span></button>
    </div>
    <div class="material-collections" role="group" aria-label="水印素材专题">
      <button type="button" :aria-pressed="collection === 'general'" :disabled="busy" data-testid="watermark-collection-general" @click="collection = 'general'">通用样式<span>{{ generalCount }}</span></button>
      <button type="button" :aria-pressed="collection === 'all'" :disabled="busy" data-testid="watermark-collection-all" @click="collection = 'all'">全部素材</button>
      <button type="button" :aria-pressed="collection === 'science'" :disabled="busy" data-testid="watermark-collection-science" @click="collection = 'science'">科普精选<span>{{ scienceCount }}</span></button>
      <span class="collection-hint">{{ collection === 'general' ? '自由改字 · 配色 · 入退场动画' : '标题 · 标注 · 装饰' }}</span>
    </div>
    <div class="material-categories" role="group" aria-label="水印素材分类">
      <button v-for="item in visibleCategories" :key="item" type="button" :aria-pressed="category === item" :disabled="busy" :data-watermark-category="item" @click="category = item">{{ item }}<span class="category-count">{{ categoryCounts[item] }}</span></button>
    </div>
    <div class="library-summary"><span>{{ filteredMaterials.length }} 个{{ search.trim() ? '匹配' : '内置' }}素材</span><span><Icon name="volume-off" :size="12" />悬停预览 · 从当前刻度添加</span></div>
    <p v-if="error" class="library-error" role="alert" data-testid="watermark-error">{{ error }}</p>
    <div ref="scroller" class="material-scroller" data-testid="watermark-scroller" @scroll="stopPreview">
      <div v-if="visibleMaterials.length" class="material-grid">
        <article v-for="material in visibleMaterials" :key="material.id" class="material-card" :data-watermark-id="material.id">
          <button type="button" class="material-preview" :class="{ previewing: activePreviewId === material.id, 'preview-ready': activePreviewId === material.id && previewReady }" :disabled="busy || material.kind === 'image'" :aria-label="`${material.kind === 'text' ? '添加并编辑' : activePreviewId === material.id ? '停止预览' : '预览'} ${material.name}`" :aria-pressed="material.kind === 'video' ? activePreviewId === material.id : undefined" @pointerenter="($event.pointerType === 'mouse') && startPreview(material)" @pointerleave="leavePreview(material.id)" @focus="focusPreview($event, material)" @blur="leavePreview(material.id)" @click="togglePreview(material)">
            <img :src="material.poster" alt="" loading="lazy" draggable="false" />
            <canvas v-if="activePreviewId === material.id" :ref="bindCanvas" :class="{ ready: previewReady }" aria-hidden="true" />
            <span class="material-type" :class="{ editable: material.kind === 'text' }">{{ material.kind === 'text' ? '可编辑文字' : material.chromaKey ? '绿幕动效' : material.kind === 'video' ? '动画' : '贴纸' }}</span>
            <span v-if="material.kind === 'video'" class="preview-indicator" aria-hidden="true"><Icon :name="activePreviewId === material.id ? 'pause' : 'play'" :size="13" /></span>
            <span v-if="failedPreviewId === material.id" class="preview-unavailable">预览暂不可用</span>
          </button>
          <div class="material-detail"><div><strong :title="material.name">{{ material.name }}</strong><span>{{ material.category }}<i />{{ material.duration }} 秒</span></div><button type="button" class="material-add" :aria-label="`添加 ${material.name}`" :title="`从当前刻度添加 ${material.name}`" :disabled="busy" :data-watermark-add="material.id" @click="add(material)"><Icon name="plus" :size="17" /></button></div>
        </article>
      </div>
      <div v-else class="material-empty" role="status"><Icon name="search" :size="28" /><strong>没有找到匹配的素材</strong><span>试试其他关键词，或导入自己的图片、视频。</span><button type="button" :disabled="busy" @click="search = ''; category = '全部'; collection = 'all'">查看全部素材</button></div>
    </div>
    <nav v-if="pageCount > 1" class="material-pagination" aria-label="水印素材分页" data-testid="watermark-pagination">
      <button type="button" :disabled="busy || page === 1" data-testid="watermark-previous-page" @click="page--">上一页</button>
      <span role="status" aria-live="polite">第 {{ page }} / {{ pageCount }} 页 · 每页 {{ pageSize }} 个</span>
      <button type="button" :disabled="busy || page === pageCount" data-testid="watermark-next-page" @click="page++">下一页</button>
    </nav>
    <p class="library-note"><Icon name="layers" :size="14" /><span>素材添加到独立水印轨道；可调整位置、大小和时长。文字水印添加后可在片段属性中直接改文案，绿幕素材自动去除绿色背景。</span></p>
  </section>
</template>

<style scoped>
.watermark-library{box-sizing:border-box;min-width:0;padding:16px;color:var(--ed-text);font-size:12px;line-height:1.5;container-type:inline-size}
.library-toolbar{display:flex;align-items:center;gap:9px;margin-bottom:12px;min-width:0}
.material-search{position:relative;display:flex;align-items:center;flex:1;min-width:0;color:var(--ed-muted)}
.material-search>svg{position:absolute;left:11px;pointer-events:none}
.watermark-library .material-search input{box-sizing:border-box;width:100%;min-width:0;height:36px;padding:7px 28px 7px 35px;border:1px solid var(--ed-border);border-radius:8px;background:var(--ed-bg);color:var(--ed-text);font:inherit;font-size:12px;line-height:20px}
.watermark-library button{box-sizing:border-box;font:inherit;cursor:pointer}
.watermark-library .import-local{display:flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;min-height:36px;padding:6px 11px;border:1px solid var(--ed-border);border-radius:8px;background:var(--ed-panel);color:var(--ed-text);font-size:11px;white-space:nowrap}
.watermark-library .import-local:hover:not(:disabled){border-color:var(--ed-accent);color:var(--ed-accent);background:var(--ed-bg)}
.material-collections{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:12px;padding-bottom:11px;border-bottom:1px solid var(--ed-border)}
.material-collections>button{display:flex;align-items:center;gap:6px;min-height:30px;padding:4px 10px;border:1px solid var(--ed-border);border-radius:7px;background:var(--ed-panel);color:var(--ed-muted);font-size:11px}
.material-collections>button[aria-pressed=true]{border-color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 12%,var(--ed-panel));color:var(--ed-accent)}
.material-collections>button>span{font-size:9px;font-variant-numeric:tabular-nums;opacity:.8}
.collection-hint{margin-left:auto;color:var(--ed-muted);font-size:10px;line-height:1.6}
.material-categories{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-bottom:10px}
.watermark-library .material-categories button{display:block;flex-shrink:0;min-height:29px;padding:4px 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--ed-muted);font-size:11px;line-height:19px;white-space:nowrap}
.watermark-library .material-categories button:hover:not(:disabled){color:var(--ed-text);background:var(--ed-bg)}
.watermark-library .material-categories button[aria-pressed=true]{border-color:color-mix(in srgb,var(--ed-accent) 20%,var(--ed-border));background:color-mix(in srgb,var(--ed-accent) 9%,var(--ed-panel));color:var(--ed-accent);font-weight:600}
.category-count{display:inline-block;margin-left:5px;font-size:9px;font-variant-numeric:tabular-nums;opacity:.75}
.library-summary{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:5px 12px;margin-bottom:10px;color:var(--ed-muted);font-size:10px}
.library-summary>span:last-child{display:flex;align-items:center;gap:4px}
.material-scroller{max-height:min(440px,calc(100dvh - 260px));min-height:110px;overflow:auto;overscroll-behavior:contain;padding:2px 4px 3px 2px;margin:-2px -4px -3px -2px;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent}
.material-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.material-card{min-width:0;border:1px solid var(--ed-border);border-radius:9px;background:var(--ed-panel);overflow:hidden}
.watermark-library .material-preview{display:block;position:relative;width:100%;min-height:0;padding:0;aspect-ratio:16/9;overflow:hidden;border:0;border-bottom:1px solid var(--ed-border);border-radius:0;background-color:color-mix(in srgb,var(--ed-bg) 65%,var(--ed-panel));background-image:conic-gradient(var(--ed-border) 25%,transparent 0 50%,var(--ed-border) 0 75%,transparent 0);background-size:16px 16px;color:var(--ed-text)}
.material-preview img,.material-preview canvas{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;user-select:none}
.science-collection .material-preview{background-color:#15212d;background-image:conic-gradient(#1b2936 25%,transparent 0 50%,#1b2936 0 75%,transparent 0);background-size:24px 24px}
.material-preview canvas{opacity:0}
.material-preview canvas.ready{opacity:1}
.material-preview.preview-ready img{opacity:0}
.material-type{position:absolute;left:7px;top:7px;padding:2px 5px;border:1px solid #ffffff25;border-radius:4px;background:#202637d6;color:#fff;font-size:8px;line-height:12px;pointer-events:none}
.material-type.editable{background:#17604ee8;border-color:#a0ebd67a}
.preview-indicator{position:absolute;right:7px;bottom:7px;display:flex;align-items:center;justify-content:center;width:23px;height:23px;border:1px solid #ffffff60;border-radius:50%;background:#202637bb;color:#fff;pointer-events:none}
.material-preview.previewing .preview-indicator{background:var(--ed-accent)}
.preview-unavailable{position:absolute;bottom:6px;left:6px;padding:2px 5px;border-radius:4px;background:#202637e8;color:#fff;font-size:9px;line-height:14px;pointer-events:none}
.material-detail{display:flex;align-items:center;gap:6px;padding:9px}
.material-detail>div{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.material-detail strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:600}
.material-detail>div>span{display:flex;align-items:center;gap:5px;min-width:0;color:var(--ed-muted);font-size:9px;white-space:nowrap}
.material-detail i{display:block;width:2px;height:2px;border-radius:50%;background:currentColor;opacity:.65}
.watermark-library .material-add{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:27px;min-height:27px;padding:0;border:1px solid color-mix(in srgb,var(--ed-accent) 22%,var(--ed-border));border-radius:7px;background:color-mix(in srgb,var(--ed-accent) 8%,var(--ed-panel));color:var(--ed-accent)}
.watermark-library .material-add:hover:not(:disabled){border-color:var(--ed-accent);background:var(--ed-accent);color:#fff}
.material-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:12px;color:var(--ed-muted);font-size:10px;font-variant-numeric:tabular-nums}
.watermark-library .material-pagination button{min-height:29px;padding:4px 10px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-panel);color:var(--ed-text);font-size:11px}
.watermark-library .material-pagination button:hover:not(:disabled){color:var(--ed-accent);border-color:var(--ed-accent)}
.library-note{display:flex;align-items:flex-start;gap:7px;margin:13px 0 0;padding-top:11px;border-top:1px solid var(--ed-border);color:var(--ed-muted);font-size:10px;line-height:1.65}
.library-note svg{flex-shrink:0;margin-top:1px;color:var(--ed-accent)}
.library-error{padding:9px 11px;margin:0 0 10px;border:1px solid color-mix(in srgb,#d95751 30%,var(--ed-border));border-radius:7px;background:color-mix(in srgb,#d95751 8%,var(--ed-panel));color:color-mix(in srgb,#d95751 75%,var(--ed-text));font-size:11px;overflow-wrap:anywhere}
.material-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:36px 15px;text-align:center;color:var(--ed-muted);font-size:11px}
.material-empty strong{color:var(--ed-text);font-size:12px;font-weight:500}
.watermark-library .material-empty button{margin-top:3px;padding:6px 10px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-panel);color:var(--ed-accent);font-size:11px}
.watermark-library button:disabled,.watermark-library input:disabled{opacity:.55;cursor:not-allowed}
.watermark-library .material-preview:disabled{opacity:1}
.watermark-library button:focus-visible,.watermark-library input:focus-visible{outline:2px solid var(--ed-accent);outline-offset:-2px}
@container(max-width:470px){.material-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.material-detail{padding:7px}.material-detail strong{font-size:10px}.material-detail>div>span{font-size:8px;gap:4px}.watermark-library .material-add{width:24px;min-height:24px}.watermark-library .material-categories button{font-size:10px;padding:4px 7px}}
@media(max-width:380px){.watermark-library{padding:12px}.library-toolbar{flex-wrap:wrap;gap:7px}.material-search{flex-basis:100%}.watermark-library .import-local{min-height:30px;margin-left:auto;padding:4px 8px}.library-summary{font-size:9px}.material-scroller{max-height:min(400px,calc(100dvh - 315px))}}
@media(max-height:480px){.material-scroller{max-height:210px}.library-note{margin-top:9px;padding-top:8px}.watermark-library{padding:12px}}
</style>
