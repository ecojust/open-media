const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { execFileSync } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const card = (page, id) => page.locator(`.asset-card[data-source-asset-id="${id}"]`)
const preview = (page, id) => card(page, id).locator('.asset-media-preview')
const state = (page, id) => preview(page, id).getAttribute('data-preview-state')

async function main() {
  const directory = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'asset-hover') : fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-asset-hover-'))
  fs.mkdirSync(directory, { recursive: true })
  const videoFile = path.join(directory, 'source.webm'), audioFile = path.join(directory, 'source.wav')
  execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=8', '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', videoFile])
  execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=48000', '-c:a', 'pcm_s16le', audioFile])
  const videoBytes = fs.readFileSync(videoFile), audioBytes = fs.readFileSync(audioFile)
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }), errors = []
    page.setDefaultTimeout(20000)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__asset_hover__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
    await page.route('**/hover-video/*', route => route.fulfill({ contentType: 'video/webm', body: videoBytes }))
    await page.route('**/hover-audio/*', route => route.fulfill({ contentType: 'audio/wav', body: audioBytes }))
    await page.goto(`http://127.0.0.1:${port}/__asset_hover__`)
    await page.evaluate(async sizes => {
      await import('/src/style.css')
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const { createApp, h, shallowRef, ref } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const { createProject, createClip } = await import('/src/core/project.ts')
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      const video = id => ({ id, name: `${id}.webm`, kind: 'video', url: `${location.origin}/hover-video/${id}`, duration: 8, width: 320, height: 180, size: sizes.video, mime: 'video/webm' })
      const audio = id => ({ id, name: `${id}.wav`, kind: 'audio', url: `${location.origin}/hover-audio/${id}`, duration: 8, width: 0, height: 0, size: sizes.audio, mime: 'audio/wav' })
      const project = createProject('素材悬停验证', { width: 320, height: 180, fps: 15 })
      project.assets = [video('video-first'), audio('audio-first'), audio('audio-second'), video('video-second'), ...Array.from({ length: 30 }, (_, index) => video(`offscreen-${index}`))]
      project.tracks.find(track => track.kind === 'video').clips.push(createClip(project.assets[0], project))
      const fixture = window.assetHover = { current: shallowRef(project), editor: ref(null), busy: ref(false), changes: 0, sounds: [], playCalls: [], denied: false, sources: [], media: new Set() }
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function (...args) {
        fixture.playCalls.push({ source: this.src, time: performance.now() })
        fixture.media.add(this)
        if (fixture.denied && this instanceof HTMLAudioElement) { fixture.denied = false; return Promise.reject(new DOMException('Requires interaction', 'NotAllowedError')) }
        if (this instanceof HTMLAudioElement && !fixture.sources.includes(this)) {
          const context = new AudioContext(), source = context.createMediaElementSource(this), analyser = context.createAnalyser()
          source.connect(analyser); analyser.connect(context.destination); void context.resume()
          fixture.sources.push(this); fixture.sounds.push({ context, analyser })
        }
        return play.apply(this, args)
      }
      fixture.rms = () => Math.max(0, ...fixture.sounds.map(({ analyser }) => { const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) }))
      fixture.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': 'dark' }, h(Editor, {
        ref: fixture.editor, project: fixture.current.value, automationBusy: fixture.busy.value,
        onChange: project => { fixture.current.value = project; fixture.changes++ }, runTool: async () => ({}),
      })) })
      fixture.app.mount('#app')
      fixture.empty = () => { fixture.current.value = createProject('新的空工程', { width: 320, height: 180, fps: 15 }) }
    }, { video: videoBytes.length, audio: audioBytes.length })
    await expect(page.getByTestId('video-editor')).toBeVisible()
    await expect(card(page, 'video-first')).toBeVisible()
    await expect.poll(() => card(page, 'video-first').locator('video').evaluate(video => video.readyState)).toBeGreaterThan(1)
    assert.equal(await page.locator('.asset-list audio[src]').count(), 0, '没有悬停时音频不能预先加载')
    assert(await page.locator('.asset-list video[src]').count() < 12, '只有可见缩略图应持有视频源')
    const calls = await page.evaluate(() => window.assetHover.playCalls.length)
    await card(page, 'audio-first').dispatchEvent('mouseenter')
    await card(page, 'audio-first').dispatchEvent('mouseleave')
    await page.waitForTimeout(220)
    assert.equal(await page.evaluate(() => window.assetHover.playCalls.length), calls, '快速划过素材不能启动解码')

    await card(page, 'video-first').hover()
    await expect.poll(() => state(page, 'video-first')).toBe('playing')
    await expect.poll(() => card(page, 'video-first').locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0.25)
    const frames = await card(page, 'video-first').locator('video').evaluate(async video => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
      const context = canvas.getContext('2d')
      const sample = () => { context.drawImage(video, 0, 0); return [...context.getImageData(0, 0, 320, 180).data].reduce((sum, value, index) => sum + value * (index % 19), 0) }
      const first = sample(); await new Promise(resolve => setTimeout(resolve, 350)); return { first, second: sample(), muted: video.muted }
    })
    assert.notEqual(frames.first, frames.second, '悬停应显示真实变化的视频帧')
    assert(frames.muted, '视频缩略图默认静音')

    await card(page, 'audio-first').hover()
    await expect.poll(() => state(page, 'audio-first')).toBe('playing')
    await expect.poll(() => page.evaluate(() => window.assetHover.rms())).toBeGreaterThan(0.03)
    assert(await card(page, 'video-first').locator('video').evaluate(video => video.paused && video.currentTime === 0), '离开视频须停止并复位')
    await card(page, 'audio-second').hover()
    await expect.poll(() => state(page, 'audio-second')).toBe('playing')
    assert.equal(await card(page, 'audio-first').locator('audio').getAttribute('src'), null, '切换素材须释放上一音频')
    assert.equal(await page.locator('.asset-list .asset-media-playing').count(), 1)
    await page.mouse.move(700, 60)
    await expect.poll(() => page.evaluate(() => window.assetHover.rms())).toBeLessThan(0.001)
    assert.equal(await page.locator('.asset-list audio[src]').count(), 0)

    await page.evaluate(() => { window.assetHover.denied = true })
    await card(page, 'audio-first').hover()
    await expect.poll(() => state(page, 'audio-first')).toBe('blocked')
    await expect(card(page, 'audio-first')).toContainText('点击试听')
    await card(page, 'audio-first').click()
    await expect.poll(() => state(page, 'audio-first')).toBe('playing')
    await expect.poll(() => page.evaluate(() => window.assetHover.rms())).toBeGreaterThan(0.03)

    await card(page, 'audio-first').click({ button: 'right' })
    await expect.poll(() => state(page, 'audio-first')).toBe('idle')
    assert.equal(await page.locator('.asset-list audio[src]').count(), 0, '右键菜单应停止试听')
    await page.keyboard.press('Escape')
    await page.mouse.move(700, 60)
    await card(page, 'video-first').hover()
    await expect.poll(() => state(page, 'video-first')).toBe('playing')
    await page.locator('.asset-list').evaluate(list => { list.scrollTop = list.scrollHeight })
    await expect.poll(() => card(page, 'video-first').locator('video').getAttribute('src')).toBe(null)
    assert.equal(await page.locator('.asset-list .asset-media-playing').count(), 0, '滚出可见范围应停止解码')

    await page.locator('.asset-list').evaluate(list => { list.scrollTop = 0 })
    await page.mouse.move(700, 60)
    await card(page, 'audio-first').hover()
    await expect.poll(() => state(page, 'audio-first')).toBe('playing')
    await page.evaluate(() => { window.assetHover.busy.value = true })
    await expect.poll(() => state(page, 'audio-first')).toBe('idle')
    await page.evaluate(() => { window.assetHover.busy.value = false })
    await page.mouse.move(700, 60)
    await card(page, 'audio-first').hover()
    await expect.poll(() => state(page, 'audio-first')).toBe('playing')
    await page.screenshot({ path: path.join(directory, 'asset-hover.png') })
    await page.evaluate(() => window.assetHover.empty())
    await expect(page.locator('.asset-card')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.assetHover.rms())).toBeLessThan(0.001)
    assert(await page.evaluate(() => [...window.assetHover.media].every(media => media.paused && !media.hasAttribute('src'))), '切换工程应释放所有悬停媒体源')
    assert.equal(await page.evaluate(() => window.assetHover.changes), 0, '悬停试听不能改写工程或触发保存')
    await page.evaluate(async () => { window.assetHover.app.unmount(); await Promise.all(window.assetHover.sounds.map(sound => sound.context.close())) })
    assert.deepEqual(errors, [])
    console.log('PASS 素材悬停真实视频帧、有声音频、单实例试听、浏览器拦截恢复、快速划过/菜单/滚动/MCP/切换工程释放，工程未被改写。')
    console.log(`Evidence: ${directory}`)
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
