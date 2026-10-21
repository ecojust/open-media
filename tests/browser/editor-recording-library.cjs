const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

const recordingDirectory = '/Users/demo/Library/Application Support/Open Media/recordings'
const card = (page, id) => page.locator(`.asset-card[data-source-asset-id="${id}"]`)
const snapshot = page => page.evaluate(() => JSON.parse(JSON.stringify(window.recordingLibrary.current.value)))
const assetCount = page => page.evaluate(() => window.recordingLibrary.current.value.assets.length)
const clipsFor = (page, id) => page.evaluate(id => window.recordingLibrary.current.value.tracks.flatMap(track => track.clips).filter(clip => clip.assetId === id), id)

async function assertLibraryHeader(page) {
  await expect(page.getByTestId('video-library-actions')).toHaveCount(0)
  await expect(page.getByTestId('video-library-toolbar')).toHaveCount(0)
  await expect(page.getByLabel('素材来源', { exact: true })).toHaveCount(0)
  await expect(page.locator('.asset-panel > header')).toContainText('项目素材')
  await expect(page.locator('.asset-panel > header').getByTitle('导入素材')).toBeVisible()
  assert.deepEqual(await page.getByLabel('素材类型', { exact: true }).getByRole('button').allTextContents(), ['全部', '视频', '图片', '音频'])
  await expect(page.locator('body')).not.toContainText(recordingDirectory)
}

