<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Clip, Project } from '../../core/types'
import { projectDuration } from '../../core/timeline'
import type { EditorToolRunner } from './types'
import { toolData } from './types'
import { useEditorTool } from './use-editor-tool'
import EditorToolStatus from './EditorToolStatus.vue'

const props = defineProps<{ clip: Clip; project: Project; run: EditorToolRunner; native: boolean; disabled?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const task = useEditorTool(() => props.run, busy => emit('busy', busy))
const denoise = ref(.25), deess = ref(0), compress = ref(false), limiter = ref(true)
const low = ref(0), mid = ref(0), high = ref(0), targetLufs = ref(-16), truePeak = ref(-1)
const duckTrackIds = ref<string[]>([]), reduction = ref(12), attack = ref(.1), release = ref(.3)
const musicDuration = ref(Math.max(1, projectDuration(props.project))), bpm = ref<number>(), fadeOut = ref(2)
const audioTracks = computed(() => props.project.tracks.filter(track => track.kind === 'audio' && track.clips.some(clip => clip.id !== props.clip.id)))
const blocked = computed(() => props.disabled || !props.native || task.busy.value)
const data = computed(() => toolData(task.result.value))
const silentIntervals = computed(() => Array.isArray(data.value.silenceIntervals) ? data.value.silenceIntervals as { start: number; end: number; duration: number }[] : [])
const report = computed(() => {
  const data = toolData(task.result.value), rows: { label: string; value: unknown }[] = []
  for (const [key, value] of Object.entries(data)) {
    if (['before', 'after'].includes(key) && value && typeof value === 'object') {
      for (const [metric, measured] of Object.entries(value)) if (labels[metric]) rows.push({ label: `${key === 'before' ? '处理前' : '处理后'} · ${labels[metric]}`, value: measured ?? '未测得' })
    } else if (labels[key]) rows.push({ label: labels[key], value: value ?? '未测得' })
    else if (key === 'silent' && value === true) rows.push({ label: '检测结果', value: '当前片段为静音，无法测得综合响度' })
  }
  return rows
})
const labels: Record<string, string> = { integratedLufs: '综合响度 / LUFS', inputI: '综合响度 / LUFS', loudnessRange: '响度范围 / LU', inputLra: '响度范围 / LU', truePeakDb: '真实峰值 / dBTP', truePeakDbtp: '真实峰值 / dBTP', thresholdLufs: '响度门限 / LUFS', scope: '测量范围', peakDbfs: '样本峰值 / dBFS', analyzedDuration: '分析时长 / 秒', note: '说明', inputTp: '真实峰值 / dBTP', duration: '时长 / 秒', targetLufs: '目标响度 / LUFS', gainDb: '增益 / dB' }
function run(name: string, args: Record<string, unknown>, notice: string): Promise<unknown> { return task.execute(`open_media_${name}`, { clipId: props.clip.id, ...args }, notice) }
</script>
<template>
  <section class="et-panel et-inline" data-testid="audio-clip-tools">
    <p v-if="!native" class="et-note">音频处理需要桌面版运行环境。</p>
    <details class="et-section"><summary>音频清理与均衡</summary><fieldset :disabled="blocked"><div class="et-grid"><label class="et-field">降噪强度<input v-model.number="denoise" type="number" min="0" max="1" step=".05" aria-label="音频降噪强度" /></label><label class="et-field">去齿音强度<input v-model.number="deess" type="number" min="0" max="1" step=".05" aria-label="音频去齿音强度" /></label></div><div class="et-grid"><label class="et-field">低频 / dB<input v-model.number="low" type="number" min="-12" max="12" step="1" aria-label="低频增益" /></label><label class="et-field">中频 / dB<input v-model.number="mid" type="number" min="-12" max="12" step="1" aria-label="中频增益" /></label><label class="et-field">高频 / dB<input v-model.number="high" type="number" min="-12" max="12" step="1" aria-label="高频增益" /></label></div><label class="et-check"><input v-model="compress" type="checkbox" />动态压缩</label><label class="et-check"><input v-model="limiter" type="checkbox" />限制峰值</label><button class="et-primary" @click="run('audio_process', { denoise, deess, eq: { lowGain: low, midGain: mid, highGain: high }, compress, limiter }, '已替换为处理后的音频，可在片段播放按钮试听')">应用音频处理</button></fieldset></details>
    <details class="et-section"><summary>响度分析与统一</summary><p class="et-note">测量包含片段音量，位于淡入淡出之前，不混合其他轨道。</p><fieldset :disabled="blocked"><button @click="run('audio_loudness_analyze', {}, '响度分析完成')">分析当前音频</button><div class="et-grid" style="margin-top:12px"><label class="et-field">目标 / LUFS<input v-model.number="targetLufs" type="number" min="-36" max="-5" step="1" aria-label="目标综合响度" /></label><label class="et-field">峰值 / dBTP<input v-model.number="truePeak" type="number" min="-9" max="0" step=".5" aria-label="最大真实峰值" /></label></div><button class="et-primary" @click="run('audio_normalize', { targetLufs, truePeak }, '音频响度已统一')">统一响度</button></fieldset></details>
    <details class="et-section"><summary>配音时压低背景音</summary><fieldset :disabled="blocked"><p class="et-note">选择作为配音依据的音频轨道，处理结果替换当前片段。</p><label v-for="track in audioTracks" :key="track.id" class="et-check"><input v-model="duckTrackIds" type="checkbox" :value="track.id" />{{ track.name }}</label><div class="et-grid"><label class="et-field">压低 / dB<input v-model.number="reduction" type="number" min="0" max="36" step="1" aria-label="背景音压低幅度" /></label><label class="et-field">进入 / 秒<input v-model.number="attack" type="number" min=".01" max="5" step=".05" aria-label="背景音压低进入时间" /></label><label class="et-field">恢复 / 秒<input v-model.number="release" type="number" min=".01" max="5" step=".05" aria-label="背景音恢复时间" /></label></div><button class="et-primary" :disabled="!duckTrackIds.length" @click="run('audio_ducking', { speechTrackIds: duckTrackIds, reductionDb: reduction, attack, release }, '背景音压低已应用')">应用自动压低</button></fieldset></details>
    <details class="et-section"><summary>音乐适配时长</summary><fieldset :disabled="blocked"><div class="et-grid"><label class="et-field">目标时长 / 秒<input v-model.number="musicDuration" type="number" min=".1" max="86400" step=".1" aria-label="音乐目标时长" /></label><label class="et-field">节拍 / BPM<input v-model.number="bpm" type="number" min="30" max="300" placeholder="可选" aria-label="音乐节拍" /></label><label class="et-field">结尾淡出 / 秒<input v-model.number="fadeOut" type="number" min="0" :max="Math.min(30, musicDuration)" step=".1" aria-label="音乐结尾淡出" /></label></div><button class="et-primary" @click="run('music_fit_duration', { duration: musicDuration, ...(bpm ? { bpm } : {}), fadeOut }, '音乐时长已适配')">适配时长</button></fieldset></details>
    <EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
    <p v-if="data.possibleClipping === true" class="et-note">检测到峰值削波风险，请降低音量并试听确认；这不代表已确认发生削波。</p>
    <div v-if="silentIntervals.length" class="et-result"><p class="et-note">静音区间（相对于当前片段）</p><table><thead><tr><th>开始 / 秒</th><th>结束 / 秒</th><th>持续 / 秒</th></tr></thead><tbody><tr v-for="(interval, index) in silentIntervals" :key="index"><td>{{ interval.start.toFixed(2) }}</td><td>{{ interval.end.toFixed(2) }}</td><td>{{ interval.duration.toFixed(2) }}</td></tr></tbody></table></div>
    <div v-if="report.length" class="et-result"><dl><template v-for="row in report" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ typeof row.value === 'number' ? Number(row.value.toFixed(2)) : row.value }}</dd></template></dl></div>
  </section>
</template>
<style src="./editor-tools.css"></style>
