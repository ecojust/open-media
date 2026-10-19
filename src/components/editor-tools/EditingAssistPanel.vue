<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Project } from '../../core/types'
import type { EditorToolRunner } from './types'
import Icon from '../Icon.vue'
import RhythmAssist from './RhythmAssist.vue'
import SpeechAlignmentAssist from './SpeechAlignmentAssist.vue'
import AudioBalanceAssist from './AudioBalanceAssist.vue'
import SubtitleStyleAssist from './SubtitleStyleAssist.vue'

const props = defineProps<{ project: Project; selectedClipId?: string; runTool?: EditorToolRunner; native: boolean; disabled?: boolean }>()
const emit = defineEmits<{
  busy: [value: boolean]
  change: [project: Project, label: string]
  seek: [time: number, clipId?: string]
  status: [message: string]
  focus: [clipId: string]
  chapters: []
  titles: []
}>()
const tabs = [
  { id: 'rhythm', label: '节奏检查', icon: 'clock' },
  { id: 'alignment', label: '声画对齐', icon: 'align-center' },
  { id: 'audio', label: '声音平衡', icon: 'audio' },
  { id: 'subtitles', label: '字幕样式', icon: 'text' },
  { id: 'focus', label: '画面聚焦', icon: 'zoom-in' },
] as const
type Tab = typeof tabs[number]['id']
const tab = ref<Tab>('rhythm'), busy = ref(false), tabBar = ref<HTMLElement>()
const visited = ref(new Set<Tab>(['rhythm']))
watch(tab, value => { visited.value = new Set([...visited.value, value]) })
const focusClip = ref('')
const blocked = computed(() => props.disabled || busy.value)
const visuals = computed(() => props.project.tracks.filter(track => track.kind === 'video').flatMap(track => track.clips.filter(clip => !clip.overlay && !clip.transition).map(clip => ({ track, clip }))))
const focusId = computed(() => visuals.value.some(item => item.clip.id === focusClip.value) ? focusClip.value : visuals.value.some(item => item.clip.id === props.selectedClipId) ? props.selectedClipId! : visuals.value.find(item => !item.track.locked && !item.track.muted)?.clip.id || '')
const focusTarget = computed(() => visuals.value.find(item => item.clip.id === focusId.value))
function setBusy(value: boolean): void { busy.value = value; emit('busy', value) }
function tabKeyboard(event: KeyboardEvent): void {
  if (blocked.value || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = tabs.findIndex(item => item.id === tab.value)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tab.value = tabs[index]!.id
  tabBar.value?.querySelector<HTMLButtonElement>(`[data-assist-tab="${tab.value}"]`)?.focus()
}
</script>

<template>
  <div class="editing-assist" data-testid="editing-assist">
    <p class="assist-intro">先检查节奏，再对齐讲解、平衡声音与统一画面。修改保留原素材，可撤销。</p>
    <nav ref="tabBar" class="assist-tabs" role="tablist" aria-label="剪辑优化项目" @keydown="tabKeyboard">
      <button v-for="item in tabs" :id="`assist-tab-${item.id}`" :key="item.id" type="button" role="tab" :data-assist-tab="item.id" :aria-selected="tab === item.id" :aria-controls="`assist-panel-${item.id}`" :tabindex="tab === item.id ? 0 : -1" :disabled="blocked" @click="tab = item.id"><Icon :name="item.icon" :size="14" />{{ item.label }}</button>
    </nav>
    <section id="assist-panel-rhythm" v-show="tab === 'rhythm'" role="tabpanel" aria-labelledby="assist-tab-rhythm">
      <RhythmAssist :project="project" :selected-clip-id="selectedClipId" :run-tool="native ? runTool : undefined" :disabled="disabled" @busy="setBusy" @change="(next, label) => emit('change', next, label)" @seek="(time, clipId) => emit('seek', time, clipId)" @status="emit('status', $event)" />
    </section>
    <section id="assist-panel-alignment" v-show="tab === 'alignment'" role="tabpanel" aria-labelledby="assist-tab-alignment">
      <SpeechAlignmentAssist v-if="visited.has('alignment')" :project="project" :disabled="disabled" @change="(next, label) => emit('change', next, label)" @seek="(time, clipId) => emit('seek', time, clipId)" @status="emit('status', $event)" />
    </section>
    <section id="assist-panel-audio" v-show="tab === 'audio'" role="tabpanel" aria-labelledby="assist-tab-audio">
      <AudioBalanceAssist v-if="visited.has('audio')" :project="project" :run-tool="native ? runTool : undefined" :disabled="disabled" @busy="setBusy" @status="emit('status', $event)" />
    </section>
    <section id="assist-panel-subtitles" v-show="tab === 'subtitles'" role="tabpanel" aria-labelledby="assist-tab-subtitles">
      <SubtitleStyleAssist v-if="visited.has('subtitles')" :project="project" :selected-clip-id="selectedClipId" :disabled="disabled" @change="(next, label) => emit('change', next, label)" @seek="(time, clipId) => emit('seek', time, clipId)" @status="emit('status', $event)" />
    </section>
    <section id="assist-panel-focus" v-show="tab === 'focus'" role="tabpanel" aria-labelledby="assist-tab-focus" class="et-panel">
      <h3>让观众看清重点</h3>
      <p class="et-note">选择视频或图片，在预览中框选按钮、数据或操作区域，再设置放大、停留与恢复时间。保留原画面比例。</p>
      <label class="et-field">聚焦片段<select :value="focusId" aria-label="聚焦片段" :disabled="blocked || !visuals.length" @change="focusClip = ($event.target as HTMLSelectElement).value"><option v-if="!visuals.length" value="">时间线上还没有视频或图片</option><option v-for="item in visuals" :key="item.clip.id" :value="item.clip.id" :disabled="item.track.locked || item.track.muted">{{ item.clip.name }} · {{ item.clip.start.toFixed(1) }} 秒{{ item.track.locked ? ' · 已锁定' : item.track.muted ? ' · 已隐藏' : '' }}</option></select></label>
      <button class="et-primary" data-testid="assist-focus-pick" :disabled="blocked || !runTool || !focusTarget || focusTarget.track.locked || focusTarget.track.muted" @click="emit('focus', focusId)"><Icon name="zoom-in" :size="14" />在预览中框选</button>
      <p class="et-note">框选完成后，在右侧“重点区域放大”中确认动画；已有位置或缩放动画会先提示冲突。</p>
    </section>
    <footer class="assist-footer"><span>组织讲解</span><button type="button" :disabled="blocked || !runTool" @click="emit('chapters')"><Icon name="mark-in" :size="13" />章节标记</button><button type="button" :disabled="blocked || !runTool" @click="emit('titles')"><Icon name="text" :size="13" />标题与标注</button></footer>
  </div>
</template>

<style src="./editor-tools.css"></style>
<style scoped>
.editing-assist{min-width:0;color:var(--ed-text);font-size:12px}.assist-intro{margin:0;padding:14px 16px 10px;color:var(--ed-muted);font-size:11px;line-height:1.6}.assist-tabs{display:flex;gap:4px;padding:0 12px 12px;border-bottom:1px solid var(--ed-border);overflow:auto;scrollbar-width:thin}.assist-tabs button{display:flex;align-items:center;justify-content:center;gap:5px;flex:1;min-height:34px;white-space:nowrap;padding:6px 9px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ed-muted);font:inherit;cursor:pointer}.assist-tabs button[aria-selected=true]{background:color-mix(in srgb,var(--ed-accent) 10%,transparent);border-color:color-mix(in srgb,var(--ed-accent) 30%,var(--ed-border));color:var(--ed-accent)}.assist-tabs button:disabled,.assist-footer button:disabled{opacity:.5;cursor:not-allowed}.assist-tabs button:focus-visible,.assist-footer button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:-2px}.assist-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-top:1px solid var(--ed-border)}.assist-footer>span{color:var(--ed-muted);font-size:11px;margin-right:auto}.assist-footer button{display:inline-flex;align-items:center;gap:5px;background:var(--ed-panel);color:var(--ed-text);border:1px solid var(--ed-border);border-radius:5px;padding:5px 8px;min-height:30px;font:inherit;font-size:11px;cursor:pointer}@media(max-width:480px){.assist-tabs{padding-inline:8px}.assist-tabs button{font-size:11px;padding:5px}.assist-tabs button svg{display:none}}
</style>
