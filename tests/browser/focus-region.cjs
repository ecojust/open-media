const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), net = require('node:net')
const { chromium, expect } = require('@playwright/test')
let server, browser
async function startServer() {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' })
  const url = `http://127.0.0.1:${port}`
  for (let index = 0; index < 120; index++) { try { if ((await fetch(url)).ok) return url } catch {} await new Promise(resolve => setTimeout(resolve, 100)) }
  throw Error('测试服务未启动')
}
async function main() {
  const url = await startServer()
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.route('**/focus-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0}#app{position:relative;width:800px;height:600px;margin:40px;background:#151927}canvas{display:none}</style><div id="app"></div><canvas width="160" height="90"></canvas>' }))
  await page.goto(`${url}/focus-fixture`)
  await page.evaluate(async () => {
    const component = await import('/src/components/PreviewFocusRegion.vue')
    const source = await (await fetch('/src/components/PreviewFocusRegion.vue')).text(), vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, ref, shallowRef } = await import(vueImport)
    const { createProject, createClip } = await import('/src/core/project.ts')
    const project = createProject('重点框选', { width: 640, height: 360 })
    project.assets.push({ id: 'image', kind: 'image', name: '图片', url: 'blob:test', duration: 0, width: 320, height: 180, size: 1, mime: 'image/png' })
    project.tracks[1].clips = [createClip(project.assets[0], project, { id: 'clip', start: 0, trimOut: 5, x: 100, y: 50, width: 320, height: 180, crop: { x: .2, y: .2, width: .6, height: .6 }, fit: 'contain' })]
    const current = shallowRef(project), active = ref(true), time = ref(1)
    window.focusFixture = { current, active, time, selections: [], cancellations: 0 }
    createApp({ render: () => h(component.default, { project: current.value, clipId: 'clip', time: time.value, active: active.value, onSelect: region => window.focusFixture.selections.push(region), onCancel: () => { window.focusFixture.cancellations++; active.value = false } }) }).mount('#app')
  })
  await expect(page.getByTestId('preview-focus-region')).toBeVisible()
  // The 800×600 host contains an 800×450 project, with 75px of letterboxing on each side vertically.
  await page.mouse.move(50, 60); await page.mouse.down(); await page.mouse.move(200, 70); await page.mouse.up()
  assert.equal(await page.evaluate(() => window.focusFixture.selections.length), 0)
  await page.mouse.move(40 + (100 + 320 * .5) * 1.25, 40 + 75 + (50 + 180 * .25) * 1.25)
  await page.mouse.down(); await page.mouse.move(40 + (100 + 320) * 1.25, 40 + 75 + (50 + 180 * .75) * 1.25); await page.mouse.up()
  const picked = await page.evaluate(() => window.focusFixture.selections[0])
  for (const [key, value] of Object.entries({ x: .5, y: .25, width: .5, height: .5 })) assert(Math.abs(picked[key] - value) < 1e-6, `${key}: ${picked[key]}`)
  await page.evaluate(() => { const p = structuredClone(window.focusFixture.current.value); p.tracks[1].clips[0].rotation = 90; window.focusFixture.current.value = p })
  // Rotate local points around the clip center (260,140); the preview keeps the same letterbox projection.
  const start = { x: 260 + 45, y: 140 }, end = { x: 260 - 45, y: 140 + 160 }
  await page.mouse.move(40 + start.x * 1.25, 40 + 75 + start.y * 1.25); await page.mouse.down(); await page.mouse.move(40 + end.x * 1.25, 40 + 75 + end.y * 1.25); await page.mouse.up()
  const rotated = await page.evaluate(() => window.focusFixture.selections[1])
  for (const [key, value] of Object.entries({ x: .5, y: .25, width: .5, height: .5 })) assert(Math.abs(rotated[key] - value) < 1e-6, `rotated ${key}: ${rotated[key]}`)
  await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => window.focusFixture.cancellations), 1)
  await expect(page.getByTestId('preview-focus-region')).toHaveCount(0)
  console.log('PASS 预览真实留边投影、裁切后矩形、旋转框选与 Esc 取消')
  const result = await page.evaluate(async () => {
    const { createProject, createClip } = await import('/src/core/project.ts'), { TimelinePreview } = await import('/src/core/preview.ts')
    const { executeVisualTool } = await import('/src/core/visual-tools.ts'), { exportTimelineWebM } = await import('/src/core/browser-export.ts')
    const source = document.createElement('canvas'); source.width = 160; source.height = 90
    const ctx = source.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 80, 90); ctx.fillStyle = '#0000ff'; ctx.fillRect(80, 0, 80, 90)
    const project = createProject('聚焦预览与导出', { width: 160, height: 90, fps: 20, background: '#000000' })
    project.assets = [{ id: 'image', kind: 'image', name: '红蓝', url: source.toDataURL(), duration: 0, width: 160, height: 90, size: 1, mime: 'image/png' }]
    project.tracks[1].clips = [createClip(project.assets[0], project, { id: 'clip', trimOut: 2, volume: 0 })]
    const focused = executeVisualTool(project, 'focus_region', { clipId: 'clip', region: { x: .5, y: .25, width: .5, height: .5 }, start: .2, duration: .4, holdDuration: .4, returnDuration: .4 }).project
    const canvas = document.querySelector('canvas'), preview = new TimelinePreview(canvas, focused); await preview.prepare()
    const pixels = []
    for (const time of [.1, .8, 1.7]) { await preview.seekReady(time); preview.render(time); pixels.push([...canvas.getContext('2d').getImageData(20, 45, 1, 1).data]) }
    preview.dispose()
    const output = await exportTimelineWebM(focused, { fps: 20, videoBitsPerSecond: 1000000 })
    return { pixels, output: [...new Uint8Array(await output.arrayBuffer())] }
  })
  const red = pixel => pixel[0] > 180 && pixel[2] < 40, blue = pixel => pixel[2] > 180 && pixel[0] < 40
  assert(red(result.pixels[0]) && blue(result.pixels[1]) && red(result.pixels[2]), `实际预览像素 ${JSON.stringify(result.pixels)}`)
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'open-media-focus-')), file = path.join(folder, 'focus.webm')
  await fs.writeFile(file, Buffer.from(result.output))
  for (const [time, test] of [[.1, red], [.8, blue], [1.7, red]]) {
    const pixels = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', file, '-vf', 'crop=2:2:20:44,scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    assert(test(pixels), `真实导出 ${time}s 像素 ${[...pixels]}`)
  }
  console.log(`PASS 等比放大、停留、恢复的真实预览和真实导出像素一致：${file}`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await browser?.close(); server?.kill() })
