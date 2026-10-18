<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Clip, MediaAsset, Project, Track, TrackKind } from '../core/types'
import { cloneProject, createClip, createSubtitleClip, createTrack, MAX_PROJECT_DURATION, newId, validateProject } from '../core/project'
import { projectSizeError, videoClipSourceSize } from '../core/project-size'
import { addEditorAssetToTimeline, projectSourceAssets } from '../core/editor-assets'
import { useStoredVideos } from '../core/stored-videos'
import { videoAssetKey } from '../core/video-assets'
import { isSubtitleClip } from '../core/subtitle-style'
import { DEFAULT_SUBTITLE_TEXT, trackSubtitleIssues } from '../core/subtitle-validation'
import { addClip, addTrack, applySubtitleStyleToTrack, clipDuration, clipEnd, deleteClip, duplicateClip, findClip, moveClip, projectDuration, removeTrack, reorderTrack, setTrack, splitClip, updateClip } from '../core/timeline'
import { closeTimelineGaps, deleteClipAndCloseGap, findNearestSnap, restoreAudioClipLength, trimClipAtPlayhead } from '../core/timeline-editing'
import { planSpeech } from '../core/speech'
import { voiceModelName } from '../core/voice-catalog'
import { TimelinePreview } from '../core/preview'
import Icon from './Icon.vue'
import VideoLibraryToolbar from './VideoLibraryToolbar.vue'
import SpeechPanel from './SpeechPanel.vue'
import EditorDialog from './EditorDialog.vue'
import TimelineDivider from './TimelineDivider.vue'
import ClipFilterPanel from './ClipFilterPanel.vue'
import ClipTextInput from './ClipTextInput.vue'
import AudioClipPlayer from './AudioClipPlayer.vue'
import EditorVoiceRecorder from './EditorVoiceRecorder.vue'
import WatermarkLibrary from './WatermarkLibrary.vue'
import BackgroundMusicLibrary from './BackgroundMusicLibrary.vue'
import VideoSegmentLibrary from './VideoSegmentLibrary.vue'
import TransitionLibrary from './TransitionLibrary.vue'
import ProjectSizeControls from './ProjectSizeControls.vue'
import ChromaKeyPanel from './ChromaKeyPanel.vue'
import PreviewSelection from './PreviewSelection.vue'
import type { PreviewPosition } from '../core/preview-position'
import { addTextWatermark, addWatermark } from '../core/watermark-track'
import type { WatermarkMaterial } from '../core/watermark-library'
import { chooseWatermarkSource } from '../core/watermark-source'
import { addRecordedAudio } from '../core/recording-track'
import { addBackgroundMusic } from '../core/background-music-track'
import type { BackgroundMusicItem } from '../core/background-music-catalog'
import { insertVideoSegment } from '../core/video-segment-track'
import type { VideoSegmentItem, VideoSegmentPlacement, VideoSegmentCaption } from '../core/video-segment-catalog'
import { addTransition, findTransitionCut, reconcileTransitions, TRANSITION_PRESETS, updateTransition } from '../core/transitions'
import type { TransitionEffect } from '../core/types'
import { importMediaFile, mediaKind, revokeMediaAsset } from '../core/media-import'
import { importBlobAsset, isDesktop, prepareStoredVideoPreview } from '../native'
import type { RecordedMicrophoneAudio } from '../core/microphone-recording'

