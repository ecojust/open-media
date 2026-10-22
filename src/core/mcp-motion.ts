import type { McpMotionConfig, MediaAsset, Project } from './types.ts'
import { MOTION_STYLES, type MotionStyle } from './motion-style-catalog.ts'
import { videoWorkingCopyResolver } from './video-working-copies.ts'
import { projectSourceAssets } from './editor-assets.ts'
import { getMcpGenerationCapabilities, type McpGenerationCapabilities } from './mcp-generation-capabilities.ts'

export type { McpMotionConfig } from './types.ts'
/** Capacity of one local preset render; unrelated to the user's source selection. */
const MAX_MCP_PRESET_SCENES = 16
export const MAX_MCP_MOTION_PROMPT = 4000

/** One candidate set for the GUI, counters and the agent's selected-media scope. */
export function mcpMotionAssets(project: Project): MediaAsset[] {
  return projectSourceAssets(project).filter(asset => asset.kind === 'image' || asset.kind === 'video')
}

export function mcpMotionWorkflowPrompt(project: Project): string {
  return [
    '任务：由外部 Agent 理解所选素材，用代码生成可复用的图片、透明图层或独立透明／绿幕特效素材，再通过 MCP 将这些素材分层放入当前工程轨道。原视频、图片、标题、字幕、装饰、配音、音乐和转场分别保留为可编辑片段，最终成片由 Open Media 的时间线合成和导出。代码由 Agent 在自己的可执行环境中运行，Open Media 不执行任意代码；禁止让 Agent 将整段成片、主内容与装饰预先烘焙成一个视频再导入。',
    '先检查 ready、projectId 和 revision；既有图片与视频只使用用户已选的视觉素材。通过 open_media_asset_probe、open_media_asset_get_frame 或 open_media_asset_storyboard 检查真实内容，自行规划故事、源素材截取范围、节拍表、文案和各镜时长。',
    '使用 open_media_asset_read 分块取得所选源素材：首块保存 sourceVersion，续传携带同一版本，校验 chunkSha256 后按 offset 拼接；工程、选择或源版本变化时重新读取配置，不使用过期素材。',
    '只有创作确实需要额外图片或音乐时才生成补充素材。先检查 additionalAssetGeneration 中对应 image／music 能力；checked=false、availability=unknown 或检查失败时，先调用 open_media_ai_status({probeRuntime:true}) 获取 generationCapabilities，不得把未检查、检查失败或缓存状态当成没有可用模型。检测只核对本地模型与运行环境，不代表已成功生成。',
    '默认优先用户当前选择的本地模型：对应能力 selectedModelId 已列入 readyModelIds 时，通过 open_media_image_generate 或 open_media_music_generate 生成；省略 modelId 沿用该选择，不能指定其他已下载模型，也不能为了请求模式而自动切换模型。配音及试听同样只能使用 speech_settings_get.voiceId，不能通过 speech_settings_set 更换用户所选音色。使用 destination=assets 加入当前工程素材，或 destination=timeline 直接插入合适轨道，背景音乐明确设置 instrumental:true。等待 jobId 完成并取得真实素材后再使用。只有用户明确要求 Agent 自行生成时，才覆盖此默认本地优先策略。',
    '对应能力确认 unavailable、用户当前所选模型不可用时，由 Agent 在自己的环境生成补充图片或音乐，再通过 open_media_asset_upload 或 open_media_asset_import_url 加入工程。忙碌状态 busy=true 应等待正在进行的任务并重新检查，不能等同于没有模型，也不能因此擅自改为 Agent 生成；生成失败应说明真实原因，不伪称成功，不自动下载或修复模型。',
    '按上述流程新生成的图片与音乐可以补充本次创作，不会自动修改用户已选素材配置；仍不能借补充素材之名读取未选中的既有图片或视频。新素材需要用于外部动画代码时，先以 destination=assets 入库，再按返回 assetId 读取和使用。配乐也可引用当前工程已有的音频。',
    `所有素材围绕当前工程 ${project.width} × ${project.height} 像素、${project.fps} fps 设计；独立图效可按实际占用区域生成，放置坐标与尺寸使用项目像素。静态底图、边框、纹理、箭头或装饰优先输出 PNG；SVG 可作为代码生成源，但回传前须栅格化为 PNG，MCP 素材上传不接收 SVG。需要透出底层时保留 alpha，不能把透明区域填成黑色。字幕和普通标题使用可编辑文字片段，常规移动、缩放、旋转、透明度、裁切与转场交给剪辑器。`,
    '为每种风格列出素材清单和分层计划：轨道数组从前到后对应从底层到顶层，zIndex 等于轨道下标，从 0 开始，数值越大越靠上。底图放前面的轨道，原视频与主内容放中间，装饰图片、标注与标题放后面的轨道；通过 track_add／track_reorder 调整顺序，不把图层全部压成一张图。图片像固定字幕一样设置 start、trimOut、x、y、width、height，可独立拖动、缩放和调整时长。',
    '只有剪辑器无法直接表达的局部特效才输出独立动态图效素材。优先透明视频；需绿幕时使用纯净且与主体区分的底色，添加片段后在 clip_update.patch 设置 chromaKey：enabled=true、color 为实际幕色、similarity=0.18、blend=0.08、spillSuppression=true，再根据边缘检查微调。先用 asset_probe 检查 alpha 与编码兼容性，确认抠像边缘没有残色；图效不能包含已选原视频、整段主画面或已混入的字幕与音乐。',
    '独立图效的每一帧定义为时间 t 的确定性结果，例如 renderAt(t)，随机性使用固定种子；先检查图效关键帧，再生成需要的素材文件。普通片段动画使用 open_media_clip_keyframes_set，裁切使用 open_media_clip_crop，标题使用 open_media_title_add；在同一工程时间轴上对齐素材、运动和音效，文字保留安全边距与阅读时间。',
    '依照下方默认视觉风格实现其标志性运动、材质和构图，再叠加用户额外创作要求。不是简单更换配色或重复静态卡片；额外要求为空也必须执行默认流程和风格。',
    '素材生成后使用 open_media_asset_upload 分块校验上传图片或独立图效，或 open_media_asset_import_url 导入可访问的媒体直链；查询 jobId 至 completed 后取得各自 assetId。随后使用 open_media_track_add、open_media_clip_add 和 open_media_timeline_batch_edit 按分层计划放置各个片段，保留独立位置、时长和动画参数；设置的每个轨道只承载对应层次，最终合成与导出使用编辑器。',
    '使用 open_media_timeline_get_frame、open_media_preview_render 和 open_media_export_validate 检查真正融合后的效果，修正黑帧、遮挡、文字错误和声音冲突，再报告结果与采用的实现方式。',
    '25 种风格均使用素材生成与时间线分层编排流程，presetGenerationTool 为 null。旧的 motion_clip_generate 整片快捷合成不用于此任务；缺少代码执行或独立图效生成能力时应说明实际限制，不用整片预渲染绕过编辑器。完成轨道融合和预览检查后，按用户导出要求使用 open_media_export_start 由编辑器输出成片。',
  ].join('\n\n')
}

