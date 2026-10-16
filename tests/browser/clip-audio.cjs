const assert = require('node:assert/strict')
const { chromium, expect } = require('@playwright/test')
const { existsSync } = require('node:fs')
const net = require('node:net')

/** Uses a development server and actual decoded audio; no application build is needed. */
async function mountEditor(page, baseURL) {
  await page.route('**/clip-audio-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${baseURL}/clip-audio-test`)
  await page.evaluate(async () => {
    const { createProject, createClip, createTrack, validateProject } = await import('/src/core/project.ts')
    const outputs = [], media = new Set(), mediaEvents = new WeakMap()
    const connect = AudioNode.prototype.connect
    AudioNode.prototype.connect = function (destination, ...args) {
      const result = connect.call(this, destination, ...args)
      if (destination instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser(); analyser.fftSize = 4096
        connect.call(this, analyser)
        outputs.push({ context: this.context, analyser })
      }
      return result
    }
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (...args) {
      if (!media.has(this)) {
        const events = []; mediaEvents.set(this, events)
        for (const event of ['loadeddata', 'seeked', 'seeking', 'canplay', 'waiting']) this.addEventListener(event, () => events.push(event))
      }
      media.add(this)
      return play.apply(this, args)
    }
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
    function wav(frequency, duration = 12, segmented = false) {
      const sampleRate = 48000, frames = Math.round(duration * sampleRate)
      const bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes)
      const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
      text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
      text(36, 'data'); view.setUint32(40, frames * 2, true)
      for (let i = 0; i < frames; i++) {
        const pitch = segmented && i < sampleRate ? 220 : segmented && i >= sampleRate * 8 ? 1760 : frequency
        view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * pitch * i / sampleRate) * 0.2 * 32767), true)
      }
      return new Blob([bytes], { type: 'audio/wav' })
    }
    async function sample(milliseconds = 160) {
      const measurements = []
      const started = performance.now()
      do {
        let square = 0
        const tones = { 220: 0, 440: 0, 660: 0, 880: 0, 1760: 0 }
        for (const output of outputs.filter(item => item.context.state === 'running')) {
          const values = new Float32Array(output.analyser.fftSize)
          output.analyser.getFloatTimeDomainData(values)
          square += values.reduce((sum, value) => sum + value * value, 0) / values.length
          for (const pitch of Object.keys(tones)) {
            let real = 0, imag = 0
            for (let i = 0; i < values.length; i++) {
              const angle = 2 * Math.PI * Number(pitch) * i / output.context.sampleRate
              real += values[i] * Math.cos(angle); imag += values[i] * Math.sin(angle)
            }
            tones[pitch] += 2 * Math.hypot(real, imag) / values.length
          }
        }
        measurements.push({ rms: Math.sqrt(square), tones })
        await delay(20)
      } while (performance.now() - started < milliseconds)
      return {
        rms: measurements.reduce((sum, value) => sum + value.rms, 0) / measurements.length,
        tones: Object.fromEntries(Object.keys(measurements[0].tones).map(pitch => [pitch, measurements.reduce((sum, value) => sum + value.tones[pitch], 0) / measurements.length])),
      }
    }
    const narrationBlob = wav(440, 12, true), musicBlob = wav(660)
    const narration = { id: 'narration-asset', name: '测试配音.wav', kind: 'audio', url: URL.createObjectURL(narrationBlob), duration: 12, width: 0, height: 0, size: narrationBlob.size, mime: narrationBlob.type }
    const music = { ...narration, id: 'music-asset', name: '背景音乐.wav', url: URL.createObjectURL(musicBlob), size: musicBlob.size }
    let project = createProject('片段独立试听验证', { width: 320, height: 180, fps: 30 })
    const narrationTrack = createTrack('audio', '配音轨道'), musicTrack = createTrack('audio', '背景音轨')
    narrationTrack.id = 'narration-track'; musicTrack.id = 'music-track'
    narrationTrack.clips = [createClip(narration, project, { id: 'narration', name: '测试配音', start: 4, trimIn: 1, trimOut: 7, speed: 1.5, volume: 0.5, fadeIn: 0.8, fadeOut: 0.8, speech: { text: '配音试听', voiceId: 'test-voice', rate: 1 } })]
    musicTrack.clips = [createClip(music, project, { id: 'music', name: '背景音乐', trimOut: 10 })]
    project.assets = [narration, music]; project.tracks.push(narrationTrack, musicTrack)
    project = validateProject(project, { trusted: true })
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref } = await import(vueImport)
    const VideoEditor = (await import('/src/components/VideoEditor.vue')).default
    const state = shallowRef(project), editor = ref(null)
    const app = createApp({ render: () => h(VideoEditor, { project: state.value, ref: editor, onChange: next => { state.value = next }, onStatus: value => { window.audioStatus = value } }) })
    app.mount('#app')
    window.audioChecks = {
      state, editor, app, wav, delay, sample,
      media: () => [...media].map(item => ({ source: item.currentSrc || item.src, paused: item.paused, time: item.currentTime, rate: item.playbackRate, ready: item.readyState, seeking: item.seeking, events: mediaEvents.get(item) })),
      mutate: action => { const next = structuredClone(state.value); action(next); state.value = validateProject(next, { trusted: true }) },
    }
  })
  await expect(page.getByTestId('video-editor')).toBeVisible()
}

