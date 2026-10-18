const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { chromium, expect } = require('@playwright/test')

function rgba(value) { return (value.match(/[\d.]+/g) || []).map(Number) }
function luminance(color) {
  const rgb = color.slice(0, 3).map(value => { const normalized = value / 255; return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4 })
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
}
async function material(locator, pseudo) {
  return locator.evaluate((element, pseudo) => {
    const style = getComputedStyle(element, pseudo)
    return { background: style.backgroundColor, text: style.color, blur: style.backdropFilter, prefixed: style.webkitBackdropFilter, prefixedSupported: CSS.supports('-webkit-backdrop-filter', 'blur(1px)') }
  }, pseudo)
}
async function checkPanel(locator, theme) {
  const style = await material(locator), background = rgba(style.background), foreground = rgba(style.text)
  assert(background.length === 4 && background[3] >= .9 && background[3] < 1, `面板应保留清晰文字的半透明底色：${style.background}`)
  assert.match(style.blur, /blur\(18px\).*saturate\(1\.3\)/)
  if (style.prefixedSupported) assert.equal(style.prefixed, style.blur)
  const a = luminance(background), b = luminance(foreground)
  assert((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, '弹窗正文对比度不足')
  assert.equal(background[0] < 100, theme === 'dark', '传送到 body 的弹窗应保留当前主题')
}
async function checkShade(locator, theme, pseudo) {
  const style = await material(locator, pseudo)
  assert.match(style.blur, /blur\(10px\).*saturate\(1\.15\)/)
  if (style.prefixedSupported) assert.equal(style.prefixed, style.blur)
  assert.equal(rgba(style.background)[3], theme === 'dark' ? .5 : .28)
  return style
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(15000)
  await page.addInitScript(() => {
    window.captureRequests = 0
    for (const method of ['getUserMedia', 'getDisplayMedia']) {
      Object.defineProperty(navigator.mediaDevices, method, { configurable: true, value: () => { window.captureRequests++; throw new Error('样式检查不得调用设备采集') } })
    }
  })
  try {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    await page.getByTestId('create-project').click()
    await page.getByRole('button', { name: '字幕', exact: true }).click()
    await page.getByLabel('字幕内容').fill('弹窗背景与主题检查')
    await page.getByLabel('字幕内容').press('Tab')
    for (const theme of ['light', 'dark']) {
      await page.getByTestId(`theme-${theme}`).click()
      await page.getByRole('button', { name: '关于 Open Media', exact: true }).click()
      const about = page.getByRole('dialog', { name: '关于 Open Media', exact: true })
      await expect(about).toBeVisible()
      await checkPanel(about, theme)
      const nativeShade = await checkShade(about, theme, '::backdrop')
      await page.screenshot({ path: `/tmp/open-media-dialog-glass-${theme}.png`, animations: 'disabled' })
      await page.keyboard.press('Escape'); await expect(about).not.toBeVisible()
      await page.getByRole('button', { name: '项目设置', exact: true }).click()
      const project = page.getByRole('dialog', { name: '项目设置', exact: true })
      await checkPanel(project, theme)
      assert.deepEqual(await checkShade(project, theme, '::backdrop'), nativeShade)
      await page.getByRole('button', { name: '关闭项目设置', exact: true }).click()
      await page.evaluate(() => { document.querySelector('#app').__vue_app__._instance.setupState.jobsOpen = true })
      await checkPanel(page.locator('.jobs-dialog'), theme)
      const jobsShade = await checkShade(page.locator('.modal-shade'), theme)
      assert.equal(jobsShade.background, nativeShade.background)
      await page.getByRole('button', { name: '关闭任务', exact: true }).click()
      await page.getByRole('button', { name: '轨道操作', exact: true }).first().click()
      await page.getByRole('menuitem', { name: '删除轨道', exact: true }).click()
      const deleted = page.getByRole('dialog', { name: '删除轨道', exact: true })
      await expect(deleted).toBeVisible(); await checkPanel(deleted, theme)
      const deletedShade = await checkShade(page.locator('body > .track-delete-backdrop'), theme)
      assert.equal(deletedShade.background, nativeShade.background)
      await page.screenshot({ path: `/tmp/open-media-dialog-glass-track-${theme}.png`, animations: 'disabled' })
      await deleted.getByRole('button', { name: '取消', exact: true }).click()
      await page.getByTestId('preview-record-source').click()
      const microphone = page.getByTestId('preview-record-source-panel')
      await expect(microphone).toBeVisible(); await checkPanel(microphone, theme)
      await page.getByRole('button', { name: '关闭麦克风来源', exact: true }).click()
      const normal = await page.locator('.video-editor,.asset-panel,.property-panel,.preview-stage').evaluateAll(elements => elements.map(element => ({ filter: getComputedStyle(element).filter, backdrop: getComputedStyle(element).backdropFilter })))
      assert(normal.length >= 3 && normal.every(style => style.filter === 'none' && style.backdrop === 'none'), '非弹窗页面和预览不能被模糊')
      console.log(`PASS ${theme}：原生弹窗、普通遮罩、传送弹窗及麦克风浮层材质一致，文字清晰且关闭交互正常`)
    }
    await page.evaluate(async () => {
      const vueUrl = performance.getEntriesByType('resource').find(entry => /\/node_modules\/\.vite\/deps\/vue\.js\?/.test(entry.name))?.name
      if (!vueUrl) throw new Error('无法找到当前页面的组件运行时')
      const { createApp, h } = await import(vueUrl)
      const CaptureSelectionOverlay = (await import('/src/components/CaptureSelectionOverlay.vue')).default
      const host = document.createElement('div'); document.body.append(host)
      const context = { requestId: 'style-fixture', displayId: 'display', display: { id: 'display', name: '样式检查', logicalWidth: 1280, logicalHeight: 720, pixelWidth: 1280, pixelHeight: 720 }, targets: [{ id: 'screen', name: '屏幕样例', kind: 'screen', rect: { x: 0, y: 0, width: 1280, height: 720 }, sourceWidth: 1280, sourceHeight: 720 }], preferences: { purpose: 'screenshot', mode: 'screen' } }
      window.captureStyleFixture = createApp({ render: () => h(CaptureSelectionOverlay, { context, embedded: true, purpose: 'screenshot' }, { default: () => h('div', { style: 'width:100%;height:100%;background:repeating-linear-gradient(90deg,#222 0px,#222 1px,#fff 1px,#fff 10px)' }) }) })
      window.captureStyleFixture.mount(host)
    })
    await expect(page.getByTestId('capture-picker')).toBeVisible()
    await checkPanel(page.locator('.selection-toolbar'), 'light')
    const capture = await page.locator('.capture-selection-stage,.selection-background').evaluateAll(elements => elements.map(element => ({ filter: getComputedStyle(element).filter, backdrop: getComputedStyle(element).backdropFilter })))
    assert(capture.length >= 2 && capture.every(style => style.filter === 'none' && style.backdrop === 'none'), '截图/录屏选择底图必须保持清晰')
    await page.evaluate(() => window.captureStyleFixture.unmount())
    assert.equal(await page.evaluate(() => window.captureRequests), 0)
    assert.deepEqual(errors, [])
    console.log('PASS 框选工具栏使用半透明玻璃表面，选择画面保持清晰，全程未调用屏幕或麦克风采集')
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