/** Validate stored values while permitting an unfinished user configuration. */
export function normalizeMcpMotion(value?: unknown): McpMotionConfig {
  if (value === undefined) return { enabled: false, assetIds: [], styleId: '' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('素材二创配置格式无效。')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['enabled', 'assetIds', 'styleId', 'prompt'].includes(key))) throw new Error('素材二创配置包含不支持的字段。')
  const enabled = input.enabled === undefined ? false : input.enabled, assetIds = input.assetIds === undefined ? [] : input.assetIds, styleId = input.styleId === undefined ? '' : input.styleId
  if (typeof enabled !== 'boolean') throw new Error('素材二创开关必须为布尔值。')
  if (!Array.isArray(assetIds)
    || assetIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id))
    || new Set(assetIds).size !== assetIds.length) throw new Error('素材二创需使用有效且不重复的素材标识。')
  if (typeof styleId !== 'string' || styleId !== '' && !MOTION_STYLES.some(style => style.id === styleId)) throw new Error('素材二创风格不受支持。')
  if (input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.length > MAX_MCP_MOTION_PROMPT || input.prompt.includes('\0'))) throw new Error('素材二创要求需为不超过 4000 字的文本。')
  return { enabled, assetIds: [...assetIds] as string[], styleId, ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}) }
}

export interface McpMotionAsset {
  id: string
  selectedAssetId: string
  name: string
  kind: 'image' | 'video'
  duration: number
  width: number
  height: number
  size: number
  mime: string
}

export type PublicMotionStyle = Omit<MotionStyle, 'presetSupported'>

/** Public style directions do not advertise the independent local preset renderer. */
export function publicMotionStyle(style: MotionStyle): PublicMotionStyle {
  const { presetSupported: _internalPreset, ...publicStyle } = style
  return structuredClone(publicStyle)
}

