const assert = require('node:assert/strict')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'project-save-status') : '/tmp/open-media-project-save-status'
const savedTime = page => page.getByTestId('last-save-time')
const countdown = page => page.getByTestId('autosave-countdown')
const toggle = page => page.getByTestId('autosave-toggle')

function wavFixture() {
  const rate = 16000, samples = rate
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index / rate * 440 * Math.PI * 2) * 1000), 44 + index * 2)
  return bytes
}

async function rename(page, title) {
  await page.locator('.project-title').click()
  const input = page.getByLabel('项目名称', { exact: true })
  await input.fill(title); await input.press('Enter')
  await expect(page.locator('.project-title')).toHaveText(title)
}

async function readDraft(page, id) {
  return page.evaluate(async id => {
    const { loadProject } = await import('/src/core/storage.ts')
    const result = await loadProject(id || localStorage.getItem('open-media:last-project'))
    try { return { project: result.project, savedAt: result.savedAt, blobs: [...result.blobs].map(([id, blob]) => ({ id, size: blob.size })) } }
    finally { result.revoke() }
  }, id)
}

async function fixture(browser, url, title) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const io = window.saveStatusIO = { mode: 'ready', writes: [], completions: [], holdRecent: false, recentReads: [], openCalls: [], saveCalls: [], openName: 'input.omedia', saveName: 'output.omedia' }
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'projects') {
        if (io.mode === 'fail') { io.mode = 'ready'; throw new DOMException('测试：本地存储空间不足', 'QuotaExceededError') }
        io.writes.push({ id: args[0].id, title: args[0].title })
      }
      return put.apply(this, args)
    }
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...complete,
      set(handler) {
        complete.set.call(this, typeof handler === 'function' ? function (event) {
          if (io.mode === 'hold' && this.mode === 'readwrite' && this.objectStoreNames.contains('projects')) io.completions.push(() => handler.call(this, event))
          else handler.call(this, event)
        } : handler)
      },
    })
    const getAll = IDBObjectStore.prototype.getAll
    const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess')
    IDBObjectStore.prototype.getAll = function (...args) {
      const request = getAll.apply(this, args)
      if (this.name === 'projects' && io.holdRecent) Object.defineProperty(request, 'onsuccess', {
        configurable: true,
        set(handler) {
          success.set.call(this, typeof handler === 'function' ? function (event) {
            if (io.holdRecent) io.recentReads.push(() => handler.call(this, event))
            else handler.call(this, event)
          } : handler)
        },
      })
      return request
    }
    window.showOpenFilePicker = async options => {
      io.openCalls.push({ active: navigator.userActivation.isActive, options })
      return [await (await navigator.storage.getDirectory()).getFileHandle(io.openName)]
    }
    window.showSaveFilePicker = async options => {
      io.saveCalls.push({ active: navigator.userActivation.isActive, options })
      return (await navigator.storage.getDirectory()).getFileHandle(io.saveName, { create: true })
    }
  })
  await page.goto(url)
  await expect(page.getByTestId('home-workspace')).toBeVisible()
  await page.evaluate(async title => {
    const { createProject } = await import('/src/core/project.ts')
    const { saveProject } = await import('/src/core/storage.ts')
    const project = createProject(title, { width: 640, height: 360, fps: 20 })
    await saveProject(project)
    localStorage.setItem('open-media:last-project', project.id)
    localStorage.setItem('open-media:autosave', 'true')
  }, title)
  await page.reload(); await page.getByTestId('nav-edit').click()
  await expect(page.locator('.project-title')).toHaveText(title)
  return { context, page, errors }
}

