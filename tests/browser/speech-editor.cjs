const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

function audioFixture() {
  const samples = 24000 * 2.5, bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index / 24000 * 2 * Math.PI * 220) * 4000), 44 + index * 2)
  return { url: `data:audio/wav;base64,${bytes.toString('base64')}`, size: bytes.length }
}

async function installNativeContract(page, voices = [{ id: 'english-first', name: '英语女声', language: 'en-US', gender: 'female' }, { id: 'voice-1', name: '清朗', language: 'zh-CN', gender: 'female' }, { id: 'voice-2', name: '温和', language: 'zh-CN', gender: 'male' }]) {
  await page.addInitScript(fixture => {
    const state = { mode: 'pending', calls: [], jobs: {}, accepted: [], discarded: [], cancelled: [] }
    window.speechHarness = state
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: () => fixture.url,
      invoke: async (command, args) => {
        state.calls.push({ command, args })
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'get_media_jobs') return []
        if (command === 'plugin:event|listen') return 1
        if (command === 'plugin:event|unlisten') return null
        if (command === 'get_speech_status') return { ready: true, voices: fixture.voices }
        const finish = job => ({ ...job, state: 'completed', stage: '语音已生成', asset: { id: `speech-${job.id}`, name: '生成语音.wav', kind: 'audio', url: fixture.url, nativePath: `/fixture/speech/${job.id}.wav`, mime: 'audio/wav', duration: 2.5, width: 0, height: 0, size: fixture.size } })
        if (command === 'begin_speech_job') {
          const request = args.request
          const job = { id: request.requestId, state: 'running', stage: '正在合成语音' }
          state.jobs[job.id] = job
          return state.mode === 'completed' ? finish(job) : job
        }
        if (command === 'get_speech_job') { const job = state.jobs[args.id]; return state.mode === 'completed' && job.state === 'running' ? finish(job) : job }
        if (command === 'cancel_speech_job') { state.cancelled.push(args.id); if (state.jobs[args.id]) state.jobs[args.id].state = 'cancelled'; return null }
        if (command === 'discard_speech_job') { state.discarded.push(args.id); return null }
        if (command === 'accept_speech_jobs') { state.accepted.push(...args.ids); return null }
        throw new Error(`未预期的原生命令：${command}`)
      },
    }
  }, { ...audioFixture(), voices })
}

async function expectDialogFocus(dialog) {
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
}

async function selectVoice(page, category, name) {
  await page.getByRole('tab', { name: new RegExp(`^${category}`) }).click()
  await page.getByRole('button', { name: `选择 ${name}`, exact: true }).click()
  await expect(page.getByRole('button', { name: `选择 ${name}`, exact: true })).toHaveAttribute('aria-pressed', 'true')
}

async function speechRequests(page) {
  return page.evaluate(() => window.speechHarness.calls.filter(call => call.command === 'begin_speech_job').map(call => call.args.request))
}

