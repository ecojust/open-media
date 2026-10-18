#!/usr/bin/env node
/** Render original editable templates with the application's actual text renderer. */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'public/watermarks')
const review = process.env.WATERMARK_REVIEW_DIR || '/tmp/open-media-general-watermarks'
await mkdir(output, { recursive: true }); await mkdir(review, { recursive: true })
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }, plugins: [{ name: 'watermark-render-page', configureServer(server) {
  server.middlewares.use('/__general-watermark-posters', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>') })
} } ] })
await server.listen()
const port = server.httpServer.address().port
const executablePath = process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)
let browser
try {
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`http://127.0.0.1:${port}/__general-watermark-posters`)
  const rendered = await page.evaluate(async () => {
    const { GENERAL_WATERMARK_MATERIALS } = await import('/src/core/general-watermark-catalog.ts')
    const { createProject } = await import('/src/core/project.ts')
    const { addTextWatermark } = await import('/src/core/watermark-track.ts')
    const { animatedClipAt } = await import('/src/core/visual-animation.ts')
    const { drawTextClip } = await import('/src/core/preview.ts')
    const project = createProject('通用模板缩略图', { width: 640, height: 360, fps: 24 })
    const sheets = document.createElement('canvas'); sheets.width = 1920; sheets.height = 6 * 318
    const sheet = sheets.getContext('2d'); sheet.fillStyle = '#0e1722'; sheet.fillRect(0, 0, sheets.width, sheets.height)
    const result = []
    for (const [index, material] of GENERAL_WATERMARK_MATERIALS.entries()) {
      const added = addTextWatermark(project, material, 0)
      const clip = animatedClipAt(added.project.tracks.flatMap(track => track.clips).find(item => item.id === added.clipId), material.duration / 2)
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.translate(clip.x, clip.y); ctx.globalAlpha = clip.opacity; drawTextClip(ctx, clip)
      const pixels = ctx.getImageData(0, 0, 640, 360).data
      let visiblePixels = 0
      for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset] > 240) visiblePixels++
      if (visiblePixels < 100) throw new Error(`模板未实际绘制：${material.id}`)
      const x = index % 4 * 480, y = Math.floor(index / 4) * 318
      sheet.strokeStyle = '#2a3b46'; sheet.strokeRect(x + 8, y + 8, 464, 270)
      sheet.drawImage(canvas, x + 8, y + 8, 464, 261)
      sheet.fillStyle = '#e8ecee'; sheet.font = '17px sans-serif'; sheet.textBaseline = 'middle'; sheet.fillText(material.name, x + 18, y + 295)
      result.push({ id: material.id, placement: material.placement, textTemplate: material.textTemplate, visiblePixels, dataUrl: canvas.toDataURL('image/png') })
    }
    return { materials: result, montage: sheets.toDataURL('image/png') }
  })
  const materials = []
  for (const material of rendered.materials) {
    const { dataUrl, ...record } = material
    const bytes = Buffer.from(dataUrl.split(',')[1], 'base64'), file = `${material.id}.png`
    await writeFile(path.join(output, file), bytes)
    materials.push({ ...record, file, width: 640, height: 360, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  await writeFile(path.join(output, 'general-manifest.json'), JSON.stringify({ version: 1, origin: 'Original editable Open Media text layouts', generator: 'scripts/generate-general-watermark-posters.mjs', renderer: 'drawTextClip + animatedClipAt', materials }, null, 2) + '\n')
  await writeFile(path.join(review, 'general-watermarks-montage.png'), Buffer.from(rendered.montage.split(',')[1], 'base64'))
  console.log(`Rendered ${materials.length} actual native text posters. Review: ${path.join(review, 'general-watermarks-montage.png')}`)
} finally { await browser?.close(); await server.close() }
