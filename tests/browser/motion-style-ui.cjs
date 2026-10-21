const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

async function mount(page, url) {
  await page.route('**/__motion_style__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app,.app-shell{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/__motion_style__`)
  await page.evaluate(async () => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueURL)
    const { createProject, createClip } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory } = await import('/src/core/timeline.ts')
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
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    fixture.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': fixture.theme.value }, h(Editor, {
      ref: fixture.editor, project: fixture.current.value, runTool: fixture.run, onChange: commit,
      onBusy: value => fixture.busy.push(value), onStatus: message => fixture.messages.push(message), onImport: () => fixture.imports++,
    })) })
    fixture.app.mount('#app')
  })
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = []
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000)
    await mount(page, `http://127.0.0.1:${server.httpServer.address().port}`)
    const open = page.getByTestId('motion-style-open'), dialog = page.getByRole('dialog', { name: '风格成片', exact: true })
    await open.click()
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-style-id]')).toHaveCount(15)
    await expect(dialog.getByTestId('motion-compose-submit')).toBeDisabled()
    await dialog.getByRole('button', { name: '导入素材', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    assert.equal(await page.evaluate(() => window.motionStyle.imports), 1)
    await expect(open).toBeFocused()
    await page.evaluate(() => window.motionStyle.populate())
    await open.click()
    await dialog.getByRole('button', { name: '科技视窗', exact: true }).click()
    await expect(dialog.getByLabel('成片强调颜色')).toHaveValue('#5be2da')
    await dialog.getByLabel('选择分镜素材').selectOption('source-video')
    await dialog.getByTestId('motion-add-scene').click()
    await dialog.getByLabel('分镜 1 标题', { exact: true }).fill('让故事有自己的节奏')
    await dialog.getByLabel('分镜 1 说明', { exact: true }).fill('素材、图形与文字，编排成新的表达。')
    await dialog.getByLabel('分镜 1 时长', { exact: true }).fill('3')
    await dialog.getByLabel('分镜 1 视频起点', { exact: true }).fill('0.5')
    await dialog.getByLabel('选择分镜素材').selectOption('source-photo')
    await dialog.getByTestId('motion-add-scene').click()
    await dialog.getByLabel('分镜 2 标题', { exact: true }).fill('从一张图片开始')
    await dialog.getByLabel('分镜 2 时长', { exact: true }).fill('2')
    await dialog.getByRole('button', { name: '上移分镜 2', exact: true }).click()
    await expect(dialog.getByLabel('分镜 1 标题', { exact: true })).toHaveValue('从一张图片开始')
    await expect(dialog.getByLabel('分镜 2 视频起点', { exact: true })).toHaveValue('0.5')
    await dialog.getByLabel('成片名称', { exact: true }).fill('产品故事')
    await dialog.getByLabel('动画节奏', { exact: true }).selectOption('energetic')
    await dialog.getByLabel('成片背景音乐', { exact: true }).selectOption('source-music')
    await dialog.getByLabel('成片配乐音量', { exact: true }).fill('22')
    await dialog.getByLabel('成片品牌图片', { exact: true }).selectOption('source-photo')
    await dialog.getByLabel('保留视频原声', { exact: true }).check()
    await dialog.getByLabel('成片强调颜色').fill('#ffb86c')
    await expect(dialog.getByTestId('motion-compose-submit')).toBeEnabled()
    assert.ok(await dialog.evaluate(element => element.querySelector('[data-testid="motion-compose-submit"]').getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom - 6))
    await page.screenshot({ path: path.join(output, 'composer-dark.png'), fullPage: true })
    console.log('PASS 空工程导入、15种风格、配色、分镜排序、原声、配乐与品牌图片')

    const before = await page.evaluate(() => JSON.parse(JSON.stringify(window.motionStyle.current.value)))
    const commits = await page.evaluate(() => window.motionStyle.commits)
    await page.evaluate(() => { window.motionStyle.hold = true })
    await dialog.getByTestId('motion-compose-submit').click()
    await expect(dialog.getByRole('button', { name: '取消处理', exact: true })).toBeEnabled()
    await expect(dialog.getByRole('button', { name: '关闭风格成片', exact: true })).toBeDisabled()
    await expect(dialog.getByLabel('分镜 1 标题', { exact: true })).toBeDisabled()
    await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '20')
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消处理', exact: true }).click()
    await expect(dialog.getByText('已取消', { exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.motionStyle.busy.at(-1)), false)
    assert.equal(await page.evaluate(() => window.motionStyle.commits), commits)
    assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(window.motionStyle.current.value))), before)
    await page.evaluate(() => { window.motionStyle.fail = true })
    await dialog.getByTestId('motion-compose-submit').click()
    await expect(dialog.getByRole('alert')).toContainText('示例素材暂时不可用')
    await expect(dialog.getByRole('button', { name: '关闭风格成片', exact: true })).toBeEnabled()
    console.log('PASS 进度、取消、任务错误不改工程，取消后释放忙碌状态')

    await dialog.getByTestId('motion-compose-submit').click()
    await expect(dialog).not.toBeVisible()
    const generated = await page.evaluate(() => {
      const f = window.motionStyle
      return { project: JSON.parse(JSON.stringify(f.current.value)), data: f.last, commits: f.commits, call: f.calls.at(-1), progress: f.progress, sizes: f.last ? f.current.value.assets.filter(asset => !['source-video', 'source-photo', 'source-music'].includes(asset.id)).map(asset => f.blobs.get(asset.id)?.size) : [] }
    })
    assert.equal(generated.commits, commits + 1)
    assert.equal(generated.data.start, 3)
    assert.equal(generated.data.sceneCount, 2)
    assert.equal(generated.data.duration, 5)
    assert.equal(generated.call.name, 'open_media_motion_compose')
    assert.equal(generated.call.args.scenes[0].assetId, 'source-photo')
    assert.equal(generated.call.args.scenes[1].trimIn, .5)
    assert.equal(generated.call.args.musicVolume, .22)
    assert.equal(generated.call.args.accent, '#ffb86c')
    assert.equal(generated.call.args.sourceAudio, true)
    assert.deepEqual(generated.project.assets.slice(0, 3), before.assets)
    assert.deepEqual(generated.project.tracks.find(track => track.id === before.tracks[0].id), before.tracks[0])
    assert.equal(generated.sizes.length, 2); assert.ok(generated.sizes.every(size => size > 1000))
    assert.ok(generated.project.tracks.flatMap(track => track.clips).some(clip => clip.text === '让故事有自己的节奏' && clip.keyframes))
    assert.ok(generated.progress.some(update => update.stage.includes('绘制')))
    await expect(page.locator(`.timeline-clip[data-clip-id="${generated.data.selection.clipId}"]`)).toHaveClass(/selected/)
    await page.evaluate(() => window.motionStyle.undo())
    assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(window.motionStyle.current.value))), before)
    console.log('PASS 真实 PNG 资源与可编辑动画图层生成，单次提交/撤销，生成后定位片段')

    await open.click()
    await dialog.getByLabel('选择分镜素材').selectOption('source-video')
    await dialog.getByTestId('motion-add-scene').click()
    const sourceDuration = before.assets.find(asset => asset.id === 'source-video').duration
    await dialog.getByLabel('分镜 1 视频起点', { exact: true }).fill(String(sourceDuration - .5))
    await expect(dialog.locator('.motion-warnings')).toContainText('已缩短')
    await dialog.getByLabel('分镜 1 时长', { exact: true }).fill('1')
    await expect(dialog.getByTestId('motion-compose-submit')).toBeDisabled()
    await expect(dialog.getByRole('alert')).toContainText('2 至 12')
    await dialog.getByRole('button', { name: '删除分镜 1', exact: true }).click()
    await dialog.getByLabel('选择分镜素材').selectOption('source-photo')
    await dialog.getByTestId('motion-add-scene').click()
    await dialog.getByLabel('分镜 1 时长', { exact: true }).fill('2')
    await dialog.getByLabel('成片插入位置', { exact: true }).selectOption('prepend')
    await page.evaluate(() => window.motionStyle.lock(true))
    await expect(dialog.getByRole('alert')).toContainText('解锁')
    await expect(dialog.getByTestId('motion-compose-submit')).toBeDisabled()
    await page.evaluate(() => window.motionStyle.lock(false))
    await expect(dialog.getByTestId('motion-compose-submit')).toBeEnabled()
    await page.evaluate(() => { window.motionStyle.theme.value = 'light' })
    await page.screenshot({ path: path.join(output, 'composer-light.png'), fullPage: true })
    await page.setViewportSize({ width: 680, height: 1000 })
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1))
    await page.screenshot({ path: path.join(output, 'composer-compact.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1100 })
    await dialog.getByTestId('motion-compose-submit').click()
    await expect(dialog).not.toBeVisible()
    const prepended = await page.evaluate(() => JSON.parse(JSON.stringify(window.motionStyle.current.value)))
    assert.equal(prepended.tracks.flatMap(track => track.clips).find(clip => clip.id === 'existing-video').start, 2)
    assert.equal(prepended.markers.find(marker => marker.id === 'existing-marker').time, 3)
    assert.equal(await page.evaluate(() => window.motionStyle.captures), 0)
    assert.deepEqual(errors, [])
    console.log('PASS 短视频警告、时长校验、前插锁定保护、标记顺延、明暗与窄屏布局')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
