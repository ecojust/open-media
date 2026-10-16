<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Clip, MediaAsset, Project, Track, TrackKind } from '../core/types'
import { cloneProject, createClip, createTextClip, createTrack, newId, validateProject } from '../core/project'
import { addClip, addTrack, clipDuration, clipEnd, deleteClip, duplicateClip, findClip, moveClip, projectDuration, reorderTrack, setTrack, splitClip, updateClip } from '../core/timeline'
import { TimelinePreview } from '../core/preview'
import Icon from './Icon.vue'
import SpeechPanel from './SpeechPanel.vue'

const props = defineProps<{ project: Project }>()
const emit = defineEmits<{ change: [project: Project, label?: string]; import: [files?: File[]]; export: []; status: [message: string]; busy: [value: boolean] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const timelineScroll = ref<HTMLElement | null>(null)
const timelineOffset = ref(0)
const timelineViewport = ref(900)
const selectedId = ref('')
const playhead = ref(0)
const playing = ref(false)
const zoom = ref(44)
const assetFilter = ref('all')
const search = ref('')
const propertyTab = ref<'clip' | 'project' | 'speech'>('clip')
const speechPanel = ref<InstanceType<typeof SpeechPanel> | null>(null)
const speechBusy = ref(false)
const clipMenu = ref<{ x: number; y: number; clipId: string; locked: boolean } | null>(null)
const workingProject = ref<Project | null>(null)
const activeProject = computed(() => workingProject.value || props.project)
const duration = computed(() => projectDuration(activeProject.value))
const selected = computed(() => findClip(activeProject.value, selectedId.value))
const timelineSeconds = computed(() => Math.max(20, Math.ceil(duration.value + 10)))
const timelineWidth = computed(() => Math.max(600, timelineSeconds.value * zoom.value))
const tickStep = computed(() => zoom.value < 15 ? 10 : zoom.value < 30 ? 5 : zoom.value < 70 ? 2 : 1)
const ticks = computed(() => {
  const start = Math.max(0, Math.floor((timelineOffset.value - 140) / zoom.value / tickStep.value) - 2)
  const end = Math.min(Math.floor(timelineSeconds.value / tickStep.value), Math.ceil((timelineOffset.value + timelineViewport.value) / zoom.value / tickStep.value) + 2)
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => (start + index) * tickStep.value)
})
const assets = computed(() => activeProject.value.assets.filter(asset => (assetFilter.value === 'all' || asset.kind === assetFilter.value) && asset.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const ratio = computed(() => `${activeProject.value.width} / ${activeProject.value.height}`)
const selectedLocked = computed(() => selected.value?.track.locked || false)
let preview: TimelinePreview | undefined
let frame = 0
let resizeObserver: ResizeObserver | undefined
let playbackStarted = 0
let playbackOffset = 0
let gesture: { kind: 'move' | 'trim-start' | 'trim-end'; clipId: string; trackId: string; startX: number; original: Clip; base: Project } | undefined

function message(error: unknown): void { emit('status', error instanceof Error ? error.message : String(error)) }
function commit(action: () => Project, label: string): void {
  if (speechBusy.value) return
  try { emit('change', action(), label) } catch (error) { message(error) }
}
function setSpeechBusy(value: boolean): void {
  speechBusy.value = value
  if (value) { pause(); cancelGesture(); clipMenu.value = null; propertyTab.value = 'speech' }
  emit('busy', value)
}
function openSpeech(): void { pause(); propertyTab.value = 'speech' }
function generateTextSpeech(clipId: string): void {
  clipMenu.value = null; selectedId.value = clipId; openSpeech()
  void speechPanel.value?.generate([clipId])
}
function openClipMenu(event: MouseEvent, clip: Clip, track: Track): void {
  if (clip.text === undefined || speechBusy.value) return
  event.preventDefault(); event.stopPropagation()
  selectedId.value = clip.id
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  clipMenu.value = { x: Math.max(8, Math.min(event.clientX || rect.left, window.innerWidth - 208)), y: Math.max(8, Math.min(event.clientY || rect.bottom, window.innerHeight - 160)), clipId: clip.id, locked: track.locked }
}
function closeClipMenu(event?: PointerEvent): void {
  if (!event || !(event.target as HTMLElement).closest('.clip-context-menu')) clipMenu.value = null
}
function formatTime(value: number, frames = false): string {
  const seconds = Math.max(0, value)
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60).toString().padStart(2, '0')
  return frames ? `${minutes.toString().padStart(2, '0')}:${remaining}:${Math.floor((seconds % 1) * activeProject.value.fps).toString().padStart(2, '0')}` : `${minutes}:${remaining}`
}
function seek(time: number): void {
  playhead.value = Math.max(0, Math.min(duration.value || timelineSeconds.value, time))
  playbackStarted = performance.now()
  playbackOffset = playhead.value
  preview?.render(playhead.value, playing.value)
}
function pause(): void { playing.value = false; cancelAnimationFrame(frame); preview?.pause() }
async function togglePlay(): Promise<void> {
  if (playing.value) { pause(); return }
  if (!duration.value) return
  try { await preview?.enableAudio() } catch { emit('status', '音频预览暂不可用，仍可查看画面') }
  if (playhead.value >= duration.value) playhead.value = 0
  playing.value = true
  playbackOffset = playhead.value
  playbackStarted = performance.now()
  const tick = () => {
    if (!playing.value) return
    playhead.value = Math.min(duration.value, playbackOffset + (performance.now() - playbackStarted) / 1000)
    preview?.render(Math.min(playhead.value, Math.max(0, duration.value - 0.001)), playhead.value < duration.value)
    if (playhead.value >= duration.value) pause()
    else frame = requestAnimationFrame(tick)
  }
  tick()
}
function addAssetToTimeline(asset: MediaAsset, targetTrackId?: string, time = playhead.value): void {
  commit(() => {
    let project = props.project
    let track = targetTrackId ? project.tracks.find(item => item.id === targetTrackId) : project.tracks.find(item => item.kind === (asset.kind === 'audio' ? 'audio' : 'video') && !item.locked)
    if (!track) { track = createTrack(asset.kind === 'audio' ? 'audio' : 'video'); project = addTrack(project, track) }
    const clip = createClip(asset, project, { start: Math.max(0, time) })
    selectedId.value = clip.id
    propertyTab.value = 'clip'
    return addClip(project, track.id, clip)
  }, '添加素材到时间线')
}
function addText(): void {
  commit(() => {
    let project = props.project
    let track = project.tracks.find(item => item.kind === 'text' && !item.locked)
    if (!track) { track = createTrack('text'); project = addTrack(project, track); project = reorderTrack(project, track.id, 0) }
    const clip = createTextClip(project, { start: playhead.value, text: '在这里输入字幕' })
    selectedId.value = clip.id
    propertyTab.value = 'clip'
    return addClip(project, track.id, clip)
  }, '添加字幕')
}
function addTimelineTrack(kind: TrackKind): void {
  commit(() => {
    const track = createTrack(kind, `${{ video: '视频', audio: '音频', text: '字幕' }[kind]} ${props.project.tracks.filter(item => item.kind === kind).length + 1}`)
    const project = addTrack(props.project, track)
    return kind === 'text' || kind === 'video' ? reorderTrack(project, track.id, 0) : project
  }, '添加轨道')
}
function separateAudio(): void {
  const current = selected.value
  if (!current || current.track.kind !== 'video') return
  const asset = props.project.assets.find(item => item.id === current.clip.assetId)
  if (!asset || asset.kind !== 'video') return
  commit(() => {
    let project = props.project
    let track = project.tracks.find(item => item.kind === 'audio' && !item.locked)
    if (!track) { track = createTrack('audio'); project = addTrack(project, track) }
    const clip = createClip(asset, project, { ...current.clip, id: newId('clip'), name: `${current.clip.name} · 音轨` })
    project = addClip(project, track.id, clip)
    return updateClip(project, current.clip.id, { volume: 0 })
  }, '分离片段音轨')
}
function pictureInPicture(): void {
  const width = Math.round(props.project.width * 0.32)
  const height = Math.round(props.project.height * 0.32)
  const margin = Math.round(Math.min(props.project.width, props.project.height) * 0.04)
  updateSelected({ x: props.project.width - width - margin, y: props.project.height - height - margin, width, height }, '设为画中画')
}
function updateSelected(patch: Partial<Clip>, label = '调整片段'): void {
  if (selected.value) commit(() => updateClip(props.project, selectedId.value, patch), label)
}
function numberValue(event: Event): number { return Number((event.target as HTMLInputElement).value) }
function stringValue(event: Event): string { return (event.target as HTMLInputElement).value }
function splitSelected(): void { if (selected.value) commit(() => splitClip(props.project, selectedId.value, playhead.value), '分割片段') }
function duplicateSelected(): void { if (selected.value) commit(() => duplicateClip(props.project, selectedId.value), '复制片段') }
function deleteSelected(): void {
  if (!selected.value) return
  commit(() => deleteClip(props.project, selectedId.value), '删除片段')
  selectedId.value = ''
}
function setProjectSetting(patch: Partial<Project>): void {
  commit(() => validateProject({ ...props.project, ...patch, updatedAt: new Date().toISOString() }, { trusted: true }), '调整项目设置')
}
function setRatio(value: string): void {
  const dimensions: Record<string, [number, number]> = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080], cinema: [2560, 1080] }
  const next = dimensions[value]
  if (!next) return
  commit(() => {
    const project = cloneProject(props.project)
    const sx = next[0] / project.width
    const sy = next[1] / project.height
    project.width = next[0]; project.height = next[1]
    for (const track of project.tracks) for (const clip of track.clips) {
      clip.x *= sx; clip.y *= sy; clip.width *= sx; clip.height *= sy
      if (clip.fontSize) clip.fontSize *= Math.min(sx, sy)
    }
    project.updatedAt = new Date().toISOString()
    return validateProject(project, { trusted: true })
  }, '调整画面比例')
}
function onAssetDrag(event: DragEvent, asset: MediaAsset): void {
  event.dataTransfer?.setData('application/x-open-media-asset', asset.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}
function onDrop(event: DragEvent, track: Track): void {
  event.preventDefault()
  const assetId = event.dataTransfer?.getData('application/x-open-media-asset')
  const asset = props.project.assets.find(item => item.id === assetId)
  if (asset) {
    const row = event.currentTarget as HTMLElement
    const time = Math.max(0, (event.clientX - row.getBoundingClientRect().left) / zoom.value)
    addAssetToTimeline(asset, track.id, Math.round(time * props.project.fps) / props.project.fps)
  } else if (event.dataTransfer?.files.length) emit('import', [...event.dataTransfer.files])
}
function setPlayheadFromPointer(event: PointerEvent): void {
  if ((event.target as HTMLElement).closest('.timeline-clip')) return
  const row = event.currentTarget as HTMLElement
  seek((event.clientX - row.getBoundingClientRect().left) / zoom.value)
}
function startGesture(event: PointerEvent, clip: Clip, track: Track, kind: 'move' | 'trim-start' | 'trim-end'): void {
  if (event.button !== 0 || speechBusy.value) return
  event.preventDefault(); event.stopPropagation()
  selectedId.value = clip.id; propertyTab.value = 'clip'
  if (track.locked) return
  pause()
  gesture = { kind, clipId: clip.id, trackId: track.id, startX: event.clientX, original: { ...clip }, base: props.project }
  window.addEventListener('pointermove', moveGesture)
  window.addEventListener('pointerup', endGesture, { once: true })
  window.addEventListener('pointercancel', cancelGesture, { once: true })
}
function snap(value: number): number {
  const candidates = [0, playhead.value, ...props.project.tracks.flatMap(track => track.clips.filter(clip => clip.id !== selectedId.value).flatMap(clip => [clip.start, clipEnd(clip)]))]
  const nearest = candidates.find(candidate => Math.abs(candidate - value) * zoom.value < 7)
  return nearest === undefined ? Math.round(value * props.project.fps) / props.project.fps : nearest
}
function moveGesture(event: PointerEvent): void {
  if (!gesture) return
  const { original, base, clipId, kind } = gesture
  const delta = (event.clientX - gesture.startX) / zoom.value
  try {
    if (kind === 'move') {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-track-id]')
      const targetId = target?.dataset.trackId || gesture.trackId
      workingProject.value = moveClip(base, clipId, targetId, Math.max(0, snap(original.start + delta)))
    } else if (kind === 'trim-start') {
      const sourceDelta = Math.max(-original.trimIn, Math.min(original.trimOut - original.trimIn - original.speed / props.project.fps, delta * original.speed))
      const start = original.start + sourceDelta / original.speed
      if (start >= 0) workingProject.value = updateClip(base, clipId, { start, trimIn: original.trimIn + sourceDelta })
    } else {
      const asset = base.assets.find(item => item.id === original.assetId)
      const limit = asset && asset.kind !== 'image' ? asset.duration : 86400
      const trimOut = Math.max(original.trimIn + original.speed / props.project.fps, Math.min(limit, original.trimOut + delta * original.speed))
      workingProject.value = updateClip(base, clipId, { trimOut })
    }
  } catch { /* Incompatible or locked tracks leave the last valid drag position intact. */ }
}
function clearGesture(): void {
  window.removeEventListener('pointermove', moveGesture)
  window.removeEventListener('pointerup', endGesture)
  window.removeEventListener('pointercancel', cancelGesture)
  gesture = undefined
}
function endGesture(): void {
  const project = workingProject.value
  const label = gesture?.kind === 'move' ? '移动片段' : '裁剪片段'
  workingProject.value = null
  clearGesture()
  if (project) emit('change', project, label)
}
function cancelGesture(): void { workingProject.value = null; clearGesture() }
function fitTimeline(): void { zoom.value = Math.max(6, Math.min(160, ((timelineScroll.value?.clientWidth || 900) - 160) / Math.max(10, duration.value + 2))) }
function keyboard(event: KeyboardEvent): void {
  if (event.key === 'Escape' && clipMenu.value) { clipMenu.value = null; return }
  if (speechBusy.value) return
  const element = event.target as HTMLElement
  if (element.closest('input,textarea,select,[contenteditable="true"],dialog,[role="dialog"],.speech-panel,.clip-context-menu')) return
  if (event.code === 'Space') { event.preventDefault(); void togglePlay() }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selected.value) { event.preventDefault(); deleteSelected() }
  if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey) splitSelected()
  if (event.key === 'ArrowLeft') { event.preventDefault(); seek(playhead.value - (event.shiftKey ? 1 : 1 / props.project.fps)) }
  if (event.key === 'ArrowRight') { event.preventDefault(); seek(playhead.value + (event.shiftKey ? 1 : 1 / props.project.fps)) }
  if (event.key === 'Escape') cancelGesture()
}
watch(activeProject, project => {
  if (preview) {
    if (canvas.value) { canvas.value.width = Math.min(1280, project.width); canvas.value.height = Math.round(canvas.value.width * project.height / project.width) }
    preview.setProject(project)
    if (playhead.value > projectDuration(project)) seek(projectDuration(project))
  }
}, { deep: true })
watch(() => props.project.id, () => { pause(); cancelGesture(); clipMenu.value = null; selectedId.value = ''; seek(0) })
onMounted(() => {
  if (canvas.value) {
    canvas.value.width = Math.min(1280, props.project.width)
    canvas.value.height = Math.round(canvas.value.width * props.project.height / props.project.width)
    preview = new TimelinePreview(canvas.value, props.project, message)
  }
  if (timelineScroll.value) { resizeObserver = new ResizeObserver(entries => { timelineViewport.value = entries[0].contentRect.width }); resizeObserver.observe(timelineScroll.value) }
  window.addEventListener('keydown', keyboard)
  window.addEventListener('pointerdown', closeClipMenu)
})
onBeforeUnmount(() => { pause(); cancelGesture(); resizeObserver?.disconnect(); preview?.dispose(); window.removeEventListener('keydown', keyboard); window.removeEventListener('pointerdown', closeClipMenu) })
defineExpose({ getCanvas: () => canvas.value, pause, seek })
</script>

