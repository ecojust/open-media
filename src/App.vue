<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Icon from './components/Icon.vue'
import HeaderControls from './components/HeaderControls.vue'
import EditorDialog from './components/EditorDialog.vue'
import ScreenshotPicker from './components/ScreenshotPicker.vue'
import { DEFAULT_SCREENSHOT_SHORTCUT, matchesScreenshotShortcut, screenshotErrorMessage, screenshotShortcutValidationError } from './core/screenshot'
import { copyImageToClipboard, imageClipboardError } from './core/image-clipboard'
import { buildInfo } from './core/build-info'
import VideoEditor from './components/VideoEditor.vue'
import RecorderWorkspace from './components/RecorderWorkspace.vue'
import GifWorkspace from './components/GifWorkspace.vue'
import ConvertWorkspace from './components/ConvertWorkspace.vue'
import ExportPanel from './components/ExportPanel.vue'
import McpPanel from './components/McpPanel.vue'
import mcpToolCatalog from './mcp-tools.json'
import { createMcpAutomation, type McpPlayback } from './core/mcp-automation.ts'
import { claimMcpRequest, completeMcpRequest, getMcpServiceEpoch, getMcpStatus, getPendingMcpRequests, onMcpRequest, stopMcpService, type McpPanelJob, type McpRequest, type McpStatus } from './native-mcp.ts'
import type { ImportedProject, MediaAsset, Project, ProjectHistory, ProjectSummary } from './core/types.ts'
import { stampNewAssets } from './core/asset-times.ts'
import { cloneProject, createClip, createProject, createTrack, validateProject } from './core/project.ts'
import { adoptFirstVideoSize } from './core/project-size.ts'
import { addAssets, addClip, addTrack, commitHistory, createHistory, projectDuration, redoHistory, undoHistory } from './core/timeline.ts'
import { deleteProject, listProjects, loadProject, saveProject as storeProject } from './core/storage.ts'
import { exportProjectFile, importProjectFile } from './core/project-file.ts'
import { pickBrowserProjectFile, prepareBrowserProjectSave, writeBrowserProjectFile, type BrowserProjectFileHandle } from './core/browser-project-files.ts'
import { loadProjectSaveTarget, storeProjectSaveTarget, type ProjectSaveTarget } from './core/project-save-targets.ts'
import { downloadBlob, importMediaFile } from './core/media-import.ts'
import { cancelMediaJob, cancelCapturePicker, captureScreenshot, configureScreenshotShortcut, onScreenshotRequested, pickCaptureSource, showMainWindow, closeNativeWindow, getMediaJobs, importBlobAsset, isDesktop, onNativeCloseRequest, openProjectFile, pickMediaAssets, saveBytes, saveProjectFile, type ProjectFileTarget, type MediaJob } from './native.ts'