async function mount(page, url, native, media) {
  await page.route('**/__editor_recordings__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div></body></html>' }))
  await page.route('**/editor-library-video/*', route => route.fulfill({ contentType: 'video/webm', body: media.video }))
  await page.route('**/editor-library-audio/*', route => route.fulfill({ contentType: 'audio/wav', body: media.audio }))
  await page.goto(`${url}/__editor_recordings__`)
  await page.evaluate(async ({ native, directory, videoSize, audioSize }) => {
    await import('/src/style.css')
    const componentSource = await (await fetch('/src/components/VideoEditor.vue')).text()
    const vueURL = componentSource.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref } = await import(vueURL)
    const { createProject, createClip } = await import('/src/core/project.ts')
    const { addWatermark } = await import('/src/core/watermark-track.ts')
    const { addBackgroundMusic } = await import('/src/core/background-music-track.ts')
    const video = (id, addedAt, local = false) => ({ id, name: `${id}.webm`, kind: 'video', url: `${location.origin}/editor-library-video/${id}`, duration: 8, width: 320, height: 180, mime: 'video/webm', size: videoSize, addedAt, ...(local ? { nativePath: `${directory}/${id}.webm` } : { nativePath: `/media/${id}.webm` }) })
    const audio = (id, name) => ({ id, name, kind: 'audio', url: `${location.origin}/editor-library-audio/${id}`, duration: 8, width: 0, height: 0, mime: 'audio/wav', size: audioSize, addedAt: '2026-10-18T03:00:00.000Z' })
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40
    const context = canvas.getContext('2d'); context.fillStyle = '#17a7bb'; context.fillRect(0, 0, 80, 40)
    const imageURL = canvas.toDataURL('image/png'), imageSize = (await (await fetch(imageURL)).blob()).size
    const image = (id, name) => ({ id, name, kind: 'image', url: imageURL, duration: 0, width: 80, height: 40, mime: 'image/png', size: imageSize, addedAt: '2026-10-18T02:00:00.000Z' })
    let project = createProject('工程素材隔离验证', { width: 320, height: 180, fps: 15 })
    const main = video('project-video', '2026-10-18T01:00:00.000Z')
    const legacy = video('legacy-overlay', '2026-10-18T01:30:00.000Z'); legacy.name = '旧水印素材.webm'
    project.assets.push(main, audio('project-audio', '背景音乐-普通素材.wav'), image('project-image', '水印设计原稿.png'), legacy)
    const mainTrackId = project.tracks.find(track => track.kind === 'video').id
    project.tracks.find(track => track.id === mainTrackId).clips.push(createClip(main, project, { id: 'original-video', start: 0 }))
    const watermark = addWatermark(project, { ...image('builtin-watermark', '内置水印.png'), libraryRole: 'watermark' }, 0)
    project = watermark.project
    project.tracks.find(track => track.id === watermark.trackId).clips.push(createClip(legacy, project, { id: 'legacy-overlay-clip', start: 6, trimOut: 2 }))
    const music = addBackgroundMusic(project, { ...audio('builtin-music', '内置背景配乐.wav'), libraryRole: 'background-music' }, 0)
    project = music.project
    const fixture = window.recordingLibrary = {
      current: shallowRef(project), editor: ref(null), initial: JSON.parse(JSON.stringify(project)), mainTrackId,
      watermarkClipId: watermark.clipId, musicClipId: music.clipId, calls: [], changes: [], statuses: [], imports: 0, devices: 0,
      stored: [],
      addImported() { this.current.value = { ...this.current.value, assets: [...this.current.value.assets, video('explicit-import', '2026-10-19T00:00:00.000Z', true)] } },
      openEmptyProject() { this.current.value = createProject('独立空工程', { width: 320, height: 180, fps: 15 }) },
      addStored(id, time) { this.stored.push({ ...video(id, Date.parse(time), true) }) },
    }
    fixture.addStored('recording-a', '2031-01-01T01:00:00Z')
    fixture.addStored('recording-b', '2031-01-01T02:00:00Z')
    fixture.addStored('recording-c', '2031-01-01T03:00:00Z')
    navigator.mediaDevices.getUserMedia = async () => { fixture.devices++; throw new Error('此测试禁止麦克风和摄像头采集') }
    if (native) window.__TAURI_INTERNALS__ = {
      convertFileSrc: nativePath => `${location.origin}/editor-library-video/${nativePath.split('/').pop().replace(/\.[^.]+$/, '')}`,
      invoke: async (command, args) => {
        fixture.calls.push({ command, args })
        if (command === 'list_stored_videos') return { directory, assets: structuredClone(fixture.stored), warnings: [] }
        throw new Error(`Unexpected native command: ${command}`)
      },
    }
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    fixture.app = createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': 'light' }, h(Editor, {
      ref: fixture.editor, project: fixture.current.value,
      onChange: (next, label) => { fixture.changes.push({ label, assets: next.assets.length, clips: next.tracks.reduce((sum, track) => sum + track.clips.length, 0) }); fixture.current.value = next },
      onImport: () => fixture.imports++, onStatus: message => fixture.statuses.push(message),
    })) })
    fixture.app.mount('#app')
    fixture.dispose = () => fixture.app.unmount()
  }, { native, directory: recordingDirectory, videoSize: media.video.length, audioSize: media.audio.length })
}

async function ordinaryAssets(page) {
  await page.getByRole('button', { name: '全部', exact: true }).first().click()
  await expect(page.locator('.asset-card')).toHaveCount(4)
  for (const id of ['project-video', 'project-audio', 'project-image', 'legacy-overlay']) await expect(card(page, id)).toBeVisible()
  for (const id of ['builtin-watermark', 'builtin-music']) await expect(card(page, id)).toHaveCount(0)
  await page.getByRole('button', { name: '音频', exact: true }).first().click()
  await expect(page.locator('.asset-card')).toHaveCount(1)
  await expect(card(page, 'project-audio')).toBeVisible()
  await page.getByRole('button', { name: '图片', exact: true }).first().click()
  await expect(page.locator('.asset-card')).toHaveCount(1)
  await expect(card(page, 'project-image')).toBeVisible()
  await page.getByRole('button', { name: '全部', exact: true }).first().click()
}

