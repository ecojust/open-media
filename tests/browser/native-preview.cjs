const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const readline = require('node:readline')
const { spawn, execFileSync } = require('node:child_process')
const { chromium } = require('@playwright/test')

async function main() {
  const root = path.resolve(__dirname, '../..')
  const environment = { ...process.env }
  if (!process.env.MEDIA_PREVIEW_DRIVER) execFileSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--locked', '--example', 'preview_driver'], { cwd: root, env: environment, stdio: 'pipe', timeout: 180000 })
  const driverPath = process.env.MEDIA_PREVIEW_DRIVER || path.join(root, 'src-tauri/target/debug/examples', `preview_driver${process.platform === 'win32' ? '.exe' : ''}`)
  const driver = spawn(driverPath, [], { cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let sequence = 0
  let driverError = ''
  driver.stderr.on('data', data => { driverError += data.toString() })
  driver.on('exit', code => { for (const task of pending.values()) task.reject(new Error(`preview driver exited ${code}: ${driverError}`)); pending.clear() })
  readline.createInterface({ input: driver.stdout }).on('line', line => {
    const value = JSON.parse(line)
    const task = pending.get(value.id)
    if (!task) return
    pending.delete(value.id)
    value.error ? task.reject(new Error(value.error)) : task.resolve(value.result)
  })
  function call(command, fields = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      driver.stdin.write(`${JSON.stringify({ id, command, ...fields })}\n`)
    })
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-preview-test-'))
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const encoder = process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg'
    const cases = [
      ['source.tiff', ['-f', 'lavfi', '-i', 'color=c=red:s=160x90', '-frames:v', '1'], 'image/tiff'],
      ['source.avi', ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.8', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le'], 'video/x-msvideo'],
      ['source.aiff', ['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '0.8', '-c:a', 'pcm_s16be'], 'audio/aiff'],
    ]
    const page = await browser.newPage()
    await page.route('**/__preview_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>兼容预览验证</title>' }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__preview_test__`)
    let previewCount = 0
    await page.exposeFunction('createRealPreview', async asset => {
      previewCount++
      const { path: previewPath } = await call('preview', { asset })
      return { base64: fs.readFileSync(previewPath).toString('base64'), mime: asset.kind === 'video' ? 'video/mp4' : asset.kind === 'image' ? 'image/png' : 'audio/wav' }
    })
    for (const [name, args, mime] of cases) {
      const filename = path.join(directory, name)
      execFileSync(encoder, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args, filename], { stdio: 'pipe', timeout: 30000 })
      const before = fs.readFileSync(filename)
      const asset = await call('import', { path: filename })
      const report = await page.evaluate(async ({ asset, base64, mime }) => {
        const { canPreviewMedia, ensureMediaPreview } = await import('/src/core/media-import.ts')
        const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
        const originalUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
        const input = { ...asset, url: originalUrl }
        const originalPlayable = await canPreviewMedia(input)
        const ready = await ensureMediaPreview(input, async current => {
          const generated = await window.createRealPreview(current)
          return URL.createObjectURL(new Blob([Uint8Array.from(atob(generated.base64), char => char.charCodeAt(0))], { type: generated.mime }))
        })
        const previewPlayable = await canPreviewMedia(ready)
        const originalSavedBytes = new Uint8Array(await (await fetch(ready.sourceUrl)).arrayBuffer())
        const originalPreserved = originalSavedBytes.length === bytes.length && originalSavedBytes.every((byte, index) => byte === bytes[index])
        let converted
        if (ready.kind === 'image') {
          const { convertImage, imageDefaults } = await import('/src/core/image-convert.ts')
          const output = await convertImage(ready.url, { ...imageDefaults, width: 80, format: 'webp' })
          const decoded = await createImageBitmap(output.blob)
          converted = { width: decoded.width, height: decoded.height, mime: output.blob.type }
          decoded.close()
        }
        const metadataPreserved = ['nativePath', 'duration', 'width', 'height', 'mime', 'size', 'name', 'id'].every(key => ready[key] === input[key])
        URL.revokeObjectURL(ready.url)
        URL.revokeObjectURL(originalUrl)
        return { originalPlayable, previewPlayable, originalPreserved, metadataPreserved, converted }
      }, { asset, base64: before.toString('base64'), mime })
      assert.equal(report.originalPlayable, false, `${name} exercises a genuinely incompatible original`)
      assert.equal(report.previewPlayable, true)
      assert.equal(report.originalPreserved, true)
      assert.equal(report.metadataPreserved, true)
      assert.deepEqual(fs.readFileSync(filename), before)
      assert.deepEqual(fs.readFileSync(asset.nativePath), before)
      if (name.endsWith('.tiff')) assert.deepEqual(report.converted, { width: 80, height: 45, mime: 'image/webp' })
      console.log(`PASS native ${name} → compatible preview, original metadata/bytes preserved${report.converted ? ', actual image conversion succeeds' : ''}`)
    }
    assert.equal(previewCount, 3)
    const compatible = await page.evaluate(async () => {
      const { ensureMediaPreview } = await import('/src/core/media-import.ts')
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 16
      const blob = await new Promise(resolve => canvas.toBlob(resolve))
      const asset = { id: 'compatible', name: 'image.png', kind: 'image', url: URL.createObjectURL(blob), duration: 0, width: 16, height: 16, size: blob.size, mime: 'image/png', nativePath: 'original.png' }
      const prepared = await ensureMediaPreview(asset, async () => { throw new Error('compatible input should not be transcoded') })
      URL.revokeObjectURL(asset.url)
      return prepared.url === asset.url && !prepared.sourceUrl
    })
    assert.equal(compatible, true)
    console.log('PASS compatible originals bypass proxy creation')
  } finally {
    await browser.close()
    await server.close()
    driver.stdin.end(`${JSON.stringify({ id: ++sequence, command: 'quit' })}\n`)
    await new Promise(resolve => { if (driver.exitCode !== null) resolve(); else driver.once('exit', resolve) })
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
