const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const projectAssets = page => page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.project.assets.map(asset => ({ id: asset.id, nativePath: asset.nativePath })))
const calls = (page, command) => page.evaluate(command => window.manualLibrary.calls.filter(call => call.command === command), command)

// The application and media decoding run normally; native IPC models the
// directory contract without claiming a real desktop import or conversion.
async function main() {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-manual-library-'))
  const sourcePath = path.join(artifacts, 'source.webm')
  execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x467ed0:s=160x90:r=12:d=1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', sourcePath])
  const source = fs.readFileSync(sourcePath)
  const { createServer } = await import('vite')
  const server = await createServer({ root: path.resolve(__dirname, '../..'), server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox', '--no-proxy-server'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(15000)
    await page.route('**/manual-video/**', route => route.fulfill({ contentType: 'video/webm', body: source }))
    await page.addInitScript(size => {
      localStorage.setItem('open-media:autosave', 'false')
      localStorage.setItem('open-media:theme', 'light')
      let callbackId = 0, sequence = 0
      const asset = (id, nativePath, addedAt = '2026-10-20T10:00:00Z') => ({ id, nativePath, addedAt, name: `${id}.webm`, kind: 'video', url: '', size, duration: 1, width: 160, height: 90, mime: 'video/webm' })
      const state = window.manualLibrary = {
        calls: [], unexpected: [], recording: asset('recording-only', '/recording/recording-only.webm'), generated: asset('generated-only', '/videogen/generated-only.webm', '2026-10-20T09:00:00Z'),
        imported: [], pickerId: 'manual-picker', holdScan: false, releaseScan: null, fileInputsClicked: 0,
      }
      document.addEventListener('click', event => { if (event.target instanceof HTMLInputElement && event.target.type === 'file') state.fileInputsClicked++ })
      const imported = (id, libraryVideo) => {
        const value = asset(id, `/${libraryVideo ? 'import video' : 'media'}/${id}.webm`, new Date(Date.UTC(2026, 9, 20, 12, 0, ++sequence)).toISOString())
        if (libraryVideo) state.imported.push(value)
        return structuredClone(value)
      }
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => ++callbackId, unregisterCallback() {},
        convertFileSrc: value => `${location.origin}/manual-video/${encodeURIComponent(value)}`,
        invoke: async (command, args = {}) => {
          const recordedArgs = { ...args }
          if (recordedArgs.bytes) { recordedArgs.bytesLength = recordedArgs.bytes.length; delete recordedArgs.bytes }
          state.calls.push({ command, args: structuredClone(recordedArgs) })
          if (command === 'get_desktop_platform') return 'linux'
          if (command === 'plugin:event|listen') return ++callbackId
          if (['plugin:event|unlisten', 'plugin:window|set_theme', 'plugin:window|set_background_color', 'plugin:webview|set_webview_background_color', 'mcp_stop'].includes(command)) return null
          if (command === 'configure_screenshot_shortcut') return args.shortcut
          if (['get_media_jobs', 'mcp_pending', 'list_managed_projects'].includes(command)) return []
          if (command === 'ensure_project_media') return { directory: `/projects/${args.projectId}`, assets: args.assets.map(value => ({ assetId: value.id, nativePath: `/projects/${args.projectId}/media/${value.id}.webm`, size: value.size })) }
          if (command === 'save_managed_project') return { directory: `/projects/${args.project.id}`, savedAt: new Date().toISOString() }
          if (command === 'remove_managed_project_draft') return null
          if (command === 'ai_get_status') return { models: [], jobs: [], busy: false }
          if (command === 'get_runtime_status') return { ready: true, version: 'fixture' }
          if (command === 'mcp_get_status') return { running: false, connectedClients: 0, pendingRequests: 0 }
          if (command === 'pick_media_assets') return [imported(state.pickerId, args.libraryVideo === true)]
          if (command === 'import_blob_asset') return imported(args.name.replace(/\.webm$/, ''), args.libraryVideo === true)
          if (command === 'list_workspace_assets') {
            const files = [...(args.categories.includes('recording') ? [state.recording] : []), ...(args.categories.includes('videogen') ? [state.generated] : [])]
            const result = { directories: Object.fromEntries(args.categories.map(category => [category, `/${category}`])), assets: files.map(value => ({ ...value, id: `scan-${value.id}`, addedAt: Date.parse(value.addedAt) })), warnings: [] }
            if (state.holdScan) {
              state.holdScan = false
              await new Promise(resolve => { state.releaseScan = () => { state.releaseScan = null; resolve() } })
            }
            return result
          }
          state.unexpected.push(command)
          throw new Error(`Unexpected native command: ${command}`)
        },
      }
    }, source.length)
    await page.goto(server.resolvedUrls.local[0])
    await expect(page.getByTestId('home-workspace')).toBeVisible()
    await page.getByTestId('nav-video').click()
    const rows = page.locator('[data-source-asset-id]')
    await expect(rows).toHaveCount(2)
    assert.deepEqual(await projectAssets(page), [], 'opening the library does not import every recording into the project')

    await page.getByTestId('convert-workspace').getByRole('button', { name: '导入视频', exact: true }).click()
    await expect(page.locator('[data-source-asset-id="manual-picker"]')).toBeVisible()
    assert.deepEqual((await calls(page, 'pick_media_assets')).map(call => call.args), [{}])
    assert.deepEqual(await projectAssets(page), [], 'manual workspace import must not alter the editing project')
    assert.equal(await page.evaluate(() => window.manualLibrary.fileInputsClicked), 0, 'desktop import uses the system picker')

    await page.getByTestId('media-input').setInputFiles({ name: 'manual-file.webm', mimeType: 'video/webm', buffer: source })
    await expect(page.locator('[data-source-asset-id="manual-file"]')).toBeVisible()
    const manualBlob = (await calls(page, 'import_blob_asset'))[0]
    assert.deepEqual(manualBlob.args, { name: 'manual-file.webm', bytesLength: source.length })
    assert.deepEqual(await projectAssets(page), [])
    assert((await calls(page, 'list_workspace_assets')).every(call => JSON.stringify(call.args.categories) === JSON.stringify(['recording', 'videogen'])), 'video conversion requests only the public recording and video generation categories')

    await page.getByTestId('nav-gif').click()
    const gif = page.getByTestId('gif-workspace'), selection = page.getByLabel('GIF 视频来源')
    await expect(gif).toBeVisible()
    await expect(selection).toHaveValue('scan-recording-only')
    await expect(page.locator('[data-source-asset-id="manual-file"]')).toHaveCount(0)
        await page.evaluate(() => { window.manualLibrary.pickerId = 'gif-picker'; window.manualLibrary.holdScan = true })
    await gif.getByRole('button', { name: '导入视频', exact: true }).click()
    await expect(page.locator('[data-source-asset-id="gif-picker"]')).toBeVisible()
    assert.deepEqual(await projectAssets(page), [])
    await page.waitForFunction(() => typeof window.manualLibrary.releaseScan === 'function')
    await expect(selection).toHaveValue('gif-picker')
    assert.deepEqual((await calls(page, 'pick_media_assets')).map(call => call.args), [{}, {}])
    assert.equal(await page.evaluate(() => window.manualLibrary.fileInputsClicked), 0, 'GIF desktop import must not open its browser file input')
    await page.evaluate(() => window.manualLibrary.releaseScan())
    await expect(page.locator('[data-source-asset-id="gif-picker"]')).toBeVisible()
    await expect(selection).toHaveValue('gif-picker')
    const preview = page.getByLabel('GIF 来源视频预览')
    await expect.poll(() => preview.evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2)
    assert.equal(await preview.evaluate(video => video.paused), true)
    assert.deepEqual(await projectAssets(page), [])
    await page.locator('[data-source-asset-id="gif-picker"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '添加到工程素材' }).click()
    await expect.poll(async () => (await projectAssets(page)).map(asset => asset.id)).toEqual(['gif-picker'])
    const copied = (await projectAssets(page))[0]
    assert(copied.nativePath.startsWith('/projects/'), 'explicit add copies the source into its project directory')
    assert.notEqual(copied.nativePath, '/media/gif-picker.webm')
    await expect(preview).toHaveAttribute('src', /manual-video/)

    // Exercise the real App callback used by conversion results without running
    // an unrelated export. Its blob import keeps the default non-library scope.
    await page.evaluate(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState
      await app.acceptConverted({ id: 'generated-input', name: 'generated-result.webm', kind: 'video', url: `${location.origin}/manual-video/generated-output`, duration: 1, width: 160, height: 90, size: 1, mime: 'video/webm' })
    })
    assert.deepEqual((await projectAssets(page)).map(asset => asset.id), ['gif-picker'], 'conversion result stays outside the editing project')
    const generatedBlob = (await calls(page, 'import_blob_asset')).at(-1)
    assert.deepEqual(generatedBlob.args, { name: 'generated-result.webm', bytesLength: source.length }, 'generated output must not opt into the manual video library')
    await expect(page.getByTestId('video-library-actions').getByRole('button', { name: '刷新本机视频列表' })).toBeEnabled()
    await expect(page.locator('[data-source-asset-id="generated-result"]')).toHaveCount(0)
    await expect(selection).toHaveValue('gif-picker')
    assert((await calls(page, 'list_workspace_assets')).every(call => JSON.stringify(call.args.categories) === JSON.stringify(['recording', 'videogen'])))
    await page.getByTestId('nav-video').click()
    await expect(page.locator('[data-source-asset-id="generated-result"]')).toBeVisible()
    await expect(page.locator('[data-source-asset-id="manual-picker"]')).toBeVisible()
    await expect(page.locator('[data-source-asset-id="gif-picker"]')).toHaveCount(0)
    await page.locator('[data-source-asset-id="scan-generated-only"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '添加到工程素材' }).click()
    await expect.poll(async () => (await projectAssets(page)).map(asset => asset.id)).toEqual(['gif-picker', 'scan-generated-only'])
    assert.equal((await calls(page, 'create_media_preview')).length, 0, 'fixture videos decode directly in the actual browser')
    assert.deepEqual(await page.evaluate(() => window.manualLibrary.unexpected), [])
    assert.deepEqual(errors, [])
    await page.screenshot({ path: path.join(artifacts, 'manual-library-gif.png') })
    console.log(`PASS complete App manual import contracts: isolated system picker/file imports and conversion results; recording + generated video folders; right-click copies into current project (mocked native IPC, real WebM decode). Artifacts: ${artifacts}`)
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
