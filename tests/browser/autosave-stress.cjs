const assert = require('node:assert/strict')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

// Development server only. Real encoded media and IndexedDB; no native bridge simulation.
const root = process.env.AUTOSAVE_TEST_ROOT || path.resolve(__dirname, '../..')
const baseline = process.env.AUTOSAVE_BASELINE === '1'
const oneVideo = process.env.AUTOSAVE_SCENARIO === 'one-video' || process.argv.includes('--one-video')
const runName = `${baseline ? 'baseline' : 'fixed'}${oneVideo ? '-one-video' : ''}`
const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'autosave-stress') : '/tmp/open-media-autosave-stress'
const report = { source: root, baseline, scenario: oneVideo ? 'one-video-70-clips' : '60-media-assets', environment: 'Chromium browser; not an installed desktop application', phases: {} }

function fixtures() {
  mkdirSync(artifacts, { recursive: true })
  const videoPath = path.join(artifacts, oneVideo ? 'one-video-3024-30fps.webm' : 'encoded.webm')
  if (!existsSync(videoPath)) execFileSync('ffmpeg', oneVideo
    ? ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=756x474:rate=30', '-vf', 'scale=3024:1896:flags=neighbor', '-t', '72', '-c:v', 'libvpx', '-b:v', '6M', '-threads', '2', '-deadline', 'realtime', '-cpu-used', '8', '-an', '-y', videoPath]
    : ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '4', '-c:v', 'libvpx', '-b:v', '4M', '-deadline', 'realtime', '-cpu-used', '8', '-an', '-y', videoPath])
  const rate = 48000, samples = rate * 4, audio = Buffer.alloc(44 + samples * 2)
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(rate, 24); audio.writeUInt32LE(rate * 2, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34)
  audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) audio.writeInt16LE(Math.round(Math.sin(i / rate * 440 * Math.PI * 2) * 1200), 44 + i * 2)
  return { video: readFileSync(videoPath), audio }
}

async function installInstrumentation(page) {
  await page.addInitScript(() => {
    const state = window.autosaveStress = { mode: 'ready', paused: false, hold: false, holdAborts: false, completions: [], failures: [], counters: {}, previousTick: performance.now() }
    state.media = []
    state.ignoredTransactions = new WeakSet()
    const createElement = document.createElement.bind(document)
    document.createElement = function (...args) { const element = createElement(...args); if (element instanceof HTMLMediaElement) state.media.push(element); return element }
    state.reset = () => { state.counters = { blobGets: 0, blobGetBytes: 0, blobKeys: 0, blobPuts: 0, blobPutBytes: 0, projectPuts: 0, completed: 0, aborted: 0, fetches: 0, heartbeats: 0, maxHeartbeatGapMs: 0, longTasks: [], titles: [] }; state.previousTick = performance.now() }
    state.reset()
    setInterval(() => { const now = performance.now(); state.counters.heartbeats++; state.counters.maxHeartbeatGapMs = Math.max(state.counters.maxHeartbeatGapMs, now - state.previousTick); state.previousTick = now }, 25)
    new PerformanceObserver(list => { for (const entry of list.getEntries()) state.counters.longTasks.push(Math.round(entry.duration)) }).observe({ type: 'longtask', buffered: false })
    const originalGet = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function (...args) {
      const measure = !state.ignoredTransactions.has(this.transaction) && this.name === 'blobs', counters = state.counters
      if (measure) counters.blobGets++
      const request = originalGet.apply(this, args)
      if (measure) request.addEventListener('success', () => { counters.blobGetBytes += request.result instanceof Blob ? request.result.size : 0 })
      return request
    }
    const originalKey = IDBObjectStore.prototype.getKey
    IDBObjectStore.prototype.getKey = function (...args) { if (!state.ignoredTransactions.has(this.transaction) && this.name === 'blobs') state.counters.blobKeys++; return originalKey.apply(this, args) }
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (!state.ignoredTransactions.has(this.transaction)) {
        if (this.name === 'blobs') { state.counters.blobPuts++; state.counters.blobPutBytes += args[0]?.size || 0 }
        if (this.name === 'projects') {
          state.counters.projectPuts++; state.counters.titles.push(args[0].title)
          if (state.mode === 'quota') { state.mode = 'ready'; throw new DOMException('测试：草稿存储配额不足', 'QuotaExceededError') }
          if (state.mode === 'abort') { state.mode = 'ready'; const request = originalPut.apply(this, args); this.transaction.abort(); return request }
        }
      }
      return originalPut.apply(this, args)
    }
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      const value = transaction.apply(this, args)
      if (state.paused) state.ignoredTransactions.add(value)
      if (!state.paused && value.mode === 'readwrite' && value.objectStoreNames.contains('projects')) {
        const counters = state.counters
        value.addEventListener('complete', () => counters.completed++)
        value.addEventListener('abort', () => counters.aborted++)
      }
      return value
    }
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...complete, set(handler) {
      complete.set.call(this, typeof handler === 'function' ? function (event) {
        if (state.hold && this.mode === 'readwrite' && this.objectStoreNames.contains('projects')) state.completions.push(() => handler.call(this, event))
        else handler.call(this, event)
      } : handler)
    } })
    const abort = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'onabort')
    Object.defineProperty(IDBTransaction.prototype, 'onabort', { ...abort, set(handler) {
      abort.set.call(this, typeof handler === 'function' ? function (event) {
        if (state.holdAborts && this.mode === 'readwrite' && this.objectStoreNames.contains('projects')) state.failures.push(() => handler.call(this, event))
        else handler.call(this, event)
      } : handler)
    } })
    const originalFetch = window.fetch
    window.fetch = function (...args) { if (!state.paused && String(args[0]).startsWith('blob:')) state.counters.fetches++; return originalFetch.apply(this, args) }
  })
}

