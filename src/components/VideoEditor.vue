<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Clip, MediaAsset, Project, Track, TrackKind } from '../core/types'
import { cloneProject, createClip, createTextClip, createTrack, newId, validateProject } from '../core/project'
import { addClip, addTrack, clipDuration, clipEnd, deleteClip, duplicateClip, findClip, moveClip, projectDuration, removeTrack, reorderTrack, setTrack, splitClip, updateClip } from '../core/timeline'
import { closeTimelineGaps, deleteClipAndCloseGap, findNearestSnap, trimClipAtPlayhead } from '../core/timeline-editing'
import { TimelinePreview } from '../core/preview'
import Icon from './Icon.vue'
import SpeechPanel from './SpeechPanel.vue'
import EditorDialog from './EditorDialog.vue'
import TimelineDivider from './TimelineDivider.vue'
import ClipFilterPanel from './ClipFilterPanel.vue'
import AudioClipPlayer from './AudioClipPlayer.vue'

const props = defineProps<{ project: Project; exportDisabled?: boolean }>()
const emit = defineEmits<{ change: [project: Project, label?: string]; import: [files?: File[]]; export: []; status: [message: string]; busy: [value: boolean] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const editorRoot = ref<HTMLElement | null>(null)
const timelineRatio = ref(0.4), timelineHeight = ref(268)
const timelineScroll = ref<HTMLElement | null>(null)
const timelineOffset = ref(0)
const timelineViewport = ref(900)
const selectedId = ref('')
const inspectorTab = ref<'properties' | 'filters'>('properties')
const playhead = ref(0)
const playing = ref(false)
const preparingPlayback = ref(false)
const zoom = ref(44)
const assetFilter = ref('all')
const search = ref('')
const editorDialog = ref<'speech' | 'project' | null>(null)
const modalOpen = computed(() => editorDialog.value !== null)
const dialogReturnFocus = ref<HTMLElement | null>(null)
const speechPanel = ref<InstanceType<typeof SpeechPanel> | null>(null)
const audioClipPlayer = ref<InstanceType<typeof AudioClipPlayer> | null>(null)
const speechBusy = ref(false)
const clipMenu = ref<{ x: number; y: number; clipId: string } | null>(null)
const trackMenu = ref<{ x: number; y: number; trackId: string } | null>(null)
const menuElement = ref<HTMLElement | null>(null)
const renamingTrackId = ref(''), trackName = ref('')
const pendingTrackDelete = ref<{ project: Project; trackId: string } | null>(null)
const deleteTrackDialog = ref<HTMLElement | null>(null)
const deleteTrackError = ref('')
const snapEnabled = ref(true), snapGuide = ref<number | null>(null)
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
const canSplit = computed(() => canTrim('start') && canTrim('end'))
const canTrimStart = computed(() => canTrim('start'))
const canTrimEnd = computed(() => canTrim('end'))
const menuTrack = computed(() => props.project.tracks.find(track => track.id === trackMenu.value?.trackId))
const menuTrackIndex = computed(() => props.project.tracks.findIndex(track => track.id === trackMenu.value?.trackId))
const deletingTrack = computed(() => props.project.tracks.find(track => track.id === pendingTrackDelete.value?.trackId))
const selectedVideo = computed(() => selected.value?.track.kind === 'video' && props.project.assets.find(asset => asset.id === selected.value?.clip.assetId)?.kind === 'video')
const selectedSupportsAudioPlayback = computed(() => {
  if (selected.value?.track.kind !== 'audio') return false
  const asset = activeProject.value.assets.find(item => item.id === selected.value?.clip.assetId)
  return asset?.kind === 'audio' || asset?.kind === 'video'
})
const selectedSupportsFilters = computed(() => {
  if (!selected.value || selected.value.track.kind !== 'video' || selected.value.clip.text !== undefined) return false
  const asset = activeProject.value.assets.find(item => item.id === selected.value?.clip.assetId)
  return asset?.kind === 'video' || asset?.kind === 'image'
})
watch(selectedSupportsFilters, supported => { if (!supported) inspectorTab.value = 'properties' })
let preview: TimelinePreview | undefined
let frame = 0
let resizeObserver: ResizeObserver | undefined
let playbackStarted = 0
let playbackOffset = 0
let playbackRequest = 0
let playbackAbort: AbortController | undefined
let gesture: { kind: 'move' | 'trim-start' | 'trim-end'; clipId: string; trackId: string; startX: number; startScroll: number; original: Clip; base: Project } | undefined
let menuReturnFocus: HTMLElement | null = null
let deleteReturnFocus: HTMLElement | null = null

function message(error: unknown): void { emit('status', error instanceof Error ? error.message : String(error)) }
function commit(action: () => Project, label: string): boolean {
  if (speechBusy.value) return false
  try { emit('change', action(), label); return true } catch (error) { message(error); return false }
}
function setSpeechBusy(value: boolean): void {
  speechBusy.value = value
  if (value) { pause(); cancelGesture(); closeMenus(); finishTrackRename(false); cancelTrackDelete(); editorDialog.value = 'speech' }
  emit('busy', value)
}
function openEditorDialog(kind: 'speech' | 'project'): void {
  if (speechBusy.value) return
  const focused = document.activeElement
  dialogReturnFocus.value = focused instanceof HTMLElement && !focused.closest('.clip-context-menu') ? focused : menuReturnFocus
  pause(); cancelGesture(); closeMenus(); finishTrackRename(); editorDialog.value = kind
}
function openSpeech(): void { openEditorDialog('speech') }
function closeEditorDialog(): void { if (!speechBusy.value) editorDialog.value = null }
function generateTextSpeech(clipId: string): void {
  if (speechBusy.value) return
  closeMenus(); selectedId.value = clipId; openSpeech()
  void speechPanel.value?.generate([clipId])
}
function openClipMenu(event: MouseEvent, clip: Clip, track: Track): void {
  if (speechBusy.value || pendingTrackDelete.value) return
  event.preventDefault(); event.stopPropagation()
  pause(); cancelGesture(); closeMenus(); selectedId.value = clip.id
  menuReturnFocus = event.currentTarget as HTMLElement
  const rect = menuReturnFocus.getBoundingClientRect()
  clipMenu.value = { x: event.clientX || rect.left, y: event.clientY || rect.bottom, clipId: clip.id }
  void positionMenu()
}
function openTrackMenu(event: MouseEvent, track: Track): void {
  if (speechBusy.value || pendingTrackDelete.value) return
  event.preventDefault(); event.stopPropagation()
  pause(); cancelGesture(); closeMenus()
  menuReturnFocus = event.currentTarget as HTMLElement
  const rect = menuReturnFocus.getBoundingClientRect()
  trackMenu.value = { x: event.type === 'contextmenu' && event.clientX ? event.clientX : rect.left, y: event.type === 'contextmenu' && event.clientY ? event.clientY : rect.bottom, trackId: track.id }
  void positionMenu()
}
async function positionMenu(): Promise<void> {
  await nextTick()
  const value = clipMenu.value || trackMenu.value, element = menuElement.value
  if (!value || !element) return
  const bounds = element.getBoundingClientRect()
  value.x = Math.max(8, Math.min(value.x, window.innerWidth - bounds.width - 8))
  value.y = Math.max(8, Math.min(value.y, window.innerHeight - bounds.height - 8))
  ;(element.querySelector<HTMLButtonElement>('button:not(:disabled)') || element).focus({ preventScroll: true })
}
function restoreMenuFocus(): void {
  void nextTick(() => {
    if (modalOpen.value) return
    if (menuReturnFocus?.isConnected) menuReturnFocus.focus({ preventScroll: true })
    else timelineScroll.value?.focus({ preventScroll: true })
  })
}
function closeMenus(restoreFocus = false): void {
  clipMenu.value = null; trackMenu.value = null
  if (restoreFocus) restoreMenuFocus()
}
function outsideMenus(event: PointerEvent): void {
  if (!(event.target as HTMLElement).closest('.clip-context-menu')) closeMenus()
}
function menuAction(action: () => void): void {
  action(); closeMenus()
  if (!renamingTrackId.value && !pendingTrackDelete.value && !speechBusy.value && !modalOpen.value) restoreMenuFocus()
}
function menuKeyboard(event: KeyboardEvent): void {
  event.stopPropagation()
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); closeMenus(true); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault(); event.stopPropagation()
  const buttons = [...(menuElement.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
function startTrackRename(track: Track): void {
  if (speechBusy.value || track.locked) return
  closeMenus(); renamingTrackId.value = track.id; trackName.value = track.name
  void nextTick(() => { const input = document.querySelector<HTMLInputElement>('.track-rename-input'); input?.focus(); input?.select() })
}
function finishTrackRename(save = true): void {
  const id = renamingTrackId.value, name = trackName.value.trim()
  renamingTrackId.value = ''
  const track = props.project.tracks.find(item => item.id === id)
  if (!save || !track || track.locked || speechBusy.value) return
  if (!name) { emit('status', '轨道名称不能为空。'); return }
  if (name !== track.name) commit(() => setTrack(props.project, id, { name }), '重命名轨道')
}
function changeTrackOrder(track: Track, delta: number): void {
  if (speechBusy.value || track.locked) return
  commit(() => reorderTrack(props.project, track.id, props.project.tracks.findIndex(item => item.id === track.id) + delta), '调整轨道层级')
}
function requestTrackDelete(track: Track): void {
  if (speechBusy.value || track.locked) return
  if (!track.clips.length) { commit(() => removeTrack(props.project, track.id), '删除空轨道'); return }
  pause(); cancelGesture()
  deleteReturnFocus = menuReturnFocus
  deleteTrackError.value = ''
  pendingTrackDelete.value = { project: props.project, trackId: track.id }
  void nextTick(() => deleteTrackDialog.value?.querySelector<HTMLButtonElement>('[data-cancel-track]')?.focus())
}
function cancelTrackDelete(): void {
  if (!pendingTrackDelete.value) return
  pendingTrackDelete.value = null
  void nextTick(() => { if (deleteReturnFocus?.isConnected) deleteReturnFocus.focus({ preventScroll: true }); else timelineScroll.value?.focus({ preventScroll: true }) })
}
function confirmTrackDelete(): void {
  const pending = pendingTrackDelete.value, track = deletingTrack.value
  if (!pending || !track || speechBusy.value || track.locked || pending.project !== props.project) { cancelTrackDelete(); return }
  try {
    const next = removeTrack(props.project, track.id)
    if (commit(() => next, '删除轨道及片段')) { if (track.clips.some(clip => clip.id === selectedId.value)) selectedId.value = ''; cancelTrackDelete() }
  } catch (error) { deleteTrackError.value = error instanceof Error ? error.message : String(error); message(error) }
}
function deleteDialogKeyboard(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelTrackDelete(); return }
  if (event.key !== 'Tab') return
  const buttons = [...(deleteTrackDialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
  if (!buttons.length) return
  event.preventDefault(); event.stopPropagation()
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
}
function formatTime(value: number, frames = false): string {
  const seconds = Math.max(0, value)
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60).toString().padStart(2, '0')
  return frames ? `${minutes.toString().padStart(2, '0')}:${remaining}:${Math.floor((seconds % 1) * activeProject.value.fps).toString().padStart(2, '0')}` : `${minutes}:${remaining}`
}
function seek(time: number): void {
  audioClipPlayer.value?.stop()
  if (preparingPlayback.value) pause()
  playhead.value = Math.max(0, Math.min(duration.value || timelineSeconds.value, frameTime(time)))
  playbackStarted = performance.now()
  playbackOffset = playhead.value
  preview?.seek(playhead.value, playing.value)
}
function pause(): void {
  audioClipPlayer.value?.stop()
  pauseTimeline()
}
function pauseTimeline(): void {
  playbackRequest++
  playbackAbort?.abort()
  playbackAbort = undefined
  preparingPlayback.value = false
  playing.value = false
  cancelAnimationFrame(frame)
  preview?.pause()
}
async function togglePlay(): Promise<void> {
  audioClipPlayer.value?.stop()
  if (playing.value || preparingPlayback.value) { pause(); return }
  if (!duration.value || !preview) return
  const renderer = preview
  const request = ++playbackRequest
  const abort = new AbortController()
  playbackAbort = abort
  preparingPlayback.value = true
  if (playhead.value >= duration.value) playhead.value = 0
  try {
    try { await renderer.enableAudio() } catch { if (!abort.signal.aborted) emit('status', '音频预览暂不可用，仍可查看画面') }
    if (abort.signal.aborted || request !== playbackRequest) return
    await renderer.playReady(playhead.value, abort.signal)
    if (abort.signal.aborted || request !== playbackRequest) return
    playing.value = true
    preparingPlayback.value = false
    playbackOffset = playhead.value
    playbackStarted = performance.now()
    const tick = () => {
      if (!playing.value || request !== playbackRequest) return
      playhead.value = Math.min(duration.value, playbackOffset + (performance.now() - playbackStarted) / 1000)
      renderer.render(Math.min(playhead.value, Math.max(0, duration.value - 0.001)), playhead.value < duration.value)
      if (playhead.value >= duration.value) pause()
      else frame = requestAnimationFrame(tick)
    }
    tick()
  } catch (cause) {
    if (request !== playbackRequest) return
    playing.value = false
    renderer.pause()
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) message(cause)
  } finally {
    if (request === playbackRequest) { preparingPlayback.value = false; playbackAbort = undefined }
  }
}
function addAssetToTimeline(asset: MediaAsset, targetTrackId?: string, time = playhead.value): void {
  commit(() => {
    let project = props.project
    let track = targetTrackId ? project.tracks.find(item => item.id === targetTrackId) : project.tracks.find(item => item.kind === (asset.kind === 'audio' ? 'audio' : 'video') && !item.locked)
    if (!track) { track = createTrack(asset.kind === 'audio' ? 'audio' : 'video'); project = addTrack(project, track) }
    const clip = createClip(asset, project, { start: Math.max(0, time) })
    selectedId.value = clip.id
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
    delete clip.filters
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
function inspectorTabKeyboard(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault(); event.stopPropagation()
  inspectorTab.value = event.key === 'Home' ? 'properties' : event.key === 'End' ? 'filters' : inspectorTab.value === 'properties' ? 'filters' : 'properties'
  const list = event.currentTarget as HTMLElement
  void nextTick(() => list.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus())
}
function numberValue(event: Event): number { return Number((event.target as HTMLInputElement).value) }
function stringValue(event: Event): string { return (event.target as HTMLInputElement).value }
function frameTime(value: number): number { return Math.round(value * props.project.fps) / props.project.fps }
function canTrim(side: 'start' | 'end'): boolean {
  const current = selected.value
  if (!current || current.track.locked || speechBusy.value) return false
  const time = frameTime(playhead.value), start = current.clip.start, end = clipEnd(current.clip)
  return side === 'start' ? time > start + 1e-7 && end - time >= 1 / props.project.fps - 1e-7 : time < end - 1e-7 && time - start >= 1 / props.project.fps - 1e-7
}
function trimSelected(side: 'start' | 'end'): void {
  if (!canTrim(side)) return
  pause(); commit(() => trimClipAtPlayhead(props.project, selectedId.value, frameTime(playhead.value), side), side === 'start' ? '裁掉播放头左侧' : '裁掉播放头右侧')
}
function splitSelected(): void { if (canSplit.value) { pause(); commit(() => splitClip(props.project, selectedId.value, frameTime(playhead.value)), '分割片段') } }
function duplicateSelected(): void { if (selected.value) commit(() => duplicateClip(props.project, selectedId.value), '复制片段') }
function deleteSelected(closeGap = false): void {
  if (!selected.value || selectedLocked.value || speechBusy.value) return
  pause()
  try {
    const next = closeGap ? deleteClipAndCloseGap(props.project, selectedId.value) : deleteClip(props.project, selectedId.value)
    const label = !closeGap ? '删除片段' : positionsChanged(props.project, next) ? '已删除并接拢公共空隙' : '已删除片段；没有可接拢的公共空隙，其余片段保持原位。'
    if (commit(() => next, label)) selectedId.value = ''
  } catch (error) { message(error) }
}
function positionsChanged(before: Project, after: Project): boolean {
  const positions = new Map(before.tracks.flatMap(track => track.clips.map(clip => [clip.id, clip.start] as const)))
  return after.tracks.some(track => track.clips.some(clip => Math.abs((positions.get(clip.id) ?? clip.start) - clip.start) > 1e-7))
}
function closeGaps(): void {
  if (speechBusy.value) return
  pause(); cancelGesture()
  try {
    const next = closeTimelineGaps(props.project)
    if (!positionsChanged(props.project, next)) { emit('status', '没有需要接拢的全轨公共空隙。其他轨道仍有内容的时间段会保留。'); return }
    commit(() => next, '已接拢全轨公共空隙')
  } catch (error) { message(error) }
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
  if (speechBusy.value || track.locked || pendingTrackDelete.value) return
  const assetId = event.dataTransfer?.getData('application/x-open-media-asset')
  const asset = props.project.assets.find(item => item.id === assetId)
  if (asset) {
    const row = event.currentTarget as HTMLElement
    const time = Math.max(0, (event.clientX - row.getBoundingClientRect().left) / zoom.value)
    addAssetToTimeline(asset, track.id, Math.round(time * props.project.fps) / props.project.fps)
  } else if (event.dataTransfer?.files.length) emit('import', [...event.dataTransfer.files])
}
function setPlayheadFromPointer(event: PointerEvent): void {
  if (event.button !== 0 || speechBusy.value || pendingTrackDelete.value || (event.target as HTMLElement).closest('.timeline-clip')) return
  const row = event.currentTarget as HTMLElement
  seek((event.clientX - row.getBoundingClientRect().left) / zoom.value)
}
function startGesture(event: PointerEvent, clip: Clip, track: Track, kind: 'move' | 'trim-start' | 'trim-end'): void {
  if (event.button !== 0 || speechBusy.value) return
  event.preventDefault(); event.stopPropagation()
  ;(event.currentTarget as HTMLElement).closest<HTMLButtonElement>('.timeline-clip')?.focus({ preventScroll: true })
  selectedId.value = clip.id
  if (track.locked) return
  pause(); closeMenus()
  gesture = { kind, clipId: clip.id, trackId: track.id, startX: event.clientX, startScroll: timelineScroll.value?.scrollLeft || 0, original: { ...clip }, base: props.project }
  window.addEventListener('pointermove', moveGesture)
  window.addEventListener('pointerup', endGesture, { once: true })
  window.addEventListener('pointercancel', cancelGesture, { once: true })
}
function snapCandidates(base: Project, clipId: string): number[] {
  return [0, playhead.value, ...base.tracks.flatMap(track => track.clips.filter(clip => clip.id !== clipId).flatMap(clip => [clip.start, clipEnd(clip)]))]
}
function snapCandidate(value: number, candidates: number[], min: number, max: number, bypass: boolean): number | null {
  if (!snapEnabled.value || bypass) return null
  const allowed = candidates.filter(candidate => candidate >= min - 1e-7 && candidate <= max + 1e-7)
  const snapped = findNearestSnap(value, allowed, 7 / zoom.value)
  return allowed.includes(snapped) ? snapped : null
}
function boundedFrame(value: number, min: number, max: number): number {
  const lower = Math.ceil((min - 1e-7) * props.project.fps) / props.project.fps, upper = Math.floor((max + 1e-7) * props.project.fps) / props.project.fps
  return lower <= upper ? Math.max(lower, Math.min(upper, frameTime(value))) : Math.max(min, Math.min(max, value))
}
function moveGesture(event: PointerEvent): void {
  if (!gesture) return
  const { original, base, clipId, kind } = gesture
  const delta = (event.clientX - gesture.startX + (timelineScroll.value?.scrollLeft || 0) - gesture.startScroll) / zoom.value
  const candidates = snapCandidates(base, clipId)
  snapGuide.value = null
  try {
    if (kind === 'move') {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-track-id]')
      const targetId = target?.dataset.trackId || gesture.trackId
      const length = clipDuration(original), max = 86400 - length, start = Math.max(0, Math.min(max, original.start + delta))
      const left = snapCandidate(start, candidates, 0, max, event.shiftKey), right = snapCandidate(start + length, candidates, length, 86400, event.shiftKey)
      let destination = boundedFrame(start, 0, max)
      if (left !== null && (right === null || Math.abs(left - start) <= Math.abs(right - start - length))) { destination = left; snapGuide.value = left }
      else if (right !== null) { destination = right - length; snapGuide.value = right }
      workingProject.value = moveClip(base, clipId, targetId, destination)
    } else if (kind === 'trim-start') {
      const min = Math.max(0, original.start - original.trimIn / original.speed), max = clipEnd(original) - 1 / props.project.fps
      const raw = Math.max(min, Math.min(max, original.start + delta)), snapped = snapCandidate(raw, candidates, min, max, event.shiftKey)
      const start = snapped ?? boundedFrame(raw, min, max)
      snapGuide.value = snapped
      workingProject.value = updateClip(base, clipId, { start, trimIn: original.trimIn + (start - original.start) * original.speed })
    } else {
      const asset = base.assets.find(item => item.id === original.assetId)
      const limit = asset && asset.kind !== 'image' ? asset.duration : 86400
      const min = original.start + 1 / props.project.fps, max = Math.min(86400, original.start + (limit - original.trimIn) / original.speed)
      const raw = Math.max(min, Math.min(max, clipEnd(original) + delta)), snapped = snapCandidate(raw, candidates, min, max, event.shiftKey)
      const end = snapped ?? boundedFrame(raw, min, max), trimOut = original.trimIn + (end - original.start) * original.speed
      snapGuide.value = snapped
      workingProject.value = updateClip(base, clipId, { trimOut })
    }
  } catch { snapGuide.value = null /* Incompatible or locked tracks leave the last valid drag position intact. */ }
}
function clearGesture(): void {
  window.removeEventListener('pointermove', moveGesture)
  window.removeEventListener('pointerup', endGesture)
  window.removeEventListener('pointercancel', cancelGesture)
  gesture = undefined; snapGuide.value = null
}
function endGesture(): void {
  const project = workingProject.value
  const label = gesture?.kind === 'move' ? '移动片段' : '裁剪片段'
  workingProject.value = null
  clearGesture()
  if (project && !speechBusy.value) emit('change', project, label)
}
function cancelGesture(): void { workingProject.value = null; clearGesture() }
function fitTimeline(): void { zoom.value = Math.max(6, Math.min(160, ((timelineScroll.value?.clientWidth || 900) - 160) / Math.max(10, duration.value + 2))) }
function keyboard(event: KeyboardEvent): void {
  if (event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return
  if (event.key === 'Escape' && (clipMenu.value || trackMenu.value)) { event.preventDefault(); closeMenus(true); return }
  if (speechBusy.value || pendingTrackDelete.value || modalOpen.value) return
  const element = event.target as HTMLElement
  if (element.closest('input,textarea,select,[contenteditable="true"],dialog,[role="dialog"],.speech-panel,.clip-context-menu,.audio-clip-player')) return
  if (event.code === 'Space') { event.preventDefault(); void togglePlay() }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selected.value && !event.ctrlKey && !event.metaKey) { event.preventDefault(); deleteSelected(event.shiftKey) }
  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.key.toLowerCase() === 's') { event.preventDefault(); splitSelected() }
    if (event.key.toLowerCase() === 'q') { event.preventDefault(); trimSelected('start') }
    if (event.key.toLowerCase() === 'w') { event.preventDefault(); trimSelected('end') }
  }
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
watch(() => props.project, project => {
  if (gesture && project !== gesture.base) cancelGesture()
  if (pendingTrackDelete.value && project !== pendingTrackDelete.value.project) cancelTrackDelete()
  if (clipMenu.value && !findClip(project, clipMenu.value.clipId)) closeMenus()
  if (trackMenu.value && !project.tracks.some(track => track.id === trackMenu.value?.trackId)) closeMenus()
})
watch(() => props.project.id, () => { pause(); cancelGesture(); closeMenus(); renamingTrackId.value = ''; cancelTrackDelete(); editorDialog.value = null; selectedId.value = ''; seek(0) })
onMounted(() => {
  if (canvas.value) {
    canvas.value.width = Math.min(1280, props.project.width)
    canvas.value.height = Math.round(canvas.value.width * props.project.height / props.project.width)
    preview = new TimelinePreview(canvas.value, props.project, message)
  }
  if (timelineScroll.value) { resizeObserver = new ResizeObserver(entries => { timelineViewport.value = entries[0].contentRect.width }); resizeObserver.observe(timelineScroll.value) }
  window.addEventListener('keydown', keyboard)
  window.addEventListener('pointerdown', outsideMenus)
  window.addEventListener('resize', closeMenusOnResize)
})
function closeMenusOnResize(): void { closeMenus() }
onBeforeUnmount(() => { pause(); cancelGesture(); resizeObserver?.disconnect(); preview?.dispose(); window.removeEventListener('keydown', keyboard); window.removeEventListener('pointerdown', outsideMenus); window.removeEventListener('resize', closeMenusOnResize) })
defineExpose({ getCanvas: () => canvas.value, pause, seek })
</script>

<template>
  <section ref="editorRoot" class="video-editor" data-testid="video-editor" :inert="pendingTrackDelete ? true : undefined">
    <div class="editor-tools" :inert="speechBusy || undefined">
      <div class="tool-group">
        <button class="editor-primary" title="导入素材" aria-label="导入素材" @click="emit('import')"><Icon name="import" :size="16" /><span>导入素材</span></button>
        <button title="文字转语音" aria-label="文字转语音" :class="{ 'editor-primary': editorDialog === 'speech' }" @click="openSpeech"><Icon name="audio" :size="16" /><span>配音</span></button>
      </div>
      <div class="editor-output-actions">
        <button class="project-settings-button" title="项目设置" aria-label="项目设置" aria-haspopup="dialog" :disabled="speechBusy" @click="openEditorDialog('project')"><Icon name="settings" :size="18" /></button>
        <button class="editor-export" data-testid="export-project" :disabled="!duration || exportDisabled || speechBusy" @click="pause(); emit('export')"><Icon name="export" :size="16" />导出视频</button>
      </div>
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
        <div class="preview-heading"><span class="preview-title">预览</span><span>{{ project.width }} × {{ project.height }} · {{ project.fps }} fps</span></div>
        <div class="preview-stage">
          <div class="preview-frame" :style="{ aspectRatio: ratio }"><canvas ref="canvas" aria-label="视频合成预览" data-testid="video-preview" /><div v-if="!duration" class="preview-empty"><Icon name="video" :size="38" /><strong>你的故事，从这里开始</strong><span>将素材放入下方时间线</span></div></div>
        </div>
        <div class="preview-playback"><span class="time-code">{{ formatTime(playhead, true) }}<em>/ {{ formatTime(duration, true) }}</em></span><div class="play-controls"><button title="回到开头" @click="seek(0)"><Icon name="skip-back" :size="17" /></button><button class="play-button" :disabled="!duration" :title="preparingPlayback ? '正在准备播放，点击取消' : playing ? '暂停（空格）' : '播放（空格）'" :aria-busy="preparingPlayback" data-testid="preview-play" @click="togglePlay"><Icon :name="preparingPlayback ? 'clock' : playing ? 'pause' : 'play'" :size="20" /></button><button title="跳到结尾" @click="seek(duration)"><Icon name="skip-forward" :size="17" /></button></div><span class="preview-scale">适应窗口</span></div>
      </main>
      <aside class="property-panel" :inert="speechBusy || undefined">
        <header class="property-heading">
          <div v-if="selectedSupportsFilters" class="property-tabs" role="tablist" aria-label="片段设置" @keydown="inspectorTabKeyboard">
            <button id="clip-properties-tab" type="button" role="tab" :aria-selected="inspectorTab === 'properties'" aria-controls="clip-properties-panel" :tabindex="inspectorTab === 'properties' ? 0 : -1" @click="inspectorTab = 'properties'"><Icon name="sliders" :size="14" />属性</button>
            <button id="clip-filters-tab" type="button" role="tab" :aria-selected="inspectorTab === 'filters'" aria-controls="clip-filters-panel" :tabindex="inspectorTab === 'filters' ? 0 : -1" @click="inspectorTab = 'filters'"><Icon name="sun" :size="14" />滤镜</button>
          </div>
          <span v-else>片段属性</span>
        </header>
        <div v-if="selected" class="property-content">
          <div class="selected-heading"><Icon :name="selected.track.kind === 'text' ? 'text' : selected.track.kind === 'audio' ? 'audio' : 'video'" :size="16" /><strong>{{ selected.clip.name }}</strong><span v-if="selectedLocked">已锁定</span></div>
          <section v-show="inspectorTab === 'properties'" id="clip-properties-panel" :role="selectedSupportsFilters ? 'tabpanel' : undefined" :aria-labelledby="selectedSupportsFilters ? 'clip-properties-tab' : undefined" :tabindex="selectedSupportsFilters ? 0 : undefined">
          <AudioClipPlayer v-if="selectedSupportsAudioPlayback" :key="`${project.id}:${selected.clip.id}`" ref="audioClipPlayer" :project="activeProject" :clip="selected.clip" :disabled="speechBusy || modalOpen || !!exportDisabled" @play-request="pauseTimeline" @status="message" />
          <button v-if="selected.clip.text !== undefined" class="selected-speech" :disabled="selectedLocked || !selected.clip.text.trim()" @click="openSpeech"><Icon name="audio" :size="13" />文字转语音</button>
          <fieldset :disabled="selectedLocked">
            <template v-if="selected.clip.text !== undefined"><h3>文本</h3><textarea :value="selected.clip.text" rows="3" aria-label="字幕内容" @change="updateSelected({ text: stringValue($event) }, '编辑字幕')" /><div class="property-grid"><label>字号<input type="number" min="4" max="2048" :value="selected.clip.fontSize" @change="updateSelected({ fontSize: numberValue($event) })" /></label><label>颜色<input type="color" :value="selected.clip.color" @change="updateSelected({ color: stringValue($event) })" /></label></div><label>字体<select :value="selected.clip.fontFamily" @change="updateSelected({ fontFamily: stringValue($event) })"><option value="sans-serif">无衬线</option><option value="serif">衬线</option><option value="monospace">等宽</option></select></label><label>文字底色<div class="text-background"><input type="color" :value="selected.clip.background === 'transparent' ? '#000000' : selected.clip.background" aria-label="文字底色" @change="updateSelected({ background: stringValue($event) })" /><button :class="{ active: selected.clip.background === 'transparent' }" @click="updateSelected({ background: 'transparent' })">透明</button></div></label><label>对齐<select :value="selected.clip.textAlign" @change="updateSelected({ textAlign: stringValue($event) as Clip['textAlign'] })"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label><label>字重<select :value="selected.clip.fontWeight" @change="updateSelected({ fontWeight: numberValue($event) })"><option :value="400">常规</option><option :value="600">半粗</option><option :value="700">粗体</option></select></label></template>
            <h3>时间</h3><div class="property-grid"><label>开始 / 秒<input type="number" min="0" step="0.1" :value="Number(selected.clip.start.toFixed(3))" aria-label="片段开始时间" @change="updateSelected({ start: numberValue($event) })" /></label><label>时长 / 秒<input type="number" min="0.04" step="0.1" :value="Number(clipDuration(selected.clip).toFixed(3))" aria-label="片段时长" @change="updateSelected({ trimOut: selected!.clip.trimIn + numberValue($event) * selected!.clip.speed })" /></label><label>源起点 / 秒<input type="number" min="0" step="0.1" :value="Number(selected.clip.trimIn.toFixed(3))" @change="updateSelected({ trimIn: numberValue($event) })" /></label><label>源终点 / 秒<input type="number" min="0.001" step="0.1" :value="Number(selected.clip.trimOut.toFixed(3))" @change="updateSelected({ trimOut: numberValue($event) })" /></label></div>
            <label>播放速度<select :value="selected.clip.speed" aria-label="播放速度" @change="updateSelected({ speed: numberValue($event) })"><option v-for="speed in [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8, 16]" :key="speed" :value="speed">{{ speed }}×</option></select></label>
            <template v-if="selected.track.kind !== 'text'"><h3>声音</h3><button v-if="selected.track.kind === 'video' && project.assets.find(asset => asset.id === selected!.clip.assetId)?.kind === 'video'" class="separate-audio" @click="separateAudio"><Icon name="audio" :size="13" />分离到音轨</button><label>音量 <output>{{ Math.round(selected.clip.volume * 100) }}%</output><input type="range" min="0" max="2" step="0.05" :value="selected.clip.volume" aria-label="音量" @change="updateSelected({ volume: numberValue($event) })" /></label></template>
            <h3>淡入淡出</h3><div class="property-grid"><label>淡入 / 秒<input type="number" min="0" :max="clipDuration(selected.clip)" step="0.1" :value="selected.clip.fadeIn" @change="updateSelected({ fadeIn: numberValue($event) })" /></label><label>淡出 / 秒<input type="number" min="0" :max="clipDuration(selected.clip)" step="0.1" :value="selected.clip.fadeOut" @change="updateSelected({ fadeOut: numberValue($event) })" /></label></div>
            <template v-if="selected.track.kind !== 'audio'"><h3>画面变换</h3><div class="transform-presets"><button @click="pictureInPicture">画中画</button><button @click="updateSelected({ x: 0, y: 0, width: project.width, height: project.height, rotation: 0 })">铺满画布</button></div><div class="property-grid"><label>X<input type="number" :value="Number(selected.clip.x.toFixed(1))" @change="updateSelected({ x: numberValue($event) })" /></label><label>Y<input type="number" :value="Number(selected.clip.y.toFixed(1))" @change="updateSelected({ y: numberValue($event) })" /></label><label>宽度<input type="number" min="1" :value="Number(selected.clip.width.toFixed(1))" @change="updateSelected({ width: numberValue($event) })" /></label><label>高度<input type="number" min="1" :value="Number(selected.clip.height.toFixed(1))" @change="updateSelected({ height: numberValue($event) })" /></label></div><label>旋转 / 度<input type="number" min="-3600" max="3600" step="1" :value="selected.clip.rotation" @change="updateSelected({ rotation: numberValue($event) })" /></label><label>不透明度 <output>{{ Math.round(selected.clip.opacity * 100) }}%</output><input type="range" min="0" max="1" step="0.05" :value="selected.clip.opacity" @change="updateSelected({ opacity: numberValue($event) })" /></label><label v-if="selected.clip.text === undefined">画面适配<select :value="selected.clip.fit" @change="updateSelected({ fit: stringValue($event) as Clip['fit'] })"><option value="contain">完整显示</option><option value="cover">裁切填满</option><option value="fill">拉伸填满</option></select></label></template>
          </fieldset>
          </section>
          <section v-if="selectedSupportsFilters" v-show="inspectorTab === 'filters'" id="clip-filters-panel" role="tabpanel" aria-labelledby="clip-filters-tab" tabindex="0">
            <ClipFilterPanel :key="selected.clip.id" :filters="selected.clip.filters" :disabled="selectedLocked" @change="(filters, label) => updateSelected({ filters }, label)" />
          </section>
        </div>
        <div v-else class="property-empty"><Icon name="settings" :size="28" /><strong>选择一个片段</strong><span>调整画面、速度、声音<br />或添加淡入淡出</span></div>
      </aside>
    </div>
    <TimelineDivider :target="editorRoot" v-model="timelineRatio" :disabled="speechBusy || modalOpen || !!pendingTrackDelete" @size="timelineHeight = $event" />
    <section id="editor-timeline" class="timeline-panel" :style="{ height: `${timelineHeight}px` }" aria-label="多轨时间线" :inert="speechBusy || undefined">
      <div class="timeline-toolbar" role="group" aria-label="时间线工具">
        <div class="track-add"><span>时间线</span><button title="添加视频轨道" @click="addTimelineTrack('video')"><Icon name="video" :size="14" /><Icon name="plus" :size="11" /></button><button title="添加音频轨道" @click="addTimelineTrack('audio')"><Icon name="audio" :size="14" /><Icon name="plus" :size="11" /></button><button title="添加字幕轨道" @click="addTimelineTrack('text')"><Icon name="text" :size="14" /><Icon name="plus" :size="11" /></button></div>
        <div class="timeline-clip-tools" role="group" aria-label="片段剪辑">
          <button title="添加字幕" @click="addText"><Icon name="text" :size="15" /><span>字幕</span></button>
          <button :disabled="!canSplit" title="在播放头处分割（S）" @click="splitSelected"><Icon name="scissors" :size="15" /><span>分割</span></button>
          <button :disabled="!canTrimStart" title="裁掉播放头左侧（Q）" aria-label="裁掉播放头左侧（Q）" @click="trimSelected('start')"><Icon name="mark-in" :size="15" /></button>
          <button :disabled="!canTrimEnd" title="裁掉播放头右侧（W）" aria-label="裁掉播放头右侧（W）" @click="trimSelected('end')"><Icon name="mark-out" :size="15" /></button>
          <button :disabled="!selected || selectedLocked" title="复制片段" aria-label="复制片段" @click="duplicateSelected"><Icon name="copy" :size="15" /></button>
          <button :disabled="!selected || selectedLocked" title="删除片段" aria-label="删除片段" @click="deleteSelected()"><Icon name="trash" :size="15" /></button>
        </div>
        <div class="timeline-edits"><button data-testid="timeline-snap" :aria-pressed="snapEnabled" :class="{ active: snapEnabled }" :title="snapEnabled ? '吸附已开启，按住 Shift 临时关闭' : '吸附已关闭，仍按帧对齐'" aria-label="时间线吸附" @click="snapEnabled = !snapEnabled; snapGuide = null"><Icon name="magnet" :size="16" /></button><button data-testid="timeline-close-gaps" :disabled="!duration" title="清除全轨公共空隙，保持各轨道同步" aria-label="清除全轨公共空隙" @click="closeGaps"><Icon name="close-gap" :size="16" /></button></div>
        <div class="timeline-zoom"><button title="缩小时间线" @click="zoom = Math.max(6, zoom / 1.25)"><Icon name="zoom-out" :size="15" /></button><input v-model.number="zoom" type="range" min="6" max="160" aria-label="时间线缩放" /><button title="放大时间线" @click="zoom = Math.min(160, zoom * 1.25)"><Icon name="zoom-in" :size="15" /></button><button title="适应全部片段" @click="fitTimeline"><Icon name="fit" :size="16" /></button></div>
      </div>
      <div ref="timelineScroll" class="timeline-scroll" tabindex="-1" @scroll="timelineOffset = ($event.target as HTMLElement).scrollLeft; closeMenus()">
        <div class="timeline-content" :style="{ width: `${timelineWidth + 140}px` }">
          <div class="ruler-row"><div class="track-label ruler-label">{{ formatTime(playhead, true) }}</div><div class="timeline-ruler" :style="{ width: `${timelineWidth}px` }" @pointerdown="setPlayheadFromPointer"><span v-for="tick in ticks" :key="tick" :style="{ left: `${tick * zoom}px` }">{{ formatTime(tick) }}</span><div class="ruler-playhead" :style="{ left: `${playhead * zoom}px` }" /></div></div>
          <div v-for="(track, trackIndex) in activeProject.tracks" :key="track.id" class="track-row" :class="{ locked: track.locked }">
            <div class="track-label" :data-track-label-id="track.id" tabindex="-1" @contextmenu="openTrackMenu($event, track)">
              <div class="track-name" @dblclick.stop="startTrackRename(track)"><Icon :name="track.kind === 'text' ? 'text' : track.kind === 'audio' ? 'audio' : 'video'" :size="13" /><input v-if="renamingTrackId === track.id" v-model="trackName" class="track-rename-input" aria-label="轨道名称" maxlength="200" @keydown.enter.prevent.stop="finishTrackRename()" @keydown.esc.prevent.stop="finishTrackRename(false)" @blur="finishTrackRename()" @pointerdown.stop @dblclick.stop @contextmenu.stop /><span v-else :title="`${track.name} · 双击重命名`">{{ track.name }}</span></div>
              <div class="track-actions"><button :title="track.muted ? '开启轨道声音' : '静音轨道'" :class="{ enabled: track.muted }" :disabled="track.kind === 'text' || track.locked" @click="commit(() => setTrack(project, track.id, { muted: !track.muted }), '调整轨道静音')"><Icon :name="track.muted ? 'volume-off' : 'volume'" :size="13" /></button><button :title="track.locked ? '解锁轨道' : '锁定轨道'" :class="{ enabled: track.locked }" @click="commit(() => setTrack(project, track.id, { locked: !track.locked }), '调整轨道锁定')"><Icon :name="track.locked ? 'lock' : 'unlock'" :size="12" /></button><button :disabled="!trackIndex || track.locked" title="轨道上移一层" @click="changeTrackOrder(track, -1)"><Icon name="chevron-up" :size="13" /></button><button title="轨道操作" aria-label="轨道操作" aria-haspopup="menu" @click="openTrackMenu($event, track)"><Icon name="more" :size="13" /></button></div>
            </div>
            <div class="track-lane" :data-track-id="track.id" :style="{ width: `${timelineWidth}px`, backgroundSize: `${zoom * tickStep}px 100%` }" @dragover.prevent @drop="onDrop($event, track)" @pointerdown="setPlayheadFromPointer">
              <span v-if="!track.clips.length" class="track-hint">{{ track.kind === 'text' ? '点击时间线工具栏「字幕」添加文字' : track.kind === 'audio' ? '拖入音乐或视频的声音' : '拖入视频或图片' }}</span>
              <button v-for="clip in track.clips" :key="clip.id" class="timeline-clip" :class="[track.kind, { selected: selectedId === clip.id }]" :style="{ left: `${clip.start * zoom}px`, width: `${Math.max(10, clipDuration(clip) * zoom)}px` }" :title="`${clip.name} · ${formatTime(clip.start)}—${formatTime(clipEnd(clip))}`" :data-clip-id="clip.id" @pointerdown="startGesture($event, clip, track, 'move')" @click.stop="selectedId = clip.id" @contextmenu="openClipMenu($event, clip, track)">
                <span class="trim-handle start" title="拖动裁剪开头" @pointerdown.stop="startGesture($event, clip, track, 'trim-start')" /><span class="clip-title"><Icon :name="track.kind === 'text' ? 'text' : track.kind === 'audio' ? 'audio' : 'video'" :size="12" />{{ clip.text ?? clip.name }}</span><span class="clip-detail">{{ clip.speed !== 1 ? `${clip.speed}× · ` : '' }}{{ clipDuration(clip).toFixed(1) }}s</span><span class="trim-handle end" title="拖动裁剪结尾" @pointerdown.stop="startGesture($event, clip, track, 'trim-end')" />
              </button>
              <div class="lane-playhead" :style="{ left: `${playhead * zoom}px` }" />
            </div>
          </div>
          <div v-if="snapGuide !== null" class="snap-guide" data-testid="timeline-snap-guide" aria-hidden="true" :style="{ left: `${140 + snapGuide * zoom}px` }"><span>{{ formatTime(snapGuide, true) }}</span></div>
        </div>
      </div>
      <footer class="timeline-footer"><span>空格播放 · S 分割 · Q / W 裁剪 · Shift 临时关闭吸附 · 右键更多</span><span>{{ activeProject.tracks.reduce((sum, track) => sum + track.clips.length, 0) }} 个片段 · {{ formatTime(duration) }}</span></footer>
    </section>
    <EditorDialog :open="editorDialog === 'speech'" title="文字转语音" icon="audio" wide :busy="speechBusy" :return-focus="dialogReturnFocus" @close="closeEditorDialog">
      <SpeechPanel ref="speechPanel" :active="editorDialog === 'speech'" in-dialog :project="project" :selected-clip-id="selectedId" @change="(next, label) => emit('change', next, label)" @status="emit('status', $event)" @busy="setSpeechBusy" />
    </EditorDialog>
    <EditorDialog :open="editorDialog === 'project'" title="项目设置" icon="settings" :return-focus="dialogReturnFocus" @close="closeEditorDialog">
        <div class="property-content project-settings-content">
          <h3>画面</h3><label>画面比例<select aria-label="画面比例" :value="project.width === project.height ? 'square' : project.width > project.height ? (project.width / project.height > 2 ? 'cinema' : 'landscape') : 'portrait'" @change="setRatio(stringValue($event))"><option value="landscape">横屏 16:9</option><option value="portrait">竖屏 9:16</option><option value="square">方形 1:1</option><option value="cinema">宽银幕 21:9</option></select></label>
          <label>帧率<select :value="project.fps" aria-label="项目帧率" @change="setProjectSetting({ fps: numberValue($event) })"><option :value="24">24 fps</option><option :value="25">25 fps</option><option :value="30">30 fps</option><option :value="60">60 fps</option></select></label><label>背景颜色<input type="color" :value="project.background" aria-label="项目背景颜色" @change="setProjectSetting({ background: stringValue($event) })" /></label><div class="setting-note">调整比例会同步缩放片段位置。轨道从上到下对应画面从前景到背景。</div>
          <h3>项目概况</h3><dl><dt>总时长</dt><dd>{{ formatTime(duration, true) }}</dd><dt>素材</dt><dd>{{ project.assets.length }} 个</dd><dt>轨道</dt><dd>{{ project.tracks.length }} 条</dd></dl>
        </div>
      <template #footer><button class="editor-primary" @click="closeEditorDialog">完成</button></template>
    </EditorDialog>
    <Teleport to="body">
      <div v-if="clipMenu && selected" ref="menuElement" class="clip-context-menu" role="menu" tabindex="-1" :aria-label="selected.track.kind === 'text' ? '文字片段操作' : '片段操作'" :style="{ left: `${clipMenu.x}px`, top: `${clipMenu.y}px` }" @keydown="menuKeyboard">
        <template v-if="selected.track.kind === 'text'"><button role="menuitem" :disabled="selectedLocked || speechBusy || !selected.clip.text?.trim()" @click="generateTextSpeech(clipMenu.clipId)"><Icon name="audio" :size="14" />文字转语音</button><button role="menuitem" :disabled="selectedLocked || speechBusy || !project.tracks.some(track => track.clips.some(clip => clip.speech?.textClipId === clipMenu!.clipId))" @click="menuAction(() => { openSpeech(); speechPanel?.align([selectedId]) })"><Icon name="clock" :size="14" />文字对齐已有语音</button><hr /></template>
        <button role="menuitem" :disabled="!canSplit" @click="menuAction(splitSelected)"><Icon name="scissors" :size="14" /><span>在播放头处分割</span><kbd>S</kbd></button>
        <button role="menuitem" :disabled="!canTrimStart" @click="menuAction(() => trimSelected('start'))"><Icon name="mark-in" :size="14" /><span>裁掉播放头左侧</span><kbd>Q</kbd></button>
        <button role="menuitem" :disabled="!canTrimEnd" @click="menuAction(() => trimSelected('end'))"><Icon name="mark-out" :size="14" /><span>裁掉播放头右侧</span><kbd>W</kbd></button>
        <button v-if="selectedVideo" role="menuitem" :disabled="selectedLocked || speechBusy" @click="menuAction(separateAudio)"><Icon name="audio" :size="14" />分离到音轨</button>
        <button v-if="selected.track.kind === 'video'" role="menuitem" :disabled="selectedLocked || speechBusy" @click="menuAction(pictureInPicture)"><Icon name="video" :size="14" />设为画中画</button>
        <hr /><button role="menuitem" :disabled="selectedLocked || speechBusy" @click="menuAction(duplicateSelected)"><Icon name="copy" :size="14" />复制片段</button>
        <button role="menuitem" :disabled="selectedLocked || speechBusy" @click="menuAction(() => deleteSelected())"><Icon name="trash" :size="14" /><span>删除片段</span><kbd>Delete</kbd></button>
        <button role="menuitem" :disabled="selectedLocked || speechBusy" title="仅接拢此片段原范围内的全轨公共空隙" @click="menuAction(() => deleteSelected(true))"><Icon name="close-gap" :size="14" /><span>删除并接拢空隙</span><kbd>Shift Del</kbd></button>
      </div>
      <div v-if="trackMenu && menuTrack" ref="menuElement" class="clip-context-menu" role="menu" tabindex="-1" aria-label="轨道操作" :style="{ left: `${trackMenu.x}px`, top: `${trackMenu.y}px` }" @keydown="menuKeyboard">
        <button role="menuitem" :disabled="menuTrack.locked || speechBusy" @click="menuAction(() => startTrackRename(menuTrack!))"><Icon name="text" :size="14" />重命名轨道</button>
        <button role="menuitem" :disabled="menuTrack.locked || speechBusy || menuTrackIndex <= 0" @click="menuAction(() => changeTrackOrder(menuTrack!, -1))"><Icon name="chevron-up" :size="14" />轨道上移一层</button>
        <button role="menuitem" :disabled="menuTrack.locked || speechBusy || menuTrackIndex >= project.tracks.length - 1" @click="menuAction(() => changeTrackOrder(menuTrack!, 1))"><Icon name="chevron-down" :size="14" />轨道下移一层</button>
        <hr /><button role="menuitem" :disabled="menuTrack.locked || speechBusy" @click="menuAction(() => requestTrackDelete(menuTrack!))"><Icon name="trash" :size="14" />删除轨道<span v-if="!menuTrack.clips.length" class="menu-detail">空轨道</span></button>
      </div>
      <div v-if="pendingTrackDelete && deletingTrack" class="track-delete-backdrop" @pointerdown.self="cancelTrackDelete"><section ref="deleteTrackDialog" class="track-delete-dialog" role="dialog" aria-label="删除轨道" aria-modal="true" tabindex="-1" @keydown="deleteDialogKeyboard"><h2>删除轨道</h2><p>“{{ deletingTrack.name }}”包含 {{ deletingTrack.clips.length }} 个片段。删除后可撤销恢复，素材库中的原文件会保留。</p><p v-if="deletingTrack.kind === 'text'" class="dialog-note">对应配音会保留为独立音频，不再关联此轨道的文字。</p><p v-if="deleteTrackError" class="dialog-error" role="alert">{{ deleteTrackError }}</p><footer><button data-cancel-track @click="cancelTrackDelete">取消</button><button class="confirm-delete" :disabled="speechBusy || deletingTrack.locked" @click="confirmTrackDelete"><Icon name="trash" :size="14" />删除轨道</button></footer></section></div>
    </Teleport>
  </section>
</template>

<style scoped>
.video-editor{--ed-bg:var(--ui-bg,#f5f6fa);--ed-panel:var(--ui-surface,#fff);--ed-border:var(--ui-line,#e3e6ed);--ed-text:var(--ui-text,#202638);--ed-muted:var(--ui-muted,#858b9a);--ed-accent:var(--ui-accent,#3267f6);height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;color:var(--ed-text);font-size:12px;background:var(--ed-bg)}
.selected-speech{width:100%;border:1px solid var(--ed-border);margin-top:12px;color:var(--ed-accent)}.clip-context-menu{position:fixed;z-index:70;width:244px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;padding:5px;border:1px solid var(--ui-line,#e3e6ed);border-radius:8px;background:var(--ui-surface,#fff);color:var(--ui-text,#202638);box-shadow:0 8px 30px #0002;font-size:12px;scrollbar-width:thin}.clip-context-menu button{width:100%;justify-content:flex-start;padding:6px 8px;font-size:11px;gap:7px}.clip-context-menu button>svg{flex-shrink:0}.clip-context-menu button:hover:not(:disabled){color:var(--ui-accent,#3267f6);background:color-mix(in srgb,var(--ui-accent,#3267f6) 9%,transparent)}.clip-context-menu button:focus-visible{outline-color:var(--ui-accent,#3267f6);outline-offset:-2px}.clip-context-menu kbd,.menu-detail{margin-left:auto;font:9px ui-monospace,monospace;color:var(--ui-muted,#858b9a)}.clip-context-menu hr{border:0;border-top:1px solid var(--ui-line,#e3e6ed);margin:4px 3px}.track-delete-backdrop{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:16px;background:#10162670;box-sizing:border-box}.track-delete-dialog{width:min(380px,100%);box-sizing:border-box;border:1px solid var(--ui-line,#e3e6ed);background:var(--ui-surface,#fff);color:var(--ui-text,#202638);border-radius:12px;padding:20px;box-shadow:0 16px 65px #0004;font-size:13px}.track-delete-dialog h2{font-size:16px;margin:0 0 12px}.track-delete-dialog p{line-height:1.7;overflow-wrap:anywhere;margin:10px 0}.track-delete-dialog .dialog-note{font-size:11px;color:var(--ui-muted,#858b9a)}.track-delete-dialog .dialog-error{font-size:11px;color:#bd4039}.track-delete-dialog footer{display:flex;justify-content:flex-end;gap:9px;margin-top:20px}.track-delete-dialog button{border:1px solid var(--ui-line,#e3e6ed);padding:7px 12px;font:inherit}.track-delete-dialog button:focus-visible{outline-color:var(--ui-accent,#3267f6)}.track-delete-dialog .confirm-delete{color:#fff;background:#ce4a43;border-color:#ce4a43}.track-delete-dialog .confirm-delete:hover{color:#fff;background:#ba3f39}
button,input,textarea{font:inherit}button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;border-radius:6px;min-height:29px;padding:4px 7px;white-space:nowrap}button:hover:not(:disabled){background:color-mix(in srgb,var(--ed-accent) 9%,transparent);color:var(--ed-accent)}button:disabled{opacity:.35;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}input,textarea{box-sizing:border-box;min-width:0;width:100%;border:1px solid var(--ed-border);border-radius:6px;padding:7px 8px;background:var(--ed-panel);color:var(--ed-text)}select{width:100%}input[type=range]{padding:0;accent-color:var(--ed-accent);height:23px;border:0}input[type=color]{height:30px;padding:3px}textarea{resize:vertical}
.editor-tools{height:49px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--ed-border);background:var(--ed-panel);gap:8px}.tool-group{display:flex;gap:6px;align-items:center;min-width:0;overflow-x:auto;scrollbar-width:none}.tool-group::-webkit-scrollbar{display:none}.editor-output-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}.project-settings-button{width:32px;padding:6px;flex-shrink:0}.editor-primary{background:color-mix(in srgb,var(--ed-accent) 11%,transparent);color:var(--ed-accent)}.editor-export{background:var(--ed-accent);color:white!important;padding:7px 13px}.editor-export:hover:not(:disabled){background:var(--ed-accent);filter:brightness(1.08)}.editor-main{display:grid;grid-template-columns:230px minmax(180px,1fr) 245px;flex:1;min-height:0;overflow:hidden}.asset-panel,.property-panel{background:var(--ed-panel);display:flex;flex-direction:column;min-width:0;min-height:0}.asset-panel{border-right:1px solid var(--ed-border);overflow:hidden}.asset-panel header{height:45px;display:flex;align-items:center;padding:0 14px;gap:8px;flex-shrink:0}.asset-panel header button{margin-left:auto}.count{background:var(--ed-bg);color:var(--ed-muted);font-size:10px;border-radius:4px;padding:2px 5px}.asset-search{padding:0 12px 9px;flex-shrink:0}.asset-search input{background:var(--ed-bg);border-color:transparent}.asset-filters{display:flex;gap:4px;padding:0 10px 10px;flex-shrink:0}.asset-filters button{flex:1;font-size:11px;min-height:25px;padding:3px}.asset-filters button.active{background:color-mix(in srgb,var(--ed-accent) 10%,transparent);color:var(--ed-accent)}.asset-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:max-content;align-content:start;gap:10px;padding:0 12px 12px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;flex:1;min-height:0}.asset-card{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;text-align:left;padding:0;gap:4px;min-width:0;white-space:normal;border-radius:7px}.asset-thumb{height:66px;flex-shrink:0;position:relative;display:flex;align-items:center;justify-content:center;border-radius:6px;overflow:hidden;background:#242636;color:#c5c0eb}.asset-thumb.audio{background:linear-gradient(135deg,#e6f1ed,#d1e5e1);color:#418c80}.asset-thumb img,.asset-thumb video{width:100%;height:100%;object-fit:cover}.asset-thumb>span{position:absolute;bottom:4px;right:4px;background:#151824bb;color:white;padding:1px 4px;font-size:9px;border-radius:3px}.asset-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;padding:1px 2px}.asset-meta{font-size:9px;color:var(--ed-muted);padding:0 2px}.asset-empty{grid-column:1/-1;display:flex;align-items:center;flex-direction:column;text-align:center;padding:45px 6px 20px;gap:12px;color:var(--ed-muted)}.asset-empty strong{font-weight:500;color:var(--ed-text)}.asset-empty span{font-size:11px;line-height:1.8}.asset-empty button{border:1px solid var(--ed-border);color:var(--ed-accent)}.asset-panel footer{flex-shrink:0;font-size:10px;color:var(--ed-muted);border-top:1px solid var(--ed-border);padding:10px 12px}.preview-panel{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--ed-bg)}.preview-heading{display:flex;align-items:center;gap:10px;padding:8px 14px;color:var(--ed-muted);font-size:10px}.preview-heading .preview-title{font-size:12px;color:var(--ed-text);margin-right:auto}.preview-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:12px 24px 18px;overflow:hidden}.preview-frame{position:relative;display:flex;align-items:center;justify-content:center;max-width:100%;max-height:100%;width:auto;height:100%;background:#171922;box-shadow:0 5px 24px #00000013;overflow:hidden;border-radius:3px}.preview-frame canvas{display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain}.preview-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:13px;color:#737987;background:radial-gradient(ellipse at center,#262835,#181a24);text-align:center;padding:12px}.preview-empty strong{color:#c7cad4;font-size:14px;font-weight:500}.preview-empty span{font-size:11px}.preview-playback{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 16px 12px;gap:8px;flex-shrink:0}.time-code{font-family:ui-monospace,monospace;font-size:10px;white-space:nowrap}.time-code em{font-style:normal;margin-left:6px;color:var(--ed-muted)}.play-controls{display:flex;align-items:center;gap:9px}.play-button{width:34px;height:34px;background:var(--ed-panel);border:1px solid var(--ed-border);border-radius:50%}.preview-scale{font-size:10px;color:var(--ed-muted);text-align:right}.property-panel{border-left:1px solid var(--ed-border)}.property-heading{display:flex;align-items:center;border-bottom:1px solid var(--ed-border);height:44px;flex-shrink:0;padding:0 14px;font-weight:600}.property-content{padding:13px 14px;overflow:auto;min-height:0}.property-content h3{font-size:11px;font-weight:600;margin:18px 0 12px}.property-content>h3:first-child{margin-top:0}.property-content label{display:flex;flex-direction:column;gap:6px;font-size:10px;color:var(--ed-muted);margin-bottom:11px;position:relative}.property-content label input{font-size:11px;color:var(--ed-text)}.property-content output{position:absolute;right:0;color:var(--ed-text)}.transform-presets{display:flex;gap:6px;margin-bottom:12px}.transform-presets button,.separate-audio{border:1px solid var(--ed-border);font-size:10px}.separate-audio{margin-bottom:11px}.text-background{display:flex;gap:6px}.text-background input{flex:1}.text-background button{font-size:10px;border:1px solid var(--ed-border)}.text-background button.active{color:var(--ed-accent);border-color:var(--ed-accent)}.property-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 9px}.property-content fieldset{border:0;padding:0;margin:0;min-width:0}.selected-heading{display:flex;align-items:center;gap:7px;min-width:0}.selected-heading strong{font-size:11px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;flex:1}.selected-heading span{font-size:10px;color:var(--ed-muted)}.property-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;padding:62px 15px;color:var(--ed-muted)}.property-empty strong{color:var(--ed-text);font-size:12px;font-weight:500}.property-empty span{line-height:1.8;font-size:11px}.setting-note{padding:10px;font-size:10px;background:var(--ed-bg);border-radius:6px;line-height:1.7;color:var(--ed-muted)}dl{display:grid;grid-template-columns:1fr auto;gap:10px;font-size:11px}dt{color:var(--ed-muted)}dd{margin:0}
.timeline-panel{flex:0 0 auto;min-height:0;max-height:none;box-sizing:border-box;background:var(--ed-panel);border-top:1px solid var(--ed-border);display:flex;flex-direction:column}.timeline-toolbar{height:38px;flex-shrink:0;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid var(--ed-border);gap:10px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent}.timeline-toolbar::-webkit-scrollbar{height:5px}.timeline-toolbar::-webkit-scrollbar-thumb{background:var(--ed-border);border-radius:4px}.timeline-toolbar>div,.timeline-toolbar button{flex-shrink:0}.timeline-clip-tools{display:flex;align-items:center;gap:3px;border-inline:1px solid var(--ed-border);padding-inline:9px}.timeline-clip-tools button{min-height:27px;padding:4px 6px;font-size:11px}.timeline-clip-tools button>svg{flex-shrink:0}.track-add{display:flex;align-items:center;gap:4px}.track-add>span{margin-right:12px;font-size:11px;font-weight:600}.track-add button{gap:0;min-height:25px}.timeline-zoom{display:flex;align-items:center;gap:3px;margin-left:auto;padding-right:2px}.timeline-zoom input{width:78px;height:18px}.timeline-zoom button{min-height:24px;padding:3px}.timeline-scroll{overflow:auto;flex:1;min-height:0;overscroll-behavior:contain}.timeline-content{min-width:100%;position:relative}.ruler-row,.track-row{display:flex;min-width:100%;position:relative}.ruler-row{height:24px;position:sticky;top:0;z-index:6;background:var(--ed-panel)}.track-label{width:140px;min-width:140px;position:sticky;left:0;z-index:4;background:var(--ed-panel);border-right:1px solid var(--ed-border);border-bottom:1px solid var(--ed-border);box-sizing:border-box;padding:3px 10px}.ruler-label{font:10px ui-monospace,monospace;color:var(--ed-muted);z-index:8;padding:5px 10px}.timeline-ruler{position:relative;border-bottom:1px solid var(--ed-border);height:24px;box-sizing:border-box;cursor:crosshair}.timeline-ruler>span{position:absolute;top:0;padding:5px 0 0 6px;height:100%;box-sizing:border-box;font:9px ui-monospace,monospace;color:var(--ed-muted);border-left:1px solid var(--ed-border)}.ruler-playhead{position:absolute;top:11px;width:10px;height:13px;transform:translateX(-5px);background:var(--ed-accent);clip-path:polygon(0 0,100% 0,100% 60%,50% 100%,0 60%);pointer-events:none;z-index:3}.track-row{height:48px}.track-row>.track-label{display:flex;flex-direction:column;justify-content:center}.track-name{display:flex;gap:6px;align-items:center;height:16px;flex:0 0 16px;font-size:10px;line-height:14px}.track-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track-actions{display:flex;gap:4px;margin-top:2px}.track-actions button{padding:2px;height:22px;min-height:22px;width:22px;color:var(--ed-muted)}.track-actions button.enabled{color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 10%,transparent)}.track-lane{position:relative;height:48px;box-sizing:border-box;border-bottom:1px solid var(--ed-border);background-image:linear-gradient(to right,var(--ed-border) 1px,transparent 1px);background-color:var(--ed-bg);cursor:crosshair}.track-hint{font-size:10px;color:var(--ed-muted);position:absolute;left:12px;top:50%;transform:translateY(-50%);pointer-events:none;user-select:none}.timeline-clip{position:absolute;top:5px;height:38px;min-height:0;border-radius:5px;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;padding:4px 9px;gap:2px;text-align:left;overflow:hidden;cursor:grab;touch-action:none;user-select:none;border:1px solid #a2a4e0;background:#dcdcf3;color:#55538a;font-size:10px}.timeline-clip:hover:not(:disabled){background:#d2d1ee;color:#514d89}.timeline-clip.audio{border-color:#8ac3b0;background:#d2eae1;color:#377d68}.timeline-clip.text{border-color:#d6ba83;background:#f5e7c7;color:#967137}.timeline-clip.selected{outline:2px solid var(--ed-accent);outline-offset:0;z-index:2}.clip-title{display:flex;align-items:center;gap:5px;min-height:12px;line-height:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}.clip-title svg{flex-shrink:0}.clip-detail{font-size:8px;line-height:10px;opacity:.8;pointer-events:none}.trim-handle{position:absolute;top:0;bottom:0;width:7px;z-index:2;cursor:ew-resize}.trim-handle:after{content:'';display:block;position:absolute;top:11px;bottom:11px;width:2px;background:currentColor;opacity:.35;border-radius:2px}.trim-handle.start{left:0}.trim-handle.start:after{left:2px}.trim-handle.end{right:0}.trim-handle.end:after{right:2px}.locked .timeline-clip,.locked .trim-handle{cursor:not-allowed;opacity:.65}.lane-playhead{position:absolute;top:0;bottom:0;width:1px;background:var(--ed-accent);z-index:3;pointer-events:none}.timeline-footer{height:22px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-top:1px solid var(--ed-border);flex-shrink:0;color:var(--ed-muted);font-size:9px;gap:12px}.timeline-footer span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(min-width:1500px){.editor-main{grid-template-columns:260px minmax(180px,1fr) 270px}.asset-thumb{height:78px}}
@media(max-width:1100px){.editor-main{grid-template-columns:190px minmax(160px,1fr) 220px}.asset-list{gap:8px;padding:0 9px 10px}.asset-thumb{height:56px}.preview-stage{padding:10px}.preview-scale{display:none}.preview-playback{grid-template-columns:1fr auto;padding:0 10px 10px}.property-content{padding:12px 10px}.preview-empty strong{font-size:12px}}
@media(max-width:860px){.editor-main{grid-template-columns:160px minmax(150px,1fr)}.property-panel{grid-column:1/-1;position:absolute;right:16px;top:120px;bottom:280px;width:230px;box-shadow:0 6px 35px #0002;border:1px solid var(--ed-border);border-radius:8px;z-index:10;display:none}.video-editor:focus-within .property-panel:focus-within{display:flex}.asset-list{grid-template-columns:1fr}.asset-thumb{height:78px}.property-panel:has(.property-content){display:flex;position:static;grid-column:auto;width:auto;box-shadow:none;border-radius:0;border-top:0;border-right:0;border-bottom:0}.editor-main:has(.property-content){grid-template-columns:130px minmax(150px,1fr) 190px}.asset-filters{flex-wrap:wrap}.asset-filters button{flex:1 0 40%}.preview-heading>span:nth-child(2){display:none}.preview-empty strong{font-size:11px}.preview-empty>svg{width:25px;height:25px}}
@media(max-width:600px){.editor-tools{height:44px;padding:0 8px;gap:4px}.tool-group{gap:2px}.tool-group button{padding:4px 6px}.tool-group button:not(.editor-primary)>span{display:none}.editor-export{padding:6px 8px;font-size:11px}.editor-main,.editor-main:has(.property-content){display:flex;flex-wrap:wrap;overflow:auto;min-height:0}.asset-panel{width:110px;border-bottom:1px solid var(--ed-border);flex-shrink:0;min-height:230px;max-height:280px}.asset-panel header{height:35px;padding:0 8px;font-size:10px;gap:4px}.asset-panel header button{padding:3px;min-height:22px}.asset-panel .count{display:none}.asset-search{padding:0 7px 6px}.asset-search input{padding:5px;font-size:10px}.asset-filters{padding:0 6px 6px;gap:1px}.asset-filters button{font-size:10px;min-height:20px}.asset-thumb{height:48px}.asset-panel footer{display:none}.asset-empty{padding:15px 0;gap:9px}.asset-empty strong{font-size:10px}.asset-empty span{font-size:9px}.asset-empty button{font-size:10px;padding:4px}.asset-empty>svg{width:22px;height:22px}.asset-list{padding:0 7px 8px}.preview-panel{width:calc(100% - 110px);min-height:230px;max-height:280px}.preview-heading{padding:6px 8px}.preview-stage{padding:5px 8px;min-height:120px}.preview-empty span{font-size:9px}.preview-playback{display:flex;flex-direction:column;gap:5px;padding:5px 8px 10px}.play-controls{gap:10px}.play-controls button{min-height:25px;padding:2px}.play-button{width:28px;height:28px}.time-code{font-size:9px}.property-panel:has(.property-content){display:flex;width:100%;border-left:0;border-top:1px solid var(--ed-border);height:230px;min-height:230px}.property-content{padding:10px 14px}.property-heading{height:35px}.property-content fieldset{display:grid;grid-template-columns:1fr 1fr;column-gap:12px;align-items:start}.property-content fieldset h3,.property-content fieldset textarea,.property-content fieldset>.property-grid{grid-column:1/-1}.property-content fieldset>.property-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.timeline-toolbar{padding:0 8px;gap:7px}.track-add{gap:0}.track-add>span{margin-right:6px;font-size:10px}.track-add button{padding:3px 4px}.timeline-zoom input{width:45px}.timeline-zoom button{padding:3px}.timeline-footer{padding:0 8px;font-size:8px}.timeline-footer>span:first-child{max-width:55%}.property-empty{display:none}}
@media(max-width:430px){.editor-primary>span{display:none}.timeline-zoom input{width:30px}.editor-tools{padding-inline:6px}.track-add>span{margin-right:3px}.timeline-toolbar{padding-inline:6px}}
.tool-group>button,.editor-export{flex-shrink:0}.timeline-edits{display:flex;align-items:center;gap:3px}.timeline-edits button{min-height:26px;padding:3px 5px}.timeline-edits .active{color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 10%,transparent)}.track-name{min-height:14px;cursor:text}.track-name>svg{flex-shrink:0}.track-name .track-rename-input{padding:1px 3px;height:18px;min-width:0;font-size:10px;line-height:1.2}.snap-guide{position:absolute;top:24px;bottom:0;width:1px;border-left:1px dashed #d88420;z-index:3;pointer-events:none}.snap-guide span{position:absolute;top:1px;left:4px;border-radius:3px;padding:2px 4px;background:#ac681d;color:#fff;font:9px ui-monospace,monospace;white-space:nowrap}.timeline-scroll:focus-visible{outline:2px solid var(--ed-accent);outline-offset:-2px}
@media(max-width:860px){.tool-group{gap:4px}.tool-group button>span{display:none}}
@media(max-width:600px){.track-add>span{display:none}.timeline-edits{gap:1px;margin-right:0}.timeline-toolbar{gap:4px}.tool-group{gap:2px}.tool-group button{padding-inline:4px}.editor-export{padding-inline:6px}.timeline-edits button{padding:3px 4px}}
@media(max-width:430px){.timeline-zoom{gap:1px}.timeline-edits button{padding:3px}.track-add button{padding-inline:3px}.timeline-clip-tools{padding-inline:6px;gap:2px}}
.property-heading:has(.property-tabs){padding:0 8px}
.property-tabs{display:flex;align-items:stretch;gap:6px;width:100%;height:100%}
.property-tabs button{position:relative;display:flex;align-items:center;justify-content:center;gap:6px;flex:1;min-height:0;border:0;border-radius:0;background:transparent;color:var(--ed-muted);font-size:11px;font-weight:500;padding:0 7px}
.property-tabs button[aria-selected=true]{color:var(--ed-accent)}
.property-tabs button[aria-selected=true]:after{content:'';height:2px;position:absolute;bottom:0;left:12px;right:12px;border-radius:2px;background:var(--ed-accent)}
.property-content>section:focus-visible{outline:2px solid var(--ed-accent);outline-offset:3px;border-radius:3px}
</style>
