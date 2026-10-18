const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

async function mount(page, url, mode, native, source) {
  await page.route('**/__video_lists__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.route('**/list-video/*', route => route.fulfill({ contentType: 'video/mp4', body: source }))
  await page.goto(`${url}/__video_lists__`)
  await page.evaluate(async ({ mode, native }) => {
    await import('/src/style.css')
    const filename = mode === 'gif' ? 'GifWorkspace' : 'ConvertWorkspace'
    const source = await (await fetch(`/src/components/${filename}.vue`)).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, ref, KeepAlive } = await import(vueURL)
    const Component = (await import(`/src/components/${filename}.vue`)).default
    const asset = (id, addedAt, kind = 'video', local = true) => ({ id, addedAt, kind, name: `${id}.mp4`, url: `/list-video/${id}`, duration: 8, width: 160, height: 90, size: 2048, mime: 'video/mp4', ...(local ? { nativePath: `/fixture/${id}.mp4` } : {}) })
    const assets = ref([asset('legacy-first'), asset('older', '2026-10-18T01:00:00Z'), asset('audio', '2030-01-01T00:00:00Z', 'audio'), asset('same-first', '2026-10-18T02:00:00Z'), asset('image', '2030-01-01T00:00:00Z', 'image'), asset('newest', '2026-10-18T03:00:00Z'), asset('same-last', '2026-10-18T02:00:00Z'), asset('legacy-last', undefined, 'video', false)])
    const visible = ref(true), theme = ref('light')
    const state = window.listHarness = { assets, calls: [], failReveal: false, busy: false, append(id, addedAt) { assets.value.push(asset(id, addedAt)) }, statuses: [], show(value) { visible.value = value }, theme(value) { theme.value = value } }
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      state.calls.push({ command, args })
      if (command === 'get_runtime_status') return { ready: true, source: 'fixture', version: 'fixture' }
      if (command === 'reveal_media_asset') { if (state.failReveal) throw new Error('原始文件和素材副本均已移除'); return null }
      if (command === 'begin_media_job') return { id: 'gif-export', state: 'running', progress: 0 }
      if (command === 'get_media_jobs') return [{ id: 'gif-export', state: 'running', progress: 0 }]
      if (command === 'cancel_media_job') return null
      throw new Error(`Unexpected command: ${command}`)
    } }
    const app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': theme.value }, h(KeepAlive, null, { default: () => visible.value ? h(Component, { assets: assets.value, native, ...(mode === 'gif' ? {} : { mode: 'video' }), onImported: file => state.append(file.name, '2027-01-01T00:00:00Z'), onStatus: value => state.statuses.push(value), onBusyChange: value => { state.busy = value } }) : h('div', { class: 'other-workspace' }) })) })
    app.mount('#app')
    state.dispose = () => app.unmount()
  }, { mode, native })
}

async function main() {
  const directory = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'video-source-lists') : fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-video-lists-'))
  fs.mkdirSync(directory, { recursive: true })
  const sourceFile = path.join(directory, 'source.mp4')
  execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x6257db:s=160x90:r=15:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourceFile])
  const source = fs.readFileSync(sourceFile)
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
  try {
    const url = `http://127.0.0.1:${server.httpServer.address().port}`
    for (const mode of ['video', 'gif']) for (const native of [true, false]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }), errors = []
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
      await keyboardRow.focus(); await page.keyboard.press('Shift+F10')
      await expect(menu).toBeVisible(); await page.keyboard.press('Escape')
      await expect(keyboardRow).toBeFocused()
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
        await page.locator('input[type=file]').setInputFiles({ name: 'fresh-import.mp4', mimeType: 'video/mp4', buffer: source })
        await expect(rows.first()).toHaveAttribute('data-source-asset-id', 'fresh-import.mp4')
        await expect(page.getByLabel('GIF 视频来源')).toHaveValue('fresh-import.mp4')
        await expect(preview).toHaveAttribute('src', '/list-video/fresh-import.mp4')
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
      await page.evaluate(() => { for (let index = 0; index < 25; index++) window.listHarness.append(`extra-${index}`, '2028-01-01T00:00:00Z') })
      const list = mode === 'gif' ? page.getByTestId('gif-source-list') : page.getByLabel('待转换素材')
      assert(await list.evaluate(element => element.scrollHeight > element.clientHeight), 'many videos must scroll rather than compressing the rows')
      assert((await rows.first().boundingBox()).height >= (mode === 'gif' ? 76 : 65))
      const previewBounds = await preview.boundingBox(), listBounds = await list.boundingBox()
      assert(listBounds.x + listBounds.width <= previewBounds.x + 2, 'video list must remain to the left of the main preview')
      await page.screenshot({ path: path.join(directory, `${mode}-${native ? 'desktop' : 'browser'}.png`) })
      assert.deepEqual(errors, [])
      await page.evaluate(() => window.listHarness.dispose())
      await page.close()
      console.log(`PASS ${mode} ${native ? 'desktop' : 'browser'}：视频过滤/时间排序、选择同步、右键及键盘文件夹入口、错误和禁用状态、滚动列表`)
    }
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
