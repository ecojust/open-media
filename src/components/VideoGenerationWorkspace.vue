<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import ToolWorkspace from './ToolWorkspace.vue'
import type { MediaAsset } from '../core/types.ts'
import { VIDEO_GENERATION_MAX_SHOTS, videoGenerationActualSeconds, videoGenerationRequestError, type VideoGenerationJob, type VideoGenerationMode, type VideoGenerationModel, type VideoGenerationRequest, type VideoGenerationShot, type VideoGenerationStatus } from '../core/video-generation.ts'
import { beginVideoGeneration, cancelVideoGeneration, getVideoGenerationStatus, listVideoGenerationJobs } from '../native-video-generation.ts'
import { pickMediaAssets, revealMediaAsset } from '../native.ts'

const props = defineProps<{ native: boolean; active: boolean; projectTitle: string; disabled?: boolean }>()
const emit = defineEmits<{ 'busy-change': [busy: boolean]; status: [message: string]; 'open-mcp': []; 'open-models': [provider: 'video']; 'add-asset': [asset: MediaAsset]; 'add-timeline': [asset: MediaAsset] }>()
const draftKey = 'open-media:video-generation-draft:v1'
const modes: { id: VideoGenerationMode; title: string; icon: string; detail: string }[] = [
  { id: 'prompt', title: '提示词', icon: 'text', detail: '描述场景、动作、镜头与声音' },
  { id: 'image', title: '首尾帧', icon: 'image', detail: '让图片动起来，或连接首尾画面' },
  { id: 'reference', title: '参考素材', icon: 'layers', detail: '使用图片、视频和声音作为参考' },
  { id: 'storyboard', title: '分镜', icon: 'film', detail: '分别描述每个镜头，按顺序生成' },
]
const mode = ref<VideoGenerationMode>('prompt'), modelId = ref(''), shots = ref<VideoGenerationShot[]>([newShot()])
const size = ref('512x512'), steps = ref(20), seed = ref(42), lowMemory = ref(true), joinShots = ref(true)
const catalog = ref<VideoGenerationStatus>(), checking = ref(false), error = ref(''), pollError = ref(''), draftError = ref('')
const jobs = ref<VideoGenerationJob[]>([]), selectedJobId = ref(''), selectedAssetId = ref(''), cancelling = ref('')
const starting = ref(false), elapsedNow = ref(Date.now()), jobRequests = ref<Record<string, VideoGenerationRequest>>({})
let pollTimer: ReturnType<typeof setTimeout> | undefined, clockTimer: ReturnType<typeof setInterval> | undefined, draftTimer: ReturnType<typeof setTimeout> | undefined
let destroyed = false, refreshing = false
const selectedModel = computed(() => catalog.value?.models.find(item => item.id === modelId.value))
const modeAvailable = (value: VideoGenerationMode) => !selectedModel.value || selectedModel.value.modes.includes(value)
const activeJobs = computed(() => jobs.value.filter(job => job.state === 'running'))
const working = computed(() => starting.value || activeJobs.value.length > 0)
const busy = computed(() => working.value)
const shownShots = computed(() => mode.value === 'storyboard' ? shots.value : shots.value.slice(0, 1))
const selectedJob = computed(() => jobs.value.find(job => job.id === selectedJobId.value) ?? jobs.value[0])
const results = computed(() => selectedJob.value ? [...(selectedJob.value.combinedAsset ? [selectedJob.value.combinedAsset] : []), ...selectedJob.value.assets] : [])
const previewAsset = computed(() => results.value.find(asset => asset.id === selectedAssetId.value) ?? results.value[0])
const invalid = computed(() => videoGenerationRequestError(makeRequest('validation')))
const unavailable = computed(() => !props.native ? '视频生成需要 Apple 芯片 Mac 桌面端。' : catalog.value && !catalog.value.supported ? catalog.value.reason || '当前设备不支持本地视频生成。' : !selectedModel.value ? '请等待模型检查完成。' : !modeAvailable(mode.value) ? '当前模型不支持此生成方式，请切换模型。' : selectedModel.value.state !== 'ready' ? '请前往 Info 下载所选模型。' : !catalog.value?.runtimeReady ? '视频生成组件尚未就绪，请前往 Info 检查模型。' : '')
const canGenerate = computed(() => !props.disabled && !working.value && !unavailable.value && !invalid.value)
watch(busy, value => emit('busy-change', value), { immediate: true })
watch(results, values => { if (!values.some(asset => asset.id === selectedAssetId.value)) selectedAssetId.value = values[0]?.id || '' })
watch(() => props.active, active => { if (active) void refresh(); else document.querySelector<HTMLVideoElement>('[data-testid="generation-preview"]')?.pause() })

