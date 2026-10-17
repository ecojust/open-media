const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs/promises')
const { existsSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

const root = path.resolve(__dirname, '../..')
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5203'
const artifacts = process.env.BROWSER_ARTIFACTS ? path.resolve(process.env.BROWSER_ARTIFACTS) : '/tmp/open-media-workbench'
const results = [], pageErrors = []
let server, browser, page, directory
async function check(name, action) {
  const start = Date.now()
  try { await action(); results.push({ name, passed: true, milliseconds: Date.now() - start }); console.log(`PASS ${name}`) }
  catch (error) { results.push({ name, passed: false, error: error.stack, milliseconds: Date.now() - start }); throw error }
}
async function ensureServer() {
  try {
    const response = await fetch(baseURL)
    if (response.ok && (await response.text()).includes('/@vite/client')) return
    if (response.ok) throw new Error('工作台验证需要开发服务，不使用已有构建。')
  } catch (error) { if (error.message.includes('需要开发服务')) throw error }
  if (process.env.BASE_URL) throw new Error(`工作台服务不可访问：${baseURL}`)
  server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5203', '--strictPort'], { cwd: root, stdio: 'ignore' })
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(baseURL)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('工作台服务启动超时。')
}
async function requestNewProject() {
  await page.locator('.brand').click()
  await page.getByTestId('create-project').click()
}
async function setTheme(theme) {
  await page.getByTestId(`theme-${theme}`).click()
  await expect(page.getByTestId(`theme-${theme}`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.theme-switch [aria-pressed="true"]')).toHaveCount(1)
  assert.equal(await page.evaluate(() => localStorage.getItem('open-media:theme')), theme)
}
async function rename(title) {
  await page.locator('.project-title').click()
  await page.getByLabel('项目名称', { exact: true }).fill(title)
  await page.getByLabel('项目名称', { exact: true }).press('Enter')
  await expect(page.locator('.project-title')).toHaveText(title)
}
async function storedProjects() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('open-media-projects', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => { const db = open.result; const request = db.transaction('projects').objectStore('projects').getAll(); request.onerror = () => reject(request.error); request.onsuccess = () => { resolve(request.result); db.close() } }
  }))
}
async function waitSaved() { await expect(page.locator('.statusbar > button')).toHaveText('本地草稿已保存', { timeout: 20000 }) }
async function readDownload(download) { const file = await download.path(); assert(file); return fs.readFile(file) }

