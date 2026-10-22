const assert = require('node:assert/strict')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'background-music') : '/tmp/open-media-background-music'
const dialog = page => page.getByRole('dialog', { name: '背景音乐', exact: true })
const musicTracks = project => project.tracks.filter(track => track.name === '背景音乐轨道')

function wavFixture() {
  const sampleRate = 16000, length = sampleRate * 1.25
  const bytes = Buffer.alloc(44 + length * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(length * 2, 40)
  for (let i = 0; i < length; i++) bytes.writeInt16LE(Math.round(Math.sin(i / sampleRate * 440 * Math.PI * 2) * 1200), 44 + i * 2)
  return bytes
}

async function installProject(page, url) {
  await page.addInitScript(() => {
    window.backgroundMusicAuditions = []
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (...args) {
      if (!window.backgroundMusicAuditions.includes(this)) window.backgroundMusicAuditions.push(this)
      return play.apply(this, args)
    }
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('background-music.omedia', { create: true })
  })
  await page.goto(url)
  await expect(page.getByTestId('home-workspace')).toBeVisible()
  await page.evaluate(async () => {
    const { createProject, createTextClip } = await import('/src/core/project.ts')
    const { saveProject } = await import('/src/core/storage.ts')
    const project = createProject('背景音乐完整流程', { width: 640, height: 360, fps: 20 })
    project.tracks.find(track => track.kind === 'text').clips.push(createTextClip(project, { id: 'original-subtitle', text: '保留原有字幕与音频轨道', start: 0, trimOut: 12, fontSize: 25 }))
    await saveProject(project)
    localStorage.setItem('open-media:last-project', project.id)
    localStorage.setItem('open-media:autosave', 'true')
  })
  await page.reload()
  await page.getByTestId('nav-edit').click()
  await expect(page.locator('.timeline-clip[data-clip-id="original-subtitle"]')).toBeVisible()
}

async function projectState(page, count) {
  const read = () => page.evaluate(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    const loaded = await loadProject(localStorage.getItem('open-media:last-project'))
    try { return loaded.project } finally { loaded.revoke() }
  })
  if (count !== undefined) await expect.poll(async () => (await read()).assets.length, { timeout: 20000 }).toBe(count)
  return read()
}

async function seek(page, time) {
  await page.locator('.timeline-scroll').evaluate((element, x) => { element.scrollLeft = Math.max(0, x - 400) }, time * 44)
  const ruler = await page.locator('.timeline-ruler').boundingBox()
  await page.mouse.click(ruler.x + time * 44, ruler.y + 8)
}

async function catalogChecks(page) {
  const items = await page.evaluate(async () => {
    const { BACKGROUND_MUSIC } = await import('/src/core/background-music-catalog.ts')
    const context = new AudioContext()
    const result = []
    try {
      for (const item of BACKGROUND_MUSIC) {
        const response = await fetch(item.url)
        if (!response.ok) throw new Error(`内置配乐无法读取：${item.title}`)
        const bytes = await response.arrayBuffer()
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
        const audio = await context.decodeAudioData(bytes.slice(0))
        let peak = 0
        for (const value of audio.getChannelData(0)) peak = Math.max(peak, Math.abs(value))
        result.push({ ...item, bytes: bytes.byteLength, digest, decodedDuration: audio.duration, channels: audio.numberOfChannels, peak })
      }
    } finally { await context.close() }
    return result
  })
  assert.equal(items.length, 10)
  assert.equal(new Set(items.map(item => item.id)).size, 10)
  assert.equal(new Set(items.map(item => item.digest)).size, 10, '十首内置配乐必须是不同音频文件')
  assert.equal(new Set(items.map(item => item.style)).size, 10, '十首配乐应标注不同风格')
  for (const item of items) {
    assert(item.bytes > 10000 && item.peak > 0.01, `${item.title} 必须是真实有声音乐`)
    assert(item.decodedDuration > 5)
    assert(Math.abs(item.duration - item.decodedDuration) < 0.15, `${item.title} 时长标注应对应实际音频`)
  }
  console.log('PASS 10 首本地配乐全部实际解码，独立文件、风格标注、非静音与时长一致')
  return items
}