type Workspace = 'home' | 'edit' | 'record' | 'gif' | 'image' | 'video'
const workspaces: { id: Workspace; title: string; icon: string; description: string; color: string }[] = [
  { id: 'record', title: '录屏', icon: 'record', description: '录制屏幕与声音，随时暂停和继续', color: '#e35764' },
  { id: 'gif', title: '片段转 GIF', icon: 'gif', description: '截取多个精彩片段，生成循环动图', color: '#9161d1' },
  { id: 'edit', title: '视频剪辑', icon: 'scissors', description: '多轨剪辑、字幕与配乐，组合你的故事', color: '#2563eb' },
  { id: 'video', title: '视频转换', icon: 'convert', description: '转换视频格式、压缩体积与提取音频', color: '#dd9635' },
  { id: 'image', title: '图片编辑', icon: 'image', description: '插入文字与自定义笔触，裁剪并导出图片', color: '#2a9d80' },
]
const native = isDesktop(), view = ref<Workspace>('home'), collapsed = ref(false), booting = ref(true), theme = ref<'light' | 'dark' | 'system'>('system'), systemDark = ref(false)
const initial = createProject(), project = shallowRef(initial), history = shallowRef(createHistory(initial))
const projectRevision = ref(0)
watch(project, () => { projectRevision.value++ }, { flush: 'sync' })
const videoEditor = ref<InstanceType<typeof VideoEditor>>()
const mcpOpen = ref(false), mcpBusy = ref(false), mcpJobs = shallowRef<McpPanelJob[]>([]), mcpServiceRunning = ref(false)
const activeMcpJob = computed(() => mcpJobs.value.find(job => job.state === 'running') ?? mcpJobs.value[0])
const activeMcpProgress = computed(() => activeMcpJob.value ? mcpJobPercent(activeMcpJob.value) : undefined)
type McpToolActivity = { id: string; tool: string; label: string; state: 'running' | 'completed' | 'failed' }
const mcpToolActivity = shallowRef<McpToolActivity | null>(null)
const mcpToolLabels = new Map(mcpToolCatalog.map(tool => [tool.name, tool.description.split(/[。；，]/)[0] || tool.name]))
const mcpActivityTitle = computed(() => mcpBusy.value ? 'MCP 正在处理' : mcpToolActivity.value?.state === 'running' ? 'MCP 正在调用' : mcpToolActivity.value?.state === 'failed' ? 'MCP 调用失败' : 'MCP 调用完成')
let mcpActivityDeadlineTimer: ReturnType<typeof setTimeout> | undefined, mcpActivityFeedbackTimer: ReturnType<typeof setTimeout> | undefined
const mcpConnected = ref(false)
let mcpStatusRevision = 0, mcpObservedEpoch = getMcpServiceEpoch()
let mcpBridgeError = ''
let unlistenMcp: (() => void) | undefined, mcpRequestQueue = Promise.resolve()
let mcpRequestDeadline: number | undefined, mcpPlaybackVersion = 0
let pendingMcpPlayback: { version: number; pause: () => void } | undefined
const receivedMcpRequests = new Set<string>()
const pendingHydration = new WeakMap<Project, ImportedProject>()
let continuousEdit: { group: string; history: ProjectHistory } | undefined
const autoSave = ref(true), draftState = ref<'idle' | 'waiting' | 'pending' | 'saved' | 'error'>('idle'), draftError = ref(''), lastSaved = ref('')
const draftSeconds = ref(0), lastSaveAt = ref(''), lastSaveKind = ref<'draft' | 'file'>('draft')
const DRAFT_DELAY_MS = 3000
let draftCountdown: ReturnType<typeof setInterval> | undefined, projectGeneration = 0, draftSaveRequest = 0
let nativeProjectTarget: ProjectFileTarget | undefined, browserProjectTarget: BrowserProjectFileHandle | undefined
let saveTargetRestoreError = ''
const recent = ref<ProjectSummary[]>([]), status = ref('本地创作，自由表达'), busy = ref(''), error = ref(''), recording = ref(false), browserExporting = ref(false)
const exportOpen = ref(false), jobsOpen = ref(false), jobs = ref<MediaJob[]>([])
const mediaInput = ref<HTMLInputElement>(), projectInput = ref<HTMLInputElement>(), renameInput = ref<HTMLInputElement>(), renaming = ref(false), renameValue = ref(''), search = ref('')
const blobs = new Map<string, Blob>(), ownedUrls = new Set<string>(), hydratedReleases: { release: () => void; urls: Set<string> }[] = []
const recoveryRecordings = ref<{ id: string; name: string; blob: Blob }[]>([])
const switching = ref(false), pendingMedia = ref(0), imageConverting = ref(false), videoConverting = ref(false), gifConverting = ref(false), speechWorking = ref(false)
const screenshotPicker = ref<InstanceType<typeof ScreenshotPicker>>()
const screenshotShortcut = ref<string | null>(null), screenshotBusy = ref(false), screenshotConfiguring = ref(false), screenshotError = ref(''), screenshotAssetId = ref('')
const screenshotDisabled = computed(() => Boolean(busy.value || switching.value || booting.value || recording.value || pendingMedia.value || browserExporting.value || imageConverting.value || videoConverting.value || gifConverting.value || speechWorking.value || mcpBusy.value))
let screenshotAbort: AbortController | undefined, screenshotRequestId: string | undefined, unlistenScreenshot: (() => void) | undefined, destroyed = false
let captureQueue = Promise.resolve()
let draftTimer: ReturnType<typeof setTimeout> | undefined, draftGeneration = 0, saveQueue = Promise.resolve(), jobsTimer: ReturnType<typeof setTimeout> | undefined, mediaQuery: MediaQueryList | undefined, unlistenClose: (() => void) | undefined, allowClose = false
const effectiveTheme = computed(() => theme.value === 'system' ? systemDark.value ? 'dark' : 'light' : theme.value)
const duration = computed(() => projectDuration(project.value)), workspaceTitle = computed(() => workspaces.find(item => item.id === view.value)?.title || '开始')
const visibleRecent = computed(() => recent.value.filter(item => item.title.toLowerCase().includes(search.value.toLowerCase())))
const runningJobs = computed(() => jobs.value.filter(job => job.state === 'running').length)
function contentKey(value: Project) { const copy = cloneProject(value); copy.updatedAt = ''; for (const asset of copy.assets) { asset.url = ''; delete asset.nativePath; delete asset.sourceUrl }; return JSON.stringify(copy) }
const cleanKey = ref(contentKey(initial)), dirty = computed(() => contentKey(project.value) !== cleanKey.value)
const draftLabel = computed(() => draftState.value === 'error' ? '草稿保存失败' : draftState.value === 'waiting' ? `${draftSeconds.value} 秒后保存草稿` : draftState.value === 'pending' ? '正在保存草稿…' : !autoSave.value ? '自动保存已关闭' : draftState.value === 'saved' ? '本地草稿已保存' : '自动保存已开启')
const autosaveProgress = computed(() => draftState.value === 'waiting' ? `${draftSeconds.value} 秒后保存` : draftState.value === 'pending' ? '保存中…' : '')
function savedTime(value: string) { return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }
const lastSaveTitle = computed(() => lastSaveAt.value ? `${lastSaveKind.value === 'file' ? '项目文件' : '本地草稿'}上次保存：${savedTime(lastSaveAt.value)}` : '')
function openVideoExport() { if (view.value === 'edit' && duration.value && !busy.value && !switching.value && !booting.value && !speechWorking.value && !mcpBusy.value) exportOpen.value = true }
function announce(message: string) { status.value = message }
function fail(cause: unknown) { error.value = cause instanceof Error ? cause.message : String(cause); status.value = error.value }
function notifyError(cause: unknown) { fail(cause); busy.value = '' }
function remember() { try { localStorage.setItem('open-media:last-project', project.value.id) } catch { /* Local draft failures are reported by the persistent store. */ } }
async function refreshRecent() { recent.value = await listProjects() }
function cancelDraftCountdown() {
  clearTimeout(draftTimer); draftTimer = undefined
  clearInterval(draftCountdown); draftCountdown = undefined; draftSeconds.value = 0
}
function scheduleDraft() {
  cancelDraftCountdown()
  draftError.value = ''
  if (!autoSave.value || booting.value) { draftState.value = 'idle'; return }
  draftState.value = 'waiting'
  const generation = draftGeneration, deadline = Date.now() + DRAFT_DELAY_MS
  draftSeconds.value = Math.ceil(DRAFT_DELAY_MS / 1000)
  draftCountdown = setInterval(() => { draftSeconds.value = Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) }, 100)
  draftTimer = setTimeout(() => { if (generation === draftGeneration && autoSave.value) void persist() }, DRAFT_DELAY_MS)
}
function persist(): Promise<boolean> {
  cancelDraftCountdown()
  const snapshot = cloneProject(project.value), snapshotBlobs = new Map(blobs), key = contentKey(snapshot)
  const generation = projectGeneration, request = ++draftSaveRequest
  draftState.value = 'pending'; draftError.value = ''
  const result = saveQueue.then(async () => {
    try {
      const savedAt = await storeProject(snapshot, snapshotBlobs)
      if (!destroyed && projectGeneration === generation && project.value.id === snapshot.id) {
        lastSaveAt.value = savedAt; lastSaveKind.value = 'draft'
        // An earlier write must not hide the countdown or failure of a newer edit.
        if (request === draftSaveRequest && draftState.value !== 'waiting' && contentKey(project.value) === key) draftState.value = 'saved'
        remember()
      }
      // A recent-project list read is independent of the successful draft write.
      await refreshRecent().catch(() => {})
      return true
    } catch (cause) {
      if (!destroyed && projectGeneration === generation && project.value.id === snapshot.id && request === draftSaveRequest && draftState.value !== 'waiting' && contentKey(project.value) === key) {
        draftState.value = 'error'; draftError.value = cause instanceof Error ? cause.message : String(cause)
      }
      return false
    }
  })
  saveQueue = result.then(() => undefined)
  return result
}
function commit(next: Project, label = '已修改项目', historyGroup?: string, remote = false): boolean {
  if (destroyed || mcpBusy.value && !remote) return false
  try {
    const checked = validateProject(stampNewAssets(next, project.value), { trusted: true })
    if (contentKey(checked) === contentKey(project.value)) return true
    checked.updatedAt = new Date().toISOString()
    // Consecutive live text edits share one undo step; other edits and history navigation end the group.
    history.value = historyGroup && continuousEdit?.group === historyGroup && continuousEdit.history === history.value
      ? { ...history.value, present: cloneProject(checked), future: [] }
      : commitHistory(history.value, checked)
    continuousEdit = historyGroup ? { group: historyGroup, history: history.value } : undefined
    project.value = checked
    announce(label); scheduleDraft()
    return true
  } catch (cause) { fail(cause); return false }
}
function moveHistory(direction: 'undo' | 'redo') {
  if (switching.value || booting.value || speechWorking.value || mcpBusy.value) return
  continuousEdit = undefined
  history.value = direction === 'undo' ? undoHistory(history.value) : redoHistory(history.value)
  project.value = cloneProject(history.value.present); announce(direction === 'undo' ? '已撤销' : '已重做'); scheduleDraft()
}
function toggleAutosave() { if (switching.value || booting.value) return; autoSave.value = !autoSave.value; draftGeneration++; cancelDraftCountdown(); if (draftState.value === 'waiting') draftState.value = 'idle'; try { localStorage.setItem('open-media:autosave', String(autoSave.value)) } catch {} ; if (autoSave.value) void persist() }
function setTheme(value: 'light' | 'dark' | 'system') { theme.value = value; try { localStorage.setItem('open-media:theme', value) } catch {} }
function rememberAsset(asset: MediaAsset) { if (asset.url.startsWith('blob:')) ownedUrls.add(asset.url) }
function rememberEditorAsset(asset: MediaAsset, blob: Blob) { rememberAsset(asset); blobs.set(asset.id, blob) }
async function acceptAssets(assets: MediaAsset[], assetBlobs?: Map<string, Blob>) {
  if (!assets.length) return
  for (const asset of assets) { rememberAsset(asset); if (assetBlobs?.has(asset.id)) blobs.set(asset.id, assetBlobs.get(asset.id)!) }
  commit(adoptFirstVideoSize(addAssets(project.value, assets), assets), `已导入 ${assets.length} 个素材`)
}
async function acceptAsset(asset: MediaAsset) { try { await acceptAssets([asset]); announce('录制已加入素材库，可前往视频剪辑继续编辑。') } catch (cause) { fail(cause) } }
async function importFiles(files?: File[]) {
  if (busy.value || switching.value || booting.value || speechWorking.value || mcpBusy.value) return false
  if (!files?.length) {
    if (!native) { mediaInput.value?.click(); return }
    busy.value = '正在导入素材…'
    try { await acceptAssets(await pickMediaAssets()) } catch (cause) { fail(cause) } finally { busy.value = '' }
    return
  }
  busy.value = '正在读取素材…'; error.value = ''
  const assets: MediaAsset[] = [], imported = new Map<string, Blob>(), failures: string[] = []
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!
    busy.value = `正在导入 ${index + 1}/${files.length}：${file.name}`
    try {
      if (file.size > 512 * 1024 * 1024) throw new Error('单个网页导入文件不能超过 512 MB；桌面端可用“导入素材”选择较大的文件。')
      const asset = native ? await importBlobAsset(new Uint8Array(await file.arrayBuffer()), file.name) : await importMediaFile(file)
      assets.push(asset); if (!native) imported.set(asset.id, file)
    } catch (cause) { failures.push(`${file.name}：${cause instanceof Error ? cause.message : String(cause)}`) }
  }
  try { await acceptAssets(assets, imported); if (failures.length) fail(failures.join('\n')); return failures.length === 0 && assets.length > 0 } finally { busy.value = '' }
}
function waitForIdle(): Promise<void> {
  if (!busy.value && !switching.value && !mcpBusy.value) return Promise.resolve()
  return new Promise(resolve => { const stop = watch([busy, switching, mcpBusy], ([working, changing, automated]) => { if (!working && !changing && !automated) { stop(); resolve() } }) })
}
function captured(blob: Blob, name: string): Promise<void> {
  const targetId = project.value.id
  pendingMedia.value++
  announce('录制完成，正在加入素材库。')
  const task = captureQueue.catch(() => {}).then(async () => {
    await waitForIdle()
    if (project.value.id !== targetId) throw new Error('录制所属项目已切换，请先保存录制文件。')
    if (!await importFiles([new File([blob], name, { type: blob.type })])) throw new Error(error.value || '录制暂未加入素材库，请先保存录制文件。')
    announce('录制已加入素材库，可前往视频剪辑继续编辑。')
  }).catch(cause => { recoveryRecordings.value.push({ id: `${Date.now()}-${recoveryRecordings.value.length}`, name, blob }); fail(cause) }).finally(() => { pendingMedia.value-- })
  captureQueue = task
  return task
}
async function setScreenshotShortcut(value: string | null, rememberChoice = true): Promise<void> {
  if (screenshotConfiguring.value || screenshotBusy.value) return
  const conflict = screenshotShortcutValidationError(value)
  if (conflict) { screenshotError.value = conflict; return }
  screenshotConfiguring.value = true
  screenshotError.value = ''
  try {
    const registered = native ? await configureScreenshotShortcut(value) : value
    if (destroyed) { if (native) await configureScreenshotShortcut(null); return }
    screenshotShortcut.value = registered
    if (rememberChoice) {
      try { localStorage.setItem('open-media:screenshot-shortcut', registered ?? 'disabled') }
      catch { screenshotError.value = '快捷键已生效，但无法保存设置；下次启动需要重新设置。' }
    }
  } catch (cause) { screenshotError.value = screenshotErrorMessage(cause) }
  finally { screenshotConfiguring.value = false }
}
async function initializeScreenshot(): Promise<void> {
  let preference: string | null = DEFAULT_SCREENSHOT_SHORTCUT
  try { const saved = localStorage.getItem('open-media:screenshot-shortcut'); if (saved) preference = saved === 'disabled' ? null : saved } catch {}
  try {
    if (native) {
      const unlisten = await onScreenshotRequested(() => { if (!screenshotConfiguring.value) void takeScreenshot() })
      if (destroyed) { unlisten(); return }
      unlistenScreenshot = unlisten
    }
    await setScreenshotShortcut(preference, false)
  } catch (cause) { screenshotError.value = screenshotErrorMessage(cause) }
}
async function takeScreenshot(): Promise<void> {
  if (destroyed || screenshotBusy.value || screenshotConfiguring.value) return
  if (screenshotDisabled.value || hasDialog.value || document.querySelector('[role="dialog"][aria-modal="true"]') || document.querySelector('[data-shortcut-editor][aria-pressed="true"]')) {
    announce('请先完成当前操作或关闭弹窗，再截屏。')
    return
  }
  screenshotBusy.value = true
  screenshotError.value = ''
  const targetProjectId = project.value.id
  const abort = new AbortController()
  screenshotAbort = abort
  announce('请选择截屏范围，按 Esc 取消。')
  let clipboardResult: Promise<{ copied: true } | { copied: false; cause: unknown }> | undefined
  try {
    let asset: MediaAsset
    let blob: Blob | undefined
    const startClipboardCopy = (content: string | Blob | Promise<Blob>) => copyImageToClipboard(content, native, abort.signal).then(
      () => ({ copied: true as const }),
      (cause: unknown) => ({ copied: false as const, cause }),
    )
    if (native) {
      const requestId = crypto.randomUUID()
      screenshotRequestId = requestId
      const cancel = () => { void cancelCapturePicker(requestId).catch(() => {}) }
      abort.signal.addEventListener('abort', cancel, { once: true })
      let selection
      try { selection = await pickCaptureSource(requestId, { mode: 'region', purpose: 'screenshot' }) }
      finally { abort.signal.removeEventListener('abort', cancel); screenshotRequestId = undefined }
      if (!selection || destroyed || abort.signal.aborted) {
        if (!destroyed) { await showMainWindow(); announce('已取消截屏。') }
        return
      }
      asset = await captureScreenshot(selection)
    } else {
      if (!screenshotPicker.value) throw new Error('截屏界面尚未就绪，请重试。')
      const result = await screenshotPicker.value.capture(abort.signal, content => { clipboardResult = startClipboardCopy(content) })
      blob = result.blob
      asset = await importMediaFile(new File([blob], result.name, { type: 'image/png' }))
    }
    if (destroyed) { if (asset.url.startsWith('blob:')) URL.revokeObjectURL(asset.url); return }
    if (native) clipboardResult = startClipboardCopy(asset.url)
    if (targetProjectId !== project.value.id) throw new Error('截屏所属项目已改变，请重新截屏。')
    await acceptAssets([asset], blob ? new Map([[asset.id, blob]]) : undefined)
    if (!project.value.assets.some(item => item.id === asset.id)) throw new Error(error.value || '截屏未能加入项目，请重试。')
    screenshotAssetId.value = asset.id
    view.value = 'image'
    await nextTick()
    if (native) await showMainWindow()
    const copied = await (clipboardResult ?? startClipboardCopy(blob ?? asset.url))
    if (!destroyed && !abort.signal.aborted) {
      if (copied.copied) announce('截屏已复制到剪贴板，并载入图片编辑。')
      else if (!(copied.cause instanceof DOMException && copied.cause.name === 'AbortError')) announce(`截屏已载入图片编辑，自动复制未完成。${imageClipboardError(copied.cause)}`)
    }
  } catch (cause) {
    const message = screenshotErrorMessage(cause)
    const copied = await clipboardResult
    if (!destroyed) {
      if (message) {
        screenshotError.value = copied?.copied ? `截屏已复制到剪贴板，但加入图片编辑失败：${message}` : message
        fail(screenshotError.value)
      } else announce('已取消截屏。')
    }
    if (native && !destroyed) await showMainWindow().catch(() => {})
  } finally { if (screenshotAbort === abort) screenshotAbort = undefined; screenshotRequestId = undefined; screenshotBusy.value = false }
}
function convertedBusy(value: boolean, mode: 'image' | 'video') { if (mode === 'image') imageConverting.value = value; else videoConverting.value = value }
async function saveRecoveredRecording(id: string) {
  const item = recoveryRecordings.value.find(value => value.id === id)
  if (!item) return
  try {
    if (native) { if (!await saveBytes(item.name, new Uint8Array(await item.blob.arrayBuffer()))) return }
    else downloadBlob(item.blob, item.name)
    recoveryRecordings.value = recoveryRecordings.value.filter(value => value.id !== id); announce('录制文件已保存，可重新导入。')
  } catch (cause) { fail(cause) }
}
async function acceptConverted(asset: MediaAsset) {
  pendingMedia.value++
  try {
    const blob = await (await fetch(asset.url)).blob()
    if (native) { const imported = await importBlobAsset(new Uint8Array(await blob.arrayBuffer()), asset.name); await acceptAsset(imported) }
    else await acceptAssets([asset], new Map([[asset.id, blob]]))
  } catch (cause) { fail(cause) } finally { pendingMedia.value-- }
}
function addToTimeline(assetId: string) {
  if (mcpBusy.value) return
  const asset = project.value.assets.find(item => item.id === assetId)
  if (!asset) return
  try {
    let next = project.value
    const kind = asset.kind === 'audio' ? 'audio' : 'video'
    let track = next.tracks.find(item => item.kind === kind && !item.locked)
    if (!track) { track = createTrack(kind); next = addTrack(next, track) }
    const start = Math.max(0, ...track.clips.map(clip => clip.start + (clip.trimOut - clip.trimIn) / clip.speed))
    commit(addClip(next, track.id, createClip(asset, next, { start })), '已添加到时间线'); view.value = 'edit'
  } catch (cause) { fail(cause) }
}

