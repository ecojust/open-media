const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

const read = page => page.evaluate(() => JSON.parse(JSON.stringify(window.projectCompression.current.value)))
const clips = project => project.tracks.flatMap(track => track.clips)
const withoutAsset = project => project.tracks.map(track => ({ ...track, clips: track.clips.map(({ assetId, ...clip }) => clip) }))

async function mount(page, url, { desktop = true, empty = false } = {}) {
  await page.route('**/__project_compression__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app,.app-shell{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/__project_compression__`)
  await page.evaluate(async ({ desktop, empty }) => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueURL)
    const { createProject, createClip, createSubtitleClip, validateProject } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory } = await import('/src/core/timeline.ts')
    const { addTransition } = await import('/src/core/transitions.ts')
    const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const { prepareEditorTool } = await import('/src/core/editor-tool-service.ts')
    const media = await (await fetch(VIDEO_SEGMENTS[0].url)).blob()
    const asset = await importMediaFile(new File([media], '讲解录屏.webm', { type: 'video/webm' }))
    // A real bundled movie exercises preview loading. Sizes and native jobs below
    // are fixtures for GUI transactions, not evidence of compression or speed.
    Object.assign(asset, { id: 'source', nativePath: '/media/source.webm', size: 1536 * 1024 ** 2 })
    const alias = { ...asset, id: 'source-alias', name: '重复导入的录屏.webm' }
    const skipped = { ...asset, id: 'already-small', name: '已经紧凑的片尾.webm', nativePath: '/media/ending.webm', size: 10 * 1024 ** 2 }
    let project = createProject('工程视频压缩 · 分段与字幕', { width: asset.width, height: asset.height, fps: 24 })
    if (!empty) {
      project.assets.push(asset, alias, skipped)
      const video = project.tracks.find(track => track.kind === 'video')
      video.clips.push(createClip(asset, project, { id: 'video-a', trimOut: 1.5 }), createClip(alias, project, { id: 'video-b', start: 1.5, trimIn: 1.5, trimOut: 3 }), createClip(skipped, project, { id: 'video-end', start: 3, trimOut: 1 }))
      project.tracks.find(track => track.kind === 'text').clips.push(createSubtitleClip(project, { id: 'caption-a', text: '压缩后保留全部时间线编辑', start: .25, trimOut: 2.5, color: '#ffcf72', fontSize: 28 }))
      project.tracks.find(track => track.kind === 'audio').clips.push(createClip(asset, project, { id: 'source-audio', start: .5, trimIn: .25, trimOut: 2, volume: .4 }))
      project = addTransition(project, 1.5, 'zoom-fade', .5, video.id)
    }
    project = validateProject(project, { trusted: true })
    const fixture = window.projectCompression = { current: shallowRef(project), editor: ref(), theme: ref('dark'), calls: [], tools: [], busy: [], commits: 0, messages: [], hold: false, fail: false, jobNumber: 0, jobs: new Map(), accepted: [], discarded: [], cancelled: [], devices: 0 }
    fixture.blobs = new Map([[asset.id, media], [alias.id, media], [skipped.id, media]])
    let history = createHistory(project), revision = 0
    const commit = (next, label) => { history = commitHistory(history, next); fixture.current.value = next; revision++; fixture.commits++; fixture.messages.push(label) }
    fixture.undo = () => { history = undoHistory(history); fixture.current.value = history.present; revision++ }
    navigator.mediaDevices.getUserMedia = async () => { fixture.devices++; throw new Error('Device capture is not used by compression tests') }
    const jobState = job => ({ id: job.id, state: fixture.fail ? 'failed' : fixture.hold ? 'running' : 'completed', progress: fixture.hold ? .31 : 1, stage: fixture.hold ? '正在压缩视频 1/2' : '处理完成', current: fixture.hold ? 1 : 2, total: 2, elapsedSeconds: 12, backend: 'fixture', items: fixture.hold ? [] : job.items, ...(fixture.fail ? { error: '测试任务编码失败，原视频保持不变。' } : {}) })
    if (desktop) window.__TAURI_INTERNALS__ = {
      convertFileSrc: () => asset.url,
      invoke: async (command, args) => {
        fixture.calls.push({ command, args })
        if (command === 'list_stored_videos') return { directory: '/recordings', assets: [], warnings: [] }
        if (command === 'begin_project_video_compression') {
          const id = `compression-${++fixture.jobNumber}`
          const output = { ...asset, id: `compressed-${fixture.jobNumber}`, nativePath: `/media/${id}.webm`, name: '讲解录屏-工作副本.webm', size: 640 * 1024 ** 2 }
          const job = { id, items: [
            { sourceIds: args.assets.filter(item => item.nativePath === asset.nativePath).map(item => item.id), sourceSize: asset.size, outputSize: output.size, state: 'completed', asset: output },
            { sourceIds: [skipped.id], sourceSize: skipped.size, outputSize: skipped.size + 1024, state: 'skipped', message: '结果没有变小，保留原视频。' },
          ] }
          fixture.jobs.set(id, job); return jobState(job)
        }
        if (command === 'get_project_video_compression_job') return jobState(fixture.jobs.get(args.id))
        if (command === 'cancel_project_video_compression') { fixture.cancelled.push(args.id); return null }
        if (command === 'discard_project_video_compression') { fixture.discarded.push(args.id); return null }
        if (command === 'accept_project_video_compression') { fixture.accepted.push(args.id); return null }
        throw new Error(`Unexpected native command: ${command}`)
      },
    }
    fixture.run = async (name, args, options) => {
      fixture.tools.push({ name, args: JSON.parse(JSON.stringify(args)) })
      const original = fixture.current.value, originalRevision = revision
      const assertCurrent = () => { if (revision !== originalRevision || fixture.current.value !== original) throw new Error('项目已变化') }
      const prepared = await prepareEditorTool(name, args, { ...options, project: original, revision, blobs: fixture.blobs, source: 'gui', assertCurrent })
      try {
        options.signal.throwIfAborted(); assertCurrent()
        if (prepared.project || prepared.accept) options.onProgress({ stage: '正在保存处理结果', progress: 1, cancelable: false })
        if (prepared.project) commit(prepared.project, prepared.label)
        await prepared.accept?.(); await nextTick()
        return prepared.data
      } catch (cause) { await prepared.discard?.(); throw cause }
    }
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    fixture.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': fixture.theme.value }, h(Editor, { ref: fixture.editor, project: fixture.current.value, runTool: fixture.run, onChange: commit, onBusy: value => fixture.busy.push(value), onStatus: message => fixture.messages.push(message) })) })
    fixture.app.mount('#app')
  }, { desktop, empty })
  await expect(page.getByRole('button', { name: '项目设置', exact: true })).toBeVisible()
}

