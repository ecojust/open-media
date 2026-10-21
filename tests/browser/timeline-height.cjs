const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

async function metrics(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.timeline-panel'), viewport = document.querySelector('.timeline-scroll'), content = document.querySelector('.timeline-content')
    const height = element => element.getBoundingClientRect().height
    return { panel: height(panel), viewport: height(viewport), content: height(content), client: viewport.clientHeight,
      blank: viewport.clientHeight - height(content), scroll: viewport.scrollHeight, scrollTop: viewport.scrollTop,
      scrollbar: viewport.offsetHeight - viewport.clientHeight, preview: height(document.querySelector('.editor-main')),
      panelBottom: panel.getBoundingClientRect().bottom, editorBottom: document.querySelector('.video-editor').getBoundingClientRect().bottom,
      rows: document.querySelectorAll('.track-row').length }
  })
}
async function drag(page, delta, cancel = false) {
  const divider = page.getByTestId('timeline-divider'), box = await divider.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + delta, { steps: 8 })
  if (cancel) await page.keyboard.press('Escape')
  await page.mouse.up()
}
async function noBlank(page, filled = false) {
  await expect.poll(async () => (await metrics(page)).blank).toBeLessThanOrEqual(1)
  if (filled) await expect.poll(async () => Math.abs((await metrics(page)).blank)).toBeLessThanOrEqual(1)
  const measured = await metrics(page)
  assert.ok(Math.abs(measured.panelBottom - measured.editorBottom) < 1, JSON.stringify(measured))
  const values = await page.getByTestId('timeline-divider').evaluate(element => ['aria-valuemin', 'aria-valuenow', 'aria-valuemax'].map(key => Number(element.getAttribute(key))))
  assert.ok(values[0] <= values[1] && values[1] <= values[2], JSON.stringify(values))
}
async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
    await page.route('**/__timeline_height__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__timeline_height__`)
    await page.evaluate(async () => {
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const { createApp, h, shallowRef } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const { createProject, createTrack } = await import('/src/core/project.ts')
      const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      const state = shallowRef(createProject()), mounted = shallowRef(true)
      let history = createHistory(state.value)
      const commit = next => { history = commitHistory(history, next); state.value = history.present }
      const fixture = window.timelineFixture = { state, mounted, commits: 0,
        replace(count) { const next = createProject('轨道高度'); next.tracks = Array.from({ length: count }, (_, i) => createTrack(i % 2 ? 'audio' : 'video', `轨道 ${i + 1}`)); history = createHistory(next); state.value = next },
        undo() { history = undoHistory(history); state.value = history.present }, redo() { history = redoHistory(history); state.value = history.present } }
      fixture.replace(2)
      fixture.app = createApp({ render: () => mounted.value ? h(Editor, { project: state.value, onChange: next => { fixture.commits++; commit(next) } }) : null })
      fixture.app.mount('#app')
    })
    const divider = page.getByTestId('timeline-divider')
    await noBlank(page, true)
    const two = (await metrics(page)).panel
    await drag(page, -800); await noBlank(page, true)
    assert.ok(Math.abs((await metrics(page)).panel - two) <= 1)
    for (const key of ['End', 'ArrowUp', 'Shift+ArrowUp', 'Enter']) { await divider.press(key); await noBlank(page, true) }
    await divider.dblclick(); await noBlank(page, true)
    await divider.press('Home')
    const smaller = (await metrics(page)).panel
    assert.ok(smaller < two)
    await drag(page, -18, true)
    await expect.poll(async () => Math.round((await metrics(page)).panel)).toBe(Math.round(smaller))
    await divider.press('End'); await noBlank(page, true)
    assert.equal(await page.evaluate(() => window.timelineFixture.commits), 0, '调整布局不写入工程')
    console.log('PASS 两条轨道高度封顶，鼠标/键盘/复位统一限高，Escape取消拖动且不修改工程')

    await page.getByTitle('添加音频轨道', { exact: true }).click()
    await expect(page.locator('.track-row')).toHaveCount(3)
    await divider.press('End'); await noBlank(page, true)
    await page.locator('[data-track-label-id]').last().click({ button: 'right' })
    await page.getByRole('menuitem', { name: /删除轨道/ }).click()
    await expect(page.locator('.track-row')).toHaveCount(2)
    await noBlank(page, true)
    await page.evaluate(() => window.timelineFixture.undo())
    await divider.press('End'); await noBlank(page, true)
    await page.evaluate(() => window.timelineFixture.redo()); await noBlank(page, true)
    for (const count of [1, 0, 2]) {
      await page.evaluate(count => window.timelineFixture.replace(count), count)
      await expect(page.locator('.track-row')).toHaveCount(count)
      for (const key of ['Home', 'End', 'Enter']) { await divider.press(key); await noBlank(page) }
      await divider.press('End'); await noBlank(page, true)
    }
    console.log('PASS 添加/删除/撤销重做与工程切换即时更新上限，零轨/单轨不被旧150px下限撑出空白')

    // Verify the real content is measured, rather than assuming every row is 48px.
    const customRows = await page.addStyleTag({ content: '.track-row,.track-lane{height:64px!important}' })
    await divider.press('End'); await noBlank(page, true)
    assert.ok((await metrics(page)).panel > two + 30)
    await customRows.evaluate(element => element.remove())
    await noBlank(page, true)
    for (const size of [{ width: 700, height: 800 }, { width: 390, height: 600 }, { width: 1440, height: 400 }, { width: 1440, height: 1000 }]) {
      await page.setViewportSize(size)
      await divider.press('End'); await noBlank(page)
      const m = await metrics(page)
      assert.ok(m.panelBottom <= size.height + 1, JSON.stringify(m))
      assert.ok(m.preview >= Math.min(180, (m.preview + m.panel) * 180 / 330) - 1, JSON.stringify(m))
    }
    // A horizontal scrollbar may appear as timeline zoom changes; it is real chrome, not blank track space.
    const slider = page.getByLabel('时间线缩放', { exact: true })
    for (const zoom of ['160', '6', '44']) {
      await slider.fill(zoom); await divider.press('End'); await noBlank(page, true)
    }
    console.log('PASS 实际行高变化、横向滚动条、宽窄和矮窗口均不留下轨道后的背景')

    await page.evaluate(() => window.timelineFixture.replace(20))
    await divider.press('End'); await noBlank(page)
    let m = await metrics(page)
    assert.ok(Math.abs(m.preview - 180) < 1 && m.scroll > m.client, JSON.stringify(m))
    await page.locator('.timeline-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(page.locator('.track-row').last()).toBeInViewport()
    await page.evaluate(() => window.timelineFixture.replace(2)); await noBlank(page, true)
    assert.equal((await metrics(page)).scrollTop, 0)
    const dir = process.env.BROWSER_ARTIFACTS || '/tmp/open-media-timeline-height'; fs.mkdirSync(dir, { recursive: true })
    await page.screenshot({ path: path.join(dir, 'two-tracks.png'), fullPage: true })
    await page.evaluate(() => { window.timelineFixture.mounted.value = false })
    await expect(divider).toHaveCount(0)
    await page.setViewportSize({ width: 1100, height: 700 })
    await page.evaluate(() => { window.timelineFixture.mounted.value = true })
    await noBlank(page, true)
    assert.deepEqual(errors, [])
    console.log('PASS 多轨内部滚动保留，减少轨道后自动收起并重置滚动，卸载重开无观察器错误')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