async function galleryChecks(page, items) {
  const opener = page.getByTestId('background-music-open')
  const toolbar = await opener.evaluate(element => ({ text: element.textContent.trim(), previous: element.previousElementSibling?.getAttribute('data-testid'), svg: element.querySelectorAll('svg').length }))
  assert.equal(toolbar.text, '背景音乐')
  assert.equal(toolbar.previous, 'watermark-open', '背景音乐按钮紧接水印右侧')
  assert.equal(toolbar.svg, 1)
  await opener.click()
  await expect(dialog(page)).toBeVisible()
  await expect(page.getByTestId('background-music-item')).toHaveCount(10)
  await expect(page.getByTestId('background-music-add')).toBeDisabled()
  const before = await projectState(page)
  await page.locator(`[data-music-preview="${items[0].id}"]`).click()
  await expect.poll(() => page.evaluate(() => window.backgroundMusicAuditions.some(audio => !audio.paused && audio.currentTime > 0.05))).toBe(true)
  await page.evaluate(() => { window.lastMusicAudition = window.backgroundMusicAuditions.find(audio => !audio.paused) })
  assert.deepEqual((await projectState(page)).tracks, before.tracks, '试听不能插入片段')
  assert.deepEqual((await projectState(page)).assets, before.assets, '试听不能新增项目素材')
  await page.screenshot({ path: path.join(artifacts, 'background-music-library.png') })
  await page.keyboard.press('Escape')
  await expect(dialog(page)).not.toBeVisible()
  assert(await page.evaluate(() => window.lastMusicAudition.paused && !window.lastMusicAudition.getAttribute('src')), '关闭素材库应停止试听并释放媒体源')
  await expect(opener).toBeFocused()
  console.log('PASS 背景音乐位于水印右侧，10 张卡片可选；真实试听不改项目，关闭后停止并释放音频')
}

async function addBuiltin(page, id) {
  await page.getByTestId('background-music-open').click()
  await page.locator(`[data-music-id="${id}"] .music-choice`).click()
  await expect(page.locator(`[data-testid="background-music-select"][value="${id}"]`)).toBeChecked()
  await expect(page.getByTestId('background-music-add')).toBeEnabled()
  await page.getByTestId('background-music-add').click()
  await expect(dialog(page)).not.toBeVisible()
}

async function insertionChecks(page, items) {
  const original = await projectState(page, 0)
  await seek(page, 2.25)
  await addBuiltin(page, items[0].id)
  const added = await projectState(page, 1), track = musicTracks(added)[0], clip = track?.clips[0]
  assert(track && clip, '选择后应自动创建背景音乐轨道')
  assert.equal(track.kind, 'audio')
  assert.equal(clip.start, 2.25, '添加位置必须保留打开弹窗时的准确刻度')
  const asset = added.assets.find(asset => asset.id === clip.assetId)
  assert.equal(asset.kind, 'audio')
  assert(Math.abs(asset.duration - items[0].decodedDuration) < 0.15)
  assert.equal(clip.trimIn, 0)
  assert(Math.abs(clip.trimOut - asset.duration) < 0.15)
  for (const oldTrack of original.tracks) assert.deepEqual(added.tracks.find(item => item.id === oldTrack.id), oldTrack, '新增背景音乐不得改变原有轨道')
  await expect(page.locator(`.timeline-clip[data-clip-id="${clip.id}"]`)).toHaveClass(/selected/)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  const undone = await projectState(page, 0)
  assert.equal(musicTracks(undone).length, 0)
  assert.deepEqual(undone.tracks, original.tracks)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  const redone = await projectState(page, 1)
  assert.deepEqual(redone.tracks, added.tracks)
  await seek(page, 5.5)
  await addBuiltin(page, items[1].id)
  const second = await projectState(page, 2)
  assert.equal(musicTracks(second).length, 2, '同一时段已有配乐时应新建背景音乐轨道，避免片段遮挡')
  assert.equal(musicTracks(second)[0].clips.length, 1)
  assert.deepEqual(musicTracks(second)[0].clips.find(item => item.id === clip.id), clip, '添加下一首不得挪动或覆盖已有音乐')
  assert.equal(musicTracks(second)[1].clips[0].start, 5.5)
  const afterMusic = Math.max(...musicTracks(second).flatMap(track => track.clips.map(clip => clip.start + (clip.trimOut - clip.trimIn) / clip.speed)))
  await seek(page, afterMusic)
  await addBuiltin(page, items[0].id)
  await expect.poll(async () => musicTracks(await projectState(page)).flatMap(track => track.clips).length).toBe(3)
  const reused = await projectState(page, 2)
  assert.equal(musicTracks(reused).length, 2, '不重叠时应复用已有背景音乐轨道')
  assert.equal(musicTracks(reused)[0].clips.length, 2)
  assert.equal(musicTracks(reused)[0].clips[1].assetId, clip.assetId, '同一内置配乐再次添加应复用素材')
  assert.equal(musicTracks(reused)[0].clips[1].start, afterMusic)
  console.log('PASS 从 2.25 秒精确加入专属音轨，单步撤销/重做完整恢复；重叠时创建音轨，不重叠时复用轨道与素材')
  return reused
}

