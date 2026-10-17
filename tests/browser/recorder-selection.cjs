const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function mountRecorder(page, baseURL, native, surface = 'window') {
  await page.route('**/__recorder_selection__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>录制范围验证</title></head><body><div id="app" class="app-shell"></div></body></html>' }))
  await page.goto(`${baseURL}/__recorder_selection__`)
  await page.evaluate(async ({ native, surface }) => {
    await import('/src/style.css')
    const componentSource = await (await fetch('/src/components/RecorderWorkspace.vue')).text()
    const vueImport = componentSource.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h } = await import(vueImport)
    const RecorderWorkspace = (await import('/src/components/RecorderWorkspace.vue')).default
    const state = { calls: [], events: [], blobs: [], assets: [], status: { state: 'idle', elapsed: 0, segments: 0 } }
    window.recorderHarness = state
    if (native) {
      const callbacks = new Map(), listeners = new Map()
      let callbackId = 0, listenerId = 0
      state.action = action => { for (const [id, listener] of listeners) if (listener.event === 'capture-controls-action') callbacks.get(listener.handler)?.({ event: listener.event, id, payload: { action } }) }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => listeners.delete(id) }
      window.__TAURI_INTERNALS__ = {
        transformCallback: callback => { const id = ++callbackId; callbacks.set(id, callback); return id },
        unregisterCallback: id => callbacks.delete(id),
        invoke: async (command, args) => {
          state.calls.push({ command, args })
          if (command === 'plugin:event|listen') { const id = ++listenerId; listeners.set(id, args); return id }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null }
          if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
          if (command === 'pick_capture_source') {
            if (state.permissionFailure) { state.permissionFailure = false; throw new Error('未获得屏幕录制权限，请在系统设置中允许后重试。') }
            return new Promise(resolve => { state.resolvePicker = resolve })
          }
          if (command === 'cancel_capture_picker') { state.resolvePicker(null); return }
          if (command === 'start_capture') {
            const options = args.options
            state.status = { state: 'recording', elapsed: 0, segments: 0, audioAvailable: options.microphone, muted: false, sourceId: options.sourceId, sourceName: state.selectedName ?? '演示窗口', sourceWidth: 1200, sourceHeight: 900, outputSize: options.outputSize ?? options.region ?? { width: 1200, height: 900 } }
            return { ...state.status }
          }
          if (command === 'get_capture_status') return { ...state.status }
          if (command === 'pause_capture') { state.status.state = 'paused'; return { ...state.status } }
          if (command === 'resume_capture') { state.status.state = 'recording'; return { ...state.status } }
          if (command === 'set_capture_muted') { state.status.muted = args.muted; return { ...state.status } }
          if (command === 'stop_capture') { state.status.state = 'idle'; return { id: 'native-recorded', name: '录制.webm', kind: 'video', url: '', duration: 1, width: 1280, height: 720, size: 1000, mime: 'video/webm' } }
          throw new Error(`未预期的录制命令：${command}`)
        },
      }
    } else {
      const canvas = document.createElement('canvas')
      canvas.width = 320; canvas.height = 180
      let frame = 0
      const draw = () => { const context = canvas.getContext('2d'); context.fillStyle = frame++ % 2 ? '#2070d0' : '#20b070'; context.fillRect(0, 0, 320, 180); context.fillStyle = '#f8ca53'; context.fillRect(40, 30, 110, 70) }
      draw()
      const timer = setInterval(draw, 60)
      const stream = canvas.captureStream(15)
      state.screenTrack = stream.getVideoTracks()[0]
      Object.defineProperty(state.screenTrack, 'getSettings', { value: () => ({ width: 320, height: 180, frameRate: 15, displaySurface: surface }) })
      Object.defineProperty(state.screenTrack, 'label', { value: '授权画面' })
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async options => { state.calls.push({ command: 'getDisplayMedia', args: options }); return stream } })
      state.stopSource = () => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()) }
    }
    const app = createApp({ render: () => h(RecorderWorkspace, { assets: [], native, onCaptured: (blob, name) => state.blobs.push({ blob, name }), onAsset: asset => state.assets.push(asset), onRecordingChange: active => state.events.push(active) }) })
    app.mount('#app')
    state.cleanup = () => { app.unmount(); state.stopSource?.(); delete window.__TAURI_INTERNALS__ }
  }, { native, surface })
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await mountRecorder(page, baseURL, true)
    await page.getByTestId('record-start').waitFor()
    assert.deepEqual(await page.evaluate(() => window.recorderHarness.calls.filter(call => !['get_runtime_status', 'plugin:event|listen'].includes(call.command))), [], '打开录制页不能枚举来源或申请采集权限')
    assert.equal(await page.getByTestId('capture-source').count(), 0)
    assert.equal(await page.getByTestId('capture-region-x').count(), 0)
    assert.equal(await page.getByTestId('capture-output').count(), 0)
    await page.getByLabel('开始倒计时').selectOption('0')
    await page.getByRole('switch', { name: /录制麦克风/ }).check()
    fs.mkdirSync('test-results/browser', { recursive: true })
    await page.screenshot({ path: 'test-results/browser/recorder-start-desktop.png', fullPage: true })
    await page.getByTestId('record-start').click()
    await page.waitForFunction(() => typeof window.recorderHarness.resolvePicker === 'function')
    assert.equal(await page.getByTestId('record-stop').innerText(), '取消')
    assert.equal(await page.getByLabel('帧率').isDisabled(), true)
    assert.deepEqual(await page.evaluate(() => window.recorderHarness.events), [true])
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'start_capture').length), 0)
    await page.evaluate(() => window.recorderHarness.resolvePicker({ sourceId: 'window:4', sourceName: '演示窗口', sourceWidth: 1200, sourceHeight: 900, outputSize: { width: 1280, height: 720 } }))
    await page.getByTestId('recording-source').waitFor()
    assert.match(await page.getByTestId('recording-source').innerText(), /演示窗口[\s\S]*1200 × 900[\s\S]*1280 × 720/)
    const started = await page.evaluate(() => window.recorderHarness.calls.find(call => call.command === 'start_capture').args.options)
    assert.equal(started.sourceId, 'window:4')
    assert.deepEqual(started.outputSize, { width: 1280, height: 720 })
    await page.evaluate(() => window.recorderHarness.action('toggle-mute'))
    await expect(page.getByRole('button', { name: '恢复录音', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => window.recorderHarness.action('pause'))
    await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '恢复录音', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => window.recorderHarness.action('resume'))
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await page.evaluate(() => { window.recorderHarness.action('stop'); window.recorderHarness.action('stop') })
    await page.getByTestId('record-start').waitFor()
    assert.equal(await page.evaluate(() => window.recorderHarness.assets.length), 1)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'stop_capture').length), 1)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'pause_capture').length), 1)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'resume_capture').length), 1)
    console.log('PASS 开始后选择来源、确认后才录制、尺寸传递，浮栏事件复用暂停/继续/静音/停止且仅导入一次')

    await page.evaluate(() => { window.recorderHarness.permissionFailure = true })
    await page.getByTestId('record-start').click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /屏幕录制权限/)
    assert.equal(await page.getByTestId('record-start').isDisabled(), false)
    await page.getByTestId('record-start').click()
    await page.getByTestId('record-stop').waitFor()
    await page.getByTestId('record-stop').click()
    await page.getByTestId('record-start').waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
    const calls = await page.evaluate(() => window.recorderHarness.calls)
    assert.equal(calls.filter(call => call.command === 'pick_capture_source').length, 3)
    assert.equal(calls.filter(call => call.command === 'cancel_capture_picker').length, 1)
    assert.equal(calls.filter(call => call.command === 'start_capture').length, 1)
    await page.setViewportSize({ width: 320, height: 850 })
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="recorder-workspace"]').scrollWidth > document.documentElement.clientWidth), false)
    await page.screenshot({ path: 'test-results/browser/recorder-start-mobile.png', fullPage: true })
    await page.evaluate(() => window.recorderHarness.cleanup())
    console.log('PASS 权限失败可重试、取消选择无录制、320px紧凑设置')

    await page.setViewportSize({ width: 1100, height: 850 })
    await mountRecorder(page, baseURL, false)
    await page.getByLabel('开始倒计时').selectOption('0')
    await page.getByTestId('record-start').click()
    await page.getByRole('dialog', { name: '选择录制范围', exact: true }).waitFor()
    assert.equal(await page.getByTestId('recording-source').count(), 0, '预览选择期间不得显示正在录制')
    assert.equal(await page.evaluate(() => window.recorderHarness.blobs.length), 0)
    await page.getByLabel('输出尺寸').selectOption('custom')
    await page.getByLabel('输出宽度').fill('160')
    await page.getByLabel('输出高度').fill('90')
    await page.getByTestId('capture-picker-confirm').click()
    await page.getByTestId('recording-source').waitFor()
    assert.match(await page.getByTestId('recording-source').innerText(), /授权画面[\s\S]*320 × 180[\s\S]*160 × 90/)
    const border = await page.getByTestId('recording-preview').evaluate(element => { const style = getComputedStyle(element, '::after'); return { width: style.borderTopWidth, color: style.borderTopColor, pointerEvents: style.pointerEvents } })
    assert.deepEqual(border, { width: '3px', color: 'rgb(239, 69, 87)', pointerEvents: 'none' })
    assert.match(await page.locator('.settings-hint').innerText(), /共享标识由浏览器提供/)
    await page.waitForFunction(() => document.querySelector('[data-testid="recording-preview"] video').currentTime > 0.2)
    const toolbar = page.getByTestId('recording-toolbar')
    await expect(toolbar).toBeVisible()
    await expect(toolbar.getByRole('button', { name: '未开启录音', exact: true })).toBeDisabled()
    assert.equal(await toolbar.locator('button svg').count(), 3)
    const bounds = await toolbar.boundingBox(), previewBounds = await page.getByTestId('recording-preview').boundingBox()
    assert(Math.abs(previewBounds.x + previewBounds.width - bounds.x - bounds.width - 8) < 3, '控制栏位于红框右上角')
    assert(Math.abs(bounds.y - previewBounds.y - 8) < 3)
    await expect(toolbar.locator('.recording-clock')).not.toContainText('00:00:00')
    await toolbar.getByRole('button', { name: '暂停录制', exact: true }).click()
    await expect(toolbar.getByRole('button', { name: '继续录制', exact: true })).toBeVisible()
    const pausedClock = await toolbar.locator('.recording-clock').innerText()
    await page.screenshot({ path: 'test-results/browser/recorder-preview-paused.png', fullPage: true })
    await page.waitForTimeout(1200)
    assert.equal(await toolbar.locator('.recording-clock').innerText(), pausedClock, '暂停期间时长不增加')
    await toolbar.getByRole('button', { name: '继续录制', exact: true }).click()
    await expect(toolbar.locator('.recording-clock')).not.toHaveText(pausedClock)
    await page.screenshot({ path: 'test-results/browser/recorder-preview-toolbar.png', fullPage: true })
    await toolbar.getByRole('button', { name: '停止录制', exact: true }).click()
    await page.waitForFunction(() => window.recorderHarness.blobs.length === 1)
    const recording = await page.evaluate(async () => ({ bytes: Array.from(new Uint8Array(await window.recorderHarness.blobs[0].blob.arrayBuffer())).slice(0, 4), size: window.recorderHarness.blobs[0].blob.size, released: window.recorderHarness.screenTrack.readyState, events: window.recorderHarness.events }))
    assert.deepEqual(recording.bytes, [26, 69, 223, 163])
    assert.ok(recording.size > 100)
    assert.equal(recording.released, 'ended')
    assert.deepEqual(recording.events, [true, false])
    assert.equal(await page.getByTestId('recording-preview').evaluate(element => element.classList.contains('recording-border')), false)
    await page.evaluate(() => window.recorderHarness.cleanup())
    console.log('PASS 浏览器授权后确认、实际录制容器、红框预览、停止释放设备')

    await mountRecorder(page, baseURL, false, 'monitor')
    await page.getByTestId('record-start').click()
    await page.getByRole('dialog', { name: '选择录制范围', exact: true }).waitFor()
    const stage = await page.getByTestId('capture-selection-stage').boundingBox()
    await page.mouse.move(stage.x + stage.width * .1, stage.y + stage.height * .1)
    await page.mouse.down()
    await page.mouse.move(stage.x + stage.width * .75, stage.y + stage.height * .75, { steps: 8 })
    await page.mouse.up()
    await page.getByTestId('capture-selection-frame').waitFor()
    assert.equal(await page.getByTestId('capture-picker-confirm').isDisabled(), false)
    assert.equal(await page.getByLabel('选区宽度').inputValue(), '208')
    assert.equal(await page.getByLabel('选区高度').inputValue(), '117')
    await page.screenshot({ path: 'test-results/browser/recorder-preview-selection.png', fullPage: true })
    await page.keyboard.press('Escape')
    await page.getByTestId('record-start').waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal(await page.evaluate(() => window.recorderHarness.screenTrack.readyState), 'ended')
    assert.equal(await page.evaluate(() => window.recorderHarness.blobs.length), 0)
    await page.evaluate(() => window.recorderHarness.cleanup())
    assert.deepEqual(errors, [])
    console.log('PASS 网页选择器取消后释放共享来源且不生成空白录像')
  } finally { await browser?.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
