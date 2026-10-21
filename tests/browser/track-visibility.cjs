const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')
const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'track-visibility') : '/tmp/open-media-track-visibility'
const toggle = (page, id) => page.locator(`[data-visibility-track-id="${id}"]`)
const pixel = page => page.getByTestId('video-preview').evaluate(canvas => [...canvas.getContext('2d').getImageData(8, 8, 1, 1).data])
async function main() {
  fs.mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 5317, strictPort: true, watch: null, hmr: false }, logLevel: 'error' })
  await server.listen()
  let browser, page
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/track-visibility-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto('http://127.0.0.1:5317/track-visibility-test')
    await page.evaluate(async () => {
      const { createProject, createTrack, createClip, createTextClip, validateProject } = await import('/src/core/project.ts')
      const { createHistory, commitHistory, undoHistory, redoHistory, renderDuration, projectDuration } = await import('/src/core/timeline.ts')
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const { createApp, h, shallowRef, ref, nextTick } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      const project = createProject('轨道隐藏验证', { width: 320, height: 180, fps: 20, background: '#000000' })
      project.tracks = []
      for (const [id, color, length] of [['red', '#cc2233', 3], ['blue', '#2244dd', 3], ['tail', '#55bb66', 12]]) {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
        const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 320, 180)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        const asset = { id: `asset-${id}`, kind: 'image', name: `${id}.png`, url: URL.createObjectURL(blob), duration: 0, width: 320, height: 180, mime: blob.type, size: blob.size }
        project.assets.push(asset)
        const track = { ...createTrack('video', id), id }
        track.clips.push(createClip(asset, project, { id: `clip-${id}`, start: 0, trimOut: length }))
        project.tracks.push(track)
      }
      const text = { ...createTrack('text', '字幕'), id: 'text' }
      text.clips.push(createTextClip(project, { id: 'caption', text: '隐藏后不出现在预览', start: 0, trimOut: 3, x: 20, y: 110, width: 280, height: 40, fontSize: 18 }))
      project.tracks.push(text, { ...createTrack('audio', '音频'), id: 'audio' }, { ...createTrack('transition', '转场'), id: 'transition' })
      const current = shallowRef(project), editor = ref(null), locked = ref(false)
      let history = createHistory(project)
      window.visibilityFixture = {
        state: current, editor, locked,
        undo() { history = undoHistory(history); current.value = history.present },
        redo() { history = redoHistory(history); current.value = history.present },
        durations() { return [projectDuration(current.value), renderDuration(current.value)] },
        reload() { current.value = validateProject(JSON.parse(JSON.stringify(current.value)), { trusted: true }) },
      }
      createApp({ render: () => h(Editor, { project: current.value, ref: editor, exportDisabled: locked.value, onChange: next => { history = commitHistory(history, next); current.value = next } }) }).mount('#app')
      await nextTick(); editor.value.seek(.5)
    })
    await expect(page.getByTestId('track-visibility')).toHaveCount(6)
    await expect.poll(() => pixel(page)).toEqual([204, 34, 51, 255])
    await page.locator('[data-clip-id="clip-red"]').click()
    await expect(page.getByTestId('preview-selected-clip')).toBeVisible()
    await toggle(page, 'red').click()
    await expect(toggle(page, 'red')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => pixel(page)).toEqual([34, 68, 221, 255])
    await expect(page.getByTestId('preview-selected-clip')).toHaveCount(0)
    await expect(page.locator('[data-clip-id="clip-red"]')).toBeVisible()
    await page.evaluate(() => window.visibilityFixture.undo())
    await expect.poll(() => pixel(page)).toEqual([204, 34, 51, 255])
    await page.evaluate(() => window.visibilityFixture.redo())
    await expect.poll(() => pixel(page)).toEqual([34, 68, 221, 255])
    console.log('PASS 隐藏立即更新真实合成预览，保留时间线片段，撤销/重做恢复，隐藏片段无画面选择框')

    await toggle(page, 'tail').click()
    assert.deepEqual(await page.evaluate(() => window.visibilityFixture.durations()), [12, 3])
    assert.equal(await page.locator('[data-clip-id="clip-tail"]').count(), 1)
    await page.evaluate(() => window.visibilityFixture.reload())
    await expect(toggle(page, 'tail')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('preview-play').click()
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '暂停（空格）')
    await toggle(page, 'blue').click()
    await expect.poll(() => pixel(page)).toEqual([0, 0, 0, 255])
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '暂停（空格）')
    await page.getByTestId('preview-play').click()
    console.log('PASS 隐藏尾部不延长播放/导出时长，编辑时间线保持原长度；播放中切换立即生效')

    await page.locator('[data-track-label-id="text"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '隐藏轨道' }).click()
    for (const id of ['audio', 'transition']) await toggle(page, id).click()
    await expect(page.getByTestId('preview-play')).toBeDisabled()
    await expect(page.getByTestId('export-project')).toBeDisabled()
    assert.equal(await page.locator('.timeline-clip').count(), 4)
    await toggle(page, 'blue').click()
    await expect(page.getByTestId('preview-play')).toBeEnabled()
    await page.evaluate(() => { window.visibilityFixture.locked.value = true })
    for (const id of ['red', 'blue', 'text', 'audio', 'transition']) await expect(toggle(page, id)).toBeDisabled()
    await page.evaluate(() => { window.visibilityFixture.locked.value = false })
    for (const row of await page.locator('.track-row').evaluateAll(rows => rows.map(row => {
      const label = row.querySelector('.track-label').getBoundingClientRect()
      return { height: row.getBoundingClientRect().height, inside: [...row.querySelectorAll('.track-actions button')].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= label.left && rect.right <= label.right }) }
    }))) assert.ok(row.height === 48 && row.inside, JSON.stringify(row))
    await page.screenshot({ path: path.join(artifacts, 'hidden-tracks.png'), animations: 'disabled' })
    assert.deepEqual(errors, [])
    console.log('PASS 各轨独立隐藏、全部隐藏时禁用播放导出、导出忙碌时禁用修改，按钮不溢出48px轨道布局')
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
    throw error
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
