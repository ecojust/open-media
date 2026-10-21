const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'transition-sounds') : '/tmp/open-media-transition-sounds'
const dialog = page => page.getByRole('dialog', { name: '转场', exact: true })
const read = page => page.evaluate(() => JSON.parse(JSON.stringify(window.soundFixture.current.value)))
const soundClips = project => project.tracks.filter(track => track.name === '转场音效').flatMap(track => track.clips)

async function mount(page, url) {
  await page.route('**/__transition_sound_editor__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/__transition_sound_editor__`)
  await page.evaluate(async () => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueURL)
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    const { createProject, createClip, validateProject } = await import('/src/core/project.ts')
    const { createHistory, commitHistory, undoHistory, redoHistory } = await import('/src/core/timeline.ts')
    const { addTransition } = await import('/src/core/transitions.ts')
    const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const videoBlob = await (await fetch(VIDEO_SEGMENTS[0].url)).blob()
    const video = await importMediaFile(new File([videoBlob], '原视频.webm', { type: 'video/webm' }))
    let project = createProject('转场音效实测', { width: 320, height: 180, fps: 20 })
    project.assets.push(video)
    project.tracks.find(track => track.kind === 'video').clips.push(...[0, 1, 2].map(index => createClip(video, project, {
      id: `part-${index}`, name: `视频 ${index + 1}`, start: index * 2, trimIn: 0, trimOut: 2, volume: 0,
    })))
    project = addTransition(project, 2, 'fade', 0.6)
    const current = shallowRef(project), editor = ref(null)
    let history = createHistory(current.value)
    const fixture = window.soundFixture = { current, editor, nextTick, prepared: new Map([[video.id, videoBlob]]), changes: [], busy: false,
      undo() { history = undoHistory(history); current.value = history.present },
      redo() { history = redoHistory(history); current.value = history.present },
      replace(next) { current.value = validateProject(next, { trusted: true }); history = createHistory(current.value) },
    }
    fixture.app = createApp({ render: () => h(Editor, { ref: editor, project: current.value,
      commitProject: async next => { await new Promise(resolve => setTimeout(resolve, 120)); history = commitHistory(history, next); current.value = next; fixture.changes.push(next) },
      onChange: next => { history = commitHistory(history, next); current.value = next; fixture.changes.push(next) },
      onPreparedAsset: (asset, blob) => fixture.prepared.set(asset.id, blob), onBusy: busy => { fixture.busy = busy },
    }) })
    fixture.app.mount('#app')
    window.soundAuditions = []
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (...args) { if (!window.soundAuditions.includes(this)) window.soundAuditions.push(this); return play.apply(this, args) }
  })
  await expect(page.locator('[data-clip-id="part-0"]')).toBeVisible()
}

async function openSounds(page) {
  await page.getByTestId('transition-open').click()
  await page.getByTestId('transition-sound-tab').click()
}
async function insertSound(page, id) {
  await page.locator(`[data-sound-id="${id}"] .sound-choice`).click()
  await page.getByTestId('transition-sound-add').click()
  await expect(dialog(page)).toHaveCount(0)
}

async function galleryAndInsertion(page) {
  const before = await read(page)
  const transition = before.tracks.flatMap(track => track.clips).find(clip => clip.transition)
  await page.locator(`[data-clip-id="${transition.id}"]`).click()
  await page.evaluate(() => window.soundFixture.editor.value.seek(4.2))
  await openSounds(page)
  await expect(page.getByTestId('transition-sound-item')).toHaveCount(10)
  await expect(dialog(page)).toContainText('重音对齐切点 2.00 秒')
  await expect(page.getByTestId('transition-sound-add')).toBeDisabled()
  await page.locator('[data-sound-preview="chime"]').click()
  await expect.poll(() => page.evaluate(() => window.soundAuditions.some(audio => !audio.paused && audio.currentTime > .03))).toBe(true)
  assert.deepEqual(await read(page), before, '试听不得修改工程')
  await page.evaluate(() => { window.lastSoundAudition = window.soundAuditions.find(audio => !audio.paused) })
  await dialog(page).getByRole('tab', { name: '画面转场' }).click()
  assert(await page.evaluate(() => window.lastSoundAudition.paused && !window.lastSoundAudition.getAttribute('src')), '切换页签停止并释放试听')
  await page.getByTestId('transition-sound-tab').click()
  await page.screenshot({ path: path.join(artifacts, 'library.png') })
  await insertSound(page, 'air-sweep')
  const next = await read(page), clip = soundClips(next)[0], asset = next.assets.find(asset => asset.id === clip.assetId)
  assert.equal(clip.start, 1.65)
  assert.equal(clip.trimIn, 0)
  assert.equal(clip.trimOut, .8)
  assert.equal(asset.libraryRole, 'transition-sound')
  assert.equal(await page.locator('.asset-card').count(), 1, '内置音效不混入已导入素材库')
  await expect(page.locator(`[data-clip-id="${clip.id}"]`)).toHaveClass(/selected/)
  assert.deepEqual(next.tracks.slice(0, -1), before.tracks)
  await page.evaluate(() => window.soundFixture.undo())
  assert.deepEqual(await read(page), before)
  await page.evaluate(() => window.soundFixture.redo())
  assert.deepEqual(await read(page), next)
  console.log('PASS 10音效GUI、真实试听与资源释放、异步工程归档完成后入轨、选中转场优先对齐、素材库隔离及撤销重做')
  return next
}

