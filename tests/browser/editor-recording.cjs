const assert = require('node:assert/strict')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const net = require('node:net')
const { join } = require('node:path')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

const artifacts = process.env.BROWSER_ARTIFACTS ? join(process.env.BROWSER_ARTIFACTS, 'editor-recording') : '/tmp/open-media-editor-recording'

// Only the device source and file chooser are supplied by the test. Recording,
// encoding, importing, decoding and project persistence use the application.
async function installDevices(page) {
  await page.addInitScript(() => {
    const state = { mode: 'ready', requests: [], contexts: [], pending: [], saves: 0, opens: 0 }
    window.recordingFixture = state
    async function tone() {
      const context = new AudioContext({ sampleRate: 48000 })
      const oscillator = context.createOscillator(), gain = context.createGain()
      const output = context.createMediaStreamDestination()
      oscillator.frequency.value = 523.25; gain.gain.value = 0.2
      oscillator.connect(gain).connect(output); oscillator.start()
      await context.resume()
      state.contexts.push(context)
      return output.stream
    }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
      const request = { constraints, stream: null }
      state.requests.push(request)
      if (state.mode === 'denied') throw new DOMException('Microphone permission denied', 'NotAllowedError')
      if (state.mode === 'pending') await new Promise(resolve => state.pending.push(resolve))
      request.stream = await tone()
      return request.stream
    } })
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      throw new Error('剪辑录音不应请求屏幕录制')
    } })
    window.showSaveFilePicker = async () => {
      state.saves++
      return (await navigator.storage.getDirectory()).getFileHandle('recording-project.omedia', { create: true })
    }
    window.showOpenFilePicker = async () => {
      state.opens++
      return [await (await navigator.storage.getDirectory()).getFileHandle('recording-project.omedia')]
    }
  })
}

async function savedProject(page, expectedAssets) {
  await expect.poll(async () => page.evaluate(async () => {
    const id = localStorage.getItem('open-media:last-project')
    if (!id) return -1
    const { loadProject } = await import('/src/core/storage.ts')
    try { const loaded = await loadProject(id); const count = loaded.project.assets.length; loaded.revoke(); return count } catch { return -1 }
  }), { timeout: 20000 }).toBe(expectedAssets)
  return page.evaluate(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    const loaded = await loadProject(localStorage.getItem('open-media:last-project'))
    try { return loaded.project } finally { loaded.revoke() }
  })
}

async function verifyAudio(page, asset) {
  const decoded = await page.evaluate(async id => {
    const { loadProject } = await import('/src/core/storage.ts')
    const loaded = await loadProject(localStorage.getItem('open-media:last-project'))
    const context = new AudioContext({ sampleRate: 48000 })
    try {
      const asset = loaded.project.assets.find(item => item.id === id)
      const blob = loaded.blobs.get(id)
      if (!blob) throw new Error('录音缺少可恢复的音频文件')
      const audio = await context.decodeAudioData(await blob.arrayBuffer())
      const samples = audio.getChannelData(0)
      const from = Math.floor(samples.length * 0.2), to = Math.floor(samples.length * 0.8)
      let square = 0
      for (let i = from; i < to; i++) square += samples[i] ** 2
      return { duration: audio.duration, sampleRate: audio.sampleRate, channels: audio.numberOfChannels,
        rms: Math.sqrt(square / (to - from)), size: blob.size, mime: blob.type, assetDuration: asset.duration }
    } finally { await context.close(); loaded.revoke() }
  }, asset.id)
  assert(decoded.size > 1000, `录音应包含实际编码音频：${JSON.stringify(decoded)}`)
  assert(decoded.duration >= 0.8 && decoded.duration < 5, `录音解码时长错误：${JSON.stringify(decoded)}`)
  assert(Math.abs(decoded.duration - decoded.assetDuration) < 0.15, `素材时长应与实际解码一致：${JSON.stringify(decoded)}`)
  assert(decoded.rms > 0.08 && decoded.rms < 0.18, `录音应包含真实麦克风音源波形：${JSON.stringify(decoded)}`)
  return decoded
}

