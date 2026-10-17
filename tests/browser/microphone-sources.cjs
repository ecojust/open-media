const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'microphone-sources') : '/tmp/open-media-microphone-sources'

// Supply distinguishable synthetic inputs; the application owns selection,
// MediaRecorder encoding, cancellation and release. No physical microphone is used.
async function installMicrophones(page, authorized = false) {
  await page.addInitScript(initiallyAuthorized => {
    const state = { authorized: initiallyAuthorized, requests: [], enumerations: 0, contexts: [], pending: [], mode: 'ready',
      devices: [{ id: 'mic-internal', name: '内置麦克风', frequency: 330 }, { id: 'mic-usb', name: 'USB 采访麦克风', frequency: 660 }] }
    window.microphoneFixture = state
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => {
      state.enumerations++
      if (state.enumerationFailure) throw new DOMException('无法列出当前麦克风设备', 'NotReadableError')
      if (!state.authorized) return [{ kind: 'audioinput', deviceId: '', groupId: '', label: '' }]
      return [{ kind: 'audioinput', deviceId: 'default', groupId: 'default-group', label: '默认 - 内置麦克风' },
        ...state.devices.map(device => ({ kind: 'audioinput', deviceId: device.id, groupId: device.id, label: device.name })),
        { kind: 'audiooutput', deviceId: 'speaker', groupId: 'speaker', label: '扬声器' }]
    } })
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
      const selectedId = constraints.audio?.deviceId?.exact
      const request = { constraints, stream: null, selectedId }
      state.requests.push(request)
      if (state.mode === 'denied') throw new DOMException('Microphone permission denied', 'NotAllowedError')
      if (state.mode === 'pending') await new Promise(resolve => state.pending.push(resolve))
      const device = selectedId ? state.devices.find(device => device.id === selectedId) : state.devices[0]
      if (!device) throw new DOMException('Selected microphone is disconnected', 'OverconstrainedError')
      state.authorized = true
      const context = new AudioContext({ sampleRate: 48000 })
      const oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination()
      oscillator.frequency.value = device.frequency; gain.gain.value = 0.2
      oscillator.connect(gain).connect(output); oscillator.start(); await context.resume()
      state.contexts.push(context); request.stream = output.stream
      return output.stream
    } })
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => { throw new Error('剪辑录音不得请求屏幕权限') } })
  }, authorized)
}

async function mountEditor(page, baseURL) {
  await page.route('**/__microphone_sources__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#app{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);--ed-border:#ddd;--ed-panel:white;--ed-text:#222;--ed-muted:#666}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${baseURL}/__microphone_sources__`)
  await page.evaluate(async () => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/EditorVoiceRecorder.vue')).text()
    const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h } = await import(vueImport), Recorder = (await import('/src/components/EditorVoiceRecorder.vue')).default
    const state = { saved: [], busy: [], messages: [] }
    const app = createApp({ render: () => h(Recorder, { projectId: 'source-test', start: 3,
      save: async (audio, start, projectId) => state.saved.push({ audio, start, projectId }),
      onBusy: value => state.busy.push(value), onStatus: value => state.messages.push(value) }) })
    app.mount('#app'); window.microphoneEditor = { state, cleanup: () => app.unmount() }
  })
}

