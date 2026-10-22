const assert = require('node:assert/strict')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.route('**/__speech_alignment__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__speech_alignment__`)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const moduleSource = await (await fetch('/src/components/editor-tools/SpeechAlignmentAssist.vue')).text()
      const vueURL = moduleSource.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
      const { createApp, h, shallowRef, ref } = await import(vueURL)
      const { createProject, createClip, createSubtitleClip } = await import('/src/core/project.ts')
      const { createHistory, commitHistory, undoHistory } = await import('/src/core/timeline.ts')
      const Assist = (await import('/src/components/editor-tools/SpeechAlignmentAssist.vue')).default
      const project = createProject('声画对齐界面')
      for (const [id, start, length] of [['one', 0, 4], ['two', 3, 2], ['three', 10, 2]]) {
        const text = createSubtitleClip(project, { id, start, text: `${id} 演示旁白`, trimOut: 2 })
        project.tracks.find(track => track.kind === 'text').clips.push(text)
        const audio = { id: `${id}-asset`, name: '现有配音', kind: 'audio', duration: length, width: 0, height: 0, size: 100, url: `blob:${id}`, mime: 'audio/wav' }
        project.assets.push(audio)
        project.tracks.find(track => track.kind === 'audio').clips.push(createClip(audio, project, { id: `${id}-speech`, start, speech: { textClipId: id, text: text.text, voiceId: 'existing', rate: 1 } }))
      }
      let history = createHistory(project)
      const fixture = window.speechAlignment = { current: shallowRef(project), commits: 0, seeks: [], notices: [], disabled: ref(false), theme: ref('light') }
      fixture.changeProject = () => { fixture.current.value = { ...fixture.current.value, title: `${fixture.current.value.title} 修改` } }
      fixture.undo = () => { history = undoHistory(history); fixture.current.value = history.present }
      const commit = (next, label) => { history = commitHistory(history, next); fixture.current.value = next; fixture.commits++; fixture.lastLabel = label }
      createApp({ render: () => h('main', { 'data-theme': fixture.theme.value, style: 'width:440px;padding:24px;margin:24px auto;background:var(--ui-surface);color:var(--ui-text)' }, h(Assist, { project: fixture.current.value, disabled: fixture.disabled.value, onChange: commit, onSeek: (...args) => fixture.seeks.push(args), onStatus: text => fixture.notices.push(text) })) }).mount('#app')
    })
    const panel = page.getByTestId('speech-alignment-assist')
    await expect(panel).toContainText('3 段关联配音')
    await expect(panel).toContainText('字幕比现有配音短')
    await panel.getByRole('button', { name: /^one 演示旁白.*定位片段/ }).click()
    assert.deepEqual(await page.evaluate(() => window.speechAlignment.seeks[0]), [0, 'one'])
    await panel.getByTestId('speech-alignment-preview').click()
    await expect(panel.getByTestId('speech-alignment-preview-result')).toContainText('1 个字幕')
    assert.equal(await page.evaluate(() => window.speechAlignment.commits), 0, '只读预览不提交项目')
    await panel.getByLabel('现有配音对齐策略').selectOption('ripple')
    await expect(panel.getByTestId('speech-alignment-apply')).toHaveCount(0)
    await panel.getByTestId('speech-alignment-preview').click()
    await expect(panel.getByTestId('speech-alignment-preview-result')).toContainText('2 段配音移动')
    await page.evaluate(() => window.speechAlignment.changeProject())
    await expect(panel.getByTestId('speech-alignment-apply')).toHaveCount(0)
    await panel.getByTestId('speech-alignment-preview').click()
    await panel.getByTestId('speech-alignment-apply').click()
    assert.equal(await page.evaluate(() => window.speechAlignment.commits), 1)
    assert.equal(await page.evaluate(() => window.speechAlignment.current.value.tracks.find(track => track.kind === 'audio').clips[1].start), 5)
    await expect(panel).toContainText('0 个待检查项')
    await page.evaluate(() => window.speechAlignment.undo())
    assert.equal(await page.evaluate(() => window.speechAlignment.current.value.tracks.find(track => track.kind === 'audio').clips[1].start), 3)
    await expect(panel).toContainText('字幕比现有配音短')
    await panel.getByLabel('对齐最小句间停顿').fill('9')
    await panel.getByTestId('speech-alignment-preview').click()
    await expect(panel.getByRole('alert')).toContainText('0 到 5')
    await page.evaluate(() => { window.speechAlignment.disabled.value = true; window.speechAlignment.theme.value = 'dark' })
    await expect(panel.getByTestId('speech-alignment-preview')).toBeDisabled()
    assert.equal(await page.evaluate(() => window.speechAlignment.commits), 1)
    assert.deepEqual(errors, [])
    console.log('PASS existing narration inspection, seek, read-only preview, stale-plan invalidation, atomic apply/undo and disabled controls')
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
