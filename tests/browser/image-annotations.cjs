const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { chromium, expect } = require('@playwright/test')

async function inspectPng(page, bytes, points = [], mime = 'image/png') {
  return page.evaluate(async ({ bytes, points, mime }) => {
    const blob = bytes ? new Blob([new Uint8Array(bytes)], { type: mime }) : await (await navigator.clipboard.read()).find(item => item.types.includes('image/png')).getType('image/png')
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(bitmap, 0, 0); bitmap.close()
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
    return {
      width: canvas.width, height: canvas.height,
      digest: [...new Uint8Array(await crypto.subtle.digest('SHA-256', rgba))].map(value => value.toString(16).padStart(2, '0')).join(''),
      pixels: points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]),
      blackPixels: Array.from({ length: rgba.length / 4 }, (_, index) => index * 4).filter(offset => rgba[offset] < 50 && rgba[offset + 1] < 50 && rgba[offset + 2] < 50 && rgba[offset + 3] > 200).length,
    }
  }, { bytes: bytes ? [...bytes] : undefined, points, mime })
}

async function inspectPreview(page, points = []) {
  const bytes = await page.getByTestId('convert-image-preview').evaluate(async image => {
    await image.decode()
    return [...new Uint8Array(await (await fetch(image.src)).arrayBuffer())]
  })
  return inspectPng(page, bytes, points)
}

async function copyCurrent(page, points = []) {
  await page.getByTestId('image-copy').click()
  await expect(page.getByTestId('image-copy-status')).toHaveText('图片已复制')
  return inspectPng(page, undefined, points)
}

async function convertAndDownload(page) {
  const count = await page.getByTestId('convert-result').count()
  await page.getByTestId('convert-start').click()
  await expect(page.locator('[data-testid="convert-result"].done')).toHaveCount(count + 1)
  const pending = page.waitForEvent('download')
  await page.getByTestId('convert-result').last().getByRole('button', { name: /^下载 / }).click()
  const downloaded = await pending
  return fs.readFileSync(await downloaded.path())
}

