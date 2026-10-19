<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
import EditorDialog from './EditorDialog.vue'
import type { AiModel, AiProvider } from '../core/ai.ts'
import { aiState, aiServiceError, aiRefreshing, observeAi, refreshAi, installAiModel, updateAiModel, stopAiModelDownload, stopAiJob, aiBytes, aiDuration, aiProviderNames, aiModelStateNames } from '../core/ai-service.ts'

const props = defineProps<{ open: boolean; native: boolean; initialProvider?: AiProvider }>()
const emit = defineEmits<{ status: [message: string] }>()
const expanded = ref(new Set<AiProvider | 'jobs'>()), action = ref(''), actionError = ref('')
const categoryIcons: Record<AiProvider,string> = {speech:'microphone',image:'image',video:'film',music:'audio',transcription:'text'}
function toggleCategory(provider: AiProvider | 'jobs'): void { const next=new Set(expanded.value); next.has(provider) ? next.delete(provider) : next.add(provider); expanded.value=next }
const categoryModels = (provider: AiProvider) => aiState.value.models.filter(model=>model.provider===provider)
const downloaded = (model: AiModel) => model.downloadTransferredBytes ?? model.downloadedBytes
const total = (model: AiModel) => model.downloadTotalBytes ?? model.size
function remaining(model: AiModel): string {
  if (model.state==='verifying' || model.downloadPhase==='verifying' || model.runtime.state==='verifying') return '正在校验文件完整性'
  if (!Number.isFinite(model.remainingSeconds)) return '正在估算剩余时间…'
  const seconds=Math.max(1,model.remainingSeconds!)
  return seconds<60 ? '预计剩余不到 1 分钟' : seconds<3600 ? `预计剩余约 ${Math.ceil(seconds/60)} 分钟` : `预计剩余约 ${Math.ceil(seconds/360)/10} 小时`
}
const confirming = ref<AiModel>(), accepted = ref(false), repair = ref(false)
let release: (() => void) | undefined
watch([() => props.open, () => props.initialProvider], ([open, provider]) => {
  release?.(); release = undefined
  if (open) {
    expanded.value = new Set(provider ? [provider] : [])
    release = observeAi()
    if (provider) void nextTick(()=>document.querySelector(`[data-testid="ai-category-${provider}"]`)?.scrollIntoView({block:'nearest'}))
  } else confirming.value=undefined
}, { immediate: true })
onBeforeUnmount(() => release?.())
const running = computed(() => aiState.value.jobs.filter(job => job.state === 'running').length)
const runtimePending = (model: AiModel) => ['downloading', 'verifying'].includes(model.runtime.state)
const pending = (model: AiModel) => ['downloading', 'verifying'].includes(model.state)
async function perform(id: string, callback: () => Promise<unknown>): Promise<void> {
  action.value = id; actionError.value = ''
  try { await callback() } catch (cause) { actionError.value = cause instanceof Error ? cause.message : String(cause) }
  finally { action.value = '' }
}
function askInstall(model: AiModel, isRepair = false): void {
  accepted.value = false; repair.value = isRepair; confirming.value = model
}
async function confirmInstall(): Promise<void> {
  const model = confirming.value
  if (!model || model.requiresLicenseAcceptance && !accepted.value) return
  await perform(model.id, async () => {
    await (repair.value ? updateAiModel(model.id, accepted.value) : installAiModel(model.id, accepted.value))
    confirming.value = undefined; emit('status', `${model.name} 已开始下载，完成后所有工作区可共用`)
  })
}
</script>

