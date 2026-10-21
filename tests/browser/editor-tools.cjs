const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')
const { installManagedProjectBridge } = require('./managed-project-bridge.cjs')

const read = page => page.evaluate(() => JSON.parse(JSON.stringify(window.editorTools.current.value)))
const find = (project, id) => project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)
const clip = (page, id) => page.locator(`.timeline-clip[data-clip-id="${id}"]`)
async function close(page, name) { await page.getByRole('button', { name: `关闭${name}`, exact: true }).click() }

async function verifyNativeProjectPreparation(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await installManagedProjectBridge(page)
  await page.addInitScript(() => {
    localStorage.setItem('open-media:autosave', 'false')
    let counter = 0
    const state = window.editorAppNative = { calls: [], unexpected: [], imported: 0 }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++counter, unregisterCallback() {},
      convertFileSrc: path => window.managedProjectFileUrl(path),
      invoke: async (command, args = {}, options = {}) => {
        state.calls.push(command)
        const managed = await window.managedProjectCommand(command, args, options)
        if (managed.handled) return managed.value
        if (command === 'get_desktop_platform') return 'macos'
        if (command === 'plugin:event|listen') return ++counter
        if (command === 'plugin:event|unlisten' || command === 'set_main_window_appearance' || command.startsWith('plugin:window|') || command.startsWith('plugin:webview|')) return null
        if (command === 'configure_screenshot_shortcut') return args.shortcut
        if (command === 'get_media_jobs' || command === 'mcp_pending') return []
        if (command === 'ai_get_status') return { models: [], jobs: [], busy: false }
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture' }
        if (command === 'mcp_get_config') return { host: '127.0.0.1', port: 39861, token: 'fixture' }
        if (command === 'mcp_get_status') return { running: false, connectedClients: 0, pendingRequests: 0 }
        if (command === 'mcp_asset_tool' && args.operation === 'asset_import_url') {
          const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24
          canvas.getContext('2d').fillRect(0, 0, 24, 24)
          const url = canvas.toDataURL('image/png'), id = `gui-import-${++state.imported}`, nativePath = `/fixture/downloads/${id}.png`
          const asset = { id, name: `${id}.png`, kind: 'image', url, nativePath, width: 24, height: 24, duration: 0, mime: 'image/png', size: atob(url.split(',')[1]).length }
          window.managedProjectFixture.files.set(nativePath, { ...asset })
          return { asset, source: { kind: 'url', url: args.args.url, sha256: 'a'.repeat(64), importedAt: Date.now() } }
        }
        state.unexpected.push(command)
        throw Error(`Unexpected native editor command: ${command}`)
      },
    }
  })
  try {
    await page.goto(url)
    await expect(page.getByTestId('create-project')).toBeEnabled({ timeout: 45000 })
    await page.getByTestId('create-project').click()
    await page.getByTestId('asset-url-open').click()
    const panel = page.getByTestId('asset-tools-panel')
    await panel.getByLabel('素材网址').fill('https://example.com/source.png')
    const inspect = () => page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState
      return { id: app.project.id, revision: app.projectRevision, assets: JSON.parse(JSON.stringify(app.project.assets)) }
    })
    const before = await inspect()
    for (const cancel of [true, false]) {
      await page.evaluate(() => { window.managedProjectFixture.holdNextPrepare = true })
      await panel.getByTestId('asset-tool-run').click()
      await page.waitForFunction(() => typeof window.managedProjectFixture.releasePrepare === 'function')
      await expect(panel).toContainText('正在保存工程素材')
      await expect(panel.getByRole('button', { name: '取消处理', exact: true })).toBeEnabled()
      await expect(page.getByTestId('new-project')).toBeDisabled()
      assert.deepEqual((await inspect()).assets, before.assets, 'preparation must not publish a partial project')
      if (cancel) await panel.getByRole('button', { name: '取消处理', exact: true }).click()
      await page.evaluate(() => window.managedProjectFixture.releasePrepare())
      await expect(panel.getByTestId('asset-tool-run')).toBeEnabled()
      if (cancel) {
        await expect(panel).toContainText('已取消')
        assert.deepEqual(await inspect(), before, 'cancelling file preparation preserves the entire project revision')
      } else await expect(panel).toContainText('素材已导入项目')
    }
    const after = await inspect()
    assert.equal(after.assets.length, 1)
    assert.equal(after.revision, before.revision + 1)
    assert.equal(after.assets[0].id, 'gui-import-2')
    assert.ok(after.assets[0].nativePath.startsWith(`/fixture/projects/${after.id}/assets/`))
    await close(page, '从网址导入')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    assert.deepEqual((await inspect()).assets, before.assets)
    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => window.editorAppNative.unexpected), [])
    console.log('PASS native App shared runner archives GUI results before one commit; copying remains cancellable, no partial edits, canonical media paths and one-step undo')
  } finally { await page.close() }
}

