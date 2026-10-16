const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
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
      const subtitlePixel = [...previewCanvas.getContext('2d').getImageData(52, 102, 1, 1).data]
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
      return { backgroundPixel, subtitlePixel, audioMax, audioDuration: decodedAudio.duration, bytes, progress: [progress[0], progress.at(-1)], cancelName }
    })
    assert(data.backgroundPixel[0] > 140 && data.backgroundPixel[1] < 80, `视频画面未进入预览：${data.backgroundPixel}`)
    assert(data.subtitlePixel[2] > 150 && data.subtitlePixel[0] < 100, `字幕图层未叠加：${data.subtitlePixel}`)
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

    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 850 })
      await page.evaluate(width => { document.querySelector('#app').style.width = width === 320 ? 'calc(100% - 48px)' : '100%'; document.querySelector('#app').style.marginLeft = width === 320 ? '48px' : '0' }, width)
      await page.waitForTimeout(150)
      const sizes = await page.evaluate(() => ({ width: window.innerWidth, body: document.documentElement.scrollWidth, editor: document.querySelector('.video-editor').getBoundingClientRect().width }))
      assert(sizes.body <= sizes.width + 1, `${width}px 页面横向溢出：${JSON.stringify(sizes)}`)
      assert(sizes.editor <= sizes.width + 1)
      const toolbarBounds = await page.locator('.video-editor').evaluate(element => ({ editor: element.getBoundingClientRect().right, button: element.querySelector('.editor-export').getBoundingClientRect().right }))
      assert(toolbarBounds.button <= toolbarBounds.editor + 1, `${width}px 导出按钮被裁切`)
    }
    await page.evaluate(async () => {
      const { createProject, createTextClip } = await import('/src/core/project.ts')
      const { addClip } = await import('/src/core/timeline.ts')
      let project = createProject('切换预览验证', { width: 320, height: 180 })
      project = addClip(project, project.tracks[0].id, createTextClip(project, { start: 0, trimOut: 1, x: 0, y: 0, width: 320, height: 180, text: '', background: '#2244dd' }))
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
