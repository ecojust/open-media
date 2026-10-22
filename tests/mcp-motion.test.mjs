import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import { createProject, validateProject } from '../src/core/project.ts'
import { removeAsset } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'
import { saveProject, loadProject } from '../src/core/storage.ts'
import { MOTION_STYLES } from '../src/core/motion-style-catalog.ts'
import { setGenerationModel } from '../src/core/generation-settings.ts'
import { getMcpGenerationCapabilities } from '../src/core/mcp-generation-capabilities.ts'
import { normalizeMcpMotion, getMcpMotionBrief, mcpMotionAssets, assertMcpMotionRequest, publicMotionStyle } from '../src/core/mcp-motion.ts'

beforeEach(() => { setGenerationModel('image', 'ready-image'); setGenerationModel('music', 'ready-music') })

function fixture() {
  const project = createProject('素材二创测试')
  const video = (id, patch = {}) => ({ id, name: `${id}.mp4`, kind: 'video', url: `asset://localhost/media/${id}.mp4`, nativePath: `/private/media/${id}.mp4`,
    duration: 12, width: 1280, height: 720, size: 100, mime: 'video/mp4', ...patch })
  project.assets = [video('selected'), video('other'), video('logo', { kind: 'image', mime: 'image/png', duration: 0 }), video('music', { kind: 'audio', width: 0, height: 0, mime: 'audio/wav' })]
  project.mcpMotion = { enabled: true, assetIds: ['selected', 'logo'], styleId: 'flat-pop', prompt: '产品介绍，保持简洁。' }
  return { project, video }
}

test('旧工程默认禁用，不添写设置；未完成的用户配置允许保存但明确未就绪', () => {
  const project = createProject()
  assert.equal(project.mcpMotion, undefined)
  assert.deepEqual(normalizeMcpMotion(), { enabled: false, assetIds: [], styleId: '' })
  assert.equal(getMcpMotionBrief(project).ready, false)
  assert.equal(getMcpMotionBrief(project).enabled, false)
  assert.equal(getMcpMotionBrief(project).workflow.presetGenerationTool, null)
  assert.equal(validateProject(JSON.parse(JSON.stringify(project))).mcpMotion, undefined)
  project.mcpMotion = { enabled: true, assetIds: [], styleId: '' }
  const persisted = validateProject(project, { trusted: true }), brief = getMcpMotionBrief(persisted)
  assert.deepEqual(persisted.mcpMotion, project.mcpMotion)
  assert(brief.errors.some(error => error.includes('选择当前工程')))
  assert(brief.errors.some(error => error.includes('选择一种')))
  assert.equal(brief.ready, false)
  assert.throws(() => assertMcpMotionRequest(persisted, { scenes: [{ assetId: 'fake' }] }), /未就绪/)
})

test('配置严格验证唯一标识和25种风格，不按固定数量截断素材选择，即使禁用也拒绝损坏字段', () => {
  const { project } = fixture()
  for (const style of MOTION_STYLES) {
    project.mcpMotion.styleId = style.id
    assert.equal(validateProject(project, { trusted: true }).mcpMotion.styleId, style.id)
  }
  assert.equal(MOTION_STYLES.length, 25)
  for (const config of [null, [], 'on', { enabled: 'yes' }, { enabled: null }, { assetIds: null }, { styleId: null },
    { styleId: 'unknown' }, { assetIds: ['selected', 'selected'] }, { assetIds: ['../file'] }, { assetIds: [42] },
    { prompt: '\0' }, { prompt: 'x'.repeat(4001) },
    { prompt: {} }, { enabled: false, token: 'unexpected' }]) {
    assert.throws(() => normalizeMcpMotion(config), /素材二创/)
    assert.throws(() => validateProject({ ...project, mcpMotion: config }, { trusted: true }), /素材二创/)
  }
  const input = { enabled: true, assetIds: ['selected'], styleId: 'flat-pop', prompt: '英文 words \n下一行 ' }
  const normalized = normalizeMcpMotion(input)
  assert.equal(normalized.prompt, input.prompt, '自动保存不得吞掉正在输入的空格与换行')
  normalized.assetIds.push('other')
  assert.deepEqual(input.assetIds, ['selected'])
})

