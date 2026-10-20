const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')
const clip = (page, id) => page.locator(`.timeline-clip[data-clip-id="${id}"]`)
const state = page => page.evaluate(() => JSON.parse(JSON.stringify(window.idleFixture.current.value)))

async function mount(page, url, desktop = true) {
  await page.route('**/__idle_clip_split__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app,.app-shell{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/__idle_clip_split__`)
  await page.evaluate(async desktop => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueURL)
    const { createProject, createClip, createSubtitleClip, validateProject } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory } = await import('/src/core/timeline.ts')
    const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const { prepareEditorTool } = await import('/src/core/editor-tool-service.ts')
    const media = await (await fetch(VIDEO_SEGMENTS[0].url)).blob()
    const asset = await importMediaFile(new File([media], '屏幕讲解.webm', { type: 'video/webm' }))
    asset.id = 'source'; asset.nativePath = '/media/source.webm'
    const project = createProject('静止画面分割检查', { width: asset.width, height: asset.height, fps: 24 })
    project.assets.push(asset)
    project.tracks.find(track => track.kind === 'video').clips.push(createClip(asset, project, { id: 'video-a', start: 2, trimIn: .5, trimOut: 3.5 }))
    project.tracks.find(track => track.kind === 'text').clips.push(createSubtitleClip(project, { id: 'subtitle-a', text: '保留阅读画面和原有讲解', start: 2.5, trimOut: 1.5 }))
    project.tracks.find(track => track.kind === 'audio').clips.push(createClip(asset, project, { id: 'audio-a', start: 2, trimIn: .5, trimOut: 3.5, volume: .5 }))
    const fixture = window.idleFixture = { current: shallowRef(validateProject(project, { trusted: true })), editor: ref(), theme: ref('dark'), calls: [], tools: [], busy: [], messages: [], commits: 0, held: false, fail: false, empty: false }
    let history = createHistory(fixture.current.value), revision = 0
    const commit = next => { history = commitHistory(history, next); fixture.current.value = next; revision++; fixture.commits++ }
    fixture.undo = () => { history = undoHistory(history); fixture.current.value = history.present; revision++ }
    fixture.setLocked = locked => { const next = JSON.parse(JSON.stringify(fixture.current.value)); next.tracks.find(track => track.kind === 'video').locked = locked; fixture.current.value = validateProject(next, { trusted: true }); revision++ }
    fixture.setFreeze = () => { const next = JSON.parse(JSON.stringify(fixture.current.value)); const target = next.tracks.find(track => track.kind === 'video').clips[0]; target.freezeFrame = { sourceTime: target.trimIn, original: { trimIn: target.trimIn, trimOut: target.trimOut, speed: target.speed, volume: target.volume } }; fixture.current.value = validateProject(next, { trusted: true }); revision++ }
    if (desktop) window.__TAURI_INTERNALS__ = {
      convertFileSrc: () => asset.url,
      invoke: async (command, args) => {
        fixture.calls.push({ command, args })
        if (command === 'list_stored_videos') return { directory: '/recordings', assets: [], warnings: [] }
        if (command === 'mcp_asset_cancel') {
          if (args.taskId !== fixture.heldTaskId) throw new Error('Cancellation did not target the active asset task')
          fixture.cancel?.(); return true
        }
        if (command === 'mcp_asset_tool' && args.operation === 'asset_detect_idle') {
          if (fixture.held) await new Promise((resolve, reject) => {
            fixture.heldTaskId = args.taskId
            fixture.cancel = () => { fixture.held = false; fixture.heldTaskId = undefined; fixture.cancel = undefined; reject(new DOMException('已取消', 'AbortError')) }
          })
          if (fixture.fail) throw new Error('静止画面分析失败，请检查源文件。')
          // Controlled detector results test the GUI/shared-tool transaction only.
          // Native media analysis has its own actual FFmpeg fixtures.
          return { assetId: 'source', intervals: fixture.empty ? [] : [{ kind: 'freeze', start: 1, end: 3, duration: 2, confidence: .9 }, { kind: 'silence', start: .5, end: 3.5, duration: 3 }], interpretation: '静止画面候选', start: .5, end: 3.5, complete: true }
        }
        throw new Error(`Unexpected native command: ${command}`)
      },
    }
    fixture.run = async (name, args, options) => {
      fixture.tools.push({ name, args: JSON.parse(JSON.stringify(args)) })
      const original = fixture.current.value, sourceRevision = revision
      const assertCurrent = () => { if (fixture.current.value !== original || revision !== sourceRevision) throw new Error('项目已发生变化') }
      const prepared = await prepareEditorTool(name, args, { ...options, project: original, revision, blobs: new Map([[asset.id, media]]), source: 'gui', assertCurrent })
      options.signal.throwIfAborted(); assertCurrent()
      options.onProgress({ stage: '正在保存处理结果', progress: 1, cancelable: false })
      if (prepared.project) commit(prepared.project)
      await prepared.accept?.(); await nextTick()
      return prepared.data
    }
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    fixture.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': fixture.theme.value }, h(Editor, { ref: fixture.editor, project: fixture.current.value, runTool: fixture.run, onChange: commit, onBusy: value => fixture.busy.push(value), onStatus: message => fixture.messages.push(message) })) })
    fixture.app.mount('#app'); await nextTick(); fixture.editor.value.seek(2.5)
  }, desktop)
  await expect(clip(page, 'video-a')).toBeVisible()
}
async function open(page, id = 'video-a') {
  await clip(page, id).click({ button: 'right' })
  await page.getByTestId('clip-idle-split-open').click()
  const dialog = page.getByRole('dialog', { name: '检测静止画面并分割', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}
async function main() {
  const output = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'idle-clip-split') : '/tmp/open-media-idle-clip-split'
  fs.mkdirSync(output, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
    const url = `http://127.0.0.1:${server.httpServer.address().port}`
    await mount(page, url)
    const original = await state(page)
    await clip(page, 'video-a').click({ button: 'right' })
    await expect(page.getByTestId('clip-type-normal')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('clip-type-repeat').click()
    await expect(clip(page, 'video-a')).toHaveClass(/clip-repeat/)
    await expect(clip(page, 'video-a').getByTestId('clip-repeat-badge')).toHaveText('repeat')
    await page.mouse.move(20, 20)
    await expect(clip(page, 'video-a')).toHaveCSS('background-color', 'rgb(255, 230, 160)')
    await expect(clip(page, 'video-a')).toHaveClass(/selected/)
    await expect(clip(page, 'subtitle-a')).not.toHaveClass(/clip-repeat/)
    await clip(page, 'video-a').click({ button: 'right' })
    await expect(page.getByTestId('clip-type-repeat')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('clip-type-normal').click()
    await expect(clip(page, 'video-a')).not.toHaveClass(/clip-repeat/)
    await page.evaluate(() => window.idleFixture.undo())
    await expect(clip(page, 'video-a')).toHaveClass(/clip-repeat/)
    await page.evaluate(() => window.idleFixture.undo())
    assert.deepEqual(await state(page), original)
    console.log('PASS 右键设置 repeat 黄色类型，普通恢复、选择状态、字幕颜色与撤销正常')

    await page.evaluate(() => window.idleFixture.setLocked(true))
    await clip(page, 'video-a').click({ button: 'right' })
    await expect(page.getByTestId('clip-type-repeat')).toBeDisabled()
    await expect(page.getByTestId('clip-idle-split-open')).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.idleFixture.setLocked(false))
    const dialog = await open(page), panel = dialog.getByTestId('idle-split-panel'), start = panel.getByTestId('idle-split-run')
    await expect(panel.getByLabel('静止画面最短持续时长')).toHaveValue('3')
    await expect(panel.getByLabel('静止画面判断严格程度')).toHaveValue('-60')
    assert.equal(await panel.getByLabel('静止画面判断严格程度').evaluate(element => element.getBoundingClientRect().height), 32)
    await panel.getByLabel('静止画面最短持续时长').fill('4'); await expect(start).toBeDisabled()
    await panel.getByLabel('静止画面最短持续时长').fill('1')
    await page.evaluate(() => { window.idleFixture.held = true })
    const before = await state(page), commits = await page.evaluate(() => window.idleFixture.commits)
    await start.click()
    await expect(panel.getByRole('progressbar')).toBeVisible()
    await expect(start).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '关闭检测静止画面并分割' })).toBeDisabled()
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible()
    // Progress appears before native imports finish. Test cancellation of a started
    // backend task, rather than cancellation before any native task exists.
    await page.waitForFunction(() => {
      const fixture = window.idleFixture
      return typeof fixture.cancel === 'function' && typeof fixture.heldTaskId === 'string'
        && fixture.calls.some(call => call.command === 'mcp_asset_tool' && call.args.operation === 'asset_detect_idle' && call.args.taskId === fixture.heldTaskId)
    })
    const cancelledTaskId = await page.evaluate(() => window.idleFixture.heldTaskId)
    await panel.getByRole('button', { name: '取消处理', exact: true }).click()
    await expect(panel.getByText('已取消', { exact: true })).toBeVisible()
    await expect(panel.getByRole('progressbar')).not.toBeVisible()
    await expect(start).toBeEnabled()
    assert.deepEqual(await state(page), before)
    assert.equal(await page.evaluate(() => window.idleFixture.commits), commits)
    assert.deepEqual(await page.evaluate(() => window.idleFixture.calls.filter(call => call.command === 'mcp_asset_cancel').map(call => call.args.taskId)), [cancelledTaskId])
    assert(await page.evaluate(() => !window.idleFixture.held && !window.idleFixture.cancel && !window.idleFixture.heldTaskId))
    await page.evaluate(() => { window.idleFixture.fail = true })
    await start.click(); await expect(panel.getByRole('alert')).toContainText('静止画面分析失败')
    assert.deepEqual(await state(page), before)
    await page.evaluate(() => { window.idleFixture.fail = false; window.idleFixture.empty = true })
    await start.click(); await expect(panel).toContainText('未发现符合条件的静止画面')
    await expect(start).toBeEnabled()
    assert.equal(await page.evaluate(() => window.idleFixture.commits), commits)
    console.log('PASS 桌面检测参数、锁定保护、取消和失败无改动，无结果允许调整参数重试')

    await page.evaluate(() => { window.idleFixture.empty = false })
    await start.click()
    await expect(panel).toContainText('已分出 1 段静止画面，共 2.0 秒')
    await expect(start).toBeDisabled()
    const after = await state(page), video = after.tracks.find(track => track.kind === 'video')
    assert.equal(video.clips.length, 3)
    const repeat = video.clips.find(item => item.classification === 'repeat')
    assert(repeat); assert.equal(repeat.start, 2.5); assert.equal(repeat.trimIn, 1); assert.equal(repeat.trimOut, 3)
    for (const track of before.tracks.filter(item => item.kind !== 'video')) assert.deepEqual(after.tracks.find(item => item.id === track.id), track)
    assert.equal(await page.evaluate(() => window.idleFixture.commits), commits + 1)
    const request = await page.evaluate(() => window.idleFixture.tools.filter(item => item.name === 'open_media_clip_split_idle').at(-1))
    assert.deepEqual(request.args, { clipId: 'video-a', minDuration: 1, freezeNoiseDb: -60 })
    await page.screenshot({ path: path.join(output, 'idle-split-dark.png'), animations: 'disabled' })
    await panel.getByRole('button', { name: /repeat.*00:02.50/ }).click()
    await expect(dialog).not.toBeVisible()
    await expect(clip(page, repeat.id)).toHaveClass(/selected/)
    await expect(clip(page, repeat.id)).toHaveClass(/clip-repeat/)
    await page.screenshot({ path: path.join(output, 'repeat-timeline-dark.png'), animations: 'disabled' })
    await page.evaluate(() => { window.idleFixture.theme.value = 'light' })
    await page.screenshot({ path: path.join(output, 'repeat-timeline-light.png'), animations: 'disabled' })
    await page.evaluate(() => window.idleFixture.undo())
    assert.deepEqual(await state(page), before)
    console.log('PASS 检测结果经共享工具原子分割、黄色标记，声音字幕不变，结果定位和一步撤销通过')

    await clip(page, 'video-a').click({ button: 'right' })
    await page.getByTestId('clip-type-repeat').click()
    await page.evaluate(() => { window.idleFixture.empty = true })
    await open(page)
    await panel.getByLabel('静止画面最短持续时长').fill('1')
    await start.click()
    await expect(panel).toContainText('未发现符合条件的静止画面')
    await expect(panel.getByRole('button', { name: /repeat.*00:/ })).toHaveCount(0)
    await dialog.getByRole('button', { name: '关闭检测静止画面并分割' }).click()
    await page.evaluate(() => { window.idleFixture.empty = false; window.idleFixture.undo() })
    assert.deepEqual(await state(page), before)
    console.log('PASS 已手动标记 repeat 的片段无检测命中时，不显示旧标记为新结果')

    await page.setViewportSize({ width: 400, height: 800 })
    await open(page)
    await expect(dialog).toBeVisible()
    assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth))
    await page.screenshot({ path: path.join(output, 'idle-split-narrow-light.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: '关闭检测静止画面并分割' }).click()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => window.idleFixture.setFreeze())
    await clip(page, 'video-a').click({ button: 'right' })
    await expect(page.getByTestId('clip-idle-split-open')).toBeDisabled()
    await expect(page.getByTestId('clip-type-repeat')).toBeEnabled()
    await page.keyboard.press('Escape')
    await clip(page, 'subtitle-a').click({ button: 'right' })
    await expect(page.getByTestId('clip-idle-split-open')).toHaveCount(0)
    await expect(page.getByTestId('clip-type-repeat')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await mount(page, url, false)
    const webDialog = await open(page)
    await expect(webDialog).toContainText('静止画面检测需要桌面版运行环境')
    await expect(webDialog.getByTestId('idle-split-run')).toBeDisabled()
    assert.deepEqual(errors, [])
    console.log('PASS 窄屏/浅深主题、主动定格保护、非视频隐藏和网页环境提示')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