const props = defineProps<{ project: Project; exportDisabled?: boolean; recordingDisabled?: boolean; automationBusy?: boolean; mcpConnected?: boolean }>()
const emit = defineEmits<{ change: [project: Project, label?: string, historyGroup?: string]; import: [files?: File[]]; export: []; status: [message: string]; busy: [value: boolean]; openMcp: []; 'recorded-asset': [asset: MediaAsset, blob: Blob]; 'prepared-asset': [asset: MediaAsset, blob: Blob] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const previewSelection = ref<InstanceType<typeof PreviewSelection> | null>(null)
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
const recordingPlayback = ref(false)
const zoom = ref(44)
const assetFilter = ref('all')
const native = isDesktop()
const assetSource = ref<'recordings' | 'imported'>(native ? 'recordings' : 'imported')
const search = ref('')
const editorDialog = ref<'speech' | 'project' | 'watermark' | 'music' | 'segment' | 'transition' | null>(null)
const modalOpen = computed(() => editorDialog.value !== null)
const dialogReturnFocus = ref<HTMLElement | null>(null)
const speechPanel = ref<InstanceType<typeof SpeechPanel> | null>(null)
const audioClipPlayer = ref<InstanceType<typeof AudioClipPlayer> | null>(null)
const speechBusy = ref(false), recordingBusy = ref(false), watermarkBusy = ref(false), musicBusy = ref(false), segmentBusy = ref(false), sourceImportBusy = ref(false)
const localEditingBusy = computed(() => speechBusy.value || recordingBusy.value || watermarkBusy.value || musicBusy.value || segmentBusy.value || sourceImportBusy.value)
const editingBusy = computed(() => localEditingBusy.value || !!props.automationBusy)
const watermarkError = ref(''), watermarkStart = ref(0)
const watermarkFile = ref<HTMLInputElement>()
let watermarkLocalGreen = false
let watermarkAbort: AbortController | undefined
const musicError = ref(''), musicStart = ref(0), musicFile = ref<HTMLInputElement>()
const musicAssets = new Map<string, string>()
let musicAbort: AbortController | undefined
const segmentError = ref(''), segmentFile = ref<HTMLInputElement>()
const segmentAssets = new Map<string, string>()
let segmentPlacement: VideoSegmentPlacement = 'prepend'
let segmentAbort: AbortController | undefined
const transitionError = ref(''), transitionTime = ref(0), transitionTrackId = ref<string>()
const transitionCut = computed(() => findTransitionCut(props.project, transitionTime.value, transitionTrackId.value))
const projectSizeControls = ref<InstanceType<typeof ProjectSizeControls> | null>(null)
const clipSpeechTargetId = ref(''), clipSpeechError = ref(''), clipSpeechNotice = ref('')
const selectedSpeechBusy = computed(() => speechBusy.value && clipSpeechTargetId.value === selectedId.value && editorDialog.value !== 'speech')
const clipMenu = ref<{ x: number; y: number; clipId: string } | null>(null)
const trackMenu = ref<{ x: number; y: number; trackId: string } | null>(null)
const menuElement = ref<HTMLElement | null>(null)
const renamingTrackId = ref(''), trackName = ref('')
const pendingTrackDelete = ref<{ project: Project; trackId: string } | null>(null)
const deleteTrackDialog = ref<HTMLElement | null>(null)
const deleteTrackError = ref('')
const snapEnabled = ref(true), snapGuide = ref<number | null>(null)
const draggingTrackId = ref(''), trackDropBoundary = ref<number | null>(null), trackDropTop = ref(0)
const trackOrderNotice = ref('')
const workingProject = ref<Project | null>(null)
const activeProject = computed(() => workingProject.value || props.project)
const duration = computed(() => projectDuration(activeProject.value))
const selected = computed(() => findClip(activeProject.value, selectedId.value))
const subtitleIssues = computed(() => new Map(activeProject.value.tracks.map(track => [track.id, trackSubtitleIssues(track)])))
const subtitleIssuesByClip = computed(() => new Map([...subtitleIssues.value.values()].flat().map(issue => [issue.clipId, issue])))
const generatedTimeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const generatedDateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const generatedTimes = computed(() => {
  const labels = new Map<string, { short: string; full: string }>()
  for (const track of activeProject.value.tracks) for (const clip of track.clips) {
    if (!clip.generatedAt || labels.has(clip.generatedAt)) continue
    const date = new Date(clip.generatedAt)
    labels.set(clip.generatedAt, { short: generatedTimeFormat.format(date), full: `最近生成：${generatedDateFormat.format(date)}` })
  }
  return labels
})
const timelineSeconds = computed(() => Math.max(20, Math.ceil(duration.value + 10), recordingPlayback.value ? Math.ceil(playhead.value + 5) : 0))
const timelineWidth = computed(() => Math.max(600, timelineSeconds.value * zoom.value))
const tickStep = computed(() => zoom.value < 15 ? 10 : zoom.value < 30 ? 5 : zoom.value < 70 ? 2 : 1)
const ticks = computed(() => {
  const start = Math.max(0, Math.floor((timelineOffset.value - 140) / zoom.value / tickStep.value) - 2)
  const end = Math.min(Math.floor(timelineSeconds.value / tickStep.value), Math.ceil((timelineOffset.value + timelineViewport.value) / zoom.value / tickStep.value) + 2)
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => (start + index) * tickStep.value)
})
const projectSources = computed(() => projectSourceAssets(activeProject.value))
const projectAssetIds = computed(() => new Set(activeProject.value.assets.map(asset => asset.id)))
const { recordings, directory: recordingDirectory, loading: libraryLoading, error: libraryError, warnings: libraryWarnings, refresh: refreshRecordings, reveal: revealRecordingDirectory } = useStoredVideos(() => projectSources.value, () => native)
const recordingKeys = computed(() => new Set(recordings.value.map(videoAssetKey)))
const importedSources = computed(() => projectSources.value.filter(asset => !recordingKeys.value.has(videoAssetKey(asset))))
const sourceAssets = computed(() => assetSource.value === 'recordings' ? recordings.value : importedSources.value)
const assets = computed(() => sourceAssets.value.filter(asset => (assetSource.value === 'recordings' || assetFilter.value === 'all' || asset.kind === assetFilter.value) && asset.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const assetDateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const assetTimes = computed(() => new Map(sourceAssets.value.filter(asset => asset.addedAt).map(asset => {
  const date = new Date(asset.addedAt!)
  return [asset.id, { short: assetDateFormat.format(date).replace('/', '-'), full: `${assetSource.value === 'recordings' ? '录屏文件时间' : '加入时间'}：${generatedDateFormat.format(date)}` }]
})))
const ratio = computed(() => `${activeProject.value.width} / ${activeProject.value.height}`)
const selectedLocked = computed(() => selected.value?.track.locked || false)
const selectedSubtitleTargets = computed(() => {
  const current = selected.value
  return current && isSubtitleClip(current.track, current.clip)
    ? current.track.clips.filter(clip => clip.id !== current.clip.id && isSubtitleClip(current.track, clip)).length : 0
})
const selectedSpeechPlan = computed(() => planSpeech(props.project, selectedId.value ? [selectedId.value] : []))
const selectedSpeechAlignmentError = computed(() => {
  const current = selected.value
  if (!current || current.track.kind !== 'text') return '请先选择文字片段。'
  if (current.track.locked) return '字幕轨道已锁定，请先解锁。'
  const text = current.clip.text?.trim()
  if (!text) return '字幕文字为空。'
  for (const track of props.project.tracks) {
    const audio = track.clips.find(clip => clip.speech?.textClipId === current.clip.id)
    if (!audio) continue
    if (track.locked) return '此字幕的配音轨道已锁定，请先解锁。'
    if (audio.speech?.text !== text) return '字幕文字已更改，请重新生成配音。'
    if (track.kind !== 'audio' || !props.project.assets.some(asset => asset.id === audio.assetId && asset.kind === 'audio') || !Number.isFinite(clipDuration(audio)) || clipDuration(audio) <= 0) return '关联的配音不可用，请重新生成。'
    return ''
  }
  return '请先为此文字片段生成配音。'
})
const canSplit = computed(() => canTrim('start') && canTrim('end'))
const canTrimStart = computed(() => canTrim('start'))
const canTrimEnd = computed(() => canTrim('end'))
const menuTrack = computed(() => props.project.tracks.find(track => track.id === trackMenu.value?.trackId))
const menuTrackIndex = computed(() => props.project.tracks.findIndex(track => track.id === trackMenu.value?.trackId))
const deletingTrack = computed(() => props.project.tracks.find(track => track.id === pendingTrackDelete.value?.trackId))
const selectedVideo = computed(() => selected.value?.track.kind === 'video' && props.project.assets.find(asset => asset.id === selected.value?.clip.assetId)?.kind === 'video')
const selectedVideoSize = computed(() => videoClipSourceSize(activeProject.value, selectedId.value))
const selectedVideoSizeError = computed(() => selectedVideoSize.value ? projectSizeError(selectedVideoSize.value.width, selectedVideoSize.value.height) : '无法读取视频源尺寸。')
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
let editorDestroyed = false
let sourceImportGeneration = 0
const recordedAssets = new Map<RecordedMicrophoneAudio, MediaAsset>()
let preview: TimelinePreview | undefined
let frame = 0
let resizeObserver: ResizeObserver | undefined
let playbackStarted = 0
let playbackOffset = 0
let playbackRequest = 0
let playbackAbort: AbortController | undefined
let gesture: { kind: 'move' | 'trim-start' | 'trim-end'; clipId: string; trackId: string; startX: number; startScroll: number; original: Clip; base: Project } | undefined
let previewPositionGesture: { base: Project; clipId: string; original: Clip } | undefined
let trackDrag: { trackId: string; pointerId: number; startY: number; x: number; y: number; moved: boolean; base: Project; handle: HTMLButtonElement } | undefined
let trackScrollFrame = 0, trackScrollTime = 0
let menuReturnFocus: HTMLElement | null = null
let deleteReturnFocus: HTMLElement | null = null

function message(error: unknown): void { emit('status', error instanceof Error ? error.message : String(error)) }
function commit(action: () => Project, label: string): boolean {
  if (editingBusy.value) return false
  try { emit('change', action(), label); return true } catch (error) { message(error); return false }
}
function setSpeechBusy(value: boolean): void {
  speechBusy.value = value
  if (value) { pause(); cancelGesture(); closeMenus(); finishTrackRename(false); cancelTrackDelete() }
  emit('busy', localEditingBusy.value)
}
function setRecordingBusy(value: boolean): void {
  const wasBusy = recordingBusy.value
  recordingBusy.value = value
  if (value) { pause(); cancelGesture(); closeMenus(); finishTrackRename(false); cancelTrackDelete() }
  else if (wasBusy) {
    pause()
    // Releasing microphone input can interrupt the previous output session.
    // The next explicit play starts with fresh decoders and an output context.
    resetPreview()
  }
  emit('busy', localEditingBusy.value)
}
function startRecordingPlayback(start: number, projectId: string, elapsed: () => number): void {
  if (editorDestroyed || !recordingBusy.value || props.project.id !== projectId || !preview) return
  pause()
  const renderer = preview, request = ++playbackRequest
  const abort = new AbortController()
  playbackAbort = abort
  recordingPlayback.value = true
  playing.value = true
  playhead.value = start
  // Picture time follows the recorder's clock, including decoder startup time.
  // The captured input itself is never connected to the preview output.
  void renderer.enableAudio(true, abort.signal).catch(cause => {
    if (!abort.signal.aborted && request === playbackRequest) message(cause)
  })
  const tick = () => {
    if (!recordingPlayback.value || request !== playbackRequest) return
    playhead.value = start + elapsed()
    const visualTime = Math.min(playhead.value, Math.max(0, duration.value - 0.001))
    renderer.render(visualTime, playhead.value < duration.value)
    const scroll = timelineScroll.value
    if (scroll && playhead.value * zoom.value > scroll.scrollLeft + scroll.clientWidth - 180) {
      scroll.scrollLeft = Math.max(0, playhead.value * zoom.value - scroll.clientWidth / 2)
    }
    frame = requestAnimationFrame(tick)
  }
  tick()
}
function stopRecordingPlayback(): void { if (recordingPlayback.value) pause() }
function resetPreview(): void {
  preview?.dispose()
  preview = undefined
  if (editorDestroyed || !canvas.value) return
  preview = new TimelinePreview(canvas.value, activeProject.value, message)
  preview.seek(playhead.value, false)
}
function releaseRecordingAsset(audio: RecordedMicrophoneAudio): void {
  const asset = recordedAssets.get(audio)
  recordedAssets.delete(audio)
  if (asset && !props.project.assets.some(item => item.id === asset.id)) revokeMediaAsset(asset)
}
async function saveRecording(audio: RecordedMicrophoneAudio, start: number, projectId: string): Promise<void> {
  if (editorDestroyed || props.project.id !== projectId) throw new Error('录音所属项目已切换，请先保存录音文件。')
  let asset = recordedAssets.get(audio)
  try {
    if (!asset) {
      asset = isDesktop()
        ? await importBlobAsset(new Uint8Array(await audio.blob.arrayBuffer()), audio.name)
        : await importMediaFile(new File([audio.blob], audio.name, { type: audio.blob.type }))
      recordedAssets.set(audio, asset)
    }
    if (editorDestroyed || props.project.id !== projectId) throw new Error('录音所属项目已切换，请先保存录音文件。')
    const result = addRecordedAudio(props.project, asset, start)
    emit('recorded-asset', asset, audio.blob)
    emit('change', result.project, '录音已添加到配音轨道')
    selectedId.value = result.clipId
    inspectorTab.value = 'properties'
    playhead.value = start
    await nextTick()
    if (editorDestroyed || props.project.id !== projectId || !props.project.assets.some(item => item.id === asset!.id)) throw new Error('录音未能加入当前项目，请重试或先保存录音文件。')
    timelineScroll.value?.querySelector<HTMLElement>(`[data-clip-id="${result.clipId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  } catch (cause) {
    if (editorDestroyed || props.project.id !== projectId) releaseRecordingAsset(audio)
    throw cause
  }
}
function openEditorDialog(kind: NonNullable<typeof editorDialog.value>): void {
  if (editingBusy.value) return
  const focused = document.activeElement
  dialogReturnFocus.value = focused instanceof HTMLElement && !focused.closest('.clip-context-menu') ? focused : menuReturnFocus
  pause(); cancelGesture(); closeMenus(); finishTrackRename(); editorDialog.value = kind
}
function openSpeech(): void { openEditorDialog('speech') }
function closeEditorDialog(): void { if (!editingBusy.value) editorDialog.value = null }
function openWatermarks(): void {
  if (editingBusy.value || props.exportDisabled) return
  watermarkStart.value = playhead.value
  watermarkError.value = ''
  openEditorDialog('watermark')
}
function openBackgroundMusic(): void {
  if (editingBusy.value || props.exportDisabled) return
  musicStart.value = playhead.value
  musicError.value = ''
  openEditorDialog('music')
}
function openVideoSegments(): void {
  if (editingBusy.value || props.exportDisabled) return
  segmentError.value = ''
  openEditorDialog('segment')
}
function importLocalSegment(placement: VideoSegmentPlacement): void {
  if (editingBusy.value || editorDialog.value !== 'segment') return
  segmentPlacement = placement
  segmentFile.value?.click()
}
function localSegmentChosen(event: Event): void {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (file) void insertSegment(file, segmentPlacement)
}
async function insertSegment(source: VideoSegmentItem | File, placement: VideoSegmentPlacement, caption?: VideoSegmentCaption): Promise<void> {
  if (editingBusy.value || props.exportDisabled || editorDialog.value !== 'segment') return
  const original = props.project, projectId = original.id
  const abort = new AbortController()
  segmentAbort = abort
  segmentBusy.value = true; segmentError.value = ''; emit('busy', localEditingBusy.value)
  const timeout = window.setTimeout(() => abort.abort(new Error('读取视频片段超时，请重试。')), 60000)
  let asset: MediaAsset | undefined, created = false, committed = false
  const checkCurrent = () => {
    abort.signal.throwIfAborted()
    if (editorDestroyed || props.project.id !== projectId || (!committed && props.project !== original)) throw new Error('项目已变化，本次视频片段未添加。')
  }
  try {
    const material = source instanceof File ? undefined : source
    const key = material ? `${projectId}/${material.id}` : ''
    if (key) asset = props.project.assets.find(item => item.id === segmentAssets.get(key))
    let blob: Blob | undefined
    if (!asset) {
      if (source instanceof File) {
        if (mediaKind(source.name, source.type) !== 'video') throw new Error('请选择可用的视频文件。')
        if (source.size > 512 * 1024 * 1024) throw new Error('单个片头或片尾视频不能超过 512 MB，请先裁剪或压缩。')
        blob = source
      } else {
        const response = await fetch(source.url, { signal: abort.signal })
        if (!response.ok) throw new Error('内置视频片段读取失败，请重试。')
        blob = await response.blob()
      }
      checkCurrent()
      if (!blob.size) throw new Error('视频片段文件为空。')
      const name = material ? `${material.title}.${material.filename.split('.').pop() || 'mp4'}` : (source as File).name
      asset = isDesktop()
        ? await importBlobAsset(new Uint8Array(await blob.arrayBuffer()), name)
        : await importMediaFile(new File([blob], name, { type: blob.type || 'video/mp4' }))
      if (material) asset = { ...asset, libraryRole: 'video-segment' }
      created = true
      checkCurrent()
    }
    if (asset.kind !== 'video') throw new Error('这个文件不包含可用的视频画面。')
    const result = insertVideoSegment(props.project, asset, placement, material ? caption ?? material : undefined)
    if (blob) emit('prepared-asset', asset, blob)
    emit('change', result.project, placement === 'prepend' ? '已添加片头，现有轨道同步后移' : '已添加片尾')
    committed = true
    await nextTick()
    checkCurrent()
    if (!findClip(props.project, result.clipId)) throw new Error('视频片段未能加入项目，请重试。')
    if (key) segmentAssets.set(key, asset.id)
    selectedId.value = result.clipId; inspectorTab.value = 'properties'; playhead.value = result.start
    editorDialog.value = null
    await nextTick()
    checkCurrent()
    preview?.seek(result.start, false)
    timelineScroll.value?.querySelector<HTMLElement>(`[data-clip-id="${result.clipId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  } catch (cause) {
    if (!editorDestroyed && props.project.id === projectId) segmentError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    window.clearTimeout(timeout)
    if (created && asset && !props.project.assets.some(item => item.id === asset!.id)) revokeMediaAsset(asset)
    if (segmentAbort === abort) { segmentAbort = undefined; segmentBusy.value = false; emit('busy', localEditingBusy.value) }
  }
}
function openTransitions(): void {
  if (editingBusy.value || props.exportDisabled) return
  transitionTime.value = playhead.value
  transitionTrackId.value = selected.value?.track.kind === 'video' ? selected.value.track.id : undefined
  transitionError.value = ''
  openEditorDialog('transition')
}
async function insertTransition(effect: TransitionEffect, length: number): Promise<void> {
  if (editingBusy.value || props.exportDisabled || !transitionCut.value) return
  const cut = transitionCut.value
  try {
    const project = addTransition(props.project, cut.time, effect, length, cut.trackId)
    const clip = project.tracks.flatMap(track => track.clips).find(item => item.transition?.fromClipId === cut.fromClipId && item.transition.toClipId === cut.toClipId)
    emit('change', project, '已应用转场')
    editorDialog.value = null
    if (clip) {
      selectedId.value = clip.id; playhead.value = clip.start; inspectorTab.value = 'properties'
      await nextTick()
      timelineScroll.value?.querySelector<HTMLElement>(`[data-clip-id="${clip.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      preview?.seek(clip.start, false)
    }
  } catch (cause) { transitionError.value = cause instanceof Error ? cause.message : String(cause) }
}
function changeTransition(effect: TransitionEffect, length: number): void {
  if (!selected.value?.clip.transition || selectedLocked.value || editingBusy.value) return
  pause()
  commit(() => updateTransition(props.project, selectedId.value, effect, length), '调整转场')
}
function changeTransitionLength(event: Event): void {
  const current = selected.value?.clip, input = event.target as HTMLInputElement
  if (!current?.transition) return
  let length = clipDuration(current)
  if (!selectedLocked.value && !editingBusy.value) {
    pause()
    try {
      const project = updateTransition(props.project, current.id, current.transition.effect, Number(input.value))
      length = clipDuration(findClip(project, current.id)!.clip)
      emit('change', project, '调整转场时长')
    } catch (cause) { message(cause) }
  }
  input.value = String(Number(length.toFixed(3)))
}
function importLocalMusic(): void {
  if (!editingBusy.value && editorDialog.value === 'music') musicFile.value?.click()
}
function localMusicChosen(event: Event): void {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (file) void insertBackgroundMusic(file)
}
async function insertBackgroundMusic(source: BackgroundMusicItem | File): Promise<void> {
  if (editingBusy.value || props.exportDisabled || editorDialog.value !== 'music') return
  const original = props.project, projectId = original.id, start = musicStart.value
  const abort = new AbortController()
  musicAbort = abort
  musicBusy.value = true; musicError.value = ''; emit('busy', localEditingBusy.value)
  const timeout = window.setTimeout(() => abort.abort(new Error('读取背景音乐超时，请重试。')), 30000)
  let asset: MediaAsset | undefined, created = false, committed = false
  const checkCurrent = () => {
    if (abort.signal.aborted) throw abort.signal.reason
    if (editorDestroyed || props.project.id !== projectId || (!committed && props.project !== original)) throw new Error('项目已变化，本次背景音乐未添加。')
  }
  try {
    const material = source instanceof File ? undefined : source
    const key = material ? `${projectId}/${material.id}` : ''
    if (key) asset = props.project.assets.find(item => item.id === musicAssets.get(key))
    if (!asset) {
      let blob: Blob
      if (source instanceof File) {
        if (mediaKind(source.name, source.type) !== 'audio') throw new Error('请选择可用的音频文件。')
        if (source.size > 512 * 1024 * 1024) throw new Error('单个背景音乐文件不能超过 512 MB，请先裁剪或压缩。')
        blob = source
      } else {
        const response = await fetch(source.url, { signal: abort.signal })
        if (!response.ok) throw new Error('内置背景音乐读取失败，请重试。')
        blob = await response.blob()
      }
      checkCurrent()
      if (!blob.size) throw new Error('背景音乐文件为空。')
      const name = material ? `${material.title}.${material.filename.split('.').pop() || 'mp3'}` : (source as File).name
      asset = isDesktop()
        ? await importBlobAsset(new Uint8Array(await blob.arrayBuffer()), name)
        : await importMediaFile(new File([blob], name, { type: blob.type || 'audio/mpeg' }))
      if (material) asset = { ...asset, libraryRole: 'background-music' }
      created = true
      checkCurrent()
      if (asset.kind !== 'audio') throw new Error('这个文件不包含可用的纯音频，请选择音频文件。')
      const result = addBackgroundMusic(props.project, asset, start)
      emit('prepared-asset', asset, blob)
      emit('change', result.project, '背景音乐已添加到背景音乐轨道')
      committed = true
      await finishMusicInsertion(result, start, checkCurrent)
    } else {
      checkCurrent()
      const result = addBackgroundMusic(props.project, asset, start)
      emit('change', result.project, '背景音乐已添加到背景音乐轨道')
      committed = true
      await finishMusicInsertion(result, start, checkCurrent)
    }
    if (key) musicAssets.set(key, asset.id)
  } catch (cause) {
    if (!editorDestroyed && props.project.id === projectId) musicError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    window.clearTimeout(timeout)
    if (created && asset && !props.project.assets.some(item => item.id === asset!.id)) revokeMediaAsset(asset)
    if (musicAbort === abort) { musicAbort = undefined; musicBusy.value = false; emit('busy', localEditingBusy.value) }
  }
}
async function finishMusicInsertion(result: ReturnType<typeof addBackgroundMusic>, start: number, checkCurrent: () => void): Promise<void> {
  await nextTick()
  checkCurrent()
  if (!findClip(props.project, result.clipId)) throw new Error('背景音乐未能加入项目，请重试。')
  selectedId.value = result.clipId; inspectorTab.value = 'properties'; playhead.value = start
  editorDialog.value = null
  await nextTick()
  checkCurrent()
  preview?.seek(start, false)
  timelineScroll.value?.querySelector<HTMLElement>(`[data-clip-id="${result.clipId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
function importLocalWatermark(removeGreen = false): void {
  if (editingBusy.value) return
  watermarkLocalGreen = removeGreen
  watermarkFile.value?.click()
}
function localWatermarkChosen(event: Event): void {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (file) void insertWatermark(file, watermarkLocalGreen)
}
async function insertWatermark(source: WatermarkMaterial | File, removeGreen = false): Promise<void> {
  if (editingBusy.value || props.exportDisabled || editorDialog.value !== 'watermark') return
  const projectId = props.project.id, start = watermarkStart.value
  const abort = new AbortController()
  watermarkAbort = abort
  watermarkBusy.value = true; watermarkError.value = ''; emit('busy', localEditingBusy.value)
  const timeout = window.setTimeout(() => abort.abort(new Error('读取水印素材超时，请重试。')), 20000)
  let asset: MediaAsset | undefined
  let focusTextId = ''
  const stale = () => {
    if (editorDestroyed || props.project.id !== projectId) return true
    if (abort.signal.aborted) throw abort.signal.reason
    return false
  }
  try {
    const material = source instanceof File ? undefined : source
    let result: ReturnType<typeof addWatermark>
    if (material?.kind === 'text') {
      result = addTextWatermark(props.project, material, start)
    } else {
      const desktop = isDesktop()
      const materialUrl = material ? (desktop ? material.url : chooseWatermarkSource(material)) : ''
      let blob: Blob
      if (source instanceof File) blob = source
      else {
        const response = await fetch(materialUrl, { signal: abort.signal })
        if (!response.ok) throw new Error('内置素材读取失败，请重新打开素材库。')
        blob = await response.blob()
      }
      if (stale()) return
      window.clearTimeout(timeout)
      const extension = material?.kind === 'video' ? (materialUrl.endsWith('.webm') ? 'webm' : 'mp4') : 'png'
      const name = material ? `${material.name}.${extension}` : (source as File).name
      asset = desktop
        ? await importBlobAsset(new Uint8Array(await blob.arrayBuffer()), name)
        : await importMediaFile(new File([blob], name, { type: blob.type }))
      if (material) asset = { ...asset, libraryRole: 'watermark' }
      if (stale()) return
      result = addWatermark(props.project, asset, start, { placement: material?.placement ?? 'bottom-right', chromaKey: material?.chromaKey ?? removeGreen, spillSuppression: material?.spillSuppression })
      emit('prepared-asset', asset, blob)
    }
    emit('change', result.project, material?.kind === 'text' ? '添加可编辑文字水印' : '添加水印素材')
    await nextTick()
    if (stale()) return
    if (!findClip(props.project, result.clipId)) throw new Error('水印未能加入项目，请重试。')
    selectedId.value = result.clipId; inspectorTab.value = 'properties'; playhead.value = start
    editorDialog.value = null
    await nextTick()
    preview?.seek(start, false)
    timelineScroll.value?.querySelector<HTMLElement>(`[data-clip-id="${result.clipId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (material?.kind === 'text') focusTextId = result.clipId
  } catch (cause) {
    const failure = abort.signal.aborted ? abort.signal.reason : cause
    if (!editorDestroyed && props.project.id === projectId) watermarkError.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    window.clearTimeout(timeout)
    if (asset && !props.project.assets.some(item => item.id === asset!.id)) revokeMediaAsset(asset)
    if (watermarkAbort === abort) { watermarkAbort = undefined; watermarkBusy.value = false; emit('busy', localEditingBusy.value) }
    if (focusTextId) {
      await nextTick()
      if (!editorDestroyed && props.project.id === projectId && selectedId.value === focusTextId && !modalOpen.value) {
        editorRoot.value?.querySelector<HTMLTextAreaElement>('[data-testid="clip-text-content"]')?.focus({ preventScroll: true })
      }
    }
  }
}
async function generateTextSpeech(clipId: string): Promise<void> {
  if (editingBusy.value) return
  closeMenus(); selectedId.value = clipId
  clipSpeechTargetId.value = clipId; clipSpeechError.value = ''; clipSpeechNotice.value = ''
  const panel = speechPanel.value
  if (!panel) return
  await panel.generate([clipId])
  if (clipSpeechTargetId.value === clipId && selectedId.value === clipId) {
    clipSpeechError.value = panel.error; clipSpeechNotice.value = panel.notice
  }
}
function alignTextSpeech(clipId: string): void {
  if (editingBusy.value) return
  closeMenus(); selectedId.value = clipId
  clipSpeechTargetId.value = clipId; clipSpeechError.value = ''; clipSpeechNotice.value = ''
  const panel = speechPanel.value
  if (!panel) return
  panel.align([clipId])
  clipSpeechError.value = panel.error; clipSpeechNotice.value = panel.notice
}
function openClipMenu(event: MouseEvent, clip: Clip, track: Track): void {
  if (editingBusy.value || pendingTrackDelete.value) return
  event.preventDefault(); event.stopPropagation()
  pause(); cancelGesture(); closeMenus(); selectedId.value = clip.id
  menuReturnFocus = event.currentTarget as HTMLElement
  const rect = menuReturnFocus.getBoundingClientRect()
  clipMenu.value = { x: event.clientX || rect.left, y: event.clientY || rect.bottom, clipId: clip.id }
  void positionMenu()
}
function openTrackMenu(event: MouseEvent, track: Track): void {
  if (editingBusy.value || pendingTrackDelete.value) return
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
function menuAction(action: () => void, restoreFocus = true): void {
  action(); closeMenus()
  if (restoreFocus && !renamingTrackId.value && !pendingTrackDelete.value && !editingBusy.value && !modalOpen.value) restoreMenuFocus()
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
  if (editingBusy.value || track.locked) return
  closeMenus(); renamingTrackId.value = track.id; trackName.value = track.name
  void nextTick(() => { const input = document.querySelector<HTMLInputElement>('.track-rename-input'); input?.focus(); input?.select() })
}
function finishTrackRename(save = true): void {
  const id = renamingTrackId.value, name = trackName.value.trim()
  renamingTrackId.value = ''
  const track = props.project.tracks.find(item => item.id === id)
  if (!save || !track || track.locked || editingBusy.value) return
  if (!name) { emit('status', '轨道名称不能为空。'); return }
  if (name !== track.name) commit(() => setTrack(props.project, id, { name }), '重命名轨道')
}
function changeTrackOrder(track: Track, delta: number): void {
  if (editingBusy.value || track.locked || trackDrag) return
  const index = props.project.tracks.findIndex(item => item.id === track.id)
  const destination = Math.max(0, Math.min(props.project.tracks.length - 1, index + delta))
  if (index < 0 || destination === index) return
  commit(() => reorderTrack(props.project, track.id, destination), '调整轨道层级')
}
function focusTrackHandle(trackId: string): void {
  void nextTick(() => {
    const handle = [...(timelineScroll.value?.querySelectorAll<HTMLButtonElement>('[data-track-drag]') || [])].find(item => item.dataset.trackDrag === trackId)
    handle?.focus({ preventScroll: true })
    handle?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
function trackHandleKeyboard(event: KeyboardEvent, track: Track): void {
  if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault(); event.stopPropagation()
  if (editingBusy.value || props.exportDisabled || track.locked || modalOpen.value || pendingTrackDelete.value || gesture || trackDrag) return
  const index = props.project.tracks.findIndex(item => item.id === track.id)
  const destination = index + (event.key === 'ArrowUp' ? -1 : 1)
  if (index < 0 || destination < 0 || destination >= props.project.tracks.length) return
  if (commit(() => reorderTrack(props.project, track.id, destination), '调整轨道层级')) {
    trackOrderNotice.value = `${track.name}已移至第 ${destination + 1} 层。`
    focusTrackHandle(track.id)
  }
}
function startTrackDrag(event: PointerEvent, track: Track): void {
  if (event.button !== 0 || !event.isPrimary || editingBusy.value || props.exportDisabled || track.locked || modalOpen.value || pendingTrackDelete.value || gesture || previewPositionGesture || trackDrag || renamingTrackId.value || props.project.tracks.length < 2) return
  event.preventDefault(); event.stopPropagation()
  const handle = event.currentTarget as HTMLButtonElement
  handle.focus({ preventScroll: true })
  pause(); closeMenus(); finishTrackRename(false)
  trackDrag = { trackId: track.id, pointerId: event.pointerId, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false, base: props.project, handle }
  try { handle.setPointerCapture(event.pointerId) } catch { /* Window listeners also cover devices without pointer capture. */ }
  handle.addEventListener('lostpointercapture', cancelTrackPointer)
  window.addEventListener('pointermove', moveTrackDrag, { passive: false })
  window.addEventListener('pointerup', endTrackDrag)
  window.addEventListener('pointercancel', cancelTrackPointer)
  window.addEventListener('blur', cancelTrackDrag)
}
function updateTrackDrop(): void {
  const drag = trackDrag, scroll = timelineScroll.value
  trackDropBoundary.value = null
  if (!drag?.moved || !scroll) return
  const bounds = scroll.getBoundingClientRect()
  if (drag.x < bounds.left || drag.x > bounds.right) return
  const rows = [...scroll.querySelectorAll<HTMLElement>('[data-track-row-id]')]
  const source = props.project.tracks.findIndex(track => track.id === drag.trackId)
  if (!rows.length || source < 0) return
  const pointerY = Math.max(bounds.top + 24, Math.min(bounds.bottom, drag.y))
  let boundary = rows.findIndex(row => { const rect = row.getBoundingClientRect(); return pointerY < rect.top + rect.height / 2 })
  if (boundary < 0) boundary = rows.length
  const destination = boundary > source ? boundary - 1 : boundary
  if (destination === source) return
  const row = rows[Math.min(boundary, rows.length - 1)]!
  trackDropTop.value = row.offsetTop + (boundary === rows.length ? row.offsetHeight : 0)
  trackDropBoundary.value = boundary
}
function scrollTrackDrag(now: number): void {
  trackScrollFrame = 0
  const drag = trackDrag, scroll = timelineScroll.value
  if (!drag?.moved || !scroll) return
  const bounds = scroll.getBoundingClientRect(), elapsed = Math.min(32, now - (trackScrollTime || now))
  trackScrollTime = now
  if (drag.x >= bounds.left && drag.x <= bounds.right) {
    const top = bounds.top + 24, bottom = bounds.bottom, edge = Math.min(32, (bottom - top) / 3)
    const speed = drag.y < top + edge ? -Math.min(1, (top + edge - drag.y) / edge) : drag.y > bottom - edge ? Math.min(1, (drag.y - bottom + edge) / edge) : 0
    if (speed) scroll.scrollTop += speed * elapsed * 0.6
  }
  updateTrackDrop()
  trackScrollFrame = requestAnimationFrame(scrollTrackDrag)
}
function moveTrackDrag(event: PointerEvent): void {
  const drag = trackDrag
  if (!drag || drag.pointerId !== event.pointerId) return
  event.preventDefault()
  drag.x = event.clientX; drag.y = event.clientY
  if (!drag.moved && Math.abs(event.clientY - drag.startY) < 4) return
  if (!drag.moved) {
    drag.moved = true; draggingTrackId.value = drag.trackId
    trackOrderNotice.value = '上下拖动调整轨道层级，松开确认，Esc 取消。'
    trackScrollTime = 0
    trackScrollFrame = requestAnimationFrame(scrollTrackDrag)
  }
  updateTrackDrop()
}
function endTrackDrag(event: PointerEvent): void {
  const drag = trackDrag
  if (!drag || drag.pointerId !== event.pointerId) return
  drag.x = event.clientX; drag.y = event.clientY
  updateTrackDrop()
  const boundary = trackDropBoundary.value
  const source = props.project.tracks.findIndex(track => track.id === drag.trackId)
  const track = props.project.tracks[source]
  const destination = boundary === null ? source : boundary > source ? boundary - 1 : boundary
  const bounds = timelineScroll.value?.getBoundingClientRect()
  const inside = bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top + 24 && event.clientY <= bounds.bottom
  const valid = inside && drag.moved && props.project === drag.base && track && !track.locked && !editingBusy.value && !props.exportDisabled && !modalOpen.value && !pendingTrackDelete.value
  cancelTrackDrag()
  if (valid && source !== destination && commit(() => reorderTrack(props.project, drag.trackId, destination), '调整轨道层级')) {
    trackOrderNotice.value = `${track.name}已移至第 ${destination + 1} 层。`
    focusTrackHandle(drag.trackId)
  }
}
function cancelTrackPointer(event: PointerEvent): void { if (event.pointerId === trackDrag?.pointerId) cancelTrackDrag() }
function cancelTrackDrag(): void {
  const drag = trackDrag
  trackDrag = undefined; draggingTrackId.value = ''; trackDropBoundary.value = null
  cancelAnimationFrame(trackScrollFrame); trackScrollFrame = 0; trackScrollTime = 0
  window.removeEventListener('pointermove', moveTrackDrag)
  window.removeEventListener('pointerup', endTrackDrag)
  window.removeEventListener('pointercancel', cancelTrackPointer)
  window.removeEventListener('blur', cancelTrackDrag)
  if (drag) {
    trackOrderNotice.value = ''
    drag.handle.removeEventListener('lostpointercapture', cancelTrackPointer)
    try { if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId) } catch { /* The pointer may already have been released. */ }
  }
}
function requestTrackDelete(track: Track): void {
  if (editingBusy.value || track.locked) return
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
  if (!pending || !track || editingBusy.value || track.locked || pending.project !== props.project) { cancelTrackDelete(); return }
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
function clipSpeechModel(clip: Clip): string {
  return clip.speech?.voiceId ? voiceModelName({ id: clip.speech.voiceId, name: '未知模型' }) : ''
}
function timelineClipTitle(clip: Clip): string {
  const generated = clip.generatedAt ? generatedTimes.value.get(clip.generatedAt)?.full : undefined
  const issue = subtitleIssuesByClip.value.get(clip.id)
  return `${clip.name} · ${formatTime(clip.start)}—${formatTime(clipEnd(clip))}${issue ? `\n${issue.message}` : ''}${generated ? `\n${generated}` : ''}${clip.speech?.voiceId ? `\n配音模型：${clipSpeechModel(clip)} · ${clip.speech.voiceId}` : ''}`
}
function subtitleWarningLabel(track: Track): string {
  return `${track.name}：${subtitleIssues.value.get(track.id)?.length || 0} 条字幕待检查，点击依次定位空白或默认文字`
}
async function focusSubtitleIssue(track: Track): Promise<void> {
  if (editingBusy.value) return
  const issues = subtitleIssues.value.get(track.id) || []
  if (!issues.length) return
  const index = (issues.findIndex(issue => issue.clipId === selectedId.value) + 1) % issues.length
  const issue = issues[index]!
  const clip = track.clips.find(item => item.id === issue.clipId)
  if (!clip) return
  pause(); cancelGesture(); closeMenus()
  selectedId.value = clip.id
  inspectorTab.value = 'properties'
  seek(clip.start)
  emit('status', `${track.name}：${issue.message}（${index + 1}/${issues.length}）${track.locked ? '，请先解锁轨道再编辑。' : ''}`)
  await nextTick()
  if (selectedId.value !== clip.id) return
  const scroll = timelineScroll.value
  const element = [...(scroll?.querySelectorAll<HTMLButtonElement>('[data-clip-id]') || [])].find(item => item.dataset.clipId === clip.id)
  element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  if (scroll) scroll.scrollLeft = Math.max(0, clip.start * zoom.value - Math.max(0, scroll.clientWidth - 140) / 3)
  element?.focus({ preventScroll: true })
}
function seek(time: number): void {
  if (editingBusy.value) return
  cancelPreviewPosition()
  audioClipPlayer.value?.stop()
  if (preparingPlayback.value) pause()
  const end = duration.value || timelineSeconds.value
  playhead.value = Math.max(0, time >= end ? end : Math.min(end, frameTime(time)))
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
  recordingPlayback.value = false
  cancelAnimationFrame(frame)
  preview?.pause()
}
async function togglePlay(): Promise<void> {
  await changePlayback()
}
async function changePlayback(propagateError = false): Promise<void> {
  if (editingBusy.value) return
  cancelPreviewPosition()
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
    await renderer.enableAudio(true, abort.signal)
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
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) { resetPreview(); message(cause) }
    if (propagateError) throw cause
  } finally {
    if (request === playbackRequest) { preparingPlayback.value = false; playbackAbort = undefined }
  }
}
interface EditorPlayback { time: number; playing: boolean; selectedClipId: string }
function getPlayback(): EditorPlayback {
  return { time: playhead.value, playing: playing.value, selectedClipId: selected.value?.clip.id || '' }
}
function getInteractionBusy(): boolean {
  const focused = document.activeElement
  const editingField = focused instanceof HTMLElement && editorRoot.value?.contains(focused) && focused.matches('input:not([readonly]):not(:disabled),textarea:not([readonly]):not(:disabled),select:not(:disabled),[contenteditable="true"]')
  return !!(editorDestroyed || localEditingBusy.value || preparingPlayback.value || gesture || previewPositionGesture || trackDrag || renamingTrackId.value || pendingTrackDelete.value || modalOpen.value || clipMenu.value || trackMenu.value || editingField || editorRoot.value?.querySelector('.timeline-divider.dragging'))
}
async function setPlayback(patch: Partial<EditorPlayback>): Promise<EditorPlayback> {
  if (editorDestroyed) throw new Error('剪辑界面已关闭。')
  if (patch.time !== undefined && (!Number.isFinite(patch.time) || patch.time < 0 || patch.time > MAX_PROJECT_DURATION)) throw new Error('播放时间不在有效范围内。')
  if (patch.playing !== undefined && typeof patch.playing !== 'boolean') throw new Error('播放状态需要是布尔值。')
  if (patch.selectedClipId !== undefined && (typeof patch.selectedClipId !== 'string' || patch.selectedClipId !== '' && !findClip(props.project, patch.selectedClipId))) throw new Error('选中的片段不存在。')
  const onlyPause = patch.playing === false && patch.time === undefined && patch.selectedClipId === undefined
  // The automation controller also selects newly committed material before releasing its job lock.
  const onlySelection = patch.selectedClipId !== undefined && patch.time === undefined && patch.playing === undefined
  if (recordingBusy.value || !onlyPause && (getInteractionBusy() || !onlySelection && (props.automationBusy || props.exportDisabled))) throw new Error('剪辑界面正在处理操作，请稍后重试。')
  if (patch.playing === true && (!duration.value || !preview)) throw new Error('当前工程没有可播放的片段。')
  if (patch.playing === false) pause()
  if (patch.time !== undefined) seek(patch.time)
  if (patch.selectedClipId !== undefined) { selectedId.value = patch.selectedClipId; inspectorTab.value = 'properties' }
  if (patch.playing === true && !playing.value) {
    await changePlayback(true)
    if (editorDestroyed || !playing.value) throw new Error('播放准备已取消，请重试。')
  }
  return getPlayback()
}
async function addAssetToTimeline(asset: MediaAsset, targetTrackId?: string, time = playhead.value): Promise<void> {
  if (editingBusy.value || props.exportDisabled || pendingTrackDelete.value) return
  const original = props.project, generation = ++sourceImportGeneration
  const existing = original.assets.find(item => videoAssetKey(item) === videoAssetKey(asset))
  pause()
  sourceImportBusy.value = true
  emit('busy', localEditingBusy.value)
  try {
    const prepared = native && asset.nativePath && !existing ? await prepareStoredVideoPreview(asset) : asset
    if (editorDestroyed || generation !== sourceImportGeneration) return
    if (props.project !== original) throw new Error('项目已变化，请重新添加所选素材。')
    const result = addEditorAssetToTimeline(original, prepared, { trackId: targetTrackId, start: Math.max(0, time) })
    emit('change', result.project, '添加素材到时间线')
    await nextTick()
    if (editorDestroyed || generation !== sourceImportGeneration) return
    if (!findClip(props.project, result.clipId)) throw new Error('素材未能加入项目，请重试。')
    selectedId.value = result.clipId
    preview?.seek(playhead.value, false)
  } catch (cause) { if (!editorDestroyed && generation === sourceImportGeneration) message(cause) }
  finally { if (generation === sourceImportGeneration) { sourceImportBusy.value = false; emit('busy', localEditingBusy.value) } }
}
function importEditorAssets(files?: File[]): void { if (files && !files.length) return; assetSource.value = 'imported'; emit('import', files) }
function cancelSourceImport(): void { sourceImportGeneration++; if (sourceImportBusy.value) { sourceImportBusy.value = false; emit('busy', localEditingBusy.value) } }
function addText(): void {
  commit(() => {
    let project = props.project
    let track = project.tracks.find(item => item.kind === 'text' && !item.locked && item.name !== '文字水印轨道' && item.clips.every(clip => isSubtitleClip(item, clip)))
    if (!track) { track = createTrack('text'); project = addTrack(project, track); project = reorderTrack(project, track.id, 0) }
    const clip = createSubtitleClip(project, { start: playhead.value, text: DEFAULT_SUBTITLE_TEXT })
    selectedId.value = clip.id
    return addClip(project, track.id, clip)
  }, '添加字幕')
}
function addTimelineTrack(kind: TrackKind): void {
  commit(() => {
    const track = createTrack(kind, `${{ video: '视频', audio: '音频', text: '字幕', transition: '转场' }[kind]} ${props.project.tracks.filter(item => item.kind === kind).length + 1}`)
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
    delete clip.chromaKey
    project = addClip(project, track.id, clip)
    return updateClip(project, current.clip.id, { volume: 0 })
  }, '分离片段音轨')
}
function restoreSelectedAudioLength(): void {
  if (!selectedSupportsAudioPlayback.value || selectedLocked.value || editingBusy.value) return
  pause(); cancelGesture()
  commit(() => restoreAudioClipLength(props.project, selectedId.value), '恢复音频原长度')
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
function updateTextContent(change: { projectId: string; clipId: string; text: string; historyGroup: string }): void {
  if (editingBusy.value || change.projectId !== props.project.id) return
  const current = findClip(props.project, change.clipId)
  if (!current || current.track.locked || current.track.kind !== 'text' || current.clip.text === change.text) return
  try {
    const project = updateClip(props.project, change.clipId, { text: change.text })
    emit('change', project, isSubtitleClip(current.track, current.clip) ? '编辑字幕' : '编辑文字水印', change.historyGroup)
  } catch (error) { message(error) }
}
function applySelectedSubtitleStyle(): void {
  const sourceId = clipMenu.value?.clipId || selectedId.value
  commit(() => applySubtitleStyleToTrack(props.project, sourceId), '已将样式应用到同轨道字幕')
}
function startPreviewPosition(): void {
  pause(); closeMenus(); finishTrackRename(false)
  workingProject.value = null; clearGesture(); cancelTrackDrag()
  const current = findClip(props.project, selectedId.value)
  if (!current || current.track.locked || editingBusy.value || props.exportDisabled) { previewSelection.value?.cancel(); return }
  previewPositionGesture = { base: props.project, clipId: current.clip.id, original: current.clip }
}
function movePreviewPosition(position: PreviewPosition): void {
  const drag = previewPositionGesture
  if (!drag) return
  if (drag.base !== props.project || editingBusy.value || props.exportDisabled) { cancelPreviewPosition(); return }
  try { workingProject.value = updateClip(drag.base, drag.clipId, position) }
  catch (cause) { cancelPreviewPosition(); message(cause) }
}
function endPreviewPosition(): void {
  const drag = previewPositionGesture, project = workingProject.value
  clearPreviewPosition()
  if (!drag || !project || drag.base !== props.project || editingBusy.value || props.exportDisabled) return
  const changed = findClip(project, drag.clipId)?.clip
  if (changed && (changed.x !== drag.original.x || changed.y !== drag.original.y)) emit('change', project, '调整画面位置')
}
function clearPreviewPosition(): void {
  if (previewPositionGesture) workingProject.value = null
  previewPositionGesture = undefined
}
function cancelPreviewPosition(): void { previewSelection.value?.cancel(); clearPreviewPosition() }
function nudgePreviewPosition(position: PreviewPosition): void {
  if (props.exportDisabled || editingBusy.value) return
  updateSelected(position, '微调画面位置')
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
  if (!current || current.track.kind === 'transition' || current.track.locked || editingBusy.value) return false
  const time = frameTime(playhead.value), start = current.clip.start, end = clipEnd(current.clip)
  return side === 'start' ? time > start + 1e-7 && end - time >= 1 / props.project.fps - 1e-7 : time < end - 1e-7 && time - start >= 1 / props.project.fps - 1e-7
}
function trimSelected(side: 'start' | 'end'): void {
  if (!canTrim(side)) return
  pause(); commit(() => trimClipAtPlayhead(props.project, selectedId.value, frameTime(playhead.value), side), side === 'start' ? '裁掉播放头左侧' : '裁掉播放头右侧')
}
function splitSelected(): void { if (canSplit.value) { pause(); commit(() => splitClip(props.project, selectedId.value, frameTime(playhead.value)), '分割片段') } }
function duplicateSelected(): void { if (selected.value && selected.value.track.kind !== 'transition') commit(() => duplicateClip(props.project, selectedId.value), '复制片段') }
function deleteSelected(closeGap = false): void {
  if (!selected.value || selectedLocked.value || editingBusy.value) return
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
  if (editingBusy.value) return
  pause(); cancelGesture()
  try {
    const next = closeTimelineGaps(props.project)
    if (!positionsChanged(props.project, next)) { emit('status', '没有需要接拢的全轨公共空隙。其他轨道仍有内容的时间段会保留。'); return }
    commit(() => next, '已接拢全轨公共空隙')
  } catch (error) { message(error) }
}
function setProjectSetting(patch: Partial<Project>): void {
  const sizeMode = patch.width !== undefined || patch.height !== undefined ? { autoSizeFromVideo: false } : {}
  commit(() => {
    const project = Object.assign(cloneProject(props.project), patch, sizeMode, { updatedAt: new Date().toISOString() })
    reconcileTransitions(project, props.project)
    return validateProject(project, { trusted: true })
  }, '调整项目设置')
}
function resizeProjectLive(project: Project, label: string, historyGroup?: string): void {
  if (editingBusy.value || props.exportDisabled || project.id !== props.project.id) return
  pause(); cancelGesture()
  emit('change', project, label, historyGroup)
}
function useSelectedVideoSize(): void {
  if (editingBusy.value || selectedLocked.value || selectedVideoSizeError.value) return
  const source = selectedVideoSize.value
  if (source) projectSizeControls.value?.setSourceSize(source.width, source.height)
}
function onAssetDrag(event: DragEvent, asset: MediaAsset): void {
  event.dataTransfer?.setData('application/x-open-media-asset', asset.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}
function onDrop(event: DragEvent, track: Track): void {
  event.preventDefault()
  if (editingBusy.value || track.locked || track.kind === 'transition' || pendingTrackDelete.value) return
  const assetId = event.dataTransfer?.getData('application/x-open-media-asset')
  const asset = recordings.value.find(item => item.id === assetId) ?? props.project.assets.find(item => item.id === assetId)
  if (asset) {
    const row = event.currentTarget as HTMLElement
    const time = Math.max(0, (event.clientX - row.getBoundingClientRect().left) / zoom.value)
    addAssetToTimeline(asset, track.id, Math.round(time * props.project.fps) / props.project.fps)
  } else if (event.dataTransfer?.files.length) importEditorAssets([...event.dataTransfer.files])
}
function setPlayheadFromPointer(event: PointerEvent): void {
  if (event.button !== 0 || editingBusy.value || pendingTrackDelete.value || trackDrag || (event.target as HTMLElement).closest('.timeline-clip')) return
  const row = event.currentTarget as HTMLElement
  seek((event.clientX - row.getBoundingClientRect().left) / zoom.value)
}
function startGesture(event: PointerEvent, clip: Clip, track: Track, kind: 'move' | 'trim-start' | 'trim-end'): void {
  if (event.button !== 0 || editingBusy.value || trackDrag || previewPositionGesture) return
  event.preventDefault(); event.stopPropagation()
  ;(event.currentTarget as HTMLElement).closest<HTMLButtonElement>('.timeline-clip')?.focus({ preventScroll: true })
  selectedId.value = clip.id
  if (track.locked || track.kind === 'transition') return
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
      const audioTrack = base.tracks.find(item => item.id === gesture!.trackId)?.kind === 'audio'
      const limit = audioTrack || !asset || asset.kind === 'image' ? MAX_PROJECT_DURATION : asset.duration
      const min = original.start + 1 / props.project.fps, max = Math.min(MAX_PROJECT_DURATION, original.start + (limit - original.trimIn) / original.speed)
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
  if (project && !editingBusy.value) emit('change', project, label)
}
function cancelGesture(): void { cancelPreviewPosition(); workingProject.value = null; clearGesture(); cancelTrackDrag() }
function fitTimeline(): void { zoom.value = Math.max(6, Math.min(160, ((timelineScroll.value?.clientWidth || 900) - 160) / Math.max(10, duration.value + 2))) }
function keyboard(event: KeyboardEvent): void {
  if (previewPositionGesture) { if (event.key === 'Escape') { event.preventDefault(); cancelPreviewPosition() }; return }
  if (trackDrag) { if (event.key === 'Escape') { event.preventDefault(); cancelTrackDrag() }; return }
  if (event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return
  if (event.key === 'Escape' && (clipMenu.value || trackMenu.value)) { event.preventDefault(); closeMenus(true); return }
  if (editingBusy.value || pendingTrackDelete.value || modalOpen.value) return
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
  if (previewPositionGesture && project !== previewPositionGesture.base) cancelPreviewPosition()
  if (gesture && project !== gesture.base) cancelGesture()
  if (trackDrag && project !== trackDrag.base) cancelTrackDrag()
  if (pendingTrackDelete.value && project !== pendingTrackDelete.value.project) cancelTrackDelete()
  if (clipMenu.value && !findClip(project, clipMenu.value.clipId)) closeMenus()
  if (trackMenu.value && !project.tracks.some(track => track.id === trackMenu.value?.trackId)) closeMenus()
})
watch(() => props.project.id, () => { cancelSourceImport(); cancelWatermarkImport(); cancelMusicImport(); cancelSegmentImport(); musicAssets.clear(); segmentAssets.clear(); pause(); cancelGesture(); closeMenus(); renamingTrackId.value = ''; cancelTrackDelete(); editorDialog.value = null; selectedId.value = ''; seek(0) })
watch([editingBusy, modalOpen, () => props.exportDisabled], values => { if (values.some(Boolean)) { cancelTrackDrag(); cancelPreviewPosition() } }, { flush: 'sync' })
watch(() => props.automationBusy, busy => { if (busy) { pause(); cancelGesture(); closeMenus() } }, { flush: 'sync' })
watch(selectedId, () => { cancelPreviewPosition(); clipSpeechError.value = ''; clipSpeechNotice.value = '' }, { flush: 'sync' })
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
function cancelWatermarkImport(): void {
  watermarkAbort?.abort(new DOMException('已取消水印导入', 'AbortError'))
  watermarkAbort = undefined
  if (watermarkBusy.value) { watermarkBusy.value = false; emit('busy', localEditingBusy.value) }
}
function cancelMusicImport(): void {
  musicAbort?.abort(new DOMException('已取消背景音乐导入', 'AbortError'))
  musicAbort = undefined
  if (musicBusy.value) { musicBusy.value = false; emit('busy', localEditingBusy.value) }
}
function cancelSegmentImport(): void {
  segmentAbort?.abort(new DOMException('已取消视频片段导入', 'AbortError'))
  segmentAbort = undefined
  if (segmentBusy.value) { segmentBusy.value = false; emit('busy', localEditingBusy.value) }
}
onBeforeUnmount(() => { editorDestroyed = true; cancelSourceImport(); cancelWatermarkImport(); cancelMusicImport(); cancelSegmentImport(); pause(); cancelGesture(); resizeObserver?.disconnect(); preview?.dispose(); window.removeEventListener('keydown', keyboard); window.removeEventListener('pointerdown', outsideMenus); window.removeEventListener('resize', closeMenusOnResize) })
defineExpose({ getCanvas: () => canvas.value, pause, seek, getPlayback, setPlayback, getInteractionBusy })
</script>

<template>
  <section ref="editorRoot" class="video-editor" data-testid="video-editor" :inert="pendingTrackDelete ? true : undefined">
    <div class="editor-tools">
      <div class="tool-group" :inert="editingBusy || undefined">
        <button class="editor-primary" title="导入素材" aria-label="导入素材" @click="importEditorAssets()"><Icon name="import" :size="16" /><span>导入素材</span></button>
        <button title="文字转语音" aria-label="文字转语音" :class="{ 'editor-primary': editorDialog === 'speech' }" @click="openSpeech"><Icon name="audio" :size="16" /><span>配音</span></button>
      </div>
      <div class="editor-output-actions">
        <button class="mcp-service-button" :class="{ connected: mcpConnected }" :title="mcpConnected ? 'MCP 服务 · 客户端已连接' : 'MCP 服务 · 暂无客户端连接'" :aria-label="mcpConnected ? 'MCP 服务，客户端已连接' : 'MCP 服务，暂无客户端连接'" aria-haspopup="dialog" data-testid="editor-mcp-open" @click="emit('openMcp')"><Icon name="mcp" :size="18" /></button>
        <button class="project-settings-button" title="项目设置" aria-label="项目设置" aria-haspopup="dialog" :disabled="editingBusy" @click="openEditorDialog('project')"><Icon name="settings" :size="18" /></button>
        <button class="editor-export" data-testid="export-project" :disabled="!duration || exportDisabled || editingBusy" @click="pause(); emit('export')"><Icon name="export" :size="16" />导出视频</button>
      </div>
    </div>
    <div class="editor-main">
      <aside class="asset-panel" :inert="editingBusy || undefined">
        <header><strong>项目素材</strong><span class="count">{{ sourceAssets.length }}</span><button title="导入素材" @click="importEditorAssets()"><Icon name="plus" :size="16" /></button></header>
        <div v-if="native" class="asset-source-tabs" aria-label="素材来源"><button :aria-pressed="assetSource === 'recordings'" @click="assetSource = 'recordings'">录屏</button><button :aria-pressed="assetSource === 'imported'" @click="assetSource = 'imported'">已导入</button></div>
        <VideoLibraryToolbar v-if="native && assetSource === 'recordings'" description="仅显示录屏文件 · 最近录屏在前" :directory="recordingDirectory" :loading="libraryLoading" :preparing="sourceImportBusy" :error="libraryError" :warnings="libraryWarnings" :disabled="editingBusy" @refresh="refreshRecordings" @reveal="revealRecordingDirectory" />
        <div class="asset-search"><input v-model="search" aria-label="搜索素材" placeholder="搜索素材" /></div>
        <div v-if="assetSource === 'imported'" class="asset-filters" aria-label="素材类型"><button v-for="filter in [{ key: 'all', label: '全部' }, { key: 'video', label: '视频' }, { key: 'audio', label: '音频' }, { key: 'image', label: '图片' }]" :key="filter.key" :class="{ active: assetFilter === filter.key }" @click="assetFilter = filter.key">{{ filter.label }}</button></div>
        <div class="asset-list" @dragover.prevent @drop.prevent="importEditorAssets([...($event.dataTransfer?.files || [])])">
          <button v-for="asset in assets" :key="asset.id" class="asset-card" :data-source-asset-id="asset.id" draggable="true" :title="`${asset.name} · ${assetTimes.get(asset.id)?.full || '加入时间未记录'} · 双击添加到播放头位置`" @dragstart="onAssetDrag($event, asset)" @dblclick="addAssetToTimeline(asset)" @keydown.enter.prevent="addAssetToTimeline(asset)">
            <div class="asset-thumb" :class="asset.kind"><img v-if="asset.kind === 'image'" :src="asset.url" alt="" /><video v-else-if="asset.kind === 'video' && (assetSource !== 'recordings' || projectAssetIds.has(asset.id))" :src="asset.url" preload="metadata" muted /><Icon v-else :name="asset.kind === 'video' ? 'video' : 'audio'" :size="28" /><span v-if="asset.duration">{{ formatTime(asset.duration) }}</span></div>
            <span class="asset-name">{{ asset.name }}</span><span class="asset-meta">{{ asset.kind === 'audio' ? '音频素材' : `${asset.width} × ${asset.height}` }}</span>
            <time class="asset-added-time" :datetime="asset.addedAt" :title="assetTimes.get(asset.id)?.full || '旧项目未记录素材加入时间'">{{ assetTimes.get(asset.id)?.short || '时间未记录' }}</time>
          </button>
          <div v-if="!assets.length" class="asset-empty"><Icon name="import" :size="28" /><strong>{{ sourceAssets.length ? '没有匹配的素材' : assetSource === 'recordings' ? libraryLoading ? '正在读取录屏…' : '暂无录屏文件' : '把灵感带进来' }}</strong><span>{{ assetSource === 'recordings' ? '录屏完成后会显示在这里' : '导入视频、图片或音频，拖入时间线开始剪辑' }}</span><button v-if="!sourceAssets.length" @click="importEditorAssets()">导入素材</button></div>
        </div>
        <footer>双击素材添加 · 拖动调整位置</footer>
      </aside>
      <main class="preview-panel" :inert="speechBusy || undefined">
        <div class="preview-heading"><span class="preview-title">预览</span><span>{{ project.width }} × {{ project.height }} · {{ project.fps }} fps</span></div>
        <ProjectSizeControls ref="projectSizeControls" :project="project" :disabled="editingBusy || !!exportDisabled || modalOpen" @change="resizeProjectLive" />
        <div class="preview-stage">
          <div class="preview-frame" :style="{ aspectRatio: ratio }">
            <canvas ref="canvas" aria-label="视频合成预览" data-testid="video-preview" />
            <PreviewSelection ref="previewSelection" :project="activeProject" :clip-id="selectedId" :time="playhead" :disabled="editingBusy || !!exportDisabled || modalOpen || playing || preparingPlayback || !!pendingTrackDelete" @start="startPreviewPosition" @move="movePreviewPosition" @finish="endPreviewPosition" @cancel="clearPreviewPosition" @nudge="nudgePreviewPosition" />
            <div v-if="!duration" class="preview-empty"><Icon name="video" :size="38" /><strong>你的故事，从这里开始</strong><span>将素材放入下方时间线</span></div>
          </div>
        </div>
        <div class="preview-playback">
          <span class="time-code">{{ formatTime(playhead, true) }}<em>/ {{ formatTime(duration, true) }}</em></span>
          <div class="play-controls">
            <button title="回到开头" :disabled="editingBusy" @click="seek(0)"><Icon name="skip-back" :size="17" /></button>
            <button class="play-button" :disabled="!duration || editingBusy" :title="preparingPlayback ? '正在准备播放，点击取消' : playing ? '暂停（空格）' : '播放（空格）'" :aria-busy="preparingPlayback" data-testid="preview-play" @click="togglePlay"><Icon :name="preparingPlayback ? 'clock' : playing ? 'pause' : 'play'" :size="20" /></button>
            <EditorVoiceRecorder :project-id="project.id" :start="playhead" :disabled="speechBusy || !!exportDisabled || !!recordingDisabled" :save="saveRecording" @busy="setRecordingBusy" @started="startRecordingPlayback" @stopped="stopRecordingPlayback" @release="releaseRecordingAsset" @status="emit('status', $event)" />
            <button title="跳到结尾" :disabled="editingBusy" @click="seek(duration)"><Icon name="skip-forward" :size="17" /></button>
          </div>
          <span class="preview-scale">适应窗口</span>
        </div>
      </main>
      <aside class="property-panel">
        <header class="property-heading">
          <div v-if="selectedSupportsFilters" class="property-tabs" role="tablist" aria-label="片段设置" :inert="editingBusy || undefined" @keydown="inspectorTabKeyboard">
            <button id="clip-properties-tab" type="button" role="tab" :aria-selected="inspectorTab === 'properties'" aria-controls="clip-properties-panel" :tabindex="inspectorTab === 'properties' ? 0 : -1" @click="inspectorTab = 'properties'"><Icon name="sliders" :size="14" />属性</button>
            <button id="clip-filters-tab" type="button" role="tab" :aria-selected="inspectorTab === 'filters'" aria-controls="clip-filters-panel" :tabindex="inspectorTab === 'filters' ? 0 : -1" @click="inspectorTab = 'filters'"><Icon name="sun" :size="14" />滤镜</button>
          </div>
          <span v-else>片段属性</span>
        </header>
        <div v-if="selected" class="property-content" :inert="editingBusy && !selectedSpeechBusy || undefined">
          <div class="selected-heading"><Icon :name="selected.track.kind === 'text' ? 'text' : selected.track.kind === 'audio' ? 'audio' : selected.track.kind === 'transition' ? 'transition' : 'video'" :size="16" /><strong>{{ selected.clip.name }}</strong><span v-if="selectedLocked">已锁定</span></div>
          <fieldset v-if="selected.clip.transition" class="transition-properties" :disabled="selectedLocked || editingBusy">
            <label>转场效果<select aria-label="片段转场效果" :value="selected.clip.transition.effect" @change="changeTransition(stringValue($event) as TransitionEffect, clipDuration(selected.clip))"><option v-for="effect in TRANSITION_PRESETS" :key="effect.id" :value="effect.id">{{ effect.name }}</option></select></label>
            <label>转场时长 / 秒<input type="number" :min="2 / project.fps" step="0.1" :value="Number(clipDuration(selected.clip).toFixed(3))" aria-label="片段转场时长" @change="changeTransitionLength" /></label>
            <p class="setting-note">切点 {{ (selected.clip.start + clipDuration(selected.clip) / 2).toFixed(2) }} 秒 · 前后各 {{ (clipDuration(selected.clip) / 2).toFixed(2) }} 秒。转场始终跟随关联视频的剪切点。</p>
          </fieldset>
          <template v-else>
          <section v-show="inspectorTab === 'properties'" id="clip-properties-panel" :role="selectedSupportsFilters ? 'tabpanel' : undefined" :aria-labelledby="selectedSupportsFilters ? 'clip-properties-tab' : undefined" :tabindex="selectedSupportsFilters ? 0 : undefined">
          <AudioClipPlayer v-if="selectedSupportsAudioPlayback" :key="`${project.id}:${selected.clip.id}`" ref="audioClipPlayer" :project="activeProject" :clip="selected.clip" :disabled="editingBusy || modalOpen || !!exportDisabled" @play-request="pauseTimeline" @status="message" />
          <div v-if="selected.track.kind === 'text'" class="clip-speech-actions">
            <button class="selected-speech" :disabled="editingBusy || !selectedSpeechPlan.sources.length" :title="selectedSpeechPlan.skipped[0]?.reason" :aria-busy="selectedSpeechBusy" data-testid="speech-generate-selected" @click="generateTextSpeech(selected.clip.id)"><template v-if="selectedSpeechBusy"><span class="clip-speech-spinner" />{{ speechPanel?.generationLabel || '正在生成…' }}</template><template v-else><Icon name="audio" :size="13" />文字转语音</template></button>
            <button :disabled="editingBusy || !!selectedSpeechAlignmentError" :title="selectedSpeechAlignmentError || '按关联语音的起点和时长对齐文字'" data-testid="speech-align-selected" @click="alignTextSpeech(selected.clip.id)"><Icon name="clock" :size="13" />对齐语音</button>
            <div v-if="selectedSpeechBusy && speechPanel?.generationProgress" class="clip-speech-progress" data-testid="clip-speech-progress">
              <span role="status">{{ speechPanel.progressDescription }}</span>
              <progress :value="speechPanel.progressPercent" max="100" aria-label="当前字幕转语音进度" :aria-valuetext="speechPanel.progressPercent === undefined ? speechPanel.progressDescription : `${speechPanel.progressPercent}%，${speechPanel.progressDescription}`" />
              <div class="clip-speech-progress-meta"><span role="timer" aria-live="off">已用时 {{ speechPanel.elapsedLabel }}</span><span v-if="speechPanel.progressPercent !== undefined">{{ speechPanel.progressPercent }}%</span></div>
            </div>
            <button v-if="selectedSpeechBusy" class="clip-speech-cancel" :disabled="speechPanel?.cancelling || speechPanel?.finalizing" @click="speechPanel?.cancel()"><Icon name="close" :size="13" />取消生成</button>
            <p v-if="clipSpeechError" class="clip-speech-error" role="alert">{{ clipSpeechError }}</p><p v-else-if="clipSpeechNotice" class="clip-speech-notice" role="status">{{ clipSpeechNotice }}</p>
          </div>
          <fieldset :disabled="selectedLocked || editingBusy">
            <ChromaKeyPanel v-if="selectedSupportsFilters" :value="selected.clip.chromaKey" :disabled="selectedLocked || editingBusy" @change="(chromaKey, label) => updateSelected({ chromaKey }, label)" />
            <template v-if="selected.clip.text !== undefined"><h3>{{ !isSubtitleClip(selected.track, selected.clip) ? '文字水印' : '文本' }}</h3><ClipTextInput :key="`${project.id}:${selected.clip.id}`" :project-id="project.id" :clip-id="selected.clip.id" :model-value="selected.clip.text" :label="!isSubtitleClip(selected.track, selected.clip) ? '水印文字' : '字幕内容'" @edit="updateTextContent" /><p v-if="subtitleIssuesByClip.has(selected.clip.id)" class="subtitle-issue-note" role="status"><Icon name="alert" :size="13" />{{ subtitleIssuesByClip.get(selected.clip.id)?.message }}，请输入实际字幕。</p><div class="property-grid"><label>字号<input type="number" min="4" max="2048" :value="selected.clip.fontSize" @change="updateSelected({ fontSize: numberValue($event) })" /></label><label>颜色<input type="color" :value="selected.clip.color" @change="updateSelected({ color: stringValue($event) })" /></label></div><label>字体<select :value="selected.clip.fontFamily" @change="updateSelected({ fontFamily: stringValue($event) })"><option value="sans-serif">无衬线</option><option value="serif">衬线</option><option value="monospace">等宽</option></select></label><label>文字底色<div class="text-background"><input type="color" :value="selected.clip.background === 'transparent' ? '#000000' : selected.clip.background" aria-label="文字底色" @change="updateSelected({ background: stringValue($event) })" /><button :class="{ active: selected.clip.background === 'transparent' }" @click="updateSelected({ background: 'transparent' })">透明</button></div></label><label>横向对齐<select aria-label="字幕横向对齐" :value="selected.clip.textAlign" @change="updateSelected({ textAlign: stringValue($event) as Clip['textAlign'] })"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label><label>纵向对齐<select aria-label="字幕纵向对齐" :value="selected.clip.textVerticalAlign || 'middle'" @change="updateSelected({ textVerticalAlign: stringValue($event) as Clip['textVerticalAlign'] })"><option value="top">上对齐</option><option value="middle">居中</option><option value="bottom">下对齐</option></select></label><label>字重<select :value="selected.clip.fontWeight" @change="updateSelected({ fontWeight: numberValue($event) })"><option :value="400">常规</option><option :value="600">半粗</option><option :value="700">粗体</option></select></label></template>
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
          </template>
        </div>
        <div v-else class="property-empty"><Icon name="settings" :size="28" /><strong>选择一个片段</strong><span>调整画面、速度、声音<br />或添加淡入淡出</span></div>
      </aside>
    </div>
    <TimelineDivider :target="editorRoot" v-model="timelineRatio" :disabled="editingBusy || modalOpen || !!pendingTrackDelete" @size="timelineHeight = $event" />
    <section id="editor-timeline" class="timeline-panel" :style="{ height: `${timelineHeight}px` }" aria-label="多轨时间线" :inert="editingBusy || undefined">
      <div class="timeline-toolbar" role="group" aria-label="时间线工具">
        <div class="track-add"><span>时间线</span><button title="添加视频轨道" @click="addTimelineTrack('video')"><Icon name="video" :size="14" /><Icon name="plus" :size="11" /></button><button title="添加音频轨道" @click="addTimelineTrack('audio')"><Icon name="audio" :size="14" /><Icon name="plus" :size="11" /></button><button title="添加字幕轨道" @click="addTimelineTrack('text')"><Icon name="text" :size="14" /><Icon name="plus" :size="11" /></button></div>
        <div class="timeline-clip-tools" role="group" aria-label="片段剪辑">
          <button title="添加字幕" @click="addText"><Icon name="text" :size="15" /><span>字幕</span></button>
          <button title="从当前刻度添加水印" aria-label="添加水印" aria-haspopup="dialog" data-testid="watermark-open" :disabled="editingBusy || !!exportDisabled" @click="openWatermarks"><Icon name="sticker" :size="15" /><span>水印</span></button>
          <button title="从当前刻度加入背景音乐" aria-label="背景音乐" aria-haspopup="dialog" data-testid="background-music-open" :disabled="editingBusy || !!exportDisabled" @click="openBackgroundMusic"><Icon name="audio" :size="15" /><span>背景音乐</span></button>
          <button title="添加片头或片尾" aria-label="视频片段" aria-haspopup="dialog" data-testid="video-segment-open" :disabled="editingBusy || !!exportDisabled" @click="openVideoSegments"><Icon name="video" :size="15" /><span>视频片段</span></button>
          <button title="在相邻视频切点应用转场" aria-label="转场" aria-haspopup="dialog" data-testid="transition-open" :disabled="editingBusy || !!exportDisabled" @click="openTransitions"><Icon name="transition" :size="15" /><span>转场</span></button>
          <button :disabled="!canSplit" title="在播放头处分割（S）" @click="splitSelected"><Icon name="scissors" :size="15" /><span>分割</span></button>
          <button :disabled="!canTrimStart" title="裁掉播放头左侧（Q）" aria-label="裁掉播放头左侧（Q）" @click="trimSelected('start')"><Icon name="mark-in" :size="15" /></button>
          <button :disabled="!canTrimEnd" title="裁掉播放头右侧（W）" aria-label="裁掉播放头右侧（W）" @click="trimSelected('end')"><Icon name="mark-out" :size="15" /></button>
          <button :disabled="!selected || selectedLocked || selected.track.kind === 'transition'" title="复制片段" aria-label="复制片段" @click="duplicateSelected"><Icon name="copy" :size="15" /></button>
          <button :disabled="!selected || selectedLocked" title="删除片段" aria-label="删除片段" @click="deleteSelected()"><Icon name="trash" :size="15" /></button>
        </div>
        <div class="timeline-edits"><button data-testid="timeline-snap" :aria-pressed="snapEnabled" :class="{ active: snapEnabled }" :title="snapEnabled ? '吸附已开启，按住 Shift 临时关闭' : '吸附已关闭，仍按帧对齐'" aria-label="时间线吸附" @click="snapEnabled = !snapEnabled; snapGuide = null"><Icon name="magnet" :size="16" /></button><button data-testid="timeline-close-gaps" :disabled="!duration" title="清除全轨公共空隙，保持各轨道同步" aria-label="清除全轨公共空隙" @click="closeGaps"><Icon name="close-gap" :size="16" /></button></div>
        <div class="timeline-zoom"><button title="缩小时间线" @click="zoom = Math.max(6, zoom / 1.25)"><Icon name="zoom-out" :size="15" /></button><input v-model.number="zoom" type="range" min="6" max="160" aria-label="时间线缩放" /><button title="放大时间线" @click="zoom = Math.min(160, zoom * 1.25)"><Icon name="zoom-in" :size="15" /></button><button title="适应全部片段" @click="fitTimeline"><Icon name="fit" :size="16" /></button></div>
      </div>
      <div ref="timelineScroll" class="timeline-scroll" :class="{ 'sorting-tracks': draggingTrackId }" tabindex="-1" @scroll="timelineOffset = ($event.target as HTMLElement).scrollLeft; closeMenus(); updateTrackDrop()">
        <div class="timeline-content" :style="{ width: `${timelineWidth + 140}px` }">
          <div class="ruler-row"><div class="track-label ruler-label">{{ formatTime(playhead, true) }}</div><div class="timeline-ruler" :style="{ width: `${timelineWidth}px` }" @pointerdown="setPlayheadFromPointer"><span v-for="tick in ticks" :key="tick" :style="{ left: `${tick * zoom}px` }">{{ formatTime(tick) }}</span><div class="ruler-playhead" :style="{ left: `${playhead * zoom}px` }" /></div></div>
          <div v-for="(track, trackIndex) in activeProject.tracks" :key="track.id" class="track-row" :data-track-row-id="track.id" :class="{ locked: track.locked, 'track-dragging': draggingTrackId === track.id }">
            <div class="track-label" :data-track-label-id="track.id" tabindex="-1" @contextmenu="openTrackMenu($event, track)">
              <div class="track-name" @dblclick.stop="startTrackRename(track)"><button class="track-drag-handle" :data-track-drag="track.id" :disabled="track.locked || editingBusy || !!exportDisabled || !!renamingTrackId || activeProject.tracks.length < 2" :aria-label="`拖动排序：${track.name}`" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="拖动调整轨道层级（Alt + ↑ / ↓）" @pointerdown="startTrackDrag($event, track)" @keydown="trackHandleKeyboard($event, track)" @click.stop @dblclick.stop @contextmenu.prevent.stop><Icon name="grip" :size="13" /></button><Icon :name="track.kind === 'text' ? 'text' : track.kind === 'audio' ? 'audio' : track.kind === 'transition' ? 'transition' : 'video'" :size="13" /><input v-if="renamingTrackId === track.id" v-model="trackName" class="track-rename-input" aria-label="轨道名称" maxlength="200" @keydown.enter.prevent.stop="finishTrackRename()" @keydown.esc.prevent.stop="finishTrackRename(false)" @blur="finishTrackRename()" @pointerdown.stop @dblclick.stop @contextmenu.stop /><span v-else :title="`${track.name} · 双击重命名`">{{ track.name }}</span><button v-if="subtitleIssues.get(track.id)?.length" class="track-subtitle-warning" data-testid="track-subtitle-warning" :data-warning-track-id="track.id" :disabled="editingBusy" :title="subtitleWarningLabel(track)" :aria-label="subtitleWarningLabel(track)" @pointerdown.stop @dblclick.stop @click.stop="focusSubtitleIssue(track)"><Icon name="alert" :size="13" /><span>{{ subtitleIssues.get(track.id)?.length }}</span></button><span class="track-clip-count" data-testid="track-clip-count" :data-count-track-id="track.id" :title="`${track.name}：${track.clips.length} 个片段`" :aria-label="`${track.name}：${track.clips.length} 个片段`" @dblclick.stop>{{ track.clips.length }}</span></div>
              <div class="track-actions"><button :title="track.kind === 'transition' ? track.muted ? '启用转场' : '停用转场' : track.muted ? '开启轨道声音' : '静音轨道'" :class="{ enabled: track.muted }" :disabled="track.kind === 'text' || track.locked" @click="commit(() => setTrack(project, track.id, { muted: !track.muted }), track.kind === 'transition' ? '调整转场启用状态' : '调整轨道静音')"><Icon :name="track.kind === 'transition' ? track.muted ? 'eye-off' : 'eye' : track.muted ? 'volume-off' : 'volume'" :size="13" /></button><button :title="track.locked ? '解锁轨道' : '锁定轨道'" :class="{ enabled: track.locked }" @click="commit(() => setTrack(project, track.id, { locked: !track.locked }), '调整轨道锁定')"><Icon :name="track.locked ? 'lock' : 'unlock'" :size="12" /></button><button :disabled="!trackIndex || track.locked" title="轨道上移一层" @click="changeTrackOrder(track, -1)"><Icon name="chevron-up" :size="13" /></button><button title="轨道操作" aria-label="轨道操作" aria-haspopup="menu" @click="openTrackMenu($event, track)"><Icon name="more" :size="13" /></button></div>
            </div>
            <div class="track-lane" :data-track-id="track.id" :style="{ width: `${timelineWidth}px`, backgroundSize: `${zoom * tickStep}px 100%` }" @dragover.prevent @drop="onDrop($event, track)" @pointerdown="setPlayheadFromPointer">
              <span v-if="!track.clips.length" class="track-hint">{{ track.kind === 'text' ? '点击时间线工具栏「字幕」添加文字' : track.kind === 'audio' ? '拖入音乐或视频的声音' : track.kind === 'transition' ? '在转场库中选择效果，自动对齐视频切点' : '拖入视频或图片' }}</span>
              <button v-for="clip in track.clips" :key="clip.id" class="timeline-clip" :class="[track.kind, { selected: selectedId === clip.id, 'subtitle-invalid': subtitleIssuesByClip.has(clip.id) }]" :style="{ left: `${clip.start * zoom}px`, width: `${Math.max(10, clipDuration(clip) * zoom)}px` }" :title="timelineClipTitle(clip)" :data-clip-id="clip.id" @pointerdown="startGesture($event, clip, track, 'move')" @click.stop="selectedId = clip.id" @contextmenu="openClipMenu($event, clip, track)">
                <span v-if="track.kind !== 'transition'" class="trim-handle start" title="拖动裁剪开头" @pointerdown.stop="startGesture($event, clip, track, 'trim-start')" />
                <span class="clip-title"><Icon :name="track.kind === 'text' ? 'text' : track.kind === 'audio' ? 'audio' : track.kind === 'transition' ? 'transition' : 'video'" :size="12" />{{ clip.text ?? clip.name }}</span>
                <span class="clip-detail-row"><span class="clip-detail">{{ clip.speed !== 1 ? `${clip.speed}× · ` : '' }}{{ clipDuration(clip).toFixed(1) }}s</span><span v-if="clip.generatedAt || (track.kind === 'audio' && clip.speech)" class="clip-metadata"><span v-if="track.kind === 'audio' && clip.speech" class="clip-speech-model" data-testid="clip-speech-model" :title="`配音模型：${clipSpeechModel(clip)} · ${clip.speech.voiceId}`">{{ clipSpeechModel(clip) }}</span><time v-if="clip.generatedAt" class="clip-generated-time" data-testid="clip-generated-time" :datetime="clip.generatedAt" :title="generatedTimes.get(clip.generatedAt)?.full">{{ generatedTimes.get(clip.generatedAt)?.short }}</time></span></span>
                <span v-if="track.kind !== 'transition'" class="trim-handle end" title="拖动裁剪结尾" @pointerdown.stop="startGesture($event, clip, track, 'trim-end')" />
              </button>
              <div class="lane-playhead" :style="{ left: `${playhead * zoom}px` }" />
            </div>
          </div>
          <div v-if="trackDropBoundary !== null" class="track-drop-indicator" data-testid="track-drop-indicator" :data-drop-index="trackDropBoundary" :style="{ top: `${trackDropTop}px` }" aria-hidden="true" />
          <div v-if="snapGuide !== null" class="snap-guide" data-testid="timeline-snap-guide" aria-hidden="true" :style="{ left: `${140 + snapGuide * zoom}px` }"><span>{{ formatTime(snapGuide, true) }}</span></div>
        </div>
      </div>
      <span class="track-sort-announcement" role="status" aria-live="polite">{{ trackOrderNotice }}</span>
      <footer class="timeline-footer"><span>空格播放 · S 分割 · Q / W 裁剪 · Shift 临时关闭吸附 · 右键更多</span><span>{{ activeProject.tracks.reduce((sum, track) => sum + track.clips.length, 0) }} 个片段 · {{ formatTime(duration) }}</span></footer>
    </section>
    <input ref="watermarkFile" type="file" accept="image/*,video/*,.mp4,.mov,.webm,.png,.webp,.svg" hidden data-testid="watermark-file" @change="localWatermarkChosen" />
    <input ref="musicFile" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus,.aiff,.aif,.wma" hidden data-testid="background-music-file" @change="localMusicChosen" />
    <input ref="segmentFile" type="file" accept="video/*,.mp4,.mov,.webm,.mkv,.avi,.m4v" hidden data-testid="video-segment-file" @change="localSegmentChosen" />
    <EditorDialog :open="editorDialog === 'segment'" title="视频片段" icon="video" wide :busy="segmentBusy" busy-message="正在准备视频片段…" :return-focus="dialogReturnFocus" @close="closeEditorDialog">
      <VideoSegmentLibrary v-if="editorDialog === 'segment'" :busy="segmentBusy" :error="segmentError" @select="insertSegment" @import-local="importLocalSegment" />
    </EditorDialog>
    <EditorDialog :open="editorDialog === 'transition'" title="转场" icon="transition" wide :return-focus="dialogReturnFocus" @close="closeEditorDialog">
      <TransitionLibrary v-if="editorDialog === 'transition'" :cut="transitionCut" :fps="project.fps" :from-name="transitionCut && findClip(project, transitionCut.fromClipId)?.clip.name" :to-name="transitionCut && findClip(project, transitionCut.toClipId)?.clip.name" :error="transitionError" @select="insertTransition" />
    </EditorDialog>
    <EditorDialog :open="editorDialog === 'music'" title="背景音乐" icon="audio" wide :busy="musicBusy" busy-message="正在准备背景音乐…" :return-focus="dialogReturnFocus" @close="closeEditorDialog">
      <BackgroundMusicLibrary v-if="editorDialog === 'music'" :busy="musicBusy" :error="musicError" @select="insertBackgroundMusic" @import-local="importLocalMusic" />
    </EditorDialog>
    <EditorDialog :open="editorDialog === 'watermark'" title="添加水印" icon="sticker" wide :busy="watermarkBusy" busy-message="正在添加水印素材…" :return-focus="dialogReturnFocus" @close="closeEditorDialog">
      <WatermarkLibrary v-if="editorDialog === 'watermark'" :busy="watermarkBusy" :error="watermarkError" @select="insertWatermark" @import-local="importLocalWatermark" />
    </EditorDialog>
    <EditorDialog :open="editorDialog === 'speech'" title="文字转语音" icon="audio" wide :busy="editingBusy" :return-focus="dialogReturnFocus" @close="closeEditorDialog">
      <SpeechPanel ref="speechPanel" :active="editorDialog === 'speech'" in-dialog :project="project" @change="(next, label) => emit('change', next, label)" @status="emit('status', $event)" @busy="setSpeechBusy" />
    </EditorDialog>
    <EditorDialog :open="editorDialog === 'project'" title="项目设置" icon="settings" :return-focus="dialogReturnFocus" @close="closeEditorDialog">
        <div class="property-content project-settings-content">
          <h3>画面</h3>
          <label>帧率<select :value="project.fps" aria-label="项目帧率" @change="setProjectSetting({ fps: numberValue($event) })"><option :value="24">24 fps</option><option :value="25">25 fps</option><option :value="30">30 fps</option><option :value="60">60 fps</option></select></label><label>背景颜色<input type="color" :value="project.background" aria-label="项目背景颜色" @change="setProjectSetting({ background: stringValue($event) })" /></label><div class="setting-note"><template v-if="project.autoSizeFromVideo">首次导入视频后自动采用源视频尺寸。</template>当前尺寸 {{ project.width }} × {{ project.height }}，可在预览上方直接调整并实时查看。轨道从上到下对应画面从前景到背景。</div>
          <h3>项目概况</h3><dl><dt>总时长</dt><dd>{{ formatTime(duration, true) }}</dd><dt>素材</dt><dd>{{ project.assets.length }} 个</dd><dt>轨道</dt><dd>{{ project.tracks.length }} 条</dd></dl>
        </div>
      <template #footer><button class="editor-primary" @click="closeEditorDialog">完成</button></template>
    </EditorDialog>
    <Teleport to="body">
      <div v-if="clipMenu && selected" ref="menuElement" class="clip-context-menu" role="menu" tabindex="-1" :aria-label="selected.track.kind === 'text' ? '文字片段操作' : '片段操作'" :style="{ left: `${clipMenu.x}px`, top: `${clipMenu.y}px` }" @keydown="menuKeyboard">
        <template v-if="selected.track.kind === 'text'"><button role="menuitem" :disabled="editingBusy || !selectedSpeechPlan.sources.length" @click="generateTextSpeech(clipMenu.clipId)"><Icon name="audio" :size="14" />文字转语音</button><button role="menuitem" :disabled="editingBusy || !!selectedSpeechAlignmentError" @click="menuAction(() => alignTextSpeech(selectedId))"><Icon name="clock" :size="14" />文字对齐已有语音</button><hr /></template>
        <template v-if="isSubtitleClip(selected.track, selected.clip)"><button role="menuitem" data-testid="apply-subtitle-style-to-track" :disabled="selectedLocked || editingBusy || !selectedSubtitleTargets" :title="selectedSubtitleTargets ? '同步字体、颜色、位置、尺寸和淡入淡出，保留每条字幕的文字与时间' : '同轨道没有其他字幕'" @click="menuAction(applySelectedSubtitleStyle)"><Icon name="sliders" :size="14" />将样式应用到同轨道字幕</button><hr /></template>
        <button role="menuitem" :disabled="!canSplit" @click="menuAction(splitSelected)"><Icon name="scissors" :size="14" /><span>在播放头处分割</span><kbd>S</kbd></button>
        <button role="menuitem" :disabled="!canTrimStart" @click="menuAction(() => trimSelected('start'))"><Icon name="mark-in" :size="14" /><span>裁掉播放头左侧</span><kbd>Q</kbd></button>
        <button role="menuitem" :disabled="!canTrimEnd" @click="menuAction(() => trimSelected('end'))"><Icon name="mark-out" :size="14" /><span>裁掉播放头右侧</span><kbd>W</kbd></button>
        <button v-if="selectedSupportsAudioPlayback" role="menuitem" data-testid="restore-audio-length" :disabled="selectedLocked || editingBusy" @click="menuAction(restoreSelectedAudioLength)"><Icon name="undo" :size="14" />恢复原长度</button>
        <button v-if="selectedVideo" role="menuitem" :disabled="selectedLocked || editingBusy" @click="menuAction(separateAudio)"><Icon name="audio" :size="14" />分离到音轨</button>
        <button v-if="selectedVideo" role="menuitem" data-testid="project-size-from-clip" :disabled="selectedLocked || editingBusy || !!selectedVideoSizeError" :title="selectedVideoSizeError || `源视频尺寸 ${selectedVideoSize?.width} × ${selectedVideoSize?.height}`" @click="menuAction(useSelectedVideoSize, false)"><Icon name="video" :size="14" />以此片段设置画面尺寸</button>
        <button v-if="selected.track.kind === 'video'" role="menuitem" :disabled="selectedLocked || editingBusy" @click="menuAction(pictureInPicture)"><Icon name="video" :size="14" />设为画中画</button>
        <hr /><button role="menuitem" :disabled="selectedLocked || editingBusy || selected.track.kind === 'transition'" @click="menuAction(duplicateSelected)"><Icon name="copy" :size="14" />复制片段</button>
        <button role="menuitem" :disabled="selectedLocked || editingBusy" @click="menuAction(() => deleteSelected())"><Icon name="trash" :size="14" /><span>删除片段</span><kbd>Delete</kbd></button>
        <button role="menuitem" :disabled="selectedLocked || editingBusy || selected.track.kind === 'transition'" title="仅接拢此片段原范围内的全轨公共空隙" @click="menuAction(() => deleteSelected(true))"><Icon name="close-gap" :size="14" /><span>删除并接拢空隙</span><kbd>Shift Del</kbd></button>
      </div>
      <div v-if="trackMenu && menuTrack" ref="menuElement" class="clip-context-menu" role="menu" tabindex="-1" aria-label="轨道操作" :style="{ left: `${trackMenu.x}px`, top: `${trackMenu.y}px` }" @keydown="menuKeyboard">
        <button role="menuitem" :disabled="menuTrack.locked || editingBusy" @click="menuAction(() => startTrackRename(menuTrack!))"><Icon name="text" :size="14" />重命名轨道</button>
        <button role="menuitem" :disabled="menuTrack.locked || editingBusy || menuTrackIndex <= 0" @click="menuAction(() => changeTrackOrder(menuTrack!, -1))"><Icon name="chevron-up" :size="14" />轨道上移一层</button>
        <button role="menuitem" :disabled="menuTrack.locked || editingBusy || menuTrackIndex >= project.tracks.length - 1" @click="menuAction(() => changeTrackOrder(menuTrack!, 1))"><Icon name="chevron-down" :size="14" />轨道下移一层</button>
        <hr /><button role="menuitem" :disabled="menuTrack.locked || editingBusy" @click="menuAction(() => requestTrackDelete(menuTrack!))"><Icon name="trash" :size="14" />删除轨道<span v-if="!menuTrack.clips.length" class="menu-detail">空轨道</span></button>
      </div>
      <div v-if="pendingTrackDelete && deletingTrack" class="track-delete-backdrop" @pointerdown.self="cancelTrackDelete"><section ref="deleteTrackDialog" class="track-delete-dialog" role="dialog" aria-label="删除轨道" aria-modal="true" tabindex="-1" @keydown="deleteDialogKeyboard"><h2>删除轨道</h2><p>“{{ deletingTrack.name }}”包含 {{ deletingTrack.clips.length }} 个片段。删除后可撤销恢复，素材库中的原文件会保留。</p><p v-if="deletingTrack.kind === 'text'" class="dialog-note">对应配音会保留为独立音频，不再关联此轨道的文字。</p><p v-if="deleteTrackError" class="dialog-error" role="alert">{{ deleteTrackError }}</p><footer><button data-cancel-track @click="cancelTrackDelete">取消</button><button class="confirm-delete" :disabled="editingBusy || deletingTrack.locked" @click="confirmTrackDelete"><Icon name="trash" :size="14" />删除轨道</button></footer></section></div>
    </Teleport>
  </section>
</template>

<style scoped>
.asset-source-tabs{display:flex;gap:4px;padding:0 12px 9px;flex-shrink:0}.asset-source-tabs button{flex:1;font-size:11px;border:1px solid var(--ed-border);color:var(--ed-muted)}.asset-source-tabs button[aria-pressed="true"]{background:color-mix(in srgb,var(--ed-accent) 10%,transparent);color:var(--ed-accent);border-color:color-mix(in srgb,var(--ed-accent) 35%,var(--ed-border))}.asset-panel>.video-library-toolbar{margin:0 12px 9px;max-height:180px;overflow:auto}

.mcp-service-button{width:32px;height:32px;flex:none;padding:6px;color:var(--ed-text)}.editor-output-actions>.mcp-service-button.connected{border-color:transparent;background:linear-gradient(var(--ed-panel),var(--ed-panel)) padding-box,linear-gradient(110deg,#06b6d4,#8b5cf6,#06b6d4,#8b5cf6,#06b6d4) border-box;background-size:100% 100%,400% 100%;background-position:0 0,0% 50%;box-shadow:0 0 7px #06b6d438,0 0 12px #8b5cf626;animation:mcp-connection-flow 4s linear infinite}.mcp-service-button.connected>svg{filter:drop-shadow(0 0 2px #22d3ee42)}@keyframes mcp-connection-flow{to{background-position:0 0,100% 50%}}@media(prefers-reduced-motion:reduce){.editor-output-actions>.mcp-service-button.connected{animation:none;background-position:0 0,50% 50%}}
.transition-properties{margin-top:12px}.timeline-clip.transition{background:color-mix(in srgb,var(--ed-accent) 18%,var(--ed-panel));border-color:color-mix(in srgb,var(--ed-accent) 45%,var(--ed-border));cursor:pointer}.timeline-clip.transition::after{content:"";position:absolute;top:0;bottom:0;left:50%;border-left:1px dashed currentColor;opacity:.35;pointer-events:none}

.clip-speech-progress{grid-column:1/-1;display:grid;gap:3px;color:var(--ed-muted);font-size:10px;line-height:1.6;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.clip-speech-progress-meta{display:flex;justify-content:space-between;gap:8px}.clip-speech-progress progress{display:block;appearance:none;-webkit-appearance:none;width:100%;height:6px;margin:3px 0;border:0;border-radius:99px;overflow:hidden;background:var(--ed-border);accent-color:var(--ed-accent)}.clip-speech-progress progress::-webkit-progress-bar{background:var(--ed-border);border-radius:99px}.clip-speech-progress progress::-webkit-progress-value{background:var(--ed-accent);border-radius:99px}.clip-speech-progress progress::-moz-progress-bar{background:var(--ed-accent);border-radius:99px}.clip-speech-progress progress:indeterminate{background:linear-gradient(90deg,var(--ed-border) 0 30%,var(--ed-accent) 50%,var(--ed-border) 70% 100%);background-size:200% 100%;animation:clip-speech-progress-pulse 1.5s ease-in-out infinite}.clip-speech-progress progress:indeterminate::-webkit-progress-bar{background:transparent}@keyframes clip-speech-progress-pulse{to{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){.clip-speech-progress progress:indeterminate{animation:none}}
.clip-detail-row{display:flex;align-items:center;gap:min(6px,5%);min-width:0;width:100%;margin-top:auto}
.clip-detail-row .clip-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clip-metadata{display:flex;align-items:center;justify-content:flex-end;gap:min(5px,5%);min-width:0;margin-left:auto;overflow:hidden}.clip-speech-model{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;line-height:10px}.clip-generated-time{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:8px/10px ui-monospace,monospace;opacity:.8}
.track-name .track-drag-handle{flex:0 0 14px;width:14px;height:18px;min-height:18px;padding:0;margin-left:-5px;margin-right:-3px;color:var(--ed-muted);cursor:grab;touch-action:none}.track-name .track-drag-handle:active{cursor:grabbing}.track-name .track-drag-handle:disabled{cursor:not-allowed}.track-dragging>.track-label,.track-dragging>.track-lane{background-color:color-mix(in srgb,var(--ed-accent) 10%,var(--ed-panel))}.track-dragging .timeline-clip{opacity:.65}.sorting-tracks{cursor:grabbing;user-select:none}.sorting-tracks .track-lane{cursor:grabbing}.track-drop-indicator{position:absolute;left:0;right:0;height:3px;transform:translateY(-1px);background:var(--ed-accent);box-shadow:0 0 0 1px var(--ed-panel);z-index:5;pointer-events:none}.track-sort-announcement{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}

.video-editor{--ed-bg:var(--ui-bg,#f5f6fa);--ed-panel:var(--ui-surface,#fff);--ed-border:var(--ui-line,#e3e6ed);--ed-text:var(--ui-text,#202638);--ed-muted:var(--ui-muted,#858b9a);--ed-accent:var(--ui-accent,#3267f6);height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;color:var(--ed-text);font-size:12px;background:var(--ed-bg)}
.clip-speech-actions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;margin-top:12px}.clip-speech-actions>button{border:1px solid var(--ed-border);font-size:10px;min-height:30px}.clip-speech-actions .selected-speech{color:var(--ed-accent)}.clip-speech-actions .clip-speech-cancel{grid-column:1/-1;justify-self:end}.clip-speech-error,.clip-speech-notice{grid-column:1/-1;overflow-wrap:anywhere;white-space:pre-line;font-size:10px;line-height:1.6;margin:0;padding:8px;border-radius:6px}.clip-speech-error{color:#bc423a;background:color-mix(in srgb,#e15b53 10%,var(--ed-panel))}.clip-speech-notice{color:var(--ed-text);background:var(--ed-bg)}.clip-speech-spinner{display:inline-block;width:11px;height:11px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:clip-speech-spin .8s linear infinite;flex-shrink:0}@keyframes clip-speech-spin{to{transform:rotate(360deg)}}.clip-context-menu{position:fixed;z-index:70;width:244px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;padding:5px;border:1px solid var(--ui-line,#e3e6ed);border-radius:8px;background:var(--ui-surface,#fff);color:var(--ui-text,#202638);box-shadow:0 8px 30px #0002;font-size:12px;scrollbar-width:thin}.clip-context-menu button{width:100%;justify-content:flex-start;padding:6px 8px;font-size:11px;gap:7px}.clip-context-menu button>svg{flex-shrink:0}.clip-context-menu button:hover:not(:disabled){color:var(--ui-accent,#3267f6);background:color-mix(in srgb,var(--ui-accent,#3267f6) 9%,transparent)}.clip-context-menu button:focus-visible{outline-color:var(--ui-accent,#3267f6);outline-offset:-2px}.clip-context-menu kbd,.menu-detail{margin-left:auto;font:9px ui-monospace,monospace;color:var(--ui-muted,#858b9a)}.clip-context-menu hr{border:0;border-top:1px solid var(--ui-line,#e3e6ed);margin:4px 3px}.track-delete-backdrop{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--ui-modal-backdrop,#18283d5c);-webkit-backdrop-filter:var(--ui-modal-blur,blur(10px) saturate(115%));backdrop-filter:var(--ui-modal-blur,blur(10px) saturate(115%));box-sizing:border-box}.track-delete-dialog{width:min(380px,100%);box-sizing:border-box;border:1px solid var(--ui-modal-border,#e3e6ed);background:var(--ui-modal-surface,#fffffff0);color:var(--ui-modal-text,#202638);-webkit-backdrop-filter:var(--ui-modal-panel-blur,blur(18px) saturate(130%));backdrop-filter:var(--ui-modal-panel-blur,blur(18px) saturate(130%));border-radius:12px;padding:20px;box-shadow:0 16px 65px #0004;font-size:13px}.track-delete-dialog h2{font-size:16px;margin:0 0 12px}.track-delete-dialog p{line-height:1.7;overflow-wrap:anywhere;margin:10px 0}.track-delete-dialog .dialog-note{font-size:11px;color:var(--ui-muted,#858b9a)}.track-delete-dialog .dialog-error{font-size:11px;color:#bd4039}.track-delete-dialog footer{display:flex;justify-content:flex-end;gap:9px;margin-top:20px}.track-delete-dialog button{border:1px solid var(--ui-line,#e3e6ed);padding:7px 12px;font:inherit}.track-delete-dialog button:focus-visible{outline-color:var(--ui-accent,#3267f6)}.track-delete-dialog .confirm-delete{color:#fff;background:#ce4a43;border-color:#ce4a43}.track-delete-dialog .confirm-delete:hover{color:#fff;background:#ba3f39}
button,input,textarea{font:inherit}button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;border-radius:6px;min-height:29px;padding:4px 7px;white-space:nowrap}button:hover:not(:disabled){background:color-mix(in srgb,var(--ed-accent) 9%,transparent);color:var(--ed-accent)}button:disabled{opacity:.35;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}input,textarea{box-sizing:border-box;min-width:0;width:100%;border:1px solid var(--ed-border);border-radius:6px;padding:7px 8px;background:var(--ed-panel);color:var(--ed-text)}select{width:100%}input[type=range]{padding:0;accent-color:var(--ed-accent);height:23px;border:0}input[type=color]{height:30px;padding:3px}textarea{resize:vertical}
.editor-tools{height:49px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--ed-border);background:var(--ed-panel);gap:8px}.tool-group{display:flex;gap:6px;align-items:center;min-width:0;overflow-x:auto;scrollbar-width:none}.tool-group::-webkit-scrollbar{display:none}.editor-output-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}.project-settings-button{width:32px;padding:6px;flex-shrink:0}.editor-primary{background:color-mix(in srgb,var(--ed-accent) 11%,transparent);color:var(--ed-accent)}.editor-export{background:var(--ed-accent);color:white!important;padding:7px 13px}.editor-export:hover:not(:disabled){background:var(--ed-accent);filter:brightness(1.08)}.editor-main{display:grid;grid-template-columns:230px minmax(180px,1fr) 245px;flex:1;min-height:0;overflow:hidden}.asset-panel,.property-panel{background:var(--ed-panel);display:flex;flex-direction:column;min-width:0;min-height:0}.asset-panel{border-right:1px solid var(--ed-border);overflow:hidden}.asset-panel header{height:45px;display:flex;align-items:center;padding:0 14px;gap:8px;flex-shrink:0}.asset-panel header button{margin-left:auto}.count{background:var(--ed-bg);color:var(--ed-muted);font-size:10px;border-radius:4px;padding:2px 5px}.asset-search{padding:0 12px 9px;flex-shrink:0}.asset-search input{background:var(--ed-bg);border-color:transparent}.asset-filters{display:flex;gap:4px;padding:0 10px 10px;flex-shrink:0}.asset-filters button{flex:1;font-size:11px;min-height:25px;padding:3px}.asset-filters button.active{background:color-mix(in srgb,var(--ed-accent) 10%,transparent);color:var(--ed-accent)}.asset-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:max-content;align-content:start;gap:10px;padding:0 12px 12px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;flex:1;min-height:0}.asset-card{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;text-align:left;padding:0;gap:4px;min-width:0;white-space:normal;border-radius:7px}.asset-thumb{height:66px;flex-shrink:0;position:relative;display:flex;align-items:center;justify-content:center;border-radius:6px;overflow:hidden;background:#242636;color:#c5c0eb}.asset-thumb.audio{background:linear-gradient(135deg,#e6f1ed,#d1e5e1);color:#418c80}.asset-thumb img,.asset-thumb video{width:100%;height:100%;object-fit:cover}.asset-thumb>span{position:absolute;bottom:4px;right:4px;background:#151824bb;color:white;padding:1px 4px;font-size:9px;border-radius:3px}.asset-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;padding:1px 2px}.asset-meta{font-size:9px;color:var(--ed-muted);padding:0 2px}.asset-added-time{font-size:9px;color:var(--ed-muted);padding:0 2px;line-height:14px;min-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}.asset-empty{grid-column:1/-1;display:flex;align-items:center;flex-direction:column;text-align:center;padding:45px 6px 20px;gap:12px;color:var(--ed-muted)}.asset-empty strong{font-weight:500;color:var(--ed-text)}.asset-empty span{font-size:11px;line-height:1.8}.asset-empty button{border:1px solid var(--ed-border);color:var(--ed-accent)}.asset-panel footer{flex-shrink:0;font-size:10px;color:var(--ed-muted);border-top:1px solid var(--ed-border);padding:10px 12px}.preview-panel{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--ed-bg)}.preview-heading{display:flex;align-items:center;gap:10px;padding:8px 14px;color:var(--ed-muted);font-size:10px}.preview-heading .preview-title{font-size:12px;color:var(--ed-text);margin-right:auto}.preview-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:12px 24px 18px;overflow:hidden}.preview-frame{position:relative;display:flex;align-items:center;justify-content:center;max-width:100%;max-height:100%;width:auto;height:100%;background:#171922;box-shadow:0 5px 24px #00000013;overflow:hidden;border-radius:3px}.preview-frame canvas{display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain}.preview-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:13px;color:#737987;background:radial-gradient(ellipse at center,#262835,#181a24);text-align:center;padding:12px}.preview-empty strong{color:#c7cad4;font-size:14px;font-weight:500}.preview-empty span{font-size:11px}.preview-playback{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 16px 12px;gap:8px;flex-shrink:0}.time-code{font-family:ui-monospace,monospace;font-size:10px;white-space:nowrap}.time-code em{font-style:normal;margin-left:6px;color:var(--ed-muted)}.play-controls{display:flex;align-items:center;gap:9px}.play-button{width:34px;height:34px;background:var(--ed-panel);border:1px solid var(--ed-border);border-radius:50%}.preview-scale{font-size:10px;color:var(--ed-muted);text-align:right}.property-panel{border-left:1px solid var(--ed-border)}.property-heading{display:flex;align-items:center;border-bottom:1px solid var(--ed-border);height:44px;flex-shrink:0;padding:0 14px;font-weight:600}.property-content{padding:13px 14px;overflow:auto;min-height:0}.property-content h3{font-size:11px;font-weight:600;margin:18px 0 12px}.property-content>h3:first-child{margin-top:0}.property-content label{display:flex;flex-direction:column;gap:6px;font-size:10px;color:var(--ed-muted);margin-bottom:11px;position:relative}.property-content label input{font-size:11px;color:var(--ed-text)}.property-content output{position:absolute;right:0;color:var(--ed-text)}.transform-presets{display:flex;gap:6px;margin-bottom:12px}.transform-presets button,.separate-audio{border:1px solid var(--ed-border);font-size:10px}.separate-audio{margin-bottom:11px}.text-background{display:flex;gap:6px}.text-background input{flex:1}.text-background button{font-size:10px;border:1px solid var(--ed-border)}.text-background button.active{color:var(--ed-accent);border-color:var(--ed-accent)}.property-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 9px}.property-content fieldset{border:0;padding:0;margin:0;min-width:0}.selected-heading{display:flex;align-items:center;gap:7px;min-width:0}.selected-heading strong{font-size:11px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;flex:1}.selected-heading span{font-size:10px;color:var(--ed-muted)}.property-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;padding:62px 15px;color:var(--ed-muted)}.property-empty strong{color:var(--ed-text);font-size:12px;font-weight:500}.property-empty span{line-height:1.8;font-size:11px}.setting-note{padding:10px;font-size:10px;background:var(--ed-bg);border-radius:6px;line-height:1.7;color:var(--ed-muted)}dl{display:grid;grid-template-columns:1fr auto;gap:10px;font-size:11px}dt{color:var(--ed-muted)}dd{margin:0}
.timeline-panel{flex:0 0 auto;min-height:0;max-height:none;box-sizing:border-box;background:var(--ed-panel);border-top:1px solid var(--ed-border);display:flex;flex-direction:column}.timeline-toolbar{height:38px;flex-shrink:0;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid var(--ed-border);gap:10px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent}.timeline-toolbar::-webkit-scrollbar{height:5px}.timeline-toolbar::-webkit-scrollbar-thumb{background:var(--ed-border);border-radius:4px}.timeline-toolbar>div,.timeline-toolbar button{flex-shrink:0}.timeline-clip-tools{display:flex;align-items:center;gap:3px;border-inline:1px solid var(--ed-border);padding-inline:9px}.timeline-clip-tools button{min-height:27px;padding:4px 6px;font-size:11px}.timeline-clip-tools button>svg{flex-shrink:0}.track-add{display:flex;align-items:center;gap:4px}.track-add>span{margin-right:12px;font-size:11px;font-weight:600}.track-add button{gap:0;min-height:25px}.timeline-zoom{display:flex;align-items:center;gap:3px;margin-left:auto;padding-right:2px}.timeline-zoom input{width:78px;height:18px}.timeline-zoom button{min-height:24px;padding:3px}.timeline-scroll{overflow:auto;flex:1;min-height:0;overscroll-behavior:contain}.timeline-content{min-width:100%;position:relative}.ruler-row,.track-row{display:flex;min-width:100%;position:relative}.ruler-row{height:24px;position:sticky;top:0;z-index:6;background:var(--ed-panel)}.track-label{width:140px;min-width:140px;position:sticky;left:0;z-index:4;background:var(--ed-panel);border-right:1px solid var(--ed-border);border-bottom:1px solid var(--ed-border);box-sizing:border-box;padding:3px 10px}.ruler-label{font:10px ui-monospace,monospace;color:var(--ed-muted);z-index:8;padding:5px 10px}.timeline-ruler{position:relative;border-bottom:1px solid var(--ed-border);height:24px;box-sizing:border-box;cursor:crosshair}.timeline-ruler>span{position:absolute;top:0;padding:5px 0 0 6px;height:100%;box-sizing:border-box;font:9px ui-monospace,monospace;color:var(--ed-muted);border-left:1px solid var(--ed-border)}.ruler-playhead{position:absolute;top:11px;width:10px;height:13px;transform:translateX(-5px);background:var(--ed-accent);clip-path:polygon(0 0,100% 0,100% 60%,50% 100%,0 60%);pointer-events:none;z-index:3}.track-row{height:48px}.track-row>.track-label{display:flex;flex-direction:column;justify-content:center}.track-name{display:flex;gap:6px;align-items:center;height:16px;flex:0 0 16px;font-size:10px;line-height:14px}.track-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track-name>svg{flex:none}.track-name>span:not(.track-clip-count){min-width:0}.track-name .track-clip-count{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:18px;max-width:40px;height:16px;box-sizing:border-box;padding:0 4px;margin-left:auto;border:1px solid var(--ed-border);border-radius:4px;background:var(--ed-bg);color:var(--ed-muted);font:9px ui-monospace,monospace;font-variant-numeric:tabular-nums;line-height:14px}.track-actions{display:flex;gap:4px;margin-top:2px}.track-actions button{padding:2px;height:22px;min-height:22px;width:22px;color:var(--ed-muted)}.track-actions button.enabled{color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 10%,transparent)}.track-lane{position:relative;height:48px;box-sizing:border-box;border-bottom:1px solid var(--ed-border);background-image:linear-gradient(to right,var(--ed-border) 1px,transparent 1px);background-color:var(--ed-bg);cursor:crosshair}.track-hint{font-size:10px;color:var(--ed-muted);position:absolute;left:12px;top:50%;transform:translateY(-50%);pointer-events:none;user-select:none}.timeline-clip{position:absolute;top:5px;height:38px;min-height:0;border-radius:5px;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;padding:4px 9px;gap:2px;text-align:left;overflow:hidden;cursor:grab;touch-action:none;user-select:none;border:1px solid #a2a4e0;background:#dcdcf3;color:#55538a;font-size:10px}.timeline-clip:hover:not(:disabled){background:#d2d1ee;color:#514d89}.timeline-clip.audio{border-color:#8ac3b0;background:#d2eae1;color:#377d68}.timeline-clip.text{border-color:#d6ba83;background:#f5e7c7;color:#967137}.timeline-clip.selected{outline:2px solid var(--ed-accent);outline-offset:0;z-index:2}.clip-title{display:flex;align-items:center;gap:5px;min-height:12px;line-height:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}.clip-title svg{flex-shrink:0}.clip-detail{font-size:8px;line-height:10px;opacity:.8;pointer-events:none}.trim-handle{position:absolute;top:0;bottom:0;width:7px;z-index:2;cursor:ew-resize}.trim-handle:after{content:'';display:block;position:absolute;top:11px;bottom:11px;width:2px;background:currentColor;opacity:.35;border-radius:2px}.trim-handle.start{left:0}.trim-handle.start:after{left:2px}.trim-handle.end{right:0}.trim-handle.end:after{right:2px}.locked .timeline-clip,.locked .trim-handle{cursor:not-allowed;opacity:.65}.lane-playhead{position:absolute;top:0;bottom:0;width:1px;background:var(--ed-accent);z-index:3;pointer-events:none}.timeline-footer{height:22px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-top:1px solid var(--ed-border);flex-shrink:0;color:var(--ed-muted);font-size:9px;gap:12px}.timeline-footer span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
.track-name .track-subtitle-warning{display:flex;flex:none;align-items:center;justify-content:center;gap:2px;min-width:28px;height:20px;min-height:20px;padding:1px 4px;border:1px solid #cb8b2870;border-radius:5px;background:#f9c54b25;color:var(--ed-warning,#a35b08);font-size:10px;font-weight:700;line-height:1}
.track-name .track-subtitle-warning:hover{background:#f9c54b45;color:var(--ed-warning,#804300)}
.track-name .track-subtitle-warning>span{flex:none;min-width:0;overflow:visible}
.track-subtitle-warning:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}
.timeline-clip.subtitle-invalid:not(.selected){border-color:#c78b2d;box-shadow:inset 0 2px 0 #c78b2d}
.subtitle-issue-note{display:flex;align-items:flex-start;gap:5px;margin:0;color:var(--ed-warning,#a35b08);font-size:11px;line-height:1.5}
.subtitle-issue-note svg{flex:none;margin-top:2px}
:global([data-theme="dark"] .video-editor){--ed-warning:#ffd080}
</style>
