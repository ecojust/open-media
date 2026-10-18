const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('@playwright/test')

async function main() {
  const directory = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'split-continuity') : fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-split-'))
  fs.mkdirSync(directory, { recursive: true })
  // Use the same open video codec supported by the CI browser and browser export.
  // The native export regression separately checks the packaged H.264 encoder.
  const source = path.join(directory, 'source.webm')
  execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xe04020:s=160x96:r=30:d=3', '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', source])
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    const report = await page.evaluate(async base64 => {
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
      const { createProject, createClip } = await import('/src/core/project.ts')
      const { addAsset, addClip, splitClip, updateClip } = await import('/src/core/timeline.ts')
      const blob = new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], { type: 'video/webm' })
      const url = URL.createObjectURL(blob)
      const asset = { id: 'continuous-source', name: 'source.webm', kind: 'video', url, duration: 3, width: 160, height: 96, size: blob.size, mime: 'video/webm' }
      const results = []
      let exportProject
      for (const speed of [1, 1.25]) {
        let project = createProject('分割连续帧验证', { width: 160, height: 96, fps: 30, background: '#000000' })
        project = addAsset(project, asset)
        const clip = createClip(asset, project, { id: 'before-split', trimIn: 0.137, trimOut: 2.537, speed, volume: 0 })
        project = addClip(project, project.tracks.find(track => track.kind === 'video').id, clip)
        const boundary = 0.713
        project = splitClip(project, clip.id, boundary)
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 96
        const preview = new TimelinePreview(canvas, project)
        await preview.prepare(); await preview.playReady(boundary - 0.08)
        const frames = []
        const begin = performance.now()
        await new Promise(resolve => {
          const tick = () => {
            const elapsed = (performance.now() - begin) / 1000
            const time = boundary - 0.08 + elapsed
            preview.render(time, true)
            const pixel = [...canvas.getContext('2d').getImageData(80, 48, 1, 1).data]
            frames.push({ time, pixel })
            if (elapsed >= 0.26) resolve(); else requestAnimationFrame(tick)
          }
          tick()
        })
        // Paused seeks also cover the exact boundary and adjacent output frames.
        const paused = []
        for (const time of [boundary - 1 / 30, boundary, boundary + 1 / 30]) {
          await preview.seekReady(time)
          paused.push({ time, pixel: [...canvas.getContext('2d').getImageData(80, 48, 1, 1).data] })
        }
        const right = project.tracks.find(track => track.kind === 'video').clips[1]
        preview.setProject(updateClip(project, right.id, { x: 80, width: 80 }))
        await preview.seekReady(boundary + 1 / 30)
        const transformed = { left: [...canvas.getContext('2d').getImageData(40, 48, 1, 1).data], right: [...canvas.getContext('2d').getImageData(120, 48, 1, 1).data] }
        preview.dispose()
        results.push({ speed, boundary, frames, paused, transformed })
        exportProject = project
      }
      const output = await exportTimelineWebM(exportProject, { fps: 30 })
      URL.revokeObjectURL(url)
      return { results, encoded: [...new Uint8Array(await output.arrayBuffer())] }
    }, fs.readFileSync(source).toString('base64'))
    const output = path.join(directory, 'split-browser.webm')
    fs.writeFileSync(output, Buffer.from(report.encoded))
    delete report.encoded
    const frames = execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-i', output, '-vf', 'crop=2:2:80:48,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    report.exportedFrames = Array.from({ length: frames.length / 3 }, (_, index) => [...frames.subarray(index * 3, index * 3 + 3)])
    fs.writeFileSync(path.join(directory, 'frames.json'), JSON.stringify(report, null, 2))
    for (const item of report.results) {
      for (const frame of [...item.frames, ...item.paused]) assert(frame.pixel[0] > 150 && frame.pixel[1] < 100, `分割预览黑帧 speed=${item.speed} time=${frame.time}: ${frame.pixel}; evidence=${directory}`)
      assert(item.transformed.left.slice(0, 3).every(value => value < 10) && item.transformed.right[0] > 150,
        'sharing the continuous decoder must still draw the new clip with its independent position and dimensions')
    }
    assert(report.exportedFrames.length > 40, 'real browser export must contain the complete sequence')
    for (const [index, pixel] of report.exportedFrames.entries()) assert(pixel[0] > 150 && pixel[1] < 100, `网页导出黑帧 index=${index}: ${pixel}; evidence=${directory}`)
    console.log(`PASS 真实视频在非整帧分割、变速预览与逐帧定位均连续，浏览器导出 ${report.exportedFrames.length} 帧完整解码无黑帧；证据 ${directory}`)
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
