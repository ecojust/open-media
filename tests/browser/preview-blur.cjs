const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { chromium, webkit } = require('@playwright/test')

// Exercise actual decoded media and TimelinePreview while Canvas2D.filter is absent.
// The 1280×720 timing sample measures this browser process, not macOS application performance.
async function main() {
  const root = path.resolve(__dirname, '../..'), browserName = process.env.OPEN_MEDIA_BROWSER || 'chromium'
  const directory = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'preview-blur', browserName) : path.join(tmpdir(), 'open-media-preview-blur', browserName)
  fs.mkdirSync(directory, { recursive: true })
  const sources = {
    checker: "nullsrc=s=160x96:r=24:d=2,geq=lum='if(mod(floor(X/8)+floor(Y/8),2),235,16)':cb=128:cr=128",
    step: 'color=c=black:s=160x96:r=24:d=2,drawbox=x=80:y=0:w=80:h=96:color=white:t=fill',
    keyed: 'color=c=0x00ff00:s=160x96:r=24:d=2,drawbox=x=40:y=16:w=80:h=64:color=0xff0000:t=fill',
  }
  for (const [name, source] of Object.entries(sources)) {
    const filename = path.join(directory, `${name}.webm`)
    if (!fs.existsSync(filename)) execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-c:v', 'libvpx', '-threads', '1', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '500k', '-pix_fmt', 'yuv420p', filename])
  }
  const { createServer } = await import('vite')
  const cacheDir = fs.mkdtempSync(path.join(tmpdir(), 'open-media-preview-blur-vite-'))
  const server = await createServer({ root, cacheDir, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  let browser
  try {
    await server.listen()
    browser = await (browserName === 'webkit' ? webkit.launch({ headless: true }) : chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }))
    const page = await browser.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const prototype = CanvasRenderingContext2D.prototype
      window.originalCanvasFilterSupport = 'filter' in prototype
      delete prototype.filter
      window.forcedCanvasFilterUnsupported = !('filter' in document.createElement('canvas').getContext('2d'))
    })
    await page.route('**/__blur__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>模糊预览验证</title>' }))
    for (const name of Object.keys(sources)) await page.route(`**/blur-${name}.webm`, route => route.fulfill({ contentType: 'video/webm', body: fs.readFileSync(path.join(directory, `${name}.webm`)) }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__blur__`)
    const report = await page.evaluate(async () => {
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { CanvasBlurRenderer } = await import('/src/core/canvas-blur.ts')
      const { createProject, createClip, createTextClip, validateProject } = await import('/src/core/project.ts')
      const { addTransition } = await import('/src/core/transitions.ts')
      const { importMediaFile } = await import('/src/core/media-import.ts')
      const { createChromaKey } = await import('/src/core/chroma-key.ts')
      const assets = {}, images = {}, notices = []
      for (const name of ['checker', 'step', 'keyed']) {
        const blob = await (await fetch(`/blur-${name}.webm`)).blob()
        assets[name] = await importMediaFile(new File([blob], `${name}.webm`, { type: 'video/webm' }))
      }
      const canvas = (width = 160, height = 96) => { const value = document.createElement('canvas'); value.width = width; value.height = height; return value }
      const pixels = value => value.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, value.width, value.height).data
      const at = (data, x, y, width = 160) => [...data.slice((Math.floor(y) * width + Math.floor(x)) * 4, (Math.floor(y) * width + Math.floor(x)) * 4 + 4)]
      const keep = (name, value) => { images[name] = value.toDataURL('image/png') }
      const base = (asset, options = {}) => {
        const project = createProject('模糊预览验证', { width: 160, height: 96, fps: 24, background: '#000000', ...options })
        project.assets = [asset]
        project.tracks.find(track => track.kind === 'video').clips = [createClip(asset, project, { id: 'source', trimOut: 2, volume: 0 })]
        return project
      }
      const withBlur = (project, options = {}) => {
        const next = structuredClone(project)
        next.tracks.find(track => track.kind === 'text').clips = [createTextClip(next, { id: 'local-blur', textRole: 'watermark', text: '', trimOut: 2, x: 32, y: 24, width: 64, height: 48, overlay: { kind: 'blur', color: '#ffffff', strokeWidth: 1, blurRadius: 8 }, ...options })]
        return validateProject(next, { trusted: true })
      }
      const read = async (project, time, name, shared) => {
        const output = shared?.canvas || canvas(project.width, project.height), preview = shared?.preview || new TimelinePreview(output, project, message => notices.push(message))
        try { await preview.seekReady(time); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); preview.render(time); if (name) keep(name, output); return new Uint8ClampedArray(pixels(output)) } finally { if (!shared) preview.dispose() }
      }
      const contrast = (data, rect, width = 160) => {
        let sum = 0, count = 0
        for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width - 1; x++) { sum += Math.abs(data[(y * width + x) * 4] - data[(y * width + x + 1) * 4]); count++ }
        return sum / count
      }
      const difference = (original, changed, rect, width = 160) => {
        let inside = 0, outside = 0, sumX = 0, sumY = 0, maximumOutside = 0
        for (let i = 0; i < original.length; i += 4) {
          const x = i / 4 % width, y = Math.floor(i / 4 / width), delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(original[i + channel] - changed[i + channel])))
          const within = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
          if (!within) maximumOutside = Math.max(maximumOutside, delta)
          if (delta <= 3) continue
          if (within) { inside++; sumX += x; sumY += y } else outside++
        }
        return { inside, outside, maximumOutside, x: inside ? sumX / inside : null, y: inside ? sumY / inside : null }
      }

      const checker = base(assets.checker), rect = { x: 32, y: 24, width: 64, height: 48 }, inner = { x: 40, y: 32, width: 48, height: 32 }
      const sharp = await read(checker, .5, 'local-sharp'), blurred = await read(withBlur(checker), .5, 'local-blurred'), half = await read(withBlur(checker, { opacity: .5 }), .5, 'local-half-opacity')
      let halfOpacityError = 0
      for (let i = 0; i < sharp.length; i += 4) for (let c = 0; c < 3; c++) halfOpacityError = Math.max(halfOpacityError, Math.abs(half[i + c] - (sharp[i + c] + blurred[i + c]) / 2))
      const moving = withBlur(checker, { x: 24, keyframes: { x: [{ time: 0, value: 24 }, { time: 1, value: 88 }] } })
      const movingCanvas = canvas(), movingPreview = new TimelinePreview(movingCanvas, moving, message => notices.push(message)), shared = { canvas: movingCanvas, preview: movingPreview }
      let left, right
      try { left = await read(moving, .25, 'local-position-left', shared); right = await read(moving, .75, 'local-position-right', shared) } finally { movingPreview.dispose() }
      const leftDifference = difference(sharp, left, { ...rect, x: 40 }), rightDifference = difference(sharp, right, { ...rect, x: 72 })
      let vacatedError = 0
      for (let y = 24; y < 72; y++) for (let x = 40; x < 72; x++) vacatedError = Math.max(vacatedError, Math.abs(at(sharp, x, y)[0] - at(right, x, y)[0]))
      const local = { sharpContrast: contrast(sharp, inner), blurredContrast: contrast(blurred, inner), difference: difference(sharp, blurred, rect), halfOpacityError, leftDifference, rightDifference, displacement: rightDifference.x - leftDifference.x, vacatedError }

      const split = (asset, options = {}, projectOptions = {}) => {
        const project = base(asset, projectOptions), track = project.tracks.find(track => track.kind === 'video')
        track.clips = [createClip(asset, project, { id: 'before', trimOut: 1, volume: 0, ...options }), createClip(asset, project, { id: 'after', start: 1, trimIn: 1, trimOut: 2, volume: 0, ...options })]
        return project
      }
      const transitions = {}
      for (const effect of ['defocus', 'zoom-through']) {
        const project = split(assets.step), softProject = addTransition(project, 1, effect, 1, undefined, { blur: 16, easing: 'linear' }), clearProject = addTransition(project, 1, effect, 1, undefined, { blur: 0, easing: 'linear' })
        const output = canvas(), preview = new TimelinePreview(output, softProject, message => notices.push(message)), targets = [.68, .76, .84, 1.16, 1.24, 1.32, 1.52], samples = []
        try {
          await preview.playReady(.6)
          const started = performance.now()
          await new Promise(resolve => {
            function tick() {
              const time = Math.min(1.56, .6 + (performance.now() - started) / 1000)
              preview.render(time, true)
              while (targets.length && time >= targets[0]) { const target = targets.shift(); samples.push({ target, time, pixels: new Uint8ClampedArray(pixels(output)) }); keep(`${effect}-live-${target}`, output) }
              if (time >= 1.56) { preview.pause(); resolve() } else requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          })
        } finally { preview.dispose() }
        transitions[effect] = []
        for (const sample of samples) {
          const reference = await read(clearProject, sample.time)
          transitions[effect].push({ time: sample.time, target: sample.target, clear: [76, 84, 32, 128].map(x => at(reference, x, 48)), blurred: [76, 84, 32, 128].map(x => at(sample.pixels, x, 48)) })
        }
      }

      const keyed = split(assets.keyed, { x: 16, y: 8, width: 128, height: 80, opacity: .6, fit: 'fill', chromaKey: createChromaKey() }, { background: '#0000ff' })
      const colorProject = addTransition(keyed, 1, 'defocus', 1, undefined, { blur: 8, easing: 'linear' })
      const alphaPixels = await read(colorProject, .75, 'transition-color-alpha')
      const alpha = { center: at(alphaPixels, 80, 48), feather: [43, 44, 45, 115, 116, 117].map(x => ({ x, pixel: at(alphaPixels, x, 48) })), outside: [[4, 48], [156, 48], [80, 2], [80, 94]].map(([x, y]) => at(alphaPixels, x, y)) }

      // Decode a real RGBA PNG before the lower-level premultiplied-alpha check.
      const rgba = canvas(96, 64), rgbaContext = rgba.getContext('2d')
      rgbaContext.fillStyle = 'rgba(255,0,0,.5)'; rgbaContext.fillRect(32, 16, 32, 32)
      const png = await new Promise(resolve => rgba.toBlob(resolve, 'image/png')), pngUrl = URL.createObjectURL(png), decoded = new Image()
      decoded.src = pngUrl; await decoded.decode(); rgbaContext.clearRect(0, 0, 96, 64); rgbaContext.drawImage(decoded, 0, 0)
      const blurRenderer = new CanvasBlurRenderer(), softened = blurRenderer.render(rgba, 8), restored = canvas(96, 64)
      restored.getContext('2d').drawImage(softened, 0, 0, softened.width, softened.height, 0, 0, 96, 64)
      const rgbaData = pixels(restored); let alphaSum = 0, weightedX = 0, weightedY = 0, featherCount = 0, minimumFeatherRed = 255, maximumFeatherOther = 0
      for (let i = 0; i < rgbaData.length; i += 4) { const a = rgbaData[i + 3]; alphaSum += a; weightedX += (i / 4 % 96) * a; weightedY += Math.floor(i / 4 / 96) * a; if (a > 8 && a < 100) { featherCount++; minimumFeatherRed = Math.min(minimumFeatherRed, rgbaData[i]); maximumFeatherOther = Math.max(maximumFeatherOther, rgbaData[i + 1], rgbaData[i + 2]) } }
      const rgbaResult = { center: at(rgbaData, 48, 32, 96), feather: at(rgbaData, 28, 32, 96), alphaMassRatio: alphaSum / (32 * 32 * 128), centroid: { x: weightedX / alphaSum, y: weightedY / alphaSum }, featherCount, minimumFeatherRed, maximumFeatherOther, buffer: { width: softened.width, height: softened.height } }
      keep('rgba-alpha-blur', restored); blurRenderer.dispose(); URL.revokeObjectURL(pngUrl)

      const performanceProject = withBlur(base(assets.checker, { width: 1280, height: 720 }), { x: 280, y: 140, width: 720, height: 440, overlay: { kind: 'blur', color: '#ffffff', strokeWidth: 1, blurRadius: 16 } })
      const largeCanvas = canvas(1280, 720), largePreview = new TimelinePreview(largeCanvas, performanceProject, message => notices.push(message)), timings = [], gaps = [], buffers = [], outputIds = new WeakMap()
      const originalRender = CanvasBlurRenderer.prototype.render; let nextOutputId = 0
      CanvasBlurRenderer.prototype.render = function (source, radius) { const started = performance.now(), output = originalRender.call(this, source, radius); if (!outputIds.has(output)) outputIds.set(output, ++nextOutputId); buffers.push({ source: [source.width, source.height], output: [output.width, output.height], radius, milliseconds: performance.now() - started, id: outputIds.get(output) }); return output }
      let timer, heartbeatCount = 0, maximumHeartbeatGap = 0, lastHeartbeat = performance.now()
      try {
        await largePreview.playReady(.2)
        const started = performance.now(); lastHeartbeat = started; let previous = started
        timer = setInterval(() => { const now = performance.now(); maximumHeartbeatGap = Math.max(maximumHeartbeatGap, now - lastHeartbeat); lastHeartbeat = now; heartbeatCount++ }, 25)
        await new Promise(resolve => {
          function tick() { const now = performance.now(), elapsed = (now - started) / 1000; gaps.push(now - previous); previous = now; const before = performance.now(); largePreview.render(.2 + elapsed, true); timings.push(performance.now() - before); if (elapsed >= .8) resolve(); else requestAnimationFrame(tick) }
          requestAnimationFrame(tick)
        })
        largePreview.pause(); keep('large-live-blur', largeCanvas)
      } finally { clearInterval(timer); largePreview.dispose(); CanvasBlurRenderer.prototype.render = originalRender }
      const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]
      const performanceSample = { environment: navigator.userAgent, canvas: [1280, 720], sourceVideo: [160, 96], frames: timings.length, frameMilliseconds: { median: quantile(timings, .5), p95: quantile(timings, .95), max: Math.max(...timings) }, rafGapMilliseconds: { p95: quantile(gaps, .95), max: Math.max(...gaps) }, heartbeats: heartbeatCount, maximumHeartbeatGap, blurCalls: buffers.length, blurMilliseconds: { median: quantile(buffers.map(item => item.milliseconds), .5), p95: quantile(buffers.map(item => item.milliseconds), .95), max: Math.max(...buffers.map(item => item.milliseconds)) }, buffers: [...new Map(buffers.map(({ milliseconds, ...item }) => [JSON.stringify(item), item])).values()], uniqueOutputCanvases: nextOutputId }
      for (const asset of Object.values(assets)) URL.revokeObjectURL(asset.url)
      return { originalCanvasFilterSupport: window.originalCanvasFilterSupport, forcedCanvasFilterUnsupported: window.forcedCanvasFilterUnsupported, local, transitions, alpha, rgba: rgbaResult, performance: performanceSample, notices, images }
    })
    for (const [name, data] of Object.entries(report.images)) fs.writeFileSync(path.join(directory, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'))
    delete report.images; report.errors = errors
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    assert.equal(report.forcedCanvasFilterUnsupported, true, '必须实际禁用 Canvas2D.filter 才能验证兼容路径')
    assert.equal(errors.length, 0, `脚本异常：${errors.join('; ')}`)
    assert.deepEqual(report.notices, [], '真实素材应成功解码和绘制')
    assert(report.local.blurredContrast < report.local.sharpContrast * .35, '兼容路径必须降低局部棋盘对比度，不能静默跳过模糊')
    assert(report.local.difference.inside > 2000 && report.local.difference.maximumOutside <= 2, '只应模糊指定区域，框外保持真实源画面')
    assert(report.local.halfOpacityError <= 3, '局部模糊片段透明度只能施加一次')
    assert(Math.abs(report.local.displacement - 32) < 1, '动画位移必须移动模糊区域而非错位背景')
    assert(report.local.leftDifference.maximumOutside <= 2 && report.local.rightDifference.maximumOutside <= 2 && report.local.vacatedError <= 2, '移动后应恢复旧位置且保持裁剪边界')
    for (const [effect, samples] of Object.entries(report.transitions)) {
      assert.equal(samples.length, 7, `${effect} 必须覆盖切点两侧的连续播放`)
      for (const sample of samples) {
        if (sample.target > 1.5) { assert(sample.blurred.every((pixel, index) => pixel.every((value, channel) => Math.abs(value - sample.clear[index][channel]) <= 2)), `${effect} 转场结束后应恢复清晰画面`); continue }
        assert(sample.blurred[0][0] > sample.clear[0][0] + 5 && sample.blurred[1][0] < sample.clear[1][0] - 5, `${effect} ${sample.time} 必须真正柔化边界，而非仅淡出：${JSON.stringify(sample)}`)
        assert([2, 3].every(index => Math.abs(sample.blurred[index][0] - sample.clear[index][0]) < 8), `${effect} 远离边界的颜色与透明度应保持一致`)
      }
    }
    assert(Math.abs(report.alpha.center[0] - 76) < 8 && report.alpha.center[1] < 5 && Math.abs(report.alpha.center[2] - 179) < 8, `转场和片段透明度应正确组合：${report.alpha.center}`)
    assert(report.alpha.feather.some(({ pixel }) => pixel[0] > 3 && pixel[0] < 50), '透明红色边缘必须产生真实羽化')
    for (const { pixel } of report.alpha.feather) assert(pixel[1] < 5 && Math.abs(pixel[0] + pixel[2] - 255) < 8, `透明边缘不能引入黑边或绿色：${pixel}`)
    assert(report.alpha.outside.every(pixel => pixel[0] < 2 && pixel[1] < 2 && pixel[2] > 253), '带位移的转场不能污染片段外侧')
    assert(report.rgba.featherCount > 100 && report.rgba.minimumFeatherRed > 245 && report.rgba.maximumFeatherOther < 5, '半透明PNG的模糊必须保留原色，不能把透明黑混入RGB')
    assert(report.rgba.center[3] > 105 && report.rgba.center[3] < 135 && report.rgba.feather[3] > 5 && report.rgba.feather[3] < 100, '半透明中心及羽边必须保留正确alpha')
    assert(report.rgba.alphaMassRatio > .85 && report.rgba.alphaMassRatio < 1.12 && Math.abs(report.rgba.centroid.x - 47.5) < 2 && Math.abs(report.rgba.centroid.y - 31.5) < 2, '模糊不得偏移图像或明显重复叠加透明度')
    assert(report.performance.buffers.length > 0 && report.performance.uniqueOutputCanvases <= 2, '连续模糊应复用缓冲画布')
    console.log(JSON.stringify({ local: report.local, alpha: report.alpha, rgba: report.rgba, performance: report.performance, directory }))
    console.log(`PASS 无Canvas滤镜时的真实局部模糊、位移、透明边界及连续模糊转场；报告 ${directory}`)
  } finally { await browser?.close(); await server.close(); fs.rmSync(cacheDir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
