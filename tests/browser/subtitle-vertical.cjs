const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/subtitle-vertical-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>字幕纵向对齐验证</title>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/subtitle-vertical-test`)
    const report = await page.evaluate(async () => {
      const { createProject, createClip, createTextClip } = await import('/src/core/project.ts')
      const { TimelinePreview, drawTextClip } = await import('/src/core/preview.ts')
      const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
      const { prepareNativeProject } = await import('/src/core/native-project.ts')
      const bounds = canvas => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
        let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1, count = 0
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4
          if (pixels[i] > 180 && pixels[i + 1] > 180 && pixels[i + 2] > 180 && pixels[i + 3] > 180) {
            minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++
          }
        }
        return { minX, minY, maxX, maxY, count }
      }
      const makeCanvas = (width, height) => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas }
      const decodeExport = async project => {
        const blob = await exportTimelineWebM(project)
        const video = document.createElement('video'); video.muted = true; video.preload = 'auto'
        const videoUrl = URL.createObjectURL(blob)
        try {
          await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; video.src = videoUrl; video.load() })
          await new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = reject; video.currentTime = 0.1 })
          const frame = makeCanvas(video.videoWidth, video.videoHeight)
          frame.getContext('2d').drawImage(video, 0, 0)
          return { ...bounds(frame), size: blob.size, width: video.videoWidth, height: video.videoHeight }
        } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(videoUrl) }
      }
      const rate = 24000, samples = rate * 2, wav = new ArrayBuffer(44 + samples * 2), view = new DataView(wav)
      const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)) }
      ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
      ascii(36, 'data'); view.setUint32(40, samples * 2, true)
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 400), true)
      const audioUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      const imported = []
      // Capture the actual PNG produced by desktop export preparation at the transport boundary.
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          if (command !== 'import_blob_asset') throw new Error(`Unexpected command: ${command}`)
          const blob = new Blob([new Uint8Array(args.bytes)], { type: 'image/png' })
          imported.push(blob)
          return { id: 'native-text', name: args.name, kind: 'image', url: URL.createObjectURL(blob), duration: 0, width: 280, height: 200, size: blob.size, mime: 'image/png' }
        },
      }
      const result = {}
      for (const alignment of ['top', 'middle', 'bottom', undefined]) {
        const project = createProject('字幕纵向对齐', { width: 320, height: 240, fps: 20, background: '#000000' })
        const clip = createTextClip(project, { text: '字幕第一行\n第二行', textVerticalAlign: alignment, fontSize: 24, fontFamily: 'sans-serif', fontWeight: 600, x: 20, y: 20, width: 280, height: 200, trimOut: 1.2 })
        project.tracks[0].clips.push(clip)
        const audio = { id: 'test-tone', name: '测试声音.wav', kind: 'audio', url: audioUrl, nativePath: '/fixture/test-tone.wav', duration: 2, width: 0, height: 0, size: wav.byteLength, mime: 'audio/wav' }
        project.assets.push(audio)
        project.tracks[2].clips.push(createClip(audio, project, { trimOut: 1.2 }))
        const local = makeCanvas(280, 200)
        drawTextClip(local.getContext('2d'), clip)
        const previewCanvas = makeCanvas(320, 240)
        const preview = new TimelinePreview(previewCanvas, project)
        await preview.prepare(); await preview.seekReady(0.1); preview.dispose()
        const native = await prepareNativeProject(project)
        const bitmap = await createImageBitmap(imported.at(-1))
        const nativeCanvas = makeCanvas(bitmap.width, bitmap.height)
        nativeCanvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close()
        const localPixels = local.getContext('2d').getImageData(0, 0, 280, 200).data
        const nativePixels = nativeCanvas.getContext('2d').getImageData(0, 0, 280, 200).data
        const identicalNativePixels = localPixels.every((value, index) => value === nativePixels[index])
        URL.revokeObjectURL(native.textAssets[clip.id].url)
        let exported
        if (alignment) exported = await decodeExport(project)
        if (alignment === 'middle') {
          const silentProject = structuredClone(project)
          silentProject.assets = []
          silentProject.tracks[2].clips = []
          result.textOnly = await decodeExport(silentProject)
          project.tracks[2].muted = true
          result.muted = await decodeExport(project)
          project.tracks[2].muted = false
          project.tracks[2].clips[0].volume = 0
          result.zeroVolume = await decodeExport(project)
        }
        result[String(alignment)] = { local: bounds(local), preview: bounds(previewCanvas), native: bounds(nativeCanvas), identicalNativePixels, exported }
      }
      URL.revokeObjectURL(audioUrl)
      return result
    })
    assert.deepEqual(errors, [])
    for (const alignment of ['top', 'middle', 'bottom']) {
      const row = report[alignment]
      assert(row.local.count > 100, `${alignment}: 实际文字应可见`)
      assert.deepEqual(row.native, row.local, `${alignment}: 桌面导出准备的真实 PNG 应与预览文字层逐像素一致`)
      assert(row.identicalNativePixels, `${alignment}: PNG 文字层完整像素应一致`)
      for (const coordinate of ['minX', 'maxX', 'minY', 'maxY']) assert.equal(row.preview[coordinate], row.local[coordinate] + 20)
      assert.equal(row.exported.width, 320); assert.equal(row.exported.height, 240)
      assert(row.exported.size > 500)
      for (const coordinate of ['minX', 'maxX', 'minY', 'maxY']) assert(Math.abs(row.exported[coordinate] - row.preview[coordinate]) <= 2, `${alignment}: 编码后解码画面的 ${coordinate} 与预览一致`)
    }
    assert(report.top.local.maxY < report.middle.local.maxY)
    assert(report.middle.local.maxY < report.bottom.local.maxY)
    assert.equal(report.top.local.minX, report.bottom.local.minX)
    assert.equal(report.top.local.maxX, report.bottom.local.maxX)
    assert.deepEqual(report.undefined.local, report.middle.local, '旧项目的实际像素不应变化')
    for (const key of ['textOnly', 'muted', 'zeroVolume']) {
      assert(report[key].size > 500, `${key}: 无可听音频时仍应生成有效视频`)
      assert.equal(report[key].width, 320); assert.equal(report[key].height, 240)
      for (const coordinate of ['minX', 'maxX', 'minY', 'maxY']) assert(Math.abs(report[key][coordinate] - report.middle.preview[coordinate]) <= 2, `${key}: 无可听音频视频应保留字幕位置`)
    }
    console.log('PASS 上/中/下对齐真实画布像素、旧项目兼容、桌面导出 PNG 图层一致；三种对齐均实际编码 WebM 并解码核对文字位置')
    console.log('PASS 纯字幕、音轨静音与片段零音量项目均真实导出 WebM 并解码核对字幕画面')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