async function devicesReleased(page) {
  await expect.poll(() => page.evaluate(() => window.microphoneFixture.requests.every(request =>
    !request.stream || request.stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true)
}

async function checkDecoded(page, index, frequency) {
  const decoded = await page.evaluate(async index => {
    const saved = window.microphoneEditor.state.saved[index], context = new AudioContext({ sampleRate: 48000 })
    try {
      const audio = await context.decodeAudioData(await saved.audio.blob.arrayBuffer()), samples = audio.getChannelData(0)
      const start = Math.floor(samples.length * .2), end = Math.floor(samples.length * .8)
      let crossings = 0, square = 0
      for (let i = start + 1; i < end; i++) { if (samples[i - 1] < 0 && samples[i] >= 0) crossings++; square += samples[i] ** 2 }
      return { frequency: crossings * audio.sampleRate / (end - start), rms: Math.sqrt(square / (end - start)),
        duration: audio.duration, size: saved.audio.blob.size, start: saved.start, projectId: saved.projectId }
    } finally { await context.close() }
  }, index)
  assert(Math.abs(decoded.frequency - frequency) < 8, `应实际编码所选设备的波形：${JSON.stringify(decoded)}`)
  assert(decoded.duration > .8 && decoded.size > 1000 && decoded.rms > .08)
  assert.equal(decoded.start, 3); assert.equal(decoded.projectId, 'source-test')
}

async function finishRecording(page) {
  await expect(page.getByTestId('preview-record')).toHaveAttribute('aria-label', '停止录音')
  await expect(page.getByTestId('preview-record-source')).toBeDisabled()
  await page.waitForTimeout(1100)
  await page.getByTestId('preview-record').click()
  await expect(page.getByTestId('preview-record')).toHaveAttribute('aria-label', '开始录音')
  await devicesReleased(page)
}

async function visibleInside(page, locator, viewport) {
  const bounds = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, clear: hit === element || element.contains(hit) }
  })
  assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height,
    `控件应位于 ${viewport.width}×${viewport.height} 可视区：${JSON.stringify(bounds)}`)
  assert(bounds.clear, `控件不可被遮挡：${JSON.stringify(bounds)}`)
}

