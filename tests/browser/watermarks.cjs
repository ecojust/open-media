const assert = require('node:assert/strict')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'watermarks') : '/tmp/open-media-watermarks'

async function observeContentPolicy(page) {
  const violations = []
  await page.exposeBinding('reportWatermarkPolicyViolation', (_, violation) => { violations.push(violation) })
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      void window.reportWatermarkPolicyViolation({ directive: event.effectiveDirective, blocked: event.blockedURI, disposition: event.disposition })
    })
  })
  return violations
}

async function installFilePickers(page) {
  await page.addInitScript(() => {
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('watermarks.omedia', { create: true })
    window.showOpenFilePicker = async () => [(await (await navigator.storage.getDirectory()).getFileHandle('watermarks.omedia'))]
    const create = document.createElement.bind(document)
    window.watermarkVideos = []
    document.createElement = function (tag, ...args) {
      const element = create(tag, ...args)
      if (tag.toLowerCase() === 'video') window.watermarkVideos.push(element)
      return element
    }
  })
}

async function installProject(page, url) {
  await page.goto(url)
  await expect(page.getByTestId('home-workspace')).toBeVisible()
  await page.evaluate(async () => {
    const { createProject, createClip, createTextClip } = await import('/src/core/project.ts')
    const { saveProject } = await import('/src/core/storage.ts')
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    canvas.getContext('2d').fillStyle = '#24458b'; canvas.getContext('2d').fillRect(0, 0, 320, 180)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const asset = { id: 'original-picture', kind: 'image', name: '原画面.png', url: URL.createObjectURL(blob), width: 320, height: 180, duration: 0, size: blob.size, mime: blob.type }
    const project = createProject('水印完整流程验证', { width: 320, height: 180, fps: 20 })
    project.assets.push(asset)
    project.tracks[1].clips.push(createClip(asset, project, { id: 'original-picture-clip', trimOut: 7 }))
    project.tracks[0].clips.push(createTextClip(project, { id: 'original-subtitle', text: '原有字幕', trimOut: 7, x: 5, y: 5, width: 100, height: 24, fontSize: 15 }))
    await saveProject(project, new Map([[asset.id, blob]]))
    URL.revokeObjectURL(asset.url)
    localStorage.setItem('open-media:last-project', project.id)
    localStorage.setItem('open-media:autosave', 'true')
  })
  await page.reload()
  await expect(page.getByTestId('home-workspace')).toBeVisible()
  await page.getByTestId('nav-edit').click()
  await expect(page.locator('[data-clip-id="original-picture-clip"]')).toBeVisible()
}

async function projectState(page, assetCount) {
  if (assetCount !== undefined) await expect.poll(async () => page.evaluate(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    try { const value = await loadProject(localStorage.getItem('open-media:last-project')); const count = value.project.assets.length; value.revoke(); return count } catch { return -1 }
  }), { timeout: 20000 }).toBe(assetCount)
  return page.evaluate(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    const value = await loadProject(localStorage.getItem('open-media:last-project'))
    try { return value.project } finally { value.revoke() }
  })
}

async function seek(page, seconds) {
  await page.locator('.timeline-scroll').evaluate(element => { element.scrollLeft = 0 })
  await page.locator('.timeline-ruler').click({ position: { x: seconds * 44, y: 8 } })
}