<template>
  <section class="video-editor" data-testid="video-editor">
    <div class="editor-tools" :inert="speechBusy || undefined">
      <div class="tool-group">
        <button class="editor-primary" title="导入素材" aria-label="导入素材" @click="emit('import')"><Icon name="import" :size="16" /><span>导入素材</span></button>
        <button @click="addText"><Icon name="text" :size="16" /><span>字幕</span></button>
        <button title="文字转语音" aria-label="文字转语音" :class="{ 'editor-primary': propertyTab === 'speech' }" @click="openSpeech"><Icon name="audio" :size="16" /><span>配音</span></button>
        <button :disabled="!selected || selectedLocked" title="在播放头处分割（S）" @click="splitSelected"><Icon name="scissors" :size="16" /><span>分割</span></button>
        <button :disabled="!selected || selectedLocked" title="复制片段" @click="duplicateSelected"><Icon name="copy" :size="16" /></button>
        <button :disabled="!selected || selectedLocked" title="删除片段" @click="deleteSelected"><Icon name="trash" :size="16" /></button>
      </div>
      <button class="editor-export" :disabled="!duration" @click="pause(); emit('export')"><Icon name="export" :size="16" />导出视频</button>
    </div>
    <div class="editor-main">
      <aside class="asset-panel" :inert="speechBusy || undefined">
        <header><strong>项目素材</strong><span class="count">{{ project.assets.length }}</span><button title="导入素材" @click="emit('import')"><Icon name="plus" :size="16" /></button></header>
        <div class="asset-search"><input v-model="search" aria-label="搜索素材" placeholder="搜索素材" /></div>
        <div class="asset-filters" aria-label="素材类型"><button v-for="filter in [{ key: 'all', label: '全部' }, { key: 'video', label: '视频' }, { key: 'audio', label: '音频' }, { key: 'image', label: '图片' }]" :key="filter.key" :class="{ active: assetFilter === filter.key }" @click="assetFilter = filter.key">{{ filter.label }}</button></div>
        <div class="asset-list" @dragover.prevent @drop.prevent="emit('import', [...($event.dataTransfer?.files || [])])">
          <button v-for="asset in assets" :key="asset.id" class="asset-card" draggable="true" :title="`${asset.name} · 双击添加到播放头位置`" @dragstart="onAssetDrag($event, asset)" @dblclick="addAssetToTimeline(asset)" @keydown.enter.prevent="addAssetToTimeline(asset)">
            <div class="asset-thumb" :class="asset.kind"><img v-if="asset.kind === 'image'" :src="asset.url" alt="" /><video v-else-if="asset.kind === 'video'" :src="asset.url" preload="metadata" muted /><Icon v-else name="audio" :size="28" /><span v-if="asset.duration">{{ formatTime(asset.duration) }}</span></div>
            <span class="asset-name">{{ asset.name }}</span><span class="asset-meta">{{ asset.kind === 'audio' ? '音频素材' : `${asset.width} × ${asset.height}` }}</span>
          </button>
          <div v-if="!assets.length" class="asset-empty"><Icon name="import" :size="28" /><strong>{{ project.assets.length ? '没有匹配的素材' : '把灵感带进来' }}</strong><span>导入视频、图片或音乐<br />拖入时间线即可开始剪辑</span><button v-if="!project.assets.length" @click="emit('import')">选择素材</button></div>
        </div>
        <footer>双击素材添加 · 拖动调整位置</footer>
      </aside>
      <main class="preview-panel" :inert="speechBusy || undefined">
        <div class="preview-heading"><span class="preview-title">预览</span><span>{{ project.width }} × {{ project.height }} · {{ project.fps }} fps</span><button title="画面设置" @click="propertyTab = 'project'"><Icon name="settings" :size="15" /></button></div>
        <div class="preview-stage">
          <div class="preview-frame" :style="{ aspectRatio: ratio }"><canvas ref="canvas" aria-label="视频合成预览" data-testid="video-preview" /><div v-if="!duration" class="preview-empty"><Icon name="video" :size="38" /><strong>你的故事，从这里开始</strong><span>将素材放入下方时间线</span></div></div>
        </div>
        <div class="preview-playback"><span class="time-code">{{ formatTime(playhead, true) }}<em>/ {{ formatTime(duration, true) }}</em></span><div class="play-controls"><button title="回到开头" @click="seek(0)"><Icon name="skip-back" :size="17" /></button><button class="play-button" :disabled="!duration" :title="playing ? '暂停（空格）' : '播放（空格）'" data-testid="preview-play" @click="togglePlay"><Icon :name="playing ? 'pause' : 'play'" :size="20" /></button><button title="跳到结尾" @click="seek(duration)"><Icon name="skip-forward" :size="17" /></button></div><span class="preview-scale">适应窗口</span></div>
      </main>
      <aside class="property-panel" :class="{ 'speech-open': propertyTab === 'speech' }">
        <div class="property-tabs"><button :disabled="speechBusy" :class="{ active: propertyTab === 'clip' }" @click="propertyTab = 'clip'">片段属性</button><button :class="{ active: propertyTab === 'speech' }" @click="openSpeech">配音</button><button :disabled="speechBusy" :class="{ active: propertyTab === 'project' }" @click="propertyTab = 'project'">项目设置</button></div>
        <SpeechPanel ref="speechPanel" v-show="propertyTab === 'speech'" :active="propertyTab === 'speech'" :project="project" :selected-clip-id="selectedId" @change="(next, label) => emit('change', next, label)" @status="emit('status', $event)" @busy="setSpeechBusy" />
        <div v-if="propertyTab === 'project'" class="property-content">
          <h3>画面</h3><label>画面比例<select aria-label="画面比例" :value="project.width === project.height ? 'square' : project.width > project.height ? (project.width / project.height > 2 ? 'cinema' : 'landscape') : 'portrait'" @change="setRatio(stringValue($event))"><option value="landscape">横屏 16:9</option><option value="portrait">竖屏 9:16</option><option value="square">方形 1:1</option><option value="cinema">宽银幕 21:9</option></select></label>
          <label>帧率<select :value="project.fps" aria-label="项目帧率" @change="setProjectSetting({ fps: numberValue($event) })"><option :value="24">24 fps</option><option :value="25">25 fps</option><option :value="30">30 fps</option><option :value="60">60 fps</option></select></label><label>背景颜色<input type="color" :value="project.background" aria-label="项目背景颜色" @change="setProjectSetting({ background: stringValue($event) })" /></label><div class="setting-note">调整比例会同步缩放片段位置。轨道从上到下对应画面从前景到背景。</div>
          <h3>项目概况</h3><dl><dt>总时长</dt><dd>{{ formatTime(duration, true) }}</dd><dt>素材</dt><dd>{{ project.assets.length }} 个</dd><dt>轨道</dt><dd>{{ project.tracks.length }} 条</dd></dl>
        </div>
        <div v-else-if="propertyTab === 'clip' && selected" class="property-content">
          <div class="selected-heading"><Icon :name="selected.track.kind === 'text' ? 'text' : selected.track.kind === 'audio' ? 'audio' : 'video'" :size="16" /><strong>{{ selected.clip.name }}</strong><span v-if="selectedLocked">已锁定</span></div>
          <button v-if="selected.clip.text !== undefined" class="selected-speech" :disabled="selectedLocked || !selected.clip.text.trim()" @click="openSpeech"><Icon name="audio" :size="13" />文字转语音</button>
          <fieldset :disabled="selectedLocked">
            <template v-if="selected.clip.text !== undefined"><h3>文本</h3><textarea :value="selected.clip.text" rows="3" aria-label="字幕内容" @change="updateSelected({ text: stringValue($event) }, '编辑字幕')" /><div class="property-grid"><label>字号<input type="number" min="4" max="2048" :value="selected.clip.fontSize" @change="updateSelected({ fontSize: numberValue($event) })" /></label><label>颜色<input type="color" :value="selected.clip.color" @change="updateSelected({ color: stringValue($event) })" /></label></div><label>字体<select :value="selected.clip.fontFamily" @change="updateSelected({ fontFamily: stringValue($event) })"><option value="sans-serif">无衬线</option><option value="serif">衬线</option><option value="monospace">等宽</option></select></label><label>文字底色<div class="text-background"><input type="color" :value="selected.clip.background === 'transparent' ? '#000000' : selected.clip.background" aria-label="文字底色" @change="updateSelected({ background: stringValue($event) })" /><button :class="{ active: selected.clip.background === 'transparent' }" @click="updateSelected({ background: 'transparent' })">透明</button></div></label><label>对齐<select :value="selected.clip.textAlign" @change="updateSelected({ textAlign: stringValue($event) as Clip['textAlign'] })"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label><label>字重<select :value="selected.clip.fontWeight" @change="updateSelected({ fontWeight: numberValue($event) })"><option :value="400">常规</option><option :value="600">半粗</option><option :value="700">粗体</option></select></label></template>
            <h3>时间</h3><div class="property-grid"><label>开始 / 秒<input type="number" min="0" step="0.1" :value="Number(selected.clip.start.toFixed(3))" aria-label="片段开始时间" @change="updateSelected({ start: numberValue($event) })" /></label><label>时长 / 秒<input type="number" min="0.04" step="0.1" :value="Number(clipDuration(selected.clip).toFixed(3))" aria-label="片段时长" @change="updateSelected({ trimOut: selected!.clip.trimIn + numberValue($event) * selected!.clip.speed })" /></label><label>源起点 / 秒<input type="number" min="0" step="0.1" :value="Number(selected.clip.trimIn.toFixed(3))" @change="updateSelected({ trimIn: numberValue($event) })" /></label><label>源终点 / 秒<input type="number" min="0.001" step="0.1" :value="Number(selected.clip.trimOut.toFixed(3))" @change="updateSelected({ trimOut: numberValue($event) })" /></label></div>
            <label>播放速度<select :value="selected.clip.speed" aria-label="播放速度" @change="updateSelected({ speed: numberValue($event) })"><option v-for="speed in [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8, 16]" :key="speed" :value="speed">{{ speed }}×</option></select></label>
            <template v-if="selected.track.kind !== 'text'"><h3>声音</h3><button v-if="selected.track.kind === 'video' && project.assets.find(asset => asset.id === selected!.clip.assetId)?.kind === 'video'" class="separate-audio" @click="separateAudio"><Icon name="audio" :size="13" />分离到音轨</button><label>音量 <output>{{ Math.round(selected.clip.volume * 100) }}%</output><input type="range" min="0" max="2" step="0.05" :value="selected.clip.volume" aria-label="音量" @change="updateSelected({ volume: numberValue($event) })" /></label></template>
            <h3>淡入淡出</h3><div class="property-grid"><label>淡入 / 秒<input type="number" min="0" :max="clipDuration(selected.clip)" step="0.1" :value="selected.clip.fadeIn" @change="updateSelected({ fadeIn: numberValue($event) })" /></label><label>淡出 / 秒<input type="number" min="0" :max="clipDuration(selected.clip)" step="0.1" :value="selected.clip.fadeOut" @change="updateSelected({ fadeOut: numberValue($event) })" /></label></div>
            <template v-if="selected.track.kind !== 'audio'"><h3>画面变换</h3><div class="transform-presets"><button @click="pictureInPicture">画中画</button><button @click="updateSelected({ x: 0, y: 0, width: project.width, height: project.height, rotation: 0 })">铺满画布</button></div><div class="property-grid"><label>X<input type="number" :value="Number(selected.clip.x.toFixed(1))" @change="updateSelected({ x: numberValue($event) })" /></label><label>Y<input type="number" :value="Number(selected.clip.y.toFixed(1))" @change="updateSelected({ y: numberValue($event) })" /></label><label>宽度<input type="number" min="1" :value="Number(selected.clip.width.toFixed(1))" @change="updateSelected({ width: numberValue($event) })" /></label><label>高度<input type="number" min="1" :value="Number(selected.clip.height.toFixed(1))" @change="updateSelected({ height: numberValue($event) })" /></label></div><label>旋转 / 度<input type="number" min="-3600" max="3600" step="1" :value="selected.clip.rotation" @change="updateSelected({ rotation: numberValue($event) })" /></label><label>不透明度 <output>{{ Math.round(selected.clip.opacity * 100) }}%</output><input type="range" min="0" max="1" step="0.05" :value="selected.clip.opacity" @change="updateSelected({ opacity: numberValue($event) })" /></label><label v-if="selected.clip.text === undefined">画面适配<select :value="selected.clip.fit" @change="updateSelected({ fit: stringValue($event) as Clip['fit'] })"><option value="contain">完整显示</option><option value="cover">裁切填满</option><option value="fill">拉伸填满</option></select></label></template>
          </fieldset>
        </div>
        <div v-else-if="propertyTab === 'clip'" class="property-empty"><Icon name="settings" :size="28" /><strong>选择一个片段</strong><span>调整画面、速度、声音<br />或添加淡入淡出</span><button @click="propertyTab = 'project'">项目设置</button></div>
      </aside>
    </div>
    <section class="timeline-panel" aria-label="多轨时间线" :inert="speechBusy || undefined">
      <div class="timeline-toolbar"><div class="track-add"><span>时间线</span><button title="添加视频轨道" @click="addTimelineTrack('video')"><Icon name="video" :size="14" /><Icon name="plus" :size="11" /></button><button title="添加音频轨道" @click="addTimelineTrack('audio')"><Icon name="audio" :size="14" /><Icon name="plus" :size="11" /></button><button title="添加字幕轨道" @click="addTimelineTrack('text')"><Icon name="text" :size="14" /><Icon name="plus" :size="11" /></button></div><div class="timeline-zoom"><button title="缩小时间线" @click="zoom = Math.max(6, zoom / 1.25)"><Icon name="zoom-out" :size="15" /></button><input v-model.number="zoom" type="range" min="6" max="160" aria-label="时间线缩放" /><button title="放大时间线" @click="zoom = Math.min(160, zoom * 1.25)"><Icon name="zoom-in" :size="15" /></button><button title="适应全部片段" @click="fitTimeline"><Icon name="fit" :size="16" /></button></div></div>
      <div ref="timelineScroll" class="timeline-scroll" @scroll="timelineOffset = ($event.target as HTMLElement).scrollLeft">
        <div class="timeline-content" :style="{ width: `${timelineWidth + 140}px` }">
          <div class="ruler-row"><div class="track-label ruler-label">{{ formatTime(playhead, true) }}</div><div class="timeline-ruler" :style="{ width: `${timelineWidth}px` }" @pointerdown="setPlayheadFromPointer"><span v-for="tick in ticks" :key="tick" :style="{ left: `${tick * zoom}px` }">{{ formatTime(tick) }}</span><div class="ruler-playhead" :style="{ left: `${playhead * zoom}px` }" /></div></div>
          <div v-for="(track, trackIndex) in activeProject.tracks" :key="track.id" class="track-row" :class="{ locked: track.locked }">
            <div class="track-label"><div class="track-name"><Icon :name="track.kind === 'text' ? 'text' : track.kind === 'audio' ? 'audio' : 'video'" :size="13" /><span :title="track.name">{{ track.name }}</span></div><div class="track-actions"><button :title="track.muted ? '开启轨道声音' : '静音轨道'" :class="{ enabled: track.muted }" :disabled="track.kind === 'text'" @click="commit(() => setTrack(project, track.id, { muted: !track.muted }), '调整轨道静音')"><Icon :name="track.muted ? 'volume-off' : 'volume'" :size="13" /></button><button :title="track.locked ? '解锁轨道' : '锁定轨道'" :class="{ enabled: track.locked }" @click="commit(() => setTrack(project, track.id, { locked: !track.locked }), '调整轨道锁定')"><Icon :name="track.locked ? 'lock' : 'unlock'" :size="12" /></button><button :disabled="!trackIndex || track.locked" title="轨道上移一层" @click="commit(() => reorderTrack(project, track.id, trackIndex - 1), '调整轨道层级')"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 9 4-4 4 4M8 5v8" /></svg></button></div></div>
            <div class="track-lane" :data-track-id="track.id" :style="{ width: `${timelineWidth}px`, backgroundSize: `${zoom * tickStep}px 100%` }" @dragover.prevent @drop="onDrop($event, track)" @pointerdown="setPlayheadFromPointer">
              <span v-if="!track.clips.length" class="track-hint">{{ track.kind === 'text' ? '点击上方「字幕」添加文字' : track.kind === 'audio' ? '拖入音乐或视频的声音' : '拖入视频或图片' }}</span>
              <button v-for="clip in track.clips" :key="clip.id" class="timeline-clip" :class="[track.kind, { selected: selectedId === clip.id }]" :style="{ left: `${clip.start * zoom}px`, width: `${Math.max(10, clipDuration(clip) * zoom)}px` }" :title="`${clip.name} · ${formatTime(clip.start)}—${formatTime(clipEnd(clip))}`" :data-clip-id="clip.id" @pointerdown="startGesture($event, clip, track, 'move')" @click.stop="selectedId = clip.id; propertyTab = 'clip'" @dblclick="propertyTab = 'clip'" @contextmenu="openClipMenu($event, clip, track)">
                <span class="trim-handle start" title="拖动裁剪开头" @pointerdown.stop="startGesture($event, clip, track, 'trim-start')" /><span class="clip-title"><Icon :name="track.kind === 'text' ? 'text' : track.kind === 'audio' ? 'audio' : 'video'" :size="12" />{{ clip.text ?? clip.name }}</span><span class="clip-detail">{{ clip.speed !== 1 ? `${clip.speed}× · ` : '' }}{{ clipDuration(clip).toFixed(1) }}s</span><span class="trim-handle end" title="拖动裁剪结尾" @pointerdown.stop="startGesture($event, clip, track, 'trim-end')" />
              </button>
              <div class="lane-playhead" :style="{ left: `${playhead * zoom}px` }" />
            </div>
          </div>
        </div>
      </div>
      <footer class="timeline-footer"><span>空格播放 · S 分割 · 拖动边缘裁剪 · 上层轨道显示在前</span><span>{{ activeProject.tracks.reduce((sum, track) => sum + track.clips.length, 0) }} 个片段 · {{ formatTime(duration) }}</span></footer>
    </section>
    <Teleport to="body"><div v-if="clipMenu" class="clip-context-menu" role="menu" aria-label="文字片段操作" :style="{ left: `${clipMenu.x}px`, top: `${clipMenu.y}px` }"><button role="menuitem" :disabled="clipMenu.locked" @click="generateTextSpeech(clipMenu.clipId)"><Icon name="audio" :size="14" />文字转语音</button><button role="menuitem" :disabled="clipMenu.locked || !project.tracks.some(track => track.clips.some(clip => clip.speech?.textClipId === clipMenu!.clipId))" @click="openSpeech(); speechPanel?.align([clipMenu!.clipId]); clipMenu = null"><Icon name="clock" :size="14" />文字对齐已有语音</button><button role="menuitem" :disabled="clipMenu.locked" @click="duplicateSelected(); clipMenu = null"><Icon name="copy" :size="14" />复制片段</button><button role="menuitem" :disabled="clipMenu.locked" @click="deleteSelected(); clipMenu = null"><Icon name="trash" :size="14" />删除片段</button></div></Teleport>
  </section>
