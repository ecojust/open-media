<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Project } from '../../core/types'
import type { EditorToolRunner } from './types'
import { toolData } from './types'
import { useEditorTool } from './use-editor-tool'
import EditorToolStatus from './EditorToolStatus.vue'

const props = defineProps<{ project: Project; runTool?: EditorToolRunner; disabled?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; status: [value: string] }>()
const task = useEditorTool(() => props.runTool ?? (async () => { throw new Error('当前环境尚未就绪。') }), value => emit('busy', value))
const speechTrackIds = ref<string[]>([]), musicTrackIds = ref<string[]>([])
const normalize = ref(true), ducking = ref(true), targetLufs = ref(-16), truePeak = ref(-1), reductionDb = ref(12), attack = ref(.15), release = ref(.6)
const tracks = computed(() => props.project.tracks.filter(track => track.kind === 'audio' && track.clips.length))
const blocked = computed(() => props.disabled || !props.runTool || task.busy.value)
const data = computed(() => toolData(task.result.value))
const measurements = computed(() => Array.isArray(data.value.measurements) ? data.value.measurements as { clipId: string; name: string; beforeLufs: number; estimatedLufs: number; limited: boolean }[] : [])
const skipped = computed(() => Array.isArray(data.value.skipped) ? data.value.skipped as { clipId: string; name: string; reason: string }[] : [])
const isMusic = (track: typeof tracks.value[number]) => track.clips.some(clip => props.project.assets.find(asset => asset.id === clip.assetId)?.libraryRole === 'background-music') || /音乐|music|bgm/i.test(track.name)
function defaults() {
  const available = tracks.value.filter(track => !track.locked && !track.muted)
  speechTrackIds.value = available.filter(track => !isMusic(track) && (track.clips.some(clip => clip.speech) || /配音|人声|旁白|录音|voice|narration/i.test(track.name))).map(track => track.id)
  musicTrackIds.value = available.filter(isMusic).map(track => track.id)
  ducking.value = musicTrackIds.value.length > 0
}
watch(() => props.project.id, defaults, { immediate: true })
watch(tracks, () => {
  const ids = new Set(tracks.value.map(track => track.id))
  speechTrackIds.value = speechTrackIds.value.filter(id => ids.has(id))
  musicTrackIds.value = musicTrackIds.value.filter(id => ids.has(id))
})
async function apply() {
  const result = await task.execute('open_media_audio_balance', { speechTrackIds: speechTrackIds.value, musicTrackIds: musicTrackIds.value, normalize: normalize.value, ducking: ducking.value, targetLufs: targetLufs.value, truePeak: truePeak.value, reductionDb: reductionDb.value, attack: attack.value, release: release.value }, '声音平衡已应用，可整体撤销')
  if (result !== undefined) emit('status', '声音平衡已应用，可整体撤销')
}
</script>
<template>
  <section class="et-panel audio-balance-assist" data-testid="audio-balance-assist">
    <h3>旁白与音乐平衡</h3>
    <p class="et-note">统一旁白音量，讲话时降低背景音乐，句间短暂停顿保持平稳。原始素材不变，调整可整体撤销。</p>
    <p v-if="!runTool" class="et-note">声音平衡需要桌面版运行环境。</p>
    <p v-if="!tracks.length" class="et-note">先添加旁白或背景音乐到音频轨道。</p>
    <fieldset :disabled="blocked">
      <div class="et-grid ab-tracks">
        <div><h4>人声轨道</h4><label v-for="track in tracks" :key="track.id" class="et-check"><input v-model="speechTrackIds" type="checkbox" :value="track.id" :disabled="track.muted || normalize && track.locked || musicTrackIds.includes(track.id)" />{{ track.name }}<span class="et-chip">{{ track.clips.length }}</span><small v-if="track.locked || track.muted">{{ track.muted ? '已静音' : '已锁定' }}</small></label></div>
        <div><h4>音乐轨道</h4><label v-for="track in tracks" :key="track.id" class="et-check"><input v-model="musicTrackIds" type="checkbox" :value="track.id" :disabled="track.muted || track.locked || speechTrackIds.includes(track.id)" />{{ track.name }}<span class="et-chip">{{ track.clips.length }}</span><small v-if="track.locked || track.muted">{{ track.muted ? '已静音' : '已锁定' }}</small></label></div>
      </div>
      <label class="et-check"><input v-model="normalize" type="checkbox" />统一旁白响度</label>
      <div v-if="normalize" class="et-grid"><label class="et-field">目标响度 / LUFS<input v-model.number="targetLufs" type="number" min="-36" max="-5" step="1" aria-label="旁白目标响度" /></label><label class="et-field">真峰值上限 / dBTP<input v-model.number="truePeak" type="number" min="-9" max="0" step=".5" aria-label="旁白真峰值上限" /></label></div>
      <label class="et-check"><input v-model="ducking" type="checkbox" />讲话时自动降低音乐</label>
      <div v-if="ducking" class="et-grid ab-envelope"><label class="et-field">压低 / dB<input v-model.number="reductionDb" type="number" min="0" max="36" step="1" aria-label="音乐自动压低幅度" /></label><label class="et-field">进入 / 秒<input v-model.number="attack" type="number" min=".01" max="5" step=".05" aria-label="音乐压低进入时间" /></label><label class="et-field">恢复 / 秒<input v-model.number="release" type="number" min=".01" max="5" step=".05" aria-label="音乐恢复时间" /></label></div>
      <p class="et-note">真峰值上限与片段 200% 音量上限可能限制目标响度，结果会逐项标明。自动压低依据人声片段区间，手动音量关键帧会受到保护。</p>
      <button type="button" class="et-primary" :disabled="!speechTrackIds.length || !normalize && !ducking || ducking && !musicTrackIds.length" @click="apply">应用声音平衡</button>
    </fieldset>
    <EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
    <div v-if="task.result.value" class="et-result"><p>已调整 {{ data.normalizedCount }} 段旁白 · {{ data.duckedCount }} 段音乐自动压低<span v-if="data.restoredCount"> · {{ data.restoredCount }} 段音乐恢复原音量</span></p><table v-if="measurements.length"><thead><tr><th>旁白</th><th>实测 / LUFS</th><th>调整后预计</th></tr></thead><tbody><tr v-for="item in measurements" :key="item.clipId"><td>{{ item.name }}</td><td>{{ item.beforeLufs.toFixed(1) }}</td><td>{{ item.estimatedLufs.toFixed(1) }}<span v-if="item.limited" class="et-chip">受峰值或音量上限限制</span></td></tr></tbody></table><p v-for="item in skipped" :key="item.clipId" class="et-note">{{ item.name }}：{{ item.reason }}</p></div>
  </section>
</template>
<style src="./editor-tools.css"></style>
<style scoped>
.ab-tracks{margin:16px 0}.ab-tracks>div{border:1px solid var(--ed-border,var(--ui-line));border-radius:8px;padding:10px;min-width:0;max-height:220px;overflow:auto}.ab-tracks h4{font-size:12px;margin:0 0 8px}.ab-tracks .et-check{overflow-wrap:anywhere}.ab-tracks small{color:var(--ed-muted,var(--ui-muted));font-size:10px}.ab-envelope{grid-template-columns:repeat(3,minmax(0,1fr))}.et-result td .et-chip{margin-top:3px}
</style>
