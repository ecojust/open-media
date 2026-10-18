<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { VIDEO_SEGMENTS, type VideoSegmentCaption, type VideoSegmentItem, type VideoSegmentPlacement } from '../core/video-segment-catalog'
import type { VideoSegmentTitleLayout } from '../core/video-segment-presets'
import { videoSegmentTextLayout, type VideoSegmentTextBox } from '../core/video-segment-layout'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ placement?: VideoSegmentPlacement; busy?: boolean; error?: string }>(), { placement: 'prepend', busy: false, error: '' })
const emit = defineEmits<{ select: [item: VideoSegmentItem, placement: VideoSegmentPlacement, caption: VideoSegmentCaption]; 'import-local': [placement: VideoSegmentPlacement] }>()
const collection = ref<'all' | 'science' | 'general'>('general')
const placementItems = computed(() => VIDEO_SEGMENTS.filter(item => item.placement === props.placement))
const scienceCount = computed(() => placementItems.value.filter(item => item.collection === 'science').length)
const generalCount = computed(() => placementItems.value.filter(item => item.collection === 'general').length)
const items = computed(() => placementItems.value.filter(item => collection.value === 'all' || item.collection === collection.value))
const segmentTitle = computed(() => props.placement === 'prepend' ? '片头' : '片尾')
const selectedId = ref(items.value[0]!.id)
const selected = computed(() => items.value.find(item => item.id === selectedId.value) ?? items.value[0]!)
const heading = ref(selected.value.heading), subheading = ref(selected.value.subheading)
const duration = ref(selected.value.duration)
const layout = ref<VideoSegmentTitleLayout>(selected.value.layout ?? 'center')
const textLayout = computed(() => videoSegmentTextLayout(selected.value.width, selected.value.height, layout.value, Boolean(subheading.value.trim())))
const validDuration = computed(() => Number.isFinite(duration.value) && duration.value >= 2 && duration.value <= 12)
const preview = ref<HTMLVideoElement | null>(null), playing = ref(false), previewError = ref('')
let playbackToken = 0

function textBoxStyle(box: VideoSegmentTextBox, item: VideoSegmentItem = selected.value) {
  return { left: `${box.x / item.width * 100}%`, top: `${box.y / item.height * 100}%`, width: `${box.width / item.width * 100}%`, height: `${box.height / item.height * 100}%`,
    fontSize: `${box.fontSize / item.width * 100}cqw`, textAlign: box.textAlign, justifyContent: box.textAlign === 'left' ? 'flex-start' : box.textAlign === 'right' ? 'flex-end' : 'center' }
}
function thumbnailTitleStyle(item: VideoSegmentItem) { return textBoxStyle(videoSegmentTextLayout(item.width, item.height, item.layout, Boolean(item.subheading)).heading, item) }

function stopPreview(): void {
  playbackToken += 1
  preview.value?.pause()
  playing.value = false
}
function choose(item: VideoSegmentItem): void {
  if (props.busy || item.placement !== props.placement) return
  stopPreview()
  selectedId.value = item.id
  heading.value = item.heading
  subheading.value = item.subheading
  duration.value = item.duration
  layout.value = item.layout ?? 'center'
  previewError.value = ''
}
async function togglePreview(): Promise<void> {
  if (props.busy || !preview.value) return
  if (playing.value) { stopPreview(); return }
  const token = ++playbackToken
  const video = preview.value
  previewError.value = ''
  try {
    setPreviewSpeed()
    await video.play()
    if (token !== playbackToken) return
    playing.value = true
  } catch {
    if (token !== playbackToken) return
    playing.value = false
    previewError.value = '视频预览暂时不可用，请重试。'
  }
}
function add(): void {
  if (props.busy || !validDuration.value) return
  stopPreview()
  emit('select', selected.value, props.placement, { heading: heading.value.trim(), subheading: subheading.value.trim(), textColor: selected.value.textColor, duration: duration.value, layout: layout.value })
}
function setPreviewSpeed(): void {
  if (preview.value && validDuration.value) preview.value.playbackRate = selected.value.duration / duration.value
}
watch(duration, setPreviewSpeed)
function importLocal(): void {
  if (props.busy) return
  stopPreview()
  emit('import-local', props.placement)
}
watch([() => props.placement, collection], () => {
  stopPreview()
  selectedId.value = items.value[0]!.id
  heading.value = selected.value.heading
  subheading.value = selected.value.subheading
  duration.value = selected.value.duration
  layout.value = selected.value.layout ?? 'center'
  previewError.value = ''
})
watch(() => props.busy, busy => { if (busy) stopPreview() })
function visibilityChanged(): void { if (document.hidden) stopPreview() }
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged))
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', visibilityChanged)
  stopPreview()
  if (preview.value) { preview.value.removeAttribute('src'); preview.value.load() }
})
</script>

