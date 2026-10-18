const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { chromium } = require('@playwright/test')

let server, browser
async function startServer() {
  if (process.env.TRANSITION_TEST_URL) return process.env.TRANSITION_TEST_URL
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' })
  const url = `http://127.0.0.1:${port}`
  for (let n = 0; n < 150; n++) {
    try { if ((await fetch(url)).ok) return url } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('转场测试服务未就绪')
}

async function main() {
  const only = process.env.TRANSITION_EFFECTS?.split(',').filter(Boolean) || []
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'open-media-transitions-'))
  for (const [name, color] of [['red', '0xc82828'], ['cyan', '0x28c8c8'], ['detail', 'black']]) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=20:d=2${name === 'detail' ? ',drawbox=x=80:y=0:w=80:h=90:c=white:t=fill,drawbox=x=24:y=0:w=4:h=90:c=red:t=fill' : ''}`, '-c:v', 'libvpx', '-threads', '1', '-b:v', '250k', path.join(folder, `${name}.webm`)])
  }
  const baseURL = await startServer()
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage()
  await page.route('**/transition-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><canvas id="preview" width="160" height="90"></canvas></body></html>' }))
  for (const name of ['red', 'cyan', 'detail']) {
    const body = await fs.readFile(path.join(folder, `${name}.webm`))
    await page.route(`**/transition-${name}.webm`, route => route.fulfill({ contentType: 'video/webm', body }))
  }
  await page.goto(`${baseURL}/transition-fixture`)
  const result = await page.evaluate(async (only) => {
    const { createProject, createClip, validateProject } = await import('/src/core/project.ts')
    const { addTransition, TRANSITION_PRESETS } = await import('/src/core/transitions.ts')
    const { TimelinePreview } = await import('/src/core/preview.ts')
    const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
    const project = createProject('转场真实画面验证', { width: 160, height: 90, fps: 20, background: '#102030' })
    project.assets = await Promise.all(['red', 'cyan'].map(async id => ({ id, kind: 'video', name: `${id}.webm`, url: URL.createObjectURL(await (await fetch(`/transition-${id}.webm`)).blob()), duration: 2, width: 160, height: 90, mime: 'video/webm', size: 100 })))
    project.tracks[1].clips = project.assets.map((asset, index) => createClip(asset, project, { id: `${asset.id}-clip`, start: index * 2, trimOut: 2, volume: 0 }))
    const source = validateProject(project, { trusted: true })
    const canvas = document.querySelector('canvas'), preview = new TimelinePreview(canvas, source)
    const points = [[16, 9], [48, 27], [80, 45], [112, 63], [144, 81], [16, 81], [144, 9], [4, 45], [20, 45], [140, 45], [156, 45], [80, 1], [80, 12], [80, 78], [80, 89]]
    const pixels = () => points.map(([x, y]) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data])
    await preview.prepare()
    const frames = {}
    for (const { id } of TRANSITION_PRESETS.filter(item => !only.length || only.includes(item.id))) {
      const next = addTransition(source, 2, id, 1)
      preview.setProject(next)
      frames[id] = []
      const times = ['diagonal', 'radial'].includes(id) ? [1.5, 1.625, 1.75, 1.875, 2, 2.125, 2.25, 2.375] : id.startsWith('zoom-fade') ? [1.625, 1.75, 1.875, 2.125, 2.25, 2.375] : [1.75, 2.25]
      for (const time of times) {
        await preview.seekReady(time)
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        preview.render(time)
        frames[id].push({ time, pixels: pixels() })
      }
    }
    const detailFrames = {}
    if (!only.length) {
      const detailAsset = { ...project.assets[0], id: 'detail', url: URL.createObjectURL(await (await fetch('/transition-detail.webm')).blob()) }
      const detail = { ...source, assets: [...source.assets, detailAsset], tracks: source.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, assetId: 'detail' })) })) }
      for (const effect of ['fade', 'defocus', 'zoom-through']) {
        preview.setProject(addTransition(detail, 2, effect, 1))
        await preview.prepare(); await preview.seekReady(1.75); preview.render(1.75)
        detailFrames[effect] = [24, 26, 76, 84].map(x => [...canvas.getContext('2d').getImageData(x, 45, 1, 1).data])
      }
      preview.setProject(addTransition(detail, 2, 'defocus', 1))
      await preview.prepare(); await preview.seekReady(1.75)
      canvas.width = 80; canvas.height = 45; preview.render(1.75)
      detailFrames.reduced = [38, 42].map(x => [...canvas.getContext('2d').getImageData(x, 22, 1, 1).data])
    }
    preview.dispose()
    const exports = {}
    for (const effect of ['fade', 'zoom-fade', 'zoom-fade-left', 'iris', 'diamond', 'blinds', 'flash-white', 'defocus', 'zoom-through', 'diagonal', 'radial'].filter(effect => !only.length || only.includes(effect))) {
      const output = await exportTimelineWebM(addTransition(source, 2, effect, 1), { fps: 20, videoBitsPerSecond: 1000000 })
      exports[effect] = [...new Uint8Array(await output.arrayBuffer())]
    }
    return { frames, points, exports, detailFrames }
  }, only)
  const background = [16, 32, 48]
  const coverage = (x, y, inside) => {
    let count = 0
    for (let iy = 0; iy < 32; iy++) for (let ix = 0; ix < 32; ix++) if (inside(x + (ix + .5) / 32, y + (iy + .5) / 32)) count++
    return { visible: true, alpha: count / 1024 }
  }
  const effects = {
    fade: () => ({ visible: true, alpha: 0.5 }),
    'wipe-up': (x, y) => ({ visible: y >= 45 }),
    'wipe-down': (x, y) => ({ visible: y < 45 }),
    'wipe-left': x => ({ visible: x >= 80 }),
    'wipe-right': x => ({ visible: x < 80 }),
    'close-vertical': (x, y) => ({ visible: y >= 22.5 && y < 67.5 }),
    'close-horizontal': x => ({ visible: x >= 40 && x < 120 }),
    'slide-left': x => ({ visible: x < 80 }),
    'slide-right': x => ({ visible: x >= 80 }),
    diagonal: (x, y, v = .5) => coverage(x, y, (sx, sy) => sx / 160 + sy / 90 < 2 * v),
    radial: (x, y, v = .5) => coverage(x, y, (sx, sy) => (Math.atan2(sy - 45, sx - 80) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI) < 2 * Math.PI * v),
    iris: (x, y) => coverage(x, y, (sx, sy) => Math.hypot(sx - 80, sy - 45) < Math.hypot(160, 90) / 4),
    diamond: (x, y) => coverage(x, y, (sx, sy) => Math.abs(sx / 80 - 1) + Math.abs(sy / 45 - 1) < 1),
    blinds: (x, y) => coverage(x, y, (sx, sy) => { const row = Math.floor(sy / (90 / 8)); return sy < row * 90 / 8 + Math.max(0, Math.min(1, (.5 - .22 * row / 7) / .78)) * 90 / 8 }),
    'flash-white': () => ({ visible: true, alpha: .5, background: [255, 249, 232] }),
    defocus: () => ({ visible: true, alpha: .5 }),
    'zoom-through': () => ({ visible: true, alpha: .5 }),
    zoom: (x, y) => ({ visible: x >= 40 && x < 120 && y >= 22.5 && y < 67.5, alpha: 0.5 }),
  }
  assert.equal(Object.keys(result.frames).length, only.length || 23, '保留原有 15 种转场并加入 8 种科普转场')
  for (const [effect, frames] of Object.entries(result.frames)) for (const { time, pixels } of frames) {
    const side = time >= 2, source = side ? [40, 200, 200] : [200, 40, 40]
    const visibility = Math.abs(time - 2) / .5
    pixels.forEach((pixel, index) => {
      const [x, y] = result.points[index]
      let transform
      if (effect.startsWith('zoom-fade')) {
        // At half visibility the image is 90% of its original dimensions,
        // and the direction pins the corresponding image edge in place.
        const scale = .8 + .2 * visibility, width = 160 * scale, height = 90 * scale
        const left = effect.endsWith('-left') ? 0 : effect.endsWith('-right') ? 160 - width : (160 - width) / 2
        const top = effect.endsWith('-up') ? 0 : effect.endsWith('-down') ? 90 - height : (90 - height) / 2
        transform = { visible: x >= left && x < left + width && y >= top && y < top + height, alpha: visibility }
      } else transform = effects[effect](x, y, visibility)
      const alpha = transform.visible ? transform.alpha ?? 1 : 0
      const expected = source.map((value, channel) => value * alpha + (transform.background || background)[channel] * (1 - alpha))
      assert(pixel.slice(0, 3).every((value, channel) => Math.abs(value - expected[channel]) <= 5), `${effect} time=${time} point=${result.points[index]} actual=${pixel} expected=${expected}`)
    })
  }
  if (!only.length) {
    const { fade: focused, defocus: softened, 'zoom-through': pushed } = result.detailFrames
    assert(softened[2][0] > focused[2][0] + 10 && softened[3][0] < focused[3][0] - 10, '失焦转场应真正柔化黑白边缘')
    assert(result.detailFrames.reduced.every((pixel, i) => Math.abs(pixel[0] - softened[i + 2][0]) < 10), '低清预览应按实际画布尺寸缩放模糊半径')
    assert(focused[1][0] > 80 && pushed[1][0] < focused[1][0] - 50, '推近转场应改变实际画面细节的位置')
    const output = path.join(folder, 'transition-browser-fade.webm')
    await fs.writeFile(output, Buffer.from(result.exports.fade))
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }))
    assert(probe.streams.some(stream => stream.codec_type === 'video' && stream.width === 160 && stream.height === 90))
    const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output, '-vf', 'fps=20,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e6 })
    const luminance = []
    for (let i = 0; i < raw.length; i += 3) luminance.push(raw[i] + raw[i + 1] + raw[i + 2])
    assert(luminance.length >= 70, '导出必须包含完整视频帧')
    const cut = luminance.slice(30, 51)
    assert(Math.min(...cut) < 140, `导出应实际淡出至项目背景色：${cut}`)
    assert(luminance.slice(0, 25).some(value => value > 250) && luminance.slice(55).some(value => value > 400), '切点前后必须保留两段实际视频')
  }
  for (const effect of ['zoom-fade', 'zoom-fade-left'].filter(effect => result.exports[effect])) {
    const output = path.join(folder, `transition-browser-${effect}.webm`)
    await fs.writeFile(output, Buffer.from(result.exports[effect]))
    const decoded = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output, '-vf', 'fps=20', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 5e6 })
    const frameBytes = 160 * 90 * 3, frameCount = decoded.length / frameBytes
    assert(frameCount >= 70, `${effect} 导出必须包含完整视频帧`)
    const pixelAt = (frame, x, y) => [...decoded.subarray(frame * frameBytes + (y * 160 + x) * 3, frame * frameBytes + (y * 160 + x) * 3 + 3)]
    const close = (actual, expected, tolerance = 9) => actual.every((value, channel) => Math.abs(value - expected[channel]) <= tolerance)
    for (const [time, source] of [[1.75, [200, 40, 40]], [2.25, [40, 200, 200]]]) {
      // Browser capture is real time: match a nearby encoded frame, then infer
      // its opacity from the center before checking spatial edges separately.
      const candidates = [Math.round(time * 20) - 1, Math.round(time * 20), Math.round(time * 20) + 1]
      assert(candidates.some(frame => {
        const center = pixelAt(frame, 80, 45)
        const channel = time < 2 ? 0 : 1
        const alpha = (center[channel] - background[channel]) / (source[channel] - background[channel])
        if (alpha < .3 || alpha > .7) return false
        const foreground = source.map((value, index) => value * alpha + background[index] * (1 - alpha))
        return close(center, foreground)
          && close(pixelAt(frame, 20, 45), foreground)
          && close(pixelAt(frame, 4, 45), effect === 'zoom-fade-left' ? foreground : background)
          && close(pixelAt(frame, 156, 45), background)
      }), `${effect} 在 ${time} 秒导出后应保留 80%–100% 缩放、透明度与对应的方向边缘`)
    }
  }
  for (const effect of ['iris', 'diamond', 'blinds', 'flash-white', 'defocus', 'zoom-through', 'diagonal', 'radial'].filter(effect => result.exports[effect])) {
    const output = path.join(folder, `transition-browser-${effect}.webm`)
    await fs.writeFile(output, Buffer.from(result.exports[effect]))
    const decoded = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output, '-vf', 'fps=20', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 5e6 })
    const frameBytes = 160 * 90 * 3
    assert(decoded.length / frameBytes >= 70, `${effect} 必须实际导出完整视频`)
    for (const time of ['diagonal', 'radial'].includes(effect) ? [1.625, 1.75, 1.875, 2.125, 2.25, 2.375] : [1.75, 2.25]) {
      const source = time >= 2 ? [40, 200, 200] : [200, 40, 40]
      const points = effect === 'diagonal' ? [[16, 9], [48, 27], [112, 63], [144, 81]] : effect === 'radial' ? [[120, 22], [120, 67], [40, 67], [40, 22]] : effect === 'blinds' ? [[80, 46], [80, 53]] : effect === 'iris' || effect === 'diamond' ? [[80, 45], [4, 4]] : [[80, 45]]
      const candidates = [Math.round(time * 20) - 1, Math.round(time * 20), Math.round(time * 20) + 1]
      assert(candidates.some(frame => points.every(([x, y]) => {
        const model = effects[effect](x, y, Math.abs(time - 2) / .5), alpha = model.visible ? model.alpha ?? 1 : 0
        const expected = source.map((value, i) => value * alpha + (model.background || background)[i] * (1 - alpha))
        const at = frame * frameBytes + (y * 160 + x) * 3, actual = [...decoded.subarray(at, at + 3)]
        return actual.every((value, i) => Math.abs(value - expected[i]) <= 20)
      })), `${effect} 在 ${time} 秒导出后应包含对应的形状、柔光或透明度效果`)
    }
  }
  console.log(`PASS ${Object.keys(result.frames).length} 种转场双侧真实 Canvas 像素，${Object.keys(result.exports).length} 种效果的真实 WebM 导出并解码；文件 ${folder}`)
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await browser?.close(); server?.kill() })
