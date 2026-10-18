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
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'open-media-transitions-'))
  for (const [name, color] of [['red', '0xc82828'], ['cyan', '0x28c8c8']]) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=20:d=2`, '-c:v', 'libvpx', '-threads', '1', '-b:v', '250k', path.join(folder, `${name}.webm`)])
  }
  const baseURL = await startServer()
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage()
  await page.route('**/transition-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><canvas id="preview" width="160" height="90"></canvas></body></html>' }))
  for (const name of ['red', 'cyan']) {
    const body = await fs.readFile(path.join(folder, `${name}.webm`))
    await page.route(`**/transition-${name}.webm`, route => route.fulfill({ contentType: 'video/webm', body }))
  }
  await page.goto(`${baseURL}/transition-fixture`)
  const result = await page.evaluate(async () => {
    const { createProject, createClip, validateProject } = await import('/src/core/project.ts')
    const { addTransition, TRANSITION_PRESETS } = await import('/src/core/transitions.ts')
    const { TimelinePreview } = await import('/src/core/preview.ts')
    const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
    const project = createProject('转场真实画面验证', { width: 160, height: 90, fps: 20, background: '#102030' })
    project.assets = await Promise.all(['red', 'cyan'].map(async id => ({ id, kind: 'video', name: `${id}.webm`, url: URL.createObjectURL(await (await fetch(`/transition-${id}.webm`)).blob()), duration: 2, width: 160, height: 90, mime: 'video/webm', size: 100 })))
    project.tracks[1].clips = project.assets.map((asset, index) => createClip(asset, project, { id: `${asset.id}-clip`, start: index * 2, trimOut: 2, volume: 0 }))
    const source = validateProject(project, { trusted: true })
    const canvas = document.querySelector('canvas'), preview = new TimelinePreview(canvas, source)
    const points = [[16, 9], [48, 27], [80, 45], [112, 63], [144, 81], [16, 81], [144, 9]]
    const pixels = () => points.map(([x, y]) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data])
    await preview.prepare()
    const frames = {}
    for (const { id } of TRANSITION_PRESETS) {
      const next = addTransition(source, 2, id, 1)
      preview.setProject(next)
      frames[id] = []
      for (const time of [1.75, 2.25]) {
        await preview.seekReady(time)
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        preview.render(time)
        frames[id].push(pixels())
      }
    }
    preview.dispose()
    const output = await exportTimelineWebM(addTransition(source, 2, 'fade', 1), { fps: 20, videoBitsPerSecond: 1000000 })
    return { frames, points, bytes: [...new Uint8Array(await output.arrayBuffer())] }
  })
  const background = [16, 32, 48]
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
    zoom: (x, y) => ({ visible: x >= 40 && x < 120 && y >= 22.5 && y < 67.5, alpha: 0.5 }),
  }
  for (const [effect, frames] of Object.entries(result.frames)) for (const [side, pixels] of frames.entries()) {
    const source = side ? [40, 200, 200] : [200, 40, 40]
    pixels.forEach((pixel, index) => {
      const transform = effects[effect](...result.points[index])
      const alpha = transform.visible ? transform.alpha ?? 1 : 0
      const expected = source.map((value, channel) => value * alpha + background[channel] * (1 - alpha))
      assert(pixel.slice(0, 3).every((value, channel) => Math.abs(value - expected[channel]) <= 5), `${effect} side=${side} point=${result.points[index]} actual=${pixel} expected=${expected}`)
    })
  }
  const output = path.join(folder, 'transition-browser-export.webm')
  await fs.writeFile(output, Buffer.from(result.bytes))
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }))
  assert(probe.streams.some(stream => stream.codec_type === 'video' && stream.width === 160 && stream.height === 90))
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output, '-vf', 'fps=20,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e6 })
  const luminance = []
  for (let i = 0; i < raw.length; i += 3) luminance.push(raw[i] + raw[i + 1] + raw[i + 2])
  assert(luminance.length >= 70, '导出必须包含完整视频帧')
  const cut = luminance.slice(30, 51)
  assert(Math.min(...cut) < 140, `导出应实际淡出至项目背景色：${cut}`)
  assert(luminance.slice(0, 25).some(value => value > 250) && luminance.slice(55).some(value => value > 400), '切点前后必须保留两段实际视频')
  console.log(`PASS 10 种转场双侧真实 Canvas 像素 + 浏览器 WebM 导出并解码验证；文件 ${output}`)
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await browser?.close(); server?.kill() })
