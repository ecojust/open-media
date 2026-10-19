<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
import EditorDialog from './EditorDialog.vue'
import type { AiModel, AiProvider } from '../core/ai.ts'
import { aiState, aiServiceError, aiRefreshing, observeAi, refreshAi, installAiModel, updateAiModel, stopAiModelDownload, stopAiJob, aiBytes, aiDuration, aiProviderNames, aiModelStateNames } from '../core/ai-service.ts'

const props = defineProps<{ open: boolean; native: boolean; initialProvider?: AiProvider }>()
const emit = defineEmits<{ close: []; status: [message: string] }>()
const tab = ref<AiProvider | 'all' | 'jobs'>('all'), action = ref(''), actionError = ref('')
const confirming = ref<AiModel>(), accepted = ref(false), repair = ref(false)
let release: (() => void) | undefined
watch(() => props.open, open => { release?.(); release = undefined; if (open) { tab.value = props.initialProvider || 'all'; release = observeAi() } }, { immediate: true })
onBeforeUnmount(() => release?.())
const models = computed(() => aiState.value.models.filter(model => tab.value === 'all' || model.provider === tab.value))
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
  <EditorDialog :open="open" title="AI 模型中心" icon="sparkles" wide class="ai-model-dialog" @close="emit('close')">
    <div class="ai-center-body">
      <div class="ai-center-intro"><div><strong>下载一次，整个工作台共用</strong><p>配音、图像、视频与歌曲模型统一管理，任务在切换工作区后继续运行。</p></div><button :disabled="aiRefreshing || !!action" aria-label="刷新模型状态" @click="refreshAi"><Icon name="refresh" :size="16" /></button></div>
      <div class="ai-center-tabs" role="tablist" aria-label="模型类别"><button role="tab" :aria-selected="tab==='all'" @click="tab='all'">全部</button><button v-for="(name, provider) in aiProviderNames" :key="provider" role="tab" :aria-selected="tab===provider" @click="tab=provider">{{ name }}</button><button role="tab" :aria-selected="tab==='jobs'" @click="tab='jobs'">任务<small v-if="running">{{ running }}</small></button></div>
      <p v-if="!native" class="ai-center-note">请在桌面端下载模型并进行本地生成。</p>
      <p v-if="actionError || aiServiceError" class="ai-center-error" role="alert">{{ actionError || aiServiceError }}</p>
      <div v-if="tab!=='jobs'" class="ai-model-grid">
        <article v-for="model in models" :key="model.id" class="ai-model-card" :data-ai-model="model.id">
          <header><span class="ai-model-symbol"><Icon :name="model.provider==='speech' ? 'microphone' : model.provider==='music' ? 'audio' : model.provider==='image' ? 'image' : 'film'" :size="21" /></span><div><strong>{{ model.name }}</strong><small>{{ aiProviderNames[model.provider] }} · {{ model.bundled ? '已内置' : aiBytes(model.size) }}</small></div><span class="ai-model-state" :class="{ready:model.state==='ready'}">{{ aiModelStateNames[model.state] }}</span></header>
          <p class="ai-model-hardware">{{ model.hardware }}</p><p v-if="model.runtime.reason" class="ai-model-detail">{{ model.runtime.reason }}</p><p v-if="model.runtime.device" class="ai-model-detail">推理设备：{{ model.runtime.device }}</p>
          <p v-if="model.license" class="ai-model-license">{{ model.license }}<a v-if="model.licenseUrl" :href="model.licenseUrl" target="_blank" rel="noopener noreferrer">模型许可<Icon name="export" :size="11" /></a></p>
          <p v-if="model.error" class="ai-center-error">{{ model.error }}</p>
          <template v-if="pending(model)"><progress :value="runtimePending(model) || model.state==='verifying' ? undefined : model.downloadedBytes" :max="Math.max(1,model.size)" :aria-label="`${model.name}下载进度`"/><footer><small>{{ runtimePending(model) ? '正在准备运行环境' : model.state==='verifying' ? '正在校验文件完整性' : `${aiBytes(model.downloadedBytes)} / ${aiBytes(model.size)}` }}</small><button :disabled="!!action" @click="perform(model.id,()=>stopAiModelDownload(model.id))">取消</button></footer></template>
          <footer v-else><small>{{ model.state==='ready' ? '可供所有工作区使用' : '模型与运行组件按需下载' }}</small><button v-if="model.state==='ready' && !model.bundled" :disabled="!!action" @click="askInstall(model,true)"><Icon name="refresh" :size="13"/>检查 / 修复</button><button v-else-if="model.state!=='ready'" :disabled="!native || !!action || model.state==='unsupported'" @click="askInstall(model)"><Icon name="download" :size="13"/>{{ model.state==='update-available' ? '更新' : model.downloadedBytes ? '继续下载' : '下载' }}</button></footer>
        </article>
        <p v-if="native && !models.length" class="ai-center-note">{{ aiRefreshing ? '正在读取模型目录…' : '暂无此类别模型' }}</p>
      </div>
      <div v-else class="ai-center-jobs"><p v-if="!aiState.jobs.length" class="ai-center-note">还没有模型任务。</p><article v-for="job in aiState.jobs" :key="job.id"><header><strong>{{ aiState.models.find(model=>model.id===job.modelId)?.name || aiProviderNames[job.provider] }}</strong><span>{{ ({running:'进行中',completed:'已完成',failed:'失败',cancelled:'已取消'})[job.state] }}</span></header><p>{{ job.stage }} · {{ aiDuration(job.elapsedSeconds) }}</p><progress v-if="job.state==='running'" :value="job.progress" max="1" aria-label="模型任务进度"/><p v-if="job.error" class="ai-center-error">{{ job.error }}</p><p v-if="job.warning" class="ai-model-detail">{{ job.warning }}</p><button v-if="job.cancelable && job.state==='running'" :disabled="!!action" @click="perform(job.id,()=>stopAiJob(job.id))">取消任务</button></article></div>
    </div>
  </EditorDialog>
  <EditorDialog :open="!!confirming && open" :title="repair ? '修复模型' : '下载模型'" icon="download" :busy="!!action" busy-message="正在启动模型下载" @close="confirming=undefined">
    <div v-if="confirming" class="ai-license-confirm"><h3>{{ confirming.name }}</h3><p>模型文件约 {{ aiBytes(confirming.size) }}，运行组件另行下载；共享文件会复用，下载中断后可继续。</p><p>{{ confirming.hardware }}</p><p v-if="confirming.license">模型许可：{{ confirming.license }}<a v-if="confirming.licenseUrl" :href="confirming.licenseUrl" target="_blank" rel="noopener noreferrer">查看原文</a></p><label v-if="confirming.requiresLicenseAcceptance"><input v-model="accepted" type="checkbox"/>我已阅读模型许可，确认所在地及使用方式符合要求。</label><p v-if="actionError" class="ai-center-error" role="alert">{{ actionError }}</p></div>
    <template #footer><button :disabled="!!action" @click="confirming=undefined">取消</button><button class="primary" :disabled="!!action || (!!confirming?.requiresLicenseAcceptance && !accepted)" @click="confirmInstall">{{ action ? '正在准备…' : repair ? '检查并修复' : '开始下载' }}</button></template>
  </EditorDialog>
