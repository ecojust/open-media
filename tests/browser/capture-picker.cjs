const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function mount(page, baseURL, options = {}) {
  await page.route('**/__capture_picker__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${baseURL}/__capture_picker__`)
  await page.evaluate(async options => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/CaptureSelectionOverlay.vue')).text()
    const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, nextTick } = await import(vueImport)
    const Overlay = (await import('/src/components/CaptureSelectionOverlay.vue')).default
    const context = {
      requestId: 'interaction-test', displayId: 'screen:1',
      display: { id: 'screen:1', name: '主屏幕 · 2 倍缩放', logicalWidth: 1280, logicalHeight: 800, pixelWidth: 2560, pixelHeight: 1600 },
      targets: [
        { id: 'screen:1', name: '主屏幕', kind: 'screen', rect: { x: 0, y: 0, width: 1280, height: 800 }, sourceWidth: 2560, sourceHeight: 1600 },
        { id: 'window:front', name: '资料窗口', kind: 'window', rect: { x: 300, y: 180, width: 600, height: 350 }, sourceWidth: 1200, sourceHeight: 700 },
        { id: 'window:back', name: '编辑窗口', kind: 'window', rect: { x: 100, y: 100, width: 900, height: 600 }, sourceWidth: 1800, sourceHeight: 1200 },
      ], audioDevices: options.audioDevices, audioState: options.audioState, audioError: options.audioError, preferences: { mode: options.mode ?? 'region', purpose: options.purpose, microphone: options.microphone, audioDevice: options.audioDevice ?? '' },
    }
    if (options.windowOnly) { context.availableModes = ['window']; context.targets = [context.targets[1]]; context.preferences.mode = 'window' }
    const contextRef = shallowRef(context)
    window.pickerHarness = { confirmed: [], canceled: 0, audioRequests: [], replaceContext: async patch => { contextRef.value = { ...contextRef.value, ...patch }; await nextTick() } }
    const app = createApp({ render: () => h(Overlay, { context: contextRef.value, embedded: options.embedded ?? false, onConfirm: selection => window.pickerHarness.confirmed.push(selection), onCancel: () => window.pickerHarness.canceled++ }, {
      background: () => h('div', { style: 'position:absolute;inset:0;background:linear-gradient(120deg,#4a647c,#789baf);' }, [
        h('div', { style: 'position:absolute;left:7.8125%;top:12.5%;width:70.3125%;height:75%;background:#e6edf4;border-radius:10px;box-shadow:0 12px 35px #182c4440;padding:20px;color:#33475b;' }, '编辑窗口'),
        h('div', { style: 'position:absolute;left:23.4375%;top:22.5%;width:46.875%;height:43.75%;background:#fff;border-radius:10px;box-shadow:0 10px 30px #182c4440;padding:20px;color:#33475b;' }, '资料窗口'),
      ]),
    }) })
    // Interaction uses the same public events as embedded source selection.
    app.mount('#app')
    window.pickerHarness.cleanup = () => app.unmount()
    if (!options.embedded) {
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        if (command === 'get_capture_picker_context') return new Promise((resolve, reject) => {
          const snapshot = structuredClone(contextRef.value)
          window.pickerHarness.audioRequests.push({ requestId: args.requestId, finish: patch => resolve({ ...snapshot, audioState: 'ready', ...patch }), fail: message => reject(new Error(message)) })
        })
        if (command !== 'complete_capture_picker') throw new Error(`未知命令 ${command}`)
        if (args.selection) window.pickerHarness.confirmed.push(args.selection)
        else window.pickerHarness.canceled++
      } }
    }
  }, options)
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**/src-tauri/target/**'] }, hmr: false }, logLevel: 'error' })
  await server.listen()
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await mount(page, baseURL)
    assert.equal(await page.getByTestId('capture-picker-microphone').getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByTestId('capture-picker-confirm').isDisabled(), true)
    await drag(page, { x: 100, y: 100 }, { x: 500, y: 350 })
    assert.equal(await page.getByLabel('选区宽度').inputValue(), '800')
    assert.equal(await page.getByLabel('选区高度').inputValue(), '500')
    await drag(page, { x: 250, y: 200 }, { x: 300, y: 230 })
    let frame = await page.getByTestId('capture-selection-frame').boundingBox()
    assert.equal(frame.x, 150); assert.equal(frame.y, 130)
    const handle = await page.getByTestId('capture-handle-se').boundingBox()
    await drag(page, { x: handle.x + 5, y: handle.y + 5 }, { x: handle.x + 45, y: handle.y + 35 })
    assert.equal(await page.getByLabel('选区宽度').inputValue(), '880')
    assert.equal(await page.getByLabel('选区高度').inputValue(), '560')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    frame = await page.getByTestId('capture-selection-frame').boundingBox()
    assert.equal(frame.x, 150.5); assert.equal(frame.y, 135)
    await page.getByLabel('选区宽度').fill('640')
    await page.getByLabel('选区宽度').press('Tab')
    assert.equal((await page.getByTestId('capture-selection-frame').boundingBox()).width, 320)
    await page.getByLabel('输出尺寸').selectOption('custom')
    await page.getByLabel('输出宽度').fill('641')
    assert.equal(await page.getByTestId('capture-picker-confirm').isDisabled(), true)
    assert.match(await page.getByRole('alert').innerText(), /偶数/)
    await page.getByLabel('输出宽度').fill('640')
    await page.getByLabel('输出高度').fill('480')
    fs.mkdirSync('test-results/browser', { recursive: true })
    await page.screenshot({ path: 'test-results/browser/capture-picker-region.png' })
    await page.getByTestId('capture-picker-confirm').click()
    assert.deepEqual(await page.evaluate(() => window.pickerHarness.confirmed[0]), { sourceId: 'screen:1', region: { x: 301, y: 270, width: 640, height: 560 }, outputSize: { width: 640, height: 480 }, microphone: true, audioDevice: '' })
    console.log('PASS 实际拖拽、八手柄中的角点缩放、物理像素微调、选区尺寸与输出尺寸校验')

    await mount(page, baseURL, { mode: 'window' })
    await page.mouse.move(400, 240)
    assert.match(await page.locator('.selection-caption').innerText(), /资料窗口/)
    assert.equal(await page.getByTestId('capture-picker-confirm').isDisabled(), true)
    await page.mouse.click(400, 240)
    assert.equal(await page.getByTestId('capture-picker-confirm').isDisabled(), false)
    await page.getByTestId('capture-picker-microphone').click()
    assert.equal(await page.getByTestId('capture-picker-microphone').getAttribute('aria-pressed'), 'false')
    assert.match(await page.getByTestId('capture-picker-microphone').innerText(), /麦克风关/)
    await page.screenshot({ path: 'test-results/browser/capture-picker-window.png' })
    await page.getByTestId('capture-picker-confirm').click()
    assert.deepEqual(await page.evaluate(() => window.pickerHarness.confirmed[0]), { sourceId: 'window:front', outputSize: undefined, microphone: false, audioDevice: '' })
    await mount(page, baseURL, { mode: 'screen' })
    await page.getByTestId('capture-selection-stage').focus()
    await page.keyboard.press('Enter')
    assert.deepEqual(await page.evaluate(() => window.pickerHarness.confirmed[0]), { sourceId: 'screen:1', outputSize: undefined, microphone: true, audioDevice: '' })
    console.log('PASS 窗口悬停高亮/点击锁定、层叠命中和屏幕快捷键确认')

    await mount(page, baseURL, { mode: 'screen', microphone: false })
    assert.equal(await page.getByTestId('capture-picker-microphone').getAttribute('aria-pressed'), 'false')
    await page.getByTestId('picker-mode-window').click()
    await page.getByTestId('picker-mode-screen').click()
    assert.equal(await page.getByTestId('capture-picker-microphone').getAttribute('aria-pressed'), 'false')
    await page.getByTestId('capture-picker-microphone').click()
    await page.getByTestId('capture-picker-confirm').click()
    assert.equal(await page.evaluate(() => window.pickerHarness.confirmed[0].microphone), true)

    const audioDevices = [{ id: 'native-internal', name: '内置麦克风' }, { id: 'native-usb', name: 'USB 采访麦克风' }]
    await mount(page, baseURL, { mode: 'screen', audioDevices, audioDevice: 'native-internal' })
    const microphoneSource = page.getByTestId('capture-picker-audio-source')
    assert.equal(await microphoneSource.inputValue(), 'native-internal')
    assert.equal(await microphoneSource.locator('option').count(), 3)
    await microphoneSource.selectOption('native-usb')
    await page.getByTestId('capture-picker-microphone').click()
    assert.equal(await microphoneSource.isDisabled(), false, '麦克风关闭时仍可预选稍后启用的来源')
    await page.getByTestId('capture-picker-confirm').click()
    assert.deepEqual(await page.evaluate(() => window.pickerHarness.confirmed[0]), { sourceId: 'screen:1', outputSize: undefined, microphone: false, audioDevice: 'native-usb' })
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('open-media:microphone:capture-native')).deviceId), 'native-usb')
    await mount(page, baseURL, { mode: 'screen', audioDevices: audioDevices.slice(0, 1), audioDevice: 'native-usb' })
    assert.equal(await microphoneSource.inputValue(), 'native-usb')
    assert.match(await microphoneSource.locator('option:checked').innerText(), /不可用|已断开/)
    assert.equal(await page.getByTestId('capture-picker-confirm').isDisabled(), true)
    assert.match(await page.getByRole('alert').innerText(), /麦克风.*断开/)
    await page.getByTestId('capture-picker-microphone').click()
    assert.equal(await page.getByTestId('capture-picker-confirm').isDisabled(), false)
    await page.getByTestId('capture-picker-microphone').click()
    await microphoneSource.selectOption('')
    assert.equal(await page.getByTestId('capture-picker-confirm').isDisabled(), false)
    await page.getByTestId('capture-picker-confirm').click()
    assert.equal(await page.evaluate(() => window.pickerHarness.confirmed[0].audioDevice), '')
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('open-media:microphone:capture-native')).deviceId), '')
    console.log('PASS 原生麦克风来源可选择并持久化，关闭麦克风保留来源，已断开来源阻止录制且可改回默认')

    await mount(page, baseURL, { audioState: 'loading', audioDevices: [], audioDevice: 'native-usb' })
    await expect(page.getByTestId('capture-picker-audio-loading')).toBeVisible()
    await drag(page, { x: 100, y: 100 }, { x: 500, y: 350 })
    await page.getByLabel('输出尺寸').selectOption('720p')
    await expect(page.getByTestId('capture-picker-confirm')).toBeDisabled()
    await page.getByTestId('picker-mode-window').click()
    await page.mouse.click(400, 240)
    await expect(page.locator('.selection-caption')).toContainText('资料窗口')
    await page.getByTestId('picker-mode-region').click()
    await page.getByTestId('capture-picker-microphone').click()
    await expect(page.getByTestId('capture-picker-confirm')).toBeEnabled()
    await page.waitForFunction(() => window.pickerHarness.audioRequests.length === 1)
    await page.evaluate(audioDevices => window.pickerHarness.audioRequests[0].finish({ audioDevices }), audioDevices)
    await expect(page.getByTestId('capture-picker-audio-loading')).toHaveCount(0)
    await expect(page.getByLabel('选区宽度')).toHaveValue('800')
    await expect(page.getByLabel('选区高度')).toHaveValue('500')
    await expect(page.getByLabel('输出尺寸')).toHaveValue('720p')
    await expect(microphoneSource).toHaveValue('native-usb')
    await expect(page.getByTestId('capture-picker-microphone')).toHaveAttribute('aria-pressed', 'false')
    await page.getByTestId('capture-picker-confirm').click()
    assert.deepEqual(await page.evaluate(() => window.pickerHarness.confirmed[0]), { sourceId: 'screen:1', region: { x: 200, y: 200, width: 800, height: 500 }, outputSize: { width: 1280, height: 720 }, microphone: false, audioDevice: 'native-usb' })
    console.log('PASS 音频后台加载不阻塞选区和窗口选择，完成后保留用户区域、输出尺寸及麦克风偏好')

    for (const finish of ['confirm', 'cancel', 'unmount']) {
      await mount(page, baseURL, { mode: 'screen', audioState: 'loading', audioDevices: [] })
      await page.waitForFunction(() => window.pickerHarness.audioRequests.length === 1)
      if (finish === 'confirm') {
        await page.getByTestId('capture-picker-microphone').click()
        await expect(page.getByTestId('capture-picker-confirm')).toBeEnabled()
        await page.getByTestId('capture-picker-confirm').click()
        assert.equal(await page.evaluate(() => window.pickerHarness.confirmed[0].microphone), false)
      } else if (finish === 'cancel') {
        await page.getByTestId('capture-picker-cancel').click()
        assert.equal(await page.evaluate(() => window.pickerHarness.canceled), 1)
      } else await page.evaluate(() => window.pickerHarness.cleanup())
      await page.evaluate(() => window.pickerHarness.audioRequests[0].finish({ audioDevices: [{ id: 'late-device', name: '迟到设备' }] }))
      await page.waitForTimeout(350)
      assert.equal(await page.evaluate(() => window.pickerHarness.audioRequests.length), 1, `${finish} 后停止轮询`)
      assert.equal(await microphoneSource.locator('option[value="late-device"]').count(), 0, `${finish} 后忽略迟到设备`)
    }
    console.log('PASS 麦克风关闭时可立即确认，取消和销毁不等待设备，完成后迟到音频结果被丢弃')

    await mount(page, baseURL, { mode: 'screen', audioState: 'loading', audioDevices: [] })
    await page.waitForFunction(() => window.pickerHarness.audioRequests.length === 1)
    await page.evaluate(() => window.pickerHarness.replaceContext({ requestId: 'replacement', displayId: 'screen:2' }))
    await page.evaluate(() => window.pickerHarness.audioRequests[0].finish({ audioDevices: [{ id: 'stale-device', name: '旧窗口设备' }] }))
    await expect(page.getByTestId('capture-picker-audio-loading')).toBeVisible()
    assert.equal(await microphoneSource.locator('option[value="stale-device"]').count(), 0)
    await page.waitForFunction(() => window.pickerHarness.audioRequests.length === 2)
    assert.equal(await page.evaluate(() => window.pickerHarness.audioRequests[1].requestId), 'replacement')
    await page.evaluate(() => window.pickerHarness.audioRequests[1].finish({ displayId: 'wrong-display', audioDevices: [] }))
    await expect(page.getByRole('alert')).toContainText('当前选择窗口不一致')
    await expect(page.getByTestId('capture-picker-confirm')).toBeDisabled()
    await page.getByTestId('capture-picker-cancel').click()
    assert.equal(await page.evaluate(() => window.pickerHarness.canceled), 1)

    await mount(page, baseURL, { mode: 'screen', audioState: 'loading', audioDevices: [] })
    await page.waitForFunction(() => window.pickerHarness.audioRequests.length === 1)
    await page.evaluate(() => window.pickerHarness.audioRequests[0].finish({ audioState: 'error', audioError: '设备扫描失败。' }))
    await expect(page.getByRole('alert')).toContainText('设备扫描失败')
    await expect(page.getByTestId('capture-picker-confirm')).toBeDisabled()
    await page.getByTestId('capture-picker-microphone').click()
    await expect(page.getByTestId('capture-picker-confirm')).toBeEnabled()
    await page.getByTestId('capture-picker-confirm').click()
    assert.equal(await page.evaluate(() => window.pickerHarness.confirmed[0].microphone), false)
    console.log('PASS 切换会话忽略旧结果，拒绝其他显示器的状态，音频扫描失败仍可取消或关闭麦克风录制')

    await mount(page, baseURL, { mode: 'screen', purpose: 'screenshot', microphone: true })
    assert.equal(await page.getByTestId('capture-picker-microphone').count(), 0)
    assert.equal(await page.getByTestId('capture-picker-audio-source').count(), 0)
    assert.equal(await page.getByTestId('capture-picker-audio-refresh').count(), 0)
    assert.equal(await page.getByLabel('输出尺寸').count(), 0)
    await page.getByTestId('capture-picker-confirm').click()
    assert.equal(await page.evaluate(() => Object.hasOwn(window.pickerHarness.confirmed[0], 'microphone')), false)
    assert.equal(await page.evaluate(() => Object.hasOwn(window.pickerHarness.confirmed[0], 'audioDevice')), false)
    console.log('PASS 录制默认启用麦克风、选择面板可反复切换并返回选择，截屏不携带麦克风选项')

    await mount(page, baseURL, { embedded: true })
    const stage = await page.getByTestId('capture-selection-stage').boundingBox()
    await drag(page, { x: stage.x + stage.width * .1, y: stage.y + stage.height * .1 }, { x: stage.x + stage.width * .6, y: stage.y + stage.height * .5 })
    assert.equal(await page.getByLabel('选区宽度').inputValue(), '1280')
    assert.equal(await page.getByLabel('选区高度').inputValue(), '640')
    await page.getByTestId('capture-picker-confirm').focus()
    await page.keyboard.press('Tab')
    assert.equal(await page.getByTestId('capture-selection-stage').evaluate(element => document.activeElement === element), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => window.pickerHarness.canceled), 1)
    await page.setViewportSize({ width: 320, height: 700 })
    await mount(page, baseURL, { embedded: true, windowOnly: true })
    assert.equal(await page.getByTestId('picker-mode-region').count(), 0)
    assert.equal(await page.getByTestId('capture-picker-confirm').isDisabled(), false)
    const toolbar = await page.locator('.selection-toolbar').boundingBox()
    assert.ok(toolbar.x >= 0 && toolbar.x + toolbar.width <= 320)
    assert.ok(toolbar.y + toolbar.height <= 700)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320)
    await page.screenshot({ path: 'test-results/browser/capture-picker-mobile.png' })
    for (const viewport of [{ width: 320, height: 240 }, { width: 800, height: 300 }, { width: 1280, height: 300 }]) {
      await page.setViewportSize(viewport)
      await mount(page, baseURL, { embedded: true, mode: 'screen' })
      await page.getByLabel('输出尺寸').selectOption('custom')
      for (const id of ['capture-picker-microphone', 'capture-picker-audio-source', 'capture-picker-cancel', 'capture-picker-confirm']) {
        const bounds = await page.getByTestId(id).boundingBox()
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, `${id} remains reachable at ${viewport.width} × ${viewport.height}`)
      }
      assert.equal(await page.getByTestId('capture-picker-cancel').evaluate(element => element.closest('.selection-toolbar') !== null), true)
      await page.getByTestId('capture-picker-cancel').click()
      assert.deepEqual(await page.evaluate(() => ({ canceled: window.pickerHarness.canceled, confirmed: window.pickerHarness.confirmed.length })), { canceled: 1, confirmed: 0 })
    }
    const retina = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 })
    await mount(retina, baseURL, { mode: 'screen' })
    const retinaCancel = await retina.getByTestId('capture-picker-cancel').boundingBox()
    assert.ok(retinaCancel.x >= 0 && retinaCancel.y >= 0 && retinaCancel.x + retinaCancel.width <= 640 && retinaCancel.y + retinaCancel.height <= 360)
    await retina.getByTestId('capture-picker-confirm').click()
    assert.equal(await retina.evaluate(() => window.pickerHarness.confirmed[0].microphone), true)
    await retina.close()
    console.log('PASS 取消和麦克风与确认按钮同处选择面板，320px窄屏、短屏和2倍缩放均可操作')
    const nativePage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    nativePage.on('pageerror', error => errors.push(error.message))
    await nativePage.addInitScript(() => {
      window.nativePickerCalls = []
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        window.nativePickerCalls.push({ command, args })
        if (command === 'get_capture_picker_context') return {
          requestId: 'native-test', displayId: 'screen:1', display: { id: 'screen:1', name: '测试显示器', logicalWidth: 1280, logicalHeight: 800, pixelWidth: 2560, pixelHeight: 1600 },
          targets: [{ id: 'screen:1', name: '测试显示器', kind: 'screen', rect: { x: 0, y: 0, width: 1280, height: 800 }, sourceWidth: 2560, sourceHeight: 1600 }], preferences: { mode: 'region' },
        }
        if (command === 'capture_picker_ready' || command === 'complete_capture_picker') return
        throw new Error(`选区窗口调用了无关命令 ${command}`)
      } }
    })
    await nativePage.goto(`${baseURL}/?capture-picker=native-test&display=screen%3A1`)
    await nativePage.waitForFunction(() => window.nativePickerCalls.some(call => call.command === 'capture_picker_ready'))
    assert.equal(await nativePage.locator('.app-shell').count(), 0, '原生选区窗口不得加载主工作台')
    assert.equal(await nativePage.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgba(0, 0, 0, 0)')
    await nativePage.keyboard.press('Escape')
    await nativePage.waitForFunction(() => window.nativePickerCalls.some(call => call.command === 'complete_capture_picker'))
    assert.deepEqual(await nativePage.evaluate(() => window.nativePickerCalls.at(-1)), { command: 'complete_capture_picker', args: { requestId: 'native-test', selection: null } })
    await nativePage.close()
    assert.deepEqual(errors, [])
    console.log('PASS 浏览器预览缩放映射、焦点循环、Esc取消及320px窄屏布局')
    console.log('PASS 原生透明窗口入口、准备握手和取消协议')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
