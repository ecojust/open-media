const assert = require('node:assert/strict')
const { existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { chromium, expect } = require('@playwright/test')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'preview-position') : '/tmp/open-media-preview-position'
const state = page => page.evaluate(() => window.positionFixture.state.value)
const changes = page => page.evaluate(() => window.positionFixture.changes.length)
const clip = async (page, id = 'subtitle') => (await state(page)).tracks.flatMap(track => track.clips).find(item => item.id === id)
const selection = page => page.getByTestId('preview-selected-clip')
const row = (page, id) => page.locator(`[data-track-row-id="${id}"]`)
const coordinate = (actual, expected, message = '项目像素坐标应准确', epsilon = 1e-8) => assert(Math.abs(actual - expected) <= epsilon, `${message}：${actual} ≈ ${expected}`)
// Pointer coordinates pass through the browser's single-precision SVG matrix.
const draggedCoordinate = (actual, expected) => coordinate(actual, expected, '自由拖动应保持子像素精度', 1e-3)

async function installEditor(page, url) {
  await page.route('**/preview-position-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/preview-position-test`)
  await page.evaluate(async () => {
    const { createProject, createTrack, createClip, createTextClip, validateProject } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
    const componentSource = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueImport = componentSource.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueImport)
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    const project = createProject('预览直接定位验证', { width: 640, height: 360, fps: 20, background: '#102030' })
    project.tracks = []
    const subtitles = createTrack('text', '字幕轨道'); subtitles.id = 'subtitles'
    subtitles.clips.push(createTextClip(project, { id: 'subtitle', name: '定位字幕', text: '移动字幕', start: 0, trimOut: 5, x: 60, y: 40, width: 160, height: 40, background: '#cc2233', fontSize: 18 }))
    const source = document.createElement('canvas'); source.width = 80; source.height = 60
    const ctx = source.getContext('2d'); ctx.fillStyle = '#12cfe3'; ctx.fillRect(0, 0, 80, 60)
    const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
    const asset = { id: 'watermark-image', name: '定位水印.png', kind: 'image', url: URL.createObjectURL(blob), duration: 0, width: 80, height: 60, mime: blob.type, size: blob.size }
    project.assets.push(asset)
    const watermarks = createTrack('video', '水印轨道'); watermarks.id = 'watermarks'
    watermarks.clips.push(createClip(asset, project, { id: 'watermark', start: 0, trimOut: 5, x: 390, y: 90, width: 80, height: 60 }))
    const late = createTrack('text', '稍后字幕'); late.id = 'late'
    late.clips.push(createTextClip(project, { id: 'later-subtitle', text: '稍后显示', start: 6, trimOut: 2, x: 220, y: 250, width: 150, height: 40, fontSize: 16 }))
    project.tracks.push(subtitles, watermarks, late)
    const current = shallowRef(validateProject(project, { trusted: true })), editor = ref(null), exportDisabled = ref(false)
    let history = createHistory(current.value)
    const fixture = window.positionFixture = {
      state: current, editor, exportDisabled, changes: [], messages: [], nextTick,
      get history() { return history },
      reset(next = project) { current.value = validateProject(next, { trusted: true }); history = createHistory(current.value); this.changes.splice(0) },
      undo() { history = undoHistory(history); current.value = history.present },
      redo() { history = redoHistory(history); current.value = history.present },
    }
    fixture.app = createApp({ render: () => h(Editor, {
      ref: editor, project: current.value, exportDisabled: exportDisabled.value,
      onChange: (next, label) => { fixture.changes.push({ next, label }); history = commitHistory(history, next); current.value = next },
      onStatus: message => fixture.messages.push(message),
    }) })
    fixture.app.mount('#app'); await nextTick(); editor.value.seek(1)
  })
  await expect(page.locator('[data-clip-id="subtitle"].timeline-clip')).toBeVisible()
  await expect.poll(() => pixel(page, 65, 45)).toEqual([204, 34, 51, 255])
}

