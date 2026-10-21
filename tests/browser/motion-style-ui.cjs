const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

async function mount(page, url, native = false) {
  await page.route('**/__motion_style__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app,.app-shell{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/__motion_style__`)
  await page.evaluate(async native => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueURL)
    const { createProject, createClip } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
    const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
    const { BACKGROUND_MUSIC } = await import('/src/core/background-music-catalog.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const { prepareEditorTool } = await import('/src/core/editor-tool-service.ts')
    const media = await (await fetch(VIDEO_SEGMENTS[0].url)).blob()
    const video = await importMediaFile(new File([media], '产品演示.webm', { type: 'video/webm' }))
    video.id = 'source-video'
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
    const ctx = canvas.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, 640, 360)
    gradient.addColorStop(0, '#5299c9'); gradient.addColorStop(1, '#d3e6bb'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 360)
    ctx.fillStyle = '#18364b'; ctx.font = 'bold 48px sans-serif'; ctx.fillText('OPEN MEDIA', 80, 185)
    const photoBytes = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const photo = await importMediaFile(new File([photoBytes], '封面图片.png', { type: 'image/png' })); photo.id = 'source-photo'
    const musicBytes = await (await fetch(BACKGROUND_MUSIC[0].url)).blob()
    const music = await importMediaFile(new File([musicBytes], '柔和配乐.mp3', { type: 'audio/mpeg' })); music.id = 'source-music'
    const project = createProject('素材驱动风格成片', { width: 640, height: 360, fps: 24 })
    const fixture = window.motionStyle = { current: shallowRef(project), editor: ref(), theme: ref('dark'), busy: [], calls: [], progress: [], imports: 0, commits: 0, messages: [], hold: false, fail: false, captures: 0, blobs: new Map([[video.id, media], [photo.id, photoBytes], [music.id, musicBytes]]) }
    let history = createHistory(project), revision = 0
    const commit = (next, label) => { history = commitHistory(history, next); fixture.current.value = next; revision++; fixture.commits++; fixture.messages.push(label) }
    fixture.undo = () => { history = undoHistory(history); fixture.current.value = history.present; revision++ }
    fixture.redo = () => { history = redoHistory(history); fixture.current.value = history.present; revision++ }
    fixture.populate = () => {
      const next = structuredClone(project); next.assets.push(video, photo, music)
      next.tracks.find(track => track.kind === 'video').clips.push(createClip(video, next, { id: 'existing-video', trimOut: 3 }))
      next.markers = [{ id: 'existing-marker', time: 1, label: '原有标记', kind: 'chapter', color: '#33aaff' }]
      commit(next, '导入示例素材')
    }
    fixture.lock = value => {
      const next = JSON.parse(JSON.stringify(fixture.current.value))
      next.tracks.find(track => track.clips.some(clip => clip.id === 'existing-video')).locked = value
      commit(next, value ? '锁定原轨道' : '解锁原轨道')
    }
    navigator.mediaDevices.getUserMedia = async () => { fixture.captures++; throw new Error('This interaction test must not capture media devices') }
    fixture.run = async (name, args, options) => {
      fixture.calls.push({ name, args: JSON.parse(JSON.stringify(args)) })
      // This controllable wait exercises cancellation and busy UI only. Successful
      // compositions below call the real service and import its real PNG artwork.
      if (fixture.hold) await new Promise((resolve, reject) => {
        options.onProgress({ stage: '正在等待测试任务', progress: .2 })
        const cancel = () => { fixture.hold = false; reject(new DOMException('已取消', 'AbortError')) }
        if (options.signal.aborted) cancel(); else options.signal.addEventListener('abort', cancel, { once: true })
      })
      if (fixture.fail) { fixture.fail = false; throw new Error('示例素材暂时不可用') }
      const original = fixture.current.value, originalRevision = revision
      const assertCurrent = () => { if (originalRevision !== revision || original.id !== fixture.current.value.id) throw new Error('项目已变化') }
      const prepared = await prepareEditorTool(name, args, { ...options, onProgress: update => { fixture.progress.push(update); options.onProgress(update) }, project: original, revision, blobs: fixture.blobs, source: 'gui', assertCurrent })
      try {
        options.signal.throwIfAborted(); assertCurrent()
        if (prepared.project) {
          options.onProgress({ stage: '正在保存处理结果', progress: 1, cancelable: false })
          for (const { asset, blob } of prepared.assets || []) if (blob) fixture.blobs.set(asset.id, blob)
          commit(prepared.project, prepared.label)
        }
        await prepared.accept?.(); await nextTick()
        fixture.last = prepared.data
        return prepared.data
      } catch (cause) { await prepared.discard?.(); throw cause }
    }
    if (native) window.__TAURI_INTERNALS__ = {
      convertFileSrc: () => video.url,
      invoke: async command => {
        if (command === 'list_stored_videos') return { directory: '/recordings', warnings: [], assets: [{ ...video, id: 'unregistered-recording', name: '尚未加入工程.webm', nativePath: '/recordings/not-imported.webm' }] }
        throw new Error(`Unexpected native call in recording guard test: ${command}`)
      },
    }
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    fixture.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': fixture.theme.value }, h(Editor, {
      ref: fixture.editor, project: fixture.current.value, runTool: fixture.run, onChange: commit,
      onBusy: value => fixture.busy.push(value), onStatus: message => fixture.messages.push(message), onImport: () => fixture.imports++,
    })) })
    fixture.app.mount('#app')
  }, native)
}