async function editCrop(page, region) {
  await page.getByTestId('image-crop-open').click()
  const panel = page.getByRole('region', { name: '框选裁剪', exact: true })
  await expect(panel).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  assert.equal(await panel.evaluate(element => !!element.closest('.convert-preview .preview-stage')), true, '裁剪必须属于当前预览区域')
  for (const [name, value] of [['宽', region.width], ['高', region.height], ['X', region.x], ['Y', region.y]]) {
    await page.getByLabel(`框选${name}`, { exact: true }).fill(String(value))
    await page.getByLabel(`框选${name}`, { exact: true }).press('Tab')
  }
  return panel
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: () => true } }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__image_annotations__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>图片编辑验证</title></head><body></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__image_annotations__`)
    const crossingBytes = await page.evaluate(async () => {
      const { convertImage, imageDefaults } = await import('/src/core/image-convert.ts')
      const source = document.createElement('canvas'); source.width = 128; source.height = 96
      const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
      const converted = await convertImage(blob, {
        ...imageDefaults,
        annotations: [
          { id: 'crossing', kind: 'stroke', style: 'marker', color: '#00ff00', width: 12, opacity: 0.5, points: [{ x: 20, y: 20 }, { x: 100, y: 80 }, { x: 20, y: 80 }, { x: 100, y: 20 }] },
          { id: 'point', kind: 'stroke', style: 'pen', color: '#ff0000', width: 8, opacity: 1, points: [{ x: 20, y: 50 }, { x: 20, y: 50 }] },
        ],
      })
      return [...new Uint8Array(await converted.blob.arrayBuffer())]
    })
    const crossing = await inspectPng(page, crossingBytes, [[60, 50], [40, 35], [20, 50]])
    assert.deepEqual(crossing.pixels[0], crossing.pixels[1], '同一条荧光笔路径自交处不能重复叠加透明度')
    assert(crossing.pixels[0][3] >= 127 && crossing.pixels[0][3] <= 128)
    assert.deepEqual(crossing.pixels[2], [255, 0, 0, 255], '重复坐标的单点笔触也要产生可见像素')
    console.log('PASS 荧光笔自交处保持同一次透明合成，单点笔触写入真实像素')
    await page.evaluate(async () => {
      await import('/src/style.css')
      const { mountConversionTest } = await import('/tests/browser/conversion-harness.ts')
      const { importMediaFile } = await import('/src/core/media-import.ts')
      await mountConversionTest()
      document.querySelector('#test-root').classList.add('app-shell')
      const images = []
      for (const [name, width, height] of [['编辑原图.png', 320, 200], ['独立图片.png', 200, 120]]) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const context = canvas.getContext('2d')
        context.fillStyle = name === '编辑原图.png' ? '#ffffff' : '#0055aa'; context.fillRect(0, 0, width, height)
        if (name === '编辑原图.png') { context.fillStyle = '#ee2200'; context.fillRect(0, 0, 40, 40) }
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        images.push(await importMediaFile(new File([blob], name, { type: 'image/png' })))
      }
      window.conversionHarness.assets.value = images
    })
    await expect(page.locator('.convert-toolbar h1')).toHaveText('图片编辑')
    await page.getByLabel('选择 独立图片.png', { exact: true }).uncheck()
    await page.locator('.source-details').filter({ hasText: '编辑原图.png' }).first().click()
    const original = await inspectPreview(page, [[10, 10]])
    assert.equal(original.width, 320); assert.equal(original.height, 200)
    assert.deepEqual(original.pixels, [[238, 34, 0, 255]])
    await editCrop(page, { x: 80, y: 40, width: 160, height: 100 })
    await page.getByTestId('image-crop-apply').click()
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalWidth', 160)
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalHeight', 100)
    const cropped = await inspectPreview(page, [[10, 10]])
    assert.deepEqual(cropped.pixels, [[255, 255, 255, 255]], '确认裁剪后主页必须立即显示裁剪后的实际像素')
    const cancelledCrop = await editCrop(page, { x: 0, y: 0, width: 80, height: 60 })
    await page.getByTestId('image-edit-cancel').click()
    assert.equal((await inspectPreview(page)).digest, cropped.digest)
    await page.getByTestId('image-crop-clear').click()
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalWidth', 320)
    assert.equal((await inspectPreview(page)).digest, original.digest)
    console.log('PASS 框选确认后主预览尺寸与像素立即改变，取消保留已应用效果，清除裁剪恢复原图')

    async function fill(label, value) {
      const input = page.getByLabel(label, { exact: true })
      if (await input.getAttribute('type') === 'range') {
        const minimum = Number(await input.getAttribute('min')), step = Number(await input.getAttribute('step'))
        await input.press('Home')
        for (let count = 0; count < Math.round((Number(value) - minimum) / step); count++) await input.press('ArrowRight')
      } else await input.fill(String(value))
      await input.press('Tab')
    }
    async function drag(start, end) {
      const canvas = page.getByTestId('image-annotation-canvas')
      await canvas.locator('..').locator('img').evaluate(image => image.decode())
      const bounds = await canvas.boundingBox()
      await page.mouse.move(bounds.x + start[0] / 320 * bounds.width, bounds.y + start[1] / 200 * bounds.height)
      await page.mouse.down()
      const drawingBounds = await canvas.boundingBox()
      for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(drawingBounds[key] - bounds[key]) <= 0.5, `开始笔触或选中标注不能改变画布的 ${key}，否则实际指针位置会偏移`)
      await page.mouse.move(bounds.x + end[0] / 320 * bounds.width, bounds.y + end[1] / 200 * bounds.height, { steps: 10 })
      await page.mouse.up()
    }
    await page.getByTestId('image-add-text').click()
    await expect(page.getByRole('region', { name: '图片标注', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    assert.equal(await page.getByTestId('image-annotations-panel').evaluate(element => !!element.closest('.convert-preview .preview-stage')), true, '文字和笔触应在当前图片预览中编辑')
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(1)
    await fill('图片文字内容', '标题 A')
    await fill('图片文字字号', 28)
    await fill('图片文字颜色', '#000000')
    await fill('图片文字 X', 70)
    await fill('图片文字 Y', 50)
    await drag([90, 65], [130, 85])
    await expect(page.getByLabel('图片文字 X', { exact: true })).toHaveValue('110')
    await expect(page.getByLabel('图片文字 Y', { exact: true })).toHaveValue('70')
    await page.getByTestId('image-annotation-undo').click()
    await expect(page.getByLabel('图片文字 X', { exact: true })).toHaveValue('70')
    await page.getByTestId('image-annotation-redo').click()
    await expect(page.getByLabel('图片文字 X', { exact: true })).toHaveValue('110')
    await fill('图片文字内容', '已编辑的文字')
    await page.getByTestId('image-annotation-delete').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(0)
    await page.getByTestId('image-annotation-undo').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(1)
    fs.mkdirSync('/tmp/open-media-image-edit', { recursive: true })
    await page.screenshot({ path: '/tmp/open-media-image-edit/text-inline-desktop.png', fullPage: true })
    await page.getByTestId('image-annotation-canvas').evaluate(element => { window.inlineAnnotationCanvas = element })
    await page.getByTestId('image-add-stroke').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(1)
    await expect(page.getByTestId('image-annotation-item').first()).toContainText('已编辑的文字')
    await page.getByTestId('image-add-text').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(2)
    assert.equal(await page.getByTestId('image-annotation-canvas').evaluate(element => element === window.inlineAnnotationCanvas), true, '外部文字和笔触按钮应复用同一编辑组件')
    await expect(page.getByTestId('image-annotation-item').first()).toContainText('已编辑的文字')
    await fill('图片文字内容', '当前会话新增文字')
    await page.getByTestId('image-annotation-delete').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(1)
    await page.locator('.source-details').filter({ hasText: '独立图片.png' }).first().click()
    await expect(page.getByTestId('image-annotations-panel')).toHaveCount(0)
    await page.locator('.source-details').filter({ hasText: '编辑原图.png' }).first().click()
    await expect.poll(async () => (await inspectPreview(page)).blackPixels).toBeGreaterThan(50)
    const textPreview = await inspectPreview(page)
    assert.notEqual(textPreview.digest, original.digest)
    await page.getByTestId('image-add-text').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(2)
    await fill('图片文字内容', '这段取消的内容不能保存')
    await page.getByTestId('image-edit-cancel').click()
    assert.equal((await inspectPreview(page)).digest, textPreview.digest)
    console.log('PASS 文字可插入、编辑、拖动和撤销重做；外部文字/笔触切换复用会话不丢草稿，切换素材自动应用实际字形，取消不污染已保存编辑')

    await page.getByTestId('image-add-stroke').click()
    await expect(page.getByRole('region', { name: '图片标注', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(1)
    for (const stroke of [
      { style: 'pen', color: '#ff0000', width: 8, opacity: '1', start: [50, 140], end: [140, 140] },
      { style: 'marker', color: '#00ff00', width: 12, opacity: '0.5', start: [180, 140], end: [280, 140] },
      { style: 'dashed', color: '#0000ff', width: 6, opacity: '1', start: [180, 175], end: [280, 175] },
    ]) {
      await page.getByTestId('image-add-stroke').click()
      await page.getByRole('button', { name: `使用${{ pen: '画笔', marker: '荧光笔', dashed: '虚线' }[stroke.style]}`, exact: true }).click()
      await fill('图片笔触颜色', stroke.color)
      await fill('图片笔触宽度', stroke.width)
      await fill('图片笔触透明度', stroke.opacity)
      await drag(stroke.start, stroke.end)
    }
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(4)
    await page.getByTestId('image-annotation-undo').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(3)
    await page.getByTestId('image-annotation-redo').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(4)
    await page.getByTestId('image-annotation-item').nth(1).click()
    await expect(page.getByLabel('图片笔触类型')).toHaveValue('pen')
    await expect(page.getByLabel('图片笔触宽度')).toHaveValue('8')
    await page.getByTestId('image-annotation-delete').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(3)
    await page.getByTestId('image-annotation-undo').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(4)
    const cropAfterDraft = await editCrop(page, { x: 0, y: 0, width: 320, height: 200 })
    await expect(page.getByTestId('image-annotations-panel')).toHaveCount(0)
    await page.getByTestId('image-edit-cancel').click()
    const points = [[90, 140], [220, 140], [185, 175], [205, 175]]
    await expect.poll(async () => (await inspectPreview(page, points)).pixels[0]).toEqual([255, 0, 0, 255])
    const annotated = await inspectPreview(page, points)
    assert.deepEqual(annotated.pixels[0], [255, 0, 0, 255])
    assert(annotated.pixels[1][0] >= 127 && annotated.pixels[1][0] <= 128 && annotated.pixels[1][1] === 255 && annotated.pixels[1][2] === annotated.pixels[1][0], '荧光笔透明度应合成到真实图片像素')
    assert.deepEqual(annotated.pixels[2], [0, 0, 255, 255])
    assert.deepEqual(annotated.pixels[3], [255, 255, 255, 255], '虚线必须保留间隔')
    assert.equal((await copyCurrent(page)).digest, annotated.digest)
    console.log('PASS 切换裁剪先应用未确认笔触，取消裁剪不撤销已应用标注；三种笔触实际颜色与透明度、虚线间隔、复制与主预览一致')

    await page.locator('.source-details').filter({ hasText: '独立图片.png' }).first().click()
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalWidth', 200)
    assert.deepEqual((await inspectPreview(page, [[90, 80]])).pixels, [[0, 85, 170, 255]])
    await page.getByTestId('image-add-stroke').click()
    await expect(page.getByTestId('image-annotation-item')).toHaveCount(0)
    await page.getByTestId('image-edit-cancel').click()
    await page.locator('.source-details').filter({ hasText: '编辑原图.png' }).first().click()
    await expect.poll(async () => (await inspectPreview(page)).digest).toBe(annotated.digest)
    console.log('PASS 每张图片独立保留文字和笔触，切换图片不会串用标注')
    fs.mkdirSync('/tmp/open-media-image-edit', { recursive: true })
    await page.screenshot({ path: '/tmp/open-media-image-edit/edited-preview.png', fullPage: true })
    await page.getByTestId('image-add-stroke').click()
    await page.setViewportSize({ width: 390, height: 820 })
    const compactEditor = page.getByRole('region', { name: '图片标注', exact: true })
    await expect.poll(() => compactEditor.evaluate(element => element.getBoundingClientRect().width <= innerWidth && element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(page.getByTestId('image-annotations-apply')).toBeVisible()
    await page.screenshot({ path: '/tmp/open-media-image-edit/editor-compact.png', fullPage: true })
    await page.getByTestId('image-edit-cancel').click()
    await page.setViewportSize({ width: 1280, height: 1000 })

    await editCrop(page, { x: 40, y: 40, width: 260, height: 150 })
    await page.getByTestId('image-crop-apply').click()
    await page.getByTestId('convert-width').fill('130')
    await page.getByLabel('图片旋转').selectOption('90')
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalWidth', 75)
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalHeight', 130)
    await expect(page.getByTestId('image-preview-caption')).toHaveText('编辑预览 · 75 × 130 · 4 个标注')
    const unflipped = await inspectPreview(page, [[25, 105]])
    assert(unflipped.pixels[0][0] >= 127 && unflipped.pixels[0][0] <= 128 && unflipped.pixels[0][1] === 255 && unflipped.pixels[0][2] === unflipped.pixels[0][0], '翻转前该位置应为荧光笔，防止把旧预览当作翻转结果')
    const previousPreviewUrl = await page.getByTestId('convert-image-preview').getAttribute('src')
    await page.getByLabel('水平翻转', { exact: true }).check()
    // A flip preserves dimensions, so wait for the new rendered image rather than its size.
    await expect(page.getByTestId('convert-image-preview')).not.toHaveAttribute('src', previousPreviewUrl)
    await expect(page.getByTestId('image-preview-caption')).toHaveText('编辑预览 · 75 × 130 · 4 个标注')
    const transformed = await inspectPreview(page, [[25, 105]])
    assert.deepEqual(transformed.pixels, [[255, 0, 0, 255]], '原图坐标的笔触必须与图片一同裁剪、缩放、翻转和旋转')
    const copied = await copyCurrent(page)
    assert.equal(copied.digest, transformed.digest)
    const png = await convertAndDownload(page)
    const exported = await inspectPng(page, png)
    assert.equal(exported.digest, copied.digest, '真实下载 PNG 与剪贴板完整 RGBA 必须一致')
    assert(exported.blackPixels > 10, '变换后的导出必须保留文字')
    console.log('PASS 裁剪、缩放、翻转、旋转同步作用于文字笔触；下载 PNG、主预览、真实剪贴板逐像素一致')

    const availableFormats = await page.getByTestId('convert-format').locator('option').evaluateAll(items => items.map(item => item.value))
    for (const format of ['jpeg', 'webp', 'bmp', 'gif', 'avif'].filter(format => availableFormats.includes(format))) {
      await page.getByTestId('convert-format').selectOption(format)
      const bytes = await convertAndDownload(page)
      const decoded = await inspectPng(page, bytes, [[25, 105]], `image/${format}`)
      assert.equal(decoded.width, 75); assert.equal(decoded.height, 130)
      assert(decoded.pixels[0][0] > 230 && decoded.pixels[0][1] < 25 && decoded.pixels[0][2] < 25 && decoded.pixels[0][3] === 255, `${format} 下载应保留变换后的红色笔触`)
      assert(decoded.blackPixels > 5, `${format} 下载应保留文字像素`)
      assert.equal((await copyCurrent(page)).digest, decoded.digest, `${format} 导出与对应复制结果必须一致`)
      console.log(`PASS ${format.toUpperCase()} 真实下载解码保留变换后的文字笔触，与剪贴板逐像素一致`)
    }

    await page.getByTestId('convert-format').selectOption('ico')
    for (const size of [16, 32, 48, 128, 256]) await page.getByLabel(`图标 ${size} 像素`, { exact: true }).uncheck()
    const ico = await convertAndDownload(page)
    assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 1)
    const iconLength = ico.readUInt32LE(14), iconOffset = ico.readUInt32LE(18)
    const iconPixels = await inspectPng(page, ico.subarray(iconOffset, iconOffset + iconLength))
    assert.equal(iconPixels.width, 64); assert.equal(iconPixels.height, 64)
    assert(iconPixels.blackPixels > 5)
    assert.equal((await copyCurrent(page)).digest, iconPixels.digest)
    await page.getByTestId('convert-format').selectOption('tiff')
    const tiff = await convertAndDownload(page)
    assert.equal(tiff.readUInt16LE(0), 0x4949)
    const directory = tiff.readUInt32LE(4), tags = {}
    for (let index = 0; index < tiff.readUInt16LE(directory); index++) {
      const cursor = directory + 2 + index * 12
      tags[tiff.readUInt16LE(cursor)] = tiff.readUInt32LE(cursor + 8)
    }
    const tiffPixels = tiff.subarray(tags[273], tags[273] + tags[256] * tags[257] * 4)
    assert.equal(tiffPixels.length, tags[256] * tags[257] * 4)
    const tiffClipboard = await copyCurrent(page)
    assert.equal(tiffClipboard.width, tags[256]); assert.equal(tiffClipboard.height, tags[257])
    assert.equal(createHash('sha256').update(tiffPixels).digest('hex'), tiffClipboard.digest)
    assert(tiffClipboard.blackPixels > 10)
    console.log('PASS ICO 内嵌真实图片和 TIFF 像素均保留文字笔触，与对应复制图片逐像素一致')

    await page.evaluate(async () => {
      const { importMediaFile } = await import('/src/core/media-import.ts')
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 320
      const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      const asset = await importMediaFile(new File([blob], '裁剪后文字.png', { type: 'image/png' }))
      window.conversionHarness.assets.value.push(asset)
      window.conversionHarness.focusAssetId.value = asset.id
    })
    await page.getByTestId('convert-format').selectOption('png')
    await page.getByTestId('convert-width').fill('')
    await page.getByLabel('图片旋转').selectOption('0')
    await page.getByLabel('水平翻转', { exact: true }).uncheck()
    await editCrop(page, { x: 340, y: 210, width: 130, height: 80 })
    await page.getByTestId('image-crop-apply').click()
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalWidth', 130)
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalHeight', 80)
    await page.getByTestId('image-add-text').click()
    await expect(page.getByTestId('image-annotation-crop-hint')).toBeVisible()
    const defaultX = Number(await page.getByLabel('图片文字 X', { exact: true }).inputValue())
    const defaultY = Number(await page.getByLabel('图片文字 Y', { exact: true }).inputValue())
    const defaultFontSize = Number(await page.getByLabel('图片文字字号', { exact: true }).inputValue())
    assert(defaultX >= 340 && defaultX < 470 && defaultY >= 210 && defaultY < 290, '默认文字应直接放到当前裁剪保留范围')
    assert(defaultFontSize >= 4 && defaultFontSize <= 26, '默认字号须适合较小保留区域')
    await fill('图片文字内容', '裁剪文字')
    await fill('图片文字颜色', '#000000')
    await page.getByTestId('image-annotations-apply').click()
    await expect.poll(async () => (await inspectPreview(page)).blackPixels).toBeGreaterThan(10)
    const croppedText = await inspectPreview(page)
    assert.equal((await copyCurrent(page)).digest, croppedText.digest)
    const croppedTextExport = await inspectPng(page, await convertAndDownload(page))
    assert.equal(croppedTextExport.digest, croppedText.digest)
    console.log('PASS 右下角小区域裁剪后默认插入文字即可看见，无需移动或缩小；复制与真实导出保留字形')

    await page.getByTestId('image-add-text').click()
    await fill('图片文字内容', '切换保留')
    await fill('图片文字颜色', '#000000')
    await fill('图片文字字号', 10)
    await fill('图片文字 X', 350)
    await fill('图片文字 Y', 260)
    await page.getByTestId('image-preview-original').click()
    await expect(page.getByTestId('image-annotations-panel')).toHaveCount(0)
    await expect(page.getByTestId('image-preview-original')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalWidth', 512)
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalHeight', 320)
    await expect(page.getByTestId('image-preview-caption')).toHaveText('原图 · 512 × 320')
    assert.equal((await inspectPreview(page)).blackPixels, 0, '未确认标注切换原图时应显示原始白图，不显示已保存的文字和裁剪')
    await page.getByTestId('image-preview-original').click()
    await expect(page.getByTestId('image-preview-original')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalWidth', 130)
    await expect(page.getByTestId('convert-image-preview')).toHaveJSProperty('naturalHeight', 80)
    await expect(page.getByTestId('image-preview-caption')).toHaveText('编辑预览 · 130 × 80 · 2 个标注')
    const resumedDraft = await inspectPreview(page)
    assert.notEqual(resumedDraft.digest, croppedText.digest, '返回编辑预览应保留切换前未确认的新增文字')
    assert.equal((await copyCurrent(page)).digest, resumedDraft.digest)
    console.log('PASS 未确认文字切换查看原图先应用草稿，原图保持原始尺寸和像素，返回编辑预览及复制保留新增标注')

    assert.deepEqual(errors, [])
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
