<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Project } from '../../core/types'
import type { EditorToolRunner } from './types'
import { toolData } from './types'
import { useEditorTool } from './use-editor-tool'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'

const props = defineProps<{ project: Project; time: number; run: EditorToolRunner; initialTab?: 'markers' | 'snapshots' | 'validate' }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const task = useEditorTool(() => props.run, busy => emit('busy', busy))
const tab = ref(props.initialTab || 'markers'), name = ref(''), markers = ref<{ id?: string; time: number; label: string; kind: string; color?: string }[]>([])
const snapshots = ref<Record<string, unknown>[]>([]), selectedSnapshot = ref(''), removePending = ref(''), start = ref<number>(), end = ref<number>(), analyzeMedia = ref(false)
const data = computed(() => toolData(task.result.value))
const issues = computed(() => Array.isArray(data.value.issues) ? data.value.issues as { severity: string; code: string; message: string; time?: number }[] : [])
const settingChanges = computed(() => Array.isArray(data.value.settings) ? data.value.settings as { field: string; before: unknown; after: unknown }[] : [])
const settingLabels: Record<string, string> = { name: '项目名称', width: '画面宽度', height: '画面高度', fps: '帧率', background: '背景颜色' }
const diffRows = computed(() => ['assets', 'tracks', 'clips', 'markers'].flatMap(key => {
  const row = data.value[key] as { added?: unknown[]; removed?: unknown[]; changed?: unknown[] } | undefined
  return row && typeof row === 'object' && !Array.isArray(row) ? [{ name: ({ assets: '素材', tracks: '轨道', clips: '片段', markers: '标记' } as Record<string, string>)[key], added: row.added?.length || 0, removed: row.removed?.length || 0, changed: row.changed?.length || 0 }] : []
}))
function loadMarkers(): void { markers.value = (((props.project as unknown as Record<string, unknown>).markers || []) as typeof markers.value).map(marker => ({ ...marker })) }
loadMarkers()
function addMarker(): void { markers.value.push({ time: Number(props.time.toFixed(3)), label: '', kind: 'chapter', color: '#4f83ff' }) }
async function listSnapshots(): Promise<void> {
  const value = await task.execute('open_media_project_snapshot', { action: 'list' }, '')
  const response = toolData(value)
  const list = Array.isArray(value) ? value : response.snapshots
  if (Array.isArray(list)) snapshots.value = list as Record<string, unknown>[]
}
async function snapshot(action: string, id?: string): Promise<void> {
  const value = await task.execute('open_media_project_snapshot', { action, ...(id ? { id } : {}), ...(action === 'create' ? { name: name.value.trim() } : {}) }, ({ create: '项目快照已保存', compare: '快照对比完成', restore: '已恢复快照，可撤销', delete: '快照已删除' } as Record<string, string>)[action])
  if (value !== undefined && ['create', 'delete', 'restore'].includes(action)) { name.value = ''; removePending.value = ''; await listSnapshots() }
}
function formatDate(value: unknown): string { const date = new Date(String(value)); return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString() }
function bytes(value: unknown): string { const size = Number(value) || 0; return size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB` }
async function selectTab(value: 'markers' | 'snapshots' | 'validate'): Promise<void> { if (task.busy.value) return; tab.value = value; task.result.value = undefined; task.error.value = ''; task.notice.value = ''; if (value === 'snapshots') await listSnapshots() }
function validateOutput(): Promise<unknown> { return task.execute('open_media_export_validate', { analyzeMedia: analyzeMedia.value, ...(Number.isFinite(start.value) ? { start: start.value } : {}), ...(Number.isFinite(end.value) ? { end: end.value } : {}) }, '输出检查完成') }
onMounted(() => { if (tab.value === 'snapshots') void listSnapshots() })
</script>
<template>
  <section class="et-panel" data-testid="project-tools-panel"><div class="et-tabs" aria-label="项目工具"><button :aria-pressed="tab === 'markers'" :disabled="task.busy.value" @click="selectTab('markers')"><Icon name="mark-in" :size="14" />项目标记</button><button :aria-pressed="tab === 'snapshots'" :disabled="task.busy.value" @click="selectTab('snapshots')"><Icon name="copy" :size="14" />项目快照</button><button :aria-pressed="tab === 'validate'" :disabled="task.busy.value" @click="selectTab('validate')"><Icon name="check" :size="14" />输出检查</button></div><fieldset :disabled="task.busy.value">
    <template v-if="tab === 'markers'"><p class="et-note">保存章节、重点和待检查位置。标记不会改变视频画面。</p><div class="project-marker-list"><div v-for="(marker, index) in markers" :key="marker.id || index" class="project-marker"><div class="et-grid"><label class="et-field">时间 / 秒<input v-model.number="marker.time" type="number" min="0" max="86400" step=".1" :aria-label="`标记 ${index + 1} 时间`" /></label><label class="et-field">类型<select v-model="marker.kind" :aria-label="`标记 ${index + 1} 类型`"><option value="chapter">章节</option><option value="highlight">重点</option><option value="review">待检查</option></select></label></div><div class="project-marker-name"><input v-model="marker.label" maxlength="240" :aria-label="`标记 ${index + 1} 名称`" placeholder="标记名称" /><button :aria-label="`删除标记 ${index + 1}`" @click="markers.splice(index, 1)"><Icon name="trash" :size="14" /></button></div></div></div><div class="et-actions"><button @click="addMarker"><Icon name="plus" :size="14" />标记当前帧</button><button class="et-primary" :disabled="markers.some(marker => !marker.label.trim())" @click="task.execute('open_media_timeline_markers_set', { markers }, '项目标记已保存')">保存标记</button></div></template>
    <template v-else-if="tab === 'snapshots'"><p class="et-note">快照包含项目与素材文件，可在之后恢复；恢复操作可以撤销。</p><label class="et-field">快照名称<input v-model="name" maxlength="120" aria-label="项目快照名称" placeholder="例如：完成初剪" /></label><div class="et-actions"><button class="et-primary" :disabled="!name.trim()" @click="snapshot('create')"><Icon name="save" :size="14" />保存快照</button><button @click="listSnapshots"><Icon name="refresh" :size="14" />刷新列表</button></div><div class="project-snapshots"><article v-for="item in snapshots" :key="String(item.id)"><label class="et-check"><input v-model="selectedSnapshot" type="radio" name="project-snapshot" :value="String(item.id)" /><strong>{{ item.name }}</strong></label><p class="et-note">{{ formatDate(item.createdAt) }} · {{ bytes(item.bytes) }} · {{ item.clipCount }} 个片段</p><div v-if="selectedSnapshot === item.id" class="et-actions"><button @click="snapshot('compare', String(item.id))">对比当前工程</button><button @click="snapshot('restore', String(item.id))">恢复快照</button><button v-if="removePending !== item.id" @click="removePending = String(item.id)">删除</button><button v-else @click="snapshot('delete', String(item.id))">确认删除快照</button></div></article><p v-if="!snapshots.length" class="et-note">尚无快照。</p></div></template>
    <template v-else><p class="et-note">检查工程结构、字幕、素材与输出风险；启用媒体分析后，可进一步检查最多 60 秒范围内的黑帧、声音削波与解码情况。</p><label class="et-check"><input v-model="analyzeMedia" type="checkbox" />渲染并分析媒体输出</label><div v-if="analyzeMedia" class="et-grid"><label class="et-field">开始 / 秒<input v-model.number="start" type="number" min="0" step=".1" placeholder="项目开头" aria-label="输出检查开始时间" /></label><label class="et-field">结束 / 秒<input v-model.number="end" type="number" min="0" step=".1" placeholder="项目结尾" aria-label="输出检查结束时间" /></label></div><button class="et-primary" @click="validateOutput"><Icon name="check" :size="14" />开始检查</button></template>
    </fieldset><EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
    <div v-if="issues.length" class="et-result"><article v-for="(issue, index) in issues" :key="index" class="project-issue"><span class="et-chip">{{ issue.severity === 'error' ? '错误' : issue.severity === 'warning' ? '提醒' : '信息' }}</span><span v-if="issue.time !== undefined">{{ issue.time.toFixed(2) }} 秒</span><p>{{ issue.message }}</p></article></div><p v-else-if="data.valid === true" class="et-note">本次检查未发现问题。</p><div v-if="diffRows.length" class="et-result"><table><thead><tr><th>项目</th><th>新增</th><th>删除</th><th>修改</th></tr></thead><tbody><tr v-for="row in diffRows" :key="row.name"><td>{{ row.name }}</td><td>{{ row.added }}</td><td>{{ row.removed }}</td><td>{{ row.changed }}</td></tr></tbody></table><dl v-if="settingChanges.length"><template v-for="change in settingChanges" :key="change.field"><dt>{{ settingLabels[change.field] || change.field }}</dt><dd>{{ change.before }} → {{ change.after }}</dd></template></dl><p v-if="data.identical === true" class="et-note">当前工程与该快照完全一致。</p></div>
  </section>
</template>
<style src="./editor-tools.css"></style>
<style scoped>
.project-marker-list{max-height:290px;overflow:auto}.project-marker{padding:10px 0;border-bottom:1px solid var(--ed-border)}.project-marker-name{display:flex;gap:7px}.project-marker-name input{min-width:0;flex:1;height:32px}.project-snapshots{max-height:300px;overflow:auto;margin-top:12px}.project-snapshots article{border-top:1px solid var(--ed-border);padding:8px 0}.project-issue{padding:5px 0}.project-issue p{margin:5px 0}.project-issue>span{margin-right:8px}
</style>