async function main() {
  const output = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'motion-style') : '/tmp/open-media-motion-style'
  fs.mkdirSync(output, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }), errors = []
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000)
    const url = `http://127.0.0.1:${server.httpServer.address().port}`
    await mount(page, url)
    await expect(page.getByTestId('motion-style-open')).toHaveCount(0)
    await expect(page.getByTestId('effect-clip-panel')).toHaveCount(0)
    await page.locator('.editor-tools').getByRole('button', { name: '导入素材', exact: true }).click()
    assert.equal(await page.evaluate(() => window.motionStyle.imports), 1)
    await page.evaluate(() => window.motionStyle.populate())
    const card = id => page.locator(`[data-source-asset-id="${id}"]`)
    const menu = page.getByRole('menu', { name: '素材操作', exact: true })
    await card('source-video').click()
    await card('source-photo').click({ modifiers: ['Control'] })
    await expect(card('source-video')).toHaveAttribute('aria-pressed', 'true')
    await expect(card('source-photo')).toHaveAttribute('aria-pressed', 'true')
    await card('source-music').click({ modifiers: ['Control'] })
    await expect(page.getByTestId('asset-effect-selection-open')).toBeDisabled()
    await card('source-music').click({ modifiers: ['Control'] })
    await card('source-video').click({ button: 'right' })
    await expect(menu.getByTestId('asset-effect-clip-open')).toContainText('2 个素材')
    await menu.getByTestId('asset-effect-clip-open').click()
    const panel = page.getByTestId('effect-clip-panel')
    await expect(panel).toBeVisible()
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await expect(panel.locator('[data-style-id]')).toHaveCount(15)
    await expect(panel.locator('input[type=file]')).toHaveCount(0)
    await expect(panel.getByLabel('选择分镜素材')).toHaveCount(0)
    await expect(panel.locator('[data-scene-asset-id]')).toHaveCount(2)
    await panel.getByRole('button', { name: '科技视窗', exact: true }).click()
    await panel.getByLabel('场景 1 标题', { exact: true }).fill('让故事有自己的节奏')
    await panel.getByLabel('场景 1 说明', { exact: true }).fill('素材、图形与文字，编排成新的表达。')
    await panel.getByLabel('场景 1 时长', { exact: true }).fill('2')
    await panel.getByLabel('场景 1 视频起点', { exact: true }).fill('0.5')
    await panel.getByLabel('场景 2 标题', { exact: true }).fill('从一张图片开始')
    await panel.getByLabel('场景 2 时长', { exact: true }).fill('2')
    await panel.getByRole('button', { name: '上移场景 2', exact: true }).click()
    await expect(panel.getByLabel('场景 1 标题', { exact: true })).toHaveValue('从一张图片开始')
    await panel.getByLabel('效果片段名称', { exact: true }).fill('产品故事')
    await panel.getByText('配色与节奏', { exact: true }).click()
    await expect(panel.getByLabel('效果强调颜色')).toHaveValue('#5be2da')
    await panel.getByLabel('效果强调颜色').fill('#ffb86c')
    await panel.getByLabel('动画节奏', { exact: true }).selectOption('energetic')
    await panel.getByLabel('效果品牌图片', { exact: true }).selectOption('source-photo')
    await panel.getByText('声音', { exact: true }).click()
    await panel.getByLabel('效果背景音乐', { exact: true }).selectOption('source-music')
    await panel.getByLabel('效果配乐音量', { exact: true }).fill('22')
    await panel.getByLabel('保留视频原声', { exact: true }).check()
    await expect(panel.getByLabel('同时插入当前播放头')).not.toBeChecked()
    await expect(panel.getByTestId('effect-clip-generate')).toBeEnabled()
    await panel.locator('.effect-fields').evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: path.join(output, 'effects-inline-dark.png'), fullPage: true })
    console.log('PASS 工程素材多选、右键与内联入口，无独立上传/素材弹窗，15种风格和参数')

    const before = await page.evaluate(() => JSON.parse(JSON.stringify(window.motionStyle.current.value)))
    const commits = await page.evaluate(() => window.motionStyle.commits)
    await page.evaluate(() => { window.motionStyle.hold = true })
    await panel.getByTestId('effect-clip-generate').click()
    await expect(panel.getByRole('button', { name: '取消处理', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '关闭效果片段设置' })).toBeDisabled()
    await expect(panel.getByLabel('场景 1 标题', { exact: true })).toBeDisabled()
    await expect(panel.getByRole('progressbar')).toHaveAttribute('value', '20')
    await panel.getByRole('button', { name: '取消处理', exact: true }).click()
    await expect(panel.getByText('已取消', { exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.motionStyle.busy.at(-1)), false)
    assert.equal(await page.evaluate(() => window.motionStyle.commits), commits)
    assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(window.motionStyle.current.value))), before)
    await page.evaluate(() => { window.motionStyle.fail = true })
    await panel.getByTestId('effect-clip-generate').click()
    await expect(panel.getByRole('alert')).toContainText('示例素材暂时不可用')
    await expect(page.getByRole('button', { name: '关闭效果片段设置' })).toBeEnabled()
    console.log('PASS 取消和失败不污染工程，输入与关闭保护，进度与任务解锁')

    await panel.getByTestId('effect-clip-generate').click()
    await expect(panel).not.toBeVisible({ timeout: 120000 })
    const generated = await page.evaluate(() => {
      const f = window.motionStyle, data = f.last, asset = f.current.value.assets.find(asset => asset.id === data.assetId)
      return { project: JSON.parse(JSON.stringify(f.current.value)), data, asset, blobSize: f.blobs.get(asset.id)?.size, commits: f.commits, call: f.calls.at(-1), progress: f.progress }
    })
    assert.equal(generated.commits, commits + 1)
    assert.equal(generated.data.destination, 'assets')
    assert.equal(generated.data.clipId, undefined)
    assert.equal(generated.asset.kind, 'video'); assert.equal(generated.asset.libraryRole, undefined)
    assert.ok(generated.blobSize > 1000); assert.ok(Math.abs(generated.asset.duration - 4) < .2)
    assert.equal(generated.call.name, 'open_media_motion_clip_generate')
    assert.equal(generated.call.args.scenes[0].assetId, 'source-photo')
    assert.equal(generated.call.args.scenes[1].trimIn, .5)
    assert.equal(generated.call.args.musicVolume, .22); assert.equal(generated.call.args.accent, '#ffb86c')
    assert.equal(generated.call.args.sourceAudio, true); assert.equal(generated.call.args.placement, undefined)
    assert.deepEqual(generated.project.assets.slice(0, 3), before.assets)
    assert.deepEqual(generated.project.tracks, before.tracks); assert.deepEqual(generated.project.markers, before.markers)
    assert.equal(generated.project.assets.length, before.assets.length + 1)
    assert.ok(generated.progress.some(update => update.stage.includes('编码')))
    await expect(card(generated.asset.id)).toBeVisible(); await expect(card(generated.asset.id)).toHaveAttribute('aria-pressed', 'true')
    await expect(card(generated.asset.id)).toBeFocused()
    const decoded = await page.evaluate(async id => {
      const asset = window.motionStyle.current.value.assets.find(asset => asset.id === id), video = document.createElement('video')
      video.muted = true; video.preload = 'auto'; video.src = asset.url
      try { await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Generated video failed to decode')); video.load() }); return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, ready: video.readyState } }
      finally { video.removeAttribute('src'); video.load() }
    }, generated.asset.id)
    assert.equal(decoded.width, 640); assert.equal(decoded.height, 360); assert.ok(decoded.ready >= 2)
    await page.evaluate(() => window.motionStyle.undo())
    assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(window.motionStyle.current.value))), before)
    await page.evaluate(() => window.motionStyle.redo())
    await card(generated.asset.id).dblclick()
    await expect.poll(() => page.evaluate(id => window.motionStyle.current.value.tracks.flatMap(track => track.clips).filter(clip => clip.assetId === id).length, generated.asset.id)).toBe(1)
    await page.evaluate(() => window.motionStyle.undo())
    const trackId = before.tracks.find(track => track.kind === 'video').id
    await card(generated.asset.id).dragTo(page.locator(`[data-track-id="${trackId}"]`), { targetPosition: { x: 230, y: 20 } })
    await expect.poll(() => page.evaluate(id => window.motionStyle.current.value.tracks.flatMap(track => track.clips).filter(clip => clip.assetId === id).length, generated.asset.id)).toBe(1)
    await page.evaluate(() => window.motionStyle.undo())
    console.log('PASS 真实编码视频可解码、默认仅入素材、原工程不变、一笔撤销/恢复、双击与拖拽剪辑')

    await card('source-video').click()
    await card('source-photo').click({ modifiers: ['Shift'] })
    await expect(card('source-video')).toHaveAttribute('aria-pressed', 'true')
    await expect(card('source-photo')).toHaveAttribute('aria-pressed', 'true')
    await card('source-photo').click()
    await page.getByTestId('asset-effect-selection-open').click()
    await expect(panel.locator('[data-scene-asset-id]')).toHaveCount(1)
    await panel.getByLabel('场景 1 时长', { exact: true }).fill('1')
    await expect(panel.getByTestId('effect-clip-generate')).toBeDisabled()
    await expect(panel.getByRole('alert')).toContainText('2 至 12')
    await panel.getByLabel('场景 1 时长', { exact: true }).fill('2')
    await panel.getByLabel('场景 1 标题', { exact: true }).fill('你的素材，新的表达')
    await panel.getByLabel('场景 1 说明', { exact: true }).fill('生成效果片段，继续分割、配音与剪辑。')
    await page.evaluate(() => { window.motionStyle.theme.value = 'light' })
    await page.setViewportSize({ width: 1280, height: 720 })
    assert.ok(await panel.evaluate(element => element.querySelector('[data-testid="effect-clip-generate"]').getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom))
    await page.screenshot({ path: path.join(output, 'effects-inline-720-light.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 980 })
    await page.evaluate(async () => { document.activeElement?.blur(); await window.motionStyle.editor.value.setPlayback({ time: 1.25 }) })
    await panel.getByLabel('同时插入当前播放头').check()
    await panel.getByTestId('effect-clip-generate').click()
    await expect(panel).not.toBeVisible({ timeout: 120000 })
    const inserted = await page.evaluate(() => ({ data: window.motionStyle.last, project: JSON.parse(JSON.stringify(window.motionStyle.current.value)) }))
    assert.equal(inserted.data.destination, 'timeline'); assert.equal(inserted.data.start, 1.25)
    assert.equal(inserted.project.tracks.flatMap(track => track.clips).find(clip => clip.id === inserted.data.clipId).start, 1.25)
    await expect(page.locator(`.timeline-clip[data-clip-id="${inserted.data.clipId}"]`)).toHaveClass(/selected/)
    await page.locator(`.timeline-clip[data-clip-id="${inserted.data.clipId}"]`).click({ button: 'right' })
    await page.getByTestId('clip-effect-clip-open').click()
    await expect(panel.locator('[data-scene-asset-id]')).toHaveAttribute('data-scene-asset-id', inserted.data.assetId)
    await page.getByRole('button', { name: '关闭效果片段设置' }).click()
    await page.evaluate(async () => { document.activeElement?.blur(); await window.motionStyle.editor.value.setPlayback({ time: 2.25 }) })
    await page.waitForFunction(() => {
      const canvas = window.motionStyle.editor.value.getCanvas(), context = canvas?.getContext('2d')
      return context && context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[0] > 70
    })
    await card('source-photo').click()
    await page.getByTestId('asset-effect-selection-open').click()
    await panel.getByLabel('场景 1 标题', { exact: true }).fill('你的素材，新的表达')
    await panel.getByLabel('场景 1 说明', { exact: true }).fill('生成效果片段，继续分割、配音与剪辑。')
    await panel.getByLabel('场景 1 时长', { exact: true }).fill('2')
    await panel.locator('.effect-fields').evaluate(element => { element.scrollTop = 0 })
    await card(inserted.data.assetId).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, 'effects-result-inline-light.png'), fullPage: true })
    await page.evaluate(() => { window.motionStyle.theme.value = 'dark' })
    await page.screenshot({ path: path.join(output, 'effects-result-inline-dark.png'), fullPage: true })
    assert.equal(await page.evaluate(() => window.motionStyle.captures), 0)
    assert.deepEqual(errors, [])
    console.log('PASS Shift选择、时长验证、720px底部控制、播放头插入、时间线源素材入口')

    const nativePage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await mount(nativePage, url, true)
    const recording = nativePage.locator('[data-source-asset-id="unregistered-recording"]')
    await expect(recording).toBeVisible(); await recording.click({ button: 'right' })
    await expect(nativePage.getByTestId('asset-effect-clip-open')).toBeDisabled()
    await expect(nativePage.getByRole('menu', { name: '素材操作' })).toContainText('请先双击将录屏加入项目')
    assert.equal(await nativePage.evaluate(() => window.motionStyle.calls.length), 0)
    await nativePage.close()
    console.log('PASS 未加入工程的录屏禁止生成，说明先导入/插入，不接受任意本地路径')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