async function seed(page) {
  return page.evaluate(async () => {
    const { createProject, createTrack, createClip, createTextClip } = await import('/src/core/project.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const { saveProject } = await import('/src/core/storage.ts')
    const video = await (await fetch('/autosave-fixture.webm')).blob(), audio = await (await fetch('/autosave-fixture.wav')).blob()
    const project = createProject('六十素材草稿压力测试', { width: 640, height: 360, fps: 24 })
    project.tracks = [createTrack('text', '字幕'), createTrack('video', '主视频'), createTrack('video', '后段视频'), createTrack('audio', '配音')]
    const blobs = new Map()
    for (let i = 0; i < 60; i++) {
      const isVideo = i < 40, file = new File([isVideo ? video : audio], `真实素材-${i + 1}.${isVideo ? 'webm' : 'wav'}`, { type: isVideo ? 'video/webm' : 'audio/wav' })
      const asset = await importMediaFile(file)
      project.assets.push(asset); blobs.set(asset.id, file)
      const track = isVideo ? project.tracks[i < 30 ? 1 : 2] : project.tracks[3]
      track.clips.push(createClip(asset, project, { start: isVideo ? i * 4 : (i - 40) * 4, trimOut: 4 }))
    }
    project.tracks[0].clips.push(createTextClip(project, { text: '自动保存与连续预览', start: 0, trimOut: 160, fontSize: 24 }))
    await saveProject(project, blobs)
    localStorage.setItem('open-media:last-project', project.id)
    localStorage.setItem('open-media:autosave', 'true')
    project.assets.forEach(asset => URL.revokeObjectURL(asset.url))
    return { id: project.id, assets: project.assets.length, clips: project.tracks.flatMap(track => track.clips).length, bytes: [...blobs.values()].reduce((sum, blob) => sum + blob.size, 0), firstClip: project.tracks[1].clips[0].id, secondClip: project.tracks[1].clips[1].id, audioClip: project.tracks[3].clips[0].id }
  })
}

async function rawDraft(page, integrity = false) {
  return page.evaluate(async integrity => {
    const state = window.autosaveStress
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open('open-media-projects', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try {
      state.paused = true
      const transaction = database.transaction(['projects', 'blobs'], 'readonly')
      state.paused = false
      const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) })
      const project = await request(transaction.objectStore('projects').get(localStorage.getItem('open-media:last-project')))
      const blobs = integrity ? await Promise.all(project.assets.map(asset => request(transaction.objectStore('blobs').get(`${project.id}:${asset.id}`)))) : []
      const hashes = await Promise.all(blobs.map(async blob => ({ size: blob.size, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('') })))
      return { title: project.title, savedAt: project.localDraftSavedAt, assets: project.assets.length, clips: project.tracks.flatMap(track => track.clips).length, hashes }
    } finally { database.close(); state.paused = false }
  }, integrity)
}

