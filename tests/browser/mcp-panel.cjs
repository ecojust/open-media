const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'mcp-panel') : fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-mcp-panel-'))
  fs.mkdirSync(artifacts, { recursive: true })
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
      const fixture = window.mcpFixture = {
        open: ref(true), native: ref(false), theme: ref('light'), calls: [], events: [], clipboard: '',
        failStatus: false, failConfig: false, failStart: false, failClipboard: false, failConfigOnStart: false,
        holdConfig: false, holdStart: false, holdStop: false,
        config: { host: '127.0.0.1', port: 39861, token: 'a'.repeat(64) }, running: false, nextPort: 41239,
        jobs: ref([{ id: 'speech-1', name: '字幕转语音', state: 'running', progress: .47, stage: '第 2 / 5 段', cancelable: true }]),
      }
      const snapshot = () => ({ running: fixture.running, host: fixture.config.host, port: fixture.config.port,
        url: fixture.running ? `http://${fixture.config.host}:${fixture.config.port}/mcp` : null, pendingRequests: 0 })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
        if (fixture.failClipboard) throw new Error('剪贴板访问被拒绝')
        fixture.clipboard = text
      } } })
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        fixture.calls.push({ command, args })
        if (command === 'mcp_get_config') {
          if (fixture.failConfig) throw new Error('本机配置暂时不可读取')
          if (fixture.holdConfig) return new Promise(resolve => {
            const saved = { ...fixture.config }
            fixture.releaseConfig = () => { fixture.holdConfig = false; resolve(saved) }
          })
          return { ...fixture.config }
        }
        if (command === 'mcp_get_status') { if (fixture.failStatus) throw new Error('暂时无法访问服务状态'); return snapshot() }
        if (command === 'mcp_start') {
          if (fixture.failStart) throw new Error('无法建立 MCP 监听')
          const start = () => {
            fixture.config.port = fixture.nextPort
            fixture.running = true
            if (fixture.failConfigOnStart) fixture.failConfig = true
            return snapshot()
          }
          if (fixture.holdStart) return new Promise(resolve => { fixture.releaseStart = () => { fixture.holdStart = false; resolve(start()) } })
          return start()
        }
        if (command === 'mcp_stop') {
          const stop = () => { fixture.running = false; return snapshot() }
          if (fixture.holdStop) return new Promise(resolve => { fixture.releaseStop = () => { fixture.holdStop = false; resolve(stop()) } })
          return stop()
        }
        if (command === 'mcp_pending') return []
        if (command === 'mcp_claim') return args.id === 'request-1'
        if (command === 'mcp_complete') return args.id === 'request-1'
        throw new Error(`未知模拟命令 ${command}`)
      } }
      fixture.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': fixture.theme.value }, h(Panel, {
        open: fixture.open.value, native: fixture.native.value, jobs: fixture.jobs.value,
        onClose: () => { fixture.open.value = false }, onStatus: value => fixture.events.push(['status', value]),
        onServiceChange: value => fixture.events.push(['service', value]), onCancelJob: id => fixture.events.push(['cancel', id]),
      })) })
      fixture.app.mount('#app')
    })
    const dialog = page.getByRole('dialog', { name: 'MCP 服务', exact: true })
    const toggle = page.getByRole('switch', { name: 'MCP 服务开关', exact: true })
    const copy = page.getByRole('button', { name: '复制配置', exact: true })
    const address = page.getByLabel('MCP 连接地址', { exact: true })
    const token = page.getByLabel('MCP Token', { exact: true })
    await expect(dialog).toContainText('MCP 服务由桌面端提供')
    assert.deepEqual(await page.evaluate(() => window.mcpFixture.calls), [], '网页模式不得调用原生服务')
    await expect(toggle).toHaveCount(0)
    await expect(copy).toHaveCount(0)
    await expect(dialog.locator('details, progress, pre')).toHaveCount(0)
    await page.evaluate(() => { window.mcpFixture.open.value = false })
    await expect(dialog).not.toBeVisible()
    await page.evaluate(() => { window.mcpFixture.native.value = true; window.mcpFixture.holdConfig = true; window.mcpFixture.open.value = true })
    await expect(dialog).toContainText('正在读取…')
    await expect(toggle).toBeDisabled()
    await expect(copy).toBeDisabled()
    assert.equal(await page.evaluate(() => window.mcpFixture.calls.some(call => call.command === 'mcp_start')), false, '打开设置不能自动启动服务')
    await page.waitForFunction(() => typeof window.mcpFixture.releaseConfig === 'function')
    await page.evaluate(() => window.mcpFixture.releaseConfig())
    await expect(dialog).toContainText('未启动')
    await expect(toggle).toBeEnabled()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(copy).toBeDisabled()
    await expect(address).toHaveValue('http://127.0.0.1:39861/mcp')
    await expect(token).toHaveValue('a'.repeat(64))
    await expect(token).toHaveAttribute('type', 'text')
    await expect(dialog.locator('input')).toHaveCount(2)
    assert.equal(await address.evaluate(input => input.readOnly), true)
    assert.equal(await token.evaluate(input => input.readOnly), true)
    await token.focus()
    assert.deepEqual(await token.evaluate(input => [input.selectionStart, input.selectionEnd]), [0, 64], '只读Token可选中后手动复制')
    await expect(page.getByLabel('MCP 监听 IP', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('MCP 端口', { exact: true })).toHaveCount(0)
    await expect(dialog.locator('details, progress, pre')).toHaveCount(0)
    await expect(dialog).not.toContainText('自动化任务')
    await expect(dialog).not.toContainText('开放的功能')
    await expect(dialog).not.toHaveClass(/wide/)
    const compact = await dialog.boundingBox()
    assert(compact.width <= 480 && compact.height < 340, `MCP弹窗应保持紧凑：${JSON.stringify(compact)}`)
    assert((await dialog.evaluate(element => getComputedStyle(element, '::backdrop').backdropFilter)).includes('blur'), '沿用统一毛玻璃遮罩')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(copy).toBeEnabled()
    await expect(dialog).toContainText('运行中')
    await expect(address).toHaveValue('http://127.0.0.1:41239/mcp')
    const commands = await page.evaluate(() => window.mcpFixture.calls.map(call => call.command))
    assert.equal(commands.filter(command => command === 'mcp_start').length, 1)
    assert.equal(commands.includes('mcp_save_config'), false, '面板不再写入用户地址/端口配置')
    assert(commands.slice(commands.indexOf('mcp_start') + 1).includes('mcp_get_config'), '启动自动选择端口后必须重新读取实际配置')
    await copy.click()
    await expect(dialog).toContainText('配置已复制')
    const copied = JSON.parse(await page.evaluate(() => window.mcpFixture.clipboard))
    assert.deepEqual(copied, { mcpServers: { 'open-media': { type: 'http', url: 'http://127.0.0.1:41239/mcp', headers: { Authorization: `Bearer ${'a'.repeat(64)}` } } } })
    await page.screenshot({ path: path.join(artifacts, 'mcp-compact-desktop.png'), animations: 'disabled' })
    await page.evaluate(() => { window.mcpFixture.theme.value = 'dark' })
    await page.screenshot({ path: path.join(artifacts, 'mcp-compact-dark.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 380, height: 740 })
    const narrow = await dialog.boundingBox()
    assert(narrow.width <= 356 && narrow.height < 400)
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1), false)
    await page.screenshot({ path: path.join(artifacts, 'mcp-compact-narrow.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 1280, height: 960 })
    await page.evaluate(() => { window.mcpFixture.theme.value = 'light'; window.mcpFixture.failClipboard = true })
    await copy.click()
    await expect(dialog.getByRole('alert')).toContainText('剪贴板访问被拒绝')
    await page.evaluate(() => { window.mcpFixture.failClipboard = false })
    await copy.click()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    assert.equal(await page.evaluate(() => window.mcpFixture.running), true, '关闭弹窗保持服务运行')
    await page.evaluate(() => { window.mcpFixture.open.value = true })
    await expect(copy).toBeEnabled()
    await expect(token).toHaveValue('a'.repeat(64))
    await expect(address).toHaveValue('http://127.0.0.1:41239/mcp')
    await page.evaluate(() => { window.mcpFixture.failStatus = true })
    await expect(dialog).toContainText('状态暂不可用')
    await expect(copy).toBeDisabled()
    await expect(dialog.getByRole('alert')).toContainText('暂时无法访问服务状态')
    await page.evaluate(() => { window.mcpFixture.failStatus = false })
    await expect(copy).toBeEnabled()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    const beforeStop = await page.evaluate(async () => (await import('/src/native-mcp.ts')).getMcpServiceEpoch())
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(toggle).toBeEnabled()
    await expect(copy).toBeDisabled()
    await expect(address).toHaveValue('http://127.0.0.1:41239/mcp')
    assert((await page.evaluate(async () => (await import('/src/native-mcp.ts')).getMcpServiceEpoch())) > beforeStop)
    await page.evaluate(() => { window.mcpFixture.failStart = true })
    await toggle.click()
    await expect(dialog.getByRole('alert')).toContainText('无法建立 MCP 监听')
    await expect(toggle).toBeEnabled()
    await expect(copy).toBeDisabled()
    assert.equal(await page.evaluate(() => window.mcpFixture.running), false)
    await page.evaluate(() => { window.mcpFixture.failStart = false; window.mcpFixture.failConfigOnStart = true; window.mcpFixture.nextPort = 43105 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(toggle).toBeEnabled()
    await expect(address).toHaveValue('http://127.0.0.1:43105/mcp')
    await expect(token).toHaveValue('')
    await expect(copy).toBeDisabled()
    await expect(dialog.getByRole('alert')).toContainText('本机配置暂时不可读取')
    await page.evaluate(() => { window.mcpFixture.failConfig = false; window.mcpFixture.failConfigOnStart = false })
    await expect(copy).toBeEnabled()
    await expect(token).toHaveValue('a'.repeat(64))
    await copy.click()
    assert.equal(JSON.parse(await page.evaluate(() => window.mcpFixture.clipboard)).mcpServers['open-media'].url, 'http://127.0.0.1:43105/mcp')
    console.log('PASS MCP精简面板：只读地址/Token、紧凑开关、默认不启动、fallback实际端口、完整配置复制、桌面限制、状态/配置/剪贴板失败恢复与窄屏布局')

    await page.evaluate(() => { window.mcpFixture.holdStop = true })
    await toggle.click()
    await expect(toggle).toBeDisabled()
    await expect(copy).toBeDisabled()
    await expect(page.getByRole('button', { name: '关闭MCP 服务', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await page.waitForFunction(() => typeof window.mcpFixture.releaseStop === 'function')
    const stopEvents = await page.evaluate(() => window.mcpFixture.events.length)
    await page.evaluate(() => { window.mcpFixture.open.value = false; window.mcpFixture.releaseStop() })
    await expect(dialog).not.toBeVisible()
    await expect.poll(() => page.evaluate(start => window.mcpFixture.events.slice(start).some(([name, status]) => name === 'service' && !status.running), stopEvents)).toBe(true)
    await page.evaluate(() => { window.mcpFixture.open.value = true })
    await expect(toggle).toBeEnabled()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await page.evaluate(() => { window.mcpFixture.holdStart = true; window.mcpFixture.nextPort = 45017 })
    await toggle.click()
    await expect(toggle).toBeDisabled()
    await page.waitForFunction(() => typeof window.mcpFixture.releaseStart === 'function')
    const startEvents = await page.evaluate(() => window.mcpFixture.events.length)
    await page.evaluate(() => { window.mcpFixture.open.value = false; window.mcpFixture.releaseStart() })
    await expect(dialog).not.toBeVisible()
    await expect.poll(() => page.evaluate(start => window.mcpFixture.events.slice(start).some(([name, status]) => name === 'service' && status.running && status.port === 45017), startEvents)).toBe(true)
    await page.evaluate(() => { window.mcpFixture.open.value = true })
    await expect(copy).toBeEnabled()
    await expect(address).toHaveValue('http://127.0.0.1:45017/mcp')
    const bridge = await page.evaluate(async () => {
      const api = await import('/src/native-mcp.ts')
      return { pending: await api.getPendingMcpRequests(), claimed: await api.claimMcpRequest('request-1'), completed: await api.completeMcpRequest('request-1', { ok: true }) }
    })
    assert.deepEqual(bridge, { pending: [], claimed: true, completed: true })
    const stopRace = await page.evaluate(async () => {
      const api = await import('/src/native-mcp.ts'), fixture = window.mcpFixture
      fixture.holdStop = true; fixture.releaseStop = undefined
      const before = api.getMcpServiceEpoch(), pending = api.stopMcpService(), immediate = api.getMcpServiceEpoch()
      while (!fixture.releaseStop) await new Promise(resolve => setTimeout(resolve, 0))
      fixture.releaseStop(); await pending
      return { before, immediate }
    })
    assert(stopRace.immediate > stopRace.before, '停服必须在原生请求返回前使已领取请求失效')
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('a'.repeat(64))), false)
    assert.deepEqual(errors, [])
    console.log('PASS MCP异步生命周期：忙态保护、外部关闭仍回传实际启停状态、重开读取最新地址、请求桥与停服epoch；原生契约模拟，非真实监听服务测试')
    console.log(`截图：${artifacts}`)
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
