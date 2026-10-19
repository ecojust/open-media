const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { chromium } = require('@playwright/test')

const allEffects = ['fragment-burst', 'fragment-vortex', 'fragment-collapse', 'pixel-dissolve', 'pixel-wave', 'slice-stagger', 'slice-vertical', 'checker-flip', 'tile-orbit', 'glitch-slices', 'zipper-slices', 'stepped-shutter']
const selectedEffects = process.argv.find(argument => argument.startsWith('--effects='))?.slice('--effects='.length)
const effects = selectedEffects ? selectedEffects.split(',') : allEffects
assert(effects.length && effects.every(effect => allEffects.includes(effect)) && new Set(effects).size === effects.length, '使用 --effects=id,id 指定有效且不重复的转场')
const root = path.resolve(__dirname, '../..')
const directory = process.env.OPEN_MEDIA_FRAGMENT_REPORT || path.join(process.env.BROWSER_ARTIFACTS || os.tmpdir(), 'open-media-fragment-transitions')
const ffmpeg = process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg'

function compareNative() {
  const output = [], failures = []
  const rgb = file => execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-frames:v', '1', '-'], { maxBuffer: 10 * 1024 * 1024 })
  for (const [width, height] of [[320, 180], [180, 320]]) for (const effect of effects) for (const time of [1.5, 2.5]) {
    const suffix = `${width}x${height}-${effect}-${time}.png`
    const native = path.join(directory, `native-${suffix}`), preview = path.join(directory, `seek-${suffix}`)
    assert(fs.existsSync(native) && fs.existsSync(preview), `缺少同帧原生/预览图：${suffix}`)
    const a = rgb(native), b = rgb(preview), am = new Uint8Array(width * height), bm = new Uint8Array(width * height)
    let error = 0, disagreement = 0, geometricMismatch = 0
    for (let i = 0; i < am.length; i++) {
      am[i] = Math.abs(a[i * 3] - 9) + Math.abs(a[i * 3 + 1] - 11) + Math.abs(a[i * 3 + 2] - 18) > 14 ? 1 : 0
      bm[i] = Math.abs(b[i * 3] - 9) + Math.abs(b[i * 3 + 1] - 11) + Math.abs(b[i * 3 + 2] - 18) > 14 ? 1 : 0
      if (am[i] !== bm[i]) disagreement++
      for (let channel = 0; channel < 3; channel++) error += Math.abs(a[i * 3 + channel] - b[i * 3 + channel])
    }
    const neighbor = (mask, x, y) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height && mask[(y + dy) * width + x + dx]) return true
      return false
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x
      if ((am[i] && !neighbor(bm, x, y)) || (bm[i] && !neighbor(am, x, y))) geometricMismatch++
    }
    const result = { effect, width, height, time, meanAbsoluteRgbError: error / a.length, maskDisagreement: disagreement / am.length, disagreementBeyondOnePixel: geometricMismatch / am.length, nativeImageMtime: fs.statSync(native).mtime.toISOString(), previewImageMtime: fs.statSync(preview).mtime.toISOString() }
    if (!(result.meanAbsoluteRgbError < 8)) failures.push(`原生与预览颜色差异过大：${JSON.stringify(result)}`)
    if (!(result.disagreementBeyondOnePixel < .003)) failures.push(`原生与预览碎片几何位置不一致：${JSON.stringify(result)}`)
    output.push(result)
  }
  fs.writeFileSync(path.join(directory, 'native-comparison.json'), JSON.stringify(output, null, 2))
  fs.writeFileSync(path.join(directory, 'native-comparison-summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), effects, frames: output.length, passed: failures.length === 0, failures }, null, 2))
  assert.equal(failures.length, 0, failures.join('\n'))
  console.log(`PASS ${output.length} 张原生/预览同帧比对；最大RGB平均误差 ${Math.max(...output.map(row => row.meanAbsoluteRgbError)).toFixed(3)}/255；超出一像素边缘的最大几何差异 ${(Math.max(...output.map(row => row.disagreementBeyondOnePixel)) * 100).toFixed(3)}%`)
}

async function main() {
  if (process.argv.includes('--compare-native')) { compareNative(); return }
  fs.mkdirSync(directory, { recursive: true })
  const media = path.join(directory, 'source.webm')
  // Fixed bright grid makes gaps distinguishable from a plain fade; the moving
  // white square separately proves the source video remains live inside tiles.
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'color=c=white:s=40x40:r=30:d=4', '-filter_complex', '[0:v]drawgrid=w=80:h=72:t=3:c=white@0.7[grid];[grid][1:v]overlay=x=20+90*t:y=250:shortest=1', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p', media])
  const { createServer } = await import('vite')
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-fragment-vite-'))
  const server = await createServer({ root, cacheDir, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.setDefaultTimeout(45000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__fragment__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>body{background:#10131f;color:white;font:18px sans-serif}canvas{display:block;margin:30px auto;max-width:90vw}</style><h1>碎片与切片转场实时验证</h1><canvas id="preview"></canvas>' }))
    await page.route('**/__fragment-source.webm', route => route.fulfill({ contentType: 'video/webm', body: fs.readFileSync(media) }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__fragment__`)
    await page.evaluate(async ({ effects }) => {
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { createProject, createClip } = await import('/src/core/project.ts')
      const { importMediaFile } = await import('/src/core/media-import.ts')
      const { addTransition } = await import('/src/core/transitions.ts')
      const { exportProjectFile, importProjectFile } = await import('/src/core/project-file.ts')
      const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
      const blob = await (await fetch('/__fragment-source.webm')).blob()
      const asset = await importMediaFile(new File([blob], '纹理运动.webm', { type: 'video/webm' }))
      const bg = [9, 11, 18]
      const check = (condition, message) => { if (!condition) throw new Error(message) }
      const stats = canvas => {
        const ctx = canvas.getContext('2d', { willReadFrequently: true }), { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
        let hash = 2166136261, occupied = 0, brightness = 0, edge = 0
        const rowCoverage = Array(canvas.height).fill(0), columnCoverage = Array(canvas.width).fill(0)
        for (let p = 0; p < data.length; p += 4) {
          const distance = Math.abs(data[p] - bg[0]) + Math.abs(data[p + 1] - bg[1]) + Math.abs(data[p + 2] - bg[2])
          const x = p / 4 % canvas.width, y = Math.floor(p / 4 / canvas.width)
          if (distance > 14) { occupied++; rowCoverage[y]++; columnCoverage[x]++ }
          hash = Math.imul(hash ^ (data[p] + data[p + 1] * 3 + data[p + 2] * 7), 16777619)
          brightness += (data[p] + data[p + 1] + data[p + 2]) / 3
          if (x && Math.abs(data[p] - data[p - 4]) + Math.abs(data[p + 1] - data[p - 3]) + Math.abs(data[p + 2] - data[p - 2]) > 80) edge++
        }
        const count = canvas.width * canvas.height
        return { hash: hash >>> 0, occupied: occupied / count, brightness: brightness / count, edge: edge / count, rowCoverage, columnCoverage }
      }
      const make = (effect, width = 320, height = 180, parameters = {}) => {
        let project = createProject(`转场验证 ${effect}`, { width, height, fps: 30, background: '#090b12' })
        project.assets.push(asset)
        const track = project.tracks.find(track => track.kind === 'video')
        track.clips.push(createClip(asset, project, { id: 'before', start: 0, trimIn: 0, trimOut: 2, fit: 'cover', volume: 0 }), createClip(asset, project, { id: 'after', start: 2, trimIn: 2, trimOut: 4, fit: 'cover', volume: 0 }))
        return addTransition(project, 2, effect, 2, track.id, { easing: 'linear', ...parameters })
      }
      const roundtrip = async project => {
        const archive = await exportProjectFile(project, { blobs: new Map([[asset.id, blob]]) })
        const reopened = (await importProjectFile(archive)).project
        check(JSON.stringify(project.tracks.map(track => track.clips.map(clip => clip.transition))) === JSON.stringify(reopened.tracks.map(track => track.clips.map(clip => clip.transition))), '保存重开不得丢失转场绑定和参数')
        return reopened
      }
      const live = async (effect, width, height, parameters = {}, save = false, from = 0, until = 3.4) => {
        let project = make(effect, width, height, parameters)
        if (save) project = await roundtrip(project)
        const canvas = document.getElementById('preview'); canvas.width = width; canvas.height = height
        const messages = [], preview = new TimelinePreview(canvas, project, message => messages.push(message))
        const frames = [], samples = [], renderTimes = [], gaps = []
        const sourceSample = document.createElement('canvas'); sourceSample.width = 32; sourceSample.height = 18
        const sourceContext = sourceSample.getContext('2d', { willReadFrequently: true })
        try {
          // Use the interactive startup and RAF loop, never prepare() here.
          await preview.playReady(from)
          const targets = [.4, 1.5, 1.8, 2.2, 2.5, 3.2].filter(t => t >= from && t <= until)
          const started = performance.now(); let last = started, sampleAt = -1
          await new Promise((resolve, reject) => {
            const tick = () => {
              try {
                const now = performance.now(), time = from + (now - started) / 1000
                gaps.push(now - last); last = now
                const before = performance.now(); preview.render(Math.min(time, until), true); renderTimes.push(performance.now() - before)
                if (time - sampleAt >= .08) {
                  samples.push({ time, ...stats(canvas), media: [...preview.entries].map(([clipId, entry]) => {
                    let hash = 2166136261
                    if (entry.media.readyState >= 2) {
                      sourceContext.drawImage(entry.media, 0, 0, 32, 18)
                      for (const value of sourceContext.getImageData(0, 0, 32, 18).data) hash = Math.imul(hash ^ value, 16777619)
                    }
                    return { clipId, time: entry.media.currentTime, ready: entry.media.readyState, paused: entry.media.paused, hash: hash >>> 0 }
                  }) }); sampleAt = time
                }
                while (targets.length && time >= targets[0]) frames.push({ target: targets.shift(), time, ...stats(canvas), png: canvas.toDataURL('image/png') })
                if (time >= until) { preview.pause(); resolve() } else requestAnimationFrame(tick)
              } catch (error) { reject(error) }
            }
            requestAnimationFrame(tick)
          })
          check(!messages.length, `素材加载错误：${messages.join('; ')}`)
          for (const frame of frames.filter(frame => frame.target === .4 || frame.target === 3.2)) check(frame.occupied > .96, `${effect} ${width}x${height} 端点未恢复原视频 ${frame.occupied}`)
          const active = samples.filter(frame => frame.time >= 1.25 && frame.time <= 1.85)
          check(new Set(active.map(frame => frame.hash)).size > 4, `${effect} 转场中的纹理必须连续变化`)
          check(active.every(frame => frame.media.some(media => media.ready >= 2 && !media.paused)), `${effect} 转场不能冻结视频解码`)
          const sourceFrames = active.flatMap(frame => frame.media.filter(media => media.clipId === 'before' && media.ready >= 2))
          check(new Set(sourceFrames.map(frame => frame.hash)).size > 4, `${effect} 切片中的原视频纹理必须随时间变化`)
          check(Math.max(...sourceFrames.map(frame => frame.time)) - Math.min(...sourceFrames.map(frame => frame.time)) > .25, `${effect} 原视频时钟未推进`)
          const middle = frames.find(frame => frame.target === 1.5)
          if (parameters.scope !== 'incoming') check(middle.occupied > .005 && middle.occupied < (effect === 'glitch-slices' ? .995 : .90), `${effect} 应产生明显几何空隙，不是整帧淡出：${middle.occupied}`)
          await preview.seekReady(2)
          const cut = stats(canvas)
          if (!parameters.scope || parameters.scope === 'both') check(cut.occupied < .001, `${effect} 切点原片泄漏：${cut.occupied}`)
          const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]
          return { effect, width, height, saveReopened: save, parameters, frames, samples: samples.map(({ rowCoverage, columnCoverage, ...sample }) => sample), cut, performance: { renderP50: percentile(renderTimes, .5), renderP95: percentile(renderTimes, .95), rafP95: percentile(gaps, .95), rafMax: Math.max(...gaps) } }
        } finally { preview.dispose() }
      }
      const still = async (effect, time, parameters = {}, width = 320, height = 180) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const preview = new TimelinePreview(canvas, make(effect, width, height, parameters))
        try { await preview.seekReady(time); return { ...stats(canvas), png: canvas.toDataURL('image/png') } } finally { preview.dispose() }
      }
      const controls = async () => {
        const result = []
        for (const effect of effects) {
          const linear = await still(effect, 1.3, { easing: 'linear' })
          const slow = await still(effect, 1.3, { easing: 'ease-in' })
          check(linear.hash !== slow.hash, `${effect} 缓动参数没有影响画面`)
          const outgoingSuppressed = await still(effect, 1.5, { scope: 'incoming' })
          const incomingSuppressed = await still(effect, 2.5, { scope: 'outgoing' })
          check(outgoingSuppressed.occupied > .96 && incomingSuppressed.occupied > .96, `${effect} 单侧作用范围错误`)
          result.push({ effect, linearHash: linear.hash, easedHash: slow.hash, inactiveOutgoing: outgoingSuppressed.occupied, inactiveIncoming: incomingSuppressed.occupied })
        }
        // An independent image-space property: staggered strips leave holes on
        // alternate sides. This distinguishes opposing slices from a whole-image slide.
        const horizontal = await still('slice-stagger', 1.5)
        const image = new Image(); image.src = horizontal.png; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
        const content = (x, y) => { const p = ctx.getImageData(x, y, 1, 1).data; return Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 14 }
        let pairs = 0
        for (let row = 0; row < 12; row++) {
          const left = content(30, row * 15 + 7), right = content(290, row * 15 + 7)
          if (left !== right && (row % 2 === 0 ? left : right)) pairs++
        }
        check(pairs >= 10, `横切应交替从左右离场，实际 ${pairs}/12 行`)
        const independentGeometry = {}
        if (effects.includes('glitch-slices')) {
          const glitch = await still('glitch-slices', 1.5)
          image.src = glitch.png; await image.decode(); ctx.clearRect(0, 0, 320, 180); ctx.drawImage(image, 0, 0)
          const gaps = Array.from({ length: 16 }, (_, row) => {
            const y = Math.floor((row + .5) * 180 / 16)
            let left = 0, right = 319
            while (left < 320 && !content(left, y)) left++
            while (right >= 0 && !content(right, y)) right--
            return { left, right: 319 - right }
          })
          check(gaps.filter(gap => gap.left > 3).length >= 3 && gaps.filter(gap => gap.right > 3).length >= 3, '数字故障应在不同行呈现正反两向抖动，不能只是整体平移')
          independentGeometry.glitchRowGaps = gaps
        }
        if (effects.includes('zipper-slices')) {
          const zipper = await still('zipper-slices', 1.5)
          image.src = zipper.png; await image.decode(); ctx.clearRect(0, 0, 320, 180); ctx.drawImage(image, 0, 0)
          const centerGap = row => {
            const y = row * 15 + 7
            let left = 159, right = 160
            while (left >= 0 && !content(left, y)) left--
            while (right < 320 && !content(right, y)) right++
            return right - left - 1
          }
          const first = centerGap(0), last = centerGap(11)
          check(first > 50 && last > first + 40, `拉链中心开口应从上到下逐级增大：${first}/${last}`)
          independentGeometry.zipperTopBottomGap = [first, last]
        }
        if (effects.includes('stepped-shutter')) {
          const shutter = await still('stepped-shutter', 1.5)
          image.src = shutter.png; await image.decode(); ctx.clearRect(0, 0, 320, 180); ctx.drawImage(image, 0, 0)
          let anchoredColumns = 0
          for (let col = 0; col < 7; col++) if (!content(Math.floor(col * 320 / 12 + 2), 20) && content(Math.floor((col + 1) * 320 / 12 - 3), 20)) anchoredColumns++
          check(anchoredColumns >= 6, `阶梯折屏应向各面板右边缘收缩：${anchoredColumns}/7`)
          independentGeometry.shutterRightAnchoredColumns = anchoredColumns
        }
        return { effects: result, alternatingStripRows: pairs, independentGeometry }
      }
      const exportDemo = async () => {
        let project = createProject('碎片与切片转场演示', { width: 640, height: 360, fps: 30, background: '#090b12' })
        project.assets.push(asset)
        const track = project.tracks.find(track => track.kind === 'video')
        for (let i = 0; i < effects.length; i++) {
          track.clips.push(createClip(asset, project, { id: `before-${i}`, start: i * 4, trimIn: 0, trimOut: 2, fit: 'cover', volume: 0 }), createClip(asset, project, { id: `after-${i}`, start: i * 4 + 2, trimIn: 2, trimOut: 4, fit: 'cover', volume: 0 }))
        }
        for (let i = 0; i < effects.length; i++) project = addTransition(project, i * 4 + 2, effects[i], 2, track.id, { easing: 'ease-in-out' })
        const reopened = await roundtrip(project)
        const encoded = await exportTimelineWebM(reopened, { width: 640, height: 360, fps: 30, videoBitsPerSecond: 1_400_000 })
        return Array.from(new Uint8Array(await encoded.arrayBuffer()))
      }
      const nativeFixture = async (effect, width, height) => {
        const project = make(effect, width, height)
        return { project, frames: await Promise.all([1.5, 2.5].map(async time => ({ time, ...await still(effect, time, {}, width, height) }))) }
      }
      window.fragmentFixture = { live, controls, exportDemo, nativeFixture }
    }, { effects })
    const report = { browser: await browser.version(), runs: [], errors }
    for (const [width, height] of [[320, 180], [180, 320]]) for (const effect of effects) {
      const fixture = await page.evaluate(({ effect, width, height }) => window.fragmentFixture.nativeFixture(effect, width, height), { effect, width, height })
      for (const asset of fixture.project.assets) { asset.nativePath = media; asset.url = ''; asset.size = fs.statSync(media).size }
      fs.writeFileSync(path.join(directory, `native-${width}x${height}-${effect}.json`), JSON.stringify(fixture.project, null, 2))
      for (const frame of fixture.frames) fs.writeFileSync(path.join(directory, `seek-${width}x${height}-${effect}-${frame.time}.png`), Buffer.from(frame.png.split(',')[1], 'base64'))
    }
    console.log('已生成原生交叉核验工程和精确同时间预览PNG')
    for (const [width, height] of [[320, 180], [180, 320]]) {
      for (const [index, effect] of effects.entries()) {
        const result = await page.evaluate(async ({ effect, width, height }) => window.fragmentFixture.live(effect, width, height, {}, true), { effect, width, height })
        for (const frame of result.frames) {
          const file = `${width}x${height}-${index}-${frame.target}.png`
          fs.writeFileSync(path.join(directory, file), Buffer.from(frame.png.split(',')[1], 'base64')); delete frame.png; frame.file = file
        }
        delete result.cut.rowCoverage; delete result.cut.columnCoverage
        report.runs.push(result)
        console.log(`PASS ${effect} ${width}x${height} 连续播放、几何空隙、切点与端点、工程保存重开`)
        fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
      }
    }
    report.controls = await page.evaluate(() => window.fragmentFixture.controls())
    console.log(`PASS ${effects.length}款缓动与单侧作用范围、独立像素几何检查`)
    report.performance720p = await page.evaluate(async () => {
      const result = await window.fragmentFixture.live('fragment-vortex', 1280, 720)
      return result.performance
    })
    console.log(`720p 连续播放观察 ${JSON.stringify(report.performance720p)}`)
    if (!process.argv.includes('--skip-export')) {
      console.log(`开始真实编码 ${effects.length * 4} 秒转场演示`)
      const bytes = await page.evaluate(() => window.fragmentFixture.exportDemo())
      const webm = path.join(directory, 'fragment-transitions.webm')
      fs.writeFileSync(webm, Buffer.from(bytes))
      const mp4 = path.join(directory, 'fragment-transitions.mp4')
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', webm, '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4])
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4], { encoding: 'utf8' }))
      assert(Number(probe.format.duration) >= effects.length * 4 - .5, '实际编码视频应包含全部选定转场')
      assert.equal(probe.streams[0].width, 640)
      assert.equal(probe.streams[0].height, 360)
      execFileSync(ffmpeg, ['-v', 'error', '-i', mp4, '-f', 'null', '-'])
      const encodedEffects = effects.map((effect, index) => {
        const time = index * 4 + 1.5
        const pixels = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', mp4, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 4 * 1024 * 1024 })
        let content = 0
        for (let i = 0; i < pixels.length; i += 3) if (Math.abs(pixels[i] - 9) + Math.abs(pixels[i + 1] - 11) + Math.abs(pixels[i + 2] - 18) > 25) content++
        const coverage = content / (pixels.length / 3)
        assert(coverage > .005 && coverage < (effect === 'glitch-slices' ? .995 : .9), `编码视频中的 ${effect} 必须保留实际碎片几何：${coverage}`)
        return { effect, time, coverage }
      })
      report.export = { bytes: fs.statSync(mp4).size, duration: Number(probe.format.duration), codec: probe.streams[0].codec_name, decoded: true, file: mp4, encodedEffects }
      console.log(`PASS 真实编码并全片解码 ${report.export.duration}s ${report.export.bytes} bytes`)
    }
    // Contact sheet contains each effect halfway out and halfway in, in ID order.
    const inputs = effects.flatMap((_, index) => [1.5, 2.5].map(time => path.join(directory, `320x180-${index}-${time}.png`)))
    execFileSync(ffmpeg, ['-v', 'error', '-y', ...inputs.flatMap(input => ['-i', input]), '-filter_complex', `${inputs.map((_, index) => `[${index}:v]`).join('')}xstack=inputs=${inputs.length}:layout=${inputs.map((_, index) => `${index % 4 * 320}_${Math.floor(index / 4) * 180}`).join('|')}`, '-frames:v', '1', path.join(directory, 'contact-sheet.png')])
    assert.equal(errors.length, 0, `页面异常：${errors.join('; ')}`)
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`PASS 全部碎片转场回归；结果 ${directory}`)
  } finally { await browser?.close(); await server.close(); fs.rmSync(cacheDir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
