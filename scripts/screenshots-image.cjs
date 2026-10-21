// Reproduce the image editor README screenshots from the current application.
// Artwork is an original vector landscape rendered into small local PNG fixtures.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const root = path.resolve(__dirname, '..')
  const output = path.join(root, 'docs/screenshots')
  const { createServer } = await import('vite')
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(server.resolvedUrls.local[0])
    await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 30000 })
    const images = await page.evaluate(() => {
      const variants = [
        ['山野计划 · 主题海报.png', '#dbece4', '#ecdbb0', '#174c53'],
        ['日落山脊 · 配色参考.png', '#eee0d7', '#efb68b', '#6c4863'],
        ['海岸漫游 · 素材底图.png', '#d5e9ef', '#f3e6c8', '#185b78'],
        ['林间晨光 · 封面备选.png', '#e5e8cf', '#edcf8c', '#406748'],
      ]
      return variants.map(([name, skyTop, skyBottom, foreground], variant) => {
        const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 1000
        const ctx = canvas.getContext('2d')
        const sky = ctx.createLinearGradient(0, 0, 0, 1000); sky.addColorStop(0, skyTop); sky.addColorStop(1, skyBottom)
        ctx.fillStyle = sky; ctx.fillRect(0, 0, 1440, 1000)
        ctx.strokeStyle = '#ffffff45'; ctx.lineWidth = 1
        for (let r = 112; r < 380; r += 24) { ctx.beginPath(); ctx.arc(1120, 270, r, 0, Math.PI * 2); ctx.stroke() }
        ctx.fillStyle = '#fff3ca'; ctx.beginPath(); ctx.arc(1120, 270, 104, 0, Math.PI * 2); ctx.fill()
        const hills = [
          ['#94b6af', [[0, 665], [160, 505], [270, 610], [450, 380], [630, 610], [815, 450], [1080, 635], [1290, 395], [1440, 530]]],
          ['#5b9695', [[0, 780], [230, 590], [480, 790], [700, 565], [900, 670], [1130, 530], [1440, 700]]],
          [foreground, [[0, 835], [160, 730], [340, 765], [600, 710], [880, 850], [1140, 660], [1440, 745]]],
        ]
        hills.forEach(([color, points], index) => {
          ctx.fillStyle = variant ? [skyBottom, '#629493', foreground][index] : color
          ctx.beginPath(); ctx.moveTo(...points[0]); points.slice(1).forEach(point => ctx.lineTo(...point)); ctx.lineTo(1440, 1000); ctx.lineTo(0, 1000); ctx.closePath(); ctx.fill()
        })
        ctx.fillStyle = '#e5dbb7'; ctx.beginPath(); ctx.moveTo(716, 723); ctx.bezierCurveTo(620, 780, 840, 860, 750, 1000); ctx.lineTo(1000, 1000); ctx.bezierCurveTo(910, 890, 765, 780, 737, 728); ctx.closePath(); ctx.fill()
        ctx.fillStyle = '#31656b'
        for (let i = 0; i < 15; i++) {
          const x = 45 + i * 41, y = 770 + Math.sin(i * .7) * 32, h = 44 + (i % 4) * 18
          ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x - 23, y); ctx.lineTo(x + 23, y); ctx.closePath(); ctx.fill(); ctx.fillRect(x - 3, y, 6, 20)
        }
        ctx.strokeStyle = '#fff7df65'; ctx.lineWidth = 1.5
        for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(1030, 895 + i * 10); ctx.lineTo(1350 - i * 15, 895 + i * 10); ctx.stroke() }
        ctx.strokeStyle = '#214e5855'; ctx.lineWidth = 2
        for (const [x, y] of [[1020, 390], [1050, 360], [980, 366]]) { ctx.beginPath(); ctx.moveTo(x - 8, y + 4); ctx.quadraticCurveTo(x, y - 5, x + 8, y + 4); ctx.stroke() }
        return { name, base64: canvas.toDataURL('image/png').split(',')[1] }
      })
    })
    await page.getByTestId('nav-image').click()
    await page.getByTestId('media-input').setInputFiles(images.map(image => ({ name: image.name, mimeType: 'image/png', buffer: Buffer.from(image.base64, 'base64') })))
    await expect(page.locator('.convert-source')).toHaveCount(4)
    await page.locator('.source-details').filter({ hasText: images[0].name }).click()
    await page.getByTestId('convert-image-preview').evaluate(image => image.decode())

    async function textItem(text, size, x, y, color = '#174c53', weight = '600') {
      await page.getByTestId('image-add-text').click()
      await page.getByLabel('图片文字内容', { exact: true }).fill(text)
      await page.getByLabel('图片文字字号', { exact: true }).fill(String(size))
      await page.getByLabel('图片文字字重', { exact: true }).selectOption(weight)
      await page.getByLabel('图片文字颜色', { exact: true }).fill(color)
      await page.getByLabel('图片文字 X', { exact: true }).fill(String(x))
      await page.getByLabel('图片文字 Y', { exact: true }).fill(String(y))
      await page.getByLabel('图片文字 Y', { exact: true }).press('Tab')
    }
    await textItem('FIELD NOTES  /  VOL. 03', 22, 90, 75, '#47706b', '400')
    await textItem('去山野，寻找灵感', 78, 85, 160, '#174c53', '700')
    await textItem('把旅途，剪成值得珍藏的片段。', 30, 90, 275, '#38675f', '400')
    await textItem('山野计划  ·  秋日特辑', 25, 92, 339, '#38675f', '600')
    await textItem('01   越过山脊', 24, 1060, 815, '#f1e9ce', '600')
    await textItem('02   遇见森林', 24, 1060, 860, '#f1e9ce', '600')
    await textItem('OPEN MEDIA  /  2026', 19, 90, 935, '#efdfb8', '400')
    await page.getByTestId('image-add-stroke').click()
    await page.getByRole('button', { name: '使用荧光笔', exact: true }).click()
    await page.getByLabel('图片笔触颜色', { exact: true }).fill('#f2b35b')
    await page.getByLabel('图片笔触宽度', { exact: true }).fill('17')
    let canvas = await page.getByTestId('image-annotation-canvas').boundingBox()
    async function stroke(points) {
      canvas = await page.getByTestId('image-annotation-canvas').boundingBox()
      await page.mouse.move(canvas.x + points[0][0] * canvas.width / 1440, canvas.y + points[0][1] * canvas.height / 1000)
      await page.mouse.down()
      for (const [x, y] of points.slice(1)) await page.mouse.move(canvas.x + x * canvas.width / 1440, canvas.y + y * canvas.height / 1000, { steps: 4 })
      await page.mouse.up()
    }
    await stroke([[90, 246], [270, 251], [450, 248], [630, 251], [782, 249]])
    await page.getByRole('button', { name: '使用虚线', exact: true }).click()
    await page.getByLabel('图片笔触颜色', { exact: true }).fill('#fcf2ce')
    await page.getByLabel('图片笔触宽度', { exact: true }).fill('5')
    await stroke([[454, 425], [525, 500], [590, 567], [625, 644], [689, 697]])
    await page.getByTestId('image-select-tool').click()
    await page.getByTestId('image-annotation-item').filter({ hasText: '去山野，寻找灵感' }).click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(9)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.mouse.move(20, 1030)
    await page.evaluate(() => document.fonts.ready)
    for (const theme of ['light', 'dark']) {
      await page.getByTestId(`theme-${theme}`).click()
      await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', theme)
      await page.mouse.move(20, 1030)
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `image-edit-${theme}.png`), animations: 'disabled' })
    }
    assert.deepEqual(errors, [])
    console.log('Captured current full image workspace with four original PNG inputs, seven editable text layers, two brush layers and inline properties; no native mocks or generated output claims.')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
