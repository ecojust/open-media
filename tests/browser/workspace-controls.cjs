const assert = require('node:assert/strict')
const { existsSync, mkdirSync } = require('node:fs')
const { chromium } = require('@playwright/test')
// Mount actual application workspaces and dialogs; no capture or production build is started.
const checks = []
async function inspect(page, label, min = 1) {
  const values = await page.locator('select:visible').evaluateAll(elements => elements.map(element => {
    const css = getComputedStyle(element)
    return { label: element.getAttribute('aria-label') || element.closest('label')?.textContent?.slice(0, 30), height: element.getBoundingClientRect().height, appearance: css.appearance, font: css.fontSize, top: css.paddingTop, bottom: css.paddingBottom, left: css.paddingLeft, right: css.paddingRight, radius: css.borderRadius, image: css.backgroundImage, disabled: element.matches(':disabled'), opacity: css.opacity, cursor: css.cursor, background: css.backgroundColor, color: css.color }
  }))
  assert(values.length >= min, `${label}: expected at least ${min} controls, got ${values.length}`)
  for (const value of values) {
    assert.equal(value.height, 32, `${label} height ${JSON.stringify(value)}`)
    assert.equal(value.appearance, 'none', `${label} appearance`)
    assert.equal(value.font, '12px', `${label} font ${JSON.stringify(value)}`)
    assert.equal(value.top, '0px', `${label} padding top`)
    assert.equal(value.bottom, '0px', `${label} padding bottom`)
    assert.equal(value.left, '9px', `${label} padding left`)
    assert.equal(value.right, '30px', `${label} padding right`)
    assert.equal(value.radius, '6px', `${label} border radius`)
    assert.match(value.image, /data:image\/svg\+xml/, `${label} SVG arrow`)
    if (value.disabled) { assert.equal(value.opacity, '0.6'); assert.equal(value.cursor, 'not-allowed') }
  }
  const modalControls = page.locator('dialog[open] select:visible:enabled, .export-dialog select:visible:enabled')
  const focusable = await modalControls.count() ? modalControls.first() : page.locator('select:visible:enabled').first()
  if (await focusable.count()) {
    await focusable.focus()
    const outline = await focusable.evaluate(element => { const s = getComputedStyle(element); return [s.outlineWidth, s.outlineStyle] })
    assert.deepEqual(outline, ['2px', 'solid'], `${label} focus indicator`)
  }
  checks.push({ label, count: values.length, colors: [...new Set(values.map(v => `${v.color}/${v.background}`))] })
}
async function mount(page, base, component, props, theme = 'light') {
  await page.goto(`${base}/__controls__`)
  await page.evaluate(async ({ component, props, theme }) => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/' + component + '.vue')).text()
    const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h } = await import(vueImport)
    const Component = (await import('/src/components/' + component + '.vue')).default
    if (component === 'ExportPanel') props.project = (await import('/src/core/project.ts')).createProject()
    createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': theme }, [h(Component, props)]) }).mount('#app')
  }, { component, props, theme })
}
async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(10000)
    mkdirSync('test-results/browser', { recursive: true })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__controls__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>' }))
    for (const theme of ['light', 'dark']) {
      await page.goto(base)
      await page.evaluate(theme => { localStorage.clear(); localStorage.setItem('open-media:theme', theme) }, theme)
      await page.reload()
      await page.getByTestId('create-record').waitFor()
      const order = ['record', 'gif', 'edit', 'video', 'image']
      assert.deepEqual(await page.locator('[data-testid^="nav-"]').evaluateAll(nodes => nodes.map(n => n.dataset.testid.replace('nav-', ''))), order)
      assert.deepEqual(await page.locator('.workspace-cards [data-testid^="create-"]').evaluateAll(nodes => nodes.map(n => n.dataset.testid.replace('create-', ''))), order)
      for (const workspace of ['record', 'gif', 'video', 'image']) {
        await page.getByTestId(`nav-${workspace}`).click()
        await inspect(page, `${theme} ${workspace}`)
      }
      const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
        const context = canvas.getContext('2d'); context.fillStyle = '#f14354'; context.fillRect(0, 0, 160, 90)
        return canvas.toDataURL('image/png').split(',')[1]
      })
      await page.getByTestId('media-input').setInputFiles({ name: '样式检查.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') })
      await page.getByTestId('image-crop-open').click()
      await inspect(page, `${theme} image crop dialog`, 4)
      await page.setViewportSize({ width: 420, height: 900 })
      await inspect(page, `${theme} image crop dialog width 420`, 2)
      await page.getByRole('button', { name: '关闭框选裁剪', exact: true }).click()
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.getByTestId('nav-edit').click()
      await page.locator('.asset-card').first().dblclick()
      await inspect(page, `${theme} editor image`, 2)
      await page.getByTitle('添加字幕', { exact: true }).click()
      await inspect(page, `${theme} editor text`, 4)
      await page.getByRole('button', { name: '项目设置', exact: true }).click()
      await inspect(page, `${theme} project dialog`, 6)
      await page.getByRole('button', { name: '关闭项目设置', exact: true }).click()
      await page.getByTestId('export-project').click()
      await inspect(page, `${theme} export dialog`, 7)
      await page.screenshot({ path: `test-results/browser/workspace-controls-${theme}.png` })
      for (const width of [800, 420]) {
        await page.setViewportSize({ width, height: 900 })
        await inspect(page, `${theme} export dialog width ${width}`, 3)
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await mount(page, base, 'ConvertWorkspace', { assets: [], mode: 'video', native: true }, theme)
      await inspect(page, `${theme} native video settings`, 6)
      await mount(page, base, 'ExportPanel', { open: true, native: true }, theme)
      await inspect(page, `${theme} native export settings`, 4)
      await mount(page, base, 'CaptureSelectionOverlay', { embedded: true, context: { requestId: 'style-check', displayId: 'screen:1', display: { id: 'screen:1', name: '屏幕', logicalWidth: 1280, logicalHeight: 800, pixelWidth: 1280, pixelHeight: 800 }, targets: [{ id: 'screen:1', name: '屏幕', kind: 'screen', rect: { x: 0, y: 0, width: 1280, height: 800 }, sourceWidth: 1280, sourceHeight: 800 }], preferences: { mode: 'region' } } }, theme)
      await inspect(page, `${theme} capture overlay`, 1)
    }
    assert.deepEqual(errors, [])
    console.log(`PASS 首页与侧栏顺序一致；${checks.length} 组实际工作区、弹窗与采集覆盖页样式检查，共 ${checks.reduce((sum, row) => sum + row.count, 0)} 个控件采样，覆盖明暗主题、窄屏、禁用和键盘焦点`)
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
