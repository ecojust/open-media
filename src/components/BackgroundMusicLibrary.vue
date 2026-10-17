<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { BACKGROUND_MUSIC, type BackgroundMusicItem } from '../core/background-music-catalog'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ busy?: boolean; error?: string }>(), { busy: false, error: '' })
const emit = defineEmits<{ select: [item: BackgroundMusicItem]; 'import-local': [] }>()
const selectedId = ref(''), previewId = ref(''), playing = ref(false), loading = ref(false)
const previewError = ref(''), progress = ref(0)
const selected = computed(() => BACKGROUND_MUSIC.find(item => item.id === selectedId.value))
const accents = ['#7993e9', '#b788d6', '#52a69b', '#d79459', '#c67a8f', '#668fae', '#8ca75e', '#b69954', '#8d88c7', '#6c9c9b']
let audio: HTMLAudioElement | null = null, generation = 0

function durationLabel(seconds: number): string {
  const duration = Math.max(0, Math.round(seconds))
  return `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`
}
function stopPreview(): void {
  generation += 1
  previewId.value = ''
  playing.value = false
  loading.value = false
  progress.value = 0
  if (!audio) return
  audio.onerror = null
  audio.onended = null
  audio.ontimeupdate = null
  audio.onpause = null
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
  audio = null
}
function failPreview(item: BackgroundMusicItem, token: number): void {
  if (token !== generation) return
  stopPreview()
  previewError.value = `“${item.title}”暂时无法试听，请重试。`
}
async function togglePreview(item: BackgroundMusicItem): Promise<void> {
  if (props.busy) return
  previewError.value = ''
  if (previewId.value === item.id && (playing.value || loading.value)) {
    if (loading.value) stopPreview()
    else { audio?.pause(); playing.value = false }
    return
  }
  if (previewId.value !== item.id || !audio) {
    stopPreview()
    audio = new Audio(item.url)
    audio.preload = 'auto'
    audio.volume = 0.65
    previewId.value = item.id
  }
  const media = audio
  const token = generation
  media.onerror = () => failPreview(item, token)
  media.onpause = () => { if (token === generation) playing.value = false }
  media.onended = () => {
    if (token !== generation) return
    playing.value = false
    loading.value = false
    progress.value = 0
    media.currentTime = 0
  }
  media.ontimeupdate = () => {
    if (token === generation && Number.isFinite(media.duration) && media.duration > 0) progress.value = Math.min(1, media.currentTime / media.duration)
  }
  loading.value = true
  try {
    await media.play()
    if (token !== generation) { media.pause(); return }
    playing.value = true
    loading.value = false
  } catch { failPreview(item, token) }
}
function addSelected(): void {
  if (props.busy || !selected.value) return
  stopPreview()
  previewError.value = ''
  emit('select', selected.value)
}
function importLocal(): void {
  if (props.busy) return
  stopPreview()
  previewError.value = ''
  emit('import-local')
}
function visibilityChanged(): void { if (document.hidden) stopPreview() }
watch(selectedId, () => { stopPreview(); previewError.value = '' })
watch(() => props.busy, value => { if (value) stopPreview() })
watch(() => props.error, value => { if (value) stopPreview() })
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged))
onBeforeUnmount(() => { document.removeEventListener('visibilitychange', visibilityChanged); stopPreview() })
</script>

<template>
  <section class="background-music-library" data-testid="background-music-library" aria-label="背景音乐素材库" :aria-busy="busy">
    <div class="music-toolbar">
      <div class="music-intro"><strong>找到适合画面的节奏</strong><span>{{ BACKGROUND_MUSIC.length }} 段内置纯音乐 · 离线可用</span></div>
      <button type="button" class="music-import" :disabled="busy" data-testid="background-music-import-local" @click="importLocal"><Icon name="upload" :size="15" /><span>上传音乐</span></button>
    </div>
    <div class="music-scroller" data-testid="background-music-list">
      <div class="music-grid" role="group" aria-label="选择背景音乐">
        <article v-for="(item, index) in BACKGROUND_MUSIC" :key="item.id" class="music-card" :class="{ selected: selectedId === item.id, previewing: previewId === item.id && playing }" :style="{ '--music-accent': accents[index % accents.length] }" data-testid="background-music-item" :data-music-id="item.id">
          <label class="music-choice">
            <input v-model="selectedId" type="radio" name="background-music-track" :value="item.id" :disabled="busy" :aria-label="`选择 ${item.title}，${item.style}`" data-testid="background-music-select" />
            <span class="music-art" aria-hidden="true"><span class="music-disc" /><Icon name="audio" :size="23" /></span>
            <span class="music-detail"><span class="music-title"><strong>{{ item.title }}</strong><Icon v-if="selectedId === item.id" name="check" :size="13" /></span><span class="music-meta"><span>{{ item.style }}</span><span>{{ durationLabel(item.duration) }}</span><span v-if="item.bpm">{{ item.bpm }} BPM</span></span><span class="music-description" :title="item.description">{{ item.description }}</span></span>
          </label>
          <button type="button" class="music-preview" :class="{ active: previewId === item.id && (playing || loading) }" :disabled="busy" :aria-label="`${previewId === item.id && (playing || loading) ? '暂停试听' : '试听'} ${item.title}`" :aria-pressed="previewId === item.id && (playing || loading)" :title="previewId === item.id && (playing || loading) ? '暂停试听' : '试听'" data-testid="background-music-preview" :data-music-preview="item.id" @click="togglePreview(item)"><Icon :name="previewId === item.id && loading ? 'clock' : previewId === item.id && playing ? 'pause' : 'play'" :size="16" /></button>
          <span v-if="previewId === item.id" class="music-progress" :style="{ transform: `scaleX(${progress})` }" aria-hidden="true" />
        </article>
      </div>
    </div>
    <p class="music-message" :class="{ error: error || previewError }" role="status" aria-live="polite" data-testid="background-music-error"><template v-if="error || previewError"><Icon name="alert" :size="13" /><span>{{ error || previewError }}</span></template><template v-else><Icon name="layers" :size="13" /><span>从当前刻度加入“背景音乐轨道”，可继续裁剪和调整音量。</span></template></p>
    <div class="music-footer"><span class="music-selection">{{ selected ? `已选择：${selected.title}` : '选择一段音乐，或上传自己的音频' }}</span><button type="button" class="music-add" :disabled="busy || !selected" data-testid="background-music-add" @click="addSelected"><Icon :name="busy ? 'clock' : 'plus'" :size="16" /><span>{{ busy ? '正在添加…' : '添加到时间线' }}</span></button></div>
  </section>
