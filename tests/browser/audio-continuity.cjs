const assert = require('node:assert/strict')
const { chromium } = require('@playwright/test')
const { existsSync } = require('node:fs')

/** Development server only: these checks exercise decoded audio without a production build. */
async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**/src-tauri/target/**'] }, hmr: false } })
  await server.listen()
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/audio-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }))
    await page.goto(`${baseURL}/audio-test`)
    await page.evaluate(async () => {
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { createProject, createClip, createTrack } = await import('/src/core/project.ts')
      const counters = new Map()
      const entry = media => {
        let stats = counters.get(media)
        if (!stats) {
          stats = { src: 0, currentTime: 0, playbackRate: 0, volume: 0, muted: 0, play: 0, pause: 0, seeking: 0, waiting: 0, ratechange: 0 }
          counters.set(media, stats)
          for (const name of ['seeking', 'waiting', 'ratechange']) media.addEventListener(name, () => stats[name]++)
        }
        return stats
      }
      for (const key of ['src', 'currentTime', 'playbackRate', 'volume', 'muted']) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, key)
        Object.defineProperty(HTMLMediaElement.prototype, key, { ...descriptor, set(value) { entry(this)[key]++; return descriptor.set.call(this, value) } })
      }
      for (const key of ['play', 'pause']) {
        const original = HTMLMediaElement.prototype[key]
        HTMLMediaElement.prototype[key] = function (...args) { entry(this)[key]++; return original.apply(this, args) }
      }
      function wav(frequency, duration = 12, amplitude = 0.2) {
        const sampleRate = 48000, frames = Math.round(duration * sampleRate)
        const bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes)
        const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
        text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
        view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
        text(36, 'data'); view.setUint32(40, frames * 2, true)
        for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * frequency * i / sampleRate) * amplitude * 32767), true)
        return new Blob([bytes], { type: 'audio/wav' })
      }
      function fixture(rows) {
        const project = createProject('音频连续性验证', { width: 32, height: 32, fps: 30 })
        const urls = []
        project.assets = rows.map((row, index) => {
          const blob = wav(row.frequency, 12, row.amplitude || 0.2), url = row.url || URL.createObjectURL(blob)
          if (!row.url) urls.push(url)
          return { id: `audio-asset-${index}`, name: `测试音轨 ${index + 1}`, kind: 'audio', url, duration: 12, width: 0, height: 0, size: blob.size, mime: blob.type }
        })
        project.tracks = rows.map((row, index) => ({ ...createTrack('audio'), muted: Boolean(row.muted), clips: [createClip(project.assets[index], project, { id: `audio-clip-${index}`, trimOut: 6, ...row.clip })] }))
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32
        const notices = [], preview = new TimelinePreview(canvas, project, message => notices.push(message))
        return { project, preview, notices, dispose() { preview.dispose(); urls.forEach(url => URL.revokeObjectURL(url)) } }
      }
      function resetCounters() { for (const stats of counters.values()) for (const key of Object.keys(stats)) stats[key] = 0 }
      function snapshot() { return [...counters].map(([media, stats]) => ({ source: media.currentSrc || media.src, time: media.currentTime, rate: media.playbackRate, paused: media.paused, ...stats })) }
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
      async function run(preview, start, seconds) {
        const began = performance.now()
        return await new Promise(resolve => {
          function frame(now) {
            const elapsed = Math.min(seconds, (now - began) / 1000)
            preview.render(start + elapsed, true)
            if (elapsed < seconds) requestAnimationFrame(frame)
            else resolve(start + elapsed)
          }
          requestAnimationFrame(frame)
        })
      }
      async function record(preview) {
        const stream = await preview.enableAudio(false), chunks = []
        const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
        recorder.addEventListener('dataavailable', event => chunks.push(event.data))
        const started = new Promise(resolve => recorder.addEventListener('start', resolve, { once: true }))
        recorder.start(100)
        await started
        const start = performance.now()
        return { time: () => (performance.now() - start) / 1000, async finish() {
          const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }))
          recorder.stop(); await stopped
          const context = new AudioContext()
          try {
            const decoded = await context.decodeAudioData(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer())
            return { samples: decoded.getChannelData(0).slice(), sampleRate: decoded.sampleRate, duration: decoded.duration }
          } finally { await context.close() }
        } }
      }
      function rms(audio, from, to) {
        const begin = Math.max(0, Math.round(from * audio.sampleRate)), end = Math.min(audio.samples.length, Math.round(to * audio.sampleRate))
        let sum = 0
        for (let i = begin; i < end; i++) sum += audio.samples[i] ** 2
        return Math.sqrt(sum / Math.max(1, end - begin))
      }
      function tone(audio, from, to, frequency) {
        const begin = Math.max(0, Math.round(from * audio.sampleRate)), end = Math.min(audio.samples.length, Math.round(to * audio.sampleRate))
        const windowSize = Math.round(audio.sampleRate * 0.05)
        let total = 0, count = 0
        for (let start = begin; start + windowSize <= end; start += windowSize) {
          let real = 0, imag = 0
          for (let i = start; i < start + windowSize; i++) {
            const angle = 2 * Math.PI * frequency * i / audio.sampleRate
            real += audio.samples[i] * Math.cos(angle); imag += audio.samples[i] * Math.sin(angle)
          }
          total += 2 * Math.hypot(real, imag) / windowSize; count++
        }
        return total / Math.max(1, count)
      }
      function continuity(audio, from, to) {
        const windows = []
        for (let time = from; time + 0.025 <= to; time += 0.025) windows.push(rms(audio, time, time + 0.025))
        return { windows: windows.length, minimum: Math.min(...windows), maximum: Math.max(...windows), silent: windows.filter(value => value < 0.01).length }
      }
      window.audioTest = { fixture, resetCounters, snapshot, counters, delay, run, record, rms, tone, continuity, wav }
    })

    const continuous = await page.evaluate(async () => {
      const { fixture, resetCounters, snapshot, run, record, tone, continuity, delay } = window.audioTest
      const item = fixture([
        { frequency: 440, clip: { trimIn: 0.4, trimOut: 9.4, speed: 1.5 } },
        { frequency: 660, clip: { start: 1.2, trimOut: 1.6 } },
        { frequency: 1230, muted: true, amplitude: 0.4 },
        { frequency: 1810, amplitude: 0.4, clip: { start: 8 } },
      ])
      try {
        await item.preview.prepare()
        const recording = await record(item.preview)
        await item.preview.playReady(0)
        const playingAt = recording.time()
        resetCounters()
        await run(item.preview, 0, 4)
        const stats = snapshot(), lastTime = stats.find(row => row.rate === 1.5)?.time
        item.preview.pause(); await delay(100)
        const audio = await recording.finish()
        const from = playingAt + 0.3, to = playingAt + 3.7
        return {
          continuity: continuity(audio, from, to), duration: audio.duration, lastTime, stats, notices: item.notices,
          single: { base: tone(audio, playingAt + 0.4, playingAt + 0.9, 440), overlap: tone(audio, playingAt + 0.4, playingAt + 0.9, 660) },
          overlap: { base: tone(audio, playingAt + 1.6, playingAt + 2.4, 440), second: tone(audio, playingAt + 1.6, playingAt + 2.4, 660) },
          leakage: { muted: tone(audio, from, to, 1230), inactive: tone(audio, from, to, 1810) },
        }
      } finally { item.dispose() }
    })
    assert.equal(continuous.continuity.silent, 0, `播放期间存在静音切片：${JSON.stringify(continuous)}`)
    assert(continuous.continuity.minimum > 0.07, `连续播放音量异常：${JSON.stringify(continuous.continuity)}`)
    assert(continuous.single.base > 0.1 && continuous.single.overlap < 0.01, `单轨阶段串入其他片段：${JSON.stringify(continuous.single)}`)
    assert(continuous.overlap.base > 0.1 && continuous.overlap.second > 0.1, `重叠片段未同时出声：${JSON.stringify(continuous.overlap)}`)
    assert(continuous.leakage.muted < 0.005 && continuous.leakage.inactive < 0.005, `静音或未开始轨道漏音：${JSON.stringify(continuous.leakage)}`)
    assert(continuous.lastTime > 6.0 && continuous.lastTime < 6.8, `变速播放进度错误：${continuous.lastTime}`)
    assert(continuous.stats.every(row => row.playbackRate <= 1 && row.volume <= 1 && row.muted <= 1), `逐帧重复写入媒体属性：${JSON.stringify(continuous.stats)}`)
    assert(continuous.stats.every(row => row.currentTime <= 3 && row.play <= 1), `连续播放反复定位或启动：${JSON.stringify(continuous.stats)}`)
    assert.deepEqual(continuous.notices, [])
    console.log(`PASS 真实音频 1.5 倍速连续播放、重叠混音、静音与未开始轨道隔离：${JSON.stringify(continuous)}`)

    const transitions = await page.evaluate(async () => {
      const { fixture, resetCounters, snapshot, run, record, rms, tone, delay } = window.audioTest
      const item = fixture([{ frequency: 440, clip: { trimOut: 2 } }, { frequency: 660, clip: { start: 3, trimOut: 3 } }])
      try {
        await item.preview.prepare()
        const recording = await record(item.preview)
        await item.preview.playReady(0)
        await run(item.preview, 0, 1)
        item.preview.pause()
        const pauseAt = recording.time()
        await delay(500)
        const beforeSeek = snapshot().find(row => row.time > 0.8 && row.time < 1.3)
        resetCounters()
        item.preview.seek(0.94, false)
        await delay(80)
        const smallSeek = snapshot().find(row => row.source === beforeSeek.source)
        await item.preview.playReady(0.94)
        const resumeAt = recording.time()
        await run(item.preview, 0.94, 0.8)
        item.preview.seek(3.2, true)
        const jumpAt = recording.time()
        await run(item.preview, 3.2, 0.8)
        item.preview.pause(); await delay(120)
        const audio = await recording.finish()
        return {
          beforeSeek: beforeSeek.time, afterSeek: smallSeek.time, smallSeekWrites: smallSeek.currentTime,
          pausedRms: rms(audio, pauseAt + 0.18, pauseAt + 0.42),
          resume: { active: tone(audio, resumeAt + 0.2, resumeAt + 0.65, 440), other: tone(audio, resumeAt + 0.2, resumeAt + 0.65, 660) },
          jump: { active: tone(audio, jumpAt + 0.2, jumpAt + 0.65, 660), old: tone(audio, jumpAt + 0.2, jumpAt + 0.65, 440) },
          notices: item.notices,
        }
      } finally { item.dispose() }
    })
    assert(Math.abs(transitions.afterSeek - 0.94) < 0.02 && transitions.smallSeekWrites === 1, `小范围主动跳转未定位：${JSON.stringify(transitions)}`)
    assert(transitions.pausedRms < 0.002, `暂停后仍输出声音：${transitions.pausedRms}`)
    assert(transitions.resume.active > 0.1 && transitions.resume.other < 0.01, `恢复播放音轨错误：${JSON.stringify(transitions.resume)}`)
    assert(transitions.jump.active > 0.1 && transitions.jump.old < 0.01, `跨片段跳转漏音：${JSON.stringify(transitions.jump)}`)
    assert.deepEqual(transitions.notices, [])
    console.log(`PASS 暂停静音、恢复播放、小范围主动定位和跨片段跳转：${JSON.stringify(transitions)}`)

    const delayedBytes = await page.evaluate(async () => [...new Uint8Array(await window.audioTest.wav(440, 4).arrayBuffer())])
    await page.route('**/delayed-audio.wav*', async route => {
      await new Promise(resolve => setTimeout(resolve, 700))
      await route.fulfill({ contentType: 'audio/wav', body: Buffer.from(delayedBytes), headers: { 'Accept-Ranges': 'bytes' } })
    })
    const delayed = await page.evaluate(async () => {
      const { fixture, resetCounters, snapshot, run, record, continuity, delay } = window.audioTest
      const item = fixture([{ frequency: 440, url: `${location.origin}/delayed-audio.wav`, clip: { trimOut: 3 } }])
      try {
        const recording = await record(item.preview)
        resetCounters()
        let settled = false
        const ready = item.preview.playReady(0.6).then(() => { settled = true })
        let framesWhilePending = 0
        const poll = () => { if (!settled) { framesWhilePending++; requestAnimationFrame(poll) } }
        requestAnimationFrame(poll)
        await ready
        const playingAt = recording.time(), startup = snapshot()
        await run(item.preview, 0.6, 1.3)
        item.preview.pause(); await delay(100)
        const audio = await recording.finish()
        return { framesWhilePending, startup: startup.filter(row => row.source.endsWith('/delayed-audio.wav')), continuity: continuity(audio, playingAt + 0.2, playingAt + 1.1), notices: item.notices }
      } finally { item.dispose() }
    })
    assert(delayed.framesWhilePending >= 5, `未覆盖真实延迟加载：${JSON.stringify(delayed)}`)
    assert.equal(delayed.startup.length, 1)
    assert(delayed.startup[0].play <= 1 && delayed.startup[0].currentTime <= 2, `加载期间反复播放/定位：${JSON.stringify(delayed.startup)}`)
    assert.equal(delayed.continuity.silent, 0)
    assert.deepEqual(delayed.notices, [])
    console.log(`PASS 延迟媒体加载期间只启动一次，并在载入后连续输出真实音频：${JSON.stringify(delayed)}`)

    const cancelled = await page.evaluate(async () => {
      const { fixture, resetCounters, snapshot, run, record, rms, tone, delay } = window.audioTest
      const item = fixture([{ frequency: 440, url: `${location.origin}/delayed-audio.wav?cancel=1`, clip: { trimOut: 3 } }])
      try {
        const recording = await record(item.preview)
        resetCounters()
        const pending = item.preview.playReady(0).then(() => '', error => error.name)
        await delay(120)
        item.preview.pause()
        const cancellation = await pending
        await delay(200)
        const readyAt = recording.time()
        const stopped = snapshot().filter(row => row.source.endsWith('?cancel=1'))
        await item.preview.playReady(0)
        const restartAt = recording.time()
        await run(item.preview, 0, 0.8)
        item.preview.pause(); await delay(100)
        const audio = await recording.finish()
        return { cancellation, readyAt, stopped, pausedRms: rms(audio, 0.2, readyAt - 0.05), restartedTone: tone(audio, restartAt + 0.2, restartAt + 0.6, 440), notices: item.notices }
      } finally { item.dispose() }
    })
    assert(cancelled.readyAt > 0.7, '取消测试未等待真实媒体加载')
    assert.equal(cancelled.cancellation, 'AbortError')
    assert.equal(cancelled.stopped.length, 1)
    assert(cancelled.stopped[0].paused && cancelled.stopped[0].play === 0, `取消后发生延迟播放：${JSON.stringify(cancelled)}`)
    assert(cancelled.pausedRms < 0.002 && cancelled.restartedTone > 0.1, `取消后恢复播放错误：${JSON.stringify(cancelled)}`)
    assert.deepEqual(cancelled.notices, [])
    assert.deepEqual(errors, [])
    console.log(`PASS 载入期间取消播放后保持静音，下一次主动播放正常：${JSON.stringify(cancelled)}`)
  } finally {
    await browser.close()
    await server.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
