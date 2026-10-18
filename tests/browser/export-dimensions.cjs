const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function mount(page, baseURL, native, width = 853, height = 479) {
  await page.route('**/__export_dimensions__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="app"></div>' }))
  await page.addInitScript(() => {
    const originalSet = window.setInterval.bind(window), originalClear = window.clearInterval.bind(window)
    window.exportIntervals = new Set()
    window.setInterval = (...args) => { const id = originalSet(...args); if (args[0]?.name === 'updateElapsed') window.exportIntervals.add(id); return id }
    window.clearInterval = id => { window.exportIntervals.delete(id); originalClear(id) }
  })
  await page.goto(`${baseURL}/__export_dimensions__`)
  await page.evaluate(async ({ native, width, height }) => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/ExportPanel.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, ref, nextTick } = await import(vueURL)
    const { createProject, createClip } = await import('/src/core/project.ts')
    const { addAsset, addClip } = await import('/src/core/timeline.ts')
    const ExportPanel = (await import('/src/components/ExportPanel.vue')).default
    let project = createProject('源尺寸导出验证', { width, height })
    // Only the bridge payload is inspected here; no native encoder is invoked.
    const asset = { id: 'source', name: 'source.webm', kind: 'video', duration: 1, width, height, size: 1, mime: 'video/webm', url: '', nativePath: '/fixture/source.webm' }
    project = addAsset(project, asset)
    project = addClip(project, project.tracks.find(track => track.kind === 'video').id, createClip(asset, project))
    const state = window.exportDimensions = { project, specs: [], calls: [], open: ref(true), errors: [], busy: [], currentJob: null, holdBegin: false, releaseBegin: null, revealError: '' }
    if (native) {
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          state.calls.push({ command, args })
          if (command === 'get_runtime_status') return { ready: true, source: 'fixture', version: 'fixture' }
          if (command === 'begin_media_job') { state.specs.push(structuredClone(args.spec)); if (state.holdBegin) await new Promise(resolve => { state.releaseBegin = resolve }); return structuredClone(state.currentJob) }
          if (command === 'get_media_jobs') return state.currentJob ? [structuredClone(state.currentJob)] : []
          if (command === 'cancel_media_job') { if (state.currentJob) state.currentJob.state = 'cancelled'; return }
          if (command === 'reveal_media_job_output') { if (state.revealError) throw new Error(state.revealError); return }
          throw new Error(`未预期命令：${command}`)
        },
      }
    }
    const app = createApp({ render: () => h(ExportPanel, { project: state.project, native, open: state.open.value, onClose: () => { state.open.value = false }, onBusy: value => state.busy.push(value) }) })
    app.mount('#app')
    state.reopen = async () => { state.open.value = false; await nextTick(); state.open.value = true; await nextTick() }
    state.cleanup = () => app.unmount()
  }, { native, width, height })
  await expect(page.getByTestId('export-dialog')).toBeVisible()
}

