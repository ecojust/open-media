const assert = require('node:assert/strict')
const { existsSync, mkdirSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '../..')
const artifacts = path.join(os.tmpdir(), 'open-media-native-platform')

async function checkSidebarControls(page) {
  await expect(page.locator('.header-controls')).toHaveCount(1)
  await expect(page.locator('.topbar')).toHaveCount(0)
  const sidebar = await page.locator('.sidebar').boundingBox()
  const controls = page.locator('.sidebar-bottom .header-controls')
  await expect(controls).toBeVisible()
  const bottom = await page.locator('.statusbar').boundingBox()
  for (const button of await controls.locator('.theme-switch>button,.header-icon').all()) {
    await expect(button).toBeVisible()
    const bounds = await button.boundingBox()
    assert(bounds.x >= sidebar.x && bounds.x + bounds.width <= sidebar.x + sidebar.width, 'sidebar buttons fit within its width')
    assert(bounds.y >= sidebar.y && bounds.y + bounds.height <= bottom.y, 'sidebar buttons remain above the status bar')
  }
  const bounds = await controls.boundingBox()
  assert(bottom.y - bounds.y - bounds.height < 30, 'appearance controls stay at the lower left')
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: () => true } }, logLevel: 'error' })
  await server.listen()
  mkdirSync(artifacts, { recursive: true })
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
  try {
    for (const platform of ['windows', 'macos', 'linux', 'web', 'failed']) {
      const sidebarControls = platform === 'windows' || platform === 'macos'
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
      await expect(page.locator('.topbar .brand')).toHaveCount(sidebarControls ? 0 : 1)
      await expect(page.getByTestId('theme-dark')).toBeVisible()
      await page.getByTestId('theme-dark').click()
      await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
      const bounds = await page.locator('.header-controls').boundingBox()
      if (sidebarControls) {
        await checkSidebarControls(page)
        assert.equal((await page.locator('.workbench-body').boundingBox()).y, 0, `${platform} has no empty header row`)
      } else assert.ok(bounds.x + bounds.width > 1400, 'appearance controls remain at the right edge')
      await page.getByRole('button', { name: '关于 Open Media', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '关于 Open Media', exact: true })).toContainText('版本号')
      await expect(page.getByRole('dialog', { name: '关于 Open Media', exact: true })).toContainText('构建时间')
      assert.deepEqual(errors, [])
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: '关于 Open Media', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '关于 Open Media', exact: true })).toBeFocused()
      await page.screenshot({ path: path.join(artifacts, `header-${platform}.png`) })
      if (sidebarControls) {
        await page.getByRole('button', { name: '折叠侧栏', exact: true }).click()
        await expect(page.locator('.sidebar')).toHaveCSS('width', '58px')
        await checkSidebarControls(page)
        await page.screenshot({ path: path.join(artifacts, `${platform}-collapsed.png`) })
        await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
        for (const [width, height] of [[1100, 800], [800, 640], [420, 640], [800, 400]]) {
          await page.setViewportSize({ width, height })
          await expect(page.locator('.sidebar')).toHaveCSS('width', width <= 640 ? '48px' : width <= 900 ? '58px' : '155px')
          await checkSidebarControls(page)
          for (const theme of ['light', 'dark', 'system']) {
            await page.getByTestId(`theme-${theme}`).click()
            await expect(page.getByTestId(`theme-${theme}`)).toHaveAttribute('aria-pressed', 'true')
          }
          await page.emulateMedia({ colorScheme: 'dark' })
          await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark')
          await page.emulateMedia({ colorScheme: 'light' })
          await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'light')
          await page.getByRole('button', { name: '关于 Open Media', exact: true }).click()
          const dialog = page.getByRole('dialog', { name: '关于 Open Media', exact: true })
          await expect(dialog).toBeVisible()
          const box = await dialog.boundingBox()
          assert(Math.abs(box.x + box.width / 2 - width / 2) < 2, 'information dialog stays centered in the window')
          await expect(dialog).toContainText('构建时间')
          await page.keyboard.press('Escape')
          await expect(page.getByRole('button', { name: '关于 Open Media', exact: true })).toBeFocused()
          await page.screenshot({ path: path.join(artifacts, `${platform}-${width}x${height}.png`) })
        }
      }
      await context.close()
      console.log(`PASS ${platform}: platform identity, ${sidebarControls ? 'responsive lower-left' : 'right-aligned'} theme controls and app information`)
    }
  } finally {
    await browser.close()
    await server.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
