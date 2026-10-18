const assert = require('node:assert/strict')
const { chromium, expect } = require('@playwright/test')

// Full application integration with the native event/IPC boundary simulated.
// Real HTTP and protocol compatibility are tested separately by the native suite.
async function installNativeBridge(page) {
  await page.addInitScript(() => {
    localStorage.setItem('open-media:autosave', 'false')
    const fixture = window.mcpAppFixture = {
      calls: [], completions: [], requests: new Map(), callbacks: new Map(), listeners: new Map(), heldClaims: new Map(),
      counter: 1, running: true, holdClaimId: '', unexpected: [],
      config: { host: '127.0.0.1', port: 39861, token: 'a'.repeat(64) },
    }
    const status = () => ({ running: fixture.running, host: fixture.config.host, port: fixture.config.port,
      url: fixture.running ? `http://${fixture.config.host}:${fixture.config.port}/mcp` : null,
      pendingRequests: [...fixture.requests.values()].filter(item => !item.claimed).length })
    fixture.emit = request => {
      for (const listener of fixture.listeners.values()) {
        if (listener.event === 'mcp-request') fixture.callbacks.get(listener.handler)?.({ event: listener.event, id: listener.id, payload: structuredClone(request) })
      }
    }
    fixture.enqueue = (id, tool, args = {}, options = {}) => {
      const request = { id, tool: `open_media_${tool}`, arguments: args, createdAt: Date.now(), deadlineAt: Date.now() + (options.ttl ?? 30000) }
      fixture.requests.set(id, { request, claimed: false })
      if (options.emit !== false) for (let copy = 0; copy < (options.copies || 1); copy++) fixture.emit(request)
      return id
    }
    // A renderer reload must replay requests accepted before its event listener exists.
    fixture.enqueue('startup-replay', 'project_get', {}, { emit: false })
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) { fixture.listeners.delete(id) } }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback) { const id = fixture.counter++; fixture.callbacks.set(id, callback); return id },
      unregisterCallback(id) { fixture.callbacks.delete(id) },
      convertFileSrc: path => path,
      invoke: async (command, args = {}) => {
        fixture.calls.push({ command, args: structuredClone(args) })
        if (command === 'plugin:event|listen') {
          const id = fixture.counter++; fixture.listeners.set(id, { ...args, id }); return id
        }
        if (command === 'plugin:event|unlisten') { fixture.listeners.delete(args.eventId); return null }
        if (command === 'configure_screenshot_shortcut') return args.shortcut
        if (command === 'get_media_jobs') return []
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'mcp_import_media_paths') return new Promise(resolve => { fixture.releaseImport = assets => resolve(assets) })
        if (command === 'mcp_get_config') return { ...fixture.config }
        if (command === 'mcp_get_status') return status()
        if (command === 'mcp_save_config') { fixture.config = { ...args.config, token: args.config.token || 'b'.repeat(64) }; return { ...fixture.config } }
        if (command === 'mcp_start') { fixture.running = true; return status() }
        if (command === 'mcp_stop') { fixture.running = false; fixture.requests.clear(); return status() }
        if (command === 'mcp_pending') return [...fixture.requests.values()].filter(item => !item.claimed && item.request.deadlineAt > Date.now()).map(item => structuredClone(item.request))
        if (command === 'mcp_claim') {
          const pending = fixture.requests.get(args.id)
          if (!fixture.running || !pending || pending.claimed || pending.request.deadlineAt <= Date.now()) return false
          pending.claimed = true
          if (fixture.holdClaimId === args.id) return new Promise(resolve => fixture.heldClaims.set(args.id, () => resolve(true)))
          return true
        }
        if (command === 'mcp_complete') {
          const pending = fixture.requests.get(args.id)
          fixture.completions.push(structuredClone(args))
          fixture.requests.delete(args.id)
          return Boolean(fixture.running && pending?.claimed && pending.request.deadlineAt > Date.now())
        }
        fixture.unexpected.push(command)
        throw new Error(`测试未预期的原生命令：${command}`)
      },
    }
  })
}

