const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '../..')
const defaultShortcut = 'CommandOrControl+Shift+2'
const selection = { sourceId: 'screen:1', sourceName: '屏幕 1', sourceWidth: 1920, sourceHeight: 1080, region: { x: 100, y: 80, width: 64, height: 40 } }

// The bridge is mocked; PNG decoding and the application UI use real browser APIs.
async function installNativeContract(page) {
  await page.addInitScript(() => {
    const callbacks = new Map(), listeners = new Map(), urls = new Map()
    let callbackId = 0, listenerId = 0, assetId = 0
    const state = { calls: [], shortcut: null, rejectShortcut: null, picker: null, capture: null, completed: [], unexpected: [] }
    function asset(name, width, height, color) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, width, height)
      const url = canvas.toDataURL('image/png'), id = `native-screenshot-fixture-${++assetId}`, nativePath = `/screenshot-fixture/${id}.png`
      urls.set(nativePath, url)
      return { id, name, kind: 'image', nativePath, url: '', mime: 'image/png', width, height, duration: 0, size: Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4) }
    }
    state.emitScreenshot = () => {
      for (const [id, listener] of listeners) if (listener.event === 'screenshot-requested') callbacks.get(listener.handler)?.({ event: listener.event, id, payload: null })
    }
    state.finishPicker = value => { const pending = state.picker; state.picker = null; if (!pending) throw new Error('没有待确认的截屏范围'); pending(value) }
    state.finishCapture = () => {
      const pending = state.capture; state.capture = null
      if (!pending) throw new Error('没有待完成的截屏')
      const result = asset(`截屏-${state.completed.length + 1}.png`, 64, 40, '#1a78bc')
      state.completed.push(result)
      pending(result)
    }
    window.screenshotHarness = state
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => listeners.delete(id) }
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => { const id = ++callbackId; callbacks.set(id, callback); return id },
      unregisterCallback: id => callbacks.delete(id),
      convertFileSrc: path => { if (!urls.has(path)) throw new Error(`没有图片样本：${path}`); return urls.get(path) },
      invoke: async (command, args) => {
        state.calls.push({ command, args })
        if (command === 'plugin:event|listen') { const id = ++listenerId; listeners.set(id, args); return id }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null }
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'get_media_jobs') return []
        if (command === 'configure_screenshot_shortcut') {
          if (args.shortcut && args.shortcut === state.rejectShortcut) throw new Error('此快捷键已被占用，请选择其他组合。')
          state.shortcut = args.shortcut
          return args.shortcut
        }
        if (command === 'pick_capture_source') return new Promise(resolve => { state.picker = resolve })
        if (command === 'capture_screenshot') return new Promise(resolve => { state.capture = resolve })
        if (command === 'cancel_capture_picker') { state.picker?.(null); state.picker = null; return null }
        if (command === 'show_main_window') return null
        if (command === 'pick_media_assets') return [asset('已有图片一.png', 32, 20, '#cc4466'), asset('已有图片二.png', 32, 20, '#449944')]
        state.unexpected.push(command)
        throw new Error(`未预期的原生命令：${command}`)
      },
    }
  })
}
async function calls(page, command) { return page.evaluate(command => window.screenshotHarness.calls.filter(call => call.command === command), command) }
async function emitScreenshot(page) { await page.evaluate(() => window.screenshotHarness.emitScreenshot()) }

