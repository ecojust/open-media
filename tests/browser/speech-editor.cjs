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

async function installNativeContract(page) {
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
        if (command === 'get_speech_status') return { ready: true, voices: [{ id: 'english-first', name: '英语女声', language: 'en-US' }, { id: 'voice-1', name: '清朗', language: 'zh-CN' }, { id: 'voice-2', name: '温和', language: 'zh-CN' }] }
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
  }, audioFixture())
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
    await page.getByRole('button', { name: '文字转语音', exact: true }).first().click()
    await expect(page.getByLabel('配音声音')).toHaveValue('voice-1')
    await expect(page.locator('select[aria-label="配音声音"] optgroup[label="中文"] option')).toHaveCount(2)
    await expect(page.locator('select[aria-label="配音声音"] optgroup[label="英语"] option')).toHaveText(['英语女声 · 英语 · 美国'])
    await page.getByTestId('speech-generate-all').click()
    await expect(page.locator('.speech-progress')).toContainText('已完成 0 / 2')
    await expect(page.getByTestId('save-project')).toBeDisabled()
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
    await expect(page.getByTestId('nav-record')).toBeDisabled()
    await expect(page.getByTitle('新建项目', { exact: true })).toBeDisabled()
    assert.equal(await page.locator('.timeline-panel').getAttribute('inert'), '')
    await page.getByRole('button', { name: '取消生成', exact: true }).click()
    await expect(page.locator('.speech-notice')).toContainText('取消')
    await expect(page.getByTestId('save-project')).toBeEnabled()
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(0)
    await expect(page.locator('.asset-card')).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.speechHarness.cancelled.length > 0 && window.speechHarness.discarded.length > 0), true)
    console.log('PASS 原生桥契约：实际工作台批量配音锁定导航/保存/撤销，取消释放并保持时间线')

    await page.evaluate(() => { window.speechHarness.mode = 'completed' })
    await page.getByLabel('配音声音').selectOption('voice-2')
    await page.getByLabel('配音语速').fill('1.25')
    await page.getByTestId('speech-generate-all').click()
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(2)
    await expect(page.locator('.asset-card')).toHaveCount(2)
    await expect(page.locator('.speech-notice')).toContainText('已添加 2 段语音')
    assert.equal(await page.locator('.timeline-clip.text .clip-detail').evaluateAll(elements => elements.every(element => element.textContent.includes('2.5s'))), true)
    assert.equal(await page.evaluate(() => window.speechHarness.accepted.length), 2)
    const requests = await page.evaluate(() => window.speechHarness.calls.filter(call => call.command === 'begin_speech_job').map(call => call.args.request))
    assert.equal(requests.at(-1).voiceId, 'voice-2'); assert.equal(requests.at(-1).speed, 1.25)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(0); await expect(page.locator('.asset-card')).toHaveCount(0)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(2)
    assert.equal(await page.evaluate(() => window.speechHarness.accepted.some(id => window.speechHarness.discarded.includes(id))), false)
    console.log('PASS 原生桥契约：全部配音原子加入音轨/素材、时长对齐、保留撤销/重做资源')

    await page.locator('.timeline-clip.text').first().click({ button: 'right' })
    await expect(page.getByRole('menu', { name: '文字片段操作' })).toBeVisible()
    await page.getByRole('menuitem', { name: '文字转语音', exact: true }).click()
    await expect(page.locator('.speech-notice')).toContainText('已添加 1 段语音')
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(2)
    await expect(page.locator('.asset-card')).toHaveCount(3)
    console.log('PASS 原生桥契约：单个文字右键生成替换关联音轨，不重复叠加')

    await page.locator('.voice-preview > summary').click()
    await page.getByRole('button', { name: '生成试听', exact: true }).click()
    await expect(page.getByLabel('生成的试听音频')).toHaveJSProperty('readyState', 4)
    assert.equal(await page.getByLabel('生成的试听音频').evaluate(audio => audio.duration), 2.5)
    await expect(page.locator('.asset-card')).toHaveCount(3)
    await page.getByLabel('配音声音').selectOption('voice-1')
    await expect(page.getByLabel('生成的试听音频')).toHaveCount(0)
    console.log('PASS 原生桥契约：试听播放真实WAV夹具且不入项目，换声音释放试听')

    fs.mkdirSync('/tmp/open-media-speech-editor', { recursive: true })
    await page.screenshot({ path: '/tmp/open-media-speech-editor/desktop.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '/tmp/open-media-speech-editor/compact.png' })
    await expect(page.getByTestId('speech-panel')).toBeVisible()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    assert.deepEqual(errors, [])

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
