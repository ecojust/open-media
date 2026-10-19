const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')
const path = require('node:path')
const fs = require('node:fs/promises')
const { existsSync } = require('node:fs')

const baseURL = process.env.EDITOR_TEST_URL || 'http://127.0.0.1:5202'
let server
async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(baseURL)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('编辑器测试服务未就绪')
}

async function installTimeline(page, rows) {
  await page.evaluate(async rows => {
    const { createProject, createTextClip, createTrack, validateProject } = await import('/src/core/project.ts')
    const project = createProject('剪辑交互验证', { width: 320, height: 180, fps: 20 })
    project.tracks = rows.map((row, index) => ({
      ...createTrack('text', row.name || `字幕 ${index + 1}`),
      id: `editing-track-${index}`, locked: Boolean(row.locked),
      clips: row.clips.map(clip => createTextClip(project, { text: clip.id, name: clip.id, fontSize: 24, ...clip })),
    }))
    window.editorState.value = validateProject(project, { trusted: true })
    window.editorStatus = ''
    await new Promise(requestAnimationFrame)
    document.querySelector('.timeline-scroll').scrollTo(0, 0)
  }, rows)
}
async function clipState(page, id) {
  return page.evaluate(id => window.editorState.value.tracks.flatMap(track => track.clips).find(clip => clip.id === id), id)
}
async function seekEditor(page, seconds) {
  const ruler = await page.locator('.timeline-ruler').boundingBox()
  await page.mouse.click(ruler.x + seconds * 44, ruler.y + 10)
}
async function dragClip(page, id, seconds, beforeRelease) {
  const bounds = await page.locator(`[data-clip-id="${id}"]`).boundingBox()
  const x = bounds.x + bounds.width / 2, y = bounds.y + 18
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x + seconds * 44, y, { steps: 6 })
  if (beforeRelease) await beforeRelease()
  await page.mouse.up()
}
async function editorLayout(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const bounds = document.querySelector(selector).getBoundingClientRect()
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, height: bounds.height }
    }
    return { editor: rect('.video-editor'), preview: rect('.editor-main'), divider: rect('.timeline-divider'), timeline: rect('.timeline-panel') }
  })
}
async function dragTimelineDivider(page, deltaY) {
  const bounds = await page.getByTestId('timeline-divider').boundingBox()
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x, y + deltaY, { steps: 8 })
  await page.mouse.up()
}

