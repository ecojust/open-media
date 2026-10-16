const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
  try {
    const page = await browser.newPage()
    await page.route('**/__image_format_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>图片格式验证</title>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__image_format_test__`)
    const result = await page.evaluate(async () => {
      const { convertImage, imageDefaults, getSupportedImageFormats, standardIconSizes } = await import('/src/core/image-convert.ts')
      const source = document.createElement('canvas')
      source.width = 32
      source.height = 16
      const context = source.getContext('2d')
      context.fillStyle = '#ff0000'
      context.fillRect(0, 0, 16, 16)
      context.fillStyle = '#0000ff'
      context.fillRect(16, 0, 16, 8)
      const input = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
      const inspect = async blob => {
        const bitmap = await createImageBitmap(blob)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        return { width: canvas.width, height: canvas.height, pixel: (x, y) => [...ctx.getImageData(x, y, 1, 1).data] }
      }
      const supported = await getSupportedImageFormats()
      const outputs = []
      for (const format of supported.filter(format => format !== 'ico')) {
        const converted = await convertImage(input, { ...imageDefaults, format, crop: { x: 8, y: 0, width: 16, height: 16 }, width: 8, rotation: 90, quality: 1 })
        const preview = await inspect(converted.previewBlob ?? converted.blob)
        const bytes = new DataView(await converted.blob.arrayBuffer())
        let tiff
        if (format === 'tiff') {
          const tags = {}
          for (let index = 0; index < bytes.getUint16(8, true); index++) {
            const cursor = 10 + index * 12
            tags[bytes.getUint16(cursor, true)] = bytes.getUint32(cursor + 8, true)
          }
          const pixel = tags[273] + (6 * 8 + 6) * 4
          tiff = { signature: bytes.getUint16(0, true), width: tags[256], height: tags[257], blue: [...new Uint8Array(bytes.buffer, pixel, 4)] }
        }
        outputs.push({ format, width: converted.width, height: converted.height, mime: converted.blob.type, size: converted.blob.size, previewMime: converted.previewBlob?.type, red: preview.pixel(4, 1), blue: preview.pixel(6, 6), transparent: preview.pixel(1, 6), tiff })
      }
      const convertedIcon = await convertImage(input, { ...imageDefaults, format: 'ico', rotation: 90, allowUpscale: true, iconSizes: [...standardIconSizes].reverse() })
      const iconBytes = new DataView(await convertedIcon.blob.arrayBuffer())
      const entries = []
      for (let index = 0; index < iconBytes.getUint16(4, true); index++) {
        const cursor = 6 + index * 16
        const size = iconBytes.getUint8(cursor) || 256
        const length = iconBytes.getUint32(cursor + 8, true)
        const offset = iconBytes.getUint32(cursor + 12, true)
        const decoded = await inspect(new Blob([iconBytes.buffer.slice(offset, offset + length)], { type: 'image/png' }))
        entries.push({ size, width: decoded.width, height: decoded.height, edge: decoded.pixel(0, Math.floor(size / 2)), red: decoded.pixel(Math.floor(size / 2), Math.max(1, Math.floor(size / 8))), blue: decoded.pixel(Math.floor(size * 0.65), Math.floor(size * 0.75)) })
      }
      const iconUrl = URL.createObjectURL(convertedIcon.blob)
      const iconImage = new Image()
      iconImage.src = iconUrl
      await iconImage.decode()
      const iconImageSize = { width: iconImage.naturalWidth, height: iconImage.naturalHeight }
      URL.revokeObjectURL(iconUrl)
      const preview = await inspect(convertedIcon.previewBlob)
      const noUpscale = await convertImage(input, { ...imageDefaults, format: 'ico', iconSizes: [64] })
      const noUpscalePreview = await inspect(noUpscale.previewBlob)
      const croppedIcon = await convertImage(input, { ...imageDefaults, format: 'ico', crop: { x: 0, y: 0, width: 16, height: 16 }, iconSizes: [16], transparent: false, background: '#00ff00' })
      const croppedIconPreview = await inspect(croppedIcon.previewBlob)
      let outsideCropRejected = false
      try { await convertImage(input, { ...imageDefaults, crop: { x: 30, y: 0, width: 4, height: 8 } }) } catch { outsideCropRejected = true }
      let avifRejected = false
      if (!supported.includes('avif')) {
        try { await convertImage(input, { ...imageDefaults, format: 'avif' }) } catch (error) { avifRejected = /AVIF/.test(error.message) }
      }
      return {
        supported, outputs, entries, iconImageSize, preview: { width: preview.width, height: preview.height }, iconSizes: convertedIcon.iconSizes,
        noUpscale: { edge: noUpscalePreview.pixel(1, 32), padding: noUpscalePreview.pixel(15, 32), inside: noUpscalePreview.pixel(17, 30) },
        croppedIcon: { width: croppedIconPreview.width, height: croppedIconPreview.height, pixel: croppedIconPreview.pixel(8, 8) }, outsideCropRejected, avifRejected,
      }
    })
    for (const output of result.outputs) {
      assert.equal(output.width, 8)
      assert.equal(output.height, 8)
      assert.equal(output.mime, `image/${output.format}`)
      assert.ok(output.size > 32)
      assert.ok(output.red[0] > 230 && output.red[1] < 25 && output.red[2] < 25, `${output.format} preserves cropped and rotated red pixels`)
      assert.ok(output.blue[2] > 230 && output.blue[0] < 25 && output.blue[1] < 25, `${output.format} preserves cropped and rotated blue pixels`)
      if (['jpeg', 'bmp'].includes(output.format)) assert.ok(output.transparent.every(value => value > 230))
      else assert.equal(output.transparent[3], 0)
      if (output.format === 'tiff') {
        assert.equal(output.previewMime, 'image/png')
        assert.deepEqual(output.tiff, { signature: 0x4949, width: 8, height: 8, blue: [0, 0, 255, 255] })
      }
    }
    assert.deepEqual(result.iconSizes, [16, 32, 48, 64, 128, 256])
    assert.equal(result.entries.length, 6)
    for (const entry of result.entries) {
      assert.equal(entry.width, entry.size)
      assert.equal(entry.height, entry.size)
      assert.equal(entry.edge[3], 0, `ICO ${entry.size} maintains aspect ratio with transparent padding`)
      assert.deepEqual(entry.red, [255, 0, 0, 255])
      assert.deepEqual(entry.blue, [0, 0, 255, 255])
    }
    assert.deepEqual(result.iconImageSize, { width: 256, height: 256 })
    assert.deepEqual(result.preview, { width: 256, height: 256 })
    assert.equal(result.noUpscale.edge[3], 0)
    assert.equal(result.noUpscale.padding[3], 0)
    assert.deepEqual(result.noUpscale.inside, [255, 0, 0, 255])
    assert.deepEqual(result.croppedIcon, { width: 16, height: 16, pixel: [255, 0, 0, 255] })
    assert.equal(result.outsideCropRejected, true)
    if (!result.supported.includes('avif')) assert.equal(result.avifRejected, true, 'unsupported encoders never return PNG renamed as AVIF')
    for (const format of ['png', 'jpeg', 'webp', 'bmp', 'gif', 'tiff', 'ico']) assert.ok(result.supported.includes(format))
    console.log('PASS real image encoding with crop and rotation, GIF transparency, TIFF pixels and preview, six-size ICO aspect ratio and alpha, no upscaling, and AVIF capability detection')
  } finally {
    await browser.close()
    await server.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