async function rename(page, title) {
  await page.locator('.project-title').click()
  await page.getByLabel('项目名称', { exact: true }).fill(title)
  await page.getByLabel('项目名称', { exact: true }).press('Enter')
  await expect(page.locator('.project-title')).toHaveText(title)
}

async function selectAndSeek(page, fixture, count = 6) {
  const times = []
  for (let i = 0; i < count; i++) {
    const begin = Date.now(), clip = page.locator(`[data-clip-id="${i % 2 ? fixture.secondClip : fixture.firstClip}"]`)
    await clip.click({ position: { x: 12, y: 18 } })
    await expect(clip).toHaveClass(/selected/)
    await page.locator('.timeline-ruler').click({ position: { x: 8 + (i % 3) * 24, y: 12 } })
    times.push(Date.now() - begin)
  }
  return times
}

async function startPlayback(page) {
  const begin = Date.now()
  const button = page.getByTestId('preview-play')
  if (!(await button.getAttribute('title')).startsWith('暂停')) await button.click()
  await expect(button).toHaveAttribute('title', /暂停/, { timeout: oneVideo ? 30000 : 5000 })
  const first = await page.locator('.time-code').innerText()
  await expect.poll(() => page.locator('.time-code').innerText()).not.toBe(first)
  return Date.now() - begin
}

async function reset(page) { await page.evaluate(() => window.autosaveStress.reset()) }
async function stats(page) { return page.evaluate(() => {
  const state = window.autosaveStress, active = state.media.filter(media => media.getAttribute('src'))
  return { ...state.counters, media: { created: state.media.length, attachedSources: active.filter(media => media.isConnected).length, detachedSources: active.filter(media => !media.isConnected).length, detachedAutoSources: active.filter(media => !media.isConnected && media.preload === 'auto').length, ready: active.filter(media => media.readyState >= 2).length } }
}) }
async function saved(page, title) {
  await expect.poll(async () => { try { return (await rawDraft(page)).title } catch { return '' } }, { timeout: 20000 }).toBe(title)
  await expect(page.locator('.statusbar')).toContainText('本地草稿已保存')
}