let sequence = 0
async function enqueue(page, tool, args = {}, options = {}) {
  const id = options.id || `app-request-${++sequence}`
  await page.evaluate(({ id, tool, args, options }) => window.mcpAppFixture.enqueue(id, tool, args, options), { id, tool, args, options })
  return id
}
async function completion(page, id) {
  await page.waitForFunction(id => window.mcpAppFixture.completions.some(result => result.id === id), id)
  return page.evaluate(id => window.mcpAppFixture.completions.find(result => result.id === id), id)
}
async function tool(page, name, args = {}) {
  const result = await completion(page, await enqueue(page, name, args))
  assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.result)}`)
  return result.result
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }), errors = []
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  try {
    await installNativeBridge(page)
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    const replay = await completion(page, 'startup-replay')
    assert.equal(replay.isError, false, '渲染器监听建立后应领取遗漏事件的待处理请求')
    await expect(page.getByTestId('home-workspace')).toBeVisible()
    await page.getByTestId('create-project').click()
    await expect(page.getByTestId('save-project')).toBeEnabled()
    await expect(page.getByTestId('editor-mcp-open')).toBeVisible()
    await page.getByTestId('editor-mcp-open').click()
    const dialog = page.getByRole('dialog', { name: 'MCP 服务', exact: true })
    await expect(dialog).toBeVisible()
    await expect(page.getByLabel('MCP 连接地址', { exact: true })).toHaveValue('http://127.0.0.1:39861/mcp')
    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    await expect(dialog).not.toBeVisible()

    const initial = await tool(page, 'project_get')
    assert.equal(initial.title, '未命名项目')
    assert.equal(initial.tracks.length, 3)
    const changed = await tool(page, 'project_update', { expectedRevision: initial.revision, patch: { title: 'MCP 实时编辑项目', width: 1280, height: 720 } })
    assert(changed.revision > initial.revision)
    await expect(page.locator('.project-title')).toHaveText('MCP 实时编辑项目')
    await expect(page.getByLabel('项目宽度', { exact: true })).toHaveValue('1280')
    await expect(page.getByLabel('项目高度', { exact: true })).toHaveValue('720')
    const rejected = await completion(page, await enqueue(page, 'project_update', { expectedRevision: initial.revision, patch: { title: '不得覆盖新修改' } }))
    assert.equal(rejected.isError, true)
    assert.match(JSON.stringify(rejected.result), /版本|revision/)
    await expect(page.locator('.project-title')).toHaveText('MCP 实时编辑项目')
    console.log('PASS 完整App桥接模拟：启动时待处理请求重放、右侧M入口、工程读写同步UI、旧revision拒绝')

    const added = await tool(page, 'track_add', { kind: 'text', name: 'MCP 字幕轨道', expectedRevision: changed.revision })
    const track = page.locator(`[data-track-row-id="${added.track.id}"]`)
    await expect(track.locator('.track-name')).toContainText('MCP 字幕轨道')
    const subtitle = await tool(page, 'text_add', { trackId: added.track.id, text: '外部 AI 编辑，桌面实时同步。', start: 0, duration: 4, expectedRevision: added.revision, style: { fontSize: 48, color: '#ffffff', background: '#223344' } })
    await expect(page.locator(`[data-clip-id="${subtitle.clip.id}"]`)).toBeVisible()
    assert.equal((await tool(page, 'playback_get')).selectedClipId, subtitle.clip.id, '新增片段提交并刷新组件后应立即选中')
    const textRead = await tool(page, 'project_get')
    assert.equal(textRead.tracks.find(item => item.id === added.track.id).clips[0].text, '外部 AI 编辑，桌面实时同步。')
    assert.equal(textRead.tracks.find(item => item.id === added.track.id).clipCount, 1)
    await tool(page, 'project_history', { direction: 'undo', expectedRevision: textRead.revision })
    await expect(page.locator(`[data-clip-id="${subtitle.clip.id}"]`)).toHaveCount(0)
    const undone = await tool(page, 'project_get')
    assert.equal(undone.tracks.find(item => item.id === added.track.id).clips.length, 0)
    await tool(page, 'project_history', { direction: 'redo', expectedRevision: undone.revision })
    await expect(page.locator(`[data-clip-id="${subtitle.clip.id}"]`)).toBeVisible()

    const beforeDuplicate = await tool(page, 'project_get')
    const duplicateId = await enqueue(page, 'track_add', { kind: 'audio', name: '只添加一次', expectedRevision: beforeDuplicate.revision }, { copies: 3 })
    await completion(page, duplicateId)
    const duplicateRead = await tool(page, 'project_get')
    assert.equal(duplicateRead.tracks.filter(item => item.name === '只添加一次').length, 1)
    assert.equal(duplicateRead.revision, beforeDuplicate.revision + 1)
    assert.equal(await page.evaluate(id => window.mcpAppFixture.calls.filter(call => call.command === 'mcp_claim' && call.args.id === id).length, duplicateId), 1)
    assert.equal(await page.evaluate(id => window.mcpAppFixture.completions.filter(call => call.id === id).length, duplicateId), 1)
    console.log('PASS 完整App桥接模拟：字幕轨道/片段创建、真实撤销重做历史、重复事件只执行一次')

    const beforeExpired = await tool(page, 'project_get')
    await enqueue(page, 'project_update', { patch: { title: '过期事件不得修改' } }, { ttl: -100 })
    const afterExpired = await tool(page, 'project_get')
    assert.equal(afterExpired.revision, beforeExpired.revision)
    assert.equal(afterExpired.title, beforeExpired.title)

    const heldId = 'claim-deadline-race'
    await page.evaluate(id => { window.mcpAppFixture.holdClaimId = id }, heldId)
    await enqueue(page, 'project_update', { patch: { title: '领取返回过晚不得修改' } }, { id: heldId, ttl: 800 })
    await page.waitForFunction(id => window.mcpAppFixture.heldClaims.has(id), heldId)
    await page.waitForFunction(id => Date.now() > window.mcpAppFixture.requests.get(id).request.deadlineAt, heldId)
    await page.evaluate(id => { const fixture = window.mcpAppFixture; fixture.heldClaims.get(id)(); fixture.heldClaims.delete(id); fixture.holdClaimId = '' }, heldId)
    const afterLate = await tool(page, 'project_get')
    assert.equal(afterLate.revision, beforeExpired.revision)
    assert.equal(afterLate.title, beforeExpired.title)

    const stopId = 'claim-stop-race'
    await page.evaluate(id => { window.mcpAppFixture.holdClaimId = id }, stopId)
    await enqueue(page, 'project_update', { patch: { title: '停服后的领取不得修改' } }, { id: stopId })
    await page.waitForFunction(id => window.mcpAppFixture.heldClaims.has(id), stopId)
    await page.getByTestId('editor-mcp-open').click()
    await expect(page.getByTestId('mcp-stop')).toBeEnabled()
    await page.getByTestId('mcp-stop').click()
    await expect(dialog).toContainText('服务已停止')
    await page.evaluate(id => { const fixture = window.mcpAppFixture; fixture.heldClaims.get(id)(); fixture.heldClaims.delete(id); fixture.holdClaimId = '' }, stopId)
    await page.getByTestId('mcp-start').click()
    await expect(dialog).toContainText('服务运行中')
    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    const restarted = await tool(page, 'project_get')
    assert.equal(restarted.title, beforeExpired.title)
    assert.equal(restarted.revision, beforeExpired.revision)
    await expect(page.locator('.project-title')).toHaveText(beforeExpired.title)
    console.log('PASS 完整App桥接模拟：事件过期、claim响应过晚、领取后停服均不提交迟到修改；重启可继续读取')

    await page.getByTestId('nav-record').click()
    await expect(page.getByTestId('record-start')).toBeVisible()
    const imported = await tool(page, 'asset_import', { paths: ['/fixture/import.png'] })
    assert.equal(imported.state, 'running')
    assert.equal(typeof imported.jobId, 'string')
    await page.waitForFunction(() => typeof window.mcpAppFixture.releaseImport === 'function')
    await expect(page.getByTestId('nav-edit')).toHaveClass(/active/)
    await expect(page.getByTestId('record-start')).not.toBeVisible()
    await expect(page.getByTestId('nav-record')).toBeDisabled()
    await expect(page.getByTestId('nav-image')).toBeDisabled()
    await expect(page.getByTestId('new-project')).toBeDisabled()
    await expect(page.getByTestId('save-project')).toBeDisabled()
    await expect(page.locator('#editor-timeline')).toHaveAttribute('inert', '')
    const beforeBlockedClick = await tool(page, 'project_get')
    const subtitleButton = await page.locator('button[title="添加字幕"]').boundingBox()
    assert(subtitleButton)
    await page.mouse.click(subtitleButton.x + subtitleButton.width / 2, subtitleButton.y + subtitleButton.height / 2)
    assert.equal((await tool(page, 'project_get')).revision, beforeBlockedClick.revision, 'inert时间线必须阻止真实鼠标点击添加字幕')
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24
      canvas.getContext('2d').fillRect(0, 0, 24, 24)
      const url = canvas.toDataURL('image/png')
      window.mcpAppFixture.releaseImport([{ id: 'mcp-import-image', name: 'MCP 导入素材.png', kind: 'image', url, mime: 'image/png', width: 24, height: 24, duration: 0, size: atob(url.split(',')[1]).length }])
    })
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    const importStatus = await tool(page, 'job_get', { id: imported.jobId })
    assert.equal(importStatus.state, 'completed')
    assert.equal((await tool(page, 'asset_list')).assets.some(asset => asset.id === 'mcp-import-image'), true)
    assert.equal(await page.evaluate(() => window.mcpAppFixture.calls.some(call => ['start_capture', 'pick_capture_source'].includes(call.command))), false)
    console.log('PASS 完整App桥接模拟：从录屏页启动异步MCP任务会返回剪辑页，处理中阻止跨页和本地改动，完成后恢复操作')

    // Hold the real editor's asynchronous output preparation; never capture a microphone.
    await page.evaluate(async () => {
      const { TimelinePreview } = await import('/src/core/preview.ts'), fixture = window.mcpAppFixture
      const original = TimelinePreview.prototype.enableAudio
      fixture.restorePlaybackPreparation = () => { TimelinePreview.prototype.enableAudio = original }
      TimelinePreview.prototype.enableAudio = function (_monitor, signal) {
        fixture.playbackPreparing = true; fixture.playbackSignal = signal
        return new Promise(resolve => { fixture.releasePlayback = () => resolve(new MediaStream()) })
      }
    })
    await page.getByTestId('nav-record').click()
    await expect(page.getByTestId('record-start')).toBeVisible()
    const playbackId = await enqueue(page, 'playback_set', { time: 0, playing: true })
    await page.waitForFunction(() => window.mcpAppFixture.playbackPreparing)
    await expect(page.getByTestId('nav-edit')).toHaveClass(/active/)
    await page.getByTestId('editor-mcp-open').click()
    await expect(page.getByTestId('mcp-stop')).toBeEnabled()
    await page.screenshot({ path: '/tmp/open-media-mcp-app.png', fullPage: true })
    await page.getByTestId('mcp-stop').click()
    await expect(dialog).toContainText('服务已停止')
    assert.equal(await page.evaluate(() => window.mcpAppFixture.playbackSignal.aborted), true, '服务停止必须立即中止播放准备，而非等准备结束后才暂停')
    await page.evaluate(() => { window.mcpAppFixture.releasePlayback(); window.mcpAppFixture.restorePlaybackPreparation() })
    await page.getByTestId('mcp-start').click()
    await expect(dialog).toContainText('服务运行中')
    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    assert.equal((await tool(page, 'playback_get')).playing, false)
    assert.equal(await page.evaluate(id => window.mcpAppFixture.completions.some(item => item.id === id && !item.isError), playbackId), false)
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    console.log('PASS 完整App桥接模拟：跨工作区远程播放在异步准备期间停服立即中止，迟到准备结果不启动播放')

    assert.deepEqual(await page.evaluate(() => window.mcpAppFixture.unexpected), [])
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
