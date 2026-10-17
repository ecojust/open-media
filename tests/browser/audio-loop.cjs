const assert = require('node:assert/strict')
const { chromium } = require('@playwright/test')
const { existsSync } = require('node:fs')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: null } })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/audio-loop-check', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><canvas width="64" height="64"></canvas>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/audio-loop-check`)
    await page.evaluate(async () => {
      const { createClip, createProject } = await import('/src/core/project.ts')
      const { addAsset, addClip } = await import('/src/core/timeline.ts')
      const { ClipAudioPlayer } = await import('/src/core/clip-audio-player.ts')
      const { TimelinePreview } = await import('/src/core/preview.ts')
      const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
      const sampleRate = 48000, bytes = new ArrayBuffer(44 + sampleRate * 2), view = new DataView(bytes)
      const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
      text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
      text(36, 'data'); view.setUint32(40, sampleRate * 2, true)
      for (let index = 0; index < sampleRate; index++) view.setInt16(44 + index * 2, Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 8000), true)
      const blob = new Blob([bytes], { type: 'audio/wav' })
      const asset = { id: 'loop-source', name: '循环测试.wav', kind: 'audio', url: URL.createObjectURL(blob), duration: 1, width: 0, height: 0, size: blob.size, mime: blob.type }
      const project = addAsset(createProject('循环测试', { width: 64, height: 64, fps: 15 }), asset)
      const rms = (values, from = 0, to = values.length) => Math.sqrt(values.slice(from, to).reduce((sum, value) => sum + value * value, 0) / Math.max(1, to - from))
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
      const measure = analyser => { const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples); return rms(samples) }
      window.loopChecks = { asset, project, createClip, addClip, ClipAudioPlayer, TimelinePreview, exportTimelineWebM, rms, delay, measure }
    })

    for (const speed of [1, 1.5]) {
      const result = await page.evaluate(async speed => {
        const { asset, project, createClip, ClipAudioPlayer, delay, measure } = window.loopChecks
        const clip = createClip(asset, project, { trimIn: 2.25, trimOut: 2.25 + speed * 2.4, speed, volume: 0.5, fadeIn: 0.1, fadeOut: 0.2 })
        const notices = []; let ended = 0
        const player = new ClipAudioPlayer(asset, clip, { ended: () => ended++, error: text => notices.push(text) })
        await player.play(0)
        const analyser = player.context.createAnalyser(); analyser.fftSize = 2048; player.gain.connect(analyser)
        await delay(1250)
        const middle = measure(analyser), elapsed = player.elapsed
        const buffered = Boolean(player.buffer)
        player.pause()
        const paused = player.elapsed
        await delay(100)
        const retained = player.elapsed
        await player.play(paused)
        await delay(300)
        const resumed = measure(analyser), resumedElapsed = player.elapsed
        await player.play(2.1)
        await delay(480)
        const final = { ended, elapsed: player.elapsed, rms: measure(analyser) }
        player.dispose()
        return { middle, elapsed, paused, retained, buffered, resumed, resumedElapsed, final, notices }
      }, speed)
      assert(result.middle > 0.05, `循环后仍需真实声音：${JSON.stringify(result)}`)
      assert(result.elapsed > 1 && result.elapsed < 1.6)
      assert.equal(result.paused, result.retained, '暂停不能推进循环时间')
      assert(result.resumed > 0.05 && result.resumedElapsed > result.paused)
      assert.equal(result.buffered, speed === 1)
      assert.equal(result.final.ended, 1)
      assert(Math.abs(result.final.elapsed - 2.4) < 1e-8)
      assert(result.final.rms < 0.002)
      assert.deepEqual(result.notices, [])
      console.log(`PASS ${speed} 倍速循环独立试听、循环后起点、暂停恢复、跳转和淡出终点：${JSON.stringify(result)}`)
    }

    const previewResult = await page.evaluate(async () => {
      const { asset, project, createClip, addClip, TimelinePreview, delay, measure } = window.loopChecks
      const clip = createClip(asset, project, { trimIn: 2.25, trimOut: 6.75, speed: 1.5, volume: 0.5 })
      const timeline = addClip(project, project.tracks.find(track => track.kind === 'audio').id, clip)
      const notices = [], preview = new TimelinePreview(document.querySelector('canvas'), timeline, text => notices.push(text))
      await preview.prepare(); await preview.enableAudio(); await preview.playReady(0)
      const entry = preview.entries.get(clip.id), analyser = preview.audioContext.createAnalyser()
      entry.gain.connect(analyser)
      const started = performance.now()
      let frame
      const tick = () => { preview.render((performance.now() - started) / 1000, true); frame = requestAnimationFrame(tick) }
      tick(); await delay(1500)
      const result = { rms: measure(analyser), loop: entry.media.loop, rate: entry.media.playbackRate, currentTime: entry.media.currentTime, notices }
      cancelAnimationFrame(frame); preview.pause(); preview.dispose()
      return result
    })
    assert(previewResult.rms > 0.05 && previewResult.loop && previewResult.rate === 1.5)
    assert.deepEqual(previewResult.notices, [])
    console.log(`PASS 时间线真实解码循环音频：${JSON.stringify(previewResult)}`)

    const exported = await page.evaluate(async () => {
      const { asset, project, createClip, addClip, exportTimelineWebM, rms } = window.loopChecks
      const clip = createClip(asset, project, { trimIn: 2.25, trimOut: 6.75, speed: 1.5, volume: 0.5, fadeIn: 0.1, fadeOut: 0.2 })
      const timeline = addClip(project, project.tracks.find(track => track.kind === 'audio').id, clip)
      const blob = await exportTimelineWebM(timeline)
      const context = new AudioContext()
      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      const samples = decoded.getChannelData(0), rate = decoded.sampleRate
      const result = { bytes: blob.size, duration: decoded.duration, early: rms(samples, Math.round(rate * 0.3), Math.round(rate * 0.6)), repeated: rms(samples, Math.round(rate * 2.2), Math.round(rate * 2.5)) }
      await context.close()
      return result
    })
    assert(exported.bytes > 1000 && exported.duration >= 2.9)
    assert(exported.early > 0.04 && exported.repeated > 0.04, `浏览器导出延展区段须含真实音频：${JSON.stringify(exported)}`)
    assert.deepEqual(errors, [])
    console.log(`PASS 实际 WebM 导出解码包含原音频结束后的循环声音：${JSON.stringify(exported)}`)
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
