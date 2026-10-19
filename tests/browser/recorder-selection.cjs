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
          if (command === 'show_main_window') return null
          if (command === 'open_media_library_directory') {
            if (state.directoryFailure) { state.directoryFailure = false; throw new Error('目录暂不可用') }
            return null
          }
          if (command === 'pick_capture_source') {
            if (state.permissionFailure) { state.permissionFailure = false; throw new Error('未获得屏幕录制权限，请在系统设置中允许后重试。') }
            return new Promise(resolve => { state.resolvePicker = resolve })
          }
          if (command === 'cancel_capture_picker') { state.resolvePicker(null); return }
          if (command === 'start_capture') {
            if (state.startFailure) { state.startFailure = false; throw new Error('录制来源已关闭，请重新选择。') }
            const options = args.options
            state.status = { state: 'recording', elapsed: 0, segments: 0, audioAvailable: options.microphone, muted: !options.microphone, microphoneEnabled: options.microphone, sourceId: options.sourceId, sourceName: state.selectedName ?? '演示窗口', sourceWidth: 1200, sourceHeight: 900, outputSize: options.outputSize ?? options.region ?? { width: 1200, height: 900 } }
            return { ...state.status }
          }
          if (command === 'get_capture_status') return { ...state.status }
          if (command === 'pause_capture') { state.status.state = 'paused'; return { ...state.status } }
          if (command === 'resume_capture') { state.status.state = 'recording'; return { ...state.status } }
          if (command === 'set_capture_microphone') { state.status.microphoneEnabled = args.enabled; state.status.audioAvailable = args.enabled; state.status.muted = !args.enabled; return { ...state.status } }
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
      let stream
      const newDisplay = () => {
        stream = canvas.captureStream(15)
        state.screenTrack = stream.getVideoTracks()[0]
        Object.defineProperty(state.screenTrack, 'getSettings', { value: () => ({ width: 320, height: 180, frameRate: 15, displaySurface: surface }) })
        Object.defineProperty(state.screenTrack, 'label', { value: '授权画面' })
      }
      newDisplay()
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async options => {
        state.calls.push({ command: 'getDisplayMedia', args: options })
        if (state.screenTrack.readyState === 'ended') newDisplay()
        return stream
      } })
      state.microphoneTracks = []
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [
        { kind: 'audioinput', deviceId: 'browser-internal', label: '内置麦克风', groupId: 'internal' },
        { kind: 'audioinput', deviceId: 'browser-usb', label: 'USB 采访麦克风', groupId: 'usb' },
      ] })
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async options => {
        state.calls.push({ command: 'getUserMedia', args: options })
        if (state.rejectMicrophone) { state.rejectMicrophone = false; throw new DOMException('用户拒绝麦克风', 'NotAllowedError') }
        state.audioContext ??= new AudioContext()
        await state.audioContext.resume()
        const tone = state.audioContext.createOscillator(), gain = state.audioContext.createGain(), destination = state.audioContext.createMediaStreamDestination()
        tone.frequency.value = 440; gain.gain.value = .12; tone.connect(gain).connect(destination); tone.start()
        const track = destination.stream.getAudioTracks()[0]
        state.microphoneTracks.push(track)
        if (state.delayMicrophone) return new Promise(resolve => { state.resolveMicrophone = () => resolve(destination.stream) })
        return destination.stream
      } })
      state.stopSource = () => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); state.microphoneTracks.forEach(track => track.stop()); void state.audioContext?.close() }
    }
    const app = createApp({ render: () => h(RecorderWorkspace, { assets: [], native, onCaptured: (blob, name) => state.blobs.push({ blob, name }), onAsset: asset => state.assets.push(asset), onRecordingChange: active => state.events.push(active) }) })
    app.mount('#app')
    state.cleanup = () => { app.unmount(); state.stopSource?.(); delete window.__TAURI_INTERNALS__ }
  }, { native, surface })
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**/src-tauri/target/**'] }, hmr: false }, logLevel: 'error' })
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
    const directoryButton = page.getByRole('button', { name: '打开录屏保存目录', exact: true })
    const headingBounds = await page.getByRole('heading', { name: '屏幕录制', exact: true }).boundingBox()
    const directoryBounds = await directoryButton.boundingBox()
    assert(directoryBounds.x >= headingBounds.x + headingBounds.width, '打开目录位于主标题右侧')
    assert(Math.abs(directoryBounds.y + directoryBounds.height / 2 - headingBounds.y - headingBounds.height / 2) < 2, '目录按钮与主标题同排居中')
    await expect(directoryButton.locator('svg')).toHaveCount(1)
    await page.evaluate(() => { window.recorderHarness.directoryFailure = true })
    await directoryButton.click()
    await expect(page.getByRole('alert')).toContainText('无法打开录屏保存目录：目录暂不可用')
    await directoryButton.click()
    await expect.poll(() => page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'open_media_library_directory').length)).toBe(2)
    await expect(page.getByRole('alert')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.recorderHarness.calls.filter(call => !['get_runtime_status', 'plugin:event|listen'].includes(call.command)).map(call => call.command)), ['open_media_library_directory', 'open_media_library_directory'], '打开目录不扫描视频列表或启动采集')
    console.log('PASS 录屏目录入口紧邻主标题，按需打开、错误可重试且不扫描目录')
    assert.equal(await page.getByTestId('capture-source').count(), 0)
    assert.equal(await page.getByTestId('capture-region-x').count(), 0)
    assert.equal(await page.getByTestId('capture-output').count(), 0)
    await page.getByLabel('开始倒计时').selectOption('0')
    assert.equal(await page.getByRole('switch', { name: /录制麦克风/ }).count(), 0, '麦克风配置已移入范围选择面板')
    assert.equal(await page.getByText('点击开始后选择录制范围', { exact: true }).count(), 0)
    fs.mkdirSync('test-results/browser', { recursive: true })
    await page.screenshot({ path: 'test-results/browser/recorder-start-desktop.png', fullPage: true })
    await page.getByTestId('record-start').click()
    await page.waitForFunction(() => typeof window.recorderHarness.resolvePicker === 'function')
    assert.equal(await page.getByTestId('record-stop').innerText(), '取消')
    assert.equal(await page.getByLabel('帧率').isDisabled(), true)
    assert.deepEqual(await page.evaluate(() => window.recorderHarness.events), [true])
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'start_capture').length), 0)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.find(call => call.command === 'pick_capture_source').args.preferences.microphone), true)
    await page.evaluate(() => window.recorderHarness.resolvePicker({ microphone: false, audioDevice: 'native-usb', sourceId: 'window:4', sourceName: '演示窗口', sourceWidth: 1200, sourceHeight: 900, outputSize: { width: 1280, height: 720 } }))
    await page.getByTestId('recording-source').waitFor()
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'show_main_window').length), 0, '成功开始录制不能重新显示主窗口')
    assert.match(await page.getByTestId('recording-source').innerText(), /演示窗口[\s\S]*1200 × 900[\s\S]*1280 × 720/)
    const started = await page.evaluate(() => window.recorderHarness.calls.find(call => call.command === 'start_capture').args.options)
    assert.equal(started.sourceId, 'window:4')
    assert.equal(started.microphone, false, '选择面板关闭麦克风后不应在开始时请求麦克风')
    assert.equal(started.audioDevice, 'native-usb', '关闭麦克风仍保留选择来源，供红框中开启时使用')
    assert.deepEqual(started.outputSize, { width: 1280, height: 720 })
    await page.evaluate(() => window.recorderHarness.action('toggle-microphone'))
    await expect(page.getByRole('button', { name: '关闭麦克风', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => window.recorderHarness.action('pause'))
    await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '关闭麦克风', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => window.recorderHarness.action('resume'))
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await page.evaluate(() => { window.recorderHarness.action('stop'); window.recorderHarness.action('stop') })
    await page.getByTestId('record-start').waitFor()
    assert.equal(await page.evaluate(() => window.recorderHarness.assets.length), 1)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'stop_capture').length), 1)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'pause_capture').length), 1)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'resume_capture').length), 1)
    await expect.poll(() => page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'show_main_window').length)).toBe(1)
    console.log('PASS 开始后选择来源、确认后才录制、尺寸传递，浮栏事件复用暂停/继续/麦克风开关/停止且仅导入一次')

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
    assert.equal(calls.filter(call => call.command === 'pick_capture_source').at(-1).args.preferences.audioDevice, 'native-usb', '再次选择录制范围保留上次麦克风来源')
    await page.getByTestId('record-start').click()
    await expect.poll(() => page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'pick_capture_source').length)).toBe(4)
    // The native picker writes its choice immediately even if its window is canceled.
    await page.evaluate(() => localStorage.setItem('open-media:microphone:capture-native', JSON.stringify({ deviceId: 'native-internal', name: '内置麦克风' })))
    await page.getByTestId('record-stop').click()
    await page.getByTestId('record-start').click()
    await expect.poll(() => page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'pick_capture_source').length)).toBe(5)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'pick_capture_source').at(-1).args.preferences.audioDevice), 'native-internal')
    await page.getByTestId('record-stop').click()
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'start_capture').length), 1)
    console.log('PASS 原生选区更改麦克风后取消，再次开启选择器读取最新来源且不启动录制')

    const restoreCount = () => page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'show_main_window').length)
    await expect.poll(restoreCount).toBe(5)
    await page.getByLabel('开始倒计时').selectOption('3')
    await page.getByTestId('record-start').click()
    await expect.poll(() => page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'pick_capture_source').length)).toBe(6)
    await page.evaluate(() => window.recorderHarness.resolvePicker({ microphone: false, sourceId: 'screen:1', sourceWidth: 1920, sourceHeight: 1080 }))
    await expect(page.getByText('3 秒后开始', { exact: true })).toBeVisible()
    await page.getByTestId('record-stop').click()
    await page.getByTestId('record-start').waitFor()
    await expect.poll(restoreCount).toBe(6)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'start_capture').length), 1, '倒计时取消不能启动录制')
    await page.getByLabel('开始倒计时').selectOption('0')
    await page.evaluate(() => { window.recorderHarness.startFailure = true })
    await page.getByTestId('record-start').click()
    await expect.poll(() => page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'pick_capture_source').length)).toBe(7)
    await page.evaluate(() => window.recorderHarness.resolvePicker({ microphone: false, sourceId: 'window:4', sourceWidth: 1200, sourceHeight: 900 }))
    await expect(page.getByRole('alert')).toContainText('录制来源已关闭')
    await expect.poll(restoreCount).toBe(7)
    console.log('PASS 录制成功保持最小化，停止、倒计时取消和开始失败恢复主窗口')

    await page.setViewportSize({ width: 320, height: 850 })
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="recorder-workspace"]').scrollWidth > document.documentElement.clientWidth), false)
    await page.screenshot({ path: 'test-results/browser/recorder-start-mobile.png', fullPage: true })
    await page.evaluate(() => window.recorderHarness.cleanup())
    console.log('PASS 权限失败可重试、取消选择无录制、320px紧凑设置')

    await page.setViewportSize({ width: 1100, height: 850 })
    await mountRecorder(page, baseURL, false)
    await expect(page.getByRole('button', { name: '打开录屏保存目录', exact: true })).toHaveCount(0)
    await page.getByLabel('开始倒计时').selectOption('0')
    await page.getByTestId('record-start').click()
    await page.getByRole('dialog', { name: '选择录制范围', exact: true }).waitFor()
    assert.equal(await page.getByTestId('recording-source').count(), 0, '预览选择期间不得显示正在录制')
    assert.equal(await page.evaluate(() => window.recorderHarness.blobs.length), 0)
    const pickerMicrophone = page.getByTestId('capture-picker-microphone')
    await expect(pickerMicrophone).toHaveAttribute('aria-pressed', 'true')
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'getUserMedia').length), 0, '选择面板确认前不申请麦克风')
    await page.getByTestId('capture-picker-audio-source').selectOption('browser-usb')
    await pickerMicrophone.click()
    await expect(pickerMicrophone).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('capture-picker-audio-source')).toHaveValue('browser-usb')
    await expect(page.getByTestId('capture-picker-audio-source')).toBeEnabled()
    const cancelBounds = await page.getByTestId('capture-picker-cancel').boundingBox()
    assert(cancelBounds.x >= 0 && cancelBounds.y >= 0 && cancelBounds.x + cancelBounds.width <= 1100 && cancelBounds.y + cancelBounds.height <= 850, '取消按钮留在选择面板可视区内')
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
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toBeEnabled()
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'getUserMedia').length), 0)
    await toolbar.getByRole('button', { name: '开启麦克风', exact: true }).click()
    await expect(toolbar.getByRole('button', { name: '关闭麦克风', exact: true })).toHaveAttribute('aria-pressed', 'true')
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'getUserMedia').length), 1)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.find(call => call.command === 'getUserMedia').args.audio.deviceId.exact), 'browser-usb', '红框开启麦克风使用之前选择的明确来源')
    assert.equal(await toolbar.locator('button svg').count(), 3)
    const bounds = await toolbar.boundingBox(), previewBounds = await page.getByTestId('recording-preview').boundingBox()
    assert(Math.abs(previewBounds.x + previewBounds.width - bounds.x - bounds.width - 8) < 3, '控制栏位于红框右上角')
    assert(Math.abs(bounds.y - previewBounds.y - 8) < 3)
    await expect(toolbar.locator('.recording-clock')).not.toContainText('00:00:00')
    await toolbar.getByRole('button', { name: '暂停录制', exact: true }).click()
    await expect(toolbar.getByRole('button', { name: '继续录制', exact: true })).toBeVisible()
    const pausedClock = await toolbar.locator('.recording-clock').innerText()
    await toolbar.getByRole('button', { name: '关闭麦克风', exact: true }).click()
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toHaveAttribute('aria-pressed', 'false')
    assert.equal(await page.evaluate(() => window.recorderHarness.microphoneTracks[0].readyState), 'ended', '关闭麦克风释放设备，不影响暂停状态')
    await expect(toolbar.getByRole('button', { name: '继续录制', exact: true })).toBeEnabled()
    await page.screenshot({ path: 'test-results/browser/recorder-preview-paused.png', fullPage: true })
    await page.waitForTimeout(1200)
    assert.equal(await toolbar.locator('.recording-clock').innerText(), pausedClock, '暂停期间时长不增加')
    await toolbar.getByRole('button', { name: '继续录制', exact: true }).click()
    await expect(toolbar.locator('.recording-clock')).not.toHaveText(pausedClock)
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await page.evaluate(() => { window.recorderHarness.rejectMicrophone = true })
    await toolbar.getByRole('button', { name: '开启麦克风', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('麦克风权限')
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toBeEnabled()
    await expect(toolbar.getByRole('button', { name: '暂停录制', exact: true })).toBeEnabled()
    await toolbar.getByRole('button', { name: '开启麦克风', exact: true }).click()
    await expect(toolbar.getByRole('button', { name: '关闭麦克风', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/browser/recorder-preview-toolbar.png', fullPage: true })
    await toolbar.getByRole('button', { name: '停止录制', exact: true }).click()
    await page.waitForFunction(() => window.recorderHarness.blobs.length === 1)
    const recording = await page.evaluate(async () => ({ bytes: Array.from(new Uint8Array(await window.recorderHarness.blobs[0].blob.arrayBuffer())).slice(0, 4), size: window.recorderHarness.blobs[0].blob.size, released: window.recorderHarness.screenTrack.readyState, events: window.recorderHarness.events }))
    assert.deepEqual(recording.bytes, [26, 69, 223, 163])
    assert.ok(recording.size > 100)
    assert.equal(recording.released, 'ended')
    assert(await page.evaluate(() => window.recorderHarness.microphoneTracks.every(track => track.readyState === 'ended')))
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
    await page.getByTestId('capture-picker-audio-source').selectOption('browser-internal')
    await page.getByTestId('capture-picker-cancel').click()
    await page.getByTestId('record-start').waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal(await page.evaluate(() => window.recorderHarness.screenTrack.readyState), 'ended')
    assert.equal(await page.evaluate(() => window.recorderHarness.blobs.length), 0)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'getUserMedia').length), 0)
    await page.getByTestId('record-start').click()
    await page.getByRole('dialog', { name: '选择录制范围', exact: true }).waitFor()
    await expect(page.getByTestId('capture-picker-audio-source')).toHaveValue('browser-internal')
    await page.getByTestId('capture-picker-cancel').click()
    await page.getByTestId('record-start').waitFor()
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'getDisplayMedia').length), 2)
    assert.equal(await page.evaluate(() => window.recorderHarness.screenTrack.readyState), 'ended')
    assert.equal(await page.evaluate(() => window.recorderHarness.blobs.length), 0)
    assert.equal(await page.evaluate(() => window.recorderHarness.calls.filter(call => call.command === 'getUserMedia').length), 0)
    await page.evaluate(() => window.recorderHarness.cleanup())
    console.log('PASS 网页选择器取消后释放共享来源且不生成空白录像；再次打开保留取消前选择的麦克风')

    await mountRecorder(page, baseURL, false)
    await page.getByLabel('开始倒计时').selectOption('0')
    await page.getByTestId('record-start').click()
    await page.getByTestId('capture-picker-microphone').click()
    await page.getByTestId('capture-picker-confirm').click()
    await expect(toolbar).toBeVisible()
    await page.evaluate(() => { window.recorderHarness.delayMicrophone = true })
    await toolbar.getByRole('button', { name: '开启麦克风', exact: true }).click()
    await page.waitForFunction(() => typeof window.recorderHarness.resolveMicrophone === 'function')
    await expect(toolbar.getByRole('button', { name: '开启麦克风', exact: true })).toBeDisabled()
    await expect(toolbar.getByRole('button', { name: '停止录制', exact: true })).toBeEnabled()
    await toolbar.getByRole('button', { name: '停止录制', exact: true }).click()
    await page.getByTestId('record-start').waitFor()
    await page.waitForFunction(() => window.recorderHarness.blobs.length === 1)
    assert.equal(await page.evaluate(() => window.recorderHarness.screenTrack.readyState), 'ended')
    await page.evaluate(() => window.recorderHarness.resolveMicrophone())
    await page.waitForFunction(() => window.recorderHarness.microphoneTracks.every(track => track.readyState === 'ended'))
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.equal(await page.evaluate(() => window.recorderHarness.blobs.length), 1, '晚到授权不会重新开始录制或重复导入')
    await page.evaluate(() => window.recorderHarness.cleanup())
    assert.deepEqual(errors, [])
    console.log('PASS 等待麦克风授权仍可停止；晚到设备自动释放，不恢复录制')
  } finally { await browser?.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
