<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MediaAsset, Project } from '../core/types'
import { projectSourceAssets } from '../core/editor-assets'
import { MOTION_STYLES, getMotionStyle, type MotionStyleId } from '../core/motion-style-catalog'
import { drawMotionStyleBackground, drawMotionStyleDecoration, drawMotionStylePoster } from '../core/motion-style-art'
import { planMotionComposition, type MotionComposeOptions, type MotionSceneInput } from '../core/motion-style-composer'
import Icon from './Icon.vue'
import AssetVideoThumbnail from './AssetVideoThumbnail.vue'
import EditorToolStatus from './editor-tools/EditorToolStatus.vue'
import { useEditorTool } from './editor-tools/use-editor-tool'
import { toolData, type EditorToolRunner } from './editor-tools/types'

const props = defineProps<{ project: Project; run: EditorToolRunner }>()
const emit = defineEmits<{ busy: [value: boolean]; status: [message: string]; complete: [time: number, clipId?: string]; import: [] }>()
interface SceneDraft extends MotionSceneInput { key: number }
const styleId = ref<MotionStyleId>('flat-pop')
const selectedStyle = computed(() => getMotionStyle(styleId.value))
const scenes = ref<SceneDraft[]>([]), previewKey = ref<number>(), pendingAssetId = ref('')
let nextSceneKey = 0
const title = ref(''), placement = ref<'append' | 'prepend'>('append'), tempo = ref<'calm' | 'balanced' | 'energetic'>('balanced')
const accent = ref(selectedStyle.value.palette.accent), background = ref(selectedStyle.value.palette.background), textColor = ref(selectedStyle.value.palette.textColor)
const musicAssetId = ref(''), musicVolume = ref(25), sourceAudio = ref(false), logoAssetId = ref('')
const task = useEditorTool(() => props.run, value => emit('busy', value))
const visuals = computed(() => projectSourceAssets(props.project).filter(asset => asset.kind === 'image' || asset.kind === 'video'))
const audioAssets = computed(() => props.project.assets.filter(asset => asset.kind === 'audio'))
const imageAssets = computed(() => visuals.value.filter(asset => asset.kind === 'image'))
const assetMap = computed(() => new Map(props.project.assets.map(asset => [asset.id, asset])))
const selectedScene = computed(() => scenes.value.find(scene => scene.key === previewKey.value) || scenes.value[0])
const previewAsset = computed(() => selectedScene.value ? assetMap.value.get(selectedScene.value.assetId) : undefined)
const options = computed<MotionComposeOptions>(() => ({
  styleId: styleId.value, scenes: scenes.value.map(({ key: _key, ...scene }) => ({ ...scene })),
  placement: placement.value, ...(title.value.trim() ? { title: title.value.trim() } : {}), tempo: tempo.value,
  accent: accent.value, background: background.value, textColor: textColor.value,
  ...(musicAssetId.value ? { musicAssetId: musicAssetId.value } : {}), musicVolume: musicVolume.value / 100,
  sourceAudio: sourceAudio.value, ...(logoAssetId.value ? { logoAssetId: logoAssetId.value } : {}),
}))
const planned = computed(() => {
  if (!scenes.value.length) return { error: '', plan: undefined }
  try { return { error: '', plan: planMotionComposition(props.project, options.value) } }
  catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause), plan: undefined } }
})
const posters = new WeakMap<HTMLCanvasElement, string>()
function poster(element: unknown, id: string): void {
  if (!(element instanceof HTMLCanvasElement) || posters.get(element) === id) return
  drawMotionStylePoster(element, id); posters.set(element, id)
}
function previewPoster(element: unknown): void {
  if (!(element instanceof HTMLCanvasElement)) return
  const palette = { accent: accent.value, background: background.value, textColor: textColor.value }
  const key = `${styleId.value}:${palette.accent}:${palette.background}:${palette.textColor}`
  if (posters.get(element) === key) return
  const context = element.getContext('2d')
  if (!context) return
  drawMotionStyleBackground(context, element.width, element.height, styleId.value, palette)
  context.save(); context.translate(element.width * .67, element.height * .45)
  drawMotionStyleDecoration(context, element.width * .35, styleId.value, palette)
  context.restore(); posters.set(element, key)
}
function resetColors(): void {
  accent.value = selectedStyle.value.palette.accent
  background.value = selectedStyle.value.palette.background
  textColor.value = selectedStyle.value.palette.textColor
}
watch(styleId, resetColors)
watch(visuals, list => {
  if (!list.some(asset => asset.id === pendingAssetId.value)) pendingAssetId.value = list[0]?.id || ''
}, { immediate: true })
function assetName(assetId: string): string { return assetMap.value.get(assetId)?.name || '素材已移除' }
function seconds(value: number): string { return `${Number(value.toFixed(2))} 秒` }
function addScene(): void {
  const asset = assetMap.value.get(pendingAssetId.value)
  if (task.busy.value || !asset || !['image', 'video'].includes(asset.kind) || scenes.value.length >= 16) return
  const scene: SceneDraft = { key: ++nextSceneKey, assetId: asset.id, heading: '', caption: '', duration: 4 }
  if (asset.kind === 'video') scene.trimIn = 0
  scenes.value.push(scene); previewKey.value = scene.key
}
function moveScene(index: number, direction: -1 | 1): void {
  if (task.busy.value || index + direction < 0 || index + direction >= scenes.value.length) return
  const [scene] = scenes.value.splice(index, 1)
  scenes.value.splice(index + direction, 0, scene)
}
function removeScene(index: number): void {
  if (task.busy.value) return
  const [scene] = scenes.value.splice(index, 1)
  if (previewKey.value === scene.key) previewKey.value = scenes.value[Math.min(index, scenes.value.length - 1)]?.key
}
function videoAsset(scene: SceneDraft): MediaAsset | undefined {
  const asset = assetMap.value.get(scene.assetId)
  return asset?.kind === 'video' ? asset : undefined
}
async function compose(): Promise<void> {
  if (!planned.value.plan || task.busy.value) return
  const result = await task.execute('open_media_motion_compose', { ...options.value }, '')
  if (result === undefined) return
  const data = toolData(result)
  const selection = toolData(data.selection)
  const clipId = typeof selection.clipId === 'string' ? selection.clipId : Array.isArray(data.clipIds) && typeof data.clipIds[0] === 'string' ? data.clipIds[0] : undefined
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter((item): item is string => typeof item === 'string') : []
  emit('status', `已添加${selectedStyle.value.name} · ${Number(data.sceneCount) || scenes.value.length} 个分镜，可在时间线继续编辑${warnings.length ? `；${warnings.join('；')}` : ''}`)
  emit('complete', typeof data.start === 'number' ? data.start : 0, clipId)
}
</script>

