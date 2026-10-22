const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium } = require('@playwright/test')

async function mountNativeExport(page, baseURL, scenario) {
  await page.route('**/__native_export_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>导出取消验证</title></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${baseURL}/__native_export_test__`)
  await page.evaluate(async scenario => {
    const { createProject, createClip } = await import('/src/core/project.ts')
    const { addAsset, addClip } = await import('/src/core/timeline.ts')
    const componentSource = await (await fetch('/src/components/ExportPanel.vue')).text()
    const vueImport = componentSource.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h } = await import(vueImport)
    const ExportPanel = (await import('/src/components/ExportPanel.vue')).default
    const source = document.createElement('canvas')
    source.width = 32; source.height = 18
    source.getContext('2d').fillRect(0, 0, 32, 18)
    const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
    const url = URL.createObjectURL(blob)
    let project = createProject('原生取消验证', { width: 320, height: 180 })
    const asset = { id: 'native-test-image', name: '导出素材.png', kind: 'image', url, duration: 1, width: 32, height: 18, size: blob.size, mime: 'image/png', ...(scenario === 'save-dialog' ? { nativePath: '/native-fixture/image.png' } : {}) }
    project = addAsset(project, asset)
    project = addClip(project, project.tracks.find(track => track.kind === 'video').id, createClip(asset, project, { trimOut: 1 }))
    if (scenario === 'prepare') project = addAsset(project, { ...asset, id: 'unused-second-image', name: '第二个素材.png' })
    const state = { calls: [], busy: [], statuses: [], jobs: [], nativeJob: undefined, releaseImport: undefined, releaseSave: undefined }
    window.nativeHarness = state
    window.__TAURI_INTERNALS__ = {
      convertFileSrc: () => url,
      invoke: async (command, args) => {
        state.calls.push({ command, args })
        if (command === 'get_runtime_status') return { ready: true, version: 'test', source: '测试工具' }
        if (command === 'import_blob_asset') {
          return new Promise(resolve => {
            state.releaseImport = () => resolve({ ...asset, id: 'imported-native-image', nativePath: '/native-fixture/imported.png' })
          })
        }
        if (command === 'begin_media_job') {
          return new Promise(resolve => {
            state.releaseSave = () => {
              state.nativeJob = { id: 'pending-save-job', state: 'running', progress: 0, name: '导出验证', outputPath: '/native-fixture/output.mp4' }
              resolve({ ...state.nativeJob })
            }
          })
        }
        if (command === 'cancel_media_job') {
          if (!state.nativeJob || state.nativeJob.id !== args.id) throw new Error('取消了不存在的任务')
          state.nativeJob.state = 'cancelled'
          return null
        }
        if (command === 'get_media_jobs') return state.nativeJob ? [{ ...state.nativeJob }] : []
        throw new Error(`测试未预期的原生命令：${command}`)
      },
    }
    const app = createApp({ render: () => h(ExportPanel, { project, native: true, open: true, onBusy: value => state.busy.push(value), onStatus: value => state.statuses.push(value), onJob: value => state.jobs.push(value) }) })
    app.mount('#app')
    state.cleanup = () => { app.unmount(); URL.revokeObjectURL(url); delete window.__TAURI_INTERNALS__ }
  }, scenario)
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    const page = await browser.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))

    await mountNativeExport(page, baseURL, 'prepare')
    await page.getByTestId('start-export').click()
    await page.waitForFunction(() => typeof window.nativeHarness.releaseImport === 'function')
    await page.getByRole('button', { name: '取消导出', exact: true }).click()
    await page.evaluate(() => window.nativeHarness.releaseImport())
    await page.waitForFunction(() => window.nativeHarness.busy.at(-1) === false)
    const prepared = await page.evaluate(() => ({ calls: window.nativeHarness.calls, statuses: window.nativeHarness.statuses, busy: window.nativeHarness.busy }))
    assert.equal(prepared.calls.filter(call => call.command === 'begin_media_job').length, 0, '素材准备期间取消仍启动了编码')
    assert.equal(prepared.calls.filter(call => call.command === 'import_blob_asset').length, 1, '取消后仍继续导入后续素材')
    assert.deepEqual(prepared.calls.find(call => call.command === 'import_blob_asset').args.bytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10], '准备阶段没有经过真实PNG读取')
    assert.deepEqual(prepared.busy, [true, false])
    assert.equal(prepared.statuses.some(message => /导出完成/.test(message)), false)
    assert.equal(await page.locator('.success-message').count(), 0)
    assert.match(await page.getByRole('alert').innerText(), /取消/)
    assert.equal(await page.getByTestId('start-export').isEnabled(), true)
    await page.evaluate(() => window.nativeHarness.cleanup())
    console.log('PASS 原生素材准备过程中取消：不启动编码、不继续准备、不报告完成')

    await mountNativeExport(page, baseURL, 'save-dialog')
    await page.getByTestId('start-export').click()
    await page.waitForFunction(() => typeof window.nativeHarness.releaseSave === 'function')
    await page.getByRole('button', { name: '取消导出', exact: true }).click()
    assert.equal(await page.evaluate(() => window.nativeHarness.calls.some(call => call.command === 'cancel_media_job')), false, '保存框尚未返回任务时不应取消未知任务')
    await page.evaluate(() => window.nativeHarness.releaseSave())
    await page.waitForFunction(() => window.nativeHarness.calls.some(call => call.command === 'cancel_media_job') && window.nativeHarness.busy.at(-1) === false)
    const saved = await page.evaluate(() => ({ calls: window.nativeHarness.calls, statuses: window.nativeHarness.statuses, busy: window.nativeHarness.busy, job: window.nativeHarness.nativeJob }))
    const cancelled = saved.calls.filter(call => call.command === 'cancel_media_job')
    assert.equal(saved.calls.filter(call => call.command === 'begin_media_job').length, 1)
    assert.equal(cancelled.length, 1, '返回的编码任务应且只应取消一次')
    assert.equal(cancelled[0].args.id, 'pending-save-job')
    assert.equal(saved.job.state, 'cancelled')
    assert.deepEqual(saved.busy, [true, false])
    assert.equal(saved.statuses.some(message => /导出完成/.test(message)), false)
    assert.equal(await page.locator('.success-message').count(), 0)
    assert.match(await page.getByRole('alert').innerText(), /取消/)
    assert.equal(await page.getByTestId('start-export').isEnabled(), true)
    assert.equal(await page.getByRole('button', { name: '关闭导出', exact: true }).isEnabled(), true)
    await page.evaluate(() => window.nativeHarness.cleanup())
    assert.deepEqual(errors, [])
    console.log('PASS 原生保存框等待期间取消：任务返回后立即取消，不报告导出完成')
  } finally { await browser?.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
