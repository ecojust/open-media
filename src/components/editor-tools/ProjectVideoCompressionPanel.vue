<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MediaAsset, Project } from '../../core/types'
import type { EditorToolRunner } from './types'
import { workingVideoAsset } from '../../core/video-working-copies'
import { compressionSummary, type CompressionReport } from '../../core/project-video-compression'
import { useEditorTool } from './use-editor-tool'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'

const props = defineProps<{ project: Project; native: boolean; runTool?: EditorToolRunner; disabled?: boolean; asset?: MediaAsset; standalone?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; status: [message: string] }>()
const mode = ref<'lossless' | 'quality'>('quality')
const quality = ref<'high' | 'balanced' | 'compact'>('high')
const currentAsset = computed(() => props.asset ? workingVideoAsset(props.project, props.asset) : undefined)
const originalAsset = computed(() => currentAsset.value?.compression ? props.project.assets.find(asset => asset.id === currentAsset.value!.compression!.originalAssetId) : currentAsset.value)
const summary = computed(() => currentAsset.value ? { sourceCount: 1, compressedCount: currentAsset.value.compression ? 1 : 0, sourceBytes: originalAsset.value?.size ?? currentAsset.value.size, currentBytes: currentAsset.value.size } : compressionSummary(props.project))
const scope = computed(() => currentAsset.value ? { assetIds: [currentAsset.value.id] } : {})
const pendingImport = computed(() => currentAsset.value && !props.project.assets.some(asset => asset.id === currentAsset.value!.id))
const report = ref<CompressionReport>()
const task = useEditorTool(() => props.runTool!, busy => emit('busy', busy))
const blocked = computed(() => !props.native || !props.runTool || props.disabled || task.busy.value)
function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 1) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'], unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`
}
async function compress(): Promise<void> {
  if (blocked.value || !summary.value.sourceCount) return
  report.value = undefined
  const result = await task.execute('open_media_project_video_compress', { ...scope.value, mode: mode.value, ...(mode.value === 'quality' ? { quality: quality.value } : {}) }, '工程视频处理完成')
  if (result === undefined) return
  report.value = result as CompressionReport
  const message = report.value.processedCount
    ? `已替换 ${report.value.processedCount} 个源视频，节省 ${bytes(report.value.savedBytes)}`
    : '没有产生更小的副本，继续使用原视频。'
  task.notice.value = message
  emit('status', message)
}
async function restore(): Promise<void> {
  if (blocked.value || !summary.value.compressedCount) return
  const result = await task.execute('open_media_project_video_restore', scope.value, '已恢复原视频')
  if (result === undefined) return
  report.value = undefined
  emit('status', '已恢复原视频，时间线编辑保持不变。')
}
</script>

<template>
  <section :class="['project-compression', { standalone }]" data-testid="project-video-compression" aria-label="工程视频压缩">
    <header v-if="!standalone"><Icon name="video" :size="16" /><h3>{{ asset ? '压缩视频' : '工程视频压缩' }}</h3><span>{{ summary.sourceCount }} 个源视频</span></header>
    <p v-if="currentAsset" class="compression-source" :title="currentAsset.name">{{ currentAsset.name }}</p>
    <p class="compression-note">{{ asset ? '仅处理当前视频。' : '可在剪辑前处理已导入的视频，同一源文件只处理一次。' }}保留分辨率、帧率与音轨；完成后播放、拖动与效果预览立即使用压缩副本。</p>
    <p v-if="pendingImport" class="compression-note">开始压缩时会将此视频加入本工程素材，原文件保留。</p>
    <div class="compression-overview"><span>当前使用 <strong>{{ bytes(summary.currentBytes) }}</strong></span><span v-if="summary.compressedCount">工作副本 {{ summary.compressedCount }} 个</span></div>
    <fieldset :disabled="blocked">
      <legend class="sr-only">工程视频压缩方式</legend>
      <div class="compression-modes">
        <label :class="{ selected: mode === 'quality' }"><input v-model="mode" type="radio" value="quality" name="project-compression-mode" aria-label="按质量压缩" /><span><strong>按质量压缩</strong><small>兼顾清晰度与处理速度</small></span></label>
        <label :class="{ selected: mode === 'lossless' }"><input v-model="mode" type="radio" value="lossless" name="project-compression-mode" aria-label="无损压缩" /><span><strong>无损压缩</strong><small>逐像素保真，体积可能更大</small></span></label>
      </div>
      <label v-if="mode === 'quality'" class="compression-quality">画面质量<select v-model="quality" aria-label="工程视频压缩质量"><option value="high">高质量（推荐）</option><option value="balanced">均衡</option><option value="compact">更小体积</option></select></label>
      <p class="compression-note compression-mode-help">{{ mode === 'quality' ? '优先使用可用的 GPU，不可用时回退 CPU。优化视频定位，方便播放和分段解码。' : '使用无损编码，不降低解码画面的像素精度。已压缩视频通常难以继续缩小。' }} 结果更大时保留原视频。</p>
      <div class="compression-actions"><button class="compression-primary" data-testid="project-compression-start" :disabled="!summary.sourceCount" @click="compress"><Icon name="convert" :size="15" />{{ asset ? '压缩视频' : '压缩工程视频' }}</button><button v-if="summary.compressedCount" data-testid="project-compression-restore" @click="restore"><Icon name="undo" :size="15" />恢复原视频</button></div>
    </fieldset>
    <p v-if="!native" class="compression-note">工程视频压缩需要桌面端。</p>
    <p v-else-if="!summary.sourceCount" class="compression-note">先导入视频，再处理剪辑工作副本，无需加入时间线。</p>
    <EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
    <div v-if="report?.items.length" class="compression-results" aria-label="工程视频压缩结果">
      <article v-for="(item, index) in report.items" :key="index" :class="{ skipped: item.state === 'skipped' }"><Icon :name="item.state === 'skipped' ? 'info' : 'check'" :size="14" /><div><strong :title="item.originalName">{{ item.originalName }}</strong><span>{{ bytes(item.sourceSize) }}<template v-if="item.state !== 'skipped' && item.outputSize !== undefined"> → {{ bytes(item.outputSize) }}</template><template v-else> · 保留原视频</template></span><small v-if="item.message">{{ item.message }}</small></div></article>
    </div>
    <p class="compression-note compression-retention">原视频保留，可恢复或撤销；便携项目会同时保存原视频和副本。压缩不保证缩短字幕、转场等效果的合成耗时。</p>
  </section>
