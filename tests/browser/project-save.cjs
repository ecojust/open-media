const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { existsSync } = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

const artifacts = '/tmp/open-media-project-save'

function inspectArchive(bytes, title, { image, subtitle } = {}) {
  const entries = unzipSync(new Uint8Array(bytes))
  const manifest = JSON.parse(strFromU8(entries['project.json']))
  assert.equal(manifest.format, 'open-media-project')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.project.title, title)
  assert.equal(Object.keys(entries).length, manifest.project.assets.length + 1)
  if (image) {
    assert.equal(manifest.project.assets.length, 1)
    const asset = manifest.project.assets[0]
    assert.equal(asset.url, '')
    assert.equal(asset.nativePath, undefined)
    assert.equal(asset.size, image.length)
    assert.deepEqual(Buffer.from(entries[`media/${asset.id}`]), image)
  }
  if (subtitle) assert.equal(manifest.project.tracks.flatMap(track => track.clips).find(clip => clip.text)?.text, subtitle)
  return manifest.project
}

async function rename(page, title) {
  await page.locator('.project-title').click()
  await page.getByLabel('项目名称', { exact: true }).fill(title)
  await page.getByLabel('项目名称', { exact: true }).press('Enter')
  await expect(page.locator('.project-title')).toHaveText(title)
}

async function createProject(page) {
  await page.locator('.brand').click()
  await page.getByTestId('create-project').click()
  await expect(page.getByTestId('save-project')).toBeEnabled()
  await expect(page.locator('.project-title')).toHaveText('未命名项目')
}

async function openRecent(page, title) {
  await page.locator('.brand').click()
  await page.locator('.recent-item > button').filter({ hasText: title }).click()
  await expect(page.getByTestId('save-project')).toBeEnabled()
  await expect(page.locator('.project-title')).toHaveText(title)
}

async function save(page, { saveAs = false, key, result = true } = {}) {
  if (key) await page.keyboard.press(key)
  else await page.getByTestId(saveAs ? 'save-as-project' : 'save-project').click()
  await expect(page.getByTestId('save-project')).toBeEnabled()
  await expect(page.getByTestId('save-as-project')).toBeEnabled()
  if (result) {
    await expect(page.locator('.status-main')).toContainText(saveAs ? '项目已另存为' : '项目已保存')
    await expect(page.locator('.project-title > i')).toHaveCount(0)
  }
}

async function addMedia(page) {
  const imported = page.getByLabel('素材来源', { exact: true }).getByRole('button', { name: '已导入', exact: true })
  if (await imported.count()) await imported.click()
  const image = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 32
    const context = canvas.getContext('2d'); context.fillStyle = '#68a4df'; context.fillRect(0, 0, 48, 32)
    context.fillStyle = '#c12932'; context.fillRect(8, 4, 24, 16)
    return Array.from(Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), value => value.charCodeAt(0)))
  }))
  await page.getByTestId('media-input').setInputFiles({ name: '保存测试.png', mimeType: 'image/png', buffer: image })
  await expect(page.locator('.asset-card')).toHaveCount(1)
  await page.getByRole('button', { name: '字幕', exact: true }).click()
  await page.getByLabel('字幕内容').fill('保存需要保留素材和字幕')
  await page.getByLabel('字幕内容').press('Tab')
  return { image, subtitle: '保存需要保留素材和字幕' }
}

async function createPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  return { page, context, errors }
}

