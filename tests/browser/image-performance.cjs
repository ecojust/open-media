const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('@playwright/test')

async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }

async function main() {
  const { createServer } = await import('vite')
  const root = path.resolve(__dirname, '../..')
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-image-performance-vite-'))
  const server = await createServer({ root, cacheDir, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__annotation_performance__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__annotation_performance__`)
    await page.evaluate(async () => {
      await import('/@vite/client')
      // Use the same transformed dependency URL as the component, including its cache key.
      const moduleSource = await (await fetch('/src/components/ImageAnnotationEditor.vue')).text()
      const vueUrl = moduleSource.match(/from ["']([^"']+vue\.js[^"']*)["']/)[1]
      const { createApp, h, nextTick } = await import(vueUrl)
      const Editor = (await import('/src/components/ImageAnnotationEditor.vue')).default
      const source = document.createElement('canvas'); source.width = 3840; source.height = 2160
      const ctx = source.getContext('2d'); ctx.fillStyle = '#202939'; ctx.fillRect(0, 0, 3840, 2160)
      const sourceUrl = source.toDataURL('image/png')
      source.width = source.height = 0
      window.metrics = { emits: 0, strokes: 0, widthWrites: 0, frameMs: [] }
      window.nextTick = nextTick
      const stroke = CanvasRenderingContext2D.prototype.stroke
      CanvasRenderingContext2D.prototype.stroke = function (...args) { window.metrics.strokes++; return stroke.apply(this, args) }
      const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')
      Object.defineProperty(HTMLCanvasElement.prototype, 'width', { ...width, set(value) { window.metrics.widthWrites++; width.set.call(this, value) } })
      const annotations = Array.from({ length: 100 }, (_, i) => ({ id: `stroke-${i}`, kind: 'stroke', style: i % 3 === 0 ? 'marker' : 'pen', color: ['#ef4444', '#00aaff', '#ffc000'][i % 3], opacity: .25, width: 4, points: Array.from({ length: 1000 }, (_, p) => ({ x: 100 + p * 3.5, y: 50 + i * 17 + Math.sin(p * .1) * 10 })) }))
      annotations.push({ id: 'selected-text', kind: 'text', text: '性能测试', x: 1800, y: 1850, fontSize: 96, fontFamily: 'sans-serif', fontWeight: 600, color: '#ffffff', opacity: 1 })
      window.latest = structuredClone(annotations)
      window.app = createApp({ render() { return h(Editor, { source: sourceUrl, width: 3840, height: 2160, modelValue: annotations, initialTool: 'stroke', 'onUpdate:modelValue': value => { window.metrics.emits++; window.latest = value } }) } })
      window.app.mount('#app')
      await nextTick()
      window.canvasDigest = async () => {
        const c = document.querySelector('[data-testid="image-annotation-canvas"]')
        const rgba = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', rgba))].map(x => x.toString(16).padStart(2, '0')).join('')
      }
    })
    await page.locator('.annotation-stage img').evaluate(image => image.decode())
    await page.getByTestId('image-annotation-item').last().click()
    await frames(page)
    const initialDigest = await page.evaluate(() => window.canvasDigest())
    const canvas = page.getByTestId('image-annotation-canvas')
    const bounds = await canvas.boundingBox()
    const x = bounds.x + 1820 * bounds.width / 3840, y = bounds.y + 1870 * bounds.height / 2160
    await page.mouse.move(x, y); await page.mouse.down()
    const result = await page.evaluate(async ({ x, y }) => {
      window.metrics = { emits: 0, strokes: 0, widthWrites: 0, frameMs: [] }
      const c = document.querySelector('[data-testid="image-annotation-canvas"]')
      for (let i = 0; i < 24; i++) {
        const started = performance.now()
        c.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1, clientX: x + (i + 1) * 2, clientY: y }))
        await window.nextTick()
        await new Promise(requestAnimationFrame)
        window.metrics.frameMs.push(performance.now() - started)
      }
      const sorted = [...window.metrics.frameMs].sort((a, b) => a - b)
      return { ...window.metrics, medianMs: sorted[12], p95Ms: sorted[22], totalMs: sorted.reduce((a, b) => a + b, 0) }
    }, { x, y })
    assert.equal(result.emits, 0, '手势内不能反复深复制并提交整个标注集')
    assert(result.strokes <= 200, '拖动文字时静态笔触只建立一次缓存')
    assert(result.widthWrites <= 2, '拖动时不应反复重置主画布尺寸')
    await page.mouse.move(x + 48, y); await page.mouse.up(); await frames(page)
    const latest = await page.evaluate(() => ({ annotations: window.latest.length, text: window.latest.at(-1), points: window.latest.filter(item => item.kind === 'stroke').reduce((n, item) => n + item.points.length, 0), emits: window.metrics.emits }))
    assert.equal(latest.annotations, 101)
    assert.equal(latest.points, 100_000)
    assert.equal(latest.emits, 1, 'pointerup提交最终坐标一次，父级可立即保存')
    assert(Math.abs(latest.text.x - (1800 + 48 * 3840 / bounds.width)) < .01)
    const movedDigest = await page.evaluate(() => window.canvasDigest())
    assert.notEqual(movedDigest, initialDigest, '文字必须真实移动并更新画面')
    await page.getByTestId('image-annotation-undo').click(); await frames(page)
    assert.equal(await page.evaluate(() => window.latest.at(-1).x), 1800)
    assert.equal(await page.evaluate(() => window.canvasDigest()), initialDigest, '撤销必须完整还原像素')
    await page.getByTestId('image-annotation-redo').click(); await frames(page)
    assert.equal(await page.evaluate(() => window.canvasDigest()), movedDigest, '重做必须完整还原像素')
    for (const reason of ['pointercancel', 'blur']) {
      await page.mouse.move(x + 48, y); await page.mouse.down(); await page.mouse.move(x + 80, y)
      await page.evaluate(reason => {
        if (reason === 'blur') window.dispatchEvent(new Event('blur'))
        else document.querySelector('[data-testid="image-annotation-canvas"]').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
      }, reason)
      await page.mouse.up(); await frames(page)
      assert.equal(await page.evaluate(() => window.latest.at(-1).x), latest.text.x, `${reason}恢复手势前坐标`)
      assert.equal(await page.evaluate(() => window.canvasDigest()), movedDigest, `${reason}恢复手势前像素`)
    }
    // A selected middle layer must stay below a later stroke throughout the gesture.
    await page.evaluate(async () => {
      const { drawImageAnnotations } = await import('/src/core/image-annotations.ts')
      const selected = window.latest.at(-1)
      const overlay = { id: 'foreground', kind: 'stroke', style: 'pen', color: '#ff0000', opacity: 1, width: 20, points: [{ x: 1800, y: 1920 }, { x: 2500, y: 1920 }] }
      window.app.unmount()
      const moduleSource = await (await fetch('/src/components/ImageAnnotationEditor.vue')).text()
      const { createApp, h } = await import(moduleSource.match(/from ["']([^"']+vue\.js[^"']*)["']/)[1])
      const Editor = (await import('/src/components/ImageAnnotationEditor.vue')).default
      const source = document.createElement('canvas'); source.width = 3840; source.height = 2160
      const url = source.toDataURL(); source.width = source.height = 0
      window.app = createApp({ render: () => h(Editor, { source: url, width: 3840, height: 2160, modelValue: [selected, overlay], initialTool: 'stroke', 'onUpdate:modelValue': value => { window.latest = value } }) })
      window.app.mount('#app')
      window.drawAnnotations = drawImageAnnotations
    })
    await page.locator('.annotation-stage img').evaluate(image => image.decode())
    await page.getByTestId('image-annotation-item').first().click(); await frames(page)
    const middleBounds = await canvas.boundingBox()
    const middleX = middleBounds.x + (latest.text.x + 20) * middleBounds.width / 3840
    const middleY = middleBounds.y + 1860 * middleBounds.height / 2160
    await page.mouse.move(middleX, middleY); await page.mouse.down(); await page.mouse.move(middleX + 20, middleY); await frames(page)
    const foregroundPixel = await canvas.evaluate(c => [...c.getContext('2d').getImageData(Math.round(2200 * c.width / 3840), Math.round(1920 * c.height / 2160), 1, 1).data])
    assert.deepEqual(foregroundPixel, [255, 0, 0, 255], '拖动时后面的图层仍盖在文字上方')
    await page.mouse.up()
    await page.evaluate(() => window.app.unmount())
    const conversion = await page.evaluate(async () => {
      const { convertImage, imageDefaults } = await import('/src/core/image-convert.ts')
      const input = document.createElement('canvas'); input.width = 3840; input.height = 2160
      const context = input.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0, 0, input.width, input.height)
      const source = await new Promise(resolve => input.toBlob(resolve, 'image/png'))
      input.width = input.height = 0
      const canvases = [], images = []
      const originalCreate = document.createElement.bind(document), OriginalImage = window.Image
      document.createElement = function (tag, ...args) { const element = originalCreate(tag, ...args); if (tag === 'canvas') canvases.push(element); return element }
      window.Image = class extends OriginalImage { constructor(...args) { super(...args); images.push(this) } }
      const clean = () => canvases.every(canvas => canvas.width === 0 && canvas.height === 0) && images.every(image => !image.getAttribute('src'))
      try {
        const png = await convertImage(source, { ...imageDefaults, width: 1920, height: 1080, rotation: 90 })
        const pngReleased = clean(), bitmap = await createImageBitmap(png.blob)
        const decoded = { width: bitmap.width, height: bitmap.height }; bitmap.close()
        const icon = await convertImage(source, { ...imageDefaults, format: 'ico', iconSizes: [32, 64] })
        const iconReleased = clean(), bytes = await icon.blob.arrayBuffer(), directory = new DataView(bytes)
        const iconSizes = []
        for (let index = 0; index < directory.getUint16(4, true); index++) {
          const entry = 6 + index * 16, length = directory.getUint32(entry + 8, true), offset = directory.getUint32(entry + 12, true)
          const image = await createImageBitmap(new Blob([bytes.slice(offset, offset + length)], { type: 'image/png' }))
          iconSizes.push([image.width, image.height]); image.close()
        }
        let invalid = false
        try { await convertImage(new Blob(['invalid image'], { type: 'image/png' }), imageDefaults) } catch { invalid = true }
        const invalidReleased = clean(), controller = new AbortController(), toBlob = HTMLCanvasElement.prototype.toBlob
        let cancelled = false
        HTMLCanvasElement.prototype.toBlob = function (callback, ...args) { return toBlob.call(this, blob => { controller.abort(); callback(blob) }, ...args) }
        try { await convertImage(source, imageDefaults, controller.signal) } catch (error) { cancelled = error.name === 'AbortError' }
        finally { HTMLCanvasElement.prototype.toBlob = toBlob }
        return { decoded, iconSizes, pngReleased, iconReleased, invalid, invalidReleased, cancelled, cancelledReleased: clean(), temporaryCanvases: canvases.length }
      } finally { document.createElement = originalCreate; window.Image = OriginalImage }
    })
    assert.deepEqual(conversion.decoded, { width: 1080, height: 1920 })
    assert.deepEqual(conversion.iconSizes, [[32, 32], [64, 64]])
    for (const state of ['pngReleased', 'iconReleased', 'invalid', 'invalidReleased', 'cancelled', 'cancelledReleased']) assert.equal(conversion[state], true, state)
    assert.deepEqual(errors, [])
    const report = { scenario: '4K image / 100000 stroke points / 24 text drag samples', environment: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, node: process.version, browser: browser.version() }, ...result, latest, conversion, initialDigest, movedDigest, checks: ['commit', 'undo', 'redo', 'pointercancel', 'blur', 'layer-order', 'unmount'] }
    if (process.env.OPEN_MEDIA_PERFORMANCE_REPORT) {
      fs.mkdirSync(process.env.OPEN_MEDIA_PERFORMANCE_REPORT, { recursive: true })
      fs.writeFileSync(path.join(process.env.OPEN_MEDIA_PERFORMANCE_REPORT, 'image-current.json'), JSON.stringify(report, null, 2))
    }
    console.log(JSON.stringify(report, null, 2))
  } finally { await browser?.close(); await server.close(); fs.rmSync(cacheDir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
