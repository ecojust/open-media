const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const dimensions = page => page.evaluate(() => {
  const project = document.querySelector('#app').__vue_app__._instance.setupState.project
  return [project.width, project.height, project.autoSizeFromVideo]
})
async function fixture(browser, url, native = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(native => {
    localStorage.setItem('open-media:autosave', 'false')
    if (!native) return
    let callback = 0
    window.sizeHarness = { assets: [], calls: [] }
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback, unregisterCallback: () => {}, convertFileSrc: value => value,
      invoke: async (command, args) => {
        window.sizeHarness.calls.push(command)
        if (command === 'plugin:event|listen') return ++callback
        if (command === 'plugin:event|unlisten') return null
        if (command === 'configure_screenshot_shortcut') return args.shortcut
        if (command === 'get_media_jobs') return []
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'get_capture_status') return { state: 'idle', elapsed: 0, segments: 0 }
        if (command === 'pick_media_assets') return window.sizeHarness.assets.splice(0)
        throw new Error(`未预期的原生命令：${command}`)
      },
    }
  }, native)
  await page.goto(url)
  await expect(page.getByTestId('create-project')).toBeEnabled()
  await page.getByTestId('nav-edit').click()
  return { page, close: async () => { assert.deepEqual(errors, []); await context.close() } }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-source-size-'))
  const portrait = path.join(directory, 'portrait.webm'), landscape = path.join(directory, 'landscape.webm')
  for (const [filename, size] of [[portrait, '180x320'], [landscape, '640x360']]) {
    execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=15`, '-t', '0.8', '-c:v', 'libvpx', '-threads', '1', '-an', filename], { timeout: 30000, stdio: 'pipe' })
  }
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
  const url = `http://127.0.0.1:${server.httpServer.address().port}`
  try {
    {
      const { page, close } = await fixture(browser, url)
      const image = Buffer.from(await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128
        return [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve))).arrayBuffer())]
      }))
      await page.getByTestId('media-input').setInputFiles({ name: 'still.png', mimeType: 'image/png', buffer: image })
      await expect(page.locator('.asset-card')).toHaveCount(1)
      assert.deepEqual(await dimensions(page), [1920, 1080, true])
      await page.getByTestId('media-input').setInputFiles(portrait)
      await expect(page.locator('.preview-heading')).toContainText('180 × 320')
      assert.deepEqual(await dimensions(page), [180, 320, false])
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      assert.deepEqual(await dimensions(page), [1920, 1080, true])
      await page.getByRole('button', { name: '重做', exact: true }).click()
      assert.deepEqual(await dimensions(page), [180, 320, false])
      await page.getByTestId('media-input').setInputFiles(landscape)
      await expect(page.locator('.asset-card')).toHaveCount(3)
      assert.deepEqual(await dimensions(page), [180, 320, false])
      await page.locator('.asset-card').filter({ hasText: 'portrait.webm' }).dblclick()
      await expect(page.locator('.timeline-clip')).toHaveCount(1)
      assert.deepEqual(await page.evaluate(() => {
        const project = document.querySelector('#app').__vue_app__._instance.setupState.project
        const clip = project.tracks.flatMap(track => track.clips)[0]
        return [clip.width, clip.height]
      }), [180, 320])
      await close()
      console.log('PASS 浏览器真实视频解码保留竖屏源尺寸；图片导入不抢占，后续视频不覆盖，撤销重做及时间线同步')
    }
    {
      const { page, close } = await fixture(browser, url)
      await page.getByRole('button', { name: '项目设置', exact: true }).click()
      await page.getByLabel('画面比例', { exact: true }).selectOption('square')
      await page.getByRole('dialog', { name: '项目设置', exact: true }).getByRole('button', { name: '完成', exact: true }).click()
      await page.getByTestId('media-input').setInputFiles(portrait)
      await expect(page.locator('.asset-card')).toHaveCount(1)
      assert.deepEqual(await dimensions(page), [1080, 1080, false])
      await close()
      console.log('PASS 手动选择项目比例之后，首个视频导入保持用户尺寸')
    }
    {
      const { page, close } = await fixture(browser, url)
      await page.evaluate(async () => {
        const { createProject } = await import('/src/core/project.ts')
        const { saveProject } = await import('/src/core/storage.ts')
        const project = createProject('旧项目', { width: 800, height: 600 })
        delete project.autoSizeFromVideo
        await saveProject(project)
        localStorage.setItem('open-media:last-project', project.id)
      })
      await page.reload(); await page.getByTestId('nav-edit').click()
      await page.getByTestId('media-input').setInputFiles(portrait)
      await expect(page.locator('.asset-card')).toHaveCount(1)
      assert.deepEqual(await dimensions(page), [800, 600, undefined])
      await close()
      console.log('PASS 已保存旧项目重新打开后导入视频，不追溯改变画布尺寸')
    }
    {
      const { page, close } = await fixture(browser, url, true)
      await page.evaluate(({ bytes, size }) => {
        window.sizeHarness.assets.push({ id: 'desktop-source', name: 'desktop.webm', kind: 'video', width: 640, height: 360, duration: .8, size, mime: 'video/webm', url: `data:video/webm;base64,${bytes}` })
      }, { bytes: fs.readFileSync(landscape).toString('base64'), size: fs.statSync(landscape).size })
      await page.locator('.editor-tools').getByRole('button', { name: '导入素材', exact: true }).click()
      await expect(page.locator('.preview-heading')).toContainText('640 × 360')
      assert.deepEqual(await dimensions(page), [640, 360, false])
      assert(await page.evaluate(() => window.sizeHarness.calls.includes('pick_media_assets')))
      await close()
      console.log('PASS 桌面导入桥接返回的源视频尺寸进入同一首次匹配流程')
    }
    {
      const { page, close } = await fixture(browser, url, true)
      await page.getByTestId('nav-record').click()
      await page.evaluate(({ bytes, size }) => {
        const component = document.querySelector('.recorder-workspace').__vueParentComponent
        component.emit('asset', { id: 'recorded-source', name: 'recorded.webm', kind: 'video', width: 180, height: 320, duration: .8, size, mime: 'video/webm', url: `data:video/webm;base64,${bytes}` })
      }, { bytes: fs.readFileSync(portrait).toString('base64'), size: fs.statSync(portrait).size })
      await expect.poll(() => dimensions(page)).toEqual([180, 320, false])
      await page.evaluate(() => document.querySelector('.recorder-workspace').__vueParentComponent.emit('add-to-timeline', 'recorded-source'))
      await expect(page.getByTestId('video-editor')).toBeVisible()
      await expect(page.locator('.preview-heading')).toContainText('180 × 320')
      await expect(page.locator('.timeline-clip')).toHaveCount(1)
      assert.deepEqual(await dimensions(page), [180, 320, false])
      await close()
      console.log('PASS 录屏组件完成事件及加入剪辑事件保留录制源尺寸；未申请真实采集权限')
    }
  } finally { await browser.close(); await server.close(); fs.rmSync(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
