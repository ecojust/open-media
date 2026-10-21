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
import VideoGenerationWorkspace from './components/VideoGenerationWorkspace.vue'
import AiGenerationWorkspace from './components/AiGenerationWorkspace.vue'
import AppInfo from './components/AppInfo.vue'
import { aiState, observeAi } from './core/ai-service.ts'
import { getAiStatus, type AiProvider } from './native-ai.ts'
import ConvertWorkspace from './components/ConvertWorkspace.vue'
import ExportPanel from './components/ExportPanel.vue'
import McpPanel from './components/McpPanel.vue'
import McpStatusGlow from './components/McpStatusGlow.vue'
import mcpToolCatalog from './mcp-tools.json'
import { prepareEditorTool, type EditorToolRunner } from './core/editor-tool-service.ts'
import { createMcpAutomation, type McpPlayback } from './core/mcp-automation.ts'
import { serializeMcpError } from './core/mcp-response.ts'
import { createNativeAppearanceSync } from './native-appearance.ts'
import { claimMcpRequest, completeMcpRequest, getMcpServiceEpoch, getMcpStatus, getPendingMcpRequests, onMcpRequest, stopMcpService, type McpPanelJob, type McpRequest, type McpStatus } from './native-mcp.ts'
import type { ImportedProject, MediaAsset, Project, ProjectHistory, ProjectSummary } from './core/types.ts'
import { stampNewAssets } from './core/asset-times.ts'
import { cloneProject, createClip, createProject, createTrack, validateProject } from './core/project.ts'
import { withProjectFileTitle } from './core/project-title.ts'
import { adoptFirstVideoSize } from './core/project-size.ts'
import { addAssets, addClip, addTrack, commitHistory, createHistory, projectDuration, renderDuration, redoHistory, undoHistory } from './core/timeline.ts'
import { deleteProject, listProjects, loadProject, saveProject as storeProject } from './core/storage.ts'
import { createDraftSaveQueue, draftSaveErrorMessage } from './core/draft-save-queue.ts'
import { exportProjectFile, importProjectFile } from './core/project-file.ts'
import { pickBrowserProjectFile, prepareBrowserProjectSave, writeBrowserProjectFile, type BrowserProjectFileHandle } from './core/browser-project-files.ts'
import { loadProjectSaveTarget, storeProjectSaveTarget, type ProjectSaveTarget } from './core/project-save-targets.ts'
import { downloadBlob, importMediaFile } from './core/media-import.ts'
import { cancelMediaJob, cancelCapturePicker, captureScreenshot, configureScreenshotShortcut, onScreenshotRequested, pickCaptureSource, showMainWindow, closeNativeWindow, getMediaJobs, importBlobAsset, isDesktop, onNativeCloseRequest, openProjectArchive, pickMediaAssets, saveBytes, saveProjectArchive, type ProjectFileTarget, type MediaJob } from './native.ts'
import { materializeProjectAsset, prepareNativeProjectArchive, restoreNativeProjectArchive, restoreNativeProjectAsset } from './native-project-files.ts'
import { prepareProjectMedia, isProjectMediaPrepared, saveManagedProject, listManagedProjects, loadManagedProject, removeManagedProjectDraft } from './native-project-library.ts'
import { getDesktopPlatform, type DesktopPlatform } from './native-platform.ts'

