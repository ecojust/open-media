const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { chromium, expect } = require('@playwright/test')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'video-segments') : '/tmp/open-media-video-segments'
async function main() {
  mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false } })
  await server.listen()
  let browser, page
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(20000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/video-segment-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body><div id="app"></div></body></html>' }))
    await page.goto(`http://127.0.0.1:${port}/video-segment-fixture`)
    await page.evaluate(async () => {
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const vuePath = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
      const { createApp, h, shallowRef, nextTick } = await import(vuePath)
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      const { createProject, createClip, createTextClip } = await import('/src/core/project.ts')
      const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
      const original = createProject('片头片尾完整验证', { width: 320, height: 180, fps: 20 })
      const blob = await (await fetch(VIDEO_SEGMENTS[2].url)).blob()
      const asset = { id: 'original-video', name: '原视频.webm', kind: 'video', url: URL.createObjectURL(blob), duration: 5, width: 1280, height: 720, size: blob.size, mime: 'video/webm' }
      original.assets.push(asset)
      original.tracks[1].clips.push(createClip(asset, original, { id: 'original-video-clip', volume: 0 }))
      original.tracks[0].clips.push(createTextClip(original, { id: 'original-text', text: '保留正文字幕', trimOut: 3, fontSize: 14 }))
      const current = shallowRef(original)
      const fixture = window.segmentFixture = { current, changes: [], prepared: [], nextTick }
      fixture.app = createApp({ render: () => h(Editor, { project: current.value,
        onChange: next => { fixture.changes.push(next); current.value = next },
        onPreparedAsset: (asset, blob) => fixture.prepared.push({ id: asset.id, size: blob.size }),
      }) })
      fixture.app.mount('#app')
      await nextTick()
    })
    const state = () => page.evaluate(() => JSON.parse(JSON.stringify(window.segmentFixture.current.value)))
    const introOpener = page.getByTestId('video-segment-intro-open'), outroOpener = page.getByTestId('video-segment-outro-open')
    assert.equal(await introOpener.evaluate(element => element.previousElementSibling?.getAttribute('data-testid')), 'background-music-open')
    assert.equal(await outroOpener.evaluate(element => element.previousElementSibling?.getAttribute('data-testid')), 'video-segment-intro-open')
    const templateIds = await page.evaluate(async () => {
      const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
      return { prepend: VIDEO_SEGMENTS.filter(item => item.placement === 'prepend').map(item => item.id), append: VIDEO_SEGMENTS.filter(item => item.placement === 'append').map(item => item.id) }
    })
    assert(templateIds.prepend.length > 0 && templateIds.append.length > 0)
    await introOpener.click()
    await expect(page.getByRole('dialog', { name: '片头', exact: true })).toBeVisible()
    await expect(page.getByTestId('video-segment-item')).toHaveCount(templateIds.prepend.length)
    assert.deepEqual(await page.getByTestId('video-segment-item').evaluateAll(items => items.map(item => item.dataset.segmentId)), templateIds.prepend)
    await expect(page.getByTestId('video-segment-library').getByRole('radio')).toHaveCount(0)
    await expect(page.getByTestId('video-segment-add')).toHaveText('添加到项目开头')
    await page.getByTestId('video-segment-preview').click()
    await expect.poll(() => page.locator('.segment-preview video').evaluate(video => video.currentTime > .05 && !video.paused)).toBe(true)
    assert.equal((await state()).assets.length, 1, '预览不能添加素材')
    await page.getByTestId('video-segment-heading').fill('定制开场')
    await page.getByTestId('video-segment-subheading').fill('这是可继续编辑的标题')
    await page.screenshot({ path: path.join(artifacts, 'library.png') })
    await page.evaluate(() => { window.segmentPreview = document.querySelector('.segment-preview video') })
    await page.getByTestId('video-segment-add').click()
    await expect(page.getByTestId('video-segment-library')).not.toBeVisible()
    let project = await state()
    assert.equal(project.assets.length, 2)
    assert.equal(project.width, 320); assert.equal(project.height, 180)
    assert.equal(project.tracks.flatMap(track => track.clips).find(clip => clip.id === 'original-video-clip').start, 5)
    assert.equal(project.tracks.flatMap(track => track.clips).find(clip => clip.id === 'original-text').start, 5)
    assert(project.tracks.flatMap(track => track.clips).some(clip => clip.text === '定制开场'))
    assert(await page.evaluate(() => window.segmentPreview.paused && !window.segmentPreview.getAttribute('src')), '关闭库后释放预览')
    assert.equal(await page.evaluate(() => window.segmentFixture.changes.length), 1)
    console.log('PASS 背景音乐后依次提供片头、片尾入口；片头仅自身模板、真实预览、可编辑标题、固定前插并同步后移')

    await outroOpener.click()
    await expect(page.getByRole('dialog', { name: '片尾', exact: true })).toBeVisible()
    await expect(page.getByTestId('video-segment-item')).toHaveCount(templateIds.append.length)
    assert.deepEqual(await page.getByTestId('video-segment-item').evaluateAll(items => items.map(item => item.dataset.segmentId)), templateIds.append)
    await expect(page.getByTestId('video-segment-library').getByRole('radio')).toHaveCount(0)
    await page.locator('[data-segment-id="starlit-finale"]').click()
    await expect(page.getByTestId('video-segment-add')).toHaveText('添加到项目结尾')
    await page.screenshot({ path: path.join(artifacts, 'outro-library.png') })
    await page.getByTestId('video-segment-add').click()
    await expect(page.getByTestId('video-segment-library')).not.toBeVisible()
    project = await state()
    assert.equal(project.assets.length, 3)
    const videoTrack = project.tracks.find(track => track.kind === 'video')
    assert.deepEqual(videoTrack.clips.map(clip => clip.start).sort((a, b) => a - b), [0, 5, 10])
    assert.equal(await page.evaluate(() => window.segmentFixture.changes.length), 2)

    await outroOpener.click()
    const local = path.resolve('src/assets/video-segments/paper-morning.webm')
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByTestId('video-segment-import-local').click()
    const chooser = await chooserPromise
    await chooser.setFiles(local)
    await expect(page.getByTestId('video-segment-library')).not.toBeVisible()
    project = await state()
    assert.equal(project.assets.length, 4)
    const imported = project.assets.find(asset => asset.name === 'paper-morning.webm')
    assert(imported)
    assert.equal(project.tracks.flatMap(track => track.clips).find(clip => clip.assetId === imported.id).start, 15)
    assert.equal(project.tracks.flatMap(track => track.clips).filter(clip => clip.text).length, 5, '本地视频不能误带模板标题')
    console.log('PASS 片尾模板不混入片头，固定追加项目结尾，本地视频同向追加且不附带模板标题')

    // Render a real short output, then decode it independently to verify the videos are usable media.
    const output = await page.evaluate(async () => {
      const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
      const { insertVideoSegment } = await import('/src/core/video-segment-track.ts')
      const { createProject } = await import('/src/core/project.ts')
      const { VIDEO_SEGMENT_PRESETS } = await import('/src/core/video-segment-presets.ts')
      const asset = window.segmentFixture.current.value.assets.find(asset => asset.name.includes('星轨序章'))
      window.segmentFixture.app.unmount()
      await window.segmentFixture.nextTick()
      const project = insertVideoSegment(createProject('真实片头导出', { width: 320, height: 180, fps: 20 }), asset, 'prepend', VIDEO_SEGMENT_PRESETS[0]).project
      const file = await exportTimelineWebM(project, { fps: 20, videoBitsPerSecond: 800000 })
      return [...new Uint8Array(await file.arrayBuffer())]
    })
    const outputPath = path.join(artifacts, 'opening-export.webm')
    writeFileSync(outputPath, Buffer.from(output))
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-count_frames', '-of', 'json', outputPath], { encoding: 'utf8' }))
    const video = info.streams.find(stream => stream.codec_type === 'video')
    assert.equal(video.width, 320); assert.equal(video.height, 180)
    // Live browser capture may coalesce frames under load; duration and decoded
    // title pixels verify the actual output independently of capture cadence.
    assert(Number(video.nb_read_frames) >= 60)
    const timestamps = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', outputPath], { encoding: 'utf8' }).trim().split('\n').map(Number)
    assert(timestamps.at(-1) >= 4.8)
    const decoded = execFileSync('ffmpeg', ['-v', 'error', '-ss', '2', '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1e6 })
    assert.equal(decoded.length, 320 * 180 * 3)
    let titlePixels = 0
    for (let y = 60; y < 125; y++) for (let x = 32; x < 288; x++) {
      const offset = (y * 320 + x) * 3
      if (decoded[offset] > 180 && decoded[offset + 1] > 180) titlePixels++
    }
    assert(titlePixels > 70, '独立可编辑标题应真实出现在输出画面中，而不只是素材库预览')
    assert.deepEqual(errors, [])
    console.log('PASS 真实片头和独立文字导出为可解码的5秒视频')
  } catch (error) {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
    throw error
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