async function pixel(page, x, y) {
  return page.getByTestId('video-preview').evaluate((canvas, { x, y }) => [...canvas.getContext('2d').getImageData(Math.round(x / 640 * canvas.width), Math.round(y / 360 * canvas.height), 1, 1).data], { x, y })
}
async function guidePresent(page, axis) {
  const guide = page.getByTestId(`preview-snap-${axis}`)
  await expect(guide).toHaveCount(1)
  assert(await guide.evaluate(line => { const css = getComputedStyle(line); return css.display !== 'none' && css.visibility === 'visible' && css.stroke !== 'none' && Number.parseFloat(css.strokeWidth) > 0 }), '吸附参考线应实际绘制可见描边')
}
async function select(page, id = 'subtitle') {
  await page.locator(`[data-clip-id="${id}"].timeline-clip`).click()
  await expect(selection(page)).toBeVisible()
  await expect(selection(page)).toHaveAttribute('data-preview-clip-id', id)
}
async function reset(page) {
  await page.evaluate(async () => { window.positionFixture.reset(); await window.positionFixture.nextTick(); window.positionFixture.editor.value.seek(1) })
  await select(page)
}
async function drag(page, x, y, options = {}) {
  const chosen = await clip(page, options.id || 'subtitle')
  const box = await page.getByTestId('video-preview').boundingBox()
  const scale = box.width / 640
  assert(Math.abs(scale - box.height / 360) < 0.01, '预览实际显示比例必须一致')
  const start = { x: box.x + (chosen.x + chosen.width / 2) * scale, y: box.y + (chosen.y + chosen.height / 2) * scale }
  await page.mouse.move(start.x, start.y); await page.mouse.down()
  if (options.alt) await page.keyboard.down('Alt')
  await page.mouse.move(start.x + (x - chosen.x) * scale, start.y + (y - chosen.y) * scale, { steps: 9 })
  if (options.during) await options.during()
  if (options.cancel === 'escape') await page.keyboard.press('Escape')
  if (options.cancel === 'pointer') await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })))
  if (options.cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.mouse.up()
  if (options.alt) await page.keyboard.up('Alt')
}

async function liveAndHistoryChecks(page) {
  await select(page)
  const before = await state(page)
  await drag(page, 240 + 2, 160 + 2, { during: async () => {
    assert.equal(await changes(page), 0, '多次 pointermove 只更新临时项目，不提交历史')
    assert.equal((await clip(page)).x, 60)
    await guidePresent(page, 'x')
    await guidePresent(page, 'y')
    await expect.poll(() => pixel(page, 245, 165)).toEqual([204, 34, 51, 255])
    await expect.poll(() => pixel(page, 65, 45)).toEqual([16, 32, 48, 255])
    await page.screenshot({ path: path.join(artifacts, 'center-snap.png') })
  } })
  const after = await clip(page)
  coordinate(after.x, 240); coordinate(after.y, 160)
  assert.equal(await changes(page), 1)
  assert.equal(await page.evaluate(() => window.positionFixture.history.past.length), 1)
  await expect(page.getByTestId('preview-snap-x')).toHaveCount(0)
  await page.evaluate(() => window.positionFixture.undo())
  assert.deepEqual(await state(page), before)
  await expect.poll(() => pixel(page, 65, 45)).toEqual([204, 34, 51, 255])
  await page.evaluate(() => window.positionFixture.redo())
  coordinate((await clip(page)).x, 240)
  await expect.poll(() => pixel(page, 245, 165)).toEqual([204, 34, 51, 255])
  console.log('PASS 字幕选框和真实预览随拖动更新；画布中心吸附及参考线正确；一次拖动只提交一次，撤销/重做恢复像素与坐标')
}

async function snappingAndScaleChecks(page) {
  await reset(page)
  await drag(page, 2, 2)
  coordinate((await clip(page)).x, 0); coordinate((await clip(page)).y, 0)
  await drag(page, 478, 318)
  coordinate((await clip(page)).x, 480); coordinate((await clip(page)).y, 320)
  await drag(page, 231, 91, { during: async () => {
    await guidePresent(page, 'x')
    await guidePresent(page, 'y')
  } })
  coordinate((await clip(page)).x, 230, '字幕右边缘应对齐可见水印左边缘')
  coordinate((await clip(page)).y, 90, '字幕顶部应对齐可见水印顶部')
  await drag(page, 242, 162, { alt: true, during: async () => {
    await expect(page.getByTestId('preview-snap-x')).toHaveCount(0)
    await expect(page.getByTestId('preview-snap-y')).toHaveCount(0)
  } })
  draggedCoordinate((await clip(page)).x, 242); draggedCoordinate((await clip(page)).y, 162)
  await select(page, 'watermark')
  await drag(page, 270, 220, { id: 'watermark', alt: true })
  draggedCoordinate((await clip(page, 'watermark')).x, 270)
  await expect.poll(() => pixel(page, 275, 225)).toEqual([18, 207, 227, 255])
  await expect.poll(() => pixel(page, 395, 95)).toEqual([16, 32, 48, 255])
  await page.setViewportSize({ width: 1100, height: 850 })
  await select(page)
  await drag(page, 111, 117, { alt: true })
  draggedCoordinate((await clip(page)).x, 111); draggedCoordinate((await clip(page)).y, 117)
  await expect.poll(() => pixel(page, 116, 122)).toEqual([204, 34, 51, 255])
  await page.setViewportSize({ width: 1440, height: 1000 })
  console.log('PASS 四侧边缘、其他片段边缘吸附；Alt 自由移动；图片水印真实移动；不同显示比例仍使用正确项目像素坐标')
}