async function saveAndInspect(page, output, media) {
  const result = await page.evaluate(async () => {
    const { exportProjectFile, importProjectFile } = await import('/src/core/project-file.ts')
    const source = window.recordingLibrary.current.value
    const blob = await exportProjectFile(source)
    const restored = await importProjectFile(blob)
    try {
      return { bytes: [...new Uint8Array(await blob.arrayBuffer())], source: JSON.parse(JSON.stringify(source)), restored: restored.project }
    } finally { restored.revoke() }
  })
  const bytes = Buffer.from(result.bytes), entries = unzipSync(bytes)
  fs.writeFileSync(output, bytes)
  const manifest = JSON.parse(strFromU8(entries['project.json'])).project
  assert.equal(manifest.assets.length, result.source.assets.length)
  assert.equal(Object.keys(entries).length, result.source.assets.length + 1)
  assert.deepEqual(manifest.tracks, result.source.tracks, '项目素材过滤不能删除时间线片段')
  assert.deepEqual(result.restored.tracks, result.source.tracks, '便携项目打开后仍保留完整时间线')
  assert.equal(manifest.assets.find(asset => asset.id === 'builtin-watermark').libraryRole, 'watermark')
  assert.equal(manifest.assets.find(asset => asset.id === 'builtin-music').libraryRole, 'background-music')
  assert.deepEqual(Buffer.from(entries['media/builtin-music']), media.audio, '隐藏的内置配乐仍必须完整打包')
  assert(entries['media/builtin-watermark'].byteLength > 30, '隐藏的水印图片仍必须完整打包')
  for (const asset of manifest.assets.filter(asset => asset.kind === 'video')) assert.deepEqual(Buffer.from(entries[`media/${asset.id}`]), media.video)
  assert(!manifest.assets.some(asset => /^recording-/.test(asset.id)), '公共目录视频不能自动进入工程保存文件')
}

async function dragAsset(page, id, trackId, time) {
  const handle = await page.evaluateHandle(() => new DataTransfer())
  try {
    await card(page, id).dispatchEvent('dragstart', { dataTransfer: handle })
    const lane = page.locator(`.track-lane[data-track-id="${trackId}"]`)
    await lane.scrollIntoViewIfNeeded()
    const bounds = await lane.boundingBox()
    await lane.dispatchEvent('drop', { dataTransfer: handle, clientX: bounds.x + time * 44, clientY: bounds.y + 15 })
  } finally { await handle.dispose() }
}

