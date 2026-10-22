const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

const read = page => page.evaluate(() => JSON.parse(JSON.stringify(window.editingAssist.current.value)))
const find = (project, id) => project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)

async function mount(page, url, desktop = true) {
  await page.route('**/__editing_assist__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app,.app-shell{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/__editing_assist__`)
  await page.evaluate(async desktop => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueURL)
    const { createProject, createClip, createSubtitleClip, createTrack } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory } = await import('/src/core/timeline.ts')
    const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
    const { BACKGROUND_MUSIC } = await import('/src/core/background-music-catalog.ts')
    const { bundledVoicePreviewUrl } = await import('/src/core/voice-previews.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const { prepareEditorTool } = await import('/src/core/editor-tool-service.ts')
    const media = await (await fetch(VIDEO_SEGMENTS[0].url)).blob()
    const asset = await importMediaFile(new File([media], '剪辑优化示例.webm', { type: 'video/webm' }))
    asset.id = 'source'; asset.nativePath = '/media/source.webm'
    const voiceBytes = await (await fetch(bundledVoicePreviewUrl('matcha_zh_en_female'))).blob()
    const musicBytes = await (await fetch(BACKGROUND_MUSIC[0].url)).blob()
    const voice = await importMediaFile(new File([voiceBytes], '旁白示例.mp3', { type: 'audio/mpeg' }))
    const music = await importMediaFile(new File([musicBytes], '背景音乐示例.mp3', { type: 'audio/mpeg' }))
    voice.id = 'voice-source'; voice.nativePath = '/media/voice.mp3'
    music.id = 'music-source'; music.nativePath = '/media/music.mp3'; music.libraryRole = 'background-music'
    const project = createProject('讲解视频 · 剪辑优化', { width: 640, height: 360, fps: 24 })
    project.assets.push(asset, voice, music)
    project.tracks.find(track => track.kind === 'video').clips.push(createClip(asset, project, { id: 'video-a', trimOut: Math.min(5, asset.duration) }))
    project.tracks.find(track => track.kind === 'text').clips.push(
      createSubtitleClip(project, { id: 'reference', text: '先展示结果，再解释步骤', color: '#ffcc00', fontSize: 28, start: 0, trimOut: 2 }),
      createSubtitleClip(project, { id: 'caption-a', text: '让观众看清每一步操作', fontSize: 20, start: 2, trimOut: 2 }),
    )
    const extra = createTrack('text', '补充说明')
    extra.clips.push(createSubtitleClip(project, { id: 'caption-b', text: '统一声音与字幕风格', fontSize: 20, start: 4, trimOut: 1 }))
    project.tracks.push(extra)
    const voiceTrack = project.tracks.find(track => track.kind === 'audio'), musicTrack = createTrack('audio', '背景音乐')
    voiceTrack.id = 'voice-track'; voiceTrack.name = '旁白'
    voiceTrack.clips.push(createClip(voice, project, { id: 'voice-a', start: .5, trimOut: 2, speech: { textClipId: 'reference', text: '先展示结果，再解释步骤', voiceId: 'fixture', rate: 1 } }))
    musicTrack.id = 'music-track'; musicTrack.clips.push(createClip(music, project, { id: 'music-a', trimOut: 5, volume: .35 }))
    project.tracks.push(musicTrack)
    const fixture = window.editingAssist = { current: shallowRef(project), editor: ref(), calls: [], tools: [], busy: [], commits: 0, messages: [], theme: ref('dark'), hold: false, cancelled: 0, devices: 0 }
    let history = createHistory(project), revision = 0
    const commit = (next, label) => { history = commitHistory(history, next); fixture.current.value = next; revision++; fixture.commits++; fixture.messages.push(label) }
    fixture.undo = () => { history = undoHistory(history); fixture.current.value = history.present; revision++ }
    fixture.blobs = new Map([[asset.id, media], [voice.id, voiceBytes], [music.id, musicBytes]])
    navigator.mediaDevices.getUserMedia = async () => { fixture.devices++; throw new Error('No device capture in editing assist tests') }
    // Native analysis is controlled here to test GUI cancellation and busy handling.
    // The preview uses a real bundled video; these fixture intervals are not media-analysis claims.
    if (desktop) window.__TAURI_INTERNALS__ = {
      convertFileSrc: filename => filename.includes('voice.mp3') ? voice.url : filename.includes('music.mp3') ? music.url : asset.url,
      invoke: async (command, args) => {
        fixture.calls.push({ command, args })
        if (command === 'list_stored_videos') return { directory: '/recordings', assets: [], warnings: [] }
        if (command === 'mcp_asset_tool' && args.operation === 'asset_detect_idle') {
          if (fixture.hold) await new Promise((resolve, reject) => {
            fixture.cancelAnalysis = () => { fixture.hold = false; fixture.cancelled++; reject(new DOMException('已取消', 'AbortError')) }
          })
          return { intervals: [{ kind: 'freeze', start: 1, end: 3, confidence: .96 }], detectors: ['black', 'freeze'], repeatedIntervals: [], repetitionScope: { truncated: false } }
        }
        if (command === 'mcp_asset_cancel') { fixture.cancelAnalysis?.(); fixture.cancelAnalysis = undefined; return true }
        if (command === 'audio_tool_begin' && args.spec.action === 'analyze') return { id: 'analysis-voice-a', state: 'completed', progress: 1, stage: '测量完成', result: { integratedLufs: -22, truePeakDbtp: -8, measured: true, silent: false } }
        if (command === 'audio_tool_accept' || command === 'audio_tool_discard') return null
        throw new Error(`Unexpected native command: ${command}`)
      },
    }
    fixture.run = async (name, args, options) => {
      fixture.tools.push({ name, args: JSON.parse(JSON.stringify(args)) })
      const original = fixture.current.value, originalRevision = revision
      const prepared = await prepareEditorTool(name, args, { ...options, project: original, revision, blobs: fixture.blobs, source: 'gui' })
      try {
        options.signal.throwIfAborted()
        if (originalRevision !== revision) throw new Error('项目已变化')
        if (prepared.project || prepared.accept) options.onProgress({ stage: '正在保存处理结果', progress: 1, cancelable: false })
        if (prepared.project) commit(prepared.project, prepared.label)
        await prepared.accept?.(); await nextTick()
        return prepared.data
      } catch (cause) { await prepared.discard?.(); throw cause }
    }
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    fixture.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': fixture.theme.value }, h(Editor, {
      ref: fixture.editor, project: fixture.current.value, runTool: fixture.run, onChange: commit,
      onBusy: value => fixture.busy.push(value), onStatus: message => fixture.messages.push(message),
    })) })
    fixture.app.mount('#app')
  }, desktop)
  await expect(page.locator('.timeline-clip[data-clip-id="video-a"]')).toBeVisible()
}