async function galleryChecks(page) {
  const button = page.getByTestId('watermark-open')
  const position = await button.evaluate(element => ({ previous: element.previousElementSibling?.textContent.trim(), svg: element.querySelectorAll('svg').length }))
  assert.equal(position.previous, '字幕', '添加水印应紧接字幕按钮右侧')
  assert.equal(position.svg, 1)
  await button.click()
  const dialog = page.getByRole('dialog', { name: '添加水印', exact: true })
  await expect(dialog).toBeVisible()
  const count = await page.locator('[data-watermark-id]').count()
  assert(count >= 16, '素材库应提供足够多种内置素材')
  for (const category of ['互动贴纸', '装饰动效', '提示标注', '字幕标签']) {
    await page.locator(`[data-watermark-category="${category}"]`).click()
    assert(await page.locator('[data-watermark-id]').count() > 1)
    await expect(page.locator(`[data-watermark-category="${category}"]`)).toHaveAttribute('aria-pressed', 'true')
  }
  await page.locator('[data-watermark-category="全部"]').click()
  await page.getByTestId('watermark-search').fill('点赞')
  await expect(page.locator('[data-watermark-id]')).toHaveCount(1)
  await expect(page.locator('[data-watermark-id="thumb-pulse"]')).toBeVisible()
  await page.getByTestId('watermark-search').fill('不存在的素材检索')
  await expect(dialog.getByText('没有找到匹配的素材')).toBeVisible()
  await dialog.getByRole('button', { name: '查看全部素材' }).click()
  await expect(page.locator('[data-watermark-id]')).toHaveCount(count)
  const material = page.locator('[data-watermark-id="thumb-pulse"]')
  await material.locator('.material-preview').hover()
  const preview = material.locator('canvas.ready')
  await expect(preview).toBeVisible()
  const pixels = () => preview.evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let hash = 0, opaque = 0, transparent = 0
    for (let i = 0; i < data.length; i += 4) { hash = (hash * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3]) >>> 0; if (data[i + 3] > 240) opaque++; if (data[i + 3] === 0) transparent++ }
    return { hash, opaque, transparent, corner: [...data.slice(0, 4)] }
  })
  const first = await pixels()
  assert(first.opaque > 100 && first.transparent > 1000, '预览应显示真实动画和透明背景')
  assert.equal(first.corner[3], 0, '预览角落的绿幕必须透明')
  await expect.poll(async () => (await pixels()).hash).not.toBe(first.hash)
  await page.evaluate(() => { window.watermarkActivePreview = window.watermarkVideos.findLast(video => !video.isConnected && !video.paused && video.currentSrc.includes('/watermarks/')) })
  await page.screenshot({ path: path.join(artifacts, 'material-library.png') })
  await dialog.getByRole('button', { name: '关闭添加水印' }).click()
  await expect(dialog).not.toBeVisible()
  assert(await page.evaluate(() => window.watermarkActivePreview?.paused && !window.watermarkActivePreview.getAttribute('src')), '关闭弹窗必须暂停并释放素材预览')
  console.log('PASS 添加水印位于字幕右侧；分类、搜索、空结果恢复、真实动画与透明预览，以及关闭后的媒体释放')
}

async function addBuiltin(page, id = 'thumb-pulse') {
  await page.getByTestId('watermark-open').click()
  await page.locator(`[data-watermark-add="${id}"]`).click()
  await expect(page.getByRole('dialog', { name: '添加水印', exact: true })).not.toBeVisible()
}

async function compositeChecks(page, clip, sourceProject) {
  const result = await page.evaluate(async ({ clipId, start }) => {
    const { loadProject } = await import('/src/core/storage.ts')
    const { TimelinePreview } = await import('/src/core/preview.ts')
    const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
    const loaded = await loadProject(localStorage.getItem('open-media:last-project'))
    const clip = loaded.project.tracks.flatMap(track => track.clips).find(item => item.id === clipId)
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const preview = new TimelinePreview(canvas, loaded.project)
    const points = [[2, 170], [Math.floor(clip.x + 2), Math.floor(clip.y + 2)]]
    const read = () => ({ pixels: points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]), bytes: [...context.getImageData(0, 0, 320, 180).data] })
    try {
      await preview.prepare(); await preview.seekReady(start + 0.4)
      const first = read()
      await preview.seekReady(start + 1.2)
      const second = read()
      const blob = await exportTimelineWebM(loaded.project, { width: 320, height: 180, fps: 20 })
      const url = URL.createObjectURL(blob), video = document.createElement('video')
      video.muted = true; video.src = url
      try {
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject })
        const frames = []
        for (const time of [start + 0.4, start + 1.2]) {
          await new Promise(resolve => { video.onseeked = resolve; video.currentTime = time })
          context.clearRect(0, 0, 320, 180); context.drawImage(video, 0, 0, 320, 180)
          frames.push(read())
        }
        return { first, second, frames, encoded: [...new Uint8Array(await blob.arrayBuffer())] }
      } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url) }
    } finally { preview.dispose(); loaded.revoke() }
  }, { clipId: clip.id, start: clip.start })
  const expected = [36, 69, 139]
  const sameBlue = (actual, tolerance) => actual.slice(0, 3).every((value, index) => Math.abs(value - expected[index]) <= tolerance)
  for (const frame of [result.first, result.second]) for (const pixel of frame.pixels) assert(sameBlue(pixel, 2), `绿幕应透出原画面：${pixel}`)
  assert.notDeepEqual(result.first.bytes, result.second.bytes, '不同时间的动画合成画面应有变化')
  assert(result.encoded.length > 1000)
  assert.deepEqual(result.encoded.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3])
  for (const frame of result.frames) for (const pixel of frame.pixels) assert(sameBlue(pixel, 12), `实际导出视频不能带绿色底：${pixel}`)
  let different = 0
  for (let index = 0; index < result.frames[0].bytes.length; index += 4) if (Math.abs(result.frames[0].bytes[index] - result.frames[1].bytes[index]) > 20) different++
  assert(different > 20, `导出动画解码后的两帧应该不同：${different}`)
  writeFileSync(path.join(artifacts, 'watermark-export.webm'), Buffer.from(result.encoded))
  assert.equal(sourceProject.width, 320)
  console.log('PASS 时间线合成真实动画并去除绿底；真实 WebM 导出后再次解码验证动画变化和原画面透出')
}

