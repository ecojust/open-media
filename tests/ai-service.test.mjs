import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const nativeUrl = new URL('../src/native-ai.ts', import.meta.url).href
const endpoints = ['beginAiGeneration', 'cancelAiJob', 'cancelAiModelDownload', 'downloadAiModel', 'getAiStatus', 'repairAiModel']
registerHooks({ load(url, context, next) {
  if (url !== nativeUrl) return next(url, context)
  return { format: 'module', shortCircuit: true, source: endpoints.map(name => `export const ${name} = (...args) => globalThis.__aiServiceIo.${name}(...args)`).join('\n') }
} })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const empty = () => ({ models: [], jobs: [], busy: false })
const job = () => ({ id: 'image:request', provider: 'image', modelId: 'qwen-image', kind: 'generation', state: 'running', stage: '等待生成', startedAt: 1, elapsedSeconds: 0, assets: [], cancelable: true })
const request = { provider: 'image', request: { requestId: 'request', modelId: 'qwen-image', prompt: '植物与阳光' } }
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)) } throw Error('condition did not settle') }
let sequence = 0
async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = { status: empty(), reads: 0, io: {} }
  f.io = {
    async getAiStatus() { f.reads++; return structuredClone(f.status) },
    async beginAiGeneration() { f.status = { ...empty(), busy: true, jobs: [job()] }; return job() },
    async downloadAiModel() { return empty() }, async repairAiModel() { return empty() },
    async cancelAiModelDownload() { return empty() }, async cancelAiJob() { f.status = empty() },
  }
  globalThis.__aiServiceIo = Object.fromEntries(endpoints.map(name => [name, (...args) => f.io[name](...args)]))
  f.service = await import(`../src/core/ai-service.ts?race=${++sequence}`)
  return f
}

test('pending native submission is globally busy before it has a registered job', async t => {
  const f = await fixture(t), start = deferred()
  f.io.beginAiGeneration = () => start.promise
  const generating = f.service.generateAi(request)
  assert.equal(f.service.aiState.value.busy, true)
  assert.equal(f.service.aiState.value.jobs.length, 0)
  // A concurrent metadata poll cannot make a still-pending submission closable.
  await f.service.refreshAi()
  assert.equal(f.service.aiState.value.busy, true)
  f.status = { ...empty(), busy: true, jobs: [job()] }
  start.resolve(job())
  await generating
  assert.equal(f.service.aiState.value.jobs[0].id, 'image:request')
  assert.equal(f.service.aiState.value.busy, true)
})

test('late download snapshots cannot erase newer jobs and polling survives closing the center', async t => {
  const f = await fixture(t), downloading = deferred()
  f.io.downloadAiModel = () => downloading.promise
  const release = f.service.observeAi()
  await f.service.refreshAi()
  const install = f.service.installAiModel('qwen-image', true)
  release()
  await f.service.generateAi(request)
  // The download IPC response was produced before generation registered its job.
  downloading.resolve(empty())
  await install
  assert.equal(f.service.aiState.value.jobs[0].id, 'image:request')
  assert.equal(f.service.aiState.value.busy, true)
  const reads = f.reads
  f.status = { ...empty(), jobs: [{ ...job(), state: 'completed', cancelable: false }] }
  t.mock.timers.tick(1000)
  await until(() => f.reads > reads && !f.service.aiState.value.busy)
  assert.equal(f.service.aiState.value.jobs[0].state, 'completed')
  const settledReads = f.reads
  t.mock.timers.tick(4000)
  assert.equal(f.reads, settledReads, 'idle service without observers stops polling')
})

test('an older in-flight poll drains before refreshing a completed mutation', async t => {
  const f = await fixture(t), oldRead = deferred()
  let initial = true
  f.io.getAiStatus = async () => { f.reads++; if (initial) { initial = false; return oldRead.promise } return structuredClone(f.status) }
  const polling = f.service.refreshAi()
  const generating = f.service.generateAi(request)
  await until(() => f.service.aiState.value.jobs.length === 1)
  oldRead.resolve(empty())
  await Promise.all([polling, generating])
  assert.equal(f.reads, 2)
  assert.equal(f.service.aiState.value.jobs[0].id, 'image:request')
  assert.equal(f.service.aiState.value.busy, true)
})

test('failed post-mutation status checks keep polling without an open workspace', async t => {
  const f = await fixture(t)
  let unavailable = true
  f.io.getAiStatus = async () => { f.reads++; if (unavailable) throw Error('temporary IPC outage'); return structuredClone(f.status) }
  await f.service.installAiModel('qwen-image', true)
  assert.match(f.service.aiServiceError.value, /temporary IPC outage/)
  const reads = f.reads
  unavailable = false
  t.mock.timers.tick(1000)
  await until(() => f.reads > reads && !f.service.aiServiceError.value)
  assert.equal(f.service.aiState.value.busy, false)
})

test('rejected submissions release the global pending state and retain the action error', async t => {
  const f = await fixture(t)
  f.io.beginAiGeneration = async () => { throw Error('model is not installed') }
  await assert.rejects(f.service.generateAi(request), /model is not installed/)
  assert.equal(f.service.aiState.value.busy, false)
  assert.match(f.service.aiServiceError.value, /model is not installed/)
})

test('speech download, cancellation and repair route through the shared model service and refresh authoritative status', async t => {
  const f = await fixture(t), calls = []
  const model = { id: 'speech:f5-v1-base-fp32', provider: 'speech', state: 'not-downloaded' }
  f.status.models = [model]
  f.io.downloadAiModel = async (id, accepted) => { calls.push(['download', id, accepted]); f.status.models[0].state = 'downloading'; return structuredClone(f.status) }
  f.io.cancelAiModelDownload = async id => { calls.push(['cancel', id]); f.status.models[0].state = 'not-downloaded'; return structuredClone(f.status) }
  f.io.repairAiModel = async (id, accepted) => { calls.push(['repair', id, accepted]); f.status.models[0].state = 'verifying'; return structuredClone(f.status) }
  await f.service.installAiModel(model.id, true)
  assert.equal(f.service.aiState.value.models[0].state, 'downloading')
  await f.service.stopAiModelDownload(model.id)
  assert.equal(f.service.aiState.value.models[0].state, 'not-downloaded')
  await f.service.updateAiModel(model.id, true)
  assert.equal(f.service.aiState.value.models[0].state, 'verifying')
  assert.deepEqual(calls, [['download', model.id, true], ['cancel', model.id], ['repair', model.id, true]])
})

test('a failed speech model download remains visible after catalog refresh and can be retried', async t => {
  const f = await fixture(t)
  f.io.downloadAiModel = async () => { throw Error('网络不可用') }
  await assert.rejects(f.service.installAiModel('speech:f5-v1-base-fp32', false), /网络不可用/)
  assert.match(f.service.aiServiceError.value, /网络不可用/)
  assert.equal(f.service.aiState.value.busy, false)
  f.io.downloadAiModel = async () => empty()
  await f.service.installAiModel('speech:f5-v1-base-fp32', false)
  assert.equal(f.service.aiServiceError.value, '')
})
