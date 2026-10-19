<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import type { Project } from '../../core/types'
import type { SpeechAlignmentSettings } from '../../core/speech-timing'
import { inspectSpeechAlignment, previewSpeechAlignment, type SpeechAlignmentPreview } from '../../core/speech-alignment-assist'
import Icon from '../Icon.vue'

const props = defineProps<{ project: Project; disabled?: boolean }>()
const emit = defineEmits<{ change: [project: Project, label: string]; seek: [time: number, clipId?: string]; status: [message: string] }>()
const trackId = ref(''), mode = ref<SpeechAlignmentSettings['mode']>('subtitle'), gap = ref(0.2)
const preview = shallowRef<SpeechAlignmentPreview>(), previewSource = shallowRef<Project>(), error = ref('')
const tracks = computed(() => props.project.tracks.filter(track => track.kind === 'text' && track.clips.some(clip => clip.textRole !== 'watermark')))
const report = computed(() => inspectSpeechAlignment(props.project, trackId.value || undefined))
const visibleIssues = computed(() => report.value.issues.slice(0, 50))
const changed = computed(() => !!preview.value && (preview.value.changes.length > 0 || preview.value.movedMarkerCount > 0))
const canApply = computed(() => changed.value && previewSource.value === props.project && !props.disabled)
function invalidate(): void { preview.value = undefined; previewSource.value = undefined; error.value = '' }
watch([() => props.project, mode, gap, trackId], invalidate, { flush: 'sync' })
watch(() => props.project, project => { if (trackId.value && !project.tracks.some(track => track.id === trackId.value && track.kind === 'text')) trackId.value = '' }, { flush: 'sync' })
function prepare(): void {
  if (props.disabled) return
  invalidate()
  try {
    preview.value = previewSpeechAlignment(props.project, { mode: mode.value, gap: mode.value === 'subtitle' ? 0 : gap.value, textTrackId: trackId.value || undefined })
    previewSource.value = props.project
    if (!changed.value) emit('status', '现有字幕与配音已符合所选对齐策略，无需修改。')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
function apply(): void {
  if (!canApply.value || !preview.value) return
  const result = preview.value
  const label = mode.value === 'subtitle' ? '字幕跟随配音' : mode.value === 'ripple' ? '顺延字幕与配音' : '延长镜头并对齐配音'
  emit('change', result.project, label)
  emit('status', `已对齐 ${result.changedSubtitleCount} 个字幕，移动 ${result.movedSpeechCount} 个配音片段，可一次撤销。`)
  invalidate()
}
function seconds(value: number): string { return `${value.toFixed(2)} 秒` }
function time(value: number): string { return `${Math.floor(value / 60)}:${(value % 60).toFixed(2).padStart(5, '0')}` }
</script>

<template>
  <section class="et-panel speech-alignment-assist" data-testid="speech-alignment-assist">
    <h3>声画对齐</h3>
    <p class="et-note">按现有配音的实际片段时长检查，包含裁剪和变速。字幕跟随配音时保留声音位置与句间停顿。</p>
    <fieldset :disabled="disabled">
      <label class="et-field">字幕范围<select v-model="trackId" aria-label="声画对齐字幕范围"><option value="">全部字幕轨道</option><option v-for="track in tracks" :key="track.id" :value="track.id">{{ track.name }}</option></select></label>
      <div class="alignment-counts"><span>{{ report.entries.length - report.mutedCount }} 段关联配音</span><span :class="{ 'alignment-warning': report.issues.length }">{{ report.issues.length }} 个待检查项</span></div>
      <p v-if="report.unvoicedCount || report.mutedCount" class="et-note">{{ report.unvoicedCount ? `${report.unvoicedCount} 段字幕尚未关联配音` : '' }}{{ report.unvoicedCount && report.mutedCount ? '；' : '' }}{{ report.mutedCount ? `跳过 ${report.mutedCount} 段隐藏或静音配音` : '' }}。</p>
      <div v-if="report.issues.length" class="alignment-issues" aria-label="声画对齐检查结果">
        <button v-for="(issue, index) in visibleIssues" :key="`${issue.kind}-${issue.clipId}-${index}`" class="alignment-issue" @click="emit('seek', issue.time, issue.clipId)">
          <span class="alignment-issue-top"><strong>{{ issue.name }}</strong><span>{{ time(issue.time) }}</span></span><span>{{ issue.message }}</span><span class="alignment-jump"><Icon name="play" :size="11" />定位片段</span>
        </button>
        <p v-if="report.issues.length > visibleIssues.length" class="et-note">已显示前 {{ visibleIssues.length }} 项，可缩小字幕轨道范围继续检查。</p>
      </div>
      <p v-else-if="report.entries.length > report.mutedCount" class="et-note">当前范围未发现字幕时序不一致或配音重叠。</p>
      <label class="et-field alignment-mode">对齐策略<select v-model="mode" aria-label="现有配音对齐策略"><option value="subtitle">字幕跟随现有配音</option><option value="ripple">顺延后续字幕与配音</option><option value="extend_visual">延长镜头并顺延</option></select></label>
      <p v-if="mode === 'subtitle'" class="et-note">只调整字幕起点与时长，配音、视频和音乐保持原有节奏；重叠的配音会保留为待检查项。</p>
      <template v-else><label class="et-field">最小句间停顿 / 秒<input v-model.number="gap" type="number" min="0" max="5" step=".05" aria-label="对齐最小句间停顿" /></label><p class="et-note">保留已有较长停顿，仅在空间不足时向后顺延。</p></template>
      <p v-if="mode === 'ripple'" class="et-note">移动所选范围的后续字幕与关联配音。视频位置保持原样，应用后请检查讲解是否仍对应画面。</p>
      <p v-if="mode === 'extend_visual'" class="et-note">字幕必须对应起止一致的独立镜头。视频及其原声一起减速，后续素材和标记顺延；复杂变速、动画或跨边界内容会阻止应用。</p>
      <button :disabled="!report.entries.some(entry => !entry.muted)" data-testid="speech-alignment-preview" @click="prepare"><Icon name="eye" :size="13" />预览调整</button>
    </fieldset>
    <p v-if="error" class="et-error" role="alert">{{ error }}</p>
    <div v-if="preview" class="alignment-preview" aria-live="polite" data-testid="speech-alignment-preview-result">
      <p v-if="!changed" class="et-note">已符合所选策略，无需修改。</p>
      <template v-else>
        <h4>将进行以下调整</h4>
        <div class="alignment-counts"><span>{{ preview.changedSubtitleCount }} 个字幕</span><span>{{ preview.movedSpeechCount }} 段配音移动</span><span v-if="preview.retimedVisualCount">{{ preview.retimedVisualCount }} 个镜头延长</span><span v-if="preview.movedMarkerCount">{{ preview.movedMarkerCount }} 个标记顺延</span></div>
        <p class="et-note">项目时长：{{ seconds(preview.beforeDuration) }} → {{ seconds(preview.afterDuration) }}。共修改 {{ preview.changes.length }} 个片段，可一次撤销。</p>
        <div class="alignment-changes"><div v-for="item in preview.changes.slice(0, 30)" :key="item.clipId"><strong>{{ item.name }}</strong><span>{{ item.removed ? '关联转场将移除' : `${time(item.beforeStart)} → ${time(item.afterStart)} · ${seconds(item.beforeDuration)} → ${seconds(item.afterDuration)}` }}</span></div></div>
        <p v-if="preview.changes.length > 30" class="et-note">另有 {{ preview.changes.length - 30 }} 个片段同步调整。</p>
        <p v-if="preview.remainingIssues.length" class="alignment-warning">调整后仍有 {{ preview.remainingIssues.length }} 个待检查项，可选择顺延策略或逐段检查。</p>
        <button class="et-primary" :disabled="!canApply" data-testid="speech-alignment-apply" @click="apply">应用本次调整</button>
      </template>
    </div>
  </section>
</template>

<style src="./editor-tools.css"></style>
<style scoped>
.alignment-counts{display:flex;gap:7px 12px;flex-wrap:wrap;font-size:11px;line-height:1.7}.alignment-warning{color:var(--ui-warning,#b17726);font-size:11px;line-height:1.7}.alignment-issues{display:grid;gap:7px;max-height:260px;overflow:auto;margin-top:10px;padding-right:3px}.alignment-issue{display:flex!important;align-items:stretch!important;text-align:left;flex-direction:column;gap:5px!important;padding:9px!important;line-height:1.6;white-space:normal}.alignment-issue-top{display:flex;justify-content:space-between;gap:10px}.alignment-issue-top strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px}.alignment-issue-top>span,.alignment-jump{color:var(--ed-muted,var(--ui-muted));font-size:10px;flex:none}.alignment-jump{display:flex;align-items:center;gap:4px}.alignment-mode{margin-top:14px!important}.alignment-preview{border-top:1px solid var(--ed-border,var(--ui-line));padding-top:12px;margin-top:12px}.alignment-preview h4{margin:0 0 10px;font-size:12px;font-weight:600}.alignment-changes{max-height:200px;overflow:auto;display:grid;gap:7px;margin-bottom:12px}.alignment-changes>div{display:flex;flex-direction:column;gap:3px;font-size:10px;line-height:1.5}.alignment-changes strong{font-weight:500;overflow-wrap:anywhere}.alignment-changes span{color:var(--ed-muted,var(--ui-muted));font-variant-numeric:tabular-nums}
</style>
