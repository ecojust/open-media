const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')
const card = (page, id) => page.locator(`.asset-card[data-source-asset-id="${id}"]`)
const read = page => page.evaluate(() => JSON.parse(JSON.stringify(window.assetCompression.current.value)))

async function mount(page, url, desktop = true) {
  await page.route('**/__asset_compression__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app,.app-shell{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/__asset_compression__`)
  await page.evaluate(async desktop => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueURL)
    const { createProject } = await import('/src/core/project.ts')
    const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const { prepareEditorTool } = await import('/src/core/editor-tool-service.ts')
    const media = await (await fetch(VIDEO_SEGMENTS[0].url)).blob()
    const loaded = await importMediaFile(new File([media], '源视频.webm', { type: 'video/webm' }))
    // Native sizes and compression jobs are controlled GUI fixtures; media decoding is real.
    const recording = { ...loaded, id: 'recording', name: '录屏素材.webm', nativePath: '/recordings/recording.webm', size: 1536 * 1024 ** 2, addedAt: new Date().toISOString() }
    const imported = { ...loaded, id: 'imported', name: '已导入素材.webm', nativePath: '/media/imported.webm', size: 256 * 1024 ** 2 }
    const audio = { ...loaded, kind: 'audio', id: 'sound', name: '声音.webm', width: 0, height: 0 }
    const project = createProject('剪辑前素材压缩', { width: loaded.width, height: loaded.height, fps: 24 }); project.assets.push(recording, imported, audio)
    const f = window.assetCompression = { current: shallowRef(project), theme: ref('dark'), calls: [], tools: [], messages: [], commits: 0, hold: false, fail: false, jobs: new Map(), sequence: 0, revision: 0, cancelled: [], discarded: [] }
    const commit = (next, label) => { f.current.value = next; f.commits++; f.revision++; f.messages.push(label) }
    const state = job => ({ ...job, state: f.fail ? 'failed' : f.hold ? 'running' : 'completed', stage: f.hold ? '正在压缩所选视频' : '完成', progress: f.hold ? .25 : 1, current: 1, total: 1, elapsedSeconds: 2, ...(f.fail ? { error: '测试编码失败' } : {}) })
    if (desktop) window.__TAURI_INTERNALS__ = { convertFileSrc: () => loaded.url, invoke: async (command, args) => {
      f.calls.push({ command, args })
      if (command === 'list_stored_videos') return { directory: '/recordings', warnings: [], assets: [recording] }
      if (command === 'begin_project_video_compression') {
        assertSource(args.assets)
        const id = `compression-${++f.sequence}`, input = args.assets[0], asset = { ...input, id: `working-${f.sequence}`, name: `${input.name}（工作副本）`, nativePath: `/media/${id}.webm`, url: loaded.url, size: Math.floor(input.size * .4), compression: undefined }
        const job = { id, items: [{ sourceIds: [input.id], sourceSize: input.size, outputSize: asset.size, state: 'completed', asset }] }; f.jobs.set(id, job); return state(job)
      }
      if (command === 'get_project_video_compression_job') return state(f.jobs.get(args.id))
      if (command === 'cancel_project_video_compression') { f.cancelled.push(args.id); return null }
      if (command === 'discard_project_video_compression') { f.discarded.push(args.id); return null }
      if (command === 'accept_project_video_compression') return null
      if (command === 'create_media_preview') return { path: '/media/original-preview.webm' }
      throw new Error(`Unexpected command ${command}`)
    } }
    function assertSource(assets) { if (assets.length !== 1 || assets[0].compression) throw new Error('Single-asset operation must receive its original source only') }
    f.run = async (name, args, options) => {
      f.tools.push({ name, args }); const original = f.current.value, revision = f.revision
      const assertCurrent = () => { if (f.current.value !== original || revision !== f.revision) throw new Error('工程已变化') }
      const prepared = await prepareEditorTool(name, args, { ...options, project: original, revision, blobs: new Map(), source: 'gui', assertCurrent })
      try {
        options.signal.throwIfAborted(); assertCurrent()
        if (prepared.project || prepared.accept) options.onProgress({ stage: '正在保存', progress: 1, cancelable: false })
        if (prepared.project) commit(prepared.project, prepared.label)
        await prepared.accept?.(); await nextTick(); return prepared.data
      } catch (cause) { await prepared.discard?.(); throw cause }
    }
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    f.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': f.theme.value }, h(Editor, { project: f.current.value, runTool: f.run, onChange: commit, onStatus: message => f.messages.push(message) })) }); f.app.mount('#app')
  }, desktop)
}

