const assert = require('node:assert/strict')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'track-reorder') : '/tmp/open-media-track-reorder'
const initialOrder = ['track-red', 'track-blue', 'track-sound', 'track-labels']
const handle = (page, id) => page.locator(`[data-track-drag="${id}"]`)
const row = (page, id) => page.locator(`[data-track-row-id="${id}"]`)
const order = page => page.evaluate(() => window.trackFixture.state.value.tracks.map(track => track.id))
const changes = page => page.evaluate(() => window.trackFixture.changes.length)
const state = page => page.evaluate(() => window.trackFixture.state.value)
const pixel = page => page.getByTestId('video-preview').evaluate(canvas => [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data])

async function installEditor(page, url) {
  // This suite never opens hardware. An unresolved permission request exercises
  // the production recorder's busy guard and is cancelled through its button.
  await page.addInitScript(() => {
    window.trackMicRequests = []
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => new Promise((resolve, reject) => {
      window.trackMicRequests.push({ resolve, reject })
    }) })
  })
  await page.route('**/track-reorder-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/track-reorder-test`)
  await page.evaluate(async () => {
    const { createProject, createTrack, createClip, createTextClip, validateProject } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
    const componentSource = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueImport = componentSource.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueImport)
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    const project = createProject('轨道拖拽排序验证', { width: 320, height: 180, fps: 20 })
    const blobs = new Map()
    project.tracks = []
    for (const [id, name, color] of [['red', '红色底图', '#cc2233'], ['blue', '蓝色上层', '#2244dd']]) {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 320, 180)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      const asset = { id: `asset-${id}`, kind: 'image', name: `${name}.png`, url: URL.createObjectURL(blob), duration: 0, width: 320, height: 180, mime: blob.type, size: blob.size }
      blobs.set(asset.id, blob); project.assets.push(asset)
      const track = createTrack('video', name); track.id = `track-${id}`
      track.clips.push(createClip(asset, project, { id: `clip-${id}`, start: 0.5, trimIn: 0.25, trimOut: 5.25 }))
      project.tracks.push(track)
    }
    const sound = createTrack('audio', '配音轨道'); sound.id = 'track-sound'
    const labels = createTrack('text', '字幕轨道'); labels.id = 'track-labels'
    labels.clips.push(createTextClip(project, { id: 'clip-label', text: '保持原有字幕', start: 0.5, trimOut: 5, x: 170, y: 130, width: 140, height: 30, fontSize: 14 }))
    project.tracks.push(sound, labels)
    const current = shallowRef(validateProject(project, { trusted: true })), editor = ref(null), exportDisabled = ref(false)
    let history = createHistory(current.value)
    const fixture = window.trackFixture = {
      state: current, editor, blobs, exportDisabled, changes: [], messages: [], busy: false, nextTick,
      get history() { return history },
      reset(next = project) { current.value = validateProject(next, { trusted: true }); history = createHistory(current.value); this.changes.splice(0) },
      undo() { history = undoHistory(history); current.value = history.present },
      redo() { history = redoHistory(history); current.value = history.present },
      addRows() {
        const next = JSON.parse(JSON.stringify(current.value))
        for (let index = 0; index < 24; index++) {
          const track = createTrack(index % 2 ? 'audio' : 'video', `补充轨道 ${index + 1}`)
          track.id = `extra-${index}`; next.tracks.push(track)
        }
        this.reset(next)
      },
    }
    fixture.app = createApp({ render: () => h(Editor, {
      ref: editor, project: current.value, exportDisabled: exportDisabled.value,
      onChange: (next, label) => { fixture.changes.push({ next, label }); history = commitHistory(history, next); current.value = next },
      onStatus: message => fixture.messages.push(message), onBusy: value => { fixture.busy = value },
    }) })
    fixture.app.mount('#app'); await nextTick(); editor.value.seek(1)
  })
  await expect(handle(page, 'track-red')).toBeVisible()
  await expect.poll(() => pixel(page)).toEqual([34, 68, 221, 255])
}

async function startDrag(page, id) {
  const button = handle(page, id)
  await button.scrollIntoViewIfNeeded()
  const box = await button.boundingBox()
  assert(box, `缺少轨道拖拽手柄：${id}`)
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(point.x, point.y); await page.mouse.down()
  return point
}