<template>
  <section class="segment-library" data-testid="video-segment-library" :data-placement="placement" :aria-busy="busy" :aria-label="`${segmentTitle}素材库`">
    <div class="segment-toolbar">
      <div><strong>{{ placement === 'prepend' ? '用精彩开场开启故事' : '为故事留下动人余韵' }}</strong><span>{{ items.length }} 款原创{{ segmentTitle }}模板 · 离线可用 · 标题可编辑</span></div>
      <button type="button" class="segment-import" :disabled="busy" data-testid="video-segment-import-local" @click="importLocal"><Icon name="upload" :size="15" />导入{{ segmentTitle }}</button>
    </div>
    <div class="segment-collections" role="group" aria-label="筛选模板主题">
      <button type="button" :aria-pressed="collection === 'general'" :disabled="busy" data-testid="video-segment-collection-general" @click="collection = 'general'">通用 <span>{{ generalCount }}</span></button>
      <button type="button" :aria-pressed="collection === 'all'" :disabled="busy" data-testid="video-segment-collection-all" @click="collection = 'all'">全部 <span>{{ placementItems.length }}</span></button>
      <button type="button" :aria-pressed="collection === 'science'" :disabled="busy" data-testid="video-segment-collection-science" @click="collection = 'science'">科普精选 <span>{{ scienceCount }}</span></button>
    </div>
    <div class="segment-body">
      <div class="segment-grid" role="group" :aria-label="`选择${segmentTitle}模板`">
        <button v-for="item in items" :key="item.id" type="button" class="segment-card" :class="{ selected: item.id === selectedId }" :aria-pressed="item.id === selectedId" :disabled="busy" :data-segment-id="item.id" data-testid="video-segment-item" @click="choose(item)">
          <span class="segment-thumbnail" :style="{ color: item.textColor }"><img :src="item.posterUrl" alt="" loading="lazy" /><span :style="thumbnailTitleStyle(item)">{{ item.heading }}</span><small>{{ item.placement === 'prepend' ? '片头' : '片尾' }} · {{ item.duration }} 秒</small></span>
          <span class="segment-card-label"><strong>{{ item.title }}</strong><span>{{ item.style }}</span><Icon v-if="item.id === selectedId" name="check" :size="13" /></span>
        </button>
      </div>
      <div class="segment-customize">
        <div class="segment-preview" :class="{ 'lower-caption': layout === 'lower-third' }" :style="{ color: selected.textColor }">
          <video :key="selected.id" ref="preview" :src="selected.url" :poster="selected.posterUrl" muted loop playsinline preload="none" @loadedmetadata="setPreviewSpeed" @pause="playing = false" @error="previewError = '视频预览暂时不可用，请重试。'" />
          <div class="segment-preview-titles" :data-layout="layout"><strong :style="textBoxStyle(textLayout.heading)">{{ heading }}</strong><span :style="textBoxStyle(textLayout.subheading)">{{ subheading }}</span></div>
          <button type="button" :disabled="busy" :aria-label="playing ? '暂停模板预览' : '播放模板预览'" :title="playing ? '暂停预览' : '播放预览'" data-testid="video-segment-preview" @click="togglePreview"><Icon :name="playing ? 'pause' : 'play'" :size="16" /></button>
        </div>
        <p class="segment-description">{{ selected.description }}</p>
        <label class="segment-field"><span>标题</span><input v-model="heading" maxlength="120" :disabled="busy" data-testid="video-segment-heading" placeholder="留空则不添加标题" /></label>
        <label class="segment-field"><span>副标题</span><input v-model="subheading" maxlength="240" :disabled="busy" data-testid="video-segment-subheading" placeholder="留空则不添加副标题" /></label>
        <label class="segment-field"><span>文字布局</span><select v-model="layout" :disabled="busy" data-testid="video-segment-layout"><option value="center">居中</option><option value="left">左对齐</option><option value="lower-third">下方落款</option></select></label>
        <label class="segment-field segment-duration"><span>时长 <small>完整播放动画</small></span><span class="segment-duration-control"><input v-model.number="duration" type="number" min="2" max="12" step="0.5" :disabled="busy" :aria-invalid="!validDuration" data-testid="video-segment-duration" />秒</span></label>
        <p class="segment-caption-note"><Icon name="text" :size="13" />加入后可在时间线中继续编辑文字与位置。</p>
      </div>
    </div>
    <p class="segment-placement-note"><Icon :name="placement === 'prepend' ? 'skip-back' : 'skip-forward'" :size="14" /><span>{{ placement === 'prepend' ? '片头放在项目开头，现有轨道片段整体后移。' : '片尾放在全部轨道的末尾，现有片段位置保持不变。' }}</span></p>
    <p class="segment-message" :class="{ error: error || previewError || !validDuration }" role="status" aria-live="polite" data-testid="video-segment-error"><template v-if="error || previewError || !validDuration"><Icon name="alert" :size="13" />{{ error || previewError || '请选择 2 至 12 秒的模板时长。' }}</template><template v-else>视频保持项目画面尺寸；本地视频作为{{ segmentTitle }}插入，不附加模板标题。</template></p>
    <footer class="segment-footer"><span>{{ selected.title }} · {{ validDuration ? duration : '—' }} 秒</span><button type="button" class="segment-add" :disabled="busy || !validDuration" data-testid="video-segment-add" @click="add"><Icon :name="busy ? 'clock' : 'plus'" :size="15" />{{ busy ? '正在添加…' : placement === 'prepend' ? '添加到项目开头' : '添加到项目结尾' }}</button></footer>
  </section>
