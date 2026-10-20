const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { chromium, expect } = require('@playwright/test')

const workspaces = [
  ['record', 'RecorderWorkspace', '屏幕录制', {}],
  ['gif', 'GifWorkspace', '片段转 GIF', {}],
  ['generate', 'VideoGenerationWorkspace', '视频生成', {}],
  ['image-generate', 'AiGenerationWorkspace', '图像生成', { provider: 'image' }],
  ['song-generate', 'AiGenerationWorkspace', '歌曲生成', { provider: 'music' }],
  ['video', 'ConvertWorkspace', '视频转换', { mode: 'video' }],
]

async function main() {
  const directory = process.env.BROWSER_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-workspace-layout-'))
  fs.mkdirSync(directory, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**'] } }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__tool_layout__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>' }))
    let baseline
    for (const [id, filename, title, props] of workspaces) {
      await page.goto(`${server.resolvedUrls.local[0]}__tool_layout__`)
      await page.evaluate(async ({ filename, props }) => {
        await import('/src/style.css')
        const source = await (await fetch(`/src/components/${filename}.vue`)).text()
        const vueUrl = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
        const { createApp, h } = await import(vueUrl)
        const Component = (await import(`/src/components/${filename}.vue`)).default
        createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': 'dark' }, h(Component, { native: false, active: true, projectTitle: '布局检查', assets: [], ...props })) }).mount('#app')
      }, { filename, props })
      await expect(page.locator('.tool-workspace-header h1')).toHaveText(title)
      for (const width of [1440, 900, 620]) {
        await page.setViewportSize({ width, height: 960 })
        const geometry = await page.locator('.tool-workspace').evaluate(element => {
          const rect = selector => {
            const node = element.querySelector(selector), box = node.getBoundingClientRect()
            return { x: box.x, y: box.y, width: box.width, height: box.height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }
          }
          return { header: rect('.tool-workspace-header'), library: rect('.tool-workspace-library'), main: rect('.tool-workspace-main'), settings: rect('.tool-workspace-settings'), rootWidth: element.scrollWidth, viewport: innerWidth, titleSize: getComputedStyle(element.querySelector('h1')).fontSize }
        })
        assert.equal(geometry.titleSize, '18px', `${id}: consistent title`)
        assert(geometry.rootWidth <= width + 1, `${id} ${width}: no document horizontal scrolling`)
        for (const name of ['library', 'main', 'settings']) {
          const panel = geometry[name]
          assert(panel.width > 0 && panel.x >= 0 && panel.x + panel.width <= width + 1, `${id} ${width}: ${name} fits viewport`)
          assert(panel.scrollWidth <= panel.clientWidth + 2, `${id} ${width}: ${name} content does not overflow horizontally: ${JSON.stringify(panel)}`)
        }
        if (width === 1440) {
          assert.equal(geometry.library.width, 220)
          assert.equal(geometry.settings.width, 280)
          assert.equal(geometry.library.y, geometry.main.y)
          assert.equal(geometry.main.y, geometry.settings.y)
          const layout = [geometry.header.height, geometry.main.x, geometry.main.width, geometry.main.height]
          baseline ??= layout
          assert.deepEqual(layout, baseline, `${id}: panels align with every workspace`)
          await page.screenshot({ path: path.join(directory, `${id}-wide.png`) })
        } else if (width === 900) {
          assert(geometry.main.y > geometry.library.y, `${id}: medium source panel is above preview`)
          assert.equal(geometry.main.y, geometry.settings.y)
        } else {
          assert(geometry.main.y > geometry.library.y && geometry.settings.y > geometry.main.y, `${id}: narrow panels stack in source-preview-settings order`)
          await page.screenshot({ path: path.join(directory, `${id}-narrow.png`) })
        }
      }
    }
    assert.deepEqual(errors, [])
    console.log(`Six workspaces share header, columns, scrolling and responsive layout. Screenshots: ${directory}`)
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