</template>

<style scoped>
.video-editor{--ed-bg:var(--ui-bg,#f5f6fa);--ed-panel:var(--ui-surface,#fff);--ed-border:var(--ui-line,#e3e6ed);--ed-text:var(--ui-text,#202638);--ed-muted:var(--ui-muted,#858b9a);--ed-accent:var(--ui-accent,#3267f6);height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;color:var(--ed-text);font-size:12px;background:var(--ed-bg)}
.selected-speech{width:100%;border:1px solid var(--ed-border);margin-top:12px;color:var(--ed-accent)}.clip-context-menu{position:fixed;z-index:70;width:198px;box-sizing:border-box;padding:5px;border:1px solid var(--ui-line,#e3e6ed);border-radius:8px;background:var(--ui-surface,#fff);color:var(--ui-text,#202638);box-shadow:0 8px 30px #0002;font-size:12px}.clip-context-menu button{width:100%;justify-content:flex-start;padding:6px 8px;font-size:11px}.clip-context-menu button:hover:not(:disabled){color:var(--ui-accent,#3267f6);background:color-mix(in srgb,var(--ui-accent,#3267f6) 9%,transparent)}
button,input,select,textarea{font:inherit}button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;border-radius:6px;min-height:29px;padding:4px 7px;white-space:nowrap}button:hover:not(:disabled){background:color-mix(in srgb,var(--ed-accent) 9%,transparent);color:var(--ed-accent)}button:disabled{opacity:.35;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}input,select,textarea{box-sizing:border-box;min-width:0;width:100%;border:1px solid var(--ed-border);border-radius:6px;padding:7px 8px;background:var(--ed-panel);color:var(--ed-text)}input[type=range]{padding:0;accent-color:var(--ed-accent);height:23px;border:0}input[type=color]{height:30px;padding:3px}textarea{resize:vertical}
.editor-tools{height:49px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--ed-border);background:var(--ed-panel);gap:8px}.tool-group{display:flex;gap:6px;align-items:center;min-width:0}.editor-primary{background:color-mix(in srgb,var(--ed-accent) 11%,transparent);color:var(--ed-accent)}.editor-export{background:var(--ed-accent);color:white!important;padding:7px 13px}.editor-export:hover:not(:disabled){background:var(--ed-accent);filter:brightness(1.08)}.editor-main{display:grid;grid-template-columns:230px minmax(180px,1fr) 245px;flex:1;min-height:220px;overflow:hidden}.asset-panel,.property-panel{background:var(--ed-panel);display:flex;flex-direction:column;min-width:0;min-height:0}.asset-panel{border-right:1px solid var(--ed-border)}.asset-panel header{height:45px;display:flex;align-items:center;padding:0 14px;gap:8px;flex-shrink:0}.asset-panel header button{margin-left:auto}.count{background:var(--ed-bg);color:var(--ed-muted);font-size:10px;border-radius:4px;padding:2px 5px}.asset-search{padding:0 12px 9px}.asset-search input{background:var(--ed-bg);border-color:transparent}.asset-filters{display:flex;gap:4px;padding:0 10px 10px}.asset-filters button{flex:1;font-size:11px;min-height:25px;padding:3px}.asset-filters button.active{background:color-mix(in srgb,var(--ed-accent) 10%,transparent);color:var(--ed-accent)}.asset-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:10px;padding:0 12px 12px;overflow:auto;flex:1;min-height:0}.asset-card{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;text-align:left;padding:0;gap:4px;min-width:0;white-space:normal;border-radius:7px}.asset-thumb{height:66px;position:relative;display:flex;align-items:center;justify-content:center;border-radius:6px;overflow:hidden;background:#242636;color:#c5c0eb}.asset-thumb.audio{background:linear-gradient(135deg,#e6f1ed,#d1e5e1);color:#418c80}.asset-thumb img,.asset-thumb video{width:100%;height:100%;object-fit:cover}.asset-thumb>span{position:absolute;bottom:4px;right:4px;background:#151824bb;color:white;padding:1px 4px;font-size:9px;border-radius:3px}.asset-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;padding:1px 2px}.asset-meta{font-size:9px;color:var(--ed-muted);padding:0 2px}.asset-empty{grid-column:1/-1;display:flex;align-items:center;flex-direction:column;text-align:center;padding:45px 6px 20px;gap:12px;color:var(--ed-muted)}.asset-empty strong{font-weight:500;color:var(--ed-text)}.asset-empty span{font-size:11px;line-height:1.8}.asset-empty button{border:1px solid var(--ed-border);color:var(--ed-accent)}.asset-panel footer{font-size:10px;color:var(--ed-muted);border-top:1px solid var(--ed-border);padding:10px 12px}.preview-panel{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--ed-bg)}.preview-heading{display:flex;align-items:center;gap:10px;padding:8px 14px;color:var(--ed-muted);font-size:10px}.preview-heading .preview-title{font-size:12px;color:var(--ed-text);margin-right:auto}.preview-heading button{min-height:24px;padding:3px}.preview-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:12px 24px 18px;overflow:hidden}.preview-frame{position:relative;display:flex;align-items:center;justify-content:center;max-width:100%;max-height:100%;width:auto;height:100%;background:#171922;box-shadow:0 5px 24px #00000013;overflow:hidden;border-radius:3px}.preview-frame canvas{display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain}.preview-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:13px;color:#737987;background:radial-gradient(ellipse at center,#262835,#181a24);text-align:center;padding:12px}.preview-empty strong{color:#c7cad4;font-size:14px;font-weight:500}.preview-empty span{font-size:11px}.preview-playback{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 16px 12px;gap:8px;flex-shrink:0}.time-code{font-family:ui-monospace,monospace;font-size:10px;white-space:nowrap}.time-code em{font-style:normal;margin-left:6px;color:var(--ed-muted)}.play-controls{display:flex;align-items:center;gap:9px}.play-button{width:34px;height:34px;background:var(--ed-panel);border:1px solid var(--ed-border);border-radius:50%}.preview-scale{font-size:10px;color:var(--ed-muted);text-align:right}.property-panel{border-left:1px solid var(--ed-border)}.property-tabs{display:flex;border-bottom:1px solid var(--ed-border);height:44px;flex-shrink:0;padding:0 12px;gap:16px}.property-tabs button{padding:0;border-radius:0;color:var(--ed-muted);position:relative}.property-tabs button.active{color:var(--ed-text)}.property-tabs button.active:after{content:'';position:absolute;bottom:0;height:2px;background:var(--ed-accent);left:0;right:0}.property-content{padding:13px 14px;overflow:auto;min-height:0}.property-content h3{font-size:11px;font-weight:600;margin:18px 0 12px}.property-content>h3:first-child{margin-top:0}.property-content label{display:flex;flex-direction:column;gap:6px;font-size:10px;color:var(--ed-muted);margin-bottom:11px;position:relative}.property-content label input,.property-content label select{font-size:11px;color:var(--ed-text)}.property-content output{position:absolute;right:0;color:var(--ed-text)}.transform-presets{display:flex;gap:6px;margin-bottom:12px}.transform-presets button,.separate-audio{border:1px solid var(--ed-border);font-size:10px}.separate-audio{margin-bottom:11px}.text-background{display:flex;gap:6px}.text-background input{flex:1}.text-background button{font-size:10px;border:1px solid var(--ed-border)}.text-background button.active{color:var(--ed-accent);border-color:var(--ed-accent)}.property-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 9px}.property-content fieldset{border:0;padding:0;margin:0;min-width:0}.selected-heading{display:flex;align-items:center;gap:7px;min-width:0}.selected-heading strong{font-size:11px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;flex:1}.selected-heading span{font-size:10px;color:var(--ed-muted)}.property-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;padding:62px 15px;color:var(--ed-muted)}.property-empty strong{color:var(--ed-text);font-size:12px;font-weight:500}.property-empty span{line-height:1.8;font-size:11px}.property-empty button{border:1px solid var(--ed-border);font-size:11px}.setting-note{padding:10px;font-size:10px;background:var(--ed-bg);border-radius:6px;line-height:1.7;color:var(--ed-muted)}dl{display:grid;grid-template-columns:1fr auto;gap:10px;font-size:11px}dt{color:var(--ed-muted)}dd{margin:0}
.timeline-panel{height:268px;min-height:175px;max-height:43%;flex-shrink:0;background:var(--ed-panel);border-top:1px solid var(--ed-border);display:flex;flex-direction:column}.timeline-toolbar{height:40px;flex-shrink:0;display:flex;justify-content:space-between;align-items:center;padding:0 14px;border-bottom:1px solid var(--ed-border);gap:12px}.track-add{display:flex;align-items:center;gap:4px}.track-add>span{margin-right:12px;font-size:11px;font-weight:600}.track-add button{gap:0;min-height:25px}.timeline-zoom{display:flex;align-items:center;gap:3px}.timeline-zoom input{width:78px;height:18px}.timeline-zoom button{min-height:24px;padding:3px}.timeline-scroll{overflow:auto;flex:1;min-height:0;overscroll-behavior:contain}.timeline-content{min-width:100%;position:relative}.ruler-row,.track-row{display:flex;min-width:100%;position:relative}.ruler-row{height:28px;position:sticky;top:0;z-index:6;background:var(--ed-panel)}.track-label{width:140px;min-width:140px;position:sticky;left:0;z-index:4;background:var(--ed-panel);border-right:1px solid var(--ed-border);border-bottom:1px solid var(--ed-border);box-sizing:border-box;padding:8px 12px}.ruler-label{font:10px ui-monospace,monospace;color:var(--ed-muted);z-index:8;padding:7px 12px}.timeline-ruler{position:relative;border-bottom:1px solid var(--ed-border);height:28px;box-sizing:border-box;cursor:crosshair}.timeline-ruler>span{position:absolute;top:0;padding:5px 0 0 6px;height:100%;box-sizing:border-box;font:9px ui-monospace,monospace;color:var(--ed-muted);border-left:1px solid var(--ed-border)}.ruler-playhead{position:absolute;top:15px;width:10px;height:13px;transform:translateX(-5px);background:var(--ed-accent);clip-path:polygon(0 0,100% 0,100% 60%,50% 100%,0 60%);pointer-events:none;z-index:3}.track-row{height:61px}.track-name{display:flex;gap:6px;align-items:center;font-size:10px}.track-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track-actions{display:flex;gap:4px;margin-top:3px}.track-actions button{padding:2px;min-height:17px;width:21px;color:var(--ed-muted)}.track-actions button.enabled{color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 10%,transparent)}.track-lane{position:relative;height:61px;box-sizing:border-box;border-bottom:1px solid var(--ed-border);background-image:linear-gradient(to right,var(--ed-border) 1px,transparent 1px);background-color:var(--ed-bg);cursor:crosshair}.track-hint{font-size:10px;color:var(--ed-muted);position:absolute;left:15px;top:24px;pointer-events:none;user-select:none}.timeline-clip{position:absolute;top:7px;height:46px;min-height:0;border-radius:5px;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;padding:7px 10px;gap:3px;text-align:left;overflow:hidden;cursor:grab;touch-action:none;user-select:none;border:1px solid #a2a4e0;background:#dcdcf3;color:#55538a;font-size:10px}.timeline-clip:hover:not(:disabled){background:#d2d1ee;color:#514d89}.timeline-clip.audio{border-color:#8ac3b0;background:#d2eae1;color:#377d68}.timeline-clip.text{border-color:#d6ba83;background:#f5e7c7;color:#967137}.timeline-clip.selected{outline:2px solid var(--ed-accent);outline-offset:0;z-index:2}.clip-title{display:flex;align-items:center;gap:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}.clip-title svg{flex-shrink:0}.clip-detail{font-size:8px;opacity:.8;pointer-events:none}.trim-handle{position:absolute;top:0;bottom:0;width:7px;z-index:2;cursor:ew-resize}.trim-handle:after{content:'';display:block;position:absolute;top:15px;bottom:15px;width:2px;background:currentColor;opacity:.35;border-radius:2px}.trim-handle.start{left:0}.trim-handle.start:after{left:2px}.trim-handle.end{right:0}.trim-handle.end:after{right:2px}.locked .timeline-clip,.locked .trim-handle{cursor:not-allowed;opacity:.65}.lane-playhead{position:absolute;top:0;bottom:0;width:1px;background:var(--ed-accent);z-index:3;pointer-events:none}.timeline-footer{height:24px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-top:1px solid var(--ed-border);flex-shrink:0;color:var(--ed-muted);font-size:9px;gap:12px}.timeline-footer span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(min-width:1500px){.editor-main{grid-template-columns:260px minmax(180px,1fr) 270px}.asset-thumb{height:78px}.timeline-panel{height:295px}}
@media(max-width:1100px){.editor-main{grid-template-columns:190px minmax(160px,1fr) 220px}.asset-list{gap:8px;padding:0 9px 10px}.asset-thumb{height:56px}.preview-stage{padding:10px}.preview-scale{display:none}.preview-playback{grid-template-columns:1fr auto;padding:0 10px 10px}.property-content{padding:12px 10px}.preview-empty strong{font-size:12px}.timeline-panel{height:240px}}
@media(max-width:860px){.editor-main{grid-template-columns:160px minmax(150px,1fr)}.property-panel{grid-column:1/-1;position:absolute;right:16px;top:120px;bottom:280px;width:230px;box-shadow:0 6px 35px #0002;border:1px solid var(--ed-border);border-radius:8px;z-index:10;display:none}.video-editor:focus-within .property-panel:focus-within{display:flex}.asset-list{grid-template-columns:1fr}.asset-thumb{height:78px}.property-panel:is(:has(.property-content),.speech-open){display:flex;position:static;grid-column:auto;width:auto;box-shadow:none;border-radius:0;border-top:0;border-right:0;border-bottom:0}.editor-main:has(.property-content,.speech-open){grid-template-columns:130px minmax(150px,1fr) 190px}.asset-filters{flex-wrap:wrap}.asset-filters button{flex:1 0 40%}.preview-heading>span:nth-child(2){display:none}.preview-empty strong{font-size:11px}.preview-empty>svg{width:25px;height:25px}}
@media(max-width:600px){.editor-tools{height:44px;padding:0 8px;gap:4px}.tool-group{gap:2px}.tool-group button{padding:4px 6px}.tool-group button:not(.editor-primary)>span{display:none}.editor-export{padding:6px 8px;font-size:11px}.editor-main,.editor-main:has(.property-content,.speech-open){display:flex;flex-wrap:wrap;overflow:auto;min-height:230px}.asset-panel{width:110px;border-bottom:1px solid var(--ed-border);flex-shrink:0;min-height:230px;max-height:280px}.asset-panel header{height:35px;padding:0 8px;font-size:10px;gap:4px}.asset-panel header button{padding:3px;min-height:22px}.asset-panel .count{display:none}.asset-search{padding:0 7px 6px}.asset-search input{padding:5px;font-size:10px}.asset-filters{padding:0 6px 6px;gap:1px}.asset-filters button{font-size:10px;min-height:20px}.asset-thumb{height:48px}.asset-panel footer{display:none}.asset-empty{padding:15px 0;gap:9px}.asset-empty strong{font-size:10px}.asset-empty span{font-size:9px}.asset-empty button{font-size:10px;padding:4px}.asset-empty>svg{width:22px;height:22px}.asset-list{padding:0 7px 8px}.preview-panel{width:calc(100% - 110px);min-height:230px;max-height:280px}.preview-heading{padding:6px 8px}.preview-stage{padding:5px 8px;min-height:120px}.preview-empty span{font-size:9px}.preview-playback{display:flex;flex-direction:column;gap:5px;padding:5px 8px 10px}.play-controls{gap:10px}.play-controls button{min-height:25px;padding:2px}.play-button{width:28px;height:28px}.time-code{font-size:9px}.property-panel:is(:has(.property-content),.speech-open){display:flex;width:100%;border-left:0;border-top:1px solid var(--ed-border);height:230px;min-height:230px}.property-content{padding:10px 14px}.property-tabs{height:35px}.property-content fieldset{display:grid;grid-template-columns:1fr 1fr;column-gap:12px;align-items:start}.property-content fieldset h3,.property-content fieldset textarea,.property-content fieldset>.property-grid{grid-column:1/-1}.property-content fieldset>.property-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.timeline-panel{height:230px;max-height:40%;min-height:180px}.timeline-toolbar{padding:0 8px;height:36px;gap:4px}.track-add{gap:0}.track-add>span{margin-right:6px;font-size:10px}.track-add button{padding:3px 4px}.timeline-zoom input{width:45px}.timeline-zoom button{padding:3px}.timeline-footer{padding:0 8px;font-size:8px}.timeline-footer>span:first-child{max-width:55%}.property-empty{display:none}}
@media(max-width:430px){.editor-primary>span{display:none}.timeline-zoom input{width:30px}.editor-tools{padding-inline:6px}.track-add>span{margin-right:3px}.timeline-toolbar{padding-inline:6px}}
</style>