async function main() {
  let server, browser
  const errors = [], results = []
  const check = async (name, run) => { await run(); results.push(name); console.log(`PASS ${name}`) }
  try {
    let url = process.env.BASE_URL
    if (url) {
      const response = await fetch(url)
      assert(response.ok && (await response.text()).includes('/@vite/client'), '截屏契约验证需要当前源码的开发服务。')
    } else {
      const { createServer } = await import('vite')
      server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
      await server.listen()
      url = `http://127.0.0.1:${server.httpServer.address().port}`
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(error.message))
    await installNativeContract(page)
    await page.goto(url)
    await expect(page.getByTestId('home-workspace')).toBeVisible()

    await check('桌面截屏先订阅事件再注册默认快捷键，不提前读取屏幕或打开录制', async () => {
      await expect.poll(async () => (await calls(page, 'configure_screenshot_shortcut')).length).toBe(1)
      assert.deepEqual((await calls(page, 'configure_screenshot_shortcut'))[0].args, { shortcut: defaultShortcut })
      const trace = await page.evaluate(() => window.screenshotHarness.calls)
      assert(trace.findIndex(call => call.command === 'plugin:event|listen' && call.args.event === 'screenshot-requested') < trace.findIndex(call => call.command === 'configure_screenshot_shortcut'))
      for (const command of ['pick_capture_source', 'capture_screenshot', 'start_capture', 'list_capture_devices', 'show_main_window']) assert.equal((await calls(page, command)).length, 0)
      await page.getByTestId('nav-record').click()
      await expect(page.getByTestId('screenshot-shortcut')).toContainText('Ctrl + Shift + 2')
      await expect(page.getByTestId('screenshot-controls')).toContainText('全局生效')
    })

    await check('原生事件选择截屏范围，等待完成才前置应用，仅选中新图片并显示真实PNG', async () => {
      await page.getByTestId('nav-image').click()
      await page.getByRole('button', { name: '导入图片', exact: true }).click()
      await expect(page.locator('.convert-source')).toHaveCount(2)
      await expect(page.locator('.convert-source input:checked')).toHaveCount(2)
      await page.locator('.brand').click()
      await emitScreenshot(page)
      await expect.poll(async () => (await calls(page, 'pick_capture_source')).length).toBe(1)
      assert.deepEqual((await calls(page, 'pick_capture_source'))[0].args.preferences, { mode: 'region', purpose: 'screenshot' })
      assert.equal((await calls(page, 'show_main_window')).length, 0)
      await emitScreenshot(page)
      assert.equal((await calls(page, 'pick_capture_source')).length, 1, '范围选择期间不能重复启动')
      await page.evaluate(selection => window.screenshotHarness.finishPicker(selection), selection)
      await expect.poll(async () => (await calls(page, 'capture_screenshot')).length).toBe(1)
      assert.deepEqual((await calls(page, 'capture_screenshot'))[0].args.selection, selection)
      assert.equal((await calls(page, 'show_main_window')).length, 0, '截屏尚未返回时不能前置主窗口')
      await emitScreenshot(page)
      assert.equal((await calls(page, 'pick_capture_source')).length, 1, '截屏写入期间不能重复启动')
      await page.evaluate(() => window.screenshotHarness.finishCapture())
      await expect(page.getByTestId('convert-workspace')).toBeVisible()
      await expect(page.locator('.convert-toolbar h1')).toHaveText('图片转换')
      await expect(page.locator('.convert-source')).toHaveCount(3)
      await expect(page.locator('.convert-source input:checked')).toHaveCount(1)
      await expect(page.getByRole('checkbox', { name: '选择 截屏-1.png', exact: true })).toBeChecked()
      await expect(page.getByRole('checkbox', { name: '选择 已有图片一.png', exact: true })).not.toBeChecked()
      const preview = page.getByTestId('convert-image-preview')
      await expect(preview).toHaveAttribute('alt', '截屏-1.png')
      await expect(preview).toHaveJSProperty('naturalWidth', 64)
      await expect(preview).toHaveJSProperty('naturalHeight', 40)
      const pixel = await preview.evaluate(image => { const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); return [...context.getImageData(0, 0, 1, 1).data] })
      assert.deepEqual(pixel, [26, 120, 188, 255])
      await expect.poll(async () => (await calls(page, 'show_main_window')).length).toBe(1)
      await expect(page.locator('.status-main')).toContainText('截屏已载入图片转换')
    })

    await check('取消范围选择不创建素材并恢复主窗口，弹窗打开时忽略截屏事件', async () => {
      await emitScreenshot(page)
      await expect.poll(async () => (await calls(page, 'pick_capture_source')).length).toBe(2)
      await page.evaluate(() => window.screenshotHarness.finishPicker(null))
      await expect(page.locator('.status-main')).toContainText('已取消截屏')
      assert.equal((await calls(page, 'capture_screenshot')).length, 1)
      await expect.poll(async () => (await calls(page, 'show_main_window')).length).toBe(2)
      await expect(page.locator('.convert-source')).toHaveCount(3)
      await expect(page.getByTestId('convert-image-preview')).toHaveAttribute('alt', '截屏-1.png')
      await page.getByRole('button', { name: '关于 Open Media', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '关于 Open Media', exact: true })).toBeVisible()
      await emitScreenshot(page)
      assert.equal((await calls(page, 'pick_capture_source')).length, 2)
      await page.keyboard.press('Escape')
    })

    await check('快捷键冲突保留旧组合，成功修改持久化，停用后重启继续停用', async () => {
      await page.getByTestId('nav-record').click()
      const editor = page.getByTestId('screenshot-shortcut')
      await page.evaluate(() => { window.screenshotHarness.rejectShortcut = 'Ctrl+Shift+9' })
      await editor.click()
      await editor.press('Control+Shift+9')
      await expect(page.getByTestId('screenshot-controls').getByRole('alert')).toContainText('此快捷键已被占用')
      await expect(editor).toContainText('Ctrl + Shift + 2')
      assert.equal(await page.evaluate(() => window.screenshotHarness.shortcut), defaultShortcut)
      assert.equal(await page.evaluate(() => localStorage.getItem('open-media:screenshot-shortcut')), null)
      await editor.click()
      await editor.press('Control+Shift+8')
      await expect(editor).toContainText('Ctrl + Shift + 8')
      assert.equal(await page.evaluate(() => localStorage.getItem('open-media:screenshot-shortcut')), 'Ctrl+Shift+8')
      assert.equal((await calls(page, 'pick_capture_source')).length, 2, '设置快捷键不应截屏')
      await page.getByRole('button', { name: '停用快捷键', exact: true }).click()
      await expect(editor).toContainText('未启用')
      assert.equal(await page.evaluate(() => window.screenshotHarness.shortcut), null)
      assert.equal(await page.evaluate(() => localStorage.getItem('open-media:screenshot-shortcut')), 'disabled')
      await expect(page.getByTestId('screenshot-start')).toBeEnabled()
      await page.reload()
      await expect(page.getByTestId('home-workspace')).toBeVisible()
      await expect.poll(async () => (await calls(page, 'configure_screenshot_shortcut')).length).toBe(1)
      assert.deepEqual((await calls(page, 'configure_screenshot_shortcut'))[0].args, { shortcut: null })
      await page.getByTestId('nav-record').click()
      await expect(page.getByTestId('screenshot-shortcut')).toContainText('未启用')
      await page.getByRole('button', { name: '恢复默认', exact: true }).click()
      await expect(page.getByTestId('screenshot-shortcut')).toContainText('Ctrl + Shift + 2')
      assert.equal(await page.evaluate(() => localStorage.getItem('open-media:screenshot-shortcut')), defaultShortcut)
    })

    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => window.screenshotHarness.unexpected), [])
    console.log(`Native screenshot bridge contract: ${results.length} groups passed; native OS capture and hotkey registration were mocked.`)
    await context.close()
  } finally {
    await browser?.close()
    await server?.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