async function localMaterialChecks(page) {
  const bytes = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
    const context = canvas.getContext('2d')
    context.fillStyle = '#00ff00'; context.fillRect(0, 0, 160, 90)
    context.fillStyle = '#ff00cc'; context.fillRect(40, 20, 80, 50)
    return [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer())]
  }))
  await seek(page, 1)
  await page.getByTestId('watermark-open').click()
  await page.getByTestId('watermark-file').setInputFiles({ name: '本地水印.png', mimeType: 'image/png', buffer: bytes })
  await expect(page.getByRole('dialog', { name: '添加水印', exact: true })).not.toBeVisible()
  const project = await projectState(page, 4), asset = project.assets.find(item => item.name === '本地水印.png')
  const clip = project.tracks.flatMap(track => track.clips).find(item => item.assetId === asset?.id)
  assert(asset && clip)
  assert.equal(clip.start, 1)
  assert(!clip.chromaKey?.enabled, '本地素材不能未经用户选择就去除颜色')
  const pixel = () => page.getByTestId('video-preview').evaluate((canvas, clip) => {
    const x = Math.floor((clip.x + 2) / 320 * canvas.width), y = Math.floor((clip.y + 2) / 180 * canvas.height)
    return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data]
  }, clip)
  await expect.poll(pixel).toEqual([0, 255, 0, 255])
  await page.getByTestId('chroma-key-enabled').click()
  await expect.poll(pixel).toEqual([36, 69, 139, 255])
  await expect.poll(async () => (await projectState(page)).tracks.flatMap(track => track.clips).find(item => item.id === clip.id)?.chromaKey?.enabled).toBe(true)
  await expect(page.getByLabel('去底颜色容差', { exact: true })).toBeVisible()
  await expect(page.getByLabel('去底边缘柔和', { exact: true })).toBeVisible()
  console.log('PASS 本地图片从当前刻度导入，保留原色；用户开启去底后实时透出下层画面，容差和柔化参数可用')
  return projectState(page, 4)
}

