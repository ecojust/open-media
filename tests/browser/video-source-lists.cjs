const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

async function mount(page, url, mode, native, source, options = {}) {
  await page.route('**/__video_lists__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.route('**/list-video/*', route => route.fulfill({ contentType: 'video/webm', body: source }))
  await page.goto(`${url}/__video_lists__`)
  await page.evaluate(async ({ mode, native, options }) => {
    await import('/src/style.css')
    const filename = mode === 'gif' ? 'GifWorkspace' : 'ConvertWorkspace'
    const source = await (await fetch(`/src/components/${filename}.vue`)).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, ref, KeepAlive } = await import(vueURL)
    const Component = (await import(`/src/components/${filename}.vue`)).default
    const asset = (id, addedAt, kind = 'video', local = true) => ({ id, addedAt, kind, name: `${id}.webm`, url: `/list-video/${id}`, duration: 8, width: 160, height: 90, size: 2048, mime: 'video/webm', ...(local ? { nativePath: `/fixture/${id}.webm` } : {}) })
    const assets = ref([asset('legacy-first'), asset('older', '2026-10-18T01:00:00Z'), asset('audio', '2030-01-01T00:00:00Z', 'audio'), asset('same-first', '2026-10-18T02:00:00Z'), asset('image', '2030-01-01T00:00:00Z', 'image'), asset('newest', '2026-10-18T03:00:00Z'), asset('same-last', '2026-10-18T02:00:00Z'), asset('legacy-last', undefined, 'video', false)])
    if (options.emptyProjectAssets) assets.value = []
    const visible = ref(true), theme = ref('light')
    const state = window.listHarness = { assets, calls: [], failReveal: false, failScan: false, holdScan: false, stored: [], warnings: [], busy: false,
      append(id, addedAt) { assets.value.push(asset(id, addedAt)) },
      addStored(id, addedAt, nativePath = `/recordings/${id}.webm`) { state.stored.push({ ...asset(id), addedAt: Date.parse(addedAt), nativePath }) },
      statuses: [], show(value) { visible.value = value }, theme(value) { theme.value = value } }
    if (options.directoryOnly) { state.addStored('only-recording-new', '2035-01-01T00:00:00Z'); state.addStored('only-recording-old', '2034-01-01T00:00:00Z') }
    const library = () => ({ directory: '/Users/demo/Library/Application Support/Open Media/recordings', assets: structuredClone(state.stored), warnings: [...state.warnings] })
    window.__TAURI_INTERNALS__ = { convertFileSrc: nativePath => `/list-video/${nativePath.split('/').pop().replace(/\.[^.]+$/, '')}`, invoke: async (command, args) => {
      state.calls.push({ command, args })
      if (command === 'get_runtime_status') return { ready: true, source: 'fixture', version: 'fixture' }
      if (command === 'list_stored_videos') {
        if (state.failScan) throw new Error('录屏目录暂时不可读取，请重试')
        if (state.holdScan) return new Promise(resolve => { state.releaseScan = () => { state.holdScan = false; resolve(library()) } })
        return library()
      }
      if (command === 'open_media_library_directory') return null
      if (command === 'reveal_media_asset') { if (state.failReveal) throw new Error('原始文件和素材副本均已移除'); return null }
      if (command === 'begin_media_job') return { id: 'gif-export', state: 'running', progress: 0 }
      if (command === 'get_media_jobs') return [{ id: 'gif-export', state: 'running', progress: 0 }]
      if (command === 'cancel_media_job') return null
      throw new Error(`Unexpected command: ${command}`)
    } }
    const app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': theme.value }, h(KeepAlive, null, { default: () => visible.value ? h(Component, { assets: assets.value, native, ...(mode === 'gif' ? {} : { mode: mode === 'image' ? 'image' : 'video' }), onImported: file => state.append(file.name, '2027-01-01T00:00:00Z'), onStatus: value => state.statuses.push(value), onBusyChange: value => { state.busy = value } }) : h('div', { class: 'other-workspace' }) })) })
    app.mount('#app')
    state.dispose = () => app.unmount()
  }, { mode, native, options })
}

async function main() {
  const directory = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'video-source-lists') : fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-video-lists-'))
  fs.mkdirSync(directory, { recursive: true })
  const sourceFile = path.join(directory, 'source.webm')
  execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x6257db:s=160x90:r=15:d=1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', sourceFile])
  const source = fs.readFileSync(sourceFile)
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
  try {
    const url = `http://127.0.0.1:${server.httpServer.address().port}`
    for (const mode of ['video', 'gif']) for (const native of [true, false]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }), errors = []
      const mediaRequests = []
      page.on('request', request => { if (request.url().includes('/list-video/')) mediaRequests.push(request.url()) })
      page.on('pageerror', error => errors.push(error.message))
      await mount(page, url, mode, native, source)
      const rows = page.locator('[data-source-asset-id]')
      await expect(rows).toHaveCount(6)
      assert.deepEqual(await rows.evaluateAll(items => items.map(item => item.dataset.sourceAssetId)), ['newest', 'same-last', 'same-first', 'older', 'legacy-last', 'legacy-first'])
      await expect(rows.first().locator('time')).toHaveAttribute('datetime', '2026-10-18T03:00:00Z')
      await expect(rows.filter({ hasText: '导入时间未记录' })).toHaveCount(2)
      const older = page.locator('[data-source-asset-id="older"]')
      await (mode === 'gif' ? older : older.locator('.source-details')).click()
      const preview = mode === 'gif' ? page.getByLabel('GIF 来源视频预览') : page.locator('.preview-stage video')
      await expect(preview).toHaveAttribute('src', '/list-video/older')
      if (mode === 'gif') {
        await expect(page.getByLabel('GIF 视频来源')).toHaveValue('older')
        await page.getByLabel('开始时间', { exact: true }).fill('1')
      } else await expect(page.locator('.convert-source input:checked')).toHaveCount(6)
      await page.evaluate(() => window.listHarness.append('later', '2026-10-18T04:00:00Z'))
      await expect(rows.first()).toHaveAttribute('data-source-asset-id', 'later')
      await expect(preview).toHaveAttribute('src', '/list-video/older')
      if (mode === 'gif') await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('1')
      await older.click({ button: 'right' })
      const menu = page.getByRole('menu', { name: '视频素材操作' })
      await expect(menu).toBeVisible()
      await expect(menu).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      await expect(menu).toHaveCSS('color', 'rgb(38, 48, 68)')
      await page.evaluate(() => window.listHarness.theme('dark'))
      await expect(menu).toHaveCSS('background-color', 'rgb(29, 34, 48)')
      await expect(menu).toHaveCSS('color', 'rgb(227, 232, 242)')
      await page.evaluate(() => window.listHarness.theme('light'))
      const reveal = menu.getByRole('menuitem', { name: '打开所在文件夹' })
      if (native) {
        await expect(reveal).toBeEnabled(); await reveal.click()
        await expect(menu).toHaveCount(0)
        await expect.poll(() => page.evaluate(() => window.listHarness.calls.filter(call => call.command === 'reveal_media_asset').length)).toBe(1)
        const revealed = await page.evaluate(() => window.listHarness.calls.filter(call => call.command === 'reveal_media_asset'))
        assert.deepEqual(revealed.map(call => call.args.asset.id), ['older'])
        await page.locator('[data-source-asset-id="legacy-last"]').click({ button: 'right' })
        await expect(menu.getByRole('menuitem')).toBeDisabled()
        await expect(menu).toContainText('此素材没有可用的本地位置')
      } else {
        await expect(reveal).toBeDisabled()
        await expect(menu).toContainText('仅桌面端可打开所在文件夹')
        assert.equal(await page.evaluate(() => window.listHarness.calls.filter(call => call.command === 'reveal_media_asset').length), 0)
      }
      await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0)
      const keyboardRow = mode === 'gif' ? older : older.locator('.source-details')
      if (mode === 'gif') {
        // Both opening gestures must survive a scroll queued while revealing the source.
        for (const gesture of ['keyboard', 'mouse']) {
          const previousHeight = await keyboardRow.evaluate((element, gesture) => {
            const list = element.closest('.gif-source-list'), previous = list.style.maxHeight
            list.style.maxHeight = '150px'; list.scrollTop = list.scrollHeight
            element.focus()
            if (gesture === 'keyboard') element.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
            else {
              const bounds = element.getBoundingClientRect()
              element.dispatchEvent(new MouseEvent('contextmenu', { clientX: bounds.left + 10, clientY: bounds.top + 10, bubbles: true, cancelable: true }))
            }
            return previous
          }, gesture)
          await expect(menu).toBeVisible()
          await expect.poll(() => menu.evaluate(element => element.contains(document.activeElement))).toBe(true)
          await page.keyboard.press('Escape'); await expect(keyboardRow).toBeFocused()
          await keyboardRow.evaluate((element, height) => { element.closest('.gif-source-list').style.maxHeight = height }, previousHeight)
        }
      }
      await keyboardRow.focus(); await page.keyboard.press('Shift+F10')
      await expect(menu).toBeVisible(); await page.keyboard.press('Escape')
      await expect(keyboardRow).toBeFocused()

      // Escape during keyboard positioning must cancel the pending open as well.
      await keyboardRow.evaluate(element => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await expect(menu).toHaveCount(0)
      await expect(keyboardRow).toBeFocused()

      // Close after insertion but before open() resumes from nextTick: stale focus must not win.
      await page.evaluate(() => {
        window.menuEscapeDuringOpen = 0
        const observer = new MutationObserver(() => {
          if (!document.querySelector('[role="menu"][aria-label="视频素材操作"]')) return
          observer.disconnect()
          window.menuEscapeDuringOpen++
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        observer.observe(document.querySelector('#app'), { childList: true, subtree: true })
      })
      await page.keyboard.press('Shift+F10')
      await expect.poll(() => page.evaluate(() => window.menuEscapeDuringOpen)).toBe(1)
      await expect(menu).toHaveCount(0)
      await expect(keyboardRow).toBeFocused()

      // A delayed scroll from focusing a source must not strand focus on a removed menu.
      await page.keyboard.press('Shift+F10'); await expect(menu).toBeVisible()
      await expect.poll(() => menu.evaluate(element => element.contains(document.activeElement))).toBe(true)
      await page.evaluate(() => window.dispatchEvent(new Event('scroll')))
      await expect(menu).toHaveCount(0)
      await expect(keyboardRow).toBeFocused()

      // Clicking another focusable control still gives that control focus, never the old source.
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.dataset.testid = 'menu-outside-control'
        button.textContent = '外部操作'
        button.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2000'
        document.body.append(button)
      })
      await page.keyboard.press('Shift+F10'); await expect(menu).toBeVisible()
      const outsideControl = page.getByTestId('menu-outside-control')
      await outsideControl.click(); await expect(menu).toHaveCount(0)
      await expect(outsideControl).toBeFocused()
      await outsideControl.evaluate(element => element.remove())

      await keyboardRow.focus(); await page.keyboard.press('Shift+F10')
      await page.evaluate(() => window.listHarness.show(false))
      await expect(menu).toHaveCount(0)
      await expect(page.locator('.other-workspace')).toHaveCount(1)
      await page.evaluate(() => window.listHarness.show(true))
      await expect(preview).toHaveAttribute('src', '/list-video/older')
      if (mode === 'gif') await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('1')
      if (native) {
        await page.evaluate(() => { window.listHarness.failReveal = true })
        await older.click({ button: 'right' }); await menu.getByRole('menuitem').click()
        await expect(page.getByText('原始文件和素材副本均已移除', { exact: true })).toBeVisible()
      }
      if (mode === 'gif') {
        await page.locator('input[type=file]').setInputFiles({ name: 'fresh-import.webm', mimeType: 'video/webm', buffer: source })
        await expect(rows.first()).toHaveAttribute('data-source-asset-id', 'fresh-import.webm')
        await expect(page.getByLabel('GIF 视频来源')).toHaveValue('fresh-import.webm')
        await expect(preview).toHaveAttribute('src', '/list-video/fresh-import.webm')
        if (native) {
          await page.getByTestId('export-gif').click()
          await expect(page.getByLabel('GIF 视频来源')).toBeDisabled()
          await expect(rows.first()).toBeDisabled()
          await page.getByRole('button', { name: '取消导出', exact: true }).click()
          await expect(rows.first()).toBeEnabled()
        }
      } else if (native) {
        await page.getByTestId('convert-start').click()
        await expect(rows.first().locator('.source-details')).toBeDisabled()
        await rows.first().dispatchEvent('click')
        await expect(preview).toHaveAttribute('src', '/list-video/older')
        await page.getByRole('button', { name: '取消转换', exact: true }).click()
        await expect(rows.first().locator('.source-details')).toBeEnabled()
      }
      if (native) {
        const toolbar = page.getByTestId('video-library-toolbar')
        await expect(toolbar).toBeVisible()
        await expect(page.getByTestId('video-library-directory')).toHaveAttribute('title', '/Users/demo/Library/Application Support/Open Media/recordings')
        const initialSource = await preview.getAttribute('src'), beforeCount = await rows.count()
        const projectAssetsBeforeScan = await page.evaluate(() => window.listHarness.assets.value.map(asset => asset.id))
        if (mode === 'gif') await page.getByLabel('开始时间', { exact: true }).fill('2')
        else await older.getByRole('checkbox').uncheck()
        await page.evaluate(() => {
          window.listHarness.addStored('recording-only', '2031-01-01T00:00:00Z')
          window.listHarness.addStored('duplicate-older', '2032-01-01T00:00:00Z', '/fixture/older.webm')
          window.listHarness.warnings = ['损坏视频.webm：无法读取视频信息']
          window.listHarness.holdScan = true
        })
        await toolbar.getByRole('button', { name: '刷新本机视频列表' }).click()
        await expect(toolbar).toContainText('正在读取目录视频')
        await expect(rows).toHaveCount(beforeCount)
        await expect(preview).toHaveAttribute('src', initialSource)
        await page.waitForFunction(() => typeof window.listHarness.releaseScan === 'function')
        await page.evaluate(() => window.listHarness.releaseScan())
        await expect(rows).toHaveCount(beforeCount + 1)
        await expect(rows.first()).toHaveAttribute('data-source-asset-id', 'older')
        await expect(page.locator('[data-source-asset-id="duplicate-older"]')).toHaveCount(0)
        await expect(older).toHaveCount(1)
        await expect(rows.first().locator('time')).toHaveAttribute('datetime', '2032-01-01T00:00:00.000Z')
        await expect(page.locator('[data-source-asset-id="recording-only"] time')).toHaveAttribute('datetime', '2031-01-01T00:00:00.000Z')
        await expect(preview).toHaveAttribute('src', initialSource)
        if (mode === 'gif') await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('2')
        else await expect(older.getByRole('checkbox')).not.toBeChecked()
        assert(!mediaRequests.some(url => url.endsWith('/recording-only')), '目录扫描不应逐个加载或转换未选中的视频')
        await toolbar.getByText('部分文件已跳过（1）', { exact: true }).click()
        await expect(toolbar).toContainText('损坏视频.webm：无法读取视频信息')
        await toolbar.getByRole('button', { name: '打开录屏保存目录' }).click()
        await expect.poll(() => page.evaluate(() => window.listHarness.calls.filter(call => call.command === 'open_media_library_directory').length)).toBe(1)
        const recording = page.locator('[data-source-asset-id="recording-only"]')
        await (mode === 'gif' ? recording : recording.locator('.source-details')).click()
        await expect(preview).toHaveAttribute('src', '/list-video/recording-only')
        await expect.poll(() => preview.evaluate(video => video.readyState), { message: '目录视频应在实际浏览器中解码' }).toBeGreaterThanOrEqual(2).catch(async cause => {
          console.error(await preview.evaluate(video => ({ ready: video.readyState, error: video.error?.message ?? '', source: video.currentSrc, calls: window.listHarness.calls.slice(-8) })))
          throw cause
        })
        assert.equal(await preview.evaluate(video => video.paused), true, '目录选择不能自动播放')
        if (mode === 'gif') await page.getByLabel('开始时间', { exact: true }).fill('1.2')
        await page.evaluate(() => window.listHarness.show(false))
        await expect(page.locator('.other-workspace')).toHaveCount(1)
        const scansWhileHidden = await page.evaluate(() => window.listHarness.calls.filter(call => call.command === 'list_stored_videos').length)
        await page.evaluate(() => { window.listHarness.addStored('recording-on-return', '2033-01-01T00:00:00Z'); window.dispatchEvent(new Event('focus')) })
        assert.equal(await page.evaluate(() => window.listHarness.calls.filter(call => call.command === 'list_stored_videos').length), scansWhileHidden)
        await page.evaluate(() => window.listHarness.show(true))
        await expect(page.locator('[data-source-asset-id="recording-on-return"]')).toHaveCount(1)
        await expect(preview).toHaveAttribute('src', '/list-video/recording-only')
        if (mode === 'gif') await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('1.2')
        const beforeFailure = await rows.count()
        await page.evaluate(() => { window.listHarness.failScan = true })
        await toolbar.getByRole('button', { name: '刷新本机视频列表' }).click()
        await expect(toolbar.getByRole('alert')).toContainText('录屏目录暂时不可读取')
        await expect(rows).toHaveCount(beforeFailure)
        await expect(preview).toHaveAttribute('src', '/list-video/recording-only')
        await page.evaluate(() => { window.listHarness.failScan = false; window.listHarness.addStored('recording-on-focus', '2034-01-01T00:00:00Z'); window.dispatchEvent(new Event('focus')) })
        await expect(page.locator('[data-source-asset-id="recording-on-focus"]')).toHaveCount(1)
        await expect(toolbar.getByRole('alert')).toHaveCount(0)
        await expect(preview).toHaveAttribute('src', '/list-video/recording-only')
        assert.deepEqual(await page.evaluate(() => window.listHarness.assets.value.map(asset => asset.id)), projectAssetsBeforeScan, '目录浏览与预览不能把录屏批量加入当前工程')
        console.log(`PASS ${mode} 本机目录模拟：默认扫描、路径去重、延迟/失败保留选择与GIF片段、按需解码、激活和窗口聚焦刷新、打开目录与跳过提示`)
      } else {
        await expect(page.getByTestId('video-library-toolbar')).toHaveCount(0)
        assert.equal(await page.evaluate(() => window.listHarness.calls.some(call => ['list_stored_videos', 'open_media_library_directory'].includes(call.command))), false, '网页不扫描本机目录')
      }
      await page.evaluate(() => { for (let index = 0; index < 25; index++) window.listHarness.append(`extra-${index}`, '2028-01-01T00:00:00Z') })
      const list = mode === 'gif' ? page.getByTestId('gif-source-list') : page.getByLabel('待转换素材')
      assert(await list.evaluate(element => element.scrollHeight > element.clientHeight), 'many videos must scroll rather than compressing the rows')
      assert((await rows.first().boundingBox()).height >= (mode === 'gif' ? 76 : 65))
      const previewBounds = await preview.boundingBox(), listBounds = await list.boundingBox()
      assert(listBounds.x + listBounds.width <= previewBounds.x + 2, 'video list must remain to the left of the main preview')
      await page.screenshot({ path: path.join(directory, `${mode}-${native ? 'desktop' : 'browser'}.png`) })
      if (native) {
        const toolbar = page.getByTestId('video-library-toolbar')
        await page.evaluate(() => window.listHarness.theme('dark'))
        await expect(toolbar).toHaveCSS('background-color', 'rgb(36, 42, 57)')
        await expect(page.locator('select').first()).toHaveCSS('background-color', 'rgb(29, 34, 48)')
        await page.screenshot({ path: path.join(directory, `${mode}-desktop-dark.png`) })
        await page.evaluate(() => window.listHarness.theme('light'))
        await expect(page.locator('select').first()).toHaveCSS('background-color', 'rgb(255, 255, 255)')
        await page.setViewportSize({ width: 780, height: 850 })
        await toolbar.scrollIntoViewIfNeeded()
        const toolbarBox = await toolbar.boundingBox()
        const sourcesBox = await page.locator(mode === 'gif' ? '.gif-sources' : '.convert-sources').boundingBox()
        const directoryBox = await page.getByTestId('video-library-directory').boundingBox()
        assert(directoryBox && directoryBox.height >= 12 && directoryBox.y >= toolbarBox.y && directoryBox.y + directoryBox.height <= toolbarBox.y + toolbarBox.height, '窄屏目录路径保持可见')
        for (const button of await toolbar.getByRole('button').all()) {
          const box = await button.boundingBox()
          assert(box && box.width >= 24 && box.height >= 24 && box.x >= toolbarBox.x && box.x + box.width <= toolbarBox.x + toolbarBox.width + 1 && box.y >= sourcesBox.y && box.y + box.height <= sourcesBox.y + sourcesBox.height, '窄屏目录栏操作按钮保持可见，不被长路径或布局挤出')
        }
        await page.screenshot({ path: path.join(directory, `${mode}-desktop-narrow.png`) })
      }
      assert.deepEqual(errors, [])
      await page.evaluate(() => window.listHarness.dispose())
      await page.close()
      console.log(`PASS ${mode} ${native ? 'desktop' : 'browser'}：视频过滤/时间排序、选择同步、右键及键盘文件夹入口、错误和禁用状态、滚动列表`)
    }
    const directoryPage = await browser.newPage({ viewport: { width: 1280, height: 850 } })
    await mount(directoryPage, url, 'video', true, source, { directoryOnly: true, emptyProjectAssets: true })
    await expect(directoryPage.locator('[data-source-asset-id]')).toHaveCount(2)
    await expect(directoryPage.locator('.convert-source input:checked')).toHaveCount(1)
    await expect(directoryPage.getByRole('checkbox', { name: '选择 only-recording-new.webm', exact: true })).toBeChecked()
    await directoryPage.getByRole('checkbox', { name: '选择 only-recording-new.webm', exact: true }).uncheck()
    await directoryPage.evaluate(() => { window.listHarness.addStored('only-recording-later', '2036-01-01T00:00:00Z'); window.dispatchEvent(new Event('focus')) })
    await expect(directoryPage.locator('[data-source-asset-id]')).toHaveCount(3)
    await expect(directoryPage.locator('.convert-source input:checked')).toHaveCount(0)
    await directoryPage.getByRole('button', { name: '全选', exact: true }).click()
    await expect(directoryPage.locator('.convert-source input:checked')).toHaveCount(3)
    await directoryPage.evaluate(() => { window.listHarness.addStored('only-recording-latest', '2037-01-01T00:00:00Z'); window.dispatchEvent(new Event('focus')) })
    await expect(directoryPage.locator('[data-source-asset-id]')).toHaveCount(4)
    await expect(directoryPage.locator('.convert-source input:checked')).toHaveCount(3)
    await expect(directoryPage.getByRole('checkbox', { name: '选择 only-recording-latest.webm', exact: true })).not.toBeChecked()
    await directoryPage.evaluate(() => window.listHarness.dispose())
    await directoryPage.close()
    console.log('PASS 目录首次加载仅选最新视频，背景刷新保留取消选择或手动全选，不自动扩充批次')
    const imagePage = await browser.newPage()
    await mount(imagePage, url, 'image', true, source)
    await expect(imagePage.getByTestId('convert-workspace')).toBeVisible()
    await expect(imagePage.getByTestId('video-library-toolbar')).toHaveCount(0)
    assert.equal(await imagePage.evaluate(() => window.listHarness.calls.some(call => call.command === 'list_stored_videos')), false, '图片编辑不读取视频目录')
    await imagePage.evaluate(() => window.listHarness.dispose())
    await imagePage.close()
    console.log('PASS 图片编辑保留原项目素材列表，不显示或扫描视频目录')
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
