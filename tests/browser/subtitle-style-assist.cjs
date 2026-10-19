const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 900, height: 850 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/subtitle-style-assist-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>body{font-family:system-ui;background:#171d2a;color:#d8dfed;--ed-text:#d8dfed;--ed-panel:#212838;--ed-border:#354157;--ed-muted:#a1b0c4;--ed-accent:#7694ff}#app{max-width:680px;margin:auto}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/subtitle-style-assist-test`)
    await page.evaluate(async () => {
      const source = await (await fetch('/src/components/editor-tools/SubtitleStyleAssist.vue')).text()
      const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
      const { createApp, h, shallowRef, ref, nextTick } = await import(vueImport)
      const { createProject, createTrack, createSubtitleClip, createTextClip } = await import('/src/core/project.ts')
      const { createHistory, commitHistory, undoHistory } = await import('/src/core/timeline.ts')
      const Panel = (await import('/src/components/editor-tools/SubtitleStyleAssist.vue')).default
      const project = createProject('字幕统一组件验证'), second = createTrack('text', '第二字幕'), locked = createTrack('text', '锁定字幕')
      project.tracks[0].id = 'main'; second.id = 'second'; locked.id = 'locked'; locked.locked = true
      project.tracks[0].clips = [
        createSubtitleClip(project, { id: 'source', text: '参考样式', color: '#ffcc00', fontSize: 48, start: 0, trimOut: 5 }),
        createSubtitleClip(project, { id: 'target', text: '第二句', start: 5 }),
        createTextClip(project, { id: 'title', textRole: 'watermark', text: '章节标题' }),
      ]
      second.clips = [
        createSubtitleClip(project, { id: 'empty', text: '', start: 10 }),
        createSubtitleClip(project, { id: 'animated', text: '动画字幕', start: 15, keyframes: { x: [{ time: 0, value: 5 }] } }),
      ]
      locked.clips = [createSubtitleClip(project, { id: 'locked-caption', text: '锁定文字', start: 20 })]
      project.tracks.push(second, locked)
      const current = shallowRef(project), disabled = ref(false)
      let history = createHistory(project)
      const fixture = window.subtitleStyleAssist = { current, disabled, changes: [], seeks: [], messages: [], nextTick,
        undo() { history = undoHistory(history); current.value = history.present },
        get history() { return history },
      }
      createApp({ render: () => h(Panel, { project: current.value, selectedClipId: 'source', disabled: disabled.value,
        onChange(next, label) { fixture.changes.push(label); history = commitHistory(history, next); current.value = next },
        onSeek(time, clipId) { fixture.seeks.push({ time, clipId }) }, onStatus(message) { fixture.messages.push(message) },
      }) }).mount('#app')
      await nextTick()
    })
    await expect(page.getByLabel('参考字幕')).toHaveValue('source')
    await expect(page.getByLabel('参考字幕').locator('option')).toHaveCount(5)
    await expect(page.getByTestId('subtitle-style-summary')).toContainText('将修改 2 条字幕')
    await expect(page.getByTestId('subtitle-style-summary')).toContainText('动画跳过 1 条')
    await page.getByLabel('统一轨道：锁定字幕').check()
    await expect(page.getByTestId('subtitle-style-summary')).toContainText('锁定跳过 1 条')
    await page.getByRole('button', { name: '字幕内容为空' }).click()
    assert.deepEqual(await page.evaluate(() => window.subtitleStyleAssist.seeks), [{ time: 10, clipId: 'empty' }])
    await page.getByRole('button', { name: '应用字幕样式' }).click()
    const applied = await page.evaluate(() => ({ project: window.subtitleStyleAssist.current.value, changes: window.subtitleStyleAssist.changes, past: window.subtitleStyleAssist.history.past.length }))
    assert.equal(applied.past, 1)
    assert.deepEqual(applied.changes, ['统一字幕样式'])
    const find = id => applied.project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)
    assert.equal(find('target').color, '#ffcc00'); assert.equal(find('empty').fontSize, 48)
    assert.equal(find('locked-caption').color, '#ffffff'); assert.equal(find('animated').color, '#ffffff')
    assert.equal(find('title').color, '#ffffff'); assert.equal(find('empty').text, '')
    assert.equal(applied.project.subtitleStyle.color, '#ffcc00')
    await expect(page.getByRole('button', { name: '应用字幕样式' })).toBeDisabled()
    await page.evaluate(() => window.subtitleStyleAssist.undo())
    await expect(page.getByTestId('subtitle-style-summary')).toContainText('将修改 2 条字幕')
    assert.equal(await page.evaluate(() => window.subtitleStyleAssist.current.value.subtitleStyle), undefined)
    await page.evaluate(() => { window.subtitleStyleAssist.disabled.value = true })
    await expect(page.getByLabel('参考字幕')).toBeDisabled()
    await expect(page.getByRole('button', { name: '字幕内容为空' })).toBeDisabled()
    assert.deepEqual(errors, [])
    console.log('PASS 字幕统一组件：跨轨道预览、锁定与动画保护、问题定位、一次应用与撤销、忙碌禁用')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
