<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MediaAsset } from '../../core/types'
import type { AssetToolAction, EditorToolRunner } from './types'
import { toolData } from './types'
import { useEditorTool } from './use-editor-tool'
import { saveToolFile } from './save-tool-file'
import EditorToolStatus from './EditorToolStatus.vue'
import Icon from '../Icon.vue'

const props = defineProps<{ asset?: MediaAsset; action: AssetToolAction; native: boolean; run: EditorToolRunner }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const task = useEditorTool(() => props.run, busy => emit('busy', busy))
const action = ref(props.action), url = ref(''), filename = ref(''), time = ref(0), count = ref(8), start = ref(0), end = ref(props.asset?.duration || 0), threshold = ref(.3), minimum = ref(2), language = ref('zh-en'), storyboardMode = ref('time')
const actions: { id: AssetToolAction; label: string; icon: string }[] = [
  { id: 'probe', label: '素材分析', icon: 'info' }, { id: 'frame', label: '提取画面', icon: 'image' }, { id: 'storyboard', label: '联系表', icon: 'panel' },
  { id: 'scenes', label: '场景检测', icon: 'scissors' }, { id: 'idle', label: '黑场 / 静止 / 静音', icon: 'volume-off' }, { id: 'ocr', label: '识别文字', icon: 'text' },
]
const available = computed(() => actions.filter(item => props.asset?.kind === 'video' || item.id === 'probe' || props.asset?.kind === 'image' && ['frame', 'ocr'].includes(item.id) || props.asset?.kind === 'audio' && item.id === 'idle'))
const data = computed(() => toolData(task.result.value))
const frames = computed(() => (Array.isArray(data.value.frames) ? data.value.frames : data.value.base64 ? [data.value] : []).filter(value => value && typeof value === 'object') as Record<string, unknown>[])
const sheet = computed(() => data.value.sheet && typeof data.value.sheet === 'object' ? data.value.sheet as Record<string, unknown> : undefined)
const repeated = computed(() => Array.isArray(data.value.repeatedIntervals) ? data.value.repeatedIntervals as { start: number; end: number; referenceStart: number; referenceEnd: number; confidence: number }[] : [])
const extractedText = computed(() => typeof data.value.text === 'string' ? data.value.text : '')
const rows = computed(() => {
  const output: { label: string; value: string }[] = []
  const labels: Record<string, string> = { duration: '时长 / 秒', width: '宽度', height: '高度', size: '文件大小 / 字节', codec: '编码', codec_name: '编码', sampleRate: '采样率', sample_rate: '采样率', channels: '声道', format: '格式', bitrate: '码率', bit_rate: '码率', name: '名称', mimeType: '媒体类型', confidence: '置信度', sourceTime: '画面时间 / 秒', threshold: '检测阈值', minInterval: '最小间隔 / 秒', frameRate: '帧率', rotationDegrees: '旋转 / 度', hasAlphaChannel: '透明通道', bitRate: '码率', hasVideo: '包含视频', hasAudio: '包含音频', streams: '媒体流', points: '场景变化点', time: '时间 / 秒', score: '变化分值', intervals: '候选区间', start: '开始 / 秒', end: '结束 / 秒', interpretation: '结果说明', kind: '类型', mime: '媒体类型', type: '类型', profile: '编码规格', pixelFormat: '像素格式', channelLayout: '声道布局', startTime: '开始时间 / 秒', encodedBytes: '图像大小 / 字节', requestedTime: '请求时间 / 秒', language: '识别语言', confidenceBasis: '置信度依据', detectors: '检测类型', detector: '检测方式', minimumDuration: '最短持续 / 秒', repetitionScope: '相似画面分析范围', repetitionThreshold: '相似度阈值', maxDuration: '最长分析 / 秒', fps: '抽样帧率' }
  function visit(value: unknown, prefix = '', depth = 0): void {
    if (!value || typeof value !== 'object' || depth > 2 || output.length > 80) return
    for (const [key, entry] of Object.entries(value)) {
      if (['base64', 'text', 'url', 'sourceUrl', 'nativePath', 'frames', 'asset', 'sheet', 'assetId', 'timeBase', 'artifactId', 'repeatedIntervals', 'repetitionLimitation'].includes(key)) continue
      const label = prefix ? `${prefix} · ${labels[key] || key}` : labels[key] || key
      if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') output.push({ label, value: String(entry) })
      else if (Array.isArray(entry)) entry.slice(0, 40).forEach((item, index) => typeof item === 'object' ? visit(item, `${label} ${index + 1}`, depth + 1) : output.push({ label: `${label} ${index + 1}`, value: String(item) }))
      else visit(entry, label, depth + 1)
    }
  }
  visit(data.value)
  return output
})
function frameUrl(frame: Record<string, unknown>): string { return typeof frame.base64 === 'string' ? `data:image/png;base64,${frame.base64}` : '' }
async function download(url: string, name: string): Promise<void> { try { await saveToolFile(await (await fetch(url)).blob(), name) } catch (cause) { task.error.value = cause instanceof Error ? cause.message : String(cause) } }
async function saveText(): Promise<void> { try { await saveToolFile(new Blob([extractedText.value], { type: 'text/plain;charset=utf-8' }), '识别文字.txt') } catch (cause) { task.error.value = cause instanceof Error ? cause.message : String(cause) } }
async function run(): Promise<void> {
  if (!props.native || task.busy.value) return
  let name = '', args: Record<string, unknown> = props.asset ? { assetId: props.asset.id, asset: props.asset } : {}
  switch (action.value) {
    case 'url': name = 'asset_import_url'; args = { url: url.value.trim(), ...(filename.value.trim() ? { name: filename.value.trim() } : {}) }; break
    case 'probe': name = 'asset_probe'; break
    case 'frame': name = 'asset_get_frame'; args.time = time.value; args.maxWidth = 1920; break
    case 'storyboard': name = 'asset_storyboard'; Object.assign(args, { start: start.value, ...(end.value > start.value ? { end: end.value } : {}), count: count.value, maxWidth: 480, mode: storyboardMode.value, ...(storyboardMode.value === 'scene' ? { threshold: threshold.value } : {}) }); break
    case 'scenes': name = 'asset_detect_scenes'; args.threshold = threshold.value; args.minInterval = .5; break
    case 'idle': name = 'asset_detect_idle'; args.minDuration = minimum.value; args.noiseDb = -45; break
    case 'ocr': name = 'asset_ocr'; args.time = time.value; args.language = language.value; args.width = 1920; break
  }
  await task.execute(`open_media_${name}`, args, action.value === 'url' ? '素材已导入项目' : '分析完成')
}
watch(() => props.action, value => { action.value = value })
</script>
<template>
  <section class="et-panel" data-testid="asset-tools-panel">
    <p v-if="asset" class="et-note">{{ asset.name }}</p>
    <div v-if="action !== 'url'" class="et-tabs" aria-label="素材工具"><button v-for="item in available" :key="item.id" :aria-pressed="action === item.id" :disabled="task.busy.value" @click="action = item.id; task.result.value = undefined; task.error.value = ''; task.notice.value = ''"><Icon :name="item.icon" :size="14" />{{ item.label }}</button></div>
    <p v-if="!native" class="et-note">素材分析与网址导入需要桌面版运行环境。</p>
    <fieldset :disabled="task.busy.value || !native">
      <template v-if="action === 'url'"><label class="et-field">视频、音频或图片文件地址<input v-model="url" type="url" placeholder="https://example.com/video.mp4" aria-label="素材网址" /></label><label class="et-field">文件名称（可选）<input v-model="filename" maxlength="180" aria-label="网址素材名称" placeholder="保留原文件名称" /></label><p class="et-note">填写可直接下载的媒体文件地址；导入后保存在本地项目中。</p></template>
      <template v-else-if="action === 'frame' || action === 'ocr'"><label v-if="asset?.kind !== 'image'" class="et-field">画面时间 / 秒<input v-model.number="time" type="number" min="0" :max="asset?.duration || undefined" step=".1" aria-label="提取画面时间" /></label><label v-if="action === 'ocr'" class="et-field">文字语言<select v-model="language" aria-label="识别文字语言"><option value="zh-en">简体中文与英文</option><option value="en">英文</option></select></label></template>
      <template v-else-if="action === 'storyboard'"><label class="et-field">取帧方式<select v-model="storyboardMode" aria-label="联系表取帧方式"><option value="time">按时间均匀取帧</option><option value="scene">按场景选择代表画面</option></select></label><label v-if="storyboardMode === 'scene'" class="et-field">场景变化阈值<input v-model.number="threshold" type="number" min="0" max="1" step=".05" aria-label="联系表场景阈值" /><small>根据画面变化选择场景中点，分析范围最长 600 秒。</small></label><div class="et-grid"><label class="et-field">开始 / 秒<input v-model.number="start" type="number" min="0" step=".1" aria-label="联系表开始时间" /></label><label class="et-field">结束 / 秒<input v-model.number="end" type="number" min="0" :max="asset?.duration || undefined" step=".1" aria-label="联系表结束时间" /></label><label class="et-field">画面数量<input v-model.number="count" type="number" min="2" max="24" aria-label="联系表画面数量" /></label></div></template>
      <label v-else-if="action === 'scenes'" class="et-field">画面变化阈值<input v-model.number="threshold" type="number" min=".05" max=".95" step=".05" aria-label="场景检测阈值" /><small>数值越小，越容易识别画面变化。</small></label>
      <label v-else-if="action === 'idle'" class="et-field">最短持续时长 / 秒<input v-model.number="minimum" type="number" min=".1" max="3600" step=".1" aria-label="最短持续时长" /></label>
      <div class="et-actions"><button class="et-primary" :disabled="action === 'url' && !url.trim()" data-testid="asset-tool-run" @click="run"><Icon :name="action === 'url' ? 'import' : 'play'" :size="14" />{{ action === 'url' ? '导入素材' : '开始处理' }}</button></div>
    </fieldset>
    <EditorToolStatus :busy="task.busy.value" :cancelling="task.cancelling.value" :cancelable="task.cancelable.value" :stage="task.stage.value" :percent="task.percent.value" :error="task.error.value" :notice="task.notice.value" @cancel="task.cancel" />
    <p v-if="action === 'idle'" class="et-note">检测黑场、近静止和静音的候选区间，不判断内容是否有用；不同类型的区间可能重叠。</p>
    <div v-if="sheet" class="asset-tool-sheet et-result"><img :src="frameUrl(sheet)" alt="完整视频联系表" /><button @click="download(frameUrl(sheet), '视频联系表.png')"><Icon name="download" :size="14" />保存整张联系表</button></div>
    <div v-if="frames.length" class="asset-tool-frames et-result"><figure v-for="(frame, index) in frames" :key="index"><img :src="frameUrl(frame)" :alt="`提取画面 ${index + 1}`" /><figcaption><span>{{ Number(frame.sourceTime ?? frame.requestedTime ?? 0).toFixed(2) }} 秒<template v-if="typeof frame.sceneStart === 'number' && typeof frame.sceneEnd === 'number'"> · 场景 {{ frame.sceneStart.toFixed(1) }}–{{ frame.sceneEnd.toFixed(1) }} 秒</template></span><button title="保存图片" @click="download(frameUrl(frame), `画面-${index + 1}.png`)"><Icon name="download" :size="14" /></button></figcaption></figure></div>
    <div v-if="extractedText" class="et-result"><label class="et-field">识别结果<textarea :value="extractedText" readonly aria-label="文字识别结果" /></label><button @click="saveText"><Icon name="download" :size="14" />保存文字</button></div>
    <div v-if="repeated.length" class="et-result"><p class="et-note">候选重复画面，仅表示视觉相似，不代表已确认重复操作。</p><table><thead><tr><th>候选区间 / 秒</th><th>相似画面 / 秒</th><th>相似度</th></tr></thead><tbody><tr v-for="(interval, index) in repeated" :key="index"><td>{{ interval.start.toFixed(2) }}–{{ interval.end.toFixed(2) }}</td><td>{{ interval.referenceStart.toFixed(2) }}–{{ interval.referenceEnd.toFixed(2) }}</td><td>{{ (interval.confidence * 100).toFixed(0) }}%</td></tr></tbody></table></div><p v-if="data.repetitionLimitation" class="et-note">{{ data.repetitionLimitation }}</p>
    <div v-if="rows.length" class="et-result"><dl><template v-for="(row, index) in rows" :key="index"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></template></dl></div>
  </section>
</template>
<style src="./editor-tools.css"></style>
<style scoped>
.asset-tool-sheet img{display:block;width:100%;height:auto;margin-bottom:8px}.asset-tool-frames{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;max-height:420px}.asset-tool-frames figure{margin:0;min-width:0}.asset-tool-frames img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:var(--ed-bg);border:1px solid var(--ed-border);border-radius:6px}.asset-tool-frames figcaption{display:flex;align-items:center;justify-content:space-between;font-size:10px;color:var(--ed-muted);margin-top:4px}.asset-tool-frames figcaption button{min-height:25px;padding:3px 6px}
</style>
