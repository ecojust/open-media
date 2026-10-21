const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('@playwright/test')

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-preview-resources-'))
  const source = path.join(directory, 'source.webm')
  execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xe04020:s=160x96:r=30:d=2', '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', source])
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/preview-resource-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/preview-resource-test`)
    const report = await page.evaluate(async base64 => {
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { createProject, createClip, createTrack } = await import('/src/core/project.ts')
      const data = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
      const media = []
      const createElement = document.createElement.bind(document)
      document.createElement = function (tag, options) {
        const element = createElement(tag, options)
        if (element instanceof HTMLMediaElement) media.push(element)
        return element
      }
      const project = createProject('六十素材预览资源验证', { width: 160, height: 96, fps: 30 })
      project.assets = Array.from({ length: 60 }, (_, index) => {
        const blob = new Blob([data], { type: 'video/webm' })
        return { id: `asset-${index}`, name: `素材 ${index + 1}`, kind: 'video', url: URL.createObjectURL(blob), duration: 2, width: 160, height: 96, size: blob.size, mime: blob.type }
      })
      project.tracks = [{ ...createTrack('video'), clips: project.assets.map((asset, index) => createClip(asset, project, { id: `clip-${index}`, start: index * 0.4, trimIn: 0.2, trimOut: 0.6, volume: 0 })) }]
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 96
      const notices = [], preview = new TimelinePreview(canvas, project, message => notices.push(message))
      const resident = () => media.filter(element => element.hasAttribute('src')).length
      const counts = [resident()], seeks = []
      try {
        await preview.enableAudio(false)
        await preview.playReady(0.05)
        const started = performance.now()
        await new Promise(resolve => {
          function tick() {
            const elapsed = Math.min(2.4, (performance.now() - started) / 1000)
            preview.render(0.05 + elapsed, true)
            counts.push(resident())
            if (elapsed >= 2.4) resolve(); else requestAnimationFrame(tick)
          }
          tick()
        })
        preview.pause()
        for (const time of [19.9, 0.1, 23.7, 8.9, 15.3, 0.1]) {
          await preview.seekReady(time)
          counts.push(resident())
          seeks.push({ time, pixel: [...canvas.getContext('2d').getImageData(80, 48, 1, 1).data] })
        }
        const released = media.find(element => !element.hasAttribute('src'))
        released.dispatchEvent(new Event('error'))
        released.dispatchEvent(new Event('loadeddata'))
        const overlapProject = { ...project, tracks: [
          { ...createTrack('video'), clips: [createClip(project.assets[0], project, { id: 'overlap-left', trimIn: 0.2, trimOut: 1.2, volume: 0 })] },
          { ...createTrack('video'), clips: [createClip(project.assets[0], project, { id: 'overlap-right', trimIn: 0.4, trimOut: 1.4, volume: 0 })] },
        ] }
        preview.setProject(overlapProject)
        await preview.playReady(0.1)
        const overlap = media.filter(element => element.hasAttribute('src')).map(element => ({ paused: element.paused, time: element.currentTime }))
        const boundary = 0.713
        const splitProject = { ...project, tracks: [{ ...createTrack('video'), clips: [
          createClip(project.assets[0], project, { id: 'split-left', trimIn: 0.137, trimOut: 0.85, volume: 0 }),
          createClip(project.assets[0], project, { id: 'split-right', start: boundary, trimIn: 0.85, trimOut: 1.8, volume: 0 }),
        ] }] }
        preview.setProject(splitProject)
        await preview.playReady(boundary - 0.08)
        const splitFrames = [], splitStart = performance.now()
        await new Promise(resolve => {
          function tick() {
            const elapsed = (performance.now() - splitStart) / 1000
            preview.render(boundary - 0.08 + elapsed, true)
            splitFrames.push([...canvas.getContext('2d').getImageData(80, 48, 1, 1).data])
            if (elapsed >= 0.26) resolve(); else requestAnimationFrame(tick)
          }
          tick()
        })
        preview.dispose()
        return { initial: counts[0], maximum: Math.max(...counts), created: media.length, remaining: resident(), seeks, overlap, splitFrames, notices }
      } finally {
        preview.dispose()
        project.assets.forEach(asset => URL.revokeObjectURL(asset.url))
      }
    }, fs.readFileSync(source).toString('base64'))
    assert(report.initial <= 5 && report.maximum <= 5, `六十个顺序片段不应同时保留解码资源：${JSON.stringify(report)}`)
    assert.equal(report.remaining, 0, '关闭预览必须释放所有媒体源')
    for (const frame of report.seeks) assert(frame.pixel[0] > 150 && frame.pixel[1] < 100, `跳转到未加载片段后必须显示真实视频画面：${JSON.stringify(frame)}`)
    assert.equal(report.overlap.length, 2, '重叠片段必须各自保留独立的媒体播放位置')
    assert(report.overlap.every(element => !element.paused), '重叠片段必须同时播放')
    assert(Math.abs(report.overlap[1].time - report.overlap[0].time - 0.2) < 0.05, '同素材重叠片段必须保持各自的裁剪位置')
    assert(report.splitFrames.every(pixel => pixel[0] > 150 && pixel[1] < 100), '释放离开播放位置的媒体源时，分割处必须保持连续画面')
    assert.deepEqual(report.notices, [])
    assert.deepEqual(errors, [])
    console.log(`PASS 六十个真实视频片段顺序播放、远距离来回跳转、重叠独立定位与资源释放：${JSON.stringify(report)}`)

    const thumbnails = await page.evaluate(async base64 => {
      const source = await (await fetch('/src/components/AssetMediaPreview.vue')).text()
      const { createApp, h, ref, nextTick } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const Thumbnail = (await import('/src/components/AssetMediaPreview.vue')).default
      const data = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
      const urls = [0, 1].map(() => URL.createObjectURL(new Blob([data], { type: 'video/webm' })))
      const callbacks = [], NativeObserver = window.IntersectionObserver
      window.IntersectionObserver = class extends NativeObserver {
        constructor(callback, options) { super(callback, options); callbacks.push(callback) }
      }
      const sources = ref(Array.from({ length: 60 }, () => urls[0]))
      const host = document.createElement('div'); document.body.append(host)
      const app = createApp({ render: () => h('div', { class: 'asset-list', style: 'width:160px;height:240px;overflow:auto' }, sources.value.map((src, index) => h(Thumbnail, { key: index, src, kind: 'video', active: false, style: 'display:block;width:160px;height:80px' }))) })
      app.mount(host)
      let mounted = true
      await nextTick()
      const videos = [...host.querySelectorAll('video')], list = host.querySelector('.asset-list')
      const count = () => videos.filter(video => video.hasAttribute('src')).length
      async function until(check) {
        const start = performance.now()
        while (!check()) {
          if (performance.now() - start > 5000) throw new Error('素材缩略图状态未在五秒内就绪')
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      try {
        await until(() => videos[0].readyState >= 2)
        const initial = count()
        sources.value[0] = urls[1]; sources.value[59] = urls[1]
        await nextTick()
        await until(() => videos[0].currentSrc === urls[1] && videos[0].readyState >= 2)
        const hiddenSourceRemainsUnloaded = !videos[59].hasAttribute('src')
        list.scrollTop = list.scrollHeight
        await until(() => videos[59].currentSrc === urls[1] && videos[59].readyState >= 2 && !videos[0].hasAttribute('src'))
        const bottom = count()
        list.scrollTop = 0
        await until(() => videos[0].currentSrc === urls[1] && videos[0].readyState >= 2 && !videos[59].hasAttribute('src'))
        const topAgain = count(), decoded = videos[0].videoWidth
        app.unmount(); mounted = false
        for (const callback of callbacks) callback([{ isIntersecting: true }])
        return { initial, bottom, topAgain, hiddenSourceRemainsUnloaded, decoded, afterUnmountAndLateObserver: count() }
      } finally {
        if (mounted) app.unmount()
        host.remove(); urls.forEach(url => URL.revokeObjectURL(url)); window.IntersectionObserver = NativeObserver
      }
    }, fs.readFileSync(source).toString('base64'))
    assert([thumbnails.initial, thumbnails.bottom, thumbnails.topAgain].every(count => count > 0 && count <= 6), `素材列表仅应加载可见区域附近的缩略图：${JSON.stringify(thumbnails)}`)
    assert(thumbnails.hiddenSourceRemainsUnloaded, '更换隐藏素材的来源不应启动解码')
    assert.equal(thumbnails.decoded, 160, '滚回可见区域必须重新解码真实视频缩略图')
    assert.equal(thumbnails.afterUnmountAndLateObserver, 0, '卸载后到达的可见性通知不得重新加载素材')
    assert.deepEqual(errors, [])
    console.log(`PASS 六十个视频缩略图按可见范围加载、滚动释放与重新解码、来源变更及卸载：${JSON.stringify(thumbnails)}`)
  } finally {
    await browser.close()
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