async function appChecks(browser, url, productionCsp) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, bypassCSP: false })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  try {
    const violations = await observeContentPolicy(page)
    const response = await context.request.get(url)
    assert.equal(response.headers()['content-security-policy'], productionCsp, '浏览器检查必须使用当前桌面端生产安全策略')
    await installFilePickers(page)
    await installProject(page, url)
    const original = await projectState(page, 1)
    await galleryChecks(page)
    await seek(page, 2.5)
    await addBuiltin(page)
    const added = await projectState(page, 2)
    const track = added.tracks.find(item => item.name === '水印轨道'), clip = track?.clips[0]
    assert(track && clip, '水印必须添加到独立轨道')
    assert.equal(clip.start, 2.5, '素材必须从打开素材库时的当前刻度开始')
    assert.equal(clip.chromaKey.enabled, true)
    assert(added.tracks.indexOf(track) < added.tracks.findIndex(item => item.id === original.tracks[1].id), '水印轨道位于画面轨道上方')
    for (const item of original.tracks) assert.deepEqual(added.tracks.find(value => value.id === item.id).clips, item.clips, '添加水印不能覆盖或移动原有字幕与画面')
    await expect(page.locator(`[data-clip-id="${clip.id}"]`)).toHaveClass(/selected/)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.locator(`[data-clip-id="${clip.id}"]`)).toHaveCount(0)
    await projectState(page, 1)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(page.locator(`[data-clip-id="${clip.id}"]`)).toBeVisible()
    await projectState(page, 2)
    console.log('PASS 素材从精确 2.5 秒开始，自动前景水印轨道与绿幕抠像，不覆盖原素材；撤销/重做原子恢复素材和片段')
    await compositeChecks(page, clip, added)

    await page.locator(`[data-track-label-id="${track.id}"]`).getByRole('button', { name: '锁定轨道', exact: true }).click()
    await seek(page, 2.5)
    await addBuiltin(page, 'star-save')
    const locked = await projectState(page, 3)
    assert.equal(locked.tracks.filter(item => item.name === '水印轨道').length, 2)
    assert.deepEqual(locked.tracks.find(item => item.id === track.id).clips, track.clips)
    assert.equal(locked.tracks.find(item => item.id === track.id).locked, true)
    console.log('PASS 原水印轨道锁定时新建前景轨道并保留锁定内容')

    const withLocal = await localMaterialChecks(page)

    await page.getByTestId('save-project').click()
    await expect(page.locator('.status-main')).toContainText('项目已保存')
    const archive = Buffer.from(await page.evaluate(async () => {
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle('watermarks.omedia')).getFile()
      return [...new Uint8Array(await file.arrayBuffer())]
    }))
    writeFileSync(path.join(artifacts, 'watermarks.omedia'), archive)
    const entries = unzipSync(archive), manifest = JSON.parse(strFromU8(entries['project.json']))
    assert.deepEqual(manifest.project.tracks, withLocal.tracks)
    for (const asset of withLocal.assets) assert.equal(entries[`media/${asset.id}`].byteLength, asset.size)
    await page.reload()
    await expect(page.getByTestId('home-workspace')).toBeVisible()
    await page.getByTestId('nav-edit').click()
    await expect(page.locator(`[data-clip-id="${clip.id}"]`)).toBeVisible()
    assert.deepEqual((await projectState(page, 4)).tracks, withLocal.tracks)
    await page.keyboard.press('Control+o')
    await expect(page.locator('.status-main')).toContainText('已打开')
    await expect(page.locator(`[data-clip-id="${clip.id}"]`)).toBeVisible()
    const localAsset = withLocal.assets.find(item => item.name === '本地水印.png')
    const localClip = withLocal.tracks.flatMap(track => track.clips).find(item => item.assetId === localAsset.id)
    await page.locator(`[data-clip-id="${localClip.id}"]`).click()
    await seek(page, 3)
    await expect(page.getByTestId('chroma-key-enabled')).toBeChecked()
    await page.screenshot({ path: path.join(artifacts, 'watermark-timeline.png') })
    console.log('PASS 项目包保存实际素材字节、抠像参数和轨道；刷新恢复草稿及重新打开便携文件都完整保留')
    await page.setViewportSize({ width: 320, height: 850 })
    await page.getByTestId('watermark-open').click()
    const dialog = page.getByRole('dialog', { name: '添加水印', exact: true })
    await expect(dialog).toBeVisible()
    const dimensions = await dialog.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: window.innerWidth, overflowing: element.scrollWidth > element.clientWidth + 1 }))
    assert(dimensions.left >= 0 && dimensions.right <= dimensions.width && !dimensions.overflowing)
    await page.getByTestId('watermark-search').fill('点赞')
    await expect(page.locator('[data-watermark-add="thumb-pulse"]')).toBeVisible()
    await page.screenshot({ path: path.join(artifacts, 'watermark-narrow.png') })
    await dialog.getByRole('button', { name: '关闭添加水印' }).click()
    console.log('PASS 320 像素窄屏可横向滚动时间线工具、打开素材库、搜索及关闭，无弹窗水平溢出')
    assert.deepEqual(errors, [])
    assert.deepEqual(violations, [], '合法素材读取、预览、导入、保存和真实导出不应触发生产安全策略违规')
    console.log('PASS 当前生产 CSP 下完整素材读取、预览、导入、保存与真实导出，无安全策略违规')
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
    throw error
  } finally { await context.close() }
}

