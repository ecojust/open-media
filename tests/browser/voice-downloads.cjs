const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function installNativeContract(page) {
  await page.addInitScript(() => {
    const packs = [
      { id: 'zipvoice_zh_female', modelId: 'zipvoice-distill-fp32', name: 'ZipVoice Distill FP32', modelSize: 531957872, language: 'zh-CN', gender: 'female', license: 'CC-BY-NC', usageNote: '模型限非商业用途' },
      { id: 'f5_zh_female', modelId: 'f5-v1-base-fp32', name: 'F5-TTS v1 Base FP32', modelSize: 1402816013, runtimeSize: 780000000, language: 'zh-CN', gender: 'female', license: 'CC-BY-NC-4.0', usageNote: '模型限非商业用途' },
      { id: 'qwen3_serena', modelId: 'qwen3-tts-1.7b-serena', name: 'Qwen3-TTS 1.7B BF16 · Serena', modelSize: 4520159586, runtimeSize: 780000000, language: 'zh-CN', gender: 'female', license: 'Apache-2.0', usageNote: '中文男声与女声；CPU离线合成，建议至少16GB' },
    ].flatMap((voice, index) => [voice, { ...voice, id: ['zipvoice_zh_male', 'f5_zh_male', 'qwen3_uncle_fu'][index], name: `${voice.name.replace(' · Serena', '')} · 男声`, gender: 'male' }])
    const state = window.voiceDownloadHarness = { calls: [], deferDownloadDispatch: false, releaseDownloadDispatch: null, deferDownload: false, releaseDownload: null, bundledReady: true, sharedRuntimeReady: false, models: Object.fromEntries(packs.map(voice => [voice.modelId, { status: 'not-downloaded', downloadedBytes: 0, error: '' }])) }
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
        if (command === 'begin_speech_model_download' && state.deferDownloadDispatch) await new Promise(resolve => { state.releaseDownloadDispatch = resolve })
        state.calls.push({ command, args })
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'get_media_jobs') return []
        if (command === 'plugin:event|listen') return 1
        if (command === 'plugin:event|unlisten') return null
        if (command === 'get_speech_status') return catalog()
        if (command === 'begin_speech_model_download') {
          const model = state.models[args.modelId]
          if (!model) throw new Error('未知模型')
          if (state.deferDownload) await new Promise(resolve => { state.releaseDownload = resolve })
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
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**'] }, hmr: false }, logLevel: 'error' })
  await server.listen()
  let browser, page
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
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
    const zipMale = dialog.locator('[data-voice-id="zipvoice_zh_male"]')
    const f5Male = dialog.locator('[data-voice-id="f5_zh_male"]')
    const qwenMale = dialog.locator('[data-voice-id="qwen3_uncle_fu"]')
    await expect(dialog.getByRole('button', { name: '选择 Matcha 中英', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.locator('[data-voice-id="matcha_zh_en_female"] .voice-model-size')).toHaveText('已内置 · 149.2 MB')
    await expect(dialog.getByRole('tab')).toHaveCount(0)
    await expect(dialog.locator('.voice-card')).toHaveCount(7)
    const rows = await dialog.locator('.voice-card').evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().top)))
    assert.equal(new Set(rows).size, 2, '七个声音在同一列表内排列为四列两行')
    const search = dialog.getByLabel('搜索声音', { exact: true })
    await search.fill('英语')
    await expect(dialog.locator('.voice-card')).toHaveCount(1)
    await search.fill('男声')
    await expect(dialog.locator('.voice-card')).toHaveCount(3)
    await search.fill('Serena')
    await expect(dialog.locator('.voice-card')).toHaveCount(1)
    await search.fill('')
    await expect(dialog.locator('.voice-card')).toHaveCount(7)
    await expect(zip.getByRole('button', { name: '选择 ZipVoice Distill FP32', exact: true })).toBeDisabled()
    await expect(zip.locator('.voice-model-size')).toHaveText('模型 · 532 MB')
    await expect(f5.locator('.voice-model-size')).toHaveText('模型 · 1.4 GB')
    await expect(f5.locator('.voice-runtime-size')).toHaveText('运行组件 · 780 MB · 待下载')
    await expect(f5.getByRole('button', { name: '下载 F5-TTS v1 Base FP32', exact: true })).toContainText('2.18 GB')
    await expect(qwen.locator('.voice-model-size')).toHaveText('模型 · 4.52 GB')
    await expect(zip.locator('.voice-model-license')).toHaveText('模型限非商业用途')
    await expect(f5.locator('.voice-model-license')).toHaveText('模型限非商业用途')
    await expect(qwen.locator('.voice-model-license')).toHaveText('Apache-2.0')
    await expect(qwenMale.locator('.voice-model-license')).toHaveText('Apache-2.0')
    await expect(dialog.getByText('中文男声与女声；CPU离线合成，建议至少16GB', { exact: true })).toHaveCount(0)
    await expect(dialog.locator('.voice-card-copy > strong')).toHaveText(['Matcha 中英', 'ZipVoice Distill FP32', 'ZipVoice Distill FP32', 'F5-TTS v1 Base FP32', 'F5-TTS v1 Base FP32', 'Qwen3-TTS 1.7B BF16', 'Qwen3-TTS 1.7B BF16'])
    await expect(dialog.locator('.voice-hardware')).toHaveCount(7)
    await expect(dialog.locator('.voice-model-shared')).toHaveCount(6)
    for (const [female, male, model] of [[zip, zipMale, 'ZipVoice Distill FP32'], [f5, f5Male, 'F5-TTS v1 Base FP32'], [qwen, qwenMale, 'Qwen3-TTS 1.7B BF16']]) {
      await expect(male.locator('.voice-card-copy > span')).toHaveText('中文 · 男声')
      await expect(male.locator('.voice-model-shared')).toHaveText('共用模型 · 下载一次即可')
      await expect(male.locator('.voice-model-size')).toHaveText(await female.locator('.voice-model-size').innerText())
      await expect(male.getByRole('button', { name: `下载 ${model} · 男声`, exact: true })).toHaveText(await female.getByRole('button', { name: `下载 ${model}`, exact: true }).textContent())
    }
    for (const [id, memoryGb, gpuAuto] of [['matcha_zh_en_female', 4, false], ['zipvoice_zh_female', 8, false], ['zipvoice_zh_male', 8, false], ['f5_zh_female', 8, true], ['f5_zh_male', 8, true], ['qwen3_serena', 16, true], ['qwen3_uncle_fu', 16, true]]) {
      const hardware = dialog.locator(`[data-voice-id="${id}"] .voice-hardware`)
      await expect(hardware).toContainText(`建议系统内存 ${memoryGb} GB`)
      await expect(hardware).toContainText(gpuAuto ? '优先可用 GPU · CPU 自动回退' : '优先 CoreML · CPU 自动回退')
    }
    await expect(dialog.locator('.voice-hardware-note')).toHaveText('macOS 自动检测硬件加速，Windows 当前使用 CPU。实际设备见生成进度；内存为整机建议。')
    await expect(dialog.locator('.voice-download-sources, .voice-current-source, .voice-download-help')).toHaveCount(0)
    for (const button of await dialog.locator('.voice-download-button').all()) {
      await button.scrollIntoViewIfNeeded()
      await expect(button).toBeInViewport({ ratio: 1 })
    }
    await dialog.locator('.voice-grid-scroll').evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: '/tmp/open-media-voice-downloads-available.png', animations: 'disabled' })
    for (const [card, name, id] of [
      [zip, 'ZipVoice Distill FP32', 'zipvoice_zh_female'],
      [zipMale, 'ZipVoice Distill FP32 · 男声', 'zipvoice_zh_male'],
      [f5, 'F5-TTS v1 Base FP32', 'f5_zh_female'],
      [f5Male, 'F5-TTS v1 Base FP32 · 男声', 'f5_zh_male'],
      [qwen, 'Qwen3-TTS 1.7B BF16', 'qwen3_serena'],
      [qwenMale, 'Qwen3-TTS 1.7B BF16 · 男声', 'qwen3_uncle_fu'],
    ]) {
      await card.getByRole('button', { name: `试听 ${name}`, exact: true }).click()
      const audio = dialog.getByLabel('声音试听音频')
      await expect(audio).toHaveJSProperty('paused', false)
      await expect(audio).toHaveJSProperty('readyState', 4)
      assert.match(await audio.getAttribute('src'), new RegExp(`${id}\\.mp3`))
      assert.ok(await audio.evaluate(element => element.duration > 1 && element.duration < 20), '真实原句MP3应成功解码并具有有效时长')
    }
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.some(call => /begin_speech/.test(call.command))), false, '试听本地音频不能自动下载或合成')
    console.log('PASS 三种模型的男女声原句MP3均可本地播放，试听不下载或合成')

    await page.evaluate(() => { window.voiceDownloadHarness.deferDownloadDispatch = true; window.voiceDownloadHarness.deferDownload = true })
    await f5Male.getByRole('button', { name: '下载 F5-TTS v1 Base FP32 · 男声', exact: true }).click()
    await expect(f5.getByRole('button', { name: '下载 F5-TTS v1 Base FP32', exact: true })).toBeDisabled()
    await expect(f5Male.getByRole('button', { name: '下载 F5-TTS v1 Base FP32 · 男声', exact: true })).toBeDisabled()
    await expect.poll(() => page.evaluate(() => typeof window.voiceDownloadHarness.releaseDownloadDispatch), { message: '等待请求进入受控原生桥，禁用按钮不能代表异步调用已经抵达' }).toBe('function')
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.filter(call => call.command === 'begin_speech_model_download').length), 0, '请求尚未送达时，男女声按钮也应立即共同禁用')
    await page.evaluate(() => { window.voiceDownloadHarness.deferDownloadDispatch = false; window.voiceDownloadHarness.releaseDownloadDispatch() })
    await expect.poll(() => page.evaluate(() => ({
      count: window.voiceDownloadHarness.calls.filter(call => call.command === 'begin_speech_model_download').length,
      ready: typeof window.voiceDownloadHarness.releaseDownload === 'function',
    })), { message: '等待唯一共享下载请求完成派发，且响应测试门闩已就绪' }).toEqual({ count: 1, ready: true })
    await page.evaluate(() => { window.voiceDownloadHarness.deferDownload = false; window.voiceDownloadHarness.releaseDownload() })
    await expect(f5.getByRole('progressbar')).toHaveAttribute('value', '0')
    await expect(f5Male.getByRole('progressbar')).toHaveAttribute('value', '0')
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.filter(call => call.command === 'begin_speech_model_download').length), 1, '男声与女声只能启动一次共享模型下载')
    await expect(close).toBeEnabled()
    await expect(page.getByTestId('save-project')).toBeEnabled()
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    await page.evaluate(() => { window.voiceDownloadHarness.models['f5-v1-base-fp32'].downloadedBytes = 1091408007 })
    await expect(f5.getByRole('progressbar')).toHaveAttribute('value', '50')
    await expect(f5Male.getByRole('progressbar')).toHaveAttribute('value', '50')
    await page.evaluate(() => { window.voiceDownloadHarness.models['f5-v1-base-fp32'].downloadSource = 'https://hf-mirror.com' })
    await expect(f5.locator('.voice-current-source')).toHaveCount(0)
    await expect(f5.getByRole('progressbar')).toHaveAttribute('value', '50')
    await expect(f5Male.getByRole('progressbar')).toHaveAttribute('value', '50')
    await expect(zip.getByRole('progressbar')).toHaveCount(0)
    await f5.getByRole('button', { name: '取消下载 F5-TTS v1 Base FP32', exact: true }).click()
    await expect(f5.getByRole('button', { name: '下载 F5-TTS v1 Base FP32', exact: true })).toBeEnabled()
    await expect(f5Male.getByRole('button', { name: '下载 F5-TTS v1 Base FP32 · 男声', exact: true })).toBeEnabled()
    await f5.getByRole('button', { name: '下载 F5-TTS v1 Base FP32', exact: true }).click()
    await expect(f5.getByRole('progressbar')).toBeVisible()
    await page.evaluate(() => Object.assign(window.voiceDownloadHarness.models['f5-v1-base-fp32'], { status: 'failed', error: '连接中断，请重试。' }))
    await expect(f5.locator('.voice-model-error')).toHaveText('连接中断，请重试。')
    await expect(f5Male.locator('.voice-model-error')).toHaveText('连接中断，请重试。')
    await f5Male.getByRole('button', { name: '重试下载 F5-TTS v1 Base FP32 · 男声', exact: true }).click()
    await expect(f5.getByRole('progressbar')).toBeVisible()
    await page.evaluate(() => Object.assign(window.voiceDownloadHarness.models['f5-v1-base-fp32'], { status: 'verifying', runtimeStatus: 'verifying', downloadedBytes: 2182816013 }))
    await expect(f5.locator('.voice-model-state')).toHaveText('正在校验模型与运行组件…')
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toBeDisabled()
    await page.evaluate(() => { window.voiceDownloadHarness.models['f5-v1-base-fp32'].status = 'ready' })
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toBeDisabled()
    await expect(f5.locator('.voice-runtime-size')).toContainText('校验中')
    console.log('PASS 男女声共享模型下载、待处理、进度、取消和重试；运行组件未校验时仍不可用')

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
    await expect(dialog.getByRole('button', { name: '选择 Matcha 中英', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(f5.locator('.voice-model-size')).toHaveText('已下载 · 1.4 GB')
    await expect(f5Male.locator('.voice-model-size')).toHaveText('已下载 · 1.4 GB')
    await expect(f5Male.getByRole('button', { name: '下载 F5-TTS v1 Base FP32 · 男声', exact: true })).toHaveCount(0)
    await f5Male.getByRole('button', { name: '选择 F5-TTS v1 Base FP32 · 男声', exact: true }).click()
    await expect(f5Male.getByRole('button', { name: '选择 F5-TTS v1 Base FP32 · 男声', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.locator('.voice-current')).toContainText('F5-TTS v1 Base FP32 · 男声')
    await f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true }).click()
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByTestId('speech-generate-all')).toBeEnabled()
    await expect(qwen.locator('.voice-runtime-size')).toHaveText('运行组件 · 780 MB · 已就绪')
    await expect(qwen.getByRole('button', { name: '下载 Qwen3-TTS 1.7B BF16', exact: true })).toContainText('4.52 GB')
    await expect(qwen.getByRole('button', { name: '选择 Qwen3-TTS 1.7B BF16', exact: true })).toBeDisabled()
    console.log('PASS 重开保持原选择，共享运行组件不重复计入下一模型下载量')

    await close.click()
    await page.evaluate(() => Object.assign(window.voiceDownloadHarness.models['qwen3-tts-1.7b-serena'], { status: 'unsupported', runtimeStatus: 'unsupported', runtimeError: '当前平台尚无已验证运行组件' }))
    await open.click()
    await expect(qwen.locator('.voice-model-error')).toHaveText('当前平台尚无已验证运行组件')
    await expect(qwen.getByRole('button', { name: '下载 Qwen3-TTS 1.7B BF16', exact: true })).toHaveCount(0)
    await expect(qwen.getByRole('button', { name: '选择 Qwen3-TTS 1.7B BF16', exact: true })).toBeDisabled()
    await expect(qwen.getByRole('button', { name: '试听 Qwen3-TTS 1.7B BF16', exact: true })).toBeEnabled()
    await page.screenshot({ path: '/tmp/open-media-voice-downloads.png', animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(dialog).toBeVisible()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await expect(dialog.locator('.voice-card')).toHaveCount(7)
    const narrowRows = await dialog.locator('.voice-card').evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().top)))
    assert.equal(new Set(narrowRows).size, 4, '窄屏中七个声音自动排列为四行')
    assert.equal(await dialog.locator('.voice-grid-scroll').evaluate(element => element.scrollWidth <= element.clientWidth), true, '声音网格不得横向溢出')
    await qwenMale.scrollIntoViewIfNeeded()
    await expect(qwenMale.getByRole('button', { name: '试听 Qwen3-TTS 1.7B BF16 · 男声', exact: true })).toBeInViewport()
    await page.screenshot({ path: '/tmp/open-media-voice-downloads-narrow.png', animations: 'disabled' })
    console.log('PASS 不支持平台仅允许试听，七卡无Tab，长模型名与窄屏滚动布局正常')

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
    await expect(dialog.getByRole('button', { name: '选择 Matcha 中英', exact: true })).toBeDisabled()
    assert.deepEqual(errors, [])
    console.log('PASS 内置模型损坏时仍可试听与下载独立模型，未就绪禁止生成，下载验证后正常解锁')
  } catch (error) {
    await page?.screenshot({ path: '/tmp/open-media-voice-downloads-failure.png', animations: 'disabled' }).catch(() => {})
    throw error
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
