const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')
const { existsSync } = require('node:fs')
const fs = require('node:fs/promises')
const net = require('node:net')
const path = require('node:path')

let server
async function startDevServer() {
  if (process.env.FILTER_TEST_URL) return process.env.FILTER_TEST_URL
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'pipe' })
  let output = ''
  server.stdout.on('data', data => { output += data })
  server.stderr.on('data', data => { output += data })
  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(url)).ok) return url } catch {}
    if (server.exitCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`滤镜测试开发服务未就绪：${output}`)
}

async function clipState(page, id = 'filter-video') {
  return page.evaluate(id => window.filterState.value.tracks.flatMap(track => track.clips).find(clip => clip.id === id), id)
}
async function previewPixel(page, x = 20, y = 20) {
  return page.getByTestId('video-preview').evaluate((canvas, point) => [...canvas.getContext('2d').getImageData(...point, 1, 1).data], [x, y])
}
function isGray(pixel) { return Math.max(...pixel.slice(0, 3)) - Math.min(...pixel.slice(0, 3)) <= 3 }
function assertPixelClose(actual, expected, tolerance, message) {
  assert(actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance), `${message}：${actual} / ${expected}`)
}
async function setRange(page, name, fraction) {
  await page.getByRole('slider', { name, exact: true }).evaluate((input, fraction) => {
    input.value = String(Number(input.min) + (Number(input.max) - Number(input.min)) * fraction)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, fraction)
}

async function installEditor(page, baseURL) {
  await page.route('**/filter-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${baseURL}/filter-test`)
  await page.evaluate(async () => {
    const { createProject, createClip, createTextClip, createTrack, validateProject } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
    const toBlob = canvas => new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const source = document.createElement('canvas'); source.width = 320; source.height = 180
    const context = source.getContext('2d')
    const paint = () => {
      context.fillStyle = '#cc2233'; context.fillRect(0, 0, 160, 90)
      context.fillStyle = '#15aa32'; context.fillRect(0, 90, 160, 90)
      context.fillStyle = '#1e46dc'; context.fillRect(160, 0, 160, 180)
    }
    paint()
    const stream = source.captureStream(20), chunks = []
    const recording = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
    recording.ondataavailable = event => chunks.push(event.data)
    const stopped = new Promise(resolve => { recording.onstop = resolve })
    recording.start(100)
    const painting = setInterval(paint, 50)
    await new Promise(resolve => setTimeout(resolve, 1700))
    recording.stop(); await stopped; clearInterval(painting)
    stream.getTracks().forEach(track => track.stop())
    const videoBlob = new Blob(chunks, { type: 'video/webm' })
    const image = document.createElement('canvas'); image.width = 64; image.height = 64
    image.getContext('2d').fillStyle = 'rgba(0,255,50,0.5)'; image.getContext('2d').fillRect(0, 0, 32, 64)
    const imageBlob = await toBlob(image)
    const wav = new ArrayBuffer(44 + 44100 * 2 * 2), header = new DataView(wav)
    const tag = (offset, text) => [...text].forEach((character, index) => header.setUint8(offset + index, character.charCodeAt(0)))
    tag(0, 'RIFF'); header.setUint32(4, wav.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ')
    header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true)
    header.setUint32(24, 44100, true); header.setUint32(28, 88200, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true)
    tag(36, 'data'); header.setUint32(40, wav.byteLength - 44, true)
    const audioBlob = new Blob([wav], { type: 'audio/wav' })
    const video = { id: 'video-source', kind: 'video', name: '滤镜测试视频.webm', url: URL.createObjectURL(videoBlob), duration: 1.6, width: 320, height: 180, size: videoBlob.size, mime: videoBlob.type }
    const picture = { id: 'image-source', kind: 'image', name: '透明图层.png', url: URL.createObjectURL(imageBlob), duration: 0, width: 64, height: 64, size: imageBlob.size, mime: imageBlob.type }
    const audio = { id: 'audio-source', kind: 'audio', name: '音频轨道.wav', url: URL.createObjectURL(audioBlob), duration: 2, width: 0, height: 0, size: audioBlob.size, mime: audioBlob.type }
    let project = createProject('片段滤镜验证', { width: 320, height: 180, fps: 20 })
    const imageTrack = createTrack('video', '透明图片轨道')
    project.tracks[0].clips = [createTextClip(project, { id: 'filter-text', text: '', name: '原色字幕底板', x: 0, y: 132, width: 100, height: 40, background: '#2244dd', trimOut: 1.5 })]
    project.tracks[1].clips = [createClip(video, project, { id: 'filter-video', trimOut: 1.5 })]
    imageTrack.clips = [createClip(picture, project, { id: 'filter-image', x: 200, y: 20, width: 64, height: 64, trimOut: 1.5 })]
    project.tracks[2].clips = [createClip(audio, project, { id: 'filter-audio', trimOut: 1.5 })]
    project.tracks.splice(1, 0, imageTrack)
    project.assets = [video, picture, audio]
    project = validateProject(project, { trusted: true })
    window.filterBlobs = new Map([[video.id, videoBlob], [picture.id, imageBlob], [audio.id, audioBlob]])
    const componentSource = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueImport = componentSource.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref } = await import(vueImport)
    const VideoEditor = (await import('/src/components/VideoEditor.vue')).default
    const state = shallowRef(project), editor = ref(null)
    let history = createHistory(project)
    window.filterState = state
    window.filterEditor = editor
    window.filterStatus = ''
    window.filterMoveHistory = direction => {
      history = direction === 'undo' ? undoHistory(history) : redoHistory(history)
      state.value = history.present
    }
    window.filterReset = () => { state.value = project; history = createHistory(project) }
    window.filterApp = createApp({ render: () => h(VideoEditor, { ref: editor, project: state.value, onChange: next => { history = commitHistory(history, next); state.value = next }, onStatus: value => { window.filterStatus = value } }) }).mount('#app')
  })
  await expect.poll(async () => (await previewPixel(page))[0]).toBeGreaterThan(150)
}

async function verifyRendererBackends(page) {
  const result = await page.evaluate(async () => {
    const { ClipFilterRenderer } = await import('/src/core/filter-renderer.ts')
    const { CLIP_FILTER_PRESETS } = await import('/src/core/clip-filters.ts')
    const source = document.createElement('canvas'); source.width = 4; source.height = 2
    const context = source.getContext('2d', { willReadFrequently: true })
    context.putImageData(new ImageData(new Uint8ClampedArray([
      210, 30, 70, 255, 20, 190, 80, 255, 40, 70, 220, 128, 210, 170, 30, 64,
      30, 130, 210, 255, 170, 40, 140, 128, 80, 90, 30, 64, 10, 20, 30, 0,
    ]), 4, 2), 0, 0)
    const read = canvas => {
      const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height
      const ctx = copy.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(canvas, 0, 0)
      return [...ctx.getImageData(0, 0, copy.width, copy.height).data]
    }
    const gpu = new ClipFilterRenderer(), cpu = new ClipFilterRenderer({ preferCpu: true })
    const compared = []
    for (const preset of CLIP_FILTER_PRESETS.filter(item => item.id !== 'original')) {
      const accelerated = read(gpu.render(source, 4, 2, 4, 2, preset.filters))
      const fallback = read(cpu.render(source, 4, 2, 4, 2, preset.filters))
      compared.push({ id: preset.id, accelerated, fallback, backend: gpu.backend })
    }
    const filters = CLIP_FILTER_PRESETS.find(item => item.id === 'retro').filters
    const expected = read(cpu.render(source, 4, 2, 4, 2, filters))
    const glCanvas = gpu.render(source, 4, 2, 4, 2, filters)
    const gl = glCanvas.getContext('webgl'), extension = gl?.getExtension('WEBGL_lose_context')
    let afterLoss
    if (extension) {
      const lost = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('测试 GPU 上下文丢失事件超时')), 5000)
        glCanvas.addEventListener('webglcontextlost', () => { clearTimeout(timeout); resolve() }, { once: true })
      })
      extension.loseContext(); await lost
      afterLoss = { pixels: read(gpu.render(source, 4, 2, 4, 2, filters)), backend: gpu.backend }
    }
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    let noGl, noGlResult
    try {
      HTMLCanvasElement.prototype.getContext = function (type, ...args) { return /^webgl/.test(type) ? null : originalGetContext.call(this, type, ...args) }
      noGl = new ClipFilterRenderer()
      noGlResult = { pixels: read(noGl.render(source, 4, 2, 4, 2, filters)), backend: noGl.backend }
    } finally { HTMLCanvasElement.prototype.getContext = originalGetContext; noGl?.dispose() }
    gpu.dispose(); cpu.dispose()
    return { compared, expected, afterLoss, noGlResult }
  })
  assert(result.compared.some(item => item.backend === 'webgl'), '测试环境应实际执行 WebGL 滤镜路径')
  for (const entry of result.compared) {
    assertPixelClose(entry.accelerated, entry.fallback, 4, `${entry.id} GPU/CPU 颜色、方向和透明度应一致`)
    for (let index = 3; index < entry.accelerated.length; index += 4) assert.equal(entry.accelerated[index], entry.fallback[index], `${entry.id} 不应改变 alpha`)
  }
  assert.equal(result.afterLoss?.backend, 'cpu', 'GPU 上下文丢失后应自动使用 CPU')
  assertPixelClose(result.afterLoss.pixels, result.expected, 0, '上下文丢失后效果保持一致')
  assert.equal(result.noGlResult.backend, 'cpu')
  assertPixelClose(result.noGlResult.pixels, result.expected, 0, '无 GPU 环境保持相同滤镜效果')
  console.log('PASS 11 种非原色预设真实 GPU/CPU 像素一致，保留方向和 alpha，GPU 缺失/丢失时正确降级')
}