async function main() {
  const output = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'editing-assist') : '/tmp/open-media-editing-assist'
  fs.mkdirSync(output, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
    await mount(page, `http://127.0.0.1:${server.httpServer.address().port}`)
    const open = page.getByTestId('editing-assist-open'), dialog = page.getByRole('dialog', { name: '剪辑优化', exact: true })
    await open.click()
    await expect(dialog).toBeVisible()
    const tab = name => dialog.getByRole('tab', { name, exact: true })
    await expect(tab('节奏检查')).toHaveAttribute('aria-selected', 'true')
    await tab('节奏检查').focus(); await page.keyboard.press('ArrowRight')
    await expect(tab('声画对齐')).toHaveAttribute('aria-selected', 'true'); await expect(tab('声画对齐')).toBeFocused()
    await page.keyboard.press('End'); await expect(tab('画面聚焦')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Home'); await expect(tab('节奏检查')).toHaveAttribute('aria-selected', 'true')
    console.log('PASS 剪辑优化入口与键盘切换标签')

    await page.evaluate(() => { window.editingAssist.hold = true })
    await dialog.getByTestId('rhythm-analyze').click()
    await expect(dialog.getByRole('button', { name: '取消处理', exact: true })).toBeEnabled()
    await expect(dialog.getByRole('button', { name: '关闭剪辑优化', exact: true })).toBeDisabled()
    for (const name of ['节奏检查', '声画对齐', '声音平衡', '字幕样式', '画面聚焦']) await expect(tab(name)).toBeDisabled()
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible()
    // Busy UI precedes native dispatch; this scenario verifies cancellation of an already running job.
    await page.waitForFunction(() => typeof window.editingAssist.cancelAnalysis === 'function')
    await dialog.getByRole('button', { name: '取消处理', exact: true }).click()
    await expect(dialog.getByText('已取消', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '关闭剪辑优化', exact: true })).toBeEnabled()
    await expect(tab('字幕样式')).toBeEnabled()
    assert.equal(await page.evaluate(() => window.editingAssist.cancelled), 1)
    assert.equal(await page.evaluate(() => window.editingAssist.busy.at(-1)), false)
    assert.equal(await page.evaluate(() => window.editingAssist.commits), 0)
    console.log('PASS 节奏分析忙碌锁定弹窗和标签、Esc 不关闭、取消释放锁且不修改项目')

    await dialog.getByTestId('rhythm-analyze').click()
    await expect(dialog.getByTestId('rhythm-candidate')).toHaveCount(1)
    await expect(dialog.getByTestId('rhythm-candidate')).toContainText('00:01.000–00:03.000')
    const calls = await page.evaluate(() => window.editingAssist.tools.length)
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'editing-assist-rhythm-dark.png') })
    await dialog.getByRole('button', { name: '定位 00:01.000', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect.poll(() => page.evaluate(() => window.editingAssist.editor.value.getPlayback().time)).toBe(1)
    assert.equal(await page.evaluate(() => window.editingAssist.editor.value.getPlayback().selectedClipId), 'video-a')
    await open.click()
    await expect(dialog.getByTestId('rhythm-candidate')).toHaveCount(1)
    assert.equal(await page.evaluate(() => window.editingAssist.tools.length), calls, '重开保留分析结果，不重新调用检测')
    console.log('PASS 候选定位关闭弹窗并选择片段，重开保留结果')

    await tab('字幕样式').click()
    await dialog.getByLabel('参考字幕', { exact: true }).selectOption('reference')
    await expect(dialog.getByTestId('subtitle-style-summary')).toContainText('将修改 2 条字幕')
    const original = await read(page), before = await page.evaluate(() => window.editingAssist.commits)
    await page.evaluate(() => { window.editingAssist.theme.value = 'light' })
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'editing-assist-subtitles-light.png') })
    await dialog.getByRole('button', { name: '应用字幕样式', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.editingAssist.commits)).toBe(before + 1)
    const styled = await read(page)
    for (const id of ['caption-a', 'caption-b']) {
      assert.equal(find(styled, id).color, '#ffcc00'); assert.equal(find(styled, id).fontSize, 28)
      for (const key of ['text', 'start', 'trimIn', 'trimOut']) assert.deepEqual(find(styled, id)[key], find(original, id)[key])
    }
    assert.equal(styled.subtitleStyle.color, '#ffcc00')
    await page.evaluate(() => window.editingAssist.undo())
    await expect(dialog.getByTestId('subtitle-style-summary')).toContainText('将修改 2 条字幕')
    assert.deepEqual(await read(page), original, '撤销恢复跨轨字幕属性和默认样式')
    console.log('PASS 中央面板跨轨字幕样式只提交一次，保留文本时序并整体撤销')

    await tab('声画对齐').click()
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'editing-assist-alignment-light.png') })
    await tab('声音平衡').click()
    const audio = dialog.getByTestId('audio-balance-assist')
    await expect(audio.locator('.ab-tracks > div:first-child input[value="voice-track"]')).toBeChecked()
    await expect(audio.locator('.ab-tracks > div:last-child input[value="music-track"]')).toBeChecked()
    await expect(audio.getByRole('button', { name: '应用声音平衡', exact: true })).toBeEnabled()
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'editing-assist-audio-light.png') })
    const beforeAudio = await read(page), audioCommits = await page.evaluate(() => window.editingAssist.commits)
    await audio.getByRole('button', { name: '应用声音平衡', exact: true }).click()
    await expect(audio).toContainText('已调整 1 段旁白 · 1 段音乐自动压低')
    assert.equal(await page.evaluate(() => window.editingAssist.commits), audioCommits + 1)
    const balanced = await read(page)
    assert(find(balanced, 'voice-a').volume > 1.9)
    assert(find(balanced, 'music-a').keyframes.volume.some(frame => frame.value < .1))
    assert.deepEqual(find(balanced, 'music-a').audioBalance.ducking.keyframes, find(balanced, 'music-a').keyframes.volume)
    const audioCalls = await page.evaluate(() => window.editingAssist.calls.filter(call => call.command.startsWith('audio_tool_')))
    assert.deepEqual(audioCalls.map(call => call.command), ['audio_tool_begin', 'audio_tool_accept'])
    assert.equal(audioCalls[0].args.spec.asset.id, 'voice-source')
    await page.evaluate(() => { window.editingAssist.theme.value = 'dark' })
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'editing-assist-audio-dark.png') })
    await page.evaluate(() => window.editingAssist.undo())
    assert.deepEqual(await read(page), beforeAudio)
    console.log('PASS 中央声音平衡通过真实准备服务调用测量桥、生成关键帧并一次提交和撤销')

    const beforeFocus = await page.evaluate(() => window.editingAssist.commits)
    await page.evaluate(() => { window.editingAssist.theme.value = 'light' })
    await tab('画面聚焦').click()
    await dialog.getByLabel('聚焦片段', { exact: true }).selectOption('video-a')
    await dialog.getByTestId('assist-focus-pick').click()
    await expect(dialog).not.toBeVisible()
    const picker = page.getByTestId('preview-focus-region')
    await expect(picker).toBeVisible()
    const bounds = await picker.locator('svg').evaluate(svg => {
      const matrix = svg.getScreenCTM(), a = new DOMPoint(160, 90).matrixTransform(matrix), b = new DOMPoint(480, 270).matrixTransform(matrix)
      return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    })
    await page.mouse.move(bounds.x1, bounds.y1); await page.mouse.down(); await page.mouse.move(bounds.x2, bounds.y2); await page.mouse.up()
    await expect(picker).toHaveCount(0)
    const visual = page.getByTestId('visual-clip-tools')
    await expect(visual.getByLabel('聚焦区域宽度', { exact: true })).toHaveValue('50')
    await expect(visual.getByRole('button', { name: '应用聚焦', exact: true })).toBeEnabled()
    assert.equal(await page.evaluate(() => window.editingAssist.commits), beforeFocus, '框选只准备动画，不提前提交项目')
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'editing-assist-focus-light.png') })
    assert.equal(await page.evaluate(() => window.editingAssist.devices), 0)
    assert.deepEqual(errors, [])
    console.log(`PASS 从中央面板进入真实视频预览框选，正确填写动画区域；无设备采集及浏览器异常；截图：${output}`)

    const web = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    web.on('pageerror', error => errors.push(error.message)); web.setDefaultTimeout(15000)
    await mount(web, `http://127.0.0.1:${server.httpServer.address().port}`, false)
    assert.equal(await web.evaluate(() => '__TAURI_INTERNALS__' in window), false)
    await web.getByTestId('editing-assist-open').click()
    const webDialog = web.getByRole('dialog', { name: '剪辑优化', exact: true })
    await expect(webDialog.getByTestId('rhythm-analyze')).toBeDisabled()
    await expect(webDialog.getByTestId('rhythm-assist')).toContainText('桌面')
    await web.screenshot({ animations: 'disabled', path: path.join(output, 'editing-assist-web-dark.png') })
    await webDialog.getByRole('tab', { name: '声音平衡', exact: true }).click()
    await expect(webDialog.getByRole('button', { name: '应用声音平衡', exact: true })).toBeDisabled()
    await expect(webDialog.getByTestId('audio-balance-assist')).toContainText('桌面')
    assert.equal(await web.evaluate(() => window.editingAssist.tools.length), 0)
    await webDialog.getByRole('tab', { name: '声画对齐', exact: true }).click()
    await expect(webDialog.getByTestId('speech-alignment-preview')).toBeEnabled()
    await webDialog.getByTestId('speech-alignment-preview').click()
    await expect(webDialog.getByTestId('speech-alignment-apply')).toBeEnabled()
    await webDialog.getByRole('tab', { name: '字幕样式', exact: true }).click()
    await webDialog.getByLabel('参考字幕', { exact: true }).selectOption('reference')
    await webDialog.getByRole('button', { name: '应用字幕样式', exact: true }).click()
    await expect.poll(() => web.evaluate(() => window.editingAssist.commits)).toBe(1)
    assert.equal(find(await read(web), 'caption-b').color, '#ffcc00')
    await webDialog.getByRole('tab', { name: '画面聚焦', exact: true }).click()
    await webDialog.getByTestId('assist-focus-pick').click()
    await expect(webDialog).not.toBeVisible()
    const webPicker = web.getByTestId('preview-focus-region')
    await expect(webPicker).toBeVisible()
    const webBounds = await webPicker.locator('svg').evaluate(svg => {
      const matrix = svg.getScreenCTM(), a = new DOMPoint(160, 90).matrixTransform(matrix), b = new DOMPoint(480, 270).matrixTransform(matrix)
      return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    })
    await web.mouse.move(webBounds.x1, webBounds.y1); await web.mouse.down(); await web.mouse.move(webBounds.x2, webBounds.y2); await web.mouse.up()
    await web.getByTestId('visual-clip-tools').getByRole('button', { name: '应用聚焦', exact: true }).click()
    await expect.poll(() => web.evaluate(() => window.editingAssist.commits)).toBe(2)
    assert.equal(find(await read(web), 'video-a').keyframes.scaleX.at(-1).value, 1)
    assert.deepEqual(await web.evaluate(() => window.editingAssist.calls), [])
    assert.equal(await web.evaluate(() => window.editingAssist.devices), 0)
    assert.deepEqual(errors, [])
    console.log('PASS 网页明确禁用节奏检测及声音平衡，字幕、现有配音对齐和聚焦继续可用，无原生命令调用')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
