const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')
const { installManagedProjectBridge } = require('./managed-project-bridge.cjs')

// IPC fixtures verify UI routing and shared states; no model download or synthesis is performed.
async function installNativeContract(page) {
  await installManagedProjectBridge(page)
  await page.addInitScript(() => {
    const packs = [
      { id: 'zipvoice_zh_female', modelId: 'zipvoice-distill-fp32', name: 'ZipVoice Distill FP32', modelSize: 531957872, language: 'zh-CN', gender: 'female', license: 'CC-BY-NC' },
      { id: 'f5_zh_female', modelId: 'f5-v1-base-fp32', name: 'F5-TTS v1 Base FP32', modelSize: 1402816013, runtimeSize: 780000000, language: 'zh-CN', gender: 'female', license: 'CC-BY-NC-4.0' },
      { id: 'qwen3_serena', modelId: 'qwen3-tts-1.7b-serena', name: 'Qwen3-TTS 1.7B BF16 · Serena', modelSize: 4520159586, runtimeSize: 780000000, language: 'zh-CN', gender: 'female', license: 'Apache-2.0' },
    ].flatMap((voice, index) => [voice, { ...voice, id: ['zipvoice_zh_male', 'f5_zh_male', 'qwen3_uncle_fu'][index], name: `${voice.name.replace(' · Serena', '')} · 男声`, gender: 'male' }])
    const state = window.voiceDownloadHarness = { calls: [], bundledReady: true, sharedRuntimeReady: false, nativeUpgrade: null, models: Object.fromEntries(packs.map(voice => [voice.modelId, { status: 'not-downloaded', downloadedBytes: 0, error: '' }])) }
    const catalog = () => ({ ready: state.bundledReady || Object.entries(state.models).some(([id, model]) => model.status === 'ready' && (id === 'zipvoice-distill-fp32' || state.sharedRuntimeReady || model.runtimeStatus === 'ready')), error: state.bundledReady ? undefined : '内置模型完整性校验失败', voices: [
      { id: 'matcha_zh_en_female', name: '温柔女声（中英）', language: 'zh-CN', gender: 'female', status: state.bundledReady ? 'bundled' : 'failed', modelSize: 149227292, ...(state.nativeUpgrade || {}) },
      ...packs.map(voice => {
        const model = state.models[voice.modelId]
        const runtimeStatus = voice.runtimeSize ? model.runtimeStatus || (state.sharedRuntimeReady ? 'ready' : 'not-downloaded') : undefined
        return { ...voice, downloadSize: voice.modelSize + (voice.runtimeSize || 0), ...model, runtimeStatus, ...(voice.modelId === 'zipvoice-distill-fp32' && model.status === 'ready' ? state.nativeUpgrade || {} : {}) }
      }),
    ] })
    const globalStatus = () => ({ jobs: [], busy: false, models: packs.filter(voice => voice.gender === 'female').map(voice => {
      const model = state.models[voice.modelId]
      return { id: `speech:${voice.modelId}`, name: voice.name.replace(' · Serena', ''), provider: 'speech', capabilities: ['text-to-speech'], version: 'fixture', size: voice.modelSize, downloadedBytes: model.downloadedBytes, state: model.status, hardware: '优先可用 GPU，建议 16 GB 内存', runtime: { state: model.runtimeStatus || (state.sharedRuntimeReady ? 'ready' : 'not-downloaded') }, bundled: false, requiresLicenseAcceptance: true, license: voice.license, licenseUrl: 'https://example.com/license', error: model.error, voices: packs.filter(item => item.modelId === voice.modelId) }
    }) })
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command, args, options) => {
        state.calls.push({ command, args })
        const managed = await window.managedProjectCommand(command, args, options)
        if (managed.handled) return managed.value
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'get_media_jobs' || command === 'mcp_pending') return []
        if (command === 'mcp_get_status') return { running: false, connectedClients: 0, pendingRequests: 0 }
        if (command === 'get_desktop_platform') return 'macos'
        if (command === 'configure_screenshot_shortcut') return args.shortcut
        if (command === 'ai_get_status') return globalStatus()
        if (command === 'list_stored_videos') return { directory: '/fixture/recordings', assets: [], warnings: [] }
        if (command === 'plugin:event|listen') return 1
        if (command === 'plugin:event|unlisten') return null
        if (command === 'get_speech_status') return catalog()
        if (command === 'ai_model_download' || command === 'ai_model_repair') {
          if (!args.acceptedLicense) throw new Error('许可未确认')
          const model = state.models[args.modelId.replace(/^speech:/, '')]
          if (!model) throw new Error('未知模型')
          Object.assign(model, { status: command === 'ai_model_repair' ? 'verifying' : 'downloading', downloadedBytes: 0, error: '' })
          return globalStatus()
        }
        if (command === 'ai_model_cancel') {
          Object.assign(state.models[args.modelId.replace(/^speech:/, '')], { status: 'not-downloaded', downloadedBytes: 0, runtimeStatus: undefined })
          return globalStatus()
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
    const dialog = page.getByRole('dialog', { name: '文字转语音', exact: true })
    const close = dialog.getByRole('button', { name: '关闭文字转语音', exact: true })
    const f5 = dialog.locator('[data-voice-id="f5_zh_female"]'), f5Male = dialog.locator('[data-voice-id="f5_zh_male"]')
    const info = page.getByRole('dialog', { name: '关于 Open Media', exact: true })
    const infoF5 = info.locator('[data-ai-model="speech:f5-v1-base-fp32"]')
    const closeInfo = () => info.getByRole('button', { name: '关闭关于 Open Media', exact: true }).click()
    const confirm = async (repair = false) => {
      const modal = page.getByRole('dialog', { name: repair ? '修复模型' : '下载模型', exact: true })
      await expect(modal.getByRole('button', { name: repair ? '检查并修复' : '开始下载', exact: true })).toBeDisabled()
      await modal.getByRole('checkbox').check()
      await modal.getByRole('button', { name: repair ? '检查并修复' : '开始下载', exact: true }).click()
      await expect(modal).not.toBeVisible()
    }
    await open.click()
    await expect(dialog.getByRole('button', { name: '选择 Matcha 中英', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.locator('.voice-card')).toHaveCount(7)
    await expect(dialog.getByRole('tab')).toHaveCount(0)
    await expect(dialog.locator('.voice-hardware,.voice-model-license,.voice-download-button,.voice-repair-button')).toHaveCount(0)
    const search = dialog.getByLabel('搜索声音', { exact: true })
    await search.fill('英语'); await expect(dialog.locator('.voice-card')).toHaveCount(1)
    await search.fill('男声'); await expect(dialog.locator('.voice-card')).toHaveCount(3)
    await search.fill(''); await expect(dialog.locator('.voice-card')).toHaveCount(7)
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toBeDisabled()
    await expect(f5).toContainText('依靠 F5-TTS v1 Base FP32 模型')
    for (const [id, name] of [
      ['zipvoice_zh_female', 'ZipVoice Distill FP32'], ['zipvoice_zh_male', 'ZipVoice Distill FP32 · 男声'],
      ['f5_zh_female', 'F5-TTS v1 Base FP32'], ['f5_zh_male', 'F5-TTS v1 Base FP32 · 男声'],
      ['qwen3_serena', 'Qwen3-TTS 1.7B BF16'], ['qwen3_uncle_fu', 'Qwen3-TTS 1.7B BF16 · 男声'],
    ]) {
      await dialog.locator(`[data-voice-id="${id}"]`).getByRole('button', { name: `试听 ${name}`, exact: true }).click()
      const audio = dialog.getByLabel('声音试听音频')
      await expect(audio).toHaveJSProperty('paused', false); await expect(audio).toHaveJSProperty('readyState', 4)
      assert.match(await audio.getAttribute('src'), new RegExp(`${id}\\.mp3`))
      assert.ok(await audio.evaluate(element => element.duration > 1 && element.duration < 20))
    }
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.some(call => /begin_speech|ai_model_(download|repair)/.test(call.command))), false, '原句MP3试听不触发下载或合成')
    console.log('PASS 七张声音卡同页选择、搜索，男女声音频无需下载即可本地试听')

    await f5Male.getByRole('button', { name: '前往 Info 管理 F5-TTS v1 Base FP32 · 男声', exact: true }).click()
    await expect(dialog).not.toBeVisible(); await expect(info).toBeVisible()
    await expect(info.getByTestId('ai-category-speech')).toHaveAttribute('aria-expanded', 'true')
    await expect(infoF5).toBeVisible(); await expect(infoF5).toContainText('CC-BY-NC-4.0')
    await infoF5.getByRole('button', { name: '下载', exact: true }).click(); await confirm()
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.filter(call => call.command === 'ai_model_download').length), 1, '男女声音色共用一个全局模型下载')
    await expect(infoF5.getByRole('progressbar')).toBeVisible()
    await infoF5.getByRole('button', { name: '取消', exact: true }).click()
    await expect(infoF5.getByRole('button', { name: '下载', exact: true })).toBeEnabled()
    await infoF5.getByRole('button', { name: '下载', exact: true }).click(); await confirm()
    await closeInfo(); await open.click()
    await expect(f5.locator('.voice-model-state')).toHaveText('模型准备中')
    await expect(f5Male.locator('.voice-model-state')).toHaveText('模型准备中')
    await expect(f5.getByRole('progressbar')).toHaveCount(0)
    await expect(f5Male.getByRole('button', { name: '选择 F5-TTS v1 Base FP32 · 男声', exact: true })).toBeDisabled()
    await page.evaluate(() => {
      window.voiceDownloadHarness.sharedRuntimeReady = true
      Object.assign(window.voiceDownloadHarness.models['f5-v1-base-fp32'], { status: 'ready', runtimeStatus: 'ready' })
    })
    await expect(f5Male.getByRole('button', { name: '选择 F5-TTS v1 Base FP32 · 男声', exact: true })).toBeEnabled()
    await f5Male.getByRole('button', { name: '选择 F5-TTS v1 Base FP32 · 男声', exact: true }).click()
    await expect(dialog.getByTestId('speech-generate-all')).toBeEnabled()
    await close.click(); await open.click()
    await expect(f5Male.getByRole('button', { name: '选择 F5-TTS v1 Base FP32 · 男声', exact: true })).toHaveAttribute('aria-pressed', 'true')
    console.log('PASS 模型下载与取消集中在 Info，配音模态关闭后再打开 Info，共享状态刷新与声音选择保留')

    await dialog.getByRole('button', { name: '在 Info 中管理配音模型', exact: true }).click()
    await expect(dialog).not.toBeVisible(); await expect(infoF5).toBeVisible()
    await info.getByRole('button', { name: '刷新模型状态', exact: true }).click()
    await infoF5.getByRole('button', { name: '检查 / 修复', exact: true }).click(); await confirm(true)
    await expect(infoF5.getByRole('progressbar')).toBeVisible()
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.filter(call => call.command === 'ai_model_repair').length), 1)
    await closeInfo(); await open.click()
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toBeDisabled()
    await page.evaluate(() => { window.voiceDownloadHarness.models['f5-v1-base-fp32'].status = 'ready' })
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toBeEnabled()
    await close.click()
    await page.evaluate(() => { window.voiceDownloadHarness.models['f5-v1-base-fp32'].runtimeStatus = 'upgrade-available' })
    await open.click()
    await expect(f5.locator('.voice-model-state')).toHaveText('已就绪 · 加速组件可更新')
    await expect(f5.getByRole('button', { name: '选择 F5-TTS v1 Base FP32', exact: true })).toBeEnabled()
    await expect(f5.getByRole('button', { name: '前往 Info 管理 F5-TTS v1 Base FP32', exact: true })).toBeEnabled()
    await page.setViewportSize({ width: 680, height: 820 })
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true, '精简配音面板不得横向溢出')
    await dialog.locator('[data-voice-id="qwen3_uncle_fu"]').scrollIntoViewIfNeeded()
    await expect(dialog.getByRole('button', { name: '试听 Qwen3-TTS 1.7B BF16 · 男声', exact: true })).toBeInViewport()
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.some(call => ['begin_speech_model_download', 'cancel_speech_model_download', 'repair_speech_model'].includes(call.command))), false, '组件不得绕过全局模型服务')
    assert.deepEqual(errors, [])
    console.log('PASS Info 修复后恢复声音选择，GPU更新保持已有CPU声音可用，窄屏布局正常，无分散下载IPC')
  } catch (error) {
    await page?.screenshot({ path: '/tmp/open-media-voice-downloads-failure.png', animations: 'disabled' }).catch(() => {})
    throw error
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