async function editorChecks(browser, baseURL) {
  const context = await browser.newContext({ viewport: { width: 800, height: 650 } }), page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await installMicrophones(page)
    await mountEditor(page, baseURL)
    assert.equal(await page.evaluate(() => window.microphoneFixture.requests.length), 0)
    await page.getByTestId('preview-record-source').click()
    await expect(page.getByTestId('preview-record-source-refresh')).toHaveText('授权并刷新')
    assert.equal(await page.evaluate(() => window.microphoneFixture.requests.length), 0, '读取来源不得自动申请麦克风权限')
    await page.getByTestId('preview-record-source-refresh').click()
    await expect(page.getByTestId('preview-record-source-refresh')).toHaveText('刷新设备')
    await expect(page.getByTestId('preview-record-device').locator('option')).toHaveCount(3)
    await devicesReleased(page)
    assert.equal(await page.evaluate(() => window.microphoneEditor.state.saved.length), 0, '授权刷新不能生成录音')
    assert.deepEqual(await page.evaluate(() => window.microphoneEditor.state.busy), [true, false])
    await page.getByTestId('preview-record-device').selectOption('mic-usb')
    await expect(page.getByTestId('preview-record-source')).toHaveAttribute('title', /USB 采访麦克风/)
    await page.getByRole('button', { name: '关闭麦克风来源', exact: true }).click()
    await page.getByTestId('preview-record').click()
    await finishRecording(page)
    assert.deepEqual(await page.evaluate(() => window.microphoneFixture.requests.at(-1).constraints), { audio: { deviceId: { exact: 'mic-usb' } }, video: false })
    await checkDecoded(page, 0, 660)
    console.log('PASS 来源面板只枚举设备；显式授权后立即释放；选择 USB 来源后实际编码对应音源，录制中禁止切换')

    await mountEditor(page, baseURL)
    await expect(page.getByTestId('preview-record-source')).toHaveAttribute('title', /USB 采访麦克风/)
    await page.getByTestId('preview-record-source').click()
    // The fresh page has no grant state, but the stored exact choice stays visible.
    await expect(page.getByTestId('preview-record-device')).toHaveValue('mic-usb')
    await page.getByTestId('preview-record-source-refresh').click()
    await expect(page.getByTestId('preview-record-source-refresh')).toHaveText('刷新设备')
    await devicesReleased(page)
    await page.evaluate(() => {
      window.microphoneFixture.devices = window.microphoneFixture.devices.filter(device => device.id !== 'mic-usb')
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
    })
    await expect(page.getByTestId('preview-record-device')).toHaveValue('mic-usb')
    await expect(page.getByTestId('preview-record-device').locator('option:checked')).toContainText('已断开')
    await expect(page.getByTestId('preview-record-source-panel').getByRole('alert')).toContainText('已断开')
    const beforeMissing = await page.evaluate(() => window.microphoneFixture.requests.length)
    await page.getByRole('button', { name: '关闭麦克风来源', exact: true }).click()
    await page.getByTestId('preview-record').click()
    await expect(page.getByTestId('preview-record-error')).toContainText('所选麦克风')
    assert.equal(await page.evaluate(() => window.microphoneFixture.requests.length), beforeMissing, '已知断开设备不应悄悄采集默认麦克风')
    assert.equal(await page.evaluate(() => window.microphoneEditor.state.saved.length), 0)
    await page.getByTestId('preview-record-source').click()
    await page.getByTestId('preview-record-device').selectOption('mic-internal')
    await expect(page.getByTestId('preview-record-error')).toHaveCount(0)
    await page.getByRole('button', { name: '关闭麦克风来源', exact: true }).click()
    await page.getByTestId('preview-record').click()
    await finishRecording(page)
    assert.equal(await page.evaluate(() => window.microphoneFixture.requests.at(-1).constraints.audio.deviceId.exact), 'mic-internal')
    await checkDecoded(page, 0, 330)
    console.log('PASS 重开保留精确来源；设备拔出显式提示并阻止默认回退；改选内置输入编码另一条实际波形')

    await page.getByTestId('preview-record-source').click()
    await page.getByTestId('preview-record-device').selectOption('')
    await page.getByRole('button', { name: '关闭麦克风来源', exact: true }).click()
    await page.getByTestId('preview-record').click()
    await finishRecording(page)
    assert.deepEqual(await page.evaluate(() => window.microphoneFixture.requests.at(-1).constraints), { audio: true, video: false })
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('open-media:microphone:editor'))), { deviceId: '', name: '' })
    console.log('PASS 显式切回系统默认后清除精确设备约束和持久化选择')

    await mountEditor(page, baseURL)
    await page.getByTestId('preview-record-source').click()
    await expect(page.getByTestId('preview-record-source-refresh')).toHaveText('授权并刷新')
    await page.evaluate(() => { window.microphoneFixture.mode = 'pending' })
    await page.getByTestId('preview-record-source-refresh').click()
    await expect(page.getByTestId('preview-record-source-panel').getByRole('button', { name: '取消', exact: true })).toBeVisible()
    await page.getByTestId('preview-record-source-panel').getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByTestId('preview-record-source-panel')).toHaveCount(0)
    await expect(page.getByTestId('preview-record')).toBeEnabled()
    await page.evaluate(() => window.microphoneFixture.pending.splice(0).forEach(resolve => resolve()))
    await expect.poll(() => page.evaluate(() => !!window.microphoneFixture.requests.at(-1)?.stream)).toBe(true)
    await devicesReleased(page)
    assert.deepEqual(await page.evaluate(() => window.microphoneEditor.state.busy), [true, false])
    assert.equal(await page.evaluate(() => window.microphoneEditor.state.saved.length), 0)
    assert.deepEqual(errors, [])
    console.log('PASS 来源授权可取消，迟到的麦克风流自动释放，不生成录音或锁住编辑器')
  } finally { await context.close() }

  for (const viewport of [{ width: 320, height: 850 }, { width: 800, height: 700 }]) {
    const context = await browser.newContext({ viewport }), page = await context.newPage()
    try {
      await installMicrophones(page, true)
      await page.goto(baseURL)
      await page.getByTestId('create-project').click()
      await visibleInside(page, page.getByTestId('preview-record'), viewport)
      await visibleInside(page, page.getByTestId('preview-record-source'), viewport)
      await page.getByTestId('preview-record-source').click()
      await expect(page.getByTestId('preview-record-device').locator('option')).toHaveCount(3)
      await visibleInside(page, page.getByTestId('preview-record-source-panel'), viewport)
      await visibleInside(page, page.getByTestId('preview-record-device'), viewport)
      await page.getByTestId('preview-record-device').selectOption('mic-usb')
      await page.screenshot({ path: path.join(artifacts, `editor-source-${viewport.width}.png`) })
      await page.getByRole('button', { name: '关闭麦克风来源', exact: true }).click()
      await page.getByTestId('preview-record').click()
      await expect(page.getByTestId('preview-record')).toHaveAttribute('aria-label', '停止录音')
      await expect(page.getByTestId('preview-record-source')).toBeDisabled()
      for (const id of ['preview-record', 'preview-record-status']) await visibleInside(page, page.getByTestId(id), viewport)
      await finishRecording(page)
      await expect(page.locator('.timeline-clip.audio')).toHaveCount(1)
      console.log(`PASS ${viewport.width}px 真实剪辑布局的来源面板、录音按钮和时长可见，所选来源录音进入配音轨道`)
    } finally { await context.close() }
  }
}

