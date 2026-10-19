const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { chromium, webkit, expect } = require('@playwright/test')

function installCanvasStats() {
  window.compositeFixture.stats = canvas => {
    const sample = document.createElement('canvas'); sample.width = 320; sample.height = 180
    const ctx = sample.getContext('2d', { willReadFrequently: true }); ctx.drawImage(canvas, 0, 0, 320, 180)
    const data = ctx.getImageData(0, 0, 320, 180).data, groups = { blue: [0, 0, 0], red: [0, 0, 0], cyan: [0, 0, 0], white: [0, 0, 0], green: [0, 0, 0] }
    let hash = 2166136261, watermarkHash = 2166136261, luma = 0
    for (let i = 0; i < data.length; i += 4) {
      const x = i / 4 % 320, y = Math.floor(i / 1280), [r, g, b] = data.subarray(i, i + 3)
      hash = Math.imul(hash ^ (r + 3 * g + 7 * b), 16777619)
      if (x > 190 && y < 80) watermarkHash = Math.imul(watermarkHash ^ (r + 3 * g + 7 * b), 16777619)
      luma += (r + g + b) / 3
      const names = []
      if (b > 100 && b > r * 1.5 && b > g * 1.5) names.push('blue')
      if (r > 120 && r > g * 2 && r > b * 2) names.push('red')
      if (y > 125 && r < 80 && g > 150 && b > 150) names.push('cyan')
      if (x > 190 && y < 80 && r > 180 && g > 180 && b > 180) names.push('white')
      if (g > 100 && g > r * 2 && g > b * 2) names.push('green')
      for (const name of names) { groups[name][0]++; groups[name][1] += x; groups[name][2] += y }
    }
    return { hash: hash >>> 0, watermarkHash: watermarkHash >>> 0, luma: luma / (320 * 180), ...Object.fromEntries(Object.entries(groups).map(([key, [count, x, y]]) => [key, { count, x: count ? x / count : null, y: count ? y / count : null }])) }
  }
}

