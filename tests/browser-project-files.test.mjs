import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { pickBrowserProjectFile, prepareBrowserProjectSave, writeBrowserProjectFile } from '../src/core/browser-project-files.ts'

function browser(t, api) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  if (api === undefined) delete globalThis.window
  else Object.defineProperty(globalThis, 'window', { value: api, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete globalThis.window
  })
}

async function fileHandle(t, name, initial = new Uint8Array()) {
  const directory = await mkdtemp(join(tmpdir(), 'open-media-project-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, name)
  await writeFile(path, initial)
  const calls = { permissions: [], writes: 0, closes: 0, aborts: 0 }
  const handle = {
    name: basename(path),
    async getFile() { return new File([await readFile(path)], basename(path)) },
    async requestPermission(options) { calls.permissions.push(options); return 'granted' },
    async createWritable() {
      const temporary = `${path}.pending`
      return {
        async write(blob) { calls.writes++; await writeFile(temporary, new Uint8Array(await blob.arrayBuffer())) },
        async close() { calls.closes++; await rename(temporary, path) },
        async abort() { calls.aborts++; await rm(temporary, { force: true }) },
      }
    },
  }
  return { handle, calls, path }
}

test('首次保存同步打开位置框并写入完整文件，重复保存覆盖原文件且不再选择位置', async (t) => {
  const { handle, calls, path } = await fileHandle(t, '项目.omedia')
  let pickCount = 0
  browser(t, {
    showSaveFilePicker(options) {
      pickCount++
      assert.equal(options.suggestedName, '项目.omedia')
      assert.deepEqual(Object.values(options.types[0].accept).flat(), ['.omedia'])
      return Promise.resolve(handle)
    },
  })
  const pending = prepareBrowserProjectSave('项目')
  assert.equal(pickCount, 1, '位置选择必须发生在首次异步等待之前')
  const selected = await pending
  const firstBytes = Uint8Array.from([80, 75, 3, 4, 0, 255, 8, 1])
  await writeBrowserProjectFile(selected, new Blob([firstBytes]))
  assert.deepEqual(await readFile(path), Buffer.from(firstBytes))
  const second = prepareBrowserProjectSave('不同标题', selected)
  assert.deepEqual(calls.permissions, [{ mode: 'readwrite' }])
  const secondBytes = Uint8Array.from([80, 75, 0, 2])
  await writeBrowserProjectFile(await second, new Blob([secondBytes]))
  assert.equal(pickCount, 1)
  assert.deepEqual(await readFile(path), Buffer.from(secondBytes), '较短的新内容必须完整替换旧内容')
  assert.deepEqual({ writes: calls.writes, closes: calls.closes, aborts: calls.aborts }, { writes: 2, closes: 2, aborts: 0 })
})

test('另存为选择新文件，原文件字节保持不变', async (t) => {
  const original = await fileHandle(t, '原项目.omedia', Buffer.from('original bytes'))
  const copy = await fileHandle(t, '项目副本.omedia')
  let picks = 0
  browser(t, { showSaveFilePicker(options) { picks++; assert.equal(options.suggestedName, '项目副本.omedia'); return Promise.resolve(copy.handle) } })
  const target = await prepareBrowserProjectSave('项目副本.omedia', undefined)
  await writeBrowserProjectFile(target, new Blob(['new project bytes']))
  assert.equal(picks, 1)
  assert.equal(await readFile(original.path, 'utf8'), 'original bytes')
  assert.equal(await readFile(copy.path, 'utf8'), 'new project bytes')
  assert.equal(original.calls.writes, 0)
})

test('打开项目同步选择文件并保留句柄与实际内容，随后保存直接写回', async (t) => {
  const entry = await fileHandle(t, '已存在.zip', Uint8Array.from([80, 75, 255, 0, 16]))
  let openCount = 0
  let saveCount = 0
  browser(t, {
    showOpenFilePicker(options) {
      openCount++
      assert.equal(options.multiple, false)
      assert.deepEqual(Object.values(options.types[0].accept).flat(), ['.omedia', '.zip'])
      return Promise.resolve([entry.handle])
    },
    showSaveFilePicker() { saveCount++; throw new Error('保存已有项目不应打开位置框') },
  })
  const pending = pickBrowserProjectFile()
  assert.equal(openCount, 1)
  const opened = await pending
  assert.equal(opened.handle, entry.handle)
  assert.equal(opened.file.name, '已存在.zip')
  assert.deepEqual(new Uint8Array(await opened.file.arrayBuffer()), Uint8Array.from([80, 75, 255, 0, 16]))
  await writeBrowserProjectFile(await prepareBrowserProjectSave('已存在', opened.handle), new Blob(['updated']))
  assert.equal(saveCount, 0)
  assert.equal(await readFile(entry.path, 'utf8'), 'updated')
})

test('不支持文件选择接口时同步返回 undefined，允许调用方回退到下载', (t) => {
  browser(t, undefined)
  assert.equal(pickBrowserProjectFile(), undefined)
  assert.equal(prepareBrowserProjectSave('项目'), undefined)
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true })
  assert.equal(pickBrowserProjectFile(), undefined)
  assert.equal(prepareBrowserProjectSave('项目'), undefined)
})

