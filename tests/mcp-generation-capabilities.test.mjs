import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { getMcpGenerationCapabilities } from '../src/core/mcp-generation-capabilities.ts'
import { setGenerationModel } from '../src/core/generation-settings.ts'
import { publicAiStatus } from '../src/core/mcp-ai-generation.ts'

function model(provider, patch = {}) {
  return {
    id: `${provider}-model`, name: `${provider} model`, provider,
    capabilities: [provider === 'image' ? 'text-to-image' : 'text-to-music'],
    version: '1', state: 'ready', size: 1_000, downloadedBytes: 1_000,
    hardware: '8 GB memory', runtime: { state: 'ready', device: 'auto' },
    bundled: false, requiresLicenseAcceptance: true, ...patch,
  }
}
function status(models, busy = false) { return { models, jobs: [], busy } }

beforeEach(() => { setGenerationModel('image', 'image-model'); setGenerationModel('music', 'music-model') })

test('未查询不能当作没有本地模型，明确先查询能力；真实空目录才转交Agent', () => {
  const unqueried = getMcpGenerationCapabilities()
  assert.equal(unqueried.checked, false)
  assert.equal(unqueried.image.availability, 'unknown')
  assert.equal(unqueried.image.route, 'check-status')
  assert.equal(unqueried.music.route, 'check-status')
  assert.deepEqual(unqueried.check, { tool: 'open_media_ai_status', arguments: { probeRuntime: true } })
  const empty = getMcpGenerationCapabilities(status([]))
  assert.equal(empty.checked, true)
  assert.equal(empty.image.availability, 'unavailable')
  assert.equal(empty.image.route, 'agent')
  assert.equal(empty.music.route, 'agent')
  assert.deepEqual(empty.image.readyModelIds, [])
})

test('各类能力独立判断，模型与运行环境同时ready才优先调用本地工具', () => {
  const readyImage = model('image'), missingMusic = model('music', { state: 'not-downloaded', downloadedBytes: 0 })
  const result = getMcpGenerationCapabilities(status([readyImage, missingMusic]))
  assert.equal(result.image.availability, 'ready')
  assert.equal(result.image.route, 'mcp')
  assert.deepEqual(result.image.readyModelIds, [readyImage.id])
  assert.equal(result.image.tool, 'open_media_image_generate')
  assert.equal(result.music.route, 'agent')
  assert.equal(result.music.tool, 'open_media_music_generate')
  const musicOnly = getMcpGenerationCapabilities(status([model('music')]))
  assert.equal(musicOnly.image.route, 'agent')
  assert.equal(musicOnly.music.route, 'mcp')
})

test('下载字节齐全但未就绪、损坏、升级或不支持的平台都不可用', () => {
  for (const state of ['not-downloaded', 'downloading', 'verifying', 'failed', 'unsupported', 'update-available']) {
    const result = getMcpGenerationCapabilities(status([model('image', { state })]))
    assert.equal(result.image.route, 'agent', state)
    assert.deepEqual(result.image.readyModelIds, [], state)
    assert.ok(result.image.models[0].reason, state)
  }
  const failed = getMcpGenerationCapabilities(status([model('image', { state: 'failed', error: '权重校验失败' })]))
  assert.equal(failed.image.models[0].reason, '权重校验失败')
})

test('权重ready但运行环境未就绪或能力不匹配，不误报可文生图或文生音乐', () => {
  for (const runtimeState of ['not-downloaded', 'unsupported', 'update-available', 'failed', 'checking']) {
    const result = getMcpGenerationCapabilities(status([model('image', { runtime: { state: runtimeState, reason: '运行环境待修复' } })]))
    assert.equal(result.image.route, 'agent', runtimeState)
    assert.equal(result.image.models[0].reason, '运行环境待修复')
  }
  const mismatched = getMcpGenerationCapabilities(status([
    model('image', { capabilities: ['image-to-image'] }),
    model('music', { capabilities: ['lyrics-to-song'] }),
    model('video', { capabilities: ['text-to-image', 'text-to-music'] }),
  ]))
  assert.equal(mismatched.image.route, 'agent')
  assert.equal(mismatched.music.route, 'agent')
  assert.equal(mismatched.image.models.length, 1)
  assert.equal(mismatched.music.models.length, 1)
  assert.equal(mismatched.image.models[0].reason, '模型不支持所需生成能力。')
})

test('任务忙碌不会把已安装能力降级为Agent，用户明确要求Agent时才覆盖本地优先', () => {
  const result = getMcpGenerationCapabilities(status([model('image'), model('music')], true))
  assert.equal(result.busy, true)
  assert.equal(result.image.route, 'mcp')
  assert.equal(result.music.route, 'mcp')
  assert.deepEqual(result.policy, {
    default: 'local-first', modelSelection: 'user-selected-only', selectionChange: 'user-interface-only', agentOverride: 'explicit-user-request', unavailable: 'agent', unknown: 'check-status', busy: 'wait',
  })
})

