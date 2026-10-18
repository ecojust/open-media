const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

const read = page => page.evaluate(() => JSON.parse(JSON.stringify(window.cutFixture.current.value)))
const clips = project => project.tracks.flatMap(track => track.clips)
const effects = project => project.tracks.filter(track => track.kind === 'transition').flatMap(track => track.clips)
const clipButton = (page, id) => page.locator(`.timeline-clip[data-clip-id="${id}"]`)

async function mount(page, url) {
  await page.route('**/__cut_editor__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/__cut_editor__`)
  await page.evaluate(async () => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref } = await import(vueURL)
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    const { createProject, createClip, createTextClip, validateProject } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
    const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const blob = await (await fetch(VIDEO_SEGMENTS[0].url)).blob()
    const asset = await importMediaFile(new File([blob], 'original.webm', { type: 'video/webm' }))
    const project = createProject('转场与片头片尾交互', { width: 640, height: 360, fps: 24 })
    project.assets.push(asset)
    project.tracks.find(track => track.kind === 'video').clips.push(
      createClip(asset, project, { id: 'part-a', name: '前半段', trimIn: 0, trimOut: 2.5 }),
      createClip(asset, project, { id: 'part-b', name: '后半段', start: 2.5, trimIn: 2.5, trimOut: 5 }),
    )
    project.tracks[0].clips.push(createTextClip(project, { id: 'original-caption', text: '保留字幕同步', trimOut: 5, fontSize: 22 }))
    const current = shallowRef(validateProject(project, { trusted: true })), editor = ref(null)
    let history = createHistory(current.value)
    const fixture = window.cutFixture = { current, editor, messages: [], prepared: [], busy: [],
      undo() { history = undoHistory(history); current.value = history.present },
      redo() { history = redoHistory(history); current.value = history.present },
      replace(next) { current.value = validateProject(next, { trusted: true }); history = createHistory(current.value) },
    }
    fixture.app = createApp({ render: () => h(Editor, { ref: editor, project: current.value,
      onChange: next => { history = commitHistory(history, next); current.value = next },
      onStatus: message => fixture.messages.push(message), onBusy: busy => fixture.busy.push(busy),
      onPreparedAsset: (asset, blob) => fixture.prepared.push({ id: asset.id, bytes: blob.size }),
    }) })
    fixture.app.mount('#app')
  })
  await expect(clipButton(page, 'part-a')).toBeVisible()
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(20000)
  try {
    await mount(page, `http://127.0.0.1:${server.httpServer.address().port}`)
    const original = await read(page)
    const toolbar = await page.locator('.timeline-clip-tools button').allTextContents()
    assert(toolbar.indexOf('片头') === toolbar.indexOf('背景音乐') + 1)
    assert(toolbar.indexOf('片尾') === toolbar.indexOf('片头') + 1)
    assert(toolbar.indexOf('转场') === toolbar.indexOf('片尾') + 1)
    const templateIds = await page.evaluate(async () => {
      const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
      return { prepend: VIDEO_SEGMENTS.filter(item => item.placement === 'prepend').map(item => item.id), append: VIDEO_SEGMENTS.filter(item => item.placement === 'append').map(item => item.id) }
    })
    await expect(page.getByLabel('项目宽度', { exact: true })).toBeVisible()
    await page.getByTestId('transition-open').click()
    const gallery = page.getByRole('dialog', { name: '转场', exact: true })
    await expect(gallery.getByRole('radio')).toHaveCount(15)
    for (const effect of ['zoom-fade', 'zoom-fade-left', 'zoom-fade-right', 'zoom-fade-up', 'zoom-fade-down']) {
      await expect(gallery.locator(`input[value="${effect}"]`)).toHaveCount(1)
    }
    await page.screenshot({ path: '/tmp/open-media-transition-library.png' })
    await expect(gallery).toContainText('切点 2.50 秒')
    await gallery.locator('.transition-card').filter({ hasText: '纵向开合' }).click()
    await gallery.getByLabel('转场时长', { exact: true }).fill('1.2')
    await gallery.getByTestId('transition-apply').click()
    await expect(gallery).toHaveCount(0)
    let next = await read(page), effect = effects(next)[0]
    assert.deepEqual([effect.transition.effect, effect.start, effect.trimOut], ['close-vertical', 1.9, 1.2])
    await expect(clipButton(page, effect.id)).toHaveClass(/transition/)
    await expect(clipButton(page, effect.id).locator('.trim-handle')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '复制片段', exact: true })).toBeDisabled()
    await expect(page.locator('.preview-selection')).toHaveCount(0)
    await page.getByLabel('片段转场效果').selectOption('slide-left')
    assert.equal(effects(await read(page))[0].transition.effect, 'slide-left')
    const beforeDrag = effects(await read(page))[0]
    const bounds = await clipButton(page, effect.id).boundingBox()
    await page.mouse.move(bounds.x + 8, bounds.y + 8); await page.mouse.down(); await page.mouse.move(bounds.x + 80, bounds.y + 8); await page.mouse.up()
    assert.deepEqual(effects(await read(page))[0], beforeDrag, '转场不可拖离关联切点')
    await page.evaluate(() => window.cutFixture.undo())
    assert.equal(effects(await read(page))[0].transition.effect, 'close-vertical')
    await page.evaluate(() => window.cutFixture.redo())
    assert.equal(effects(await read(page))[0].transition.effect, 'slide-left')
    const lengthInput = page.getByLabel('片段转场时长')
    await lengthInput.fill('99'); await lengthInput.blur()
    await expect(lengthInput).toHaveValue('2.5')
    await lengthInput.fill('99'); await lengthInput.blur()
    await expect(lengthInput).toHaveValue('2.5')
    await lengthInput.fill('-1'); await lengthInput.blur()
    await expect(lengthInput).toHaveValue('2.5')
    await page.evaluate(() => window.cutFixture.undo())
    assert.equal(effects(await read(page))[0].trimOut, 1.2)
    await page.getByRole('button', { name: '停用转场', exact: true }).click()
    assert.equal((await read(page)).tracks.find(track => track.kind === 'transition').muted, true)
    await page.getByRole('button', { name: '启用转场', exact: true }).click()
    assert.equal((await read(page)).tracks.find(track => track.kind === 'transition').muted, false)
    await page.getByTestId('transition-open').click()
    await gallery.locator('.transition-card').filter({ has: page.locator('input[value="zoom-fade"]') }).click()
    await gallery.getByLabel('转场时长', { exact: true }).fill('1.2')
    await gallery.getByTestId('transition-apply').click()
    await expect(gallery).toHaveCount(0)
    assert.equal(effects(await read(page)).length, 1, '同一个切点应用新转场应替换效果')
    assert.equal(effects(await read(page))[0].transition.effect, 'zoom-fade')
    for (const effectId of ['zoom-fade-left', 'zoom-fade-right', 'zoom-fade-up', 'zoom-fade-down']) {
      await page.getByLabel('片段转场效果').selectOption(effectId)
      assert.equal(effects(await read(page))[0].transition.effect, effectId)
    }
    await page.evaluate(() => window.cutFixture.undo())
    assert.equal(effects(await read(page))[0].transition.effect, 'zoom-fade-up')
    await page.evaluate(() => window.cutFixture.redo())
    assert.equal(effects(await read(page))[0].transition.effect, 'zoom-fade-down')
    assert.equal(effects(await read(page))[0].start, 1.9)
    assert.equal(effects(await read(page))[0].trimOut, 1.2)
    console.log('PASS 转场库15效果、5种缩放淡化应用及修改、切点居中、禁止自由拖动/复制、撤销重做')

    await page.getByTestId('video-segment-intro-open').click()
    const segments = page.getByRole('dialog', { name: '片头', exact: true })
    await expect(segments.getByTestId('video-segment-item')).toHaveCount(templateIds.prepend.length)
    assert.deepEqual(await segments.getByTestId('video-segment-item').evaluateAll(items => items.map(item => item.dataset.segmentId)), templateIds.prepend)
    await expect(segments.getByRole('radio')).toHaveCount(0)
    await expect(segments.getByTestId('video-segment-add')).toHaveText('添加到项目开头')
    await segments.getByTestId('video-segment-heading').fill('我们的开场')
    await segments.getByTestId('video-segment-subheading').fill('保持所有轨道同步')
    await segments.getByTestId('video-segment-preview').click()
    await expect.poll(() => segments.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(.1)
    await segments.getByTestId('video-segment-add').click()
    await expect(segments).toHaveCount(0)
    next = await read(page)
    for (const prior of clips(original)) assert.equal(clips(next).find(clip => clip.id === prior.id).start, prior.start + 5)
    assert.equal(effects(next)[0].start, 6.9)
    assert(clips(next).some(clip => clip.text === '我们的开场' && clip.start === 0 && clip.trimOut === 5))
    assert.deepEqual([next.width, next.height], [640, 360])
    assert((await page.evaluate(() => window.cutFixture.prepared)).some(item => item.bytes > 1000))
    await page.evaluate(() => window.cutFixture.undo())
    assert.equal(clips(await read(page)).find(clip => clip.id === 'part-a').start, 0)
    await page.evaluate(() => window.cutFixture.redo())
    assert.equal(clips(await read(page)).find(clip => clip.id === 'part-a').start, 5)
    await page.getByTestId('transition-open').click()
    await expect(gallery).toContainText('切点 5.00 秒')
    await gallery.getByTestId('transition-apply').click()
    await expect(gallery).toHaveCount(0)
    assert.equal(effects(await read(page)).length, 2, '片头与正文能直接添加转场')
    console.log('PASS 真实模板播放、可编辑片头文字、全轨同步后移、单步撤销、正文交界转场')

    await page.getByTestId('video-segment-outro-open').click()
    const endings = page.getByRole('dialog', { name: '片尾', exact: true })
    await expect(endings.getByTestId('video-segment-item')).toHaveCount(templateIds.append.length)
    assert.deepEqual(await endings.getByTestId('video-segment-item').evaluateAll(items => items.map(item => item.dataset.segmentId)), templateIds.append)
    await expect(endings.getByRole('radio')).toHaveCount(0)
    await expect(endings.getByTestId('video-segment-add')).toHaveText('添加到项目结尾')
    const chooserPromise = page.waitForEvent('filechooser')
    await endings.getByTestId('video-segment-import-local').click()
    await (await chooserPromise).setFiles(path.resolve('src/assets/video-segments/prism-dawn.webm'))
    await expect(endings).toHaveCount(0)
    next = await read(page)
    const appended = clips(next).find(clip => clip.name === 'prism-dawn.webm')
    assert.equal(appended.start, 10)
    assert.equal(clips(next).find(clip => clip.id === 'part-a').start, 5)
    const reopened = await page.evaluate(async () => {
      const { exportProjectFile, importProjectFile } = await import('/src/core/project-file.ts')
      const current = window.cutFixture.current.value
      const imported = await importProjectFile(await exportProjectFile(current))
      try { return JSON.parse(JSON.stringify(imported.project)) } finally { imported.revoke() }
    })
    assert.deepEqual(reopened.tracks, next.tracks, '保存重开保留转场绑定、标题及全部时序')
    console.log('PASS 本地视频追加尾部、完整便携项目保存重开保持转场与素材')

    await page.evaluate(() => {
      const fixture = window.cutFixture, project = JSON.parse(JSON.stringify(fixture.current.value))
      project.tracks.find(track => track.kind === 'video').locked = true
      fixture.replace(project)
    })
    const locked = await read(page)
    await page.getByTestId('video-segment-intro-open').click()
    await segments.getByTestId('video-segment-add').click()
    await expect(segments.getByTestId('video-segment-error')).toContainText('解锁')
    assert.deepEqual(await read(page), locked, '锁轨阻止前插并且不留下新素材或半完成修改')
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      const fixture = window.cutFixture, project = JSON.parse(JSON.stringify(fixture.current.value))
      project.tracks = project.tracks.filter(track => track.kind !== 'transition')
      project.tracks.forEach(track => { if (track.kind === 'video') track.clips = [] })
      fixture.replace(project)
    })
    await page.getByTestId('transition-open').click()
    await expect(gallery.getByTestId('transition-apply')).toBeDisabled()
    await expect(gallery).toContainText('需要两个首尾相接的视频片段')
    assert.deepEqual(errors, [])
    console.log('PASS 锁定前插原子失败、缺少相邻视频时提示，不产生空转场')
    await page.keyboard.press('Escape')
    await page.screenshot({ path: '/tmp/open-media-editor-transitions-segments.png' })
  } catch (cause) { await page.screenshot({ path: '/tmp/open-media-editor-transitions-segments-failure.png' }).catch(() => {}); throw cause }
  finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
