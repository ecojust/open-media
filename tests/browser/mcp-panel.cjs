const assert = require('node:assert/strict')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(15000)
  try {
    await page.route('**/__mcp_panel__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>body{margin:0;font-family:sans-serif}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__mcp_panel__`)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const source = await (await fetch('/src/components/McpPanel.vue')).text()
      const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
      const { createApp, h, ref } = await import(vueURL)
      const Panel = (await import('/src/components/McpPanel.vue')).default
      const fixture = window.mcpFixture = { open: ref(true), native: ref(false), calls: [], events: [], clipboard: '', failStatus: false, failStart: false,
        config: { host: '127.0.0.1', port: 39861, token: 'a'.repeat(64) }, running: false,
        jobs: ref([{ id: 'speech-1', name: '字幕转语音', state: 'running', progress: .47, stage: '第 2 / 5 段', cancelable: true }]),
      }
      const snapshot = () => ({ running: fixture.running, host: fixture.config.host, port: fixture.config.port,
        url: fixture.running ? `http://${fixture.config.host === '0.0.0.0' ? '127.0.0.1' : fixture.config.host}:${fixture.config.port}/mcp` : null, pendingRequests: 0 })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { fixture.clipboard = text } } })
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        fixture.calls.push({ command, args })
        if (command === 'mcp_get_config') return { ...fixture.config }
        if (command === 'mcp_get_status') { if (fixture.failStatus) throw new Error('暂时无法访问'); return snapshot() }
        if (command === 'mcp_save_config') {
          if (fixture.running) throw new Error('服务运行中')
          fixture.config = { ...args.config, token: args.config.token || 'b'.repeat(64) }; return { ...fixture.config }
        }
        if (command === 'mcp_start') { if (fixture.failStart) throw new Error('端口已被占用'); fixture.running = true; return snapshot() }
        if (command === 'mcp_stop') {
          if (fixture.holdStop) return new Promise(resolve => { fixture.releaseStop = () => { fixture.running = false; resolve(snapshot()) } })
          fixture.running = false; return snapshot()
        }
        if (command === 'mcp_pending') return []
        if (command === 'mcp_claim') return args.id === 'request-1'
        if (command === 'mcp_complete') return args.id === 'request-1'
        throw new Error(`未知模拟命令 ${command}`)
      } }
      fixture.app = createApp({ render: () => h(Panel, { open: fixture.open.value, native: fixture.native.value, jobs: fixture.jobs.value,
        onClose: () => { fixture.open.value = false }, onStatus: value => fixture.events.push(['status', value]),
        onServiceChange: value => fixture.events.push(['service', value]), onCancelJob: id => fixture.events.push(['cancel', id]),
      }) })
      fixture.app.mount('#app')
    })
    const dialog = page.getByRole('dialog', { name: 'MCP 服务', exact: true })
    await expect(dialog).toContainText('MCP 服务由桌面端提供')
    assert.deepEqual(await page.evaluate(() => window.mcpFixture.calls), [], '网页模式不得调用原生服务')
    await expect(page.getByTestId('mcp-start')).toHaveCount(0)
    await page.evaluate(() => { window.mcpFixture.open.value = false })
    await expect(dialog).not.toBeVisible()
    await page.evaluate(() => { window.mcpFixture.native.value = true; window.mcpFixture.open.value = true })
    await expect(dialog).toContainText('服务已停止')
    await expect(page.getByLabel('MCP 监听 IP', { exact: true })).toHaveValue('127.0.0.1')
    await expect(page.getByLabel('MCP 端口', { exact: true })).toHaveValue('39861')
    await expect(page.getByLabel('MCP Token', { exact: true })).toHaveAttribute('type', 'password')
    await page.getByLabel('MCP 端口', { exact: true }).fill('65536')
    await expect(page.getByTestId('mcp-start')).toBeDisabled()
    await page.getByLabel('MCP 端口', { exact: true }).fill('40001')
    await page.getByLabel('MCP Token', { exact: true }).fill('short')
    await expect(page.getByTestId('mcp-start')).toBeDisabled()
    await page.getByLabel('MCP Token', { exact: true }).fill('')
    await page.getByLabel('MCP 监听 IP', { exact: true }).fill('0.0.0.0')
    await page.getByTestId('mcp-start').click()
    await expect(dialog).toContainText('服务运行中')
    await expect(page.getByLabel('MCP 监听 IP', { exact: true })).toBeDisabled()
    await expect(page.getByLabel('MCP 连接地址', { exact: true })).toHaveValue('http://127.0.0.1:40001/mcp')
    await expect(dialog).toContainText('局域网 IP')
    const mutationCommands = await page.evaluate(() => window.mcpFixture.calls.filter(call => ['mcp_start', 'mcp_save_config'].includes(call.command)))
    assert.deepEqual(mutationCommands.map(call => call.command), ['mcp_save_config', 'mcp_start'])
    assert.equal(mutationCommands[0].args.config.token, '')
    await page.getByRole('button', { name: '复制 MCP 地址', exact: true }).click()
    assert.equal(await page.evaluate(() => window.mcpFixture.clipboard), 'http://127.0.0.1:40001/mcp')
    await dialog.locator('summary').filter({ hasText: '客户端配置' }).click()
    await expect(page.getByTestId('mcp-client-config')).not.toContainText('b'.repeat(64))
    await page.getByRole('button', { name: '复制配置（含 Token）', exact: true }).click()
    const copied = JSON.parse(await page.evaluate(() => window.mcpFixture.clipboard))
    assert.equal(copied.mcpServers['open-media'].headers.Authorization, `Bearer ${'b'.repeat(64)}`)
    assert.equal(copied.mcpServers['open-media'].type, 'http')
    await page.getByRole('button', { name: '显示 Token', exact: true }).click()
    await expect(page.getByTestId('mcp-client-config')).toContainText('b'.repeat(64))
    await expect(dialog.locator('progress')).toHaveAttribute('value', '47')
    await page.getByRole('button', { name: '取消任务 字幕转语音', exact: true }).click()
    assert((await page.evaluate(() => window.mcpFixture.events)).some(([name, id]) => name === 'cancel' && id === 'speech-1'))
    await page.evaluate(() => { window.mcpFixture.jobs.value = [{ ...window.mcpFixture.jobs.value[0], cancelling: true }] })
    await expect(page.getByRole('button', { name: '取消任务 字幕转语音', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    assert.equal(await page.evaluate(() => window.mcpFixture.running), true, '关闭弹窗保持服务运行')
    await page.evaluate(() => { window.mcpFixture.open.value = true })
    await expect(page.getByLabel('MCP Token', { exact: true })).toHaveAttribute('type', 'password')
    await page.evaluate(() => { window.mcpFixture.failStatus = true })
    await page.getByRole('button', { name: '刷新 MCP 状态', exact: true }).click()
    await expect(dialog).toContainText('状态暂不可用')
    await page.evaluate(() => { window.mcpFixture.failStatus = false })
    await page.getByRole('button', { name: '刷新 MCP 状态', exact: true }).click()
    await expect(dialog).toContainText('服务运行中')
    const beforeStop = await page.evaluate(async () => (await import('/src/native-mcp.ts')).getMcpServiceEpoch())
    await page.getByTestId('mcp-stop').click()
    await expect(dialog).toContainText('服务已停止')
    assert((await page.evaluate(async () => (await import('/src/native-mcp.ts')).getMcpServiceEpoch())) > beforeStop)
    await page.getByLabel('MCP 监听 IP', { exact: true }).fill('127.0.0.1')
    await page.getByRole('button', { name: '重新生成 Token', exact: true }).click()
    await expect(page.getByLabel('MCP 监听 IP', { exact: true })).toHaveValue('127.0.0.1')
    assert.equal(await page.evaluate(() => window.mcpFixture.config.host), '0.0.0.0', 'Token重置不隐式保存其他未保存修改')
    await expect(dialog).toContainText('上方设置尚未保存')
    await page.evaluate(() => { window.mcpFixture.failStart = true })
    await page.getByTestId('mcp-start').click()
    await expect(dialog.getByRole('alert')).toContainText('端口已被占用')
    await expect(page.getByTestId('mcp-start')).toBeEnabled()
    assert.equal(await page.evaluate(() => window.mcpFixture.running), false)
    await dialog.locator('summary').filter({ hasText: '开放的功能' }).click()
    await expect(dialog).toContainText('speech_generate')
    await expect(dialog).toContainText('track_add')
    const bridge = await page.evaluate(async () => {
      const api = await import('/src/native-mcp.ts')
      return { pending: await api.getPendingMcpRequests(), claimed: await api.claimMcpRequest('request-1'), completed: await api.completeMcpRequest('request-1', { ok: true }) }
    })
    assert.deepEqual(bridge, { pending: [], claimed: true, completed: true })
    const stopRace = await page.evaluate(async () => {
      const api = await import('/src/native-mcp.ts'), fixture = window.mcpFixture
      fixture.holdStop = true
      const before = api.getMcpServiceEpoch(), pending = api.stopMcpService(), immediate = api.getMcpServiceEpoch()
      while (!fixture.releaseStop) await new Promise(resolve => setTimeout(resolve, 0))
      fixture.releaseStop(); await pending
      return { before, immediate }
    })
    assert(stopRace.immediate > stopRace.before, '停服必须在原生请求返回前使已领取请求失效')
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('b'.repeat(64))), false)
    assert.deepEqual(errors, [])
    console.log('PASS MCP面板交互模拟：桌面限制、配置校验/保存、启停、Token显隐/更新、地址配置复制、状态异常、任务取消与bridge命令（非真实服务测试）')
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