async function main() {
  const output = '/tmp/open-media-asset-compression'; fs.mkdirSync(output, { recursive: true })
  const { createServer } = await import('vite'), server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' }); await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
    const url = `http://127.0.0.1:${server.httpServer.address().port}`, page = await browser.newPage({ viewport: { width: 1440, height: 950 } }), errors = []
    page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(15000); await mount(page, url)
    await expect(card(page, 'recording')).toBeVisible(); await expect(card(page, 'recording').getByTestId('asset-file-size')).toHaveText('1.5 GB')
    await card(page, 'recording').click({ button: 'right' }); await page.getByTestId('asset-compression-open').click()
    const dialog = page.getByRole('dialog', { name: '压缩视频', exact: true }), panel = dialog.getByTestId('project-video-compression'), start = panel.getByTestId('project-compression-start'), restore = panel.getByTestId('project-compression-restore')
    await expect(dialog).toContainText('录屏素材.webm'); await expect(dialog).not.toContainText('开始压缩时会将此视频加入本工程素材')
    assert.equal((await read(page)).assets.length, 3)
    await page.evaluate(() => { window.assetCompression.hold = true }); await start.click()
    await expect(dialog.getByRole('progressbar')).toBeVisible(); await expect(dialog).toContainText('正在压缩所选视频'); await expect(dialog.getByRole('button', { name: '关闭压缩视频' })).toBeDisabled()
    await dialog.getByRole('button', { name: '取消处理' }).click(); await expect(dialog).toContainText('已取消')
    let p = await read(page); assert.equal(p.assets.length, 3); assert.equal(p.tracks.flatMap(t => t.clips).length, 0); assert(!p.assets.some(a => a.compression))
    assert(await page.evaluate(() => window.assetCompression.cancelled.length > 0 && window.assetCompression.discarded.length > 0))
    await page.evaluate(() => { window.assetCompression.hold = false; window.assetCompression.fail = true }); await start.click(); await expect(dialog.getByRole('alert')).toContainText('测试编码失败')
    await page.evaluate(() => { window.assetCompression.fail = false }); await start.click(); await expect(restore).toBeVisible()
    p = await read(page); const work = p.assets.find(a => a.compression?.active); assert(work); assert.equal(work.compression.originalAssetId, 'recording'); assert.equal(p.tracks.flatMap(t => t.clips).length, 0)
    assert.equal(await page.evaluate(() => window.assetCompression.calls.filter(c => c.command === 'create_media_preview').length), 0, '压缩前不为大原视频重复生成预览')
    const ids = await page.evaluate(() => window.assetCompression.tools.filter(t => t.name === 'open_media_project_video_compress').map(t => t.args.assetIds)); assert(ids.every(ids => ids.length === 1 && ids[0] === 'recording'))
    await dialog.getByRole('button', { name: '关闭压缩视频' }).click(); await expect(card(page, work.id)).toBeVisible(); await expect(card(page, 'recording')).toHaveCount(0)
    await expect(card(page, work.id).getByTestId('asset-file-size')).toContainText('1.5 GB → 614.4 MB'); await expect(card(page, work.id)).toContainText('工作副本')
    await page.screenshot({ path: path.join(output, 'recording-working-copy.png') })
    await expect(card(page, work.id)).toBeVisible(); await expect(card(page, 'imported').getByTestId('asset-file-size')).toHaveText('256.0 MB')
    await card(page, 'sound').click({ button: 'right' }); await expect(page.getByTestId('asset-compression-open')).toHaveCount(0); await page.keyboard.press('Escape')
    console.log('PASS 工程视频右键独立压缩；取消/失败保留原件，大小与工作副本实时显示，不扫描公共目录')

    await card(page, work.id).dblclick()
    p = await read(page); assert.equal(p.tracks.flatMap(t => t.clips)[0].assetId, work.id)
    await card(page, work.id).click({ button: 'right' }); await page.getByTestId('asset-compression-open').click(); await restore.click(); await expect(restore).toHaveCount(0)
    p = await read(page); assert.equal(p.tracks.flatMap(t => t.clips)[0].assetId, 'recording'); assert(p.assets.filter(a => a.compression).every(a => a.compression.active === false))
    await dialog.getByRole('button', { name: '关闭压缩视频' }).click(); await expect(card(page, 'recording')).toBeVisible()
    await page.evaluate(() => { const f = window.assetCompression, p = structuredClone(f.current.value); p.assets.find(a => a.id === 'recording').url = 'data:video/webm;base64,AA=='; p.tracks.forEach(t => { t.clips = [] }); f.current.value = p; f.revision++ })
    await card(page, 'recording').dblclick(); await expect.poll(async () => (await read(page)).tracks.flatMap(t => t.clips).length).toBe(1)
    p = await read(page); const restoredSource = p.assets.find(a => a.id === 'recording'); assert(restoredSource.sourceUrl?.startsWith('data:')); assert(restoredSource.url.startsWith('blob:')); assert.equal(p.tracks.flatMap(t => t.clips)[0].assetId, 'recording')
    assert.equal(await page.evaluate(() => window.assetCompression.calls.filter(c => c.command === 'create_media_preview').length), 1)
    console.log('PASS 后续添加立即使用工作副本；恢复后原件加入时间线时按需生成可播放预览并保存URL，不重复使用失效原URL')

    await card(page, 'imported').click({ button: 'right' }); await page.getByTestId('asset-compression-open').click()
    await page.setViewportSize({ width: 400, height: 850 }); await page.evaluate(() => { window.assetCompression.theme.value = 'light' })
    assert(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)); await page.screenshot({ path: path.join(output, 'single-video-compression-light.png') })
    await start.click(); await expect(restore).toBeVisible(); assert.deepEqual(await page.evaluate(() => window.assetCompression.tools.at(-1).args.assetIds), ['imported'])
    await dialog.getByRole('button', { name: '关闭压缩视频' }).click(); p = await read(page); const importedWork = p.assets.find(a => a.compression?.active && a.compression.originalAssetId === 'imported'); await expect(card(page, importedWork.id)).toBeVisible()
    assert.equal(await page.evaluate(() => window.assetCompression.calls.filter(c => c.command === 'list_stored_videos').length), 0); assert.deepEqual(errors, []); console.log('PASS 未使用的导入视频可在剪辑前独立压缩，400px弹窗无溢出；未捕获异常为0')
    const web = await browser.newPage({ viewport: { width: 1200, height: 900 } }); await mount(web, url, false)
    await card(web, 'imported').click({ button: 'right' }); await web.getByTestId('asset-compression-open').click()
    const webDialog = web.getByRole('dialog', { name: '压缩视频', exact: true })
    await expect(webDialog.getByTestId('project-compression-start')).toBeDisabled(); await expect(webDialog).toContainText('需要桌面端')
    assert.equal(await web.evaluate(() => window.assetCompression.tools.length), 0); await web.close()
    console.log('PASS 网页环境可查看视频大小，但不会误启动原生压缩')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