async function cancellationChecks(page) {
  await reset(page)
  const before = await state(page)
  for (const cancel of ['escape', 'pointer', 'blur']) {
    await drag(page, 240, 160, { cancel, during: async () => {
      await expect.poll(() => pixel(page, 245, 165)).toEqual([204, 34, 51, 255])
    } })
    assert.deepEqual(await state(page), before, `${cancel} 必须完整恢复项目`)
    assert.equal(await changes(page), 0)
    await expect(page.getByTestId('preview-snap-x')).toHaveCount(0)
    await expect.poll(() => pixel(page, 65, 45)).toEqual([204, 34, 51, 255])
  }
  await selection(page).click()
  assert.equal(await changes(page), 0, '无位移点击不得创建空历史')
  console.log('PASS Esc、指针取消、窗口失焦都恢复预览且不写入；单击不新增历史')
}

async function rotatedAndInterruptedChecks(page) {
  await reset(page)
  await selection(page).focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  assert.equal((await clip(page)).x, 61); assert.equal((await clip(page)).y, 50)
  assert.equal(await changes(page), 2)
  await page.evaluate(() => window.positionFixture.undo())
  assert.equal((await clip(page)).y, 40)
  await reset(page)
  await page.evaluate(() => { const next = JSON.parse(JSON.stringify(window.positionFixture.state.value)); next.tracks[0].clips[0].rotation = 90; window.positionFixture.reset(next) })
  await drag(page, 220, 120, { alt: true })
  assert.equal((await clip(page)).rotation, 90)
  draggedCoordinate((await clip(page)).x, 220); draggedCoordinate((await clip(page)).y, 120)
  await expect.poll(() => pixel(page, 285, 65)).toEqual([204, 34, 51, 255])
  await expect.poll(() => pixel(page, 125, 5)).toEqual([16, 32, 48, 255])
  await reset(page)
  const before = await state(page)
  await drag(page, 240, 160, { during: async () => {
    await page.evaluate(() => { window.positionFixture.exportDisabled.value = true })
    await expect(selection(page)).toHaveCount(0)
  } })
  assert.equal(await changes(page), 0)
  assert.deepEqual(await state(page), before)
  await page.evaluate(() => { window.positionFixture.exportDisabled.value = false })
  await expect(selection(page)).toBeVisible()
  await drag(page, 240, 160, { during: async () => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(page.getByTestId('preview-snap-x')).toHaveCount(0)
  } })
  assert.equal(await changes(page), 0)
  assert.deepEqual(await state(page), before)
  await page.setViewportSize({ width: 1440, height: 1000 })
  console.log('PASS 方向键 1 像素/Shift 10 像素微调；旋转片段按画布坐标移动，真实像素与旋转保留；拖动中忙碌或缩放窗口安全取消')
}

async function restrictionChecks(page) {
  await reset(page)
  await row(page, 'subtitles').getByTitle('锁定轨道', { exact: true }).click()
  await expect(selection(page)).toHaveCount(0)
  await row(page, 'subtitles').getByTitle('解锁轨道', { exact: true }).click()
  await expect(selection(page)).toBeVisible()
  await page.evaluate(() => { const next = JSON.parse(JSON.stringify(window.positionFixture.state.value)); next.tracks[0].clips[0].opacity = 0; window.positionFixture.reset(next) })
  await expect(selection(page)).toHaveCount(0)
  await page.evaluate(() => { const next = JSON.parse(JSON.stringify(window.positionFixture.state.value)); next.tracks[0].clips[0].opacity = 1; window.positionFixture.reset(next) })
  await expect(selection(page)).toBeVisible()
  await page.locator('[data-clip-id="later-subtitle"].timeline-clip').click()
  await expect(selection(page)).toHaveCount(0)
  await page.evaluate(() => window.positionFixture.editor.value.seek(6.5))
  await expect(selection(page)).toHaveAttribute('data-preview-clip-id', 'later-subtitle')
  await page.evaluate(() => window.positionFixture.editor.value.seek(8))
  await expect(selection(page)).toHaveCount(0)
  await reset(page)
  await page.evaluate(() => { window.positionFixture.exportDisabled.value = true })
  await expect(selection(page)).toHaveCount(0)
  await page.evaluate(() => { window.positionFixture.exportDisabled.value = false })
  await expect(selection(page)).toBeVisible()
  console.log('PASS 锁定、完全透明、不在当前播放时间及导出忙碌时不提供可编辑选框，恢复后重新可编辑')
}