async function mount(page, url) {
  await page.route('**/__editor_tools__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app,.app-shell{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/__editor_tools__`)
  await page.evaluate(async () => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueURL)
    const { createProject, createClip, createTextClip } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory } = await import('/src/core/timeline.ts')
    const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const { prepareEditorTool } = await import('/src/core/editor-tool-service.ts')
    const media = await (await fetch(VIDEO_SEGMENTS[0].url)).blob()
    const asset = await importMediaFile(new File([media], 'editor-tools.webm', { type: 'video/webm' }))
    asset.id = 'source'; asset.nativePath = '/media/source.webm'
    const audioBytes = new Uint8Array(44 + 16000 * 2 * 5), wav = new DataView(audioBytes.buffer)
    const label = (offset, value) => [...value].forEach((c, i) => wav.setUint8(offset + i, c.charCodeAt(0)))
    label(0, 'RIFF'); wav.setUint32(4, audioBytes.length - 8, true); label(8, 'WAVEfmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true); wav.setUint32(24, 16000, true); wav.setUint32(28, 32000, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); label(36, 'data'); wav.setUint32(40, audioBytes.length - 44, true)
    for (let i = 0; i < 80000; i++) wav.setInt16(44 + i * 2, Math.sin(i * 440 * Math.PI * 2 / 16000) * 8000, true)
    const audioBlob = new Blob([audioBytes], { type: 'audio/wav' }), audioAsset = await importMediaFile(new File([audioBlob], 'test-audio.wav', { type: 'audio/wav' }))
    audioAsset.id = 'audio-source'; audioAsset.nativePath = '/media/audio.wav'
    const project = createProject('剪辑工具真实服务联调', { width: 640, height: 360, fps: 24 })
    project.assets.push(asset, audioAsset)
    project.tracks.find(track => track.kind === 'audio').clips.push(createClip(audioAsset, project, { id: 'audio-a', trimOut: 5 }))
    project.tracks.find(track => track.kind === 'video').clips.push(createClip(asset, project, { id: 'video-a', trimOut: 5 }))
    project.tracks.find(track => track.kind === 'text').clips.push(createTextClip(project, { id: 'caption-a', text: '工具联调字幕', trimOut: 5, fontSize: 24 }))
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#266b9a'; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = '#ffffff'; ctx.fillText('SOURCE FRAME', 20, 80)
    const png = canvas.toDataURL('image/png').split(',')[1]
    const fixture = window.editorTools = { current: shallowRef(project), editor: ref(), calls: [], tools: [], busy: [], commits: 0, theme: ref('light'), held: false, fail: false, asrReady: false, modelProviders: [], devices: 0 }
    let history = createHistory(project), revision = 0
    const commit = next => { history = commitHistory(history, next); fixture.current.value = next; revision++; fixture.commits++ }
    fixture.undo = () => { history = undoHistory(history); fixture.current.value = history.present; revision++ }
    fixture.blobs = new Map([[asset.id, media], [audioAsset.id, audioBlob]])
    navigator.mediaDevices.getUserMedia = async () => { fixture.devices++; throw new Error('No device capture in editor tool tests') }
    const asrStatus = () => ({ ready: fixture.asrReady, runtimeReady: true, models: [{ id: 'asr-small', name: '离线识别模型', status: fixture.asrReady ? 'ready' : 'not-downloaded', downloadSize: 150e6, modelSize: 149e6, downloadedBytes: fixture.asrReady ? 150e6 : 0, progress: fixture.asrReady ? 1 : 0, hardware: '建议 2 GB 可用内存', language: '中文与英文' }] })
    window.__TAURI_INTERNALS__ = {
      convertFileSrc: filename => filename.endsWith('.wav') ? audioAsset.url : asset.url,
      invoke: async (command, args) => {
        fixture.calls.push({ command, args })
        if (command === 'list_stored_videos') return { directory: '/recordings', assets: [], warnings: [] }
        if (command === 'mcp_asset_tool') {
          if (fixture.fail) throw new Error('素材读取失败，请重新选择文件。')
          if (fixture.held) return new Promise((resolve, reject) => { fixture.release = () => { fixture.held = false; reject(new DOMException('已取消', 'AbortError')) } })
          if (args.operation === 'asset_probe') return { assetId: args.args.asset.id, kind: 'video', width: 640, height: 360, frameRate: 24, duration: 5, hasVideo: true, hasAudio: false, streams: [] }
          if (args.operation === 'asset_get_frame') return { requestedTime: args.args.time, sourceTime: args.args.time, mimeType: 'image/png', width: 320, height: 180, base64: png, encodedBytes: png.length * .75 }
          if (args.operation === 'asset_storyboard') return { start: 0, end: 5, frames: [0,1,2,3].map(time => ({ sourceTime: time, requestedTime: time, mimeType: 'image/png', width: 320, height: 180, base64: png, encodedBytes: png.length * .75 })) }
          if (args.operation === 'asset_detect_scenes') return { points: [{ time: 2, score: .8, confidence: .8 }], interpretation: '场景变化候选' }
          if (args.operation === 'asset_detect_idle') return { intervals: [{ kind: 'black', start: 1, end: 2, duration: 1 }], interpretation: '仅供检查', repeatedIntervals: [{ start: 3, end: 4, referenceStart: 1, referenceEnd: 2, confidence: .91 }], repetitionLimitation: '仅按抽样画面相似度提供候选。' }
          throw new Error(`Unexpected asset operation: ${args.operation}`)
        }
        if (command === 'mcp_asset_cancel') { fixture.release?.(); return true }
        if (command === 'ai_get_status') return { models: [{ id: 'transcription:asr-small', provider: 'transcription', state: fixture.asrReady ? 'ready' : 'not-downloaded' }], jobs: [], busy: false }
        if (command === 'asr_status') return asrStatus()
        if (command === 'asr_download') { fixture.asrReady = true; return { id: 'download-1', state: 'completed', stage: '模型下载完成', progress: 1, result: asrStatus() } }
        if (command === 'asr_transcribe') return { id: 'asr-1', state: 'completed', stage: '识别完成', progress: 1, result: { text: '识别字幕验证', language: 'zh', segments: [{ text: '识别字幕验证', start: .5, end: 2, words: [], tokens: [] }], tokens: [], timestampKind: 'model', wordSegmentation: 'latin-whitespace-and-cjk-model-tokens', backend: 'fixture', duration: 5, modelId: 'asr-small' } }
        if (command === 'audio_tool_begin') return { id: 'audio-tool-1', state: 'completed', progress: 1, stage: '处理完成', result: args.spec.action === 'analyze' ? { integratedLufs: -18.5, truePeakDbtp: -2, loudnessRange: 3, measured: true, peakDbfs: -.05, possibleClipping: true, silenceIntervals: [{ start: 1, end: 1.5, duration: .5 }] } : { asset: { ...audioAsset, id: `processed-${fixture.calls.length}` }, before: { integratedLufs: -18.5 }, after: { integratedLufs: -16, truePeakDbtp: -1 } } }
        if (command === 'audio_tool_accept') return null
        if (command === 'get_speech_status') return { ready: true, voices: [{ id: 'fixture-voice', name: '测试音色', language: 'zh-CN', gender: 'female', status: 'bundled' }] }
        if (command === 'begin_speech_job') return { id: 'speech-preview-1', state: 'completed', progress: 1, stage: '试听就绪', asset: { ...audioAsset, id: 'preview-audio', name: '配音试听.wav' } }
        if (command === 'discard_speech_job' || command === 'accept_speech_jobs') return null
        throw new Error(`Unexpected native command: ${command}`)
      },
    }
    fixture.run = async (name, args, options) => {
      fixture.tools.push({ name, args: JSON.parse(JSON.stringify(args)) })
      const original = fixture.current.value, originalRevision = revision
      const prepared = await prepareEditorTool(name, args, { ...options, project: original, revision, blobs: fixture.blobs, source: 'gui' })
      options.signal.throwIfAborted()
      if (originalRevision !== revision) { prepared.discard?.(); throw new Error('项目已变化') }
      if (prepared.project) commit(prepared.project)
      for (const item of prepared.assets || []) if (item.blob) fixture.blobs.set(item.asset.id, item.blob)
      options.onProgress({ stage: '正在完成', cancelable: false })
      if (fixture.holdAccept) await new Promise(resolve => { fixture.finishAccept = () => { fixture.holdAccept = false; resolve() } })
      await prepared.accept?.(); await nextTick()
      return prepared.data
    }
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    fixture.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': fixture.theme.value }, h(Editor, {
      ref: fixture.editor, project: fixture.current.value, runTool: fixture.run, onChange: commit, onBusy: value => fixture.busy.push(value), onOpenModels: provider => fixture.modelProviders.push(provider),
    })) })
    fixture.app.mount('#app')
  })
  await expect(clip(page, 'video-a')).toBeVisible()
}

