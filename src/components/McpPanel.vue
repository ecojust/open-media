<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { getMcpConfig, getMcpStatus, saveMcpConfig, startMcpService, stopMcpService, type McpConfig, type McpPanelJob, type McpStatus } from '../native-mcp'
import tools from '../mcp-tools.json'
import EditorDialog from './EditorDialog.vue'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ open: boolean; native: boolean; jobs?: McpPanelJob[] }>(), { jobs: () => [] })
const emit = defineEmits<{ close: []; status: [message: string]; serviceChange: [status: McpStatus]; cancelJob: [id: string] }>()
const config = ref<McpConfig>({ host: '127.0.0.1', port: 39861, token: '' })
const saved = ref<McpConfig>()
const service = ref<McpStatus>({ running: false, host: '127.0.0.1', port: 39861, url: null, pendingRequests: 0 })
const loading = ref(false), busy = ref(false), tokenVisible = ref(false), error = ref(''), notice = ref(''), statusError = ref('')
let timer: ReturnType<typeof setTimeout> | undefined, revision = 0, disposed = false
const dirty = computed(() => !saved.value || config.value.host.trim() !== saved.value.host || config.value.port !== saved.value.port || config.value.token !== saved.value.token)
const blocked = computed(() => loading.value || busy.value || !props.native)
const configDisabled = computed(() => blocked.value || service.value.running)
const validation = computed(() => {
  if (!config.value.host.trim()) return '请输入监听 IP 地址。'
  if (!Number.isInteger(config.value.port) || config.value.port < 1 || config.value.port > 65535) return '端口需要是 1 到 65535 之间的整数。'
  if (config.value.token && !/^[\x21-\x7e]{32,256}$/.test(config.value.token)) return 'Token 需要 32–256 个不含空格的英文字符、数字或符号，留空则自动生成。'
  return ''
})
const endpoint = computed(() => {
  if (service.value.running && service.value.url) return service.value.url
  const current = saved.value
  if (!current) return ''
  const host = current.host === '0.0.0.0' ? '127.0.0.1' : current.host === '::' ? '::1' : current.host
  return `http://${host.includes(':') ? `[${host}]` : host}:${current.port}/mcp`
})
const allInterfaces = computed(() => ['0.0.0.0', '::'].includes(saved.value?.host || ''))
const clientConfig = (hideToken = false) => JSON.stringify({ mcpServers: { 'open-media': { type: 'http', url: endpoint.value, headers: { Authorization: `Bearer ${hideToken ? '••••••••（复制时包含完整 Token）' : saved.value?.token || ''}` } } } }, null, 2)
const visibleConfig = computed(() => clientConfig(!tokenVisible.value))
const recentJobs = computed(() => [...props.jobs].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running')).slice(0, 12))
const groups = [
  { title: '项目与播放', prefixes: ['project_', 'playback_', 'timeline_'] },
  { title: '轨道与片段', prefixes: ['track_', 'clip_'] },
  { title: '字幕与水印', prefixes: ['text_', 'subtitle_'] },
  { title: '滤镜与转场', prefixes: ['filter_', 'transition_'] },
  { title: '素材与音乐', prefixes: ['asset_', 'material_'] },
  { title: '配音与模型', prefixes: ['speech_'] },
  { title: '导出与任务', prefixes: ['export_', 'job_'] },
]
const toolGroups = computed(() => groups.map(group => ({ ...group, tools: tools.filter(tool => group.prefixes.some(prefix => tool.name.startsWith(`open_media_${prefix}`))) })).filter(group => group.tools.length))
function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function applyStatus(next: McpStatus): void { service.value = next; statusError.value = ''; emit('serviceChange', next) }
function setSaved(next: McpConfig): void { saved.value = { ...next }; config.value = { ...next } }
function stopPoll(): void { clearTimeout(timer); timer = undefined }
function schedulePoll(): void {
  stopPoll()
  if (!disposed && props.open && props.native) timer = setTimeout(() => void poll(), 1500)
}
async function poll(): Promise<void> {
  const current = revision
  if (disposed || !props.open || !props.native) return
  try {
    if (!busy.value && !loading.value) {
      const next = await getMcpStatus()
      if (!disposed && current === revision && props.open) applyStatus(next)
    }
  } catch (cause) { if (!disposed && current === revision && props.open) statusError.value = `状态刷新失败：${errorText(cause)}` }
  finally { if (current === revision) schedulePoll() }
}
async function load(): Promise<void> {
  const current = ++revision
  stopPoll(); error.value = ''; notice.value = ''; statusError.value = ''; tokenVisible.value = false
  if (!props.native) return
  loading.value = true
  try {
    const [nextConfig, nextStatus] = await Promise.all([getMcpConfig(), getMcpStatus()])
    if (!disposed && current === revision) { setSaved(nextConfig); applyStatus(nextStatus) }
  } catch (cause) { if (!disposed && current === revision) error.value = `无法读取 MCP 设置：${errorText(cause)}` }
  finally { if (current === revision) { loading.value = false; schedulePoll() } }
}
async function changeService(action: 'save' | 'start' | 'stop' | 'token'): Promise<void> {
  if (blocked.value || (action !== 'stop' && service.value.running) || (action !== 'stop' && action !== 'token' && validation.value)) return
  revision++; busy.value = true; error.value = ''; notice.value = ''; stopPoll()
  try {
    if (action === 'stop') {
      applyStatus(await stopMcpService()); notice.value = 'MCP 服务已停止。'
    } else if (action === 'token') {
      const next = await saveMcpConfig({ ...(saved.value || config.value), token: '' })
      saved.value = { ...next }; config.value.token = next.token; tokenVisible.value = false
      notice.value = 'Token 已更新，请重新复制客户端配置。'
    } else {
      setSaved(await saveMcpConfig({ ...config.value, host: config.value.host.trim() }))
      if (action === 'start') { applyStatus(await startMcpService()); notice.value = 'MCP 服务已启动，可连接当前剪辑工程。' }
      else notice.value = 'MCP 设置已保存到本机。'
    }
    emit('status', notice.value)
  } catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false; schedulePoll() }
}
async function copy(value: string, label: string): Promise<void> {
  if (!value) return
  error.value = ''; notice.value = ''
  try {
    if (!navigator.clipboard?.writeText) throw new Error('系统剪贴板暂不可用，请选择文本后手动复制。')
    await navigator.clipboard.writeText(value)
    notice.value = `已复制${label}。`
  } catch (cause) { error.value = `复制失败：${errorText(cause)}` }
}
function jobState(job: McpPanelJob): string { return job.cancelling ? '正在取消' : ({ running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' }[job.state]) }
function jobPercent(job: McpPanelJob): number | undefined { return typeof job.progress === 'number' && Number.isFinite(job.progress) ? Math.round(Math.max(0, Math.min(1, job.progress)) * 100) : undefined }
watch(() => props.open, open => { if (open) void load(); else { revision++; stopPoll(); tokenVisible.value = false } }, { immediate: true })
onBeforeUnmount(() => { disposed = true; revision++; stopPoll() })
</script>

<template>
  <EditorDialog :open="open" title="MCP 服务" icon="mcp" :busy="busy" busy-message="正在更新服务，请稍候。" wide @close="emit('close')">
    <section class="mcp-panel" data-testid="mcp-panel" :aria-busy="loading || busy">
      <div v-if="!native" class="mcp-unavailable" role="status"><Icon name="monitor" :size="26" /><strong>MCP 服务由桌面端提供</strong><p>在桌面版视频剪辑中启动服务后，外部 AI 可以连接并操作当前工程。</p></div>
      <template v-else>
        <div class="mcp-status-row"><span class="mcp-indicator" :class="{ running: service.running && !statusError, uncertain: statusError }"/><strong>{{ loading ? '正在读取设置…' : statusError ? '状态暂不可用' : service.running ? '服务运行中' : '服务已停止' }}</strong><span v-if="service.running" class="mcp-request-count">{{ service.pendingRequests ? `${service.pendingRequests} 个请求处理中` : '等待外部 AI 连接' }}</span><button type="button" class="mcp-icon-button" :disabled="blocked" aria-label="刷新 MCP 状态" title="刷新状态" @click="poll"><Icon name="refresh" :size="15" /></button></div>
        <p class="mcp-intro">允许外部 AI 操作当前剪辑工程。修改会同步到界面，编辑操作可撤销。</p>
        <div class="mcp-fields">
          <label class="mcp-host">监听 IP<input v-model="config.host" aria-label="MCP 监听 IP" spellcheck="false" autocomplete="off" :disabled="configDisabled" placeholder="127.0.0.1" /></label>
          <label>端口<input v-model.number="config.port" type="number" min="1" max="65535" step="1" aria-label="MCP 端口" :disabled="configDisabled" /></label>
          <label class="mcp-token">访问 Token<span class="mcp-token-input"><input v-model="config.token" :type="tokenVisible ? 'text' : 'password'" aria-label="MCP Token" autocomplete="off" spellcheck="false" :disabled="configDisabled" placeholder="留空自动生成" /><button type="button" class="mcp-icon-button" :disabled="loading" :aria-label="tokenVisible ? '隐藏 Token' : '显示 Token'" :title="tokenVisible ? '隐藏 Token' : '显示 Token'" @click="tokenVisible = !tokenVisible"><Icon :name="tokenVisible ? 'eye-off' : 'eye'" :size="15" /></button></span></label>
        </div>
        <div class="mcp-actions"><button type="button" :disabled="configDisabled" @click="changeService('token')"><Icon name="refresh" :size="14" />重新生成 Token</button><span/><button v-if="!service.running" type="button" :disabled="blocked || !dirty || !!validation" @click="changeService('save')">保存设置</button><button v-if="service.running" type="button" :disabled="blocked" data-testid="mcp-stop" @click="changeService('stop')"><Icon name="stop" :size="14" />停止服务</button><button v-else type="button" class="mcp-primary" :disabled="blocked || !!validation" data-testid="mcp-start" @click="changeService('start')"><Icon name="play" :size="14" />{{ busy ? '正在启动…' : '启动服务' }}</button></div>
        <p v-if="service.running" class="mcp-hint">停止服务后可修改地址和 Token。关闭此弹窗，服务仍保持运行。</p>
        <p v-else class="mcp-hint">默认仅本机连接。配置保存在本机，不随工程文件分享。</p>
        <p v-if="!loading && validation" class="mcp-error" role="alert">{{ validation }}</p>
        <p v-if="statusError" class="mcp-error" role="status">{{ statusError }}</p>
        <div v-if="endpoint" class="mcp-connection">
          <div class="mcp-section-heading"><strong>连接地址</strong><span>Streamable HTTP · Bearer Token</span></div>
          <div class="mcp-address"><input :value="endpoint" readonly aria-label="MCP 连接地址" @focus="($event.target as HTMLInputElement).select()" /><button type="button" aria-label="复制 MCP 地址" title="复制地址" @click="copy(endpoint, '连接地址')"><Icon name="copy" :size="15" /></button></div>
          <p v-if="!service.running" class="mcp-hint">启动服务后，此地址才可连接。</p>
          <p v-if="dirty" class="mcp-hint">上方设置尚未保存，连接信息对应已保存的配置。</p>
          <p v-if="allInterfaces" class="mcp-hint">已监听全部网卡。局域网连接时，将地址中的主机替换为这台电脑的局域网 IP。</p>
          <details class="mcp-client-config"><summary>客户端配置 <span>JSON</span></summary><pre data-testid="mcp-client-config">{{ visibleConfig }}</pre><button type="button" :disabled="!saved?.token" @click="copy(clientConfig(), '客户端配置（包含 Token）')"><Icon name="copy" :size="14" />复制配置（含 Token）</button></details>
        </div>
        <div v-if="recentJobs.length" class="mcp-jobs" aria-label="自动化任务">
          <div class="mcp-section-heading"><strong>自动化任务</strong><span>{{ jobs.filter(job => job.state === 'running').length }} 个进行中</span></div>
          <div v-for="job in recentJobs" :key="job.id" class="mcp-job" :data-job-id="job.id"><div><strong>{{ job.name }}</strong><span>{{ jobState(job) }}<template v-if="jobPercent(job) !== undefined"> · {{ jobPercent(job) }}%</template></span><button v-if="job.state === 'running' && job.cancelable !== false" type="button" :disabled="job.cancelling" :aria-label="`取消任务 ${job.name}`" @click="emit('cancelJob', job.id)">{{ job.cancelling ? '正在取消…' : '取消' }}</button></div><progress v-if="job.state === 'running'" :value="jobPercent(job)" max="100" :aria-label="`${job.name}进度`"/><p v-if="job.error || job.stage" :class="{ 'mcp-error': job.error }">{{ job.error || job.stage }}</p></div>
        </div>
      </template>
      <details class="mcp-tools"><summary>开放的功能 <span>{{ tools.length }} 个工具</span></summary><section v-for="group in toolGroups" :key="group.title"><h3>{{ group.title }}</h3><dl><template v-for="tool in group.tools" :key="tool.name"><dt><code>{{ tool.name.replace('open_media_', '') }}</code><small v-if="tool.annotations?.readOnlyHint">只读</small></dt><dd>{{ tool.description }}</dd></template></dl></section></details>
      <p v-if="error" class="mcp-error" role="alert">{{ error }}</p><p v-if="notice" class="mcp-notice" role="status">{{ notice }}</p>
    </section>
  </EditorDialog>
</template>

<style scoped>
.mcp-panel{padding:16px;font-size:12px;display:grid;gap:12px;color:var(--ed-text,var(--ui-modal-text));line-height:1.6}.mcp-panel p{margin:0}.mcp-status-row{display:flex;align-items:center;gap:8px}.mcp-status-row>strong{font-size:13px}.mcp-status-row>button{margin-left:auto}.mcp-indicator{width:8px;height:8px;border-radius:50%;background:var(--ed-muted,var(--ui-modal-muted));flex:none}.mcp-indicator.running{background:var(--ui-success,#208565);box-shadow:0 0 0 3px color-mix(in srgb,var(--ui-success,#208565) 12%,transparent)}.mcp-indicator.uncertain{background:var(--ui-danger,#c14040)}.mcp-request-count,.mcp-intro,.mcp-hint,.mcp-section-heading>span{color:var(--ed-muted,var(--ui-modal-muted));font-size:11px}.mcp-fields{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:10px}.mcp-fields label{display:grid;gap:5px;min-width:0;font-size:11px}.mcp-token{grid-column:1/-1}.mcp-panel input{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:5px 9px;border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:6px;background:var(--ed-panel,var(--ui-modal-solid));color:inherit;font:inherit;font-size:12px}.mcp-panel input:focus-visible,.mcp-panel button:focus-visible,.mcp-panel summary:focus-visible{outline:2px solid var(--ed-accent,var(--ui-modal-accent));outline-offset:2px}.mcp-panel input:disabled{opacity:.65}.mcp-token-input{display:flex;gap:6px}.mcp-panel button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:6px;padding:5px 9px;background:var(--ed-panel,var(--ui-modal-solid));color:inherit;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}.mcp-panel button:hover:not(:disabled){background:var(--ed-bg,var(--ui-modal-hover))}.mcp-panel button:disabled{opacity:.45;cursor:not-allowed}.mcp-panel .mcp-primary{background:var(--ed-accent,var(--ui-modal-accent));border-color:var(--ed-accent,var(--ui-modal-accent));color:#fff}.mcp-panel .mcp-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--ed-accent,var(--ui-modal-accent))}.mcp-panel .mcp-icon-button{flex:none;width:30px;padding:0}.mcp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.mcp-actions>span{flex:1}.mcp-connection,.mcp-jobs{display:grid;gap:8px;padding-top:13px;border-top:1px solid var(--ed-border,var(--ui-modal-border))}.mcp-section-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.mcp-section-heading>strong{font-size:12px}.mcp-address{display:flex;gap:7px}.mcp-address>input{font-family:ui-monospace,monospace;font-size:11px}.mcp-address>button{flex:none;width:33px;padding:0}.mcp-panel details{border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:7px;padding:9px 11px;min-width:0}.mcp-panel summary{cursor:pointer;font-weight:600;user-select:none;font-size:11px}.mcp-panel summary>span{color:var(--ed-muted,var(--ui-modal-muted));font-weight:400;margin-left:7px}.mcp-client-config pre{padding:10px;white-space:pre-wrap;overflow-wrap:anywhere;font:10px/1.7 ui-monospace,monospace;color:var(--ed-text,var(--ui-modal-text));background:var(--ed-bg,var(--ui-modal-hover));border-radius:5px;user-select:text}.mcp-tools section{border-top:1px solid var(--ed-border,var(--ui-modal-border));margin-top:10px;padding-top:8px}.mcp-tools h3{font-size:11px;margin:0 0 8px}.mcp-tools dl{margin:0;display:grid;gap:3px}.mcp-tools dt{display:flex;align-items:center;gap:8px;overflow-wrap:anywhere;font-size:10px}.mcp-tools dt>small{font-size:9px;color:var(--ed-muted,var(--ui-modal-muted));border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:3px;padding:0 4px;white-space:nowrap}.mcp-tools dd{margin:0 0 8px;color:var(--ed-muted,var(--ui-modal-muted));font-size:10px;overflow-wrap:anywhere}.mcp-error{color:var(--ui-danger,#c14040);font-size:11px;overflow-wrap:anywhere}.mcp-notice{color:var(--ui-success,#208565);font-size:11px;min-height:18px}.mcp-unavailable{display:grid;justify-items:center;text-align:center;gap:8px;padding:16px 8px}.mcp-unavailable>svg{color:var(--ed-accent,var(--ui-modal-accent))}.mcp-unavailable p{font-size:11px;color:var(--ed-muted,var(--ui-modal-muted));max-width:350px}.mcp-job{border:1px solid var(--ed-border,var(--ui-modal-border));border-radius:6px;padding:9px;display:grid;gap:6px}.mcp-job>div{display:flex;align-items:center;gap:8px;min-width:0}.mcp-job strong{font-size:11px;flex:1;min-width:0;overflow-wrap:anywhere}.mcp-job span,.mcp-job p{font-size:10px;color:var(--ed-muted,var(--ui-modal-muted))}.mcp-job .mcp-error{color:var(--ui-danger,#c14040)}.mcp-job button{font-size:10px;min-height:25px;padding:3px 7px}.mcp-job progress{height:5px;width:100%;accent-color:var(--ed-accent,var(--ui-modal-accent))}@media(max-width:520px){.mcp-panel{padding:13px;gap:10px}.mcp-section-heading{flex-wrap:wrap;gap:3px}.mcp-request-count{font-size:10px}.mcp-actions{gap:6px}.mcp-panel button{font-size:10px}}
</style>