interface Question { title: string; text: string; choices: { id: string; label: string; primary?: boolean }[] }
const question = ref<Question>(), questionResolve = ref<((answer: string) => void)>()
function ask(value: Question): Promise<string> { if (question.value) return Promise.resolve('cancel'); question.value = value; return new Promise(resolve => { questionResolve.value = resolve }) }
function answer(value: string) { const resolve = questionResolve.value; question.value = undefined; questionResolve.value = undefined; resolve?.(value) }
async function protectProject(): Promise<boolean> {
  while (dirty.value) {
    const id = project.value.id, key = contentKey(project.value)
    if (autoSave.value && await persist()) {
      if (project.value.id === id && contentKey(project.value) === key) return true
      continue
    }
    const choice = await ask({ title: '保留当前项目', text: '当前项目有尚未保留的修改。可以先保存本地草稿，稍后继续编辑。', choices: [{ id: 'cancel', label: '取消' }, { id: 'discard', label: '不保留修改' }, { id: 'save', label: '保存草稿', primary: true }] })
    if (choice === 'cancel') return false
    if (project.value.id !== id || contentKey(project.value) !== key) continue
    if (choice === 'discard') return true
    if (!await persist()) { fail(draftError.value); return false }
    if (project.value.id === id && contentKey(project.value) === key) return true
  }
  return true
}
function releaseUnusedMedia(next: Project) {
  const retainedIds = new Set(next.assets.map(asset => asset.id))
  const retainedUrls = new Set(next.assets.map(asset => asset.url))
  for (const id of blobs.keys()) if (!retainedIds.has(id)) blobs.delete(id)
  for (const url of ownedUrls) if (!retainedUrls.has(url)) { URL.revokeObjectURL(url); ownedUrls.delete(url) }
  for (let index = hydratedReleases.length - 1; index >= 0; index--) {
    const entry = hydratedReleases[index]!
    if (![...entry.urls].some(url => retainedUrls.has(url))) { entry.release(); hydratedReleases.splice(index, 1) }
  }
}
function applyProjectSaveTarget(target?: ProjectSaveTarget) {
  nativeProjectTarget = target?.kind === 'native' ? target.target : undefined
  browserProjectTarget = target?.kind === 'browser' ? target.handle : undefined
  lastSaved.value = nativeProjectTarget?.path ?? browserProjectTarget?.name ?? ''
  saveTargetRestoreError = ''
}
async function rememberProjectSaveTarget(projectId: string, target?: ProjectSaveTarget): Promise<string> {
  applyProjectSaveTarget(target)
  try { await storeProjectSaveTarget(projectId, target); return '' }
  catch {
    if (!target) {
      saveTargetRestoreError = '项目已打开，但无法清除旧保存位置记录。请使用“另存为”选择保存位置。'
      return saveTargetRestoreError
    }
    return '文件操作已完成，但无法记住保存位置；本次会话仍可直接保存，重新打开应用后请检查保存位置。'
  }
}
async function adoptProject(next: Project, restored = false, savedAt?: string) {
  continuousEdit = undefined
  projectGeneration++; draftGeneration++; cancelDraftCountdown()
  lastSaveAt.value = savedAt || ''; lastSaveKind.value = 'draft'
  applyProjectSaveTarget()
  releaseUnusedMedia(next)
  project.value = next; history.value = createHistory(next); cleanKey.value = contentKey(next); draftState.value = restored ? 'saved' : 'idle'; lastSaved.value = ''; remember()
  view.value = 'edit'; screenshotAssetId.value = ''; error.value = ''; if (!restored) scheduleDraft()
  if (restored) {
    try {
      const target = await loadProjectSaveTarget(next.id)
      if (target && (target.kind === 'native') !== native) throw new Error('保存位置属于另一运行环境。')
      applyProjectSaveTarget(target)
    } catch (cause) {
      saveTargetRestoreError = `无法恢复项目保存位置，请重新打开本地项目后重试，或使用“另存为”选择位置。${cause instanceof Error ? cause.message : ''}`
      fail(saveTargetRestoreError)
    }
  }
}
function localMediaIsWorking(): boolean { return screenshotBusy.value || recording.value || pendingMedia.value > 0 || browserExporting.value || runningJobs.value > 0 || imageConverting.value || videoConverting.value || gifConverting.value || speechWorking.value }
function mediaIsWorking(): boolean { return localMediaIsWorking() || mcpBusy.value }
async function changeProject(action: () => Promise<void>): Promise<void> {
  if (busy.value || switching.value || booting.value) return
  if (mediaIsWorking()) { fail('请先完成或取消录制、配音、转换、导出及 MCP 任务，再切换项目。'); return }
  switching.value = true
  try { if (await protectProject()) await action() } catch (cause) { fail(cause) } finally { switching.value = false }
}
async function newProject() { await changeProject(async () => { await adoptProject(createProject()); announce('已新建项目。') }) }
function retainImportedMedia(imported: ImportedProject, next: Project) {
  for (const [id, blob] of imported.blobs) blobs.set(id, blob)
  hydratedReleases.push({ release: imported.revoke, urls: new Set(imported.project.assets.map(asset => asset.url)) }); next.assets.forEach(rememberAsset)
}
async function hydrate(imported: ImportedProject, deferred = false) {
  const next = cloneProject(imported.project)
  if (native) {
    for (const asset of next.assets) {
      const blob = imported.blobs.get(asset.id)
      if (blob && !asset.nativePath) {
        const recovered = await importBlobAsset(new Uint8Array(await blob.arrayBuffer()), asset.name)
        Object.assign(asset, recovered, { id: asset.id, addedAt: asset.addedAt })
      }
    }
  }
  const checked = validateProject(next, { trusted: true })
  if (deferred) pendingHydration.set(checked, imported)
  else retainImportedMedia(imported, checked)
  return checked
}
async function openProject(file?: File) {
  if (busy.value || switching.value || booting.value) return
  let browserSelection: { file: File; handle: BrowserProjectFileHandle } | null | undefined
  if (!file && !native) {
    if (mediaIsWorking()) { fail('请先完成或取消录制、配音、转换及导出，再切换项目。'); return }
    try {
      const selection = pickBrowserProjectFile()
      if (!selection) { projectInput.value?.click(); return }
      busy.value = '正在选择项目…'
      browserSelection = await selection
      if (!browserSelection) return
      file = browserSelection.file
    } catch (cause) { fail(cause); return } finally { busy.value = '' }
  }
  await changeProject(async () => {
    busy.value = '正在打开项目…'; error.value = ''
    try {
      const selected = file || await openProjectFile()
      if (!selected) return
      const imported = await importProjectFile(selected instanceof File ? selected : new Uint8Array(selected.bytes))
      try {
        await adoptProject(await hydrate(imported))
        const target: ProjectSaveTarget | undefined = !(selected instanceof File)
          ? { kind: 'native', target: { name: selected.name, path: selected.path, token: selected.token } }
          : browserSelection ? { kind: 'browser', handle: browserSelection.handle } : undefined
        const warning = await rememberProjectSaveTarget(project.value.id, target)
        cleanKey.value = contentKey(project.value); announce(warning || '项目与素材已打开。')
        if (warning) error.value = warning
      } catch (cause) { imported.revoke(); throw cause }
    } finally { busy.value = '' }
  })
}
async function openRecent(id: string) {
  await changeProject(async () => {
    busy.value = '正在恢复本地草稿…'
    try { const imported = await loadProject(id); try { await adoptProject(await hydrate(imported), true, imported.savedAt); if (!saveTargetRestoreError) announce('已恢复本地项目。') } catch (cause) { imported.revoke(); throw cause } } finally { busy.value = '' }
  })
}
async function removeRecent(item: ProjectSummary) {
  if (mcpBusy.value) return
  const choice = await ask({ title: '移除本地草稿', text: `移除“${item.title}”的本地草稿？已经导出的项目文件仍可打开。`, choices: [{ id: 'cancel', label: '取消' }, { id: 'remove', label: '移除草稿', primary: true }] })
  if (choice !== 'remove') return
  try { if (item.id === project.value.id) { draftGeneration++; cancelDraftCountdown() }; await saveQueue; await deleteProject(item.id); await refreshRecent(); if (item.id === project.value.id) { draftState.value = 'idle'; if (lastSaveKind.value === 'draft') lastSaveAt.value = '' } } catch (cause) { fail(cause) }
}
async function save(saveAs = false, closing = false): Promise<boolean> {
  if (busy.value || switching.value && !closing || booting.value || speechWorking.value || mcpBusy.value) return false
  if (!saveAs && saveTargetRestoreError) { fail(saveTargetRestoreError); return false }
  busy.value = '正在打包项目与素材…'; error.value = ''
  const snapshot = cloneProject(project.value), key = contentKey(snapshot)
  try {
    const name = `${snapshot.title.replace(/[\\/:*?"<>|]/g, '-') || '媒体项目'}.omedia`
    const browserTarget = native ? undefined : await prepareBrowserProjectSave(name, saveAs ? undefined : browserProjectTarget)
    if (browserTarget === null) return false
    const blob = await exportProjectFile(snapshot, { blobs, onProgress: (done, total) => { busy.value = `正在打包项目 ${Math.round(done / Math.max(1, total) * 100)}%` } })
    let downloaded = false, targetWarning = ''
    if (native) {
      const target = await saveProjectFile(name, new Uint8Array(await blob.arrayBuffer()), saveAs ? undefined : nativeProjectTarget?.token)
      if (!target) return false
      targetWarning = await rememberProjectSaveTarget(snapshot.id, { kind: 'native', target })
    } else if (browserTarget) {
      await writeBrowserProjectFile(browserTarget, blob)
      targetWarning = await rememberProjectSaveTarget(snapshot.id, { kind: 'browser', handle: browserTarget })
    } else { downloadBlob(blob, name); lastSaved.value = name; downloaded = true }
    const savedAt = new Date().toISOString()
    if (project.value.id === snapshot.id) cleanKey.value = key
    await persist()
    if (project.value.id === snapshot.id) { lastSaveAt.value = savedAt; lastSaveKind.value = 'file' }
    announce(downloaded ? '已下载项目副本；当前浏览器不支持直接覆盖文件。' : `${saveAs ? '项目已另存为' : '项目已保存'}：${lastSaved.value}${targetWarning ? `；${targetWarning}` : ''}`)
    if (targetWarning) error.value = targetWarning
    return true
  } catch (cause) {
    fail(cause)
    return false
  } finally { busy.value = '' }
}
async function rename() { if (mcpBusy.value) return; renameValue.value = project.value.title; renaming.value = true; await nextTick(); renameInput.value?.focus(); renameInput.value?.select() }
function finishRename() { if (!renaming.value) return; renaming.value = false; const title = renameValue.value.trim().slice(0, 300); if (title) commit({ ...project.value, title }, '项目已重命名') }
async function pollMcpConnection(): Promise<void> {
  if (!native || destroyed || allowClose) return
  const revision = mcpStatusRevision
  try {
    const next = await getMcpStatus()
    if (!destroyed && !allowClose && revision === mcpStatusRevision) mcpServiceChanged(next)
  } catch (cause) {
    if (!destroyed && revision === mcpStatusRevision && !(cause instanceof Error && cause.name === 'AbortError')) mcpConnected.value = false
  }
}
async function pollJobs() {
  if (!native || destroyed) return
  await Promise.allSettled([
    getMediaJobs().then(next => { if (!destroyed) jobs.value = next }),
    pollMcpConnection(),
  ])
  if (!destroyed) jobsTimer = setTimeout(() => void pollJobs(), 1000)
}
async function cancelJob(id: string) { try { await cancelMediaJob(id); jobs.value = await getMediaJobs() } catch (cause) { fail(cause) } }
async function nativeClose() {
  if (allowClose || switching.value || question.value) return
  if (busy.value || booting.value) { fail('请等待当前操作完成，再关闭应用。'); return }
  if (mcpBusy.value) { openJobs(); fail('请在处理任务中完成或取消 MCP 任务，再关闭应用。'); return }
  if (screenshotBusy.value) { fail('请先完成或取消截屏，再关闭应用。'); return }
  if (speechWorking.value) { view.value = 'edit'; fail('请先结束录音或完成、取消文字配音，再关闭应用。'); return }
  if (recording.value || recoveryRecordings.value.length) { view.value = 'record'; fail('请先结束录制，录制完成后再关闭应用。'); return }
  if (browserExporting.value || runningJobs.value) { if (native) openJobs(); fail('请等待导出完成，或先取消正在处理的任务。'); return }
  if (pendingMedia.value || imageConverting.value || videoConverting.value || gifConverting.value) { fail('请先完成或取消素材导入及媒体转换，再关闭应用。'); return }
  switching.value = true
  const suspendedDialogs = [...document.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"][aria-modal="true"]')].map(element => ({ element, inert: element.inert }))
  try {
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.matches('input,textarea,[contenteditable="true"]')) focused.blur()
    finishRename()
    for (const { element } of suspendedDialogs) element.inert = true
    await nextTick()
    draftGeneration++; cancelDraftCountdown()
    await saveQueue
    jobs.value = await getMediaJobs()
    if (runningJobs.value) { openJobs(); fail('请等待导出完成，或先取消正在处理的任务。'); return }
    if (dirty.value) {
      const choice = await ask({
        title: '关闭应用',
        text: `“${project.value.title}”有尚未保存到项目文件的修改。全部关闭将退出应用，不再保存当前修改；已经保存的本地草稿仍会保留。`,
        choices: [{ id: 'cancel', label: '取消' }, { id: 'discard', label: '全部关闭' }, { id: 'save', label: '保存并全部关闭', primary: true }],
      })
      if (choice === 'cancel') return
      if (choice === 'save' && (!await save(false, true) || dirty.value)) return
    }
    allowClose = true
    try {
      clearMcpToolActivity()
      cancelMcpPlayback()
      if (mcpServiceRunning.value) { await mcpAutomation.cancelAll(); await stopMcpService(); mcpServiceRunning.value = false; mcpConnected.value = false }
      await closeNativeWindow()
    } catch (cause) { allowClose = false; throw cause }
  } catch (cause) { fail(cause) }
  finally {
    if (!allowClose) {
      switching.value = false
      for (const { element, inert } of suspendedDialogs) element.inert = inert
      if (autoSave.value && (draftState.value === 'pending' || draftState.value === 'waiting')) scheduleDraft()
    }
  }
}
const hasDialog = computed(() => Boolean(question.value || exportOpen.value || jobsOpen.value || mcpOpen.value))
let previousFocus: HTMLElement | null = null
watch(hasDialog, async open => { if (open) { previousFocus = document.activeElement as HTMLElement; await nextTick(); ((question.value ? document.querySelector('.app-confirm button') : document.querySelector('[role="dialog"][aria-modal="true"] button, [role="dialog"][aria-modal="true"] input')) as HTMLElement | null)?.focus() } else previousFocus?.focus() })
function keyboard(event: KeyboardEvent) {
  if (event.defaultPrevented || !hasDialog.value && document.querySelector('[role="dialog"][aria-modal="true"]')) return
  if (hasDialog.value) {
    if (event.key === 'Escape') { event.preventDefault(); if (question.value) answer('cancel'); else if (mcpOpen.value) mcpOpen.value = false; else if (jobsOpen.value) jobsOpen.value = false; else if (!browserExporting.value) exportOpen.value = false }
    if (event.key === 'Tab') {
      const dialog = question.value ? document.querySelector('.app-confirm') : document.querySelector('[role="dialog"][aria-modal="true"]'), items = dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')].filter(item => item.offsetParent !== null) : []
      const first = items[0], last = items.at(-1)
      if (first && event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (last && !event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    return
  }
  if (switching.value || booting.value || speechWorking.value || mcpBusy.value) { if (event.ctrlKey || event.metaKey) event.preventDefault(); return }
  if (!native && matchesScreenshotShortcut(event, screenshotShortcut.value)) { event.preventDefault(); void takeScreenshot(); return }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 's') { event.preventDefault(); void save(event.shiftKey) }
  if (key === 'o') { event.preventDefault(); void openProject() }
  if ((event.target as HTMLElement)?.closest('input,textarea,[contenteditable]')) return
  if (key === 'z') { event.preventDefault(); moveHistory(event.shiftKey ? 'redo' : 'undo') }
  if (key === 'y') { event.preventDefault(); moveHistory('redo') }
}
function unload(event: BeforeUnloadEvent) { if (!allowClose && (mediaIsWorking() || recoveryRecordings.value.length || busy.value || switching.value || dirty.value && (draftState.value !== 'saved' || !autoSave.value))) { event.preventDefault(); event.returnValue = '' } }
function mediaChanged(event: MediaQueryListEvent) { systemDark.value = event.matches }
function dropped(event: DragEvent) { event.preventDefault(); const files = [...(event.dataTransfer?.files || [])]; if (files.length === 1 && files[0]!.name.toLowerCase().endsWith('.omedia')) void openProject(files[0]); else if (files.length) void importFiles(files) }
function mcpLocalInteractionBusy(): boolean {
  // The automation task owns mcpBusy; feeding it back here would block its own commit.
  if (destroyed || allowClose || booting.value || switching.value || busy.value || localMediaIsWorking() || renaming.value || question.value || exportOpen.value) return true
  if (videoEditor.value?.getInteractionBusy()) return true
  const active = document.activeElement
  if (active instanceof HTMLElement && active.matches('input,textarea,[contenteditable="true"]') && !active.closest('.mcp-panel')) return true
  // Viewing or cancelling tasks does not edit the project; all other modals remain blocking.
  return [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(dialog => !dialog.matches('.jobs-dialog') && !dialog.querySelector('.mcp-panel'))
}
function cancelMcpPlayback(): void {
  mcpPlaybackVersion++
  const pending = pendingMcpPlayback
  pendingMcpPlayback = undefined
  pending?.pause()
}
const mcpAutomation = createMcpAutomation({
  getProject: () => project.value,
  getRevision: () => projectRevision.value,
  isBusy: mcpLocalInteractionBusy,
  isDirty: () => dirty.value,
  getBlobs: () => new Map(blobs),
  getSaveTarget: () => {
    if (saveTargetRestoreError) throw new Error(saveTargetRestoreError)
    return nativeProjectTarget ? { ...nativeProjectTarget } : undefined
  },
  commit: (next, label, expected) => {
    if (destroyed || allowClose || project.value.id !== expected.projectId || projectRevision.value !== expected.revision) return false
    videoEditor.value?.pause()
    return commit(next, label, undefined, true)
  },
  hydrate: imported => hydrate(imported, true),
  adopt: async next => {
    const imported = pendingHydration.get(next)
    if (imported) { retainImportedMedia(imported, next); pendingHydration.delete(next) }
    await adoptProject(next)
  },
  didSave: async (snapshot, target) => {
    if (destroyed || project.value.id !== snapshot.id) {
      await storeProjectSaveTarget(snapshot.id, { kind: 'native', target })
      return
    }
    const savedAt = new Date().toISOString()
    const warning = await rememberProjectSaveTarget(snapshot.id, { kind: 'native', target })
    cleanKey.value = contentKey(snapshot)
    await persist()
    if (!destroyed && project.value.id === snapshot.id) { lastSaveAt.value = savedAt; lastSaveKind.value = 'file'; if (warning) error.value = warning }
  },
  didOpen: async target => {
    const warning = await rememberProjectSaveTarget(project.value.id, { kind: 'native', target: { name: target.name, path: target.path, token: target.token } })
    cleanKey.value = contentKey(project.value)
    if (warning) error.value = warning
  },
  history: direction => { videoEditor.value?.pause(); moveHistory(direction) },
  getPlayback: () => videoEditor.value?.getPlayback() ?? { time: 0, playing: false, selectedClipId: '' },
  setPlayback: async (patch: Partial<McpPlayback>) => {
    if (destroyed || allowClose) throw new Error('应用正在关闭。')
    const epoch = getMcpServiceEpoch(), projectId = project.value.id, version = ++mcpPlaybackVersion
    const deadline = mcpRequestDeadline ?? Date.now() + 30_000
    const current = () => !destroyed && !allowClose && version === mcpPlaybackVersion && epoch === getMcpServiceEpoch() && project.value.id === projectId && Date.now() < deadline
    pendingMcpPlayback = { version, pause: () => videoEditor.value?.pause() }
    const timeout = setTimeout(() => { if (pendingMcpPlayback?.version === version) cancelMcpPlayback() }, Math.max(0, deadline - Date.now()))
    try {
      if (view.value !== 'edit') view.value = 'edit'
      // Newly created clips must reach the editor props before selection is validated.
      await nextTick()
      if (!current()) throw new Error('MCP 播放请求已停止或过期。')
      const editor = videoEditor.value
      if (!editor) throw new Error('视频剪辑界面尚未就绪。')
      pendingMcpPlayback = { version, pause: () => editor.pause() }
      const result = await editor.setPlayback(patch)
      if (!current()) {
        if (pendingMcpPlayback?.version === version) cancelMcpPlayback()
        throw new Error('MCP 播放请求已停止或过期。')
      }
      return result
    } finally {
      clearTimeout(timeout)
      if (pendingMcpPlayback?.version === version) pendingMcpPlayback = undefined
    }
  },
  ownAsset: (asset, blob) => { rememberAsset(asset); if (blob) blobs.set(asset.id, blob) },
  onBusy: value => {
    if (value) { videoEditor.value?.pause(); view.value = 'edit' }
    mcpBusy.value = value
  },
  onJobsChanged: () => { if (!destroyed) mcpJobs.value = mcpAutomation.list() },
  announce: message => { if (!destroyed) announce(message) },
})
function openJobs(): void {
  mcpOpen.value = false; jobsOpen.value = true
  // The closing native dialog restores its opener on the next tick before focus moves here.
  void nextTick(async () => { await nextTick(); if (jobsOpen.value) document.querySelector<HTMLButtonElement>('.jobs-dialog button')?.focus() })
}
function openMcp(): void { jobsOpen.value = false; mcpOpen.value = true; if (mcpBridgeError) fail(mcpBridgeError) }
function openMcpStatus(): void { if (mcpBusy.value) openJobs(); else openMcp() }
function mcpJobState(job: McpPanelJob): string { return job.cancelling ? '正在取消' : ({ running: '正在处理', completed: '已完成', failed: '失败', cancelled: '已取消' }[job.state]) }
function mcpJobPercent(job: McpPanelJob): number | undefined { return typeof job.progress === 'number' && Number.isFinite(job.progress) ? Math.round(Math.max(0, Math.min(1, job.progress)) * 100) : undefined }
async function cancelMcpJob(id: string): Promise<void> {
  try { await mcpAutomation.cancel(id); mcpJobs.value = mcpAutomation.list() } catch (cause) { fail(cause) }
}
function clearMcpToolActivity(id?: string): void {
  if (id && mcpToolActivity.value?.id !== id) return
  clearTimeout(mcpActivityDeadlineTimer); clearTimeout(mcpActivityFeedbackTimer)
  mcpActivityDeadlineTimer = undefined; mcpActivityFeedbackTimer = undefined
  mcpToolActivity.value = null
}
function beginMcpToolActivity(request: McpRequest): void {
  clearMcpToolActivity()
  mcpToolActivity.value = { id: request.id, tool: request.tool, label: mcpToolLabels.get(request.tool) || request.tool, state: 'running' }
  mcpActivityDeadlineTimer = setTimeout(() => clearMcpToolActivity(request.id), Math.max(0, request.deadlineAt - Date.now()))
}
function finishMcpToolActivity(id: string, failed: boolean): void {
  const activity = mcpToolActivity.value
  if (activity?.id !== id) return
  clearTimeout(mcpActivityDeadlineTimer); mcpActivityDeadlineTimer = undefined
  mcpToolActivity.value = { ...activity, state: failed ? 'failed' : 'completed' }
  // Fast tools retain truthful completion feedback without extending the edit lock.
  mcpActivityFeedbackTimer = setTimeout(() => clearMcpToolActivity(id), 1200)
}
function mcpServiceChanged(next: McpStatus): void {
  if (destroyed || allowClose) return
  const changed = mcpServiceRunning.value !== next.running || mcpObservedEpoch !== getMcpServiceEpoch()
  mcpObservedEpoch = getMcpServiceEpoch(); mcpStatusRevision++
  mcpServiceRunning.value = next.running
  mcpConnected.value = native && next.running && Number.isFinite(next.connectedClients) && next.connectedClients > 0
  if (!changed) return
  if (!next.running) { clearMcpToolActivity(); cancelMcpPlayback(); void mcpAutomation.cancelAll() }
  else void recoverPendingMcpRequests()
}
function enqueueMcpRequest(request: McpRequest): void {
  if (destroyed || !request || typeof request.id !== 'string' || typeof request.deadlineAt !== 'number' || receivedMcpRequests.has(request.id)) return
  receivedMcpRequests.add(request.id)
  // Native request IDs are unique for the application lifetime; bound the replay cache.
  if (receivedMcpRequests.size > 2048) receivedMcpRequests.delete(receivedMcpRequests.values().next().value!)
  const epoch = getMcpServiceEpoch()
  const current = () => !destroyed && !allowClose && epoch === getMcpServiceEpoch() && Date.now() < request.deadlineAt
  const run = async () => {
    if (!current()) return
    const claimed = await claimMcpRequest(request.id)
    // Claim crosses native IPC. Stop, navigation and expiry must be checked again after it.
    if (!claimed || !current()) return
    mcpRequestDeadline = request.deadlineAt
    beginMcpToolActivity(request)
    let failed = false
    try {
      const result = await mcpAutomation.execute(request.tool, request.arguments)
      if (current()) await completeMcpRequest(request.id, result)
    } catch (cause) {
      failed = true
      if (current()) await completeMcpRequest(request.id, { error: cause instanceof Error ? cause.message : String(cause) }, true)
    } finally {
      mcpRequestDeadline = undefined
      if (current()) finishMcpToolActivity(request.id, failed)
      else clearMcpToolActivity(request.id)
    }
  }
  mcpRequestQueue = mcpRequestQueue.then(run, run).catch(cause => {
    if (!destroyed) { mcpBridgeError = `MCP 请求处理失败：${cause instanceof Error ? cause.message : String(cause)}`; announce(mcpBridgeError) }
  })
}
async function recoverPendingMcpRequests(): Promise<void> {
  if (!native || destroyed) return
  try {
    const requests = await getPendingMcpRequests()
    if (!Array.isArray(requests)) throw new Error('无法读取待处理请求。')
    if (!destroyed) { mcpBridgeError = ''; requests.forEach(enqueueMcpRequest) }
  } catch (cause) { if (!destroyed) mcpBridgeError = `MCP 连接尚未就绪：${cause instanceof Error ? cause.message : String(cause)}` }
}
async function initializeMcp(): Promise<void> {
  try {
    const unlisten = await onMcpRequest(enqueueMcpRequest)
    if (destroyed) { unlisten(); return }
    unlistenMcp = unlisten
    await recoverPendingMcpRequests()
  } catch (cause) { if (!destroyed) mcpBridgeError = `无法监听 MCP 请求：${cause instanceof Error ? cause.message : String(cause)}` }
}
onMounted(async () => {
  mediaQuery = matchMedia('(prefers-color-scheme: dark)'); systemDark.value = mediaQuery.matches; mediaQuery.addEventListener('change', mediaChanged)
  window.addEventListener('keydown', keyboard); window.addEventListener('beforeunload', unload)
  try { autoSave.value = localStorage.getItem('open-media:autosave') !== 'false'; const value = localStorage.getItem('open-media:theme'); if (value === 'light' || value === 'dark' || value === 'system') theme.value = value } catch {}
  try { await refreshRecent(); const last = localStorage.getItem('open-media:last-project'); if (last && recent.value.some(item => item.id === last)) { const imported = await loadProject(last); const restored = await hydrate(imported); await adoptProject(restored, true, imported.savedAt); view.value = 'home' } } catch (cause) { fail(cause) }
  booting.value = false
  void initializeScreenshot()
  if (native) {
    void initializeMcp()
    void pollJobs()
    try { unlistenClose = await onNativeCloseRequest(() => { if (!allowClose) void nativeClose() }) } catch (cause) { fail(cause) }
  }
})
onBeforeUnmount(() => { destroyed = true; clearMcpToolActivity(); cancelMcpPlayback(); unlistenMcp?.(); void mcpAutomation.dispose().catch(() => {}); if (native) void stopMcpService().catch(() => {}); screenshotAbort?.abort(); if (screenshotRequestId) void cancelCapturePicker(screenshotRequestId).catch(() => {}); unlistenScreenshot?.(); if (native) void configureScreenshotShortcut(null).catch(() => {}); draftGeneration++; cancelDraftCountdown(); clearTimeout(jobsTimer); unlistenClose?.(); mediaQuery?.removeEventListener('change', mediaChanged); window.removeEventListener('keydown', keyboard); window.removeEventListener('beforeunload', unload); for (const entry of hydratedReleases) entry.release(); for (const url of ownedUrls) URL.revokeObjectURL(url) })
</script>

<template>
  <div class="app-shell" :data-theme="effectiveTheme" @dragover.prevent @drop="dropped">
    <header class="topbar">
      <button class="brand" :disabled="speechWorking || mcpBusy" title="开始" @click="view='home'"><img src="/brand-mark.png" width="29" height="29" alt=""/><strong>Open Media</strong></button>
      <div class="topbar-end"><HeaderControls :theme="theme" :effective-theme="effectiveTheme" @update:theme="setTheme"/></div>
    </header>
    <div class="workbench-body" :inert="switching || booting">
      <aside class="sidebar" :class="{collapsed}">
        <div class="sidebar-heading"><span v-if="!collapsed">工作台</span><button class="icon-button" :title="collapsed?'展开侧栏':'折叠侧栏'" :aria-label="collapsed?'展开侧栏':'折叠侧栏'" @click="collapsed=!collapsed"><Icon name="panel" :size="17"/></button></div>
        <nav aria-label="工作区"><button :disabled="speechWorking || mcpBusy" :class="{active:view==='home'}" title="开始" @click="view='home'"><Icon name="home"/><span>开始</span></button><div class="nav-divider"/><button v-for="item in workspaces" :key="item.id" :disabled="speechWorking || mcpBusy" :class="{active:view===item.id}" :title="item.title" :data-testid="`nav-${item.id}`" @click="view=item.id"><Icon :name="item.icon"/><span>{{ item.title }}</span><i v-if="item.id==='record' && recording" class="recording-dot"/></button></nav>
        <div class="sidebar-bottom"><div class="local-mark"><Icon name="lock" :size="14"/><span>素材在本机处理</span></div><small v-if="!collapsed">Open Media · {{ buildInfo.version }}</small></div>
      </aside>
      <main class="main-area">
        <div v-if="view!=='home'" class="project-bar"><span class="workspace-tag"><Icon :name="workspaces.find(item=>item.id===view)?.icon || 'video'" :size="15"/>{{ workspaceTitle }}</span><span class="divider"/><input v-if="renaming" ref="renameInput" v-model="renameValue" maxlength="300" class="rename-input" aria-label="项目名称" @blur="finishRename" @keydown.enter="finishRename" @keydown.esc="renaming=false"/><button v-else :disabled="speechWorking || mcpBusy" class="project-title" :title="`${project.title}，点击重命名`" @click="rename">{{ project.title }}<i v-if="dirty"/></button><span class="project-summary">{{ project.assets.length }} 个素材 · {{ duration.toFixed(1) }} 秒</span><div v-if="view==='edit'" class="project-file-actions file-actions">
        <button title="新建工程" aria-label="新建工程" :disabled="!!busy || switching || booting || mediaIsWorking()" data-testid="new-project" @click="newProject()"><Icon name="plus"/><span>新建工程</span></button>
        <button title="打开项目 (Ctrl/⌘+O)" aria-label="打开项目" :disabled="!!busy || switching || booting || mediaIsWorking()" data-testid="open-project" @click="openProject()"><Icon name="folder"/><span>打开</span></button>
        <button :title="lastSaved && (native || browserProjectTarget) ? `保存到 ${lastSaved} (Ctrl/⌘+S)` : '保存项目 (Ctrl/⌘+S)'" aria-label="保存项目" :disabled="!!busy || switching || booting || speechWorking || mcpBusy" data-testid="save-project" @click="save()"><Icon name="save"/><span>保存</span></button>
        <button class="autosave-switch" role="switch" :aria-checked="autoSave" aria-label="自动保存本地草稿" title="仅自动保存本地草稿" :disabled="booting || switching" data-testid="autosave-toggle" :aria-describedby="autosaveProgress ? 'autosave-progress' : undefined" @click="toggleAutosave"><span>自动保存</span><svg width="28" height="16" viewBox="0 0 28 16"><rect width="28" height="16" rx="8"/><circle :cx="autoSave?20:8" cy="8" r="5.5"/></svg></button>
        <span v-if="autosaveProgress" id="autosave-progress" class="autosave-countdown" data-testid="autosave-countdown">{{ autosaveProgress }}</span>
        <button title="另存为项目 (Ctrl/⌘+Shift+S)" aria-label="另存为项目" :disabled="!!busy || switching || booting || speechWorking || mcpBusy" data-testid="save-as-project" @click="save(true)"><Icon name="save-as"/><span>另存为</span></button>
        <span class="divider"/><button class="icon-button" title="撤销 (Ctrl+Z)" aria-label="撤销" :disabled="!history.past.length || switching || booting || speechWorking || mcpBusy" @click="moveHistory('undo')"><Icon name="undo"/></button><button class="icon-button" title="重做" aria-label="重做" :disabled="!history.future.length || switching || booting || speechWorking || mcpBusy" @click="moveHistory('redo')"><Icon name="redo"/></button>
      </div></div>
        <div v-if="error" class="app-error" role="alert"><Icon name="alert" :size="16"/><span>{{ error }}</span><button class="icon-button" aria-label="关闭提示" @click="error=''"><Icon name="close" :size="15"/></button></div>
        <div v-for="item in recoveryRecordings" :key="item.id" class="app-error recording-recovery" role="alert"><Icon name="video" :size="16"/><span>录制尚未加入项目：{{ item.name }}</span><button @click="saveRecoveredRecording(item.id)">保存录制文件</button></div>
        <section v-if="!booting && (mcpBusy || mcpToolActivity)" class="mcp-processing-banner" data-testid="mcp-processing-banner" aria-label="MCP 处理状态" :data-call-state="mcpToolActivity?.state" :data-call-tool="mcpToolActivity?.tool">
          <span v-if="mcpBusy || mcpToolActivity?.state==='running'" class="spinner small" aria-hidden="true"/><Icon v-else :name="mcpToolActivity?.state==='failed' ? 'alert' : 'check'" :size="16"/>
          <div class="mcp-processing-copy" role="status" aria-live="polite">
            <div class="mcp-processing-heading"><strong>{{ mcpActivityTitle }}</strong><span v-if="mcpBusy && activeMcpJob">{{ activeMcpJob.name }}<template v-if="activeMcpProgress!==undefined"> · {{ activeMcpProgress }}%</template></span><span v-else-if="mcpToolActivity" :title="mcpToolActivity.tool">{{ mcpToolActivity.label }}</span></div>
            <p v-if="mcpBusy"><span v-if="activeMcpJob?.stage">{{ activeMcpJob.stage }} · </span>编辑暂时锁定，完成后自动恢复。</p>
            <p v-if="mcpBusy && mcpToolActivity" :title="mcpToolActivity.tool">{{ mcpToolActivity.state==='running' ? '正在调用' : mcpToolActivity.state==='failed' ? '调用失败' : '最近调用已完成' }}：{{ mcpToolActivity.label }}</p>
            <p v-else-if="mcpToolActivity">{{ mcpToolActivity.state==='running' ? '正在执行工具调用。' : mcpToolActivity.state==='failed' ? '本次调用失败，具体原因已返回客户端。' : '本次工具调用已完成。' }}</p>
          </div>
          <div v-if="mcpBusy" class="mcp-processing-actions"><button data-testid="mcp-processing-tasks" @click="openJobs"><Icon name="layers" :size="14"/>查看任务</button><button v-if="activeMcpJob?.state==='running' && activeMcpJob.cancelable!==false" data-testid="mcp-processing-cancel" :disabled="activeMcpJob.cancelling" @click="cancelMcpJob(activeMcpJob.id)">{{ activeMcpJob.cancelling ? '正在取消…' : '取消任务' }}</button></div>
        </section>
        <div v-if="booting" class="boot-loading"><span class="spinner"/>正在恢复工作台…</div>
        <section v-else-if="view==='home'" class="home-workspace" data-testid="home-workspace">
          <div class="home-intro"><div class="eyebrow"><span/>YOUR LOCAL CREATIVE STUDIO</div><h1>把灵感，剪成作品。</h1><p>录下屏幕，整理片段，转换媒体。<br/>让每一次创作，都从这里开始。</p><div class="home-actions"><button class="primary" data-testid="create-project" :disabled="switching || booting || speechWorking || screenshotBusy || mcpBusy" @click="newProject"><Icon name="plus"/>新建剪辑项目</button><button :disabled="switching || booting || speechWorking || screenshotBusy || mcpBusy" @click="openProject()"><Icon name="folder"/>打开项目</button></div><div class="hero-art" aria-hidden="true"><div class="art-window"><div class="art-dots"><i/><i/><i/></div><svg viewBox="0 0 260 120"><path d="M0 85 40 65 75 80 130 32 180 60 220 25 260 45v75H0Z" fill="#dce8ff"/><path d="M0 105 60 80 105 95 155 65 210 88 260 64v56H0Z" fill="#b9d0ff"/><circle cx="130" cy="60" r="25" fill="white"/><path d="m124 48 19 12-19 12z" fill="#4b7deb"/></svg></div><div class="art-timeline"><i/><i/><i/><i/><b/></div><div class="art-note"><Icon name="audio" :size="20"/><span><i/><i/><i/><i/><i/><i/><i/></span></div></div></div>
          <div class="workspace-cards"><button v-for="item in workspaces" :key="item.id" :data-testid="`create-${item.id}`" :disabled="mcpBusy" @click="view=item.id"><span class="card-icon" :style="{'--card-color':item.color}"><Icon :name="item.icon" :size="23"/></span><strong>{{ item.title }}</strong><p>{{ item.description }}</p><Icon name="chevron-right" :size="15"/></button></div>
          <section class="recent-section"><div class="section-heading"><h2>最近项目 <span>{{ recent.length }}</span></h2><label class="search-field"><Icon name="search" :size="15"/><input v-model="search" placeholder="搜索本地项目" aria-label="搜索本地项目"/></label></div><div v-if="!visibleRecent.length" class="empty-projects"><Icon name="folder" :size="31"/><p>{{ search?'没有找到匹配项目':'你的项目会保存在这里' }}</p><small>开启自动保存后，可随时回来继续编辑。</small></div><div v-else class="recent-list"><div v-for="item in visibleRecent" :key="item.id" class="recent-item"><button :disabled="mcpBusy" @click="openRecent(item.id)"><span class="recent-icon"><Icon name="video" :size="22"/></span><span><strong>{{ item.title }}</strong><small>{{ item.width }} × {{ item.height }} · {{ item.assetCount }} 个素材 · {{ item.duration.toFixed(1) }} 秒</small></span><time :datetime="item.updatedAt">{{ new Date(item.updatedAt).toLocaleString() }}</time></button><button class="icon-button" :aria-label="`移除草稿 ${item.title}`" :disabled="mcpBusy" @click="removeRecent(item)"><Icon name="trash" :size="16"/></button></div></div></section>
          <p class="home-footnote"><Icon name="info" :size="14"/>自动保存保留本地草稿；保存项目会同时打包素材，方便迁移和继续编辑。</p>
        </section>
        <VideoEditor ref="videoEditor" v-if="!booting && view==='edit'" :project="project" :automation-busy="mcpBusy" :mcp-connected="mcpConnected" :export-disabled="!!busy || switching || booting || mcpBusy" :recording-disabled="recording || screenshotBusy || pendingMedia > 0 || browserExporting || mcpBusy" @open-mcp="openMcp" @recorded-asset="rememberEditorAsset" @prepared-asset="rememberEditorAsset" @busy="speechWorking=$event" @change="commit" @import="importFiles" @export="openVideoExport" @status="announce"/>
        <KeepAlive :key="`record-${project.id}`"><RecorderWorkspace v-if="!booting && view==='record'" :assets="project.assets" :native="native" :screenshot-shortcut="screenshotShortcut" :screenshot-busy="screenshotBusy" :screenshot-disabled="screenshotDisabled" :screenshot-error="screenshotError" :screenshot-configuring="screenshotConfiguring" @screenshot="takeScreenshot" @screenshot-shortcut-change="setScreenshotShortcut" @captured="captured" @asset="acceptAsset" @add-to-timeline="addToTimeline" @recording-change="recording=$event" @status="announce"/></KeepAlive>
        <KeepAlive :key="`gif-${project.id}`"><GifWorkspace @busy-change="gifConverting=$event" v-if="!booting && view==='gif'" :assets="project.assets" :native="native" @imported="importFiles([$event])" @status="announce"/></KeepAlive>
        <KeepAlive :key="`convert-${project.id}`"><ConvertWorkspace @busy-change="convertedBusy" v-if="!booting && (view==='image'||view==='video')" :key="view" :mode="view" :focus-asset-id="view==='image' ? screenshotAssetId : undefined" :assets="project.assets" :native="native" @import="importFiles" @result="acceptConverted" @status="announce"/></KeepAlive>
      </main>
    </div>
    <footer class="statusbar"><span class="status-main"><span v-if="busy" class="spinner small"/><Icon v-else :name="recording?'record':'check'" :size="13"/><span class="status-message">{{ busy || status }}</span><time v-if="lastSaveAt" class="last-save-time" data-testid="last-save-time" :datetime="lastSaveAt" :title="lastSaveTitle">上次保存 {{ savedTime(lastSaveAt) }}</time></span><span v-if="native" class="status-tasks"><button v-if="mcpBusy || mcpServiceRunning" class="job-status" aria-label="MCP 任务" @click="openMcpStatus"><Icon name="mcp" :size="13"/><span>{{ mcpBusy ? 'MCP 正在处理' : 'MCP 服务' }}</span></button><button class="job-status" aria-label="处理任务" title="查看媒体处理与 MCP 任务" @click="openJobs"><Icon name="layers" :size="13"/><span>处理任务</span><b v-if="runningJobs">{{ runningJobs }}</b></button></span><button :class="{danger:draftState==='error'}" :title="draftError || lastSaved || draftLabel" @click="draftState==='error' && persist()"><span v-if="draftState==='pending'" class="spinner small"/><Icon v-else :name="draftState==='error'?'alert':autoSave?'check':'save'" :size="13"/>{{ draftLabel }}</button></footer>
    <input ref="mediaInput" class="sr-only" type="file" accept="video/*,audio/*,image/*,.mkv,.mov,.avi,.flac,.ogg" multiple data-testid="media-input" @change="importFiles([...(($event.target as HTMLInputElement).files || [])]); ($event.target as HTMLInputElement).value=''"/>
    <input ref="projectInput" class="sr-only" type="file" accept=".omedia" data-testid="project-input" @change="openProject(($event.target as HTMLInputElement).files?.[0]); ($event.target as HTMLInputElement).value=''"/>
    <ScreenshotPicker ref="screenshotPicker"/>
    <ExportPanel :open="exportOpen" :project="project" :native="native" @close="exportOpen=false" @status="announce" @busy="browserExporting=$event"/>
    <McpPanel :open="mcpOpen" :native="native" @close="mcpOpen=false" @status="announce" @service-change="mcpServiceChanged"/>
    <EditorDialog :open="!!question" :title="question?.title || '确认操作'" icon="alert" class="app-confirm" @close="answer('cancel')"><div class="dialog-content"><p>{{ question?.text }}</p></div><template #footer><div class="confirmation-actions"><button v-for="choice in question?.choices" :key="choice.id" :class="{primary:choice.primary}" @click="answer(choice.id)">{{ choice.label }}</button></div></template></EditorDialog>
    <div v-if="jobsOpen" class="modal-shade" @click.self="jobsOpen=false">
      <section class="dialog jobs-dialog" role="dialog" aria-modal="true" aria-labelledby="jobs-title">
        <header><span><Icon name="layers"/><strong id="jobs-title">处理任务</strong></span><button class="icon-button" aria-label="关闭任务" @click="jobsOpen=false"><Icon name="close"/></button></header>
        <div class="dialog-content">
          <p v-if="!jobs.length && !mcpJobs.length" class="muted">还没有处理任务。</p>
          <h3 v-if="jobs.length && mcpJobs.length">媒体处理</h3>
          <article v-for="job in [...jobs].reverse()" :key="job.id" class="job-item" :data-media-job-id="job.id">
            <div><strong>{{ job.name }}</strong><span>{{ ({running:'正在处理',completed:'已完成',failed:'失败',cancelled:'已取消'})[job.state] }}</span></div>
            <div v-if="job.state==='running'" class="progress-track"><i :style="{width:`${job.progress*100}%`}"/></div>
            <p v-if="job.outputPath">{{ job.outputPath }}</p><p v-if="job.error" class="error-message">{{ job.error }}</p>
            <button v-if="job.state==='running'" @click="cancelJob(job.id)">取消任务</button>
          </article>
          <h3 v-if="mcpJobs.length">MCP 任务</h3>
          <article v-for="job in mcpJobs" :key="job.id" class="job-item mcp-task-item" :data-mcp-job-id="job.id">
            <div><strong>{{ job.name }}</strong><span>{{ mcpJobState(job) }}<template v-if="mcpJobPercent(job)!==undefined"> · {{ mcpJobPercent(job) }}%</template></span></div>
            <progress v-if="job.state==='running'" :value="mcpJobPercent(job)" max="100" :aria-label="`${job.name}进度`"/>
            <p v-if="job.error || job.stage" :class="{ 'error-message': job.state==='failed' }">{{ job.error || job.stage }}</p>
            <button v-if="job.state==='running' && job.cancelable!==false" :disabled="job.cancelling" :aria-label="`取消 MCP 任务 ${job.name}`" @click="cancelMcpJob(job.id)">{{ job.cancelling ? '正在取消…' : '取消任务' }}</button>
          </article>
        </div>
        <footer><button @click="jobsOpen=false">关闭</button></footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.autosave-countdown{font-size:10px;color:var(--ui-muted);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:5.5em;margin-right:4px}
.status-message{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.last-save-time{flex:none;font-variant-numeric:tabular-nums;border-left:1px solid var(--ui-line);padding-left:8px;margin-left:2px}
@media(max-width:640px){.status-main{max-width:none;flex:1}.status-message{flex:1}.last-save-time{max-width:60%;overflow:hidden;text-overflow:ellipsis;font-size:9px}}
.app-confirm{--ed-border:var(--ui-line);--ed-panel:var(--ui-surface);--ed-text:var(--ui-text);--ed-accent:var(--ui-accent);--ed-muted:var(--ui-muted);--ed-bg:var(--ui-hover)}
.confirmation-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
.confirmation-actions button{font-size:12px}
.mcp-task-item progress{display:block;width:100%;height:5px;accent-color:var(--ui-accent)}
.mcp-task-item .error-message{color:var(--ui-danger)}
.mcp-processing-banner{display:flex;align-items:center;gap:12px;flex-shrink:0;padding:10px 16px;border-bottom:1px solid color-mix(in srgb,var(--ui-accent) 20%,var(--ui-line));background:color-mix(in srgb,var(--ui-accent) 7%,var(--ui-surface));color:var(--ui-text)}
.mcp-processing-banner>.spinner{flex:none}.mcp-processing-copy{flex:1;min-width:0}.mcp-processing-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px 12px;font-size:12px}.mcp-processing-heading strong{color:var(--ui-accent)}.mcp-processing-heading span{overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.mcp-processing-copy p{margin:4px 0 0;font-size:11px;line-height:1.5;color:var(--ui-muted);overflow-wrap:anywhere}.mcp-processing-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;flex-shrink:0}.mcp-processing-actions button{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:4px 9px;border:1px solid var(--ui-line);border-radius:6px;background:var(--ui-surface);color:var(--ui-text);font:inherit;font-size:11px;cursor:pointer}.mcp-processing-actions button:hover:not(:disabled){border-color:var(--ui-accent);color:var(--ui-accent)}.mcp-processing-actions button:disabled{opacity:.5;cursor:wait}
@media(max-width:700px){.mcp-processing-banner{gap:8px;padding:9px 12px;flex-wrap:wrap}.mcp-processing-actions{margin-left:auto}}
</style>
