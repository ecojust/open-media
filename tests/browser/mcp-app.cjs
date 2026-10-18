const assert = require('node:assert/strict')
const { chromium, expect } = require('@playwright/test')

// Full application integration with the native event/IPC boundary simulated.
// Real HTTP and protocol compatibility are tested separately by the native suite.
async function installNativeBridge(page) {
  await page.addInitScript(() => {
    localStorage.setItem('open-media:autosave', 'false')
    localStorage.setItem('open-media:theme', 'dark')
    const fixture = window.mcpAppFixture = {
      calls: [], completions: [], requests: new Map(), callbacks: new Map(), listeners: new Map(), heldClaims: new Map(), heldCompletions: new Map(),
      counter: 1, running: true, connectedClients: 0, statusFailure: false, omitConnectionCount: false, holdNextStatus: false, holdClaimId: '', unexpected: [],
      mediaJobs: [{ id: 'existing-export', name: '已有视频导出', state: 'completed', progress: 1, outputPath: '/fixture/export.mp4' }],
      config: { host: '127.0.0.1', port: 39861, token: 'a'.repeat(64) },
      backgroundColors: {},
    }
    const status = () => ({ running: fixture.running, host: fixture.config.host, port: fixture.config.port,
      url: fixture.running ? `http://${fixture.config.host}:${fixture.config.port}/mcp` : null,
      pendingRequests: [...fixture.requests.values()].filter(item => !item.claimed).length,
      ...(fixture.omitConnectionCount ? {} : { connectedClients: fixture.connectedClients }) })
    fixture.emit = request => {
      for (const listener of fixture.listeners.values()) {
        if (listener.event === 'mcp-request') fixture.callbacks.get(listener.handler)?.({ event: listener.event, id: listener.id, payload: structuredClone(request) })
      }
    }
    fixture.close = () => {
      for (const listener of fixture.listeners.values()) if (listener.event === 'native-close-requested') fixture.callbacks.get(listener.handler)?.({ event: listener.event, id: listener.id, payload: null })
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
        if (command === 'plugin:window|set_background_color' || command === 'plugin:webview|set_webview_background_color') {
          if (args.label !== 'main' || !['#151923', '#f7f9fc'].includes(args.value)) throw new Error('主窗口背景参数无效')
          fixture.backgroundColors[command] = args.value
          return null
        }
        if (command === 'configure_screenshot_shortcut') return args.shortcut
        if (command === 'get_media_jobs') return structuredClone(fixture.mediaJobs)
        if (command === 'cancel_media_job') { fixture.mediaJobs.find(job => job.id === args.id).state = 'cancelled'; return null }
        if (command === 'close_native_window') return null
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'list_stored_videos') return { directory: '/fixture/recordings', assets: [], warnings: [] }
        if (command === 'mcp_import_media_paths') return new Promise(resolve => { fixture.releaseImport = assets => resolve(assets) })
        if (command === 'mcp_get_config') return { ...fixture.config }
        if (command === 'mcp_get_status') {
          if (fixture.statusFailure) throw new Error('状态读取暂时失败')
          const snapshot = status()
          if (fixture.holdNextStatus) { fixture.holdNextStatus = false; return new Promise(resolve => { fixture.releaseStatus = () => { fixture.releaseStatus = undefined; resolve(snapshot) } }) }
          return snapshot
        }
        if (command === 'mcp_save_config') { fixture.config = { ...args.config, token: args.config.token || 'b'.repeat(64) }; return { ...fixture.config } }
        if (command === 'mcp_start') {
          if (fixture.holdNextStart) { fixture.holdNextStart = false; return new Promise(resolve => { fixture.releaseStart = () => { fixture.releaseStart = undefined; fixture.running = true; resolve(status()) } }) }
          fixture.running = true; return status()
        }
        if (command === 'mcp_stop') { fixture.running = false; fixture.connectedClients = 0; fixture.requests.clear(); return status() }
        if (command === 'mcp_pending') return [...fixture.requests.values()].filter(item => !item.claimed && item.request.deadlineAt > Date.now()).map(item => structuredClone(item.request))
        if (command === 'mcp_claim') {
          const pending = fixture.requests.get(args.id)
          if (!fixture.running || !pending || pending.claimed || pending.request.deadlineAt <= Date.now()) return false
          pending.claimed = true
          if (fixture.holdClaimId === args.id) return new Promise(resolve => fixture.heldClaims.set(args.id, () => resolve(true)))
          return true
        }
        if (command === 'mcp_complete') {
          if (fixture.holdCompleteId === args.id) await new Promise(resolve => fixture.heldCompletions.set(args.id, resolve))
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

async function editorGeometry(page) {
  return page.evaluate(() => Object.fromEntries(['[data-testid="video-editor"]', '#editor-timeline'].map(selector => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect()
    return [selector, { x, y, width, height }]
  })))
}
async function assertFloatingBar(page, width) {
  const geometry = await page.getByTestId('mcp-processing-banner').evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect()
    const header = document.querySelector('.topbar').getBoundingClientRect()
    const brand = document.querySelector('.brand').getBoundingClientRect()
    const controls = document.querySelector('.topbar-end').getBoundingClientRect()
    const detail = element.querySelector('.mcp-processing-details')?.getBoundingClientRect()
    return { x, y, width, height, position: getComputedStyle(element).position, viewport: innerWidth,
      headerBottom: header.bottom, brandRight: brand.right, controlsLeft: controls.left,
      detail: detail ? { top: detail.top, bottom: detail.bottom } : null, viewportHeight: innerHeight }
  })
  assert.equal(geometry.position, 'fixed')
  assert.equal(geometry.height, 44)
  assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= geometry.viewport, JSON.stringify(geometry))
  if (geometry.viewport > 700) {
    assert.ok(geometry.y >= 0 && geometry.y + geometry.height <= geometry.headerBottom, '宽屏状态条位于全局顶栏内')
    assert.ok(geometry.x > geometry.brandRight && geometry.x + geometry.width < geometry.controlsLeft, '状态条不遮挡品牌和主题按钮')
  } else {
    assert.equal(geometry.y, geometry.headerBottom + 8, '窄屏状态条置于顶栏下方')
  }
  if (geometry.detail) {
    assert.ok(geometry.detail.top >= geometry.y + geometry.height, '详情向下展开')
    assert.ok(geometry.detail.bottom <= geometry.viewportHeight, '详情不超出窗口底部')
  }
  if (width) assert.equal(geometry.viewport, width)
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
    const backgroundColors = () => page.evaluate(() => window.mcpAppFixture.backgroundColors)
    const expectedColors = color => ({ 'plugin:window|set_background_color': color, 'plugin:webview|set_webview_background_color': color })
    await expect.poll(backgroundColors).toEqual(expectedColors('#151923'))
    await page.getByTestId('theme-light').click()
    await expect.poll(backgroundColors).toEqual(expectedColors('#f7f9fc'))
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByTestId('theme-system').click()
    await expect.poll(backgroundColors).toEqual(expectedColors('#151923'))
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(backgroundColors).toEqual(expectedColors('#f7f9fc'))
    await page.getByTestId('create-project').click()
    await expect(page.getByTestId('save-project')).toBeEnabled()
    await expect(page.locator('.statusbar > *')).toHaveCount(2)
    await expect(page.locator('.statusbar > .status-main')).toBeVisible()
    await expect(page.locator('.statusbar > button')).toContainText('自动保存已关闭')
    await expect(page.locator('.statusbar .status-tasks')).toHaveCount(0)
    await expect(page.getByTestId('editor-mcp-open')).toBeVisible()
    await page.getByTestId('editor-mcp-open').click()
    const dialog = page.getByRole('dialog', { name: 'MCP 服务', exact: true })
    await expect(dialog).toBeVisible()
    await expect(page.getByLabel('MCP 连接地址', { exact: true })).toHaveValue('http://127.0.0.1:39861/mcp')
    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    await expect(dialog).not.toBeVisible()

    const mcpButton = page.getByTestId('editor-mcp-open')
    await expect(mcpButton).not.toHaveClass(/\bconnected\b/)
    await page.evaluate(() => { window.mcpAppFixture.connectedClients = 1 })
    await expect(mcpButton).toHaveClass(/\bconnected\b/)
    await expect(dialog).not.toBeVisible()
    await page.evaluate(() => { window.mcpAppFixture.connectedClients = 0 })
    await expect(mcpButton).not.toHaveClass(/\bconnected\b/)
    await page.evaluate(() => { window.mcpAppFixture.connectedClients = 2 })
    await expect(mcpButton).toHaveClass(/\bconnected\b/)
    await page.evaluate(() => { window.mcpAppFixture.statusFailure = true })
    await expect(mcpButton).not.toHaveClass(/\bconnected\b/)
    assert.equal(await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.mcpServiceRunning), true, '状态查询失败不应把服务改成已停止')
    await page.evaluate(() => { window.mcpAppFixture.statusFailure = false })
    await expect(mcpButton).toHaveClass(/\bconnected\b/)
    await page.evaluate(() => { window.mcpAppFixture.omitConnectionCount = true })
    await expect(mcpButton).not.toHaveClass(/\bconnected\b/)
    await page.evaluate(() => { window.mcpAppFixture.omitConnectionCount = false })
    await expect(mcpButton).toHaveClass(/\bconnected\b/)
    await page.evaluate(() => { window.mcpAppFixture.running = false })
    await expect(mcpButton).not.toHaveClass(/\bconnected\b/)
    await page.waitForFunction(() => !document.querySelector('#app').__vue_app__._instance.setupState.mcpServiceRunning)
    await page.evaluate(() => { window.mcpAppFixture.running = true; window.mcpAppFixture.connectedClients = 0 })
    await page.waitForFunction(() => document.querySelector('#app').__vue_app__._instance.setupState.mcpServiceRunning)
    await expect(mcpButton).not.toHaveClass(/\bconnected\b/)
    await page.evaluate(() => { window.mcpAppFixture.connectedClients = 1 })
    await expect(mcpButton).toHaveClass(/\bconnected\b/)
    const steady = await page.evaluate(() => ({ polls: window.mcpAppFixture.calls.filter(call => call.command === 'mcp_get_status').length, recoveries: window.mcpAppFixture.calls.filter(call => call.command === 'mcp_pending').length }))
    await page.waitForFunction(count => window.mcpAppFixture.calls.filter(call => call.command === 'mcp_get_status').length >= count + 3, steady.polls)
    assert.equal(await page.evaluate(() => window.mcpAppFixture.calls.filter(call => call.command === 'mcp_pending').length), steady.recoveries, '常驻轮询不应反复重放待处理请求')
    console.log('PASS 连接指示：弹窗关闭时跟踪真实连接、断开、状态失败/恢复、旧字段缺失与外部停服；运行本身不点亮')

    await page.evaluate(() => { window.mcpAppFixture.holdNextStatus = true })
    await page.waitForFunction(() => typeof window.mcpAppFixture.releaseStatus === 'function')
    await mcpButton.click()
    await expect(page.getByTestId('mcp-service-switch')).toBeEnabled()
    await page.getByTestId('mcp-service-switch').click()
    await expect(page.getByTestId('mcp-service-switch')).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('mcp-service-switch').click()
    await expect(page.getByTestId('mcp-service-switch')).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    await expect(mcpButton).not.toHaveClass(/\bconnected\b/)
    const beforeStaleRelease = await page.evaluate(() => {
      const fixture = window.mcpAppFixture, button = document.querySelector('[data-testid="editor-mcp-open"]')
      fixture.staleConnectionChanges = []
      fixture.connectionObserver = new MutationObserver(() => fixture.staleConnectionChanges.push(button.classList.contains('connected')))
      fixture.connectionObserver.observe(button, { attributes: true, attributeFilter: ['class'] })
      const polls = fixture.calls.filter(call => call.command === 'mcp_get_status').length
      fixture.releaseStatus()
      return polls
    })
    await page.waitForFunction(count => window.mcpAppFixture.calls.filter(call => call.command === 'mcp_get_status').length > count, beforeStaleRelease)
    await expect(mcpButton).not.toHaveClass(/\bconnected\b/)
    assert.equal(await page.evaluate(() => { const fixture = window.mcpAppFixture; fixture.connectionObserver.disconnect(); return fixture.staleConnectionChanges.some(Boolean) }), false, '停止/重启前的迟到响应不能重新点亮连接状态')
    await page.evaluate(() => { window.mcpAppFixture.connectedClients = 1 })
    await expect(mcpButton).toHaveClass(/\bconnected\b/)
    await page.evaluate(() => { window.mcpAppFixture.connectedClients = 0 })
    await expect(mcpButton).not.toHaveClass(/\bconnected\b/)
    console.log('PASS 连接指示：迟到轮询不能覆盖停止/重启结果，后续新客户端仍正常更新')

    const changeRace = await page.evaluate(async () => {
      const native = await import('/src/native-mcp.ts'), fixture = window.mcpAppFixture
      fixture.running = false; fixture.holdNextStart = true
      const starting = native.startMcpService()
      while (!fixture.releaseStart) await new Promise(resolve => setTimeout(resolve, 0))
      fixture.holdNextStatus = true
      const readDuringStart = native.getMcpStatus()
      while (!fixture.releaseStatus) await new Promise(resolve => setTimeout(resolve, 0))
      fixture.releaseStart()
      const changed = await starting
      fixture.releaseStatus()
      const late = await readDuringStart
      return { changed, late }
    })
    assert.equal(changeRace.changed.running, true)
    assert.equal(changeRace.late.running, true, '启动期间取得的旧停止状态不能覆盖已经完成的启动')
    assert.equal(changeRace.late.connectedClients, 0)
    console.log('PASS 状态顺序：启停操作完成形成读取屏障，变更期间发出的迟到旧状态不覆盖最新结果')

    const activityBanner = page.getByTestId('mcp-processing-banner')
    await page.getByTestId('nav-record').click()
    await page.evaluate(() => { window.mcpAppFixture.holdCompleteId = 'visible-tool' })
    await enqueue(page, 'project_get', {}, { id: 'visible-tool' })
    await page.waitForFunction(() => window.mcpAppFixture.heldCompletions.has('visible-tool'))
    await expect(activityBanner).toContainText('MCP 正在调用')
    await expect(activityBanner).toContainText('读取当前工程')
    await expect(activityBanner).toHaveAttribute('data-call-tool', 'open_media_project_get')
    await expect(activityBanner).not.toContainText('编辑暂时锁定')
    await expect(page.getByTestId('nav-record')).toHaveClass(/active/)
    await expect(page.getByTestId('nav-edit')).toBeEnabled()
    const queuedTool = await enqueue(page, 'project_validate')
    await expect(activityBanner).toHaveAttribute('data-call-tool', 'open_media_project_get')
    assert.equal(await page.evaluate(id => window.mcpAppFixture.calls.some(call => call.command === 'mcp_claim' && call.args.id === id), queuedTool), false, '排队调用不得替换当前执行工具')
    await page.screenshot({ path: '/tmp/open-media-mcp-tool-activity.png', fullPage: true })
    await page.evaluate(() => { const fixture = window.mcpAppFixture; fixture.holdCompleteId = ''; fixture.heldCompletions.get('visible-tool')() })
    await completion(page, queuedTool)
    await expect(activityBanner).toContainText('MCP 调用完成')
    await expect(activityBanner).toHaveAttribute('data-call-tool', 'open_media_project_validate')
    await expect(activityBanner).not.toBeVisible()
    await page.getByTestId('nav-edit').click()
    await expect(page.getByTestId('save-project')).toBeEnabled()
    console.log('PASS 工具调用提示：跨工作区显示当前工具，排队不抢标签，完成短暂反馈，查询不增加编辑锁')

    await page.evaluate(() => { window.mcpAppFixture.holdCompleteId = 'visible-tool-expired' })
    await enqueue(page, 'project_get', {}, { id: 'visible-tool-expired', ttl: 1100 })
    await page.waitForFunction(() => window.mcpAppFixture.heldCompletions.has('visible-tool-expired'))
    await expect(activityBanner).toHaveAttribute('data-call-state', 'running')
    await expect(activityBanner).not.toBeVisible()
    await page.evaluate(() => { const fixture = window.mcpAppFixture; fixture.holdCompleteId = ''; fixture.heldCompletions.get('visible-tool-expired')() })
    await completion(page, 'visible-tool-expired')
    await expect(activityBanner).not.toBeVisible()
    await page.evaluate(() => { window.mcpAppFixture.holdCompleteId = 'visible-tool-stopped' })
    await enqueue(page, 'project_get', {}, { id: 'visible-tool-stopped' })
    await page.waitForFunction(() => window.mcpAppFixture.heldCompletions.has('visible-tool-stopped'))
    await expect(activityBanner).toHaveAttribute('data-call-state', 'running')
    await mcpButton.click()
    await page.getByTestId('mcp-service-switch').click()
    await expect(page.getByTestId('mcp-service-switch')).toHaveAttribute('aria-checked', 'false')
    await expect(activityBanner).not.toBeVisible()
    await page.evaluate(() => { const fixture = window.mcpAppFixture; fixture.holdCompleteId = ''; fixture.heldCompletions.get('visible-tool-stopped')() })
    await completion(page, 'visible-tool-stopped')
    await page.getByTestId('mcp-service-switch').click()
    await expect(page.getByTestId('mcp-service-switch')).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    await expect(activityBanner).not.toBeVisible()
    console.log('PASS 工具调用提示：过期与停服立即清理，迟到完成不重新显示')

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
    await expect(activityBanner).toContainText('MCP 调用失败')
    await expect(activityBanner).toHaveAttribute('data-call-state', 'failed')
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
    await expect(page.getByTestId('mcp-service-switch')).toBeEnabled()
    await page.getByTestId('mcp-service-switch').click()
    await expect(page.getByRole('switch', { name: 'MCP 服务开关' })).toHaveAttribute('aria-checked', 'false')
    await page.evaluate(id => { const fixture = window.mcpAppFixture; fixture.heldClaims.get(id)(); fixture.heldClaims.delete(id); fixture.holdClaimId = '' }, stopId)
    await page.getByTestId('mcp-service-switch').click()
    await expect(page.getByRole('switch', { name: 'MCP 服务开关' })).toHaveAttribute('aria-checked', 'true')
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
    const processingBanner = page.getByTestId('mcp-processing-banner')
    await expect(processingBanner).toBeVisible()
    await expect(processingBanner).toContainText('MCP 正在处理')
    await expect(processingBanner).toContainText('导入素材')
    await expect(processingBanner).toContainText('正在读取和准备媒体')
    await assertFloatingBar(page)
    const runningGeometry = await editorGeometry(page)
    await page.getByTestId('mcp-processing-details').click()
    await expect(page.getByTestId('mcp-processing-detail-panel')).toContainText('编辑暂时锁定，完成后自动恢复。')
    assert.deepEqual(await editorGeometry(page), runningGeometry, '悬浮详情展开不能推移编辑器或时间线')
    await expect(page.getByTestId('mcp-processing-cancel')).toBeEnabled()
    await expect(page.getByTestId('editor-mcp-open')).toBeEnabled()
    await expect(page.getByRole('dialog', { name: '处理任务', exact: true })).not.toBeVisible()
    await page.screenshot({ path: '/tmp/open-media-mcp-processing-banner.png', fullPage: true })
    const beforeBlockedClick = await tool(page, 'project_get')
    await expect(processingBanner).toContainText('MCP 正在处理')
    await expect(processingBanner).toContainText('导入素材')
    await expect(processingBanner).toContainText('正在读取和准备媒体')
    await expect(processingBanner).toContainText('最近调用已完成：读取当前工程')
    assert.deepEqual(await editorGeometry(page), runningGeometry, '工具状态及详情文字更新不能改变编辑器或时间线位置')
    await assertFloatingBar(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await assertFloatingBar(page, 390)
    const compactDetail = await page.getByTestId('mcp-processing-detail-panel').boundingBox()
    assert.ok(compactDetail && compactDetail.x >= 0 && compactDetail.x + compactDetail.width <= 390)
    await page.screenshot({ path: '/tmp/open-media-mcp-floating-mobile.png', fullPage: true })
    await page.setViewportSize({ width: 1500, height: 1000 })
    await expect.poll(() => editorGeometry(page), { message: '恢复窗口尺寸后悬浮栏不保留布局占位' }).toEqual(runningGeometry)
    await page.getByTestId('mcp-processing-details').click()
    await expect(page.getByTestId('mcp-processing-detail-panel')).not.toBeVisible()
    const subtitleButton = await page.locator('button[title="添加字幕"]').boundingBox()
    assert(subtitleButton)
    await page.mouse.click(subtitleButton.x + subtitleButton.width / 2, subtitleButton.y + subtitleButton.height / 2)
    assert.equal((await tool(page, 'project_get')).revision, beforeBlockedClick.revision, 'inert时间线必须阻止真实鼠标点击添加字幕')
    await page.getByTestId('mcp-processing-tasks').click()
    const tasks = page.getByRole('dialog', { name: '处理任务', exact: true })
    await expect(tasks).toBeVisible()
    await expect(dialog).not.toBeVisible()
    await expect(tasks.locator('[data-media-job-id="existing-export"]')).toContainText('已有视频导出')
    const importRow = tasks.locator(`[data-mcp-job-id="${imported.jobId}"]`)
    await expect(importRow).toContainText('正在处理')
    await expect(importRow.getByRole('progressbar')).toBeVisible()
    await expect(importRow.getByRole('button', { name: /取消 MCP 任务/ })).toBeEnabled()
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24
      canvas.getContext('2d').fillRect(0, 0, 24, 24)
      const url = canvas.toDataURL('image/png')
      window.mcpAppFixture.releaseImport([{ id: 'mcp-import-image', name: 'MCP 导入素材.png', kind: 'image', url, mime: 'image/png', width: 24, height: 24, duration: 0, size: atob(url.split(',')[1]).length }])
    })
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    await expect(processingBanner).not.toBeVisible()
    const importStatus = await tool(page, 'job_get', { id: imported.jobId })
    assert.equal(importStatus.state, 'completed')
    assert.equal((await tool(page, 'asset_list')).assets.some(asset => asset.id === 'mcp-import-image'), true)
    assert.equal(await page.evaluate(() => window.mcpAppFixture.calls.some(call => ['start_capture', 'pick_capture_source'].includes(call.command))), false)
    await expect(importRow).toContainText('已完成')
    await expect(importRow.getByRole('button', { name: /取消 MCP 任务/ })).toHaveCount(0)
    assert.equal((await tool(page, 'project_get')).assets.some(asset => asset.id === 'mcp-import-image'), true, '任务弹窗保持打开时异步结果仍写入工程')
    console.log('PASS 完整App桥接模拟：MCP任务在处理任务弹窗显示进度，既有视频导出保留，查看期间异步操作正常完成')

    // Viewing the task list is read-only and must also permit a later remote task.
    const cancelling = await tool(page, 'asset_import', { paths: ['/fixture/cancelled.png'] })
    const cancelRow = tasks.locator(`[data-mcp-job-id="${cancelling.jobId}"]`)
    await expect(cancelRow).toContainText('正在处理')
    await page.evaluate(() => window.mcpAppFixture.close())
    await expect(tasks).toBeVisible()
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('.app-error')).toContainText('处理任务')
    assert.equal(await page.evaluate(() => window.mcpAppFixture.calls.some(call => call.command === 'close_native_window')), false)
    await tasks.getByRole('button', { name: '关闭任务', exact: true }).click()
    await expect(processingBanner).toBeVisible()
    const beforeCancelGeometry = await editorGeometry(page)
    await page.getByTestId('mcp-processing-cancel').click()
    await expect(page.getByTestId('mcp-processing-cancel')).toBeDisabled()
    await expect(processingBanner).toContainText('正在取消')
    assert.deepEqual(await editorGeometry(page), beforeCancelGeometry, '取消阶段文案变化不能推移编辑器或时间线')
    await assertFloatingBar(page)
    await page.getByTestId('mcp-processing-tasks').click()
    await expect(cancelRow).toContainText('正在取消')
    await expect(cancelRow.getByRole('button', { name: /取消 MCP 任务/ })).toBeDisabled()
    await page.evaluate(() => window.mcpAppFixture.releaseImport([{ id: 'cancelled-import', name: '不得入库.png', kind: 'image', url: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png', width: 24, height: 24, duration: 0, size: 8 }]))
    await expect(cancelRow).toContainText('已取消')
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    await expect(processingBanner).not.toBeVisible()
    assert.equal((await tool(page, 'job_get', { id: cancelling.jobId })).state, 'cancelled')
    assert.equal((await tool(page, 'asset_list')).assets.some(asset => asset.id === 'cancelled-import'), false)
    console.log('PASS MCP全局悬浮状态：固定44px，工具/阶段与取消状态变化不推移编辑器及时间线，详情浮层与390px窄屏不溢出，取消可达')
    await page.evaluate(() => window.mcpAppFixture.close())
    const closeDialog = page.getByRole('dialog', { name: '关闭应用', exact: true })
    await expect(closeDialog).toBeVisible()
    const beforeModalImportCalls = await page.evaluate(() => window.mcpAppFixture.calls.filter(call => call.command === 'mcp_import_media_paths').length)
    const blockedByModal = await completion(page, await enqueue(page, 'asset_import', { paths: ['/fixture/modal-blocked.png'] }))
    assert.equal(blockedByModal.isError, true)
    assert.match(JSON.stringify(blockedByModal.result), /其他操作|稍后|等待/)
    assert.equal(await page.evaluate(() => window.mcpAppFixture.calls.filter(call => call.command === 'mcp_import_media_paths').length), beforeModalImportCalls)
    await closeDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(closeDialog).not.toBeVisible()
    await tasks.getByRole('button', { name: '关闭任务', exact: true }).click()
    await page.getByTestId('editor-mcp-open').click()
    await expect(dialog).toBeVisible()
    await expect(tasks).not.toBeVisible()
    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    assert.equal(await page.evaluate(() => window.mcpAppFixture.calls.some(call => call.command === 'close_native_window')), false)
    console.log('PASS 完整App桥接模拟：任务列表允许后续MCP操作与取消，忙时原生关闭导向任务，迟到结果不入库，确认弹窗仍阻止新操作')

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
    await expect(page.getByTestId('mcp-service-switch')).toBeEnabled()
    await page.screenshot({ path: '/tmp/open-media-mcp-app.png', fullPage: true })
    await page.getByTestId('mcp-service-switch').click()
    await expect(page.getByRole('switch', { name: 'MCP 服务开关' })).toHaveAttribute('aria-checked', 'false')
    assert.equal(await page.evaluate(() => window.mcpAppFixture.playbackSignal.aborted), true, '服务停止必须立即中止播放准备，而非等准备结束后才暂停')
    await page.evaluate(() => { window.mcpAppFixture.releasePlayback(); window.mcpAppFixture.restorePlaybackPreparation() })
    await page.getByTestId('mcp-service-switch').click()
    await expect(page.getByRole('switch', { name: 'MCP 服务开关' })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    assert.equal((await tool(page, 'playback_get')).playing, false)
    assert.equal(await page.evaluate(id => window.mcpAppFixture.completions.some(item => item.id === id && !item.isError), playbackId), false)
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    console.log('PASS 完整App桥接模拟：跨工作区远程播放在异步准备期间停服立即中止，迟到准备结果不启动播放')

    // A native export must remain cancellable when window close comes from an open MCP dialog.
    await page.evaluate(() => window.mcpAppFixture.mediaJobs.push({ id: 'running-export', name: '进行中的视频导出', state: 'running', progress: 0.4 }))
    await page.waitForFunction(() => document.querySelector('#app').__vue_app__._instance.setupState.runningJobs === 1)
    await page.getByTestId('editor-mcp-open').click()
    await expect(dialog).toBeVisible()
    await page.evaluate(() => window.mcpAppFixture.close())
    await expect(tasks).toBeVisible()
    await expect(dialog).not.toBeVisible()
    await expect(tasks.getByRole('button', { name: '关闭任务', exact: true })).toBeFocused()
    const nativeExport = tasks.locator('[data-media-job-id="running-export"]')
    await expect(nativeExport).toContainText('正在处理')
    await nativeExport.getByRole('button', { name: '取消任务', exact: true }).click()
    await expect(nativeExport).toContainText('已取消')
    assert.equal(await page.evaluate(() => window.mcpAppFixture.calls.some(call => call.command === 'close_native_window')), false)
    await page.screenshot({ path: '/tmp/open-media-processing-tasks.png', fullPage: true })
    console.log('PASS 完整App桥接模拟：MCP设置中关闭窗口会切到媒体处理任务，焦点进入任务弹窗，普通导出仍能取消')

    assert.deepEqual(await page.evaluate(() => window.mcpAppFixture.unexpected), [])
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
