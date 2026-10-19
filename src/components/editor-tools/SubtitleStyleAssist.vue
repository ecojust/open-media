<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Project } from '../../core/types'
import { applySubtitleStyleUnification, listStyleSubtitles, planSubtitleStyleUnification, subtitleStyleIssues } from '../../core/subtitle-style-assist'
import Icon from '../Icon.vue'

const props = defineProps<{ project: Project; selectedClipId?: string; disabled?: boolean }>()
const emit = defineEmits<{ change: [project: Project, label: string]; seek: [time: number, clipId?: string]; status: [message: string] }>()
const sourceClipId = ref(''), targetTrackIds = ref<string[]>([]), rememberAsDefault = ref(true), notice = ref(''), error = ref('')
const subtitles = computed(() => listStyleSubtitles(props.project))
const tracks = computed(() => props.project.tracks.filter(track => subtitles.value.some(item => item.trackId === track.id)))
const issues = computed(() => subtitleStyleIssues(props.project))
const options = computed(() => ({ sourceClipId: sourceClipId.value, targetTrackIds: targetTrackIds.value, rememberAsDefault: rememberAsDefault.value }))
const plan = computed(() => {
  if (!subtitles.value.some(item => item.clipId === sourceClipId.value)) return undefined
  return planSubtitleStyleUnification(props.project, options.value)
})
const canApply = computed(() => !!plan.value && (!!plan.value.changes.length || plan.value.defaultChanged))
let initializedProjectId = ''
watch([() => props.project.id, subtitles, tracks], () => {
  const newProject = initializedProjectId !== props.project.id
  if (newProject) {
    initializedProjectId = props.project.id
    targetTrackIds.value = tracks.value.filter(track => !track.locked).map(track => track.id)
    notice.value = ''; error.value = ''
  } else targetTrackIds.value = targetTrackIds.value.filter(id => tracks.value.some(track => track.id === id))
  if (newProject || !subtitles.value.some(item => item.clipId === sourceClipId.value)) {
    sourceClipId.value = subtitles.value.find(item => item.clipId === props.selectedClipId)?.clipId ?? subtitles.value[0]?.clipId ?? ''
  }
}, { immediate: true })
watch(() => props.selectedClipId, id => {
  if (id && subtitles.value.some(item => item.clipId === id)) sourceClipId.value = id
})
watch([sourceClipId, targetTrackIds, rememberAsDefault], () => { notice.value = ''; error.value = '' })
function timeLabel(time: number): string {
  const seconds = Math.max(0, Math.floor(time))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
function apply(): void {
  if (props.disabled || !canApply.value) return
  error.value = ''
  try {
    const currentPlan = planSubtitleStyleUnification(props.project, options.value)
    const next = applySubtitleStyleUnification(props.project, options.value)
    if (next === props.project) return
    emit('change', next, '统一字幕样式')
    notice.value = `已统一 ${currentPlan.changes.length} 条字幕${currentPlan.defaultChanged ? '，并保存为新字幕默认样式' : ''}。可撤销本次操作。`
    emit('status', notice.value)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
</script>

<template>
  <section class="et-panel subtitle-style-assist" data-testid="subtitle-style-assist">
    <h3>统一字幕样式</h3>
    <p class="et-note">用一条字幕统一字体、颜色、背景、位置、大小、对齐与淡入淡出。文字内容、时间和配音关联保持不变。</p>
    <p v-if="!subtitles.length" class="et-note">先在时间线上添加字幕，即可统一样式并检查字幕内容。</p>
    <fieldset v-else :disabled="disabled">
      <label class="et-field">参考字幕
        <select v-model="sourceClipId" aria-label="参考字幕">
          <option v-for="subtitle in subtitles" :key="subtitle.clipId" :value="subtitle.clipId">{{ timeLabel(subtitle.start) }} · {{ subtitle.trackName }} · {{ subtitle.text.trim().slice(0, 36) || '空字幕' }}</option>
        </select>
      </label>
      <button v-if="plan" @click="emit('seek', plan.source.start, plan.source.clipId)"><Icon name="search" :size="14" />定位参考字幕</button>
      <p v-if="plan?.source.animated" class="et-note">参考字幕包含动画，仅提取基础样式，不复制关键帧。</p>
      <div class="ssa-targets">
        <div class="ssa-target-heading"><span>应用到字幕轨道</span><button @click="targetTrackIds = tracks.filter(track => !track.locked).map(track => track.id)">选择可编辑轨道</button></div>
        <label v-for="track in tracks" :key="track.id" class="et-check">
          <input v-model="targetTrackIds" type="checkbox" :value="track.id" :aria-label="`统一轨道：${track.name}`" />
          <span>{{ track.name }}</span><span class="et-chip">{{ subtitles.filter(item => item.trackId === track.id).length }} 条</span><span v-if="track.locked" class="et-chip">已锁定</span>
        </label>
      </div>
      <label class="et-check"><input v-model="rememberAsDefault" type="checkbox" />同时设为后续新字幕的默认样式</label>
      <div v-if="plan" class="ssa-summary" aria-live="polite" data-testid="subtitle-style-summary">
        <strong>将修改 {{ plan.changes.length }} 条字幕</strong>
        <span>样式相同 {{ plan.unchanged.length }} 条 · 锁定跳过 {{ plan.locked.length }} 条 · 动画跳过 {{ plan.animated.length }} 条</span>
        <span v-if="plan.defaultChanged">将更新后续新字幕的默认样式</span>
      </div>
      <p class="et-note">参考字幕不参与修改；带位置、缩放、旋转或透明度关键帧的字幕将跳过，以保留已有动画。短字幕的淡入淡出会按实际时长缩短。</p>
      <button class="et-primary" :disabled="!canApply" @click="apply"><Icon name="check" :size="14" />应用字幕样式</button>
    </fieldset>
    <p v-if="error" class="et-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="et-notice" role="status">{{ notice }}</p>
    <div v-if="subtitles.length" class="ssa-issues">
      <h3>字幕内容检查 <span class="et-chip">{{ issues.length }} 处</span></h3>
      <p v-if="!issues.length" class="et-note">未发现空字幕或未替换的默认文字。</p>
      <div v-else class="ssa-issue-list">
        <button v-for="issue in issues" :key="issue.clipId" :disabled="disabled" @click="emit('seek', issue.start, issue.clipId)">
          <Icon name="alert" :size="14" /><span><strong>{{ issue.message }}</strong><small>{{ timeLabel(issue.start) }} · {{ issue.trackName }}</small></span><span>定位</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style src="./editor-tools.css"></style>
<style scoped>
.ssa-targets{margin:14px 0;padding:10px;border:1px solid var(--ed-border,var(--ui-line));border-radius:8px;max-height:220px;overflow:auto}
.ssa-target-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:11px;color:var(--ed-muted,var(--ui-muted))}
.ssa-target-heading button{font-size:10px;min-height:26px;padding:3px 6px}
.ssa-targets .et-check>span:first-of-type{flex:1;min-width:0;overflow-wrap:anywhere}
.ssa-summary{display:grid;gap:6px;padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--ed-accent,var(--ui-accent)) 8%,transparent);font-size:11px;line-height:1.6;margin:12px 0}
.ssa-summary strong{font-size:12px}.ssa-summary span{color:var(--ed-muted,var(--ui-muted))}
.ssa-issues{border-top:1px solid var(--ed-border,var(--ui-line));padding-top:14px;margin-top:18px}.ssa-issues h3{display:flex;align-items:center;gap:8px}
.ssa-issue-list{display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto}.ssa-issue-list button{justify-content:flex-start;text-align:left;padding:9px}.ssa-issue-list button>span:first-of-type{flex:1;min-width:0;display:grid;gap:5px}.ssa-issue-list strong{font-size:11px;font-weight:500}.ssa-issue-list small{color:var(--ed-muted,var(--ui-muted));overflow-wrap:anywhere}
</style>
