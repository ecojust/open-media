<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MediaAsset, Project } from '../core/types'
import { MOTION_STYLES, getMotionStyle, type MotionStyleId } from '../core/motion-style-catalog'
import { drawMotionStylePoster } from '../core/motion-style-art'
import { planMotionClipGeneration, type MotionClipGenerateOptions } from '../core/motion-style-service'
import type { MotionSceneInput } from '../core/motion-style-composer'
import Icon from './Icon.vue'
import EditorToolStatus from './editor-tools/EditorToolStatus.vue'
import { useEditorTool } from './editor-tools/use-editor-tool'
import { toolData, type EditorToolRunner } from './editor-tools/types'

const props = defineProps<{ project: Project; assets: MediaAsset[]; playhead: number; runTool: EditorToolRunner }>()
const emit = defineEmits<{ busy: [value: boolean]; status: [message: string]; complete: [result: { assetId: string; clipId?: string; start?: number }] }>()
interface SceneDraft extends MotionSceneInput { key: number }
const styleId = ref<MotionStyleId>('flat-pop'), selectedStyle = computed(() => getMotionStyle(styleId.value))
const title = ref(''), tempo = ref<'calm' | 'balanced' | 'energetic'>('balanced'), insertAtPlayhead = ref(false)
const accent = ref(selectedStyle.value.palette.accent), background = ref(selectedStyle.value.palette.background), textColor = ref(selectedStyle.value.palette.textColor)
const musicAssetId = ref(''), musicVolume = ref(25), sourceAudio = ref(false), logoAssetId = ref('')
const scenes = ref<SceneDraft[]>([])
let nextKey = 0
watch(() => props.assets.map(asset => asset.id).join('\0'), () => {
  scenes.value = props.assets.map(asset => ({ key: ++nextKey, assetId: asset.id, heading: '', caption: '', duration: 4, ...(asset.kind === 'video' ? { trimIn: 0 } : {}) }))
}, { immediate: true })
const task = useEditorTool(() => props.runTool, value => emit('busy', value))
const assetMap = computed(() => new Map(props.project.assets.map(asset => [asset.id, asset])))
const audioAssets = computed(() => props.project.assets.filter(asset => asset.kind === 'audio'))
const imageAssets = computed(() => props.project.assets.filter(asset => asset.kind === 'image' && !asset.libraryRole))
const options = computed<MotionClipGenerateOptions>(() => ({
  styleId: styleId.value, scenes: scenes.value.map(({ key: _key, ...scene }) => ({ ...scene })),
  ...(title.value.trim() ? { title: title.value.trim() } : {}), tempo: tempo.value,
  accent: accent.value, background: background.value, textColor: textColor.value,
  ...(musicAssetId.value ? { musicAssetId: musicAssetId.value } : {}), musicVolume: musicVolume.value / 100,
  sourceAudio: sourceAudio.value, ...(logoAssetId.value ? { logoAssetId: logoAssetId.value } : {}),
  destination: insertAtPlayhead.value ? 'timeline' : 'assets', ...(insertAtPlayhead.value ? { insert: { start: props.playhead } } : {}),
}))
const planned = computed(() => {
  try { return { plan: planMotionClipGeneration(props.project, options.value), error: '' } }
  catch (cause) { return { plan: undefined, error: cause instanceof Error ? cause.message : String(cause) } }
})
const posters = new WeakMap<HTMLCanvasElement, string>()
function poster(element: unknown, id: string): void {
  if (!(element instanceof HTMLCanvasElement) || posters.get(element) === id) return
  drawMotionStylePoster(element, id); posters.set(element, id)
}
function resetColors(): void {
  accent.value = selectedStyle.value.palette.accent
  background.value = selectedStyle.value.palette.background
  textColor.value = selectedStyle.value.palette.textColor
}
watch(styleId, resetColors)
function assetName(scene: SceneDraft): string { return assetMap.value.get(scene.assetId)?.name || '素材已移除' }
function videoAsset(scene: SceneDraft): MediaAsset | undefined {
  const asset = assetMap.value.get(scene.assetId)
  return asset?.kind === 'video' ? asset : undefined
}
function seconds(value: number): string { return `${Number(value.toFixed(2))} 秒` }
function moveScene(index: number, direction: -1 | 1): void {
  if (task.busy.value || index + direction < 0 || index + direction >= scenes.value.length) return
  const [scene] = scenes.value.splice(index, 1)
  scenes.value.splice(index + direction, 0, scene)
}
async function generate(): Promise<void> {
  if (!planned.value.plan || task.busy.value) return
  const result = await task.execute('open_media_motion_clip_generate', { ...options.value }, '')
  if (result === undefined) return
  const data = toolData(result)
  if (typeof data.assetId !== 'string') { task.error.value = '生成结果缺少视频素材，请检查任务结果后重试。'; return }
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter((item): item is string => typeof item === 'string') : []
  emit('status', `已生成${selectedStyle.value.name}效果视频，已加入项目素材${typeof data.clipId === 'string' ? '和时间线' : ''}${warnings.length ? `；${warnings.join('；')}` : ''}`)
  emit('complete', { assetId: data.assetId, ...(typeof data.clipId === 'string' ? { clipId: data.clipId } : {}), ...(typeof data.start === 'number' ? { start: data.start } : {}) })
}
</script>