async function staleImportChecks(browser, url, productionCsp) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, bypassCSP: false })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  try {
    const violations = await observeContentPolicy(page)
    await page.route('**/watermark-project-switch', route => route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': productionCsp }, body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto(`${url}/watermark-project-switch`)
    await page.evaluate(async () => {
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
      const { createApp, h, shallowRef } = await import(vueImport)
      const { createProject } = await import('/src/core/project.ts')
      const fixture = { requests: [], events: [], prepared: [], changes: [], revoked: [], current: shallowRef(createProject('旧项目')) }
      window.watermarkBridge = fixture
      const revoke = URL.revokeObjectURL.bind(URL)
      URL.revokeObjectURL = url => { fixture.revoked.push(url); revoke(url) }
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: value => value,
        invoke: async (command, args) => {
          if (command !== 'import_blob_asset') throw new Error(`未预期原生调用：${command}`)
          const blob = new Blob([new Uint8Array(args.bytes)], { type: 'video/mp4' })
          const asset = { id: `native-watermark-${fixture.requests.length}`, name: args.name, kind: 'video', url: URL.createObjectURL(blob), duration: 4, width: 640, height: 360, size: blob.size, mime: blob.type }
          fixture.requests.push({ command, args, asset })
          await new Promise(resolve => { fixture.release = resolve })
          return asset
        },
      }
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      fixture.switchProject = () => { fixture.current.value = createProject('新项目') }
      fixture.app = createApp({ render: () => h(Editor, {
        project: fixture.current.value,
        onChange: project => { fixture.changes.push(project); fixture.current.value = project },
        onBusy: busy => fixture.events.push(busy),
        onPreparedAsset: (asset, blob) => fixture.prepared.push({ asset, size: blob.size }),
      }) })
      fixture.app.mount('#app')
    })
    await page.getByTestId('watermark-open').click()
    await page.locator('[data-watermark-add="thumb-pulse"]').click()
    await expect.poll(() => page.evaluate(() => window.watermarkBridge.requests.length)).toBe(1)
    await expect(page.getByTestId('watermark-library')).toHaveAttribute('aria-busy', 'true')
    const request = await page.evaluate(() => {
      const request = window.watermarkBridge.requests[0]
      return { command: request.command, name: request.args.name, bytes: request.args.bytes.slice(4, 8), size: request.args.bytes.length }
    })
    assert.equal(request.command, 'import_blob_asset')
    assert.equal(request.name, '点赞鼓励.mp4')
    assert.deepEqual(request.bytes, [...Buffer.from('ftyp')])
    assert(request.size > 1000)
    await page.evaluate(() => window.watermarkBridge.switchProject())
    await expect(page.getByRole('dialog', { name: '添加水印', exact: true })).not.toBeVisible()
    await page.evaluate(() => window.watermarkBridge.release())
    await expect.poll(() => page.evaluate(() => window.watermarkBridge.revoked.includes(window.watermarkBridge.requests[0].asset.url))).toBe(true)
    const result = await page.evaluate(() => {
      const fixture = window.watermarkBridge
      return { title: fixture.current.value.title, assets: fixture.current.value.assets.length, clips: fixture.current.value.tracks.flatMap(track => track.clips).length,
        prepared: fixture.prepared.length, changes: fixture.changes.length, busy: fixture.events.at(-1) }
    })
    assert.deepEqual(result, { title: '新项目', assets: 0, clips: 0, prepared: 0, changes: 0, busy: false })
    await expect(page.getByTestId('watermark-open')).toBeEnabled()
    console.log('PASS 原生导入桥传递真实 MP4 字节；项目切换后忽略迟到导入结果、释放 URL、不污染新项目并解除忙碌状态')
    assert.deepEqual(errors, [])
    assert.deepEqual(violations, [], '原生桥场景也必须遵守生产安全策略')
  } finally { await context.close() }
}

async function main() {
  mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const productionCsp = JSON.parse(readFileSync(path.resolve('src-tauri/tauri.conf.json'), 'utf8')).app.security.csp
  assert.equal(typeof productionCsp, 'string', '必须读取实际生产 CSP，不能以测试策略代替')
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/src-tauri/target/**'] }, hmr: false, headers: { 'Content-Security-Policy': productionCsp } } })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    await appChecks(browser, `http://127.0.0.1:${port}`, productionCsp)
    await staleImportChecks(browser, `http://127.0.0.1:${port}`, productionCsp)
  } finally { await browser.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