async function generatedTimeChecks(page) {
  await reset(page)
  const source = '2026-10-17T01:02:03.000Z'
  await page.evaluate(source => {
    const next = JSON.parse(JSON.stringify(window.positionFixture.state.value))
    next.tracks[0].clips[0].generatedAt = source
    window.positionFixture.reset(next)
  }, source)
  const timelineClip = page.locator('.timeline-clip[data-clip-id="subtitle"]')
  const stamp = timelineClip.getByTestId('clip-generated-time')
  await expect(stamp).toHaveAttribute('datetime', source)
  await expect(stamp).toHaveText('09:02:03')
  await expect(stamp).toHaveAttribute('title', /最近生成：.*2026.*10.*17.*\d{2}:\d{2}:\d{2}/)
  await drag(page, 111, 117, { alt: true })
  assert.equal((await clip(page)).generatedAt, source, '改变画面位置不得伪造新的内容生成时间')
  await expect(stamp).toHaveAttribute('datetime', source)
  await page.getByLabel('字号', { exact: true }).fill('20')
  await page.getByLabel('字号', { exact: true }).press('Tab')
  assert.equal((await clip(page)).generatedAt, source, '修改样式保留内容生成时间')
  await page.getByTestId('clip-text-content').fill('更新后的真实字幕内容')
  await page.getByTestId('clip-text-content').press('Tab')
  const updated = (await clip(page)).generatedAt
  assert(updated && updated !== source && Date.parse(updated) > Date.parse(source))
  await expect(stamp).toHaveAttribute('datetime', updated)
  const dimensions = await timelineClip.evaluate(element => ({ clip: element.getBoundingClientRect().height, row: element.closest('.track-row').getBoundingClientRect().height }))
  assert.deepEqual(dimensions, { clip: 38, row: 48 }, '时间标签不得增加轨道或片段高度')
  await page.evaluate(() => {
    const next = JSON.parse(JSON.stringify(window.positionFixture.state.value))
    next.tracks[0].clips[0].trimOut = 0.5
    window.positionFixture.reset(next)
  })
  await expect(stamp).toHaveAttribute('title', /最近生成：/)
  const narrow = await timelineClip.evaluate(element => {
    const clip = element.getBoundingClientRect(), time = element.querySelector('[data-testid="clip-generated-time"]').getBoundingClientRect()
    return { clip: { left: clip.left, right: clip.right, top: clip.top, bottom: clip.bottom }, time: { left: time.left, right: time.right, top: time.top, bottom: time.bottom } }
  })
  assert(narrow.time.left >= narrow.clip.left && narrow.time.right <= narrow.clip.right && narrow.time.top >= narrow.clip.top && narrow.time.bottom <= narrow.clip.bottom, '窄片段应在内部截断显示生成时间，不覆盖其他轨道')
  await page.evaluate(() => {
    const next = JSON.parse(JSON.stringify(window.positionFixture.state.value))
    delete next.tracks[0].clips[0].generatedAt
    window.positionFixture.reset(next)
  })
  await expect(stamp).toHaveCount(0)
  console.log('PASS 片段右下角显示真实生成时间并悬停提供完整日期；移动/样式保留、修改文案更新；窄片段不溢出且旧项目不伪造时间')
}

async function main() {
  mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false } })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
  try {
    await installEditor(page, `http://127.0.0.1:${port}`)
    await liveAndHistoryChecks(page)
    await snappingAndScaleChecks(page)
    await cancellationChecks(page)
    await restrictionChecks(page)
    await rotatedAndInterruptedChecks(page)
    await generatedTimeChecks(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
    throw error
  } finally { await context.close(); await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