async function nativeChecks(browser, url) {
  const { page, context, errors } = await createPage(browser)
  const state = { calls: [], mode: 'ready', nextName: 'native-a.omedia', openName: 'native-a.omedia', targets: new Map() }
  const target = name => ({ name, path: path.join(artifacts, name), token: createHash('sha256').update(name).digest('hex') })
  try {
    await page.exposeBinding('projectNativeInvoke', async (_, command, args) => {
      if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
      if (command === 'get_media_jobs') return []
      if (command === 'list_stored_videos') return { directory: '/fixture/recordings', assets: [], warnings: [] }
      if (command === 'configure_screenshot_shortcut') return args.shortcut
      if (command === 'plugin:event|listen') return 1
      if (command === 'plugin:event|unlisten') return null
      if (command === 'import_blob_asset') {
        const bytes = Buffer.from(args.bytes)
        return { id: `asset-${Date.now()}`, name: args.name, kind: 'image', url: `data:image/png;base64,${bytes.toString('base64')}`, mime: 'image/png', duration: 0, width: 48, height: 32, size: bytes.length }
      }
      if (command === 'save_project_file') {
        state.calls.push({ token: args.token, name: args.name })
        if (state.mode === 'cancel') { state.mode = 'ready'; return null }
        if (state.mode === 'fail') { state.mode = 'ready'; throw new Error('保存测试：磁盘写入失败') }
        const destination = args.token ? state.targets.get(args.token) : target(state.nextName)
        assert(destination, `未知保存目标 ${args.token}`)
        await fs.writeFile(destination.path, Buffer.from(args.bytes))
        state.targets.set(destination.token, destination)
        return destination
      }
      if (command === 'open_project_file') {
        const selected = target(state.openName)
        state.targets.set(selected.token, selected)
        return { ...selected, bytes: Array.from(await fs.readFile(selected.path)) }
      }
      throw new Error(`未预期的原生命令：${command}`)
    })
    await page.addInitScript(() => {
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: path => path,
        invoke: (command, args) => window.projectNativeInvoke(command, args),
      }
    })
    await page.goto(url)
    await createProject(page)
    await rename(page, '首次保存')
    const media = await addMedia(page)
    state.mode = 'cancel'
    await save(page, { result: false })
    assert.equal(state.calls.at(-1).token, null)
    assert.equal(existsSync(target('native-a.omedia').path), false)
    await expect(page.locator('.project-title > i')).toHaveCount(1)
    await save(page)
    assert.equal(state.calls.at(-1).token, null)
    const first = inspectArchive(await fs.readFile(target('native-a.omedia').path), '首次保存', media)
    await rename(page, '直接覆盖')
    await save(page, { key: 'Control+s' })
    assert.equal(state.calls.at(-1).token, target('native-a.omedia').token)
    assert.equal(inspectArchive(await fs.readFile(target('native-a.omedia').path), '直接覆盖', media).id, first.id)
    const original = await fs.readFile(target('native-a.omedia').path)
    state.nextName = 'native-b.omedia'
    await rename(page, '另存的项目')
    await save(page, { saveAs: true, key: 'Control+Shift+s' })
    assert.equal(state.calls.at(-1).token, null)
    inspectArchive(await fs.readFile(target('native-b.omedia').path), '另存的项目', media)
    assert.deepEqual(await fs.readFile(target('native-a.omedia').path), original)
    await rename(page, '取消后仍保存原目标')
    state.mode = 'cancel'
    await save(page, { saveAs: true, result: false })
    assert.equal(state.calls.at(-1).token, null)
    await expect(page.locator('.project-title > i')).toHaveCount(1)
    await save(page, { key: 'Meta+s' })
    assert.equal(state.calls.at(-1).token, target('native-b.omedia').token)
    inspectArchive(await fs.readFile(target('native-b.omedia').path), '取消后仍保存原目标', media)
    await rename(page, '失败后仍保存原目标')
    state.nextName = 'native-failed.omedia'; state.mode = 'fail'
    await save(page, { saveAs: true, key: 'Meta+Shift+s', result: false })
    await expect(page.getByRole('alert')).toContainText('磁盘写入失败')
    assert.equal(state.calls.at(-1).token, null)
    assert.equal(existsSync(target('native-failed.omedia').path), false)
    await expect(page.locator('.project-title > i')).toHaveCount(1)
    await save(page)
    assert.equal(state.calls.at(-1).token, target('native-b.omedia').token)
    const beforeFailure = await fs.readFile(target('native-b.omedia').path)
    await rename(page, '覆盖重试成功'); state.mode = 'fail'
    await save(page, { result: false })
    assert.equal(state.calls.at(-1).token, target('native-b.omedia').token)
    assert.deepEqual(await fs.readFile(target('native-b.omedia').path), beforeFailure)
    await save(page)
    inspectArchive(await fs.readFile(target('native-b.omedia').path), '覆盖重试成功', media)
    console.log('PASS 原生桥契约：真实项目压缩包含素材字幕；首次保存、直接覆盖、另存、四种快捷键，以及取消/失败保留目标')

    const protectedBytes = await fs.readFile(target('native-b.omedia').path)
    await createProject(page)
    state.nextName = 'native-new.omedia'
    await save(page)
    assert.equal(state.calls.at(-1).token, null)
    const fresh = inspectArchive(await fs.readFile(target('native-new.omedia').path), '未命名项目')
    assert.notEqual(fresh.id, first.id)
    assert.deepEqual(await fs.readFile(target('native-b.omedia').path), protectedBytes)
    await openRecent(page, '覆盖重试成功')
    await save(page)
    assert.equal(state.calls.at(-1).token, target('native-b.omedia').token, '切换回来必须恢复本项目的保存目标')
    inspectArchive(await fs.readFile(target('native-new.omedia').path), '未命名项目')
    await page.keyboard.press('Control+o')
    await expect(page.locator('.project-title')).toHaveText('直接覆盖')
    await rename(page, '打开后保存原文件')
    await save(page)
    assert.equal(state.calls.at(-1).token, target('native-a.omedia').token)
    inspectArchive(await fs.readFile(target('native-a.omedia').path), '打开后保存原文件', media)
    await page.reload()
    await expect(page.getByTestId('home-workspace')).toBeVisible()
    await page.getByTestId('nav-edit').click()
    await expect(page.locator('.project-title')).toHaveText('打开后保存原文件')
    state.nextName = 'native-restored.omedia'
    await rename(page, '恢复后覆盖原文件')
    await save(page)
    assert.equal(state.calls.at(-1).token, target('native-a.omedia').token)
    inspectArchive(await fs.readFile(target('native-a.omedia').path), '恢复后覆盖原文件', media)
    assert.equal(existsSync(target('native-restored.omedia').path), false)
    console.log('PASS 原生桥契约：新项目独立；切换和重载恢复已选目标，打开项目后的保存直接回写原文件')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

async function installBrowserPickers(page) {
  await page.addInitScript(() => {
    const state = { saves: [], opens: [], nextName: 'browser-a.omedia', openName: 'browser-a.omedia', mode: 'ready' }
    window.projectFileHarness = state
    window.showSaveFilePicker = async options => {
      state.saves.push({ options, active: navigator.userActivation.isActive })
      if (state.mode === 'cancel') { state.mode = 'ready'; throw new DOMException('已取消', 'AbortError') }
      if (state.mode === 'fail') { state.mode = 'ready'; throw new DOMException('保存测试：文件访问失败', 'NotAllowedError') }
      const root = await navigator.storage.getDirectory()
      const handle = await root.getFileHandle(state.nextName, { create: true })
      if (!(handle instanceof FileSystemFileHandle)) throw new Error('需要真实的文件句柄')
      return handle
    }
    window.showOpenFilePicker = async options => {
      state.opens.push({ options, active: navigator.userActivation.isActive })
      const root = await navigator.storage.getDirectory()
      return [await root.getFileHandle(state.openName)]
    }
  })
}

async function readBrowserFile(page, name) {
  return Buffer.from(await page.evaluate(async name => {
    const root = await navigator.storage.getDirectory(), handle = await root.getFileHandle(name)
    return Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()))
  }, name))
}