test('brief只返回当前所选视觉素材的公开元数据和可执行工作流，返回值与工程隔离', () => {
  const { project } = fixture(), original = structuredClone(project)
  const brief = getMcpMotionBrief(project)
  assert.equal(brief.ready, true)
  assert.deepEqual(brief.assetIds, ['selected', 'logo'])
  assert.deepEqual(brief.configuredAssetIds, project.mcpMotion.assetIds)
  assert.equal(brief.style.id, 'flat-pop')
  assert.equal(brief.prompt, project.mcpMotion.prompt)
  assert.equal(brief.workflow.codeExecution, 'external-agent')
  assert.equal(brief.workflow.presetGenerationTool, null)
  assert(brief.instructions.some(instruction => instruction.includes('自行规划')))
  assert(brief.workflow.editingTools.includes('open_media_clip_add'))
  const toolNames = new Set(JSON.parse(readFileSync(new URL('../src/mcp-tools.json', import.meta.url), 'utf8')).map(tool => tool.name))
  for (const [key, names] of Object.entries(brief.workflow)) {
    if (!key.endsWith('Tools') || names === null) continue
    for (const name of Array.isArray(names) ? names : [names]) assert(toolNames.has(name), `workflow tool exists: ${name}`)
  }
  for (const asset of brief.assets) for (const key of ['url', 'sourceUrl', 'nativePath']) assert.equal(key in asset, false)
  assert.doesNotMatch(JSON.stringify(brief), /private\/media|asset:\/\//)
  brief.assets[0].name = 'mutated'; brief.assetIds.push('other'); brief.style.palette.accent = '#000000'; brief.style.tags.push('mutated')
  assert.deepEqual(project, original)
  assert.notEqual(getMcpMotionBrief(project).style.palette.accent, '#000000')
})

test('所有风格采用分层任务，独立本地预设校验不静默替换不支持的风格', () => {
  const { project } = fixture()
  const presets = MOTION_STYLES.filter(style => style.presetSupported)
  const codeStyles = MOTION_STYLES.filter(style => !style.presetSupported)
  assert.equal(presets.length, 15)
  assert.equal(codeStyles.length, 10)
  for (const style of MOTION_STYLES) {
    project.mcpMotion.styleId = style.id
    const before = structuredClone(project), brief = getMcpMotionBrief(project)
    assert.equal(brief.ready, true)
    assert.equal('presetSupported' in brief.style, false)
    assert.equal(brief.workflow.presetGenerationTool, null)
    const args = { scenes: [{ assetId: 'selected' }] }
    if (style.presetSupported) assert.equal(assertMcpMotionRequest(project, args).styleId, style.id)
    else {
      assert(brief.instructions.some(instruction => instruction.includes('不得用整片预渲染或近似预设替代')))
      assert(brief.effectivePrompt.includes(style.prompt))
      for (const input of [args, { ...args, styleId: style.id }]) {
        assert.throws(() => assertMcpMotionRequest(project, input), /外部 Agent.*不支持内置二维预设.*open_media_asset_upload.*open_media_asset_import_url/)
      }
      assert.throws(() => assertMcpMotionRequest(project, { ...args, styleId: presets[0].id }), /风格.*不一致/)
    }
    assert.deepEqual(project, before)
  }
})

test('生成必须已启用并沿用所选风格与视觉素材，logo限制图片，音乐仅来自当前工程音频', () => {
  const { project } = fixture(), before = structuredClone(project)
  const args = { scenes: [{ assetId: 'selected', heading: '主画面' }], logoAssetId: 'logo', musicAssetId: 'music' }
  assert.equal(assertMcpMotionRequest(project, args).styleId, 'flat-pop')
  assert.equal('styleId' in args, false)
  assert.deepEqual(project, before)
  for (const [patch, expected] of [
    [{ styleId: 'tech-hud' }, /风格.*不一致/],
    [{ scenes: [{ assetId: 'other' }] }, /用户已选/],
    [{ scenes: [{ assetId: 'missing' }] }, /用户已选/],
    [{ scenes: [{ assetId: 'music' }] }, /用户已选/],
    [{ scenes: [] }, /1 至 16/],
    [{ scenes: [null] }, /分镜格式/],
    [{ logoAssetId: 'other' }, /用户已选/],
    [{ logoAssetId: 'selected' }, /品牌图片/],
    [{ musicAssetId: 'selected' }, /当前工程.*音频/],
    [{ musicAssetId: 'missing' }, /当前工程.*音频/],
  ]) assert.throws(() => assertMcpMotionRequest(project, { ...args, ...patch }), expected)
  project.mcpMotion.enabled = false
  assert.throws(() => assertMcpMotionRequest(project, { ...args, mcpMotion: before.mcpMotion }), /用户.*开启/)
  assert.equal(project.mcpMotion.enabled, false, '调用参数不能重新开启用户授权')
})

test('原件、历史与当前压缩副本属于同一视觉授权，并且brief使用当前工作副本', () => {
  const { project, video } = fixture()
  project.assets.push(video('old-copy', { compression: { originalAssetId: 'selected', mode: 'quality', quality: 'high', createdAt: '2026-10-21T00:00:00.000Z', active: false } }),
    video('active-copy', { compression: { originalAssetId: 'selected', mode: 'quality', quality: 'high', createdAt: '2026-10-21T01:00:00.000Z', active: true } }))
  for (const chosen of ['selected', 'old-copy', 'active-copy']) {
    project.mcpMotion.assetIds = [chosen]
    const clean = validateProject(project, { trusted: true }), brief = getMcpMotionBrief(clean)
    assert.equal(brief.ready, true)
    assert.deepEqual(brief.assetIds, ['active-copy'])
    assert.equal(brief.assets[0].selectedAssetId, chosen)
    for (const requested of ['selected', 'old-copy', 'active-copy']) assert.doesNotThrow(() => assertMcpMotionRequest(clean, { scenes: [{ assetId: requested }] }))
  }
  project.assets.find(asset => asset.id === 'active-copy').compression.active = false
  assert.deepEqual(getMcpMotionBrief(validateProject(project, { trusted: true })).assetIds, ['selected'])
})

test('移除选中素材保留用户配置并显示未就绪，不能悄悄换用其它素材', () => {
  const { project } = fixture()
  const removed = removeAsset(project, 'selected')
  assert.deepEqual(removed.mcpMotion, project.mcpMotion)
  const brief = getMcpMotionBrief(removed)
  assert.equal(brief.ready, false)
  assert(brief.errors.some(error => /selected.*移除/.test(error)))
  assert.deepEqual(brief.assetIds, ['logo'])
  assert.throws(() => assertMcpMotionRequest(removed, { scenes: [{ assetId: 'logo' }] }), /未就绪/)
  for (const id of ['music', 'builtin']) {
    const modified = structuredClone(project)
    modified.assets.push({ ...modified.assets[2], id: 'builtin', libraryRole: 'watermark' })
    modified.mcpMotion.assetIds = [id]
    assert.doesNotThrow(() => validateProject(modified, { trusted: true }))
    assert.equal(getMcpMotionBrief(modified).ready, false)
    assert.match(getMcpMotionBrief(modified).errors.join(' '), /不是可用于二创/)
  }
})

test('本地草稿、JSON校验和便携项目保存导入均保留代码专用风格与文本，新的工程仍默认禁用', async () => {
  globalThis.indexedDB = new IDBFactory()
  const project = createProject('持久化二创要求'), blob = new Blob(['image-fixture'], { type: 'image/png' })
  const source = { id: 'photo', name: '用户图片.png', kind: 'image', url: URL.createObjectURL(blob), nativePath: '/private/original.png', width: 320, height: 180, duration: 0, size: blob.size, mime: blob.type }
  project.assets.push(source)
  project.mcpMotion = { enabled: true, assetIds: ['photo'], styleId: MOTION_STYLES.find(style => !style.presetSupported).id, prompt: '产品 A \n保持留白 ' }
  try {
    const blobs = new Map([[source.id, blob]])
    await saveProject(project, blobs)
    const restored = await loadProject(project.id)
    try {
      assert.deepEqual(restored.project.mcpMotion, project.mcpMotion)
      assert.equal(getMcpMotionBrief(restored.project).ready, true)
      assert.equal(getMcpMotionBrief(restored.project).workflow.presetGenerationTool, null)
      const exported = await exportProjectFile(restored.project, { blobs: restored.blobs })
      const imported = await importProjectFile(exported)
      try {
        assert.deepEqual(imported.project.mcpMotion, project.mcpMotion)
        assert.equal(getMcpMotionBrief(imported.project).ready, true)
        assert.equal('presetSupported' in getMcpMotionBrief(imported.project).style, false)
        assert.equal(imported.project.assets[0].nativePath, undefined)
        assert.deepEqual(validateProject(JSON.parse(JSON.stringify(imported.project))).mcpMotion, project.mcpMotion)
      } finally { imported.revoke() }
    } finally { restored.revoke() }
    assert.equal(getMcpMotionBrief(createProject('新工程')).enabled, false)
  } finally { URL.revokeObjectURL(source.url) }
})


test('每种风格都有独立素材分层方案，额外要求为空也完整，切换风格保留用户文本', () => {
  const { project } = fixture()
  const userText = '标题保持中文\n只做 8 秒，最后一秒留白  '
  project.mcpMotion.prompt = userText
  const prompts = new Set()
  for (const style of MOTION_STYLES) {
    project.mcpMotion.styleId = style.id
    const brief = getMcpMotionBrief(project)
    assert.equal(brief.generationMode, 'agent-assets-timeline')
    assert.equal(brief.workflow.finalComposition, 'editor-timeline')
    assert.equal(brief.workflow.trackOrder, 'back-to-front')
    assert.equal(brief.workflow.zIndex, 'array-index')
    assert.equal(brief.workflow.presetGenerationTool, null)
    assert.deepEqual(brief.workflow.assetOutputs, ['image', 'transparent-image', 'effect-video', 'green-screen-effect'])
    assert.equal(brief.stylePrompt, style.prompt)
    assert.equal(brief.userPrompt, userText)
    assert.equal(brief.prompt, userText)
    assert.match(brief.stylePrompt, new RegExp(style.id))
    assert.match(brief.stylePrompt, /素材与轨道方案：/)
    assert.match(brief.stylePrompt, /不能将主内容和装饰一起烘焙成视频/)
    assert.match(brief.stylePrompt, /最终成片由编辑器合成/)
    assert.match(brief.stylePrompt, /zIndex/)
    assert(brief.stylePrompt.length > 250)
    assert(brief.effectivePrompt.indexOf(brief.workflowPrompt) < brief.effectivePrompt.indexOf(brief.stylePrompt))
    assert(brief.effectivePrompt.indexOf(brief.stylePrompt) < brief.effectivePrompt.indexOf(userText))
    assert.match(brief.workflowPrompt, new RegExp(`${project.width} × ${project.height}`))
    for (const phrase of ['renderAt(t)', 'sourceVersion', 'chunkSha256', 'open_media_asset_upload', 'open_media_clip_add', '不执行任意代码', 'open_media_clip_keyframes_set', 'open_media_export_start', 'clip_update.patch', '保留 alpha', '禁止让 Agent 将整段成片', '回传前须栅格化为 PNG']) assert(brief.effectivePrompt.includes(phrase))
    prompts.add(brief.stylePrompt)
  }
  assert.equal(prompts.size, 25)
  project.mcpMotion.prompt = ''
  const brief = getMcpMotionBrief(project)
  assert.equal(brief.userPrompt, '')
  assert(brief.effectivePrompt.includes(brief.stylePrompt))
  assert(brief.effectivePrompt.includes(brief.workflowPrompt))
  assert.doesNotMatch(brief.effectivePrompt, /\n\n用户额外创作要求\n/)
})

test('素材计数按实际视觉候选，与选择列表一致，不把工程总素材数当成可用图片视频数', () => {
  const { project, video } = fixture()
  project.assets = [...Array.from({ length: 11 }, (_, index) => video(`visual-${index}`, index % 2 ? { kind: 'image', duration: 0, mime: 'image/png' } : {})),
    ...Array.from({ length: 5 }, (_, index) => video(`audio-${index}`, { kind: 'audio', width: 0, height: 0, mime: 'audio/wav' }))]
  project.mcpMotion.assetIds = ['visual-0', 'visual-1']
  const brief = getMcpMotionBrief(project)
  assert.equal(project.assets.length, 16)
  assert.equal(mcpMotionAssets(project).length, 11)
  assert.equal(brief.availableAssetCount, 11)
  assert.equal(brief.selectedAssetCount, 2)
  assert.equal('maxAssetCount' in brief, false)
  const copy = video('active-visual', { compression: { originalAssetId: 'visual-0', mode: 'quality', quality: 'high', createdAt: '2026-10-21T00:00:00.000Z', active: true } })
  project.assets.push(copy, video('builtin', { libraryRole: 'watermark' }))
  assert.equal(mcpMotionAssets(project).length, 11)
  assert.deepEqual(getMcpMotionBrief(project).assetIds, ['active-visual', 'visual-1'])
  project.assets = project.assets.filter(asset => asset.id !== 'visual-0')
  project.mcpMotion.assetIds = ['active-visual']
  assert.equal(getMcpMotionBrief(project).ready, false, '选择列表排除的孤立工作副本也不能通过brief授权')
})


test('可选择全部实际视觉素材，超过16个不截断；音频不进入候选，预设单次分镜限制独立', () => {
  const { project, video } = fixture()
  project.assets = [...Array.from({ length: 40 }, (_, index) => video(`visual-${index}`, index % 2 ? { kind: 'image', duration: 0, mime: 'image/png' } : {})),
    ...Array.from({ length: 7 }, (_, index) => video(`audio-${index}`, { kind: 'audio', width: 0, height: 0, mime: 'audio/wav' }))]
  const candidates = mcpMotionAssets(project)
  assert.equal(candidates.length, 40)
  assert(candidates.every(asset => asset.kind === 'image' || asset.kind === 'video'))
  project.mcpMotion.assetIds = candidates.map(asset => asset.id)
  const normalized = normalizeMcpMotion(project.mcpMotion)
  assert.deepEqual(normalized.assetIds, project.mcpMotion.assetIds)
  const restored = validateProject(JSON.parse(JSON.stringify(project)), { trusted: true })
  const brief = getMcpMotionBrief(restored)
  assert.equal(brief.ready, true)
  assert.equal(brief.availableAssetCount, 40)
  assert.equal(brief.selectedAssetCount, 40)
  assert.deepEqual(brief.assetIds, project.mcpMotion.assetIds)
  assert.equal('maxAssetCount' in brief, false)
  assert.doesNotThrow(() => assertMcpMotionRequest(restored, { scenes: [{ assetId: 'visual-39' }] }))
  assert.doesNotThrow(() => assertMcpMotionRequest(restored, { scenes: candidates.slice(0, 16).map(asset => ({ assetId: asset.id })) }))
  assert.throws(() => assertMcpMotionRequest(restored, { scenes: candidates.slice(0, 17).map(asset => ({ assetId: asset.id })) }), /内置快捷合成.*分镜.*不影响工程素材选择/)
  restored.mcpMotion.assetIds.push('audio-0')
  const withAudio = getMcpMotionBrief(restored)
  assert.equal(withAudio.ready, false)
  assert.equal(withAudio.selectedAssetCount, 40)
  assert(withAudio.errors.some(error => error.includes('不是可用于二创')))
})

test('超过16个已选视觉素材完整保存到草稿和便携工程，重新打开不丢选择', async () => {
  globalThis.indexedDB = new IDBFactory()
  const project = createProject('全部素材持久化'), imageBytes = new Blob(['image-fixture'], { type: 'image/png' })
  const imageUrl = URL.createObjectURL(imageBytes), blobs = new Map()
  for (let index = 0; index < 32; index++) {
    const id = `selected-image-${index}`
    project.assets.push({ id, name: `图片 ${index + 1}.png`, kind: 'image', url: imageUrl, width: 320, height: 180, duration: 0, size: imageBytes.size, mime: imageBytes.type })
    blobs.set(id, imageBytes)
  }
  project.mcpMotion = { enabled: true, assetIds: project.assets.map(asset => asset.id), styleId: 'tech-hud', prompt: '使用全部素材，按内容安排镜头。' }
  try {
    await saveProject(project, blobs)
    const restored = await loadProject(project.id)
    try {
      assert.deepEqual(restored.project.mcpMotion, project.mcpMotion)
      assert.equal(getMcpMotionBrief(restored.project).selectedAssetCount, 32)
      const imported = await importProjectFile(await exportProjectFile(restored.project, { blobs: restored.blobs }))
      try {
        assert.deepEqual(imported.project.mcpMotion, project.mcpMotion)
        assert.equal(getMcpMotionBrief(imported.project).ready, true)
        assert.equal(getMcpMotionBrief(imported.project).selectedAssetCount, 32)
        assert.equal(getMcpMotionBrief(imported.project).availableAssetCount, 32)
      } finally { imported.revoke() }
    } finally { restored.revoke() }
  } finally { URL.revokeObjectURL(imageUrl) }
})


test('二创brief区分未查模型与实时能力，补充素材策略按能力传递且不修改工程或调用方状态', () => {
  const { project } = fixture(), original = structuredClone(project)
  const unknown = getMcpMotionBrief(project)
  assert.equal(unknown.ready, true, '额外素材模型未知不阻止读取已配置的二创任务')
  assert.equal(unknown.additionalAssetGeneration.checked, false)
  assert.equal(unknown.additionalAssetGeneration.image.route, 'check-status')
  assert.equal(unknown.additionalAssetGeneration.music.route, 'check-status')
  assert.deepEqual(unknown.additionalAssetGeneration.check, { tool: 'open_media_ai_status', arguments: { probeRuntime: true } })
  const model = provider => ({ id: `ready-${provider}`, name: provider, provider, state: 'ready',
    capabilities: [provider === 'image' ? 'text-to-image' : 'text-to-music'], runtime: { state: 'ready', device: 'cpu' }, hardware: '16 GB' })
  const capabilities = getMcpGenerationCapabilities({ models: [model('image'), model('music')], jobs: [], busy: true })
  const brief = getMcpMotionBrief(project, capabilities)
  assert.equal(brief.additionalAssetGeneration.checked, true)
  assert.equal(brief.additionalAssetGeneration.busy, true)
  assert.equal(brief.additionalAssetGeneration.policy.busy, 'wait')
  assert.equal(brief.additionalAssetGeneration.policy.default, 'local-first')
  assert.equal(brief.additionalAssetGeneration.policy.modelSelection, 'user-selected-only')
  assert.equal(brief.additionalAssetGeneration.image.selectedModelId, 'ready-image')
  assert.equal(brief.additionalAssetGeneration.music.selectedModelId, 'ready-music')
  assert.equal(brief.additionalAssetGeneration.policy.agentOverride, 'explicit-user-request')
  assert.equal(brief.additionalAssetGeneration.image.route, 'mcp')
  assert.equal(brief.additionalAssetGeneration.music.route, 'mcp')
  assert.deepEqual(brief.additionalAssetGeneration.image.readyModelIds, ['ready-image'])
  assert.deepEqual(brief.additionalAssetGeneration.music.readyModelIds, ['ready-music'])
  assert.deepEqual(brief.workflow.capabilityTools, ['open_media_ai_status'])
  assert.deepEqual(brief.workflow.generationTools, ['open_media_image_generate', 'open_media_music_generate'])
  brief.additionalAssetGeneration.image.readyModelIds.push('mutated')
  brief.additionalAssetGeneration.image.models[0].runtime.state = 'mutated'
  brief.additionalAssetGeneration.policy.default = 'mutated'
  assert.deepEqual(capabilities.image.readyModelIds, ['ready-image'])
  assert.equal(capabilities.image.models[0].runtime.state, 'ready')
  assert.equal(capabilities.policy.default, 'local-first')
  assert.deepEqual(project, original)
  const noLocal = getMcpMotionBrief(project, getMcpGenerationCapabilities({ models: [], jobs: [], busy: false }))
  assert.equal(noLocal.additionalAssetGeneration.checked, true)
  assert.equal(noLocal.additionalAssetGeneration.image.route, 'agent')
  assert.equal(noLocal.additionalAssetGeneration.music.route, 'agent')
  assert.equal(noLocal.ready, true)
})

test('默认提示限定按需生成、先查对应能力、本地优先、明确覆盖与真实失败处理，原素材范围不被放开', () => {
  const { project } = fixture()
  project.mcpMotion.prompt = '请 Agent 自行生成背景音乐，使用轻快的原声风格。'
  const brief = getMcpMotionBrief(project)
  assert.equal(brief.userPrompt, project.mcpMotion.prompt)
  for (const phrase of ['只有创作确实需要额外图片或音乐', 'additionalAssetGeneration', 'availability=unknown',
    'open_media_ai_status({probeRuntime:true})', 'readyModelIds', 'open_media_image_generate', 'open_media_music_generate',
    'destination=assets', 'destination=timeline', 'instrumental:true', '用户明确要求 Agent 自行生成',
    '忙碌状态 busy=true 应等待', '不自动下载或修复模型', '不能借补充素材之名读取未选中的既有图片或视频']) {
    assert(brief.workflowPrompt.includes(phrase), phrase)
    assert(brief.effectivePrompt.includes(phrase), phrase)
  }
  assert.deepEqual(brief.assetIds, ['selected', 'logo'])
  assert.equal(brief.workflow.codeExecution, 'external-agent')
  assert.equal(brief.generationMode, 'agent-assets-timeline')
})


test('分层流程只推荐现有工具，绿幕通过片段更新设置，最终使用编辑器导出', () => {
  const { project } = fixture(), brief = getMcpMotionBrief(project)
  const tools = JSON.parse(readFileSync(new URL('../src/mcp-tools.json', import.meta.url), 'utf8'))
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  assert.equal(byName.has('open_media_motion_clip_generate'), false)
  assert(brief.workflow.editingTools.includes('open_media_track_reorder'))
  assert(brief.workflow.editingTools.includes('open_media_clip_keyframes_set'))
  assert(brief.workflow.editingTools.includes('open_media_clip_crop'))
  assert(brief.workflow.editingTools.includes('open_media_title_add'))
  assert.deepEqual(brief.workflow.exportTools, ['open_media_export_start'])
  assert(byName.get('open_media_clip_update').inputSchema.properties.patch.properties.chromaKey)
  assert.match(brief.workflowPrompt, /底图放前面的轨道.*主内容放中间.*装饰图片.*放后面的轨道/)
  assert.match(brief.workflowPrompt, /图片像固定字幕一样设置 start、trimOut、x、y、width、height/)
  assert.match(brief.workflowPrompt, /图效不能包含已选原视频、整段主画面或已混入的字幕与音乐/)
  assert.doesNotMatch(brief.workflowPrompt, /clip_add\.options.*chromaKey/)
})


test('公开风格移除内部预设能力标记，嵌套返回值不影响默认目录', () => {
  const style = MOTION_STYLES.find(style => style.presetSupported)
  const original = structuredClone(style), publicStyle = publicMotionStyle(style)
  assert.equal('presetSupported' in publicStyle, false)
  assert.equal(publicStyle.prompt, style.prompt)
  publicStyle.palette.accent = '#000000'
  publicStyle.tags.push('changed')
  assert.deepEqual(style, original)
})
