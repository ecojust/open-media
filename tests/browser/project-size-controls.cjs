const assert = require('node:assert/strict')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/size-controls-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>' }))
    await page.goto(`${server.resolvedUrls.local[0]}size-controls-test`)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const source = await (await fetch('/src/components/ProjectSizeControls.vue')).text()
      const { createApp, h, shallowRef, ref, nextTick } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const Controls = (await import('/src/components/ProjectSizeControls.vue')).default
      const { createProject, createTextClip, cloneProject, validateProject } = await import('/src/core/project.ts')
      const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
      const original = createProject('实时画面尺寸')
      original.tracks.find(track => track.kind === 'text').clips = [createTextClip(original, { text: '测试缩放', fontSize: 64 })]
      const state = shallowRef(original), disabled = ref(false), controls = ref(null), visible = ref(true)
      let history = createHistory(original), continuous
      window.sizeFixture = {
        state, disabled, controls, visible, changes: [], nextTick,
        reset() { continuous = undefined; history = createHistory(cloneProject(original)); state.value = history.present },
        undo() { continuous = undefined; history = undoHistory(history); state.value = history.present },
        redo() { continuous = undefined; history = redoHistory(history); state.value = history.present },
        switchProject() { continuous = undefined; history = createHistory(createProject('另一个项目', { width: 720, height: 1280 })); state.value = history.present },
        historyLength() { return history.past.length },
      }
      const app = createApp({ render: () => h('main', { style: 'width:400px;--ed-border:#d2d7df;--ed-bg:#fff;--ed-panel:#f4f6f8;--ed-text:#17243a;--ed-muted:#526079;--ed-accent:#5274e3' }, [
        visible.value && h(Controls, { ref: controls, project: state.value, disabled: disabled.value, onChange: (next, label, group) => {
          const checked = validateProject(next, { trusted: true }); checked.updatedAt = new Date().toISOString()
          history = group && continuous?.group === group && continuous.history === history ? { ...history, present: cloneProject(checked), future: [] } : commitHistory(history, checked)
          continuous = group ? { group, history } : undefined
          state.value = checked; window.sizeFixture.changes.push({ label, group })
        } }), h('button', { id: 'outside' }, '离开控件'),
      ]) })
      app.mount('#app'); await nextTick()
    })
    const width = page.getByLabel('项目宽度', { exact: true }), height = page.getByLabel('项目高度', { exact: true }), preset = page.getByLabel('画面比例', { exact: true })
    const styles = await preset.evaluate(element => { const css = getComputedStyle(element); return { height: element.getBoundingClientRect().height, font: css.fontSize, arrow: css.backgroundImage } })
    assert.equal(styles.height, 32); assert.equal(styles.font, '12px'); assert.match(styles.arrow, /data:image\/svg\+xml/)
    assert.equal(await width.evaluate(element => element.getBoundingClientRect().height), 32)
    assert.equal(await height.evaluate(element => element.getBoundingClientRect().height), 32)
    const state = () => page.evaluate(() => {
      const project = window.sizeFixture.state.value
      return { width: project.width, height: project.height, fontSize: project.tracks.find(track => track.kind === 'text').clips[0]?.fontSize, past: window.sizeFixture.historyLength() }
    })
    await width.focus(); await width.fill('19')
    assert.deepEqual(await state(), { width: 19, height: 1080, fontSize: 4, past: 1 })
    await width.fill('192'); await width.fill('1920')
    assert.equal((await state()).fontSize, 64, '输入中间值不得造成字体下限夹取后的累计失真')
    await height.fill('720')
    const changed = await state()
    assert.equal(changed.height, 720); assert.equal(changed.fontSize, 64 * 720 / 1080); assert.equal(changed.past, 1)
    assert.equal(await width.evaluate(input => document.activeElement === input), false)
    assert.equal(await height.evaluate(input => document.activeElement === input), true, '当前输入无需失焦即生效')
    await page.evaluate(() => window.sizeFixture.undo())
    await expect(width).toHaveValue('1920'); await expect(height).toHaveValue('1080')
    assert.equal((await state()).fontSize, 64)
    await page.evaluate(() => window.sizeFixture.redo())
    await expect(height).toHaveValue('720')
    console.log('PASS 实时应用、焦点内一次撤销、输入中间值不损伤几何、撤销重做同步')

    await page.locator('#outside').click(); await page.evaluate(() => window.sizeFixture.reset())
    for (const value of ['', '15', '0', '-1', '16385', '853.5']) {
      await width.fill(value)
      await expect(page.getByRole('alert')).toContainText('16 到 16384 之间的整数')
      assert.equal((await state()).width, 1920); assert.equal((await state()).past, 0)
      await expect(width).toHaveValue(value)
    }
    await width.press('Escape')
    await expect(width).toHaveValue('1920'); await expect(page.getByRole('alert')).toHaveCount(0)
    await width.fill('16'); assert.equal((await state()).width, 16)
    await width.fill('16384'); assert.equal((await state()).width, 16384)
    console.log('PASS 无效输入保留并提示，不污染项目；Esc恢复当前值，尺寸边界可用')

    await page.evaluate(() => window.sizeFixture.reset())
    await preset.selectOption('portrait')
    await expect(width).toHaveValue('1080'); await expect(height).toHaveValue('1920')
    await preset.selectOption('custom'); await expect(width).toBeFocused()
    await width.fill('15')
    await page.evaluate(() => window.sizeFixture.switchProject())
    await expect(width).toHaveValue('720'); await expect(height).toHaveValue('1280'); await expect(page.getByRole('alert')).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.sizeFixture.controls.value.setSourceSize(853, 479)), true)
    await expect(width).toHaveValue('853'); await expect(height).toHaveValue('479'); await expect(width).toBeFocused()
    assert.equal(await page.evaluate(() => window.sizeFixture.controls.value.setSourceSize(10, 479)), false)
    assert.equal((await state()).width, 853)
    await page.evaluate(() => { window.sizeFixture.disabled.value = true })
    await expect(width).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.sizeFixture.controls.value.setSourceSize(1920, 1080)), false)
    assert.equal((await state()).width, 853)
    await page.evaluate(() => { window.sizeFixture.disabled.value = false })
    await expect(width).toBeEnabled()
    const fits = await page.getByTestId('project-size-controls').evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return [...element.querySelectorAll('input,select,label')].every(input => { const rect = input.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right })
    })
    assert.equal(fits, true, '400px 宽度下尺寸控件折行且不溢出')
    await page.screenshot({ path: '/tmp/open-media-inline-project-size.png' })
    await page.evaluate(async () => { window.sizeFixture.controls.value.setSourceSize(640, 360); window.sizeFixture.visible.value = false; await window.sizeFixture.nextTick() })
    assert.deepEqual(errors, [])
    console.log('PASS 预设、自定义、切项目、源尺寸应用、禁用和卸载安全，400px宽度可用')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