async function countdownChecks(browser, url) {
  const { context, page, errors } = await fixture(browser, url, '倒计时基准项目')
  try {
    const baseline = await readDraft(page)
    assert(baseline.savedAt && Number.isFinite(Date.parse(baseline.savedAt)))
    await expect(savedTime(page)).toHaveAttribute('datetime', baseline.savedAt)
    assert(/\d{2}:\d{2}:\d{2}/.test(await savedTime(page).innerText()), '左下角保存时间精确到秒')
    await rename(page, '第一次待保存')
    await expect(countdown(page)).toContainText('3')
    await expect(countdown(page)).toContainText('2')
    assert.equal((await readDraft(page)).project.title, '倒计时基准项目', '倒计时结束前不能提前显示已保存')
    await expect(savedTime(page)).toHaveAttribute('datetime', baseline.savedAt)
    await rename(page, '重新计时后关闭自动保存')
    await expect(countdown(page)).toContainText('3')
    await toggle(page).click(); await expect(toggle(page)).toHaveAttribute('aria-checked', 'false')
    await page.waitForTimeout(3400)
    assert.equal((await readDraft(page)).project.title, '倒计时基准项目', '关闭自动保存必须取消排队中的保存')
    await expect(savedTime(page)).toHaveAttribute('datetime', baseline.savedAt)
    await toggle(page).click()
    await expect.poll(async () => (await readDraft(page)).project.title).toBe('重新计时后关闭自动保存')
    const enabled = await readDraft(page)
    await expect(savedTime(page)).toHaveAttribute('datetime', enabled.savedAt)
    assert(Date.parse(enabled.savedAt) > Date.parse(baseline.savedAt))
    await rename(page, '等待完整倒计时保存')
    await expect(countdown(page)).toContainText('3')
    await page.screenshot({ path: path.join(artifacts, 'autosave-countdown.png') })
    await expect(countdown(page)).toContainText('2')
    await expect(countdown(page)).toContainText('1')
    await expect.poll(async () => (await readDraft(page)).project.title).toBe('等待完整倒计时保存')
    const saved = await readDraft(page)
    await expect(savedTime(page)).toHaveAttribute('datetime', saved.savedAt)
    assert(Date.parse(saved.savedAt) > Date.parse(enabled.savedAt))
    await page.reload(); await page.getByTestId('nav-edit').click()
    await expect(savedTime(page)).toHaveAttribute('datetime', saved.savedAt)
    assert.equal((await readDraft(page)).savedAt, saved.savedAt, '重新打开草稿不能将保存时间改成当前时间')
    await page.screenshot({ path: path.join(artifacts, 'saved-time.png') })
    assert.deepEqual(errors, [])
    console.log('PASS 自动保存显示 3/2/1 秒倒计时；继续编辑重新计时，关闭取消，成功写入后更新时间，重载保留真实保存时间')
  } catch (error) { await page.screenshot({ path: path.join(artifacts, 'countdown-failure.png') }); throw error }
  finally { await context.close() }
}

async function completionChecks(browser, url) {
  const { context, page, errors } = await fixture(browser, url, '保存完成基准项目')
  try {
    const baseline = await readDraft(page)
    await page.evaluate(() => { window.saveStatusIO.mode = 'hold' })
    await rename(page, '等待完成通知的旧快照')
    await expect.poll(() => page.evaluate(() => window.saveStatusIO.completions.length)).toBe(1)
    await expect(savedTime(page)).toHaveAttribute('datetime', baseline.savedAt)
    await expect(countdown(page)).toContainText('保存中')
    await rename(page, '写入期间继续编辑的新快照')
    await expect(countdown(page)).toContainText('3')
    await page.evaluate(() => { const io = window.saveStatusIO; io.mode = 'ready'; io.completions.splice(0).forEach(complete => complete()) })
    await expect(countdown(page)).toContainText(/\d/)
    assert.equal((await readDraft(page)).project.title, '等待完成通知的旧快照')
    await expect.poll(async () => (await readDraft(page)).project.title).toBe('写入期间继续编辑的新快照')
    const latest = await readDraft(page)
    await expect(savedTime(page)).toHaveAttribute('datetime', latest.savedAt)
    await page.evaluate(() => { window.saveStatusIO.mode = 'fail' })
    await rename(page, '失败的修改不可覆盖草稿')
    await expect(page.locator('.statusbar')).toContainText('草稿保存失败')
    await expect(savedTime(page)).toHaveAttribute('datetime', latest.savedAt)
    const afterFailure = await readDraft(page)
    assert.equal(afterFailure.project.title, latest.project.title)
    assert.equal(afterFailure.savedAt, latest.savedAt, '事务失败不能刷新保存时间或覆盖原草稿')
    await page.locator('.statusbar button').filter({ hasText: '草稿保存失败' }).click()
    await expect.poll(async () => (await readDraft(page)).project.title).toBe('失败的修改不可覆盖草稿')
    const retried = await readDraft(page)
    await expect(savedTime(page)).toHaveAttribute('datetime', retried.savedAt)
    assert(Date.parse(retried.savedAt) > Date.parse(latest.savedAt))
    assert.deepEqual(errors, [])
    console.log('PASS 等待保存完成时不提前刷新时间；旧快照完成不吞掉后续编辑，原子写入失败保留草稿和时间，重试后恢复')
  } catch (error) { await page.screenshot({ path: path.join(artifacts, 'completion-failure.png') }); throw error }
  finally { await context.close() }
}

