const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { chromium } = require('@playwright/test')

async function main() {
  const root = path.resolve(__dirname, '../..')
  const revision = process.env.OPEN_MEDIA_PREVIEW_REF || 'current'
  const directory = process.env.OPEN_MEDIA_PERFORMANCE_REPORT || path.join(os.tmpdir(), 'open-media-preview-performance')
  fs.mkdirSync(directory, { recursive: true })
  const source = path.join(directory, 'source-1080p.webm')
  if (!fs.existsSync(source)) execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=6', '-c:v', 'libvpx',
    '-threads', '2', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '4M', '-pix_fmt', 'yuv420p', source,
  ])
  const oldPreview = revision === 'current' ? undefined : execFileSync('git', ['show', `${revision}:src/core/preview.ts`], { cwd: root, encoding: 'utf8' })
  const { createServer } = await import('vite')
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-preview-performance-vite-'))
  const server = await createServer({ root, cacheDir,
    plugins: oldPreview ? [{ name: 'preview-baseline', enforce: 'pre', load(id) { if (id.split('?')[0] === path.join(root, 'src/core/preview.ts')) return oldPreview } }] : [],
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error',
  })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), headless: true,
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__preview_performance', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><canvas width="1920" height="1080"></canvas></body></html>' }))
    await page.route('**/__performance_video.webm', route => route.fulfill({ contentType: 'video/webm', body: fs.readFileSync(source) }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__preview_performance`)
    const report = await page.evaluate(async () => {
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { createProject, createClip, createTextClip, createTrack } = await import('/src/core/project.ts')
      const { addTransition } = await import('/src/core/transitions.ts')
      const { measureTextLayout } = await import('/src/core/text-layout.ts')
      let measures = 0, drawCount = 0
      const presentedFrames = new WeakMap(), requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        return requestFrame.call(this, (now, metadata) => { presentedFrames.set(this, metadata.mediaTime); callback(now, metadata) })
      }
      const measure = CanvasRenderingContext2D.prototype.measureText
      CanvasRenderingContext2D.prototype.measureText = function (...args) { measures++; return measure.apply(this, args) }
      const media = [], create = document.createElement.bind(document)
      document.createElement = function (tag, ...args) { const element = create(tag, ...args); if (element instanceof HTMLMediaElement) media.push(element); return element }
      let project = createProject('1080p 七十片段性能', { width: 1920, height: 1080, fps: 30 })
      const videoBlob = await (await fetch('/__performance_video.webm')).blob()
      const asset = { id: 'video', name: '动态视频', kind: 'video', url: URL.createObjectURL(videoBlob), duration: 6, width: 1920, height: 1080, size: videoBlob.size, mime: 'video/webm' }
      project.assets = [asset]
      project.tracks = [createTrack('video'), createTrack('audio'), createTrack('text')]
      project.tracks.find(track => track.kind === 'video').clips = [createClip(asset, project, { id: 'first', trimOut: 3, volume: 0 }), createClip(asset, project, { id: 'second', start: 3, trimIn: 3, trimOut: 6, volume: 0 })]
      // Twelve simultaneous annotations stress layout; the remaining captions
      // exercise traversal without artificially decoding dozens of video files.
      project.tracks.find(track => track.kind === 'text').clips = Array.from({ length: 67 }, (_, i) => createTextClip(project, {
        id: 'text-' + i, text: `${i + 1} 科普知识 · 从图像认识世界 Open Media keeps video, subtitles and transitions in one preview.`,
        start: i < 12 ? 0 : 10 + (i - 12) * 2, trimOut: 6, fontSize: 24 + (i % 3) * 4, width: 620, height: 150,
        x: (i % 3) * 640, y: Math.floor((i % 12) / 3) * 240, background: i % 2 ? '#102030' : 'transparent',
        textAlign: ['left', 'center', 'right'][i % 3], textVerticalAlign: ['top', 'middle', 'bottom'][i % 3],
        keyframes: i % 3 === 0 ? { opacity: [{ time: 0, value: .5 }, { time: 6, value: 1 }] } : undefined,
      }))
      project = addTransition(project, 3, 'pixel-dissolve', 1.2)
      const canvas = document.querySelector('canvas'), messages = []
      const preview = new TimelinePreview(canvas, project, message => messages.push(message))
      const draw = preview.draw
      preview.draw = function (...args) { drawCount++; return draw.apply(this, args) }
      const resident = () => media.filter(element => element.hasAttribute('src')).length
      const stats = values => { const sorted = [...values].sort((a, b) => a - b); return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, p50: sorted[Math.floor(values.length * .5)], p95: sorted[Math.floor(values.length * .95)], max: sorted.at(-1) } }
      try {
        await preview.enableAudio(false)
        const startup = performance.now(); await preview.playReady(.1); const startupMs = performance.now() - startup
        const durations = [], intervals = [], liveMediaTimes = [], start = performance.now()
        let prior = start, maxResident = resident(); measures = 0
        await new Promise(resolve => {
          function frame(now) {
            const time = .1 + (now - start) / 1000
            intervals.push(now - prior); prior = now
            const t0 = performance.now(); preview.render(time, true); durations.push(performance.now() - t0)
            maxResident = Math.max(maxResident, resident())
            if (time >= .5 + liveMediaTimes.length) liveMediaTimes.push(preview.activeEntries(time)
              .filter(entry => entry.media instanceof HTMLVideoElement).map(entry => entry.media.currentTime))
            if (time >= 5.5) resolve(); else requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        })
        const playbackMeasures = measures
        preview.pause()
        // Drain the final asynchronous seek/presentation caused by pausing.
        // A stopped renderer must then remain idle, not repaint continuously.
        const settlingStarted = performance.now()
        let quietSince = settlingStarted, observedDraws = drawCount
        while (performance.now() - quietSince < 250) {
          if (performance.now() - settlingStarted > 3000) throw new Error('暂停后的画面未能在三秒内停止重绘')
          await new Promise(resolve => setTimeout(resolve, 25))
          if (drawCount !== observedDraws) { observedDraws = drawCount; quietSince = performance.now() }
        }
        const pauseSettlingMs = performance.now() - settlingStarted
        const idleStart = drawCount; await new Promise(resolve => setTimeout(resolve, 500)); const idleDraws = drawCount - idleStart
        const hashes = []
        for (const time of [1, 2.6, 2.95, 3.05, 3.4, 4.5]) {
          // Start until a real video frame is presented, then pause. Some engines
          // do not issue a new frame callback for an already-paused seek.
          await preview.playReady(time); preview.pause()
          const presented = preview.activeEntries(time).filter(entry => entry.media instanceof HTMLVideoElement)
            .map(entry => ({ currentTime: entry.media.currentTime, presentedTime: presentedFrames.get(entry.media) }))
          const data = canvas.getContext('2d').getImageData(0, 0, 1920, 1080).data
          // Paint the SAME decoded frame synchronously with direct measurement.
          // This isolates cache correctness from two decoders choosing adjacent
          // frames, while preserving the real video, animations and transition.
          const cache = preview.textLayoutCache, cachedGet = cache?.get
          let expected
          try {
            if (cache) cache.get = measureTextLayout
            preview.render(time, false)
            expected = canvas.getContext('2d').getImageData(0, 0, 1920, 1080).data
          } finally { if (cache) cache.get = cachedGet }
          let hash = 2166136261, mismatches = 0
          for (let i = 0; i < data.length; i++) { hash = Math.imul(hash ^ data[i], 16777619); if (data[i] !== expected[i]) mismatches++ }
          hashes.push({ time, hash: hash >>> 0, mismatches, presented })
        }
        preview.dispose()
        return { scenario: '1080p 动态视频、70 片段、12 个同时显示字幕及标题、碎片转场',
          userAgent: navigator.userAgent, clips: project.tracks.reduce((count, track) => count + track.clips.length, 0), startupMs,
          frameMs: stats(durations), intervalMs: stats(intervals), frames: durations.length, measureCalls: playbackMeasures,
          measureCallsPerFrame: playbackMeasures / durations.length, idleDraws, pauseSettlingMs, maxResident, remaining: resident(), liveMediaTimes, hashes, messages }
      } finally {
        preview.dispose(); CanvasRenderingContext2D.prototype.measureText = measure; document.createElement = create
        HTMLVideoElement.prototype.requestVideoFrameCallback = requestFrame
        URL.revokeObjectURL(asset.url)
      }
    })
    report.environment = { revision, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      platform: process.platform, arch: process.arch, node: process.version, browser: browser.version(), cpu: os.cpus()[0]?.model }
    fs.writeFileSync(path.join(directory, `preview-${revision.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify(report, null, 2))
    assert.equal(report.clips, 70)
    assert.equal(report.idleDraws, 0, '暂停后不应继续重绘')
    assert(report.maxResident <= 2, '顺序视频仅保留当前及临近片段解码器')
    assert.equal(report.remaining, 0, '关闭后必须释放所有媒体源')
    const liveTimes = report.liveMediaTimes.flat()
    assert(liveTimes.length >= 5 && liveTimes.at(-1) - liveTimes[0] > 3, '测量期间真实视频必须持续解码播放')
    for (const frame of report.hashes) {
      assert.equal(frame.mismatches, 0, `${frame.time} 秒画面须与无缓存参考逐像素一致`)
      for (const media of frame.presented) {
        assert(Number.isFinite(media.presentedTime) && media.currentTime >= 0 && media.currentTime < 6,
          `须记录真实呈现的源帧，而不是空白画面：${JSON.stringify(frame)}`)
      }
    }
    assert(new Set(report.hashes.flatMap(frame => frame.presented.map(media => media.presentedTime))).size >= 4,
      '不同时间点必须实际呈现不同源视频帧')
    if (revision === 'current') assert(report.measureCallsPerFrame < 1, '已缓存字幕不应每帧重复测量')
    assert.deepEqual(report.messages, []); assert.deepEqual(errors, [])
    console.log(`PASS 真实 1080p 合成性能、字体缓存、暂停与解码器释放：${JSON.stringify(report)}`)
  } finally { await browser?.close(); await server.close(); fs.rmSync(cacheDir, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