async function main() {
  await ensureServer()
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'open-media-workbench-'))
  await fs.mkdir(artifacts, { recursive: true })
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true })
  // This workbench scenario verifies the download fallback; handle-based saves have separate coverage.
  await context.addInitScript(() => { window.showSaveFilePicker = undefined; window.showOpenFilePicker = undefined })
  page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('dialog', dialog => dialog.accept())
  await page.goto(baseURL)
  await expect(page.getByTestId('home-workspace')).toBeVisible()

  await check('顶部仅保留品牌、主题和信息，保存与自动草稿移入剪辑工作区', async () => {
    await expect(page.locator('.topbar [data-testid="export-project"]')).toHaveCount(0)
    await expect(page.getByTestId('export-project')).toHaveCount(0)
    await page.getByTestId('nav-record').click()
    await expect(page.getByTestId('record-start')).toBeVisible()
    await expect(page.getByTestId('export-project')).toHaveCount(0)
    await page.locator('.brand').click()
    await expect(page.getByTestId('autosave-toggle')).toHaveCount(0)
    await expect(page.locator('.topbar .file-actions')).toHaveCount(0)
    await expect(page.locator('.topbar button:visible')).toHaveCount(5)
    await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveCount(0)
    assert.equal(await page.locator('.topbar button').evaluateAll(elements => elements.every(element => element.querySelector('svg, img'))), true)
    await page.screenshot({ path: path.join(artifacts, 'workbench-light.png') })
    await page.getByTestId('create-project').click()
    await expect(page.getByTestId('video-editor')).toBeVisible()
    await expect(page.locator('.project-bar').getByTestId('autosave-toggle')).toHaveAttribute('aria-checked', 'true')
    assert.equal(await page.getByTestId('autosave-toggle').evaluate(element => element.previousElementSibling?.getAttribute('data-testid')), 'save-project')
    await expect(page.getByTestId('video-editor').getByTestId('export-project')).toBeVisible()
    await expect(page.locator('.topbar [data-testid="export-project"]')).toHaveCount(0)
    await rename('工作台验收')
  })

  await check('三个主题图标平铺并直接切换，信息显示版本和时间并正确恢复焦点', async () => {
    const themeButtons = page.getByRole('group', { name: '界面主题', exact: true }).getByRole('button')
    await expect(themeButtons).toHaveCount(3)
    const positions = await themeButtons.evaluateAll(buttons => buttons.map(button => ({ top: button.getBoundingClientRect().top, left: button.getBoundingClientRect().left, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height, svg: Boolean(button.querySelector('svg')) })))
    assert(positions.every(position => position.top === positions[0].top && position.width === 28 && position.height === 26 && position.svg), `主题按钮布局异常：${JSON.stringify(positions)}`)
    assert(positions[0].left < positions[1].left && positions[1].left < positions[2].left)
    await setTheme('dark')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark')
    await setTheme('light')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'light')
    await setTheme('system')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('theme-system')).toHaveAttribute('title', '跟随系统（当前为深色）')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'light')
    await expect(page.getByTestId('theme-system')).toHaveAttribute('title', '跟随系统（当前为浅色）')
    await page.getByTestId('theme-light').focus()
    await page.keyboard.press('Space')
    await expect(page.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'true')
    await setTheme('system')
    const opener = page.getByRole('button', { name: '关于 Open Media', exact: true })
    await opener.focus()
    await page.keyboard.press('Space')
    const info = page.getByRole('dialog', { name: '关于 Open Media', exact: true })
    await expect(info).toBeVisible()
    const packageInfo = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    await expect(info.locator('dl')).toContainText(packageInfo.version)
    await expect(info.locator('dl')).toContainText('构建时间')
    await expect(info.locator('dl')).toContainText('开发模式，尚未构建')
    const timestamp = await info.locator('time').getAttribute('datetime')
    assert(Number.isFinite(Date.parse(timestamp)), `信息弹窗时间无效：${timestamp}`)
    assert.equal(await info.getByText('媒体处理', { exact: true }).count(), 0)
    await expect.poll(() => info.locator('.app-identity img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(info).not.toBeVisible()
    await expect(opener).toBeFocused()
  })

  await check('侧栏展开与折叠保持菜单项目高度', async () => {
    const heights = await page.locator('.sidebar nav>button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height))
    await page.getByRole('button', { name: '折叠侧栏', exact: true }).click()
    await expect(page.locator('.sidebar')).toHaveClass(/collapsed/)
    assert.deepEqual(await page.locator('.sidebar nav>button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height)), heights)
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
    await expect(page.locator('.sidebar')).not.toHaveClass(/collapsed/)
    assert.deepEqual(await page.locator('.sidebar nav>button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height)), heights)
  })

  const source = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const context = canvas.getContext('2d'); let frame = 0
    const paint = () => { context.fillStyle = '#d73351'; context.fillRect(0, 0, 320, 180); context.fillStyle = '#ffffff'; context.fillRect(20 + frame++ % 120, 40, 50, 80) }
    paint()
    const timer = setInterval(paint, 60), stream = canvas.captureStream(15)
    const recording = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), chunks = []
    recording.ondataavailable = event => chunks.push(event.data)
    const stopped = new Promise(resolve => { recording.onstop = resolve })
    recording.start(100); await new Promise(resolve => setTimeout(resolve, 1250)); recording.stop(); await stopped
    clearInterval(timer); stream.getTracks().forEach(track => track.stop())
    const video = new Blob(chunks, { type: 'video/webm' })
    context.fillStyle = '#3366dd'; context.fillRect(0, 0, 320, 180); context.fillStyle = '#ffffff'; context.fillRect(120, 55, 80, 70)
    const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    return { video: [...new Uint8Array(await video.arrayBuffer())], image: [...new Uint8Array(await image.arrayBuffer())] }
  })

  await check('真实视频与图片导入，添加时间线、字幕与播放预览', async () => {
    await page.getByTestId('media-input').setInputFiles([{ name: 'sample-video.webm', mimeType: 'video/webm', buffer: Buffer.from(source.video) }, { name: 'sample-image.png', mimeType: 'image/png', buffer: Buffer.from(source.image) }])
    await expect(page.locator('.asset-card')).toHaveCount(2)
    await page.locator('.asset-card').filter({ hasText: 'sample-video.webm' }).dblclick()
    await expect(page.locator('.timeline-clip')).toHaveCount(1)
    await page.locator('.asset-card').filter({ hasText: 'sample-image.png' }).dblclick()
    await expect(page.locator('.timeline-clip')).toHaveCount(2)
    await page.getByLabel('片段时长', { exact: true }).fill('1')
    await page.getByLabel('片段时长', { exact: true }).press('Tab')
    await page.getByRole('button', { name: '字幕', exact: true }).click()
    await page.getByLabel('字幕内容').fill('从灵感到作品')
    await page.getByLabel('字幕内容').press('Tab')
    await page.getByLabel('片段时长', { exact: true }).fill('1')
    await page.getByLabel('片段时长', { exact: true }).press('Tab')
    await expect(page.locator('.timeline-clip')).toHaveCount(3)
    await page.getByTestId('preview-play').click()
    await page.waitForTimeout(450)
    await page.getByTestId('preview-play').click()
    const pixel = await page.getByTestId('video-preview').evaluate(canvas => [...canvas.getContext('2d').getImageData(20, 20, 1, 1).data])
    assert(pixel[0] + pixel[1] + pixel[2] > 100, `预览没有显示实际素材：${pixel}`)
    await page.getByTitle('回到开头', { exact: true }).click()
  })

  await check('编辑操作通过全局撤销和重做恢复', async () => {
    await page.locator('.timeline-clip.text').click()
    await page.getByLabel('片段开始时间', { exact: true }).fill('0.25')
    await page.getByLabel('片段开始时间', { exact: true }).press('Tab')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.getByLabel('片段开始时间', { exact: true })).toHaveValue('0')
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(page.getByLabel('片段开始时间', { exact: true })).toHaveValue('0.25')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    const ruler = await page.locator('.timeline-ruler').boundingBox()
    await page.mouse.click(ruler.x + 0.5 * 44, ruler.y + 10)
    await page.getByTitle('裁掉播放头右侧（W）', { exact: true }).click()
    await expect(page.getByLabel('片段时长', { exact: true })).toHaveValue('0.5')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.getByLabel('片段时长', { exact: true })).toHaveValue('1')
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(page.getByLabel('片段时长', { exact: true })).toHaveValue('0.5')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await page.getByTitle('回到开头', { exact: true }).click()
  })

  let projectBytes
  await check('保存便携项目含真实素材，重新导入还原时间线并释放旧素材URL', async () => {
    const previousUrls = await page.locator('.asset-thumb video, .asset-thumb img').evaluateAll(elements => elements.map(element => element.src))
    const download = page.waitForEvent('download')
    await page.getByTestId('save-project').click()
    projectBytes = await readDownload(await download)
    const files = unzipSync(projectBytes), manifest = JSON.parse(strFromU8(files['project.json']))
    assert.equal(manifest.project.assets.length, 2)
    assert.equal(Object.keys(files).length, 3)
    for (const asset of manifest.project.assets) assert.equal(files[`media/${asset.id}`].length, asset.size)
    assert.equal(manifest.project.tracks.flatMap(track => track.clips).length, 3)
    await expect(page.getByTestId('save-project')).toBeEnabled()
    await requestNewProject()
    await expect(page.getByTestId('video-editor')).toBeVisible()
    await expect(page.locator('.asset-card')).toHaveCount(0)
    const revoked = await page.evaluate(async urls => Promise.all(urls.map(async url => { try { await fetch(url); return false } catch { return true } })), previousUrls)
    assert(revoked.every(Boolean), '切换项目后仍保留旧素材对象URL')
    await page.getByTestId('project-input').setInputFiles({ name: 'restore.omedia', mimeType: 'application/octet-stream', buffer: projectBytes })
    await expect(page.locator('.project-title')).toHaveText('工作台验收')
    await expect(page.locator('.asset-card')).toHaveCount(2)
    await expect(page.locator('.timeline-clip')).toHaveCount(3)
    const restoredImage = page.locator('.asset-thumb img')
    await expect(restoredImage).toHaveJSProperty('complete', true)
    await expect(restoredImage).toHaveJSProperty('naturalWidth', 320)
    await expect(restoredImage).toHaveJSProperty('naturalHeight', 180)
  })

  await check('自动草稿包含素材，刷新恢复项目和全部轨道', async () => {
    await rename('自动草稿恢复')
    await waitSaved()
    await page.reload()
    await expect(page.getByTestId('home-workspace')).toBeVisible()
    await page.getByTestId('nav-edit').click()
    await expect(page.locator('.project-title')).toHaveText('自动草稿恢复')
    await expect(page.locator('.asset-card')).toHaveCount(2)
    await expect(page.locator('.timeline-clip')).toHaveCount(3)
    await expect(page.locator('.asset-thumb img')).toBeVisible()
  })

  await check('关闭自动保存不写入草稿，切换项目可取消并选择保留', async () => {
    await page.getByTestId('autosave-toggle').click()
    await rename('尚未自动保存')
    await page.waitForTimeout(850)
    assert((await storedProjects()).some(project => project.title === '自动草稿恢复'))
    assert(!(await storedProjects()).some(project => project.title === '尚未自动保存'))
    await requestNewProject()
    await expect(page.getByRole('dialog')).toContainText('保留当前项目')
    await expect(page.getByTestId('create-project')).toBeDisabled()
    assert.equal(await page.locator('.workbench-body').getAttribute('inert'), '')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByTestId('nav-edit').click()
    await expect(page.locator('.project-title')).toHaveText('尚未自动保存')
    await requestNewProject()
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(page.getByTestId('video-editor')).toBeVisible()
    await expect(page.locator('.asset-card')).toHaveCount(0)
    assert((await storedProjects()).some(project => project.title === '尚未自动保存'))
    await page.locator('.brand').click()
    await page.locator('.recent-item > button:first-child').filter({ hasText: '尚未自动保存' }).click()
    await expect(page.locator('.project-title')).toHaveText('尚未自动保存')
    await page.getByTestId('autosave-toggle').click()
    await waitSaved()
  })

  await check('真实导出弹窗生成可解码WebM文件', async () => {
    await page.getByTestId('export-project').click()
    await page.getByLabel('导出宽度', { exact: true }).fill('320')
    await page.getByLabel('导出高度', { exact: true }).fill('180')
    const download = page.waitForEvent('download', { timeout: 30000 })
    await page.getByTestId('start-export').click()
    const bytes = await readDownload(await download)
    assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3])
    const output = path.join(directory, 'timeline.webm')
    await fs.writeFile(output, bytes)
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }))
    const video = probe.streams.find(stream => stream.codec_type === 'video')
    assert.equal(video.width, 320); assert.equal(video.height, 180)
    await expect(page.getByTestId('export-dialog')).toContainText('视频已导出')
    await page.getByRole('button', { name: '关闭导出', exact: true }).click()
  })

  await check('录制跨工作区持续运行，保存忙碌时停止也不会丢弃录制', async () => {
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
      const context = canvas.getContext('2d'); let frame = 0
      const paint = () => { context.fillStyle = '#258855'; context.fillRect(0, 0, 320, 180); context.fillStyle = '#ffffff'; context.fillRect(frame++ % 180, 50, 30, 30) }
      paint(); window.capturePaintTimer = setInterval(paint, 50)
      window.captureStream = canvas.captureStream(15)
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => window.captureStream })
      const audio = new AudioContext(), tone = audio.createOscillator(), output = audio.createMediaStreamDestination()
      const gain = audio.createGain(); gain.gain.value = 0.1
      tone.connect(gain).connect(output); tone.start()
      window.captureAudioContext = audio; window.captureMicrophoneStream = output.stream; window.captureMicrophoneRequests = 0
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { window.captureMicrophoneRequests++; return output.stream } })
      const original = Blob.prototype.arrayBuffer
      window.releaseBufferReads = () => { window.holdBufferReads = false; window.bufferWaiters.splice(0).forEach(resolve => resolve()) }
      window.bufferWaiters = []
      Blob.prototype.arrayBuffer = async function () { if (window.holdBufferReads) await new Promise(resolve => window.bufferWaiters.push(resolve)); return original.call(this) }
    })
    await page.getByTestId('nav-record').click()
    await page.getByLabel('开始倒计时').selectOption('0')
    await page.getByTestId('record-start').click()
    await expect(page.getByTestId('capture-picker-microphone')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('capture-picker-confirm').click()
    await expect(page.getByTestId('recording-source')).toBeVisible()
    assert.equal(await page.evaluate(() => window.captureMicrophoneRequests), 1)
    await expect(page.getByTestId('record-stop')).toBeVisible()
    await page.waitForTimeout(400)
    await page.getByTestId('nav-edit').click()
    await expect(page.locator('.recording-dot')).toBeVisible()
    await requestNewProject()
    await expect(page.locator('.app-error')).toContainText('请先完成或取消录制、配音、转换及导出，再切换项目。')
    await page.getByTestId('nav-edit').click()
    await expect(page.locator('.project-title')).toHaveText('尚未自动保存')
    await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await page.getByTestId('nav-record').click()
    await page.evaluate(() => { window.holdBufferReads = true })
    const download = page.waitForEvent('download', { timeout: 30000 })
    await page.keyboard.press('Control+s')
    await page.waitForFunction(() => window.bufferWaiters.length > 0)
    await page.getByTestId('record-stop').click()
    await expect(page.getByTestId('record-start')).toBeVisible()
    await expect(page.locator('.status-main')).toContainText('打包')
    await page.evaluate(() => window.releaseBufferReads())
    await download
    await expect(page.locator('.project-summary')).toContainText('3 个素材', { timeout: 20000 })
    assert.equal(await page.evaluate(() => window.captureStream.getTracks().every(track => track.readyState === 'ended')), true)
    assert.equal(await page.evaluate(() => window.captureMicrophoneStream.getTracks().every(track => track.readyState === 'ended')), true)
    await page.evaluate(async () => { clearInterval(window.capturePaintTimer); await window.captureAudioContext.close() })
    await page.getByTestId('nav-edit').click()
    await expect(page.locator('.asset-card')).toHaveCount(3)
    await waitSaved()
  })

  await check('异步保存保护先锁定切换，完成后只创建一个新项目', async () => {
    await rename('切换前最终编辑')
    await page.evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction
      window.holdTransactions = true; window.heldTransactions = 0
      IDBDatabase.prototype.transaction = function (...args) {
        const value = transaction.apply(this, args)
        if (window.holdTransactions && args[1] === 'readwrite' && value.objectStoreNames.contains('projects')) {
          window.heldTransactions++
          const keepAlive = () => { if (window.holdTransactions) { const request = value.objectStore('projects').get('__test_hold'); request.onsuccess = keepAlive } }
          keepAlive()
        }
        return value
      }
    })
    await requestNewProject()
    await page.waitForFunction(() => window.heldTransactions > 0)
    await expect(page.getByTestId('create-project')).toBeDisabled()
    await expect(page.getByTestId('autosave-toggle')).toHaveCount(0)
    assert.equal(await page.locator('.workbench-body').getAttribute('inert'), '')
    await page.getByTestId('create-project').evaluate(element => element.click())
    await page.evaluate(() => { window.holdTransactions = false })
    await expect(page.getByTestId('video-editor')).toBeVisible()
    await expect(page.locator('.asset-card')).toHaveCount(0)
    const projects = await storedProjects()
    assert(projects.some(project => project.title === '切换前最终编辑' && project.assets.length === 3))
    await page.locator('.brand').click()
    await page.locator('.recent-item > button:first-child').filter({ hasText: '切换前最终编辑' }).click()
    await expect(page.locator('.asset-card')).toHaveCount(3)
  })

  await check('深浅色与全部工作区320像素布局，图标采用SVG', async () => {
    await rename('我的第一部作品')
    await setTheme('dark')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark')
    await page.screenshot({ path: path.join(artifacts, 'workbench-dark.png') })
    await page.setViewportSize({ width: 320, height: 850 })
    for (const id of ['edit', 'record', 'gif', 'image', 'video']) {
      await page.getByTestId(`nav-${id}`).click()
      await expect(page.locator('.topbar [data-testid="export-project"]')).toHaveCount(0)
      await expect(page.getByTestId('export-project')).toHaveCount(id === 'edit' ? 1 : 0)
      const geometry = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth, right: document.querySelector('.topbar-end').getBoundingClientRect().right, content: document.querySelector('.main-area').getBoundingClientRect().right }))
      assert(geometry.scroll <= 321 && geometry.right <= 321 && geometry.content <= 321, `${id} 工作区超出320像素：${JSON.stringify(geometry)}`)
      assert.equal(await page.locator('button').evaluateAll(elements => elements.some(element => /\p{Extended_Pictographic}/u.test(element.textContent))), false)
    }
    await page.getByTestId('nav-edit').click()
    await page.screenshot({ path: path.join(artifacts, 'workbench-mobile.png') })
    await page.setViewportSize({ width: 1440, height: 960 })
    await setTheme('light')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'light')
    await page.screenshot({ path: path.join(artifacts, 'editor-light.png') })
    assert.deepEqual(pageErrors, [])
  })
}

main().catch(async error => { console.error(error); process.exitCode = 1; if (page) await page.screenshot({ path: '/tmp/open-media-workbench-failure.png', fullPage: true }).catch(() => {}) }).finally(async () => {
  const report = JSON.stringify({ passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, pageErrors, results }, null, 2)
  await fs.mkdir(artifacts, { recursive: true })
  await fs.writeFile('/tmp/open-media-workbench-results.json', report)
  await fs.writeFile(path.join(artifacts, 'workbench-results.json'), report)
  if (process.exitCode) await fs.copyFile('/tmp/open-media-workbench-failure.png', path.join(artifacts, 'workbench-failure.png')).catch(() => {})
  await browser?.close()
  server?.kill()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})
