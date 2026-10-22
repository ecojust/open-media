const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { chromium } = require('@playwright/test')

function backgroundBounds(pixels, width, height, channels = 4) {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels
    if (pixels[i] > 130 && pixels[i + 1] < 100 && pixels[i + 2] > 110) {
      minX = Math.min(minX, x); minY = Math.min(minY, y)
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++
    }
  }
  return { minX, minY, maxX, maxY, count }
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-subtitle-background-'))
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/subtitle-background-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>字幕文字背景验证</title>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/subtitle-background-test`)
    const report = await page.evaluate(async () => {
      const { createProject, createTextClip } = await import('/src/core/project.ts')
      const { TimelinePreview, drawTextClip } = await import('/src/core/preview.ts')
      const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
      const { prepareNativeProject } = await import('/src/core/native-project.ts')
      const canvas = (width, height) => { const result = document.createElement('canvas'); result.width = width; result.height = height; return result }
      const bounds = target => {
        const pixels = target.getContext('2d').getImageData(0, 0, target.width, target.height).data
        let minX = target.width, minY = target.height, maxX = -1, maxY = -1, count = 0
        for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
          const i = (y * target.width + x) * 4
          if (pixels[i] > 130 && pixels[i + 1] < 100 && pixels[i + 2] > 110 && pixels[i + 3] > 180) {
            minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++
          }
        }
        return { minX, minY, maxX, maxY, count }
      }
      let importedPng
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        if (command !== 'import_blob_asset') throw new Error(`Unexpected command: ${command}`)
        importedPng = new Blob([new Uint8Array(args.bytes)], { type: 'image/png' })
        return { id: 'native-text', name: args.name, kind: 'image', url: URL.createObjectURL(importedPng), duration: 0, width: 560, height: 260, size: importedPng.size, mime: 'image/png' }
      } }
      const result = []
      for (const horizontal of ['left', 'center', 'right']) for (const vertical of ['top', 'middle', 'bottom']) {
        const project = createProject('字幕文字背景', { width: 640, height: 360, fps: 20, background: '#000000' })
        const clip = createTextClip(project, { text: '较长的一行文字\n短句', textAlign: horizontal, textVerticalAlign: vertical, fontSize: 28, fontWeight: 600, background: '#c828b4', color: '#ffffff', x: 40, y: 50, width: 560, height: 260, trimOut: 0.6 })
        project.tracks.find(track => track.kind === 'text').clips.push(clip)
        const local = canvas(560, 260)
        drawTextClip(local.getContext('2d'), clip)
        const localPixels = local.getContext('2d').getImageData(0, 0, 560, 260).data
        const previewCanvas = canvas(640, 360)
        const preview = new TimelinePreview(previewCanvas, project)
        await preview.prepare(); await preview.seekReady(0.1); preview.dispose()
        const native = await prepareNativeProject(project)
        const bitmap = await createImageBitmap(importedPng)
        const nativeCanvas = canvas(bitmap.width, bitmap.height)
        nativeCanvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close()
        const nativePixels = nativeCanvas.getContext('2d').getImageData(0, 0, 560, 260).data
        const identicalNativePixels = localPixels.every((value, index) => value === nativePixels[index])
        const pngBase64 = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(importedPng) })
        URL.revokeObjectURL(native.textAssets[clip.id].url)
        const blob = await exportTimelineWebM(project)
        const video = document.createElement('video'); video.muted = true
        const videoUrl = URL.createObjectURL(blob)
        let exported
        try {
          await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; video.src = videoUrl; video.load() })
          await new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = reject; video.currentTime = 0.1 })
          const decoded = canvas(video.videoWidth, video.videoHeight)
          decoded.getContext('2d').drawImage(video, 0, 0)
          exported = { ...bounds(decoded), bytes: blob.size, width: video.videoWidth, height: video.videoHeight }
        } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(videoUrl) }
        // Scan background width around each line to ensure short lines do not inherit the longest line's box.
        const rowWidths = []
        for (let y = 0; y < local.height; y++) {
          let left = local.width, right = -1
          for (let x = 0; x < local.width; x++) if (localPixels[(y * local.width + x) * 4 + 3] > 180) { left = Math.min(left, x); right = Math.max(right, x) }
          if (right >= left) rowWidths.push(right - left + 1)
        }
        result.push({ horizontal, vertical, local: bounds(local), preview: bounds(previewCanvas), native: bounds(nativeCanvas), identicalNativePixels, rowWidths, exported, pngBase64 })
      }
      const empty = canvas(560, 260)
      drawTextClip(empty.getContext('2d'), createTextClip({ width: 640, height: 360 }, { width: 560, height: 260, text: '  \n\t', background: '#c828b4' }))
      return { rows: result, empty: [...empty.getContext('2d').getImageData(0, 0, 560, 260).data].every(value => value === 0) }
    })
    assert.deepEqual(errors, [])
    assert.equal(report.empty, true, '空字幕不得形成背景矩形')
    for (const row of report.rows) {
      const label = `${row.horizontal}/${row.vertical}`
      assert(row.identicalNativePixels, `${label}: 桌面导出的 PNG 应与文字预览层逐像素一致`)
      assert.deepEqual(row.native, row.local)
      assert(row.local.count > 1500 && row.local.count < 15000, `${label}: 文字背景应可见且紧凑`)
      assert(row.local.maxX - row.local.minX < 260, `${label}: 背景宽度应匹配文字而不是 560px 定位框`)
      assert(row.local.maxY - row.local.minY < 100, `${label}: 背景高度应匹配两行文字而不是 260px 定位框`)
      assert(Math.max(...row.rowWidths) > Math.min(...row.rowWidths) * 2, `${label}: 短行背景应明显窄于长行`)
      for (const coordinate of ['minX', 'maxX', 'minY', 'maxY']) {
        assert.equal(row.preview[coordinate], row.local[coordinate] + (coordinate.endsWith('X') ? 40 : 50))
        assert(Math.abs(row.exported[coordinate] - row.preview[coordinate]) <= 3, `${label}: 真实 WebM 解码背景位置 ${coordinate} 不一致`)
      }
      assert.equal(row.exported.width, 640); assert.equal(row.exported.height, 360)
      assert(row.exported.bytes > 1000)
    }
    // Encode the exact PNG emitted by desktop export preparation, then decode the
    // final video. This verifies alpha compositing and compact backgrounds survive
    // the desktop encoder, in addition to the actual browser export above.
    for (const row of [report.rows[0], report.rows[4], report.rows[8]]) {
      const name = `${row.horizontal}-${row.vertical}`
      const input = path.join(temporary, `${name}.png`), output = path.join(temporary, `${name}.mp4`)
      fs.writeFileSync(input, Buffer.from(row.pngBase64, 'base64'))
      execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=20:d=0.6', '-loop', '1', '-framerate', '20', '-i', input, '-filter_complex_threads', '1', '-filter_complex', '[0:v]format=rgba[base];[1:v]format=rgba[text];[base][text]overlay=x=40:y=50:format=auto,format=yuv420p[video]', '-map', '[video]', '-c:v', 'libx264', '-threads', '1', '-crf', '18', '-an', '-t', '0.6', output], { stdio: 'pipe' })
      const decoded = execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-ss', '0.1', '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 2 * 1024 * 1024 })
      assert.equal(decoded.length, 640 * 360 * 3)
      const actual = backgroundBounds(decoded, 640, 360, 3)
      for (const coordinate of ['minX', 'maxX', 'minY', 'maxY']) assert(Math.abs(actual[coordinate] - row.preview[coordinate]) <= 3, `${name}: PNG 合成后的真实 MP4 背景位置 ${coordinate} 不一致`)
    }
    console.log('PASS 字幕文字背景：九种横纵对齐、逐行紧凑背景、空白透明、桌面 PNG 完整像素一致；九段实际 WebM 与三段实际 MP4 编码后解码验证')
  } finally { await browser?.close(); await server.close(); fs.rmSync(temporary, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
