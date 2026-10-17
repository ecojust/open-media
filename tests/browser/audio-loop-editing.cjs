const assert = require('node:assert/strict')
const { existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'audio-loop-editing') : '/tmp/open-media-audio-loop-editing'
const timelineClip = (page, id) => page.locator(`.timeline-clip[data-clip-id="${id}"]`)
const state = page => page.evaluate(() => window.loopFixture.state.value)
const clip = async (page, id = 'audio') => (await state(page)).tracks.flatMap(track => track.clips).find(item => item.id === id)
const changes = page => page.evaluate(() => window.loopFixture.changes.length)
const durationField = page => page.getByLabel('片段时长', { exact: true })

async function mount(page, url) {
  await page.route('**/audio-loop-editing-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/audio-loop-editing-test`)
  await page.evaluate(async () => {
    const { createProject, createTrack, createClip, validateProject } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueImport)
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    const sampleRate = 24000, frames = sampleRate * 4
    const bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes)
    const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVEfmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    text(36, 'data'); view.setUint32(40, frames * 2, true)
    for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 6000), true)
    const audioBlob = new Blob([bytes], { type: 'audio/wav' })
    const context = new AudioContext({ sampleRate }), decoded = await context.decodeAudioData(bytes.slice(0)); await context.close()
    const audio = { id: 'asset-audio', kind: 'audio', name: '四秒配音.wav', url: URL.createObjectURL(audioBlob), duration: decoded.duration, width: 0, height: 0, mime: audioBlob.type, size: audioBlob.size }
    const videoBlob = await (await fetch('/watermarks/cursor-click.mp4')).blob()
    const videoUrl = URL.createObjectURL(videoBlob), media = document.createElement('video')
    media.src = videoUrl; media.preload = 'auto'; media.muted = true
    await new Promise((resolve, reject) => { media.onloadeddata = resolve; media.onerror = () => reject(new Error('真实视频素材无法解码')); media.load() })
    const video = { id: 'asset-video', kind: 'video', name: '真实视频.mp4', url: videoUrl, duration: media.duration, width: media.videoWidth, height: media.videoHeight, mime: 'video/mp4', size: videoBlob.size }
    media.removeAttribute('src'); media.load()
    const project = createProject('音频延长与恢复验证', { width: 320, height: 180, fps: 20 })
    const sound = createTrack('audio', '配音轨道'); sound.id = 'audio-track'
    sound.clips = [createClip(audio, project, { id: 'audio', start: 1, trimIn: 1, trimOut: 4, volume: 0.65, generatedAt: '2026-10-17T01:02:03.000Z' })]
    const visual = createTrack('video', '视频轨道'); visual.id = 'video-track'
    visual.clips = [createClip(video, project, { id: 'video', start: 0 })]
    project.assets = [audio, video]; project.tracks = [sound, visual]
    const current = shallowRef(validateProject(project, { trusted: true })), editor = ref(null)
    let history = createHistory(current.value)
    const fixture = window.loopFixture = {
      state: current, editor, changes: [], messages: [], nextTick,
      reset() { current.value = validateProject(project, { trusted: true }); history = createHistory(current.value); this.changes.splice(0); this.messages.splice(0) },
      undo() { history = undoHistory(history); current.value = history.present },
      redo() { history = redoHistory(history); current.value = history.present },
    }
    fixture.app = createApp({ render: () => h(Editor, { ref: editor, project: current.value,
      onChange: (next, label) => { fixture.changes.push({ label }); history = commitHistory(history, next); current.value = next },
      onStatus: message => fixture.messages.push(message),
    }) })
    fixture.app.mount('#app'); await nextTick(); editor.value.seek(1)
  })
  await expect(timelineClip(page, 'audio')).toBeVisible()
  await expect(page.getByTestId('video-preview')).toBeVisible()
  await page.getByLabel('时间线缩放', { exact: true }).fill('40')
  if (await page.getByTestId('timeline-snap').getAttribute('aria-pressed') === 'true') await page.getByTestId('timeline-snap').click()
}

async function reset(page) {
  await page.keyboard.press('Escape')
  await page.evaluate(async () => { window.loopFixture.reset(); await window.loopFixture.nextTick(); window.loopFixture.editor.value.seek(1) })
  await timelineClip(page, 'audio').click()
}
async function dragEnd(page, id, extraSeconds) {
  const handle = timelineClip(page, id).locator('.trim-handle.end')
  await handle.scrollIntoViewIfNeeded()
  const box = await handle.boundingBox(), zoom = Number(await page.getByLabel('时间线缩放', { exact: true }).inputValue())
  assert(box, '片段右边界应可拖动')
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x + extraSeconds * zoom, y, { steps: 8 }); await page.mouse.up()
}
async function setDuration(page, value) { await durationField(page).fill(String(value)); await durationField(page).press('Tab') }