// Actual VideoEditor playback, without prepare(): seek-only tests enable a different
// media residency path and cannot detect live compositing regressions.
async function main() {
  const root = path.resolve(__dirname, '../..')
  const browserName = process.env.OPEN_MEDIA_BROWSER || 'chromium'
  const revision = process.env.OPEN_MEDIA_PREVIEW_REF || 'current'
  const appMode = process.argv.includes('--app')
  const artifacts = process.env.OPEN_MEDIA_COMPOSITE_REPORT || (process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'preview-composite') : path.join(tmpdir(), 'open-media-preview-composite'))
  const directory = path.join(artifacts, `${browserName}-${revision}${appMode ? '-app' : ''}`)
  fs.mkdirSync(directory, { recursive: true })
  const mediaDirectory = path.dirname(directory), source = path.join(mediaDirectory, 'moving-source.webm'), segment = path.join(mediaDirectory, 'segment.webm')
  if (!fs.existsSync(source)) execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2040d0:s=640x360:r=30:d=8', '-f', 'lavfi', '-i', 'color=c=0xee2020:s=50x50:r=30:d=8', '-filter_complex', '[0:v][1:v]overlay=x=30+40*t:y=170:shortest=1', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p', source])
  if (!fs.existsSync(segment)) execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-i', path.join(root, 'src/assets/video-segments/prism-dawn.webm'), '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p', segment])
  const { createServer } = await import('vite')
  const oldPreview = revision === 'current' ? undefined : execFileSync('git', ['show', `${revision}:src/core/preview.ts`], { cwd: root, encoding: 'utf8' })
  const cacheDir = fs.mkdtempSync(path.join(tmpdir(), 'open-media-preview-composite-vite-'))
  const server = await createServer({ root, cacheDir, plugins: oldPreview ? [{ name: 'preview-comparison', enforce: 'pre', load(id) { if (id.split('?')[0] === path.join(root, 'src/core/preview.ts')) return oldPreview } }] : [], server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const profile = browserName === 'webkit' ? fs.mkdtempSync(path.join(directory, 'profile-')) : undefined
  let browser
  try {
    browser = await (browserName === 'webkit' ? webkit.launchPersistentContext(profile, { headless: true, viewport: { width: 1440, height: 960 }, acceptDownloads: true }) : chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }))
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(30000)
    await page.route('**/__composite__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}</style><div id="app"></div>' }))
    await page.route('**/__source.webm', route => route.fulfill({ contentType: 'video/webm', body: fs.readFileSync(source) }))
    await page.route('**/__segment.webm', route => route.fulfill({ contentType: 'video/webm', body: fs.readFileSync(segment) }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__composite__`)
    await page.evaluate(async () => {
      await import('/src/style.css')
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const { createApp, h, shallowRef, ref, nextTick } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { createProject, createClip, createTextClip, validateProject } = await import('/src/core/project.ts')
      const { importMediaFile } = await import('/src/core/media-import.ts')
      const { addWatermark } = await import('/src/core/watermark-track.ts')
      const { addTransition } = await import('/src/core/transitions.ts')
      const asset = async (url, name) => { const blob = await (await fetch(url)).blob(); return importMediaFile(new File([blob], name, { type: 'video/webm' })) }
      const [original, intro, watermark] = await Promise.all([asset('/__source.webm', '移动原视频.webm'), asset('/__segment.webm', '真实片头片尾.webm'), asset('/watermarks/loading-dots.webm', '动态水印.webm')])
      let project = createProject('连续合成验证', { width: 640, height: 360, fps: 30, background: '#000000' })
      project.assets.push(original, intro)
      const videoTrack = project.tracks.find(track => track.kind === 'video')
      videoTrack.clips.push(
        createClip(intro, project, { id: 'intro', trimOut: 1, volume: 0 }),
        createClip(original, project, { id: 'body-a', start: 1, trimOut: 4, volume: 0, keyframes: { x: [{ time: 0, value: -50 }, { time: 3, value: 0 }], scaleX: [{ time: 0, value: .65 }, { time: 3, value: 1 }], scaleY: [{ time: 0, value: .65 }, { time: 3, value: 1 }] } }),
        createClip(original, project, { id: 'body-b', start: 5, trimIn: 4, trimOut: 8, volume: 0 }),
        createClip(intro, project, { id: 'outro', start: 9, trimIn: 3, trimOut: 4, volume: 0 }),
      )
      project.tracks.find(track => track.kind === 'text').clips.push(createTextClip(project, { id: 'moving-caption', text: '字幕运动', start: 1, trimOut: 8, x: 20, y: 282, width: 240, height: 60, fontSize: 30, color: '#00ffff', keyframes: { x: [{ time: 0, value: 20 }, { time: 8, value: 360 }] } }))
      project = addWatermark(project, watermark, 1.2, { placement: 'top-right', chromaKey: true, spillSuppression: true }).project
      project = addWatermark(project, watermark, 5.8, { placement: 'top-right', chromaKey: true, spillSuppression: true }).project
      for (const cut of [1, 5, 9]) project = addTransition(project, cut, 'fade', 1, videoTrack.id, { color: '#000000' })
      const current = shallowRef(validateProject(project, { trusted: true })), editor = ref(null)
      const fixture = window.compositeFixture = { current, editor, messages: [], frames: [], samples: [], media: [], renderCount: 0, TimelinePreview }
      const createElement = document.createElement.bind(document)
      document.createElement = function (tag, options) { const node = createElement(tag, options); if (node instanceof HTMLMediaElement) fixture.media.push(node); return node }
      const render = TimelinePreview.prototype.render
      TimelinePreview.prototype.render = function (...args) { const result = render.apply(this, args); if (!fixture.preview) fixture.preview = this; if (fixture.preview === this) fixture.renderCount++; return result }
      fixture.app = createApp({ render: () => h(Editor, { ref: editor, project: current.value, onChange: next => { current.value = next }, onStatus: message => fixture.messages.push(message) }) })
      fixture.app.mount('#app'); await nextTick()
    })
    await page.waitForFunction(() => window.compositeFixture.editor.value?.getCanvas())
    if (appMode) {
      await page.evaluate(async () => {
        const f = window.compositeFixture, project = f.current.value
        const { saveProject } = await import('/src/core/storage.ts')
        const blobs = new Map(await Promise.all(project.assets.map(async asset => [asset.id, await (await fetch(asset.url)).blob()])))
        await saveProject(project, blobs)
        localStorage.setItem('open-media:last-project', project.id)
        localStorage.setItem('open-media:autosave', 'true')
      })
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
      await expect(page.getByTestId('home-workspace')).toBeVisible()
      await page.evaluate(async () => {
        const { TimelinePreview } = await import('/src/core/preview.ts')
        const f = window.compositeFixture = { current: { value: null }, editor: { value: null }, messages: [], frames: [], samples: [], media: [], renderCount: 0, TimelinePreview }
        const render = TimelinePreview.prototype.render
        TimelinePreview.prototype.render = function (...args) { const result = render.apply(this, args); if (!f.preview || f.preview.disposed) f.preview = this; if (f.preview === this) f.renderCount++; return result }
      })
      await page.getByTestId('nav-edit').click()
      await expect(page.getByTestId('video-editor')).toBeVisible()
      await page.locator('[data-clip-id="moving-caption"]').click()
      const x = page.locator('.property-content').getByLabel('X', { exact: true })
      await x.fill('60'); await x.press('Tab')
      await page.locator('[data-clip-id="intro"]').click()
      await page.getByTestId('motion-preset-controls').locator('summary').click()
      await page.getByLabel('片段入退场动画预设').selectOption('pull-back')
      await page.getByTestId('motion-preset-apply').click()
      await expect.poll(() => page.evaluate(() => window.compositeFixture.preview.project.tracks.flatMap(track => track.clips).find(clip => clip.id === 'intro').keyframes?.scaleX?.[0]?.value)).toBe(1.06)
      await page.evaluate(() => { delete window.showSaveFilePicker })
      const download = page.waitForEvent('download')
      await page.getByTestId('save-project').click()
      const archive = path.join(directory, 'edited-project.omedia')
      await (await download).saveAs(archive)
      await expect(page.getByTestId('save-project')).toBeEnabled()
      await page.getByTestId('project-input').setInputFiles(archive)
      await expect(page.locator('[data-clip-id="moving-caption"]')).toBeVisible()
      await expect(page.getByTestId('save-project')).toBeEnabled()
      await page.locator('[data-clip-id="moving-caption"]').click()
      await expect(page.locator('.property-content').getByLabel('X', { exact: true })).toHaveValue('60')
      await page.evaluate(() => {
        const f = window.compositeFixture, instance = document.querySelector('[data-testid="video-preview"]').__vueParentComponent
        f.editor.value = instance.exposed
        f.current.value = instance.props.project
        f.appReopened = true
      })
    }
    await page.evaluate(installCanvasStats)
    await page.getByTitle('回到开头', { exact: true }).click()
    await page.getByTestId('preview-play').click()
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', '暂停（空格）')
    await page.evaluate(async () => {
      const f = window.compositeFixture, targets = [.25, .75, 1.8, 2.8, 3.8, 4.75, 5.25, 6.6, 7.6, 9.25, 9.75]
      if (!f.editor.value.getPlayback().playing) throw new Error('播放按钮未启动编辑器')
      const started = performance.now(); let lastSample = -1
      await new Promise((resolve, reject) => {
        function tick() {
          const state = f.editor.value.getPlayback(), time = state.time, canvas = f.editor.value.getCanvas()
          if (time - lastSample >= .09) {
            f.samples.push({ time, ...f.stats(canvas), decoders: [...f.preview.entries.values()].filter(entry => entry.media instanceof HTMLVideoElement && entry.media.hasAttribute('src')).map(entry => ({ assetId: entry.assetId, active: !!entry.active, time: entry.media.currentTime, paused: entry.media.paused, seeking: entry.media.seeking, ready: entry.media.readyState })) })
            lastSample = time
          }
          while (targets.length && time >= targets[0]) { f.frames.push({ target: targets.shift(), time, stats: f.stats(canvas), png: canvas.toDataURL('image/png') }) }
          if (time >= 9.85) { f.editor.value.pause(); resolve() }
          else if (performance.now() - started > 30000) reject(new Error(`连续播放未完成：${JSON.stringify(state)}`))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    })
    await page.screenshot({ path: path.join(directory, 'editor.png') })
    const report = await page.evaluate(async () => {
      const f = window.compositeFixture, canvas = document.createElement('canvas'), actual = f.editor.value.getCanvas()
      canvas.width = actual.width; canvas.height = actual.height
      const reference = new f.TimelinePreview(canvas, f.current.value, message => f.messages.push(message))
      try {
        await reference.prepare()
        for (const frame of f.frames) { await reference.seekReady(frame.time); frame.reference = f.stats(canvas); frame.referencePng = canvas.toDataURL('image/png') }
      } finally { reference.dispose() }
      return { appReopened: !!f.appReopened, userAgent: navigator.userAgent, canvas: { width: actual.width, height: actual.height }, renderCount: f.renderCount, frames: f.frames, samples: f.samples, messages: f.messages, project: f.current.value }
    })
    for (const [i, frame] of report.frames.entries()) { fs.writeFileSync(path.join(directory, `live-${i}-${frame.target}.png`), Buffer.from(frame.png.split(',')[1], 'base64')); fs.writeFileSync(path.join(directory, `seek-${i}-${frame.target}.png`), Buffer.from(frame.referencePng.split(',')[1], 'base64')); delete frame.png; delete frame.referencePng }
    report.errors = errors
    report.appAlerts = await page.getByRole('alert').allTextContents()
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    const middle = report.samples.filter(frame => frame.time > 1.6 && frame.time < 4.4)
    const late = report.samples.filter(frame => frame.time > 6.3 && frame.time < 8.6)
    const transitionRatios = [4.75, 5.25].map(target => report.frames.find(frame => frame.target === target).stats.luma / report.frames.find(frame => frame.target === 6.6).stats.luma)
    const captionAlignmentError = Math.max(...report.frames.filter(frame => frame.reference.cyan.count > 100).map(frame => Math.abs(frame.stats.cyan.x - frame.reference.cyan.x)))
    const summary = { browserName, revision, appReopened: report.appReopened, samples: report.samples.length, renderCount: report.renderCount, maxDecoders: Math.max(...report.samples.map(s => s.decoders.length)), redMotion: Math.max(...middle.map(s => s.red.x)) - Math.min(...middle.map(s => s.red.x)), captionMotion: Math.max(...middle.map(s => s.cyan.x)) - Math.min(...middle.map(s => s.cyan.x)), scaleAreaRatio: Math.max(...middle.map(s => s.blue.count)) / Math.min(...middle.map(s => s.blue.count)), watermarkMotion: new Set(late.map(s => s.watermarkHash)).size, lateWatermarkVisible: late.filter(s => s.white.count > 10).length, maxGreenLeak: Math.max(...late.map(s => s.green.count)), transitionRatios, captionAlignmentError, messages: report.messages, errors, appAlerts: report.appAlerts, directory }
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(JSON.stringify(summary))
    assert.equal(report.appAlerts.length, 0, `应用报告错误：${report.appAlerts.join('; ')}`)
    assert(transitionRatios.every(ratio => ratio < .8), '淡化转场应实际改变播放画面，而非只与缺失效果的参考一致')
    assert(captionAlignmentError < 3, '连续字幕动画应与同时间参考位置一致')
    assert.equal(errors.length, 0, `连续预览脚本异常：${errors.join('; ')}`)
    assert.equal(report.messages.length, 0, `连续预览素材异常：${report.messages.join('; ')}`)
    assert(middle.every(frame => frame.red.count > 100 && frame.cyan.count > 100), '连续播放时原视频及字幕应持续可见')
    assert(late.every(frame => frame.white.count > 10), '晚入场动态水印不应在连续播放时消失')
    assert(summary.redMotion > 30, '真实原视频中的物体应连续运动')
    assert(summary.captionMotion > 30, '字幕关键帧应连续运动')
    assert(summary.scaleAreaRatio > 1.3, '视频缩放关键帧应连续生效')
    assert(summary.watermarkMotion > 8 && summary.lateWatermarkVisible > 8, '晚于预加载窗口的动态水印应出现并连续运动')
    assert(summary.maxGreenLeak < 30, '绿幕水印应与原视频融合')
    for (const target of [4.75, 5.25]) { const frame = report.frames.find(item => item.target === target); assert(Math.abs(frame.stats.luma - frame.reference.luma) < 8, '播放中的转场亮度应接近同时间跳转参考') }
    console.log(`PASS 连续原视频、缩放移动、字幕关键帧、动态水印、片头片尾及转场；报告 ${directory}`)
  } finally { await browser?.close(); await server.close(); fs.rmSync(cacheDir, { recursive: true, force: true }); if (profile) fs.rmSync(profile, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