async function main() {
  const baseURL = await startDevServer()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await installEditor(page, baseURL)
    await verifyRendererBackends(page)
    const originalPixel = await previewPixel(page)
    await page.locator('[data-clip-id="filter-video"]').click()
    await expect(page.getByRole('tab', { name: '属性', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: '滤镜', exact: true }).click()
    const panel = page.getByTestId('clip-filter-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-filter-preset]')).toHaveCount(12)
    await panel.locator('[data-filter-preset="monochrome"]').click()
    await expect.poll(async () => isGray(await previewPixel(page))).toBe(true)
    const monochromePixel = await previewPixel(page)
    const subtitlePixel = await previewPixel(page, 20, 150)
    const imagePixel = await previewPixel(page, 210, 30)
    assert(subtitlePixel[2] > 180 && subtitlePixel[0] < 80, `视频滤镜不应污染字幕：${subtitlePixel}`)
    assert(imagePixel[1] > imagePixel[0] + 70, `视频滤镜不应污染透明图片图层：${imagePixel}`)
    await expect(panel.locator('[data-filter-preset="monochrome"]')).toHaveAttribute('aria-pressed', 'true')
    await fs.mkdir('/tmp/open-media-filter-checks', { recursive: true })
    await page.screenshot({ path: '/tmp/open-media-filter-checks/editor-filters-desktop.png' })
    console.log('PASS 视频滤镜页签、12 个预设、实际黑白预览和独立字幕/透明图片图层')

    const encoded = await page.evaluate(async () => {
      const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
      const blob = await exportTimelineWebM(window.filterState.value, { width: 320, height: 180, fps: 20 })
      const url = URL.createObjectURL(blob), video = document.createElement('video')
      video.muted = true; video.preload = 'auto'; video.src = url
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject })
      await new Promise(resolve => { video.onseeked = resolve; video.currentTime = 0.5 })
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0)
      const points = [[20, 20], [20, 150], [210, 30], [250, 30]]
      const pixels = points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data])
      video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url)
      return { pixels, bytes: [...new Uint8Array(await blob.arrayBuffer())] }
    })
    assert.deepEqual(encoded.bytes.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3])
    assert(encoded.bytes.length > 1000)
    assertPixelClose(encoded.pixels[0], monochromePixel, 7, '导出视频应保留黑白滤镜')
    assertPixelClose(encoded.pixels[1], subtitlePixel, 8, '导出字幕保留原色')
    assertPixelClose(encoded.pixels[2], imagePixel, 10, '导出透明图片正确叠加')
    assert(isGray(encoded.pixels[3]), `图片透明区域应透出下层黑白视频：${encoded.pixels[3]}`)
    await fs.writeFile('/tmp/open-media-filter-checks/filtered-export.webm', Buffer.from(encoded.bytes))
    console.log('PASS 真实 WebM 编码与重新解码验证滤镜、字幕原色、透明图层叠加')

    await setRange(page, '滤镜强度', 0)
    await expect.poll(async () => (await clipState(page)).filters.intensity).toBe(0)
    assertPixelClose(await previewPixel(page), originalPixel, 2, '零强度应恢复原色')
    await setRange(page, '滤镜强度', 0.5)
    await expect.poll(async () => (await clipState(page)).filters.intensity).toBe(0.5)
    const halfPixel = await previewPixel(page)
    assert(halfPixel[0] < originalPixel[0] && halfPixel[0] > monochromePixel[0], `半强度应介于原色和黑白之间：${halfPixel}`)
    await panel.locator('.filter-switch').click()
    await expect(page.getByRole('switch', { name: '启用滤镜' })).not.toBeChecked()
    assertPixelClose(await previewPixel(page), originalPixel, 2, '关闭滤镜应恢复原色')
    assert.equal((await clipState(page)).filters.intensity, 0.5, '关闭滤镜应保留参数')
    await page.getByRole('switch', { name: '启用滤镜' }).press('Space')
    await expect.poll(async () => (await clipState(page)).filters.enabled).toBe(true)
    assertPixelClose(await previewPixel(page), halfPixel, 2, '重新启用应恢复原参数效果')
    await setRange(page, '亮度', 0.55)
    await expect.poll(async () => (await clipState(page)).filters.brightness).toBeCloseTo(0.1)
    assert((await previewPixel(page))[0] > halfPixel[0] + 10, '手动提高亮度应改变实际预览')
    await expect(panel.locator('.filter-section-heading').first()).toContainText('自定义')
    await page.getByRole('button', { name: '重置滤镜', exact: true }).click()
    await expect.poll(async () => (await previewPixel(page))[0]).toBe(originalPixel[0])
    console.log('PASS 滤镜强度、开关保留参数、重置通过真实属性面板回写并改变像素')

    await panel.locator('[data-filter-preset="warm"]').click()
    const savedFilters = (await clipState(page)).filters
    await page.evaluate(() => window.filterMoveHistory('undo'))
    assertPixelClose(await previewPixel(page), originalPixel, 2, '撤销应恢复原色预览')
    await page.evaluate(() => window.filterMoveHistory('redo'))
    assert.deepEqual((await clipState(page)).filters, savedFilters)
    await page.getByRole('button', { name: '复制片段', exact: true }).click()
    await page.evaluate(() => window.filterEditor.value.seek(0.75))
    await page.getByTitle('在播放头处分割（S）').click()
    const persisted = await page.evaluate(async () => {
      const { exportProjectFile, importProjectFile } = await import('/src/core/project-file.ts')
      const clips = window.filterState.value.tracks.flatMap(track => track.clips).filter(clip => clip.assetId === 'video-source')
      const blob = await exportProjectFile(window.filterState.value, { blobs: window.filterBlobs })
      const imported = await importProjectFile(blob)
      const restored = imported.project.tracks.flatMap(track => track.clips).filter(clip => clip.assetId === 'video-source').map(clip => clip.filters)
      imported.revoke()
      return { clips: clips.map(clip => clip.filters), restored, size: blob.size }
    })
    assert.equal(persisted.clips.length, 3)
    assert.deepEqual(persisted.clips, [savedFilters, savedFilters, savedFilters])
    assert.deepEqual(persisted.restored, persisted.clips)
    assert(persisted.size > 1000)
    console.log('PASS 滤镜撤销/重做、界面复制/分割和包含真实素材的项目文件保存恢复')

    await page.getByRole('tab', { name: '属性', exact: true }).click()
    await page.getByRole('button', { name: '分离到音轨', exact: true }).click()
    const separated = await page.evaluate(() => ({
      video: window.filterState.value.tracks.flatMap(track => track.clips).find(clip => clip.id === 'filter-video'),
      audio: window.filterState.value.tracks.filter(track => track.kind === 'audio').flatMap(track => track.clips).filter(clip => clip.assetId === 'video-source'),
    }))
    assert.deepEqual(separated.video.filters, savedFilters)
    assert.equal(separated.video.volume, 0)
    assert.equal(separated.audio.length, 1)
    assert.equal(separated.audio[0].filters, undefined)
    await page.getByRole('tab', { name: '滤镜', exact: true }).click()
    console.log('PASS 带滤镜视频分离音轨保留画面效果，纯音频片段不携带滤镜')

    await page.evaluate(() => {
      const project = JSON.parse(JSON.stringify(window.filterState.value))
      project.tracks.find(track => track.clips.some(clip => clip.id === 'filter-video')).locked = true
      window.filterState.value = project
    })
    await expect(page.getByRole('switch', { name: '启用滤镜' })).toBeDisabled()
    await expect(panel.locator('[data-filter-preset="monochrome"]')).toBeDisabled()
    await expect(page.getByRole('slider', { name: '滤镜强度', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '重置滤镜', exact: true })).toBeDisabled()
    for (const id of ['filter-text', 'filter-audio']) {
      await page.locator(`[data-clip-id="${id}"]`).click()
      await expect(page.getByRole('tab', { name: '滤镜', exact: true })).toHaveCount(0)
    }
    await page.locator('[data-clip-id="filter-image"]').click()
    await page.getByRole('tab', { name: '滤镜', exact: true }).click()
    await panel.locator('[data-filter-preset="cool"]').click()
    assert((await clipState(page, 'filter-image')).filters.temperature < 0)
    assert.deepEqual((await clipState(page)).filters, savedFilters, '图片滤镜不能改写相邻视频滤镜')
    console.log('PASS 锁定片段拒绝修改，字幕/音频无滤镜入口，图片片段独立应用滤镜')

    for (const width of [768, 320]) {
      await page.setViewportSize({ width, height: 850 })
      await panel.scrollIntoViewIfNeeded()
      const bounds = await panel.boundingBox()
      assert(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `${width}px 滤镜面板超出可视区：${JSON.stringify(bounds)}`)
      await page.getByRole('slider', { name: '滤镜强度', exact: true }).scrollIntoViewIfNeeded()
      await expect(page.getByRole('slider', { name: '滤镜强度', exact: true })).toBeVisible()
    }
    await page.screenshot({ path: '/tmp/open-media-filter-checks/editor-filters-mobile.png' })
    console.log('PASS 768 / 320 像素窗口下滤镜面板和调整控件可达')
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => server?.kill())
