<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { getMcpConfig, getMcpStatus, startMcpService, stopMcpService, type McpConfig, type McpPanelJob, type McpStatus } from '../native-mcp'
import EditorDialog from './EditorDialog.vue'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ open: boolean; native: boolean; jobs?: McpPanelJob[] }>(), { jobs: () => [] })
const emit = defineEmits<{ close: []; status: [message: string]; serviceChange: [status: McpStatus]; cancelJob: [id: string] }>()
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
  <EditorDialog :open="open" title="MCP 服务" icon="mcp" :busy="busy" busy-message="正在更新服务…" @close="emit('close')">
    <section class="mcp-panel" data-testid="mcp-panel" :aria-busy="loading || busy">
      <p v-if="!native" class="mcp-unavailable" role="status">MCP 服务由桌面端提供。</p>
      <template v-else>
        <div class="mcp-status-row"><span class="mcp-indicator" :class="{ running: service.running && !statusError }" /><span role="status">{{ stateLabel }}</span><button type="button" role="switch" class="mcp-switch" aria-label="MCP 服务开关" :aria-checked="service.running" :disabled="blocked" :title="service.running ? '停止 MCP 服务' : '启动 MCP 服务'" data-testid="mcp-service-switch" @click="toggleService"><span /></button></div>
        <label class="mcp-field">地址<input :value="endpoint" readonly aria-label="MCP 连接地址" spellcheck="false" :placeholder="loading ? '正在读取…' : '启动后显示连接地址'" @focus="($event.target as HTMLInputElement).select()" /></label>
        <label class="mcp-field">Token<input :value="configReady ? config?.token || '' : ''" type="text" readonly aria-label="MCP Token" autocomplete="off" spellcheck="false" :placeholder="loading || busy ? '正在读取…' : '连接信息尚未就绪'" @focus="($event.target as HTMLInputElement).select()" /></label>
        <div class="mcp-footer"><p class="mcp-feedback" :class="{ error: error || statusError }" :role="error || statusError ? 'alert' : 'status'">{{ feedback }}</p><button type="button" class="mcp-copy" :disabled="!canCopy" data-testid="mcp-copy-config" @click="copyConfig"><Icon name="copy" :size="14" />复制配置</button></div>
      </template>
    </section>
  </EditorDialog>
</template>

<style scoped>
.mcp-panel{display:grid;gap:12px;padding:14px 16px;font-size:12px;line-height:1.5;color:var(--ed-text,var(--ui-modal-text))}.mcp-status-row{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--ed-muted,var(--ui-modal-muted))}.mcp-indicator{width:6px;height:6px;flex:none;border-radius:50%;background:currentColor}.mcp-indicator.running{background:var(--ui-success,#208565)}.mcp-status-row .mcp-switch{margin-left:auto;position:relative;display:block;flex:none;width:30px;height:18px;min-height:18px;padding:0;border:0;border-radius:20px;background:var(--ed-border,var(--ui-line));cursor:pointer}.mcp-switch>span{display:block;position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0002;transition:transform .15s}.mcp-status-row .mcp-switch[aria-checked=true]{background:var(--ed-accent,var(--ui-accent))}.mcp-switch[aria-checked=true]>span{transform:translateX(12px)}.mcp-field{display:grid;gap:5px;min-width:0;font-size:11px;color:var(--ed-muted,var(--ui-modal-muted))}.mcp-field input{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:5px 9px;border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:6px;background:var(--ed-panel,var(--ui-modal-solid));color:var(--ed-text,var(--ui-modal-text));font:11px ui-monospace,monospace}.mcp-panel input:focus-visible,.mcp-panel button:focus-visible{outline:2px solid var(--ed-accent,var(--ui-modal-accent));outline-offset:2px}.mcp-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-width:0}.mcp-feedback{flex:1;min-width:0;margin:0;font-size:11px;color:var(--ui-success,#208565);overflow-wrap:anywhere}.mcp-feedback.error{color:var(--ui-danger,#c14040)}.mcp-copy{display:inline-flex;align-items:center;justify-content:center;flex:none;gap:6px;min-height:30px;padding:5px 10px;border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:6px;background:var(--ed-panel,var(--ui-modal-solid));color:var(--ed-text,var(--ui-modal-text));font:inherit;font-size:11px;cursor:pointer}.mcp-copy:hover:not(:disabled){background:var(--ed-bg,var(--ui-modal-hover))}.mcp-panel button:disabled{opacity:.45;cursor:not-allowed}.mcp-unavailable{margin:4px 0;font-size:12px;color:var(--ed-muted,var(--ui-modal-muted))}@media(prefers-reduced-motion:reduce){.mcp-switch>span{transition:none}}
</style>
