const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const directory = process.env.BROWSER_ARTIFACTS || '/tmp/open-media-image-canvas'
  fs.mkdirSync(directory, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__image_canvas_workspace__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }))
    await page.goto(`${server.resolvedUrls.local[0]}__image_canvas_workspace__`)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const { mountConversionTest } = await import('/tests/browser/conversion-harness.ts')
      const { importMediaFile } = await import('/src/core/media-import.ts')
      await mountConversionTest()
      document.querySelector('#test-root').classList.add('app-shell')
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 800
      const ctx = canvas.getContext('2d'), sky = ctx.createLinearGradient(0, 0, 1280, 800)
      sky.addColorStop(0, '#bde4e9'); sky.addColorStop(1, '#f5e6ca')
      ctx.fillStyle = sky; ctx.fillRect(0, 0, 1280, 800)
      ctx.fillStyle = '#fff0bd'; ctx.beginPath(); ctx.arc(920, 240, 88, 0, Math.PI * 2); ctx.fill()
      for (const [color, points] of [
        ['#7caaa9', [[0, 570], [240, 290], [440, 550], [720, 340], [1010, 510], [1280, 320]]],
        ['#427f82', [[0, 650], [250, 490], [520, 650], [920, 440], [1280, 600]]],
        ['#23575f', [[0, 760], [410, 580], [790, 740], [1120, 620], [1280, 700]]],
      ]) {
        ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(...points[0]); points.slice(1).forEach(point => ctx.lineTo(...point)); ctx.lineTo(1280, 800); ctx.lineTo(0, 800); ctx.closePath(); ctx.fill()
      }
      ctx.fillStyle = '#23575f'; ctx.font = '24px sans-serif'; ctx.fillText('FIELD NOTES  /  2026', 80, 100)
      ctx.fillStyle = '#f5e6ca'; ctx.font = '22px sans-serif'; ctx.fillText('慢下来，记录每一段旅程。', 80, 735)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      window.conversionHarness.assets.value = [await importMediaFile(new File([blob], '山野旅行 · 封面.png', { type: 'image/png' }))]
    })
    const viewport = page.getByTestId('image-canvas-viewport')
    await page.getByTestId('convert-image-preview').evaluate(image => image.decode())
    await expect(page.getByTestId('image-preview-caption')).toContainText('编辑预览')
    const initial = await viewport.boundingBox()
    assert(initial.width > 900 && initial.height > 700, 'canvas receives most of the workspace')
    await page.getByTestId('image-add-text').click()
    await expect(page.getByTestId('image-select-tool')).toHaveAttribute('aria-pressed', 'true')
    await page.getByLabel('图片文字内容', { exact: true }).fill('去山野，寻找灵感')
    await page.getByLabel('图片文字字号', { exact: true }).fill('68')
    await page.getByLabel('图片文字颜色', { exact: true }).fill('#23575f')
    await page.getByLabel('图片文字 X', { exact: true }).fill('80')
    await page.getByLabel('图片文字 Y', { exact: true }).fill('160')
    await page.getByLabel('图片文字 Y', { exact: true }).press('Tab')
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(1)
    const editBox = await viewport.boundingBox()
    assert.deepEqual(editBox, initial, 'entering edit mode keeps canvas geometry stable')
    assert.equal(await page.getByRole('complementary', { name: '标注属性' }).evaluate(element => !!element.closest('.convert-settings')), true, 'properties occupy the common right panel')
    await expect(page.locator('.convert-preview .annotation-toolbar')).toHaveCount(0)
    for (const theme of ['light', 'dark']) {
      await page.locator('#test-root').evaluate((element, theme) => element.dataset.theme = theme, theme)
      await page.screenshot({ animations: 'disabled', path: path.join(directory, `text-${theme}.png`) })
    }
    await page.getByTestId('image-add-stroke').click()
    await page.getByRole('button', { name: '使用荧光笔', exact: true }).click()
    await page.getByLabel('图片笔触宽度', { exact: true }).fill('20')
    const stage = await page.getByTestId('image-canvas-stage').boundingBox()
    await page.mouse.move(stage.x + stage.width * .07, stage.y + stage.height * .34)
    await page.mouse.down(); await page.mouse.move(stage.x + stage.width * .53, stage.y + stage.height * .34, { steps: 12 }); await page.mouse.up()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(2)
    assert.deepEqual(await viewport.boundingBox(), initial, 'brush properties do not push or shrink the canvas')
    await page.screenshot({ animations: 'disabled', path: path.join(directory, 'brush-dark.png') })
    await page.getByTestId('image-annotation-canvas').focus()
    await page.keyboard.press('v')
    await expect(page.getByTestId('image-select-tool')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('image-crop-open').click()
    assert.deepEqual(await viewport.boundingBox(), initial, 'crop shares the same canvas bounds')
    await page.getByLabel('框选宽', { exact: true }).fill('1100')
    await page.getByLabel('框选宽', { exact: true }).press('Tab')
    await page.screenshot({ animations: 'disabled', path: path.join(directory, 'crop-dark.png') })
    for (const width of [1024, 760, 390]) {
      await page.setViewportSize({ width, height: 900 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: document stays within viewport`)
      const properties = page.locator('.convert-settings')
      await properties.scrollIntoViewIfNeeded()
      const box = await properties.boundingBox()
      assert(box.width > 0 && box.x >= 0 && box.x + box.width <= width + 1, `${width}: properties remain reachable`)
      await page.getByLabel('框选宽', { exact: true }).fill('1080')
      await page.getByLabel('框选宽', { exact: true }).press('Tab')
    }
    await page.getByTestId('image-crop-apply').click()
    await expect(page.getByRole('tab', { name: '导出设置', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('convert-format')).toBeVisible()
    assert.deepEqual(errors, [])
    console.log(`PASS stable canvas geometry across preview/text/brush/crop, shared contextual properties, keyboard tool state and responsive controls. Screenshots: ${directory}`)
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
