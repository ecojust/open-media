const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  const address = server.httpServer.address()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] })
  try {
    const page = await browser.newPage()
    await page.route('**/__conversion_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>转换验证</title></head><body>转换验证</body></html>' }))
    await page.goto(`http://127.0.0.1:${address.port}/__conversion_test__`)
    const images = await page.evaluate(async () => {
      const { convertImage, imageDefaults } = await import('/src/core/image-convert.ts')
      const source = document.createElement('canvas')
      source.width = 16
      source.height = 8
      const context = source.getContext('2d')
      context.fillStyle = '#ff0000'
      context.fillRect(0, 0, 8, 8)
      const input = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
      const result = []
      for (const format of ['png', 'jpeg', 'webp', 'bmp']) {
        const converted = await convertImage(input, { ...imageDefaults, format, quality: 1, width: 8, rotation: 90, background: '#ffffff' })
        const bitmap = await createImageBitmap(converted.blob)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        result.push({ format, mime: converted.blob.type, bytes: converted.blob.size, width: bitmap.width, height: bitmap.height, top: [...ctx.getImageData(2, 1, 1, 1).data], bottom: [...ctx.getImageData(2, 6, 1, 1).data] })
        bitmap.close()
      }
      const flipped = await convertImage(input, { ...imageDefaults, flipX: true })
      const bitmap = await createImageBitmap(flipped.blob)
      const check = document.createElement('canvas')
      check.width = 16
      check.height = 8
      const ctx = check.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      const flip = { left: [...ctx.getImageData(1, 4, 1, 1).data], right: [...ctx.getImageData(14, 4, 1, 1).data] }
      bitmap.close()
      const cancel = new AbortController()
      cancel.abort()
      let cancelled = false
      try { await convertImage(input, imageDefaults, cancel.signal) } catch (error) { cancelled = error.name === 'AbortError' }
      return { result, flip, cancelled }
    })
    for (const result of images.result) {
      assert.equal(result.width, 4)
      assert.equal(result.height, 8)
      assert.equal(result.mime, `image/${result.format}`)
      assert.ok(result.bytes > 32)
      assert.ok(result.top[0] > 230 && result.top[1] < 25 && result.top[2] < 25, `${result.format} rotated red pixels are preserved`)
      if (['jpeg', 'bmp'].includes(result.format)) assert.ok(result.bottom.slice(0, 3).every(value => value > 230) && result.bottom[3] === 255, `${result.format} flattens alpha to the selected background`)
      else assert.equal(result.bottom[3], 0)
    }
    assert.equal(images.flip.left[3], 0)
    assert.deepEqual(images.flip.right, [255, 0, 0, 255])
    assert.equal(images.cancelled, true)
    console.log('PASS actual PNG, JPEG, WebP, BMP encoding, resize, rotation, flip, transparency and cancellation')

    const video = await page.evaluate(async () => {
      const { importMediaFile } = await import('/src/core/media-import.ts')
      const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
      const { createProject, createTrack, createClip } = await import('/src/core/project.ts')
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 90
      const context = canvas.getContext('2d')
      const stream = canvas.captureStream(15)
      const audio = new AudioContext()
      await audio.resume()
      const destination = audio.createMediaStreamDestination()
      const oscillator = audio.createOscillator()
      oscillator.connect(destination)
      oscillator.start()
      destination.stream.getAudioTracks().forEach(track => stream.addTrack(track))
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' })
      const chunks = []
      recorder.ondataavailable = event => chunks.push(event.data)
      const finished = new Promise(resolve => { recorder.onstop = resolve })
      recorder.start(100)
      for (let index = 0; index < 20; index++) {
        context.fillStyle = '#ff4000'
        context.fillRect(0, 0, 160, 90)
        context.fillStyle = '#0066ff'
        context.fillRect(index * 5, 15, 24, 30)
        await new Promise(resolve => setTimeout(resolve, 70))
      }
      recorder.stop()
      await finished
      stream.getTracks().forEach(track => track.stop())
      oscillator.stop()
      await audio.close()
      const input = new File(chunks, '录制片段.webm', { type: 'video/webm' })
      const asset = await importMediaFile(input)
      const project = createProject('转换验证', { width: 80, height: 44, fps: 15, background: '#000000' })
      project.assets = [asset]
      const track = createTrack('video')
      track.clips = [createClip(asset, project, { trimIn: 0.15, trimOut: 1.15 })]
      project.tracks = [track]
      const updates = []
      const blob = await exportTimelineWebM(project, { width: 80, height: 44, fps: 15, onProgress: value => updates.push(value) })
      const converted = await importMediaFile(new File([blob], '转换结果.webm', { type: 'video/webm' }))
      const player = document.createElement('video')
      player.src = converted.url
      player.muted = true
      await new Promise((resolve, reject) => { player.onloadeddata = resolve; player.onerror = reject })
      await new Promise(resolve => { player.onseeked = resolve; player.currentTime = 0.35 })
      const image = document.createElement('canvas')
      image.width = 80
      image.height = 44
      const ctx = image.getContext('2d')
      ctx.drawImage(player, 0, 0, 80, 44)
      const pixel = [...ctx.getImageData(60, 32, 1, 1).data]
      const audioCheck = new AudioContext()
      const audioBuffer = await audioCheck.decodeAudioData(await blob.arrayBuffer())
      const samples = audioBuffer.getChannelData(0)
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
      await audioCheck.close()
      URL.revokeObjectURL(asset.url)
      URL.revokeObjectURL(converted.url)
      return { sourceDuration: asset.duration, duration: converted.duration, width: converted.width, height: converted.height, size: blob.size, mime: blob.type, progress: updates.at(-1), updates: updates.length, pixel, rms }
    })
    assert.ok(video.sourceDuration > 1.2)
    assert.ok(video.duration >= 0.8 && video.duration <= 1.3, `trim duration ${video.duration}`)
    assert.equal(video.width, 80)
    assert.equal(video.height, 44)
    assert.equal(video.mime, 'video/webm')
    assert.ok(video.size > 1000)
    assert.equal(video.progress, 1)
    assert.ok(video.updates > 5)
    assert.ok(video.rms > 0.05, 'output retains an audible source audio track')
    assert.ok(video.pixel[0] > 180 && video.pixel[1] < 120 && video.pixel[2] < 80, `output preserves actual source video frames: ${JSON.stringify(video)}`)
    console.log('PASS actual source probing and WebM trim, resize, frame encoding, audio muxing and progress')

    await page.evaluate(async () => {
      const { mountConversionTest } = await import('/tests/browser/conversion-harness.ts')
      await mountConversionTest()
    })
    await page.getByTestId('convert-format').selectOption('jpeg')
    await page.getByTestId('convert-width').fill('80')
    await page.getByLabel('图片旋转').selectOption('90')
    await page.getByTestId('convert-start').click()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="convert-result"]')].filter(item => item.classList.contains('done')).length === 2).catch(async error => { throw new Error(`${error.message}\n${await page.locator('body').innerText()}`) })
    assert.equal(await page.locator('.source-selection').innerText(), '已选 2 项', 'converted results are not silently added to the next conversion selection')
    const dimensions = await page.getByTestId('convert-image-preview').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }))
    assert.deepEqual(dimensions, { width: 45, height: 80 })
    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('convert-download-all').click()
    const download = await downloadPromise
    const { unzipSync } = require('fflate')
    const archive = unzipSync(fs.readFileSync(await download.path()))
    assert.deepEqual(Object.keys(archive).sort(), ['示例图 (2).jpg', '示例图.jpg'])
    for (const bytes of Object.values(archive)) assert.deepEqual([...bytes.subarray(0, 2)], [255, 216])
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'conversion workspace fits a narrow viewport')
    console.log('PASS conversion workspace batch controls, real JPEG downloads, unique ZIP entries and narrow layout')

    await page.evaluate(async () => {
      const { importMediaFile } = await import('/src/core/media-import.ts')
      const canvas = document.createElement('canvas')
      canvas.width = 96; canvas.height = 48
      const context = canvas.getContext('2d')
      context.fillStyle = '#206ad8'; context.fillRect(0, 0, 96, 48)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      const screenshot = await importMediaFile(new File([blob], '截屏.png', { type: 'image/png' }))
      window.conversionHarness.screenshot = screenshot
      window.conversionHarness.focusAssetId.value = screenshot.id
    })
    assert.equal(await page.locator('.source-selection').innerText(), '已选 2 项', 'a pending screenshot focus must wait for its image to arrive')
    await page.evaluate(() => window.conversionHarness.assets.value.push(window.conversionHarness.screenshot))
    await page.waitForFunction(() => document.querySelector('.source-selection').textContent === '已选 1 项')
    await page.getByTestId('convert-image-preview').evaluate(image => image.decode())
    const focused = await page.getByTestId('convert-image-preview').evaluate(image => ({ name: image.alt, width: image.naturalWidth, height: image.naturalHeight }))
    assert.deepEqual(focused, { name: '截屏.png', width: 96, height: 48 }, 'screenshot focus opens the original image instead of the previous conversion result')
    assert.equal(await page.getByLabel('选择 截屏.png', { exact: true }).isChecked(), true)
    assert.equal(await page.locator('.convert-source input:checked').count(), 1, 'only the screenshot is selected for conversion')
    await page.getByLabel('选择 示例图.png', { exact: true }).first().check()
    await page.evaluate(() => { window.conversionHarness.assets.value = [...window.conversionHarness.assets.value] })
    assert.equal(await page.locator('.source-selection').innerText(), '已选 2 项', 'later asset updates must preserve manual selection instead of reapplying a consumed focus request')
    console.log('PASS screenshot focus waits for import, selects only the screenshot, opens original pixels and preserves subsequent manual selection')

    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob
      HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
        HTMLCanvasElement.prototype.toBlob = original
        original.call(this, blob => { window.conversionHarness.finishEncoding = () => callback(blob) }, ...args)
      }
    })
    await page.getByTestId('convert-start').click()
    await page.waitForFunction(() => typeof window.conversionHarness.finishEncoding === 'function')
    await page.evaluate(() => {
      const nextScreenshot = { ...window.conversionHarness.screenshot, id: 'next-screenshot', name: '下一张截屏.png' }
      window.conversionHarness.focusAssetId.value = nextScreenshot.id
      window.conversionHarness.assets.value.push(nextScreenshot)
    })
    assert.equal(await page.locator('.source-selection').innerText(), '已选 2 项', 'a screenshot arriving during conversion must not alter the active batch selection')
    assert.equal(await page.getByLabel('选择 下一张截屏.png', { exact: true }).isChecked(), false)
    await page.evaluate(() => window.conversionHarness.finishEncoding())
    await page.waitForFunction(() => document.querySelector('.source-selection').textContent === '已选 1 项')
    assert.equal(await page.getByLabel('选择 下一张截屏.png', { exact: true }).isChecked(), true)
    await page.getByTestId('convert-image-preview').evaluate(image => image.decode())
    assert.equal(await page.getByTestId('convert-image-preview').getAttribute('alt'), '下一张截屏.png')
    assert.equal(await page.locator('[data-testid="convert-result"].done').count(), 4, 'the in-progress batch completes before applying the deferred screenshot focus')
    console.log('PASS screenshot focus is deferred during a real conversion batch and applied after completion')
  } finally {
    await browser.close()
    await server.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
