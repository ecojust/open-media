const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function installNativeContract(page) {
  await page.addInitScript(() => {
    const state = window.voiceDownloadHarness = { calls: [], modelState: 'not-downloaded', downloadedBytes: 0, modelError: '' }
    const catalog = () => ({ ready: true, voices: [
      { id: 'matcha_zh_en_female', name: '温柔女声（中英）', language: 'zh-CN', gender: 'female', status: 'bundled', modelSize: 149227292 },
      ...[
        { id: 'zm_013', name: '低沉男声', language: 'zh-CN', gender: 'male' },
        { id: 'zf_038', name: '清亮女声', language: 'zh-CN', gender: 'female' },
        { id: 'af_maple', name: '英语女声', language: 'en-US', gender: 'female' },
      ].map(voice => ({ ...voice, modelId: 'optional-shared', modelSize: 176178663, downloadSize: 176178663, status: state.modelState, downloadedBytes: state.downloadedBytes, error: state.modelError })),
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
          if (args.modelId !== 'optional-shared') throw new Error('未知模型')
          state.modelState = 'downloading'; state.downloadedBytes = 0; state.modelError = ''
          return catalog()
        }
        if (command === 'cancel_speech_model_download') { state.modelState = 'not-downloaded'; state.downloadedBytes = 0; return catalog() }
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
    await expect(dialog.getByRole('button', { name: '选择 温柔女声（中英）', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.locator('.voice-model-size')).toHaveText('已内置 · 149.2 MB')
    await dialog.getByRole('tab', { name: /^中文男声/ }).click()
    const male = dialog.locator('[data-voice-id="zm_013"]')
    await expect(male.getByRole('button', { name: '选择 低沉男声', exact: true })).toBeDisabled()
    await expect(male.locator('.voice-model-size')).toHaveText('模型 · 176.2 MB')
    await expect(male.locator('.voice-model-shared')).toHaveText('共享模型 · 3 种声音')
    await expect(male.getByRole('button', { name: '下载 低沉男声', exact: true })).toContainText('176.2 MB')
    await page.screenshot({ path: '/tmp/open-media-voice-downloads-available.png', animations: 'disabled' })
    await expect(male.getByRole('button', { name: '试听 低沉男声', exact: true })).toBeEnabled()
    await male.getByRole('button', { name: '试听 低沉男声', exact: true }).click()
    await expect(dialog.getByLabel('声音试听音频')).toHaveJSProperty('paused', false)
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.some(call => /begin_speech/.test(call.command))), false, '试听本地音频不能自动下载或合成')
    console.log('PASS 可选声音显示模型与下载大小、共享音色数量，未下载可本地试听但不可选择')

    await male.getByRole('button', { name: '下载 低沉男声', exact: true }).click()
    await expect(male.getByRole('progressbar')).toHaveAttribute('value', '0')
    await expect(close).toBeEnabled()
    await expect(page.getByTestId('save-project')).toBeEnabled()
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    await page.evaluate(() => { window.voiceDownloadHarness.downloadedBytes = 88089332 })
    await expect(male.getByRole('progressbar')).toHaveAttribute('value', '50')
    await dialog.getByRole('tab', { name: /^中文女声/ }).click()
    const female = dialog.locator('[data-voice-id="zf_038"]')
    await expect(female.getByRole('progressbar')).toHaveAttribute('value', '50')
    await female.getByRole('button', { name: '取消下载 清亮女声', exact: true }).click()
    await expect(female.getByRole('button', { name: '下载 清亮女声', exact: true })).toBeEnabled()
    await female.getByRole('button', { name: '下载 清亮女声', exact: true }).click()
    await expect(female.getByRole('progressbar')).toBeVisible()
    await page.evaluate(() => { window.voiceDownloadHarness.modelState = 'failed'; window.voiceDownloadHarness.modelError = '连接中断，请重试。' })
    await expect(female.locator('.voice-model-error')).toHaveText('连接中断，请重试。')
    await female.getByRole('button', { name: '重试下载 清亮女声', exact: true }).click()
    await expect(female.getByRole('progressbar')).toBeVisible()
    await page.evaluate(() => { window.voiceDownloadHarness.modelState = 'verifying'; window.voiceDownloadHarness.downloadedBytes = 176178663 })
    await expect(female.locator('.voice-model-state')).toHaveText('正在校验模型…')
    await expect(female.getByRole('button', { name: '选择 清亮女声', exact: true })).toBeDisabled()
    console.log('PASS 共享下载进度自动刷新，支持取消/失败重试，校验期间不可用，编辑与关闭不被锁定')

    await close.click()
    await expect(dialog).not.toBeVisible()
    const calls = await page.evaluate(() => window.voiceDownloadHarness.calls)
    const cancellations = calls.filter(call => call.command === 'cancel_speech_model_download').length
    const reads = calls.filter(call => call.command === 'get_speech_status').length
    await page.waitForTimeout(1200)
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.filter(call => call.command === 'get_speech_status').length), reads, '关闭停止界面轮询')
    assert.equal(await page.evaluate(() => window.voiceDownloadHarness.calls.filter(call => call.command === 'cancel_speech_model_download').length), cancellations, '关闭不取消后台下载')
    await page.evaluate(() => { window.voiceDownloadHarness.modelState = 'ready'; window.voiceDownloadHarness.modelError = '' })
    await open.click()
    await dialog.getByRole('tab', { name: /^中英女声/ }).click()
    await expect(dialog.getByRole('button', { name: '选择 温柔女声（中英）', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByRole('tab', { name: /^中文男声/ }).click()
    await expect(male.getByRole('button', { name: '选择 低沉男声', exact: true })).toBeEnabled()
    await expect(male.locator('.voice-model-size')).toHaveText('已下载 · 176.2 MB')
    await male.getByRole('button', { name: '选择 低沉男声', exact: true }).click()
    await expect(male.getByRole('button', { name: '选择 低沉男声', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByTestId('speech-generate-all')).toBeEnabled()
    await dialog.getByRole('tab', { name: /^英文女声/ }).click()
    await expect(dialog.getByRole('button', { name: '选择 英语女声', exact: true })).toBeEnabled()
    await page.screenshot({ path: '/tmp/open-media-voice-downloads.png', animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(dialog).toBeVisible()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    assert.deepEqual(errors, [])
    console.log('PASS 重开同步已下载状态，保持原选择，一次安装解锁多个声音，窄屏无溢出')
  } catch (error) {
    await page?.screenshot({ path: '/tmp/open-media-voice-downloads-failure.png', animations: 'disabled' }).catch(() => {})
    throw error
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