async function dragTo(page, source, target, side = 'before', during) {
  const point = await startDrag(page, source)
  const targetBox = await row(page, target).boundingBox()
  assert(targetBox)
  await page.mouse.move(point.x + 8, targetBox.y + (side === 'before' ? 4 : targetBox.height - 4), { steps: 8 })
  await expect(page.getByTestId('track-drop-indicator')).toBeVisible()
  if (during) await during()
  await page.mouse.up()
  await expect(page.getByTestId('track-drop-indicator')).toHaveCount(0)
}

function assertTracksUnchanged(before, after) {
  assert.equal(after.tracks.length, before.tracks.length)
  for (const track of before.tracks) assert.deepEqual(after.tracks.find(item => item.id === track.id), track, `排序不能更改 ${track.name} 内的片段、时间、变换或锁定状态`)
  assert.deepEqual(after.assets, before.assets, '排序不能更改或复制素材')
}

async function basicChecks(page) {
  await page.locator('[data-clip-id="clip-red"]').click()
  const before = await state(page)
  const playhead = await page.locator('.ruler-label').innerText()
  await dragTo(page, 'track-blue', 'track-red', 'before', async () => {
    assert.equal(await changes(page), 0, '拖动经过多个像素不能逐次提交历史')
    assert.deepEqual(await order(page), initialOrder, '松手前不应修改项目轨道数组')
    await page.screenshot({ path: path.join(artifacts, 'drag-insertion.png') })
  })
  const forward = ['track-blue', 'track-red', 'track-sound', 'track-labels']
  assert.deepEqual(await order(page), forward)
  assert.equal(await changes(page), 1)
  assert.equal(await page.evaluate(() => window.trackFixture.history.past.length), 1)
  assertTracksUnchanged(before, await state(page))
  await expect(page.locator('[data-clip-id="clip-red"]')).toHaveClass(/selected/)
  assert.equal(await page.locator('.ruler-label').innerText(), playhead, '轨道排序不得跳动播放头')
  await expect.poll(() => pixel(page)).toEqual([204, 34, 51, 255])
  await page.evaluate(() => window.trackFixture.undo())
  assert.deepEqual(await order(page), initialOrder)
  await expect.poll(() => pixel(page)).toEqual([34, 68, 221, 255])
  await page.evaluate(() => window.trackFixture.redo())
  assert.deepEqual(await order(page), forward)
  await expect.poll(() => pixel(page)).toEqual([204, 34, 51, 255])
  console.log('PASS 拖动手柄上移轨道，松手只产生一次历史；选中片段、播放头、全部数据不变；真实图片叠放、撤销及重做同步更新')

  await dragTo(page, 'track-blue', 'track-labels', 'after')
  assert.deepEqual(await order(page), ['track-red', 'track-sound', 'track-labels', 'track-blue'])
  await expect.poll(() => pixel(page)).toEqual([34, 68, 221, 255])
  await dragTo(page, 'track-blue', 'track-red', 'before')
  assert.deepEqual(await order(page), forward)
  assert.equal(await changes(page), 3)
  assertTracksUnchanged(before, await state(page))
  const heights = await page.locator('[data-track-row-id]').evaluateAll(rows => rows.map(element => element.getBoundingClientRect().height))
  assert(heights.every(height => height === 48), `拖拽手柄不能增加轨道高度：${heights}`)
  await page.screenshot({ path: path.join(artifacts, 'sorted-timeline.png') })
  console.log('PASS 混合轨道可拖至最底和最顶，轨道保持 48px，原片段时间与数据完整保留')
}