async function browserChecks(browser, url) {
  const { page, context, errors } = await createPage(browser)
  try {
    await installBrowserPickers(page)
    await page.goto(url)
    await createProject(page)
    await rename(page, '网页首次保存')
    const media = await addMedia(page)
    await save(page)
    inspectArchive(await readBrowserFile(page, 'browser-a.omedia'), '网页首次保存', media)
    await rename(page, '网页直接覆盖')
    await save(page, { key: 'Control+s' })
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 1)
    const original = await readBrowserFile(page, 'browser-a.omedia')
    inspectArchive(original, '网页直接覆盖', media)
    await page.evaluate(() => { window.projectFileHarness.nextName = 'browser-b.omedia' })
    await rename(page, '网页另存为')
    await save(page, { saveAs: true })
    inspectArchive(await readBrowserFile(page, 'browser-b.omedia'), '网页另存为', media)
    assert.deepEqual(await readBrowserFile(page, 'browser-a.omedia'), original)
    await rename(page, '取消后网页覆盖')
    await page.evaluate(() => { window.projectFileHarness.mode = 'cancel' })
    await save(page, { saveAs: true, result: false })
    await expect(page.locator('.project-title > i')).toHaveCount(1)
    await save(page)
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 3)
    inspectArchive(await readBrowserFile(page, 'browser-b.omedia'), '取消后网页覆盖', media)
    await rename(page, '失败后网页覆盖')
    await page.evaluate(() => { window.projectFileHarness.mode = 'fail' })
    await save(page, { saveAs: true, result: false })
    await expect(page.getByRole('alert')).toContainText('文件访问失败')
    await save(page)
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 4)
    inspectArchive(await readBrowserFile(page, 'browser-b.omedia'), '失败后网页覆盖', media)
    console.log('PASS 网页真实文件句柄：连续覆写项目和素材，另存后切换目标，取消/失败继续保存原目标')

    await page.keyboard.press('Control+o')
    await expect(page.locator('.project-title')).toHaveText('网页直接覆盖')
    await rename(page, '网页打开后回写')
    await save(page)
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 4)
    inspectArchive(await readBrowserFile(page, 'browser-a.omedia'), '网页打开后回写', media)
    const old = await readBrowserFile(page, 'browser-a.omedia')
    await createProject(page)
    await page.evaluate(() => { window.projectFileHarness.nextName = 'browser-new.omedia' })
    await save(page)
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 5)
    inspectArchive(await readBrowserFile(page, 'browser-new.omedia'), '未命名项目')
    assert.deepEqual(await readBrowserFile(page, 'browser-a.omedia'), old)
    await openRecent(page, '网页打开后回写')
    await rename(page, '网页切换后覆盖')
    await save(page)
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 5)
    inspectArchive(await readBrowserFile(page, 'browser-a.omedia'), '网页切换后覆盖', media)
    inspectArchive(await readBrowserFile(page, 'browser-new.omedia'), '未命名项目')
    const activation = await page.evaluate(() => [...window.projectFileHarness.saves, ...window.projectFileHarness.opens])
    assert(activation.every(call => call.active), '选择器必须在用户点击或按键激活期间打开')
    assert(activation.every(call => call.options.excludeAcceptAllOption), '项目选择器应限定项目文件格式')
    console.log('PASS 网页打开项目后直接回写，新项目不覆盖旧目标，选择器保留用户激活')

    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      for (const id of ['save-project', 'save-as-project']) {
        const button = page.getByTestId(id)
        await button.scrollIntoViewIfNeeded()
        await button.click({ trial: true })
        const visible = await button.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return { width: rect.width, height: rect.height, reachable: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === element, svg: !!element.querySelector('svg') }
        })
        assert(visible.reachable && visible.width >= 24 && visible.height >= 24 && visible.svg, `${width}px 下 ${id} 无法操作`)
      }
      await page.screenshot({ path: path.join(artifacts, `save-${width}.png`), animations: 'disabled' })
    }
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.reload()
    await expect(page.getByTestId('home-workspace')).toBeVisible()
    await page.getByTestId('nav-edit').click()
    await page.evaluate(() => { window.projectFileHarness.nextName = 'browser-restored.omedia' })
    await rename(page, '网页恢复后覆盖')
    await save(page)
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 0)
    inspectArchive(await readBrowserFile(page, 'browser-a.omedia'), '网页恢复后覆盖', media)
    console.log('PASS 320/768/1440px 保存和另存为按钮均可达；真实文件句柄经 IndexedDB 恢复后仍直接覆盖')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

