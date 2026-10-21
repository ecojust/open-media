// Reproducible documentation scenes. Native directory/platform IPC is a fixture;
// source videos are genuinely encoded and decoded, with no simulated export results.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'docs/screenshots')
const scenes = [
  { id: 'opening', name: '星海观察 · 开场.webm', title: '从一束光，看见宇宙', subtitle: 'LIGHT / SPACE / DISCOVERY', color: '#a995ff', heading: '星海观察', number: '01', directory: 'recordings' },
  { id: 'orbit', name: '轨道运动 · 示意.webm', title: '每一次绕行，都有规律', subtitle: 'MOTION / GRAVITY / ORBIT', color: '#72e1cf', heading: '轨道运动', number: '02', directory: 'import video' },
  { id: 'spectrum', name: '光谱分析 · 演示.webm', title: '让不可见，成为线索', subtitle: 'SPECTRUM / COLOR / ENERGY', color: '#ffba80', heading: '光谱分析', number: '03', directory: 'recordings' },
  { id: 'ending', name: '探索笔记 · 结尾.webm', title: '保持好奇，继续探索', subtitle: 'OBSERVE / QUESTION / CREATE', color: '#81b8ff', heading: '探索笔记', number: '04', directory: 'import video' },
]

async function makePoster(page, scene, destination) {
  await page.setContent('<html><body style="margin:0"><canvas width="1280" height="720"></canvas></body></html>')
  await page.evaluate(scene => {
    const canvas = document.querySelector('canvas'), c = canvas.getContext('2d')
    const background = c.createLinearGradient(0, 0, 1280, 720)
    background.addColorStop(0, '#111527'); background.addColorStop(1, '#182039')
    c.fillStyle = background; c.fillRect(0, 0, 1280, 720)
    c.strokeStyle = '#ffffff0a'; c.lineWidth = 1
    for (let x = 0; x < 1280; x += 40) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 720); c.stroke() }
    for (let y = 0; y < 720; y += 40) { c.beginPath(); c.moveTo(0, y); c.lineTo(1280, y); c.stroke() }
    for (let i = 0; i < 100; i++) { const x = (i * 277 + 97) % 1280, y = (i * 181 + 73) % 720; c.fillStyle = i % 3 ? '#b9c5ec70' : '#ffffff'; c.beginPath(); c.arc(x, y, i % 8 === 0 ? 1.7 : .7, 0, Math.PI * 2); c.fill() }
    const glow = c.createRadialGradient(920, 320, 10, 920, 320, 340)
    glow.addColorStop(0, scene.color + '55'); glow.addColorStop(1, scene.color + '00')
    c.fillStyle = glow; c.fillRect(560, 0, 720, 720)
    c.save(); c.translate(920, 315); c.rotate(-.33)
    c.strokeStyle = scene.color + '66'; c.lineWidth = 1.4
    for (const scale of [1, 1.24, 1.48]) { c.beginPath(); c.ellipse(0, 0, 197 * scale, 64 * scale, 0, 0, Math.PI * 2); c.stroke() }
    c.restore()
    const sphere = c.createRadialGradient(875, 255, 10, 930, 340, 150)
    sphere.addColorStop(0, '#f5e9ff'); sphere.addColorStop(.23, scene.color); sphere.addColorStop(.72, '#51488e'); sphere.addColorStop(1, '#141b34')
    c.fillStyle = sphere; c.beginPath(); c.arc(920, 315, 126, 0, Math.PI * 2); c.fill()
    c.strokeStyle = scene.color + 'bb'; c.lineWidth = 2; c.beginPath(); c.ellipse(920, 315, 265, 85, -.33, 0, Math.PI); c.stroke()
    c.fillStyle = '#f2f4ff'; c.beginPath(); c.arc(672, 391, 8, 0, Math.PI * 2); c.fill()
    c.fillStyle = scene.color; c.fillRect(64, 67, 30, 4)
    c.font = '500 20px sans-serif'; c.fillText('OPEN MEDIA  /  VISUAL NOTES', 110, 76)
    c.font = '500 19px sans-serif'; c.fillText(scene.subtitle, 64, 230)
    c.font = '700 72px sans-serif'; c.fillStyle = '#f4f6ff'; c.fillText(scene.heading, 60, 327)
    c.font = '400 28px sans-serif'; c.fillStyle = '#bac4df'; c.fillText(scene.title, 64, 387)
    c.fillStyle = scene.color; c.fillRect(64, 425, 64, 3)
    c.font = '400 18px sans-serif'; c.fillStyle = '#a4aec7'; c.fillText('光的故事 · 原创动态示意', 64, 472)
    c.strokeStyle = '#ffffff20'; c.beginPath(); c.moveTo(64, 591); c.lineTo(1216, 591); c.stroke()
    for (const [i, caption] of ['观察现象', '理解规律', '提出问题'].entries()) { c.fillStyle = scene.color; c.font = '600 17px sans-serif'; c.fillText(`0${i + 1}`, 64 + i * 224, 637); c.fillStyle = '#e1e5f4'; c.font = '400 18px sans-serif'; c.fillText(caption, 98 + i * 224, 637) }
    c.textAlign = 'right'; c.font = '400 19px sans-serif'; c.fillStyle = '#99a5c2'; c.fillText(`CHAPTER ${scene.number} / 04`, 1216, 637)
  }, scene)
  const data = await page.locator('canvas').evaluate(canvas => canvas.toDataURL('image/png').split(',')[1])
  fs.writeFileSync(destination, Buffer.from(data, 'base64'))
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-doc-libraries-'))
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] })
  let server
  try {
    const painter = await browser.newPage()
    for (const scene of scenes) {
      const poster = path.join(temp, `${scene.id}.png`), file = path.join(temp, `${scene.id}.webm`)
      await makePoster(painter, scene, poster)
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', poster, '-t', '12', '-vf', "zoompan=z='min(zoom+0.0005,1.08)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=960x540:fps=15", '-r', '15', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '2', '-b:v', '500k', '-pix_fmt', 'yuv420p', '-an', file])
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]))
      scene.size = fs.statSync(file).size; scene.duration = Number(probe.format.duration)
      assert.equal(probe.streams[0].width, 960); assert.equal(probe.streams[0].height, 540)
      assert.ok(scene.duration >= 11.9)
    }
    await painter.close()
    const { createServer } = await import('vite')
    server = await createServer({ root, server: { host: '127.0.0.1', port: Number(process.env.SCREENSHOT_PORT || 5238), strictPort: true, hmr: false, watch: null }, logLevel: 'error' })
    await server.listen()
    const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__doc_video__/*', route => {
      const id = new URL(route.request().url()).pathname.split('/').pop()
      return route.fulfill({ contentType: 'video/webm', body: fs.readFileSync(path.join(temp, `${id}.webm`)) })
    })
    await page.addInitScript(scenes => {
      localStorage.setItem('open-media:autosave', 'false')
      localStorage.setItem('open-media:theme', 'light')
      let callbackId = 0
      const assets = scenes.map((scene, index) => ({ id: scene.id, name: scene.name, kind: 'video', url: '', nativePath: `/${scene.directory}/${scene.id}.webm`, size: scene.size, duration: scene.duration, width: 960, height: 540, mime: 'video/webm', addedAt: Date.UTC(2026, 9, 21, 9, 0, 4 - index) }))
      window.documentationLibrary = { unexpected: [] }
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => ++callbackId, unregisterCallback() {},
        convertFileSrc: value => `${location.origin}/__doc_video__/${value.split('/').pop().replace('.webm', '')}`,
        invoke: async (command, args = {}) => {
          if (command === 'get_desktop_platform') return 'macos'
          if (command === 'plugin:event|listen') return ++callbackId
          if (['plugin:event|unlisten', 'plugin:window|set_theme', 'plugin:window|set_background_color', 'plugin:webview|set_webview_background_color', 'mcp_stop'].includes(command)) return null
          if (command === 'configure_screenshot_shortcut') return args.shortcut
          if (command === 'get_media_jobs' || command === 'mcp_pending') return []
          if (command === 'ai_get_status') return { models: [], jobs: [], busy: false }
          if (command === 'get_runtime_status') return { ready: true, version: 'documentation-scene' }
          if (command === 'mcp_get_status') return { running: false, connectedClients: 0, pendingRequests: 0 }
          if (command === 'list_stored_videos') return { directory: '/recordings', importDirectory: args.includeImported ? '/import video' : null, assets: assets.filter(asset => args.includeImported || asset.nativePath.startsWith('/recordings/')), warnings: [] }
          window.documentationLibrary.unexpected.push(command)
          throw new Error(`Unexpected documentation IPC: ${command}`)
        },
      }
    }, scenes)
    await page.goto(server.resolvedUrls.local[0])
    await page.getByTestId('home-workspace').waitFor()
    await page.getByTestId('nav-gif').click()
    await expect(page.locator('[data-source-asset-id]')).toHaveCount(4)
    await expect.poll(() => page.getByLabel('GIF 来源视频预览').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(4)
    await page.getByLabel('GIF 来源视频预览').evaluate(async video => { await video.play(); await new Promise(resolve => setTimeout(resolve, 250)); video.pause(); video.currentTime = .5 })
    await expect.poll(() => page.getByLabel('GIF 来源视频预览').evaluate(video => video.seeking)).toBe(false)
    await page.waitForTimeout(800)
    for (let i = 0; i < 2; i++) await page.getByRole('button', { name: '添加片段', exact: true }).click()
    for (const [i, values] of [[.5, 2.5], [4, 6], [8, 10]].entries()) {
      await page.getByLabel('开始时间', { exact: true }).nth(i).fill(String(values[0]))
      await page.getByLabel('结束时间', { exact: true }).nth(i).fill(String(values[1]))
    }
    await page.getByLabel('输出宽度').selectOption('640')
    await page.getByLabel('帧率').selectOption('15')
    await expect(page.locator('.output-summary')).toContainText('6.00 秒')
    for (const theme of ['light', 'dark']) {
      await page.getByTestId(`theme-${theme}`).click()
      await page.mouse.move(5, 5); await page.waitForTimeout(250)
      await page.screenshot({ path: path.join(output, `gif-${theme}.png`) })
    }
    await page.getByTestId('nav-video').click()
    await expect(page.locator('[data-source-asset-id]')).toHaveCount(4)
    await page.getByRole('button', { name: '全选', exact: true }).click()
    await page.getByTestId('convert-format').selectOption('mp4')
    await page.getByLabel('分辨率').selectOption('720')
    await page.getByLabel('编码质量').selectOption('high')
    await page.getByLabel('截取指定时间段', { exact: true }).check()
    await page.getByLabel('起点 · 秒', { exact: true }).fill('1.5')
    await page.getByLabel('终点 · 秒', { exact: true }).fill('10.5')
    await expect.poll(() => page.locator('.preview-stage video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(4)
    await page.locator('.preview-stage video').evaluate(async video => { await video.play(); await new Promise(resolve => setTimeout(resolve, 250)); video.pause(); video.currentTime = 1.5 })
    await expect.poll(() => page.locator('.preview-stage video').evaluate(video => video.seeking)).toBe(false)
    await page.waitForTimeout(800)
    for (const theme of ['light', 'dark']) {
      await page.getByTestId(`theme-${theme}`).click()
      await page.mouse.move(5, 5); await page.waitForTimeout(250)
      await page.screenshot({ path: path.join(output, `video-convert-${theme}.png`) })
    }
    assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.documentationLibrary.unexpected), [])
    console.log('Captured current full application: 4 genuine decoded videos, 3 GIF ranges / 6 s / 90 frames, batch conversion settings. Native directories are fixtures; no conversion completion is simulated.')
  } finally { await browser.close(); await server?.close(); fs.rmSync(temp, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
