const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { chromium } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] })
    const page = await browser.newPage()
    await page.route('**/motion-native-fixture', route => route.fulfill({ contentType: 'text/html', body: '<main>效果片段生命周期</main>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/motion-native-fixture`)
    const result = await page.evaluate(async () => {
      const { createProject, createClip, createTextClip } = await import('/src/core/project.ts')
      const { renderMotionClip } = await import('/src/native-motion-clip.ts')
      const project = createProject('临时效果片段', { width: 1440, height: 810, fps: 48 })
      const source = { id: 'video', kind: 'video', name: '原素材.mp4', url: 'asset://localhost/source.mp4', nativePath: '/safe/media/source.mp4', width: 160, height: 90, duration: 2, size: 100, mime: 'video/mp4' }
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32
      canvas.getContext('2d').fillRect(0, 0, 32, 32)
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      const art = { id: 'art', kind: 'image', name: '背景.png', url: URL.createObjectURL(png), width: 32, height: 32, duration: 5, size: png.size, mime: 'image/png' }
      project.assets = [source, art]
      project.tracks.find(track => track.kind === 'video').clips = [createClip(source, project)]
      project.tracks.find(track => track.kind === 'text').clips = [createTextClip(project, { text: '原生效果片段', trimOut: 2 })]
      const original = JSON.stringify(project)
      let mode = 'success', calls = [], release, progress = [], spec
      const wait = async name => { if (mode === name) await new Promise(resolve => { release = resolve }) }
      const ready = { ...source, id: 'result', name: '效果片段.mp4', nativePath: '/safe/media/motion-clip-scope/result.mp4', width: 1440, height: 810 }
      window.__TAURI_INTERNALS__ = { convertFileSrc: path => `asset://localhost${path}`, invoke: async (command, args) => {
        calls.push({ command, id: args?.id, scopeId: args?.scopeId })
        if (command === 'create_motion_clip_scope') { await wait('late-scope'); return 'scope' }
        if (command === 'import_motion_clip_asset') {
          await wait('late-import')
          const image = await createImageBitmap(new Blob([Uint8Array.from(args.bytes)], { type: 'image/png' }))
          const dimensions = { width: image.width, height: image.height }; image.close()
          return { ...art, ...dimensions, id: `scoped-${calls.length}`, nativePath: `/safe/media/motion-clip-scope/inputs/${calls.length}.png`, url: '' }
        }
        if (command === 'begin_motion_clip_render') { spec = args.spec; await wait('late-begin'); return { id: 'job', state: 'running', name: 'result.mp4', progress: 0, stage: '正在编码', encodedFrames: 7, outputTime: .15 } }
        if (command === 'get_media_jobs') return [{ id: 'job', state: 'completed', progress: 1 }]
        if (command === 'motion_clip_result') {
          if (mode === 'bad-result') return { ...ready, kind: 'image' }
          if (mode === 'failed-result') throw new Error('输出校验失败')
          return { ...ready }
        }
        if (['accept_motion_clip', 'discard_motion_clip', 'cancel_media_job'].includes(command)) return null
        throw new Error(`Unexpected IPC: ${command}`)
      } }
      const summary = {}
      try {
        const generated = await renderMotionClip(project, undefined, update => progress.push(update))
        summary.output = generated.asset; summary.spec = spec; summary.progress = progress
        await generated.accept(); await generated.accept(); await generated.discard()
        summary.acceptCalls = calls.filter(call => call.command === 'accept_motion_clip').length
        summary.acceptDiscards = calls.filter(call => call.command === 'discard_motion_clip').length
        summary.imports = calls.filter(call => call.command === 'import_motion_clip_asset')
        calls = []
        const unused = await renderMotionClip(project)
        await unused.discard(); await unused.discard()
        summary.discardCalls = calls.filter(call => call.command === 'discard_motion_clip').length
        summary.rejectedAccept = await unused.accept().catch(error => error.message)
        summary.failures = []
        for (mode of ['failed-result', 'bad-result']) {
          calls = []
          const error = await renderMotionClip(project).catch(error => error.message)
          summary.failures.push({ mode, error, calls: [...calls] })
        }
        summary.cancellations = []
        for (mode of ['late-scope', 'late-import', 'late-begin']) {
          calls = []; release = undefined
          const controller = new AbortController()
          const pending = renderMotionClip(project, controller.signal).catch(error => error.name)
          const deadline = Date.now() + 5000
          while (!release) { if (Date.now() > deadline) throw new Error(`test wait timeout: ${mode}`); await new Promise(resolve => setTimeout(resolve, 0)) }
          controller.abort(); release()
          summary.cancellations.push({ mode, error: await pending, calls: [...calls] })
        }
        mode = 'success'; calls = []
        summary.staleError = await renderMotionClip(project, undefined, update => { if (update.stage.startsWith('效果片段 · ')) throw new Error('当前工程已变化') }).catch(error => error.message)
        summary.staleCleanup = [...calls]
        summary.unchanged = JSON.stringify(project) === original
        return summary
      } finally { delete window.__TAURI_INTERNALS__; URL.revokeObjectURL(art.url) }
    })
    assert.deepEqual(result.spec.config, { format: 'mp4', width: 1440, height: 810, fps: 48, quality: 'high' })
    assert.equal(result.output.kind, 'video'); assert.match(result.output.url, /^asset:/)
    assert.equal(result.acceptCalls, 1); assert.equal(result.acceptDiscards, 0)
    assert.equal(result.imports.length, 2); assert(result.imports.every(call => call.scopeId === 'scope'))
    assert(result.spec.project.assets.find(asset => asset.id === 'art').nativePath.includes('/inputs/'))
    assert.equal(result.spec.project.assets.find(asset => asset.id === 'video').nativePath, '/safe/media/source.mp4')
    assert.equal(Object.keys(result.spec.textAssets).length, 1)
    assert(result.progress.some(update => update.encodedFrames === 7 && update.outputTime === .15))
    assert.equal(result.discardCalls, 1); assert.match(result.rejectedAccept, /已取消/); assert(result.unchanged)
    for (const failure of result.failures) {
      assert.match(failure.error, /校验效果片段失败/)
      assert(failure.calls.some(call => call.command === 'cancel_media_job'))
      assert.equal(failure.calls.filter(call => call.command === 'discard_motion_clip').length, 1)
      assert(!failure.calls.some(call => call.command === 'accept_motion_clip'))
    }
    for (const cancellation of result.cancellations) {
      assert.equal(cancellation.error, 'AbortError')
      assert.deepEqual(cancellation.calls.filter(call => call.command === 'discard_motion_clip').map(call => call.id), [cancellation.mode === 'late-begin' ? 'job' : 'scope'])
      assert(!cancellation.calls.some(call => call.command === 'accept_motion_clip'))
      if (cancellation.mode === 'late-begin') assert(cancellation.calls.some(call => call.command === 'cancel_media_job'))
    }
    assert.match(result.staleError, /当前工程已变化/)
    assert(result.staleCleanup.some(call => call.command === 'cancel_media_job'))
    assert(result.staleCleanup.some(call => call.command === 'discard_motion_clip'))
    console.log('PASS native effect clip bridge: scoped PNGs, 1440×810/48fps, progress, source immutability, accept/discard ownership, failed output, delayed scope/import/launch cancellation, stale project cleanup')
  } finally { await browser?.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