type Workspace = 'home' | 'edit' | 'record' | 'gif' | 'image' | 'video' | 'generate' | 'image-generate' | 'song-generate'
const workspaces: { id: Workspace; title: string; icon: string; description: string; color: string }[] = [
  { id: 'record', title: '录屏', icon: 'record', description: '录制屏幕与声音，随时暂停和继续', color: '#e35764' },
  { id: 'gif', title: '片段转 GIF', icon: 'gif', description: '截取多个精彩片段，生成循环动图', color: '#9161d1' },
  { id: 'generate', title: '视频生成', icon: 'sparkles', description: '提示词、首尾帧与分镜，让灵感成为视频', color: '#8060d6' },
  { id: 'image-generate', title: '图像生成', icon: 'image', description: '从文字或图片出发，创作新的画面', color: '#b15aab' },
  { id: 'song-generate', title: '歌曲生成', icon: 'audio', description: '用风格与歌词创作歌曲，也能生成纯音乐', color: '#3c9e99' },
  { id: 'video', title: '视频转换', icon: 'convert', description: '转换视频格式、压缩体积与提取音频', color: '#dd9635' },
  { id: 'image', title: '图片编辑', icon: 'image', description: '插入文字与自定义笔触，裁剪并导出图片', color: '#2a9d80' },
  { id: 'edit', title: '工程剪辑', icon: 'scissors', description: '独立管理工程素材，多轨剪辑、字幕与配乐', color: '#2563eb' },
]
const native = isDesktop(), view = ref<Workspace>('home'), collapsed = ref(false), booting = ref(true), theme = ref<'light' | 'dark' | 'system'>('system'), systemDark = ref(false)
const generationVisited = ref(false), videoGenerating = ref(false)
const imageGenerationVisited = ref(false), songGenerationVisited = ref(false)
const infoOpen = ref(false), aiInitialProvider = ref<AiProvider>()
let releaseAiStatus: (() => void) | undefined
function openAiModels(provider?: AiProvider): void { aiInitialProvider.value=provider; infoOpen.value=true }
watch(view, value => { if (value === 'generate') generationVisited.value = true; if(value==='image-generate') imageGenerationVisited.value=true; if(value==='song-generate') songGenerationVisited.value=true })
const desktopPlatform = ref<DesktopPlatform | null>(null)
const sidebarControls = computed(() => desktopPlatform.value === 'windows' || desktopPlatform.value === 'macos')
const initial = createProject(), project = shallowRef(initial), history = shallowRef(createHistory(initial))
const projectRevision = ref(0)
watch(project, () => { projectRevision.value++ }, { flush: 'sync' })
const videoEditor = ref<InstanceType<typeof VideoEditor>>()
const mcpOpen = ref(false), mcpBusy = ref(false), mcpJobs = shallowRef<McpPanelJob[]>([]), mcpServiceRunning = ref(false), mcpConnected = ref(false)
const activeMcpJob = computed(() => mcpJobs.value.find(job => job.state === 'running') ?? mcpJobs.value[0])
const activeMcpProgress = computed(() => activeMcpJob.value ? mcpJobPercent(activeMcpJob.value) : undefined)
type McpToolActivity = { id: string; tool: string; label: string; state: 'running' | 'completed' | 'failed' }
const mcpToolActivity = shallowRef<McpToolActivity | null>(null)
const mcpToolLabels = new Map(mcpToolCatalog.map(tool => [tool.name, tool.description.split(/[。；，]/)[0] || tool.name]))
const mcpActivityTitle = computed(() => mcpBusy.value ? 'MCP 正在处理' : mcpToolActivity.value?.state === 'running' ? 'MCP 正在调用' : mcpToolActivity.value?.state === 'failed' ? 'MCP 调用失败' : mcpToolActivity.value ? 'MCP 调用完成' : '等待 MCP 操作')
const mcpDetailsOpen = ref(false)
const mcpCompactStatus = computed(() => mcpBusy.value && activeMcpJob.value ? `${activeMcpJob.value.name} · ${activeMcpJob.value.stage}` : mcpToolActivity.value?.label || (mcpConnected.value ? '客户端已连接' : ''))
const mcpBannerVisible = computed(() => !booting.value && (mcpBusy.value || !!mcpToolActivity.value || mcpServiceRunning.value && mcpConnected.value))
watch(mcpBannerVisible, visible => { if (!visible) mcpDetailsOpen.value = false })
let mcpActivityDeadlineTimer: ReturnType<typeof setTimeout> | undefined, mcpActivityFeedbackTimer: ReturnType<typeof setTimeout> | undefined
const mcpGlowActive = computed(() => native && !booting.value && mcpServiceRunning.value)
const mcpWorkHighlighted = computed(() => mcpGlowActive.value && mcpConnected.value && (mcpBusy.value || mcpToolActivity.value?.state === 'running'))
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
let draftCountdown: ReturnType<typeof setInterval> | undefined, projectGeneration = 0
let nativeProjectTarget: ProjectFileTarget | undefined, browserProjectTarget: BrowserProjectFileHandle | undefined
let saveTargetRestoreError = ''
const recent = ref<ProjectSummary[]>([]), status = ref('本地创作，自由表达'), busy = ref(''), error = ref(''), recording = ref(false), browserExporting = ref(false)
const exportOpen = ref(false), jobsOpen = ref(false), jobs = ref<MediaJob[]>([])
const mediaInput = ref<HTMLInputElement>(), projectInput = ref<HTMLInputElement>(), renameInput = ref<HTMLInputElement>(), renaming = ref(false), renameValue = ref(''), search = ref('')
const blobs = new Map<string, Blob>(), ownedUrls = new Set<string>(), hydratedReleases: { release: () => void; urls: Set<string> }[] = []
type MediaWorkspace = 'record' | 'gif' | 'image' | 'video'
const workspaceAssets = shallowRef<Record<MediaWorkspace, MediaAsset[]>>({ record: [], gif: [], image: [], video: [] })
const workspaceBlobs = new Map<string, Blob>(), workspaceUrls = new Set<string>()
const projectMediaBusy = ref(false), projectMenuOpen = ref(false), projectMenu = ref<HTMLElement>()
const projectMenuStyle = ref<Record<string, string>>({})
let importDestination: Workspace | undefined
const projectImportDisabled = computed(() => !!busy.value || switching.value || booting.value || projectMediaBusy.value || speechWorking.value || mcpBusy.value)
const recoveryRecordings = ref<{ id: string; name: string; blob: Blob }[]>([])
const switching = ref(false), pendingMedia = ref(0), imageConverting = ref(false), videoConverting = ref(false), gifConverting = ref(false), speechWorking = ref(false)
const screenshotPicker = ref<InstanceType<typeof ScreenshotPicker>>()
const screenshotShortcut = ref<string | null>(null), screenshotBusy = ref(false), screenshotConfiguring = ref(false), screenshotError = ref(''), screenshotAssetId = ref('')
const screenshotDisabled = computed(() => Boolean(busy.value || switching.value || booting.value || recording.value || projectMediaBusy.value || pendingMedia.value || browserExporting.value || imageConverting.value || videoConverting.value || gifConverting.value || speechWorking.value || mcpBusy.value))
let screenshotAbort: AbortController | undefined, screenshotRequestId: string | undefined, unlistenScreenshot: (() => void) | undefined, destroyed = false
let captureQueue = Promise.resolve()
let draftTimer: ReturnType<typeof setTimeout> | undefined, draftGeneration = 0, jobsTimer: ReturnType<typeof setTimeout> | undefined, mediaQuery: MediaQueryList | undefined, unlistenClose: (() => void) | undefined, allowClose = false
const effectiveTheme = computed(() => theme.value === 'system' ? systemDark.value ? 'dark' : 'light' : theme.value)
const nativeAppearance = createNativeAppearanceSync()
watch([effectiveTheme, theme], ([value, choice]) => { if (native) void nativeAppearance.sync(value, choice === 'system') })
const duration = computed(() => projectDuration(project.value)), workspaceTitle = computed(() => workspaces.find(item => item.id === view.value)?.title || '开始')
const visibleRecent = computed(() => recent.value.filter(item => item.title.toLowerCase().includes(search.value.toLowerCase())))
const runningJobs = computed(() => jobs.value.filter(job => job.state === 'running').length)
function contentKey(value: Project) {
  return JSON.stringify({ ...value, updatedAt: '', assets: value.assets.map(asset => ({ ...asset, url: '', nativePath: undefined, sourceUrl: undefined })) })
}
const cleanKey = ref(contentKey(initial)), dirty = computed(() => contentKey(project.value) !== cleanKey.value)
const draftLabel = computed(() => draftState.value === 'error' ? '草稿保存失败' : draftState.value === 'waiting' ? `${draftSeconds.value} 秒后保存草稿` : draftState.value === 'pending' ? '正在保存草稿…' : !autoSave.value ? '自动保存已关闭' : draftState.value === 'saved' ? '本地草稿已保存' : '自动保存已开启')
const autosaveProgress = computed(() => draftState.value === 'waiting' ? `${draftSeconds.value} 秒后保存` : draftState.value === 'pending' ? '保存中…' : '')
function savedTime(value: string) { return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }
const lastSaveTitle = computed(() => lastSaveAt.value ? `${lastSaveKind.value === 'file' ? '项目文件' : '本地草稿'}上次保存：${savedTime(lastSaveAt.value)}` : '')
function openVideoExport() { if (view.value === 'edit' && renderDuration(project.value) > 0 && !busy.value && !switching.value && !booting.value && !speechWorking.value && !projectMediaBusy.value && !mcpBusy.value) exportOpen.value = true }
function announce(message: string) { status.value = message }
function fail(cause: unknown) { error.value = cause instanceof Error ? cause.message : String(cause); status.value = error.value }
function notifyError(cause: unknown) { fail(cause); busy.value = '' }
function remember() { try { localStorage.setItem('open-media:last-project', project.value.id) } catch { /* Local draft failures are reported by the persistent store. */ } }
async function refreshRecent() {
  recent.value = (native ? await listManagedProjects() : await listProjects()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}
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
  const generation = projectGeneration, revision = projectRevision.value
  draftState.value = 'pending'; draftError.value = ''
  return draftSaves.save(`${generation}:${snapshot.id}`, revision, { snapshot, snapshotBlobs, key, generation, revision }).then(saved => {
    // Each caller settles its pending state, including callers sharing an active write.
    if (saved && !destroyed && projectGeneration === generation && project.value.id === snapshot.id && revision === projectRevision.value && draftState.value !== 'waiting' && contentKey(project.value) === key) draftState.value = 'saved'
    return saved
  })
}
const draftSaves = createDraftSaveQueue(async ({ snapshot, snapshotBlobs, key, generation, revision }: { snapshot: Project; snapshotBlobs: Map<string, Blob>; key: string; generation: number; revision: number }): Promise<boolean> => {
    try {
      const prepared = await prepareProjectMedia(snapshot, { blobs: snapshotBlobs })
      const savedAt = native ? (await saveManagedProject(prepared)).savedAt : await storeProject(prepared, snapshotBlobs)
      if (!destroyed && projectGeneration === generation && project.value.id === snapshot.id) {
        lastSaveAt.value = savedAt; lastSaveKind.value = 'draft'
        remember()
      }
      // A recent-project list read is independent of the successful draft write.
      void refreshRecent().catch(() => {})
      return true
    } catch (cause) {
      if (!destroyed && projectGeneration === generation && project.value.id === snapshot.id && revision === projectRevision.value && draftState.value !== 'waiting' && contentKey(project.value) === key) {
        draftState.value = 'error'; draftError.value = draftSaveErrorMessage(cause)
      }
      return false
    }
})
function commit(next: Project, label = '已修改项目', historyGroup?: string, remote = false): boolean {
  if (destroyed || mcpBusy.value && !remote) return false
  try {
    // Remote edits cannot change the user's per-project creation preferences.
    if (remote) next = { ...next, mcpMotion: project.value.mcpMotion ? structuredClone(project.value.mcpMotion) : undefined }
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
function moveHistory(direction: 'undo' | 'redo', remote = false) {
  if (switching.value || booting.value || projectMediaBusy.value || speechWorking.value || mcpBusy.value) return
  continuousEdit = undefined
  const moved = direction === 'undo' ? undoHistory(history.value) : redoHistory(history.value)
  history.value = remote ? { ...moved, present: { ...moved.present, mcpMotion: project.value.mcpMotion ? structuredClone(project.value.mcpMotion) : undefined } } : moved
  project.value = cloneProject(history.value.present); announce(direction === 'undo' ? '已撤销' : '已重做'); scheduleDraft()
}
function toggleAutosave() { if (switching.value || booting.value) return; autoSave.value = !autoSave.value; draftGeneration++; cancelDraftCountdown(); if (draftState.value === 'waiting') draftState.value = 'idle'; try { localStorage.setItem('open-media:autosave', String(autoSave.value)) } catch {} ; if (autoSave.value) void persist() }
function setTheme(value: 'light' | 'dark' | 'system') { theme.value = value; try { localStorage.setItem('open-media:theme', value) } catch {} }
function rememberAsset(asset: MediaAsset) { if (asset.url.startsWith('blob:')) ownedUrls.add(asset.url) }
function rememberEditorAsset(asset: MediaAsset, blob: Blob) { rememberAsset(asset); blobs.set(asset.id, blob) }
function projectGuard() {
  const id = project.value.id, revision = projectRevision.value, session = projectGeneration
  return () => { if (destroyed || project.value.id !== id || projectRevision.value !== revision || projectGeneration !== session) throw new Error('当前工程已变化，本次素材未加入，请重试。') }
}
async function commitEditorChange(next: Project, label?: string, historyGroup?: string): Promise<void> {
  if (projectMediaBusy.value) throw new Error('正在整理工程素材，请稍后重试。')
  if (isProjectMediaPrepared(next)) { if (!commit(next, label, historyGroup)) throw new Error('工程未接受本次修改。'); return }
  const assertCurrent = projectGuard()
  projectMediaBusy.value = true
  announce('正在保存工程素材…')
  try { const prepared = await prepareProjectMedia(next, { blobs, assertCurrent }); assertCurrent(); if (!commit(prepared, label, historyGroup)) throw new Error('工程未接受本次修改。') }
  finally { projectMediaBusy.value = false }
}
function registerWorkspaceAsset(destination: MediaWorkspace, asset: MediaAsset, blob?: Blob): void {
  const stored = { ...asset, addedAt: asset.addedAt || new Date().toISOString() }
  if (blob) workspaceBlobs.set(stored.id, blob)
  if (stored.url.startsWith('blob:')) workspaceUrls.add(stored.url)
  const destinations: MediaWorkspace[] = destination === 'record' ? ['record', 'gif', 'video'] : [destination]
  const next = { ...workspaceAssets.value }
  for (const key of destinations) next[key] = [...next[key].filter(item => item.id !== stored.id && (!stored.nativePath || item.nativePath !== stored.nativePath)), stored]
  workspaceAssets.value = next
}
async function acceptAssets(assets: MediaAsset[], assetBlobs?: Map<string, Blob>) {
  if (!assets.length) return
  const assertCurrent = projectGuard()
  const prepared = await prepareProjectMedia(adoptFirstVideoSize(addAssets(project.value, assets), assets), { blobs: new Map([...blobs, ...(assetBlobs ?? [])]), assertCurrent })
  assertCurrent()
  if (!commit(prepared, `已加入 ${assets.length} 个工程素材`)) throw new Error('工程未接受素材，请稍后重试。')
  for (const asset of prepared.assets) { rememberAsset(asset); if (assetBlobs?.has(asset.id)) blobs.set(asset.id, assetBlobs.get(asset.id)!) }
}
function acceptAsset(asset: MediaAsset) { registerWorkspaceAsset('record', asset); announce('录制已保存，可在列表中右键加入工程素材。') }
async function acceptGeneratedAsset(asset: MediaAsset, timeline = false): Promise<void> {
  if (destroyed || projectImportDisabled.value) { fail('请等待当前工程操作结束后，再加入素材。'); return }
  projectMediaBusy.value = true
  announce('正在将素材加入当前工程…')
  let projectUrl: string | undefined
  try {
    const existing = project.value.assets.find(item => item.id === asset.id)
    if (!existing) {
      const blob = workspaceBlobs.get(asset.id)
      const copy = { ...asset }
      if (!native && (blob || copy.url.startsWith('blob:'))) {
        const content = blob ?? await (await fetch(copy.sourceUrl || copy.url)).blob()
        projectUrl = URL.createObjectURL(content); copy.url = projectUrl; delete copy.sourceUrl
        await acceptAssets([copy], new Map([[copy.id, content]]))
      } else await acceptAssets([copy], blob ? new Map([[copy.id, blob]]) : undefined)
    }
    if (timeline) addToTimeline(asset.id)
    else announce('素材已加入当前工程。')
  } catch (cause) { if (projectUrl && !ownedUrls.has(projectUrl)) URL.revokeObjectURL(projectUrl); fail(cause) }
  finally { projectMediaBusy.value = false }
}
function editGeneratedImage(asset: MediaAsset): void {
  registerWorkspaceAsset('image', asset)
  screenshotAssetId.value=asset.id; view.value='image'
}
async function importFiles(files?: File[], destination: Workspace = view.value) {
  if (projectImportDisabled.value) return false
  const target: MediaWorkspace | 'edit' = ['record','gif','image','video'].includes(destination) ? destination as MediaWorkspace : 'edit'
  const accept = async (assets: MediaAsset[], imported?: Map<string, Blob>) => {
    if (target === 'edit') await acceptAssets(assets, imported)
    else { for (const asset of assets) registerWorkspaceAsset(target, asset, imported?.get(asset.id)); announce(`已载入 ${assets.length} 个素材。`) }
  }
  if (!files?.length) {
    if (!native) { importDestination = destination; mediaInput.value?.click(); return }
    busy.value = '正在导入素材…'
    try { await accept(await pickMediaAssets()) } catch (cause) { fail(cause) } finally { busy.value = '' }
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
  try { await accept(assets, imported); if (failures.length) fail(failures.join('\n')); return failures.length === 0 && assets.length > 0 } catch (cause) { fail(cause); return false } finally { busy.value = '' }
}
function waitForIdle(): Promise<void> {
  if (!busy.value && !switching.value && !mcpBusy.value) return Promise.resolve()
  return new Promise(resolve => { const stop = watch([busy, switching, mcpBusy], ([working, changing, automated]) => { if (!working && !changing && !automated) { stop(); resolve() } }) })
}
function captured(blob: Blob, name: string): Promise<void> {
  pendingMedia.value++
  announce('录制完成，正在载入录屏列表。')
  const task = captureQueue.catch(() => {}).then(async () => {
    await waitForIdle()
    const asset = await importMediaFile(new File([blob], name, { type: blob.type }))
    registerWorkspaceAsset('record', asset, blob)
    announce('录制已载入列表，可右键加入工程素材。')
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
  const abort = new AbortController()
  screenshotAbort = abort
  announce('请选择截屏范围，按 Esc 取消。')
  let clipboardResult: Promise<{ copied: true } | { copied: false; cause: unknown }> | undefined
  let capturedImageUrl: string | undefined
  const startClipboardCopy = (content: string | Blob | Promise<Blob>) => copyImageToClipboard(content, native, abort.signal).then(
    () => ({ copied: true as const }),
    (cause: unknown) => ({ copied: false as const, cause }),
  )
  try {
    let asset: MediaAsset
    let blob: Blob | undefined
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
      capturedImageUrl = asset.url
    } else {
      if (!screenshotPicker.value) throw new Error('截屏界面尚未就绪，请重试。')
      const result = await screenshotPicker.value.capture(abort.signal, content => { clipboardResult = startClipboardCopy(content) })
      blob = result.blob
      asset = await importMediaFile(new File([blob], result.name, { type: 'image/png' }))
    }
    if (destroyed) { if (asset.url.startsWith('blob:')) URL.revokeObjectURL(asset.url); return }
    registerWorkspaceAsset('image', asset, blob)
    screenshotAssetId.value = asset.id
    view.value = 'image'
    await nextTick()
    if (native) {
      await showMainWindow()
      clipboardResult = startClipboardCopy(asset.url)
    }
    const copied = await (clipboardResult ?? startClipboardCopy(blob ?? asset.url))
    if (!destroyed && !abort.signal.aborted) {
      if (copied.copied) announce('截屏已复制到剪贴板，并载入图片编辑。')
      else if (!(copied.cause instanceof DOMException && copied.cause.name === 'AbortError')) announce(`截屏已载入图片编辑，自动复制未完成。${imageClipboardError(copied.cause)}`)
    }
  } catch (cause) {
    const message = screenshotErrorMessage(cause)
    if (native && !destroyed) await showMainWindow().catch(() => {})
    if (!destroyed && !abort.signal.aborted && capturedImageUrl && !clipboardResult) clipboardResult = startClipboardCopy(capturedImageUrl)
    const copied = await clipboardResult
    if (!destroyed) {
      if (message) {
        screenshotError.value = copied?.copied ? `截屏已复制到剪贴板，但加入图片编辑失败：${message}` : message
        fail(screenshotError.value)
      } else announce('已取消截屏。')
    }
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
    const destination = asset.kind === 'image' ? 'image' : 'video'
    if (native) { const imported = await importBlobAsset(new Uint8Array(await blob.arrayBuffer()), asset.name); registerWorkspaceAsset(destination, imported) }
    else registerWorkspaceAsset(destination, asset, blob)
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
  while (dirty.value || autoSave.value && ['waiting', 'pending', 'error'].includes(draftState.value)) {
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
  next = await prepareProjectMedia(next, { blobs })
  if (native && !restored) await saveManagedProject(next)
  projectMenuOpen.value = false
  renaming.value = false; renameValue.value = ''
  continuousEdit = undefined
  projectGeneration++; draftGeneration++; cancelDraftCountdown()
  lastSaveAt.value = savedAt || ''; lastSaveKind.value = 'draft'
  applyProjectSaveTarget()
  let restoredTarget: ProjectSaveTarget | undefined, targetError = ''
  if (restored) {
    try {
      restoredTarget = await loadProjectSaveTarget(next.id)
      if (restoredTarget && (restoredTarget.kind === 'native') !== native) throw new Error('保存位置属于另一运行环境。')
      next = withProjectFileTitle(next, restoredTarget?.kind === 'native' ? restoredTarget.target.name : restoredTarget?.handle.name)
    } catch (cause) {
      targetError = `无法恢复项目保存位置，请重新打开本地项目后重试，或使用“另存为”选择位置。${cause instanceof Error ? cause.message : ''}`
    }
  }
  releaseUnusedMedia(next)
  if (native) for (const asset of next.assets) { if (asset.nativePath) blobs.delete(asset.id); rememberAsset(asset) }
  project.value = next; history.value = createHistory(next); cleanKey.value = contentKey(next); draftState.value = restored ? 'saved' : 'idle'; lastSaved.value = ''; remember()
  view.value = 'edit'; screenshotAssetId.value = ''; error.value = ''; if (!restored) scheduleDraft()
  if (restored) {
    if (targetError) { saveTargetRestoreError = targetError; fail(targetError) }
    else applyProjectSaveTarget(restoredTarget)
  }
}
function localMediaIsWorking(): boolean { return projectMediaBusy.value || screenshotBusy.value || recording.value || pendingMedia.value > 0 || browserExporting.value || runningJobs.value > 0 || imageConverting.value || videoConverting.value || gifConverting.value || speechWorking.value }
function mediaIsWorking(): boolean { return localMediaIsWorking() || mcpBusy.value }
async function changeProject(action: () => Promise<void>): Promise<void> {
  if (busy.value || switching.value || booting.value) return
  if (mediaIsWorking()) { fail('请先完成或取消录制、配音、转换、导出及 MCP 任务，再切换项目。'); return }
  finishRename()
  switching.value = true
  try {
    if (await protectProject()) {
      draftGeneration++; cancelDraftCountdown()
      await draftSaves.flush()
      await action()
    }
  } catch (cause) { fail(cause) } finally { switching.value = false }
}
async function newProject() { await changeProject(async () => { await adoptProject(createProject()); await refreshRecent(); announce('已新建工程。') }) }
function retainImportedMedia(imported: ImportedProject, next: Project) {
  const nativeIds = new Set(next.assets.filter(asset => asset.nativePath).map(asset => asset.id))
  for (const [id, blob] of imported.blobs) { if (native && nativeIds.has(id)) blobs.delete(id); else blobs.set(id, blob) }
  const retainedUrls = new Set(next.assets.flatMap(asset => [asset.url, asset.sourceUrl].filter((url): url is string => !!url)))
  const importedUrls = new Set(imported.project.assets.map(asset => asset.url))
  if ([...importedUrls].some(url => retainedUrls.has(url))) hydratedReleases.push({ release: imported.revoke, urls: importedUrls })
  else imported.revoke()
  next.assets.forEach(rememberAsset)
}
async function hydrate(imported: ImportedProject, deferred = false) {
  const next = cloneProject(imported.project)
  if (native) for (let index = 0; index < next.assets.length; index++) {
    const asset = next.assets[index]!
    if (!asset.nativePath) next.assets[index] = await restoreNativeProjectAsset(await materializeProjectAsset(next.id, asset, { blobs: imported.blobs }))
  }
  const checked = validateProject(await prepareProjectMedia(next, { blobs: imported.blobs }), { trusted: true })
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
      const selected = file || await openProjectArchive()
      if (!selected) return
      const imported = selected instanceof File ? await importProjectFile(selected) : undefined
      try {
        const next = imported ? await hydrate(imported) : await restoreNativeProjectArchive(withProjectFileTitle((selected as Exclude<typeof selected, File>).project, selected.name))
        await adoptProject(withProjectFileTitle(next, selected.name))
        const target: ProjectSaveTarget | undefined = !(selected instanceof File)
          ? { kind: 'native', target: { name: selected.name, path: selected.path, token: selected.token } }
          : browserSelection ? { kind: 'browser', handle: browserSelection.handle } : undefined
        const warning = await rememberProjectSaveTarget(project.value.id, target)
        cleanKey.value = contentKey(project.value); announce(warning || '项目与素材已打开。')
        if (warning) error.value = warning
      } catch (cause) { imported?.revoke(); throw cause }
    } finally { busy.value = '' }
  })
}
async function openRecent(id: string) {
  projectMenuOpen.value = false
  if (id === project.value.id && view.value === 'edit') return
  await changeProject(async () => {
    busy.value = '正在恢复本地草稿…'
    try { await restoreRecent(id); if (!saveTargetRestoreError) announce('已恢复本地工程。') } finally { busy.value = '' }
  })
}
async function restoreRecent(id: string): Promise<void> {
  if (native) {
    let savedAt = ''
    const stored = await loadManagedProject(id, { onSavedAt: value => { savedAt = value } })
    await adoptProject(stored, true, savedAt || stored.updatedAt)
    return
  }
  const imported = await loadProject(id)
  try { await adoptProject(await hydrate(imported), true, imported.savedAt) }
  catch (cause) { imported.revoke(); throw cause }
}
async function toggleProjectMenu(): Promise<void> {
  if (projectImportDisabled.value || mediaIsWorking()) return
  projectMenuOpen.value = !projectMenuOpen.value
  if (projectMenuOpen.value) {
    const bounds = projectMenu.value?.getBoundingClientRect()
    const width = Math.min(340, window.innerWidth - 16), top = Math.min((bounds?.bottom ?? 40) + 8, window.innerHeight - 80)
    projectMenuStyle.value = { left: `${Math.max(8, Math.min(bounds?.left ?? 8, window.innerWidth - width - 8))}px`, top: `${top}px`, width: `${width}px`, maxHeight: `${Math.max(60, Math.min(360, window.innerHeight - top - 12))}px` }
    try { await refreshRecent(); await nextTick(); projectMenu.value?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus() }
    catch (cause) { fail(cause) }
  }
}
function closeProjectMenuOutside(event: PointerEvent): void {
  if (projectMenuOpen.value && !projectMenu.value?.contains(event.target as Node)) projectMenuOpen.value = false
}
function closeProjectMenuOnResize(): void { projectMenuOpen.value = false }
function projectMenuKeys(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); projectMenuOpen.value = false; projectMenu.value?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [...(projectMenu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
  if (!items.length) return
  event.preventDefault()
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus()
}
async function removeRecent(item: ProjectSummary) {
  if (mcpBusy.value) return
  const choice = await ask({ title: '移除本地草稿', text: `移除“${item.title}”的本地草稿？已经导出的项目文件仍可打开。`, choices: [{ id: 'cancel', label: '取消' }, { id: 'remove', label: '移除草稿', primary: true }] })
  if (choice !== 'remove') return
  try { if (item.id === project.value.id) { draftGeneration++; cancelDraftCountdown() }; await draftSaves.flush(); if (native) await removeManagedProjectDraft(item.id); else await deleteProject(item.id); await refreshRecent(); if (item.id === project.value.id) { draftState.value = 'idle'; if (lastSaveKind.value === 'draft') lastSaveAt.value = '' } } catch (cause) { fail(cause) }
}
async function save(saveAs = false, closing = false): Promise<boolean> {
  if (busy.value || switching.value && !closing || booting.value || projectMediaBusy.value || speechWorking.value || mcpBusy.value) return false
  if (!saveAs && saveTargetRestoreError) { fail(saveTargetRestoreError); return false }
  finishRename()
  busy.value = '正在打包项目与素材…'; error.value = ''
  const snapshot = cloneProject(project.value), key = contentKey(snapshot)
  try {
    const name = `${snapshot.title.replace(/[\\/:*?"<>|]/g, '-') || '媒体项目'}.omedia`
    const browserTarget = native ? undefined : await prepareBrowserProjectSave(name, saveAs ? undefined : browserProjectTarget)
    if (browserTarget === null) return false
    let downloaded = false, targetWarning = ''
    if (native) {
      const prepared = await prepareNativeProjectArchive(snapshot, { blobs, onProgress: (done, total) => { busy.value = `正在准备项目素材 ${Math.round(done / Math.max(1, total) * 100)}%` } })
      busy.value = '正在保存项目与素材…'
      const target = await saveProjectArchive(name, prepared, saveAs ? undefined : nativeProjectTarget?.token)
      if (!target) return false
      targetWarning = await rememberProjectSaveTarget(snapshot.id, { kind: 'native', target })
    } else {
      const blob = await exportProjectFile(snapshot, { blobs, onProgress: (done, total) => { busy.value = `正在打包项目 ${Math.round(done / Math.max(1, total) * 100)}%` } })
      if (browserTarget) {
        await writeBrowserProjectFile(browserTarget, blob)
        targetWarning = await rememberProjectSaveTarget(snapshot.id, { kind: 'browser', handle: browserTarget })
      } else { downloadBlob(blob, name); lastSaved.value = name; downloaded = true }
    }
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
async function rename() { if (mcpBusy.value || projectMediaBusy.value) return; renameValue.value = project.value.title; renaming.value = true; await nextTick(); renameInput.value?.focus(); renameInput.value?.select() }
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
  if (projectMediaBusy.value) { fail('请等待工程素材保存完成，再关闭应用。'); return }
  if (mcpBusy.value) { openJobs(); fail('请在处理任务中完成或取消 MCP 任务，再关闭应用。'); return }
  if (screenshotBusy.value) { fail('请先完成或取消截屏，再关闭应用。'); return }
  if (aiState.value.busy) { openAiModels(); fail('请在 Info 的模型任务中完成或取消任务，再关闭应用。'); return }
  if (videoGenerating.value) { view.value = 'generate'; fail('请先完成或取消视频生成及模型下载，再关闭应用。'); return }
  if (speechWorking.value) { view.value = 'edit'; fail('请先结束录音或完成、取消文字配音，再关闭应用。'); return }
  if (recording.value || recoveryRecordings.value.length) { view.value = 'record'; fail('请先结束录制，录制完成后再关闭应用。'); return }
  if (browserExporting.value || runningJobs.value) { if (native) openJobs(); fail('请等待导出完成，或先取消正在处理的任务。'); return }
  if (pendingMedia.value || imageConverting.value || videoConverting.value || gifConverting.value) { fail('请先完成或取消素材导入及媒体转换，再关闭应用。'); return }
  switching.value = true
  try {
    const aiStatus = await getAiStatus(false)
    if (aiStatus.busy || aiStatus.jobs.some(job => job.state === 'running') || aiStatus.models.some(model => model.state === 'downloading' || model.state === 'verifying')) {
      openAiModels(); switching.value = false; fail('请在 Info 的模型任务中完成或取消任务，再关闭应用。'); return
    }
  } catch (cause) {
    switching.value = false; fail(`无法检查 AI 模型任务，请稍后重试关闭：${cause instanceof Error ? cause.message : String(cause)}`); return
  }
  const suspendedDialogs = [...document.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"][aria-modal="true"]')].map(element => ({ element, inert: element.inert }))
  try {
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.matches('input,textarea,[contenteditable="true"]')) focused.blur()
    finishRename()
    for (const { element } of suspendedDialogs) element.inert = true
    await nextTick()
    // Undo can match the saved file while an older draft write is still in flight.
    if (!dirty.value && autoSave.value && ['waiting', 'pending', 'error'].includes(draftState.value) && !await persist()) { fail(draftError.value); return }
    draftGeneration++; cancelDraftCountdown()
    await draftSaves.flush()
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
    window.dispatchEvent(new Event('open-media:save-generation-drafts'))
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
  if (switching.value || booting.value || projectMediaBusy.value || speechWorking.value || mcpBusy.value) { if (event.ctrlKey || event.metaKey) event.preventDefault(); return }
  if (!native && matchesScreenshotShortcut(event, screenshotShortcut.value)) { event.preventDefault(); void takeScreenshot(); return }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 's') { event.preventDefault(); void save(event.shiftKey) }
  if (key === 'o') { event.preventDefault(); void openProject() }
  if ((event.target as HTMLElement)?.closest('input,textarea,[contenteditable]')) return
  if (key === 'z') { event.preventDefault(); moveHistory(event.shiftKey ? 'redo' : 'undo') }
  if (key === 'y') { event.preventDefault(); moveHistory('redo') }
}
function unload(event: BeforeUnloadEvent) { if (!allowClose && (mediaIsWorking() || videoGenerating.value || aiState.value.busy || recoveryRecordings.value.length || busy.value || switching.value || dirty.value && (draftState.value !== 'saved' || !autoSave.value))) { event.preventDefault(); event.returnValue = '' } }
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
let guiToolActive = false
const runEditorTool: EditorToolRunner = async (name, args, options) => {
  if (destroyed || allowClose || guiToolActive || projectMediaBusy.value || mcpBusy.value || busy.value || switching.value || browserExporting.value) throw new Error('当前项目正在处理其他操作，请稍后重试。')
  const source = cloneProject(project.value), revision = projectRevision.value
  const assertCurrent = () => { options.signal.throwIfAborted(); if (destroyed || allowClose || project.value.id !== source.id || projectRevision.value !== revision) throw new Error('工程已变化，请重试。') }
  guiToolActive = true
  videoEditor.value?.pause()
  try {
    const prepared = await prepareEditorTool(name, args, { ...options, project: source, revision, blobs: new Map(blobs), source: 'gui', assertCurrent: () => { options.signal.throwIfAborted(); if (destroyed || allowClose || project.value.id !== source.id || projectRevision.value !== revision) throw new Error('项目已变化，请重试。') }, hydrate: async imported => { const result = await hydrate(imported, true); pendingHydration.delete(result); return result } })
    let committed = false
    try {
      if (!prepared.irreversible) {
        options.signal.throwIfAborted()
        if (destroyed || allowClose || project.value.id !== source.id || projectRevision.value !== revision) throw new Error('项目已变化，本次操作未写入，请重试。')
      }
      if (prepared.project) {
        options.onProgress({ stage: '正在保存工程素材', progress: 1, cancelable: !prepared.irreversible })
        const preparedBlobs = new Map(blobs)
        for (const entry of prepared.assets ?? []) if (entry.blob) preparedBlobs.set(entry.asset.id, entry.blob)
        prepared.project = await prepareProjectMedia(prepared.project, { blobs: preparedBlobs, signal: options.signal, assertCurrent })
        assertCurrent()
        options.onProgress({ stage: '正在保存处理结果', progress: 1, cancelable: false })
        if (!commit(prepared.project, prepared.label || '更新项目')) throw new Error('项目拒绝了本次修改。')
        committed = true
      }
      if (prepared.accept) { options.onProgress({ stage: '正在保存处理结果', progress: 1, cancelable: false }); committed = true }
      try { prepared.assets?.forEach(({ asset, blob }) => { const stored = prepared.project?.assets.find(item => item.id === asset.id) ?? asset; rememberAsset(stored); if (blob) blobs.set(stored.id, blob) }) }
      finally { await prepared.accept?.() }
      if (prepared.selection?.clipId) {
        await nextTick()
        // The local task lock is released before the editor can accept selection.
        const clipId = prepared.selection.clipId
        setTimeout(() => { void videoEditor.value?.setPlayback({ selectedClipId: clipId }).catch(() => {}) }, 0)
      }
      return prepared.data
    } catch (cause) { if (!committed && !prepared.irreversible) await prepared.discard?.(); throw cause }
  } finally { guiToolActive = false }
}
const mcpAutomation = createMcpAutomation({
  getProject: () => project.value,
  getRevision: () => projectRevision.value,
  getProjectSession: () => projectGeneration,
  isBusy: mcpLocalInteractionBusy,
  getBlockingOperation: () => ({ jobId: null, kind: guiToolActive ? 'gui-tool' : busy.value || localMediaIsWorking() ? 'local-media' : 'local-interaction',
    name: guiToolActive ? '本地编辑工具' : busy.value || localMediaIsWorking() ? '本地媒体处理' : '本地界面交互', state: 'running', cancelable: false, poll: null, cancel: null, source: 'local' }),
  getBlobs: () => new Map(blobs),
  prepareProject: (next, options) => prepareProjectMedia(next, options),
  getSaveTarget: () => {
    if (saveTargetRestoreError) throw new Error(saveTargetRestoreError)
    return nativeProjectTarget ? { ...nativeProjectTarget } : undefined
  },
  commit: (next, label, expected) => {
    if (destroyed || allowClose || project.value.id !== expected.projectId || projectRevision.value !== expected.revision || projectGeneration !== expected.projectSession) return false
    videoEditor.value?.pause()
    return commit(next, label, undefined, true)
  },
  hydrate: imported => hydrate(imported, true),
  didSave: async (snapshot, target, expected) => {
    const current = () => !destroyed && project.value.id === expected.projectId && projectGeneration === expected.projectSession
    if (!current()) return
    const savedAt = new Date().toISOString()
    const warning = await rememberProjectSaveTarget(snapshot.id, { kind: 'native', target })
    if (!current()) return
    cleanKey.value = contentKey(snapshot)
    await persist()
    if (current()) { lastSaveAt.value = savedAt; lastSaveKind.value = 'file'; if (warning) error.value = warning }
  },
  history: direction => { videoEditor.value?.pause(); moveHistory(direction, true) },
  getPlayback: () => videoEditor.value?.getPlayback() ?? { time: 0, playing: false, selectedClipId: '' },
  setPlayback: async (patch: Partial<McpPlayback>) => {
    if (destroyed || allowClose) throw new Error('应用正在关闭。')
    const epoch = getMcpServiceEpoch(), projectId = project.value.id, session = projectGeneration, version = ++mcpPlaybackVersion
    const deadline = mcpRequestDeadline ?? Date.now() + 30_000
    const current = () => !destroyed && !allowClose && version === mcpPlaybackVersion && epoch === getMcpServiceEpoch() && project.value.id === projectId && projectGeneration === session && Date.now() < deadline
    pendingMcpPlayback = { version, pause: () => videoEditor.value?.pause() }
    const timeout = setTimeout(() => { if (pendingMcpPlayback?.version === version) cancelMcpPlayback() }, Math.max(0, deadline - Date.now()))
    try {
      if (view.value !== 'edit') view.value = 'edit'
      // Newly created clips must reach the editor props before selection is validated.
      await nextTick()
      if (!current()) throw new Error('MCP 播放请求已停止或过期。')
      const editor = videoEditor.value
      if (!editor) throw new Error('工程剪辑界面尚未就绪。')
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
  onJobsChanged: () => { if (!destroyed) mcpJobs.value = mcpAutomation.summaries() },
  announce: message => { if (!destroyed) announce(message) },
})
function openJobs(): void {
  mcpDetailsOpen.value = false; mcpOpen.value = false; jobsOpen.value = true
  // The closing native dialog restores its opener on the next tick before focus moves here.
  void nextTick(async () => { await nextTick(); if (jobsOpen.value) document.querySelector<HTMLButtonElement>('.jobs-dialog button')?.focus() })
}
function openMcp(): void { jobsOpen.value = false; mcpOpen.value = true; if (mcpBridgeError) fail(mcpBridgeError) }
function updateMcpMotion(config: NonNullable<Project['mcpMotion']>): void {
  if (!mcpServiceRunning.value || destroyed || allowClose || booting.value || switching.value || mcpBusy.value || busy.value || guiToolActive || browserExporting.value || speechWorking.value) return
  const next = cloneProject(project.value)
  next.mcpMotion = structuredClone(config)
  commit(next, '已更新 MCP 素材二创配置', 'mcp-motion-settings')
}
function mcpJobState(job: McpPanelJob): string { return job.cancelling ? '正在取消' : ({ running: '正在处理', completed: '已完成', failed: '失败', cancelled: '已取消' }[job.state]) }
function mcpJobPercent(job: McpPanelJob): number | undefined { return typeof job.progress === 'number' && Number.isFinite(job.progress) ? Math.round(Math.max(0, Math.min(1, job.progress)) * 100) : undefined }
function mcpJobMetrics(job: McpPanelJob): string {
  return [job.encodedFrames !== undefined ? `已处理 ${job.encodedFrames} 帧` : '', job.outputTime !== undefined ? `输出 ${job.outputTime.toFixed(1)} 秒` : '', job.elapsedSeconds !== undefined ? `已用 ${job.elapsedSeconds.toFixed(1)} 秒` : ''].filter(Boolean).join(' · ')
}
async function cancelMcpJob(id: string): Promise<void> {
  try { await mcpAutomation.cancel(id); mcpJobs.value = mcpAutomation.summaries() } catch (cause) { fail(cause) }
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
  const epoch = getMcpServiceEpoch(), projectId = project.value.id, session = projectGeneration
  const current = () => !destroyed && !allowClose && epoch === getMcpServiceEpoch() && Date.now() < request.deadlineAt
  const checkProject = () => {
    if (projectGeneration !== session || project.value.id !== projectId) {
      throw Object.assign(new Error('当前工程已切换或重新打开，此请求已失效。请重新读取当前工程后再操作。'), { code: 'PROJECT_CHANGED' })
    }
  }
  const run = async () => {
    if (!current()) return
    const claimed = await claimMcpRequest(request.id)
    // Claim crosses native IPC. Stop, navigation and expiry must be checked again after it.
    if (!claimed || !current()) return
    mcpRequestDeadline = request.deadlineAt
    beginMcpToolActivity(request)
    let failed = false
    try {
      checkProject()
      const result = await mcpAutomation.execute(request.tool, request.arguments)
      checkProject()
      if (current()) await completeMcpRequest(request.id, result)
    } catch (cause) {
      failed = true
      if (current()) await completeMcpRequest(request.id, serializeMcpError(cause), true)
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
  if (native) void getDesktopPlatform().then(value => { if (!destroyed) desktopPlatform.value = value })
  mediaQuery = matchMedia('(prefers-color-scheme: dark)'); systemDark.value = mediaQuery.matches; mediaQuery.addEventListener('change', mediaChanged)
  window.addEventListener('keydown', keyboard); window.addEventListener('beforeunload', unload); window.addEventListener('pointerdown', closeProjectMenuOutside); window.addEventListener('resize', closeProjectMenuOnResize)
  try { autoSave.value = localStorage.getItem('open-media:autosave') !== 'false'; const value = localStorage.getItem('open-media:theme'); if (value === 'light' || value === 'dark' || value === 'system') theme.value = value } catch {}
  if (native) void nativeAppearance.sync(effectiveTheme.value, theme.value === 'system')
  try { await refreshRecent(); const last = localStorage.getItem('open-media:last-project'); if (last && recent.value.some(item => item.id === last)) { await restoreRecent(last); view.value = 'home' } } catch (cause) { fail(cause) }
  booting.value = false
  void initializeScreenshot()
  if (native) {
    releaseAiStatus = observeAi()
    void initializeMcp()
    void pollJobs()
    try { unlistenClose = await onNativeCloseRequest(() => { if (!allowClose) void nativeClose() }) } catch (cause) { fail(cause) }
  }
})
onBeforeUnmount(() => { destroyed = true; releaseAiStatus?.(); nativeAppearance.dispose(); clearMcpToolActivity(); cancelMcpPlayback(); unlistenMcp?.(); void mcpAutomation.dispose().catch(() => {}); if (native) void stopMcpService().catch(() => {}); screenshotAbort?.abort(); if (screenshotRequestId) void cancelCapturePicker(screenshotRequestId).catch(() => {}); unlistenScreenshot?.(); if (native) void configureScreenshotShortcut(null).catch(() => {}); draftGeneration++; cancelDraftCountdown(); clearTimeout(jobsTimer); unlistenClose?.(); mediaQuery?.removeEventListener('change', mediaChanged); window.removeEventListener('keydown', keyboard); window.removeEventListener('beforeunload', unload); window.removeEventListener('pointerdown', closeProjectMenuOutside); window.removeEventListener('resize', closeProjectMenuOnResize); for (const url of workspaceUrls) URL.revokeObjectURL(url); for (const entry of hydratedReleases) entry.release(); for (const url of ownedUrls) URL.revokeObjectURL(url) })
</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-appearance': sidebarControls }" :data-theme="effectiveTheme" :data-platform="desktopPlatform" @dragover.prevent @drop="dropped">
    <header v-if="!sidebarControls" class="topbar">
      <button class="brand" :disabled="speechWorking || projectMediaBusy || mcpBusy" title="开始" @click="view='home'"><img src="/brand-mark.png" width="29" height="29" alt=""/><strong>Open Media</strong></button>
      <div class="topbar-end"><HeaderControls :theme="theme" :effective-theme="effectiveTheme" @update:theme="setTheme" :info-open="infoOpen" @open-info="openAiModels()"/></div>
    </header>
    <section v-if="mcpBannerVisible" class="mcp-processing-banner" :class="{ connected: mcpConnected && mcpGlowActive, working: mcpWorkHighlighted }" data-testid="mcp-processing-banner" :data-theme="effectiveTheme === 'dark' ? 'light' : 'dark'" aria-label="MCP 处理状态" :data-call-state="mcpToolActivity?.state || (mcpBusy ? 'running' : 'idle')" :data-call-tool="mcpToolActivity?.tool" @keydown.esc.stop="mcpDetailsOpen=false">
      <McpStatusGlow v-if="mcpConnected && mcpGlowActive" :active="true" :working="mcpWorkHighlighted"/>
      <span v-if="mcpBusy || mcpToolActivity?.state==='running'" class="spinner small" aria-hidden="true"/><Icon v-else class="mcp-status-icon" :name="mcpToolActivity?.state==='failed' ? 'alert' : mcpToolActivity ? 'check' : 'mcp'" :size="16"/>
      <div class="mcp-processing-copy" role="status" aria-live="polite" :title="`${mcpActivityTitle} · ${mcpCompactStatus}`"><strong>{{ mcpActivityTitle }}</strong><span>{{ mcpCompactStatus }}</span></div>
      <span v-if="mcpBusy && activeMcpProgress!==undefined" class="mcp-processing-percent">{{ activeMcpProgress }}%</span>
      <div class="mcp-processing-actions">
        <button class="mcp-processing-detail-button" data-testid="mcp-processing-details" title="查看 MCP 状态详情" aria-label="查看 MCP 状态详情" :aria-expanded="mcpDetailsOpen" aria-controls="mcp-processing-details" @click="mcpDetailsOpen=!mcpDetailsOpen"><Icon name="info" :size="15"/></button>
        <button v-if="mcpBusy" data-testid="mcp-processing-tasks" title="查看任务" aria-label="查看任务" @click="openJobs"><Icon name="layers" :size="14"/><span class="mcp-action-label">查看任务</span></button>
        <button v-if="mcpBusy && activeMcpJob?.state==='running' && activeMcpJob.cancelable!==false" data-testid="mcp-processing-cancel" :disabled="activeMcpJob.cancelling" :title="activeMcpJob.cancelling ? '正在取消任务' : '取消任务'" :aria-label="activeMcpJob.cancelling ? '正在取消任务' : '取消任务'" @click="cancelMcpJob(activeMcpJob.id)"><Icon name="close" :size="14"/><span class="mcp-action-label">{{ activeMcpJob.cancelling ? '正在取消…' : '取消任务' }}</span></button>
      </div>
      <div v-if="mcpBusy && activeMcpProgress!==undefined" class="mcp-processing-progress" role="progressbar" aria-label="MCP 任务进度" :aria-valuenow="activeMcpProgress" aria-valuemin="0" aria-valuemax="100"><i :style="{width:`${activeMcpProgress}%`}"/></div>
      <div v-if="mcpDetailsOpen" id="mcp-processing-details" class="mcp-processing-details" data-testid="mcp-processing-detail-panel">
        <strong>{{ mcpActivityTitle }}</strong><p>{{ mcpCompactStatus }}</p>
        <p v-if="mcpBusy && activeMcpJob && mcpJobMetrics(activeMcpJob)">{{ mcpJobMetrics(activeMcpJob) }}</p>
        <p v-if="mcpBusy">编辑暂时锁定，完成后自动恢复。可查看任务进度或取消尚未提交的任务。</p>
        <p v-if="mcpToolActivity" :title="mcpToolActivity.tool">{{ mcpToolActivity.state==='running' ? '正在调用' : mcpToolActivity.state==='failed' ? '调用失败' : '最近调用已完成' }}：{{ mcpToolActivity.label }}</p>
      </div>
    </section>
    <div class="workbench-body" :inert="switching || booting">
      <aside class="sidebar" :class="{collapsed, 'with-controls': sidebarControls}">
        <div class="sidebar-heading"><span v-if="!collapsed">工作台</span><button class="icon-button" :title="collapsed?'展开侧栏':'折叠侧栏'" :aria-label="collapsed?'展开侧栏':'折叠侧栏'" @click="collapsed=!collapsed"><Icon name="panel" :size="17"/></button></div>
        <nav aria-label="工作区"><button :disabled="speechWorking || projectMediaBusy || mcpBusy" :class="{active:view==='home'}" title="开始" @click="view='home'"><Icon name="home"/><span>开始</span></button><div class="nav-divider"/><button v-for="item in workspaces" :key="item.id" :disabled="speechWorking || projectMediaBusy || mcpBusy" :class="{active:view===item.id}" :title="item.title" :data-testid="`nav-${item.id}`" @click="view=item.id"><Icon :name="item.icon"/><span>{{ item.title }}</span><i v-if="item.id==='record' && recording" class="recording-dot"/></button></nav>
        <div class="sidebar-bottom"><div class="local-mark"><Icon name="lock" :size="14"/><span>素材在本机处理</span></div><small v-if="!collapsed">Open Media · {{ buildInfo.version }}</small><HeaderControls v-if="sidebarControls" sidebar :collapsed="collapsed" :theme="theme" :effective-theme="effectiveTheme" @update:theme="setTheme" :info-open="infoOpen" @open-info="openAiModels()"/></div>
      </aside>
      <main class="main-area">
        <div v-if="view==='edit'" class="project-bar" @scroll="projectMenuOpen=false"><span class="workspace-tag"><Icon :name="workspaces.find(item=>item.id===view)?.icon || 'video'" :size="15"/>{{ workspaceTitle }}</span><span class="divider"/><input v-if="renaming" ref="renameInput" v-model="renameValue" maxlength="300" class="rename-input" aria-label="项目名称" @blur="finishRename" @keydown.enter="finishRename" @keydown.esc="renaming=false"/><button v-else :disabled="speechWorking || projectMediaBusy || mcpBusy" class="project-title" :title="`${project.title}，点击重命名`" @click="rename">{{ project.title }}<i v-if="dirty"/></button><div ref="projectMenu" class="project-history" @keydown="projectMenuKeys" @focusout="($event.relatedTarget && !projectMenu?.contains($event.relatedTarget as Node)) && (projectMenuOpen=false)"><button class="icon-button" aria-label="切换历史工程" title="切换历史工程" aria-haspopup="menu" :aria-expanded="projectMenuOpen" :disabled="projectImportDisabled || mediaIsWorking()" data-testid="project-history-toggle" @click="toggleProjectMenu"><Icon name="chevron-down" :size="14"/></button><div v-if="projectMenuOpen" class="project-history-menu" :style="projectMenuStyle" role="menu" aria-label="历史工程"><strong>历史工程</strong><button v-for="item in recent" :key="item.id" role="menuitem" :aria-current="item.id===project.id ? 'page' : undefined" @click="openRecent(item.id)"><Icon :name="item.id===project.id ? 'check' : 'folder'" :size="15"/><span><b>{{ item.title }}</b><small>{{ item.assetCount }} 个素材 · {{ savedTime(item.updatedAt) }}</small></span></button><p v-if="!recent.length">暂无已保存工程</p></div></div><span class="project-summary">{{ project.assets.length }} 个素材 · {{ duration.toFixed(1) }} 秒</span><div class="project-file-actions file-actions">
        <button title="新建工程" aria-label="新建工程" :disabled="!!busy || switching || booting || mediaIsWorking()" data-testid="new-project" @click="newProject()"><Icon name="plus"/><span>新建工程</span></button>
        <button title="打开项目 (Ctrl/⌘+O)" aria-label="打开项目" :disabled="!!busy || switching || booting || mediaIsWorking()" data-testid="open-project" @click="openProject()"><Icon name="folder"/><span>打开</span></button>
        <button :title="lastSaved && (native || browserProjectTarget) ? `保存到 ${lastSaved} (Ctrl/⌘+S)` : '保存项目 (Ctrl/⌘+S)'" aria-label="保存项目" :disabled="!!busy || switching || booting || speechWorking || projectMediaBusy || mcpBusy" data-testid="save-project" @click="save()"><Icon name="save"/><span>保存</span></button>
        <button class="autosave-switch" role="switch" :aria-checked="autoSave" aria-label="自动保存本地草稿" title="仅自动保存本地草稿" :disabled="booting || switching" data-testid="autosave-toggle" :aria-describedby="autosaveProgress ? 'autosave-progress' : undefined" @click="toggleAutosave"><span>自动保存</span><svg width="28" height="16" viewBox="0 0 28 16"><rect width="28" height="16" rx="8"/><circle :cx="autoSave?20:8" cy="8" r="5.5"/></svg></button>
        <span v-if="autosaveProgress" id="autosave-progress" class="autosave-countdown" data-testid="autosave-countdown">{{ autosaveProgress }}</span>
        <button title="另存为项目 (Ctrl/⌘+Shift+S)" aria-label="另存为项目" :disabled="!!busy || switching || booting || speechWorking || projectMediaBusy || mcpBusy" data-testid="save-as-project" @click="save(true)"><Icon name="save-as"/><span>另存为</span></button>
        <span class="divider"/><button class="icon-button" title="撤销 (Ctrl+Z)" aria-label="撤销" :disabled="!history.past.length || switching || booting || speechWorking || projectMediaBusy || mcpBusy" @click="moveHistory('undo')"><Icon name="undo"/></button><button class="icon-button" title="重做" aria-label="重做" :disabled="!history.future.length || switching || booting || speechWorking || projectMediaBusy || mcpBusy" @click="moveHistory('redo')"><Icon name="redo"/></button>
      </div></div>
        <div v-if="error" class="app-error" role="alert"><Icon name="alert" :size="16"/><span>{{ error }}</span><button class="icon-button" aria-label="关闭提示" @click="error=''"><Icon name="close" :size="15"/></button></div>
        <div v-for="item in recoveryRecordings" :key="item.id" class="app-error recording-recovery" role="alert"><Icon name="video" :size="16"/><span>录制尚未载入列表：{{ item.name }}</span><button @click="saveRecoveredRecording(item.id)">保存录制文件</button></div>
        <div v-if="booting" class="boot-loading"><span class="spinner"/>正在恢复工作台…</div>
        <section v-else-if="view==='home'" class="home-workspace" data-testid="home-workspace">
          <div class="home-intro"><div class="eyebrow"><span/>YOUR LOCAL CREATIVE STUDIO</div><h1>把灵感，剪成作品。</h1><p>录下屏幕，整理片段，转换媒体。<br/>让每一次创作，都从这里开始。</p><div class="home-actions"><button class="primary" data-testid="create-project" :disabled="switching || booting || speechWorking || screenshotBusy || mcpBusy" @click="newProject"><Icon name="plus"/>新建工程</button><button :disabled="switching || booting || speechWorking || screenshotBusy || mcpBusy" @click="openProject()"><Icon name="folder"/>打开项目</button></div><div class="hero-art" aria-hidden="true"><div class="art-window"><div class="art-dots"><i/><i/><i/></div><svg viewBox="0 0 260 120"><path d="M0 85 40 65 75 80 130 32 180 60 220 25 260 45v75H0Z" fill="#dce8ff"/><path d="M0 105 60 80 105 95 155 65 210 88 260 64v56H0Z" fill="#b9d0ff"/><circle cx="130" cy="60" r="25" fill="white"/><path d="m124 48 19 12-19 12z" fill="#4b7deb"/></svg></div><div class="art-timeline"><i/><i/><i/><i/><b/></div><div class="art-note"><Icon name="audio" :size="20"/><span><i/><i/><i/><i/><i/><i/><i/></span></div></div></div>
          <div class="workspace-cards"><button v-for="item in workspaces" :key="item.id" :data-testid="`create-${item.id}`" :disabled="mcpBusy || projectMediaBusy" @click="view=item.id"><span class="card-icon" :style="{'--card-color':item.color}"><Icon :name="item.icon" :size="23"/></span><strong>{{ item.title }}</strong><p>{{ item.description }}</p><Icon name="chevron-right" :size="15"/></button></div>
          <section class="recent-section"><div class="section-heading"><h2>最近项目 <span>{{ recent.length }}</span></h2><label class="search-field"><Icon name="search" :size="15"/><input v-model="search" placeholder="搜索本地项目" aria-label="搜索本地项目"/></label></div><div v-if="!visibleRecent.length" class="empty-projects"><Icon name="folder" :size="31"/><p>{{ search?'没有找到匹配项目':'你的项目会保存在这里' }}</p><small>开启自动保存后，可随时回来继续编辑。</small></div><div v-else class="recent-list"><div v-for="item in visibleRecent" :key="item.id" class="recent-item"><button :disabled="mcpBusy" @click="openRecent(item.id)"><span class="recent-icon"><Icon name="video" :size="22"/></span><span><strong>{{ item.title }}</strong><small>{{ item.width }} × {{ item.height }} · {{ item.assetCount }} 个素材 · {{ item.duration.toFixed(1) }} 秒</small></span><time :datetime="item.updatedAt">{{ new Date(item.updatedAt).toLocaleString() }}</time></button><button class="icon-button" :aria-label="`移除草稿 ${item.title}`" :disabled="mcpBusy" @click="removeRecent(item)"><Icon name="trash" :size="16"/></button></div></div></section>
          <p class="home-footnote"><Icon name="info" :size="14"/>自动保存保留本地草稿；保存项目会同时打包素材，方便迁移和继续编辑。</p>
        </section>
        <VideoEditor :run-tool="runEditorTool" :commit-project="commitEditorChange" ref="videoEditor" v-if="!booting && view==='edit'" :project="project" :automation-busy="mcpBusy || projectMediaBusy" :mcp-connected="mcpConnected" :export-disabled="!!busy || switching || booting || projectMediaBusy || mcpBusy" :recording-disabled="recording || screenshotBusy || pendingMedia > 0 || browserExporting || mcpBusy" @open-mcp="openMcp" @open-models="openAiModels" @recorded-asset="rememberEditorAsset" @prepared-asset="rememberEditorAsset" @busy="speechWorking=$event" @change="(next, label, group) => { void commitEditorChange(next, label, group).catch(fail) }" @import="importFiles(undefined, 'edit')" @export="openVideoExport" @status="announce"/>
        <VideoGenerationWorkspace v-if="!booting && generationVisited" v-show="view==='generate'" :active="view==='generate'" :native="native" :project-title="project.title" :disabled="mcpBusy || switching || !!busy" @busy-change="videoGenerating=$event" @open-mcp="openMcp" @open-models="openAiModels" @add-asset="acceptGeneratedAsset" @add-timeline="acceptGeneratedAsset($event, true)" @status="announce"/>
        <AiGenerationWorkspace v-if="!booting && imageGenerationVisited" v-show="view==='image-generate'" provider="image" :active="view==='image-generate'" :native="native" :project-title="project.title" :disabled="mcpBusy || switching || !!busy" @open-models="openAiModels" @add-asset="acceptGeneratedAsset" @add-timeline="acceptGeneratedAsset($event,true)" @edit-image="editGeneratedImage" @status="announce"/>
        <AiGenerationWorkspace v-if="!booting && songGenerationVisited" v-show="view==='song-generate'" provider="music" :active="view==='song-generate'" :native="native" :project-title="project.title" :disabled="mcpBusy || switching || !!busy" @open-models="openAiModels" @add-asset="acceptGeneratedAsset" @add-timeline="acceptGeneratedAsset($event,true)" @status="announce"/>
        <KeepAlive><RecorderWorkspace v-if="!booting && view==='record'" :assets="workspaceAssets.record" :project-disabled="projectImportDisabled" :native="native" :screenshot-shortcut="screenshotShortcut" :screenshot-busy="screenshotBusy" :screenshot-disabled="screenshotDisabled" :screenshot-error="screenshotError" :screenshot-configuring="screenshotConfiguring" @screenshot="takeScreenshot" @screenshot-shortcut-change="setScreenshotShortcut" @captured="captured" @asset="acceptAsset" @add-asset="acceptGeneratedAsset" @add-to-timeline="acceptGeneratedAsset($event, true)" @recording-change="recording=$event" @status="announce"/></KeepAlive>
        <KeepAlive><GifWorkspace @busy-change="gifConverting=$event" v-if="!booting && view==='gif'" :assets="workspaceAssets.gif" :project-disabled="projectImportDisabled" :native="native" @add-project="acceptGeneratedAsset" @import="importFiles(undefined, 'gif')" @imported="importFiles([$event], 'gif')" @status="announce"/></KeepAlive>
        <KeepAlive><ConvertWorkspace @busy-change="convertedBusy" v-if="!booting && (view==='image'||view==='video')" :key="view" :mode="view" :focus-asset-id="view==='image' ? screenshotAssetId : undefined" :assets="workspaceAssets[view==='image' ? 'image' : 'video']" :project-disabled="projectImportDisabled" :native="native" @add-project="acceptGeneratedAsset" @import="importFiles" @result="acceptConverted" @status="announce"/></KeepAlive>
      </main>
    </div>
    <footer class="statusbar"><span class="status-main"><span v-if="busy || projectMediaBusy" class="spinner small"/><Icon v-else :name="recording?'record':'check'" :size="13"/><span class="status-message">{{ busy || status }}</span><time v-if="lastSaveAt" class="last-save-time" data-testid="last-save-time" :datetime="lastSaveAt" :title="lastSaveTitle">上次保存 {{ savedTime(lastSaveAt) }}</time></span><button :class="{danger:draftState==='error'}" :title="draftError || lastSaved || draftLabel" @click="draftState==='error' && persist()"><span v-if="draftState==='pending'" class="spinner small"/><Icon v-else :name="draftState==='error'?'alert':autoSave?'check':'save'" :size="13"/>{{ draftLabel }}</button></footer>
    <input ref="mediaInput" class="sr-only" type="file" accept="video/*,audio/*,image/*,.mkv,.mov,.avi,.flac,.ogg" multiple data-testid="media-input" @change="importFiles([...(($event.target as HTMLInputElement).files || [])], importDestination); importDestination=undefined; ($event.target as HTMLInputElement).value=''"/>
    <input ref="projectInput" class="sr-only" type="file" accept=".omedia" data-testid="project-input" @change="openProject(($event.target as HTMLInputElement).files?.[0]); ($event.target as HTMLInputElement).value=''"/>
    <ScreenshotPicker ref="screenshotPicker"/>
    <ExportPanel :open="exportOpen" :project="project" :native="native" @close="exportOpen=false" @status="announce" @busy="browserExporting=$event"/>
    <McpPanel :open="mcpOpen" :native="native" :project="project" :editing-busy="mcpBusy || !!busy || switching || browserExporting || speechWorking" @motion-change="updateMcpMotion" @close="mcpOpen=false" @status="announce" @service-change="mcpServiceChanged"/>
    <AppInfo :open="infoOpen" :native="native" :initial-provider="aiInitialProvider" @close="infoOpen=false" @status="announce"/>
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
            <p v-if="mcpJobMetrics(job)" class="mcp-job-metrics">{{ mcpJobMetrics(job) }}</p>
            <button v-if="job.state==='running' && job.cancelable!==false" :disabled="job.cancelling" :aria-label="`取消 MCP 任务 ${job.name}`" @click="cancelMcpJob(job.id)">{{ job.cancelling ? '正在取消…' : '取消任务' }}</button>
          </article>
        </div>
        <footer><button @click="jobsOpen=false">关闭</button></footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.project-history{position:relative;flex:none}.project-history-menu{position:fixed;z-index:60;top:calc(100% + 8px);left:0;width:min(340px,70vw);max-height:360px;overflow:auto;padding:7px;border:1px solid var(--ui-line);border-radius:9px;background:var(--ui-surface);box-shadow:var(--ui-shadow)}.project-history-menu>strong{display:block;font-size:11px;color:var(--ui-muted);padding:6px 9px}.project-history-menu>button{display:flex;width:100%;align-items:center;gap:9px;text-align:left;border:0;background:transparent;padding:9px;border-radius:6px;color:var(--ui-text)}.project-history-menu>button:hover,.project-history-menu>button[aria-current]{background:var(--ui-hover)}.project-history-menu>button>span{min-width:0;display:flex;flex-direction:column;gap:4px}.project-history-menu b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.project-history-menu small,.project-history-menu p{font-size:10px;color:var(--ui-muted)}
.workspace-cards{grid-template-columns:repeat(4,minmax(0,1fr))}
.sidebar nav{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.sidebar nav>button{flex-shrink:0}@media(max-width:1000px){.workspace-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){.workspace-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.workspace-cards>button:last-child{grid-column:auto;min-height:142px;padding:13px 10px;display:block}.workspace-cards>button:last-child>.card-icon{position:static}.workspace-cards>button:last-child>svg{top:20px}}
.autosave-countdown{font-size:10px;color:var(--ui-muted);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:5.5em;margin-right:4px}
.status-message{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.last-save-time{flex:none;font-variant-numeric:tabular-nums;border-left:1px solid var(--ui-line);padding-left:8px;margin-left:2px}
@media(max-width:640px){.status-main{max-width:none;flex:1}.status-message{flex:1}.last-save-time{max-width:60%;overflow:hidden;text-overflow:ellipsis;font-size:9px}}
.app-confirm{--ed-border:var(--ui-line);--ed-panel:var(--ui-surface);--ed-text:var(--ui-text);--ed-accent:var(--ui-accent);--ed-muted:var(--ui-muted);--ed-bg:var(--ui-hover)}
.confirmation-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
.confirmation-actions button{font-size:12px}
.mcp-task-item progress{display:block;width:100%;height:5px;accent-color:var(--ui-accent)}
.mcp-task-item .error-message{color:var(--ui-danger)}
.mcp-processing-banner{position:fixed;z-index:90;top:calc(5px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);width:min(780px,calc(100vw - 360px));height:44px;display:flex;align-items:center;gap:9px;padding:0 11px;border:1px solid color-mix(in srgb,var(--ui-accent) 25%,var(--ui-line));border-radius:9px;background:var(--ui-surface);box-shadow:0 5px 24px #0002;color:var(--ui-text)}
/* The status and its details share the opposite palette without changing the workspace. */
.mcp-processing-banner[data-theme=light]{--ui-surface:#fff;--ui-line:#d6deeb;--ui-border-strong:#aebed5;--ui-text:#263044;--ui-muted:#586a84;--ui-accent:#285be0;--ui-hover:#edf2fc;--ui-shadow:0 12px 38px #20345c24;color-scheme:light}
.mcp-processing-banner[data-theme=dark]{--ui-surface:#1d2230;--ui-line:#46546b;--ui-border-strong:#64748e;--ui-text:#e3e8f2;--ui-muted:#a3b1c7;--ui-accent:#91adff;--ui-hover:#2a3346;--ui-shadow:0 12px 38px #0006;color-scheme:dark}
.app-shell.sidebar-appearance .mcp-processing-banner{top:calc(54px + env(safe-area-inset-top,0px))}
.mcp-processing-banner.connected{border-color:color-mix(in srgb,#8c8afd 55%,var(--ui-line));box-shadow:0 0 16px #7195ff26,0 5px 24px #0002}
.mcp-status-icon{flex:none;color:var(--ui-accent)}
.mcp-processing-banner.working{border-color:#8c8afd;box-shadow:0 0 0 1px #8c8afd40,0 0 24px #7195ff55,0 6px 24px #0003}
.mcp-processing-banner.working .mcp-processing-copy strong{font-weight:700}
.mcp-processing-banner>.spinner{flex:none}.mcp-processing-copy{display:flex;align-items:center;gap:10px;flex:1;min-width:0;white-space:nowrap;font-size:11px;line-height:18px}.mcp-processing-copy strong{flex:none;color:var(--ui-accent);font-weight:600}.mcp-processing-copy>span{min-width:0;overflow:hidden;text-overflow:ellipsis}.mcp-processing-percent{flex:none;font-size:11px;width:4ch;text-align:right;font-variant-numeric:tabular-nums}.mcp-processing-actions{display:flex;gap:5px;flex:none}.mcp-processing-actions button{display:inline-flex;align-items:center;gap:4px;height:28px;min-width:28px;padding:0 7px;border:1px solid var(--ui-line);border-radius:5px;background:var(--ui-surface);color:var(--ui-text);font:inherit;font-size:11px;white-space:nowrap;cursor:pointer}.mcp-processing-actions .mcp-processing-detail-button{padding:0;width:28px;border-color:transparent}.mcp-processing-actions button:hover:not(:disabled){border-color:var(--ui-accent);color:var(--ui-accent)}.mcp-processing-actions button:disabled{opacity:.5;cursor:wait}
.mcp-processing-progress{position:absolute;bottom:0;left:8px;right:8px;height:2px;overflow:hidden;border-radius:2px}.mcp-processing-progress i{display:block;height:100%;background:var(--ui-accent)}.mcp-processing-details{position:absolute;top:52px;right:0;width:min(440px,100%);max-height:min(280px,calc(100dvh - 128px));overflow:auto;padding:14px;border:1px solid var(--ui-line);border-radius:9px;background:var(--ui-surface);box-shadow:var(--ui-shadow);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.mcp-processing-details p{margin:7px 0 0;color:var(--ui-muted);font-size:11px}.mcp-job-metrics{font-variant-numeric:tabular-nums}
@media(max-width:700px){.mcp-processing-banner{top:calc(62px + env(safe-area-inset-top,0px));width:calc(100vw - 24px);gap:6px;padding:0 8px}.mcp-processing-copy{gap:6px}.mcp-processing-copy strong{font-size:10px}.mcp-action-label{display:none}.mcp-processing-actions button{width:28px;padding:0}.mcp-processing-percent{font-size:10px}}
@media(max-width:640px){.mcp-processing-banner{top:calc(57px + env(safe-area-inset-top,0px))}}
@media(prefers-reduced-motion:reduce){.mcp-processing-banner>.spinner{animation:none}}

</style>
