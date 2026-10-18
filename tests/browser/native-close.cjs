const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

async function fixture(browser, url, autoSave = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(autoSave => {
    localStorage.setItem('open-media:autosave', String(autoSave))
    const callbacks = new Map(), listeners = new Map()
    const state = window.closeHarness = { calls: [], jobs: [], saveMode: 'ready', closeMode: 'ready', jobsMode: 'ready', saved: [] }
    let callbackId = 0
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) { const id = ++callbackId; callbacks.set(id, callback); return id },
      unregisterCallback(id) { callbacks.delete(id) },
      convertFileSrc: value => value,
      invoke: async (command, args) => {
        state.calls.push(command)
        if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return args.handler }
        if (command === 'plugin:event|unlisten') return null
        if (command === 'configure_screenshot_shortcut') return args.shortcut
        if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
        if (command === 'list_stored_videos') return { directory: '/fixture/recordings', assets: [], warnings: [] }
        if (command === 'get_media_jobs') {
          if (state.jobsMode === 'fail') throw new Error('无法检查正在处理的任务')
          return structuredClone(state.jobs)
        }
        if (command === 'save_project_file') {
          if (state.saveMode === 'cancel') return null
          if (state.saveMode === 'fail') throw new Error('项目文件写入失败')
          state.saved.push(args.bytes)
          return { name: args.name, path: `/saved/${args.name}`, token: 'saved-project' }
        }
        if (command === 'close_native_window') {
          if (state.closeMode === 'fail') throw new Error('无法关闭应用，请重试')
          return null
        }
        throw new Error(`未预期的原生命令：${command}`)
      },
    }
    state.close = () => callbacks.get(listeners.get('native-close-requested'))?.({ event: 'native-close-requested', payload: null })
    state.ready = () => listeners.has('native-close-requested')
  }, autoSave)
  await page.goto(url)
  await expect(page.getByTestId('create-project')).toBeEnabled()
  await page.waitForFunction(() => window.closeHarness.ready())
  await page.getByTestId('nav-edit').click()
  await expect(page.locator('.statusbar > *')).toHaveCount(2)
  await expect(page.locator('.statusbar > .status-main')).toBeVisible()
  await expect(page.locator('.statusbar > button')).toBeVisible()
  await expect(page.locator('.statusbar .status-tasks')).toHaveCount(0)
  return { page, errors, finish: async () => { assert.deepEqual(errors, []); await context.close() } }
}
async function rename(page, title) {
  await page.locator('.project-title').click()
  await page.getByLabel('项目名称', { exact: true }).fill(title)
  await page.getByLabel('项目名称', { exact: true }).press('Enter')
  await expect(page.locator('.project-title')).toHaveText(title)
}
async function close(page) { await page.evaluate(() => window.closeHarness.close()) }
const calls = (page, command) => page.evaluate(command => window.closeHarness.calls.filter(value => value === command).length, command)
const dialog = page => page.getByRole('dialog', { name: '关闭应用', exact: true })
async function setMode(page, key, value) { await page.evaluate(({ key, value }) => { window.closeHarness[key] = value }, { key, value }) }
async function checkNoExit(page) { assert.equal(await calls(page, 'close_native_window'), 0) }

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
    const url = `http://127.0.0.1:${server.httpServer.address().port}`
    {
      const { page, finish } = await fixture(browser, url)
      await rename(page, '尚未保存的剪辑')
      await close(page)
      await expect(dialog(page)).toContainText('已经保存的本地草稿仍会保留')
      await expect(dialog(page).locator('footer button')).toHaveText(['取消', '全部关闭', '保存并全部关闭'])
      await close(page)
      await expect(dialog(page)).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(dialog(page)).toHaveCount(0)
      await expect(page.getByTestId('save-project')).toBeEnabled()
      await checkNoExit(page)
      await expect(page.locator('.project-title')).toHaveText('尚未保存的剪辑')
      await rename(page, '关闭前保存')
      for (const mode of ['cancel', 'fail']) {
        await setMode(page, 'saveMode', mode)
        await close(page)
        await dialog(page).getByRole('button', { name: '保存并全部关闭', exact: true }).click()
        await expect(page.getByTestId('save-project')).toBeEnabled()
        await expect(page.locator('.project-title > i')).toHaveCount(1)
        await checkNoExit(page)
        if (mode === 'fail') await expect(page.getByRole('alert')).toContainText('项目文件写入失败')
      }
      await setMode(page, 'saveMode', 'ready')
      await close(page)
      await dialog(page).getByRole('button', { name: '保存并全部关闭', exact: true }).click()
      await expect.poll(() => calls(page, 'close_native_window')).toBe(1)
      await expect(page.locator('.workbench-body')).toHaveAttribute('inert', '')
      await expect(page.getByTestId('save-project')).toBeDisabled()
      const saved = await page.evaluate(() => window.closeHarness.saved)
      assert.equal(saved.length, 1)
      const entries = unzipSync(new Uint8Array(saved[0]))
      assert.equal(JSON.parse(strFromU8(entries['project.json'])).project.title, '关闭前保存')
      await close(page)
      assert.equal(await calls(page, 'close_native_window'), 1)
      await finish()
      console.log('PASS 关闭确认、重复请求与取消；项目文件保存取消/失败保持工作台，重试实际打包后仅关闭一次')
    }
    {
      const { page, finish } = await fixture(browser, url)
      await page.locator('.project-title').click()
      await page.getByLabel('项目名称', { exact: true }).fill('输入中也要保存')
      await close(page)
      await expect(dialog(page)).toContainText('输入中也要保存')
      await dialog(page).getByRole('button', { name: '取消', exact: true }).click()
      for (const title of ['关于 Open Media', '项目设置', '处理任务']) {
        if (title === '处理任务') {
          await setMode(page, 'jobs', [{ id: 'underlying-export', name: '待完成导出', state: 'running', progress: 0.5 }])
          await close(page)
          await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible()
          await setMode(page, 'jobs', [{ id: 'underlying-export', name: '待完成导出', state: 'completed', progress: 1 }])
          await page.waitForFunction(() => document.querySelector('#app').__vue_app__._instance.setupState.runningJobs === 0)
        } else await page.getByRole('button', { name: title, exact: true }).click()
        const underlying = page.getByRole('dialog', { name: title, exact: true })
        await expect(underlying).toBeVisible()
        await close(page)
        await expect(dialog(page)).toBeVisible()
        await expect(underlying).toHaveAttribute('inert', '')
        const cancel = dialog(page).getByRole('button', { name: '取消', exact: true })
        await cancel.focus()
        await page.keyboard.press('Shift+Tab')
        assert.equal(await dialog(page).evaluate(element => element.contains(document.activeElement)), true)
        await cancel.click()
        await expect(dialog(page)).toHaveCount(0)
        await expect(underlying).toBeVisible()
        await expect(underlying).not.toHaveAttribute('inert')
        await underlying.getByRole('button', { name: title === '处理任务' ? '关闭任务' : `关闭${title}`, exact: true }).click()
      }
      await page.getByRole('button', { name: '字幕', exact: true }).click()
      await page.getByLabel('字幕内容').fill('关闭时正在输入的字幕应完整保留')
      await close(page)
      await dialog(page).getByRole('button', { name: '保存并全部关闭', exact: true }).click()
      await expect.poll(() => calls(page, 'close_native_window')).toBe(1)
      const bytes = await page.evaluate(() => window.closeHarness.saved[0])
      const entries = unzipSync(new Uint8Array(bytes))
      const saved = JSON.parse(strFromU8(entries['project.json'])).project
      assert.equal(saved.title, '输入中也要保存')
      assert.equal(saved.tracks.flatMap(track => track.clips).find(clip => clip.text)?.text, '关闭时正在输入的字幕应完整保留')
      await finish()
      console.log('PASS 关于/项目设置打开时退出确认位于最上层且可操作；未失焦项目名称与字幕被完整保存')
    }
    {
      const { page, finish } = await fixture(browser, url)
      await rename(page, '退出前锁定设置')
      await page.getByRole('button', { name: '项目设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '项目设置', exact: true })
      await close(page)
      await dialog(page).getByRole('button', { name: '全部关闭', exact: true }).click()
      await expect.poll(() => calls(page, 'close_native_window')).toBe(1)
      await expect(settings).toHaveAttribute('inert', '')
      await expect(page.locator('.workbench-body')).toHaveAttribute('inert', '')
      await finish()
      console.log('PASS 确认退出后，工作台及既有原生弹窗保持锁定直到应用退出')
    }
    {
      const { page, finish } = await fixture(browser, url, true)
      await rename(page, '已有本地草稿')
      await expect(page.locator('.statusbar')).toContainText('本地草稿已保存')
      await close(page)
      await expect(dialog(page)).toBeVisible()
      await dialog(page).getByRole('button', { name: '取消', exact: true }).click()
      await page.getByTestId('autosave-toggle').click()
      await rename(page, '尚未保留的新修改')
      await close(page)
      await dialog(page).getByRole('button', { name: '全部关闭', exact: true }).click()
      await expect.poll(() => calls(page, 'close_native_window')).toBe(1)
      assert.equal(await calls(page, 'save_project_file'), 0)
      assert.deepEqual(await page.evaluate(async () => (await (await import('/src/core/storage.ts')).listProjects()).map(project => project.title)), ['已有本地草稿'])
      await finish()
      console.log('PASS 自动保存草稿后仍提示未写入文件的修改；全部关闭保留已有草稿，不另写项目文件或覆盖草稿')
    }
    {
      const { page, finish } = await fixture(browser, url)
      await rename(page, '关闭失败仍可继续')
      await setMode(page, 'closeMode', 'fail')
      await close(page)
      await dialog(page).getByRole('button', { name: '全部关闭', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('无法关闭应用')
      await expect(page.getByTestId('save-project')).toBeEnabled()
      assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented }), true)
      await rename(page, '失败后继续编辑')
      await setMode(page, 'closeMode', 'ready')
      await close(page)
      await expect(dialog(page)).toContainText('失败后继续编辑')
      await dialog(page).getByRole('button', { name: '全部关闭', exact: true }).click()
      await expect.poll(() => calls(page, 'close_native_window')).toBe(2)
      await finish()
      console.log('PASS 原生退出失败重置关闭状态，保留未保存保护并可继续编辑和重试')
    }
    {
      const { page, finish } = await fixture(browser, url)
      const protections = [
        ['screenshotBusy', true, '截屏'], ['speechWorking', true, '文字配音'], ['recording', true, '录制'],
        ['recoveryRecordings', [{ id: 'recovery', name: '待保存录制', blob: null }], '录制'],
        ['pendingMedia', 1, '素材导入'], ['imageConverting', true, '媒体转换'],
        ['videoConverting', true, '媒体转换'], ['gifConverting', true, '媒体转换'], ['browserExporting', true, '导出'],
        ['busy', '正在导入', '当前操作'],
      ]
      for (const [key, value, message] of protections) {
        await page.evaluate(({ key, value }) => { document.querySelector('#app').__vue_app__._instance.setupState[key] = value }, { key, value })
        await close(page)
        await expect(page.locator('.app-error').first()).toContainText(message)
        await checkNoExit(page)
        await expect(dialog(page)).toHaveCount(0)
        await page.evaluate(key => {
          const state = document.querySelector('#app').__vue_app__._instance.setupState
          state[key] = key === 'recoveryRecordings' ? [] : key === 'pendingMedia' ? 0 : key === 'busy' ? '' : false
          state.view = 'edit'; state.jobsOpen = false
        }, key)
      }
      await setMode(page, 'jobs', [{ id: 'running', name: '后台导出', state: 'running', progress: 0.3 }])
      await close(page)
      await expect(page.getByRole('dialog', { name: '处理任务', exact: true })).toBeVisible()
      await checkNoExit(page)
      await setMode(page, 'jobs', [])
      await page.getByRole('button', { name: '关闭任务', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('#app').__vue_app__._instance.setupState.runningJobs === 0)
      await setMode(page, 'jobsMode', 'fail')
      await close(page)
      await expect(page.locator('.app-error').first()).toContainText('无法检查正在处理的任务')
      await checkNoExit(page)
      await setMode(page, 'jobsMode', 'ready')
      await close(page)
      await expect.poll(() => calls(page, 'close_native_window')).toBe(1)
      await expect(dialog(page)).toHaveCount(0)
      await finish()
      console.log('PASS 截屏、配音、录制恢复、素材导入、转换、导出和任务状态失败均阻止退出；无修改时直接关闭')
    }
  } finally { await browser?.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