async function recentRefreshChecks(browser, url) {
  const { context, page, errors } = await fixture(browser, url, '最近项目读取基准项目')
  try {
    await page.evaluate(() => { window.saveStatusIO.holdRecent = true })
    await rename(page, '已提交但最近项目仍在读取')
    await expect.poll(() => page.evaluate(() => window.saveStatusIO.recentReads.length)).toBe(1)
    const committed = await readDraft(page)
    assert.equal(committed.project.title, '已提交但最近项目仍在读取')
    await expect(savedTime(page)).toHaveAttribute('datetime', committed.savedAt)
    // Re-enabling autosave requests the same project revision while the recent-list
    // callback is delayed. Sharing a save must not leave the UI permanently pending.
    await toggle(page).click()
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'false')
    await toggle(page).click()
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'true')
    await page.evaluate(() => { const io = window.saveStatusIO; io.holdRecent = false; io.recentReads.splice(0).forEach(resolve => resolve()) })
    await expect(page.locator('.statusbar')).toContainText('本地草稿已保存')
    await expect(countdown(page)).toHaveCount(0)
    const restored = await readDraft(page)
    assert.equal(restored.project.title, committed.project.title)
    await expect(savedTime(page)).toHaveAttribute('datetime', restored.savedAt)
    assert.deepEqual(errors, [])
    console.log('PASS 最近项目读取延迟期间再次保存同一版本，完成后仍正确显示草稿已保存')
  } catch (error) { await page.screenshot({ path: path.join(artifacts, 'recent-refresh-failure.png') }); throw error }
  finally { await context.close() }
}

async function undoBeforeSwitchChecks(browser, url) {
  const { context, page, errors } = await fixture(browser, url, '撤销后应保留的项目 A')
  try {
    const baseline = await readDraft(page)
    await page.evaluate(() => { window.saveStatusIO.mode = 'hold' })
    await rename(page, '尚未结束保存的项目 B')
    await expect.poll(() => page.evaluate(() => window.saveStatusIO.completions.length)).toBe(1)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.locator('.project-title')).toHaveText(baseline.project.title)
    await expect(page.locator('.project-title > i')).toHaveCount(0)
    await expect(countdown(page)).toContainText('3')
    await page.getByTestId('new-project').click()
    // Returning to the file's clean state still needs a draft write after the older B.
    await expect(page.locator('.project-title')).toHaveText(baseline.project.title)
    await expect(page.locator('.workbench-body')).toHaveAttribute('inert', '')
    await page.evaluate(() => { const io = window.saveStatusIO; io.mode = 'ready'; io.completions.splice(0).forEach(complete => complete()) })
    await expect(page.locator('.project-title')).toHaveText('未命名项目')
    const restored = await readDraft(page, baseline.project.id)
    assert.deepEqual(restored.project, baseline.project, '切换前必须把撤销后的 A 写回草稿，不能遗留旧 B')
    assert.deepEqual(errors, [])
    console.log('PASS 旧快照仍在保存时撤销回已保存版本，立即新建也先保留撤销后的完整草稿')
  } catch (error) { await page.screenshot({ path: path.join(artifacts, 'undo-switch-failure.png') }); throw error }
  finally { await context.close() }
}