async function fallbackChecks(browser, url) {
  const { page, context, errors } = await createPage(browser)
  try {
    await page.addInitScript(() => { window.showSaveFilePicker = undefined; window.showOpenFilePicker = undefined })
    await page.goto(url)
    await createProject(page)
    await rename(page, '下载兼容项目')
    const media = await addMedia(page)
    for (const saveAs of [false, true]) {
      const downloaded = page.waitForEvent('download')
      await save(page, { saveAs, result: false })
      const file = await downloaded
      assert.equal(file.suggestedFilename(), '下载兼容项目.omedia')
      inspectArchive(await fs.readFile(await file.path()), '下载兼容项目', media)
      await expect(page.locator('.status-main')).toContainText('当前浏览器不支持直接覆盖文件')
    }
    assert.deepEqual(errors, [])
    console.log('PASS 无文件选择 API 时保存/另存为下载真实便携项目，并明确提示无法直接覆盖')
  } finally { await context.close() }
}

async function missingBrowserTargetChecks(browser, url) {
  const { page, context, errors } = await createPage(browser)
  try {
    await installBrowserPickers(page)
    await page.goto(url)
    await createProject(page)
    await rename(page, '原保存位置失效')
    const media = await addMedia(page)
    await save(page)
    inspectArchive(await readBrowserFile(page, 'browser-a.omedia'), '原保存位置失效', media)
    const protectedBytes = Buffer.from('这个同目录文件不应被覆盖')
    await page.evaluate(async bytes => {
      const root = await navigator.storage.getDirectory()
      const protectedFile = await root.getFileHandle('protected.omedia', { create: true })
      const writer = await protectedFile.createWritable()
      await writer.write(new Uint8Array(bytes)); await writer.close()
      await root.removeEntry('browser-a.omedia')
    }, [...protectedBytes])
    await rename(page, '移除目标后的未保存修改')
    await save(page, { result: false })
    await expect(page.getByRole('alert')).toContainText('保存位置')
    await expect(page.getByRole('alert')).toContainText('另存为')
    await expect(page.getByRole('alert')).not.toContainText('NotFoundError')
    await expect(page.locator('.project-title > i')).toHaveCount(1)
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 1, '失效句柄不能悄悄更换保存位置')
    assert.equal(await page.evaluate(async () => {
      try { await (await navigator.storage.getDirectory()).getFileHandle('browser-a.omedia'); return true }
      catch (error) { if (error.name === 'NotFoundError') return false; throw error }
    }), false, '失效句柄保存失败时不能假称成功或自动重建旧文件')
    assert.deepEqual(await readBrowserFile(page, 'protected.omedia'), protectedBytes)
    await save(page, { result: false })
    await expect(page.getByRole('alert')).toContainText('保存位置')
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 1, '重复保存失效目标仍应报错，不能悄悄改成另存为')
    await page.evaluate(() => { window.projectFileHarness.nextName = 'browser-recovered.omedia' })
    await save(page, { saveAs: true })
    inspectArchive(await readBrowserFile(page, 'browser-recovered.omedia'), '移除目标后的未保存修改', media)
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 2)
    await rename(page, '重新选择位置后正常覆盖')
    await save(page)
    inspectArchive(await readBrowserFile(page, 'browser-recovered.omedia'), '重新选择位置后正常覆盖', media)
    assert.equal(await page.evaluate(() => window.projectFileHarness.saves.length), 2)
    assert.deepEqual(await readBrowserFile(page, 'protected.omedia'), protectedBytes)
    assert.deepEqual(errors, [])
    console.log('PASS 真实保存目标被删除后显示中文恢复指引、保留未保存状态；另存为完整保留素材字幕并恢复直接覆盖')
  } finally { await context.close() }
}