test('每次按最新状态重算就绪模型，下载后与失效后结果及时改变且不修改原状态', () => {
  const image = model('image', { state: 'not-downloaded' }), snapshot = status([image])
  assert.equal(getMcpGenerationCapabilities(snapshot).image.route, 'agent')
  image.state = 'ready'
  const ready = getMcpGenerationCapabilities(snapshot)
  assert.equal(ready.image.route, 'mcp')
  image.runtime.state = 'update-available'
  assert.equal(getMcpGenerationCapabilities(snapshot).image.route, 'agent')
  assert.equal(ready.image.availability, 'ready')
  ready.image.models[0].runtime.state = 'mutated'
  ready.image.models[0].capabilities.push('text-to-music')
  assert.equal(image.runtime.state, 'update-available')
  assert.deepEqual(image.capabilities, ['text-to-image'])
})

test('公开状态保留任务查询协议并附能力路由，候选模型只投影公开字段', () => {
  const snapshot = status([model('image', { nativePath: '/private/model', runtime: { state: 'ready', device: 'cpu', executablePath: '/private/runtime' } })])
  snapshot.jobs.push({ id: 'job-1', provider: 'image', kind: 'generation', state: 'completed', stage: '已完成', startedAt: 1, elapsedSeconds: 2, cancelable: false,
    assets: [{ id: 'image-1', name: '图像.png', kind: 'image', duration: 0, width: 512, height: 512, size: 100, mime: 'image/png', nativePath: '/private/result.png', url: 'asset://private/result.png' }],
  })
  const result = publicAiStatus(snapshot)
  assert.equal(result.generationCapabilities.image.route, 'mcp')
  assert.deepEqual(result.jobs[0].poll, { tool: 'open_media_ai_job_get', arguments: { id: 'job-1' } })
  assert.equal(result.jobs[0].cancel, null)
  assert.equal(result.jobs[0].assets[0].id, 'image-1')
  assert.equal('url' in result.jobs[0].assets[0], false)
  assert.equal('nativePath' in result.jobs[0].assets[0], false)
  assert.doesNotMatch(JSON.stringify(result.generationCapabilities), /private|executablePath|nativePath/)
})


test('只允许当前选择的模型，多种已下载模型不会扩大 MCP 可用范围', () => {
  const result = getMcpGenerationCapabilities(status([
    model('image'), model('image', { id: 'image-other' }), model('music'), model('music', { id: 'music-other' }),
  ]))
  assert.equal(result.image.selectedModelId, 'image-model')
  assert.equal(result.music.selectedModelId, 'music-model')
  assert.deepEqual(result.image.readyModelIds, ['image-model'])
  assert.deepEqual(result.music.readyModelIds, ['music-model'])
  assert.equal(result.image.models[0].selected, true)
  assert.equal(result.image.models[0].eligible, true)
  assert.equal(result.image.models[1].selected, false)
  assert.equal(result.image.models[1].eligible, false)
  assert.match(result.image.models[1].reason, /未被用户选中/)
})

test('所选模型缺失或未就绪时，不能改用其他已下载模型', () => {
  const alternate = model('image', { id: 'image-other' })
  const missing = getMcpGenerationCapabilities(status([alternate]))
  assert.equal(missing.image.selectedModelId, 'image-model')
  assert.equal(missing.image.availability, 'unavailable')
  assert.deepEqual(missing.image.readyModelIds, [])
  assert.match(missing.image.reason, /不在本地目录/)
  const unavailable = getMcpGenerationCapabilities(status([model('image', { state: 'not-downloaded' }), alternate]))
  assert.equal(unavailable.image.route, 'agent')
  assert.deepEqual(unavailable.image.readyModelIds, [])
  assert.match(unavailable.image.reason, /尚未下载/)
  assert.equal(unavailable.image.models[1].eligible, false)
})

test('用户切换模型后立即重新计算资格，不保留上次选择也不修改已返回快照', () => {
  const snapshot = status([model('image'), model('image', { id: 'image-other' }), model('music')])
  const before = getMcpGenerationCapabilities(snapshot)
  setGenerationModel('image', 'image-other')
  const after = getMcpGenerationCapabilities(snapshot)
  assert.equal(after.image.selectedModelId, 'image-other')
  assert.deepEqual(after.image.readyModelIds, ['image-other'])
  assert.equal(after.image.models[0].eligible, false)
  assert.equal(after.image.models[1].eligible, true)
  assert.deepEqual(after.music.readyModelIds, ['music-model'])
  assert.equal(before.image.selectedModelId, 'image-model')
  assert.deepEqual(before.image.readyModelIds, ['image-model'])
  assert.equal(getMcpGenerationCapabilities().image.selectedModelId, 'image-other')
})


test('尚未选择模型时不能默认选择已下载的第一个模型', () => {
  setGenerationModel('image', '')
  const result = getMcpGenerationCapabilities(status([model('image'), model('image', { id: 'image-other' })]))
  assert.equal(result.image.selectedModelId, '')
  assert.equal(result.image.availability, 'unavailable')
  assert.deepEqual(result.image.readyModelIds, [])
  assert(result.image.models.every(item => !item.selected && !item.eligible))
  assert.match(result.image.reason, /请先在生成页面选择模型/)
})