async function mountOverlay(page, baseURL, screenshot = false, enumerationFailure = false) {
  await page.route('**/__microphone_capture__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${baseURL}/__microphone_capture__`)
  await page.evaluate(async ({ screenshot, enumerationFailure }) => {
    window.microphoneFixture.enumerationFailure = enumerationFailure
    if (enumerationFailure) localStorage.removeItem('open-media:microphone:capture-browser')
    await import('/src/style.css')
    const source = await (await fetch('/src/components/CaptureSelectionOverlay.vue')).text()
    const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h } = await import(vueImport), Overlay = (await import('/src/components/CaptureSelectionOverlay.vue')).default
    const context = { requestId: 'browser-mic-test', displayId: 'screen:1',
      display: { id: 'screen:1', name: '测试共享画面', logicalWidth: 800, logicalHeight: 600, pixelWidth: 800, pixelHeight: 600 },
      targets: [{ id: 'screen:1', name: '测试共享画面', kind: 'screen', rect: { x: 0, y: 0, width: 800, height: 600 }, sourceWidth: 800, sourceHeight: 600 }],
      preferences: { mode: 'screen', purpose: screenshot ? 'screenshot' : 'record' } }
    const state = { confirmed: [], canceled: 0 }
    const app = createApp({ render: () => h(Overlay, { context, embedded: true,
      onConfirm: selection => state.confirmed.push(selection), onCancel: () => { state.canceled++; app.unmount() } }) })
    app.mount('#app'); window.microphonePicker = state
  }, { screenshot, enumerationFailure })
}