<template>
  <div class="et-panel motion-composer" data-testid="motion-style-composer">
    <p class="motion-intro">用自己的图片和视频编排分镜，生成可继续编辑的图层、文字和动画。</p>
    <fieldset :disabled="task.busy.value">
      <div class="motion-heading"><h3>选择风格</h3><span>15 种二维动画包装 · 滚动查看更多</span></div>
      <div class="motion-style-grid" aria-label="成片风格">
        <button v-for="style in MOTION_STYLES" :key="style.id" type="button" class="motion-style-card" :data-style-id="style.id" :aria-label="style.name" :aria-pressed="styleId === style.id" :title="style.description" @click="styleId = style.id">
          <canvas :ref="element => poster(element, style.id)" width="320" height="180" aria-hidden="true" />
          <span>{{ style.name }}<Icon v-if="styleId === style.id" name="check" :size="13" /></span>
        </button>
      </div>
      <div class="motion-selected-description"><strong>{{ selectedStyle.name }}</strong><span>{{ selectedStyle.description }}</span><p v-if="selectedStyle.note">{{ selectedStyle.note }}</p></div>
      <div class="motion-columns">
        <section class="motion-storyboard" aria-label="成片分镜">
          <div class="motion-heading"><h3>编排分镜</h3><span>{{ scenes.length }} / 16</span></div>
          <div v-if="visuals.length" class="motion-add-row">
            <select v-model="pendingAssetId" aria-label="选择分镜素材"><option v-for="asset in visuals" :key="asset.id" :value="asset.id">{{ asset.name }} · {{ asset.kind === 'video' ? seconds(asset.duration) : '图片' }}</option></select>
            <button type="button" :disabled="!pendingAssetId || scenes.length >= 16" data-testid="motion-add-scene" @click="addScene"><Icon name="plus" :size="14" />加入</button>
          </div>
          <div v-else class="motion-empty"><Icon name="image" :size="24" /><strong>先准备图片或视频</strong><span>导入项目后，即可为每个素材安排文字和时长。</span><button type="button" @click="emit('import')"><Icon name="import" :size="14" />导入素材</button></div>
          <div v-if="visuals.length && !scenes.length" class="motion-empty motion-empty-small"><Icon name="layers" :size="24" /><span>选择素材并加入分镜。可以重复使用同一个视频，设置不同起点。</span></div>
          <ol v-if="scenes.length" class="motion-scenes" aria-label="分镜列表">
            <li v-for="(scene, index) in scenes" :key="scene.key" class="motion-scene" :class="{ current: selectedScene?.key === scene.key }" :data-scene-key="scene.key" @focusin="previewKey = scene.key">
              <div class="motion-scene-heading">
                <button type="button" class="motion-scene-name" :aria-label="`预览分镜 ${index + 1}`" :title="assetName(scene.assetId)" @click="previewKey = scene.key"><span>{{ String(index + 1).padStart(2, '0') }}</span><Icon :name="videoAsset(scene) ? 'video' : 'image'" :size="13" /><strong>{{ assetName(scene.assetId) }}</strong></button>
                <div class="motion-order"><button type="button" :aria-label="`上移分镜 ${index + 1}`" :disabled="index === 0" @click="moveScene(index, -1)"><Icon name="chevron-up" :size="14" /></button><button type="button" :aria-label="`下移分镜 ${index + 1}`" :disabled="index === scenes.length - 1" @click="moveScene(index, 1)"><Icon name="chevron-down" :size="14" /></button><button type="button" :aria-label="`删除分镜 ${index + 1}`" @click="removeScene(index)"><Icon name="trash" :size="13" /></button></div>
              </div>
              <label class="et-field">标题<input v-model="scene.heading" :aria-label="`分镜 ${index + 1} 标题`" maxlength="120" placeholder="可选，留空只展示素材" /></label>
              <label class="et-field">说明<input v-model="scene.caption" :aria-label="`分镜 ${index + 1} 说明`" maxlength="240" placeholder="可选，补充一句说明" /></label>
              <div class="et-grid motion-timing"><label class="et-field">展示时长（秒）<input v-model.number="scene.duration" type="number" min="2" max="12" step="0.1" :aria-label="`分镜 ${index + 1} 时长`" /></label><label v-if="videoAsset(scene)" class="et-field">视频起点（秒）<input v-model.number="scene.trimIn" type="number" min="0" :max="videoAsset(scene)?.duration" step="0.1" :aria-label="`分镜 ${index + 1} 视频起点`" /></label></div>
            </li>
          </ol>
          <p class="et-note">每段可设 2–12 秒。视频剩余时长不足时将缩短该分镜，并在生成前提示。</p>
        </section>
        <section class="motion-settings" aria-label="风格与声音设置">
          <div class="motion-heading"><h3>风格示意</h3><span>静态示意 · {{ project.width }} × {{ project.height }}</span></div>
          <div class="motion-preview" :class="`layout-${selectedStyle.layout}`" :style="{ '--motion-accent': accent, '--motion-background': background, '--motion-text': textColor, fontFamily: selectedStyle.fontFamily }">
            <canvas :ref="previewPoster" width="640" height="360" aria-hidden="true" />
            <div class="motion-preview-surface" aria-hidden="true" />
            <div class="motion-preview-asset"><img v-if="previewAsset?.kind === 'image'" :src="previewAsset.url" alt="所选图片素材" /><AssetVideoThumbnail v-else-if="previewAsset?.kind === 'video'" :key="previewAsset.id" :src="previewAsset.url" /><Icon v-else name="image" :size="32" /></div>
            <div class="motion-preview-text"><small>{{ selectedScene ? `SCENE ${String(scenes.indexOf(selectedScene) + 1).padStart(2, '0')}` : 'YOUR STORY' }}</small><strong>{{ selectedScene?.heading || '你的故事' }}</strong><span>{{ selectedScene?.caption || '素材、文字与图形，共同组成画面。' }}</span></div>
          </div>
          <p class="et-note">此处展示风格与素材的静态布局；生成后在时间线预览实际动画。</p>
          <div class="motion-palette"><label>背景<input v-model="background" type="color" aria-label="成片背景颜色" /></label><label>强调<input v-model="accent" type="color" aria-label="成片强调颜色" /></label><label>文字<input v-model="textColor" type="color" aria-label="成片文字颜色" /></label><button type="button" title="恢复风格配色" aria-label="恢复风格配色" @click="resetColors"><Icon name="refresh" :size="13" /></button></div>
          <div class="et-grid"><label class="et-field">成片名称<input v-model="title" aria-label="成片名称" maxlength="120" :placeholder="selectedStyle.name" /></label><label class="et-field">动画节奏<select v-model="tempo" aria-label="动画节奏"><option value="calm">舒缓</option><option value="balanced">均衡</option><option value="energetic">轻快</option></select></label></div>
          <div class="et-grid"><label class="et-field">插入位置<select v-model="placement" aria-label="成片插入位置"><option value="append">当前工程末尾</option><option value="prepend">当前工程开头</option></select></label><label class="et-field">品牌图片<select v-model="logoAssetId" aria-label="成片品牌图片"><option value="">无</option><option v-for="asset in imageAssets" :key="asset.id" :value="asset.id">{{ asset.name }}</option></select></label></div>
          <div class="et-grid"><label class="et-field">背景音乐<select v-model="musicAssetId" aria-label="成片背景音乐"><option value="">无</option><option v-for="asset in audioAssets" :key="asset.id" :value="asset.id">{{ asset.name }}</option></select></label><label class="et-field">配乐音量（%）<input v-model.number="musicVolume" type="number" min="0" max="100" step="1" :disabled="!musicAssetId" aria-label="成片配乐音量" /></label></div>
          <label class="et-check"><input v-model="sourceAudio" type="checkbox" aria-label="保留视频原声" />保留视频原声</label>
          <p v-if="placement === 'prepend'" class="et-note">放到工程开头时，现有片段和标记将整体后移。</p>
        </section>
      </div>
    </fieldset>
    <div class="motion-footer">
      <div class="motion-generate">
        <div class="motion-summary" aria-live="polite"><strong v-if="planned.plan">{{ scenes.length }} 个分镜 · {{ seconds(planned.plan.duration) }}</strong><span>{{ planned.plan ? `从 ${seconds(planned.plan.start)} 开始，添加独立图层，可整体撤销` : '加入分镜后即可生成' }}</span></div>
        <button type="button" class="et-primary" data-testid="motion-compose-submit" :disabled="task.busy.value || !planned.plan" @click="compose"><Icon name="sparkles" :size="15" />{{ task.busy.value ? '正在编排…' : '生成到时间线' }}</button>
      </div>
      <p v-if="planned.error" class="et-error motion-validation" role="alert"><Icon name="alert" :size="14" />{{ planned.error }}</p>
      <ul v-if="planned.plan?.warnings.length" class="motion-warnings"><li v-for="warning in planned.plan.warnings" :key="warning">{{ warning }}</li></ul>
      <EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
    </div>
  </div>
