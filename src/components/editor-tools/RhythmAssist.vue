<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Project } from '../../core/types'
import { cloneProject } from '../../core/project'
import { addRhythmMarkers, analyzeRhythm, RHYTHM_LABELS, rhythmSelectedDuration, rhythmSignature, rhythmTime, rhythmVideoEntries, type RhythmKind, type RhythmReport, type RhythmScope } from '../../core/rhythm-assist'
import type { EditorToolRunner } from './types'
import { useEditorTool } from './use-editor-tool'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'

const props = defineProps<{ project: Project; selectedClipId?: string; runTool?: EditorToolRunner; disabled?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; status: [message: string]; seek: [time: number, clipId?: string]; change: [project: Project, label: string] }>()
const selectedVideo = computed(() => rhythmVideoEntries(props.project, 'selected', props.selectedClipId)[0])
const scope = ref<RhythmScope>(selectedVideo.value ? 'selected' : 'project'), minimum = ref(2), noiseDb = ref(-45)
const selected = ref<string[]>([]), kinds = ref<RhythmKind[]>(['black', 'freeze', 'silence', 'repeat']), page = ref(0)
const pageSize = 30, changedDuringAnalysis = ref(false)
const signature = computed(() => rhythmSignature(props.project))
const task = useEditorTool(() => async (_name, _args, options) => {
  if (!props.runTool) throw new Error('节奏分析需要桌面版运行环境。')
  return analyzeRhythm(cloneProject(props.project), { scope: scope.value, selectedClipId: props.selectedClipId, minimum: minimum.value, noiseDb: noiseDb.value }, props.runTool, options)
}, busy => emit('busy', busy))
const report = computed(() => task.result.value as RhythmReport | undefined)
const stale = computed(() => Boolean(report.value && report.value.signature !== signature.value))
const visible = computed(() => report.value?.candidates.filter(item => item.evidence.some(evidence => kinds.value.includes(evidence.kind))) || [])
const pages = computed(() => Math.max(1, Math.ceil(visible.value.length / pageSize)))
const rows = computed(() => visible.value.slice(page.value * pageSize, (page.value + 1) * pageSize))
const chosen = computed(() => report.value?.candidates.filter(item => selected.value.includes(item.id)) || [])
const duration = computed(() => rhythmSelectedDuration(chosen.value))
const controlsDisabled = computed(() => Boolean(props.disabled || task.busy.value))

watch(signature, () => {
  selected.value = []
  if (task.busy.value) { changedDuringAnalysis.value = true; task.cancel() }
})
watch(() => props.selectedClipId, () => { if (!selectedVideo.value && scope.value === 'selected' && !task.busy.value) scope.value = 'project' })
watch(kinds, () => { page.value = 0 }, { deep: true })

async function analyze(): Promise<void> {
  if (controlsDisabled.value || !props.runTool) return
  selected.value = []; page.value = 0; changedDuringAnalysis.value = false
  const result = await task.execute('rhythm-analysis', {}, '分析完成，请结合画面和讲解检查候选区间。') as RhythmReport | undefined
  if (result) {
    const message = `已分析 ${result.assetCount} 个源素材，找到 ${result.candidates.length} 处节奏候选${result.errors.length ? `；${result.errors.length} 个素材未完成` : ''}`
    task.notice.value = message; emit('status', message)
  }
}
function toggle(id: string, checked: boolean): void {
  selected.value = checked ? [...new Set([...selected.value, id])] : selected.value.filter(value => value !== id)
}
function addMarkers(): void {
  if (!report.value || stale.value || controlsDisabled.value) return
  try {
    const project = addRhythmMarkers(props.project, report.value, selected.value)
    if (project !== props.project) emit('change', project, '添加节奏检查标记')
    const message = project === props.project ? '所选区间已有检查标记' : `已为 ${chosen.value.length} 个区间添加检查标记，可撤销`
    task.notice.value = message; task.error.value = ''; emit('status', message)
  } catch (cause) { task.error.value = cause instanceof Error ? cause.message : String(cause) }
}
</script>