async function uploadChecks(page) {
  await seek(page, 8.75)
  await page.getByTestId('background-music-open').click()
  const fileInput = page.getByTestId('background-music-file')
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('background-music-import-local').click()
  await (await chooser).setFiles({ name: '损坏音频.wav', mimeType: 'audio/wav', buffer: Buffer.from('invalid audio bytes') })
  await expect(page.getByTestId('background-music-error')).toHaveClass(/error/)
  await expect(page.getByTestId('background-music-import-local')).toBeEnabled()
  assert.equal((await projectState(page)).assets.length, 2, '无效音频不可留下素材或空片段')
  assert.equal(await fileInput.inputValue(), '', '失败后文件输入应清空，允许重选同名文件')
  await fileInput.setInputFiles({ name: '用户自有配乐.wav', mimeType: 'audio/wav', buffer: wavFixture() })
  await expect(dialog(page)).not.toBeVisible()
  const project = await projectState(page, 3)
  const asset = project.assets.find(item => item.name === '用户自有配乐.wav')
  assert(asset)
  assert.equal(asset.kind, 'audio')
  assert.equal(asset.duration, 1.25)
  const clip = musicTracks(project).flatMap(track => track.clips).find(item => item.assetId === asset.id)
  assert.equal(musicTracks(project).length, 3)
  assert.equal(clip.start, 8.75)
  assert.equal(clip.trimOut, 1.25)
  console.log('PASS 支持上传真实 WAV 并加入背景音乐轨道；损坏音频明确报错、不改项目，随后可正常重试')
  return project
}

async function persistenceChecks(page, expected) {
  await page.getByTestId('save-project').click()
  await expect(page.locator('.status-main')).toContainText('项目已保存')
  const archive = Buffer.from(await page.evaluate(async () => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle('background-music.omedia')).getFile()
    return [...new Uint8Array(await file.arrayBuffer())]
  }))
  writeFileSync(path.join(artifacts, 'background-music.omedia'), archive)
  const entries = unzipSync(archive), manifest = JSON.parse(strFromU8(entries['project.json']))
  assert.deepEqual(manifest.project.tracks, expected.tracks)
  for (const asset of expected.assets) assert.equal(entries[`media/${asset.id}`].byteLength, asset.size, '便携项目必须包含真实音频字节')
  const local = expected.assets.find(asset => asset.name === '用户自有配乐.wav')
  assert.deepEqual(Buffer.from(entries[`media/${local.id}`]), wavFixture())
  await page.reload()
  await page.getByTestId('nav-edit').click()
  const restored = await projectState(page, 3)
  assert.deepEqual(restored.tracks, expected.tracks)
  const restoredAudio = await page.evaluate(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    const loaded = await loadProject(localStorage.getItem('open-media:last-project')), audio = new AudioContext()
    try {
      const results = []
      for (const asset of loaded.project.assets) {
        const blob = loaded.blobs.get(asset.id)
        const decoded = await audio.decodeAudioData(await blob.arrayBuffer())
        results.push({ id: asset.id, size: blob.size, duration: decoded.duration })
      }
      return results
    } finally { loaded.revoke(); await audio.close() }
  })
  for (const asset of restored.assets) {
    const audio = restoredAudio.find(item => item.id === asset.id)
    assert.equal(audio.size, asset.size)
    assert(Math.abs(audio.duration - asset.duration) < 0.15)
  }
  await page.screenshot({ path: path.join(artifacts, 'background-music-timeline.png') })
  console.log('PASS 保存便携项目含完整内置及上传音频；重载草稿恢复所有轨道并实际解码全部素材')
}