async function overlayChecks(browser, baseURL) {
  const context = await browser.newContext({ viewport: { width: 800, height: 700 } }), page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await installMicrophones(page)
    await mountOverlay(page, baseURL)
    const source = page.getByTestId('capture-picker-audio-source'), refresh = page.getByTestId('capture-picker-audio-refresh')
    await expect(refresh).toHaveAttribute('aria-label', '授权并刷新麦克风')
    assert.equal(await page.evaluate(() => window.microphoneFixture.requests.length), 0, '显示录制选择面板不能自动申请麦克风')
    await refresh.click()
    await expect(refresh).toHaveAttribute('aria-label', '刷新麦克风列表')
    await devicesReleased(page)
    await expect(source.locator('option')).toHaveCount(3)
    await source.selectOption('mic-usb')
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('open-media:microphone:capture-browser'))), { deviceId: 'mic-usb', name: 'USB 采访麦克风' })
    assert.equal(await page.evaluate(() => localStorage.getItem('open-media:microphone:editor')), null, '录屏来源与剪辑录音的选择分别保存')
    await page.evaluate(() => { window.microphoneFixture.devices.pop(); navigator.mediaDevices.dispatchEvent(new Event('devicechange')) })
    await expect(source.locator('option:checked')).toContainText('USB 采访麦克风（不可用）')
    await source.selectOption('mic-internal')
    await page.evaluate(() => {
      window.microphoneFixture.devices = [{ id: 'mic-usb', name: 'USB 采访麦克风', frequency: 660 }]
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
    })
    await expect(source.locator('option:checked')).toContainText('内置麦克风（不可用）')
    await source.selectOption('mic-usb')
    await page.evaluate(() => {
      window.microphoneFixture.devices = [{ id: 'mic-internal', name: '内置麦克风', frequency: 330 }]
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
    })
    await expect(source.locator('option:checked')).toContainText('USB 采访麦克风（不可用）')
    await expect(page.getByTestId('capture-picker-confirm')).toBeDisabled()
    await expect(page.getByRole('alert')).toContainText('所选麦克风')
    await page.getByTestId('capture-picker-microphone').click()
    await expect(page.getByTestId('capture-picker-confirm')).toBeEnabled()
    await page.getByTestId('capture-picker-confirm').click()
    assert.deepEqual(await page.evaluate(() => window.microphonePicker.confirmed[0]), { sourceId: 'screen:1', outputSize: undefined, microphone: false, audioDevice: 'mic-usb' })
    assert.equal(await page.evaluate(() => window.microphoneFixture.requests.length), 1)
    console.log('PASS 网页录制来源按需授权并立即释放，独立记忆选择；热拔出阻止有声录制，关闭麦克风保留来源')

    await mountOverlay(page, baseURL)
    await expect(source).toHaveValue('mic-usb')
    await expect(refresh).toHaveAttribute('aria-label', '授权并刷新麦克风')
    await page.evaluate(() => { window.microphoneFixture.mode = 'pending' })
    await refresh.click()
    await expect(page.getByTestId('capture-picker-confirm')).toBeDisabled()
    await page.getByTestId('capture-picker-cancel').click()
    await expect(page.getByTestId('capture-picker-audio-source')).toHaveCount(0)
    await page.evaluate(() => window.microphoneFixture.pending.splice(0).forEach(resolve => resolve()))
    await expect.poll(() => page.evaluate(() => !!window.microphoneFixture.requests.at(-1)?.stream)).toBe(true)
    await devicesReleased(page)
    assert.equal(await page.evaluate(() => window.microphonePicker.canceled), 1)
    assert.equal(await page.evaluate(() => window.microphonePicker.confirmed.length), 0)
    console.log('PASS 网页录制来源授权期间不能启动，取消选区会释放迟到设备且不确认录制')

    await mountOverlay(page, baseURL, false, true)
    await expect(source).toHaveValue('')
    await expect(page.getByRole('alert')).toContainText('无法读取麦克风')
    await expect(page.getByTestId('capture-picker-confirm')).toBeEnabled()
    assert.equal(await page.evaluate(() => window.microphoneFixture.requests.length), 0)
    await page.getByTestId('capture-picker-confirm').click()
    assert.deepEqual(await page.evaluate(() => window.microphonePicker.confirmed[0]), { sourceId: 'screen:1', outputSize: undefined, microphone: true, audioDevice: '' })
    console.log('PASS 设备枚举失败只显示提醒，不阻止用户确认系统默认麦克风')

    await mountOverlay(page, baseURL, true)
    await expect(page.getByTestId('capture-picker-confirm')).toBeEnabled()
    for (const id of ['capture-picker-microphone', 'capture-picker-audio-source', 'capture-picker-audio-refresh']) await expect(page.getByTestId(id)).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => ({ requests: window.microphoneFixture.requests.length, enumerations: window.microphoneFixture.enumerations })), { requests: 0, enumerations: 0 })
    await page.getByTestId('capture-picker-confirm').click()
    assert.deepEqual(await page.evaluate(() => window.microphonePicker.confirmed[0]), { sourceId: 'screen:1', outputSize: undefined })
    assert.deepEqual(errors, [])
    console.log('PASS 截屏面板没有麦克风控件，不枚举或申请麦克风，不携带录音配置')
  } finally { await context.close() }
}

async function main() {
  fs.mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**/src-tauri/target/**'] }, hmr: false }, logLevel: 'error' })
  await server.listen()
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] })
    await editorChecks(browser, baseURL)
    await overlayChecks(browser, baseURL)
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