</template>

<style src="./editor-tools/editor-tools.css"></style>
<style scoped>
.motion-composer{padding:16px 18px}.motion-intro{margin:0 0 14px;color:var(--ed-muted,var(--ui-muted))}.motion-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 9px}.motion-heading h3{margin:0}.motion-heading>span{font-size:10px;color:var(--ed-muted,var(--ui-muted))}.motion-style-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;max-height:250px;overflow:auto;padding:2px;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent;overscroll-behavior:contain}.motion-style-grid .motion-style-card{display:block;padding:0;min-width:0;overflow:hidden;text-align:left;border-radius:8px}.motion-style-card canvas{display:block;width:100%;aspect-ratio:16/9}.motion-style-card>span{display:flex;align-items:center;justify-content:space-between;gap:3px;padding:6px 8px;font-size:11px}.motion-style-card[aria-pressed=true]{border-color:var(--ed-accent);box-shadow:0 0 0 1px var(--ed-accent);color:var(--ed-accent)}.motion-selected-description{padding:11px 2px 14px;font-size:11px;color:var(--ed-muted);min-height:51px}.motion-selected-description>strong{margin-right:8px;color:var(--ed-text)}.motion-selected-description p{margin:4px 0 0;font-size:10px;line-height:1.5}.motion-columns{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:20px;border-top:1px solid var(--ed-border);padding-top:14px}.motion-storyboard,.motion-settings{min-width:0}.motion-add-row{display:flex;align-items:center;gap:6px}.motion-add-row>select{min-width:0;flex:1;height:32px;font-size:11px}.motion-add-row>button{flex:none}.motion-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:9px;min-height:220px;padding:20px;color:var(--ed-muted);border:1px dashed var(--ed-border);border-radius:8px}.motion-empty>span{max-width:240px;font-size:11px;line-height:1.7}.motion-empty-small{margin-top:10px;min-height:180px}.motion-scenes{list-style:none;padding:2px;margin:10px 0 0;max-height:407px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent}.motion-scene{border:1px solid var(--ed-border);border-radius:8px;padding:9px;margin-bottom:8px;background:color-mix(in srgb,var(--ed-panel) 70%,transparent)}.motion-scene.current{border-color:color-mix(in srgb,var(--ed-accent) 55%,var(--ed-border))}.motion-scene:last-child{margin-bottom:0}.motion-scene-heading{display:flex;align-items:center;gap:6px;margin-bottom:8px}.motion-scene-heading .motion-scene-name{display:flex;align-items:center;justify-content:flex-start;gap:5px;flex:1;min-width:0;border:0;padding:0;background:transparent;min-height:25px;text-align:left}.motion-scene-name>span{font:10px ui-monospace,monospace;color:var(--ed-accent)}.motion-scene-name svg{flex:none;color:var(--ed-muted)}.motion-scene-name strong{font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.motion-order{display:flex;gap:2px;flex:none}.motion-order button{padding:2px;min-height:24px;width:24px;border-color:transparent;background:transparent}.motion-scene .et-field{gap:4px;margin-bottom:7px;font-size:10px}.motion-timing .et-field{margin-bottom:0}.motion-preview{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;isolation:isolate;border-radius:8px;background:var(--motion-background);color:var(--motion-text)}.motion-preview>canvas{position:absolute;inset:0;width:100%;height:100%;opacity:.4}.motion-preview-surface{position:absolute;inset:0;background:var(--motion-background);opacity:.25}.motion-preview-asset{position:absolute;left:45%;top:20%;width:48%;height:64%;display:flex;align-items:center;justify-content:center;border:2px solid var(--motion-accent);box-shadow:5px 5px 0 color-mix(in srgb,var(--motion-accent) 35%,transparent);background:color-mix(in srgb,var(--motion-background) 85%,var(--motion-accent));overflow:hidden}.motion-preview-asset>img{width:100%;height:100%;object-fit:contain}.motion-preview-asset :deep(video){width:100%;height:100%;object-fit:contain}.motion-preview-text{position:absolute;left:7%;top:23%;width:35%;display:flex;flex-direction:column;gap:7px}.motion-preview-text>small{font-size:7px;letter-spacing:1px;color:var(--motion-accent)}.motion-preview-text>strong{font-size:clamp(12px,1.6vw,21px);line-height:1.25;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.motion-preview-text>span{font-size:9px;line-height:1.5;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.layout-center .motion-preview-asset,.layout-stack .motion-preview-asset{left:20%;top:12%;width:60%;height:52%}.layout-center .motion-preview-text,.layout-stack .motion-preview-text{left:12%;top:71%;width:76%;text-align:center;gap:3px}.layout-center .motion-preview-text>small,.layout-stack .motion-preview-text>small{display:none}.layout-center .motion-preview-text>strong,.layout-stack .motion-preview-text>strong{font-size:16px;-webkit-line-clamp:1}.layout-center .motion-preview-text>span,.layout-stack .motion-preview-text>span{-webkit-line-clamp:1}.layout-collage .motion-preview-asset{transform:rotate(4deg);left:45%;top:17%;width:46%;height:66%}.layout-collage .motion-preview-text>strong{background:var(--motion-accent);color:var(--motion-background);padding:4px;transform:rotate(-3deg)}.motion-palette{display:flex;gap:9px;align-items:center;margin:12px 0}.motion-palette>label{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--ed-muted)}.motion-palette input[type=color]{width:30px;height:25px;padding:2px;border:1px solid var(--ed-border);border-radius:5px;background:var(--ed-panel);cursor:pointer}.motion-palette>button{margin-left:auto;min-height:25px;padding:3px 6px}.motion-settings .et-field{font-size:10px;margin-bottom:9px}.motion-footer{position:sticky;bottom:0;z-index:3;margin:13px -18px -16px;padding:12px 18px 16px;border-top:1px solid var(--ed-border);background:var(--ui-modal-surface,var(--ed-panel));-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);box-shadow:0 -6px 16px #0001}.motion-generate{display:flex;align-items:center;justify-content:space-between;gap:12px}.motion-summary{display:flex;flex-direction:column;gap:3px;min-width:0}.motion-summary>strong{font-size:11px}.motion-summary>span{font-size:10px;color:var(--ed-muted)}.motion-generate>button{flex:none}.motion-validation{display:flex;gap:6px;align-items:flex-start;font-size:11px;margin:10px 0 0}.motion-validation>svg{flex:none}.motion-warnings{max-height:95px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding-left:18px;margin:10px 0 0;color:var(--ed-warning,#ae771f);font-size:11px;line-height:1.6}.motion-composer button:focus-visible,.motion-composer select:focus-visible,.motion-composer input:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}
@media(max-width:700px){.motion-composer{padding:12px}.motion-footer{bottom:0;margin-inline:-12px;margin-bottom:-12px;padding:12px}.motion-columns{grid-template-columns:1fr;gap:16px}.motion-style-grid{grid-template-columns:repeat(3,minmax(0,1fr));max-height:235px}.motion-scenes{max-height:320px}.motion-preview{max-width:420px;margin:auto}.motion-preview-text>strong{font-size:19px}.motion-preview-text>span{font-size:10px}.motion-generate{align-items:flex-start}.motion-summary>span{max-width:180px}.motion-settings .et-field{font-size:11px}.motion-selected-description{min-height:0}}
@media(prefers-reduced-motion:reduce){.motion-composer button,.motion-composer select{transition:none}}
</style>