<template>
  <section class="et-panel effect-clip-panel" aria-label="效果片段设置" data-testid="effect-clip-panel" @keydown.stop>
    <div class="effect-fields">
      <p class="effect-intro">使用已选的 {{ assets.length }} 个项目素材，生成可独立剪辑的视频片段。</p>
      <fieldset :disabled="task.busy.value">
        <div class="effect-heading"><h3>选择风格</h3><span>15 种 · 滚动查看</span></div>
        <div class="effect-style-grid" aria-label="效果风格">
          <button v-for="style in MOTION_STYLES" :key="style.id" type="button" class="effect-style-card" :data-style-id="style.id" :aria-label="style.name" :aria-pressed="styleId === style.id" :title="style.description" @click="styleId = style.id"><canvas :ref="element => poster(element, style.id)" width="320" height="180" aria-hidden="true" /><span>{{ style.name }}<Icon v-if="styleId === style.id" name="check" :size="12" /></span></button>
        </div>
        <p class="effect-style-description">{{ selectedStyle.description }}</p>
        <p v-if="selectedStyle.note" class="et-note">{{ selectedStyle.note }}</p>
        <p class="et-note">缩略图为风格示意，生成后得到可播放的视频素材。</p>
        <label class="et-field">片段名称<input v-model="title" aria-label="效果片段名称" maxlength="120" :placeholder="`${selectedStyle.name}效果片段`" /></label>
        <details class="effect-section" open>
          <summary>素材与文字 <span>{{ scenes.length }} 个场景</span></summary>
          <ol class="effect-scenes" aria-label="效果素材列表">
            <li v-for="(scene, index) in scenes" :key="scene.key" class="effect-scene" :data-scene-asset-id="scene.assetId">
              <div class="effect-scene-heading"><span>{{ String(index + 1).padStart(2, '0') }}</span><Icon :name="videoAsset(scene) ? 'video' : 'image'" :size="13" /><strong :title="assetName(scene)">{{ assetName(scene) }}</strong><button type="button" :aria-label="`上移场景 ${index + 1}`" :disabled="index === 0" @click="moveScene(index, -1)"><Icon name="chevron-up" :size="13" /></button><button type="button" :aria-label="`下移场景 ${index + 1}`" :disabled="index === scenes.length - 1" @click="moveScene(index, 1)"><Icon name="chevron-down" :size="13" /></button></div>
              <label class="et-field">标题<input v-model="scene.heading" :aria-label="`场景 ${index + 1} 标题`" maxlength="120" placeholder="可选，留空只展示素材" /></label>
              <label class="et-field">说明<input v-model="scene.caption" :aria-label="`场景 ${index + 1} 说明`" maxlength="240" placeholder="可选，补充一句说明" /></label>
              <div class="et-grid"><label class="et-field">时长 / 秒<input v-model.number="scene.duration" :aria-label="`场景 ${index + 1} 时长`" type="number" min="2" max="12" step="0.1" /></label><label v-if="videoAsset(scene)" class="et-field">源起点 / 秒<input v-model.number="scene.trimIn" :aria-label="`场景 ${index + 1} 视频起点`" type="number" min="0" :max="videoAsset(scene)?.duration" step="0.1" /></label></div>
            </li>
          </ol>
          <p class="et-note">每段 2–12 秒。视频剩余时间不足时自动缩短，保持正常速度。</p>
        </details>
        <details class="effect-section"><summary>配色与节奏</summary>
          <div class="effect-palette"><label>背景<input v-model="background" type="color" aria-label="效果背景颜色" /></label><label>强调<input v-model="accent" type="color" aria-label="效果强调颜色" /></label><label>文字<input v-model="textColor" type="color" aria-label="效果文字颜色" /></label><button type="button" title="恢复风格配色" aria-label="恢复风格配色" @click="resetColors"><Icon name="refresh" :size="13" /></button></div>
          <label class="et-field">动画节奏<select v-model="tempo" aria-label="动画节奏"><option value="calm">舒缓</option><option value="balanced">均衡</option><option value="energetic">轻快</option></select></label>
          <label class="et-field">品牌图片<select v-model="logoAssetId" aria-label="效果品牌图片"><option value="">无</option><option v-for="asset in imageAssets" :key="asset.id" :value="asset.id">{{ asset.name }}</option></select></label>
        </details>
        <details class="effect-section"><summary>声音</summary>
          <label class="et-field">背景音乐<select v-model="musicAssetId" aria-label="效果背景音乐"><option value="">无</option><option v-for="asset in audioAssets" :key="asset.id" :value="asset.id">{{ asset.name }}</option></select></label>
          <label class="et-field">配乐音量 / %<input v-model.number="musicVolume" aria-label="效果配乐音量" :disabled="!musicAssetId" type="number" min="0" max="100" step="1" /></label>
          <label class="et-check"><input v-model="sourceAudio" type="checkbox" aria-label="保留视频原声" />保留视频原声</label>
        </details>
      </fieldset>
    </div>
    <footer class="effect-footer">
      <label class="et-check"><input v-model="insertAtPlayhead" type="checkbox" :disabled="task.busy.value" aria-label="同时插入当前播放头" />同时插入当前播放头 <span v-if="insertAtPlayhead">{{ seconds(playhead) }}</span></label>
      <div class="effect-generate"><span>{{ planned.plan ? `${scenes.length} 个场景 · ${seconds(planned.plan.duration)}` : '请检查素材与设置' }}</span><button type="button" class="et-primary" data-testid="effect-clip-generate" :disabled="task.busy.value || !planned.plan" @click="generate"><Icon name="sparkles" :size="14" />{{ task.busy.value ? '生成中…' : '生成视频' }}</button></div>
      <p class="effect-output-note">完成后加入项目素材，可双击或拖入时间线。</p>
      <p v-if="planned.error" class="et-error effect-validation" role="alert">{{ planned.error }}</p>
      <ul v-if="planned.plan?.warnings.length" class="effect-warnings"><li v-for="warning in planned.plan.warnings" :key="warning">{{ warning }}</li></ul>
      <EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
    </footer>
  </section>
