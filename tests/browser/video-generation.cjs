const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

// Native calls below are a GUI contract fixture, not inference or export verification.
async function mount(page, base, native = true) {
  await page.route('**/__video_generation__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app,.app-shell{height:100%;margin:0}*{box-sizing:border-box}.app-shell{display:flex}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${base}__video_generation__`)
  await page.evaluate(async native => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/VideoGenerationWorkspace.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, ref } = await import(vueURL)
    const { default: Workspace } = await import('/src/components/VideoGenerationWorkspace.vue')
    const image = { id: 'image-1', name: '湖畔首帧.png', kind: 'image', url: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect fill="%23447788" width="64" height="64"/></svg>', duration: 5, width: 64, height: 64, size: 100, mime: 'image/png', nativePath: '/fixture/image.png' }
    const asset = { id: 'video-result', name: '生成镜头.mp4', kind: 'video', url: '', duration: 3.04, width: 512, height: 288, size: 200, mime: 'video/mp4', nativePath: '/fixture/generation/result.mp4' }
    const state = window.generationHarness = { calls: [], jobs: [], selections: [image], added: [], timeline: [], busy: false, mcp: false, active: ref(true), enabled: ref(true), supported: true,
      models: [
        { id: 'h3-base-fl2va', name: 'MiniMax H3 FL2VA', version: '1', modes: ['prompt', 'image', 'storyboard'], size: 144000000000, downloadedBytes: 0, state: 'not-downloaded', hardware: 'Apple 芯片，建议低内存模式', licenseUrl: 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE' },
        { id: 'h3-base-ref2va', name: 'MiniMax H3 Ref2VA', version: '1', modes: ['reference'], size: 150000000000, downloadedBytes: 0, state: 'not-downloaded', hardware: 'Apple 芯片，建议 64 GB 以上内存', licenseUrl: 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE' },
      ], asset }
    const status = () => ({ supported: state.supported, reason: state.supported ? undefined : '当前系统需要 Apple 芯片 Mac。', runtimeReady: true, device: '测试设备', memoryBytes: 32000000000, models: JSON.parse(JSON.stringify(state.models)) })
    if (native) window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: path => path.endsWith('image.png') ? image.url : `${location.origin}/fixture-preview.mp4`, invoke: async (command, args) => {
      state.calls.push({ command, args })
      if (command === 'get_video_generation_status') return status()
      if (command === 'list_video_generation_jobs') return JSON.parse(JSON.stringify(state.jobs))
      if (command === 'begin_video_model_download') { if (!args.acceptedLicense) throw new Error('未确认许可'); state.models.find(model => model.id === args.modelId).state = 'downloading'; return status() }
      if (command === 'cancel_video_model_download') { Object.assign(state.models.find(model => model.id === args.modelId), { state: 'not-downloaded', downloadedBytes: 10000000 }); return status() }
      if (command === 'pick_media_assets') return state.selections
      if (command === 'begin_video_generation') { const job = { id: `job-${state.jobs.length + 1}`, state: 'running', stage: '正在生成镜头', progress: .25, shotIndex: 0, shotCount: args.request.shots.length, startedAt: Date.now(), elapsedSeconds: 1, assets: [] }; state.jobs.unshift(job); return job }
      if (command === 'cancel_video_generation') { state.jobs.find(job => job.id === args.id).state = 'cancelled'; return }
      if (command === 'reveal_media_asset') return
      throw new Error(`未预期命令：${command}`)
    } }
    state.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': 'dark' }, [state.enabled.value ? h(Workspace, { native, active: state.active.value, projectTitle: '当前项目', onBusyChange: value => { state.busy = value }, onAddAsset: value => state.added.push(value), onAddTimeline: value => state.timeline.push(value), onOpenMcp: () => { state.mcp = true } }) : null]) }).mount('#app')
  }, native)
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**'] }, hmr: false }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1480, height: 1100 } })
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(15000)
    await mount(page, server.resolvedUrls.local[0])
    const workspace = page.getByTestId('video-generation-workspace')
    await expect(workspace).toBeVisible()
    await expect(page.getByTestId('generation-start')).toBeDisabled()
    await expect(page.getByLabel('低内存模式', { exact: false })).toBeChecked()
    await expect(page.getByLabel('生成画面尺寸')).toHaveValue('512x512')
    await expect(page.getByRole('button', { name: '参考素材', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '下载模型 MiniMax H3 FL2VA', exact: true }).click()
    const license = page.getByRole('dialog', { name: '下载模型前确认' })
    await expect(license).toContainText('欧盟、英国、韩国及美国')
    await license.getByText('阅读随附的完整模型许可', { exact: true }).click()
    await expect(license.locator('pre')).toContainText('MiniMax H3 COMMUNITY LICENSE AGREEMENT')
    await expect(license.getByRole('button', { name: '确认并下载' })).toBeDisabled()
    await license.getByLabel('我已阅读模型许可，并确认所在地及用途符合许可条件').check()
    await license.getByRole('button', { name: '确认并下载' }).click()
    await expect(license).not.toBeVisible()
    await expect.poll(() => page.evaluate(() => window.generationHarness.busy)).toBe(true)
    await workspace.locator('[data-model-id="h3-base-fl2va"]').getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('button', { name: '继续下载 MiniMax H3 FL2VA', exact: true })).toBeVisible()
    await page.evaluate(() => { for (const model of window.generationHarness.models) { model.state = 'ready'; model.downloadedBytes = model.size } })
    await page.getByRole('button', { name: '重新检查模型', exact: true }).click()
    await page.getByLabel('视频提示词', { exact: true }).fill('清晨湖面升起薄雾，镜头缓缓向前，远处鸟鸣。')
    await expect(page.getByTestId('generation-start')).toBeEnabled()
    if (process.env.VIDEO_GENERATION_SCREENSHOT) await page.screenshot({ path: process.env.VIDEO_GENERATION_SCREENSHOT, fullPage: true })
    await page.getByRole('button', { name: '首尾帧', exact: true }).click()
    await expect(page.getByTestId('generation-start')).toBeDisabled()
    await page.getByRole('button', { name: '选择1号镜头首帧', exact: true }).click()
    await expect(page.getByTestId('generation-start')).toBeEnabled()
    await page.getByTestId('generation-start').click()
    await expect(workspace.locator('[data-job-id="job-1"]')).toContainText('生成中')
    let request = await page.evaluate(() => window.generationHarness.calls.find(call => call.command === 'begin_video_generation').args.request)
    assert.equal(request.mode, 'image'); assert.equal(request.shots[0].firstFrame.id, 'image-1'); assert.equal(request.lowMemory, true)
    await expect(page.getByTestId('generation-start')).toBeDisabled()
    await page.evaluate(() => { window.generationHarness.active.value = false })
    await expect.poll(() => page.evaluate(() => window.generationHarness.busy)).toBe(true)
    await page.evaluate(() => { const state = window.generationHarness; state.jobs[0].state = 'completed'; state.jobs[0].progress = 1; state.jobs[0].assets = [state.asset] })
    await expect(page.getByTestId('generation-preview')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.generationHarness.busy)).toBe(false)
    await page.evaluate(() => { window.generationHarness.active.value = true })
    await page.getByRole('button', { name: '加入素材', exact: true }).click()
    await page.getByRole('button', { name: '加入时间线', exact: true }).click()
    assert.equal(await page.evaluate(() => window.generationHarness.added[0].id), 'video-result')
    assert.equal(await page.evaluate(() => window.generationHarness.timeline[0].id), 'video-result')
    await page.getByRole('button', { name: '打开生成视频文件夹', exact: true }).click()
    await page.getByRole('button', { name: '分镜', exact: true }).click()
    await page.getByRole('button', { name: /新增镜头/ }).click()
    await page.getByLabel('镜头 2 提示词', { exact: true }).fill('镜头二，柔和的阳光落在山间。')
    await page.getByLabel('镜头 2 名称', { exact: true }).fill('日出')
    await page.getByRole('button', { name: '上移镜头 2', exact: true }).click()
    await expect(page.getByLabel('镜头 1 名称', { exact: true })).toHaveValue('日出')
    await page.getByTestId('generation-start').click()
    await expect(workspace.locator('[data-job-id="job-2"]')).toContainText('镜头 1/2')
    request = await page.evaluate(() => window.generationHarness.calls.filter(call => call.command === 'begin_video_generation').at(-1).args.request)
    assert.equal(request.mode, 'storyboard'); assert.equal(request.shots.length, 2); assert.equal(request.joinShots, true); assert.equal(request.shots[0].title, '日出')
    await workspace.locator('[data-job-id="job-2"]').getByRole('button', { name: '取消生成', exact: true }).click()
    await expect(workspace.locator('[data-job-id="job-2"]')).toContainText('已取消')
    await page.getByRole('button', { name: '选择 MiniMax H3 Ref2VA', exact: true }).click()
    await page.getByRole('button', { name: '选择参考素材', exact: true }).click()
    await page.getByLabel('视频提示词', { exact: true }).fill('沿用参考图片的主体和色彩，镜头缓缓拉近。')
    await page.getByTestId('generation-start').click()
    await expect(workspace.locator('[data-job-id="job-3"]')).toContainText('生成中')
    request = await page.evaluate(() => window.generationHarness.calls.filter(call => call.command === 'begin_video_generation').at(-1).args.request)
    assert.equal(request.mode, 'reference'); assert.equal(request.modelId, 'h3-base-ref2va'); assert.equal(request.shots[0].references[0].asset.id, 'image-1')
    assert.equal(request.shots[0].firstFrame, undefined)
    await page.evaluate(() => { window.generationHarness.jobs[0].state = 'failed'; window.generationHarness.jobs[0].error = '测试任务未完成' })
    await expect(workspace.locator('[data-job-id="job-3"]')).toContainText('测试任务未完成')
    await workspace.locator('[data-job-id="job-2"]').getByRole('button', { name: '重新生成', exact: true }).click()
    await expect(workspace.locator('[data-job-id="job-4"]')).toContainText('生成中')
    request = await page.evaluate(() => window.generationHarness.calls.filter(call => call.command === 'begin_video_generation').at(-1).args.request)
    assert.equal(request.mode, 'storyboard'); assert.equal(request.modelId, 'h3-base-fl2va'); assert.equal(request.shots.length, 2, '历史任务重试必须使用其自身分镜')
    await workspace.locator('[data-job-id="job-4"]').getByRole('button', { name: '取消生成', exact: true }).click()
    await page.getByRole('button', { name: '配置视频生成 MCP 服务', exact: true }).click()
    assert.equal(await page.evaluate(() => window.generationHarness.mcp), true)
    await page.evaluate(() => { window.generationHarness.enabled.value = false })
    await expect(workspace).not.toBeVisible()
    await page.evaluate(() => { window.generationHarness.enabled.value = true })
    await expect(page.getByLabel('视频提示词', { exact: true })).toHaveValue('沿用参考图片的主体和色彩，镜头缓缓拉近。')
    await page.evaluate(() => { window.generationHarness.supported = false; window.generationHarness.models.forEach(model => { model.state = 'unsupported' }) })
    await page.getByRole('button', { name: '重新检查模型', exact: true }).click()
    await expect(page.getByTestId('generation-start')).toBeDisabled()
    await expect(workspace).toContainText('当前系统需要 Apple 芯片 Mac。')
    await page.setViewportSize({ width: 760, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const web = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await mount(web, server.resolvedUrls.local[0], false)
    await expect(web.getByTestId('generation-start')).toBeDisabled()
    await expect(web.getByTestId('video-generation-workspace')).toContainText('Apple 芯片 Mac 桌面端')
    const appPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await appPage.addInitScript(() => {
      const result = { id: 'app-result', name: '已生成视频.mp4', kind: 'video', url: '/fixture-preview.mp4', duration: 3, width: 512, height: 512, size: 1000, mime: 'video/mp4', nativePath: '/fixture/result.mp4' }
      window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: () => `${location.origin}/fixture-preview.mp4`, invoke: async (command, args) => {
        if (command === 'get_video_generation_status') return { supported: true, runtimeReady: true, models: [{ id: 'h3-base-fl2va', name: 'MiniMax H3 FL2VA', modes: ['prompt', 'image', 'storyboard'], state: 'ready', size: 144000000000, downloadedBytes: 144000000000, version: '1', licenseUrl: 'https://example.com/license', hardware: 'Apple 芯片' }] }
        if (command === 'list_video_generation_jobs') return [{ id: 'app-job', state: 'completed', stage: '生成完成', progress: 1, shotIndex: 0, shotCount: 1, startedAt: Date.now(), elapsedSeconds: 10, assets: [result] }]
        if (command === 'get_runtime_status') return { ready: true }
        if (command === 'get_media_jobs' || command === 'mcp_pending') return []
        if (command === 'mcp_get_status') return { running: false, connectedClients: 0, pendingRequests: 0 }
        if (command === 'get_desktop_platform') return 'macos'
        if (command === 'get_speech_status') return { ready: false, voices: [] }
        if (command === 'list_stored_videos') return { directory: '/fixture/recordings', assets: [], warnings: [] }
        if (command === 'configure_screenshot_shortcut') return args.shortcut
        if (command === 'plugin:event|listen') return 1
        return null
      } }
    })
    appPage.on('pageerror', error => errors.push(error.message))
    await appPage.goto(server.resolvedUrls.local[0])
    await expect(appPage.getByTestId('create-generate')).toBeVisible({ timeout: 20000 }).catch(async error => { console.error(await appPage.locator('body').innerText(), errors); throw error })
    const navOrder = await appPage.locator('.sidebar nav [data-testid]').evaluateAll(items => items.map(item => item.dataset.testid))
    assert.deepEqual(navOrder, ['nav-record', 'nav-gif', 'nav-edit', 'nav-generate', 'nav-video', 'nav-image'])
    await appPage.getByTestId('nav-generate').click()
    await expect(appPage.getByTestId('generation-preview')).toBeVisible()
    await appPage.getByRole('button', { name: '加入素材', exact: true }).click()
    await appPage.getByRole('button', { name: '加入时间线', exact: true }).click()
    await expect(appPage.getByTestId('video-editor')).toBeVisible().catch(async error => { console.error(await appPage.locator('body').innerText(), errors); throw error })
    await expect(appPage.locator('.timeline-clip.video')).toHaveCount(1)
    await appPage.getByTestId('nav-generate').click()
    await appPage.getByRole('button', { name: '加入时间线', exact: true }).click()
    await expect(appPage.locator('.timeline-clip.video')).toHaveCount(2)
    await expect(appPage.locator('.project-summary')).toContainText('1 个素材')
    assert.deepEqual(errors, [])
    console.log('Video generation GUI contract passed: license, download resume, four modes, reactive frame/reference requests, ordered storyboards, per-job retry, background polling, manual asset actions, draft restore, unsupported platforms and App asset deduplication.')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
