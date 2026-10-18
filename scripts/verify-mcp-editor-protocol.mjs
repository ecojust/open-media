// Real SDK -> native TCP -> production browser controller -> native media/file I/O.
// npm install --prefix /tmp/open-media-mcp-client --no-package-lock --ignore-scripts @modelcontextprotocol/sdk@1.32.1
// node scripts/verify-mcp-editor-protocol.mjs --server-test-binary <native-lib-test-binary> --sdk-directory /tmp/open-media-mcp-client
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { unzipSync, strFromU8 } from 'fflate'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = process.argv.slice(2)
function option(name) { const index = options.indexOf(name); if (index < 0 || !options[index + 1]) throw new Error(`Missing ${name}`); return resolve(options[index + 1]) }
const executable = option('--server-test-binary'), sdkDirectory = option('--sdk-directory')
const require = createRequire(join(sdkDirectory, 'package.json'))
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')))
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')))
assert.equal(JSON.parse(await readFile(join(sdkDirectory, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8')).version, '1.32.1')
const directory = await mkdtemp(join(tmpdir(), 'open-media-mcp-editor-protocol-'))
const wait = delay => new Promise(resolve_ => setTimeout(resolve_, delay))
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await wait(15) }
  throw new Error(`Timed out: ${label}`)
}
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')) } catch (cause) { if (cause.code === 'ENOENT') return undefined; throw cause } }
async function publish(path, value) { await writeFile(`${path}.partial`, JSON.stringify(value)); await rename(`${path}.partial`, path) }
function wave() {
  const rate = 16000, count = rate, result = Buffer.alloc(44 + count * 2)
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16)
  result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(rate, 24); result.writeUInt32LE(rate * 2, 28)
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(count * 2, 40)
  for (let sample = 0; sample < count; sample++) result.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 440 / rate) * 6000), 44 + sample * 2)
  return result
}
let output = '', spawnError, bridgeError, bridgeRunning = true, pausedTool, holdImports = false
const nativeCalls = [], claims = [], active = new Set(), seen = new Set()
const fixture = spawn(executable, ['mcp::tests::external_editor_protocol_fixture', '--exact', '--ignored', '--nocapture'], {
  env: { ...process.env, OPEN_MEDIA_MCP_EDITOR_DIRECTORY: directory }, stdio: ['ignore', 'pipe', 'pipe'],
})
fixture.on('error', cause => { spawnError = cause })
for (const stream of [fixture.stdout, fixture.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-65536) })
const exited = new Promise(resolve_ => fixture.once('exit', (code, signal) => resolve_({ code, signal })))
let browser, server, page, client, bridge, evidence
try {
  const ready = await until(async () => {
    if (spawnError) throw spawnError
    if (fixture.exitCode !== null || fixture.signalCode !== null) throw new Error(`Native fixture stopped:\n${output}`)
    return json(join(directory, 'handshake.json'))
  }, 'native listener')
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox'] })
  page = await browser.newPage()
  const browserErrors = []
  page.on('pageerror', cause => browserErrors.push(cause.message))
  await page.route('**/__protocol_editor__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Open Media protocol verification</title>' }))
  await page.route('**/__protocol_asset__?*', async route => {
    try {
      const path = await realpath(new URL(route.request().url()).searchParams.get('path'))
      assert(path.startsWith(directory + sep), 'Fixture serves only its own temporary media.')
      await route.fulfill({ status: 200, contentType: 'audio/wav', body: await readFile(path) })
    } catch (cause) { bridgeError = cause; await route.abort() }
  })
  await page.exposeFunction('protocolNativeInvoke', async (command, args) => {
    const id = `native-${nativeCalls.length + 1}`, base = join(directory, 'native', id)
    const call = { id, command, held: command === 'mcp_import_media_paths' && holdImports }
    nativeCalls.push(call)
    if (call.held) await writeFile(`${base}.hold`, '')
    await publish(`${base}.request.json`, { command, args })
    const response = await until(() => json(`${base}.response.json`), `native ${command}`, 30000)
    if (response.error) throw new Error(response.error)
    return response.result
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__protocol_editor__`)
  await page.evaluate(async () => { window.protocolEditor = (await import('/scripts/fixtures/mcp-editor-protocol.mjs')).installProtocolEditor() })
  const inspect = () => page.evaluate(() => window.protocolEditor.inspect())
  async function deliver(request) {
    while (bridgeRunning && request.tool === pausedTool) await wait(15)
    if (!bridgeRunning) return
    const base = join(directory, 'requests', request.id)
    await publish(`${base}.claim.json`, {})
    const claim = await until(() => json(`${base}.claimed.json`), 'native request claim')
    claims.push({ id: request.id, tool: request.tool, claimed: claim.claimed })
    if (!claim.claimed) return
    assert(Date.now() < request.deadlineAt, 'Never begin an expired editor request.')
    const response = await page.evaluate(request_ => window.protocolEditor.execute(request_), request)
    await publish(`${base}.response.json`, response)
    const completion = await until(() => json(`${base}.completed.json`), 'native request completion')
    assert.equal(completion.accepted, true, 'Each live claim completes exactly once.')
  }
  bridge = (async () => {
    while (bridgeRunning) {
      for (const name of await readdir(join(directory, 'requests'))) {
        if (!name.endsWith('.request.json') || seen.has(name)) continue
        seen.add(name)
        const request = await json(join(directory, 'requests', name))
        const task = deliver(request).catch(cause => { bridgeError = cause }).finally(() => active.delete(task))
        active.add(task)
      }
      await wait(10)
    }
  })().catch(cause => { bridgeError = cause })
  client = new Client({ name: 'Open Media editor protocol verification', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(ready.url), { requestInit: { headers: { Authorization: `Bearer ${ready.token}` } } }), { timeout: 10000 })
  const tools = (await client.listTools()).tools
  const metadata = name => tools.find(tool => tool.name === `open_media_${name}`)?._meta?.['openmedia/execution']
  assert.equal(metadata('timeline_batch_edit')?.mode, 'asynchronous')
  assert.equal(metadata('export_validate')?.mode, 'asynchronous')
  assert.equal(metadata('project_get')?.mode, 'synchronous')
  assert.equal(metadata('timeline_batch_edit')?.pollingTool, 'open_media_job_get')
  assert.equal(metadata('timeline_batch_edit')?.cancelTool, 'open_media_job_cancel')
  async function call(name, arguments_ = {}, expectError = false) {
    if (bridgeError) throw bridgeError
    const result = await client.callTool({ name: `open_media_${name}`, arguments: arguments_ }, undefined, { timeout: 12000 })
    assert.equal(result.isError, expectError, JSON.stringify(result))
    const text = JSON.parse(result.content[0].text)
    assert.deepEqual(Array.isArray(text) ? { result: text } : text, result.structuredContent)
    return result.structuredContent
  }
  function jobContract(job) {
    assert.equal(job.responseType, 'job'); assert.equal(job.execution, 'asynchronous')
    assert.equal(job.jobId, job.id); assert.equal(job.status, job.state)
    assert.deepEqual(job.poll, { tool: 'open_media_job_get', arguments: { id: job.id } })
    assert.equal(job.final, job.state !== 'running'); assert.equal(job.pollAfterMs, job.final ? 0 : 500)
    if (job.final) assert.equal(job.cancel, null)
  }
  async function finished(job, state = 'completed') {
    jobContract(job)
    const result = await until(async () => {
      const status = await call('job_get', job.poll.arguments); jobContract(status)
      return status.final ? status : undefined
    }, `terminal ${job.id}`)
    assert.equal(result.state, state, JSON.stringify(result)); return result
  }
  const initial = await call('project_get')
  assert.equal(initial.responseType, 'result'); assert.equal(initial.execution, 'synchronous'); assert.equal(initial.final, true)
  const textTrack = initial.tracks.find(track => track.kind === 'text').id
  const operations = [
    { tool: 'open_media_project_update', arguments: { patch: { title: '原子提交验证' } } },
    { tool: 'open_media_text_add', arguments: { trackId: textTrack, text: '这是真实协议写入的字幕', start: 0, duration: 3 } },
  ]
  const batch = await finished(await call('timeline_batch_edit', { operations, expectedRevision: initial.revision }))
  assert.equal(batch.result.operationCount, 2)
  const committed = await inspect()
  assert.equal(committed.commits.length, 1); assert.equal(committed.undoCount, 1)
  assert.equal(committed.project.title, '原子提交验证'); assert.equal(committed.project.tracks.find(track => track.id === textTrack).clips.length, 1)
  const failed = await finished(await call('timeline_batch_edit', { operations: [operations[0], { tool: 'open_media_clip_remove', arguments: { clipId: 'missing-clip' } }] }), 'failed')
  assert.match(failed.error, /全部修改均未写入/)
  assert.deepEqual((await inspect()).project, committed.project); assert.equal((await inspect()).revision, committed.revision)
  const dryRun = await finished(await call('timeline_batch_edit', { operations, dryRun: true }))
  assert.equal(dryRun.result.dryRun, true); assert.equal((await inspect()).commits.length, 1)
  await call('project_history', { direction: 'undo' })
  assert.equal((await call('project_get')).title, initial.title)
  assert.equal((await call('project_get')).tracks.find(track => track.id === textTrack).clips.length, 0)
  await call('project_history', { direction: 'redo' })
  const validation = await finished(await call('export_validate', { analyzeMedia: false }))
  assert.equal(validation.result.valid, true); assert.equal(validation.result.scope.mediaAnalyzed, false)
  assert(Array.isArray(validation.result.issues))

  const wavePath = join(directory, '真实导入音频.wav'); await writeFile(wavePath, wave())
  const beforeCancel = await inspect()
  holdImports = true
  const importing = await call('asset_import', { paths: [wavePath] }); jobContract(importing)
  assert.equal(importing.state, 'running'); assert.equal(importing.cancel.tool, 'open_media_job_cancel')
  const held = await until(() => nativeCalls.find(item => item.held), 'held native import')
  await until(() => json(join(directory, 'native', `${held.id}.executed.json`)), 'real native import/probe completed')
  const busy = await call('project_update', { patch: { title: '不可覆盖' } }, true)
  assert.equal(busy.responseType, 'error'); assert.equal(busy.code, 'PROJECT_BUSY'); assert.equal(busy.retryable, true)
  assert.equal(busy.blockingJob.jobId, importing.jobId); assert.equal(busy.blockingJob.poll.tool, 'open_media_job_get')
  assert.equal(busy.blockingJob.cancel.tool, 'open_media_job_cancel')
  const blockedAsync = await call('export_validate', { analyzeMedia: false }, true)
  assert.equal(blockedAsync.code, 'PROJECT_BUSY'); assert.equal(blockedAsync.blockingJob.jobId, importing.jobId)
  const running = await call('job_get', busy.blockingJob.poll.arguments); jobContract(running); assert.equal(running.state, 'running')
  const listed = await call('job_list')
  listed.result.forEach(jobContract)
  assert(listed.result.some(job => job.jobId === importing.jobId && job.state === 'running'))
  const cancelling = await call('job_cancel', busy.blockingJob.cancel.arguments); jobContract(cancelling)
  assert.equal(cancelling.cancelling, true)
  holdImports = false; await rm(join(directory, 'native', `${held.id}.hold`))
  await finished(importing, 'cancelled')
  assert.deepEqual((await inspect()).project, beforeCancel.project)
  assert.equal((await inspect()).revision, beforeCancel.revision)
  assert.equal((await inspect()).commits.length, beforeCancel.commits.length, 'Cancelled import never commits its late native result.')
  const imported = await finished(await call('asset_import', { paths: [wavePath] }))
  assert.equal(imported.result.assetIds.length, 1)
  const afterImport = await call('project_get')
  assert.equal(afterImport.assets[0].kind, 'audio'); assert.equal(afterImport.assets[0].duration, 1)

  const savePath = join(directory, 'protocol-project.omedia')
  const saved = await finished(await call('project_save', { path: savePath }))
  assert.equal(saved.result.path, savePath)
  const entries = unzipSync(new Uint8Array(await readFile(savePath)))
  const manifest = JSON.parse(strFromU8(entries['project.json']))
  assert.equal(manifest.project.title, '原子提交验证')
  assert.equal(manifest.project.assets.length, 1)
  assert.deepEqual(Buffer.from(entries[`media/${afterImport.assets[0].id}`]), wave())
  await call('project_update', { patch: { title: '同一路径覆盖保存' } })
  await finished(await call('project_save'))
  assert.equal(JSON.parse(strFromU8(unzipSync(new Uint8Array(await readFile(savePath)))['project.json'])).project.title, '同一路径覆盖保存')

  const beforeExpired = await inspect()
  pausedTool = 'open_media_project_update'
  await assert.rejects(client.callTool({ name: pausedTool, arguments: { patch: { title: '超时请求不可写入' } } }, undefined, { timeout: 12000 }), cause => cause.code === -32000)
  pausedTool = undefined
  await until(() => claims.some(claim => !claim.claimed), 'expired request claim rejection')
  assert.deepEqual((await inspect()).project, beforeExpired.project)
  assert.equal((await inspect()).revision, beforeExpired.revision)
  assert.deepEqual(browserErrors, [])
  if (bridgeError) throw bridgeError
  evidence = { status: 'passed', client: '@modelcontextprotocol/sdk@1.32.1', transport: 'real native TCP Streamable HTTP', editor: 'production createMcpAutomation in Chromium', native: 'production media import/probe and project save', checks: ['execution metadata', 'asynchronous job/poll/cancel/result contract', 'single atomic batch commit and undo/redo', 'failed batch rollback', 'dry run', 'export validation final structured result', 'queryable blocking job error', 'cancelled import rejects late commit', 'real WAV import and archive bytes', 'overwrite saved target', 'expired request cannot claim or edit'], fixtureBoundary: 'JSON files replace desktop IPC delivery; explicit native completion barrier controls race timing only', completedClaims: claims.filter(claim => claim.claimed).length }
} finally {
  pausedTool = undefined; bridgeRunning = false
  await bridge
  await Promise.allSettled([...active])
  if (page && !page.isClosed()) await page.evaluate(() => window.protocolEditor?.dispose()).catch(() => {})
  await client?.close().catch(() => {})
  await browser?.close()
  await server?.close()
  await writeFile(join(directory, 'stop'), '')
  const result = await Promise.race([exited, wait(5000).then(() => null)])
  if (!result) fixture.kill('SIGTERM')
  await rm(directory, { recursive: true, force: true })
  assert(result && result.code === 0, `Native fixture did not stop cleanly: ${JSON.stringify(result)}\n${output}`)
}
console.log(JSON.stringify(evidence, null, 2))
