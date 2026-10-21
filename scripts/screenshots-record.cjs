// Capture the current application using an in-page demo stream, never a user's screen or microphone.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const root = path.resolve(__dirname, '..')
  const { createServer } = await import('vite')
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => dialog.accept())
    await page.addInitScript(() => {
      localStorage.setItem('open-media:theme', 'light')
      localStorage.setItem('open-media:autosave', 'false')
    })
    await page.goto(server.resolvedUrls.local[0])
    await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 30000 })
    await page.getByTestId('media-input').setInputFiles([
      ['轨道观测 · 开场.webm', 'science-orbital-atlas'],
      ['分子结构 · 解说.webm', 'science-molecular-chain'],
      ['地形扫描 · 演示.webm', 'science-terrain-horizon'],
      ['数据分析 · 结果.webm', 'science-data-field'],
    ].map(([name, file]) => ({ name, mimeType: 'video/webm', buffer: fs.readFileSync(path.join(root, `src/assets/science-segments/${file}.webm`)) })))
    await expect.poll(() => page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.project.assets.length)).toBe(4)
    await page.evaluate(async () => {
      await document.fonts.ready
      const canvas = document.createElement('canvas')
      canvas.width = 1280; canvas.height = 720
      const ctx = canvas.getContext('2d')
      let frame = 0
      const text = (value, x, y, size, color = '#e2edf7', weight = 400) => {
        ctx.fillStyle = color; ctx.font = `${weight} ${size}px sans-serif`; ctx.fillText(value, x, y)
      }
      const paint = () => {
        const time = frame++ / 30
        const gradient = ctx.createLinearGradient(0, 0, 1280, 720)
        gradient.addColorStop(0, '#0c1729'); gradient.addColorStop(1, '#163e51')
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1280, 720)
        ctx.strokeStyle = '#294459'; ctx.lineWidth = 1
        for (let x = 0; x < 1280; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 720); ctx.stroke() }
        for (let y = 0; y < 720; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1280, y); ctx.stroke() }
        ctx.fillStyle = '#0c1729d9'; ctx.fillRect(0, 0, 1280, 105)
        text('O R B I T   L A B', 52, 45, 18, '#69d8ca', 600)
        text('轨道观测站', 52, 82, 27, '#f0f6ff', 600)
        text('观测记录  /  实验数据  /  可视化', 843, 65, 20, '#99b5c8')
        text('看见引力的轨迹', 60, 206, 50, '#f6f4e9', 700)
        text('从一条轨道，理解宇宙的秩序。', 62, 253, 22, '#acc8d7')
        text('01  建立模型', 64, 325, 20, '#78e3ce', 600)
        text('调整轨道倾角、偏心率与运行周期', 64, 361, 19, '#b2c6d9')
        text('02  观察运动', 64, 420, 20, '#78e3ce', 600)
        text('跟踪卫星位置，记录关键观测时刻', 64, 456, 19, '#b2c6d9')
        ctx.save(); ctx.translate(924, 320)
        for (let i = 0; i < 6; i++) {
          ctx.save(); ctx.rotate(-0.58 + i * .22)
          ctx.strokeStyle = i % 2 ? '#d9bb7b99' : '#63cab999'; ctx.lineWidth = i === 3 ? 2.5 : 1
          ctx.beginPath(); ctx.ellipse(0, 0, 220, 60 + i * 18, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore()
        }
        const globe = ctx.createRadialGradient(-20, -35, 4, 0, 0, 98)
        globe.addColorStop(0, '#92d9d7'); globe.addColorStop(.45, '#397d91'); globe.addColorStop(1, '#132d4a')
        ctx.fillStyle = globe; ctx.beginPath(); ctx.arc(0, 0, 98, 0, Math.PI * 2); ctx.fill()
        ctx.strokeStyle = '#79beca66'
        for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.ellipse(0, i * 22, Math.sqrt(98 ** 2 - (i * 22) ** 2), 15, 0, 0, Math.PI * 2); ctx.stroke() }
        const angle = time * .23
        ctx.fillStyle = '#ffe3a6'; ctx.shadowColor = '#ffe3a6'; ctx.shadowBlur = 16
        ctx.beginPath(); ctx.arc(Math.cos(angle) * 220, Math.sin(angle) * 110, 7, 0, Math.PI * 2); ctx.fill(); ctx.restore()
        const cards = [['轨道周期', '96.4 min', '#74d6c1'], ['运行高度', '408 km', '#87b9ff'], ['倾角', '51.6°', '#e3c58e']]
        cards.forEach(([label, value, color], index) => {
          const x = 60 + index * 390
          ctx.fillStyle = '#12293eea'; ctx.beginPath(); ctx.roundRect(x, 542, 360, 124, 12); ctx.fill()
          text(label, x + 24, 578, 17, '#91acbe'); text(value, x + 24, 628, 32, color, 600)
          ctx.fillStyle = color; ctx.fillRect(x + 295, 574, 3, 52)
        })
      }
      paint()
      const timer = setInterval(paint, 1000 / 30)
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
        const stream = canvas.captureStream(30)
        const track = stream.getVideoTracks()[0], getSettings = track.getSettings.bind(track)
        Object.defineProperty(track, 'getSettings', { value: () => ({ ...getSettings(), displaySurface: 'monitor' }) })
        Object.defineProperty(track, 'label', { value: '轨道观测站 · 演示画布' })
        window.demoStream = stream
        return stream
      } })
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [] })
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new Error('截图示例禁止访问设备麦克风') } })
      window.stopDemoCanvas = () => { clearInterval(timer); window.demoStream?.getTracks().forEach(track => track.stop()) }
    })
    await page.getByTestId('nav-record').click()
    await page.getByLabel('开始倒计时').selectOption('0')
    await page.getByRole('switch', { name: /录制共享音频/ }).uncheck()
    await page.getByTestId('record-start').click()
    await expect(page.getByTestId('capture-picker')).toBeVisible()
    await page.getByTestId('picker-mode-screen').click()
    await page.getByTestId('capture-selection-stage').click({ position: { x: 500, y: 250 } })
    await page.getByTestId('capture-picker-microphone').click()
    await expect(page.getByTestId('capture-picker-microphone')).toHaveAttribute('aria-pressed', 'false')
    await page.getByTestId('capture-picker-confirm').click()
    await expect(page.getByTestId('recording-source')).toContainText('1280 × 720')
    await page.waitForTimeout(3500)
    for (const theme of ['light', 'dark']) {
      await page.getByTestId(`theme-${theme}`).click()
      await page.mouse.move(1650, 1030)
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(root, `docs/screenshots/record-${theme}.png`) })
    }
    await page.getByTestId('record-stop').click()
    await expect(page.getByTestId('record-start')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.project.assets.length)).toBe(5)
    const captured = await page.evaluate(async () => {
      const asset = document.querySelector('#app').__vue_app__._instance.setupState.project.assets.at(-1)
      const video = document.createElement('video'); video.muted = true; video.src = asset.url
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject })
      const result = { width: video.videoWidth, height: video.videoHeight, duration: asset.duration, bytes: (await (await fetch(asset.url)).blob()).size }
      video.removeAttribute('src'); video.load(); window.stopDemoCanvas()
      return result
    })
    assert.equal(captured.width, 1280); assert.equal(captured.height, 720)
    assert(captured.duration > 3 && captured.bytes > 1000)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ captured, screenshots: 2, devicesAccessed: false }))
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
