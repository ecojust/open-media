<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { Project } from '../../core/types'
import { projectDuration } from '../../core/timeline'
import { getToolArtifact } from '../../core/tool-artifacts'
import type { EditorToolRunner } from './types'
import { toolData } from './types'
import { useEditorTool } from './use-editor-tool'
import { saveToolFile } from './save-tool-file'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'
const props = defineProps<{ project: Project; time: number; run: EditorToolRunner; selectedClipId?: string }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const task = useEditorTool(() => props.run, busy => emit('busy', busy))
const action = ref<'frame' | 'video' | 'audio'>('frame'), time = ref(props.time), start = ref(props.time), end = ref(Math.min(projectDuration(props.project), props.time + 10))
const width = ref(Math.max(160, Math.min(1280, props.project.width))), fps = ref(Math.min(30, props.project.fps)), solo = ref(false)
const resultUrl = ref(''), mime = ref(''), filename = ref('')
let generation = 0, disposed = false
function clear(): void { generation++; if (resultUrl.value.startsWith('blob:')) URL.revokeObjectURL(resultUrl.value); resultUrl.value = ''; mime.value = ''; filename.value = '' }
async function run(): Promise<void> {
  if (task.busy.value) return
  clear(); const request = generation
  if (action.value !== 'frame' && (end.value <= start.value || end.value - start.value > 60)) { task.error.value = '请选择 0 到 60 秒的有效预览范围。'; return }
  const args: Record<string, unknown> = action.value === 'frame' ? { time: time.value, width: width.value } : { start: start.value, end: end.value }
  if (action.value === 'video') Object.assign(args, { width: width.value, fps: fps.value })
  if (action.value === 'audio') Object.assign(args, { mode: solo.value ? 'solo' : 'mix', ...(solo.value && props.selectedClipId ? { clipIds: [props.selectedClipId] } : {}) })
  const name = action.value === 'frame' ? 'timeline_get_frame' : action.value === 'video' ? 'preview_render' : 'audio_preview'
  const value = await task.execute(`open_media_${name}`, args, '预览已生成')
  if (value === undefined || disposed || request !== generation) return
  const data = toolData(value), artifact = data.artifact as Record<string, unknown> | undefined
  try {
    const artifactId = typeof data.artifactId === 'string' ? data.artifactId : typeof artifact?.artifactId === 'string' ? artifact.artifactId : ''
    if (artifactId) {
      const stored = await getToolArtifact(artifactId)
      if (disposed || request !== generation) return
      resultUrl.value = URL.createObjectURL(stored.blob); mime.value = stored.metadata.mimeType; filename.value = stored.metadata.name
    } else if (typeof data.base64 === 'string') { resultUrl.value = `data:image/png;base64,${data.base64}`; mime.value = 'image/png'; filename.value = '时间线画面.png' }
    else throw new Error('处理结果没有可读取的预览文件。')
  } catch (cause) { if (!disposed && request === generation) { task.error.value = cause instanceof Error ? cause.message : String(cause); task.notice.value = '' } }
}
async function save(): Promise<void> { try { await saveToolFile(await (await fetch(resultUrl.value)).blob(), filename.value) } catch (cause) { task.error.value = cause instanceof Error ? cause.message : String(cause) } }
watch(action, () => { clear(); task.error.value = ''; task.notice.value = '' })
onBeforeUnmount(() => { disposed = true; clear() })
</script>
<template>
  <section class="et-panel" data-testid="preview-tools-panel"><div class="et-tabs" aria-label="预览工具类型"><button :aria-pressed="action === 'frame'" :disabled="task.busy.value" @click="action = 'frame'"><Icon name="image" :size="14" />当前画面</button><button :aria-pressed="action === 'video'" :disabled="task.busy.value" @click="action = 'video'"><Icon name="video" :size="14" />片段预览</button><button :aria-pressed="action === 'audio'" :disabled="task.busy.value" @click="action = 'audio'"><Icon name="audio" :size="14" />音频试听</button></div><fieldset :disabled="task.busy.value"><label v-if="action === 'frame'" class="et-field">时间线位置 / 秒<input v-model.number="time" type="number" min="0" :max="projectDuration(project)" step=".01" aria-label="时间线画面位置" /></label><div v-else class="et-grid"><label class="et-field">开始 / 秒<input v-model.number="start" type="number" min="0" :max="projectDuration(project)" step=".1" aria-label="预览范围开始时间" /></label><label class="et-field">结束 / 秒<input v-model.number="end" type="number" min="0" :max="projectDuration(project)" step=".1" aria-label="预览范围结束时间" /></label></div><div class="et-grid"><label v-if="action !== 'audio'" class="et-field">预览宽度 / 像素<input v-model.number="width" type="number" :min="action === 'frame' ? 16 : 160" :max="action === 'frame' ? 1920 : 1280" step="16" aria-label="工具预览宽度" /></label><label v-if="action === 'video'" class="et-field">预览帧率<input v-model.number="fps" type="number" min="1" max="30" step="1" aria-label="工具预览帧率" /></label></div><label v-if="action === 'audio' && selectedClipId" class="et-check"><input v-model="solo" type="checkbox" />仅试听当前片段</label><p class="et-note">生成结果包含时间线已有的效果，不会更改工程或播放位置。视频和音频预览范围最长 60 秒。</p><button class="et-primary" @click="run"><Icon name="play" :size="14" />{{ action === 'frame' ? '提取合成画面' : action === 'video' ? '生成预览视频' : '生成试听音频' }}</button></fieldset><EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" /><div v-if="resultUrl" class="et-result preview-tool-result"><img v-if="mime.startsWith('image/')" :src="resultUrl" alt="最终合成画面" /><video v-else-if="mime.startsWith('video/')" :src="resultUrl" controls playsinline preload="metadata" aria-label="生成的视频预览" /><audio v-else-if="mime.startsWith('audio/')" :src="resultUrl" controls preload="metadata" aria-label="生成的音频试听" /><div class="et-actions"><button @click="save"><Icon name="download" :size="14" />保存预览文件</button></div></div></section>
</template>
<style src="./editor-tools.css"></style>
<style scoped>
.preview-tool-result>img,.preview-tool-result>video{display:block;width:100%;max-height:280px;object-fit:contain;border-radius:7px;background:var(--ed-bg)}.preview-tool-result>audio{width:100%}
</style>
