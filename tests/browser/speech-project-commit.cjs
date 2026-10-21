const assert = require('node:assert/strict')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__speech_project_commit__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="app"></div></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__speech_project_commit__`)
    const samples = 24000, audio = Buffer.alloc(44 + samples * 2)
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40)
    for (let index = 0; index < samples; index++) audio.writeInt16LE(Math.round(Math.sin(index / 24000 * Math.PI * 440) * 4000), 44 + index * 2)
    await page.evaluate(async audioURL => {
      await import('/src/style.css')
      const source = await (await fetch('/src/components/SpeechPanel.vue')).text()
      const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
      const { createApp, h, shallowRef } = await import(vueURL)
      const { createProject, createSubtitleClip } = await import('/src/core/project.ts')
      const p = createProject('配音工程提交验证')
      p.tracks.find(track => track.kind === 'text').clips.push(createSubtitleClip(p, { text: '验证配音等待工程素材收录完成', trimOut: 5 }))
      const f = window.speechCommit = { current: shallowRef(p), accepted: [], discarded: [], commits: 0, pending: false, fail: false, sequence: 0, release: null }
      window.__TAURI_INTERNALS__ = { convertFileSrc: () => audioURL, invoke: async (command, args) => {
        if (command === 'get_speech_status') return { ready: true, voices: [{ id: 'matcha_zh_en_female', name: 'Matcha 中英', language: 'zh-CN', gender: 'female', ready: true }] }
        if (command === 'begin_speech_job') { const id = `generated-${++f.sequence}`; return { id, state: 'completed', asset: { id, name: `${id}.wav`, kind: 'audio', url: audioURL, nativePath: `/speech/${id}.wav`, mime: 'audio/wav', duration: 1, size: 48044, width: 0, height: 0 } } }
        if (command === 'accept_speech_jobs') { f.accepted.push(...args.ids); return null }
        if (command === 'discard_speech_job') { f.discarded.push(args.id); return null }
        if (command === 'cancel_speech_job') return null
        throw new Error(`Unexpected native command ${command}`)
      } }
      const Speech = (await import('/src/components/SpeechPanel.vue')).default
      createApp({ render: () => h(Speech, { active: true, project: f.current.value, commitProject: async next => {
        f.pending = true
        await new Promise(resolve => { f.release = resolve })
        f.pending = false
        if (f.fail) throw new Error('工程素材复制失败')
        f.current.value = next; f.commits++
      } }) }).mount('#app')
    }, `data:audio/wav;base64,${audio.toString('base64')}`)
    const generate = page.getByTestId('speech-generate-all')
    await expect(generate).toBeEnabled()
    await generate.click()
    await page.waitForFunction(() => window.speechCommit.pending || document.querySelector('[role=alert]'))
    assert(await page.evaluate(() => window.speechCommit.pending), await page.locator('body').innerText())
    await expect(generate).toContainText('正在加入时间线')
    assert.deepEqual(await page.evaluate(() => ({ assets: window.speechCommit.current.value.assets.length, accepted: window.speechCommit.accepted, discarded: window.speechCommit.discarded })), { assets: 0, accepted: [], discarded: [] }, '素材收录未完成时不可接受或丢弃语音结果')
    await page.evaluate(() => window.speechCommit.release())
    await expect(generate).toBeEnabled()
    assert.deepEqual(await page.evaluate(() => ({ assets: window.speechCommit.current.value.assets.length, accepted: window.speechCommit.accepted, discarded: window.speechCommit.discarded, commits: window.speechCommit.commits })), { assets: 1, accepted: ['generated-1'], discarded: [], commits: 1 })
    await page.evaluate(() => { window.speechCommit.fail = true })
    await generate.click()
    await page.waitForFunction(() => window.speechCommit.pending || document.querySelector('[role=alert]'))
    assert(await page.evaluate(() => window.speechCommit.pending), await page.locator('body').innerText())
    await page.evaluate(() => window.speechCommit.release())
    await expect(page.getByRole('alert')).toContainText('工程素材复制失败')
    await expect(generate).toBeEnabled()
    assert.deepEqual(await page.evaluate(() => ({ assets: window.speechCommit.current.value.assets.length, accepted: window.speechCommit.accepted, discarded: window.speechCommit.discarded, commits: window.speechCommit.commits })), { assets: 1, accepted: ['generated-1'], discarded: ['generated-2'], commits: 1 }, '收录失败保留原配音并回收未使用的新结果')
    assert.deepEqual(errors, [])
    console.log('PASS 配音等待异步工程素材收录完成后入轨/accept；复制失败保留旧配音，仅discard未使用结果')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
