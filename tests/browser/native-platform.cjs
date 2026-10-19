const assert = require('node:assert/strict')
const { existsSync, mkdirSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '../..')
const artifacts = path.join(os.tmpdir(), 'open-media-native-platform')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: () => true } }, logLevel: 'error' })
  await server.listen()
  mkdirSync(artifacts, { recursive: true })
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
  try {
    for (const platform of ['windows', 'macos', 'linux', 'web', 'failed']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
      const page = await context.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(platform => {
        localStorage.setItem('open-media:autosave', 'false')
        if (platform === 'web') return
        let nextId = 0
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
          transformCallback: () => ++nextId,
          unregisterCallback() {},
          convertFileSrc: value => value,
          invoke: async (command, args) => {
            if (command === 'get_desktop_platform') {
              window.headerPlatformRequested = true
              if (platform === 'failed') throw new Error('Host unavailable')
              return platform
            }
            if (command === 'plugin:event|listen') return ++nextId
            if (command === 'configure_screenshot_shortcut') return args.shortcut
            if (command === 'get_media_jobs' || command === 'mcp_pending') return []
            if (command === 'get_runtime_status') return { ready: true, version: 'fixture' }
            if (command === 'mcp_get_status') return { running: false, connectedClients: 0, pendingRequests: 0 }
            return null
          },
        }
      }, platform)
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
      await expect(page.getByTestId('home-workspace')).toBeVisible()
      if (platform !== 'web') await page.waitForFunction(() => window.headerPlatformRequested)
      await expect(page.locator('.topbar .brand')).toHaveCount(platform === 'windows' ? 0 : 1)
      await expect(page.getByTestId('theme-dark')).toBeVisible()
      await page.getByTestId('theme-dark').click()
      await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
      const bounds = await page.locator('.header-controls').boundingBox()
      assert.ok(bounds.x + bounds.width > 1400, 'appearance controls remain at the right edge')
      await page.getByRole('button', { name: '关于 Open Media', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '关于 Open Media', exact: true })).toContainText('版本号')
      await expect(page.getByRole('dialog', { name: '关于 Open Media', exact: true })).toContainText('构建时间')
      assert.deepEqual(errors, [])
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: '关于 Open Media', exact: true })).toHaveCount(0)
      await page.screenshot({ path: path.join(artifacts, `header-${platform}.png`) })
      await context.close()
      console.log(`PASS ${platform}: platform identity, right-aligned theme controls and app information`)
    }
  } finally {
    await browser.close()
    await server.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
