const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

const currentId = page => page.evaluate(() => localStorage.getItem('open-media:last-project'))
const confirmation = page => page.getByRole('dialog', { name: '保留当前项目', exact: true })

async function rename(page, title) {
  await page.locator('.project-title').click()
  await page.getByLabel('项目名称', { exact: true }).fill(title)
  await page.getByLabel('项目名称', { exact: true }).press('Enter')
  await expect(page.locator('.project-title')).toHaveText(title)
}

async function readFile(page, name) {
  const bytes = await page.evaluate(async name => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle(name)
    return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())]
  }, name)
  return JSON.parse(strFromU8(unzipSync(new Uint8Array(bytes))['project.json'])).project
}

async function save(page) {
  await page.getByTestId('save-project').click()
  await expect(page.locator('.status-main')).toContainText('项目已保存')
  await expect(page.getByTestId('save-project')).toBeEnabled()
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(15000)
    await page.addInitScript(() => {
      localStorage.setItem('open-media:autosave', 'false')
      const state = window.newProjectIO = { name: 'original.omedia', choices: [], failDraft: false }
      window.showSaveFilePicker = async () => {
        state.choices.push(state.name)
        return (await navigator.storage.getDirectory()).getFileHandle(state.name, { create: true })
      }
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (state.failDraft && this.name === 'projects') {
          state.failDraft = false
          throw new DOMException('测试：草稿保存失败', 'QuotaExceededError')
        }
        return put.apply(this, args)
      }
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    await expect(page.getByTestId('create-project')).toBeEnabled()
    await expect(page.getByTestId('new-project')).toHaveCount(0)
    for (const workspace of ['record', 'gif', 'video', 'image']) {
      await page.getByTestId(`nav-${workspace}`).click()
      await expect(page.getByTestId('new-project')).toHaveCount(0)
    }
    await page.getByTestId('nav-edit').click()
    await expect(page.getByTestId('new-project')).toBeEnabled()
    await expect(page.locator('.project-file-actions > button').first()).toHaveAccessibleName('新建工程')
    await expect(page.getByTestId('new-project').locator('svg')).toHaveCount(1)
    assert.equal(await page.getByTestId('new-project').evaluate(element => element.nextElementSibling?.getAttribute('data-testid')), 'open-project')
    await page.getByTestId('new-project').click()
    await expect(page.locator('.project-title')).toHaveText('未命名项目')
    const originalId = await currentId(page)
    await rename(page, '需要保留的原工程')
    await page.getByRole('button', { name: '字幕', exact: true }).click()
    await page.getByLabel('字幕内容').fill('新建前编辑的字幕不能丢失')
    await page.getByTestId('new-project').click()
    await expect(confirmation(page)).toBeVisible()
    await confirmation(page).getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('.project-title')).toHaveText('需要保留的原工程')
    await expect(page.getByLabel('字幕内容')).toHaveValue('新建前编辑的字幕不能丢失')
    await expect(page.locator('.timeline-clip')).toHaveCount(1)
    assert.equal(await currentId(page), originalId)
    console.log('PASS 新建工程仅在剪辑工具栏打开左侧显示 SVG；取消新建保留原工程及刚输入的字幕')

    await page.evaluate(() => { window.newProjectIO.failDraft = true })
    await page.getByTestId('new-project').click()
    await confirmation(page).getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('本地存储空间不足，项目未覆盖')
    await expect(page.getByTestId('new-project')).toBeEnabled()
    assert.equal(await currentId(page), originalId)
    await expect(page.getByLabel('字幕内容')).toHaveValue('新建前编辑的字幕不能丢失')
    await page.getByTestId('new-project').click()
    await confirmation(page).getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(page.locator('.project-title')).toHaveText('未命名项目')
    await expect(page.locator('.timeline-clip')).toHaveCount(0)
    assert.notEqual(await currentId(page), originalId)
    const originalDraft = await page.evaluate(async id => {
      const { loadProject } = await import('/src/core/storage.ts')
      const draft = await loadProject(id)
      try { return draft.project } finally { draft.revoke() }
    }, originalId)
    assert.equal(originalDraft.title, '需要保留的原工程')
    assert.equal(originalDraft.tracks.find(track => track.kind === 'text').clips[0].text, '新建前编辑的字幕不能丢失')
    console.log('PASS 保存草稿失败阻止新建；重试成功后创建空工程，原工程和字幕完整保存在本地')

    await page.locator('.brand').click()
    await page.locator('.recent-item > button').filter({ hasText: '需要保留的原工程' }).click()
    await expect(page.locator('.project-title')).toHaveText('需要保留的原工程')
    await save(page)
    assert.equal((await readFile(page, 'original.omedia')).id, originalId)
    await page.getByTestId('new-project').click()
    await expect(page.locator('.project-title')).toHaveText('未命名项目')
    await expect(confirmation(page)).toHaveCount(0)
    const freshId = await currentId(page)
    assert.notEqual(freshId, originalId)
    await rename(page, '独立保存的新工程')
    await page.evaluate(() => { window.newProjectIO.name = 'fresh.omedia' })
    await save(page)
    assert.deepEqual(await page.evaluate(() => window.newProjectIO.choices), ['original.omedia', 'fresh.omedia'])
    assert.equal((await readFile(page, 'fresh.omedia')).id, freshId)
    const untouched = await readFile(page, 'original.omedia')
    assert.equal(untouched.id, originalId)
    assert.equal(untouched.title, '需要保留的原工程')
    assert.equal(untouched.tracks.find(track => track.kind === 'text').clips[0].text, '新建前编辑的字幕不能丢失')
    await page.locator('.brand').click()
    await page.locator('.recent-item > button').filter({ hasText: '需要保留的原工程' }).click()
    await expect(page.locator('.project-title')).toHaveText('需要保留的原工程')
    await rename(page, '返回原工程后直接保存')
    await save(page)
    assert.equal((await readFile(page, 'original.omedia')).title, '返回原工程后直接保存')
    assert.equal((await readFile(page, 'fresh.omedia')).title, '独立保存的新工程')
    assert.deepEqual(await page.evaluate(() => window.newProjectIO.choices), ['original.omedia', 'fresh.omedia'])
    assert.deepEqual(errors, [])
    console.log('PASS 保存后直接新建且保存位置隔离；切回旧工程恢复其原目标并直接覆盖，两个实际项目文件互不影响')
  } finally { await browser.close(); await server.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
