const assert = require('node:assert/strict')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { chromium } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ configFile: 'vite.config.ts', server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false } })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}`
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    const result = await page.evaluate(async () => {
      const { createChromaKey } = await import('/src/core/chroma-key.ts')
      const { ClipFilterRenderer } = await import('/src/core/filter-renderer.ts')
      const { DEFAULT_CLIP_FILTERS } = await import('/src/core/clip-filters.ts')
      const key = createChromaKey(), filters = { ...DEFAULT_CLIP_FILTERS, saturation: 0 }
      const read = canvas => {
        const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height
        const context = copy.getContext('2d', { willReadFrequently: true }); context.drawImage(canvas, 0, 0)
        return [...context.getImageData(0, 0, canvas.width, canvas.height).data]
      }
      const source = document.createElement('canvas'); source.width = 4; source.height = 2
      source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray([
        0, 255, 0, 255, 0, 255, 0, 128, 255, 0, 0, 128, 0, 0, 255, 255,
        90, 255, 0, 255, 90, 255, 0, 128, 200, 120, 50, 64, 0, 0, 0, 0,
      ]), 4, 2), 0, 0)
      const gpu = new ClipFilterRenderer(), cpu = new ClipFilterRenderer({ preferCpu: true })
      const gpuPixels = read(gpu.render(source, 4, 2, 4, 2, filters, key)), backend = gpu.backend
      const cpuPixels = read(cpu.render(source, 4, 2, 4, 2, filters, key))
      const keyedOnly = read(gpu.render(source, 4, 2, 4, 2, undefined, key))
      const disabled = read(cpu.render(source, 4, 2, 4, 2, undefined, { ...key, enabled: false }))
      const spillCases = ['#00ff00', '#0000ff'].map(color => {
        const sample = document.createElement('canvas'); sample.width = 4; sample.height = 2
        const colors = [85, 173, 35, 255, 103, 191, 53, 128, 55, 190, 29, 255, 200, 120, 50, 64, 255, 255, 255, 255, 200, 40, 30, 255, 0, 255, 0, 255, 0, 0, 0, 0]
        if (color === '#0000ff') for (let i = 0; i < colors.length; i += 4) [colors[i + 1], colors[i + 2]] = [colors[i + 2], colors[i + 1]]
        sample.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(colors), 4, 2), 0, 0)
        const settings = { ...key, color, spillSuppression: true }
        const baseline = read(cpu.render(sample, 4, 2, 4, 2, undefined, { ...settings, spillSuppression: false }))
        const cpuPixels = read(cpu.render(sample, 4, 2, 4, 2, undefined, settings))
        const gpuPixels = read(gpu.render(sample, 4, 2, 4, 2, undefined, settings))
        const restored = read(gpu.render(sample, 4, 2, 4, 2, undefined, { ...settings, spillSuppression: false }))
        return { color, baseline, cpuPixels, gpuPixels, restored }
      })
      const glCanvas = gpu.render(source, 4, 2, 4, 2, filters, key)
      const extension = glCanvas.getContext('webgl').getExtension('WEBGL_lose_context')
      const lost = new Promise(resolve => glCanvas.addEventListener('webglcontextlost', resolve, { once: true }))
      extension.loseContext(); await lost
      const recovered = read(gpu.render(source, 4, 2, 4, 2, filters, key)), recoveryBackend = gpu.backend
      gpu.dispose(); cpu.dispose()

      // A real encoded moving image is used as the source, then exported and decoded again.
      const animated = document.createElement('canvas'); animated.width = animated.height = 128
      const drawing = animated.getContext('2d')
      let step = 0
      const paint = () => {
        drawing.fillStyle = '#00ff00'; drawing.fillRect(0, 0, 128, 128)
        drawing.fillStyle = '#ff0000'; drawing.fillRect(32, 32, 64, 64)
        drawing.fillStyle = '#ffffff'; drawing.fillRect(48 + (++step % 24), 76, 8, 8)
      }
      paint()
      const stream = animated.captureStream(20), chunks = []
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
      const stopped = new Promise(resolve => { recorder.onstop = resolve })
      recorder.ondataavailable = event => chunks.push(event.data)
      recorder.start(100)
      const timer = setInterval(paint, 50)
      await new Promise(resolve => setTimeout(resolve, 1400))
      recorder.stop(); await stopped; clearInterval(timer); stream.getTracks().forEach(track => track.stop())
      const sourceBlob = new Blob(chunks, { type: 'video/webm' })
      const { createProject, createClip } = await import('/src/core/project.ts')
      const { addAsset, addClip } = await import('/src/core/timeline.ts')
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
      const asset = { id: 'green-source', name: '动态绿幕素材.webm', kind: 'video', url: URL.createObjectURL(sourceBlob), duration: 1.3, width: 128, height: 128, size: sourceBlob.size, mime: sourceBlob.type }
      let project = addAsset(createProject('抠像视频导出验证', { width: 160, height: 128, fps: 20, background: '#0000ff' }), asset)
      const clip = createClip(asset, project, { start: 0.2, trimOut: 1, x: 32, y: 16, width: 96, height: 96, opacity: 0.5, filters, chromaKey: key })
      project = addClip(project, project.tracks.find(track => track.kind === 'video').id, clip)
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 128; document.body.append(canvas)
      const preview = new TimelinePreview(canvas, project, message => { throw new Error(message) })
      await preview.prepare(); await preview.seekReady(0)
      const pixel = (context, x, y) => [...context.getImageData(x, y, 1, 1).data]
      const beforeStart = pixel(canvas.getContext('2d'), 80, 64)
      await preview.seekReady(0.6)
      const previewPixels = [[40, 24], [80, 64], [4, 4]].map(([x, y]) => pixel(canvas.getContext('2d'), x, y))
      preview.dispose()
      const encoded = await exportTimelineWebM(project, { fps: 20, videoBitsPerSecond: 2_000_000 })
      const output = document.createElement('video'); output.muted = true; output.playsInline = true
      const loaded = new Promise((resolve, reject) => { output.onloadeddata = resolve; output.onerror = reject })
      output.src = URL.createObjectURL(encoded); await loaded
      const sought = new Promise(resolve => { output.onseeked = resolve }); output.currentTime = 0.6; await sought
      const decoded = document.createElement('canvas'); decoded.width = 160; decoded.height = 128
      const decodeContext = decoded.getContext('2d'); decodeContext.drawImage(output, 0, 0)
      const encodedPixels = [[40, 24], [80, 64], [4, 4]].map(([x, y]) => pixel(decodeContext, x, y))
      document.body.append(decoded)
      URL.revokeObjectURL(asset.url); URL.revokeObjectURL(output.src)
      return { gpuPixels, cpuPixels, keyedOnly, disabled, backend, recovered, recoveryBackend, spillCases, beforeStart, previewPixels, encodedPixels, encodedBytes: [...new Uint8Array(await encoded.arrayBuffer())] }
    })
    assert.equal(result.backend, 'webgl')
    assert.equal(result.recoveryBackend, 'cpu')
    for (let index = 0; index < result.gpuPixels.length; index++) assert(Math.abs(result.gpuPixels[index] - result.cpuPixels[index]) <= 5, `GPU/CPU channel ${index}: ${result.gpuPixels[index]} vs ${result.cpuPixels[index]}`)
    assert.deepEqual(result.recovered, result.cpuPixels)
    assert.equal(result.gpuPixels[3], 0); assert.equal(result.gpuPixels[7], 0)
    assert.equal(result.gpuPixels[11], 128); assert.equal(result.gpuPixels[15], 255)
    assert.equal(result.keyedOnly[3], 0); assert.equal(result.keyedOnly[8], 255)
    assert.equal(result.disabled[3], 255); assert.equal(result.disabled[7], 128)
    console.log('PASS GPU/CPU 抠像一致，先抠除再调色，保留原有 alpha；关闭和 GPU 丢失降级有效')
    for (const { color, baseline, cpuPixels, gpuPixels, restored } of result.spillCases) {
      const keyedChannel = color === '#00ff00' ? 1 : 2, otherChannels = [0, 1, 2].filter(channel => channel !== keyedChannel)
      let corrected = 0
      for (let index = 0; index < baseline.length; index += 4) {
        assert(Math.abs(cpuPixels[index + 3] - baseline[index + 3]) <= 1, `${color} 去溢色不得改变透明度`)
        for (let channel = 0; channel < 4; channel++) {
          assert(Math.abs(gpuPixels[index + channel] - cpuPixels[index + channel]) <= 5, `${color} 去溢色 GPU/CPU channel ${index + channel}`)
          assert(Math.abs(restored[index + channel] - baseline[index + channel]) <= 5, `${color} 关闭去溢色应恢复原抠像颜色`)
        }
        if (baseline[index + 3] < 50) continue
        for (const channel of otherChannels) assert(Math.abs(cpuPixels[index + channel] - baseline[index + channel]) <= 2, `${color} 去溢色须保留其余颜色通道`)
        const expected = Math.min(baseline[index + keyedChannel], Math.max(...otherChannels.map(channel => baseline[index + channel])))
        assert(Math.abs(cpuPixels[index + keyedChannel] - expected) <= 2, `${color} 应消除绿色或蓝色污染而不降低未污染颜色`)
        if (baseline[index + keyedChannel] - cpuPixels[index + keyedChannel] > 20) corrected++
      }
      assert(corrected >= 2, `${color} 必须实际修正不透明与半透明污染像素`)
    }
    console.log('PASS 绿色/蓝色去溢色在 GPU 与 CPU 一致，实际修正边缘颜色且保留 alpha，其余通道与关闭后的颜色不变')
    assert.deepEqual(result.beforeStart, [0, 0, 255, 255])
    for (const pixels of [result.previewPixels, result.encodedPixels]) {
      for (const point of [pixels[0], pixels[2]]) assert(point[0] < 8 && point[1] < 8 && point[2] > 245, `绿幕应透出蓝色底板：${point}`)
      assert(pixels[1][0] > 19 && pixels[1][0] < 34 && pixels[1][1] > 19 && pixels[1][1] < 34 && pixels[1][2] > 147 && pixels[1][2] < 164, `灰色前景半透明合成错误：${pixels[1]}`)
    }
    assert(result.encodedBytes.length > 1000)
    const directory = process.env.BROWSER_ARTIFACTS || '/tmp/open-media-chroma-key'
    mkdirSync(directory, { recursive: true })
    writeFileSync(`${directory}/keyed-timeline.webm`, Buffer.from(result.encodedBytes))
    await page.screenshot({ path: `${directory}/keyed-preview.png` })
    assert.deepEqual(errors, [])
    console.log('PASS 真实绿幕视频预览与编码导出一致，正确保留开始刻度、缩放位置、滤镜与不透明度')
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
