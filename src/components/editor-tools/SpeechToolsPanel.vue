<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { getToolArtifact } from '../../core/tool-artifacts'
import { saveToolFile } from './save-tool-file'
import type { EditorToolRunner } from './types'
import { toolData } from './types'
import { useEditorTool } from './use-editor-tool'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'
const props = defineProps<{ run: EditorToolRunner; disabled?: boolean; selectedClipId?: string }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const task = useEditorTool(() => props.run, busy => emit('busy', busy))
const entries = ref<{ text: string; pronunciation: string }[]>([]), loaded = ref(false), alignmentLoaded = ref(false)
const mode = ref('subtitle'), gap = ref(0), rate = ref(1), scope = ref('all'), previewText = ref(''), previewUrl = ref('')
const timing = ref<Record<string, unknown>[]>([])
const blocked = computed(() => props.disabled || task.busy.value)
async function load(): Promise<void> {
  const dictionary = await task.execute('open_media_speech_pronunciation_get', {}, '')
  if (dictionary !== undefined) { const data = toolData(dictionary); entries.value = Array.isArray(data.entries) ? data.entries as typeof entries.value : []; loaded.value = true }
  const alignment = await task.execute('open_media_speech_alignment_get', {}, '')
  if (alignment !== undefined) { const data = toolData(alignment); mode.value = String(data.mode || 'subtitle'); gap.value = Number(data.gap) || 0; alignmentLoaded.value = true }
}
async function estimate(): Promise<void> {
  const value = await task.execute('open_media_speech_timing_plan', { rate: rate.value, ...(scope.value === 'selected' && props.selectedClipId ? { clipIds: [props.selectedClipId] } : {}) }, '配音时长规划完成')
  const data = toolData(value); const items = data.segments || data.items || data.sources || data.plan
  timing.value = Array.isArray(items) ? items as Record<string, unknown>[] : []
}
let previewGeneration = 0, disposed = false
const previewName = ref('配音试听.wav')
function clearPreview(): void { previewGeneration++; if (previewUrl.value.startsWith('blob:')) URL.revokeObjectURL(previewUrl.value); previewUrl.value = '' }
async function preview(): Promise<void> {
  clearPreview(); const request = previewGeneration
  const value = await task.execute('open_media_speech_generate_preview', { text: previewText.value.trim(), rate: rate.value }, '试听已生成，不会添加到时间线')
  if (value === undefined || disposed || request !== previewGeneration) return
  try {
    const data = toolData(value)
    if (typeof data.artifactId !== 'string') throw new Error('试听结果没有可读取的音频文件。')
    const artifact = await getToolArtifact(data.artifactId)
    if (disposed || request !== previewGeneration) return
    previewUrl.value = URL.createObjectURL(artifact.blob); previewName.value = artifact.metadata.name
  } catch (cause) { if (!disposed && request === previewGeneration) { task.error.value = cause instanceof Error ? cause.message : String(cause); task.notice.value = '' } }
}
async function savePreview(): Promise<void> { try { await saveToolFile(await (await fetch(previewUrl.value)).blob(), previewName.value) } catch (cause) { task.error.value = cause instanceof Error ? cause.message : String(cause) } }
onBeforeUnmount(() => { disposed = true; clearPreview() })
function duration(value: unknown): string { const number = Number(value); return Number.isFinite(number) ? `${number.toFixed(2)} 秒` : '—' }
</script>
<template>
  <details class="et-panel speech-tool-settings" data-testid="speech-tools-panel" @toggle="($event.target as HTMLDetailsElement).open && !loaded && !task.busy.value && load()"><summary>读法、时长与对齐设置</summary><fieldset :disabled="blocked">
    <details class="et-section"><summary>读法词典</summary><p class="et-note">指定文字的替换读法，适用于之后生成的配音。</p><button v-if="!loaded" @click="load">读取当前设置</button><template v-else><div class="pronunciation-list"><div v-for="(entry, index) in entries" :key="index" class="pronunciation-entry"><div class="et-grid"><label class="et-field">文字<input v-model="entry.text" maxlength="80" :aria-label="`词典 ${index + 1} 原文`" /></label><label class="et-field">读法<input v-model="entry.pronunciation" maxlength="160" :aria-label="`词典 ${index + 1} 读法`" /></label></div><button :aria-label="`删除读法 ${index + 1}`" @click="entries.splice(index, 1)"><Icon name="trash" :size="13" /></button></div></div><div class="et-actions"><button :disabled="entries.length >= 200" @click="entries.push({ text: '', pronunciation: '' })"><Icon name="plus" :size="13" />新增读法</button><button class="et-primary" :disabled="entries.some(entry => !entry.text.trim() || !entry.pronunciation.trim())" @click="task.execute('open_media_speech_pronunciation_set', { entries }, '读法词典已保存')">保存读法</button></div></template></details>
    <details class="et-section"><summary>时长规划与生成对齐</summary><div class="et-grid"><label class="et-field">规划范围<select v-model="scope" aria-label="配音规划范围"><option value="all">全部字幕</option><option v-if="selectedClipId" value="selected">当前字幕</option></select></label><label class="et-field">语速参考<input v-model.number="rate" type="number" min=".5" max="2" step=".05" aria-label="配音规划语速" /></label></div><button @click="estimate">检查字幕时长</button><p class="et-note">规划结果为预计时长，实际长度以生成的语音为准。</p><button v-if="!alignmentLoaded" @click="load">读取对齐设置</button><template v-if="alignmentLoaded"><label class="et-field">生成后的对齐方式<select v-model="mode" aria-label="配音生成对齐策略"><option value="subtitle">调整字幕以匹配配音</option><option value="ripple">顺延后续字幕与配音</option><option value="extend_visual">延长画面（减速）</option></select></label><label class="et-field">片段间隔 / 秒<input v-model.number="gap" type="number" min="0" max="5" step=".05" aria-label="配音片段间隔" /></label><button class="et-primary" @click="task.execute('open_media_speech_alignment_set', { mode, gap }, '后续配音的对齐策略已保存')">保存对齐策略</button></template></details>
    <details class="et-section"><summary>自定义语料试听</summary><label class="et-field">试听文字<textarea v-model="previewText" maxlength="2000" rows="3" aria-label="自定义配音试听文字" /></label><button :disabled="!previewText.trim()" @click="preview"><Icon name="play" :size="13" />使用当前音色生成试听</button></details>
    </fieldset><EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" /><audio v-if="previewUrl" :src="previewUrl" controls preload="metadata" aria-label="自定义配音试听" style="width:100%;margin-top:12px" /><button v-if="previewUrl" @click="savePreview"><Icon name="download" :size="13" />保存试听音频</button><div v-if="timing.length" class="et-result"><table><thead><tr><th>字幕</th><th>预计时长</th><th>可用时长</th><th>提示</th></tr></thead><tbody><tr v-for="(item, index) in timing" :key="String(item.clipId || index)"><td>{{ item.text || item.name || `字幕 ${index + 1}` }}</td><td>{{ duration(item.estimateSeconds ?? item.estimatedDuration ?? item.duration) }}</td><td>{{ duration(item.availableSeconds ?? item.availableDuration ?? item.available) }}</td><td>{{ ({ 'likely-overflow': '预计超出字幕时长', 'possible-overflow': '可能超出字幕时长', 'fits-estimate': '预计可容纳' } as Record<string, string>)[String(item.risk)] || item.message || '—' }}</td></tr></tbody></table></div></details>
</template>
<style src="./editor-tools.css"></style>
<style scoped>
.speech-tool-settings{border-top:1px solid var(--ed-border)}.speech-tool-settings>summary{font-size:12px;font-weight:600;cursor:pointer}.pronunciation-list{max-height:220px;overflow:auto}.pronunciation-entry{display:flex;align-items:center;gap:7px}.pronunciation-entry>.et-grid{flex:1;min-width:0}.pronunciation-entry>.et-grid .et-field{margin-bottom:6px}
</style>
