const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__canvas_annotation_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="app" style="height:650px"></div><aside id="properties"></aside></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__canvas_annotation_test__`)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const moduleSource = await (await fetch('/src/components/ImageAnnotationEditor.vue')).text()
      const vueUrl = moduleSource.match(/from ["']([^"']+vue\.js[^"']*)["']/)[1]
      const { createApp, h, ref } = await import(vueUrl)
      const Editor = (await import('/src/components/ImageAnnotationEditor.vue')).default
      const image = document.createElement('canvas'); image.width = 640; image.height = 400
      const context = image.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, 640, 400)
      const source = image.toDataURL(); image.width = image.height = 0
      const annotations = ref([
        { id: 'title', kind: 'text', x: 100, y: 80, text: '画布文字', fontSize: 32, fontFamily: 'sans-serif', fontWeight: 600, color: '#111827', opacity: 1 },
        { id: 'line', kind: 'stroke', style: 'pen', points: [{ x: 30, y: 330 }, { x: 600, y: 330 }], width: 8, opacity: 1, color: '#ef4444' },
      ])
      const editor = ref(), external = ref(false)
      window.canvasTest = { annotations, editor, external, source, emissions: 0 }
      createApp({ render: () => h(Editor, { ref: editor, source, width: 640, height: 400, initialTool: 'select', modelValue: annotations.value, propertiesTarget: external.value ? document.querySelector('#properties') : undefined, 'onUpdate:modelValue': value => { annotations.value = value; window.canvasTest.emissions++ } }) }).mount('#app')
    })
    const canvas = page.getByTestId('image-annotation-canvas')
    await page.locator('.annotation-stage img').evaluate(image => image.decode())
    const current = () => page.evaluate(() => JSON.parse(JSON.stringify(window.canvasTest.annotations.value)))
    async function sourceClick(x, y, clicks = 1) {
      const box = await canvas.boundingBox()
      await page.mouse.click(box.x + x * box.width / 640, box.y + y * box.height / 400, { clickCount: clicks })
    }
    await sourceClick(125, 94, 2)
    const inline = page.getByTestId('image-annotation-inline-text')
    await expect(inline).toBeFocused()
    await inline.fill('直接输入，立即生效')
    assert.equal((await current())[0].text, '直接输入，立即生效', '文本无需失焦即提交父级草稿')
    await inline.dispatchEvent('compositionstart')
    await inline.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await expect(inline).toBeVisible()
    await inline.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true })
    await expect(inline).toBeVisible()
    await inline.dispatchEvent('compositionend', { data: '效' })
    await page.evaluate(() => window.canvasTest.editor.value.flush())
    await expect(inline).toHaveCount(0)
    const converted = await page.evaluate(async () => {
      const { convertImage, imageDefaults } = await import('/src/core/image-convert.ts')
      const output = await convertImage(window.canvasTest.source, { ...imageDefaults, annotations: JSON.parse(JSON.stringify(window.canvasTest.annotations.value)) })
      const bitmap = await createImageBitmap(output.blob), result = document.createElement('canvas'); result.width = bitmap.width; result.height = bitmap.height
      const context = result.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close()
      const pixels = context.getImageData(100, 80, 400, 45).data
      return { width: result.width, height: result.height, dark: [...pixels].filter((value, index) => index % 4 === 0 && value < 50).length }
    })
    assert.equal(converted.width, 640); assert.equal(converted.height, 400); assert(converted.dark > 200)
    console.log('PASS double-click editing, immediate draft publication, composition-safe confirmation and actual export pixels')

    await canvas.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown')
    assert.equal((await current())[0].x, 101); assert.equal((await current())[0].y, 90)
    await page.keyboard.press('Control+d')
    assert.equal((await current()).length, 3)
    await page.getByTestId('image-annotation-back').click()
    assert((await current())[0].id.startsWith('text-'))
    await page.getByTestId('image-annotation-front').click()
    assert((await current())[2].id.startsWith('text-'))
    await page.getByTestId('image-annotation-delete').click()
    assert.equal((await current()).length, 2)
    await page.getByTestId('image-annotation-undo').click()
    assert.equal((await current()).length, 3)
    await page.getByTestId('image-annotation-redo').click()
    assert.equal((await current()).length, 2)
    console.log('PASS keyboard source-pixel movement, duplication, layer ordering, delete and undo/redo')

    await page.getByTestId('image-annotation-item').first().click()
    const beforeView = await current()
    const viewport = page.getByRole('group', { name: '图片标注视口', exact: true })
    const box = await canvas.boundingBox()
    await page.mouse.move(box.x + 125 * box.width / 640, box.y + 104 * box.height / 400)
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -90); await page.keyboard.up('Control')
    await page.waitForTimeout(50)
    const zoomed = await canvas.boundingBox()
    assert(zoomed.width > box.width * 1.5)
    await canvas.focus()
    await page.keyboard.down('Space')
    await page.mouse.down(); await page.mouse.move(zoomed.x + 125 * zoomed.width / 640 + 24, zoomed.y + 104 * zoomed.height / 400 + 12); await page.mouse.up()
    await page.keyboard.up('Space')
    assert.deepEqual(await current(), beforeView, '缩放与平移不应改动标注或生成编辑历史')
    await page.evaluate(() => window.canvasTest.editor.value.activateTool('select'))
    const movedBox = await canvas.boundingBox()
    const start = { x: movedBox.x + 125 * movedBox.width / 640, y: movedBox.y + 104 * movedBox.height / 400 }
    await page.mouse.move(start.x, start.y); await page.mouse.down()
    await page.mouse.move(start.x + 20 * movedBox.width / 640, start.y + 10 * movedBox.height / 400, { steps: 5 }); await page.mouse.up()
    assert(Math.abs((await current())[0].x - 121) < .02)
    assert(Math.abs((await current())[0].y - 100) < .02)
    await viewport.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10000, clientX: element.getBoundingClientRect().left + 200, clientY: element.getBoundingClientRect().top + 180 })))
    await page.waitForTimeout(30)
    assert(await canvas.evaluate(element => element.width <= 4096 && element.height <= 4096 && element.width * element.height <= 8_000_000))
    console.log('PASS zoom and pan keep data unchanged, drag maps to original image coordinates and raster surfaces remain bounded')

    await page.evaluate(() => { window.canvasTest.external.value = true })
    await expect(page.locator('#properties [aria-label="标注属性"]')).toBeVisible()
    assert.equal(await page.locator('#app [aria-label="标注属性"]').count(), 0)
    await page.getByLabel('图片文字内容', { exact: true }).fill('外部属性同步')
    await page.getByTestId('image-annotation-item').first().click()
    assert.equal((await current())[0].text, '外部属性同步')
    await page.evaluate(() => { window.canvasTest.annotations.value = [{ ...window.canvasTest.annotations.value[0], text: '外部替换' }] })
    await expect(page.getByLabel('图片文字内容', { exact: true })).toHaveValue('外部替换')
    await page.getByRole('button', { name: '适应画布', exact: true }).click()
    const replacementBounds = await canvas.boundingBox()
    await page.mouse.move(replacementBounds.x + 130 * replacementBounds.width / 640, replacementBounds.y + 110 * replacementBounds.height / 400)
    await page.mouse.down()
    await page.mouse.move(replacementBounds.x + 140 * replacementBounds.width / 640, replacementBounds.y + 120 * replacementBounds.height / 400)
    await page.evaluate(() => { window.canvasTest.annotations.value = [{ ...window.canvasTest.annotations.value[0], text: '新状态', x: 42 }] })
    await page.mouse.up()
    await expect(page.getByLabel('图片文字内容', { exact: true })).toHaveValue('新状态')
    assert.equal((await current())[0].x, 42, '外部替换必须优先，不能被取消手势的旧草稿覆盖')
    await page.evaluate(() => window.canvasTest.editor.value.activateTool('stroke'))
    await canvas.focus(); await page.keyboard.press('v')
    await expect(canvas).not.toHaveClass(/drawing/)
    assert.deepEqual(errors, [])
    console.log('PASS teleported properties keep editing live and external content replacement is synchronized')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