async function main() {
  if (!process.env.EDITOR_TEST_URL) {
    server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5202', '--strictPort'], { cwd: process.cwd(), stdio: 'ignore' })
  }
  await waitForServer()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/editor-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto(`${baseURL}/editor-test`)
    const data = await page.evaluate(async () => {
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
      const { createProject, createClip, createTextClip } = await import('/src/core/project.ts')
      const { addAsset, addClip } = await import('/src/core/timeline.ts')
      const source = document.createElement('canvas'); source.width = 320; source.height = 180
      const sourceContext = source.getContext('2d')
      sourceContext.fillStyle = '#cc2233'; sourceContext.fillRect(0, 0, 320, 180)
      const audioContext = new AudioContext()
      const destination = audioContext.createMediaStreamDestination()
      const oscillator = audioContext.createOscillator(); oscillator.frequency.value = 440
      const gain = audioContext.createGain(); gain.gain.value = 0.15
      oscillator.connect(gain); gain.connect(destination); oscillator.start()
      const stream = source.captureStream(20)
      stream.addTrack(destination.stream.getAudioTracks()[0])
      const chunks = []
      const recording = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' })
      recording.ondataavailable = event => chunks.push(event.data)
      const stopped = new Promise(resolve => { recording.onstop = resolve })
      recording.start(100)
      await new Promise(resolve => setTimeout(resolve, 1600))
      recording.stop(); await stopped
      stream.getTracks().forEach(track => track.stop()); oscillator.stop(); await audioContext.close()
      const sourceBlob = new Blob(chunks, { type: 'video/webm' })
      const sourceUrl = URL.createObjectURL(sourceBlob)
      let project = createProject('多轨音画验证', { width: 320, height: 180, fps: 20 })
      const asset = { id: 'test-video', name: '测试视频.webm', kind: 'video', url: sourceUrl, duration: 1.5, width: 320, height: 180, size: sourceBlob.size, mime: sourceBlob.type }
      project = addAsset(project, asset)
      project = addClip(project, project.tracks[1].id, createClip(asset, project, { trimIn: 0.1, trimOut: 1.3, speed: 1.2 }))
      project = addClip(project, project.tracks[0].id, createTextClip(project, { text: '多轨字幕', trimOut: 1, x: 50, y: 100, width: 220, height: 70, fontSize: 28, background: '#2244dd' }))
      const previewCanvas = document.createElement('canvas'); previewCanvas.width = 320; previewCanvas.height = 180
      const preview = new TimelinePreview(previewCanvas, project)
      await preview.prepare(); await preview.seekReady(0.4)
      const backgroundPixel = [...previewCanvas.getContext('2d').getImageData(5, 5, 1, 1).data]
      const subtitlePixels = previewCanvas.getContext('2d').getImageData(50, 100, 220, 70).data
      let subtitleBackgroundCount = 0, subtitlePixel = []
      for (let index = 0; index < subtitlePixels.length; index += 4) if (subtitlePixels[index + 2] > 150 && subtitlePixels[index] < 100) {
        subtitleBackgroundCount++; subtitlePixel = [...subtitlePixels.slice(index, index + 4)]
      }
      preview.dispose()
      const progress = []
      const exported = await exportTimelineWebM(project, { width: 320, height: 180, fps: 20, onProgress: value => progress.push(value) })
      const bytes = [...new Uint8Array(await exported.arrayBuffer())]
      const decodeContext = new AudioContext()
      const decodedAudio = await decodeContext.decodeAudioData(await exported.arrayBuffer())
      const audioMax = decodedAudio.getChannelData(0).reduce((max, value) => Math.max(max, Math.abs(value)), 0)
      await decodeContext.close()
      const controller = new AbortController()
      const cancelled = exportTimelineWebM(project, { signal: controller.signal })
      window.setTimeout(() => controller.abort(), 180)
      let cancelName = ''
      try { await cancelled } catch (error) { cancelName = error.name }
      window.editorProject = project
      const componentSource = await (await fetch('/src/components/VideoEditor.vue')).text()
      const vueImport = componentSource.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
      const { createApp, h, ref } = await import(vueImport)
      const VideoEditor = (await import('/src/components/VideoEditor.vue')).default
      const state = ref(project)
      window.editorState = state
      createApp({ render: () => h(VideoEditor, { project: state.value, onChange: next => { state.value = next }, onStatus: message => { window.editorStatus = message } }) }).mount('#app')
      return { backgroundPixel, subtitlePixel, subtitleBackgroundCount, audioMax, audioDuration: decodedAudio.duration, bytes, progress: [progress[0], progress.at(-1)], cancelName }
    })
    assert(data.backgroundPixel[0] > 140 && data.backgroundPixel[1] < 80, `视频画面未进入预览：${data.backgroundPixel}`)
    assert(data.subtitlePixel[2] > 150 && data.subtitlePixel[0] < 100, `字幕图层未叠加：${data.subtitlePixel}`)
    assert(data.subtitleBackgroundCount > 500 && data.subtitleBackgroundCount < 220 * 70 / 2, '字幕背景应真实叠加在文字范围内，不填满定位矩形')
    assert(data.audioMax > 0.01, `真实音轨未混入导出：${data.audioMax}`)
    assert(data.audioDuration > 0.2 && data.audioDuration < 1.7, `音轨时长无效：${data.audioDuration}`)
    assert.deepEqual(data.bytes.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3])
    assert.equal(data.progress[1], 1)
    assert.equal(data.cancelName, 'AbortError')
    assert(data.bytes.length > 5000)
    await fs.writeFile('/tmp/open-media-preview-export.webm', Buffer.from(data.bytes))
    console.log('PASS 真实多轨预览、字幕叠加、变速视频、音轨混音、WebM编码与取消')
    await page.locator('.timeline-clip.video').click()
    await page.getByLabel('片段开始时间').fill('2')
    await page.getByLabel('片段开始时间').press('Tab')
    await page.waitForFunction(() => window.editorState.value.tracks[1].clips[0].start === 2)
    await page.locator('.timeline-clip.video').click()
    const lane = await page.locator('.track-lane').nth(1).boundingBox()
    await page.mouse.click(lane.x + 2.5 * 44, lane.y + 58)
    await page.getByTitle('在播放头处分割（S）').click()
    await page.waitForFunction(() => window.editorState.value.tracks[1].clips.length === 2)
    console.log('PASS 片段属性修改与播放头分割通过真实界面回写')
    const firstVideoId = await page.evaluate(() => window.editorState.value.tracks[1].clips[0].id)
    let clipBox = await page.locator(`[data-clip-id="${firstVideoId}"]`).boundingBox()
    await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + 18)
    await page.mouse.down()
    await page.mouse.move(clipBox.x + clipBox.width / 2 + 44, clipBox.y + 18, { steps: 6 })
    await page.mouse.up()
    await page.waitForFunction(id => Math.abs(window.editorState.value.tracks[1].clips.find(clip => clip.id === id).start - 3) < 0.04, firstVideoId)
    const endHandle = await page.locator(`[data-clip-id="${firstVideoId}"] .trim-handle.end`).boundingBox()
    await page.mouse.move(endHandle.x + 4, endHandle.y + 18)
    await page.mouse.down()
    await page.mouse.move(endHandle.x + 26, endHandle.y + 18, { steps: 6 })
    await page.mouse.up()
    await page.waitForFunction(id => Math.abs(window.editorState.value.tracks[1].clips.find(clip => clip.id === id).trimOut - 1.3) < 0.04, firstVideoId)
    await page.getByRole('button', { name: '分离到音轨' }).click()
    await page.waitForFunction(id => window.editorState.value.tracks[2].clips.length === 1 && window.editorState.value.tracks[1].clips.find(clip => clip.id === id).volume === 0, firstVideoId)
    await page.getByRole('button', { name: '画中画', exact: true }).click()
    await page.waitForFunction(id => window.editorState.value.tracks[1].clips.find(clip => clip.id === id).width < 120, firstVideoId)
    console.log('PASS 时间线拖动、源边缘裁剪、分离音轨、画中画属性回写')

    for (const kind of ['video', 'audio']) {
      await page.locator(`.timeline-clip.${kind}`).first().click({ button: 'right' })
      const menu = page.getByRole('menu', { name: '片段操作', exact: true })
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: /^删除并接拢空隙/ })).toBeEnabled()
      await expect(menu.getByRole('menuitem', { name: '文字转语音', exact: true })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    }

    await installTimeline(page, [{ clips: [{ id: 'trim-target', start: 1, trimIn: 2, trimOut: 10, speed: 2 }] }])
    await page.locator('[data-clip-id="trim-target"]').click()
    await seekEditor(page, 2)
    await page.keyboard.press('q')
    await expect.poll(() => clipState(page, 'trim-target')).toMatchObject({ start: 2, trimIn: 4, trimOut: 10, speed: 2 })
    await seekEditor(page, 4)
    await page.keyboard.press('w')
    await expect.poll(() => clipState(page, 'trim-target')).toMatchObject({ start: 2, trimIn: 4, trimOut: 8, speed: 2 })
    await page.getByLabel('字幕内容').fill('qw 是文字输入')
    await page.getByLabel('字幕内容').press('q')
    await page.getByLabel('字幕内容').press('w')
    await page.getByLabel('字幕内容').press('Tab')
    assert.equal((await clipState(page, 'trim-target')).trimIn, 4)
    assert.equal((await clipState(page, 'trim-target')).trimOut, 8)
    console.log('PASS 视频/音频片段右键菜单、Q/W变速裁剪及文字输入快捷键隔离')

    const gapRows = [{ clips: [{ id: 'remove-target', start: 0, trimOut: 2 }, { id: 'later', start: 4, trimOut: 2 }] }, { clips: [{ id: 'overlap', start: 1, trimOut: 2 }] }]
    await installTimeline(page, gapRows)
    await page.locator('[data-clip-id="remove-target"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^删除并接拢空隙/ }).click()
    await expect(page.locator('[data-clip-id="remove-target"]')).toHaveCount(0)
    assert.equal((await clipState(page, 'overlap')).start, 0, '只接拢全轨共同空白，不裁掉跨轨内容')
    assert.equal((await clipState(page, 'later')).start, 3, '删除区间之外的原有空隙应保留')
    await installTimeline(page, gapRows)
    await page.locator('[data-clip-id="remove-target"]').click()
    await page.keyboard.press('Shift+Delete')
    await expect(page.locator('[data-clip-id="remove-target"]')).toHaveCount(0)
    assert.equal((await clipState(page, 'later')).start, 3)
    await installTimeline(page, gapRows)
    await page.getByTestId('timeline-close-gaps').click()
    await expect.poll(async () => (await clipState(page, 'later')).start).toBe(3)
    assert.equal((await clipState(page, 'overlap')).start, 1)
    await installTimeline(page, [{ ...gapRows[0], locked: true }, gapRows[1]])
    const lockedState = await page.evaluate(() => JSON.stringify(window.editorState.value))
    await page.getByTestId('timeline-close-gaps').click()
    await expect.poll(() => page.evaluate(() => window.editorStatus)).toMatch(/锁/)
    assert.equal(await page.evaluate(() => JSON.stringify(window.editorState.value)), lockedState)
    await page.locator('[data-clip-id="remove-target"]').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /^删除片段/ })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: /^删除并接拢空隙/ })).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Delete')
    assert.equal(await page.evaluate(() => JSON.stringify(window.editorState.value)), lockedState)
    console.log('PASS 删除接拢与Shift+Delete保留跨轨内容，全轨空隙整理遇锁轨原子拒绝')

    await installTimeline(page, [{ clips: [{ id: 'near-a', start: 0, trimOut: 2 }, { id: 'near-b', start: 2.1, trimOut: 1 }] }, { clips: [{ id: 'snap-target', start: 5, trimOut: 1 }] }])
    await expect(page.getByTestId('timeline-snap')).toHaveAttribute('aria-pressed', 'true')
    await dragClip(page, 'snap-target', -2.92)
    await expect.poll(async () => (await clipState(page, 'snap-target')).start).toBe(2.1)
    await installTimeline(page, [{ clips: [{ id: 'edge-anchor', start: 8, trimOut: 2 }] }, { clips: [{ id: 'snap-target', start: 3, trimOut: 2 }] }])
    await dragClip(page, 'snap-target', 2.9, async () => { await expect(page.locator('.snap-guide').first()).toBeVisible() })
    await expect.poll(async () => (await clipState(page, 'snap-target')).start).toBe(6)
    await page.getByTestId('timeline-snap').click()
    await expect(page.getByTestId('timeline-snap')).toHaveAttribute('aria-pressed', 'false')
    await dragClip(page, 'snap-target', -0.1)
    await expect.poll(async () => (await clipState(page, 'snap-target')).start).toBe(5.9)
    await page.getByTestId('timeline-snap').click()
    await installTimeline(page, [{ clips: [{ id: 'trim-snap', start: 0, trimOut: 2 }, { id: 'edge-anchor', start: 5, trimOut: 1 }] }])
    const trimHandle = await page.locator('[data-clip-id="trim-snap"] .trim-handle.end').boundingBox()
    await page.mouse.move(trimHandle.x + 3, trimHandle.y + 18); await page.mouse.down()
    await page.mouse.move(trimHandle.x + 3 + 2.9 * 44, trimHandle.y + 18, { steps: 6 })
    await expect(page.locator('.snap-guide').first()).toBeVisible()
    await page.mouse.up()
    await expect.poll(async () => (await clipState(page, 'trim-snap')).trimOut).toBe(5)
    console.log('PASS 吸附选择最近边缘、移动右边缘与裁切边缘吸附、参考线及关闭吸附')

    await installTimeline(page, [{ name: '字幕主轨', clips: [{ id: 'track-content', start: 0, trimOut: 2 }] }, { name: '字幕次轨', clips: [] }])
    const firstTrack = page.locator('[data-track-label-id="editing-track-0"]')
    await firstTrack.locator('.track-name').dblclick()
    await page.getByLabel('轨道名称', { exact: true }).fill('旁白字幕')
    await page.getByLabel('轨道名称', { exact: true }).press('Enter')
    await expect(firstTrack.locator('.track-name > span[title="旁白字幕 · 双击重命名"]')).toHaveText('旁白字幕')
    assert.equal(await page.evaluate(() => window.editorState.value.tracks[0].name), '旁白字幕')
    await firstTrack.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '轨道下移一层', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.editorState.value.tracks.map(track => track.id))).toEqual(['editing-track-1', 'editing-track-0'])
    await firstTrack.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除轨道', exact: true }).click()
    const trackDialog = page.getByRole('dialog', { name: '删除轨道', exact: true })
    await expect(trackDialog).toBeVisible()
    await trackDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('[data-clip-id="track-content"]')).toHaveCount(1)
    await firstTrack.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除轨道', exact: true }).click()
    await trackDialog.getByRole('button', { name: '删除轨道', exact: true }).click()
    await expect(firstTrack).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.editorState.value.tracks.length), 1)
    console.log('PASS 轨道重命名、层级下移、删除含内容轨道可取消并确认')

    await installTimeline(page, [{ name: '工具栏字幕轨道', clips: [] }])
    const clipTools = page.locator('.timeline-clip-tools')
    await expect(clipTools.getByRole('button')).toHaveCount(11)
    const watermarkButton = clipTools.getByRole('button', { name: '添加水印', exact: true })
    await expect(watermarkButton).toBeVisible()
    assert.equal(await watermarkButton.evaluate(button => button.previousElementSibling?.textContent.trim()), '字幕')
    const musicButton = clipTools.getByRole('button', { name: '背景音乐', exact: true })
    await expect(musicButton).toBeVisible()
    assert.equal(await musicButton.evaluate(button => button.previousElementSibling?.textContent.trim()), '水印')
    const introButton = clipTools.getByRole('button', { name: '片头', exact: true })
    const outroButton = clipTools.getByRole('button', { name: '片尾', exact: true })
    await expect(introButton).toBeVisible()
    await expect(outroButton).toBeVisible()
    assert.equal(await introButton.evaluate(button => button.previousElementSibling?.textContent.trim()), '背景音乐')
    assert.equal(await outroButton.evaluate(button => button.previousElementSibling?.textContent.trim()), '片头')
    const transitionButton = clipTools.getByRole('button', { name: '转场', exact: true })
    await expect(transitionButton).toBeVisible()
    assert.equal(await transitionButton.evaluate(button => button.previousElementSibling?.textContent.trim()), '片尾')
    await expect(transitionButton.locator('svg')).toHaveCount(1)
    await expect(page.locator('.editor-tools').getByRole('button')).toHaveCount(6)
    await expect(page.locator('.editor-tools').getByRole('button', { name: '剪辑优化', exact: true })).toBeVisible()
    await expect(page.locator('.editor-tools').getByTestId('editor-mcp-open')).toBeVisible()
    await expect(page.locator('.editor-tools').getByRole('button', { name: '字幕', exact: true })).toHaveCount(0)
    await clipTools.getByRole('button', { name: '字幕', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.editorState.value.tracks[0].clips.length)).toBe(1)
    const addedTextId = await page.evaluate(() => window.editorState.value.tracks[0].clips[0].id)
    await seekEditor(page, 1)
    await clipTools.getByTitle('裁掉播放头左侧（Q）', { exact: true }).click()
    await expect.poll(() => clipState(page, addedTextId)).toMatchObject({ start: 1, trimIn: 1, trimOut: 5 })
    await seekEditor(page, 3)
    await clipTools.getByTitle('裁掉播放头右侧（W）', { exact: true }).click()
    await expect.poll(() => clipState(page, addedTextId)).toMatchObject({ start: 1, trimIn: 1, trimOut: 3 })
    await seekEditor(page, 2)
    await clipTools.getByTitle('在播放头处分割（S）', { exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.editorState.value.tracks[0].clips.length)).toBe(2)
    await clipTools.getByRole('button', { name: '复制片段', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.editorState.value.tracks[0].clips.length)).toBe(3)
    await clipTools.getByRole('button', { name: '删除片段', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.editorState.value.tracks[0].clips.length)).toBe(2)
    await expect(clipTools.getByRole('button', { name: '复制片段', exact: true })).toBeDisabled()
    await expect(clipTools.getByRole('button', { name: '删除片段', exact: true })).toBeDisabled()
    console.log('PASS 字幕、分割、两侧裁剪、复制与删除集中在时间线工具栏并实际修改片段')

    await installTimeline(page, Array.from({ length: 12 }, (_, index) => ({ name: `轨道 ${index + 1}`, clips: [{ id: `resize-track-${index}`, start: 0, trimOut: 2 }] })))
    const divider = page.getByTestId('timeline-divider')
    await expect(divider).toHaveAttribute('role', 'separator')
    await expect(divider).toHaveAttribute('aria-controls', 'editor-timeline')
    const defaultTimelineHeight = (await editorLayout(page)).timeline.height
    await dragTimelineDivider(page, -120)
    await expect.poll(async () => Math.round((await editorLayout(page)).timeline.height - defaultTimelineHeight)).toBe(120)
    await dragTimelineDivider(page, 80)
    await expect.poll(async () => Math.round((await editorLayout(page)).timeline.height - defaultTimelineHeight)).toBe(40)
    await divider.press('ArrowUp')
    await expect.poll(async () => Math.round((await editorLayout(page)).timeline.height - defaultTimelineHeight)).toBe(52)
    await divider.press('ArrowDown')
    await expect.poll(async () => Math.round((await editorLayout(page)).timeline.height - defaultTimelineHeight)).toBe(40)
    await divider.press('Home')
    await expect.poll(async () => Math.round((await editorLayout(page)).timeline.height)).toBe(150)
    await divider.press('End')
    await expect.poll(async () => Math.round((await editorLayout(page)).preview.height)).toBe(180)
    await divider.dblclick()
    await expect.poll(async () => Math.round((await editorLayout(page)).timeline.height - defaultTimelineHeight)).toBe(0)
    assert(await page.locator('.timeline-scroll').evaluate(element => element.scrollHeight > element.clientHeight), '多轨内容必须在时间线内滚动')
    await page.locator('.timeline-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(page.locator('[data-clip-id="resize-track-11"]')).toBeInViewport()
    assert(Math.abs((await editorLayout(page)).timeline.height - defaultTimelineHeight) < 1, '多轨滚动不应改变面板分配高度')
    await page.locator('.timeline-scroll').evaluate(element => { element.scrollTop = 0 })
    console.log('PASS 预览与时间线拖动分配高度、键盘边界与微调、双击复位及多轨内部滚动')

    await installTimeline(page, Array.from({ length: 12 }, (_, index) => ({ clips: [{ id: `wheel-track-${index}`, start: 0, trimOut: 200 }] })))
    const zoomSlider = page.getByLabel('时间线缩放', { exact: true }), timelineScroller = page.locator('.timeline-scroll')
    const zoomValue = async () => Number(await zoomSlider.inputValue())
    const settleZoom = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const scrollBounds = await timelineScroller.boundingBox(), wheelPoint = { x: scrollBounds.x + 400, y: scrollBounds.y + 70 }
    const pointerTime = () => timelineScroller.evaluate((element, x) => (element.scrollLeft + x - element.getBoundingClientRect().left - 140) / Number(document.querySelector('[aria-label="时间线缩放"]').value), wheelPoint.x)
    const assertWheelAnchor = async (before, label) => assert(Math.abs((await pointerTime()) - before) * await zoomValue() <= 2, `${label}：鼠标下的时间位置应保持不变`)
    const dispatchWheels = (deltaY, deltaMode = 0, count = 1) => timelineScroller.evaluate((element, options) => {
      const cancelled = []
      for (let i = 0; i < options.count; i++) cancelled.push(!element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, clientX: options.x, clientY: options.y, deltaY: options.deltaY, deltaMode: options.deltaMode })))
      return cancelled
    }, { ...wheelPoint, deltaY, deltaMode, count })
    await page.evaluate(() => { window.zoomOriginalProject = window.editorState.value })
    await zoomSlider.fill('44'); await settleZoom()
    let anchorTime = await pointerTime()
    await page.mouse.move(wheelPoint.x, wheelPoint.y)
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -90); await page.keyboard.up('Control')
    await expect.poll(zoomValue).toBeGreaterThan(44); await settleZoom()
    await assertWheelAnchor(anchorTime, 'Ctrl + 上滚放大')
    const enlargedZoom = await zoomValue()
    anchorTime = await pointerTime()
    await page.keyboard.down('Control'); await page.mouse.wheel(0, 60); await page.keyboard.up('Control')
    await expect.poll(zoomValue).toBeLessThan(enlargedZoom); await settleZoom()
    await assertWheelAnchor(anchorTime, 'Ctrl + 下滚缩小')
    assert.equal(await timelineScroller.evaluate(element => element.scrollTop), 0, 'Ctrl + 滚轮不能同时纵向滚动轨道')

    await timelineScroller.evaluate(element => { element.scrollLeft = 1100 })
    await settleZoom(); anchorTime = await pointerTime()
    let beforeZoom = await zoomValue()
    assert.deepEqual(await dispatchWheels(-20, 0, 6), Array(6).fill(true), '快速 Ctrl + 滚轮应阻止默认页面缩放')
    await expect.poll(zoomValue).toBeGreaterThan(beforeZoom); await settleZoom()
    assert(Math.abs(await zoomValue() - beforeZoom * Math.exp(120 * 0.002)) < 0.001, '同一帧内的连续滚轮应累计，不能丢失缩放量')
    await assertWheelAnchor(anchorTime, '已横向滚动后的快速连续缩放')
    for (const [deltaMode, deltaY] of [[1, -3], [2, 0.5]]) {
      anchorTime = await pointerTime(); beforeZoom = await zoomValue()
      const pixels = deltaY * (deltaMode === 1 ? 16 : await timelineScroller.evaluate(element => element.clientHeight))
      await dispatchWheels(deltaY, deltaMode); await settleZoom()
      assert(Math.abs(await zoomValue() - beforeZoom * Math.exp(-Math.max(-240, Math.min(240, pixels)) * 0.002)) < 0.001, `deltaMode=${deltaMode} 应按行或页归一化`)
      await assertWheelAnchor(anchorTime, `deltaMode=${deltaMode} 缩放`)
    }
    beforeZoom = await zoomValue()
    await page.mouse.wheel(0, 160)
    await expect.poll(() => timelineScroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    const beforeHorizontal = await timelineScroller.evaluate(element => element.scrollLeft)
    await page.mouse.wheel(120, 0)
    await expect.poll(() => timelineScroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(beforeHorizontal)
    assert.equal(await zoomValue(), beforeZoom, '不按 Ctrl 时保留普通纵向和横向滚动，不修改缩放')
    await dispatchWheels(-10000, 0, 20); await settleZoom()
    assert.equal(await zoomValue(), 160, '放大不得超过现有上限')
    await dispatchWheels(10000, 0, 20); await settleZoom()
    assert.equal(await zoomValue(), 6, '缩小不得低于现有下限')
    assert(await page.evaluate(() => window.editorState.value === window.zoomOriginalProject), '滚动和缩放不能修改工程或提交编辑历史')
    await zoomSlider.fill('44'); await settleZoom()
    await timelineScroller.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0 })
    await page.mouse.move(scrollBounds.x + 220, scrollBounds.y + 40); await page.mouse.down()
    await dispatchWheels(-120); await settleZoom()
    assert.equal(await zoomValue(), 44, '片段拖拽期间不能改变缩放，避免片段位置跳动')
    await page.mouse.up()
    assert(await page.evaluate(() => window.editorState.value === window.zoomOriginalProject), '无位移的拖拽与滚轮不能提交编辑历史')
    console.log('PASS Ctrl + 滚轮缩放及鼠标时间锚点、横向滚动后连续缩放、行/页归一化、比例边界和拖拽隔离，普通滚动与工程内容保持原样')

    const projectSettingsButton = page.getByRole('button', { name: '项目设置', exact: true })
    const settingsBounds = await projectSettingsButton.boundingBox(), exportBounds = await page.getByTestId('export-project').boundingBox()
    assert(settingsBounds.x + settingsBounds.width <= exportBounds.x, '项目设置按钮应位于导出视频左侧')
    assert.equal((await projectSettingsButton.textContent()).trim(), '', '项目设置使用独立图标')
    await expect(projectSettingsButton.locator('svg')).toHaveCount(1)
    for (const title of ['项目设置', '文字转语音']) {
      await page.locator('.editor-tools').getByRole('button', { name: title, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await expect(dialog).toBeVisible()
      await expect(divider).toHaveAttribute('aria-disabled', 'true')
      const heightBefore = (await editorLayout(page)).timeline.height
      const handle = await divider.boundingBox(), dialogBounds = await dialog.boundingBox()
      await page.mouse.move(handle.x + 20, handle.y + handle.height / 2); await page.mouse.down()
      await page.mouse.move(handle.x + 20, handle.y - 70, { steps: 5 })
      assert(Math.abs((await editorLayout(page)).timeline.height - heightBefore) < 1, `${title}打开时不能拖动底层时间线`)
      await page.mouse.move(dialogBounds.x + dialogBounds.width / 2, dialogBounds.y + 20); await page.mouse.up()
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: `关闭${title}`, exact: true }).click()
      await expect(dialog).not.toBeVisible()
      await expect(divider).not.toHaveAttribute('aria-disabled', 'true')
    }
    console.log('PASS 项目设置图标位置以及项目设置、配音弹窗隔离底层时间线拖动')

    await installTimeline(page, [{ name: '开场字幕', clips: [{ id: 'responsive-menu', name: '开场介绍', text: '欢迎开始制作视频', start: 0, trimOut: 2 }] }])
    await fs.mkdir('/tmp/open-media-editor-efficiency', { recursive: true })

    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 850 })
      await page.evaluate(width => { document.querySelector('#app').style.width = width === 320 ? 'calc(100% - 48px)' : '100%'; document.querySelector('#app').style.marginLeft = width === 320 ? '48px' : '0' }, width)
      await page.waitForTimeout(150)
      const sizes = await page.evaluate(() => ({ width: window.innerWidth, body: document.documentElement.scrollWidth, editor: document.querySelector('.video-editor').getBoundingClientRect().width }))
      assert(sizes.body <= sizes.width + 1, `${width}px 页面横向溢出：${JSON.stringify(sizes)}`)
      assert(sizes.editor <= sizes.width + 1)
      const toolbarBounds = await page.locator('.video-editor').evaluate(element => ({ editor: element.getBoundingClientRect().right, button: element.querySelector('.editor-export').getBoundingClientRect().right }))
      assert(toolbarBounds.button <= toolbarBounds.editor + 1, `${width}px 导出按钮被裁切`)
      const timelineToolbar = page.locator('.timeline-toolbar')
      await expect(timelineToolbar.getByRole('button')).toHaveCount(19)
      if (width === 320) {
        assert(await timelineToolbar.evaluate(element => element.scrollWidth > element.clientWidth), '窄屏应允许横向滚动时间线工具栏')
        const controls = timelineToolbar.locator('button,input')
        for (const control of await controls.all()) {
          await control.scrollIntoViewIfNeeded()
          await expect(control).toBeVisible()
          const bounds = await control.boundingBox(), toolbar = await timelineToolbar.boundingBox()
          assert(bounds.x >= toolbar.x - 1 && bounds.x + bounds.width <= toolbar.x + toolbar.width + 1, `窄屏无法滚动访问时间线工具：${await control.getAttribute('title') || await control.getAttribute('aria-label')}`)
        }
        await timelineToolbar.evaluate(element => { element.scrollLeft = 0 })
      }
      await page.locator('[data-clip-id="responsive-menu"]').click({ button: 'right' })
      const menu = page.getByRole('menu', { name: '文字片段操作', exact: true })
      const menuBounds = await menu.boundingBox()
      assert(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width + 1 && menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 851, `${width}px 片段菜单超出视口：${JSON.stringify(menuBounds)}`)
      if (width === 1280 || width === 320) await page.screenshot({ path: `/tmp/open-media-editor-efficiency/${width === 1280 ? 'desktop' : 'compact'}.png` })
      await page.keyboard.press('Escape')
      await page.locator('[data-track-label-id="editing-track-0"]').click({ button: 'right' })
      const trackMenuBounds = await page.getByRole('menu', { name: '轨道操作', exact: true }).boundingBox()
      assert(trackMenuBounds.x >= 0 && trackMenuBounds.x + trackMenuBounds.width <= width + 1 && trackMenuBounds.y >= 0 && trackMenuBounds.y + trackMenuBounds.height <= 851, `${width}px 轨道菜单超出视口：${JSON.stringify(trackMenuBounds)}`)
      await page.keyboard.press('Escape')
    }
    for (const viewport of [{ width: 1280, height: 480 }, { width: 768, height: 430 }, { width: 320, height: 430 }, { width: 1280, height: 300 }]) {
      await page.setViewportSize(viewport)
      await page.evaluate(width => { document.querySelector('#app').style.width = width === 320 ? 'calc(100% - 48px)' : '100%'; document.querySelector('#app').style.marginLeft = width === 320 ? '48px' : '0' }, viewport.width)
      await divider.press('Enter')
      await dragTimelineDivider(page, -400)
      const layout = await editorLayout(page), availableHeight = layout.preview.height + layout.timeline.height
      assert(layout.preview.height >= Math.min(180, availableHeight * 180 / 330) - 1, `缩小窗口后预览失去可用空间：${JSON.stringify({ viewport, layout })}`)
      assert(layout.timeline.height >= Math.min(150, availableHeight * 150 / 330) - 1, `缩小窗口后时间线失去可用空间：${JSON.stringify({ viewport, layout })}`)
      assert(layout.timeline.bottom <= viewport.height + 1 && layout.preview.bottom <= layout.divider.top + 1, `缩小窗口后面板溢出可视区：${JSON.stringify({ viewport, layout })}`)
      const button = await page.getByTestId('export-project').boundingBox()
      assert(button.x >= layout.editor.left && button.x + button.width <= layout.editor.right + 1, '缩小窗口后导出按钮必须完整可见')
    }
    await page.setViewportSize({ width: 320, height: 850 })
    await page.evaluate(() => { document.querySelector('#app').style.width = 'calc(100% - 48px)'; document.querySelector('#app').style.marginLeft = '48px' })
    await divider.press('Enter')
    console.log('PASS 宽窄与矮窗口下拖动限制、面板不越出视区以及导出按钮保持可见')
    await page.evaluate(async () => {
      const { createProject, createTextClip } = await import('/src/core/project.ts')
      const { addClip } = await import('/src/core/timeline.ts')
      let project = createProject('切换预览验证', { width: 320, height: 180 })
      project = addClip(project, project.tracks[0].id, createTextClip(project, { start: 0, trimOut: 1, x: 0, y: 0, width: 320, height: 180, textRole: 'watermark', text: '', background: '#2244dd' }))
      project = addClip(project, project.tracks[0].id, createTextClip(project, { start: 5, trimOut: 1, text: '尾部' }))
      window.editorState.value = project
    })
    await page.waitForFunction(() => {
      const pixel = document.querySelector('[data-testid=video-preview]').getContext('2d').getImageData(2, 2, 1, 1).data
      return pixel[2] > 150 && pixel[0] < 100 && document.querySelector('.time-code').textContent.startsWith('00:00:00')
    })
    console.log('PASS 切换项目同步重置播放头与实际预览画面')
    await page.evaluate(() => {
      document.querySelector('#app').style.setProperty('--ui-bg', '#151923')
      document.querySelector('#app').style.setProperty('--ui-surface', '#1d2230')
      document.querySelector('#app').style.setProperty('--ui-text', '#e3e8f2')
    })
    const theme = await page.locator('.video-editor').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, text: getComputedStyle(element).color }))
    assert.equal(theme.background, 'rgb(21, 25, 35)')
    assert.equal(theme.text, 'rgb(227, 232, 242)')
    assert.deepEqual(errors, [])
    console.log('PASS 编辑器 1280 / 768 / 320 像素布局与深色主题')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => server?.kill())