async function missingCachedBlobChecks(browser, url) {
  const { page, context, errors } = await createPage(browser)
  try {
    await page.route('**/__project_cached_blob__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>项目素材恢复验证</title></head><body></body></html>' }))
    await page.goto(`${url}/__project_cached_blob__`)
    const result = await page.evaluate(async () => {
      const { exportProjectFile } = await import('/src/core/project-file.ts')
      const { createProject, createTextClip } = await import('/src/core/project.ts')
      const { importMediaFile } = await import('/src/core/media-import.ts')
      async function picture(color) {
        const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 32
        const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height)
        return new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      }
      const original = await picture('#dd3300'), preview = await picture('#0033dd')
      const asset = await importMediaFile(new File([original], '原始素材.png', { type: 'image/png' }))
      const originalUrl = asset.url, previewUrl = URL.createObjectURL(preview)
      asset.sourceUrl = originalUrl; asset.url = previewUrl
      const project = createProject('缓存失效后读取原件')
      project.assets = [asset]
      project.tracks.find(track => track.kind === 'text').clips = [createTextClip(project, { text: '导出必须保留原始素材' })]
      const cached = new Blob([original], { type: 'image/png' })
      let failedReads = 0
      Object.defineProperty(cached, 'arrayBuffer', { value: async () => { failedReads++; throw new DOMException('The requested file could not be found.', 'NotFoundError') } })
      try {
        const archive = await exportProjectFile(project, { blobs: new Map([[asset.id, cached]]) })
        return { archive: [...new Uint8Array(await archive.arrayBuffer())], original: [...new Uint8Array(await original.arrayBuffer())], preview: [...new Uint8Array(await preview.arrayBuffer())], failedReads }
      } finally { URL.revokeObjectURL(originalUrl); URL.revokeObjectURL(previewUrl) }
    })
    assert.equal(result.failedReads, 1, '测试必须实际经历缓存 Blob 读取失败')
    assert.notDeepEqual(result.original, result.preview, '原件与预览必须是不同实际内容')
    inspectArchive(result.archive, '缓存失效后读取原件', { image: Buffer.from(result.original), subtitle: '导出必须保留原始素材' })
    assert.deepEqual(errors, [])
    console.log('PASS 缓存 Blob 读取失效后回源打包真实原件，未将不同的预览图片冒充原件')
  } finally { await context.close() }
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true })
  // Each run starts with fresh native targets; persistent user files are never involved.
  for (const entry of await fs.readdir(artifacts)) if (/^native-.*\.omedia$/.test(entry)) await fs.unlink(path.join(artifacts, entry))
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: () => true } }, logLevel: 'error' })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}`
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server'] })
    await nativeChecks(browser, url)
    await browserChecks(browser, url)
    await fallbackChecks(browser, url)
    await missingBrowserTargetChecks(browser, url)
    await missingCachedBlobChecks(browser, url)
  } finally { await browser?.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
