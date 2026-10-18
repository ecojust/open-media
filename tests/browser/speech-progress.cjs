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

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**'] }, hmr: false }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 800, height: 950 } })
    page.setDefaultTimeout(15000)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.route('**/speech-progress-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui;background:#f5f6fa;color:#222;--ed-muted:#666;--ed-text:#222;--ed-border:#d8dce8;--ed-panel:#fff;--ed-accent:#7855df}#app{max-width:660px;margin:20px auto}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto(`${server.resolvedUrls.local[0]}speech-progress-test`)
    await page.evaluate(async fixture => {
      const state = window.progressFixture = { jobs: [], cancelled: [], discarded: [], accepted: [], polls: 0, changes: 0, holdAccept: false, holdPoll: false }
      state.intervals = new Set()
      const originalInterval = window.setInterval.bind(window), originalClear = window.clearInterval.bind(window)
      window.setInterval = (callback, delay, ...args) => { const id = originalInterval(callback, delay, ...args); if (delay === 1000) state.intervals.add(id); return id }
      window.clearInterval = id => { state.intervals.delete(id); originalClear(id) }
      window.__TAURI_INTERNALS__ = {
        convertFileSrc: () => fixture.url,
        invoke: async (command, args) => {
          if (command === 'get_speech_status') return { ready: true, voices: [{ id: 'matcha_zh_en_female', name: 'Matcha 中英', gender: 'female', language: 'zh-CN' }] }
          if (command === 'begin_speech_job') {
            const job = { id: args.request.requestId, state: 'running', stage: '正在加载声音' }
            state.jobs.push(job)
            return { ...job }
          }
          if (command === 'get_speech_job') {
            state.polls++
            if (state.holdPoll) { state.pollWaiting = true; await new Promise(resolve => { state.releasePoll = resolve }); state.pollWaiting = false }
            return { ...state.jobs.find(job => job.id === args.id) }
          }
          if (command === 'cancel_speech_job') { state.cancelled.push(args.id); return }
          if (command === 'discard_speech_job') { state.discarded.push(args.id); return }
          if (command === 'accept_speech_jobs') {
            if (state.holdAccept) await new Promise(resolve => { state.releaseAccept = resolve })
            state.accepted.push(...args.ids); return
          }
          throw new Error(`Unexpected command: ${command}`)
        },
      }
      const { createProject, createTextClip } = await import('/src/core/project.ts')
      const source = await (await fetch('/src/components/SpeechPanel.vue')).text()
      const { createApp, h, shallowRef, ref, nextTick } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const Panel = (await import('/src/components/SpeechPanel.vue')).default
      const freshProject = () => {
        const project = createProject('字幕进度测试')
        project.tracks[0].clips = ['第一段测试字幕', '第二段测试字幕'].map((text, index) => createTextClip(project, { id: `text-${index}`, text, start: index * 4, trimOut: 3 }))
        return project
      }
      state.project = shallowRef(freshProject()); state.active = ref(true); state.panel = ref(null)
      state.app = createApp({ render: () => h(Panel, { ref: state.panel, active: state.active.value, project: state.project.value, inDialog: true,
        onChange: next => { state.changes++; state.project.value = next },
        onBusy: value => { state.busy = value },
      }) })
      state.app.mount('#app')
      state.report = (index, progress, stage = '正在合成语音') => { Object.assign(state.jobs[index], { progress, stage }) }
      state.finish = index => {
        const job = state.jobs[index]
        Object.assign(job, { state: 'completed', progress: 1, stage: '语音已生成', asset: { id: `audio-${job.id}`, name: '生成语音.wav', kind: 'audio', nativePath: `/fixture/${job.id}.wav`, url: fixture.url, mime: 'audio/wav', duration: 2.5, width: 0, height: 0, size: fixture.size } })
      }
      state.reset = async () => {
        state.jobs = []; state.cancelled = []; state.discarded = []; state.accepted = []; state.changes = 0
        state.holdAccept = false; state.holdPoll = false
        state.project.value = freshProject(); state.active.value = true
        await nextTick()
      }
      await nextTick()
    }, audioFixture())
    const section = page.getByTestId('speech-progress'), bar = page.getByRole('progressbar', { name: '字幕转语音进度' })
    const generate = page.getByTestId('speech-generate-all')
    const jobs = count => expect.poll(() => page.evaluate(() => window.progressFixture.jobs.length)).toBe(count)
    const idle = async () => {
      await expect.poll(() => page.evaluate(() => window.progressFixture.busy)).toBe(false)
      assert.equal(await page.evaluate(() => window.progressFixture.intervals.size), 0, 'finished operations must release their elapsed-time interval')
    }
    const reset = async () => { await idle(); await page.evaluate(() => window.progressFixture.reset()) }
    await expect(generate).toBeEnabled()
    await expect(section).toHaveCount(0)
    await generate.click(); await jobs(1)
    await expect(section).toContainText('0 / 2 段已生成')
    await expect(section).toContainText('正在生成第 1 / 2 段')
    await expect(bar).not.toHaveAttribute('value')
    await page.evaluate(() => window.progressFixture.report(0, 0.4))
    await expect(bar).toHaveAttribute('value', '20')
    await expect(section.getByRole('timer')).toHaveAttribute('aria-live', 'off')
    await expect(section.getByRole('timer')).toHaveText(/已用时 00:0[1-9]/)
    assert.equal(await page.evaluate(() => window.progressFixture.intervals.size), 1)
    const polls = await page.evaluate(() => window.progressFixture.polls)
    await expect.poll(() => page.evaluate(() => window.progressFixture.polls)).toBeGreaterThan(polls + 1)
    await expect(bar).toHaveAttribute('value', '20')
    await page.evaluate(() => window.progressFixture.finish(0)); await jobs(2)
    await expect(section).toContainText('1 / 2 段已生成')
    await expect(section).toContainText('正在生成第 2 / 2 段')
    await expect(bar).toHaveAttribute('value', '50')
    assert.equal(await page.evaluate(() => window.progressFixture.project.value.assets.length), 0, 'individual results must not be committed before the entire batch succeeds')
    await page.evaluate(() => window.progressFixture.report(1, 0.6))
    await expect(bar).toHaveAttribute('value', '80')
    await page.screenshot({ path: '/tmp/open-media-speech-progress.png', animations: 'disabled' })
    await page.evaluate(() => window.progressFixture.report(1, 1))
    await expect(bar).toHaveAttribute('value', '99')
    await page.evaluate(() => { window.progressFixture.holdAccept = true; window.progressFixture.finish(1) })
    await expect(section).toContainText('2 / 2 段已生成')
    await expect(section).toContainText('正在加入时间线')
    await expect(bar).not.toHaveAttribute('value')
    await expect(page.getByRole('button', { name: '取消生成', exact: true })).toBeDisabled()
    await page.evaluate(() => window.progressFixture.releaseAccept()); await idle()
    await expect(section).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => ({ assets: window.progressFixture.project.value.assets.length, changes: window.progressFixture.changes, accepted: window.progressFixture.accepted.length })), { assets: 2, changes: 1, accepted: 2 })
    console.log('PASS 真实任务进度与完成段数合成总进度；等待不虚增，最终写入前不显示100%，一次原子提交')

    await reset(); await generate.click(); await jobs(1)
    await page.evaluate(() => window.progressFixture.finish(0)); await jobs(2)
    await page.evaluate(() => Object.assign(window.progressFixture.jobs[1], { state: 'failed', error: '测试：第二段失败' }))
    await expect(page.getByRole('alert')).toContainText('第二段失败'); await idle()
    await expect(section).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => ({ assets: window.progressFixture.project.value.assets.length, changes: window.progressFixture.changes, discarded: window.progressFixture.discarded.length })), { assets: 0, changes: 0, discarded: 2 })
    await reset(); await generate.click(); await jobs(1)
    await expect(section).toContainText('0 / 2 段已生成')
    await expect(bar).not.toHaveAttribute('value')
    await expect(section.getByRole('timer')).toHaveText('已用时 00:00')
    for (const invalid of [-0.2, 2, null]) {
      await page.evaluate(value => window.progressFixture.report(0, value), invalid)
      const current = await page.evaluate(() => window.progressFixture.polls)
      await expect.poll(() => page.evaluate(() => window.progressFixture.polls)).toBeGreaterThan(current)
      await expect(bar).not.toHaveAttribute('value')
    }
    await page.evaluate(() => { window.progressFixture.holdPoll = true })
    await expect.poll(() => page.evaluate(() => window.progressFixture.pollWaiting)).toBe(true)
    await page.getByRole('button', { name: '取消生成', exact: true }).click()
    await expect(section).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.progressFixture.intervals.size), 0, 'cancellation stops elapsed time even before an outstanding poll returns')
    await page.evaluate(() => { window.progressFixture.finish(0); window.progressFixture.releasePoll() }); await idle()
    assert.equal(await page.evaluate(() => window.progressFixture.changes), 0)
    await expect(section).toHaveCount(0)
    console.log('PASS 中途失败不写入项目并清理全部结果；重试从零开始，异常进度与取消后的迟到结果均不污染界面')

    for (const action of ['close', 'project']) {
      await reset(); await generate.click(); await jobs(1)
      await page.evaluate(action => {
        const state = window.progressFixture
        if (action === 'close') state.active.value = false
        else state.project.value = { ...state.project.value, id: 'replacement-project' }
      }, action)
      await idle(); await expect(section).toHaveCount(0)
      assert.deepEqual(await page.evaluate(() => ({ cancelled: new Set(window.progressFixture.cancelled).size, discarded: window.progressFixture.discarded.length, changes: window.progressFixture.changes })), { cancelled: 1, discarded: 1, changes: 0 })
    }
    await reset(); await generate.click(); await jobs(1)
    await page.evaluate(() => window.progressFixture.app.unmount())
    await expect(section).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.progressFixture.discarded.length)).toBe(1)
    assert.equal(await page.evaluate(() => window.progressFixture.intervals.size), 0)
    console.log('PASS 实际已用时静默刷新；关闭、切换项目及离开页面时取消任务并清理进度、计时器和临时结果')

    await page.setViewportSize({ width: 1440, height: 960 })
    await page.evaluate(async () => {
      const state = window.progressFixture
      await state.reset()
      document.documentElement.style.height = '100%'; document.body.style.height = '100%'
      Object.assign(document.getElementById('app').style, { height: '100%', maxWidth: 'none', margin: '0' })
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const { createApp, h, nextTick } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      state.editorApp = createApp({ render: () => h(Editor, { project: state.project.value,
        onChange: next => { state.changes++; state.project.value = next },
        onBusy: value => { state.busy = value },
      }) })
      state.editorApp.mount('#app'); await nextTick()
    })
    const singleProgress = page.getByTestId('clip-speech-progress')
    const singleBar = singleProgress.getByRole('progressbar', { name: '当前字幕转语音进度' })
    const singleGenerate = page.getByTestId('speech-generate-selected')
    await page.locator('[data-clip-id="text-0"]').click()
    await singleGenerate.click(); await jobs(1)
    await expect(singleBar).toBeVisible()
    await expect(singleBar).not.toHaveAttribute('value')
    await page.evaluate(() => window.progressFixture.report(0, 0.42, '正在合成语音 · GPU'))
    await expect(singleBar).toHaveAttribute('value', '42')
    await expect(singleProgress).toContainText('GPU')
    await page.evaluate(() => { window.progressFixture.holdPoll = true })
    await expect.poll(() => page.evaluate(() => window.progressFixture.pollWaiting)).toBe(true)
    await page.evaluate(() => {
      const state = window.progressFixture
      state.project.value = { ...state.project.value, id: 'next-editor-project' }
    })
    await expect(singleProgress).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.progressFixture.intervals.size), 0)
    await page.evaluate(() => { window.progressFixture.finish(0); window.progressFixture.holdPoll = false; window.progressFixture.releasePoll() })
    await idle()
    assert.deepEqual(await page.evaluate(() => ({ changes: window.progressFixture.changes, assets: window.progressFixture.project.value.assets.length, discarded: window.progressFixture.discarded.length })), { changes: 0, assets: 0, discarded: 1 })
    await page.locator('[data-clip-id="text-0"]').click()
    await singleGenerate.click(); await jobs(2)
    await expect(singleBar).not.toHaveAttribute('value')
    await expect(singleProgress).not.toContainText('42%')
    await page.evaluate(() => window.progressFixture.report(1, 0.1, '正在合成语音 · CPU'))
    await expect(singleBar).toHaveAttribute('value', '10')
    await expect(singleProgress).toContainText('CPU')
    await page.locator('.clip-speech-actions').getByRole('button', { name: '取消生成', exact: true }).click()
    await expect(singleProgress).toHaveCount(0); await idle()
    await page.evaluate(() => window.progressFixture.editorApp.unmount())
    assert.deepEqual(errors, [])
    console.log('PASS 单条属性栏进度跟随真实任务，切项目取消并忽略迟到结果，新项目生成不残留旧百分比与计时')
    console.log('说明：本测试校验界面与受控原生桥契约，不将测试音频当作实际模型合成结果。')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
