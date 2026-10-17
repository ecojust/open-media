const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function installNativeContract(page) {
  await page.addInitScript(() => {
    const packs = [
      { id: 'zipvoice_zh_female', modelId: 'zipvoice-distill-fp32', name: 'ZipVoice Distill FP32', modelSize: 531957872, language: 'zh-CN', gender: 'female', license: 'CC-BY-NC', usageNote: '模型限非商业用途' },
      { id: 'f5_zh_female', modelId: 'f5-v1-base-fp32', name: 'F5-TTS v1 Base FP32', modelSize: 1402816013, runtimeSize: 780000000, language: 'zh-CN', gender: 'female', license: 'CC-BY-NC-4.0', usageNote: '模型限非商业用途' },
      { id: 'qwen3_serena', modelId: 'qwen3-tts-1.7b-serena', name: 'Qwen3-TTS 1.7B BF16 · Serena', modelSize: 4520159586, runtimeSize: 780000000, language: 'zh-CN', gender: 'female', license: 'Apache-2.0' },
    ]
    const state = window.voiceDownloadHarness = { calls: [], bundledReady: true, sharedRuntimeReady: false, models: Object.fromEntries(packs.map(voice => [voice.modelId, { status: 'not-downloaded', downloadedBytes: 0, error: '' }])) }
    const catalog = () => ({ ready: state.bundledReady || Object.entries(state.models).some(([id, model]) => model.status === 'ready' && (id === 'zipvoice-distill-fp32' || state.sharedRuntimeReady || model.runtimeStatus === 'ready')), error: state.bundledReady ? undefined : '内置模型完整性校验失败', voices: [
      { id: 'matcha_zh_en_female', name: '温柔女声（中英）', language: 'zh-CN', gender: 'female', status: state.bundledReady ? 'bundled' : 'failed', modelSize: 149227292 },
      ...packs.map(voice => {
        const model = state.models[voice.modelId]
        const runtimeStatus = voice.runtimeSize ? model.runtimeStatus || (state.sharedRuntimeReady ? 'ready' : 'not-downloaded') : undefined
        return { ...voice, downloadSize: voice.modelSize + (voice.runtimeSize || 0), downloadSources: ['https://huggingface.co', 'https://hf-mirror.com'], ...model, runtimeStatus }
      }),
    ] })
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command, args) => {
        state.calls.push({ command, args })
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'get_media_jobs') return []
        if (command === 'plugin:event|listen') return 1
        if (command === 'plugin:event|unlisten') return null
        if (command === 'get_speech_status') return catalog()
        if (command === 'begin_speech_model_download') {
          const model = state.models[args.modelId]
          if (!model) throw new Error('未知模型')
          Object.assign(model, { status: 'downloading', downloadedBytes: 0, error: '', downloadSource: 'https://huggingface.co' })
          return catalog()
        }
        if (command === 'cancel_speech_model_download') {
          Object.assign(state.models[args.modelId], { status: 'not-downloaded', downloadedBytes: 0, runtimeStatus: undefined })
          return catalog()
        }
        throw new Error(`未预期的原生命令：${command}`)
      },
    }
  })
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false }, logLevel: 'error' })
  await server.listen()
  let browser, page
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    page.setDefaultTimeout(15000)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await installNativeContract(page)
    await page.goto(server.resolvedUrls.local[0])
    await page.getByTestId('create-project').click()
    await page.getByRole('button', { name: '字幕', exact: true }).click()
    const open = page.locator('.editor-tools').getByRole('button', { name: '文字转语音', exact: true })
    await open.click()
    const dialog = page.getByRole('dialog', { name: '文字转语音', exact: true })
    const close = dialog.getByRole('button', { name: '关闭文字转语音', exact: true })
    const zip = dialog.locator('[data-voice-id="zipvoice_zh_female"]')
    const f5 = dialog.locator('[data-voice-id="f5_zh_female"]')
    const qwen = dialog.locator('[data-voice-id="qwen3_serena"]')
    await expect(dialog.getByRole('button', { name: '选择 温柔女声（中英）', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.locator('[data-voice-id="matcha_zh_en_female"] .voice-model-size')).toHaveText('已内置 · 149.2 MB')
    await expect(dialog.getByRole('tab')).toHaveCount(0)
    await expect(dialog.locator('.voice-card')).toHaveCount(4)
    for (const card of await dialog.locator('.voice-card').all()) await expect(card).toBeInViewport()
    const rows = await dialog.locator('.voice-card').evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().top)))
    assert.equal(new Set(rows).size, 1, '四个声音在宽屏弹窗中并排显示')
    const search = dialog.getByLabel('搜索声音', { exact: true })
    await search.fill('英语')
    await expect(dialog.locator('.voice-card')).toHaveCount(1)
    await search.fill('Serena')
    await expect(dialog.locator('.voice-card')).toHaveCount(1)
    await search.fill('')
    await expect(dialog.locator('.voice-card')).toHaveCount(4)
    await expect(zip.getByRole('button', { name: '选择 ZipVoice Distill FP32', exact: true })).toBeDisabled()
    await expect(zip.locator('.voice-model-size')).toHaveText('模型 · 532 MB')
    await expect(f5.locator('.voice-model-size')).toHaveText('模型 · 1.4 GB')
    await expect(f5.locator('.voice-runtime-size')).toHaveText('运行组件 · 780 MB · 待下载')
    await expect(f5.getByRole('button', { name: '下载 F5-TTS v1 Base FP32', exact: true })).toContainText('2.18 GB')
    await expect(qwen.locator('.voice-model-size')).toHaveText('模型 · 4.52 GB')
    await expect(zip.locator('.voice-model-license')).toHaveText('模型限非商业用途')
    await expect(f5.locator('.voice-model-license')).toHaveText('模型限非商业用途')
    await expect(dialog.locator('.voice-download-help')).toContainText('下载失败自动切换备用来源；所有来源均校验同一文件')
    await f5.locator('.voice-download-sources summary').click()
    await expect(f5.getByRole('link', { name: 'hf-mirror.com', exact: true })).toHaveAttribute('href', 'https://hf-mirror.com')
    await f5.getByRole('button', { name: '复制下载来源 https://hf-mirror.com', exact: true }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://hf-mirror.com')
    await expect(f5.getByRole('button', { name: '复制下载来源 https://hf-mirror.com', exact: true })).toHaveAttribute('title', '已复制')
    await f5.locator('.voice-download-sources summary').click()
    await page.screenshot({ path: '/tmp/open-media-voice-downloads-available.png', animations: 'disabled' })
    for (const [card, name, id] of [[zip, 'ZipVoice Distill FP32', 'zipvoice_zh_female'], [f5, 'F5-TTS v1 Base FP32', 'f5_zh_female'], [qwen, 'Qwen3-TTS 1.7B BF16 · Serena', 'qwen3_serena']]) {
      await card.getByRole('button', { name: `试听 ${name}`, exact: true }).click()
      const audio = dialog.getByLabel('声音试听音频')
      await expect(audio).toHaveJSProperty('paused', false)
      await expect(audio).toHaveJSProperty('readyState', 4)
      assert.match(await audio.getAttribute('src'), new RegExp(`${id}\\.mp3`))
      assert.ok(await audio.evaluate(element => element.duration > 3 && element.duration < 4), '实际MP3解码应得到原句时长')
    }
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.some(call => /begin_speech/.test(call.command))), false, '试听本地音频不能自动下载或合成')
    console.log('PASS 三种模型显示独立体积与许可，真实原句MP3本地播放，试听不下载或合成')

    await f5.getByRole('button', { name: '下载 F5-TTS v1 Base FP32', exact: true }).click()
    await expect(f5.getByRole('progressbar')).toHaveAttribute('value', '0')
    await expect(close).toBeEnabled()
    await expect(page.getByTestId('save-project')).toBeEnabled()
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    await page.evaluate(() => { window.voiceDownloadHarness.models['f5-v1-base-fp32'].downloadedBytes = 1091408007 })
    await expect(f5.getByRole('progressbar')).toHaveAttribute('value', '50')
    await expect(f5.locator('.voice-current-source')).toHaveText('来源：huggingface.co')
    await page.evaluate(() => { window.voiceDownloadHarness.models['f5-v1-base-fp32'].downloadSource = 'https://hf-mirror.com' })
    await expect(f5.locator('.voice-current-source')).toHaveText('来源：hf-mirror.com')
    await expect(zip.getByRole('progressbar')).toHaveCount(0)
    await f5.getByRole('button', { name: '取消下载 F5-TTS v1 Base FP32', exact: true }).click()
    await expect(f5.getByRole('button', { name: '下载 F5-TTS v1 Base FP32', exact: true })).toBeEnabled()
    await f5.getByRole('button', { name: '下载 F5-TTS v1 Base FP32', exact: true }).click()
    await expect(f5.getByRole('progressbar')).toBeVisible()
    await page.evaluate(() => Object.assign(window.voiceDownloadHarness.models['f5-v1-base-fp32'], { status: 'failed', error: '连接中断，请重试。' }))
    await expect(f5.locator('.voice-model-error')).toHaveText('连接中断，请重试。')
    await f5.getByRole('button', { name: '重试下载 F5-TTS v1 Base FP32', exact: true }).click()
    await expect(f5.getByRole('progressbar')).toBeVisible()
    await page.evaluate(() => Object.assign(window.voiceDownloadHarness.models['f5-v1-base-fp32'], { status: 'verifying', runtimeStatus: 'verifying', downloadedBytes: 2182816013 }))
    await expect(f5.locator('.voice-model-state')).toHaveText('正在校验模型与运行组件…')
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toBeDisabled()
    await page.evaluate(() => { window.voiceDownloadHarness.models['f5-v1-base-fp32'].status = 'ready' })
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toBeDisabled()
    await expect(f5.locator('.voice-runtime-size')).toContainText('校验中')
    console.log('PASS 分模型下载进度、取消和重试；模型文件已下载但运行组件未校验时仍不可用')

    await close.click()
    await expect(dialog).not.toBeVisible()
    const calls = await page.evaluate(() => window.voiceDownloadHarness.calls)
    const cancellations = calls.filter(call => call.command === 'cancel_speech_model_download').length
    const reads = calls.filter(call => call.command === 'get_speech_status').length
    await page.waitForTimeout(1200)
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.filter(call => call.command === 'get_speech_status').length), reads, '关闭停止界面轮询')
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.filter(call => call.command === 'cancel_speech_model_download').length), cancellations, '关闭不取消后台下载')
    await page.evaluate(() => {
      window.voiceDownloadHarness.sharedRuntimeReady = true
      Object.assign(window.voiceDownloadHarness.models['f5-v1-base-fp32'], { status: 'ready', runtimeStatus: 'ready', error: '' })
    })
    await open.click()
    await expect(dialog.getByRole('button', { name: '选择 温柔女声（中英）', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(f5.locator('.voice-model-size')).toHaveText('已下载 · 1.4 GB')
    await f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true }).click()
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByTestId('speech-generate-all')).toBeEnabled()
    await expect(qwen.locator('.voice-runtime-size')).toHaveText('运行组件 · 780 MB · 已就绪')
    await expect(qwen.getByRole('button', { name: '下载 Qwen3-TTS 1.7B BF16 · Serena', exact: true })).toContainText('4.52 GB')
    await expect(qwen.getByRole('button', { name: '选择 Qwen3-TTS 1.7B BF16 · Serena', exact: true })).toBeDisabled()
    console.log('PASS 重开保持原选择，共享运行组件不重复计入下一模型下载量')

    await close.click()
    await page.evaluate(() => Object.assign(window.voiceDownloadHarness.models['qwen3-tts-1.7b-serena'], { status: 'unsupported', runtimeStatus: 'unsupported', runtimeError: '当前平台尚无已验证运行组件' }))
    await open.click()
    await expect(qwen.locator('.voice-model-error')).toHaveText('当前平台尚无已验证运行组件')
    await expect(qwen.getByRole('button', { name: '下载 Qwen3-TTS 1.7B BF16 · Serena', exact: true })).toHaveCount(0)
    await expect(qwen.getByRole('button', { name: '选择 Qwen3-TTS 1.7B BF16 · Serena', exact: true })).toBeDisabled()
    await expect(qwen.getByRole('button', { name: '试听 Qwen3-TTS 1.7B BF16 · Serena', exact: true })).toBeEnabled()
    await page.screenshot({ path: '/tmp/open-media-voice-downloads.png', animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(dialog).toBeVisible()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await expect(dialog.locator('.voice-card')).toHaveCount(4)
    const narrowRows = await dialog.locator('.voice-card').evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().top)))
    assert.equal(new Set(narrowRows).size, 2, '窄屏中四个声音自动排列为两行')
    assert.equal(await dialog.locator('.voice-grid-scroll').evaluate(element => element.scrollWidth <= element.clientWidth), true, '声音网格不得横向溢出')
    await qwen.scrollIntoViewIfNeeded()
    await expect(qwen.getByRole('button', { name: '试听 Qwen3-TTS 1.7B BF16 · Serena', exact: true })).toBeInViewport()
    console.log('PASS 不支持平台仅允许试听，四卡无Tab，长模型名与窄屏布局正常')

    await close.click()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => {
      const state = window.voiceDownloadHarness
      state.bundledReady = false; state.sharedRuntimeReady = false
      for (const model of Object.values(state.models)) Object.assign(model, { status: 'not-downloaded', runtimeStatus: undefined, downloadedBytes: 0, error: '', runtimeError: undefined })
    })
    await open.click()
    await expect(dialog.getByRole('alert').filter({ hasText: '内置模型完整性校验失败' })).toBeVisible()
    await expect(dialog.getByTestId('speech-generate-all')).toBeDisabled()
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toBeDisabled()
    await expect(f5.getByRole('button', { name: '下载 F5-TTS v1 Base FP32', exact: true })).toBeEnabled()
    await f5.getByRole('button', { name: '试听 F5-TTS v1 Base FP32', exact: true }).click()
    await expect(dialog.getByLabel('声音试听音频')).toHaveJSProperty('paused', false)
    await f5.getByRole('button', { name: '下载 F5-TTS v1 Base FP32', exact: true }).click()
    await expect(f5.getByRole('progressbar')).toBeVisible()
    await expect(dialog.getByTestId('speech-generate-all')).toBeDisabled()
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.filter(call => call.command === 'begin_speech_job').length), 0)
    await page.evaluate(() => {
      window.voiceDownloadHarness.sharedRuntimeReady = true
      Object.assign(window.voiceDownloadHarness.models['f5-v1-base-fp32'], { status: 'ready', runtimeStatus: 'ready', error: '' })
    })
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toBeEnabled()
    await expect(dialog.getByTestId('speech-generate-all')).toBeEnabled()
    await expect(dialog.getByRole('button', { name: '选择 温柔女声（中英）', exact: true })).toBeDisabled()
    assert.deepEqual(errors, [])
    console.log('PASS 内置模型损坏时仍可试听与下载独立模型，未就绪禁止生成，下载验证后正常解锁')
  } catch (error) {
    await page?.screenshot({ path: '/tmp/open-media-voice-downloads-failure.png', animations: 'disabled' }).catch(() => {})
    throw error
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
