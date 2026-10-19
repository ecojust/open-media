const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-text-layout-'))
  const server = await createServer({ root: path.resolve(__dirname, '../..'), cacheDir, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), args: ['--no-sandbox'] })
    const page = await browser.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__text_layout', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>字幕布局缓存像素校验</title>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__text_layout`)
    const report = await page.evaluate(async () => {
      const { drawTextClip } = await import('/src/core/preview.ts')
      const { createTextClip } = await import('/src/core/project.ts')
      const { TextLayoutCache } = await import('/src/core/text-layout.ts')
      const cache = new TextLayoutCache()
      const contexts = [0, 1].map(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; return c.getContext('2d', { willReadFrequently: true }) })
      const [cached, reference] = contexts
      let measurements = 0
      const measure = cached.measureText.bind(cached)
      cached.measureText = (...args) => { measurements++; return measure(...args) }
      const original = createTextClip({ width: 640, height: 360 }, { width: 400, height: 300, fontSize: 30, text: '多行字幕缓存验证\nReadable science and technology\n第二段 longer words', background: '#354b72' })
      const cases = []
      function compare(name, clip) {
        contexts.forEach(ctx => ctx.clearRect(0, 0, 640, 360))
        drawTextClip(cached, clip, cache); drawTextClip(reference, clip)
        const actual = cached.getImageData(0, 0, 640, 360).data, expected = reference.getImageData(0, 0, 640, 360).data
        let mismatches = 0, hash = 2166136261, visiblePixels = 0
        for (let i = 0; i < actual.length; i++) { if (actual[i] !== expected[i]) mismatches++; hash = Math.imul(hash ^ actual[i], 16777619); if (i % 4 === 3 && actual[i]) visiblePixels++ }
        const result = { name, mismatches, hash: hash >>> 0, visiblePixels }; cases.push(result); return result
      }
      try {
        compare('首次绘制', original)
        const warm = measurements
        for (let i = 0; i < 120; i++) drawTextClip(cached, original, cache)
        const reusedMeasurements = measurements - warm
        for (const horizontal of ['left', 'center', 'right']) for (const vertical of ['top', 'middle', 'bottom']) {
          compare(`${horizontal}-${vertical}`, { ...original, textAlign: horizontal, textVerticalAlign: vertical })
        }
        compare('编辑文本', { ...original, text: '修改后\nDifferent content' })
        compare('缩窄框', { ...original, width: 210 })
        compare('拉高框', { ...original, height: 350, textVerticalAlign: 'bottom' })
        compare('字体字号', { ...original, fontFamily: 'serif', fontSize: 42, fontWeight: 400 })
        compare('文字颜色', { ...original, color: '#e0a0ff' })
        compare('透明背景', { ...original, background: 'transparent' })
        compare('水印底板', { ...original, textRole: 'watermark' })
        compare('撤销修改', original)
        const fontClip = { ...original, fontFamily: 'LayoutFixture, monospace', fontWeight: 400 }
        const fallback = compare('字体加载前', fontClip)
        const face = new FontFace('LayoutFixture', 'local("Arial"), local("Liberation Sans"), local("DejaVu Sans")')
        document.fonts.add(face); await face.load(); await document.fonts.ready
        const loaded = compare('字体加载后', fontClip)
        let adjustedHash, adjustmentMeasurements
        if ('sizeAdjust' in face) {
          const before = measurements
          face.sizeAdjust = '130%'
          adjustedHash = compare('已加载字体原位调整尺寸', fontClip).hash
          adjustmentMeasurements = measurements - before
        }
        const replacement = new FontFace('LayoutFixture', 'local("Times New Roman"), local("Liberation Serif"), local("DejaVu Serif")')
        await replacement.load()
        document.fonts.delete(face); document.fonts.add(replacement)
        const replaced = compare('已加载字体原位替换', fontClip)
        document.fonts.delete(replacement)
        compare('移除字体恢复后备', fontClip)
        return { cases, reusedMeasurements, fallbackHash: fallback.hash, loadedHash: loaded.hash, adjustedHash, adjustmentMeasurements, replacementHash: replaced.hash }
      } finally { cache.dispose() }
    })
    report.environment = { platform: process.platform, arch: process.arch, node: process.version, browser: browser.version() }
    if (process.env.OPEN_MEDIA_PERFORMANCE_REPORT) {
      fs.mkdirSync(process.env.OPEN_MEDIA_PERFORMANCE_REPORT, { recursive: true })
      fs.writeFileSync(path.join(process.env.OPEN_MEDIA_PERFORMANCE_REPORT, 'text-layout.json'), JSON.stringify(report, null, 2))
    }
    assert.deepEqual(errors, [])
    assert.equal(report.reusedMeasurements, 0, '连续绘制应复用布局，不重复调用文字测量')
    for (const item of report.cases) {
      assert.equal(item.mismatches, 0, `${item.name} 的缓存画面须与直接绘制逐像素一致`)
      assert(item.visiblePixels > 100, `${item.name} 必须实际显示字幕`)
    }
    assert.notEqual(report.loadedHash, report.fallbackHash, '真实字体加载应改变画面')
    // Engines differ on applying a changed descriptor to an already-loaded
    // face. The cache must remeasure and match direct painting in either case.
    if (report.adjustedHash !== undefined) assert(report.adjustmentMeasurements > 0, '原位调整字体描述符必须使旧布局失效')
    assert.notEqual(report.replacementHash, report.loadedHash, '同数量字体替换应改变画面并重新布局')
    console.log(`PASS 字幕布局缓存、编辑和撤销、字体加载与替换逐像素校验：${JSON.stringify(report)}`)
  } finally { await browser?.close(); await server.close(); fs.rmSync(cacheDir, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