async function main() {
  const directory = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'editor-recording-library') : fs.mkdtempSync(path.join(os.tmpdir(), 'open-media-editor-recordings-'))
  fs.mkdirSync(directory, { recursive: true })
  const videoPath = path.join(directory, 'source.webm'), audioPath = path.join(directory, 'source.wav')
  execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x6257db:s=320x180:r=15:d=8', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', videoPath])
  execFileSync(process.env.OPEN_MEDIA_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=16000', '-c:a', 'pcm_s16le', audioPath])
  const media = { video: fs.readFileSync(videoPath), audio: fs.readFileSync(audioPath) }
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const url = `http://127.0.0.1:${server.httpServer.address().port}`
    for (const native of [true, false]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }), errors = [], requests = []
      page.setDefaultTimeout(15000)
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => { if (request.url().includes('/editor-library-video/')) requests.push(request.url()) })
      await mount(page, url, native, media)
      const initial = await page.evaluate(() => window.recordingLibrary.initial)
      await assertLibraryHeader(page)
      await ordinaryAssets(page)
      assert.deepEqual(await snapshot(page), initial, '显示工程素材和筛选不会修改工程')
      assert.equal(await page.evaluate(() => window.recordingLibrary.changes.length), 0)
      for (const id of ['watermarkClipId', 'musicClipId']) {
        const clipId = await page.evaluate(id => window.recordingLibrary[id], id)
        await expect(page.locator(`.timeline-clip[data-clip-id="${clipId}"]`)).toHaveCount(1)
      }
      for (const id of ['recording-a', 'recording-b', 'recording-c']) await expect(card(page, id)).toHaveCount(0)
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      assert.equal(await page.evaluate(() => window.recordingLibrary.calls.length), 0, '工程剪辑不扫描任何公共目录')
      assert(!requests.some(url => /\/recording-[abc]$/.test(url)), '打开工程不能读取未添加的公共素材')
      await card(page, 'project-video').dblclick()
      await expect.poll(async () => (await clipsFor(page, 'project-video')).length).toBe(2)
      const mainTrackId = await page.evaluate(() => window.recordingLibrary.mainTrackId)
      await dragAsset(page, 'project-video', mainTrackId, 16)
      await expect.poll(async () => (await clipsFor(page, 'project-video')).length).toBe(3)
      assert.equal(await assetCount(page), initial.assets.length, '复用工程素材不能重复登记')
      await page.evaluate(() => window.recordingLibrary.editor.value.setPlayback({ time: 0.5, selectedClipId: '' }))
      await expect.poll(() => page.locator('.preview-frame canvas').evaluate(canvas => {
        const [r, g, b, a] = canvas.getContext('2d').getImageData(5, canvas.height - 5, 1, 1).data
        return Math.abs(r - 98) <= 3 && Math.abs(g - 87) <= 3 && Math.abs(b - 219) <= 3 && a === 255
      }), { message: '工程视频应真实解码并进入预览画布' }).toBe(true)
      await page.locator('.asset-panel > header').getByTitle('导入素材').click()
      assert.equal(await page.evaluate(() => window.recordingLibrary.imports), 1)
      assert.equal(await assetCount(page), initial.assets.length, '只有点击导入、尚未接受文件时不添加素材')
      await page.evaluate(() => window.recordingLibrary.addImported())
      await expect(card(page, 'explicit-import')).toBeVisible()
      await expect(page.locator('.asset-card')).toHaveCount(5)
      await saveAndInspect(page, path.join(directory, `project-library-${native ? 'desktop' : 'browser'}.omedia`), media)
      const previous = await snapshot(page)
      await page.getByRole('button', { name: '图片', exact: true }).first().click()
      await page.getByLabel('搜索素材', { exact: true }).fill('水印')
      await page.evaluate(() => window.recordingLibrary.openEmptyProject())
      await expect(page.locator('.asset-card')).toHaveCount(0)
      await expect(page.locator('.asset-empty')).toContainText('此工程暂无素材')
      await expect(page.getByLabel('搜索素材', { exact: true })).toHaveValue('')
      await expect(page.getByRole('button', { name: '全部', exact: true }).first()).toHaveClass(/active/)
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      assert.equal(await page.evaluate(() => window.recordingLibrary.calls.length), 0)
      assert.equal(await assetCount(page), 0, '新工程不能混入上一个工程或公共目录素材')
      await page.evaluate(previous => { window.recordingLibrary.current.value = previous }, previous)
      await expect(page.locator('.asset-card')).toHaveCount(5)
      for (const width of [1440, 780]) {
        await page.setViewportSize({ width, height: 960 })
        await assertLibraryHeader(page)
        await page.screenshot({ path: path.join(directory, `editor-project-library-${native ? 'desktop' : 'browser'}-${width}.png`), animations: 'disabled' })
      }
      assert(!requests.some(url => /\/recording-[abc]$/.test(url)), '切换工程和保存均不能读取未添加的公共目录文件')
      console.log(`PASS ${native ? '桌面' : '网页'} 工程素材隔离、显式导入、直接分类、工程切换、真实视频解码与便携工程媒体字节校验`)
      assert.equal(await page.evaluate(() => window.recordingLibrary.devices), 0)
      assert.deepEqual(errors, [])
      await page.evaluate(() => window.recordingLibrary.dispose())
      await page.close()
    }
    console.log(`截图及便携项目验证产物：${directory}`)
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