test('打开或另存为取消返回 null，包含同步抛出的取消事件', async (t) => {
  browser(t, {
    showOpenFilePicker() { return Promise.reject(new DOMException('cancelled', 'AbortError')) },
    showSaveFilePicker() { throw new DOMException('cancelled', 'AbortError') },
  })
  assert.equal(await pickBrowserProjectFile(), null)
  assert.equal(await prepareBrowserProjectSave('项目'), null)
})

test('拒绝已有文件写权限会报出中文错误，文件不变且不自动弹另存为', async (t) => {
  const entry = await fileHandle(t, '保护.omedia', Buffer.from('safe original'))
  entry.handle.requestPermission = async () => 'denied'
  browser(t, { showSaveFilePicker() { throw new Error('不能偷偷改成另存为') } })
  await assert.rejects(prepareBrowserProjectSave('保护', entry.handle), /未获得项目文件的写入权限/)
  entry.handle.requestPermission = async () => 'prompt'
  await assert.rejects(prepareBrowserProjectSave('保护', entry.handle), /未获得项目文件的写入权限/)
  assert.equal(await readFile(entry.path, 'utf8'), 'safe original')
  assert.equal(entry.calls.writes, 0)
})

test('句柄未提供权限接口时仍能直接保存，文件选择及读取错误保留原异常', async (t) => {
  const entry = await fileHandle(t, '项目.omedia')
  delete entry.handle.requestPermission
  const selected = await prepareBrowserProjectSave('项目', entry.handle)
  await writeBrowserProjectFile(selected, new Blob(['saved without permission method']))
  assert.equal(await readFile(entry.path, 'utf8'), 'saved without permission method')
  const pickerError = new Error('picker failed')
  browser(t, { showSaveFilePicker() { return Promise.reject(pickerError) } })
  await assert.rejects(prepareBrowserProjectSave('项目'), (error) => error === pickerError)
  const readError = new DOMException('file reading failed', 'AbortError')
  entry.handle.getFile = async () => { throw readError }
  globalThis.window.showOpenFilePicker = async () => [entry.handle]
  await assert.rejects(pickBrowserProjectFile(), (error) => error === readError)
})

test('写入中途失败时中止临时文件，保留原文件与原始错误', async (t) => {
  const entry = await fileHandle(t, '项目.omedia', Buffer.from('unchanged original'))
  const originalCreate = entry.handle.createWritable
  const failure = new Error('partial write failure')
  entry.handle.createWritable = async () => {
    const stream = await originalCreate()
    const write = stream.write
    stream.write = async (blob) => { await write(blob.slice(0, 3)); throw failure }
    return stream
  }
  await assert.rejects(writeBrowserProjectFile(entry.handle, new Blob(['new complete project'])), (error) => error === failure)
  assert.equal(entry.calls.aborts, 1)
  assert.equal(entry.calls.closes, 0)
  assert.equal(await readFile(entry.path, 'utf8'), 'unchanged original')
  await assert.rejects(readFile(`${entry.path}.pending`), { code: 'ENOENT' })
})

test('关闭失败也会中止，且中止本身失败不会覆盖原始错误', async (t) => {
  const entry = await fileHandle(t, '项目.omedia', Buffer.from('original'))
  const originalCreate = entry.handle.createWritable
  const failure = new Error('close failed')
  entry.handle.createWritable = async () => {
    const stream = await originalCreate()
    const abort = stream.abort
    stream.close = async () => { throw failure }
    stream.abort = async () => { await abort(); throw new Error('abort failed') }
    return stream
  }
  await assert.rejects(writeBrowserProjectFile(entry.handle, new Blob(['pending replacement'])), (error) => error === failure)
  assert.equal(entry.calls.aborts, 1)
  assert.equal(await readFile(entry.path, 'utf8'), 'original')
  await assert.rejects(readFile(`${entry.path}.pending`), { code: 'ENOENT' })
})