function newShot(): VideoGenerationShot { return { id: crypto.randomUUID(), title: '', prompt: '', seconds: 1 } }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function percent(value?: number): number { return Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100) }
function time(value: number): string { const seconds = Math.max(0, Math.floor(value)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` }
function elapsed(job: VideoGenerationJob): string { return time(job.state === 'running' ? Math.max(job.elapsedSeconds || 0, (elapsedNow.value - job.startedAt) / 1000) : job.elapsedSeconds || 0) }
function jobState(job: VideoGenerationJob): string { return ({ running: '生成中', completed: '已完成', failed: '生成失败', cancelled: '已取消' })[job.state] }
function modelState(model: VideoGenerationModel): string { return ({ 'not-downloaded': '待下载', downloading: '下载中', verifying: '校验中', ready: '已就绪', failed: '未完成', unsupported: '不支持', 'update-available': '可更新' })[model.state] }
function chooseModel(model: VideoGenerationModel): void { modelId.value = model.id; if (!model.modes.includes(mode.value)) mode.value = model.modes[0] || 'prompt' }
function makeRequest(requestId: string = crypto.randomUUID()): VideoGenerationRequest {
  const [width = 512, height = 288] = size.value.split('x').map(Number)
  const selected = shownShots.value.map(shot => ({ ...shot, ...(mode.value === 'prompt' ? { firstFrame: undefined, lastFrame: undefined, references: undefined } : mode.value === 'reference' ? { firstFrame: undefined, lastFrame: undefined } : { references: undefined }) }))
  return { requestId, modelId: modelId.value, mode: mode.value, width, height, steps: steps.value, seed: seed.value, lowMemory: lowMemory.value, joinShots: mode.value === 'storyboard' && joinShots.value, shots: selected }
}
function persistDraft(): void {
  try { localStorage.setItem(draftKey, JSON.stringify({ mode: mode.value, modelId: modelId.value, shots: shots.value, size: size.value, steps: steps.value, seed: seed.value, lowMemory: lowMemory.value, joinShots: joinShots.value })); draftError.value = '' }
  catch { draftError.value = '生成草稿未能保存到本机；关闭应用前请保留提示词。' }
}
function restoreDraft(): void {
  try {
    const raw = localStorage.getItem(draftKey)
    if (!raw) return
    const value = JSON.parse(raw)
    if (modes.some(item => item.id === value.mode)) mode.value = value.mode
    if (typeof value.modelId === 'string') modelId.value = value.modelId
    if (Array.isArray(value.shots) && value.shots.length) {
      const validAsset = (asset: unknown): asset is MediaAsset => !!asset && typeof asset === 'object' && typeof (asset as MediaAsset).id === 'string' && typeof (asset as MediaAsset).name === 'string' && typeof (asset as MediaAsset).url === 'string' && ['image', 'video', 'audio'].includes((asset as MediaAsset).kind) && ['duration', 'width', 'height', 'size'].every(key => Number.isFinite((asset as unknown as Record<string, unknown>)[key]))
      const restored = value.shots.filter((shot: unknown) => !!shot && typeof shot === 'object').slice(0, VIDEO_GENERATION_MAX_SHOTS).map((shot: VideoGenerationShot) => ({
        id: crypto.randomUUID(), title: String(shot.title || '').slice(0, 120), prompt: String(shot.prompt || '').slice(0, 8000), seconds: Number.isFinite(shot.seconds) ? shot.seconds : 1,
        firstFrame: validAsset(shot.firstFrame) && shot.firstFrame.kind === 'image' ? shot.firstFrame : undefined,
        lastFrame: validAsset(shot.lastFrame) && shot.lastFrame.kind === 'image' ? shot.lastFrame : undefined,
        references: Array.isArray(shot.references) ? shot.references.filter(reference => reference && validAsset(reference.asset) && reference.kind === reference.asset.kind).slice(0, 12).map(reference => ({ ...reference, includeAudio: reference.includeAudio === true })) : undefined,
      }))
      if (restored.length) shots.value = restored
    }
    if (['512x288', '288x512', '512x512', '768x448', '448x768', '1344x768', '768x1344'].includes(value.size)) size.value = value.size
    if (Number.isInteger(value.steps)) steps.value = value.steps
    if (Number.isSafeInteger(value.seed)) seed.value = value.seed
    lowMemory.value = value.lowMemory !== false; joinShots.value = value.joinShots !== false
  } catch { draftError.value = '上次生成草稿无法读取，已使用默认设置。' }
}
restoreDraft()
watch([mode, modelId, shots, size, steps, seed, lowMemory, joinShots], () => { clearTimeout(draftTimer); draftTimer = setTimeout(persistDraft, 400) }, { deep: true })
async function refresh(): Promise<void> {
  if (destroyed || refreshing) return
  refreshing = true; checking.value = !catalog.value
  try {
    const [next, nextJobs] = await Promise.all([getVideoGenerationStatus(), listVideoGenerationJobs()])
    if (destroyed) return
    catalog.value = next; jobs.value = nextJobs.slice().sort((a, b) => b.startedAt - a.startedAt); pollError.value = ''
    if (!next.models.some(item => item.id === modelId.value)) { const candidate = next.models.find(item => item.modes.includes(mode.value)); modelId.value = candidate?.id || next.models[0]?.id || '' }
  } catch (cause) { if (!destroyed) pollError.value = message(cause) }
  finally {
    refreshing = false; checking.value = false; clearTimeout(pollTimer)
    if (!destroyed && props.native) pollTimer = setTimeout(() => void refresh(), busy.value || props.active ? 1500 : 5000)
  }
}
async function selectFrame(shot: VideoGenerationShot, field: 'firstFrame' | 'lastFrame'): Promise<void> {
  if (!props.native || working.value) return
  try { const selected = await pickMediaAssets(); if (!selected.length) return; const image = selected.find(asset => asset.kind === 'image'); if (!image) throw new Error('请选择图片作为首帧或尾帧。'); shot[field] = image; error.value = '' }
  catch (cause) { error.value = message(cause) }
}
async function selectReferences(shot: VideoGenerationShot): Promise<void> {
  if (!props.native || working.value) return
  try { const selected = await pickMediaAssets(); shot.references = [...(shot.references ?? []), ...selected.map(asset => ({ asset, kind: asset.kind, includeAudio: false }))]; error.value = '' }
  catch (cause) { error.value = message(cause) }
}
function moveShot(index: number, delta: number): void { const target = index + delta; if (target < 0 || target >= shots.value.length) return; const shot = shots.value.splice(index, 1)[0]!; shots.value.splice(target, 0, shot) }
async function generate(retry?: VideoGenerationRequest): Promise<void> {
  if (working.value || props.disabled) return
  const request = retry ? { ...retry, requestId: crypto.randomUUID() } : makeRequest()
  const validation = videoGenerationRequestError(request)
  const model = catalog.value?.models.find(item => item.id === request.modelId)
  const readiness = !catalog.value?.supported || !catalog.value.runtimeReady || model?.state !== 'ready' ? '请前往 Info 完成模型准备并检查当前设备。' : !model.modes.includes(request.mode) ? '所选模型不支持此生成方式。' : ''
  if (validation || readiness) { error.value = validation || readiness; return }
  starting.value = true; error.value = ''; persistDraft()
  try { const job = await beginVideoGeneration(request); jobRequests.value[job.id] = JSON.parse(JSON.stringify(request)); jobs.value = [job, ...jobs.value.filter(item => item.id !== job.id)]; selectedJobId.value = job.id; emit('status', '视频生成已开始，可在任务区查看进度。') }
  catch (cause) { error.value = message(cause) }
  finally { starting.value = false; void refresh() }
}
async function cancelJob(job: VideoGenerationJob): Promise<void> {
  cancelling.value = job.id
  try { await cancelVideoGeneration(job.id); await refresh() }
  catch (cause) { error.value = message(cause) }
  finally { cancelling.value = '' }
}
async function reveal(asset: MediaAsset): Promise<void> { try { await revealMediaAsset(asset) } catch (cause) { error.value = message(cause) } }
onMounted(() => { void refresh(); clockTimer = setInterval(() => { if (activeJobs.value.length) elapsedNow.value = Date.now() }, 1000) })
onBeforeUnmount(() => { destroyed = true; clearTimeout(pollTimer); clearTimeout(draftTimer); clearInterval(clockTimer); persistDraft(); emit('busy-change', false) })
</script>

<template>
  <ToolWorkspace class="generation-workspace" data-testid="video-generation-workspace" title="视频生成" icon="sparkles" description="从一句描述到一组镜头，让灵感成为可剪辑的素材。" library-label="生成任务" settings-label="生成设置">
    <template #actions><button :disabled="!native" title="配置 MCP 服务" aria-label="配置视频生成 MCP 服务" @click="emit('open-mcp')"><Icon name="mcp" /><span>MCP</span></button></template>
    <template #library>
      <div class="generation-library-heading"><h2>生成任务</h2><small>{{ jobs.length }} 个任务</small></div>
      <div v-if="jobs.length" class="generation-job-list"><article v-for="job in jobs" :key="job.id" class="generation-job" :class="{ selected: selectedJob?.id === job.id }" :data-job-id="job.id"><button class="generation-job-select" :aria-pressed="selectedJob?.id === job.id" @click="selectedJobId = job.id"><span><Icon :name="job.state === 'running' ? 'clock' : job.state === 'completed' ? 'check' : 'alert'" :size="15" /><strong>{{ jobState(job) }}</strong></span><time>{{ new Date(job.startedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</time></button><p>{{ job.stage }}<template v-if="job.shotCount > 1"> · 镜头 {{ Math.min(job.shotCount, job.shotIndex + 1) }}/{{ job.shotCount }}</template></p><progress v-if="job.state === 'running'" :value="job.progress === undefined ? undefined : percent(job.progress)" max="100" aria-label="视频生成进度" /><div class="generation-job-metrics"><small>用时 {{ elapsed(job) }}<template v-if="job.progress !== undefined"> · {{ percent(job.progress) }}%</template></small><button v-if="job.state === 'running'" :disabled="cancelling === job.id" @click="cancelJob(job)">{{ cancelling === job.id ? '正在取消…' : '取消生成' }}</button><button v-else-if="(job.state === 'failed' || job.state === 'cancelled') && jobRequests[job.id]" :disabled="working || disabled || !catalog?.supported || !catalog.runtimeReady" @click="generate(jobRequests[job.id])">重新生成</button></div><p v-if="job.error" class="generation-error">{{ job.error }}</p><p v-if="job.warning" class="generation-muted">{{ job.warning }}</p></article></div>
      <p v-else class="generation-library-empty">暂无生成任务。填写提示词后，点击开始生成。</p>
    </template>
    <div class="generation-content">
      <p v-if="!native || catalog && !catalog.supported" class="generation-notice" role="status"><Icon name="info" :size="17" />{{ catalog?.reason || '视频生成需要 Apple 芯片 Mac 桌面端；其他平台可查看设置。' }}</p>
    <p v-if="pollError || error || draftError" class="generation-error" role="alert">{{ error || pollError || draftError }} <button v-if="pollError" @click="refresh">重新检查</button></p>
      <section class="generation-preview-card" aria-label="生成结果预览"><h2>生成预览</h2>
        <div v-if="previewAsset" class="generation-preview"><video :key="previewAsset.id" :src="previewAsset.url" controls playsinline preload="metadata" data-testid="generation-preview" /><label v-if="results.length > 1">查看结果<select v-model="selectedAssetId" aria-label="查看生成结果"><option v-for="asset in results" :key="asset.id" :value="asset.id">{{ asset.id === selectedJob?.combinedAsset?.id ? '完整视频 · ' : '' }}{{ asset.name }}</option></select></label><strong>{{ previewAsset.name }}</strong><small>{{ previewAsset.width }} × {{ previewAsset.height }} · {{ previewAsset.duration.toFixed(2) }} 秒</small><div class="generation-result-actions"><button :disabled="disabled" @click="emit('add-asset', previewAsset)"><Icon name="import" :size="14" />加入素材</button><button :disabled="disabled" @click="emit('add-timeline', previewAsset)"><Icon name="plus" :size="14" />加入时间线</button><button :disabled="!previewAsset.nativePath" title="打开文件夹" aria-label="打开生成视频文件夹" @click="reveal(previewAsset)"><Icon name="folder" :size="15" /></button></div><p class="generation-muted">添加至当前项目：{{ projectTitle }}</p></div>
        <div v-else class="generation-empty"><Icon name="film" :size="36" /><strong>从这里开启一段新画面</strong><p>生成过程中可切换工作区。完成后预览视频，再加入当前项目。</p></div>
      </section>
      <section class="generation-input"><div class="generation-modes" role="group" aria-label="生成方式"><button v-for="item in modes" :key="item.id" :aria-pressed="mode === item.id" :disabled="working || !modeAvailable(item.id)" :title="!modeAvailable(item.id) ? '请先切换支持此方式的模型' : item.detail" @click="mode = item.id"><Icon :name="item.icon" :size="15" />{{ item.title }}</button></div>
          <p class="generation-muted">{{ modes.find(item => item.id === mode)?.detail }}</p>
          <div class="generation-shots"><article v-for="(shot, index) in shownShots" :key="shot.id" class="generation-shot" :data-shot-id="shot.id">
            <header v-if="mode === 'storyboard'"><span>镜头 {{ index + 1 }}</span><input v-model="shot.title" :disabled="working" maxlength="120" :aria-label="`镜头 ${index + 1} 名称`" placeholder="镜头名称" /><button :disabled="working || !index" :aria-label="`上移镜头 ${index + 1}`" title="上移" @click="moveShot(index, -1)"><Icon name="chevron-up" :size="14" /></button><button :disabled="working || index === shots.length - 1" :aria-label="`下移镜头 ${index + 1}`" title="下移" @click="moveShot(index, 1)"><Icon name="chevron-down" :size="14" /></button><button :disabled="working || shots.length === 1" :aria-label="`移除镜头 ${index + 1}`" title="移除镜头" @click="shots.splice(index, 1)"><Icon name="trash" :size="14" /></button></header>
            <textarea v-model="shot.prompt" :disabled="working" :aria-label="mode === 'storyboard' ? `镜头 ${index + 1} 提示词` : '视频提示词'" :rows="mode === 'storyboard' ? 3 : 5" maxlength="8000" placeholder="例如：清晨，阳光穿过薄雾照亮山间湖泊。镜头缓慢向前推进，水面泛起涟漪，远处传来轻柔的鸟鸣。" />
            <div v-if="mode === 'image' || mode === 'storyboard'" class="generation-frames"><div v-for="field in (['firstFrame', 'lastFrame'] as const)" :key="field" class="generation-frame"><button :disabled="!native || working" :aria-label="`选择${index + 1}号镜头${field === 'firstFrame' ? '首帧' : '尾帧'}`" @click="selectFrame(shot, field)"><img v-if="shot[field]" :src="shot[field]?.url" :alt="shot[field]?.name" /><Icon v-else name="image" :size="22" /><span>{{ field === 'firstFrame' ? '首帧' : '尾帧' }}{{ mode === 'storyboard' ? '（可选）' : '' }}</span><small v-if="shot[field]">{{ shot[field]?.name }}</small></button><button v-if="shot[field]" class="generation-frame-remove" :disabled="working" :aria-label="`移除${index + 1}号镜头${field === 'firstFrame' ? '首帧' : '尾帧'}`" @click="delete shot[field]"><Icon name="close" :size="13" /></button></div></div>
            <div v-if="mode === 'reference'" class="generation-references"><button :disabled="!native || working || (shot.references?.length || 0) >= 12" @click="selectReferences(shot)"><Icon name="plus" :size="15" />选择参考素材</button><p class="generation-muted">最多 9 张图片、3 段视频，合计最多 12 项。音视频每段 2–15 秒，视频和音频各自总长最多 15 秒；参考视频的声音时，生成时长至少 2 秒。</p><div v-for="(reference, position) in shot.references" :key="`${reference.asset.id}-${position}`" class="generation-reference"><Icon :name="reference.kind" :size="15" /><span :title="reference.asset.name">{{ reference.asset.name }}</span><label v-if="reference.kind === 'video'"><input v-model="reference.includeAudio" type="checkbox" :disabled="working" />参考声音</label><button :disabled="working" :aria-label="`移除参考 ${reference.asset.name}`" @click="shot.references?.splice(position, 1)"><Icon name="close" :size="13" /></button></div></div>
            <footer><label>时长 <input v-model.number="shot.seconds" :disabled="working" type="number" min="1" max="15" step="0.5" :aria-label="`镜头 ${index + 1} 时长`" />秒</label><small>实际约 {{ videoGenerationActualSeconds(shot.seconds || 1).toFixed(2) }} 秒 · 24 fps</small></footer>
          </article></div>
          <div v-if="mode === 'storyboard'" class="generation-story-actions"><button :disabled="working || shots.length >= VIDEO_GENERATION_MAX_SHOTS" @click="shots.push(newShot())"><Icon name="plus" :size="15" />新增镜头 {{ shots.length }}/{{ VIDEO_GENERATION_MAX_SHOTS }}</button><label><input v-model="joinShots" :disabled="working" type="checkbox" />合并为连续视频</label><small>逐镜结果始终保留</small></div>
        </section>
    </div>
    <template #settings>
      <div class="generation-settings"><h2>生成设置</h2>
        <section class="generation-models"><header><h2>生成模型</h2><button class="icon-button" title="重新检查模型" aria-label="重新检查模型" :disabled="checking" @click="refresh"><Icon name="refresh" :size="16" /></button></header>
          <p v-if="checking" class="generation-muted"><span class="spinner small" />正在检查模型与设备…</p>
          <p v-else-if="!catalog?.models.length" class="generation-muted">依靠 MiniMax H3 模型在本机生成视频，模型在 Info 中管理。</p>
          <div class="generation-model-list"><article v-for="model in catalog?.models" :key="model.id" :data-model-id="model.id" class="generation-model" :class="{ selected: model.id === modelId }">
            <button class="generation-model-select" :aria-pressed="model.id === modelId" :aria-label="`选择 ${model.name}`" :disabled="working" @click="chooseModel(model)"><Icon :name="model.state === 'ready' ? 'check' : 'download'" :size="18" /><span><strong>{{ model.name }}</strong><small>{{ modelState(model) }}</small></span><span class="generation-radio" /></button>
            <p>{{ model.modes.map(id => modes.find(item => item.id === id)?.title).join(' · ') }}</p>
            <p v-if="model.error" class="generation-error">{{ model.error }}</p>
            <button v-if="model.state !== 'ready'" class="generation-model-link" :disabled="!native || working" :aria-label="`前往 Info 管理 ${model.name}`" @click="emit('open-models', 'video')"><Icon name="info" :size="14" />{{ model.state === 'not-downloaded' ? '请前往下载' : '前往模型管理' }}</button>
          </article></div>
          <p v-if="selectedModel" class="generation-muted">依靠 {{ selectedModel.name }} 模型生成。</p><button class="generation-model-link generation-model-manager" :disabled="!native" @click="emit('open-models', 'video')"><Icon name="info" :size="14" />在 Info 中管理模型</button>
        </section>
        <div class="generation-parameters"><label>画面尺寸<select v-model="size" :disabled="working" aria-label="生成画面尺寸"><option value="512x288">横屏 512 × 288</option><option value="288x512">竖屏 288 × 512</option><option value="512x512">方形 512 × 512</option><option value="768x448">横屏 768 × 448</option><option value="448x768">竖屏 448 × 768</option><option value="1344x768">横屏 1344 × 768</option><option value="768x1344">竖屏 768 × 1344</option></select></label><label>生成步数<input v-model.number="steps" :disabled="working" aria-label="生成步数" type="number" min="4" max="50" /></label><label>随机种子<input v-model.number="seed" :disabled="working" aria-label="随机种子" type="number" min="0" max="4294967295" /></label></div>
          <label class="generation-low-memory"><input v-model="lowMemory" :disabled="working" type="checkbox" />低内存模式 <small>降低内存占用，需要更多磁盘读取时间</small></label>
          <div class="generation-submit"><p class="generation-muted">{{ unavailable || invalid || '生成在本机进行，首次加载大型模型可能较慢。' }}</p><button class="primary" :disabled="!canGenerate" data-testid="generation-start" @click="generate()"><span v-if="starting" class="spinner small" /><Icon v-else name="sparkles" :size="16" />{{ starting ? '正在启动…' : '开始生成' }}</button></div>
      </div>
    </template>
  </ToolWorkspace>
</template>

<style scoped>
.generation-models,.generation-input,.generation-output{min-width:0}
.generation-models>header,.generation-output>header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.generation-model-list{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.generation-model{border:1px solid var(--ui-line);border-radius:9px;padding:11px;min-width:0;background:var(--ui-surface-2)}
.generation-model.selected{border-color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 4%,var(--ui-surface))}
.generation-model-select{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;text-align:left;padding:0;min-height:40px}
.generation-model-select>svg{color:var(--ui-accent);flex:none}
.generation-model-select>span:nth-child(2){display:grid;gap:5px;flex:1;min-width:0}
.generation-model-select strong{font-size:11px;overflow-wrap:anywhere}
.generation-radio{width:13px;height:13px;border:1px solid var(--ui-border-strong);border-radius:50%;flex:none}
.selected .generation-radio{border:4px solid var(--ui-accent)}
.generation-model p{font-size:10px;line-height:1.6;color:var(--ui-muted);margin:9px 0}
.generation-job-metrics{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.generation-job-metrics button{font-size:10px;padding:4px 8px}
.generation-muted{font-size:11px;color:var(--ui-muted);line-height:1.7;margin:9px 0}
.generation-notice{display:flex;align-items:center;gap:8px;margin:0;padding:10px 12px;border:1px solid var(--ui-line);background:var(--ui-accent-soft);border-radius:8px;font-size:11px;line-height:1.7}
.generation-error{font-size:11px!important;line-height:1.7;color:var(--ui-danger)!important;overflow-wrap:anywhere;white-space:pre-wrap}
.generation-error button{display:inline-flex;margin-left:8px;font-size:10px}
.generation-modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px}
.generation-modes button{font-size:11px;padding:8px 5px;gap:5px;white-space:nowrap}
.generation-modes button[aria-pressed=true]{color:var(--ui-accent);background:var(--ui-accent-soft);border-color:var(--ui-accent)}
.generation-shots{display:grid;gap:12px}
.generation-shot{min-width:0}
.generation-shot>header{display:flex;align-items:center;gap:5px;margin:4px 0 8px}
.generation-shot>header>span{font-size:11px;white-space:nowrap;margin-right:4px}
.generation-shot>header input{min-width:0;width:100%;flex:1;height:30px;font-size:11px}
.generation-shot>header button{padding:5px;flex:none}
.generation-shot textarea{display:block;resize:vertical;min-height:92px;width:100%;font-size:12px;line-height:1.8;padding:10px 12px;border:1px solid var(--ui-line);border-radius:8px;background:var(--ui-surface-2);color:var(--ui-text);font-family:inherit}
.generation-shot>footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin:9px 0 0}
.generation-shot>footer label{display:flex;gap:6px;align-items:center;font-size:11px}
.generation-shot>footer input{width:64px;height:30px;font-size:11px}
.generation-frames{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:10px}
.generation-frame{position:relative;min-width:0}
.generation-frame>button:first-child{width:100%;min-height:80px;display:flex;flex-direction:column;gap:7px;font-size:11px;padding:10px;border-style:dashed;background:var(--ui-surface-2)}
.generation-frame img{max-height:90px;max-width:100%;object-fit:contain}
.generation-frame small{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.generation-frame-remove{position:absolute;right:5px;top:5px;padding:4px;background:var(--ui-surface)}
.generation-references{margin:10px 0}
.generation-references>button{font-size:11px}
.generation-reference{display:flex;align-items:center;gap:7px;font-size:11px;border-bottom:1px solid var(--ui-line);padding:8px 0}
.generation-reference>span{flex:1;min-width:0;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}
.generation-reference label{display:flex;gap:5px;align-items:center;font-size:10px;white-space:nowrap}
.generation-reference button{padding:3px}
.generation-story-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:14px;font-size:10px}
.generation-story-actions button{font-size:11px}
.generation-story-actions label,.generation-low-memory{display:flex;align-items:center;gap:6px;font-size:11px}
.generation-parameters{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;padding-top:16px;border-top:1px solid var(--ui-line)}
.generation-parameters label{display:grid;gap:7px;font-size:11px;min-width:0}
.generation-parameters input,.generation-parameters select{width:100%;min-width:0}
.generation-parameters input{height:var(--ui-control-height);font-size:var(--ui-control-font-size)}
.generation-low-memory{flex-wrap:wrap;line-height:1.7;margin:0}
.generation-submit{display:grid;gap:12px;border-top:1px solid var(--ui-line);padding-top:14px}
.generation-submit>button{width:100%;font-size:12px;min-height:38px;padding:9px 13px}
.generation-submit p{font-size:10px;margin:0}
.generation-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:13px;height:clamp(220px,36vh,480px);text-align:center;color:var(--ui-muted);padding:20px;border-radius:8px;background:var(--ui-surface-2)}
.generation-empty>svg{color:var(--ui-accent);opacity:.6}
.generation-empty strong{font-size:13px;font-weight:500}
.generation-empty p{font-size:11px;line-height:1.8;max-width:240px;margin:0}
.generation-job-list{display:flex;flex-direction:column;gap:8px;min-width:0}
.generation-job{flex-shrink:0;padding:10px;border:1px solid var(--ui-line);border-radius:8px;min-width:0}
.generation-job.selected{border-color:var(--ui-accent)}
.generation-job-select{padding:0;border:0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;width:100%;background:transparent;text-align:left}
.generation-job-select>span{display:flex;align-items:center;gap:7px;font-size:11px}
.generation-job-select strong{font-weight:600}
.generation-job-select time{font-size:10px;color:var(--ui-muted)}
.generation-job>p{font-size:10px;color:var(--ui-muted);line-height:1.6;margin:8px 0}
.generation-preview{display:grid;gap:10px;min-width:0}
.generation-preview video{display:block;width:100%;height:clamp(220px,36vh,480px);object-fit:contain;background:#111724;border-radius:8px}
.generation-preview>strong{font-size:12px;overflow-wrap:anywhere}
.generation-preview>label{display:grid;gap:7px;font-size:11px}
.generation-preview select{width:100%}
.generation-result-actions{display:flex;gap:7px;flex-wrap:wrap}
.generation-result-actions button{font-size:11px;white-space:nowrap}
.generation-result-actions>button:last-child{margin-left:auto}
.generation-preview .generation-muted{margin:0;font-size:10px}
.generation-model-link{font-size:11px;color:var(--ui-accent);margin-top:4px}
.generation-content{display:grid;gap:16px;min-width:0}
.generation-workspace h2{font-size:13px;font-weight:600;margin:0}
.generation-workspace small{font-size:10px;color:var(--ui-muted)}
.generation-workspace input[type=checkbox]{accent-color:var(--ui-accent);width:14px;height:14px;flex:none;margin:0}
.generation-workspace progress{display:block;width:100%;height:5px;margin:9px 0;border:0;border-radius:5px;accent-color:var(--ui-accent);overflow:hidden}
.generation-workspace progress::-webkit-progress-bar{background:var(--ui-line)}
.generation-workspace progress::-webkit-progress-value{background:var(--ui-accent)}
.generation-library-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.generation-library-empty{font-size:11px;line-height:1.8;color:var(--ui-muted);margin:18px 0}
.generation-preview-card>h2{margin-bottom:12px}
.generation-input{border-top:1px solid var(--ui-line);padding-top:16px}
.generation-settings{display:grid;gap:16px;min-width:0}
.generation-model-manager{width:100%}
.generation-low-memory small{width:100%;padding-left:20px}

</style>