async function checkSize(page, width, height) {
  await expect(page.getByLabel('导出宽度', { exact: true })).toHaveValue(String(width))
  await expect(page.getByLabel('导出高度', { exact: true })).toHaveValue(String(height))
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`
  try {
    {
      const page = await browser.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await mount(page, baseURL, true)
      await checkSize(page, 854, 480)
      await expect(page.getByTestId('export-dimension-adjustment')).toContainText('源 853 × 479 → 导出 854 × 480')
      await expect(page.getByTestId('start-export')).toBeEnabled()
      for (const format of ['mp4', 'webm', 'mov', 'gif']) {
        await page.getByTestId('export-format').selectOption(format)
        await page.getByTestId('start-export').click()
        await expect.poll(() => page.evaluate(() => window.exportDimensions.specs.length)).toBe(['mp4', 'webm', 'mov', 'gif'].indexOf(format) + 1)
        const spec = await page.evaluate(() => window.exportDimensions.specs.at(-1))
        assert.deepEqual([spec.config.format, spec.config.width, spec.config.height], [format, 854, 480])
        assert.deepEqual([spec.project.width, spec.project.height], [853, 479])
      }
      await expect(page.getByLabel('清晰度', { exact: true })).toHaveCount(0)
      for (const label of ['导出宽度', '导出高度']) {
        const field = page.getByLabel(label, { exact: true })
        await expect(field).toHaveAttribute('readonly', '')
        await expect(field).toHaveAttribute('aria-readonly', 'true')
        await field.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('999')
      }
      await checkSize(page, 854, 480)
      await page.evaluate(() => window.exportDimensions.reopen())
      await checkSize(page, 854, 480)
      await expect(page.getByTestId('export-dimension-adjustment')).toBeVisible()
      assert.deepEqual(await page.evaluate(() => [window.exportDimensions.project.width, window.exportDimensions.project.height]), [853, 479])
      assert.equal(await page.evaluate(() => window.exportIntervals.size), 0, '取消文件选择后清理准备阶段计时器')
      assert.deepEqual(errors, [])
      await page.close()
      console.log('PASS 桌面四种格式尺寸只读，源尺寸编码补齐明确说明，键盘不能改变尺寸，提交保留原项目')
    }
    {
      const page = await browser.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await mount(page, baseURL, true, 1280, 720)
      await checkSize(page, 1280, 720)
      await expect(page.getByTestId('export-dimension-adjustment')).toHaveCount(0)
      await expect(page.getByTestId('export-dimension-error')).toHaveCount(0)
      await expect(page.getByTestId('start-export')).toBeEnabled()
      assert.deepEqual(errors, [])
      await page.close()
      console.log('PASS 偶数源尺寸保持原值且不显示无关调整提示')
    }
    {
      const page = await browser.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await mount(page, baseURL, false)
      await checkSize(page, 853, 479)
      await expect(page.getByTestId('start-export')).toBeEnabled()
      await expect(page.getByTestId('export-dimension-adjustment')).toHaveCount(0)
      await expect(page.getByTestId('export-dimension-error')).toHaveCount(0)
      await expect(page.getByLabel('清晰度', { exact: true })).toHaveCount(0)
      await expect(page.getByLabel('导出宽度', { exact: true })).toHaveAttribute('readonly', '')
      await expect(page.getByLabel('导出高度', { exact: true })).toHaveAttribute('readonly', '')
      await expect(page.getByRole('button', { name: '打开文件夹', exact: true })).toHaveCount(0)
      await page.evaluate(async () => { window.exportDimensions.project = { ...window.exportDimensions.project, width: 1024, height: 576 }; await window.exportDimensions.reopen() })
      await checkSize(page, 1024, 576)
      assert.deepEqual(errors, [])
      await page.close()
      console.log('PASS 网页只读保留项目原始尺寸，不套用桌面编码限制；重新打开同步项目设置')
    }
    {
      const page = await browser.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await mount(page, baseURL, true, 16384, 8192)
      await checkSize(page, 16384, 8192)
      await expect(page.getByTestId('start-export')).toBeDisabled()
      await expect(page.getByTestId('export-dimension-error')).toContainText('请在预览上方调整画面尺寸')
      assert.deepEqual(errors, [])
      await page.close()
      console.log('PASS 超出编码上限明确提示项目设置调整，不留下无说明禁用按钮')
    }
    {
      const page = await browser.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await mount(page, baseURL, true, 640, 360)
      const start = page.getByTestId('start-export')
      await page.evaluate(() => {
        const state = window.exportDimensions
        state.holdBegin = true
        state.currentJob = { id: 'export-actual', kind: 'timeline', state: 'running', progress: 0, createdAt: Date.now(), startedAt: Date.now(), elapsedSeconds: 0, stage: '正在检查硬件编码' }
      })
      await start.click()
      await expect.poll(() => page.evaluate(() => typeof window.exportDimensions.releaseBegin)).toBe('function')
      const timer = page.getByTestId('export-elapsed')
      await expect(timer).toHaveAttribute('role', 'timer')
      await expect(timer).toHaveAttribute('aria-live', 'off')
      await expect(timer).toHaveText(/已用时 00:0[1-9]/)
      await expect(page.getByTestId('export-stage')).toHaveCount(0)
      assert.equal(await page.evaluate(() => window.exportIntervals.size), 1, '准备阶段已计时且只有一个计时器')
      await page.evaluate(() => { window.exportDimensions.holdBegin = false; window.exportDimensions.releaseBegin() })
      await expect(page.getByTestId('export-stage')).toHaveText('正在检查硬件编码')
      await page.evaluate(() => Object.assign(window.exportDimensions.currentJob, { backend: 'GPU（NVENC）', stage: '正在导出视频', progress: 0.75, elapsedSeconds: 3.1 }))
      await expect(page.getByTestId('export-stage')).toHaveText('正在导出视频 · GPU（NVENC）')
      await expect(page.locator('.progress-track>i')).toHaveAttribute('style', 'width: 75%;')
      await page.evaluate(() => Object.assign(window.exportDimensions.currentJob, { backend: 'CPU', stage: '正在导出视频', fallbackReason: '硬件编码不可用，已自动回退 CPU', progress: 0.1 }))
      await expect(page.getByTestId('export-stage')).toHaveText('正在导出视频 · CPU')
      await expect(page.getByTestId('export-fallback')).toContainText('自动回退 CPU')
      await expect(page.locator('.progress-track>i')).toHaveAttribute('style', 'width: 10%;')
      await page.evaluate(() => Object.assign(window.exportDimensions.currentJob, { state: 'completed', progress: 1, elapsedSeconds: 9.5, outputPath: '/fixture/export-result.mp4' }))
      await expect(page.getByTestId('export-completed-elapsed')).toHaveText('耗时 00:09')
      await expect(timer).toHaveCount(0)
      assert.equal(await page.evaluate(() => window.exportIntervals.size), 0, '完成冻结耗时并清除计时器')
      await page.waitForTimeout(1100)
      await expect(page.getByTestId('export-completed-elapsed')).toHaveText('耗时 00:09')
      await expect(page.getByTestId('export-fallback')).toContainText('自动回退 CPU')
      await page.evaluate(() => { window.exportDimensions.revealError = '目录暂不可访问' })
      const reveal = page.getByRole('button', { name: '打开文件夹', exact: true })
      await reveal.click()
      await expect(page.getByRole('alert')).toContainText('无法打开文件夹：目录暂不可访问')
      await page.evaluate(() => { window.exportDimensions.revealError = '' })
      await reveal.click()
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => window.exportDimensions.calls.filter(call => call.command === 'reveal_media_job_output').map(call => call.args)), { message: '等待重试真正进入原生桥，且只发送已完成任务 ID' }).toEqual([{ id: 'export-actual' }, { id: 'export-actual' }])
      await expect(reveal).toBeEnabled()
      await page.evaluate(() => window.exportDimensions.reopen())
      await expect(page.getByTestId('export-completed-elapsed')).toHaveCount(0)
      await page.evaluate(() => { window.exportDimensions.currentJob = { id: 'old-backend', kind: 'timeline', state: 'running', progress: 0, createdAt: Date.now() } })
      await start.click()
      await expect(timer).toHaveText(/已用时 00:0[1-9]/)
      await expect(page.getByTestId('export-stage')).toHaveCount(0)
      await page.getByRole('button', { name: '取消导出', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('已取消导出')
      assert.equal(await page.evaluate(() => window.exportIntervals.size), 0)
      await expect(start).toBeEnabled()
      await page.evaluate(() => { window.exportDimensions.currentJob = { id: 'unmount-job', kind: 'timeline', state: 'running', progress: 0, createdAt: Date.now() } })
      await start.click()
      await expect(timer).toBeVisible()
      await page.evaluate(() => { window.exportDimensions.open.value = false })
      assert.equal(await page.evaluate(() => window.exportIntervals.size), 0, '关闭隐藏导出页清理计时器')
      await page.evaluate(() => window.exportDimensions.cleanup())
      await expect.poll(() => page.evaluate(() => window.exportDimensions.calls.some(call => call.command === 'cancel_media_job' && call.args.id === 'unmount-job'))).toBe(true)
      assert.equal(await page.evaluate(() => window.exportIntervals.size), 0)
      assert.deepEqual(errors, [])
      await page.close()
      console.log('PASS 准备/导出实时耗时、完成冻结、真实GPU/CPU阶段与回退原因；目录打开失败可重试，取消关闭卸载清理计时')
    }
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
