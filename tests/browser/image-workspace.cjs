const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: () => true } }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__image_workspace__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__image_workspace__`)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const { mountConversionTest } = await import('/tests/browser/conversion-harness.ts')
      const { importMediaFile } = await import('/src/core/media-import.ts')
      await mountConversionTest()
      document.querySelector('#test-root').classList.add('app-shell')
      const images = []
      for (const [name, width, height] of [['色块.png', 320, 200], ['第二张.png', 200, 120]]) {
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        const context = canvas.getContext('2d')
        context.fillStyle = '#0000ff'; context.fillRect(0, 0, width, height)
        if (name === '色块.png') {
          context.fillStyle = '#ff0000'; context.fillRect(0, 0, 160, 200)
          context.fillStyle = '#00ff00'; context.fillRect(160, 0, 160, 100)
          context.fillStyle = '#ffff00'; context.fillRect(160, 100, 160, 100)
        }
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        images.push(await importMediaFile(new File([blob], name, { type: 'image/png' })))
      }
      window.conversionHarness.assets.value = images
    })
    const options = await page.getByTestId('convert-format').locator('option').evaluateAll(items => items.map(item => item.value))
    for (const format of ['png', 'jpeg', 'webp', 'bmp', 'ico', 'gif', 'tiff']) assert.ok(options.includes(format), `${format} is available`)
    const dialog = page.getByRole('dialog', { name: '框选裁剪' })
    const field = label => dialog.getByLabel(`框选${label}`, { exact: true })
    async function edit(label, value) { await field(label).fill(String(value)); await field(label).press('Tab') }
    async function chooseCrop() { await edit('宽', 160); await edit('高', 80); await edit('X', 160); await edit('Y', 0) }
    await page.getByTestId('image-crop-open').click()
    await chooseCrop()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await page.locator('.source-cropped').count(), 0, 'cancel leaves the image unchanged')
    await page.getByTestId('image-crop-open').click()
    assert.equal(await field('宽').inputValue(), '320', 'cancelled coordinates are discarded')
    await chooseCrop()
    await page.getByTestId('image-crop-apply').click()
    assert.equal(await page.locator('.source-cropped').innerText(), '已框选 160 × 80')
    await page.locator('.source-details').filter({ hasText: '第二张.png' }).click()
    await page.getByTestId('image-crop-open').click()
    assert.equal(await field('宽').inputValue(), '200')
    assert.equal(await field('高').inputValue(), '120', 'crop coordinates never leak to another image')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.locator('.source-details').filter({ hasText: '色块.png' }).click()
    await page.getByTestId('image-crop-open').click()
    assert.equal(await field('X').inputValue(), '160', 'returning to an image restores its own selection')
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await dialog.evaluate(element => element.getBoundingClientRect().width <= innerWidth))
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'crop dialog fits a narrow viewport')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByTestId('convert-width').fill('80')
    await page.getByLabel('图片旋转').selectOption('90')
    await page.getByTestId('convert-start').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="convert-result"].done').length === 2)
    assert.equal(await page.locator('.source-selection').innerText(), '已选 2 项')
    for (const [name, width, height, expected] of [['色块.png', 40, 80, [0, 255, 0, 255]], ['第二张.png', 48, 80, [0, 0, 255, 255]]]) {
      const pending = page.waitForEvent('download')
      await page.getByRole('button', { name: `下载 ${name}`, exact: true }).click()
      const download = await pending
      const bytes = [...fs.readFileSync(await download.path())]
      const decoded = await page.evaluate(async bytes => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0)
        const result = { width: bitmap.width, height: bitmap.height, pixel: [...ctx.getImageData(2, 2, 1, 1).data] }
        bitmap.close(); return result
      }, bytes)
      assert.deepEqual(decoded, { width, height, pixel: expected }, 'download contains each original crop, then scaling and rotation')
    }
    console.log('PASS per-image crop confirmation/cancellation, retained selections, actual batch crop/resize/rotation pixels and narrow dialog')

    await page.getByLabel('选择 第二张.png', { exact: true }).first().uncheck()
    await page.getByLabel('选择 色块.png', { exact: true }).first().check()
    await page.locator('.source-details').filter({ hasText: '色块.png' }).first().click()
    await page.getByTestId('convert-format').selectOption('ico')
    for (const size of [16, 32, 48, 64, 128, 256]) await page.getByLabel(`图标 ${size} 像素`, { exact: true }).uncheck()
    assert.equal(await page.getByTestId('convert-start').isDisabled(), true, 'empty icon size choice cannot start an invalid conversion')
    for (const size of [16, 32, 64]) await page.getByLabel(`图标 ${size} 像素`, { exact: true }).check()
    await page.getByTestId('convert-start').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="convert-result"].done').length === 3)
    const iconPending = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载 色块.ico', exact: true }).click()
    const icon = fs.readFileSync(await (await iconPending).path())
    assert.equal(icon.readUInt16LE(2), 1)
    assert.equal(icon.readUInt16LE(4), 3)
    assert.deepEqual([0, 1, 2].map(index => icon[6 + 16 * index] || 256), [16, 32, 64])
    console.log('PASS selected ICO sizes are encoded into a real multi-image icon file')

    const before = await page.locator('.convert-source').count()
    await page.getByTestId('convert-format').selectOption('tiff')
    await page.getByTestId('convert-start').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="convert-result"].done').length === 4)
    const tiffPending = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载 色块.tiff', exact: true }).click()
    const tiff = fs.readFileSync(await (await tiffPending).path())
    assert.deepEqual([...tiff.subarray(0, 4)], [73, 73, 42, 0])
    await page.getByTestId('convert-image-preview').evaluate(image => image.decode())
    const preview = await page.getByTestId('convert-image-preview').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }))
    assert.deepEqual(preview, { width: 40, height: 80 }, 'TIFF uses a readable preview while preserving the real download')
    assert.equal(await page.locator('.convert-source').count(), before, 'TIFF download is not mislabeled as a directly decodable project image')
    assert.deepEqual(errors, [])
    console.log('PASS TIFF file download, compatible preview and clean browser runtime')
  } finally {
    await browser.close()
    await server.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