async function cancellationChecks(page) {
  const before = await state(page), count = await changes(page)
  const point = await startDrag(page, 'track-red')
  await page.mouse.move(point.x + 10, point.y + 6)
  await expect(page.locator('.track-dragging')).toHaveCount(1)
  await expect(page.getByTestId('track-drop-indicator')).toHaveCount(0)
  await page.mouse.up()
  assert.equal(await changes(page), count, '留在原位置不能产生无效历史')
  await startDrag(page, 'track-blue')
  const target = await row(page, 'track-labels').boundingBox()
  await page.mouse.move(target.x + 20, target.y + target.height - 4, { steps: 8 })
  await expect(page.getByTestId('track-drop-indicator')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('track-drop-indicator')).toHaveCount(0)
  await page.mouse.up()
  assert.equal(await changes(page), count, 'Esc 取消后松手不能提交')
  assert.deepEqual(await state(page), before)
  await startDrag(page, 'track-blue')
  await page.mouse.move(target.x + 20, target.y + target.height - 4, { steps: 8 })
  await expect(page.getByTestId('track-drop-indicator')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.mouse.up()
  await expect(page.getByTestId('track-drop-indicator')).toHaveCount(0)
  assert.equal(await changes(page), count, '窗口失焦应取消轨道拖拽')
  const outside = await startDrag(page, 'track-red')
  const scroll = await page.locator('.timeline-scroll').boundingBox()
  await page.mouse.move(outside.x, scroll.y - 8, { steps: 8 }); await page.mouse.up()
  await expect(page.getByTestId('track-drop-indicator')).toHaveCount(0)
  assert.equal(await changes(page), count, '在时间线外松手应取消，不能误插入最前')
  assert.deepEqual(await state(page), before)
  console.log('PASS 原位松手不新增历史；Esc、窗口失焦及拖出时间线松手取消，指示线及拖动状态立即清理')
}

async function restrictionChecks(page) {
  await row(page, 'track-blue').getByTitle('锁定轨道', { exact: true }).click()
  await expect(handle(page, 'track-blue')).toBeDisabled()
  const before = await state(page), count = await changes(page)
  const source = await handle(page, 'track-blue').boundingBox(), target = await row(page, 'track-red').boundingBox()
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down(); await page.mouse.move(target.x + 20, target.y + target.height - 4, { steps: 6 }); await page.mouse.up()
  assert.equal(await changes(page), count)
  assert.deepEqual(await state(page), before)
  await page.getByTestId('preview-record').click()
  await expect(page.getByTestId('preview-record')).toHaveAttribute('aria-label', '取消麦克风授权')
  await expect.poll(() => page.evaluate(() => window.trackFixture.busy)).toBe(true)
  await expect(handle(page, 'track-red')).toBeDisabled()
  assert(await page.locator('.timeline-panel').evaluate(element => element.inert), '录音授权期间整个时间线应禁止编辑')
  const red = await handle(page, 'track-red').boundingBox()
  await page.mouse.move(red.x + red.width / 2, red.y + red.height / 2)
  await page.mouse.down(); await page.mouse.move(red.x + 10, red.y + 60, { steps: 6 }); await page.mouse.up()
  assert.equal(await changes(page), count, '录音忙碌期间拖动不能更改项目')
  await page.getByTestId('preview-record').click()
  await expect(page.getByTestId('preview-record')).toHaveAttribute('aria-label', '开始录音')
  await expect(handle(page, 'track-red')).toBeEnabled()
  await page.evaluate(() => window.trackMicRequests.splice(0).forEach(request => request.reject(new DOMException('测试已取消', 'NotAllowedError'))))
  await row(page, 'track-blue').getByTitle('解锁轨道', { exact: true }).click()
  await expect(handle(page, 'track-blue')).toBeEnabled()
  const unlocked = await state(page), unlockedCount = await changes(page)
  await page.evaluate(() => { window.trackFixture.exportDisabled.value = true })
  await expect(handle(page, 'track-blue')).toBeDisabled()
  await page.evaluate(() => { window.trackFixture.exportDisabled.value = false })
  await expect(handle(page, 'track-blue')).toBeEnabled()
  const grip = await startDrag(page, 'track-blue')
  const destination = await row(page, 'track-labels').boundingBox()
  await page.mouse.move(grip.x, destination.y + destination.height - 4, { steps: 8 })
  await expect(page.getByTestId('track-drop-indicator')).toBeVisible()
  await page.evaluate(() => { window.trackFixture.exportDisabled.value = true })
  await expect(page.getByTestId('track-drop-indicator')).toHaveCount(0)
  await page.mouse.up()
  assert.equal(await changes(page), unlockedCount, '导出变为忙碌应取消正在进行的拖拽')
  assert.deepEqual(await state(page), unlocked)
  await page.evaluate(() => { window.trackFixture.exportDisabled.value = false })
  console.log('PASS 锁定、录音忙碌和导出忙碌期间禁止拖动；忙碌状态取消现有拖拽，解除后恢复')
}

async function keyboardAndPersistenceChecks(page) {
  const before = await order(page), count = await changes(page)
  await handle(page, 'track-red').focus()
  await page.keyboard.press('Alt+ArrowUp')
  assert.deepEqual(await order(page), ['track-red', 'track-blue', 'track-sound', 'track-labels'])
  await page.keyboard.press('Alt+ArrowDown')
  assert.deepEqual(await order(page), before)
  assert.equal(await changes(page), count + 2)
  const saved = await page.evaluate(async () => {
    const fixture = window.trackFixture
    const { saveProject, loadProject } = await import('/src/core/storage.ts')
    const { exportProjectFile, importProjectFile } = await import('/src/core/project-file.ts')
    await saveProject(fixture.state.value, fixture.blobs)
    const draft = await loadProject(fixture.state.value.id)
    const archive = await exportProjectFile(fixture.state.value, { blobs: fixture.blobs })
    const reopened = await importProjectFile(archive)
    const result = { draft: draft.project.tracks.map(track => track.id), reopened: reopened.project.tracks.map(track => track.id), bytes: [...new Uint8Array(await archive.arrayBuffer())] }
    fixture.reset(reopened.project); fixture.reopened = reopened; draft.revoke()
    await fixture.nextTick(); fixture.editor.value.seek(1)
    return result
  })
  assert.deepEqual(saved.draft, before); assert.deepEqual(saved.reopened, before)
  writeFileSync(path.join(artifacts, 'sorted-tracks.omedia'), Buffer.from(saved.bytes))
  await expect.poll(() => pixel(page)).toEqual([204, 34, 51, 255])
  assert.deepEqual(await page.locator('[data-track-row-id]').evaluateAll(rows => rows.map(element => element.dataset.trackRowId)), before)
  console.log('PASS 聚焦手柄后 Alt+上下方向键排序；本地草稿和便携项目保存重开都保留顺序及真实叠放结果')
}

async function scrollChecks(page) {
  await page.evaluate(() => window.trackFixture.addRows())
  await page.locator('.timeline-scroll').evaluate(element => { element.scrollTop = 0 })
  const original = await order(page), count = await changes(page)
  const point = await startDrag(page, 'track-blue')
  const box = await page.locator('.timeline-scroll').boundingBox()
  await page.mouse.move(point.x + 8, box.y + box.height - 5, { steps: 8 })
  await expect.poll(() => page.locator('.timeline-scroll').evaluate(element => element.scrollTop), { timeout: 5000 }).toBeGreaterThan(100)
  await expect.poll(() => page.locator('.timeline-scroll').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop), { timeout: 12000 }).toBeLessThan(2)
  await expect(page.getByTestId('track-drop-indicator')).toHaveAttribute('data-drop-index', String(original.length))
  assert.equal(await changes(page), count, '自动滚动期间不应重复提交')
  await page.mouse.up()
  assert.deepEqual(await order(page), [...original.slice(1), original[0]])
  assert.equal(await changes(page), count + 1)
  const bottom = await page.locator('.timeline-scroll').evaluate(element => element.scrollTop)
  await startDrag(page, 'track-blue')
  await page.mouse.move(point.x + 8, box.y + 27, { steps: 8 })
  await expect.poll(() => page.locator('.timeline-scroll').evaluate(element => element.scrollTop), { timeout: 5000 }).toBeLessThan(bottom - 100)
  await expect.poll(() => page.locator('.timeline-scroll').evaluate(element => element.scrollTop), { timeout: 12000 }).toBeLessThan(2)
  await expect(page.getByTestId('track-drop-indicator')).toHaveAttribute('data-drop-index', '0')
  await page.mouse.up()
  assert.deepEqual(await order(page), original)
  assert.equal(await changes(page), count + 2)
  console.log('PASS 28 条轨道向下和向上拖到可视区边缘会持续自动滚动，可一次拖至最后及最前，每次只新增一条历史')
}

async function main() {
  mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/src-tauri/target/**'] }, hmr: false } })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  try {
    await installEditor(page, `http://127.0.0.1:${port}`)
    await basicChecks(page)
    await cancellationChecks(page)
    await restrictionChecks(page)
    await keyboardAndPersistenceChecks(page)
    await scrollChecks(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
    throw error
  } finally { await context.close(); await browser.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
