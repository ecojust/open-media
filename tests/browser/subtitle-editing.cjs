const assert = require('node:assert/strict')
const { existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { chromium, expect } = require('@playwright/test')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'subtitle-editing') : '/tmp/open-media-subtitle-editing'
const timelineClip = (page, id) => page.locator(`.timeline-clip[data-clip-id="${id}"]`)
const input = page => page.getByTestId('clip-text-content')
const state = page => page.evaluate(() => window.subtitleFixture.state.value)
const clip = async (page, id) => (await state(page)).tracks.flatMap(track => track.clips).find(item => item.id === id)
const styleKeys = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'fadeIn', 'fadeOut', 'fontSize', 'fontFamily', 'fontWeight', 'color', 'background', 'textAlign']
const style = clip => Object.fromEntries(styleKeys.map(key => [key, clip[key]]))
const identity = clip => Object.fromEntries(Object.entries(clip).filter(([key]) => !styleKeys.includes(key)))

async function installEditor(page, url) {
  await page.route('**/subtitle-editing-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/subtitle-editing-test`)
  await page.evaluate(async () => {
    const { cloneProject, createProject, createTrack, createTextClip, validateProject } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueImport)
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    const project = createProject('字幕输入与整轨样式验证', { width: 640, height: 360, fps: 20, background: '#102030' })
    const track = createTrack('text', '主字幕'); track.id = 'subtitles'
    track.clips = [
      createTextClip(project, { id: 'source', textRole: 'subtitle', name: '源字幕', text: '第一段原文', start: 0, trimOut: 3, x: 70, y: 80, width: 250, height: 60, rotation: 7, opacity: 0.85, fadeIn: 0.2, fadeOut: 0.3, fontSize: 23, fontFamily: 'serif', fontWeight: 700, color: '#ffd166', background: '#234567', textAlign: 'right', generatedAt: '2026-10-17T01:02:03.000Z' }),
      createTextClip(project, { id: 'second', textRole: 'subtitle', name: '另一段字幕', text: '第二段原文', start: 4, trimIn: 1, trimOut: 3, x: 20, y: 200, fontSize: 18, color: '#ffffff', generatedAt: '2026-10-17T02:03:04.000Z' }),
      createTextClip(project, { id: 'third', textRole: 'subtitle', name: '第三段字幕', text: '第三段原文', start: 7, trimOut: 3, x: 90, y: 200, fontSize: 16, background: 'transparent' }),
      createTextClip(project, { id: 'watermark', textRole: 'watermark', name: '保留文字水印', text: '水印原文', start: 11, trimOut: 2, x: 100, y: 150, fontSize: 14, color: '#00ff00' }),
    ]
    const other = createTrack('text', '另一条字幕轨道'); other.id = 'other'
    other.clips = [createTextClip(project, { id: 'other-subtitle', textRole: 'subtitle', text: '另一轨原文', start: 0, trimOut: 4, x: 10, y: 10, fontSize: 15, color: '#33aaff' })]
    project.tracks = [track, other]
    const current = shallowRef(validateProject(project, { trusted: true })), editor = ref(null)
    let history = createHistory(current.value), lastGroup, lastHistory
    const fixture = window.subtitleFixture = {
      state: current, editor, changes: [], messages: [], nextTick,
      get history() { return history },
      reset(next = project) { current.value = validateProject(next, { trusted: true }); history = createHistory(current.value); lastGroup = undefined; lastHistory = undefined; this.changes.splice(0) },
      undo() { history = undoHistory(history); current.value = history.present },
      redo() { history = redoHistory(history); current.value = history.present },
    }
    fixture.app = createApp({ render: () => h(Editor, {
      ref: editor, project: current.value,
      onChange: (next, label, group) => {
        fixture.changes.push({ label })
        history = group && group === lastGroup && history === lastHistory
          ? { ...history, present: cloneProject(next), future: [] }
          : commitHistory(history, next)
        lastGroup = group; lastHistory = history; current.value = next
      },
      onStatus: message => fixture.messages.push(message),
    }) })
    fixture.app.mount('#app'); await nextTick(); editor.value.seek(1)
  })
  await expect(timelineClip(page, 'source')).toBeVisible()
}

async function reset(page, patch) {
  await page.keyboard.press('Escape')
  await page.evaluate(async patch => {
    const fixture = window.subtitleFixture
    fixture.reset()
    if (patch) {
      const project = JSON.parse(JSON.stringify(fixture.state.value))
      if (patch.locked) project.tracks[0].locked = true
      if (patch.single) project.tracks[0].clips = project.tracks[0].clips.filter(clip => ['source', 'watermark'].includes(clip.id))
      fixture.reset(project)
    }
    await fixture.nextTick(); fixture.editor.value.seek(1)
  }, patch)
  await timelineClip(page, 'source').click()
}