async function staleImportChecks(page, url, item) {
  await page.route('**/background-music-lifecycle', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}body{font-family:system-ui}</style></head><body><div id="app"></div></body></html>' }))
  const response = await page.request.get(new URL(item.url, url).href), body = await response.body()
  assert.equal(response.status(), 200)
  for (const action of ['switch', 'unmount']) {
    await page.goto(`${url}/background-music-lifecycle`)
    await page.evaluate(async () => {
      const source = await (await fetch('/src/components/VideoEditor.vue')).text()
      const vuePath = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
      const { createApp, h, shallowRef, nextTick } = await import(vuePath)
      const Editor = (await import('/src/components/VideoEditor.vue')).default
      const { createProject } = await import('/src/core/project.ts')
      const current = shallowRef(createProject('异步音乐导入验证'))
      const fixture = window.musicLifecycle = { current, changes: [], prepared: [], busy: false, nextTick,
        switchProject() { current.value = createProject('切换后的项目') },
      }
      fixture.app = createApp({ render: () => h(Editor, { project: current.value,
        onChange: next => { fixture.changes.push(next); current.value = next },
        onPreparedAsset: (asset, blob) => fixture.prepared.push({ id: asset.id, size: blob.size }),
        onBusy: busy => { fixture.busy = busy },
      }) })
      fixture.app.mount('#app'); await nextTick()
    })
    let pending, release
    const pattern = `**${new URL(item.url, url).pathname}`
    await page.route(pattern, route => { pending = route; return new Promise(resolve => { release = resolve }) })
    await page.getByTestId('background-music-open').click()
    await page.locator(`[data-music-id="${item.id}"] .music-choice`).click()
    await page.getByTestId('background-music-add').click()
    await expect.poll(() => Boolean(pending)).toBe(true)
    await expect.poll(() => page.evaluate(() => window.musicLifecycle.busy)).toBe(true)
    await page.evaluate(async action => {
      const fixture = window.musicLifecycle
      if (action === 'switch') fixture.switchProject()
      else fixture.app.unmount()
      await fixture.nextTick()
    }, action)
    await pending.fulfill({ contentType: 'audio/mpeg', body }).catch(() => {})
    release()
    await page.unroute(pattern)
    await expect.poll(() => page.evaluate(() => window.musicLifecycle.busy)).toBe(false)
    const result = await page.evaluate(() => ({ changes: window.musicLifecycle.changes.length, prepared: window.musicLifecycle.prepared.length, assets: window.musicLifecycle.current.value.assets.length }))
    assert.deepEqual(result, { changes: 0, prepared: 0, assets: 0 }, `${action} 后到达的音频不可写入新项目或已卸载编辑器`)
  }
  console.log('PASS 读取配乐期间切换项目或卸载编辑器会取消任务，迟到结果不插入片段、不污染素材且释放忙碌状态')
}

async function main() {
  mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false } })
  await server.listen()
  let browser, context, page
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] })
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    page = await context.newPage(); page.setDefaultTimeout(20000)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    const url = `http://127.0.0.1:${port}`
    await installProject(page, url)
    const items = await catalogChecks(page)
    await galleryChecks(page, items)
    await insertionChecks(page, items)
    await persistenceChecks(page, await uploadChecks(page))
    await staleImportChecks(page, url, items[0])
    assert.deepEqual(errors, [])
  } catch (error) {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
    throw error
  } finally { await context?.close(); await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