async function oneVideoChecks(page, bytes) {
  page.setDefaultTimeout(30000)
  const fixture = report.fixture = await page.evaluate(async () => {
    const { createProject, createClip, createTextClip } = await import('/src/core/project.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const { addTransition } = await import('/src/core/transitions.ts')
    const { exportProjectFile } = await import('/src/core/project-file.ts')
    const blob = await (await fetch('/autosave-fixture.webm')).blob()
    const file = new File([blob], '高分辨率录屏.webm', { type: 'video/webm' })
    const asset = await importMediaFile(file)
    let project = createProject('单视频文字与转场项目', { width: 3024, height: 1896, fps: 30 })
    project.assets.push(asset)
    const video = project.tracks.find(track => track.kind === 'video'), text = project.tracks.find(track => track.kind === 'text')
    for (let i = 0; i < 16; i++) {
      const start = i * 4.4, end = i === 15 ? 70.3 : (i + 1) * 4.4
      video.clips.push(createClip(asset, project, { start, trimIn: start, trimOut: end }))
    }
    for (let i = 0; i < 46; i++) text.clips.push(createTextClip(project, { start: i * 1.5, trimOut: 1.8, text: `第 ${i + 1} 段字幕：真实高分辨率视频与转场连续预览`, fontSize: 88, width: 2600, x: 180, y: 1500, height: 220 }))
    const effects = ['fade', 'defocus', 'close-vertical', 'slide-left', 'zoom-fade', 'flash-white', 'iris', 'zoom-through']
    for (let i = 0; i < effects.length; i++) project = addTransition(project, (i + 1) * 4.4, effects[i], 1, video.id, { blur: 16 })
    const archive = await exportProjectFile(project, { blobs: new Map([[asset.id, file]]) })
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('one-video.omedia', { create: true })
    const writer = await handle.createWritable(); await writer.write(archive); await writer.close()
    window.showOpenFilePicker = async () => [handle]
    URL.revokeObjectURL(asset.url)
    return { id: project.id, assets: 1, clips: 70, videoSegments: 16, texts: 46, transitions: 8, duration: 70.3, width: 3024, height: 1896, fps: 30, sourceDuration: asset.duration, bytes: file.size, archiveBytes: archive.size,
      firstClip: video.clips[0].id, secondClip: video.clips[1].id, textClip: text.clips[6].id, transitionClip: project.tracks.find(track => track.kind === 'transition').clips[1].id }
  })
  const downloadPending = page.waitForEvent('download')
  await page.evaluate(async () => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle('one-video.omedia')).getFile()
    const url = URL.createObjectURL(file), link = document.createElement('a')
    link.href = url; link.download = 'one-video-70-clips.omedia'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
  const archivePath = path.join(artifacts, `${runName}.omedia`)
  await (await downloadPending).saveAs(archivePath)
  report.portableProject = archivePath
  await page.locator('.home-actions').getByRole('button', { name: '打开项目', exact: true }).click()
  await expect(page.locator('.project-title')).toHaveText('单视频文字与转场项目', { timeout: 30000 })
  await expect(page.locator('.timeline-clip')).toHaveCount(70)
  await expect(page.getByTestId('autosave-toggle')).toHaveAttribute('aria-checked', 'true')
  await page.getByLabel('时间线缩放', { exact: true }).fill('12')
  await page.getByLabel('时间线缩放', { exact: true }).dispatchEvent('input')
  await saved(page, '单视频文字与转场项目')
  const original = await rawDraft(page, true)
  assert.deepEqual(original.hashes, [{ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }])
  await reset(page)
  await rename(page, '高分辨率播放期间自动保存')
  report.playbackStartupMs = await startPlayback(page)
  const playedAt = Date.now(), samples = []
  for (let i = 0; i < 5; i++) {
    const previous = await page.locator('.time-code').innerText()
    await page.waitForTimeout(8200)
    const current = await page.locator('.time-code').innerText()
    assert.notEqual(current, previous, '持续播放不得在十秒附近停住')
    await expect(page.getByTestId('preview-play')).toHaveAttribute('title', /暂停/)
    samples.push({ elapsedMs: Date.now() - playedAt, timeCode: current, ...await stats(page) })
    console.log(`MEASURE ${runName} playback ${i + 1}/5`, JSON.stringify({ elapsedMs: Date.now() - playedAt, timeCode: current, media: samples.at(-1).media }))
  }
  await saved(page, '高分辨率播放期间自动保存')
  report.phases.continuousPlayback = { wallMs: Date.now() - playedAt, samples, ...await stats(page) }
  if (!baseline) {
    assert.equal(report.phases.continuousPlayback.blobGets, 0)
    assert.equal(report.phases.continuousPlayback.blobPuts, 0)
    assert(report.phases.continuousPlayback.media.detachedAutoSources <= 5)
  }
  await reset(page)
  const selectionMs = await selectAndSeek(page, fixture, 12)
  for (const id of [fixture.textClip, fixture.transitionClip, fixture.firstClip]) {
    const begin = Date.now(), clip = page.locator(`[data-clip-id="${id}"]`)
    await clip.click({ position: { x: 8, y: 18 } }); await expect(clip).toHaveClass(/selected/)
    selectionMs.push(Date.now() - begin)
  }
  await page.waitForTimeout(3300)
  report.phases.afterPlaybackSelection = { ...await stats(page), selectionMs }
  assert.equal(report.phases.afterPlaybackSelection.projectPuts, 0)
  assert(Math.max(...selectionMs) < 3000, '播放后点击视频、文字与转场轨道应保持响应')
  await page.screenshot({ path: path.join(artifacts, `${runName}-selection.png`) })
  await page.evaluate(() => { window.autosaveStress.mode = 'quota' })
  await rename(page, '单视频草稿失败后保留的修改')
  await expect(page.locator('.statusbar')).toContainText('草稿保存失败', { timeout: 15000 })
  const failure = await rawDraft(page, true)
  assert.equal(failure.title, '高分辨率播放期间自动保存')
  assert.deepEqual(failure.hashes, original.hashes)
  await selectAndSeek(page, fixture)
  await page.screenshot({ path: path.join(artifacts, `${runName}-quota-failure.png`) })
  await page.locator('.statusbar button').filter({ hasText: '草稿保存失败' }).click()
  await saved(page, '单视频草稿失败后保留的修改')
  assert.deepEqual((await rawDraft(page, true)).hashes, original.hashes)
  report.phases.recovered = await stats(page)
  await page.reload(); await page.getByTestId('nav-edit').click()
  await expect(page.locator('.timeline-clip')).toHaveCount(70)
  await expect(page.locator('.project-title')).toHaveText('单视频草稿失败后保留的修改')
  await startPlayback(page)
  console.log('PASS 单视频3024×1896/30fps项目：16视频片段+46文字+8转场；便携项目实际打开，连续播放41秒与自动保存、后续轨道选择/跳转、配额失败恢复和媒体哈希完整')
}

async function main() {
  const fixtureBytes = fixtures(), { createServer } = await import('vite')
  const server = await createServer({ root, cacheDir: process.env.AUTOSAVE_VITE_CACHE || '/tmp/open-media-autosave-repro-vite', server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false } })
  let browser, page
  try {
    await server.listen()
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await installInstrumentation(page)
    await page.route('**/autosave-fixture.webm', route => route.fulfill({ contentType: 'video/webm', body: fixtureBytes.video }))
    await page.route('**/autosave-fixture.wav', route => route.fulfill({ contentType: 'audio/wav', body: fixtureBytes.audio }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    await expect(page.getByTestId('home-workspace')).toBeVisible()
    if (oneVideo) { await oneVideoChecks(page, fixtureBytes.video); assert.deepEqual(errors, []); report.passed = true; return }
    const fixture = report.fixture = await seed(page)
    await page.reload(); await page.getByTestId('nav-edit').click()
    await expect(page.locator('.asset-card')).toHaveCount(60)
    await expect(page.locator('.timeline-clip')).toHaveCount(61)
    await expect(page.getByTestId('autosave-toggle')).toHaveAttribute('aria-checked', 'true')
    await page.getByLabel('时间线缩放', { exact: true }).fill('6')
    await page.getByLabel('时间线缩放', { exact: true }).dispatchEvent('input')
    const original = await rawDraft(page, true)
    assert.equal(original.hashes.length, 60)
    const expectedMedia = [fixtureBytes.video, fixtureBytes.audio].map(bytes => ({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))
    assert.deepEqual(original.hashes, Array.from({ length: 60 }, (_, index) => expectedMedia[index < 40 ? 0 : 1]), '首次保存的所有媒体字节必须与真实编码输入一致')
    await reset(page)
    await startPlayback(page); await page.waitForTimeout(900)
    const selectionMs = await selectAndSeek(page, fixture, 8)
    await page.waitForTimeout(3300)
    report.phases.selectionOnly = { ...await stats(page), selectionMs }
    assert.equal(report.phases.selectionOnly.projectPuts, 0, '播放、选择与跳转本身不能写入草稿')
    if (!baseline) assert(report.phases.selectionOnly.media.detachedAutoSources <= 8, '60 个片段的预览仅应保留当前及相邻媒体解码器')
    console.log('PASS 60 份真实媒体、61 个片段播放后选择与跳转；纯选择不触发草稿保存')

    await reset(page)
    await rename(page, '媒体保持不变的项目改名')
    await startPlayback(page)
    const duringSaveMs = await selectAndSeek(page, fixture)
    await saved(page, '媒体保持不变的项目改名')
    report.phases.metadataSave = { ...await stats(page), selectionMs: duringSaveMs }
    console.log('MEASURE metadataSave', JSON.stringify(report.phases.metadataSave))
    if (!baseline) {
      assert.equal(report.phases.metadataSave.blobGets, 0, '已有媒体的元数据保存不应读取 Blob')
      assert.equal(report.phases.metadataSave.blobPuts, 0, '已有媒体的元数据保存不应重写 Blob')
    }

    for (const mode of ['quota', 'abort']) {
      const before = await rawDraft(page, true)
      const visibleTime = await page.getByTestId('last-save-time').getAttribute('datetime')
      await reset(page); await page.evaluate(mode => { window.autosaveStress.mode = mode }, mode)
      await rename(page, `${mode}失败后保留的最新编辑`)
      await startPlayback(page)
      await expect(page.locator('.statusbar')).toContainText('草稿保存失败', { timeout: 15000 })
      await expect(page.getByTestId('last-save-time')).toHaveAttribute('datetime', visibleTime)
      const failed = await rawDraft(page, true)
      assert.deepEqual(failed, before, '草稿事务失败后，原始项目、媒体校验值和保存时间必须完整保留')
      const responseMs = await selectAndSeek(page, fixture)
      report.phases[`${mode}Failure`] = { ...await stats(page), selectionMs: responseMs }
      assert(Math.max(...responseMs) < 2500, '保存失败后轨道选择与跳转仍须响应')
      await page.screenshot({ path: path.join(artifacts, `${baseline ? 'baseline' : 'fixed'}-${mode}-failure.png`) })
      await page.locator('.statusbar button').filter({ hasText: '草稿保存失败' }).click()
      await saved(page, `${mode}失败后保留的最新编辑`)
      const recovered = await rawDraft(page, true)
      assert.deepEqual(recovered.hashes, original.hashes, '重试后所有真实媒体字节保持完整')
      assert.equal(recovered.clips, 61)
      console.log(`PASS ${mode} 事务失败显示错误，旧草稿与 60 份媒体无损，选择/跳转响应，点击重试恢复`)
    }

    await reset(page); await page.evaluate(() => { window.autosaveStress.hold = true })
    await rename(page, '保存中的旧版本')
    await expect.poll(() => page.evaluate(() => window.autosaveStress.completions.length)).toBe(1)
    await rename(page, '保存等待期间中间版本一'); await page.waitForTimeout(3300)
    await rename(page, '保存等待期间中间版本二'); await page.waitForTimeout(3300)
    await rename(page, '保存等待期间最终版本'); await page.waitForTimeout(3300)
    const inflightMs = await selectAndSeek(page, fixture)
    await page.evaluate(() => { const state = window.autosaveStress; state.hold = false; state.completions.splice(0).forEach(complete => complete()) })
    await saved(page, '保存等待期间最终版本')
    await page.waitForTimeout(350)
    report.phases.inflightEdits = { ...await stats(page), selectionMs: inflightMs }
    console.log('MEASURE inflightEdits', JSON.stringify(report.phases.inflightEdits))
    if (!baseline) assert(report.phases.inflightEdits.projectPuts <= 2, '保存期间的连续修改应只写最早在途版本和最新版本')
    assert.deepEqual((await rawDraft(page, true)).hashes, original.hashes)

    await reset(page)
    await page.evaluate(() => { const state = window.autosaveStress; state.mode = 'abort'; state.holdAborts = true })
    await rename(page, '旧版本延迟报告失败')
    await expect.poll(() => page.evaluate(() => window.autosaveStress.failures.length)).toBe(1)
    await rename(page, '旧版本失败后的最终修改')
    await page.waitForTimeout(3500)
    await page.evaluate(() => { const state = window.autosaveStress; state.holdAborts = false; state.failures.splice(0).forEach(fail => fail()) })
    await saved(page, '旧版本失败后的最终修改')
    report.phases.staleFailure = await stats(page)
    assert.equal(report.phases.staleFailure.aborted, 1)
    assert.equal(report.phases.staleFailure.completed, 1)
    assert.deepEqual((await rawDraft(page, true)).hashes, original.hashes)
    console.log('PASS 旧版本延迟失败不会覆盖后续保存状态，最新修改与全部媒体完整落盘')
    await page.reload(); await page.getByTestId('nav-edit').click()
    await expect(page.locator('.project-title')).toHaveText('旧版本失败后的最终修改')
    await expect(page.locator('.asset-card')).toHaveCount(60)
    await startPlayback(page)
    await expect.poll(() => page.getByTestId('video-preview').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let colorful = 0
      for (let i = 0; i < data.length; i += 64) if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 80) colorful++
      return colorful
    })).toBeGreaterThan(100)
    await page.screenshot({ path: path.join(artifacts, `${baseline ? 'baseline' : 'fixed'}-recovered.png`) })
    assert.deepEqual(errors, [])
    report.passed = true
    console.log('PASS 保存期间的后续编辑最终落盘，重载仍有 60 素材/61 片段并实际解码彩色视频画面')
  } catch (error) {
    report.passed = false; report.error = error.stack || String(error)
    if (page) { report.finalCounters = await stats(page).catch(() => ({})); await page.screenshot({ path: path.join(artifacts, `${runName}-unexpected-failure.png`) }).catch(() => {}) }
    throw error
  } finally {
    const reportPath = path.join(artifacts, `${runName}-report.json`)
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`REPORT ${reportPath}`)
    await browser?.close(); await server.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