async function main() {
  const output = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'project-video-compression') : '/tmp/open-media-project-video-compression'
  fs.mkdirSync(output, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
    const url = `http://127.0.0.1:${server.httpServer.address().port}`
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
    await mount(page, url)
    await page.getByRole('button', { name: '项目设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '项目设置', exact: true }), panel = dialog.getByTestId('project-video-compression')
    const start = panel.getByTestId('project-compression-start'), restore = panel.getByTestId('project-compression-restore')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('2 个源视频')
    await expect(panel.getByRole('radio', { name: '按质量压缩', exact: true })).toBeChecked()
    await expect(panel.getByLabel('工程视频压缩质量')).toHaveValue('high')
    assert.equal(await panel.getByLabel('工程视频压缩质量').evaluate(element => element.getBoundingClientRect().height), 32)
    await panel.getByRole('radio', { name: '无损压缩', exact: true }).check()
    await expect(panel.getByLabel('工程视频压缩质量')).toHaveCount(0)
    await expect(panel).toContainText('逐像素保真')
    await panel.getByRole('radio', { name: '按质量压缩', exact: true }).check()
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'project-compression-dark.png') })
    console.log('PASS 项目设置提供无损/质量压缩，高质量默认、同源去重和统一 32px 下拉框')

    const original = await read(page)
    await page.evaluate(() => { window.projectCompression.hold = true })
    await start.click()
    await expect(panel.getByRole('progressbar', { name: '工具处理进度' })).toHaveAttribute('value', '29')
    await expect(panel).toContainText('正在压缩视频 1/2')
    await expect(start).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '关闭项目设置', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeDisabled()
    await expect(dialog.getByLabel('项目帧率')).toBeDisabled()
    await expect(dialog.getByLabel('项目背景颜色')).toBeDisabled()
    await expect(page.getByRole('button', { name: '项目设置', exact: true })).toBeDisabled()
    await expect(panel.getByRole('radio', { name: '无损压缩', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible()
    await page.mouse.click(5, 5); await expect(dialog).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'project-compression-progress.png') })
    await panel.getByRole('button', { name: '取消处理', exact: true }).click()
    await expect(panel.getByText('已取消', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '关闭项目设置', exact: true })).toBeEnabled()
    await expect(dialog.getByLabel('项目帧率')).toBeEnabled()
    assert.deepEqual(await read(page), original)
    assert.equal(await page.evaluate(() => window.projectCompression.commits), 0)
    assert.equal(await page.evaluate(() => window.projectCompression.busy.at(-1)), false)
    assert.equal(await page.evaluate(() => window.projectCompression.tools.length), 1)
    assert(await page.evaluate(() => window.projectCompression.discarded.includes('compression-1')))
    assert(await page.evaluate(() => window.projectCompression.cancelled.includes('compression-1')))
    console.log('PASS 进度可见，忙碌期间锁定设置及再次运行，Esc/背景不关闭，取消清理任务并保持时间线')

    await page.evaluate(() => { window.projectCompression.hold = false })
    await start.click()
    await expect(restore).toBeVisible()
    await expect(panel).toContainText('已替换 1 个源视频')
    await expect(panel).toContainText('1.5 GB → 640.0 MB')
    await expect(panel).toContainText('10.0 MB · 保留原视频')
    await expect(panel).toContainText('原视频保留')
    const compressed = await read(page), replacement = compressed.assets.find(asset => asset.compression)
    assert(replacement)
    assert.equal(replacement.compression.mode, 'quality')
    assert.equal(replacement.compression.quality, 'high')
    assert.equal(replacement.compression.originalAssetId, 'source')
    for (const id of ['video-a', 'video-b', 'source-audio']) {
      const originalId = clips(original).find(clip => clip.id === id).assetId
      const nextId = clips(compressed).find(clip => clip.id === id).assetId
      const nextAsset = compressed.assets.find(asset => asset.id === nextId)
      assert.equal(nextAsset.compression.originalAssetId, originalId)
      assert.equal(nextAsset.nativePath, replacement.nativePath, '同源别名使用同一个编码副本')
    }
    assert.equal(clips(compressed).find(clip => clip.id === 'video-end').assetId, 'already-small')
    assert.deepEqual(withoutAsset(compressed), withoutAsset(original))
    for (const asset of original.assets) assert.deepEqual(compressed.assets.find(item => item.id === asset.id), asset)
    assert.equal(await page.evaluate(() => window.projectCompression.commits), 1)
    assert.deepEqual(await page.evaluate(() => window.projectCompression.accepted), ['compression-2'])
    await page.evaluate(() => { window.projectCompression.theme.value = 'light' })
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'project-compression-results-light.png') })
    console.log('PASS 真实编辑准备服务原子替换全部分段及原声引用，字幕/转场/时序不变；报告大小、跳过结果及原件保留')

    await restore.click()
    await expect(restore).toHaveCount(0)
    const restored = await read(page)
    assert.equal(await page.evaluate(() => window.projectCompression.commits), 2)
    assert.deepEqual(restored.tracks, original.tracks, '恢复每个分段原有的素材标识，包括同文件别名')
    assert.deepEqual(withoutAsset(restored), withoutAsset(original))
    assert.equal(await page.evaluate(() => window.projectCompression.calls.filter(item => item.command === 'begin_project_video_compression').length), 2)
    await page.evaluate(() => window.projectCompression.undo())
    await expect(restore).toBeVisible()
    assert.deepEqual((await read(page)).tracks, compressed.tracks)
    await page.evaluate(() => window.projectCompression.undo())
    await expect(restore).toHaveCount(0)
    assert.deepEqual(await read(page), original)
    console.log('PASS 恢复原视频保留当前编辑，不重新编码；压缩与恢复均可整体撤销')

    await panel.getByRole('radio', { name: '无损压缩', exact: true }).check()
    await start.click()
    await expect(restore).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.projectCompression.tools.at(-1).args), { mode: 'lossless' })
    assert.equal((await read(page)).assets.find(asset => asset.compression).compression.mode, 'lossless')
    await page.evaluate(() => window.projectCompression.undo())
    assert.deepEqual(await read(page), original)
    await page.evaluate(() => { window.projectCompression.fail = true })
    await start.click()
    await expect(panel.getByRole('alert')).toContainText('测试任务编码失败')
    await expect(start).toBeEnabled()
    assert.deepEqual(await read(page), original)
    assert(await page.evaluate(() => window.projectCompression.discarded.includes('compression-4')))
    console.log('PASS 无损调用不携带质量参数，失败释放锁并丢弃输出，不改变工程')

    await page.setViewportSize({ width: 400, height: 850 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { window.projectCompression.theme.value = theme }, theme)
      await panel.scrollIntoViewIfNeeded()
      assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1))
      assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1))
      const bounds = await dialog.boundingBox()
      assert(bounds.x >= 0 && bounds.x + bounds.width <= 400)
      await page.screenshot({ animations: 'disabled', path: path.join(output, `project-compression-narrow-${theme}.png`) })
    }
    assert.equal(await page.evaluate(() => window.projectCompression.devices), 0)
    console.log('PASS 400px 深浅主题弹窗无横向溢出、功能可滚动访问，未采集设备')

    for (const options of [{ desktop: false }, { empty: true }]) {
      const disabledPage = await browser.newPage({ viewport: { width: 1200, height: 900 } })
      disabledPage.on('pageerror', error => errors.push(error.message)); disabledPage.setDefaultTimeout(15000)
      await mount(disabledPage, url, options)
      await disabledPage.getByRole('button', { name: '项目设置', exact: true }).click()
      const disabledPanel = disabledPage.getByTestId('project-video-compression')
      await expect(disabledPanel.getByTestId('project-compression-start')).toBeDisabled()
      await expect(disabledPanel).toContainText(options.empty ? '先导入视频' : '工程视频压缩需要桌面端')
      assert.equal(await disabledPage.evaluate(() => window.projectCompression.tools.length), 0)
      await disabledPage.close()
    }
    assert.deepEqual(errors, [])
    console.log(`PASS 浏览器及空工程禁用处理；无未捕获异常。状态测试截图：${output}`)
  } finally { await browser?.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