export interface McpMotionBrief {
  projectId: string
  enabled: boolean
  ready: boolean
  errors: string[]
  configuredAssetIds: string[]
  /** Resolved current working copies to use in the agent's scene plan. */
  assetIds: string[]
  assets: McpMotionAsset[]
  styleId: string
  style: PublicMotionStyle | null
  availableAssetCount: number
  selectedAssetCount: number
  generationMode: 'agent-assets-timeline'
  additionalAssetGeneration: McpGenerationCapabilities
  workflowPrompt: string
  stylePrompt: string
  userPrompt: string
  effectivePrompt: string
  /** User-authored text; defaults are supplied separately and in effectivePrompt. */
  prompt: string
  instructions: string[]
  workflow: {
    codeExecution: 'external-agent'
    finalComposition: 'editor-timeline'
    trackOrder: 'back-to-front'
    zIndex: 'array-index'
    assetOutputs: readonly ['image', 'transparent-image', 'effect-video', 'green-screen-effect']
    presetGenerationTool: null
    capabilityTools: string[]
    generationTools: string[]
    sourceTools: string[]
    importTools: string[]
    inspectionTools: string[]
    editingTools: string[]
    validationTools: string[]
    exportTools: string[]
    jobTools: string[]
  }
}

function publicAsset(asset: MediaAsset, selectedAssetId: string): McpMotionAsset {
  return { id: asset.id, selectedAssetId, name: asset.name, kind: asset.kind as 'image' | 'video',
    duration: asset.duration, width: asset.width, height: asset.height, size: asset.size, mime: asset.mime }
}

/** Detached current-project brief; it never includes local paths or media URLs. */
export function getMcpMotionBrief(project: Project, generationCapabilities?: McpGenerationCapabilities): McpMotionBrief {
  const config = normalizeMcpMotion(project.mcpMotion), errors: string[] = []
  const byId = new Map(project.assets.map(asset => [asset.id, asset])), resolve = videoWorkingCopyResolver(project)
  const candidates = mcpMotionAssets(project), candidateIds = new Set(candidates.map(asset => asset.id))
  const selected = new Map<string, McpMotionAsset>()
  if (!config.enabled) errors.push('请由用户在 MCP 设置中开启素材二创。')
  if (!config.assetIds.length) errors.push('请由用户选择当前工程中的图片或视频素材。')
  if (!config.styleId) errors.push('请由用户选择一种素材二创风格。')
  for (const id of config.assetIds) {
    const original = byId.get(id)
    if (!original) { errors.push(`已选素材 ${id} 已从当前工程移除，请重新选择。`); continue }
    const asset = resolve(original)
    if (!candidateIds.has(asset.id) || original.libraryRole !== undefined) {
      errors.push(`素材“${original.name}”不是可用于二创的工程图片或视频。`)
      continue
    }
    if (!selected.has(asset.id)) selected.set(asset.id, publicAsset(asset, id))
  }
  const assets = [...selected.values()]
  const style = config.styleId ? publicMotionStyle(MOTION_STYLES.find(style => style.id === config.styleId)!) : null
  const workflowPrompt = mcpMotionWorkflowPrompt(project), stylePrompt = style?.prompt ?? '', userPrompt = config.prompt ?? ''
  return {
    projectId: project.id, enabled: config.enabled, ready: config.enabled && errors.length === 0,
    errors, configuredAssetIds: [...config.assetIds], assetIds: assets.map(asset => asset.id), assets,
    styleId: config.styleId, style,
    availableAssetCount: candidates.length, selectedAssetCount: assets.length,
    generationMode: 'agent-assets-timeline', workflowPrompt, stylePrompt, userPrompt,
    additionalAssetGeneration: structuredClone(generationCapabilities ?? getMcpGenerationCapabilities()),
    effectivePrompt: [workflowPrompt, stylePrompt && `默认视觉风格\n${stylePrompt}`, userPrompt.trim() && `用户额外创作要求\n${userPrompt}`].filter(Boolean).join('\n\n'),
    prompt: userPrompt,
    instructions: [
      '先读取当前工程的素材二创要求；只有 ready=true 时可以生成，配置由用户在 MCP 设置中修改。',
      '使用 effectivePrompt；它按默认代码生成流程、所选风格提示词和用户额外要求合并。userPrompt 只是追加要求，不替代 workflowPrompt 或 stylePrompt。查看元数据、联系表或关键帧后自行规划素材顺序、截取范围、标题、说明与节奏。',
      '既有视觉素材只使用本要求中的选择，压缩替换时使用当前工作副本标识；按 additionalAssetGeneration 策略新生成的补充图片和音乐可以加入创作，但不得借此读取未选中的既有视觉素材。配乐也可引用当前工程音频。',
      '仅有补充图片或音乐的需求时才生成：先检查对应能力，状态未知则调用 open_media_ai_status({probeRuntime:true})。selectedModelId 已列入 readyModelIds 时默认通过对应 MCP 工具使用用户所选模型；不得改用其他已下载模型，配音同样只允许用户所选音色。用户所选模型不可用才由 Agent 自行生成，用户明确要求 Agent 自制可覆盖默认策略。忙碌须等待，检查或生成失败须说明原因，不自动下载或修复。',
      '补充素材的 MCP 生成使用 destination=assets 或 timeline，背景音乐使用 instrumental:true；生成完成后才能使用返回素材。Agent 自行生成的媒体通过上传或直链导入加入当前工程。',
      '所有风格均先生成可复用图片、透明图层或独立透明／绿幕图效素材，再分层放置到当前工程；底图在前、主内容在中间、装饰与标题在后，zIndex 越大越靠上。不得用整片预渲染或近似预设替代所选风格，最终成片由编辑器完成。',
      '生成操作返回异步任务，请查询任务进度和最终 assetId；用取帧或区间预览检查结果，并使用当前 projectId/revision 防止操作旧工程。',
    ],
    workflow: {
      codeExecution: 'external-agent', finalComposition: 'editor-timeline', trackOrder: 'back-to-front', zIndex: 'array-index',
      assetOutputs: ['image', 'transparent-image', 'effect-video', 'green-screen-effect'],
      presetGenerationTool: null,
      capabilityTools: ['open_media_ai_status'],
      generationTools: ['open_media_image_generate', 'open_media_music_generate'],
      sourceTools: ['open_media_asset_read'],
      importTools: ['open_media_asset_upload', 'open_media_asset_import_url'],
      inspectionTools: ['open_media_asset_probe', 'open_media_asset_storyboard', 'open_media_asset_get_frame'],
      editingTools: ['open_media_track_add', 'open_media_track_reorder', 'open_media_clip_add', 'open_media_clip_update', 'open_media_clip_keyframes_set', 'open_media_clip_crop', 'open_media_text_add', 'open_media_title_add', 'open_media_transition_add', 'open_media_audio_ducking', 'open_media_timeline_batch_edit'],
      validationTools: ['open_media_timeline_get_frame', 'open_media_preview_render', 'open_media_export_validate'],
      exportTools: ['open_media_export_start'],
      jobTools: ['open_media_job_get', 'open_media_job_cancel'],
    },
  }
}