<template>

    <div class="ai-center-body">
      <div class="ai-center-intro"><div><strong>下载一次，整个工作台共用</strong><p>模型按需下载，地址无法连接时自动尝试备用来源。</p></div><button :disabled="aiRefreshing || !!action" aria-label="刷新模型状态" @click="refreshAi"><Icon name="refresh" :size="16" /></button></div>
      <p v-if="!native" class="ai-center-note">请在桌面端下载模型并进行本地生成。</p>
      <p v-if="actionError || aiServiceError" class="ai-center-error" role="alert">{{ actionError || aiServiceError }}</p>
      <section v-for="(name, provider) in aiProviderNames" :key="provider" class="ai-category" :data-ai-category="provider">
        <button class="ai-category-toggle" :data-testid="`ai-category-${provider}`" :aria-expanded="expanded.has(provider)" :aria-controls="`ai-models-${provider}`" @click="toggleCategory(provider)"><Icon :name="categoryIcons[provider]" :size="17"/><strong>{{ name }}模型</strong><small>{{ categoryModels(provider).filter(model=>model.state==='ready').length }} / {{ categoryModels(provider).length }} 已就绪</small><span v-if="categoryModels(provider).some(pending)" class="ai-category-working">下载中</span><Icon name="chevron-down" :size="16" class="ai-category-chevron"/></button>
        <div v-if="expanded.has(provider)" :id="`ai-models-${provider}`" class="ai-model-grid">
        <article v-for="model in categoryModels(provider)" :key="model.id" class="ai-model-card" :data-ai-model="model.id">
          <header><span class="ai-model-symbol"><Icon :name="categoryIcons[model.provider]" :size="21" /></span><div><strong>{{ model.name }}</strong><small>{{ aiProviderNames[model.provider] }} · {{ model.bundled ? '已内置' : aiBytes(model.size) }}</small></div><span class="ai-model-state" :class="{ready:model.state==='ready'}">{{ aiModelStateNames[model.state] }}</span></header>
          <p class="ai-model-hardware">{{ model.hardware }}</p><p v-if="model.runtime.reason" class="ai-model-detail">{{ model.runtime.reason }}</p><p v-if="model.runtime.device" class="ai-model-detail">推理设备：{{ ({auto:'自动选择',cuda:'CUDA GPU',mps:'Apple GPU',cpu:'CPU'})[model.runtime.device as 'auto'|'cuda'|'mps'|'cpu'] || model.runtime.device }}</p>
          <p v-if="model.license" class="ai-model-license">{{ model.license }}<a v-if="model.licenseUrl" :href="model.licenseUrl" target="_blank" rel="noopener noreferrer">模型许可<Icon name="export" :size="11" /></a></p>
          <p v-if="model.error" class="ai-center-error">{{ model.error }}</p>
          <template v-if="pending(model)"><progress :value="model.state==='verifying' || model.downloadPhase==='verifying' || (runtimePending(model) && model.downloadTotalBytes===undefined) ? undefined : downloaded(model)" :max="Math.max(1,total(model))" :aria-label="`${model.name}下载进度`"/><div class="ai-download-status" aria-live="polite"><span>{{ runtimePending(model) ? '运行环境 · ' : '' }}{{ aiBytes(downloaded(model)) }} / {{ aiBytes(total(model)) }}</span><span v-if="model.downloadSpeedBytesPerSecond">{{ aiBytes(model.downloadSpeedBytesPerSecond) }}/秒</span><strong>{{ remaining(model) }}</strong></div><footer><small>{{ model.activeSource ? `当前来源：${model.activeSource}` : '自动选择可用下载来源' }}</small><button :disabled="!!action" @click="perform(model.id,()=>stopAiModelDownload(model.id))">取消</button></footer></template>
          <footer v-else><small>{{ model.state==='ready' ? '可供所有工作区使用' : '模型与运行组件按需下载' }}</small><button v-if="model.state==='ready' && !model.bundled" :disabled="!!action" @click="askInstall(model,true)"><Icon name="refresh" :size="13"/>检查 / 修复</button><button v-else-if="model.state!=='ready'" :disabled="!native || !!action || model.state==='unsupported'" @click="askInstall(model)"><Icon name="download" :size="13"/>{{ model.state==='update-available' ? '更新' : model.downloadedBytes ? '继续下载' : '下载' }}</button></footer>
        </article>
        <p v-if="native && !categoryModels(provider).length" class="ai-center-note">{{ aiRefreshing ? '正在读取模型目录…' : '暂无此类别模型' }}</p>
        </div>
      </section>
      <section class="ai-category" data-ai-category="jobs"><button class="ai-category-toggle" data-testid="ai-category-jobs" :aria-expanded="expanded.has('jobs')" aria-controls="ai-model-jobs" @click="toggleCategory('jobs')"><Icon name="clock" :size="17"/><strong>模型任务</strong><small>{{ running ? `${running} 个进行中` : `${aiState.jobs.length} 个任务` }}</small><Icon name="chevron-down" :size="16" class="ai-category-chevron"/></button>
      <div v-if="expanded.has('jobs')" id="ai-model-jobs" class="ai-center-jobs"><p v-if="!aiState.jobs.length" class="ai-center-note">还没有模型任务。</p><article v-for="job in aiState.jobs" :key="job.id"><header><strong>{{ aiState.models.find(model=>model.id===job.modelId)?.name || aiProviderNames[job.provider] }}</strong><span>{{ ({running:'进行中',completed:'已完成',failed:'失败',cancelled:'已取消'})[job.state] }}</span></header><p>{{ job.stage }} · {{ aiDuration(job.elapsedSeconds) }}</p><progress v-if="job.state==='running'" :value="job.progress" max="1" aria-label="模型任务进度"/><p v-if="job.error" class="ai-center-error">{{ job.error }}</p><p v-if="job.warning" class="ai-model-detail">{{ job.warning }}</p><button v-if="job.cancelable && job.state==='running'" :disabled="!!action" @click="perform(job.id,()=>stopAiJob(job.id))">取消任务</button></article></div>
    </section>
    </div>
  <EditorDialog :open="!!confirming && open" :title="repair ? '修复模型' : '下载模型'" icon="download" :busy="!!action" busy-message="正在启动模型下载" @close="confirming=undefined">
    <div v-if="confirming" class="ai-license-confirm"><h3>{{ confirming.name }}</h3><p>模型文件约 {{ aiBytes(confirming.size) }}，运行组件另行下载；共享文件会复用，下载中断后可继续。</p><p>{{ confirming.hardware }}</p><p v-if="confirming.license">模型许可：{{ confirming.license }}<a v-if="confirming.licenseUrl" :href="confirming.licenseUrl" target="_blank" rel="noopener noreferrer">查看原文</a></p><label v-if="confirming.requiresLicenseAcceptance"><input v-model="accepted" type="checkbox"/>我已阅读模型许可，确认所在地及使用方式符合要求。</label><p v-if="actionError" class="ai-center-error" role="alert">{{ actionError }}</p></div>
    <template #footer><button :disabled="!!action" @click="confirming=undefined">取消</button><button class="primary" :disabled="!!action || (!!confirming?.requiresLicenseAcceptance && !accepted)" @click="confirmInstall">{{ action ? '正在准备…' : repair ? '检查并修复' : '开始下载' }}</button></template>
  </EditorDialog>
