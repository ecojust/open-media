const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')
const count = (page, id) => page.locator(`[data-count-track-id="${id}"]`)

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }, logLevel: 'error' })
  await server.listen()
  let browser, page
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.route('**/track-count-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto(`${server.resolvedUrls.local[0]}track-count-test`)
    await page.evaluate(async () => {
      const { createProject, createTrack, createTextClip } = await import('/src/core/project.ts')
      const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const { createApp, h, shallowRef, ref, nextTick } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      const project = createProject('轨道片段数量', { width: 320, height: 180, fps: 20 })
      project.tracks = [['text', '字幕轨道', 'subtitles'], ['text', '备用字幕', 'other'], ['video', '视频轨道', 'video'], ['audio', '配音轨道', 'audio']].map(([kind, name, id]) => ({ ...createTrack(kind, name), id }))
      project.tracks[0].clips.push(createTextClip(project, { id: 'original', text: '在这里输入字幕', trimOut: 5 }))
      const current = shallowRef(project), editor = ref(null)
      let history = createHistory(project)
      const fixture = window.trackCountFixture = {
        state: current, editor,
        undo() { history = undoHistory(history); current.value = history.present },
        redo() { history = redoHistory(history); current.value = history.present },
        manyTracks() {
          const next = structuredClone(current.value)
          for (let index = 0; index < 20; index++) next.tracks.push({ ...createTrack(index % 2 ? 'audio' : 'video', `额外轨道 ${index}`), id: `extra-${index}` })
          next.tracks[0].name = '用于检查长名称与字幕警告不重叠的字幕轨道'
          next.tracks[0].clips = Array.from({ length: 100 }, (_, index) => createTextClip(next, { id: `large-${index}`, text: index === 0 ? '' : `字幕 ${index}`, start: index * 5, trimOut: 5 }))
          current.value = next
        },
      }
      createApp({ render: () => h(Editor, { ref: editor, project: current.value, onChange: next => { history = commitHistory(history, next); current.value = next } }) }).mount('#app')
      await nextTick()
    })
    await expect(count(page, 'subtitles')).toHaveText('1')
    for (const id of ['other', 'video', 'audio']) await expect(count(page, id)).toHaveText('0')
    await expect(count(page, 'subtitles')).toHaveAttribute('aria-label', '字幕轨道：1 个片段')
    await page.locator('.timeline-toolbar').getByRole('button', { name: '字幕', exact: true }).click()
    await expect(count(page, 'subtitles')).toHaveText('2')
    await page.getByRole('button', { name: '复制片段', exact: true }).click()
    await expect(count(page, 'subtitles')).toHaveText('3')
    await page.getByRole('button', { name: '删除片段', exact: true }).click()
    await expect(count(page, 'subtitles')).toHaveText('2')
    console.log('PASS 空轨显示0，添加、复制及删除片段后计数即时同步')

    const clip = page.locator('[data-clip-id="original"]'), target = page.locator('[data-track-id="other"]')
    await clip.scrollIntoViewIfNeeded()
    const from = await clip.boundingBox(), to = await target.boundingBox()
    assert(from && to)
    await page.mouse.move(from.x + 20, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect(count(page, 'subtitles')).toHaveText('1')
    await expect(count(page, 'other')).toHaveText('1')
    await page.evaluate(() => window.trackCountFixture.undo())
    await expect(count(page, 'subtitles')).toHaveText('2')
    await expect(count(page, 'other')).toHaveText('0')
    await page.evaluate(() => window.trackCountFixture.redo())
    await expect(count(page, 'subtitles')).toHaveText('1')
    await expect(count(page, 'other')).toHaveText('1')
    console.log('PASS 跨轨拖动与撤销/重做同步更新两条轨道数量')

    await page.evaluate(() => window.trackCountFixture.manyTracks())
    await expect(page.getByTestId('track-clip-count')).toHaveCount(24)
    await expect(count(page, 'subtitles')).toHaveText('100')
    const inspectLayout = () => page.locator('.track-row').evaluateAll(rows => rows.map(row => {
      const label = row.querySelector('.track-label').getBoundingClientRect()
      const badge = row.querySelector('.track-clip-count').getBoundingClientRect()
      const warning = row.querySelector('.track-subtitle-warning')?.getBoundingClientRect()
      const actions = row.querySelector('.track-actions').getBoundingClientRect()
      const handle = row.querySelector('.track-drag-handle').getBoundingClientRect()
      return { rowHeight: row.getBoundingClientRect().height, inside: badge.left >= label.left && badge.right <= label.right, atTop: badge.top < actions.top, rightOfWarning: !warning || badge.left >= warning.right, rightOfHandle: badge.left >= handle.right }
    }))
    for (const result of await inspectLayout()) {
      assert.equal(result.rowHeight, 48)
      assert.ok(result.inside && result.atTop && result.rightOfWarning && result.rightOfHandle, JSON.stringify(result))
    }
    await count(page, 'extra-19').scrollIntoViewIfNeeded()
    await expect(count(page, 'extra-19')).toHaveText('0')
    await page.setViewportSize({ width: 900, height: 700 })
    for (const result of await inspectLayout()) assert.ok(result.inside && result.rightOfWarning && result.rowHeight === 48)
    await count(page, 'subtitles').scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/open-media-track-counts.png', animations: 'disabled' })
    assert.deepEqual(errors, [])
    console.log('PASS 多轨滚动、三位数量、长名称和字幕警告不重叠，保持48px轨道高度')
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