</template>

<style scoped>
.segment-library{padding:16px;font-size:12px;color:var(--ed-text);container-type:inline-size}
.segment-library button,.segment-library input,.segment-library select{font:inherit;box-sizing:border-box}
.segment-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px}
.segment-toolbar>div{display:flex;flex-direction:column;gap:4px;min-width:0}
.segment-toolbar strong{font-size:13px;font-weight:600}.segment-toolbar span{color:var(--ed-muted);font-size:11px}
.segment-collections{display:flex;align-items:center;gap:6px;margin:-4px 0 13px}.segment-collections button{display:flex;align-items:center;gap:7px;min-height:30px;padding:4px 10px;border:1px solid transparent;border-radius:7px;color:var(--ed-muted);background:transparent;cursor:pointer}.segment-collections button[aria-pressed=true]{border-color:color-mix(in srgb,var(--ed-accent) 24%,var(--ed-border));background:color-mix(in srgb,var(--ed-accent) 9%,var(--ed-panel));color:var(--ed-accent)}.segment-collections span{font-size:10px;opacity:.7}
.segment-import{display:flex;align-items:center;gap:6px;min-height:34px;flex-shrink:0;padding:6px 10px;border:1px solid var(--ed-border);border-radius:8px;color:var(--ed-text);background:var(--ed-panel);cursor:pointer}
.segment-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(225px,.85fr);gap:16px}
.segment-grid{display:grid;grid-auto-rows:max-content;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:10px;max-height:min(410px,calc(100dvh - 360px));min-height:200px;padding:2px 7px 2px 2px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent}
.segment-card{display:flex;flex-direction:column;min-width:0;padding:0;text-align:left;border:1px solid var(--ed-border);border-radius:9px;background:var(--ed-panel);color:var(--ed-text);overflow:hidden;cursor:pointer}
.segment-card.selected{border-color:var(--ed-accent);box-shadow:0 0 0 1px var(--ed-accent)}
.segment-thumbnail{display:block;flex-shrink:0;position:relative;aspect-ratio:16/9;width:100%;overflow:hidden;background:#171b28;container-type:inline-size}
.segment-thumbnail img{display:block;width:100%;height:100%;object-fit:cover}
.segment-thumbnail>span{position:absolute;display:flex;align-items:center;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
.segment-thumbnail small{position:absolute;bottom:6px;left:6px;padding:1px 5px;border-radius:4px;color:#fff;background:#10121899;font-size:9px}
.segment-card-label{display:flex;flex-wrap:wrap;align-items:center;gap:3px 6px;padding:7px 8px;min-width:0}
.segment-card-label strong{font-size:11px;font-weight:600}.segment-card-label>span{font-size:10px;color:var(--ed-muted)}.segment-card-label svg{margin-left:auto;color:var(--ed-accent)}
.segment-customize{min-width:0}.segment-preview{position:relative;aspect-ratio:16/9;border:1px solid var(--ed-border);border-radius:10px;overflow:hidden;background:#171b28;container-type:inline-size}
.segment-preview video{display:block;width:100%;height:100%;object-fit:cover}.segment-preview-titles{position:absolute;inset:0;pointer-events:none}
.segment-preview-titles strong,.segment-preview-titles span{position:absolute;display:flex;align-items:center;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.2}.segment-preview-titles strong{font-weight:600}
.segment-preview>button{position:absolute;bottom:8px;right:8px;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid #ffffff50;border-radius:50%;color:white;background:#141620a8;cursor:pointer}
.segment-preview.lower-caption>button{top:8px;bottom:auto}
.segment-description{font-size:10px;color:var(--ed-muted);line-height:1.6;min-height:32px;margin:10px 0}
.segment-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;font-size:11px;color:var(--ed-muted)}
.segment-field input{width:100%;min-width:0;height:34px;padding:7px 9px;border:1px solid var(--ed-border);border-radius:7px;background:var(--ed-bg);color:var(--ed-text);outline:none}
.segment-field select{width:100%;border-color:var(--ed-border);background-color:var(--ed-bg);color:var(--ed-text)}
.segment-field input:focus{border-color:var(--ed-accent)}.segment-caption-note{display:flex;align-items:flex-start;gap:5px;color:var(--ed-muted);font-size:10px;line-height:1.6}.segment-caption-note svg{flex-shrink:0;margin-top:2px}
.segment-duration>span:first-child{display:flex;align-items:center;justify-content:space-between;gap:8px}.segment-duration small{font-size:10px;color:var(--ed-muted);font-weight:400}.segment-duration-control{display:flex;align-items:center;gap:8px}.segment-duration-control input{width:92px}.segment-field input[aria-invalid=true]{border-color:var(--ed-danger,#e16b75)}
.segment-placement-note{display:flex;align-items:center;gap:7px;margin:16px 0 0;padding:9px 10px;border:1px solid var(--ed-border);border-radius:8px;background:var(--ed-bg);font-size:11px;line-height:1.6;color:var(--ed-text)}.segment-placement-note svg{flex-shrink:0;color:var(--ed-muted)}
.segment-message{display:flex;align-items:flex-start;gap:5px;min-height:18px;margin:10px 0;color:var(--ed-muted);font-size:10px;line-height:18px}.segment-message.error{color:var(--ed-danger,#e16b75)}.segment-message svg{flex-shrink:0;margin-top:2px}
.segment-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;border-top:1px solid var(--ed-border)}.segment-footer>span{font-size:11px;color:var(--ed-muted)}
.segment-add{display:flex;align-items:center;justify-content:center;gap:6px;min-height:35px;padding:7px 12px;border:1px solid var(--ed-accent);border-radius:8px;background:var(--ed-accent);color:white;font-weight:600;cursor:pointer}
.segment-library button:disabled{cursor:default;opacity:.5}.segment-library button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}.segment-import:hover:not(:disabled){border-color:var(--ed-accent)}
@container(max-width:600px){.segment-body{grid-template-columns:1fr}.segment-grid{max-height:220px;min-height:150px;grid-template-columns:repeat(3,minmax(0,1fr))}.segment-customize{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px}.segment-preview{grid-row:span 3}.segment-description{display:none}.segment-caption-note{grid-column:1/-1;margin:0}.segment-field{margin:0}.segment-preview-titles strong{font-size:12px}.segment-preview-titles span{font-size:7px}}
@container(max-width:380px){.segment-toolbar{align-items:flex-start;flex-direction:column}.segment-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.segment-customize{grid-template-columns:1fr}.segment-preview{grid-row:auto}.segment-footer{align-items:stretch;flex-direction:column}.segment-preview-titles strong{font-size:17px}.segment-preview-titles span{font-size:8px}}
</style>