<template>
  <section class="et-panel rhythm-assist" data-testid="rhythm-assist">
    <p class="et-note">识别值得回看的黑场、静止、静音和相似画面。结果按当前裁切与变速映射到时间线，先检查再决定是否精简。</p>
    <p v-if="!runTool" class="et-note">节奏分析需要桌面版运行环境。</p>
    <fieldset :disabled="controlsDisabled">
      <label class="et-field">分析范围<select v-model="scope" aria-label="节奏分析范围"><option value="selected" :disabled="!selectedVideo">选中的视频片段{{ selectedVideo ? ` · ${selectedVideo.clip.name}` : '' }}</option><option value="project">项目中的所有视频片段</option></select></label>
      <div class="et-grid"><label class="et-field">最短持续 / 秒<input v-model.number="minimum" type="number" min=".5" max="60" step=".5" aria-label="节奏最短持续时长" /></label><label class="et-field">静音阈值 / dB<input v-model.number="noiseDb" type="number" min="-80" max="-10" step="1" aria-label="节奏静音阈值" /></label></div>
      <p class="et-note">同一源视频只分析一次。已隐藏的轨道、主动定格和内置装饰素材不参与检测。</p>
      <button class="et-primary" :disabled="!runTool || scope === 'selected' && !selectedVideo" data-testid="rhythm-analyze" @click="analyze"><Icon name="search" :size="14" />{{ report ? '重新分析' : '分析节奏' }}</button>
    </fieldset>
    <EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
    <p v-if="task.busy.value" class="et-note">进度按已完成素材统计；正在解码分析的素材可能暂时没有百分比变化，可随时取消。</p>
    <p v-if="stale || changedDuringAnalysis" class="rhythm-warning" role="status"><Icon name="alert" :size="14" />时间线或素材已改变，请重新分析；旧结果不能定位或添加标记。</p>
    <template v-if="report">
      <p class="et-note">已检查 {{ report.clipCount }} 个片段 · {{ report.assetCount }} 个源素材。置信度表示检测阈值或画面相似程度，不代表该段应该删除。</p>
      <p v-if="report.candidates.length" class="et-note">最短持续时长按每种检测的连续区间判断；不同检测重叠时，会按依据变化分段显示，因此单行可能短于设定值。</p>
      <p v-if="report.noAudioAssets.length" class="et-note">{{ report.noAudioAssets.join('、') }} 没有音轨。静止画面可能正在展示重要信息，不能据此判断为等待。</p>
      <p v-if="report.repetitionLimited" class="et-note">相似画面检测仅覆盖源素材前 180 秒；黑场、静止和静音覆盖完整素材。</p>
      <div v-if="report.errors.length" class="rhythm-errors" role="alert"><p v-for="error in report.errors" :key="error">{{ error }}</p></div>
      <fieldset :disabled="stale || controlsDisabled">
        <div class="rhythm-filters" aria-label="节奏候选筛选"><label v-for="(label, kind) in RHYTHM_LABELS" :key="kind" class="et-check"><input v-model="kinds" type="checkbox" :value="kind" />{{ label }}</label></div>
        <div v-if="report.candidates.length" class="rhythm-summary"><span>勾选 {{ chosen.length }} 处 · 覆盖 {{ duration.toFixed(2) }} 秒</span><button :disabled="!visible.length" @click="selected = [...new Set([...selected, ...visible.map(item => item.id)])]">勾选筛选结果</button><button :disabled="!selected.length" @click="selected = []">清空</button></div>
        <p v-if="chosen.length" class="et-note">这是可供精简评估的区间总时长，已去除重叠；字幕、配音或转场重叠的区间需要先确认内容衔接。</p>
        <div class="rhythm-candidates">
          <article v-for="candidate in rows" :key="candidate.id" class="rhythm-candidate" data-testid="rhythm-candidate">
            <div class="rhythm-candidate-heading"><label class="et-check"><input type="checkbox" :checked="selected.includes(candidate.id)" :aria-label="`选择 ${rhythmTime(candidate.start)} 的候选`" @change="toggle(candidate.id, ($event.target as HTMLInputElement).checked)" /><strong>{{ rhythmTime(candidate.start) }}–{{ rhythmTime(candidate.end) }}</strong></label><span>{{ (candidate.end - candidate.start).toFixed(2) }} 秒</span></div>
            <p class="rhythm-source">{{ candidate.trackName }} · {{ candidate.clipName }}</p>
            <ul class="rhythm-evidence"><li v-for="evidence in candidate.evidence" :key="evidence.kind"><span class="et-chip">{{ RHYTHM_LABELS[evidence.kind] }}</span><span>{{ evidence.description }}</span><small>置信度 {{ Math.round(evidence.confidence * 100) }}%</small></li></ul>
            <p v-if="candidate.context.length" class="rhythm-context"><Icon name="info" :size="13" />{{ candidate.context.join(' · ') }}</p>
            <div class="rhythm-candidate-actions"><span>源 {{ rhythmTime(candidate.sourceStart) }}–{{ rhythmTime(candidate.sourceEnd) }}</span><button :aria-label="`定位 ${rhythmTime(candidate.start)}`" @click="emit('seek', candidate.start, candidate.clipId)"><Icon name="mark-in" :size="13" />定位</button></div>
          </article>
        </div>
        <p v-if="!visible.length" class="et-note">{{ report.candidates.length ? '当前筛选没有候选区间。' : report.errors.length ? '已完成的素材中没有符合阈值的候选；请检查上方失败原因。' : '未发现符合当前阈值的候选区间。' }}</p>
        <div v-if="pages > 1" class="rhythm-pagination"><button :disabled="page === 0" aria-label="上一页候选" @click="page--"><Icon name="chevron-left" :size="14" /></button><span>{{ page + 1 }} / {{ pages }} · {{ visible.length }} 处</span><button :disabled="page >= pages - 1" aria-label="下一页候选" @click="page++"><Icon name="chevron-right" :size="14" /></button></div>
        <div class="et-actions"><button class="et-primary" :disabled="!selected.length" data-testid="rhythm-add-markers" @click="addMarkers"><Icon name="mark-in" :size="14" />添加检查标记</button></div>
      </fieldset>
    </template>
  </section>