</template>

<style src="./editor-tools.css"></style>
<style scoped>
.project-compression{margin-top:18px;padding-top:16px;border-top:1px solid var(--ed-border);font-size:11px;color:var(--ed-text)}
.project-compression.standalone{margin-top:0;padding:16px;border:0}.project-compression.standalone .compression-source{margin-top:0}.compression-source{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;margin:12px 0 0}.project-compression header{display:flex;align-items:center;gap:7px}.project-compression header h3{font-size:12px;margin:0}.project-compression header>span{margin-left:auto;color:var(--ed-muted);font-size:10px}.project-compression header>svg{color:var(--ed-accent)}
.compression-note{margin:9px 0;color:var(--ed-muted);font-size:10px;line-height:1.8}.compression-overview{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0;color:var(--ed-muted)}.compression-overview strong{color:var(--ed-text);font-weight:500;font-variant-numeric:tabular-nums}
.project-compression fieldset{margin:0;padding:0;border:0;min-width:0}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.compression-modes{display:grid;grid-template-columns:1fr 1fr;gap:8px}.compression-modes label{display:flex;align-items:center;gap:8px;margin:0;padding:10px;border:1px solid var(--ed-border);border-radius:7px;cursor:pointer;color:var(--ed-text)}.compression-modes label.selected{border-color:var(--ed-accent);background:color-mix(in srgb,var(--ed-accent) 9%,transparent)}.compression-modes input{flex:none;margin:0;width:13px;height:13px;min-height:0;accent-color:var(--ed-accent)}.compression-modes label>span{display:flex;flex-direction:column;gap:3px}.compression-modes strong{font-size:11px;font-weight:500}.compression-modes small{font-size:9px;color:var(--ed-muted);line-height:1.5}
.compression-quality{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0;color:var(--ed-muted)}.compression-quality select{width:175px;height:32px;color:var(--ed-text);background-color:var(--ed-bg);border-color:var(--ed-border)}
.compression-mode-help{min-height:36px}.compression-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.compression-actions button{display:inline-flex;align-items:center;gap:6px;min-height:32px;font-size:11px;padding:7px 10px;background:var(--ed-panel);border:1px solid var(--ed-border);border-radius:6px;color:var(--ed-text)}.compression-actions .compression-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:white}.compression-actions button:disabled{opacity:.45;cursor:not-allowed}
.compression-results{max-height:210px;overflow:auto;margin-top:12px;border:1px solid var(--ed-border);border-radius:7px;overscroll-behavior:contain}.compression-results article{display:flex;align-items:flex-start;gap:7px;padding:9px;border-bottom:1px solid var(--ed-border)}.compression-results article:last-child{border-bottom:0}.compression-results article>svg{margin-top:2px;color:var(--ed-accent)}.compression-results article.skipped>svg{color:var(--ed-muted)}.compression-results article>div{display:flex;min-width:0;flex:1;flex-direction:column;gap:3px}.compression-results strong{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}.compression-results span,.compression-results small{font-size:10px;color:var(--ed-muted);line-height:1.6}.compression-results small{overflow-wrap:anywhere}.compression-retention{margin-bottom:0;padding-top:10px;border-top:1px solid var(--ed-border)}
@media(max-width:420px){.compression-modes{grid-template-columns:1fr}.compression-modes label{padding:9px}.compression-quality select{width:160px}}
</style>