</template>

<style scoped>
.background-music-library{box-sizing:border-box;min-width:0;padding:16px;color:var(--ed-text);font-size:12px;line-height:1.5;container-type:inline-size}
.music-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}
.music-intro{display:flex;flex-direction:column;min-width:0;gap:3px}
.music-intro strong{font-size:13px;font-weight:600}
.music-intro>span{font-size:11px;color:var(--ed-muted)}
.background-music-library button{box-sizing:border-box;font:inherit;cursor:pointer}
.background-music-library .music-import{display:flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;min-height:34px;padding:6px 11px;border:1px solid var(--ed-border);border-radius:8px;background:var(--ed-panel);color:var(--ed-text);font-size:11px;white-space:nowrap}
.background-music-library .music-import:hover:not(:disabled){border-color:var(--ed-accent);color:var(--ed-accent)}
.music-scroller{max-height:min(440px,calc(100dvh - 270px));min-height:120px;overflow:auto;overscroll-behavior:contain;padding:3px 5px 3px 3px;margin:-3px -5px -3px -3px;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent}
.music-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
.music-card{position:relative;display:flex;align-items:center;min-width:0;min-height:85px;border:1px solid var(--ed-border);border-radius:10px;overflow:hidden;background:var(--ed-panel)}
.music-card:hover{border-color:color-mix(in srgb,var(--music-accent) 52%,var(--ed-border))}
.music-card.selected{border-color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 5%,var(--ed-panel))}
.music-choice{display:flex;align-items:center;gap:10px;min-width:0;align-self:stretch;flex:1;padding:11px 4px 11px 11px;cursor:pointer}
.music-choice input{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.music-card:has(.music-choice input:focus-visible){outline:2px solid var(--ed-accent);outline-offset:1px}
.music-choice:has(input:disabled){cursor:default}
.music-art{position:relative;display:flex;align-items:center;justify-content:center;flex-shrink:0;width:44px;height:44px;border:1px solid color-mix(in srgb,var(--music-accent) 25%,var(--ed-border));border-radius:9px;overflow:hidden;background:linear-gradient(145deg,color-mix(in srgb,var(--music-accent) 25%,var(--ed-panel)),color-mix(in srgb,var(--music-accent) 7%,var(--ed-bg)));color:color-mix(in srgb,var(--music-accent) 82%,var(--ed-text))}
.music-disc{position:absolute;width:46px;height:46px;border:1px solid currentColor;border-radius:50%;right:-18px;bottom:-17px;opacity:.24}
.music-disc::after{content:'';position:absolute;inset:5px;border:1px solid currentColor;border-radius:50%}
.music-art>svg{position:relative}
.music-detail{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.music-title{display:flex;align-items:center;gap:5px;min-width:0}
.music-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}
.music-title>svg{flex-shrink:0;color:var(--ed-accent)}
.music-meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;color:var(--ed-muted);font-size:10px;font-variant-numeric:tabular-nums}
.music-meta>span+span::before{content:'·';margin-right:7px;opacity:.65}
.music-description{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--ed-muted)}
.background-music-library .music-preview{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:30px;height:30px;min-height:30px;margin:0 10px 0 5px;padding:0;border:1px solid var(--ed-border);border-radius:50%;background:var(--ed-bg);color:var(--ed-muted)}
.background-music-library .music-preview:hover:not(:disabled),.background-music-library .music-preview.active{border-color:var(--ed-accent);color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 8%,var(--ed-panel))}
.music-progress{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--music-accent);transform-origin:left center;pointer-events:none}
.music-message{display:flex;align-items:flex-start;gap:6px;min-height:18px;margin:13px 0 10px;color:var(--ed-muted);font-size:10px;line-height:18px}
.music-message>svg{flex-shrink:0;margin-top:2px}
.music-message.error{color:var(--ed-danger,#e16b75)}
.music-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:11px;border-top:1px solid var(--ed-border)}
.music-selection{min-width:0;font-size:11px;color:var(--ed-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.background-music-library .music-add{display:flex;align-items:center;justify-content:center;flex-shrink:0;gap:6px;min-height:35px;padding:7px 13px;border:1px solid var(--ed-accent);border-radius:8px;background:var(--ed-accent);color:#fff;font-size:11px;font-weight:600}
.background-music-library .music-add:hover:not(:disabled){filter:brightness(1.08)}
.background-music-library button:disabled{cursor:default;opacity:.45}
.background-music-library button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}
@container (max-width:560px){.music-grid{grid-template-columns:minmax(0,1fr)}.music-card{min-height:79px}.music-art{width:41px;height:41px}.music-toolbar{gap:9px}.music-intro strong{font-size:12px}}
@container (max-width:340px){.music-toolbar{align-items:flex-start;flex-direction:column}.music-footer{align-items:stretch;flex-direction:column}.music-add{width:100%}.music-selection{white-space:normal}}
</style>
