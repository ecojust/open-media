import test from 'node:test'
import assert from 'node:assert/strict'
import { createDraftSaveQueue, draftSaveErrorMessage } from '../src/core/draft-save-queue.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('慢速草稿写入时连续编辑只保存首个和最新版本，全部等待者等到对应写入完成', async () => {
  const first = deferred(), last = deferred(), writes = []
  const queue = createDraftSaveQueue(async value => { writes.push(value); return await (value === 1 ? first : last).promise })
  const initial = queue.save('project-a', 1, 1)
  const pending = Array.from({ length: 60 }, (_, i) => queue.save('project-a', i + 2, i + 2))
  let idle = false
  const flushed = queue.flush().then(() => { idle = true })
  await tick()
  assert.deepEqual(writes, [1]); assert.equal(idle, false)
  first.resolve('old saved')
  assert.equal(await initial, 'old saved')
  await tick()
  assert.deepEqual(writes, [1, 61]); assert.equal(idle, false)
  last.resolve('latest saved')
  assert((await Promise.all(pending)).every(result => result === 'latest saved'))
  await flushed
  assert.equal(idle, true)
})

test('同一版本的并发保存共用正在进行的写入，完成后允许显式重试', async () => {
  const gate = deferred(), writes = []
  const queue = createDraftSaveQueue(async value => { writes.push(value); return await gate.promise })
  const first = queue.save('project-a', 1, 'first')
  assert.equal(queue.save('project-a', 1, 'duplicate'), first)
  gate.resolve(true); await first; await queue.flush()
  assert.deepEqual(writes, ['first'])
  await queue.save('project-a', 1, 'retry')
  assert.deepEqual(writes, ['first', 'retry'])
})

test('较新待保存版本不会被迟到的旧版本覆盖，切换项目的写入不会互相合并', async () => {
  const gate = deferred(), writes = []
  const queue = createDraftSaveQueue(async value => { writes.push(value); if (value === 'a1') await gate.promise; return value })
  const a1 = queue.save('generation-1:a', 1, 'a1')
  const a3 = queue.save('generation-1:a', 3, 'a3')
  const b1 = queue.save('generation-2:b', 1, 'b1')
  const a2 = queue.save('generation-1:a', 2, 'a2')
  gate.resolve()
  assert.deepEqual(await Promise.all([a1, a3, b1, a2]), ['a1', 'a3', 'b1', 'a3'])
  await queue.flush()
  assert.deepEqual(writes, ['a1', 'a3', 'b1'])
})

test('一次写入失败不会阻断后续最新版本，也不会让关闭等待永久挂起', async () => {
  const gate = deferred(), writes = []
  const queue = createDraftSaveQueue(async value => { writes.push(value); if (value === 'failing') await gate.promise; return value })
  const failure = assert.rejects(queue.save('a', 1, 'failing'), /disk write failed/)
  const recovery = queue.save('a', 2, 'recovered')
  gate.reject(new Error('disk write failed'))
  await failure
  assert.equal(await recovery, 'recovered')
  await queue.flush()
  assert.deepEqual(writes, ['failing', 'recovered'])
})

test('草稿失败说明区分存储容量和事务中断，保留具体错误及手动保存提示', () => {
  assert.match(draftSaveErrorMessage(new DOMException('Quota exceeded', 'QuotaExceededError')), /存储空间不足.*保存项目文件/)
  assert.match(draftSaveErrorMessage(new DOMException('transaction aborted', 'AbortError')), /已保存的草稿未被替换.*transaction aborted/)
  assert.match(draftSaveErrorMessage(new Error('asset 42 missing')), /asset 42 missing.*当前编辑仍在内存中/)
  assert.match(draftSaveErrorMessage(new Error('保存失败', { cause: new DOMException('quota', 'QuotaExceededError') })), /存储空间不足/)
  assert.match(draftSaveErrorMessage(new Error('保存失败', { cause: new DOMException('inactive', 'TransactionInactiveError') })), /写入中断.*草稿未被替换/)
})