/** Scope validation for the independent local preset compositor; not an MCP entry point. */
export function assertMcpMotionRequest<T extends object>(project: Project, args: T): T & { styleId: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('素材二创请求格式无效。')
  const brief = getMcpMotionBrief(project)
  if (!brief.ready) throw new Error(`素材二创尚未就绪：${brief.errors.join(' ')}`)
  const input = args as Record<string, unknown>
  if (input.styleId !== undefined && input.styleId !== brief.styleId) throw new Error('请求风格与用户在 MCP 设置中选择的风格不一致。')
  if (!MOTION_STYLES.find(style => style.id === brief.styleId)?.presetSupported) throw new Error(`“${brief.style?.name ?? brief.styleId}”需要外部 Agent 根据默认提示词生成分层素材，不支持内置二维预设。请读取 open_media_motion_brief_get，通过 open_media_asset_upload 或 open_media_asset_import_url 回传图片与独立图效，再由编辑器合成。`)
  if (!Array.isArray(input.scenes) || !input.scenes.length || input.scenes.length > MAX_MCP_PRESET_SCENES) throw new Error('内置快捷合成每次支持 1 至 16 个分镜；此限制不影响工程素材选择。')
  const selected = new Set(brief.assetIds), byId = new Map(project.assets.map(asset => [asset.id, asset])), resolve = videoWorkingCopyResolver(project)
  const assertVisual = (id: unknown, label: string) => {
    const asset = typeof id === 'string' ? byId.get(id) : undefined
    if (!asset || !['image', 'video'].includes(asset.kind) || asset.libraryRole !== undefined || !selected.has(resolve(asset).id)) throw new Error(`${label}必须使用用户已选的当前工程视觉素材。`)
    return asset
  }
  input.scenes.forEach((scene, index) => {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error(`第 ${index + 1} 个分镜格式无效。`)
    assertVisual((scene as Record<string, unknown>).assetId, `第 ${index + 1} 个分镜`)
  })
  if (input.logoAssetId !== undefined && assertVisual(input.logoAssetId, '品牌图片').kind !== 'image') throw new Error('品牌图片需选择已选素材中的图片。')
  if (input.musicAssetId !== undefined) {
    const music = typeof input.musicAssetId === 'string' ? byId.get(input.musicAssetId) : undefined
    if (music?.kind !== 'audio') throw new Error('配乐需使用当前工程中的音频素材。')
  }
  return { ...args, styleId: brief.styleId }
}
