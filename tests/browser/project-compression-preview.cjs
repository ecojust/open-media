const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('@playwright/test')

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-compression-preview-'))
  const originalPath = path.join(directory, 'original.webm'), compressedPath = path.join(directory, 'working.webm')
  const encode = args => execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', ...args])
  // These are real, distinct video files. Compression is not represented by fake
  // sizes or URLs: the lower-bitrate working copy must decode in the renderer.
  encode(['-f', 'lavfi', '-i', "testsrc2=s=320x180:r=24:d=6,drawbox=x=0:y=0:w=80:h=80:color=red:t=fill:enable='lt(t,3)',drawbox=x=0:y=0:w=80:h=80:color=blue:t=fill:enable='gte(t,3)',drawbox=x=0:y=100:w=320:h=80:color=black:t=fill", '-c:v', 'libvpx-vp9', '-lossless', '1', '-threads', '2', originalPath])
  encode(['-i', originalPath, '-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-g', '24', '-threads', '2', compressedPath])
  const originalBytes = fs.readFileSync(originalPath), compressedBytes = fs.readFileSync(compressedPath)
  assert(compressedBytes.length < originalBytes.length, '实际工作副本必须比测试原视频更小')
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
    const page = await browser.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__compression_preview__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><canvas width="320" height="180"></canvas></body></html>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__compression_preview__`)
    const result = await page.evaluate(async ({ original, compressed }) => {
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { createProject, createClip, createSubtitleClip, validateProject, cloneProject } = await import('/src/core/project.ts')
      const { addTransition } = await import('/src/core/transitions.ts')
      const { applyProjectVideoCompression, restoreProjectVideos } = await import('/src/core/project-video-compression.ts')
      const decode = data => new Blob([Uint8Array.from(atob(data), char => char.charCodeAt(0))], { type: 'video/webm' })
      const originalBlob = decode(original), compressedBlob = decode(compressed)
      const originalUrl = URL.createObjectURL(originalBlob), compressedUrl = URL.createObjectURL(compressedBlob), urls = [originalUrl, compressedUrl]
      const originalAsset = { id: 'original', name: '录屏.webm', kind: 'video', url: originalUrl, nativePath: '/media/original.webm', mime: 'video/webm', size: originalBlob.size, width: 320, height: 180, duration: 6 }
      const compressedAsset = { ...originalAsset, id: 'working', name: '录屏工作副本.webm', url: compressedUrl, nativePath: '/media/working.webm', size: compressedBlob.size }
      let project = createProject('剪辑工作副本预览', { width: 320, height: 180, fps: 24, background: '#101010' })
      project.assets.push(originalAsset)
      const video = project.tracks.find(track => track.kind === 'video'), text = project.tracks.find(track => track.kind === 'text')
      video.clips.push(createClip(originalAsset, project, { id: 'first', trimOut: 3, volume: 0 }), createClip(originalAsset, project, { id: 'second', start: 3, trimIn: 3, trimOut: 6, volume: 0 }))
      text.clips.push(createSubtitleClip(project, { id: 'caption', text: 'WORKING COPY', x: 0, y: 125, width: 320, height: 40, fontSize: 24, start: 0, trimOut: 6, color: '#ffffff', background: 'transparent', keyframes: { opacity: [{ time: 0, value: 0 }, { time: 1, value: 1 }] } }))
      project = validateProject(addTransition(project, 3, 'zoom-fade', 1, video.id), { trusted: true })
      const media = [], createElement = document.createElement.bind(document)
      document.createElement = function(tag, options) { const element = createElement(tag, options); if (element instanceof HTMLMediaElement) media.push(element); return element }
      const canvas = document.querySelector('canvas'), context = canvas.getContext('2d'), notices = []
      const preview = new TimelinePreview(canvas, project, message => notices.push(message))
      const resident = () => media.filter(element => element.hasAttribute('src'))
      const sources = () => resident().map(element => element.getAttribute('src'))
      const pixel = () => [...context.getImageData(30, 30, 1, 1).data]
      const whites = () => { const bytes = context.getImageData(0, 125, 320, 40).data; let count = 0; for (let i = 0; i < bytes.length; i += 4) if (bytes[i] > 180 && bytes[i + 1] > 180 && bytes[i + 2] > 180) count++; return count }
      async function frame(time) { await preview.seekReady(time); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); preview.render(time); return { pixel: pixel(), whites: whites(), sources: sources() } }
      try {
        const before = await frame(1.2), originalDecoders = [...resident()]
        const applied = applyProjectVideoCompression(project, [originalAsset], [{ sourceIds: [originalAsset.id], sourceSize: originalBlob.size, outputSize: compressedBlob.size, asset: compressedAsset, state: 'completed' }], 'quality', 'high')
        preview.setProject(applied.project)
        const oldReleased = originalDecoders.every(element => element.paused && !element.hasAttribute('src'))
        // A stale source fallback now fails. The original still remains an asset
        // for undo, but all interactive decoding must use the working copy.
        URL.revokeObjectURL(originalUrl)
        const after = await frame(1.2), earlyAnimation = await frame(.05), fullAnimation = await frame(1.2)
        const transition = await frame(2.75), later = await frame(4.5)
        const noEffects = cloneProject(applied.project)
        for (const track of noEffects.tracks) if (track.kind === 'text' || track.kind === 'transition') track.clips = []
        preview.setProject(noEffects)
        const noText = await frame(1.2), noTransition = await frame(2.75)
        preview.setProject(applied.project)
        await preview.enableAudio(false)
        await preview.playReady(3.7)
        const playback = [], started = performance.now()
        await new Promise(resolve => { function tick() { const elapsed = (performance.now() - started) / 1000; preview.render(3.7 + elapsed, true); playback.push({ pixel: pixel(), sources: sources() }); if (elapsed >= .3) resolve(); else requestAnimationFrame(tick) } tick() })
        preview.pause()
        const compressedDecoders = [...resident()]
        const restoredUrl = URL.createObjectURL(originalBlob); urls.push(restoredUrl)
        const restorable = cloneProject(applied.project); restorable.assets.find(asset => asset.id === originalAsset.id).url = restoredUrl
        const restored = restoreProjectVideos(restorable).project
        preview.setProject(restored)
        const workingReleased = compressedDecoders.every(element => element.paused && !element.hasAttribute('src'))
        const restoredFrame = await frame(1.2)
        preview.dispose()
        return { originalSize: originalBlob.size, compressedSize: compressedBlob.size, before, after, earlyAnimation, fullAnimation, transition, later, noText, noTransition, playback, oldReleased, workingReleased, restoredFrame, compressedUrl, restoredUrl, remaining: resident().length, notices }
      } finally { preview.dispose(); urls.forEach(url => URL.revokeObjectURL(url)); document.createElement = createElement }
    }, { original: originalBytes.toString('base64'), compressed: compressedBytes.toString('base64') })
    const red = pixel => pixel[0] > 180 && pixel[1] < 60 && pixel[2] < 60
    const blue = pixel => pixel[2] > 180 && pixel[0] < 60 && pixel[1] < 60
    assert(red(result.before.pixel) && red(result.after.pixel), '工作副本切换后必须继续显示同一源时间的真实画面')
    assert(result.oldReleased, '切换后旧视频解码器应暂停并移除媒体源')
    for (const frame of [result.after, result.earlyAnimation, result.fullAnimation, result.transition, result.later, ...result.playback]) assert(frame.sources.length && frame.sources.every(url => url === result.compressedUrl), '剪辑定位和播放不得退回原件 URL')
    assert(blue(result.later.pixel) && result.playback.every(frame => blue(frame.pixel)), '新工作副本必须支持向后定位并真实连续播放')
    assert(result.fullAnimation.whites > 300 && result.earlyAnimation.whites < result.fullAnimation.whites / 4, '字幕透明度动画应继续与压缩视频实时合成')
    assert(result.noText.whites < 10, '关闭字幕后对应像素应消失，验证不是已烘焙的视频文字')
    assert(result.transition.pixel[0] < result.noTransition.pixel[0] * .8, '转场缩放淡化应合成在工作副本视频上')
    assert(result.workingReleased && red(result.restoredFrame.pixel), '恢复原件应释放工作副本并重新解码原件')
    assert(result.restoredFrame.sources.every(url => url === result.restoredUrl))
    assert.equal(result.remaining, 0)
    assert.deepEqual(result.notices, []); assert.deepEqual(errors, [])
    console.log(`PASS 真实压缩文件剪辑预览：${result.originalSize} → ${result.compressedSize} 字节；工作副本解码、远近定位、播放、字幕动画、转场合成、原件恢复与旧解码器释放全部通过`)
  } finally { await browser?.close(); await server.close(); fs.rmSync(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
