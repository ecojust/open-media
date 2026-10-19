const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

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
        if (command === 'ai_get_status') return { models: [], jobs: [], busy: false }
        if (command === 'list_stored_videos') return { directory: '/fixture/recordings', assets: [], warnings: [] }
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'get_capture_status') return { state: 'idle', elapsed: 0, segments: 0 }
        if (command === 'pick_media_assets') return window.sizeHarness.assets.splice(0)
        throw new Error(`未预期的原生命令：${command}`)
      },
    }
  }, native)
  await page.goto(url)
  await expect(page.getByTestId('create-project')).toBeEnabled({ timeout: 15000 }).catch(error => { if (errors.length) error.message += `\n启动错误：${errors.join('\n')}`; throw error })
  await page.getByTestId('nav-edit').click()
  if (native) await page.getByLabel('素材来源', { exact: true }).getByRole('button', { name: '已导入', exact: true }).click()
  return { page, close: async () => { assert.deepEqual(errors, []); await context.close() } }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-source-size-'))
  const portrait = path.join(directory, 'portrait.webm'), landscape = path.join(directory, 'landscape.webm')
  for (const [filename, size] of [[portrait, '180x320'], [landscape, '640x360']]) {
    execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=15`, '-t', '0.8', '-c:v', 'libvpx', '-threads', '1', '-an', filename], { timeout: 30000, stdio: 'pipe' })
  }
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**'] } }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || chromium.executablePath(), args: ['--no-sandbox', '--no-proxy-server'] })
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
      await page.getByLabel('画面比例', { exact: true }).selectOption('square')
      assert.deepEqual(await dimensions(page), [1080, 1080, false])
      await page.getByRole('button', { name: '项目设置', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '项目设置', exact: true })
      await expect(dialog).toBeVisible()
      for (const label of ['画面比例', '项目宽度', '项目高度']) await expect(dialog.getByLabel(label, { exact: true })).toHaveCount(0)
      await dialog.getByRole('button', { name: '完成', exact: true }).click()
      await page.getByTestId('media-input').setInputFiles(portrait)
      await expect(page.locator('.asset-card')).toHaveCount(1)
      assert.deepEqual(await dimensions(page), [1080, 1080, false])
      await close()
      console.log('PASS 主界面比例实时应用、设置弹窗不再重复尺寸入口，首个视频导入保持用户尺寸')
    }
    {
      const { page, close } = await fixture(browser, url)
      const controls = page.getByTestId('project-size-controls')
      await controls.getByLabel('画面比例', { exact: true }).selectOption('custom')
      const width = controls.getByLabel('项目宽度', { exact: true }), height = controls.getByLabel('项目高度', { exact: true })
      await expect(width).toHaveValue('1920'); await expect(height).toHaveValue('1080')
      for (const value of ['', '0', '-1', '15', '16385', '853.5']) {
        await width.fill(value)
        await expect(controls.getByRole('alert')).toContainText('16 到 16384 之间的整数')
        await expect(width).toHaveValue(value)
        assert.deepEqual(await dimensions(page), [1920, 1080, true])
      }
      await width.fill('853')
      await expect(width).toBeFocused()
      assert.deepEqual(await dimensions(page), [853, 1080, false], '有效宽度不需要失焦或确认即可生效')
      await expect(page.locator('.preview-heading')).toContainText('853 × 1080')
      await height.fill('0')
      await expect(controls.getByRole('alert')).toBeVisible()
      assert.deepEqual(await dimensions(page), [853, 1080, false], '无效高度保留输入但不进入项目')
      await height.fill('479')
      await expect(height).toBeFocused()
      await expect(controls.getByRole('alert')).toHaveCount(0)
      assert.deepEqual(await dimensions(page), [853, 479, false])
      await expect(page.locator('.preview-heading')).toContainText('853 × 479')
      await page.screenshot({ path: '/tmp/open-media-project-custom-size.png', animations: 'disabled' })
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      assert.deepEqual(await dimensions(page), [1920, 1080, true], '同一次控件焦点内的宽高调整合并为一次撤销，无效输入不增加历史')
      await expect(width).toHaveValue('1920'); await expect(height).toHaveValue('1080')
      await page.getByRole('button', { name: '重做', exact: true }).click()
      assert.deepEqual(await dimensions(page), [853, 479, false])
      await page.getByTestId('media-input').setInputFiles(portrait)
      await expect(page.locator('.asset-card')).toHaveCount(1)
      assert.deepEqual(await dimensions(page), [853, 479, false], '自定义尺寸不会被后续首个视频覆盖')
      await expect(controls.getByLabel('画面比例', { exact: true })).toHaveValue('custom')
      await expect(width).toHaveValue('853'); await expect(height).toHaveValue('479')
      await width.fill('1024'); await height.fill('576')
      await expect(height).toBeFocused()
      assert.deepEqual(await dimensions(page), [1024, 576, false], '宽高编辑保持实时预览，不等待确认')
      await page.evaluate(() => { window.showSaveFilePicker = undefined })
      const downloaded = page.waitForEvent('download')
      await page.getByTestId('save-project').click()
      const saved = await downloaded, savedBytes = fs.readFileSync(await saved.path())
      const stored = JSON.parse(strFromU8(unzipSync(new Uint8Array(savedBytes))['project.json'])).project
      assert.deepEqual([stored.width, stored.height, stored.autoSizeFromVideo], [1024, 576, false])
      assert.deepEqual([stored.assets[0].width, stored.assets[0].height], [180, 320], '保存不能改写源视频尺寸')
      await page.getByTestId('project-input').setInputFiles({ name: 'custom-size.omedia', mimeType: 'application/x-open-media-project', buffer: savedBytes })
      await expect(page.locator('.preview-heading')).toContainText('1024 × 576')
      assert.deepEqual(await dimensions(page), [1024, 576, false])
      await close()
      console.log('PASS 主界面整数宽高实时预览、无效值拦截、单步撤销重做、后续导入保持设置及实际项目文件保存重开')
    }
    {
      const { page, close } = await fixture(browser, url)
      await page.getByTestId('media-input').setInputFiles([portrait, landscape])
      await expect(page.locator('.asset-card')).toHaveCount(2)
      await page.locator('.asset-card').filter({ hasText: 'portrait.webm' }).dblclick()
      await page.locator('.asset-card').filter({ hasText: 'landscape.webm' }).dblclick()
      await expect(page.locator('.timeline-clip')).toHaveCount(2)
      const portraitClip = page.locator('.timeline-clip').filter({ hasText: 'portrait.webm' })
      const landscapeClip = page.locator('.timeline-clip').filter({ hasText: 'landscape.webm' })
      for (const [label, value] of [['片段开始时间', '1'], ['宽度', '90'], ['高度', '160'], ['旋转 / 度', '90']]) {
        const input = page.locator('.property-panel').getByLabel(label, { exact: true })
        await input.fill(value); await input.press('Tab')
      }
      await portraitClip.click()
      const snapshot = await page.evaluate(() => JSON.parse(JSON.stringify(document.querySelector('#app').__vue_app__._instance.setupState.project)))
      await landscapeClip.click({ button: 'right' })
      const match = page.getByRole('menuitem', { name: '以此片段设置画面尺寸', exact: true })
      await expect(match).toHaveAttribute('title', '源视频尺寸 640 × 360')
      await match.click()
      const settings = page.getByRole('dialog', { name: '项目设置', exact: true })
      await expect(settings).not.toBeVisible()
      const controls = page.getByTestId('project-size-controls')
      await expect(controls.getByLabel('画面比例', { exact: true })).toHaveValue('custom')
      await expect(controls.getByLabel('项目宽度', { exact: true })).toHaveValue('640')
      await expect(controls.getByLabel('项目高度', { exact: true })).toHaveValue('360')
      await expect(controls.getByLabel('项目宽度', { exact: true })).toBeFocused()
      assert.deepEqual(await dimensions(page), [640, 360, false], '视频右键直接应用源尺寸并聚焦主界面尺寸控件')
      const changed = await page.evaluate(() => JSON.parse(JSON.stringify(document.querySelector('#app').__vue_app__._instance.setupState.project)))
      assert.deepEqual(changed.assets, snapshot.assets)
      const selected = changed.tracks.flatMap(track => track.clips).find(clip => clip.name === 'landscape.webm')
      assert.deepEqual([selected.width, selected.height, selected.rotation, selected.start], [320, 180, 90, 1], '采用源尺寸而非片段变换后的尺寸，并保持旋转和时间')
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      assert.deepEqual(await dimensions(page), [180, 320, false])
      await page.getByRole('button', { name: '重做', exact: true }).click()
      assert.deepEqual(await dimensions(page), [640, 360, false])
      const row = page.locator('.track-row').filter({ has: landscapeClip })
      await row.getByRole('button', { name: '锁定轨道', exact: true }).click()
      await landscapeClip.click({ button: 'right' })
      await expect(match).toBeDisabled()
      await page.keyboard.press('Escape')
      await row.getByRole('button', { name: '解锁轨道', exact: true }).click()
      await portraitClip.click({ button: 'right' })
      await expect(match).toHaveAttribute('title', '源视频尺寸 180 × 320')
      await page.screenshot({ path: '/tmp/open-media-project-size-from-clip.png', animations: 'disabled' })
      await match.click()
      assert.deepEqual(await dimensions(page), [180, 320, false])
      await expect(controls.getByLabel('项目宽度', { exact: true })).toHaveValue('180')
      await expect(controls.getByLabel('项目高度', { exact: true })).toHaveValue('320')
      await expect(controls.getByLabel('项目宽度', { exact: true })).toBeFocused()
      await page.getByRole('button', { name: '字幕', exact: true }).click()
      await page.locator('.timeline-clip.text').click({ button: 'right' })
      await expect(match).toHaveCount(0)
      await close()
      console.log('PASS 视频右键直接应用源尺寸并聚焦控件；忽略片段变换，支持撤销重做并保护锁轨')
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