async function editingChecks(page) {
  await reset(page)
  const original = await clip(page), originalVideo = await clip(page, 'video'), count = await changes(page)
  await dragEnd(page, 'audio', 2)
  await expect(durationField(page)).toHaveValue('5')
  const extended = await clip(page)
  assert.equal(extended.trimIn, 1); assert.equal(extended.trimOut, 6)
  assert.equal(extended.start, 1); assert.equal(extended.generatedAt, original.generatedAt)
  assert.equal(await changes(page), count + 1, '一轮拖拽应只产生一次历史提交')
  assert.deepEqual(await clip(page, 'video'), originalVideo)
  await page.evaluate(() => window.loopFixture.undo())
  assert.deepEqual(await clip(page), original)
  await expect(durationField(page)).toHaveValue('3')
  await page.evaluate(() => window.loopFixture.redo())
  assert.deepEqual(await clip(page), extended)
  await expect(durationField(page)).toHaveValue('5')
  console.log('PASS 音频片段右边界可拖过源时长，位置和其他视频保持原样；单步撤销/重做恢复')

  await setDuration(page, 9)
  await expect(durationField(page)).toHaveValue('9')
  assert.equal((await clip(page)).trimOut, 10, '属性时长应允许延长为多个源周期')
  await page.getByLabel('播放速度', { exact: true }).selectOption('1.25')
  const beforeRestore = await clip(page), beforeRestoreCount = await changes(page)
  await timelineClip(page, 'audio').click({ button: 'right' })
  await expect(page.getByTestId('restore-audio-length')).toBeEnabled()
  await expect(page.getByTestId('restore-audio-length')).toHaveText('恢复原长度')
  await page.getByTestId('restore-audio-length').click()
  const restored = await clip(page)
  assert.equal(restored.trimIn, 0); assert.equal(restored.trimOut, 4)
  assert.equal(restored.start, beforeRestore.start); assert.equal(restored.speed, 1.25); assert.equal(restored.volume, beforeRestore.volume)
  assert.equal(restored.generatedAt, beforeRestore.generatedAt)
  await expect(durationField(page)).toHaveValue('3.2')
  assert.equal(await changes(page), beforeRestoreCount + 1)
  await expect(page.getByRole('menu', { name: '片段操作', exact: true })).toHaveCount(0)
  await page.evaluate(() => window.loopFixture.undo())
  assert.deepEqual(await clip(page), beforeRestore)
  await page.evaluate(() => window.loopFixture.redo())
  assert.deepEqual(await clip(page), restored)
  console.log('PASS 属性可输入超过源长度的时长；右键恢复完整源长度，保留位置、速度、音量并支持撤销/重做')
}

async function lockAndVideoChecks(page) {
  await reset(page)
  await setDuration(page, 7)
  const track = page.locator('[data-track-row-id="audio-track"]')
  await track.getByRole('button', { name: '锁定轨道', exact: true }).click()
  await expect(durationField(page)).toBeDisabled()
  await timelineClip(page, 'audio').click({ button: 'right' })
  await expect(page.getByTestId('restore-audio-length')).toBeDisabled()
  await page.keyboard.press('Escape')
  const locked = await clip(page), lockedCount = await changes(page)
  await dragEnd(page, 'audio', 2)
  assert.deepEqual(await clip(page), locked)
  assert.equal(await changes(page), lockedCount, '锁定后拖动不得写入项目')
  await track.getByRole('button', { name: '解锁轨道', exact: true }).click()
  await expect(durationField(page)).toBeEnabled()
  await timelineClip(page, 'audio').click({ button: 'right' })
  await expect(page.getByTestId('restore-audio-length')).toBeEnabled()
  await page.getByTestId('restore-audio-length').click()
  assert.equal((await clip(page)).trimOut, 4)
  console.log('PASS 锁定音轨同时禁止延长、时长输入和恢复；解锁后恢复操作重新可用')

  await reset(page)
  await timelineClip(page, 'video').click()
  const original = await clip(page, 'video')
  await dragEnd(page, 'video', 3)
  assert.deepEqual(await clip(page, 'video'), original, '视频右边界必须仍停在源终点')
  await timelineClip(page, 'video').click({ button: 'right' })
  await expect(page.getByTestId('restore-audio-length')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await setDuration(page, original.trimOut + 5)
  assert.deepEqual(await clip(page, 'video'), original, '视频属性输入不得绕过源时长上限')
  assert.ok((await page.evaluate(() => window.loopFixture.messages)).some(message => /时长|源|裁剪/.test(message)), '无效视频长度应有反馈')
  console.log('PASS 视频保持源时长限制，拖拽与属性输入均不能超出，菜单不显示音频恢复操作')
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false }, logLevel: 'error' })
  await server.listen()
  let browser, page
  try {
    mkdirSync(artifacts, { recursive: true })
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); page.setDefaultTimeout(15000)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await mount(page, server.resolvedUrls.local[0].replace(/\/$/, ''))
    await editingChecks(page)
    await lockAndVideoChecks(page)
    await page.screenshot({ path: path.join(artifacts, 'editing.png'), animations: 'disabled' })
    assert.deepEqual(errors, [])
  } catch (error) {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), animations: 'disabled' }).catch(() => {})
    throw error
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
