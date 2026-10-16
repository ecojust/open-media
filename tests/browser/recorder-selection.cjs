const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium } = require('@playwright/test')

async function mountRecorder(page, baseURL, native) {
  await page.route('**/__recorder_selection__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>录制范围验证</title></head><body><div id="app" class="app-shell"></div></body></html>' }))
  await page.goto(`${baseURL}/__recorder_selection__`)
  await page.evaluate(async native => {
    await import('/src/style.css')
    const componentSource = await (await fetch('/src/components/RecorderWorkspace.vue')).text()
    const vueImport = componentSource.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h } = await import(vueImport)
    const RecorderWorkspace = (await import('/src/components/RecorderWorkspace.vue')).default
    const state = { calls: [], events: [], blobs: [], releaseDevices: undefined, screenTrack: undefined, devices: [{ id: 'screen:1', name: '主屏幕', kind: 'screen', width: 1920, height: 1080 }, { id: 'screen:2', name: '副屏幕', kind: 'screen', width: 2560, height: 1440 }, { id: 'window:4', name: '演示窗口', kind: 'window', width: 1200, height: 900 }], status: { state: 'idle', elapsed: 0, segments: 0 } }
    window.recorderHarness = state
    if (native) {
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          state.calls.push({ command, args })
          if (command === 'list_capture_devices') {
            if (state.delayDevices) return new Promise(resolve => { state.releaseDevices = () => { state.delayDevices = false; resolve([...state.devices]) } })
            return [...state.devices]
          }
          if (command === 'start_capture') {
            const options = args.options
            const source = state.devices.find(device => device.id === options.sourceId)
            if (!source) throw new Error('所选来源不可用')
            state.status = { state: 'recording', elapsed: 0, segments: 0, sourceId: source.id, sourceName: source.name, sourceWidth: source.width, sourceHeight: source.height, outputSize: options.outputSize ?? options.region ?? { width: source.width, height: source.height } }
            return { ...state.status }
          }
          if (command === 'get_capture_status') return { ...state.status }
          if (command === 'pause_capture') { state.status.state = 'paused'; return { ...state.status } }
          if (command === 'resume_capture') { state.status.state = 'recording'; return { ...state.status } }
          if (command === 'stop_capture') { state.status.state = 'idle'; return null }
          throw new Error(`未预期的录制命令：${command}`)
        },
      }
    } else {
      const canvas = document.createElement('canvas')
      canvas.width = 160; canvas.height = 90
      let frame = 0
      const draw = () => { const context = canvas.getContext('2d'); context.fillStyle = frame++ % 2 ? '#2070d0' : '#20b070'; context.fillRect(0, 0, 160, 90) }
      draw()
      const timer = setInterval(draw, 60)
      const stream = canvas.captureStream(15)
      state.screenTrack = stream.getVideoTracks()[0]
      Object.defineProperty(state.screenTrack, 'getSettings', { value: () => ({ width: 160, height: 90, frameRate: 15, displaySurface: 'window' }) })
      Object.defineProperty(state.screenTrack, 'label', { value: '浏览器授权窗口' })
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async options => { state.calls.push({ command: 'getDisplayMedia', args: options }); return stream } })
      state.stopSource = () => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()) }
    }
    const app = createApp({ render: () => h(RecorderWorkspace, { assets: [], native, onCaptured: (blob, name) => state.blobs.push({ blob, name }), onRecordingChange: active => state.events.push(active) }) })
    app.mount('#app')
    state.cleanup = () => { app.unmount(); state.stopSource?.(); delete window.__TAURI_INTERNALS__ }
  }, native)
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
    await page.waitForFunction(() => !document.querySelector('[data-testid="record-start"]').disabled)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls[0].args.requestPermission), false, '打开录制页不应自动请求系统采集权限')
    await page.getByTestId('capture-source').selectOption('screen:2')
    await page.getByRole('button', { name: '授权并刷新录制来源', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="capture-source"]').disabled && window.recorderHarness.calls.filter(call => call.command === 'list_capture_devices').length === 2)
    assert.equal(await page.getByTestId('capture-source').inputValue(), 'screen:2')
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'list_capture_devices').at(-1).args.requestPermission), true)
    await page.getByTestId('capture-mode-window').click()
    await page.getByTestId('capture-output').selectOption('720p')
    await page.getByLabel('开始倒计时').selectOption('0')
    assert.equal(await page.getByTestId('capture-mode-window').getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByTestId('capture-mode-screen').getAttribute('aria-pressed'), 'false')
    const sourceStyles = await page.locator('.source-tabs button').evaluateAll(buttons => buttons.map(button => ({ color: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor })))
    assert.deepEqual(sourceStyles[0], sourceStyles[2], '屏幕与区域应恢复为未选中样式')
    assert.deepEqual(sourceStyles[1], { color: 'rgb(50, 103, 246)', background: 'rgb(255, 255, 255)' }, '窗口模式应立即显示选中样式')
    fs.mkdirSync('test-results/browser', { recursive: true })
    await page.screenshot({ path: 'test-results/browser/recorder-window-desktop.png', fullPage: true })
    await page.getByTestId('record-start').click()
    await page.getByTestId('recording-source').waitFor()
    assert.match(await page.getByTestId('recording-source').innerText(), /演示窗口[\s\S]*1200 × 900[\s\S]*1280 × 720/)
    const started = await page.evaluate(() => window.recorderHarness.calls.find(call => call.command === 'start_capture').args.options)
    assert.equal(started.sourceId, 'window:4')
    assert.deepEqual(started.outputSize, { width: 1280, height: 720 })
    assert.equal(await page.getByTestId('capture-source').isDisabled(), true)
    assert.equal(await page.getByTestId('capture-output').isDisabled(), true)
    assert.equal(await page.getByTestId('capture-mode-region').isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '授权并刷新录制来源', exact: true }).isDisabled(), true)
    await page.getByTestId('record-stop').click()
    await page.getByTestId('record-start').waitFor()
    await page.evaluate(() => { window.recorderHarness.devices = window.recorderHarness.devices.filter(device => device.kind !== 'window') })
    await page.getByRole('button', { name: '授权并刷新录制来源', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="capture-source"]').value === '')
    assert.equal(await page.getByTestId('capture-source').inputValue(), '')
    assert.equal(await page.getByTestId('record-start').isDisabled(), true)
    assert.match(await page.getByRole('alert').innerText(), /来源已不可用/)
    console.log('PASS 窗口选择、尺寸传递、实际状态、录制锁定与关闭窗口阻断')

    await page.getByTestId('capture-mode-region').click()
    await page.getByTestId('capture-region-x').fill('2500')
    await page.getByTestId('capture-region-width').fill('640')
    assert.equal(await page.getByTestId('record-start').isDisabled(), true)
    assert.match(await page.getByRole('alert').innerText(), /超出屏幕范围/)
    await page.getByTestId('capture-region-x').fill('100')
    await page.getByTestId('capture-region-y').fill('50')
    await page.getByTestId('capture-region-height').fill('480')
    await page.getByTestId('capture-output').selectOption('custom')
    await page.getByTestId('capture-output-width').fill('641')
    await page.getByTestId('capture-output-height').fill('480')
    assert.equal(await page.getByTestId('record-start').isDisabled(), true)
    assert.match(await page.getByRole('alert').innerText(), /偶数整数/)
    await page.getByTestId('capture-output-width').fill('640')
    await page.evaluate(() => { window.recorderHarness.delayDevices = true })
    await page.getByRole('button', { name: '授权并刷新录制来源', exact: true }).click()
    assert.equal(await page.getByTestId('record-start').isDisabled(), true)
    await page.waitForFunction(() => typeof window.recorderHarness.releaseDevices === 'function')
    await page.evaluate(() => window.recorderHarness.releaseDevices())
    await page.waitForFunction(() => !document.querySelector('[data-testid="record-start"]').disabled)
    await page.setViewportSize({ width: 320, height: 850 })
    const overflow = await page.evaluate(() => document.querySelector('[data-testid="recorder-workspace"]').scrollWidth > document.documentElement.clientWidth)
    assert.equal(overflow, false, '320px录制设置出现水平溢出')
    await page.getByTestId('record-start').click()
    await page.getByTestId('recording-source').waitFor()
    const cropped = await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'start_capture').at(-1).args.options)
    assert.deepEqual(cropped.region, { x: 100, y: 50, width: 640, height: 480 })
    assert.equal(cropped.sourceId, 'screen:2')
    assert.deepEqual(cropped.outputSize, { width: 640, height: 480 })
    await page.getByTestId('record-stop').click()
    await page.evaluate(() => window.recorderHarness.cleanup())
    console.log('PASS 区域边界、无效尺寸、来源刷新等待和320px窄屏操作')

    await page.setViewportSize({ width: 1100, height: 850 })
    await mountRecorder(page, baseURL, false)
    await page.getByTestId('capture-mode-window').click()
    await page.getByTestId('capture-output').selectOption('custom')
    await page.getByTestId('capture-output-width').fill('320')
    await page.getByTestId('capture-output-height').fill('180')
    await page.getByLabel('开始倒计时').selectOption('0')
    await page.getByTestId('record-start').click()
    await page.getByTestId('recording-source').waitFor()
    assert.match(await page.getByTestId('recording-source').innerText(), /浏览器授权窗口[\s\S]*160 × 90[\s\S]*320 × 180/)
    const border = await page.getByTestId('recording-preview').evaluate(element => { const style = getComputedStyle(element, '::after'); return { width: style.borderTopWidth, color: style.borderTopColor, pointerEvents: style.pointerEvents } })
    assert.deepEqual(border, { width: '3px', color: 'rgb(239, 69, 87)', pointerEvents: 'none' })
    assert.match(await page.locator('.settings-hint').innerText(), /共享标识由浏览器提供/)
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.2)
    await page.getByTestId('record-stop').click()
    await page.waitForFunction(() => window.recorderHarness.blobs.length === 1)
    const recording = await page.evaluate(async () => ({ bytes: Array.from(new Uint8Array(await window.recorderHarness.blobs[0].blob.arrayBuffer())).slice(0, 4), size: window.recorderHarness.blobs[0].blob.size, released: window.recorderHarness.screenTrack.readyState, events: window.recorderHarness.events, sourceOptions: window.recorderHarness.calls[0].args }))
    assert.deepEqual(recording.bytes, [26, 69, 223, 163], '界面停止录制未产生真实媒体容器')
    assert.ok(recording.size > 100)
    assert.equal(recording.released, 'ended')
    assert.deepEqual(recording.events, [true, false])
    assert.equal(recording.sourceOptions.video.displaySurface, 'window')
    assert.equal(await page.getByTestId('recording-preview').evaluate(element => element.classList.contains('recording-border')), false)
    await page.evaluate(() => window.recorderHarness.cleanup())
    assert.deepEqual(errors, [])
    console.log('PASS 网页实际录制、授权来源信息、红色范围边框和停止后释放设备')
  } finally { await browser?.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
