const assert = require('node:assert/strict')
const { chromium } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const probe = require('node:net').createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null }, logLevel: 'error' })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage()
    const external = []
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.href); return route.abort() }
      if (url.pathname === '/__ocr__') return route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' blob: data:" }, body: '<!doctype html><html><body></body></html>' })
      return route.continue()
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__ocr__`)
    const result = await page.evaluate(async () => {
      const { recognizeImageText } = await import('/src/core/image-ocr.ts')
      const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 200
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1000, 200)
      ctx.fillStyle = 'black'; ctx.font = '52px sans-serif'; ctx.fillText('Open Media 2026', 50, 85)
      const progress = []
      const output = await recognizeImageText(canvas, 'en', { signal: new AbortController().signal, onProgress: update => progress.push(update) })
      const controller = new AbortController(); controller.abort()
      let cancelled = false
      try { await recognizeImageText(canvas, 'en', { signal: controller.signal, onProgress() {} }) } catch (error) { cancelled = error.name === 'AbortError' }
      const chineseCanvas = document.createElement('canvas'); chineseCanvas.width = 1100; chineseCanvas.height = 180
      const chineseContext = chineseCanvas.getContext('2d'); chineseContext.fillStyle = 'white'; chineseContext.fillRect(0, 0, 1100, 180)
      chineseContext.fillStyle = 'black'; chineseContext.font = '52px "Noto Sans CJK SC", sans-serif'; chineseContext.fillText('视频剪辑与字幕编辑', 40, 90)
      const chinese = await recognizeImageText(chineseCanvas, 'zh-en', { signal: new AbortController().signal, onProgress() {} })
      return { output, chinese, progress, cancelled }
    })
    assert.match(result.output.text, /Open\s+Media\s+2026/)
    const actualChinese = result.chinese.text.replace(/\s/g, ''), expectedChinese = '视频剪辑与字幕编辑'
    const costs = Array.from({ length: expectedChinese.length + 1 }, (_, index) => index)
    for (let i = 1; i <= actualChinese.length; i++) { let previous = costs[0]; costs[0] = i; for (let j = 1; j <= expectedChinese.length; j++) { const old = costs[j]; costs[j] = Math.min(costs[j] + 1, costs[j - 1] + 1, previous + (actualChinese[i - 1] === expectedChinese[j - 1] ? 0 : 1)); previous = old } }
    assert(costs.at(-1) <= 1, `Chinese recognition character error exceeded the fixture tolerance: ${actualChinese}`)
    assert(result.chinese.lines.length > 0)
    assert(result.output.confidence > .8)
    assert(result.output.words.length >= 3)
    assert(result.output.words.every(word => word.bounds.width > 0 && word.bounds.height > 0))
    assert(result.progress.some(item => item.progress === 1))
    assert(result.cancelled)
    assert.deepEqual(external, [], 'OCR must load its worker, core and language model locally')
    console.log('PASS 内置离线文字识别、单词区域与置信度、任务取消及生产内容安全策略')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
