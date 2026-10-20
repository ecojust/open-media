<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Clip } from '../../core/types'
import { clipDuration } from '../../core/timeline'
import type { EditorToolRunner } from './types'
import { toolData } from './types'
import { useEditorTool } from './use-editor-tool'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'

const props = defineProps<{ clip: Clip; native: boolean; run: EditorToolRunner }>()
const emit = defineEmits<{ busy: [value: boolean]; status: [message: string]; locate: [time: number, clipId: string] }>()
const minimum = ref(3), sensitivity = ref(-60)
const task = useEditorTool(() => props.run, value => emit('busy', value))
const data = computed(() => toolData(task.result.value))
const repeats = computed(() => Array.isArray(data.value.segments) ? (data.value.segments as { clipId: string; start: number; end: number; classification?: string; detected?: boolean }[]).filter(item => item.detected && item.classification === 'repeat') : [])
const invalid = computed(() => !Number.isFinite(minimum.value) || minimum.value < .5 || minimum.value > 3600 || minimum.value > clipDuration(props.clip))
const completed = computed(() => Number(data.value.repeatCount || 0) > 0)
function time(value: number): string { return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}` }
async function run(): Promise<void> {
  if (!props.native || invalid.value || task.busy.value || completed.value) return
  const result = await task.execute('open_media_clip_split_idle', { clipId: props.clip.id, minDuration: minimum.value, freezeNoiseDb: sensitivity.value }, '')
  if (result === undefined) return
  const value = toolData(result), count = Number(value.repeatCount || 0)
  task.notice.value = count ? `已分出 ${count} 段静止画面，共 ${Number(value.repeatDuration || 0).toFixed(1)} 秒，标记为 repeat。` : '未发现符合条件的静止画面，时间线保持不变。'
  emit('status', task.notice.value)
}
</script>
<template>
  <section class="et-panel idle-split-panel" data-testid="idle-split-panel">
    <p class="idle-split-source"><Icon name="video" :size="15" /><strong>{{ clip.name }}</strong><span>{{ clipDuration(clip).toFixed(1) }} 秒</span></p>
    <p class="et-note">检测当前视频片段中持续不变的画面，在区间起止处自动分割，并用黄色 repeat 标记。全部画面与声音都会保留，完成后可撤销。</p>
    <p v-if="!native" class="et-note">静止画面检测需要桌面版运行环境。</p>
    <fieldset :disabled="task.busy.value || !native || completed">
      <div class="et-grid">
        <label class="et-field">最短持续时长 / 秒<input v-model.number="minimum" type="number" min=".5" :max="Math.min(3600, clipDuration(clip))" step=".5" aria-label="静止画面最短持续时长" /><small>按时间线上的播放时长判断。</small></label>
        <label class="et-field">静止判断<select v-model.number="sensitivity" aria-label="静止画面判断严格程度"><option :value="-80">严格：画面几乎完全不变</option><option :value="-60">标准：允许轻微压缩噪点</option><option :value="-40">宽松：允许细微画面变化</option></select></label>
      </div>
      <p v-if="invalid" class="et-note">最短持续时长需介于 0.5 秒与片段时长之间，最长 3600 秒。</p>
      <div class="et-actions"><button class="et-primary" data-testid="idle-split-run" :disabled="invalid" @click="run"><Icon name="scissors" :size="14" />检测并分割</button></div>
    </fieldset>
    <EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
    <div v-if="repeats.length" class="et-result idle-split-results" aria-label="已分割的静止画面">
      <button v-for="item in repeats" :key="item.clipId" :disabled="task.busy.value" @click="emit('locate', item.start, item.clipId)"><span class="idle-repeat-badge"><Icon name="repeat" :size="12" />repeat</span><span>{{ time(item.start) }} — {{ time(item.end) }}</span><span>{{ (item.end - item.start).toFixed(1) }} 秒</span><Icon name="arrow" :size="13" /></button>
    </div>
    <p class="et-note">静止不代表无用内容，阅读画面、片头或等待画面也可能被标记；可定位检查后自行决定是否裁掉。</p>
  </section>
</template>
<style src="./editor-tools.css"></style>
<style scoped>
.idle-split-source{display:flex;align-items:center;gap:8px;margin:0 0 10px;min-width:0}.idle-split-source strong{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.idle-split-source>svg,.idle-split-source>span{flex:none}.idle-split-source>span{margin-left:auto;color:var(--ed-muted);font-variant-numeric:tabular-nums;font-size:11px}.idle-split-panel .et-grid{margin-top:16px}.idle-split-results{display:grid;gap:6px}.idle-split-results>button{justify-content:flex-start;font-size:11px;min-width:0;gap:8px}.idle-split-results>button>span:nth-child(3){margin-left:auto;white-space:nowrap;color:var(--ed-muted)}.idle-repeat-badge{display:inline-flex;align-items:center;gap:4px;color:#785600;background:#ffe58c;border:1px solid #cba237;border-radius:4px;padding:1px 4px;flex:none;font:10px ui-monospace,monospace}@media(max-width:480px){.idle-split-panel .et-grid{grid-template-columns:1fr}.idle-split-results>button{flex-wrap:wrap}}
</style>
