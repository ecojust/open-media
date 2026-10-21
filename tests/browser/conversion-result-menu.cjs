const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__result_menu__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="app"></div></body></html>' }))
    const url = `http://127.0.0.1:${server.httpServer.address().port}/__result_menu__`
    await page.goto(url)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const { mountConversionTest } = await import('/tests/browser/conversion-harness.ts')
      await mountConversionTest()
      window.conversionHarness.assets.value = window.conversionHarness.assets.value.slice(0, 1)
    })
    const rows = page.getByTestId('convert-result')
    await page.getByTestId('convert-start').click()
    await expect(rows.first()).toHaveClass(/done/)
    await rows.first().focus(); await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: '添加到工程素材' }).click()
    const original = await page.evaluate(async () => {
      const asset = window.conversionHarness.addedToProject[0]
      const blob = await (await fetch(asset.url)).blob()
      const bitmap = await createImageBitmap(blob)
      const result = { kind: asset.kind, mime: asset.mime, blobType: blob.type, width: bitmap.width, height: bitmap.height, size: blob.size, expectedSize: asset.size, original: window.conversionHarness.assets.value.find(value => value.id === asset.id)?.url === asset.url }
      bitmap.close(); return result
    })
    assert.deepEqual(original, { kind: 'image', mime: 'image/png', blobType: 'image/png', width: 160, height: 90, size: original.size, expectedSize: original.size, original: true })
    await expect(rows.first()).toBeFocused()
    for (const format of ['tiff', 'ico']) {
      await page.getByTestId('convert-format').selectOption(format)
      await page.getByTestId('convert-start').click()
      const result = rows.last()
      await expect(result).toHaveClass(/done/)
      await expect(result).toContainText('右键可将 PNG 副本加入工程')
      await expect(result).toHaveAttribute('tabindex', '0')
      const firstDownload = page.waitForEvent('download')
      await result.locator('.result-download').click()
      const originalBytes = fs.readFileSync(await (await firstDownload).path())
      assert.deepEqual([...originalBytes.subarray(0, 4)], format === 'tiff' ? [73, 73, 42, 0] : [0, 0, 1, 0])
      await result.click({ button: 'right' })
      await page.getByRole('menuitem', { name: '以 PNG 副本加入工程', exact: true }).click()
      const copy = await page.evaluate(async () => {
        const asset = window.conversionHarness.addedToProject.at(-1)
        const blob = await (await fetch(asset.url)).blob()
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const bitmap = await createImageBitmap(blob)
        const result = { name: asset.name, kind: asset.kind, mime: asset.mime, blobType: blob.type, signature: [...bytes.slice(0, 8)], sizeMatches: blob.size === asset.size, dimensionsMatch: bitmap.width === asset.width && bitmap.height === asset.height }
        bitmap.close(); return result
      })
      assert(copy.name.endsWith('.png'))
      assert.deepEqual({ ...copy, name: undefined }, { name: undefined, kind: 'image', mime: 'image/png', blobType: 'image/png', signature: [137, 80, 78, 71, 13, 10, 26, 10], sizeMatches: true, dimensionsMatch: true })
      const repeatedDownload = page.waitForEvent('download')
      await result.locator('.result-download').click()
      assert.deepEqual(fs.readFileSync(await (await repeatedDownload).path()), originalBytes, 'adding the compatible PNG copy must not replace or mutate the exported original')
    }
    assert.equal(await page.evaluate(() => window.conversionHarness.addedToProject.length), 3)

    await page.goto(url)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const source = await (await fetch('/src/components/ConvertWorkspace.vue')).text()
      const { createApp, h } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const Component = (await import('/src/components/ConvertWorkspace.vue')).default
      const state = window.resultHarness = { calls: [], added: [], completed: false, jobs: [] }
      window.__TAURI_INTERNALS__ = {
        convertFileSrc: path => `${location.origin}/output/${encodeURIComponent(path)}`,
        invoke: async (command, args) => {
          state.calls.push({ command, args })
          if (command === 'get_runtime_status') return { ready: true }
          if (command === 'list_workspace_assets') return { directories: { recording: '/recording', videogen: '/videogen' }, assets: [], warnings: [] }
          if (command === 'begin_media_job') {
            const job = { id: `job-${state.jobs.length}`, state: 'running', progress: 0, outputPath: `C:\\Exports\\成片 ${state.jobs.length}.${args.spec.format}` }
            state.jobs.push(job); return job
          }
          if (command === 'get_media_jobs') return state.jobs.map(job => ({ ...job, state: state.completed ? 'completed' : 'running', progress: state.completed ? 1 : 0 }))
          if (command === 'reveal_media_job_output') return null
          throw new Error(`Unexpected command: ${command}`)
        },
      }
      document.body.style.height = '900px'
      document.querySelector('#app').style.height = '100%'
      // IPC supplies export completion metadata; no native encoder is claimed here.
      const input = { id: 'source', kind: 'video', name: 'source.webm', url: '', nativePath: '/recording/source.webm', duration: 10, width: 1920, height: 1080, size: 100, mime: 'video/webm' }
      createApp({ render: () => h(Component, { assets: [input], native: true, mode: 'video', 'onAdd-project': asset => state.added.push(asset) }) }).mount('#app')
    })
    await page.getByTestId('convert-start').click()
    await expect(rows.first()).toHaveClass(/running/)
    await rows.first().dispatchEvent('contextmenu', { bubbles: true, cancelable: true })
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.evaluate(() => { window.resultHarness.completed = true })
    await expect(rows.first()).toHaveClass(/done/)
    await rows.first().click({ button: 'right' })
    await expect(page.getByRole('menu', { name: '视频素材操作' })).toBeVisible()
    await page.getByRole('menuitem', { name: '添加到工程素材' }).click()
    await rows.first().focus(); await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: '打开所在文件夹' }).click()
    await expect.poll(() => page.evaluate(() => window.resultHarness.calls.filter(call => call.command === 'reveal_media_job_output').map(call => call.args.id))).toEqual(['job-0'])
    await page.getByTestId('convert-format').selectOption('wav')
    await page.getByTestId('convert-start').click()
    await expect(rows.last()).toHaveClass(/done/)
    await rows.last().click({ button: 'right' })
    await expect(page.getByRole('menu', { name: '音频素材操作' })).toBeVisible()
    await page.getByRole('menuitem', { name: '添加到工程素材' }).click()
    const added = await page.evaluate(() => window.resultHarness.added)
    assert.equal(added.length, 2)
    assert.deepEqual(added.map(asset => [asset.kind, asset.mime, asset.width, asset.height, asset.duration, asset.size]), [['video', 'video/mp4', 1920, 1080, 10, 0], ['audio', 'audio/wav', 0, 0, 10, 0]])
    assert.equal(added[0].nativePath, 'C:\\Exports\\成片 0.mp4')
    assert(added[0].url.endsWith(encodeURIComponent(added[0].nativePath)))
    assert.deepEqual(errors, [])
    console.log('PASS conversion results: real image encoding + original-blob project addition; TIFF/ICO retain original downloads and add explicit PNG copies; completed native video/audio output metadata, keyboard menu and job-based folder reveal (native IPC mocked).')
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
