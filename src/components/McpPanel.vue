<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { getMcpConfig, getMcpStatus, startMcpService, stopMcpService, type McpConfig, type McpPanelJob, type McpStatus } from '../native-mcp'
import type { Project } from '../core/types'
import { getMcpMotionBrief, normalizeMcpMotion, MAX_MCP_MOTION_ASSETS, MAX_MCP_MOTION_PROMPT, type McpMotionConfig } from '../core/mcp-motion'
import { projectSourceAssets } from '../core/editor-assets'
import { MOTION_STYLES } from '../core/motion-style-catalog'
import { drawMotionStylePoster } from '../core/motion-style-art'
import EditorDialog from './EditorDialog.vue'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ open: boolean; native: boolean; jobs?: McpPanelJob[]; project?: Project; editingBusy?: boolean }>(), { jobs: () => [] })
const emit = defineEmits<{ close: []; status: [message: string]; serviceChange: [status: McpStatus]; cancelJob: [id: string]; motionChange: [config: McpMotionConfig] }>()
const config = ref<McpConfig>()
const service = ref<McpStatus>({ running: false, host: '127.0.0.1', port: 39861, url: null, pendingRequests: 0, connectedClients: 0 })
const loading = ref(false), busy = ref(false), configReady = ref(false)
const error = ref(''), statusError = ref(''), notice = ref(''), lastEndpoint = ref('')
let timer: ReturnType<typeof setTimeout> | undefined, revision = 0, disposed = false
const blocked = computed(() => loading.value || busy.value || !props.native)
const endpoint = computed(() => {
  if (service.value.running) return service.value.url || ''
  if (lastEndpoint.value) return lastEndpoint.value
  if (!config.value) return ''
  const host = config.value.host === '0.0.0.0' ? '127.0.0.1' : config.value.host === '::' ? '::1' : config.value.host
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.value.port}/mcp`
})
const canCopy = computed(() => !blocked.value && !statusError.value && configReady.value && service.value.running && !!service.value.url && !!config.value?.token)
const stateLabel = computed(() => loading.value ? '正在读取…' : busy.value ? '正在更新…' : statusError.value ? '状态暂不可用' : service.value.running ? '运行中' : '未启动')
const feedback = computed(() => error.value || statusError.value || notice.value)
const motion = computed(() => normalizeMcpMotion(props.project?.mcpMotion))
const motionBrief = computed(() => props.project ? getMcpMotionBrief(props.project) : undefined)
const motionBlocked = computed(() => blocked.value || !!props.editingBusy || props.jobs.some(job => job.state === 'running') || service.value.pendingRequests > 0)
const motionAssets = computed(() => props.project ? projectSourceAssets(props.project).filter(asset => asset.kind === 'image' || asset.kind === 'video') : [])
const assetSearch = ref('')
const visibleMotionAssets = computed(() => motionAssets.value.filter(asset => asset.name.toLocaleLowerCase().includes(assetSearch.value.toLocaleLowerCase())))
const selectedMotionIds = computed(() => new Set(motionBrief.value?.assetIds || []))
const invalidMotionSelection = computed(() => motion.value.assetIds.length > selectedMotionIds.value.size)
const motionStyle = computed(() => MOTION_STYLES.find(style => style.id === motion.value.styleId))
const drawnPosters = new WeakMap<HTMLCanvasElement, string>()
function poster(element: unknown, styleId: string): void {
  if (!(element instanceof HTMLCanvasElement) || drawnPosters.get(element) === styleId) return
  drawMotionStylePoster(element, styleId); drawnPosters.set(element, styleId)
}
function changeMotion(patch: Partial<McpMotionConfig>): void {
  if (!props.project || motionBlocked.value) return
  emit('motionChange', normalizeMcpMotion({ ...motion.value, ...patch }))
}
function toggleMotionAsset(id: string): void {
  if (motionBlocked.value) return
  const ids = [...selectedMotionIds.value]
  if (!ids.includes(id) && ids.length >= MAX_MCP_MOTION_ASSETS) return
  changeMotion({ assetIds: ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id] })
}
watch(() => props.project?.id, () => { assetSearch.value = '' })
function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function currentView(current: number): boolean { return !disposed && props.open && props.native && current === revision }
function applyStatus(next: McpStatus): void {
  service.value = next
  if (next.running && next.url) lastEndpoint.value = next.url
}
function stopPoll(): void { clearTimeout(timer); timer = undefined }
function schedulePoll(): void {
  stopPoll()
  if (!disposed && props.open && props.native) timer = setTimeout(() => void poll(), 1500)
}
async function readState(current: number): Promise<void> {
  const [nextConfig, nextStatus] = await Promise.allSettled([getMcpConfig(), getMcpStatus()])
  if (!currentView(current)) return
  if (nextStatus.status === 'fulfilled') { applyStatus(nextStatus.value); emit('serviceChange', nextStatus.value) }
  if (nextConfig.status === 'fulfilled') config.value = { ...nextConfig.value }
  configReady.value = nextConfig.status === 'fulfilled' && nextStatus.status === 'fulfilled'
    && (!nextStatus.value.running || nextConfig.value.host === nextStatus.value.host && nextConfig.value.port === nextStatus.value.port)
  const failure = nextConfig.status === 'rejected' ? nextConfig.reason : nextStatus.status === 'rejected' ? nextStatus.reason : undefined
  statusError.value = failure ? `无法读取连接信息：${errorText(failure)}` : !configReady.value ? '正在同步连接信息…' : ''
}
async function poll(): Promise<void> {
  const current = revision
  if (!currentView(current)) return
  try { if (!busy.value && !loading.value) await readState(current) }
  finally { if (current === revision) schedulePoll() }
}
async function load(): Promise<void> {
  const current = ++revision
  stopPoll(); error.value = ''; notice.value = ''; statusError.value = ''; configReady.value = false
  if (!props.native) { loading.value = false; return }
  loading.value = true
  try { await readState(current) }
  finally { if (current === revision) { loading.value = false; schedulePoll() } }
}
async function toggleService(): Promise<void> {
  if (blocked.value) return
  const current = ++revision, stopping = service.value.running
  busy.value = true; configReady.value = false; error.value = ''; notice.value = ''; stopPoll()
  try {
    const next = await (stopping ? stopMcpService() : startMcpService())
    // The actual service transition must reach the app even if this dialog closed meanwhile.
    if (!disposed) emit('serviceChange', next)
    if (currentView(current)) {
      applyStatus(next)
      await readState(current)
      if (currentView(current)) emit('status', next.running ? 'MCP 服务已启动。' : 'MCP 服务已停止。')
    }
  } catch (cause) { if (currentView(current)) error.value = errorText(cause) }
  finally {
    busy.value = false
    if (!disposed && props.open && current !== revision) void load()
    else schedulePoll()
  }
}
async function copyConfig(): Promise<void> {
  if (!canCopy.value) return
  const value = JSON.stringify({ mcpServers: { 'open-media': { type: 'http', url: service.value.url, headers: { Authorization: `Bearer ${config.value!.token}` } } } }, null, 2)
  const current = revision
  error.value = ''; notice.value = ''
  try {
    if (!navigator.clipboard?.writeText) throw new Error('系统剪贴板暂不可用。')
    await navigator.clipboard.writeText(value)
    if (currentView(current)) notice.value = '配置已复制'
  } catch (cause) { if (currentView(current)) error.value = `复制失败：${errorText(cause)}` }
}
watch([() => props.open, () => props.native], ([open]) => {
  if (open) void load()
  else { revision++; stopPoll(); loading.value = false }
}, { immediate: true })
onBeforeUnmount(() => { disposed = true; revision++; stopPoll() })
</script>

<template>
  <EditorDialog :open="open" title="MCP 服务" icon="mcp" :wide="!!project && motion.enabled && native" :busy="busy" busy-message="正在更新服务…" @close="emit('close')">
    <section class="mcp-panel" data-testid="mcp-panel" :aria-busy="loading || busy">
      <p v-if="!native" class="mcp-unavailable" role="status">MCP 服务由桌面端提供。</p>
      <template v-else>
        <div class="mcp-status-row"><span class="mcp-indicator" :class="{ running: service.running && !statusError }" /><span role="status">{{ stateLabel }}</span><button type="button" role="switch" class="mcp-switch" aria-label="MCP 服务开关" :aria-checked="service.running" :disabled="blocked" :title="service.running ? '停止 MCP 服务' : '启动 MCP 服务'" data-testid="mcp-service-switch" @click="toggleService"><span /></button></div>
        <label class="mcp-field">地址<input :value="endpoint" readonly aria-label="MCP 连接地址" spellcheck="false" :placeholder="loading ? '正在读取…' : '启动后显示连接地址'" @focus="($event.target as HTMLInputElement).select()" /></label>
        <label class="mcp-field">Token<input :value="configReady ? config?.token || '' : ''" type="text" readonly aria-label="MCP Token" autocomplete="off" spellcheck="false" :placeholder="loading || busy ? '正在读取…' : '连接信息尚未就绪'" @focus="($event.target as HTMLInputElement).select()" /></label>
        <div class="mcp-footer"><p class="mcp-feedback" :class="{ error: error || statusError }" :role="error || statusError ? 'alert' : 'status'">{{ feedback }}</p><button type="button" class="mcp-copy" :disabled="!canCopy" data-testid="mcp-copy-config" @click="copyConfig"><Icon name="copy" :size="14" />复制配置</button></div>
        <section v-if="project" class="mcp-motion" data-testid="mcp-motion-config">
          <div class="mcp-status-row mcp-motion-heading"><Icon name="sparkles" :size="15" /><strong>素材二创</strong><span class="mcp-motion-scope">当前工程</span><button type="button" role="switch" class="mcp-switch" aria-label="素材二创" :aria-checked="motion.enabled" :disabled="motionBlocked" data-testid="mcp-motion-switch" @click="changeMotion({ enabled: !motion.enabled })"><span /></button></div>
          <p class="mcp-motion-description">由外部 Agent 读取配置并编排、生成与剪辑。</p>
          <template v-if="motion.enabled">
            <p v-if="motionBlocked" class="mcp-motion-message" role="status">正在处理任务，完成后可修改二创配置。</p>
            <div class="mcp-motion-options">
              <section class="mcp-motion-sources" aria-label="二创素材">
                <h3>工程素材 <span>{{ selectedMotionIds.size }} / {{ MAX_MCP_MOTION_ASSETS }}</span></h3>
                <input v-if="motionAssets.length" v-model="assetSearch" type="search" class="mcp-motion-search" aria-label="筛选二创素材" placeholder="搜索图片、视频" :disabled="motionBlocked" />
                <div v-if="motionAssets.length" class="mcp-motion-assets" role="group" aria-label="选择二创素材">
                  <button v-for="asset in visibleMotionAssets" :key="asset.id" type="button" role="checkbox" class="mcp-motion-asset" :aria-checked="selectedMotionIds.has(asset.id)" :aria-label="asset.name" :data-motion-asset-id="asset.id" :disabled="motionBlocked || !selectedMotionIds.has(asset.id) && selectedMotionIds.size >= MAX_MCP_MOTION_ASSETS" :title="!selectedMotionIds.has(asset.id) && selectedMotionIds.size >= MAX_MCP_MOTION_ASSETS ? '最多选择 16 个素材，请先取消一个选择' : asset.name" @click="toggleMotionAsset(asset.id)">
                    <span class="mcp-motion-thumb"><img v-if="asset.kind === 'image'" :src="asset.url" alt="" loading="lazy" /><Icon v-else name="video" :size="19" /></span><span class="mcp-motion-asset-label"><strong>{{ asset.name }}</strong><small>{{ asset.kind === 'video' ? '视频' : '图片' }} · {{ asset.width }} × {{ asset.height }}</small></span><span class="mcp-motion-check"><Icon v-if="selectedMotionIds.has(asset.id)" name="check" :size="11" /></span>
                  </button>
                  <p v-if="!visibleMotionAssets.length" class="mcp-motion-message">没有匹配的素材。</p>
                </div>
                <p v-else class="mcp-motion-empty"><Icon name="image" :size="24" /><span>需先在工程导入素材</span><small>已有的图片与视频会显示在这里。</small></p>
                <p v-if="selectedMotionIds.size >= MAX_MCP_MOTION_ASSETS" class="mcp-motion-message" role="status">已达到 16 个素材上限。</p>
              </section>
              <section class="mcp-motion-styles" aria-label="二创风格">
                <h3>视觉风格 <span>15 种</span></h3>
                <div class="mcp-motion-style-grid"><button v-for="style in MOTION_STYLES" :key="style.id" type="button" :aria-label="style.name" :aria-pressed="motion.styleId === style.id" :data-motion-style-id="style.id" :disabled="motionBlocked" :title="style.description" @click="changeMotion({ styleId: style.id })"><canvas :ref="element => poster(element, style.id)" width="240" height="135" aria-hidden="true" /><span>{{ style.name }}</span><Icon v-if="motion.styleId === style.id" name="check" :size="12" /></button></div>
              </section>
            </div>
            <p v-if="motionStyle" class="mcp-motion-style-description">{{ motionStyle.description }}<span v-if="motionStyle.note">{{ motionStyle.note }}</span></p>
            <label class="mcp-field mcp-motion-prompt">创作要求（可选）<textarea :value="motion.prompt || ''" aria-label="二创创作要求" rows="2" :maxlength="MAX_MCP_MOTION_PROMPT" :disabled="motionBlocked" placeholder="例如：剪成 20 秒产品介绍，突出操作步骤与结果，节奏清晰。" @input="changeMotion({ prompt: ($event.target as HTMLTextAreaElement).value })" /></label>
            <p v-if="motionBrief?.errors.length" class="mcp-motion-message mcp-motion-warning" role="status">{{ motionBrief.errors.join(' ') }}</p>
            <button v-if="invalidMotionSelection" type="button" class="mcp-copy mcp-motion-clear" :disabled="motionBlocked" @click="changeMotion({ assetIds: [...selectedMotionIds] })">清除失效选择</button>
            <p v-if="motionBrief?.ready" class="mcp-motion-message" role="status">配置已就绪，请在连接的 Agent 中发起二创任务。</p>
          </template>
        </section>
      </template>
    </section>
  </EditorDialog>
</template>

<style scoped>
.mcp-panel{display:grid;gap:12px;padding:14px 16px;font-size:12px;line-height:1.5;color:var(--ed-text,var(--ui-modal-text))}.mcp-status-row{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--ed-muted,var(--ui-modal-muted))}.mcp-indicator{width:6px;height:6px;flex:none;border-radius:50%;background:currentColor}.mcp-indicator.running{background:var(--ui-success,#208565)}.mcp-status-row .mcp-switch{margin-left:auto;position:relative;display:block;flex:none;width:30px;height:18px;min-height:18px;padding:0;border:0;border-radius:20px;background:var(--ed-border,var(--ui-line));cursor:pointer}.mcp-switch>span{display:block;position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0002;transition:transform .15s}.mcp-status-row .mcp-switch[aria-checked=true]{background:var(--ed-accent,var(--ui-accent))}.mcp-switch[aria-checked=true]>span{transform:translateX(12px)}.mcp-field{display:grid;gap:5px;min-width:0;font-size:11px;color:var(--ed-muted,var(--ui-modal-muted))}.mcp-field input{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:5px 9px;border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:6px;background:var(--ed-panel,var(--ui-modal-solid));color:var(--ed-text,var(--ui-modal-text));font:11px ui-monospace,monospace}.mcp-panel input:focus-visible,.mcp-panel button:focus-visible{outline:2px solid var(--ed-accent,var(--ui-modal-accent));outline-offset:2px}.mcp-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-width:0}.mcp-feedback{flex:1;min-width:0;margin:0;font-size:11px;color:var(--ui-success,#208565);overflow-wrap:anywhere}.mcp-feedback.error{color:var(--ui-danger,#c14040)}.mcp-copy{display:inline-flex;align-items:center;justify-content:center;flex:none;gap:6px;min-height:30px;padding:5px 10px;border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:6px;background:var(--ed-panel,var(--ui-modal-solid));color:var(--ed-text,var(--ui-modal-text));font:inherit;font-size:11px;cursor:pointer}.mcp-copy:hover:not(:disabled){background:var(--ed-bg,var(--ui-modal-hover))}.mcp-panel button:disabled{opacity:.45;cursor:not-allowed}.mcp-unavailable{margin:4px 0;font-size:12px;color:var(--ed-muted,var(--ui-modal-muted))}@media(prefers-reduced-motion:reduce){.mcp-switch>span{transition:none}}
</style>

<style scoped>
.mcp-motion{border-top:1px solid var(--ed-border,var(--ui-modal-border));padding-top:12px;min-width:0}.mcp-motion-heading{color:var(--ed-text,var(--ui-modal-text));font-size:12px}.mcp-motion-heading>svg{color:var(--ed-accent,var(--ui-accent))}.mcp-motion-scope{font-size:10px;color:var(--ed-muted,var(--ui-modal-muted))}.mcp-motion-description{font-size:11px;color:var(--ed-muted,var(--ui-modal-muted));margin:6px 0 0}.mcp-motion-options{display:grid;grid-template-columns:minmax(150px,.8fr) minmax(0,1.5fr);gap:16px;margin-top:13px}.mcp-motion h3{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 7px;font-size:11px;font-weight:600}.mcp-motion h3>span{color:var(--ed-muted,var(--ui-modal-muted));font-size:10px;font-weight:400;white-space:nowrap}.mcp-motion-sources,.mcp-motion-styles{min-width:0}.mcp-motion-search,.mcp-motion-prompt textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:6px;background:var(--ed-panel,var(--ui-modal-solid));color:var(--ed-text,var(--ui-modal-text));font:inherit;font-size:11px}.mcp-motion-search{height:29px;padding:4px 7px;margin-bottom:7px}.mcp-motion-assets{display:grid;align-content:start;gap:5px;max-height:328px;overflow:auto;padding:2px;scrollbar-width:thin;scrollbar-color:var(--ed-border,var(--ui-modal-border)) transparent;overscroll-behavior:contain}.mcp-motion-asset{display:flex;align-items:center;gap:7px;min-width:0;min-height:49px;text-align:left;padding:5px;border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:6px;background:var(--ed-panel,var(--ui-modal-solid));color:var(--ed-text,var(--ui-modal-text));cursor:pointer}.mcp-motion-asset[aria-checked=true]{border-color:var(--ed-accent,var(--ui-accent));background:color-mix(in srgb,var(--ed-accent,var(--ui-accent)) 9%,var(--ed-panel,var(--ui-modal-solid)))}.mcp-motion-thumb{display:flex;align-items:center;justify-content:center;flex:none;width:33px;height:33px;border-radius:4px;background:var(--ed-bg,var(--ui-modal-hover));color:var(--ed-muted,var(--ui-modal-muted));overflow:hidden}.mcp-motion-thumb img{width:100%;height:100%;object-fit:cover}.mcp-motion-asset-label{display:grid;gap:3px;min-width:0;flex:1}.mcp-motion-asset-label strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:500}.mcp-motion-asset-label small{font-size:9px;color:var(--ed-muted,var(--ui-modal-muted))}.mcp-motion-check{display:flex;align-items:center;justify-content:center;flex:none;width:13px;height:13px;border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:3px}.mcp-motion-asset[aria-checked=true] .mcp-motion-check{background:var(--ed-accent,var(--ui-accent));border-color:transparent;color:#fff}.mcp-motion-style-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.mcp-motion-style-grid>button{display:grid;position:relative;min-width:0;overflow:hidden;padding:0;border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:6px;background:var(--ed-panel,var(--ui-modal-solid));color:var(--ed-text,var(--ui-modal-text));cursor:pointer}.mcp-motion-style-grid>button[aria-pressed=true]{border-color:var(--ed-accent,var(--ui-accent));box-shadow:0 0 0 1px var(--ed-accent,var(--ui-accent))}.mcp-motion-style-grid canvas{display:block;width:100%;height:43px;object-fit:cover}.mcp-motion-style-grid>button>span{padding:4px 2px;font-size:10px;line-height:1.3;text-align:center}.mcp-motion-style-grid>button>svg{position:absolute;right:4px;top:4px;padding:2px;box-sizing:content-box;border-radius:50%;background:var(--ed-accent,var(--ui-accent));color:#fff}.mcp-motion-style-description{font-size:10px;line-height:1.5;color:var(--ed-muted,var(--ui-modal-muted));margin:9px 0}.mcp-motion-style-description>span{display:block;margin-top:3px}.mcp-motion-prompt{margin-top:10px}.mcp-motion-prompt textarea{resize:vertical;min-height:53px;max-height:140px;padding:7px 8px;line-height:1.5}.mcp-motion-prompt textarea:focus-visible{outline:2px solid var(--ed-accent,var(--ui-accent));outline-offset:2px}.mcp-motion-message{margin:7px 0 0;font-size:10px;line-height:1.5;color:var(--ed-muted,var(--ui-modal-muted));overflow-wrap:anywhere}.mcp-motion-warning{color:var(--ui-warning,var(--ed-muted,var(--ui-modal-muted)))}.mcp-motion-empty{display:flex;flex-direction:column;align-items:center;gap:7px;margin:0;padding:24px 8px;border:1px dashed var(--ed-border,var(--ui-modal-border));border-radius:6px;font-size:11px;color:var(--ed-muted,var(--ui-modal-muted));text-align:center}.mcp-motion-empty small{font-size:10px}.mcp-motion textarea:disabled,.mcp-motion input:disabled{opacity:.5;cursor:not-allowed}@media(max-width:540px){.mcp-motion-options{grid-template-columns:1fr;gap:12px}.mcp-motion-assets{max-height:150px}.mcp-motion-style-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.mcp-motion-style-grid canvas{height:48px}}
</style>