async function immediateEditing(page) {
  await reset(page)
  const originalSecond = await clip(page, 'second')
  await input(page).fill('输入完成后直接点击另一段字幕')
  await expect(input(page)).toBeFocused()
  assert.equal((await clip(page, 'source')).text, '输入完成后直接点击另一段字幕', '输入事件必须立即写入项目，不能依赖 blur/change')
  await timelineClip(page, 'second').click()
  assert.equal((await clip(page, 'source')).text, '输入完成后直接点击另一段字幕')
  assert.deepEqual(await clip(page, 'second'), originalSecond, '切换选择不能把上一段输入写进新片段')
  await expect(input(page)).toHaveValue('第二段原文')

  await timelineClip(page, 'source').click()
  await input(page).fill('点击空轨道前已保存')
  await page.locator('[data-track-id="subtitles"]').click({ position: { x: 150, y: 18 } })
  assert.equal((await clip(page, 'source')).text, '点击空轨道前已保存')
  await input(page).fill('')
  assert.equal((await clip(page, 'source')).text, '', '删除全部文字也应立即生效')
  await page.evaluate(() => window.subtitleFixture.undo())
  await expect(input(page)).toHaveValue('点击空轨道前已保存')
  await page.evaluate(() => window.subtitleFixture.redo())
  await expect(input(page)).toHaveValue('')
  await reset(page)
  await input(page).fill('文字前后')
  await input(page).evaluate(element => element.setSelectionRange(2, 2))
  await input(page).pressSequentially('ABC')
  assert.equal((await clip(page, 'source')).text, '文字ABC前后')
  assert.equal(await input(page).evaluate(element => element.selectionStart), 5, '即时更新不得让光标跳到末尾')
  await page.evaluate(() => window.subtitleFixture.undo())
  await expect(input(page)).toHaveValue('第一段原文')
  await page.evaluate(() => window.subtitleFixture.redo())
  await expect(input(page)).toHaveValue('文字ABC前后')
  console.log('PASS 输入、直接点击其他片段/时间线、清空文字即时保存；不污染其他片段；中途插入保留光标，连续输入单步撤销/重做')
}

async function compositionEditing(page) {
  await reset(page)
  await input(page).focus()
  // Exercise the browser composition event sequence without depending on an OS input method.
  await input(page).evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    element.value = 'zhong wen'
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'wen', inputType: 'insertCompositionText', isComposing: true }))
    element.value = '中文输入已经完成'
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文输入已经完成' }))
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文输入已经完成', inputType: 'insertText', isComposing: false }))
  })
  assert.equal((await clip(page, 'source')).text, '中文输入已经完成')
  await timelineClip(page, 'second').click()
  assert.equal((await clip(page, 'source')).text, '中文输入已经完成')
  assert.equal((await clip(page, 'second')).text, '第二段原文')
  await page.evaluate(() => window.subtitleFixture.undo())
  assert.equal((await clip(page, 'source')).text, '第一段原文', '一次输入法提交应一次撤销，不能撤回到拼音候选串')
  await page.evaluate(() => window.subtitleFixture.redo())
  assert.equal((await clip(page, 'source')).text, '中文输入已经完成')

  await reset(page)
  await input(page).focus()
  await input(page).evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    element.value = '原片段的最终中文'
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }))
    const target = document.querySelector('.timeline-clip[data-clip-id="second"]')
    const bounds = target.getBoundingClientRect()
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: bounds.x + 20, clientY: bounds.y + 20 }))
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '原片段的最终中文' }))
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', isComposing: false }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: bounds.x + 20, clientY: bounds.y + 20 }))
  })
  assert.equal((await clip(page, 'source')).text, '原片段的最终中文', '先 pointerdown 切换选择后到达的输入法提交仍应保存到源片段')
  assert.equal((await clip(page, 'second')).text, '第二段原文')
  console.log('PASS 中文组合输入最终提交完整保存，单次撤销不暴露候选串；点击切换选择与 compositionend 交错时仍写回原片段')
}