</template>

<style scoped>
.ai-center-body{padding:18px}.ai-center-intro{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px}.ai-center-intro strong{font-size:14px}.ai-center-intro p,.ai-center-note{font-size:12px;line-height:1.7;color:var(--ui-muted)}.ai-center-intro p{margin:6px 0 0}.ai-center-intro button{padding:7px;flex:none}.ai-category{border:1px solid var(--ui-line);border-radius:10px;margin-top:10px;overflow:hidden}.ai-category-toggle{display:flex;align-items:center;gap:10px;width:100%;padding:13px;border:0;border-radius:0;background:var(--ui-surface-2);text-align:left}.ai-category-toggle>svg:first-child{color:var(--ui-accent)}.ai-category-toggle strong{font-size:12px}.ai-category-toggle small{font-size:10px;color:var(--ui-muted);margin-left:auto}.ai-category-chevron{transition:transform .18s}.ai-category-toggle[aria-expanded=true] .ai-category-chevron{transform:rotate(180deg)}.ai-category-working{font-size:10px;color:var(--ui-accent)}.ai-download-status{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:10px;color:var(--ui-muted);font-variant-numeric:tabular-nums}.ai-download-status strong{flex-basis:100%;font-weight:500;color:var(--ui-text)}.ai-model-grid,.ai-center-jobs{padding:12px}.ai-model-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ai-model-card{padding:14px;border:1px solid var(--ui-line);border-radius:10px;background:var(--ui-surface-2);min-width:0}.ai-model-card header{display:flex;align-items:center;gap:9px}.ai-model-symbol{display:flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;border-radius:9px;background:var(--ui-accent-soft);color:var(--ui-accent)}.ai-model-card header>div{flex:1;min-width:0;display:grid;gap:5px}.ai-model-card strong{font-size:12px;overflow-wrap:anywhere}.ai-model-card small{font-size:10px;color:var(--ui-muted)}.ai-model-state{font-size:10px;max-width:70px;color:var(--ui-muted)}.ai-model-state.ready{color:var(--ui-accent)}.ai-model-hardware{font-size:11px;line-height:1.7;margin:14px 0 8px}.ai-model-detail,.ai-model-license{font-size:10px;line-height:1.7;color:var(--ui-muted)}.ai-model-license{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}a{display:inline-flex;align-items:center;gap:4px;color:var(--ui-accent)}.ai-model-card footer{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px}.ai-model-card footer button{font-size:10px;padding:5px 8px;white-space:nowrap}.ai-center-error{font-size:11px;line-height:1.7;overflow-wrap:anywhere;color:var(--ui-danger)}progress{display:block;width:100%;height:5px;accent-color:var(--ui-accent);margin:10px 0}.ai-center-jobs{display:grid;gap:10px}.ai-center-jobs article{border:1px solid var(--ui-line);border-radius:9px;padding:12px}.ai-center-jobs header{display:flex;justify-content:space-between;gap:10px;font-size:12px}.ai-center-jobs p{font-size:11px;line-height:1.7}.ai-center-jobs button{font-size:11px;padding:5px 10px}.ai-license-confirm{padding:18px;font-size:12px;line-height:1.8}.ai-license-confirm h3{font-size:15px;margin-top:0}.ai-license-confirm a{margin-left:8px}.ai-license-confirm label{display:flex;align-items:flex-start;gap:8px;margin-top:18px}.ai-license-confirm input{margin-top:5px;accent-color:var(--ui-accent)}@media(max-width:650px){.ai-model-grid{grid-template-columns:1fr}.ai-center-body{padding:13px}}
</style>
