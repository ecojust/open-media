import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import { createProject, validateProject } from '../src/core/project.ts'
import { removeAsset } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'
import { saveProject, loadProject } from '../src/core/storage.ts'
import { MOTION_STYLES } from '../src/core/motion-style-catalog.ts'
import { normalizeMcpMotion, getMcpMotionBrief, assertMcpMotionRequest } from '../src/core/mcp-motion.ts'

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
  assert.equal(validateProject(JSON.parse(JSON.stringify(project))).mcpMotion, undefined)
  project.mcpMotion = { enabled: true, assetIds: [], styleId: '' }
  const persisted = validateProject(project, { trusted: true }), brief = getMcpMotionBrief(persisted)
  assert.deepEqual(persisted.mcpMotion, project.mcpMotion)
  assert(brief.errors.some(error => error.includes('选择当前工程')))
  assert(brief.errors.some(error => error.includes('选择一种')))
  assert.equal(brief.ready, false)
  assert.throws(() => assertMcpMotionRequest(persisted, { scenes: [{ assetId: 'fake' }] }), /未就绪/)
})

test('配置严格验证格式、16个唯一标识和15种风格，即使禁用也拒绝损坏字段', () => {
  const { project } = fixture()
  for (const style of MOTION_STYLES) {
    project.mcpMotion.styleId = style.id
    assert.equal(validateProject(project, { trusted: true }).mcpMotion.styleId, style.id)
  }
  assert.equal(MOTION_STYLES.length, 15)
  for (const config of [null, [], 'on', { enabled: 'yes' }, { enabled: null }, { assetIds: null }, { styleId: null },
    { styleId: 'unknown' }, { assetIds: ['selected', 'selected'] }, { assetIds: ['../file'] }, { assetIds: [42] },
    { assetIds: Array.from({ length: 17 }, (_, i) => `asset-${i}`) }, { prompt: '\0' }, { prompt: 'x'.repeat(4001) },
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
  assert.equal(brief.workflow.generationTool, 'open_media_motion_clip_generate')
  assert(brief.instructions.some(instruction => instruction.includes('自行规划')))
  assert(brief.workflow.editingTools.includes('open_media_clip_add'))
  const toolNames = new Set(JSON.parse(readFileSync(new URL('../src/mcp-tools.json', import.meta.url), 'utf8')).map(tool => tool.name))
  for (const names of Object.values(brief.workflow)) for (const name of Array.isArray(names) ? names : [names]) assert(toolNames.has(name), `workflow tool exists: ${name}`)
  for (const asset of brief.assets) for (const key of ['url', 'sourceUrl', 'nativePath']) assert.equal(key in asset, false)
  assert.doesNotMatch(JSON.stringify(brief), /private\/media|asset:\/\//)
  brief.assets[0].name = 'mutated'; brief.assetIds.push('other'); brief.style.palette.accent = '#000000'; brief.style.tags.push('mutated')
  assert.deepEqual(project, original)
  assert.notEqual(getMcpMotionBrief(project).style.palette.accent, '#000000')
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

test('本地草稿、JSON校验和便携项目保存导入均保留配置与文本，新的工程仍默认禁用', async () => {
  globalThis.indexedDB = new IDBFactory()
  const project = createProject('持久化二创要求'), blob = new Blob(['image-fixture'], { type: 'image/png' })
  const source = { id: 'photo', name: '用户图片.png', kind: 'image', url: URL.createObjectURL(blob), nativePath: '/private/original.png', width: 320, height: 180, duration: 0, size: blob.size, mime: blob.type }
  project.assets.push(source)
  project.mcpMotion = { enabled: true, assetIds: ['photo'], styleId: 'tech-hud', prompt: '产品 A \n保持留白 ' }
  try {
    const blobs = new Map([[source.id, blob]])
    await saveProject(project, blobs)
    const restored = await loadProject(project.id)
    try {
      assert.deepEqual(restored.project.mcpMotion, project.mcpMotion)
      assert.equal(getMcpMotionBrief(restored.project).ready, true)
      const exported = await exportProjectFile(restored.project, { blobs: restored.blobs })
      const imported = await importProjectFile(exported)
      try {
        assert.deepEqual(imported.project.mcpMotion, project.mcpMotion)
        assert.equal(getMcpMotionBrief(imported.project).ready, true)
        assert.equal(imported.project.assets[0].nativePath, undefined)
        assert.deepEqual(validateProject(JSON.parse(JSON.stringify(imported.project))).mcpMotion, project.mcpMotion)
      } finally { imported.revoke() }
    } finally { restored.revoke() }
    assert.equal(getMcpMotionBrief(createProject('新工程')).enabled, false)
  } finally { URL.revokeObjectURL(source.url) }
})