async function verifyBundledVoiceCatalog(browser, url) {
  const voices = require('../../scripts/speech-runtime.lock.json').voices
  assert.equal(voices.length, 103)
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const page = await context.newPage(), foreignRequests = [], errors = []
  try {
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const requestUrl = route.request().url()
      if (/^https?:/.test(requestUrl) && new URL(requestUrl).origin !== new URL(url).origin) { foreignRequests.push(requestUrl); return route.abort() }
      return route.continue()
    })
    await installNativeContract(page, voices)
    await page.goto(url)
    await page.getByTestId('create-project').click()
    await page.locator('.editor-tools').getByRole('button', { name: '文字转语音', exact: true }).click()
    const picker = page.getByTestId('voice-picker')
    await expect(picker).toBeVisible()
    for (const [category, count] of [['中文男声', 45], ['中文女声', 55], ['英文女声', 3]]) {
      const tab = picker.getByRole('tab', { name: new RegExp(`^${category}`) })
      await expect(tab).toContainText(String(count))
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(picker.getByRole('button', { name: /^选择 / })).toHaveCount(count)
      const images = picker.locator('img')
      await expect(images.first()).toHaveJSProperty('complete', true)
      await expect.poll(() => images.first().evaluate(image => image.naturalWidth)).toBeGreaterThan(0)
      assert.equal(await images.evaluateAll(images => images.every(image => image.currentSrc.startsWith('data:image/') || new URL(image.currentSrc || image.src).origin === location.origin)), true, '声音卡片图片应随软件提供')
      if (count > 3) {
        const grid = picker.locator('.voice-grid-scroll')
        assert.equal(await grid.evaluate(element => element.scrollHeight > element.clientHeight), true, '完整声音目录应在网格内滚动')
        await grid.evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect.poll(() => grid.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        await expect(images.last()).toHaveJSProperty('complete', true)
        await expect.poll(() => images.last().evaluate(image => image.naturalWidth)).toBeGreaterThan(0)
        await grid.evaluate(element => { element.scrollTop = 0 })
      }
    }
    await picker.getByRole('tab', { name: /^中文男声/ }).click()
    const search = picker.getByLabel('搜索声音', { exact: true })
    await search.fill('中文男声 100')
    await expect(picker.getByRole('button', { name: /^选择 / })).toHaveCount(1)
    await picker.getByRole('button', { name: '选择 中文男声 100', exact: true }).click()
    await expect(picker.getByRole('button', { name: '选择 中文男声 100', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await search.fill('不存在的音色')
    await expect(picker.getByRole('button', { name: /^选择 / })).toHaveCount(0)
    await search.fill('')
    await expect(picker.getByRole('button', { name: /^选择 / })).toHaveCount(45)
    assert.equal((await speechRequests(page)).length, 0, '浏览或选择声音不应启动合成')
    assert.deepEqual(foreignRequests, [], '卡片图片不应依赖网络服务')
    assert.deepEqual(errors, [])
    await picker.getByRole('tab', { name: /^中文女声/ }).click()
    await page.screenshot({ animations: 'disabled', path: '/tmp/open-media-speech-editor/voice-catalog.png' })
    await page.setViewportSize({ width: 320, height: 850 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ animations: 'disabled', path: '/tmp/open-media-speech-editor/voice-catalog-compact.png' })
    console.log('PASS 真实内置目录：45种中文男声、55种中文女声、3种英文女声分类、滚动、搜索和离线图片加载')
  } finally { await context.close() }
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}`
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] })
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
    const page = await context.newPage(), errors = []
    fs.mkdirSync('/tmp/open-media-speech-editor', { recursive: true })
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
    await installNativeContract(page)
    await page.goto(url)
    await page.getByTestId('create-project').click()
    await expect(page.getByTestId('video-editor')).toBeVisible()
    assert.equal(await page.evaluate(() => window.speechHarness.calls.some(call => call.command === 'get_speech_status')), false, '进入剪辑时不应加载未打开的配音组件')
    await page.getByRole('button', { name: '字幕', exact: true }).click()
    await page.getByLabel('字幕内容').fill('第一段配音文字'); await page.getByLabel('字幕内容').press('Tab')
    await page.getByRole('button', { name: '字幕', exact: true }).click()
    await page.getByLabel('字幕内容').fill('第二段配音文字'); await page.getByLabel('字幕内容').press('Tab')
    await page.getByLabel('片段开始时间', { exact: true }).fill('4'); await page.getByLabel('片段开始时间', { exact: true }).press('Tab')
    const speechButton = page.locator('.editor-tools').getByRole('button', { name: '文字转语音', exact: true })
    const speechDialog = page.getByRole('dialog', { name: '文字转语音', exact: true })
    const closeSpeech = speechDialog.getByRole('button', { name: '关闭文字转语音', exact: true })
    await speechButton.click()
    await expect(speechDialog).toBeVisible()
    assert.equal(await speechDialog.evaluate(element => element.tagName === 'DIALOG' && element.matches(':modal')), true)
    await expect(speechDialog.getByTestId('speech-panel')).toBeVisible()
    await expect(page.locator('.property-panel').getByTestId('speech-panel')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '选择 清朗', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('tab', { name: /^中文女声/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^中文男声/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^英文女声/ })).toBeVisible()
    await expect(speechDialog.locator('select[aria-label="配音声音"]')).toHaveCount(0)
    await page.getByRole('tab', { name: /^中文男声/ }).click()
    await expect(page.getByRole('button', { name: '选择 温和', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('button', { name: '选择 清朗', exact: true })).toHaveCount(0)
    await page.getByRole('tab', { name: /^英文女声/ }).click()
    await expect(page.getByRole('button', { name: '选择 英语女声', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await page.getByRole('tab', { name: /^中文女声/ }).click()
    await expect(page.getByRole('button', { name: '选择 清朗', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await closeSpeech.focus()
    for (const key of ['Tab', 'Shift+Tab']) for (let index = 0; index < 16; index++) {
      await page.keyboard.press(key)
      assert.equal(await speechDialog.evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body), true, '原生模态 Tab 可以进入浏览器界面，但不能聚焦背景工作台')
    }
    await closeSpeech.focus()
    await page.getByTestId('nav-record').evaluate(element => element.focus())
    await expectDialogFocus(speechDialog)
    await closeSpeech.focus()
    const beforeModalKeys = await page.locator('.timeline-content').innerHTML()
    for (const key of ['q', 'w', 'Delete', 'Control+z']) await page.keyboard.press(key)
    assert.equal(await page.locator('.timeline-content').innerHTML(), beforeModalKeys, '弹窗内快捷键不得修改背景时间线')
    await page.keyboard.press('Escape')
    await expect(speechDialog).not.toBeVisible()
    await expect(speechButton).toBeFocused()
    await speechButton.click()
    console.log('PASS 配音移入原生模态弹窗，Tab 焦点不越界、背景不可聚焦、Escape 恢复触发按钮')

    await page.getByTestId('speech-generate-all').click()
    await expect(page.locator('.speech-progress')).toContainText('已完成 0 / 2')
    await expect(page.getByTestId('save-project')).toBeDisabled()
    await expect(page.locator('.topbar button[aria-label="撤销"]')).toBeDisabled()
    await expect(page.getByTestId('nav-record')).toBeDisabled()
    await expect(page.getByTitle('新建项目', { exact: true })).toBeDisabled()
    await expect(closeSpeech).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(speechDialog).toBeVisible()
    await page.getByRole('button', { name: '取消生成', exact: true }).click()
    await expect(page.locator('.speech-notice')).toContainText('取消')
    await expect(page.getByTestId('save-project')).toBeEnabled()
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    await expect(closeSpeech).toBeEnabled()
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(0)
    await expect(page.locator('.asset-card')).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.speechHarness.cancelled.length > 0 && window.speechHarness.discarded.length > 0), true)
    console.log('PASS 原生桥契约：实际工作台批量配音锁定导航/保存/撤销，取消释放并保持时间线')

    await page.evaluate(() => { window.speechHarness.mode = 'completed' })
    await selectVoice(page, '中文男声', '温和')
    await page.getByLabel('配音语速').fill('1.25')
    await page.getByTestId('speech-generate-all').click()
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(2)
    await expect(page.locator('.asset-card')).toHaveCount(2)
    await expect(page.locator('.speech-notice')).toContainText('已添加 2 段语音')
    assert.equal(await page.locator('.timeline-clip.text .clip-detail').evaluateAll(elements => elements.every(element => element.textContent.includes('2.5s'))), true)
    assert.equal(await page.evaluate(() => window.speechHarness.accepted.length), 2)
    const requests = await page.evaluate(() => window.speechHarness.calls.filter(call => call.command === 'begin_speech_job').map(call => call.args.request))
    assert.equal(requests.at(-1).voiceId, 'voice-2'); assert.equal(requests.at(-1).speed, 1.25)
    await closeSpeech.click()
    await expect(speechDialog).not.toBeVisible()
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(0); await expect(page.locator('.asset-card')).toHaveCount(0)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(2)
    assert.equal(await page.evaluate(() => window.speechHarness.accepted.some(id => window.speechHarness.discarded.includes(id))), false)
    console.log('PASS 原生桥契约：全部配音原子加入音轨/素材、时长对齐、保留撤销/重做资源')

    await page.locator('.timeline-clip.text').first().click({ button: 'right' })
    await expect(page.getByRole('menu', { name: '文字片段操作' })).toBeVisible()
    await page.getByRole('menuitem', { name: '文字转语音', exact: true }).click()
    await expect(speechDialog).toBeVisible()
    await expect(page.locator('.speech-notice')).toContainText('已添加 1 段语音')
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(2)
    await expect(page.locator('.asset-card')).toHaveCount(3)
    console.log('PASS 原生桥契约：单个文字右键生成替换关联音轨，不重复叠加')

    await closeSpeech.click()
    await page.locator('.timeline-clip.text').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '文字对齐已有语音', exact: true }).click()
    await expect(speechDialog).toBeVisible()
    await expect(page.locator('.speech-notice')).toContainText('文字起点和时长已对齐关联语音')
    await expectDialogFocus(speechDialog)

    await page.getByRole('tab', { name: /^英文女声/ }).click()
    const beforeCardPreview = (await speechRequests(page)).length
    const speaker = page.getByRole('button', { name: '试听 英语女声', exact: true })
    const speakerBounds = await speaker.boundingBox(), cardBounds = await page.locator('.voice-card[data-voice-id="english-first"]').boundingBox()
    assert(speakerBounds && cardBounds && speakerBounds.x > cardBounds.x + cardBounds.width / 2 && speakerBounds.y < cardBounds.y + cardBounds.height / 2, '试听喇叭应位于卡片右上角')
    await expect(speaker.locator('svg')).toHaveCount(1)
    await page.getByRole('button', { name: '试听 英语女声', exact: true }).click()
    await expect(page.getByLabel('生成的试听音频')).toHaveJSProperty('readyState', 4)
    await expect(page.getByLabel('生成的试听音频')).toHaveJSProperty('paused', false)
    assert.equal(await page.getByLabel('生成的试听音频').evaluate(audio => audio.duration), 2.5)
    const englishPreview = (await speechRequests(page)).at(-1)
    assert.equal(englishPreview.voiceId, 'english-first')
    assert(/[a-z]/i.test(englishPreview.text) && !/\p{Script=Han}/u.test(englishPreview.text), '英文卡片试听应使用英文默认样句')
    assert.equal((await speechRequests(page)).length, beforeCardPreview + 1)
    await expect(speaker).toHaveAttribute('aria-pressed', 'true')
    await speaker.click()
    await expect(page.getByLabel('生成的试听音频')).toHaveJSProperty('paused', true)
    await expect(speaker).toHaveAttribute('aria-pressed', 'false')
    await page.getByRole('tab', { name: /^中文男声/ }).click()
    await expect(page.getByRole('button', { name: '选择 温和', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('tab', { name: /^英文女声/ }).click()
    await page.getByRole('button', { name: '试听 英语女声', exact: true }).click()
    await expect(page.getByLabel('生成的试听音频')).toHaveJSProperty('paused', false)
    assert.equal((await speechRequests(page)).length, beforeCardPreview + 1, '重复试听应复用已生成的音频')
    await expect(page.locator('.asset-card')).toHaveCount(3)
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(2)
    const previewAudio = await page.getByLabel('生成的试听音频').elementHandle()
    const previewId = await page.evaluate(() => window.speechHarness.calls.filter(call => call.command === 'begin_speech_job').at(-1).args.request.requestId)
    await closeSpeech.click()
    await expect(speechDialog).not.toBeVisible()
    assert.equal(await previewAudio.evaluate(audio => audio.paused && !audio.hasAttribute('src')), true, '关闭配音弹窗必须停止并释放试听')
    await expect.poll(() => page.evaluate(id => window.speechHarness.discarded.includes(id), previewId)).toBe(true)
    await expect(page.locator('.asset-card')).toHaveCount(3)
    await speechButton.click()
    await page.getByRole('tab', { name: /^中文男声/ }).click()
    await expect(page.getByRole('button', { name: '选择 温和', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('配音语速')).toHaveValue('1.25')
    await expect(page.getByLabel('生成的试听音频')).toHaveCount(0)
    console.log('PASS 原生桥契约：卡片喇叭独立试听、英文样句、暂停/缓存重播，不改变选择或添加时间线素材')

    await page.evaluate(() => { window.speechHarness.mode = 'pending' })
    await page.getByRole('button', { name: '试听 温和', exact: true }).click()
    await expect(page.locator('.speech-progress')).toBeVisible()
    const pendingPreviewId = (await speechRequests(page)).at(-1).requestId
    await page.getByRole('button', { name: '取消生成', exact: true }).click()
    await expect(closeSpeech).toBeEnabled()
    await expect.poll(() => page.evaluate(id => window.speechHarness.cancelled.includes(id) && window.speechHarness.discarded.includes(id), pendingPreviewId)).toBe(true)
    await expect(page.getByLabel('生成的试听音频')).toHaveCount(0)
    await expect(page.locator('.asset-card')).toHaveCount(3)
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(2)
    await page.evaluate(() => { window.speechHarness.mode = 'completed' })
    await page.locator('.voice-preview > summary').click()
    await page.getByLabel('试听文本').fill('这是一段自定义试听文本。')
    await page.getByRole('button', { name: '生成试听', exact: true }).click()
    await expect(page.getByLabel('生成的试听音频')).toHaveJSProperty('readyState', 4)
    assert.equal((await speechRequests(page)).at(-1).text, '这是一段自定义试听文本。')
    assert.equal((await speechRequests(page)).at(-1).voiceId, 'voice-2')
    const customPreviewId = (await speechRequests(page)).at(-1).requestId
    await selectVoice(page, '中文女声', '清朗')
    await expect(page.getByLabel('生成的试听音频')).toHaveCount(0)
    await expect.poll(() => page.evaluate(id => window.speechHarness.discarded.includes(id), customPreviewId)).toBe(true)
    assert.equal(await page.evaluate(() => window.speechHarness.accepted.some(id => window.speechHarness.discarded.includes(id))), false)
    await previewAudio.dispose()
    console.log('PASS 原生桥契约：取消试听保持项目，关闭或换声音释放音频，重开保留声音与语速，自定义试听仍可用')

    await closeSpeech.click()
    const settingsButton = page.locator('.editor-tools').getByRole('button', { name: '项目设置', exact: true })
    const settingsBounds = await settingsButton.boundingBox(), exportBounds = await page.getByTestId('export-project').boundingBox()
    assert(settingsBounds && exportBounds && settingsBounds.x + settingsBounds.width <= exportBounds.x, '项目设置按钮应位于导出视频左侧')
    await expect(settingsButton.locator('svg')).toHaveCount(1)
    assert.equal((await settingsButton.textContent()).trim(), '', '项目设置入口应仅显示 SVG 图标')
    await settingsButton.click()
    const settingsDialog = page.getByRole('dialog', { name: '项目设置', exact: true })
    await expect(settingsDialog).toBeVisible()
    assert.equal(await settingsDialog.evaluate(element => element.matches(':modal')), true)
    await expect(page.locator('.property-panel').getByLabel('项目帧率')).toHaveCount(0)
    await settingsDialog.getByLabel('项目帧率').selectOption('60')
    await page.screenshot({ animations: 'disabled', path: '/tmp/open-media-speech-editor/project-settings.png' })
    await settingsDialog.getByRole('button', { name: '关闭项目设置', exact: true }).focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await settingsDialog.evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body), true)
    await settingsDialog.getByRole('button', { name: '关闭项目设置', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(settingsDialog).not.toBeVisible()
    await expect(settingsButton).toBeFocused()
    await expect(page.locator('.preview-heading')).toContainText('60 fps')
    await settingsButton.click()
    await expect(settingsDialog.getByLabel('项目帧率')).toHaveValue('60')
    await settingsDialog.getByRole('button', { name: '关闭项目设置', exact: true }).click()
    await speechButton.click()
    console.log('PASS 项目设置使用导出左侧 SVG 按钮打开弹窗，帧率更新、关闭和焦点恢复正常')

    await page.screenshot({ animations: 'disabled', path: '/tmp/open-media-speech-editor/desktop.png' })
    const previousTheme = await page.locator('.app-shell').getAttribute('data-theme')
    await page.locator('.app-shell').evaluate(element => element.setAttribute('data-theme', 'dark'))
    await page.screenshot({ animations: 'disabled', path: '/tmp/open-media-speech-editor/desktop-dark.png' })
    await page.locator('.app-shell').evaluate((element, theme) => element.setAttribute('data-theme', theme || 'light'), previousTheme)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ animations: 'disabled', path: '/tmp/open-media-speech-editor/compact.png' })
    await expect(page.getByTestId('speech-panel')).toBeVisible()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    assert.deepEqual(errors, [])

    await verifyBundledVoiceCatalog(browser, url)

    const web = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await web.goto(url); await web.getByTestId('create-project').click()
    await web.getByRole('button', { name: '文字转语音', exact: true }).click()
    await expect(web.getByTestId('speech-panel')).toContainText('内置模型和多种声音随桌面端提供')
    await expect(web.getByTestId('speech-generate-all')).toHaveCount(0)
    console.log('PASS 网页明确离线语音需要桌面端，未用系统声音冒充内置模型')
    console.log('说明：这些测试验证界面与原生桥合同，语音模型的真实合成由原生运行时测试验证。')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
