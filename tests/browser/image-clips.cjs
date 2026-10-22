const assert = require('node:assert/strict')
const { existsSync, mkdirSync } = require('node:fs')
const net = require('node:net')
const { chromium, expect } = require('@playwright/test')
const artifacts = '/tmp/open-media-image-clips'
const state = page => page.evaluate(() => window.imageFixture.state.value)
const selection = page => page.getByTestId('preview-selected-clip')
const selectedClip = async page => {
  const id = await selection(page).getAttribute('data-preview-clip-id')
  return (await state(page)).tracks.flatMap(track => track.clips).find(clip => clip.id === id)
}
const pixel = (page, x, y) => page.getByTestId('video-preview').evaluate((canvas, point) => [...canvas.getContext('2d').getImageData(Math.round(point.x / 640 * canvas.width), Math.round(point.y / 360 * canvas.height), 1, 1).data], { x, y })
async function guide(page, axis) {
  const line = page.getByTestId(`preview-snap-${axis}`)
  await expect(line).toHaveCount(1)
  assert(await line.evaluate(node => { const css = getComputedStyle(node); return css.stroke !== 'none' && parseFloat(css.strokeWidth) > 0 && css.visibility === 'visible' }))
}
const near = (actual, expected) => assert(Math.abs(actual - expected) < .03, `${actual} ≈ ${expected}`)
async function gesture(page, from, delta, { alt = false, cancel = false, during } = {}) {
  const box = await page.getByTestId('video-preview').boundingBox(), scale = box.width / 640
  await page.mouse.move(box.x + from.x * scale, box.y + from.y * scale); await page.mouse.down()
  if (alt) await page.keyboard.down('Alt')
  await page.mouse.move(box.x + (from.x + delta.x) * scale, box.y + (from.y + delta.y) * scale, { steps: 7 })
  if (during) await during()
  if (cancel) await page.keyboard.press('Escape')
  await page.mouse.up()
  if (alt) await page.keyboard.up('Alt')
}
async function main() {
  mkdirSync(artifacts, { recursive: true })
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false } }); await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }), errors = []
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
  try {
    await page.route('**/image-clips-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
    await page.goto(`http://127.0.0.1:${port}/image-clips-test`)
    await page.evaluate(async () => {
      const { createProject, createTrack, createClip, validateProject } = await import('/src/core/project.ts')
      const { createHistory, commitHistory, undoHistory } = await import('/src/core/timeline.ts')
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const { createApp, h, shallowRef, ref, nextTick } = await import(source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1])
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      const project = createProject('图片片段与层级', { width: 640, height: 360, fps: 20 })
      project.tracks = []
      async function image(id, width, height, color, half = false) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, half ? width / 2 : width, height)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        return { id, kind: 'image', name: `${id}.png`, url: URL.createObjectURL(blob), duration: 0, width, height, mime: blob.type, size: blob.size }
      }
      const base = await image('base', 640, 360, '#2244dd'), overlay = await image('overlay', 160, 80, '#cc2233', true)
      project.assets.push(base, overlay)
      const track = createTrack('video', '底图'); track.id = 'base-track'; track.clips.push(createClip(base, project, { id: 'base-clip', trimOut: 10 })); project.tracks.push(track)
      const current = shallowRef(validateProject(project, { trusted: true })), editor = ref(null)
      let history = createHistory(current.value)
      const fixture = window.imageFixture = { state: current, editor, changes: [], prepared: [], nextTick, undo() { history = undoHistory(history); current.value = history.present } }
      fixture.app = createApp({ render: () => h(Editor, { ref: editor, project: current.value,
        onChange(next, label) { fixture.changes.push(label); history = commitHistory(history, next); current.value = next },
        onPreparedAsset(asset, blob) { fixture.prepared.push({ id: asset.id, size: blob.size }) },
      }) })
      fixture.app.mount('#app'); await nextTick(); editor.value.seek(2)
    })
    await expect.poll(() => pixel(page, 260, 160)).toEqual([34, 68, 221, 255])
    await page.getByTestId('image-clip-open').click()
    await expect(page.getByRole('dialog', { name: '图片片段', exact: true })).toBeVisible()
    await page.locator('[data-image-asset-id="overlay"]').click()
    await expect(selection(page)).toBeVisible()
    let current = await state(page), clip = await selectedClip(page)
    assert.equal(current.tracks.length, 2); assert.equal(current.tracks[0].clips.length, 1)
    assert.equal(current.tracks[1].name, '图片轨道'); assert.equal(clip.start, 2)
    assert.deepEqual([clip.x, clip.y, clip.width, clip.height], [240, 140, 160, 80])
    await expect.poll(() => pixel(page, 260, 160)).toEqual([204, 34, 51, 255])
    await expect.poll(() => pixel(page, 360, 160)).toEqual([34, 68, 221, 255])
    await expect(page.locator(`[data-z-track-id="${current.tracks[1].id}"]`)).toHaveAttribute('data-z-index', '1')
    console.log('PASS 图片在播放头加入独立前景轨道，源图等比居中，真实PNG透明区显示底图，z-index正确')

    await gesture(page, { x: 320, y: 180 }, { x: -238, y: -138 }, { during: async () => { await guide(page, 'x'); await guide(page, 'y') } })
    clip = await selectedClip(page); near(clip.x, 0); near(clip.y, 0)
    await expect.poll(() => pixel(page, 20, 20)).toEqual([204, 34, 51, 255])
    const changes = await page.evaluate(() => window.imageFixture.changes.length)
    await gesture(page, { x: clip.width, y: clip.height }, { x: 162, y: 81 }, { during: async () => { await guide(page, 'x') } })
    clip = await selectedClip(page); near(clip.width, 320); near(clip.height, 160); near(clip.x, 0); near(clip.y, 0)
    assert.equal(await page.evaluate(() => window.imageFixture.changes.length), changes + 1)
    await expect.poll(() => pixel(page, 140, 60)).toEqual([204, 34, 51, 255])
    await expect.poll(() => pixel(page, 200, 60)).toEqual([34, 68, 221, 255])
    await gesture(page, { x: 320, y: 160 }, { x: 100, y: 50 }, { alt: true, cancel: true })
    near((await selectedClip(page)).width, 320)
    await page.evaluate(() => window.imageFixture.undo()); near((await selectedClip(page)).width, 160)
    console.log('PASS 预览拖动与角缩放支持吸附，图片锁比例、保留透明区域；缩放单次撤销，Esc取消不提交')

    // Import a real file through the image dialog, without sharing the main video track.
    const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 100; c.height = 100; const ctx = c.getContext('2d'); ctx.fillStyle = '#22bb66'; ctx.fillRect(0, 0, 100, 100); return c.toDataURL().split(',')[1] })
    await page.getByTestId('image-clip-open').click()
    await page.getByTestId('image-clip-file').setInputFiles({ name: '本地装饰.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
    await expect(page.getByRole('dialog', { name: '图片片段', exact: true })).not.toBeVisible()
    current = await state(page); clip = await selectedClip(page)
    assert.equal(current.tracks.length, 3); assert.equal(current.tracks[2].clips[0].id, clip.id)
    assert.equal(clip.name, '本地装饰.png'); assert.equal(current.assets.length, 3)
    assert.equal(await page.evaluate(() => window.imageFixture.prepared.length), 1)
    await expect.poll(() => pixel(page, 300, 160)).toEqual([34, 187, 102, 255])
    const overlayTrack = current.tracks[2].id
    const dragHandle = page.locator(`[data-track-drag="${overlayTrack}"]`)
    await dragHandle.focus(); await page.keyboard.press('Alt+ArrowUp'); await page.keyboard.press('Alt+ArrowUp')
    await expect(page.locator(`[data-z-track-id="${overlayTrack}"]`)).toHaveAttribute('data-z-index', '0')
    await expect.poll(() => pixel(page, 300, 160)).toEqual([34, 68, 221, 255])
    await page.screenshot({ path: `${artifacts}/image-clip-layers.png` })
    console.log('PASS 本地图片加入工程并在重叠时新建轨道；上移到z-index 0后被后面的底图覆盖，排序和实际像素一致')
    await page.getByRole('button', { name: '项目设置', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '项目设置', exact: true })).toContainText('轨道从上到下对应画面从背景到前景')
    await page.getByRole('button', { name: '关闭项目设置', exact: true }).click()
    // SVG is decoded as an isolated image and rasterized before crossing the native import boundary.
    await page.getByTestId('image-clip-open').click()
    await page.getByTestId('image-clip-file').setInputFiles({ name: '透明装饰.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>window.imageClipScriptRan=true</script><rect width="50" height="100" fill="#ee9900"/></svg>') })
    await expect(page.getByRole('dialog', { name: '图片片段', exact: true })).not.toBeVisible()
    current = await state(page); clip = await selectedClip(page)
    const converted = current.assets.find(asset => asset.id === clip.assetId)
    assert.equal(converted.name, '透明装饰.png'); assert.equal(converted.mime, 'image/png')
    assert.equal(await page.evaluate(() => window.imageClipScriptRan), undefined)
    const raster = await page.evaluate(async id => {
      const asset = window.imageFixture.state.value.assets.find(asset => asset.id === id), image = new Image()
      image.src = asset.url; await image.decode()
      const c = document.createElement('canvas'); c.width = 100; c.height = 100; const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0)
      return { color: [...ctx.getImageData(10, 10, 1, 1).data], transparent: [...ctx.getImageData(80, 10, 1, 1).data] }
    }, converted.id)
    assert.deepEqual(raster.color, [238, 153, 0, 255]); assert.deepEqual(raster.transparent, [0, 0, 0, 0])
    console.log('PASS SVG通过现有安全图像转换生成透明PNG后导入，脚本不执行，项目设置层级说明一致')
    assert.deepEqual(errors, [])
  } catch (error) { await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {}); throw error }
  finally { await page.close(); await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