async function verifyPreviewAndExport(page) {
  const previewPeak = await page.evaluate(async () => {
    const { TimelinePreview } = await import('/src/core/preview.ts')
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const preview = new TimelinePreview(canvas, window.soundFixture.current.value)
    const audio = new AudioContext()
    try {
      await preview.prepare()
      const stream = await preview.enableAudio(false)
      const analyser = audio.createAnalyser()
      analyser.fftSize = 1024
      audio.createMediaStreamSource(stream).connect(analyser)
      await audio.resume()
      await preview.playReady(1.5)
      const values = new Float32Array(analyser.fftSize), origin = performance.now()
      let peak = 0
      while (performance.now() - origin < 1250) {
        preview.render(1.5 + (performance.now() - origin) / 1000, true)
        analyser.getFloatTimeDomainData(values)
        for (const value of values) peak = Math.max(peak, Math.abs(value))
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
      return peak
    } finally { preview.dispose(); await audio.close() }
  })
  assert(previewPeak > .02, `正常时间线预览必须输出真实音效，peak=${previewPeak}`)
  const output = Buffer.from(await page.evaluate(async () => {
    const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
    const blob = await exportTimelineWebM(window.soundFixture.current.value, { videoBitsPerSecond: 200000 })
    return [...new Uint8Array(await blob.arrayBuffer())]
  }))
  const exportedPath = path.join(artifacts, 'transition-sound.webm')
  writeFileSync(exportedPath, output)
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', exportedPath], { encoding: 'utf8' }))
  assert(probe.streams.some(stream => stream.codec_type === 'audio'))
  assert(probe.streams.some(stream => stream.codec_type === 'video'))
  const packets = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', exportedPath], { encoding: 'utf8' })).packets
  const duration = Math.max(...packets.map(packet => Number(packet.pts_time) + Number(packet.duration_time || 0)))
  assert(Math.abs(duration - 6) < .3, `浏览器流式 WebM 的实际包时长应为 6 秒，收到 ${duration}`)
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', exportedPath, '-map', '0:a:0', '-ac', '1', '-ar', '24000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 2000000 })
  const rms = (start, end) => {
    let sum = 0, count = 0
    for (let index = Math.floor(start * 24000); index < Math.min(Math.floor(end * 24000), pcm.length / 4); index++) { const value = pcm.readFloatLE(index * 4); sum += value * value; count++ }
    return Math.sqrt(sum / count)
  }
  const sound = rms(1.8, 2.3), quiet = Math.max(rms(.3, 1), rms(3, 5.5))
  assert(sound > .01, `导出切点附近必须有实际音效，RMS=${sound}`)
  assert(quiet < .001, `音效外应保持静音，RMS=${quiet}`)
  console.log(`PASS 正常预览实际音频输出 peak=${previewPeak.toFixed(4)}；WebM真实编码并经ffmpeg解码，切点RMS=${sound.toFixed(4)}，无声区RMS=${quiet.toFixed(6)}`)
}

