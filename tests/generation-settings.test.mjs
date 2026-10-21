import assert from 'node:assert/strict'
import test from 'node:test'

async function settings(entries = {}, failure = false) {
  const data = new Map(Object.entries(entries))
  globalThis.localStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { if (failure) throw new Error('Storage unavailable'); data.set(key, value) },
  }
  const module = await import(`../src/core/generation-settings.ts?case=${crypto.randomUUID()}`)
  return { ...module, data }
}

test('generation choices exist independently of workspaces and installed model order', async () => {
  const state = await settings()
  assert.equal(state.getGenerationModel('image'), 'z-image-turbo')
  assert.equal(state.getGenerationModel('music'), 'ace-step-1.5-turbo')
  assert.equal(state.getGenerationModel('video'), 'h3-base-fl2va')
  assert.equal(state.resolveMcpGenerationModel('image'), 'z-image-turbo')
  assert.throws(() => state.resolveMcpGenerationModel('image', 'qwen-image'), /只能使用用户当前选择/)
})

test('existing workspace model selections are available before those workspaces open', async () => {
  const state = await settings({
    'open-media:ai-image-draft:v1': JSON.stringify({ modelId: 'qwen-image' }),
    'open-media:ai-music-draft:v1': JSON.stringify({ modelId: 'ace-step-1.5-sft' }),
    'open-media:video-generation-draft:v1': JSON.stringify({ modelId: 'h3-base-ref2va' }),
  })
  assert.equal(state.getGenerationModel('image'), 'qwen-image')
  assert.equal(state.getGenerationModel('music'), 'ace-step-1.5-sft')
  assert.equal(state.getGenerationModel('video'), 'h3-base-ref2va')
})

test('selection updates synchronously, persists immediately and supersedes stale drafts', async () => {
  const state = await settings({ 'open-media:ai-image-draft:v1': JSON.stringify({ modelId: 'qwen-image' }) })
  const observed = []
  const stop = state.subscribeGenerationModels(models => { observed.push(models); models.image = 'tampered' })
  state.setGenerationModel('image', 'z-image-turbo')
  assert.equal(state.getGenerationModel('image'), 'z-image-turbo')
  assert.equal(observed.length, 1)
  state.setGenerationModel('image', 'z-image-turbo')
  assert.equal(observed.length, 1)
  assert.equal(JSON.parse(state.data.get('open-media:generation-models:v1')).image, 'z-image-turbo')
  stop()
  state.setGenerationModel('music', 'ace-step-1.5-sft')
  assert.equal(observed.length, 1)
  const restored = await settings(Object.fromEntries(state.data))
  assert.equal(restored.getGenerationModel('image'), 'z-image-turbo')
  assert.equal(restored.getGenerationModel('music'), 'ace-step-1.5-sft')
})

test('an unavailable saved model remains selected, without falling back to another model', async () => {
  const state = await settings({ 'open-media:generation-models:v1': JSON.stringify({ image: 'unavailable-model' }) })
  assert.equal(state.getGenerationModel('image'), 'unavailable-model')
  assert.equal(state.resolveMcpGenerationModel('image'), 'unavailable-model')
  assert.throws(() => state.resolveMcpGenerationModel('image', 'z-image-turbo'), /只能使用用户当前选择/)
})

test('MCP cannot override selections and a changed selection invalidates pending requests', async () => {
  const state = await settings()
  const requested = state.resolveMcpGenerationModel('video')
  state.assertMcpGenerationModel('video', requested)
  state.setGenerationModel('video', 'h3-base-ref2va')
  assert.throws(() => state.assertMcpGenerationModel('video', requested), /只能使用用户当前选择/)
  assert.equal(state.resolveMcpGenerationModel('video', 'h3-base-ref2va'), 'h3-base-ref2va')
  for (const invalid of ['', null, {}, 3]) assert.throws(() => state.resolveMcpGenerationModel('video', invalid), /只能使用用户当前选择/)
  state.setGenerationModel('image', '')
  assert.throws(() => state.resolveMcpGenerationModel('image'), /尚未选择/)
})

test('invalid storage is ignored while session choices still work when storage cannot write', async () => {
  const state = await settings({
    'open-media:generation-models:v1': 'invalid json',
    'open-media:ai-image-draft:v1': JSON.stringify({ modelId: 'invalid\u0000model' }),
  }, true)
  assert.equal(state.getGenerationModel('image'), 'z-image-turbo')
  state.setGenerationModel('image', 'qwen-image')
  assert.equal(state.resolveMcpGenerationModel('image'), 'qwen-image')
  assert.throws(() => state.setGenerationModel('image', ' bad-model'), /标识无效/)
  assert.throws(() => state.getGenerationModel('speech'), /类别无效/)
})
