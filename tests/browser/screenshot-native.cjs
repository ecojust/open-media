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
    let callbackId = 0, listenerId = 0
    const state = { managed: JSON.parse(localStorage.getItem('screenshot-fixture:managed') || '{}'), calls: [], shortcut: null, rejectShortcut: null, rejectClipboard: false, picker: null, capture: null, completed: [], unexpected: [] }
    for (const project of Object.values(state.managed)) for (const asset of project.assets) urls.set(asset.nativePath, asset.url)
    function asset(name, width, height, color) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, width, height)
      const url = canvas.toDataURL('image/png'), id = `native-screenshot-fixture-${crypto.randomUUID()}`, nativePath = `/screenshot-fixture/${id}.png`
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
        if (command === 'copy_image_to_clipboard') {
          if (!(args instanceof Uint8Array)) throw new Error('图片剪贴板命令必须使用二进制消息')
          const header = new DataView(args.buffer, args.byteOffset, args.byteLength)
          const width = header.getUint32(0, true), height = header.getUint32(4, true)
          if (args.byteLength !== 8 + width * height * 4) throw new Error('图片剪贴板消息尺寸与像素长度不一致')
          state.calls.push({ command, args: { width, height, byteLength: args.byteLength, firstPixel: [...args.slice(8, 12)], lastPixel: [...args.slice(-4)] } })
          if (state.rejectClipboard) throw new Error('无法访问系统剪贴板，请稍后重试。')
          if (state.holdClipboard) return new Promise(resolve => { state.finishClipboard = resolve })
          return null
        }
        state.calls.push({ command, args })
        if (command === 'plugin:event|listen') { const id = ++listenerId; listeners.set(id, args); return id }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null }
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'get_desktop_platform') return 'macos'
        if (command === 'get_media_jobs') return []
        if (command === 'list_stored_videos') return { directory: '/screenshot-fixture/recording', assets: [], warnings: [] }
        if (command === 'list_workspace_assets') return { directories: Object.fromEntries(args.categories.map(category => [category, `/screenshot-fixture/${category}`])), assets: args.categories.includes('screenshot') ? state.completed : [], warnings: [] }
        if (command === 'open_workspace_directory') return
        if (command === 'list_managed_projects') return Object.values(state.managed).map(project => ({ id: project.id, title: project.title, width: project.width, height: project.height, updatedAt: project.updatedAt, duration: 0, assetCount: project.assets.length }))
        if (command === 'ensure_project_media') return { directory: `/screenshot-fixture/projects/${args.projectId}`, assets: args.assets.map(item => {
          const nativePath = `/screenshot-fixture/projects/${args.projectId}/assets/${item.id}.png`
          urls.set(nativePath, urls.get(item.nativePath) || item.url)
          return { assetId: item.id, nativePath, size: item.size }
        }) }
        if (command === 'save_managed_project') { state.managed[args.project.id] = structuredClone(args.project); localStorage.setItem('screenshot-fixture:managed', JSON.stringify(state.managed)); return { directory: `/screenshot-fixture/projects/${args.project.id}`, savedAt: new Date().toISOString() } }
        if (command === 'load_managed_project') return structuredClone(state.managed[args.projectId])
        if (command === 'remove_managed_project_draft') return
        if (command === 'ai_get_status') return { models: [], jobs: [], busy: false }
        if (command === 'mcp_pending') return []
        if (command === 'mcp_get_status') return { running: false, host: '127.0.0.1', port: 39861, url: null, pendingRequests: 0, connectedClients: 0 }
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
      server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: () => true } }, logLevel: 'error' })
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
    await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 30000 }).catch(async cause => { console.error(await page.locator('body').innerText(), errors, await page.evaluate(() => window.screenshotHarness?.unexpected)); throw cause })

    await check('桌面截屏先订阅事件再注册默认快捷键，不提前读取屏幕或打开录制', async () => {
      await expect.poll(async () => (await calls(page, 'configure_screenshot_shortcut')).length).toBe(1)
      assert.deepEqual((await calls(page, 'configure_screenshot_shortcut'))[0].args, { shortcut: defaultShortcut })
      const trace = await page.evaluate(() => window.screenshotHarness.calls)
      assert(trace.findIndex(call => call.command === 'plugin:event|listen' && call.args.event === 'screenshot-requested') < trace.findIndex(call => call.command === 'configure_screenshot_shortcut'))
      await expect.poll(async () => (await calls(page, 'mcp_pending')).length).toBe(1)
      assert.equal((await calls(page, 'mcp_start')).length, 0, '启动时查询待处理请求不能自动启动 MCP 服务')
      for (const command of ['pick_capture_source', 'capture_screenshot', 'start_capture', 'list_capture_devices', 'show_main_window']) assert.equal((await calls(page, command)).length, 0)
      await page.getByTestId('nav-record').click()
      await page.getByTestId('screenshot-settings-open').click()
      await expect(page.getByTestId('screenshot-shortcut')).toContainText('Ctrl + Shift + 2')
      await expect(page.getByTestId('screenshot-controls')).toContainText('全局生效')
      await page.keyboard.press('Escape')
    })

    await check('原生事件选择截屏范围，等待完成才前置应用，仅选中新图片并显示真实PNG', async () => {
      await page.getByTestId('nav-image').click()
      await page.getByRole('button', { name: '导入图片', exact: true }).click()
      await expect(page.locator('.convert-source')).toHaveCount(2)
      await expect(page.locator('.convert-source input:checked')).toHaveCount(2)
      await page.getByRole('navigation', { name: '工作区' }).getByRole('button', { name: '开始', exact: true }).click()
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
      await page.evaluate(() => { window.screenshotHarness.holdClipboard = true; window.screenshotHarness.finishCapture() })
      await expect(page.getByTestId('convert-workspace')).toBeVisible()
      await expect(page.locator('.convert-toolbar h1')).toHaveText('图片编辑')
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
      await expect.poll(async () => (await calls(page, 'copy_image_to_clipboard')).length).toBe(1)
      const returned = await page.evaluate(() => window.screenshotHarness.calls)
      assert(returned.findIndex(item => item.command === 'show_main_window') < returned.findIndex(item => item.command === 'copy_image_to_clipboard'), '返回主窗口不能等待剪贴板写入')
      await page.evaluate(() => { window.screenshotHarness.holdClipboard = false; window.screenshotHarness.finishClipboard() })
      await expect(page.locator('.status-main')).toContainText('已复制')
      assert.deepEqual((await calls(page, 'copy_image_to_clipboard'))[0].args, { width: 64, height: 40, byteLength: 8 + 64 * 40 * 4, firstPixel: [26, 120, 188, 255], lastPixel: [26, 120, 188, 255] })
      await page.getByTestId('nav-edit').click()
      await expect(page.locator('.project-summary')).toContainText('0 个素材')
      await page.getByTestId('nav-image').click()
      await expect(page.getByTestId('convert-image-preview')).toHaveAttribute('alt', '截屏-1.png')
    })

    await check('取消范围选择不创建素材并恢复主窗口，弹窗打开时忽略截屏事件', async () => {
      await emitScreenshot(page)
      await expect.poll(async () => (await calls(page, 'pick_capture_source')).length).toBe(2)
      await page.evaluate(() => window.screenshotHarness.finishPicker(null))
      await expect(page.locator('.status-main')).toContainText('已取消截屏')
      assert.equal((await calls(page, 'capture_screenshot')).length, 1)
      assert.equal((await calls(page, 'copy_image_to_clipboard')).length, 1, '取消截屏不能写入剪贴板')
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
      await page.getByTestId('screenshot-settings-open').click()
      const editor = page.getByTestId('screenshot-shortcut')
      await page.evaluate(() => { window.screenshotHarness.rejectShortcut = 'Ctrl+Shift+9' })
      await editor.click()
      await editor.press('Control+Shift+9')
      await expect(page.getByTestId('screenshot-controls').getByRole('alert')).toContainText('此快捷键已被占用')
      await expect(editor).toContainText('Ctrl + Shift + 2')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('recorder-workspace').getByRole('alert')).toContainText('此快捷键已被占用')
      await page.getByTestId('screenshot-settings-open').click()
      await expect(page.getByTestId('screenshot-controls').getByRole('alert')).toContainText('此快捷键已被占用')
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
      await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 30000 }).catch(async cause => { console.error(await page.locator('body').innerText(), errors, await page.evaluate(() => window.screenshotHarness?.unexpected)); throw cause })
      await expect.poll(async () => (await calls(page, 'configure_screenshot_shortcut')).length).toBe(1)
      assert.deepEqual((await calls(page, 'configure_screenshot_shortcut'))[0].args, { shortcut: null })
      await page.getByTestId('nav-record').click()
      await page.getByTestId('screenshot-settings-open').click()
      await expect(page.getByTestId('screenshot-shortcut')).toContainText('未启用')
      await page.getByRole('button', { name: '恢复默认', exact: true }).click()
      await expect(page.getByTestId('screenshot-shortcut')).toContainText('Ctrl + Shift + 2')
      assert.equal(await page.evaluate(() => localStorage.getItem('open-media:screenshot-shortcut')), defaultShortcut)
    })

    await check('顶部弹窗立即截屏先关闭设置，再启动原生范围选择', async () => {
      const before = (await calls(page, 'pick_capture_source')).length
      await emitScreenshot(page)
      assert.equal((await calls(page, 'pick_capture_source')).length, before, '设置弹窗打开时不响应原生快捷键')
      await page.getByTestId('screenshot-start').click()
      await expect(page.getByRole('dialog', { name: '截屏设置', exact: true })).toHaveCount(0)
      await expect.poll(async () => (await calls(page, 'pick_capture_source')).length).toBe(before + 1)
      await page.evaluate(() => window.screenshotHarness.finishPicker(null))
      await expect(page.locator('.status-main')).toContainText('已取消截屏')
      await expect(page.getByTestId('screenshot-settings-open')).toBeFocused()
    })

    await check('原生剪贴板写入失败保留截屏，可手动重试相同图片像素', async () => {
      await page.evaluate(() => { window.screenshotHarness.rejectClipboard = true })
      await emitScreenshot(page)
      await expect.poll(() => page.evaluate(() => !!window.screenshotHarness.picker)).toBe(true)
      await page.evaluate(selection => window.screenshotHarness.finishPicker(selection), selection)
      await expect.poll(() => page.evaluate(() => !!window.screenshotHarness.capture)).toBe(true)
      await page.evaluate(() => window.screenshotHarness.finishCapture())
      await expect(page.getByTestId('convert-image-preview')).toBeVisible()
      await expect(page.locator('.status-main')).toContainText('剪贴板')
      await expect(page.locator('.status-main')).not.toContainText('已复制')
      await expect.poll(async () => (await calls(page, 'copy_image_to_clipboard')).length).toBe(1)
      const before = await page.locator('.convert-source').count()
      await page.evaluate(() => { window.screenshotHarness.rejectClipboard = false })
      await page.getByTestId('image-copy').click()
      await expect(page.getByTestId('image-copy-status')).toHaveText('图片已复制')
      const copies = await calls(page, 'copy_image_to_clipboard')
      assert.equal(copies.length, 2)
      assert.deepEqual(copies[1].args, copies[0].args)
      await expect(page.locator('.convert-source')).toHaveCount(before)
      await expect(page.getByTestId('convert-result')).toHaveCount(0)
      await page.locator('.convert-source.active').click({ button: 'right' })
      await page.getByRole('menuitem', { name: '添加到工程素材', exact: true }).click()
      await expect(page.locator('.status-main')).toContainText('素材已加入当前工程')
      await page.getByTestId('nav-edit').click()
      await expect(page.locator('.project-summary')).toContainText('1 个素材')
      const accepted = (await calls(page, 'ensure_project_media')).find(call => call.args.assets.length === 1)
      assert(accepted?.args.assets[0].nativePath.startsWith('/screenshot-fixture/native-screenshot-fixture-'), '显式加入工程时才提交原始截图到工程收录通道')
    })

    await check('项目素材已满仍能截屏、复制并载入独立图片工作区，不改变工程素材', async () => {
      const fullProject = await page.evaluate(async () => {
        const { createProject, MAX_ASSETS } = await import('/src/core/project.ts')
        const project = createProject('素材已满的截屏项目')
        const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2
        const url = canvas.toDataURL('image/png')
        project.assets = Array.from({ length: MAX_ASSETS }, (_, index) => ({
          id: `capacity-image-${index}`, name: `已有图片-${index}.png`, kind: 'image',
          url, nativePath: `/screenshot-fixture/capacity-image-${index}.png`,
          width: 2, height: 2, duration: 0, size: 100, mime: 'image/png',
        }))
        await window.__TAURI_INTERNALS__.invoke('save_managed_project', { project })
        localStorage.setItem('open-media:last-project', project.id)
        return { id: project.id, count: MAX_ASSETS, assetIds: project.assets.map(asset => asset.id) }
      })
      await page.reload()
      await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 30000 }).catch(async cause => { console.error(await page.locator('body').innerText(), errors, await page.evaluate(() => window.screenshotHarness?.unexpected)); throw cause })
      await expect.poll(async () => (await calls(page, 'configure_screenshot_shortcut')).length).toBe(1)
      await page.getByTestId('nav-edit').click()
      await expect(page.locator('.project-summary')).toContainText(`${fullProject.count} 个素材`)
      await page.getByTestId('nav-record').click()
      await emitScreenshot(page)
      await expect.poll(() => page.evaluate(() => !!window.screenshotHarness.picker)).toBe(true)
      await page.evaluate(selection => window.screenshotHarness.finishPicker(selection), selection)
      await expect.poll(() => page.evaluate(() => !!window.screenshotHarness.capture)).toBe(true)
      await page.evaluate(() => window.screenshotHarness.finishCapture())
      await expect.poll(async () => (await calls(page, 'copy_image_to_clipboard')).length).toBe(1)
      assert.deepEqual((await calls(page, 'copy_image_to_clipboard'))[0].args, {
        width: 64, height: 40, byteLength: 8 + 64 * 40 * 4,
        firstPixel: [26, 120, 188, 255], lastPixel: [26, 120, 188, 255],
      }, '达到项目容量不能阻断截屏的二进制剪贴板写入')
      await expect(page.locator('.status-main')).toContainText('截屏已复制到剪贴板，并载入图片编辑')
      await expect(page.locator('.app-error')).toHaveCount(0)
      await expect(page.getByTestId('convert-workspace')).toBeVisible()
      await expect(page.getByTestId('convert-image-preview')).toHaveAttribute('alt', '截屏-1.png')
      await expect(page.locator('.convert-source')).toHaveCount(1)
      await expect.poll(async () => (await calls(page, 'show_main_window')).length).toBe(1)
      await page.getByTestId('nav-edit').click()
      await expect(page.locator('.project-summary')).toContainText(`${fullProject.count} 个素材`)
      const retainedAssetIds = await page.evaluate(async id => {
        const saved = await window.__TAURI_INTERNALS__.invoke('load_managed_project', { projectId: id })
        return saved.assets.map(asset => asset.id)
      }, fullProject.id)
      assert.deepEqual(retainedAssetIds, fullProject.assetIds, '截图工作区不能删除、替换或追加原项目素材')
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