async function trackStyleEditing(page) {
  await reset(page)
  const before = await state(page), original = Object.fromEntries(before.tracks.flatMap(track => track.clips).map(clip => [clip.id, clip]))
  await timelineClip(page, 'source').click({ button: 'right' })
  const apply = page.getByTestId('apply-subtitle-style-to-track')
  await expect(apply).toBeEnabled()
  await expect(apply).toHaveText('将样式应用到同轨道字幕')
  await apply.click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  for (const id of ['second', 'third']) {
    assert.deepEqual(style(await clip(page, id)), style(original.source), '同轨道字幕应复制所有视觉配置')
    assert.deepEqual(identity(await clip(page, id)), identity(original[id]), '每段文字、时序、标识和生成时间必须保留')
  }
  for (const id of ['source', 'watermark', 'other-subtitle']) assert.deepEqual(await clip(page, id), original[id], `${id} 不应被修改`)
  assert.equal(await page.evaluate(() => window.subtitleFixture.history.past.length), 1, '批量样式应是一个撤销步骤')
  const applied = await state(page)
  await page.evaluate(() => window.subtitleFixture.undo())
  assert.deepEqual(await state(page), before)
  await page.evaluate(() => window.subtitleFixture.redo())
  assert.deepEqual(await state(page), applied)
  await timelineClip(page, 'source').click({ button: 'right' })
  await apply.click()
  assert.equal(await page.evaluate(() => window.subtitleFixture.history.past.length), 1, '重复应用相同样式不得产生无效历史')

  await reset(page, { locked: true })
  await timelineClip(page, 'source').click({ button: 'right' })
  await expect(apply).toBeDisabled()
  await reset(page, { single: true })
  await timelineClip(page, 'source').click({ button: 'right' })
  await expect(apply).toBeDisabled()
  await page.keyboard.press('Escape')
  await timelineClip(page, 'watermark').click({ button: 'right' })
  await expect(apply).toHaveCount(0)
  console.log('PASS 右键整轨样式完整复制外观；原文、时间、其他轨道与水印不变；单步撤销/重做；锁定与无目标限制正确')
}

async function draftPersistence(page, url) {
  await reset(page)
  await page.evaluate(async () => {
    const { saveProject } = await import('/src/core/storage.ts')
    const project = window.subtitleFixture.state.value
    await saveProject(project)
    localStorage.setItem('open-media:last-project', project.id)
    localStorage.setItem('open-media:autosave', 'true')
  })
  await page.goto(url)
  await page.getByTestId('nav-edit').click()
  await timelineClip(page, 'source').click()
  const undo = page.getByRole('button', { name: '撤销', exact: true })
  const redo = page.getByRole('button', { name: '重做', exact: true })
  const fontSize = page.getByLabel('字号', { exact: true })
  await expect(input(page)).toHaveValue('第一段原文')
  await expect(fontSize).toHaveValue('23')
  await input(page).fill('真实应用连续输入')
  await input(page).pressSequentially(' ABC')
  await expect(input(page)).toHaveValue('真实应用连续输入 ABC')
  await undo.click()
  await expect(input(page)).toHaveValue('第一段原文')
  await redo.click()
  await expect(input(page)).toHaveValue('真实应用连续输入 ABC')
  await fontSize.fill('31')
  await fontSize.press('Tab')
  await expect(fontSize).toHaveValue('31')
  await undo.click()
  await expect(fontSize).toHaveValue('23')
  await expect(input(page)).toHaveValue('真实应用连续输入 ABC')
  await undo.click()
  await expect(input(page)).toHaveValue('第一段原文')
  await expect(fontSize).toHaveValue('23')
  console.log('PASS 实际 App 工具栏单次撤销/重做完整连续输入；属性修改独立撤销，后续撤销才恢复文字')

  const text = '始终停留在输入框，也会保存到本地草稿'
  await input(page).fill(text)
  await expect(input(page)).toBeFocused()
  await expect.poll(async () => page.evaluate(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    const restored = await loadProject(localStorage.getItem('open-media:last-project'))
    try { return restored.project.tracks.flatMap(track => track.clips).find(clip => clip.id === 'source').text }
    finally { restored.revoke() }
  }), { timeout: 10000 }).toBe(text)
  await expect(input(page)).toBeFocused()
  await page.reload()
  await page.getByTestId('nav-edit').click()
  await timelineClip(page, 'source').click()
  await expect(input(page)).toHaveValue(text)
  await page.screenshot({ path: path.join(artifacts, 'saved-subtitle.png') })
  console.log('PASS 实际应用在输入框未失焦时自动保存 IndexedDB 草稿；重载应用后完整恢复文字')
}

async function main() {
  mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false } })
  await server.listen()
  let browser, context, page
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] })
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
    page = await context.newPage()
    const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
    const url = `http://127.0.0.1:${port}`
    await installEditor(page, url)
    await immediateEditing(page)
    await compositionEditing(page)
    await trackStyleEditing(page)
    await draftPersistence(page, url)
    assert.deepEqual(errors, [])
  } catch (error) {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
    throw error
  } finally { await context?.close(); await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