async function persistenceAndReuse(page, original) {
  const restored = await page.evaluate(async () => {
    const fixture = window.soundFixture
    const { saveProject, loadProject } = await import('/src/core/storage.ts')
    const { exportProjectFile, importProjectFile } = await import('/src/core/project-file.ts')
    await saveProject(fixture.current.value, fixture.prepared)
    const stored = await loadProject(fixture.current.value.id)
    const archive = await exportProjectFile(stored.project, { blobs: stored.blobs })
    const portable = await importProjectFile(archive)
    try {
      const source = portable.project.assets.find(asset => asset.libraryRole === 'transition-sound')
      const audio = new AudioContext()
      try {
        const decoded = await audio.decodeAudioData(await portable.blobs.get(source.id).arrayBuffer())
        return { tracks: portable.project.tracks, duration: decoded.duration, size: portable.blobs.get(source.id).size, role: source.libraryRole }
      } finally { await audio.close() }
    } finally { portable.revoke(); stored.revoke() }
  })
  assert.deepEqual(restored.tracks, original.tracks)
  assert.equal(restored.duration, .8)
  assert.equal(restored.role, 'transition-sound')
  assert(restored.size > 30000)
  await page.evaluate(() => window.soundFixture.editor.value.seek(4.1))
  await openSounds(page)
  await expect(dialog(page)).toContainText('重音对齐切点 4.00 秒')
  await insertSound(page, 'air-sweep')
  let next = await read(page)
  assert.equal(next.assets.length, original.assets.length)
  assert.equal(next.tracks.filter(track => track.name === '转场音效').length, 1)
  assert.equal(soundClips(next)[1].start, 3.65)
  await openSounds(page)
  await insertSound(page, 'impact')
  next = await read(page)
  assert.equal(next.tracks.filter(track => track.name === '转场音效').length, 2)
  assert.equal(soundClips(next).length, 3)
  await page.screenshot({ path: path.join(artifacts, 'timeline.png') })
  console.log('PASS 本地草稿和便携项目真实音频字节保存重开、最近切点对齐、资产和空闲音轨复用、重叠音效新建音轨')
}

async function failureAndLifecycle(page, url) {
  await page.evaluate(() => {
    const fixture = window.soundFixture, project = JSON.parse(JSON.stringify(fixture.current.value))
    project.tracks = project.tracks.filter(track => track.kind !== 'transition')
    project.tracks.find(track => track.kind === 'video').clips = []
    fixture.replace(project)
  })
  await openSounds(page)
  await page.locator('[data-sound-id="air-sweep"] .sound-choice').click()
  await expect(page.getByTestId('transition-sound-add')).toBeDisabled()
  await expect(dialog(page)).toContainText('先分割视频')
  await page.keyboard.press('Escape')
  for (const action of ['switch', 'unmount']) {
    await mount(page, url)
    let pending, release
    const pattern = '**/transition-sounds/air-sweep.wav*'
    await page.route(pattern, route => { pending = route; return new Promise(resolve => { release = resolve }) })
    await openSounds(page)
    await page.locator('[data-sound-id="air-sweep"] .sound-choice').click()
    await page.getByTestId('transition-sound-add').click()
    await expect.poll(() => Boolean(pending)).toBe(true)
    await expect.poll(() => page.evaluate(() => window.soundFixture.busy)).toBe(true)
    await page.evaluate(async action => {
      const fixture = window.soundFixture
      if (action === 'unmount') fixture.app.unmount()
      else fixture.replace((await import('/src/core/project.ts')).createProject('切换后的项目'))
      await fixture.nextTick()
    }, action)
    await pending.abort().catch(() => {})
    release()
    await page.unroute(pattern)
    await expect.poll(() => page.evaluate(() => window.soundFixture.busy)).toBe(false)
    assert.equal(await page.evaluate(() => window.soundFixture.changes.length), 0)
    assert.equal(await page.evaluate(() => window.soundFixture.prepared.size), 1)
  }
  console.log('PASS 无切点不可添加，导入中切项目/卸载会取消，迟到结果不污染项目且释放忙碌状态')
}

async function main() {
  mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000)
  const url = `http://127.0.0.1:${server.httpServer.address().port}`
  try {
    await mount(page, url)
    const original = await galleryAndInsertion(page)
    await verifyPreviewAndExport(page)
    await persistenceAndReuse(page, original)
    await failureAndLifecycle(page, url)
    assert.deepEqual(errors, [])
  } catch (error) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {}); throw error }
  finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