async function createPortableFixture(page) {
  return page.evaluate(async bytes => {
    const { createProject, createClip } = await import('/src/core/project.ts')
    const { exportProjectFile } = await import('/src/core/project-file.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const project = createProject('从文件打开的完整项目', { width: 640, height: 360, fps: 20 })
    const file = new File([new Uint8Array(bytes)], '同名配音.wav', { type: 'audio/wav' })
    const first = await importMediaFile(file), second = await importMediaFile(file)
    first.addedAt = '2026-08-02T03:04:05.000Z'
    delete second.addedAt
    project.assets.push(first, second)
    project.tracks.find(track => track.kind === 'audio').clips.push(createClip(first, project, { start: 0 }))
    const blob = await exportProjectFile(project, { blobs: new Map([[first.id, file], [second.id, file]]) })
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('input.omedia', { create: true })
    const writer = await handle.createWritable(); await writer.write(blob); await writer.close()
    URL.revokeObjectURL(first.url); URL.revokeObjectURL(second.url)
    return { id: project.id, first: first.id, second: second.id, timestamp: first.addedAt, bytes: [...new Uint8Array(await blob.arrayBuffer())] }
  }, [...wavFixture()])
}

async function openAndAssetChecks(browser, url) {
  const { context, page, errors } = await fixture(browser, url, '打开前的项目')
  try {
    await toggle(page).click()
    await page.getByTestId('media-input').setInputFiles({ name: '同名配音.wav', mimeType: 'audio/wav', buffer: wavFixture() })
    await expect(page.locator('.asset-card')).toHaveCount(1)
    await expect(page.locator('.asset-added-time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/)
    const firstTime = await page.locator('.asset-added-time').getAttribute('datetime')
    await page.waitForTimeout(1100)
    await page.getByTestId('media-input').setInputFiles({ name: '同名配音.wav', mimeType: 'audio/wav', buffer: wavFixture() })
    await expect(page.locator('.asset-card')).toHaveCount(2)
    const imports = await page.locator('.asset-added-time').evaluateAll(elements => elements.map(element => ({ time: element.getAttribute('datetime'), label: element.textContent, title: element.title })))
    assert.equal(imports[0].time, firstTime)
    assert(imports[1].time > imports[0].time)
    assert.notEqual(imports[0].label, imports[1].label, '同名素材应能通过可见加入时间区分')
    assert(imports.every(item => /\d{2}:\d{2}:\d{2}/.test(item.label) && item.title.includes(String(new Date(item.time).getFullYear()))))
    const layout = await page.locator('.asset-added-time').evaluateAll(elements => elements.map(element => ({ width: element.clientWidth, scroll: element.scrollWidth })))
    assert(layout.every(item => item.width > 0 && item.scroll <= item.width + 1), '素材时间必须在固定宽度卡片内完整显示')
    await page.getByTestId('save-project').click()
    await expect(page.locator('.status-main')).toContainText('项目已保存')
    const saved = await readDraft(page), originalId = saved.project.id
    assert.deepEqual(saved.project.assets.map(asset => asset.addedAt), imports.map(item => item.time))
    await expect(savedTime(page)).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/)
    const archiveBytes = Buffer.from(await page.evaluate(async () => [...new Uint8Array(await (await (await (await navigator.storage.getDirectory()).getFileHandle('output.omedia')).getFile()).arrayBuffer())]))
    const entries = unzipSync(archiveBytes), manifest = JSON.parse(strFromU8(entries['project.json']))
    assert.deepEqual(manifest.project.assets.map(asset => asset.addedAt), imports.map(item => item.time))
    for (const asset of saved.project.assets) assert.deepEqual(Buffer.from(entries[`media/${asset.id}`]), wavFixture())
    writeFileSync(path.join(artifacts, 'saved-assets.omedia'), archiveBytes)
    await page.screenshot({ path: path.join(artifacts, 'same-name-asset-times.png') })
    for (const width of [1440, 1000]) {
      await page.setViewportSize({ width, height: 1000 })
      const open = page.getByTestId('open-project'), box = await open.boundingBox()
      assert(box && box.x >= 0 && box.x + box.width <= width, `宽度 ${width} 下打开项目按钮必须可达`)
      await open.click({ trial: true })
    }
    await page.screenshot({ path: path.join(artifacts, 'editor-width-1000.png') })
    await page.setViewportSize({ width: 1440, height: 1000 })
    const incoming = await createPortableFixture(page)
    await rename(page, '仍未保留的项目修改')
    await page.getByTestId('open-project').click()
    await expect(page.getByRole('dialog', { name: '保留当前项目' })).toBeVisible()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('.project-title')).toHaveText('仍未保留的项目修改')
    assert.equal((await readDraft(page)).project.id, originalId)
    await page.getByTestId('open-project').click()
    await expect(page.getByRole('dialog', { name: '保留当前项目' })).toBeVisible()
    await page.getByRole('button', { name: '不保留修改', exact: true }).click()
    await expect(page.locator('.project-title')).toHaveText('从文件打开的完整项目')
    await expect(page.locator('.asset-card')).toHaveCount(2)
    await expect(page.locator('.asset-added-time').first()).toHaveAttribute('datetime', incoming.timestamp)
    await expect(page.locator('.asset-added-time').nth(1)).toHaveText('时间未记录')
    assert.equal(await page.locator('.asset-added-time').nth(1).getAttribute('datetime'), null, '旧项目缺少素材时间时不伪造加入时间')
    const calls = await page.evaluate(() => window.saveStatusIO.openCalls)
    assert.equal(calls.length, 2)
    assert(calls.every(call => call.active), '编辑器打开按钮必须在用户点击手势内调用文件选择器')
    await toggle(page).click()
    await expect.poll(async () => { try { return (await readDraft(page)).project.id } catch { return '' } }).toBe(incoming.id)
    const restored = await readDraft(page)
    assert.equal(restored.blobs.length, 2)
    assert.equal(restored.project.assets[0].addedAt, incoming.timestamp)
    assert.equal(restored.project.assets[1].addedAt, undefined)
    const decoded = await page.evaluate(async () => {
      const { loadProject } = await import('/src/core/storage.ts')
      const loaded = await loadProject(localStorage.getItem('open-media:last-project')), audio = new AudioContext()
      try { return await Promise.all([...loaded.blobs.values()].map(async blob => (await audio.decodeAudioData(await blob.arrayBuffer())).duration)) }
      finally { loaded.revoke(); await audio.close() }
    })
    assert.deepEqual(decoded, [1, 1])
    await page.reload(); await page.getByTestId('nav-edit').click()
    await expect(page.locator('.asset-added-time').first()).toHaveAttribute('datetime', incoming.timestamp)
    await expect(page.locator('.asset-added-time').nth(1)).toHaveText('时间未记录')
    await page.screenshot({ path: path.join(artifacts, 'asset-times-and-open.png') })
    assert.deepEqual(errors, [])
    console.log('PASS 剪辑区直接打开真实便携项目，未保存修改可取消；同名素材显示加入时间并跨保存恢复，旧数据不伪造日期，音频字节与解码完整')
  } catch (error) { await page.screenshot({ path: path.join(artifacts, 'open-failure.png') }); throw error }
  finally { await context.close() }
}

async function main() {
  mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false } })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] })
    const url = `http://127.0.0.1:${port}`
    await countdownChecks(browser, url)
    await completionChecks(browser, url)
    await recentRefreshChecks(browser, url)
    await undoBeforeSwitchChecks(browser, url)
    await openAndAssetChecks(browser, url)
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