async function main() {
  const output = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'editor-tools') : '/tmp/open-media-editor-tools'
  fs.mkdirSync(output, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
  try {
    await mount(page, `http://127.0.0.1:${server.httpServer.address().port}`)
    await clip(page, 'video-a').click()
    const visual = page.getByTestId('visual-clip-tools')
    await visual.getByText('动画关键帧', { exact: true }).click()
    await visual.getByRole('button', { name: '当前帧', exact: true }).click()
    await visual.getByLabel('关键帧 1 数值').fill('.4')
    const before = await page.evaluate(() => window.editorTools.commits)
    await visual.getByRole('button', { name: '应用', exact: true }).click()
    await expect.poll(async () => find(await read(page), 'video-a').keyframes?.opacity?.[0]?.value).toBe(.4)
    assert.equal(await page.evaluate(() => window.editorTools.commits), before + 1, '一次动画操作只提交一次')
    await page.evaluate(() => window.editorTools.undo())
    await expect(visual.getByLabel('关键帧 1 数值')).toHaveCount(0)
    await visual.getByText('源画面裁切', { exact: true }).click()
    await visual.getByLabel('源画面左边距').fill('10'); await visual.getByLabel('源画面宽度').fill('80')
    await visual.getByRole('button', { name: '应用裁切', exact: true }).click()
    await expect.poll(async () => find(await read(page), 'video-a').crop?.width).toBe(.8)
    await expect(visual.getByRole('button', { name: '应用裁切', exact: true })).toBeEnabled()
    await visual.getByText('重点区域放大', { exact: true }).click()
    await visual.getByRole('button', { name: '在预览中框选', exact: true }).click()
    const picker = page.getByTestId('preview-focus-region')
    await expect(picker).toBeVisible()
    const bounds = await picker.locator('svg').evaluate(svg => {
      const matrix = svg.getScreenCTM(), a = new DOMPoint(160, 90).matrixTransform(matrix), b = new DOMPoint(480, 270).matrixTransform(matrix)
      return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    })
    await page.mouse.move(bounds.x1, bounds.y1); await page.mouse.down(); await page.mouse.move(bounds.x2, bounds.y2); await page.mouse.up()
    await expect(picker).toHaveCount(0)
    await expect(visual.getByLabel('聚焦区域宽度')).toHaveValue('50')
    await visual.getByLabel('聚焦开始时间').fill('0')
    await visual.getByRole('button', { name: '应用聚焦', exact: true }).click()
    await expect.poll(async () => find(await read(page), 'video-a').keyframes?.scaleX?.length).toBe(4)
    const focused = find(await read(page), 'video-a')
    assert.equal(focused.crop.width, .8, '聚焦保留既有裁切')
    assert.equal(focused.keyframes.scaleX.at(-1).value, 1, '聚焦结束恢复原尺寸')
    await expect(visual.getByRole('button', { name: '应用聚焦', exact: true })).toBeDisabled()
    await expect(visual.getByText('替换此片段已有的位置与缩放动画', { exact: true })).toBeVisible()
    await page.evaluate(() => window.editorTools.undo())
    await expect.poll(async () => find(await read(page), 'video-a').keyframes?.scaleX).toBeUndefined()
    assert.equal(find(await read(page), 'video-a').crop.width, .8)
    await page.screenshot({ path: path.join(output, 'clip-properties-light.png') })
    console.log('PASS GUI visual keyframes/crop/focus selection use shared validation, conflict protection and one undoable project commit')

    await page.getByTestId('subtitle-tools-open').click()
    const subtitles = page.getByRole('dialog', { name: '字幕文件', exact: true })
    await subtitles.getByLabel('字幕文件内容').fill('1\n00:00:01,000 --> 00:00:02,500\n导入字幕示例\n')
    await subtitles.getByRole('button', { name: '导入到时间线', exact: true }).click()
    await expect.poll(async () => (await read(page)).tracks.flatMap(track => track.clips).some(clip => clip.text === '导入字幕示例')).toBe(true)
    await subtitles.getByRole('button', { name: '导出字幕', exact: true }).click()
    await subtitles.getByLabel('字幕文件格式').selectOption('vtt')
    await subtitles.getByRole('button', { name: '生成字幕文件', exact: true }).click()
    await expect(subtitles.getByLabel('导出字幕预览')).toHaveValue(/WEBVTT/)
    await close(page, '字幕文件')
    console.log('PASS GUI subtitle import/export uses real subtitle parser and serializer')

    await page.getByTestId('project-markers-open').click()
    const project = page.getByRole('dialog', { name: '项目工具', exact: true })
    await project.getByRole('button', { name: '标记当前帧', exact: true }).click()
    await project.getByLabel('标记 1 名称').fill('需要补充镜头'); await project.getByLabel('标记 1 时间').fill('2')
    await page.evaluate(() => { window.editorTools.holdAccept = true })
    await project.getByRole('button', { name: '保存标记', exact: true }).click()
    await expect(project.getByRole('button', { name: '正在完成', exact: true })).toBeDisabled()
    await page.evaluate(() => window.editorTools.finishAccept())
    await expect(project).toContainText('项目标记已保存')
    await expect.poll(async () => (await read(page)).markers?.[0]?.label).toBe('需要补充镜头')
    await project.getByRole('button', { name: '项目快照', exact: true }).click()
    await project.getByLabel('项目快照名称').fill('初剪完成')
    await project.getByRole('button', { name: '保存快照', exact: true }).click()
    await expect(project.getByText('初剪完成', { exact: true })).toBeVisible()
    await project.getByRole('radio').check(); await project.getByRole('button', { name: '对比当前工程' }).click()
    await expect(project).toContainText('当前工程与该快照完全一致')
    await page.screenshot({ path: path.join(output, 'snapshots-light.png') })
    await close(page, '项目工具')
    await page.getByRole('button', { name: '跳转标记：需要补充镜头' }).click()
    assert.equal(await page.evaluate(() => window.editorTools.editor.value.getPlayback().time), 2)
    console.log('PASS GUI markers, real IndexedDB snapshot archive and project comparison')

    await page.getByTestId('visual-elements-open').click()
    const elements = page.getByRole('dialog', { name: '标注与标题', exact: true })
    await elements.getByRole('button', { name: '定制当前片段' }).click()
    await expect(elements.getByLabel('标题字体')).toHaveCount(0)
    await elements.getByRole('button', { name: '动态标题', exact: true }).click()
    await elements.getByLabel('动态标题文字').fill('创作工具演示')
    await elements.getByRole('button', { name: '添加到时间线', exact: true }).click()
    await expect.poll(async () => (await read(page)).tracks.flatMap(track => track.clips).some(clip => clip.text === '创作工具演示')).toBe(true)
    await page.evaluate(() => { window.editorTools.theme.value = 'dark' })
    await page.screenshot({ path: path.join(output, 'title-dark.png') })
    await page.setViewportSize({ width: 680, height: 760 }); await page.screenshot({ path: path.join(output, 'title-narrow.png') })
    assert(await elements.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
    await close(page, '标注与标题'); await page.setViewportSize({ width: 1440, height: 1000 })
    console.log('PASS GUI title creation and contextual customization controls, dark/narrow modal layout')

    await page.getByTestId('visual-elements-open').click()
    await elements.getByLabel('画面标注类型').selectOption('ellipse')
    await expect(elements.getByLabel('画面标注类型').locator('option')).toHaveCount(12)
    await elements.getByLabel('标注宽度').fill('220'); await elements.getByLabel('标注高度').fill('120')
    await elements.getByLabel('标注水平位置').fill('80'); await elements.getByLabel('标注垂直位置').fill('40')
    await elements.getByLabel('标注线宽').fill('7')
    await elements.getByLabel('标注入退场动画').selectOption('slide-up')
    await elements.getByRole('button',{name:'添加到时间线',exact:true}).click()
    await expect(elements).toContainText('视觉标注已添加到时间线')
    const overlay=(await read(page)).tracks.flatMap(track=>track.clips).find(clip=>clip.overlay?.kind==='ellipse')
    assert(overlay.keyframes?.y?.length===4 && overlay.keyframes?.opacity?.length===4)
    await page.screenshot({path:path.join(output,'editable-overlay-dark.png')})
    await close(page,'标注与标题'); await clip(page,overlay.id).click()
    const style=page.getByTestId('overlay-properties')
    await expect(style).toBeVisible()
    await expect(page.getByTestId('speech-generate-selected')).toHaveCount(0)
    await expect(page.getByLabel('水印文字',{exact:true})).toHaveCount(0)
    await style.getByLabel('片段标注类型').selectOption('brackets')
    await style.getByLabel('片段标注线宽').fill('11'); await style.getByLabel('片段标注线宽').blur()
    await style.getByLabel('片段标注颜色').evaluate(el=>{el.value='#52dfca';el.dispatchEvent(new Event('input',{bubbles:true}))})
    await expect.poll(async()=>find(await read(page),overlay.id).overlay).toEqual({kind:'brackets',color:'#52dfca',strokeWidth:11,blurRadius:12})
    const properties=page.locator('#clip-properties-panel')
    await properties.getByLabel('X',{exact:true}).fill('120'); await properties.getByLabel('X',{exact:true}).blur()
    await expect.poll(async()=>find(await read(page),overlay.id).x).toBe(120)
    await properties.getByLabel('宽度',{exact:true}).fill('260'); await properties.getByLabel('宽度',{exact:true}).blur()
    await expect.poll(async()=>find(await read(page),overlay.id).width).toBe(260)
    await page.screenshot({path:path.join(output,'editable-overlay-properties.png')})
    console.log('PASS GUI 12种通用标注、动作、右侧线宽颜色类型与位置尺寸修改，隐藏空文本配音')


    const assetCard = page.locator('.asset-card[data-source-asset-id="source"]')
    await assetCard.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '分析素材信息', exact: true }).click()
    const assetPanel = page.getByRole('dialog', { name: '素材工具', exact: true })
    const assetsBefore = (await read(page)).assets.length
    await assetPanel.getByTestId('asset-tool-run').click(); await expect(assetPanel).toContainText('640')
    await assetPanel.getByRole('button', { name: '联系表', exact: true }).click()
    await assetPanel.getByLabel('联系表取帧方式').selectOption('scene'); await assetPanel.getByLabel('联系表场景阈值').fill('.4')
    await assetPanel.getByTestId('asset-tool-run').click()
    await expect(assetPanel.getByAltText('完整视频联系表')).toBeVisible()
    const sheetArgs = await page.evaluate(() => window.editorTools.calls.filter(call => call.command === 'mcp_asset_tool' && call.args.operation === 'asset_storyboard').at(-1).args.args)
    assert.equal(sheetArgs.mode, 'scene'); assert.equal(sheetArgs.threshold, .4)
    assert.equal((await read(page)).assets.length, assetsBefore, '只读分析不新增项目素材')
    await page.screenshot({ path: path.join(output, 'storyboard-dark.png') })
    await assetPanel.getByRole('button', { name: '黑场 / 静止 / 静音', exact: true }).click(); await assetPanel.getByTestId('asset-tool-run').click()
    await expect(assetPanel).toContainText('候选重复画面'); await expect(assetPanel).toContainText('91%'); await expect(assetPanel).toContainText('仅按抽样画面相似度提供候选')
    await assetPanel.getByRole('button', { name: '场景检测', exact: true }).click()
    await page.evaluate(() => { window.editorTools.held = true })
    await assetPanel.getByTestId('asset-tool-run').click()
    await expect(assetPanel.getByRole('button', { name: '关闭素材工具' })).toBeDisabled()
    await expect(assetPanel.getByLabel('场景检测阈值')).toBeDisabled()
    await assetPanel.getByRole('button', { name: '取消处理', exact: true }).click()
    await expect(assetPanel).toContainText('已取消')
    await expect(assetPanel.getByRole('button', { name: '关闭素材工具' })).toBeEnabled()
    await page.evaluate(() => { window.editorTools.fail = true })
    await assetPanel.getByTestId('asset-tool-run').click(); await expect(assetPanel.getByRole('alert')).toContainText('素材读取失败')
    await close(page, '素材工具')
    console.log('PASS GUI native IPC fixture: frame sheet display, progress cancellation, error and no project mutation')

    await clip(page, 'video-a').click()
    const asr = page.getByTestId('transcription-tools')
    await asr.getByText('识别语音为字幕', { exact: true }).click()
    await expect(asr).toContainText('依靠 离线识别模型 模型识别语音')
    await expect(asr.getByRole('button', { name: '识别并添加字幕', exact: true })).toBeDisabled()
    await asr.getByRole('button', { name: '前往 Info 管理 离线识别模型', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.editorTools.modelProviders), ['transcription'])
    assert.equal(await page.evaluate(() => window.editorTools.calls.some(call => call.command === 'asr_download')), false)
    await page.evaluate(async () => {
      window.editorTools.asrReady = true
      const { refreshAi } = await import('/src/core/ai-service.ts')
      await refreshAi()
    })
    await expect(asr.getByRole('button', { name: '识别并添加字幕', exact: true })).toBeEnabled()
    await asr.getByRole('button', { name: '刷新识别模型状态', exact: true }).click()
    await expect(asr).toContainText('模型已就绪')
    await asr.getByRole('button', { name: '识别并添加字幕', exact: true }).click()
    await expect.poll(async () => (await read(page)).tracks.flatMap(track => track.clips).some(clip => clip.text === '识别字幕验证')).toBe(true)
    const transcription = find(await read(page), (await read(page)).tracks.flatMap(track => track.clips).find(clip => clip.text === '识别字幕验证').id)
    assert.equal(transcription.start, .5)
    assert.equal(await page.evaluate(() => window.editorTools.devices), 0)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: path.join(output, 'transcription-dark.png') })
    console.log('PASS GUI ASR IPC fixture: Info model delegation/status and imported timestamped subtitles; no capture device access')
    await clip(page, 'audio-a').click()
    const audio = page.getByTestId('audio-clip-tools')
    await audio.getByText('响度分析与统一', { exact: true }).click()
    await audio.getByRole('button', { name: '分析当前音频', exact: true }).click()
    await expect(audio).toContainText('-18.5')
    await expect(audio).toContainText('峰值削波风险'); await expect(audio).toContainText('静音区间（相对于当前片段）')
    await audio.getByRole('button', { name: '统一响度', exact: true }).click()
    await expect.poll(async () => find(await read(page), 'audio-a').assetId).toMatch(/^processed-/)
    await expect(audio).toContainText('处理后 · 综合响度')
    await audio.getByText('音频清理与均衡', { exact: true }).click()
    await audio.getByLabel('音频降噪强度').fill('.5')
    await audio.getByRole('button', { name: '应用音频处理', exact: true }).click()
    await expect(audio.getByRole('button', { name: '应用音频处理', exact: true })).toBeEnabled()
    const processing = await page.evaluate(() => window.editorTools.calls.filter(call => call.command === 'audio_tool_begin').at(-1).args.spec)
    assert.equal(processing.denoise, .5); assert.equal(processing.action, 'process')
    console.log('PASS GUI audio IPC fixture: loudness reporting and validated nondestructive audio replacement')

    await page.getByRole('button', { name: '文字转语音', exact: true }).first().click()
    const speechDialog = page.getByRole('dialog', { name: '文字转语音', exact: true })
    const speech = page.getByTestId('speech-tools-panel')
    await speech.getByText('读法、时长与对齐设置', { exact: true }).click()
    await speech.getByText('读法词典', { exact: true }).click()
    await speech.getByRole('button', { name: '新增读法', exact: true }).click()
    await speech.getByLabel('词典 1 原文').fill('Open Media'); await speech.getByLabel('词典 1 读法').fill('开放媒体')
    await speech.getByRole('button', { name: '保存读法', exact: true }).click()
    await expect(speech).toContainText('读法词典已保存')
    await speech.getByText('时长规划与生成对齐', { exact: true }).click()
    await speech.getByLabel('配音生成对齐策略').selectOption('ripple')
    await speech.getByRole('button', { name: '保存对齐策略', exact: true }).click()
    await speech.getByRole('button', { name: '检查字幕时长', exact: true }).click()
    await expect(speech).toContainText('工具联调字幕')
    const prefs = await page.evaluate(async () => ({ entries: (await import('/src/core/speech-pronunciation.ts')).getSpeechPronunciation(), alignment: (await import('/src/core/speech-timing.ts')).getSpeechAlignment() }))
    assert.deepEqual(prefs.entries, [{ text: 'Open Media', pronunciation: '开放媒体' }]); assert.equal(prefs.alignment.mode, 'ripple')
    const assetsBeforePreview = (await read(page)).assets.length
    await speech.getByText('自定义语料试听', { exact: true }).click()
    await speech.getByLabel('自定义配音试听文字').fill('Open Media 帮助你完成创作。')
    await speech.getByRole('button', { name: '使用当前音色生成试听', exact: true }).click()
    await expect(speech.getByLabel('自定义配音试听', { exact: true })).toBeVisible()
    await expect.poll(() => speech.getByLabel('自定义配音试听', { exact: true }).evaluate(el => el.duration)).toBe(5)
    await expect(speech.getByRole('button', { name: '保存试听音频' })).toBeVisible()
    assert.equal((await read(page)).assets.length, assetsBeforePreview)
    assert(await page.evaluate(() => window.editorTools.calls.some(call => call.command === 'discard_speech_job' && call.args.id === 'speech-preview-1')))
    await close(page, '文字转语音')
    console.log('PASS GUI speech dictionary/alignment persistence and real duration planning')
    assert.deepEqual(errors, [])

    const real = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const realErrors = []; real.on('pageerror', error => realErrors.push(error.message))
    await real.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    await expect(real.getByTestId('create-project')).toBeEnabled({ timeout: 45000 })
    await real.getByTestId('create-project').click()
    await real.getByTestId('theme-dark').click()
    await real.getByTestId('visual-elements-open').click()
    const realDialog = real.getByRole('dialog', { name: '标注与标题', exact: true })
    await realDialog.getByRole('button', { name: '动态标题', exact: true }).click()
    await realDialog.getByLabel('动态标题文字').fill('真实工作台主题与工具联调')
    const appearance = await realDialog.getByLabel('动态标题布局').evaluate(el => { const css = getComputedStyle(el); return { color: css.color, background: css.backgroundColor, height: el.offsetHeight } })
    assert.equal(appearance.background, 'rgb(29, 34, 48)'); assert.equal(appearance.color, 'rgb(227, 232, 242)'); assert.equal(appearance.height, 32)
    const add = realDialog.getByRole('button', { name: '添加到时间线', exact: true })
    await add.hover()
    assert.notEqual(await add.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)')
    await add.click()
    await expect(realDialog).toContainText('标题已添加到时间线')
    await real.screenshot({ path: path.join(output, 'real-app-title-dark.png') })
    await close(real, '标注与标题')
    await expect(real.locator('.timeline-clip')).toHaveCount(1)
    await real.getByTestId('preview-tools-open').click()
    const preview = real.getByRole('dialog', { name: '预览与试听', exact: true })
    await preview.getByRole('button', { name: '提取合成画面', exact: true }).click()
    await expect(preview.getByAltText('最终合成画面')).toBeVisible()
    await expect.poll(() => preview.getByAltText('最终合成画面').evaluate(el => el.naturalWidth)).toBe(1280)
    await close(real, '预览与试听')
    await real.getByTestId('theme-light').click(); await real.getByTestId('visual-elements-open').click()
    await realDialog.getByRole('button', { name: '动态标题', exact: true }).click()
    await realDialog.getByLabel('动态标题文字').fill('明亮主题对比检查'); await add.hover()
    const light = await add.evaluate(el => ({ foreground: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }))
    assert.equal(light.foreground, 'rgb(255, 255, 255)'); assert.notEqual(light.background, light.foreground)
    await real.screenshot({ path: path.join(output, 'real-app-title-light.png') })
    const frameLimits = await real.evaluate(async () => {
      const { createProject, createTextClip } = await import('/src/core/project.ts')
      const { timelineFrame } = await import('/src/core/editor-preview-tools.ts')
      const { getToolArtifact } = await import('/src/core/tool-artifacts.ts')
      const extreme = createProject('极端比例取帧', { width: 16, height: 16384, fps: 24 })
      extreme.tracks.find(track => track.kind === 'text').clips.push(createTextClip(extreme, { text: '取帧', trimOut: 2 }))
      const context = { project: extreme, revision: 0, blobs: new Map(), source: 'gui', signal: new AbortController().signal, onProgress: () => {} }
      const frame = await timelineFrame(context, 0, 1920), artifact = await getToolArtifact(frame.artifactId)
      const png = [...new Uint8Array(await artifact.blob.arrayBuffer()).slice(0, 8)], decoded = await createImageBitmap(artifact.blob)
      const dimensions = [decoded.width, decoded.height]; decoded.close()
      const descriptor = Object.getOwnPropertyDescriptor(document.fonts, 'ready'), controller = new AbortController()
      let abortName = '', elapsed = 0, deadline
      Object.defineProperty(document.fonts, 'ready', { configurable: true, value: new Promise(() => {}) })
      const started = performance.now(), timer = setTimeout(() => controller.abort(), 30)
      try {
        await Promise.race([timelineFrame({ ...context, signal: controller.signal }, 0, 320), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('字体等待未及时取消')), 1500) })])
      } catch (cause) { abortName = cause.name; elapsed = performance.now() - started }
      finally { clearTimeout(timer); clearTimeout(deadline); if (descriptor) Object.defineProperty(document.fonts, 'ready', descriptor); else delete document.fonts.ready }
      return { width: frame.width, height: frame.height, mime: artifact.blob.type, png, dimensions, abortName, elapsed }
    })
    assert(frameLimits.width > 0 && frameLimits.height > 0 && Math.max(frameLimits.width, frameLimits.height) <= 1920)
    assert.equal(frameLimits.mime, 'image/png'); assert.deepEqual(frameLimits.png, [137,80,78,71,13,10,26,10])
    assert.deepEqual(frameLimits.dimensions, [frameLimits.width, frameLimits.height]); assert.equal(frameLimits.abortName, 'AbortError'); assert(frameLimits.elapsed < 1000)
    console.log('PASS timeline frame extreme aspect ratio stays within 1920px, real PNG artifact, cancellable stalled font preparation')
    assert.deepEqual(realErrors, []); await real.close()
    console.log('PASS real App shared runner commit and light/dark hover/select contrast, 32px native selects')
    await verifyNativeProjectPreparation(browser, `http://127.0.0.1:${server.httpServer.address().port}`)
    console.log(`Screenshots: ${output}`)
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
