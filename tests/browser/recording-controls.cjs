const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 244, height: 44 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const callbacks = new Map(), listeners = new Map()
      let nextCallback = 0, nextListener = 0
      const state = { calls: [], actions: [], rejectAction: '', snapshot: { phase: 'recording', elapsed: 8.4, muted: false, audioAvailable: true, microphoneEnabled: true, busy: false } }
      state.publish = update => {
        state.snapshot = { ...state.snapshot, ...update }
        for (const [id, listener] of listeners) if (listener.event === 'capture-controls-state') callbacks.get(listener.handler)?.({ event: listener.event, id, payload: { ...state.snapshot } })
      }
      window.controlsHarness = state
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => listeners.delete(id) }
      window.__TAURI_INTERNALS__ = {
        transformCallback: callback => { const id = ++nextCallback; callbacks.set(id, callback); return id },
        unregisterCallback: id => callbacks.delete(id),
        invoke: async (command, args) => {
          state.calls.push({ command, args })
          if (command === 'plugin:event|listen') { const id = ++nextListener; listeners.set(id, args); return id }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null }
          if (command === 'capture_controls_ready') {
            if (new URLSearchParams(location.search).has('delay-ready')) return new Promise(resolve => { state.resolveReady = resolve })
            return { ...state.snapshot }
          }
          if (command === 'capture_controls_action') {
            state.actions.push(args.action)
            if (state.rejectAction) { const message = state.rejectAction; state.rejectAction = ''; throw new Error(message) }
            return null
          }
          throw new Error(`浮栏不应调用：${command}`)
        },
      }
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?recording-controls`)
    const toolbar = page.getByTestId('recording-toolbar')
    const clockSeconds = async () => (await toolbar.locator('.recording-clock').innerText()).split(':').reduce((value, part) => value * 60 + Number(part), 0)
    await expect(toolbar).toBeVisible()
    await expect(toolbar.getByRole('button', { name: '暂停录制', exact: true })).toBeEnabled()
    await expect(toolbar.locator('.recording-clock')).toHaveText('00:00:08')
    assert.equal(await page.locator('.app-shell').count(), 0, '浮栏路由不加载主工作区')
    const trace = await page.evaluate(() => window.controlsHarness.calls)
    assert(trace.findIndex(call => call.command === 'plugin:event|listen') < trace.findIndex(call => call.command === 'capture_controls_ready'))
    assert.equal(trace.find(call => call.command === 'plugin:event|listen').args.event, 'capture-controls-state')
    const bounds = await toolbar.boundingBox()
    assert.deepEqual(bounds, { x: 0, y: 0, width: 244, height: 44 })
    assert.deepEqual(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })), { width: 244, height: 44 })
    assert.equal(await toolbar.locator('button svg').count(), 3)
    const output = '/tmp/open-media-recording-controls'
    fs.mkdirSync(output, { recursive: true })
    await page.screenshot({ path: path.join(output, 'recording.png') })
    console.log('PASS 独立浮栏路由仅加载录制控制，244×44 布局无溢出、操作图标均为 SVG')
    const initialSeconds = await clockSeconds()
    await page.waitForTimeout(1250)
    assert(await clockSeconds() >= initialSeconds + 1, '没有新状态事件时，录制时长仍由浮栏持续推进')
    assert.equal(await page.evaluate(() => window.controlsHarness.snapshot.elapsed), 8.4)
    assert.equal(await page.evaluate(() => window.controlsHarness.calls.filter(call => call.command === 'capture_controls_ready').length), 1)

    await toolbar.getByRole('button', { name: '暂停录制', exact: true }).click()
    await expect(toolbar.locator('button:disabled')).toHaveCount(3)
    await toolbar.getByRole('button', { name: '暂停录制', exact: true }).evaluate(element => element.click())
    await expect.poll(() => page.evaluate(() => window.controlsHarness.actions)).toEqual(['pause'])
    await page.evaluate(() => window.controlsHarness.publish({ phase: 'paused', elapsed: 9.7, busy: false }))
    await expect(toolbar.getByRole('button', { name: '继续录制', exact: true })).toBeEnabled()
    await expect(toolbar.locator('.recording-clock')).toHaveText('00:00:09')
    await page.waitForTimeout(1250)
    await expect(toolbar.locator('.recording-clock')).toHaveText('00:00:09')
    await toolbar.getByRole('button', { name: '关闭麦克风', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.controlsHarness.actions)).toEqual(['pause', 'toggle-microphone'])
    await page.evaluate(() => window.controlsHarness.publish({ muted: true, microphoneEnabled: false, busy: false }))
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(toolbar.getByRole('button', { name: '继续录制', exact: true })).toBeEnabled()
    await page.screenshot({ path: path.join(output, 'paused-muted.png') })
    await toolbar.getByRole('button', { name: '继续录制', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.controlsHarness.actions)).toEqual(['pause', 'toggle-microphone', 'resume'])
    await page.evaluate(() => window.controlsHarness.publish({ phase: 'recording', elapsed: 9.7, busy: false }))
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(toolbar.locator('.recording-clock')).toHaveText('00:00:09')
    await page.waitForTimeout(1250)
    assert(await clockSeconds() >= 10, '继续录制从暂停时长累加，不重置，也不计入暂停时间')
    await page.evaluate(() => window.controlsHarness.publish({ elapsed: 75.1 }))
    await expect(toolbar.locator('.recording-clock')).toHaveText('00:01:15')
    console.log('PASS 无状态事件时录制计时继续、暂停冻结、恢复接续累计，新原生快照校准时长')
    assert.deepEqual(await page.evaluate(() => window.controlsHarness.actions), ['pause', 'toggle-microphone', 'resume'])
    console.log('PASS 状态事件更新时长与暂停/继续/麦克风开关，等待主录制确认期间防止重复点击')

    await page.evaluate(() => { window.controlsHarness.rejectAction = '控制请求暂时失败，请重试。' })
    await toolbar.getByRole('button', { name: '开启麦克风', exact: true }).click()
    await expect(toolbar.getByRole('status')).toContainText('控制请求暂时失败')
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toBeEnabled()
    await page.evaluate(() => window.controlsHarness.publish({ audioAvailable: false, microphoneEnabled: false, error: null }))
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toBeEnabled()
    await toolbar.getByRole('button', { name: '开启麦克风', exact: true }).click()
    await page.evaluate(() => window.controlsHarness.publish({ busy: true, microphonePending: true }))
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toBeDisabled()
    await expect(toolbar.getByRole('button', { name: '暂停录制', exact: true })).toBeDisabled()
    await expect(toolbar.getByRole('button', { name: '停止录制', exact: true })).toBeEnabled()
    await toolbar.getByRole('button', { name: '停止录制', exact: true }).click()
    await page.evaluate(() => window.controlsHarness.publish({ phase: 'stopping', busy: true }))
    await expect(toolbar.locator('button:disabled')).toHaveCount(3)
    await expect.poll(() => page.evaluate(() => window.controlsHarness.actions.filter(action => action === 'stop').length)).toBe(1)
    const stoppingSeconds = await clockSeconds()
    await page.waitForTimeout(1250)
    assert.equal(await clockSeconds(), stoppingSeconds, '保存期间停止累计录制时长')
    console.log('PASS 请求失败可重试，未开启录音仍可打开麦克风，等待授权可停止，保存时锁定操作；原生桥与系统窗口为模拟')

    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?recording-controls&delay-ready`)
    await page.waitForFunction(() => typeof window.controlsHarness.resolveReady === 'function')
    await page.evaluate(() => window.controlsHarness.publish({ phase: 'paused', elapsed: 21.2, muted: true, microphoneEnabled: false, busy: false }))
    await expect(toolbar.getByRole('button', { name: '继续录制', exact: true })).toBeEnabled()
    await page.evaluate(async () => {
      window.controlsHarness.resolveReady({ phase: 'recording', elapsed: 8.4, muted: false, audioAvailable: true, microphoneEnabled: true, busy: false })
      await new Promise(requestAnimationFrame)
    })
    await expect(toolbar.getByRole('button', { name: '继续录制', exact: true })).toBeEnabled()
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(toolbar.locator('.recording-clock')).toHaveText('00:00:21')
    assert.deepEqual(errors, [])
    console.log('PASS 晚到初始状态不会覆盖已收到的暂停、时长与麦克风状态')
  } finally { await browser?.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
