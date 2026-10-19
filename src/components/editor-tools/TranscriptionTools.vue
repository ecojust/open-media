<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AsrStatus } from '../../native-transcription'
import { aiState } from '../../core/ai-service.ts'
import type { EditorToolRunner } from './types'
import { toolData } from './types'
import { useEditorTool } from './use-editor-tool'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'

const props = defineProps<{ clipId: string; run: EditorToolRunner; native: boolean; disabled?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; 'open-models': [provider: 'transcription'] }>()
const task = useEditorTool(() => props.run, busy => emit('busy', busy))
const status = ref<AsrStatus>(), modelId = ref(''), language = ref('zh'), granularity = ref('sentence')
const blocked = computed(() => props.disabled || !props.native || task.busy.value)
const selected = computed(() => status.value?.models.find(model => model.id === modelId.value))
const result = computed(() => toolData(task.result.value))
const rows = computed(() => Array.isArray(result.value.segments) ? result.value.segments as { text: string; start: number; end: number }[] : [])
watch(() => aiState.value.models.find(model => model.id === `transcription:${modelId.value}`)?.state, state => {
  if (state && status.value && !blocked.value) void load()
})
async function load(): Promise<void> {
  if (!props.native || task.busy.value) return
  const value = await task.execute('open_media_audio_transcribe', { action: 'status' }, '')
  if (value === undefined) return
  const data = toolData(value)
  if (!Array.isArray(data.models)) { task.error.value = '无法读取语音识别模型状态。'; return }
  status.value = data as unknown as AsrStatus
  if (!data.models.some(model => model.id === modelId.value)) modelId.value = status.value.models[0]?.id || ''
}
async function transcribe(): Promise<void> {
  await task.execute('open_media_audio_transcribe', { action: 'transcribe', modelId: modelId.value, clipId: props.clipId, language: language.value, granularity: granularity.value, createSubtitles: true }, '识别字幕已添加到时间线')
}
</script>
<template>
  <details class="et-panel et-inline et-section" data-testid="transcription-tools" @toggle="($event.target as HTMLDetailsElement).open && !blocked && load()">
    <summary>识别语音为字幕</summary>
    <p v-if="!native" class="et-note">离线语音识别需要桌面版运行环境。</p>
    <fieldset :disabled="blocked">
      <button v-if="!status" @click="load">读取识别模型</button>
      <template v-else>
        <label class="et-field">离线模型<select v-model="modelId" aria-label="语音识别模型"><option v-for="model in status.models" :key="model.id" :value="model.id">{{ model.name }}</option></select></label>
        <p v-if="status.error" class="et-error">{{ status.error }}</p>
        <template v-if="selected">
          <p class="et-note">依靠 {{ selected.name }} 模型识别语音。</p>
          <p v-if="selected.error" class="et-error">{{ selected.error }}</p>
          <div class="et-actions">
            <span v-if="selected.status === 'ready'" class="et-chip">模型已就绪</span>
            <span v-else class="et-note">{{ selected.status === 'downloading' || selected.status === 'verifying' ? '模型准备中' : '模型未就绪' }}</span>
            <button :aria-label="`前往 Info 管理 ${selected.name}`" @click="emit('open-models', 'transcription')"><Icon name="info" :size="13" />{{ selected.status === 'not-downloaded' ? '请前往下载' : '前往模型管理' }}</button>
            <button aria-label="刷新识别模型状态" @click="load"><Icon name="refresh" :size="13" /></button>
          </div>
        </template>
        <label class="et-field transcription-language">音频语言<select v-model="language" aria-label="语音识别语言"><option value="zh">中文</option><option value="">自动识别</option><option value="en">英文</option></select></label>
        <label class="et-field">字幕分段<select v-model="granularity" aria-label="识别字幕分段"><option value="sentence">逐句</option><option value="word">细分时间戳</option></select></label>
        <p class="et-note">识别当前片段实际使用的音频，并在相同时间位置添加字幕。细分模式下，中文按模型识别的字词单元分段。</p>
        <button class="et-primary" :disabled="!status.runtimeReady || selected?.status !== 'ready'" @click="transcribe"><Icon name="text" :size="13" />识别并添加字幕</button>
      </template>
    </fieldset>
    <EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
    <div v-if="rows.length" class="et-result"><p v-for="(row, index) in rows" :key="index"><span class="et-chip">{{ row.start.toFixed(2) }} – {{ row.end.toFixed(2) }} 秒</span> {{ row.text }}</p></div>
  </details>
</template>
<style src="./editor-tools.css"></style>
<style scoped>.transcription-language{margin-top:12px}</style>
