const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')
const { inspectClipboard } = require('./clipboard-helpers.cjs')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: () => true } }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__image_clipboard__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>图片剪贴板验证</title></head><body></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__image_clipboard__`)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const { mountConversionTest } = await import('/tests/browser/conversion-harness.ts')
      const { importMediaFile } = await import('/src/core/media-import.ts')
      await mountConversionTest()
      document.querySelector('#test-root').classList.add('app-shell')
      const images = []
      for (const [name, width, height] of [['四色透明图.png', 80, 60], ['第二张.png', 64, 32]]) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const context = canvas.getContext('2d')
        if (name === '四色透明图.png') {
          context.fillStyle = '#ff0000'; context.fillRect(0, 0, 40, 30)
          context.fillStyle = '#00ff00'; context.fillRect(40, 0, 40, 30)
          context.fillStyle = '#0000ff'; context.fillRect(0, 30, 40, 30)
        } else { context.fillStyle = '#cc00ff'; context.fillRect(0, 0, width, height) }
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        images.push(await importMediaFile(new File([blob], name, { type: 'image/png' })))
      }
      window.conversionHarness.assets.value = images
    })
    const copyButton = page.getByTestId('image-copy')
    async function copy(coordinates) {
      await copyButton.click()
      await expect(page.getByTestId('image-copy-status')).toHaveText('图片已复制')
      await expect(copyButton).toBeEnabled()
      return inspectClipboard(page, coordinates)
    }
    const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255], transparent = [0, 0, 0, 0]
    await expect(copyButton.locator('svg')).toHaveCount(1)
    let content = await copy([[10, 10], [70, 10], [10, 50], [70, 50]])
    assert.equal(content.width, 80); assert.equal(content.height, 60)
    assert.deepEqual(content.pixels, [red, green, blue, transparent])
    await expect(page.getByTestId('convert-result')).toHaveCount(0)
    await expect(page.locator('.convert-source')).toHaveCount(2)
    console.log('PASS 复制按钮直接写入真实剪贴板 PNG，保持原图尺寸、透明度和颜色，不新增转换任务')

    await page.getByLabel('选择 第二张.png', { exact: true }).uncheck()
    await expect(page.locator('.convert-source input:checked')).toHaveCount(1)
    content = await copy()
    assert.equal(content.width, 64); assert.equal(content.height, 32)
    assert.deepEqual(content.pixels, [[204, 0, 255, 255]], '复制当前预览的图片，即使它不在批量勾选列表中')
    console.log('PASS 多张素材只复制当前图片，独立于批量转换勾选状态')

    await page.locator('.source-details').filter({ hasText: '四色透明图.png' }).click()
    await page.getByTestId('image-crop-open').click()
    const crop = page.getByRole('dialog', { name: '框选裁剪' })
    for (const [field, value] of [['宽', 40], ['高', 40], ['X', 20], ['Y', 10]]) {
      await crop.getByLabel(`框选${field}`, { exact: true }).fill(String(value))
      await crop.getByLabel(`框选${field}`, { exact: true }).press('Tab')
    }
    await page.getByTestId('image-crop-apply').click()
    await page.getByTestId('convert-width').fill('20')
    await page.getByLabel('图片旋转').selectOption('90')
    await page.getByLabel('水平翻转', { exact: true }).check()
    content = await copy([[3, 3], [16, 3], [3, 16], [16, 16]])
    assert.equal(content.width, 20); assert.equal(content.height, 20)
    assert.deepEqual(content.pixels, [transparent, green, blue, red], '像素应按源坐标裁剪、缩放、翻转及旋转')
    await expect(page.getByTestId('convert-result')).toHaveCount(0)
    console.log('PASS 未先转换也能复制裁剪、缩放、水平翻转和旋转后的真实像素')

    await page.getByLabel('保留透明背景', { exact: true }).uncheck()
    await page.getByLabel('图片背景颜色').fill('#ffaa00')
    content = await copy([[3, 3], [16, 3], [3, 16], [16, 16]])
    assert.deepEqual(content.pixels, [[255, 170, 0, 255], green, blue, red])
    await page.getByLabel('垂直翻转', { exact: true }).check()
    content = await copy([[3, 3], [16, 3], [3, 16], [16, 16]])
    assert.deepEqual(content.pixels, [green, [255, 170, 0, 255], red, blue])
    await page.getByLabel('垂直翻转', { exact: true }).uncheck()
    console.log('PASS 背景填色和垂直翻转立即应用于剪贴板图片')

    await page.getByTestId('convert-start').click()
    await expect(page.locator('[data-testid="convert-result"].done')).toHaveCount(1)
    await page.getByTestId('convert-width').fill('10')
    await page.getByLabel('图片旋转').selectOption('0')
    await page.getByLabel('水平翻转', { exact: true }).uncheck()
    await page.getByLabel('图片背景颜色').fill('#336699')
    content = await copy([[1, 1], [8, 1], [1, 8], [8, 8]])
    assert.equal(content.width, 10); assert.equal(content.height, 10)
    assert.deepEqual(content.pixels, [red, green, blue, [51, 102, 153, 255]])
    console.log('PASS 已有转换预览时，复制仍使用当前设置重新处理原图，不复制过期结果')

    await page.getByTestId('convert-format').selectOption('ico')
    for (const size of [16, 48, 64, 128, 256]) await page.getByLabel(`图标 ${size} 像素`, { exact: true }).uncheck()
    content = await copy([[4, 4], [27, 4], [4, 27], [27, 27]])
    assert.equal(content.width, 32); assert.equal(content.height, 32)
    assert.deepEqual(content.pixels, [red, green, blue, [51, 102, 153, 255]])
    await page.getByTestId('convert-format').selectOption('tiff')
    content = await copy([[1, 1], [8, 1], [1, 8], [8, 8]])
    assert.equal(content.width, 10); assert.equal(content.height, 10)
    assert.deepEqual(content.pixels, [red, green, blue, [51, 102, 153, 255]])
    console.log('PASS 图标与高保真输出格式也能通过 PNG 图片粘贴，保留对应尺寸和编辑结果')

    const previousDigest = content.digest
    await page.getByTestId('convert-width').fill('0')
    await copyButton.click()
    await expect(page.getByTestId('image-copy-status')).not.toHaveText('图片已复制')
    await expect(page.getByTestId('image-copy-status')).toContainText('尺寸')
    await expect(copyButton).toBeEnabled()
    assert.equal((await inspectClipboard(page)).digest, previousDigest, '无效尺寸不能清空已有剪贴板')
    await expect(page.getByTestId('convert-image-preview')).toBeVisible()
    await page.getByTestId('convert-width').fill('10')
    await copy()
    const superseded = await page.evaluate(async () => {
      const { copyImageToClipboard } = await import('/src/core/image-clipboard.ts')
      async function picture(color, width, height) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, width, height)
        return new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      }
      const older = await picture('#ff0000', 18, 12), newer = await picture('#00ff00', 22, 14)
      let finishOlder
      const source = new Promise(resolve => { finishOlder = resolve })
      const first = copyImageToClipboard(source, false).then(() => 'completed', error => error.name)
      const second = copyImageToClipboard(newer, false)
      await second
      finishOlder(older)
      return first
    })
    assert.equal(superseded, 'AbortError', '新请求取消旧图片准备，不能让较晚结束的旧复制覆盖新图')
    content = await inspectClipboard(page)
    assert.equal(content.width, 22); assert.equal(content.height, 14)
    assert.deepEqual(content.pixels, [green])
    const newestDigest = content.digest
    const cancelled = await page.evaluate(async () => {
      const { copyImageToClipboard } = await import('/src/core/image-clipboard.ts')
      const controller = new AbortController()
      let rejectSource
      const source = new Promise((_resolve, reject) => { rejectSource = reject })
      const copying = copyImageToClipboard(source, false, controller.signal).then(() => 'completed', error => error.name)
      controller.abort()
      const result = await copying
      rejectSource(new Error('已取消图片稍后解码失败'))
      return result
    })
    assert.equal(cancelled, 'AbortError')
    assert.equal((await inspectClipboard(page)).digest, newestDigest, '取消待准备图片不能清空或覆盖已有剪贴板')
    console.log('PASS 慢旧复制被新请求取消，最终读回较新图片；等待期间取消保持原剪贴板且没有未处理异常')
    await page.evaluate(() => { window.conversionHarness.assets.value = [] })
    await expect(copyButton).toHaveCount(0)
    assert.deepEqual(errors, [])
    console.log('PASS 无效编辑失败后仍保留图片和旧剪贴板，可修正后重试；无图片时不显示复制入口')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