async function devicesReleased(page) {
  await expect.poll(() => page.evaluate(() => window.recordingFixture.requests.every(request =>
    !request.stream || request.stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true)
}

async function busyControls(page) {
  await expect(page.getByTestId('save-project')).toBeDisabled()
  await expect(page.getByTestId('save-as-project')).toBeDisabled()
  for (const workspace of ['record', 'gif', 'video', 'image']) await expect(page.getByTestId(`nav-${workspace}`)).toBeDisabled()
  await expect(page.getByTestId('preview-play')).toBeDisabled()
  assert(await page.locator('.timeline-panel').evaluate(element => element.inert || !!element.closest('[inert]')), '录音期间时间线应禁止编辑')
  await page.keyboard.press('Control+s')
  assert.equal(await page.evaluate(() => window.recordingFixture.saves), 0, '录音期间保存快捷键不得绕过禁用状态')
  await expect(page.getByTestId('video-editor')).toBeVisible()
}

async function record(page, { checkBusy = false } = {}) {
  const button = page.getByTestId('preview-record')
  await button.click()
  await expect(button).toHaveAttribute('aria-label', '停止录音')
  if (checkBusy) await busyControls(page)
  await expect(page.getByTestId('preview-record-status')).toContainText(/00:0[1-9]/, { timeout: 5000 })
  await button.click()
  await expect(button).toHaveAttribute('aria-label', '开始录音', { timeout: 20000 })
  await expect(page.getByTestId('save-project')).toBeEnabled()
  await devicesReleased(page)
  const play = page.getByTestId('preview-play')
  await expect(play).toHaveAttribute('aria-busy', 'false')
  await play.click()
  await expect(play).toHaveAttribute('title', '暂停（空格）')
  await page.waitForTimeout(120)
  await play.click()
  await expect(play).toHaveAttribute('title', '播放（空格）')
}

const narrationTracks = project => project.tracks.filter(track => track.name === '配音轨道')
const lastAudio = project => project.assets.at(-1)
const lastClip = project => project.tracks.flatMap(track => track.clips).find(clip => clip.assetId === lastAudio(project).id)

async function synchronizedPicture(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await installDevices(page)
    await page.route('**/recording-picture-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto(`${url}/recording-picture-test`)
    await page.evaluate(async () => {
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
      const { createApp, h, ref, nextTick } = await import(vueImport)
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      const { createProject, createTextClip } = await import('/src/core/project.ts')
      const { addClip } = await import('/src/core/timeline.ts')
      let project = createProject('同步画面验证', { width: 320, height: 180 })
      for (const [start, end, background] of [[0, 1, '#cc2233'], [1, 0.3, '#2244dd']]) {
        project = addClip(project, project.tracks[0].id, createTextClip(project, { start, trimOut: end, background, text: '', x: 0, y: 0, width: 320, height: 180 }))
      }
      const current = ref(project), editor = ref(null), messages = []
      createApp({ render: () => h(Editor, { ref: editor, project: current.value, onChange: value => { current.value = value }, onStatus: value => messages.push(value) }) }).mount('#app')
      await nextTick(); editor.value.seek(0.4)
      window.pictureRecording = { current, editor, messages }
      window.recordingFixture.mode = 'pending'
    })
    const pixel = () => page.getByTestId('video-preview').evaluate(canvas => [...canvas.getContext('2d').getImageData(5, 5, 1, 1).data].slice(0, 3))
    const initial = await page.locator('.ruler-label').innerText()
    assert.deepEqual(await pixel(), [204, 34, 51])
    await page.getByTestId('preview-record').click()
    await expect(page.getByTestId('preview-record')).toHaveAttribute('aria-label', '取消麦克风授权')
    await page.waitForTimeout(500)
    assert.equal(await page.locator('.ruler-label').innerText(), initial, '等待授权不应提前走动播放头')
    await page.evaluate(() => { window.recordingFixture.pending.splice(0).forEach(resolve => resolve()) })
    await expect(page.getByTestId('preview-record')).toHaveAttribute('aria-label', '停止录音')
    await expect.poll(pixel, { intervals: [30] }).toEqual([34, 68, 221])
    await expect(page.getByTestId('preview-record-status')).toContainText('00:02')
    assert.deepEqual(await pixel(), [34, 68, 221], '录音超过原有片段结尾时画面停留在最后一帧')
    await page.getByTestId('preview-record').click()
    await expect(page.getByTestId('preview-record')).toHaveAttribute('aria-label', '开始录音')
    await devicesReleased(page)
    const result = await page.evaluate(() => {
      const project = window.pictureRecording.current.value
      const asset = project.assets.at(-1), clip = project.tracks.flatMap(track => track.clips).find(clip => clip.assetId === asset.id)
      return { start: clip.start, duration: asset.duration }
    })
    assert.equal(result.start, 0.4)
    assert(result.duration >= 2, '实际录音应保留超过原项目结尾的内容')
    await expect(page.getByTestId('preview-play')).toHaveAttribute('aria-busy', 'false')
    await page.getByTestId('preview-play').click()
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '暂停（空格）')
    await expect.poll(pixel, { intervals: [30] }).toEqual([34, 68, 221])
    await page.getByTestId('preview-play').click()
    console.log('PASS 等待授权期间保持原刻度；录音开始后同步切换画面，越过原片尾保留最后画面，录音仍插入原始 0.4 秒位置，结束后立即正常播放')
    await page.evaluate(async () => {
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const original = TimelinePreview.prototype.enableAudio
      const schedule = window.setTimeout
      let inject = true
      window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 10000 ? 250 : delay, ...args)
      TimelinePreview.prototype.enableAudio = function (monitor, signal) {
        if (inject) {
          inject = false
          Object.defineProperty(this.audioContext, 'state', { configurable: true, value: 'interrupted' })
          this.audioContext.resume = () => new Promise(() => {})
        }
        return original.call(this, monitor, signal)
      }
      window.pictureRecording.restorePlayback = () => {
        TimelinePreview.prototype.enableAudio = original
        window.setTimeout = schedule
      }
    })
    await page.getByTestId('preview-play').click()
    await expect.poll(() => page.evaluate(() => window.pictureRecording.messages.at(-1))).toContain('音频输出未能恢复')
    await expect(page.getByTestId('preview-play')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '播放（空格）')
    await page.evaluate(() => window.pictureRecording.restorePlayback())
    await page.getByTestId('preview-play').click()
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '暂停（空格）')
    await page.getByTestId('preview-play').click()
    console.log('PASS 人为注入音频输出恢复无响应后，播放准备自动结束，提示原因并重建输出，再次播放可正常工作')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

async function extraChecks(browser, url) {
  await synchronizedPicture(browser, url)
  for (const viewport of [{ width: 800, height: 700 }, { width: 320, height: 850 }]) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await installDevices(page)
      await page.goto(url)
      await page.getByTestId('create-project').click()
      const button = page.getByTestId('preview-record')
      await button.click()
      await expect(button).toHaveAttribute('aria-label', '停止录音')
      await expect(page.getByTestId('preview-record-status')).toContainText('00:01')
      for (const id of ['preview-record', 'preview-record-status']) {
        const bounds = await page.getByTestId(id).evaluate(element => {
          const rectangle = element.getBoundingClientRect()
          const hit = document.elementFromPoint(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2)
          return { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height, clear: hit === element || element.contains(hit) }
        })
        assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height,
          `${viewport.width}px 窗口的 ${id} 必须完整显示：${JSON.stringify(bounds)}`)
        assert(bounds.clear, `${viewport.width}px 窗口的 ${id} 不应被其他面板遮挡`)
      }
      if (viewport.width === 800) await page.screenshot({ path: `${artifacts}/recording-active-800.png` })
      await button.click()
      await expect(button).toHaveAttribute('aria-label', '开始录音')
      await devicesReleased(page)
      await expect(page.locator('.timeline-clip.audio')).toHaveCount(1)
      assert.deepEqual(errors, [])
      console.log(`PASS ${viewport.width}×${viewport.height} 窗口录音按钮和时长完整显示，未被遮挡，可停止并添加片段`)
    } finally { await context.close() }
  }

  const context = await browser.newContext({ viewport: { width: 800, height: 700 } })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await installDevices(page)
    await page.route('**/voice-recorder-recovery-test', route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:40px;font-family:system-ui;--ed-border:#ddd;--ed-panel:white;--ed-text:#222;--ed-muted:#666}button{cursor:pointer}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto(`${url}/voice-recorder-recovery-test`)
    await page.evaluate(async () => {
      const source = await (await fetch('/src/components/EditorVoiceRecorder.vue')).text()
      const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
      const { createApp, h } = await import(vueImport)
      const Recorder = (await import('/src/components/EditorVoiceRecorder.vue')).default
      const state = { attempts: [], accepted: [], busy: [], rejectRemaining: 1, messages: [] }
      const app = createApp({ render: () => h(Recorder, {
        projectId: 'recording-recovery-project', start: 2.25,
        save: async (audio, start, projectId) => {
          const result = { audio, start, projectId }
          state.attempts.push(result)
          if (state.rejectRemaining > 0) { state.rejectRemaining--; throw new Error('测试：录音暂时无法添加') }
          state.accepted.push(result)
        }, onBusy: value => state.busy.push(value), onStatus: message => state.messages.push(message),
      }) })
      app.mount('#app')
      window.voiceRecovery = { ...state, app, state }
    })
    const button = page.getByTestId('preview-record')
    await button.click()
    await expect(button).toHaveAttribute('aria-label', '停止录音')
    await page.waitForTimeout(1100)
    await button.click()
    await expect(button).toHaveAttribute('aria-label', '重试添加录音')
    await expect(page.getByTestId('preview-record-error')).toContainText('录音暂时无法添加')
    await devicesReleased(page)
    const recovery = await page.evaluate(async () => {
      const state = window.voiceRecovery.state, audio = state.attempts[0].audio
      const context = new AudioContext()
      try {
        const decoded = await context.decodeAudioData(await audio.blob.arrayBuffer())
        const samples = decoded.getChannelData(0)
        let square = 0
        for (const value of samples) square += value * value
        return { attempts: state.attempts.length, accepted: state.accepted.length, busy: [...state.busy],
          requests: window.recordingFixture.requests.length, duration: decoded.duration,
          rms: Math.sqrt(square / samples.length), size: audio.blob.size }
      } finally { await context.close() }
    })
    assert.equal(recovery.attempts, 1); assert.equal(recovery.accepted, 0); assert.deepEqual(recovery.busy, [true])
    assert.equal(recovery.requests, 1)
    assert(recovery.duration > 0.9 && recovery.size > 1000 && recovery.rms > 0.08, `失败后应保留可解码的真实音频：${JSON.stringify(recovery)}`)
    await expect(page.getByRole('button', { name: '保存录音文件', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '放弃这段录音', exact: true })).toBeVisible()
    await button.click()
    await expect(button).toHaveAttribute('aria-label', '开始录音')
    const retried = await page.evaluate(() => {
      const state = window.voiceRecovery.state
      return { attempts: state.attempts.length, accepted: state.accepted.length, busy: [...state.busy],
        sameBlob: state.attempts[0].audio.blob === state.attempts[1].audio.blob,
        start: state.accepted[0].start, projectId: state.accepted[0].projectId,
        requests: window.recordingFixture.requests.length }
    })
    assert.deepEqual(retried, { attempts: 2, accepted: 1, busy: [true, false], sameBlob: true,
      start: 2.25, projectId: 'recording-recovery-project', requests: 1 })
    console.log('PASS 模拟提交失败后保留实际录音，麦克风已释放，重试复用同一个音频 Blob 和原始插入位置，不再次采集设备')

    await page.evaluate(() => { window.voiceRecovery.state.rejectRemaining = 1 })
    await button.click()
    await expect(button).toHaveAttribute('aria-label', '停止录音')
    await page.waitForTimeout(1100)
    await page.evaluate(() => {
      // stop() does not dispatch the hardware-disconnection event itself.
      for (const track of window.recordingFixture.requests.at(-1).stream.getTracks()) {
        track.stop(); track.dispatchEvent(new Event('ended'))
      }
    })
    await expect(button).toHaveAttribute('aria-label', '重试添加录音')
    await devicesReleased(page)
    assert.equal(await page.evaluate(() => window.voiceRecovery.state.attempts.length), 3, '设备结束事件应自动完成录音并尝试添加')
    await page.getByRole('button', { name: '放弃这段录音', exact: true }).click()
    await expect(button).toHaveAttribute('aria-label', '开始录音')
    await expect(page.getByTestId('preview-record-error')).toHaveCount(0)
    const discarded = await page.evaluate(() => ({ requests: window.recordingFixture.requests.length,
      accepted: window.voiceRecovery.state.accepted.length, busy: window.voiceRecovery.state.busy }))
    assert.deepEqual(discarded, { requests: 2, accepted: 1, busy: [true, false, true, false] })
    console.log('PASS 设备结束事件自动完成录音；提交失败可显式放弃，不添加片段并解除操作锁定')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

async function main() {
  mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/src-tauri/target/**'] }, hmr: false } })
  await server.listen()
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  try {
    if (process.env.RECORDING_EXTRA_ONLY === '1') { await extraChecks(browser, `http://127.0.0.1:${port}`); return }
    await installDevices(page)
    await page.goto(`http://127.0.0.1:${port}`)
    await page.getByTestId('create-project').click()
    await expect(page.getByTestId('video-editor')).toBeVisible()
    const recordButton = page.getByTestId('preview-record')
    await expect(recordButton).toHaveAttribute('aria-label', '开始录音')
    await expect(recordButton).toBeEnabled()
    const positions = await page.locator('.play-controls').evaluate(element => {
      const play = element.querySelector('[data-testid="preview-play"]')
      const record = element.querySelector('[data-testid="preview-record"]')
      return { ordered: !!(play.compareDocumentPosition(record) & Node.DOCUMENT_POSITION_FOLLOWING),
        svg: record.querySelectorAll('svg').length, requests: window.recordingFixture.requests.length }
    })
    assert.deepEqual(positions, { ordered: true, svg: 1, requests: 0 })
    console.log('PASS 空白项目可录音，SVG 按钮位于播放按钮后，点击之前不请求设备')

    await page.evaluate(() => { window.recordingFixture.mode = 'denied' })
    await recordButton.click()
    await expect(page.getByTestId('preview-record-error')).toContainText(/麦克风/)
    await expect(recordButton).toHaveAttribute('aria-label', '开始录音')
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(0)
    await expect(page.getByTestId('save-project')).toBeEnabled()
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    await devicesReleased(page)
    console.log('PASS 拒绝麦克风权限显示可理解错误，不添加空白音频，并解除操作锁定')

    await page.evaluate(() => { window.recordingFixture.mode = 'pending' })
    await recordButton.click()
    await expect(recordButton).toHaveAttribute('aria-label', '取消麦克风授权')
    await busyControls(page)
    await recordButton.click()
    await expect(recordButton).toHaveAttribute('aria-label', '开始录音')
    await page.evaluate(() => { window.recordingFixture.pending.splice(0).forEach(resolve => resolve()) })
    await expect.poll(() => page.evaluate(() => !!window.recordingFixture.requests.at(-1).stream)).toBe(true)
    await devicesReleased(page)
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(0)
    await expect(page.getByTestId('nav-record')).toBeEnabled()
    console.log('PASS 等待授权可取消，迟到的麦克风流会释放，工作区切换与保存无法绕过录音锁定')

    await page.evaluate(() => { window.recordingFixture.mode = 'ready' })
    await record(page, { checkBusy: true })
    const first = await savedProject(page, 1)
    assert.equal(narrationTracks(first).length, 1)
    assert.equal(narrationTracks(first)[0].kind, 'audio')
    assert.equal(narrationTracks(first)[0].clips.length, 1)
    assert.equal(lastClip(first).start, 0)
    await expect(page.locator(`.timeline-clip[data-clip-id="${lastClip(first).id}"]`)).toHaveClass(/selected/)
    await expect(page.getByTestId('audio-clip-player')).toBeVisible()
    const firstAudio = await verifyAudio(page, lastAudio(first))
    console.log('PASS 实际录音自动加入“配音轨道”、选中新片段并释放麦克风；草稿包含可解码音频', firstAudio)

    await page.getByRole('button', { name: '跳到结尾', exact: true }).click()
    const firstEnd = lastClip(first).start + (lastClip(first).trimOut - lastClip(first).trimIn) / lastClip(first).speed
    await record(page)
    const second = await savedProject(page, 2)
    assert.equal(narrationTracks(second).length, 1, '无重叠的下一次录音应复用已有配音轨道')
    assert.equal(narrationTracks(second)[0].clips.length, 2)
    assert(Math.abs(lastClip(second).start - firstEnd) <= 1 / second.fps + 1e-6, '第二段录音应保留点击开始时的播放头位置')
    assert(lastClip(second).start >= firstEnd - 1e-6, '按帧对齐不能让连续录音发生重叠')
    await verifyAudio(page, lastAudio(second))
    console.log('PASS 连续录音复用已有配音轨道，并从开始时的播放头位置插入，不重叠已有片段')

    await page.getByRole('button', { name: '回到开头', exact: true }).click()
    await page.getByTestId('preview-play').click()
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '暂停（空格）')
    await page.waitForTimeout(180)
    await recordButton.click()
    await expect(recordButton).toHaveAttribute('aria-label', '停止录音')
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '暂停（空格）')
    const initialPlayhead = await page.locator('.ruler-label').innerText()
    await page.waitForTimeout(1100)
    assert.notEqual(await page.locator('.ruler-label').innerText(), initialPlayhead, '录音期间预览应从当前刻度同步前进')
    await recordButton.click()
    await expect(recordButton).toHaveAttribute('aria-label', '开始录音')
    await devicesReleased(page)
    const overlapping = await savedProject(page, 3)
    assert.equal(narrationTracks(overlapping).length, 2, '已有轨道的录音区间被占用时，应新建同名音频轨道')
    assert(lastClip(overlapping).start > 0 && lastClip(overlapping).start < firstEnd)
    assert.deepEqual(narrationTracks(overlapping).find(track => track.id === narrationTracks(second)[0].id).clips, narrationTracks(second)[0].clips, '原有配音片段不应移动或覆盖')
    await verifyAudio(page, lastAudio(overlapping))
    console.log('PASS 录音期间预览从当前刻度同步前进；占用时段新建同名配音轨道并完整保留已有片段')

    for (const track of narrationTracks(overlapping)) await page.locator(`[data-track-label-id="${track.id}"]`).getByRole('button', { name: '锁定轨道', exact: true }).click()
    await page.getByRole('button', { name: '跳到结尾', exact: true }).click()
    await record(page)
    const locked = await savedProject(page, 4)
    assert.equal(narrationTracks(locked).length, 3, '现有配音轨道均锁定时应创建新的同名轨道')
    for (const track of narrationTracks(overlapping)) {
      const current = narrationTracks(locked).find(item => item.id === track.id)
      assert.equal(current.locked, true)
      assert.deepEqual(current.clips, track.clips)
    }
    await verifyAudio(page, lastAudio(locked))
    await expect(page.locator(`.timeline-clip[data-clip-id="${lastClip(locked).id}"]`)).toHaveClass(/selected/)
    await page.screenshot({ path: `${artifacts}/recording-tracks.png` })
    console.log('PASS 锁定配音轨道时新建可编辑的同名音频轨道，不改变锁定片段')

    await page.getByTestId('save-project').click()
    await expect(page.locator('.status-main')).toContainText('项目已保存')
    const archive = Buffer.from(await page.evaluate(async () => {
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('recording-project.omedia')
      return Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()))
    }))
    writeFileSync(`${artifacts}/recording-project.omedia`, archive)
    const entries = unzipSync(archive), manifest = JSON.parse(strFromU8(entries['project.json']))
    assert.equal(manifest.project.assets.length, 4)
    assert.deepEqual(manifest.project.tracks, locked.tracks)
    for (const asset of locked.assets) assert.equal(entries[`media/${asset.id}`].length, asset.size, '项目包应包含全部录音的实际字节')
    await page.reload()
    await expect(page.getByTestId('home-workspace')).toBeVisible()
    await page.getByTestId('nav-edit').click()
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(4)
    const restored = await savedProject(page, 4)
    assert.deepEqual(restored.tracks, locked.tracks)
    await verifyAudio(page, lastAudio(restored))
    await page.keyboard.press('Control+o')
    await expect.poll(() => page.evaluate(() => window.recordingFixture.opens)).toBe(1)
    await expect(page.locator('.status-main')).toContainText('已打开')
    await expect(page.locator('.timeline-clip.audio')).toHaveCount(4)
    await expect(page.getByTestId('preview-record')).toBeEnabled()
    console.log('PASS 保存项目包含全部编码录音；刷新恢复本地草稿和重开项目文件均保留音频轨道及片段')
    assert.deepEqual(errors, [])
    await extraChecks(browser, `http://127.0.0.1:${port}`)
  } catch (error) {
    await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {})
    throw error
  } finally {
    await page.evaluate(async () => {
      for (const request of window.recordingFixture?.requests || []) request.stream?.getTracks().forEach(track => track.stop())
      await Promise.all((window.recordingFixture?.contexts || []).map(context => context.close()))
    }).catch(() => {})
    await context.close(); await browser.close(); await server.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