</template>

<style src="./editor-tools/editor-tools.css"></style>
<style scoped>
.effect-clip-panel{display:flex;flex-direction:column;flex:1;min-height:0;padding:0;overflow:hidden}.effect-fields{flex:1;min-height:0;overflow:auto;padding:12px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent}.effect-intro{margin:0 0 12px;font-size:11px;color:var(--ed-muted)}.effect-heading{display:flex;justify-content:space-between;gap:6px;align-items:center;margin-bottom:8px}.effect-heading h3{margin:0;font-size:11px}.effect-heading>span{font-size:10px;color:var(--ed-muted)}.effect-style-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;max-height:235px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent;padding:2px}.effect-style-grid .effect-style-card{display:block;min-width:0;padding:0;overflow:hidden;text-align:left;border-radius:6px}.effect-style-card canvas{display:block;width:100%;aspect-ratio:16/9}.effect-style-card>span{display:flex;justify-content:space-between;align-items:center;gap:3px;padding:5px 6px;font-size:10px}.effect-style-card[aria-pressed=true]{border-color:var(--ed-accent);box-shadow:0 0 0 1px var(--ed-accent);color:var(--ed-accent)}.effect-style-description{font-size:11px;margin:9px 0;color:var(--ed-text)}.effect-section{border-top:1px solid var(--ed-border);padding-top:9px;margin-top:10px}.effect-section>summary{font-size:11px;font-weight:600;line-height:24px;cursor:pointer;margin-bottom:8px}.effect-section>summary>span{float:right;color:var(--ed-muted);font-size:10px;font-weight:400}.effect-scenes{padding:0;margin:0;list-style:none}.effect-scene{border:1px solid var(--ed-border);border-radius:6px;padding:8px;margin-bottom:8px}.effect-scene-heading{display:flex;align-items:center;gap:4px;margin-bottom:8px;min-width:0}.effect-scene-heading>span{color:var(--ed-accent);font:10px ui-monospace,monospace}.effect-scene-heading>svg{flex:none;color:var(--ed-muted)}.effect-scene-heading>strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:500}.effect-scene-heading>button{min-height:22px;width:20px;flex:none;padding:1px;border-color:transparent;background:transparent}.effect-scene .et-field{font-size:10px;gap:4px;margin-bottom:7px}.effect-scene .et-grid .et-field{margin-bottom:0}.effect-palette{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0 12px}.effect-palette>label{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--ed-muted)}.effect-palette input[type=color]{width:28px;height:25px;padding:2px;border:1px solid var(--ed-border);border-radius:5px;background:var(--ed-panel)}.effect-palette>button{margin-left:auto;min-height:25px;padding:3px}.effect-footer{flex:none;padding:9px 12px 12px;border-top:1px solid var(--ed-border);background:var(--ed-panel)}.effect-footer .et-check{margin:0 0 9px;font-size:10px;flex-wrap:wrap}.effect-footer .et-check>span{color:var(--ed-accent);font-size:10px}.effect-generate{display:flex;align-items:center;justify-content:space-between;gap:5px}.effect-generate>span{font-size:10px;color:var(--ed-muted);min-width:0}.effect-generate>button{flex:none;font-size:11px}.effect-output-note{margin:6px 0 0;font-size:9px;color:var(--ed-muted)}.effect-validation{margin:8px 0 0;font-size:10px}.effect-warnings{max-height:70px;overflow:auto;scrollbar-width:thin;padding-left:16px;margin:8px 0 0;font-size:10px;color:var(--ed-warning,#a47324);line-height:1.6}.effect-clip-panel button:focus-visible,.effect-clip-panel input:focus-visible,.effect-clip-panel select:focus-visible,.effect-clip-panel summary:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}@media(prefers-reduced-motion:reduce){.effect-clip-panel button,.effect-clip-panel select{transition:none}}
</style>