</template>

<style src="./editor-tools.css"></style>
<style scoped>
.rhythm-filters{display:flex;gap:12px;flex-wrap:wrap}.rhythm-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}.rhythm-summary>span{margin-right:auto;font-size:11px}.rhythm-summary button{font-size:10px;padding:3px 7px;min-height:26px}.rhythm-candidates{max-height:440px;overflow:auto;overscroll-behavior:contain}.rhythm-candidate{border:1px solid var(--ed-border,var(--ui-line));border-radius:8px;margin:8px 0;padding:10px;background:var(--ed-panel,var(--ui-surface))}.rhythm-candidate-heading{display:flex;gap:8px;justify-content:space-between;align-items:center;font-size:10px}.rhythm-candidate-heading .et-check{margin:0;font-size:11px}.rhythm-candidate-heading>span{flex:none;color:var(--ed-muted,var(--ui-muted))}.rhythm-source{font-size:11px;color:var(--ed-muted,var(--ui-muted));margin:7px 0;overflow-wrap:anywhere}.rhythm-evidence{display:flex;flex-direction:column;gap:6px;margin:8px 0;padding:0;list-style:none}.rhythm-evidence li{display:flex;align-items:center;flex-wrap:wrap;gap:5px;font-size:11px;line-height:1.5}.rhythm-evidence small{font-size:10px;color:var(--ed-muted,var(--ui-muted));margin-left:auto}.rhythm-context,.rhythm-warning{display:flex;gap:6px;align-items:flex-start;line-height:1.6;font-size:11px;color:var(--ui-warning,#bd852f);margin:8px 0}.rhythm-context svg,.rhythm-warning svg{flex:none;margin-top:2px}.rhythm-candidate-actions{display:flex;gap:8px;justify-content:space-between;align-items:center;font-size:10px;color:var(--ed-muted,var(--ui-muted))}.rhythm-candidate-actions button{font-size:10px;min-height:26px;padding:3px 7px}.rhythm-pagination{display:flex;justify-content:center;align-items:center;gap:12px;font-size:11px;margin:10px 0}.rhythm-errors{color:var(--ui-danger,#c34454);font-size:11px;overflow-wrap:anywhere}
</style>
