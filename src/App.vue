<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Icon from './components/Icon.vue'
import VideoEditor from './components/VideoEditor.vue'
import RecorderWorkspace from './components/RecorderWorkspace.vue'
import GifWorkspace from './components/GifWorkspace.vue'
import ConvertWorkspace from './components/ConvertWorkspace.vue'
import ExportPanel from './components/ExportPanel.vue'
import type { ImportedProject, MediaAsset, Project, ProjectSummary } from './core/types.ts'
import { cloneProject, createClip, createProject, createTrack, validateProject } from './core/project.ts'
import { addAssets, addClip, addTrack, commitHistory, createHistory, projectDuration, redoHistory, undoHistory } from './core/timeline.ts'
import { deleteProject, listProjects, loadProject, saveProject as storeProject } from './core/storage.ts'
import { exportProjectFile, importProjectFile } from './core/project-file.ts'
import { downloadBlob, importMediaFile } from './core/media-import.ts'
import { cancelMediaJob, closeNativeWindow, getMediaJobs, getRuntimeStatus, importBlobAsset, isDesktop, onNativeCloseRequest, openProjectFile, pickMediaAssets, saveBytes, selectRuntime, type MediaJob, type RuntimeStatus } from './native.ts'

type Workspace = 'home' | 'edit' | 'record' | 'gif' | 'image' | 'video'
const workspaces: { id: Workspace; title: string; icon: string; description: string; color: string }[] = [
  { id: 'edit', title: '视频剪辑', icon: 'scissors', description: '多轨剪辑、字幕与配乐，组合你的故事', color: '#2563eb' },
  { id: 'record', title: '录屏', icon: 'record', description: '录制屏幕与声音，随时暂停和继续', color: '#e35764' },
  { id: 'gif', title: '片段转 GIF', icon: 'gif', description: '截取多个精彩片段，生成循环动图', color: '#9161d1' },
  { id: 'image', title: '图片转换', icon: 'image', description: '批量转换格式，调整尺寸与画面', color: '#2a9d80' },
  { id: 'video', title: '视频转换', icon: 'convert', description: '转换视频格式、压缩体积与提取音频', color: '#dd9635' },
]
const native = isDesktop(), view = ref<Workspace>('home'), collapsed = ref(false), booting = ref(true), theme = ref<'light' | 'dark' | 'system'>('system'), systemDark = ref(false)
const initial = createProject(), project = shallowRef(initial), history = shallowRef(createHistory(initial))
const autoSave = ref(true), draftState = ref<'idle' | 'pending' | 'saved' | 'error'>('idle'), draftError = ref(''), lastSaved = ref('')
const recent = ref<ProjectSummary[]>([]), status = ref('本地创作，自由表达'), busy = ref(''), error = ref(''), recording = ref(false), browserExporting = ref(false)
const exportOpen = ref(false), settingsOpen = ref(false), jobsOpen = ref(false), runtime = ref<RuntimeStatus>({ ready: false }), jobs = ref<MediaJob[]>([])
const mediaInput = ref<HTMLInputElement>(), projectInput = ref<HTMLInputElement>(), renameInput = ref<HTMLInputElement>(), renaming = ref(false), renameValue = ref(''), search = ref('')
const blobs = new Map<string, Blob>(), ownedUrls = new Set<string>(), hydratedReleases: (() => void)[] = []
let draftTimer: ReturnType<typeof setTimeout> | undefined, draftGeneration = 0, saveQueue = Promise.resolve(), jobsTimer: ReturnType<typeof setTimeout> | undefined, mediaQuery: MediaQueryList | undefined, unlistenClose: (() => void) | undefined, allowClose = false
const effectiveTheme = computed(() => theme.value === 'system' ? systemDark.value ? 'dark' : 'light' : theme.value)
const duration = computed(() => projectDuration(project.value)), workspaceTitle = computed(() => workspaces.find(item => item.id === view.value)?.title || '开始')
const visibleRecent = computed(() => recent.value.filter(item => item.title.toLowerCase().includes(search.value.toLowerCase())))
const runningJobs = computed(() => jobs.value.filter(job => job.state === 'running').length)
function contentKey(value: Project) { const copy = cloneProject(value); copy.updatedAt = ''; for (const asset of copy.assets) { asset.url = ''; delete asset.nativePath }; return JSON.stringify(copy) }
const cleanKey = ref(contentKey(initial)), dirty = computed(() => contentKey(project.value) !== cleanKey.value)
const draftLabel = computed(() => draftState.value === 'error' ? '草稿保存失败' : draftState.value === 'pending' ? '正在保存草稿…' : !autoSave.value ? '自动保存已关闭' : draftState.value === 'saved' ? '本地草稿已保存' : '自动保存已开启')
function announce(message: string) { status.value = message }
function fail(cause: unknown) { error.value = cause instanceof Error ? cause.message : String(cause); status.value = error.value }
function notifyError(cause: unknown) { fail(cause); busy.value = '' }
function remember() { try { localStorage.setItem('open-media:last-project', project.value.id) } catch { /* Local draft failures are reported by the persistent store. */ } }
async function refreshRecent() { recent.value = await listProjects() }
function scheduleDraft() {
  clearTimeout(draftTimer)
  if (!autoSave.value || booting.value) return
  draftState.value = 'pending'
  const generation = draftGeneration
  draftTimer = setTimeout(() => { if (generation === draftGeneration && autoSave.value) void persist() }, 650)
}
function persist(): Promise<boolean> {
  clearTimeout(draftTimer)
  const snapshot = cloneProject(project.value), snapshotBlobs = new Map(blobs), key = contentKey(snapshot)
  draftState.value = 'pending'; draftError.value = ''
  const result = saveQueue.then(async () => {
    try {
      await storeProject(snapshot, snapshotBlobs); await refreshRecent()
      if (project.value.id === snapshot.id) { if (contentKey(project.value) === key) draftState.value = 'saved'; remember() }
      return true
    } catch (cause) {
      if (project.value.id === snapshot.id) { draftState.value = 'error'; draftError.value = cause instanceof Error ? cause.message : String(cause) }
      return false
    }
  })
  saveQueue = result.then(() => undefined)
  return result
}
function commit(next: Project, label = '已修改项目') {
  try {
    const checked = validateProject(next, { trusted: true })
    if (contentKey(checked) === contentKey(project.value)) return
    checked.updatedAt = new Date().toISOString(); history.value = commitHistory(history.value, checked); project.value = checked
    announce(label); scheduleDraft()
  } catch (cause) { fail(cause) }
}
function moveHistory(direction: 'undo' | 'redo') {
  history.value = direction === 'undo' ? undoHistory(history.value) : redoHistory(history.value)
  project.value = cloneProject(history.value.present); announce(direction === 'undo' ? '已撤销' : '已重做'); scheduleDraft()
}
function toggleAutosave() { autoSave.value = !autoSave.value; draftGeneration++; clearTimeout(draftTimer); try { localStorage.setItem('open-media:autosave', String(autoSave.value)) } catch {} ; if (autoSave.value) void persist() }
function setTheme(value: 'light' | 'dark' | 'system') { theme.value = value; try { localStorage.setItem('open-media:theme', value) } catch {} }
function rememberAsset(asset: MediaAsset) { if (asset.url.startsWith('blob:')) ownedUrls.add(asset.url) }
async function acceptAssets(assets: MediaAsset[], assetBlobs?: Map<string, Blob>) {
  if (!assets.length) return
  for (const asset of assets) { rememberAsset(asset); if (assetBlobs?.has(asset.id)) blobs.set(asset.id, assetBlobs.get(asset.id)!) }
  commit(addAssets(project.value, assets), `已导入 ${assets.length} 个素材`)
}
async function acceptAsset(asset: MediaAsset) { await acceptAssets([asset]) }
async function importFiles(files?: File[]) {
  if (busy.value) return
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
  try { await acceptAssets(assets, imported); if (failures.length) fail(failures.join('\n')) } finally { busy.value = '' }
}
async function captured(blob: Blob, name: string) { await importFiles([new File([blob], name, { type: blob.type })]); if (!error.value) announce('录制已加入素材库，可前往视频剪辑继续编辑。') }
async function acceptConverted(asset: MediaAsset) {
  try {
    const blob = await (await fetch(asset.url)).blob()
    if (native) { const imported = await importBlobAsset(new Uint8Array(await blob.arrayBuffer()), asset.name); await acceptAsset(imported) }
    else await acceptAssets([asset], new Map([[asset.id, blob]]))
  } catch (cause) { fail(cause) }
}
function addToTimeline(assetId: string) {
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
  if (!dirty.value) return true
  if (autoSave.value && await persist()) return true
  const choice = await ask({ title: '保留当前项目', text: '当前项目有尚未保留的修改。可以先保存本地草稿，稍后继续编辑。', choices: [{ id: 'cancel', label: '取消' }, { id: 'discard', label: '不保留修改' }, { id: 'save', label: '保存草稿', primary: true }] })
  if (choice === 'cancel') return false
  if (choice === 'save') { const success = await persist(); if (!success) fail(draftError.value); return success }
  return true
}
function adoptProject(next: Project, restored = false) {
  draftGeneration++; clearTimeout(draftTimer)
  project.value = next; history.value = createHistory(next); cleanKey.value = contentKey(next); draftState.value = restored ? 'saved' : 'idle'; lastSaved.value = ''; remember()
  view.value = 'edit'; error.value = ''; if (!restored) scheduleDraft()
}
async function newProject() { if (busy.value || !await protectProject()) return; adoptProject(createProject()); announce('已新建项目。') }
async function hydrate(imported: ImportedProject) {
  const next = cloneProject(imported.project)
  if (native) {
    for (const asset of next.assets) {
      const blob = imported.blobs.get(asset.id)
      if (blob && !asset.nativePath) {
        const recovered = await importBlobAsset(new Uint8Array(await blob.arrayBuffer()), asset.name)
        Object.assign(asset, recovered, { id: asset.id })
      }
    }
  }
  for (const [id, blob] of imported.blobs) blobs.set(id, blob)
  hydratedReleases.push(imported.revoke); next.assets.forEach(rememberAsset)
  return validateProject(next, { trusted: true })
}
async function openProject(file?: File) {
  if (busy.value || !await protectProject()) return
  if (!file && !native) { projectInput.value?.click(); return }
  busy.value = '正在打开项目…'; error.value = ''
  try {
    const selected = file || await openProjectFile()
    if (!selected) return
    const imported = await importProjectFile(selected instanceof File ? selected : new Uint8Array(selected.bytes))
    adoptProject(await hydrate(imported)); cleanKey.value = contentKey(project.value); announce('项目与素材已打开。')
  } catch (cause) { fail(cause) } finally { busy.value = '' }
}
async function openRecent(id: string) {
  if (busy.value || !await protectProject()) return
  busy.value = '正在恢复本地草稿…'
  try { adoptProject(await hydrate(await loadProject(id)), true); announce('已恢复本地项目。') } catch (cause) { fail(cause) } finally { busy.value = '' }
}
async function removeRecent(item: ProjectSummary) {
  const choice = await ask({ title: '移除本地草稿', text: `移除“${item.title}”的本地草稿？已经导出的项目文件仍可打开。`, choices: [{ id: 'cancel', label: '取消' }, { id: 'remove', label: '移除草稿', primary: true }] })
  if (choice !== 'remove') return
  try { await deleteProject(item.id); await refreshRecent(); if (item.id === project.value.id) draftState.value = 'idle' } catch (cause) { fail(cause) }
}
async function save() {
  if (busy.value) return
  busy.value = '正在打包项目与素材…'; error.value = ''
  const snapshot = cloneProject(project.value), key = contentKey(snapshot)
  try {
    const blob = await exportProjectFile(snapshot, { blobs, onProgress: (done, total) => { busy.value = `正在打包项目 ${Math.round(done / Math.max(1, total) * 100)}%` } })
    const name = `${snapshot.title.replace(/[\\/:*?"<>|]/g, '-') || '媒体项目'}.omedia`
    if (native) { const path = await saveBytes(name, new Uint8Array(await blob.arrayBuffer())); if (!path) return; lastSaved.value = path }
    else { downloadBlob(blob, name); lastSaved.value = name }
    if (project.value.id === snapshot.id) cleanKey.value = key
    await persist(); announce('项目与素材已保存，可重新打开继续编辑。')
  } catch (cause) { fail(cause) } finally { busy.value = '' }
}
async function rename() { renameValue.value = project.value.title; renaming.value = true; await nextTick(); renameInput.value?.focus(); renameInput.value?.select() }
function finishRename() { if (!renaming.value) return; renaming.value = false; const title = renameValue.value.trim().slice(0, 300); if (title) commit({ ...project.value, title }, '项目已重命名') }
async function updateRuntime() { try { runtime.value = await getRuntimeStatus() } catch (cause) { runtime.value = { ready: false, error: String(cause) } } }
async function chooseRuntime() { try { runtime.value = await selectRuntime() } catch (cause) { fail(cause) } }
async function pollJobs() { if (!native) return; try { jobs.value = await getMediaJobs() } catch {} ; jobsTimer = setTimeout(() => void pollJobs(), 1000) }
async function cancelJob(id: string) { try { await cancelMediaJob(id); jobs.value = await getMediaJobs() } catch (cause) { fail(cause) } }
async function nativeClose() {
  if (recording.value) { view.value = 'record'; fail('请先结束录制，录制完成后再关闭应用。'); return }
  if (browserExporting.value || runningJobs.value) { jobsOpen.value = native; fail('请等待导出完成，或先取消正在处理的任务。'); return }
  if (!await protectProject()) return
  allowClose = true
  await closeNativeWindow()
}
const hasDialog = computed(() => Boolean(question.value || exportOpen.value || settingsOpen.value || jobsOpen.value))
let previousFocus: HTMLElement | null = null
watch(hasDialog, async open => { if (open) { previousFocus = document.activeElement as HTMLElement; await nextTick(); (document.querySelector('[role="dialog"] button, [role="dialog"] input') as HTMLElement | null)?.focus() } else previousFocus?.focus() })
function keyboard(event: KeyboardEvent) {
  if (hasDialog.value) {
    if (event.key === 'Escape') { event.preventDefault(); if (question.value) answer('cancel'); else if (settingsOpen.value) settingsOpen.value = false; else if (jobsOpen.value) jobsOpen.value = false; else if (!browserExporting.value) exportOpen.value = false }
    if (event.key === 'Tab') {
      const dialog = document.querySelector('[role="dialog"]'), items = dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')].filter(item => item.offsetParent !== null) : []
      const first = items[0], last = items.at(-1)
      if (first && event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (last && !event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    return
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 's') { event.preventDefault(); void save() }
  if (key === 'o') { event.preventDefault(); void openProject() }
  if ((event.target as HTMLElement)?.closest('input,textarea,[contenteditable]')) return
  if (key === 'z') { event.preventDefault(); moveHistory(event.shiftKey ? 'redo' : 'undo') }
  if (key === 'y') { event.preventDefault(); moveHistory('redo') }
}
function unload(event: BeforeUnloadEvent) { if (!allowClose && (recording.value || browserExporting.value || dirty.value && (draftState.value !== 'saved' || !autoSave.value))) { event.preventDefault(); event.returnValue = '' } }
function mediaChanged(event: MediaQueryListEvent) { systemDark.value = event.matches }
function dropped(event: DragEvent) { event.preventDefault(); const files = [...(event.dataTransfer?.files || [])]; if (files.length === 1 && files[0]!.name.toLowerCase().endsWith('.omedia')) void openProject(files[0]); else if (files.length) void importFiles(files) }
onMounted(async () => {
  mediaQuery = matchMedia('(prefers-color-scheme: dark)'); systemDark.value = mediaQuery.matches; mediaQuery.addEventListener('change', mediaChanged)
  window.addEventListener('keydown', keyboard); window.addEventListener('beforeunload', unload)
  try { autoSave.value = localStorage.getItem('open-media:autosave') !== 'false'; const value = localStorage.getItem('open-media:theme'); if (value === 'light' || value === 'dark' || value === 'system') theme.value = value } catch {}
  try { await refreshRecent(); const last = localStorage.getItem('open-media:last-project'); if (last && recent.value.some(item => item.id === last)) { const restored = await hydrate(await loadProject(last)); adoptProject(restored, true); view.value = 'home' } } catch (cause) { fail(cause) }
  booting.value = false
  if (native) {
    void updateRuntime(); void pollJobs()
    try { unlistenClose = await onNativeCloseRequest(() => { if (!allowClose) void nativeClose() }) } catch (cause) { fail(cause) }
  }
})
onBeforeUnmount(() => { draftGeneration++; clearTimeout(draftTimer); clearTimeout(jobsTimer); unlistenClose?.(); mediaQuery?.removeEventListener('change', mediaChanged); window.removeEventListener('keydown', keyboard); window.removeEventListener('beforeunload', unload); for (const release of hydratedReleases) release(); for (const url of ownedUrls) URL.revokeObjectURL(url) })
</script>

<template>
  <div class="app-shell" :data-theme="effectiveTheme" @dragover.prevent @drop="dropped">
    <header class="topbar">
      <button class="brand" title="开始" @click="view='home'"><img src="/favicon.svg" width="29" height="29" alt=""/><strong>Open Media</strong></button>
      <div class="file-actions">
        <button title="新建项目" :disabled="!!busy" @click="newProject"><Icon name="plus"/><span>新建</span></button>
        <button title="打开项目 (Ctrl+O)" :disabled="!!busy" @click="openProject()"><Icon name="folder"/><span>打开</span></button>
        <span class="divider"/>
        <button title="保存项目 (Ctrl+S)" :disabled="!!busy || booting" data-testid="save-project" @click="save"><Icon name="save"/><span>保存</span></button>
        <button class="autosave-switch" role="switch" :aria-checked="autoSave" aria-label="自动保存本地草稿" title="仅自动保存本地草稿" :disabled="booting" data-testid="autosave-toggle" @click="toggleAutosave"><span>自动保存</span><svg width="28" height="16" viewBox="0 0 28 16"><rect width="28" height="16" rx="8"/><circle :cx="autoSave?20:8" cy="8" r="5.5"/></svg></button>
        <span class="divider"/><button class="icon-button" title="撤销 (Ctrl+Z)" aria-label="撤销" :disabled="!history.past.length" @click="moveHistory('undo')"><Icon name="undo"/></button><button class="icon-button" title="重做" aria-label="重做" :disabled="!history.future.length" @click="moveHistory('redo')"><Icon name="redo"/></button>
      </div>
      <div class="topbar-end"><button v-if="native" class="icon-button job-button" title="导出任务" aria-label="导出任务" @click="jobsOpen=true"><Icon name="layers"/><b v-if="runningJobs">{{ runningJobs }}</b></button><button class="icon-button" title="设置" aria-label="设置" @click="settingsOpen=true"><Icon name="settings"/></button><button class="primary top-export" :disabled="!duration || !!busy" data-testid="export-project" @click="exportOpen=true"><Icon name="export" :size="16"/><span>导出视频</span></button></div>
    </header>
    <div class="workbench-body">
      <aside class="sidebar" :class="{collapsed}">
        <div class="sidebar-heading"><span v-if="!collapsed">工作台</span><button class="icon-button" :title="collapsed?'展开侧栏':'折叠侧栏'" :aria-label="collapsed?'展开侧栏':'折叠侧栏'" @click="collapsed=!collapsed"><Icon name="panel" :size="17"/></button></div>
        <nav aria-label="工作区"><button :class="{active:view==='home'}" title="开始" @click="view='home'"><Icon name="home"/><span>开始</span></button><div class="nav-divider"/><button v-for="item in workspaces" :key="item.id" :class="{active:view===item.id}" :title="item.title" :data-testid="`nav-${item.id}`" @click="view=item.id"><Icon :name="item.icon"/><span>{{ item.title }}</span><i v-if="item.id==='record' && recording" class="recording-dot"/></button></nav>
        <div class="sidebar-bottom"><div class="local-mark"><Icon name="lock" :size="14"/><span>素材在本机处理</span></div><small v-if="!collapsed">Open Media · 0.1.0</small></div>
      </aside>
      <main class="main-area">
        <div v-if="view!=='home'" class="project-bar"><span class="workspace-tag"><Icon :name="workspaces.find(item=>item.id===view)?.icon || 'video'" :size="15"/>{{ workspaceTitle }}</span><span class="divider"/><input v-if="renaming" ref="renameInput" v-model="renameValue" maxlength="300" class="rename-input" aria-label="项目名称" @blur="finishRename" @keydown.enter="finishRename" @keydown.esc="renaming=false"/><button v-else class="project-title" :title="`${project.title}，点击重命名`" @click="rename">{{ project.title }}<i v-if="dirty"/></button><span class="project-summary">{{ project.assets.length }} 个素材 · {{ duration.toFixed(1) }} 秒</span><button class="import-action" :disabled="!!busy" data-testid="import-media" @click="importFiles()"><Icon name="import" :size="16"/><span>导入素材</span></button></div>
        <div v-if="error" class="app-error" role="alert"><Icon name="alert" :size="16"/><span>{{ error }}</span><button class="icon-button" aria-label="关闭提示" @click="error=''"><Icon name="close" :size="15"/></button></div>
        <div v-if="booting" class="boot-loading"><span class="spinner"/>正在恢复工作台…</div>
        <section v-else-if="view==='home'" class="home-workspace" data-testid="home-workspace">
          <div class="home-intro"><div class="eyebrow"><span/>YOUR LOCAL CREATIVE STUDIO</div><h1>把灵感，剪成作品。</h1><p>录下屏幕，整理片段，转换媒体。<br/>让每一次创作，都从这里开始。</p><div class="home-actions"><button class="primary" data-testid="create-project" @click="newProject"><Icon name="plus"/>新建剪辑项目</button><button @click="openProject()"><Icon name="folder"/>打开项目</button></div><div class="hero-art" aria-hidden="true"><div class="art-window"><div class="art-dots"><i/><i/><i/></div><svg viewBox="0 0 260 120"><path d="M0 85 40 65 75 80 130 32 180 60 220 25 260 45v75H0Z" fill="#dce8ff"/><path d="M0 105 60 80 105 95 155 65 210 88 260 64v56H0Z" fill="#b9d0ff"/><circle cx="130" cy="60" r="25" fill="white"/><path d="m124 48 19 12-19 12z" fill="#4b7deb"/></svg></div><div class="art-timeline"><i/><i/><i/><i/><b/></div><div class="art-note"><Icon name="audio" :size="20"/><span><i/><i/><i/><i/><i/><i/><i/></span></div></div></div>
          <div class="workspace-cards"><button v-for="item in workspaces" :key="item.id" :data-testid="`create-${item.id}`" @click="view=item.id"><span class="card-icon" :style="{'--card-color':item.color}"><Icon :name="item.icon" :size="23"/></span><strong>{{ item.title }}</strong><p>{{ item.description }}</p><Icon name="chevron-right" :size="15"/></button></div>
          <section class="recent-section"><div class="section-heading"><h2>最近项目 <span>{{ recent.length }}</span></h2><label class="search-field"><Icon name="search" :size="15"/><input v-model="search" placeholder="搜索本地项目" aria-label="搜索本地项目"/></label></div><div v-if="!visibleRecent.length" class="empty-projects"><Icon name="folder" :size="31"/><p>{{ search?'没有找到匹配项目':'你的项目会保存在这里' }}</p><small>开启自动保存后，可随时回来继续编辑。</small></div><div v-else class="recent-list"><div v-for="item in visibleRecent" :key="item.id" class="recent-item"><button @click="openRecent(item.id)"><span class="recent-icon"><Icon name="video" :size="22"/></span><span><strong>{{ item.title }}</strong><small>{{ item.width }} × {{ item.height }} · {{ item.assetCount }} 个素材 · {{ item.duration.toFixed(1) }} 秒</small></span><time :datetime="item.updatedAt">{{ new Date(item.updatedAt).toLocaleString() }}</time></button><button class="icon-button" :aria-label="`移除草稿 ${item.title}`" @click="removeRecent(item)"><Icon name="trash" :size="16"/></button></div></div></section>
          <p class="home-footnote"><Icon name="info" :size="14"/>自动保存保留本地草稿；保存项目会同时打包素材，方便迁移和继续编辑。</p>
        </section>
        <VideoEditor v-if="!booting && view==='edit'" :project="project" @change="commit" @import="importFiles" @export="exportOpen=true" @status="announce"/>
        <KeepAlive><RecorderWorkspace v-if="!booting && view==='record'" :assets="project.assets" :native="native" @captured="captured" @asset="acceptAsset" @add-to-timeline="addToTimeline" @recording-change="recording=$event" @status="announce"/></KeepAlive>
        <KeepAlive><GifWorkspace v-if="!booting && view==='gif'" :assets="project.assets" :native="native" @imported="importFiles([$event])" @status="announce"/></KeepAlive>
        <KeepAlive><ConvertWorkspace v-if="!booting && (view==='image'||view==='video')" :key="view" :mode="view" :assets="project.assets" :native="native" @import="importFiles" @result="acceptConverted" @status="announce"/></KeepAlive>
      </main>
    </div>
    <footer class="statusbar"><span class="status-main"><span v-if="busy" class="spinner small"/><Icon v-else :name="recording?'record':'check'" :size="13"/>{{ busy || status }}</span><button :class="{danger:draftState==='error'}" :title="draftError || lastSaved || draftLabel" @click="draftState==='error' && persist()"><span v-if="draftState==='pending'" class="spinner small"/><Icon v-else :name="draftState==='error'?'alert':autoSave?'check':'save'" :size="13"/>{{ draftLabel }}</button></footer>
    <input ref="mediaInput" class="sr-only" type="file" accept="video/*,audio/*,image/*,.mkv,.mov,.avi,.flac,.ogg" multiple data-testid="media-input" @change="importFiles([...(($event.target as HTMLInputElement).files || [])]); ($event.target as HTMLInputElement).value=''"/>
    <input ref="projectInput" class="sr-only" type="file" accept=".omedia" data-testid="project-input" @change="openProject(($event.target as HTMLInputElement).files?.[0]); ($event.target as HTMLInputElement).value=''"/>
    <ExportPanel :open="exportOpen" :project="project" :native="native" @close="exportOpen=false" @status="announce" @busy="browserExporting=$event"/>
    <div v-if="question" class="modal-shade" @click.self="answer('cancel')"><section class="dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><header><strong id="confirm-title">{{ question.title }}</strong></header><div class="dialog-content"><p>{{ question.text }}</p></div><footer><button v-for="choice in question.choices" :key="choice.id" :class="{primary:choice.primary}" @click="answer(choice.id)">{{ choice.label }}</button></footer></section></div>
    <div v-if="settingsOpen" class="modal-shade" @click.self="settingsOpen=false"><section class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><span><Icon name="settings"/><strong id="settings-title">设置</strong></span><button class="icon-button" aria-label="关闭设置" @click="settingsOpen=false"><Icon name="close"/></button></header><div class="dialog-content"><h3>外观</h3><div class="segmented"><button v-for="item in [{id:'light',title:'浅色',icon:'sun'},{id:'dark',title:'深色',icon:'moon'},{id:'system',title:'跟随系统',icon:'screen'}]" :key="item.id" :class="{selected:theme===item.id}" @click="setTheme(item.id as 'light'|'dark'|'system')"><Icon :name="item.icon" :size="16"/>{{ item.title }}</button></div><h3>本地保存</h3><p class="muted">自动保存仅保留当前设备的草稿。点击“保存”生成含素材的项目文件，换一台设备也可继续编辑。</p><h3>媒体处理</h3><template v-if="native"><div class="runtime-state" :class="{ready:runtime.ready}"><Icon :name="runtime.ready?'check':'alert'" :size="16"/>{{ runtime.ready?'编码工具已就绪':'编码工具尚未就绪' }}</div><p class="muted">{{ runtime.version || runtime.error }}</p><div class="runtime-actions"><button @click="updateRuntime"><Icon name="refresh" :size="15"/>重新检查</button><button @click="chooseRuntime"><Icon name="folder" :size="15"/>选择本机编码工具</button></div></template><p v-else class="muted">网页支持录屏、剪辑、GIF 和常用图片转换，以及 WebM 实时导出。桌面端提供更多视频格式与本机录屏能力。</p><p class="version-label">Open Media 0.1.0</p></div><footer><button class="primary" @click="settingsOpen=false">完成</button></footer></section></div>
    <div v-if="jobsOpen" class="modal-shade" @click.self="jobsOpen=false"><section class="dialog jobs-dialog" role="dialog" aria-modal="true" aria-labelledby="jobs-title"><header><span><Icon name="layers"/><strong id="jobs-title">导出任务</strong></span><button class="icon-button" aria-label="关闭任务" @click="jobsOpen=false"><Icon name="close"/></button></header><div class="dialog-content"><p v-if="!jobs.length" class="muted">还没有导出任务。</p><article v-for="job in [...jobs].reverse()" :key="job.id" class="job-item"><div><strong>{{ job.name }}</strong><span>{{ ({running:'正在处理',completed:'已完成',failed:'失败',cancelled:'已取消'})[job.state] }}</span></div><div v-if="job.state==='running'" class="progress-track"><i :style="{width:`${job.progress*100}%`}"/></div><p v-if="job.outputPath">{{ job.outputPath }}</p><p v-if="job.error" class="error-message">{{ job.error }}</p><button v-if="job.state==='running'" @click="cancelJob(job.id)">取消任务</button></article></div><footer><button @click="jobsOpen=false">关闭</button></footer></section></div>
  </div>
</template>
