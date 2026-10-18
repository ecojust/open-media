<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { VIDEO_SEGMENTS, type VideoSegmentCaption, type VideoSegmentItem, type VideoSegmentPlacement } from '../core/video-segment-catalog'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ busy?: boolean; error?: string }>(), { busy: false, error: '' })
const emit = defineEmits<{ select: [item: VideoSegmentItem, placement: VideoSegmentPlacement, caption: VideoSegmentCaption]; 'import-local': [placement: VideoSegmentPlacement] }>()
const selectedId = ref(VIDEO_SEGMENTS[0]!.id)
const placement = ref<VideoSegmentPlacement>('prepend')
const selected = computed(() => VIDEO_SEGMENTS.find(item => item.id === selectedId.value)!)
const heading = ref(selected.value.heading), subheading = ref(selected.value.subheading)
const preview = ref<HTMLVideoElement | null>(null), playing = ref(false), previewError = ref('')
let playbackToken = 0

function stopPreview(): void {
  playbackToken += 1
  preview.value?.pause()
  playing.value = false
}
function choose(item: VideoSegmentItem): void {
  if (props.busy) return
  stopPreview()
  selectedId.value = item.id
  placement.value = item.placement
  heading.value = item.heading
  subheading.value = item.subheading
  previewError.value = ''
}
async function togglePreview(): Promise<void> {
  if (props.busy || !preview.value) return
  if (playing.value) { stopPreview(); return }
  const token = ++playbackToken
  const video = preview.value
  previewError.value = ''
  try {
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
  if (props.busy) return
  stopPreview()
  emit('select', selected.value, placement.value, { heading: heading.value.trim(), subheading: subheading.value.trim(), textColor: selected.value.textColor })
}
function importLocal(): void {
  if (props.busy) return
  stopPreview()
  emit('import-local', placement.value)
}
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
  <section class="segment-library" data-testid="video-segment-library" :aria-busy="busy" aria-label="视频片段素材库">
    <div class="segment-toolbar">
      <div><strong>给故事一个完整的开场与结尾</strong><span>10 款原创动态模板 · 离线可用 · 标题可编辑</span></div>
      <button type="button" class="segment-import" :disabled="busy" data-testid="video-segment-import-local" @click="importLocal"><Icon name="upload" :size="15" />导入视频</button>
    </div>
    <div class="segment-body">
      <div class="segment-grid" role="group" aria-label="选择片头或片尾模板">
        <button v-for="item in VIDEO_SEGMENTS" :key="item.id" type="button" class="segment-card" :class="{ selected: item.id === selectedId }" :aria-pressed="item.id === selectedId" :disabled="busy" :data-segment-id="item.id" data-testid="video-segment-item" @click="choose(item)">
          <span class="segment-thumbnail" :style="{ color: item.textColor }"><img :src="item.posterUrl" alt="" loading="lazy" /><span>{{ item.heading }}</span><small>{{ item.placement === 'prepend' ? '片头' : '片尾' }} · {{ item.duration }} 秒</small></span>
          <span class="segment-card-label"><strong>{{ item.title }}</strong><span>{{ item.style }}</span><Icon v-if="item.id === selectedId" name="check" :size="13" /></span>
        </button>
      </div>
      <div class="segment-customize">
        <div class="segment-preview" :style="{ color: selected.textColor }">
          <video :key="selected.id" ref="preview" :src="selected.url" :poster="selected.posterUrl" muted loop playsinline preload="none" @pause="playing = false" @error="previewError = '视频预览暂时不可用，请重试。'" />
          <div class="segment-preview-titles"><strong>{{ heading }}</strong><span>{{ subheading }}</span></div>
          <button type="button" :disabled="busy" :aria-label="playing ? '暂停模板预览' : '播放模板预览'" :title="playing ? '暂停预览' : '播放预览'" data-testid="video-segment-preview" @click="togglePreview"><Icon :name="playing ? 'pause' : 'play'" :size="16" /></button>
        </div>
        <p class="segment-description">{{ selected.description }}</p>
        <label class="segment-field"><span>标题</span><input v-model="heading" maxlength="120" :disabled="busy" data-testid="video-segment-heading" placeholder="留空则不添加标题" /></label>
        <label class="segment-field"><span>副标题</span><input v-model="subheading" maxlength="240" :disabled="busy" data-testid="video-segment-subheading" placeholder="留空则不添加副标题" /></label>
        <p class="segment-caption-note"><Icon name="text" :size="13" />加入后可在时间线中继续编辑文字与位置。</p>
      </div>
    </div>
    <fieldset class="segment-placement" :disabled="busy"><legend>插入位置</legend><label :class="{ active: placement === 'prepend' }"><input v-model="placement" type="radio" name="video-segment-placement" value="prepend" data-testid="video-segment-prepend" /><Icon name="skip-back" :size="15" /><span><strong>向前添加</strong><small>放在项目开头，原片段整体后移</small></span></label><label :class="{ active: placement === 'append' }"><input v-model="placement" type="radio" name="video-segment-placement" value="append" data-testid="video-segment-append" /><Icon name="skip-forward" :size="15" /><span><strong>向后添加</strong><small>放在全部轨道的末尾</small></span></label></fieldset>
    <p class="segment-message" :class="{ error: error || previewError }" role="status" aria-live="polite" data-testid="video-segment-error"><template v-if="error || previewError"><Icon name="alert" :size="13" />{{ error || previewError }}</template><template v-else>视频保持项目画面尺寸；本地视频按所选位置插入，不附加模板标题。</template></p>
    <footer class="segment-footer"><span>{{ selected.title }} · {{ selected.duration }} 秒</span><button type="button" class="segment-add" :disabled="busy" data-testid="video-segment-add" @click="add"><Icon :name="busy ? 'clock' : 'plus'" :size="15" />{{ busy ? '正在添加…' : placement === 'prepend' ? '添加到项目开头' : '添加到项目结尾' }}</button></footer>
  </section>
</template>

<style scoped>
.segment-library{padding:16px;font-size:12px;color:var(--ed-text);container-type:inline-size}
.segment-library button,.segment-library input{font:inherit;box-sizing:border-box}
.segment-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px}
.segment-toolbar>div{display:flex;flex-direction:column;gap:4px;min-width:0}
.segment-toolbar strong{font-size:13px;font-weight:600}.segment-toolbar span{color:var(--ed-muted);font-size:11px}
.segment-import{display:flex;align-items:center;gap:6px;min-height:34px;flex-shrink:0;padding:6px 10px;border:1px solid var(--ed-border);border-radius:8px;color:var(--ed-text);background:var(--ed-panel);cursor:pointer}
.segment-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(225px,.85fr);gap:16px}
.segment-grid{display:grid;grid-auto-rows:max-content;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:10px;max-height:min(410px,calc(100dvh - 360px));min-height:200px;padding:2px 7px 2px 2px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent}
.segment-card{display:flex;flex-direction:column;min-width:0;padding:0;text-align:left;border:1px solid var(--ed-border);border-radius:9px;background:var(--ed-panel);color:var(--ed-text);overflow:hidden;cursor:pointer}
.segment-card.selected{border-color:var(--ed-accent);box-shadow:0 0 0 1px var(--ed-accent)}
.segment-thumbnail{display:block;flex-shrink:0;position:relative;aspect-ratio:16/9;width:100%;overflow:hidden;background:#171b28}
.segment-thumbnail img{display:block;width:100%;height:100%;object-fit:cover}
.segment-thumbnail>span{position:absolute;left:10%;right:10%;top:42%;font-size:clamp(8px,1.7cqw,12px);font-weight:600;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.segment-thumbnail small{position:absolute;bottom:6px;left:6px;padding:1px 5px;border-radius:4px;color:#fff;background:#10121899;font-size:9px}
.segment-card-label{display:flex;flex-wrap:wrap;align-items:center;gap:3px 6px;padding:7px 8px;min-width:0}
.segment-card-label strong{font-size:11px;font-weight:600}.segment-card-label>span{font-size:10px;color:var(--ed-muted)}.segment-card-label svg{margin-left:auto;color:var(--ed-accent)}
.segment-customize{min-width:0}.segment-preview{position:relative;aspect-ratio:16/9;border:1px solid var(--ed-border);border-radius:10px;overflow:hidden;background:#171b28}
.segment-preview video{display:block;width:100%;height:100%;object-fit:cover}.segment-preview-titles{position:absolute;inset:0;pointer-events:none}
.segment-preview-titles strong{position:absolute;top:36%;left:10%;width:80%;height:22%;display:flex;align-items:center;justify-content:center;font-size:clamp(11px,2.1cqw,20px);font-weight:600;overflow:hidden;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere}
.segment-preview-titles span{position:absolute;top:55.5%;left:10%;width:80%;height:12%;display:flex;align-items:center;justify-content:center;font-size:clamp(7px,.9cqw,9px);overflow:hidden;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere}
.segment-preview>button{position:absolute;bottom:8px;right:8px;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid #ffffff50;border-radius:50%;color:white;background:#141620a8;cursor:pointer}
.segment-description{font-size:10px;color:var(--ed-muted);line-height:1.6;min-height:32px;margin:10px 0}
.segment-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;font-size:11px;color:var(--ed-muted)}
.segment-field input{width:100%;min-width:0;height:34px;padding:7px 9px;border:1px solid var(--ed-border);border-radius:7px;background:var(--ed-bg);color:var(--ed-text);outline:none}
.segment-field input:focus{border-color:var(--ed-accent)}.segment-caption-note{display:flex;align-items:flex-start;gap:5px;color:var(--ed-muted);font-size:10px;line-height:1.6}.segment-caption-note svg{flex-shrink:0;margin-top:2px}
.segment-placement{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;padding:0;margin:16px 0 0;border:0}.segment-placement legend{font-size:11px;font-weight:600;margin-bottom:8px}
.segment-placement label{position:relative;display:flex;align-items:center;gap:8px;min-height:50px;padding:8px 10px;border:1px solid var(--ed-border);border-radius:8px;cursor:pointer;background:var(--ed-panel)}
.segment-placement label.active{border-color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 5%,var(--ed-panel))}.segment-placement input{position:absolute;opacity:0;width:1px;height:1px}
.segment-placement label:has(input:focus-visible){outline:2px solid var(--ed-accent);outline-offset:2px}.segment-placement svg{flex-shrink:0;color:var(--ed-muted)}
.segment-placement span{display:flex;flex-direction:column;gap:3px;min-width:0}.segment-placement strong{font-size:11px;font-weight:500}.segment-placement small{font-size:10px;color:var(--ed-muted)}
.segment-message{display:flex;align-items:flex-start;gap:5px;min-height:18px;margin:10px 0;color:var(--ed-muted);font-size:10px;line-height:18px}.segment-message.error{color:var(--ed-danger,#e16b75)}.segment-message svg{flex-shrink:0;margin-top:2px}
.segment-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;border-top:1px solid var(--ed-border)}.segment-footer>span{font-size:11px;color:var(--ed-muted)}
.segment-add{display:flex;align-items:center;justify-content:center;gap:6px;min-height:35px;padding:7px 12px;border:1px solid var(--ed-accent);border-radius:8px;background:var(--ed-accent);color:white;font-weight:600;cursor:pointer}
.segment-library button:disabled{cursor:default;opacity:.5}.segment-library button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}.segment-import:hover:not(:disabled){border-color:var(--ed-accent)}
@container(max-width:600px){.segment-body{grid-template-columns:1fr}.segment-grid{max-height:220px;min-height:150px;grid-template-columns:repeat(3,minmax(0,1fr))}.segment-customize{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px}.segment-preview{grid-row:span 3}.segment-description{display:none}.segment-caption-note{grid-column:1/-1;margin:0}.segment-field{margin:0}.segment-preview-titles strong{font-size:12px}.segment-preview-titles span{font-size:7px}}
@container(max-width:380px){.segment-toolbar{align-items:flex-start;flex-direction:column}.segment-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.segment-customize{grid-template-columns:1fr}.segment-placement{grid-template-columns:1fr}.segment-preview{grid-row:auto}.segment-footer{align-items:stretch;flex-direction:column}.segment-preview-titles strong{font-size:17px}.segment-preview-titles span{font-size:8px}}
</style>