async function choose(page, id) {
  await page.locator(`[data-clip-id="${id}"]`).click()
  await expect(page.getByTestId('audio-clip-player')).toBeVisible()
}
async function sample(page, milliseconds) { return page.evaluate(milliseconds => window.audioChecks.sample(milliseconds), milliseconds) }
async function setProgress(page, seconds) {
  await page.getByRole('slider', { name: '片段试听进度', exact: true }).evaluate((input, value) => {
    input.value = String(value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, seconds)
}
async function quiet(page, reason) {
  await page.waitForTimeout(140)
  const measured = await sample(page, 100)
  assert(measured.rms < 0.002, `${reason}后应停止音频输出：${JSON.stringify(measured)}`)
}

async function main() {
  const { createServer } = await import('vite')
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true } })
  await server.listen()
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await mountEditor(page, baseURL)
    await choose(page, 'narration')
    await page.screenshot({ path: '/tmp/open-media-clip-audio-desktop.png' })
    for (const width of [768, 320]) {
      await page.setViewportSize({ width, height: 850 })
      await page.getByTestId('audio-clip-player').scrollIntoViewIfNeeded()
      const bounds = await page.getByTestId('audio-clip-player').boundingBox()
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${width}px 试听控件应完整显示：${JSON.stringify(bounds)}`)
      await expect(page.getByRole('slider', { name: '片段试听进度', exact: true })).toBeVisible()
    }
    await page.screenshot({ path: '/tmp/open-media-clip-audio-narrow.png' })
    await page.setViewportSize({ width: 1280, height: 850 })
    await expect(page.getByRole('slider', { name: '片段试听进度', exact: true })).toHaveAttribute('max', '4')
    await page.getByRole('button', { name: '单独播放片段', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停片段试听', exact: true })).toBeVisible()
    await page.waitForTimeout(1050)
    const playing = await sample(page, 200)
    const media = await page.evaluate(() => window.audioChecks.media().filter(item => !item.paused))
    assert(playing.tones[440] > 0.085 && playing.tones[660] < 0.005, `应只试听所选配音，不受时间线起点影响或混入其他音轨：${JSON.stringify(playing)}`)
    assert(playing.tones[220] < 0.005 && playing.tones[1760] < 0.005, `裁剪范围外音频不应播放：${JSON.stringify(playing)}`)
    assert(playing.rms > 0.06 && playing.rms < 0.08, `50% 片段音量错误：${JSON.stringify(playing)}`)
    assert.equal(media.length, 1, `只应启动一个片段：${JSON.stringify(media)}`)
    assert.equal(media[0].rate, 1.5)
    assert(media[0].time > 2.4 && media[0].time < 4, `应从源起点 1 秒按 1.5 倍速试听：${JSON.stringify(media)}`)
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '播放（空格）')
    console.log(`PASS 配音独立试听实际解码波形、裁剪范围、1.5 倍速与 50% 音量：${JSON.stringify(playing)}`)

    await page.getByRole('button', { name: '暂停片段试听', exact: true }).click()
    const pausedAt = Number(await page.getByRole('slider', { name: '片段试听进度', exact: true }).inputValue())
    await quiet(page, '暂停片段试听')
    assert.equal(Number(await page.getByRole('slider', { name: '片段试听进度', exact: true }).inputValue()), pausedAt)
    await page.getByRole('button', { name: '单独播放片段', exact: true }).click()
    await page.waitForTimeout(180)
    const resumedAt = Number(await page.getByRole('slider', { name: '片段试听进度', exact: true }).inputValue())
    assert(resumedAt > pausedAt && resumedAt < pausedAt + 0.6, `恢复应保留试听位置：${pausedAt} -> ${resumedAt}`)
    // An unchanged-value pointer click does not dispatch input/change in the browser.
    await page.getByRole('slider', { name: '片段试听进度', exact: true }).dispatchEvent('pointerdown')
    await page.getByRole('slider', { name: '片段试听进度', exact: true }).dispatchEvent('pointerup')
    await expect(page.getByRole('button', { name: '暂停片段试听', exact: true })).toBeVisible()
    await setProgress(page, 3.65)
    await page.getByRole('button', { name: '单独播放片段', exact: true }).waitFor({ state: 'visible' })
    await quiet(page, '片段终点')
    assert.equal(Number(await page.getByRole('slider', { name: '片段试听进度', exact: true }).inputValue()), 4)
    await page.getByRole('button', { name: '单独播放片段', exact: true }).click()
    await page.waitForTimeout(100)
    const replay = Number(await page.getByRole('slider', { name: '片段试听进度', exact: true }).inputValue())
    assert(replay < 0.5, `播放结束后重播应从片段头部开始：${replay}`)
    await page.getByRole('button', { name: '停止片段试听', exact: true }).click()
    await quiet(page, '停止')
    assert.equal(Number(await page.getByRole('slider', { name: '片段试听进度', exact: true }).inputValue()), 0)
    console.log('PASS 暂停与恢复、进度跳转与原位点击、裁剪终点停止、重播和停止归零；768 / 320 像素控件可达')

    await page.evaluate(() => window.audioChecks.mutate(project => {
      const clip = project.tracks.find(track => track.id === 'narration-track').clips[0]
      clip.speed = 1; clip.trimIn = 1; clip.trimOut = 7; clip.fadeIn = 2; clip.fadeOut = 2
    }))
    await page.getByRole('button', { name: '单独播放片段', exact: true }).click()
    await page.waitForTimeout(350)
    const fadeStart = await sample(page, 120)
    await setProgress(page, 2.7)
    await page.waitForTimeout(120)
    const fadeMiddle = await sample(page, 160)
    await setProgress(page, 5.5)
    await page.waitForTimeout(80)
    const fadeEnd = await sample(page, 120)
    assert(fadeStart.rms > 0.005 && fadeStart.rms < fadeMiddle.rms * 0.5, `淡入未应用：${JSON.stringify({ fadeStart, fadeMiddle })}`)
    assert(fadeEnd.rms > 0.003 && fadeEnd.rms < fadeMiddle.rms * 0.4, `淡出未应用：${JSON.stringify({ fadeEnd, fadeMiddle })}`)
    await page.getByRole('button', { name: '停止片段试听', exact: true }).click()
    console.log(`PASS 试听真实音频包含片段淡入和淡出：${JSON.stringify({ start: fadeStart.rms, middle: fadeMiddle.rms, end: fadeEnd.rms })}`)

    await page.getByTestId('preview-play').click()
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '暂停（空格）')
    await page.waitForTimeout(180)
    const mainAudio = await sample(page, 160)
    assert(mainAudio.tones[660] > 0.15 && mainAudio.tones[440] < 0.005, `主时间线起点应播放背景音：${JSON.stringify(mainAudio)}`)
    await page.getByRole('button', { name: '单独播放片段', exact: true }).click()
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '播放（空格）')
    await page.waitForTimeout(200)
    const soloAudio = await sample(page, 120)
    assert(soloAudio.tones[660] < 0.005, `片段试听应停止主时间线混音：${JSON.stringify(soloAudio)}`)
    await page.getByTestId('preview-play').click()
    await expect(page.getByRole('button', { name: '单独播放片段', exact: true })).toBeVisible()
    await page.waitForTimeout(180)
    const returnedAudio = await sample(page, 160)
    assert(returnedAudio.tones[660] > 0.15 && returnedAudio.tones[440] < 0.005, `主播放应停止独立试听：${JSON.stringify(returnedAudio)}`)
    await page.getByTestId('preview-play').click()
    await quiet(page, '主播放暂停')
    console.log('PASS 独立试听与主时间线播放双向互斥，实际波形无其他音轨漏音')

    await page.getByRole('button', { name: '单独播放片段', exact: true }).click()
    await choose(page, 'music')
    await quiet(page, '切换所选片段')
    await page.evaluate(() => window.audioChecks.mutate(project => { const track = project.tracks.find(track => track.id === 'music-track'); track.locked = true; track.muted = true }))
    await expect(page.getByRole('button', { name: '单独播放片段', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '单独播放片段', exact: true }).click()
    await page.waitForTimeout(160)
    const lockedAudio = await sample(page, 160)
    assert(lockedAudio.tones[660] > 0.15, `锁定或静音轨道应允许独立试听：${JSON.stringify(lockedAudio)}`)
    await page.evaluate(() => window.audioChecks.mutate(project => { project.tracks.find(track => track.id === 'music-track').locked = false }))
    await expect(page.getByRole('button', { name: '暂停片段试听', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '删除片段', exact: true }).click()
    await expect(page.getByTestId('audio-clip-player')).toHaveCount(0)
    await quiet(page, '删除试听片段')
    console.log('PASS 切换选中片段与删除片段时停止试听，锁定或静音轨道允许试听')

    const delayedBytes = await page.evaluate(async () => [...new Uint8Array(await window.audioChecks.wav(880, 4).arrayBuffer())])
    await page.route('**/delayed-clip.wav', async route => {
      await new Promise(resolve => setTimeout(resolve, 1100))
      await route.fulfill({ contentType: 'audio/wav', body: Buffer.from(delayedBytes) })
    })
    await page.evaluate(async () => {
      const { createClip, createTrack } = await import('/src/core/project.ts')
      window.audioChecks.mutate(project => {
        const asset = { id: 'delayed-asset', name: '延迟音频.wav', kind: 'audio', url: `${location.origin}/delayed-clip.wav`, duration: 4, width: 0, height: 0, size: 384044, mime: 'audio/wav' }
        const track = createTrack('audio', '加载测试'); track.clips = [createClip(asset, project, { id: 'delayed-clip', trimOut: 3 })]
        project.assets.push(asset); project.tracks.push(track)
      })
    })
    await choose(page, 'delayed-clip')
    await page.getByRole('button', { name: '单独播放片段', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消片段试听加载', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '取消片段试听加载', exact: true }).click()
    await page.waitForTimeout(1300)
    await quiet(page, '取消加载并等待媒体到达')
    await expect(page.getByRole('button', { name: '单独播放片段', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '单独播放片段', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停片段试听', exact: true })).toBeVisible()
    await page.waitForTimeout(160)
    const retry = await sample(page, 160)
    assert(retry.tones[880] > 0.15, `取消后仍应能够重新试听：${JSON.stringify(retry)}`)
    await page.evaluate(() => window.audioChecks.app.unmount())
    await quiet(page, '编辑器卸载')
    assert.deepEqual(errors, [])
    console.log('PASS 取消真实延迟媒体加载后无迟到声音、可重新试听，卸载释放音频')
  } finally { await browser.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