</template>

<style scoped>
.ai-model-dialog{width:min(900px,calc(100vw - 28px))!important}.ai-center-body{padding:18px}.ai-center-intro{display:flex;align-items:center;justify-content:space-between;gap:14px}.ai-center-intro strong{font-size:14px}.ai-center-intro p,.ai-center-note{font-size:12px;line-height:1.7;color:var(--ui-muted)}.ai-center-intro button{padding:7px;flex:none}.ai-center-tabs{display:flex;gap:5px;flex-wrap:wrap;margin:16px 0}.ai-center-tabs button{font-size:12px;padding:6px 13px}.ai-center-tabs [aria-selected=true]{color:var(--ui-accent);border-color:var(--ui-accent);background:var(--ui-accent-soft)}.ai-center-tabs small{margin-left:6px}.ai-model-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ai-model-card{padding:14px;border:1px solid var(--ui-line);border-radius:10px;background:var(--ui-surface-2);min-width:0}.ai-model-card header{display:flex;align-items:center;gap:9px}.ai-model-symbol{display:flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;border-radius:9px;background:var(--ui-accent-soft);color:var(--ui-accent)}.ai-model-card header>div{flex:1;min-width:0;display:grid;gap:5px}.ai-model-card strong{font-size:12px;overflow-wrap:anywhere}.ai-model-card small{font-size:10px;color:var(--ui-muted)}.ai-model-state{font-size:10px;max-width:70px;color:var(--ui-muted)}.ai-model-state.ready{color:var(--ui-accent)}.ai-model-hardware{font-size:11px;line-height:1.7;margin:14px 0 8px}.ai-model-detail,.ai-model-license{font-size:10px;line-height:1.7;color:var(--ui-muted)}.ai-model-license{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}a{display:inline-flex;align-items:center;gap:4px;color:var(--ui-accent)}.ai-model-card footer{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px}.ai-model-card footer button{font-size:10px;padding:5px 8px;white-space:nowrap}.ai-center-error{font-size:11px;line-height:1.7;overflow-wrap:anywhere;color:var(--ui-danger)}progress{display:block;width:100%;height:5px;accent-color:var(--ui-accent);margin:10px 0}.ai-center-jobs{display:grid;gap:10px}.ai-center-jobs article{border:1px solid var(--ui-line);border-radius:9px;padding:12px}.ai-center-jobs header{display:flex;justify-content:space-between;gap:10px;font-size:12px}.ai-center-jobs p{font-size:11px;line-height:1.7}.ai-center-jobs button{font-size:11px;padding:5px 10px}.ai-license-confirm{padding:18px;font-size:12px;line-height:1.8}.ai-license-confirm h3{font-size:15px;margin-top:0}.ai-license-confirm a{margin-left:8px}.ai-license-confirm label{display:flex;align-items:flex-start;gap:8px;margin-top:18px}.ai-license-confirm input{margin-top:5px;accent-color:var(--ui-accent)}@media(max-width:650px){.ai-model-grid{grid-template-columns:1fr}.ai-center-body{padding:13px}}
</style>
