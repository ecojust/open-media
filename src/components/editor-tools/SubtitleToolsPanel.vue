<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Project } from '../../core/types'
import type { EditorToolRunner } from './types'
import { toolData } from './types'
import { useEditorTool } from './use-editor-tool'
import { saveToolFile } from './save-tool-file'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'
const props = defineProps<{ project: Project; run: EditorToolRunner }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const task = useEditorTool(() => props.run, busy => emit('busy', busy))
const action = ref<'import' | 'export'>('import'), format = ref('srt'), text = ref(''), trackId = ref(''), maxLineChars = ref(26), splitSentences = ref(true), offset = ref(0), input = ref<HTMLInputElement>()
const tracks = computed(() => props.project.tracks.filter(track => track.kind === 'text'))
const data = computed(() => toolData(task.result.value)), exportedText = computed(() => typeof data.value.text === 'string' ? data.value.text : '')
async function readFile(event: Event): Promise<void> {
  const element = event.target as HTMLInputElement, file = element.files?.[0]; element.value = ''
  if (!file) return
  if (file.size > 5 * 1024 * 1024) { task.error.value = '字幕文件不能超过 5 MB。'; return }
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension && ['srt', 'vtt', 'ass'].includes(extension)) format.value = extension
  try { const content = await file.text(); if (content.length > 2_000_000) throw new Error('字幕内容不能超过 200 万字符。'); text.value = content } catch (cause) { task.error.value = cause instanceof Error ? cause.message : '无法读取字幕文件，请重试。' }
}
async function run(): Promise<void> { await task.execute('open_media_subtitle_import_export', { action: action.value, format: format.value, ...(action.value === 'import' ? { text: text.value, maxLineChars: maxLineChars.value, splitSentences: splitSentences.value, offset: offset.value } : {}), ...(trackId.value ? { trackId: trackId.value } : {}) }, action.value === 'import' ? '字幕已导入时间线' : '字幕文件已生成') }
async function download(): Promise<void> { try { await saveToolFile(new Blob([exportedText.value], { type: 'text/plain;charset=utf-8' }), String(data.value.filename || `字幕.${format.value}`)) } catch (cause) { task.error.value = cause instanceof Error ? cause.message : String(cause) } }
watch([action, format], () => { task.result.value = undefined; task.error.value = ''; task.notice.value = '' })
</script>
<template>
  <section class="et-panel" data-testid="subtitle-tools-panel"><div class="et-tabs" aria-label="字幕文件操作"><button :aria-pressed="action === 'import'" :disabled="task.busy.value" @click="action = 'import'">导入字幕</button><button :aria-pressed="action === 'export'" :disabled="task.busy.value" @click="action = 'export'">导出字幕</button></div><fieldset :disabled="task.busy.value"><div class="et-grid"><label class="et-field">格式<select v-model="format" aria-label="字幕文件格式"><option value="srt">SRT</option><option value="vtt">VTT</option><option value="ass">ASS</option></select></label><label class="et-field">字幕轨道<select v-model="trackId" aria-label="字幕文件轨道"><option value="">{{ action === 'import' ? '新建字幕轨道' : '全部字幕轨道' }}</option><option v-for="track in tracks" :key="track.id" :value="track.id" :disabled="action === 'import' && track.locked">{{ track.name }}{{ track.locked ? '（已锁定）' : '' }}</option></select></label></div><template v-if="action === 'import'"><input ref="input" type="file" accept=".srt,.vtt,.ass,text/plain" hidden @change="readFile" /><button @click="input?.click()"><Icon name="folder" :size="14" />选择字幕文件</button><label class="et-field" style="margin-top:12px">字幕内容<textarea v-model="text" rows="8" aria-label="字幕文件内容" placeholder="也可以直接粘贴字幕文件内容" /></label><div class="et-grid"><label class="et-field">每行最多字数<input v-model.number="maxLineChars" type="number" min="4" max="80" aria-label="字幕每行最多字数" /></label><label class="et-field">整体偏移 / 秒<input v-model.number="offset" type="number" step=".1" aria-label="字幕时间偏移" /></label></div><label class="et-check"><input v-model="splitSentences" type="checkbox" />按句子拆分较长字幕</label></template><button class="et-primary" :disabled="action === 'import' && !text.trim()" @click="run"><Icon :name="action === 'import' ? 'import' : 'export'" :size="14" />{{ action === 'import' ? '导入到时间线' : '生成字幕文件' }}</button></fieldset><EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" /><div v-if="exportedText" class="et-result"><textarea :value="exportedText" readonly rows="6" aria-label="导出字幕预览" /><div class="et-actions"><button @click="download"><Icon name="download" :size="14" />保存字幕文件</button></div></div></section>
</template>
<style src="./editor-tools.css"></style>
