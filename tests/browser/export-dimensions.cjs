const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function mount(page, baseURL, native, width = 853, height = 479) {
  await page.route('**/__export_dimensions__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="app"></div>' }))
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
    const state = window.exportDimensions = { project, specs: [], open: ref(true), errors: [], busy: [] }
    if (native) {
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          if (command === 'get_runtime_status') return { ready: true, source: 'fixture', version: 'fixture' }
          if (command === 'begin_media_job') { state.specs.push(structuredClone(args.spec)); return null }
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
      await page.getByLabel('清晰度', { exact: true }).selectOption('480')
      await checkSize(page, 856, 480)
      await expect(page.getByTestId('export-dimension-adjustment')).toContainText('源 853 × 479 → 导出 856 × 480')
      await page.getByLabel('清晰度', { exact: true }).selectOption('source')
      await checkSize(page, 854, 480)
      await page.getByLabel('导出宽度', { exact: true }).fill('887')
      await page.getByLabel('导出高度', { exact: true }).fill('501')
      await expect(page.getByTestId('start-export')).toBeDisabled()
      await expect(page.getByTestId('export-dimension-error')).toContainText('宽度和高度必须为偶数')
      await expect(page.getByTestId('export-dimension-adjustment')).toHaveCount(0)
      await page.getByRole('button', { name: '调整为偶数', exact: true }).click()
      await checkSize(page, 888, 502)
      await expect(page.getByTestId('start-export')).toBeEnabled()
      await expect(page.getByTestId('export-dimension-adjustment')).toContainText('导出 888 × 502')
      await page.getByLabel('导出高度', { exact: true }).fill('480')
      await expect(page.getByTestId('export-dimension-adjustment')).toHaveCount(0)
      await page.evaluate(() => window.exportDimensions.reopen())
      await checkSize(page, 854, 480)
      await expect(page.getByTestId('export-dimension-adjustment')).toBeVisible()
      assert.deepEqual(await page.evaluate(() => [window.exportDimensions.project.width, window.exportDimensions.project.height]), [853, 479])
      assert.deepEqual(errors, [])
      await page.close()
      console.log('PASS 桌面四种格式默认/与项目相同/清晰度偶数适配，手动奇数阻止提交并可一键调整；原始项目尺寸保留')
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
      await page.getByLabel('清晰度', { exact: true }).selectOption('480')
      await checkSize(page, 855, 480)
      await page.getByLabel('清晰度', { exact: true }).selectOption('source')
      await checkSize(page, 853, 479)
      await page.getByLabel('导出宽度', { exact: true }).fill('887')
      await expect(page.getByTestId('start-export')).toBeEnabled()
      await expect(page.getByTestId('export-dimension-error')).toHaveCount(0)
      assert.deepEqual(errors, [])
      await page.close()
      console.log('PASS 网页导出保留奇数源尺寸与手动尺寸，不套用桌面编码限制')
    }
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
