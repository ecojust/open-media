const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { chromium, expect } = require('@playwright/test')
const { zipSync, strToU8 } = require('fflate')

const title = page => page.locator('.project-title')
const renameField = page => page.getByLabel('项目名称', { exact: true })

async function checks(browser, url, native) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(15000)
  page.on('pageerror', cause => errors.push(cause.message))
  try {
    await page.addInitScript(native => {
      localStorage.setItem('open-media:autosave', 'true')
      const fixture = window.titleFixture = { project: null, fileName: 'selected.omedia', cancelOpen: false, opens: 0, saved: null }
      if (native) window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: path => path,
        invoke: async (command, args) => {
          const managed = JSON.parse(localStorage.getItem('fixture:managed-projects') || '{}')
          if (command === 'ensure_project_media') { if(args.assets.length) throw new Error('名称测试仅使用空工程'); return { directory: `/projects/${args.projectId}`, assets: [] } }
          if (command === 'save_managed_project') { managed[args.project.id] = { project: structuredClone(args.project), duration: args.duration }; localStorage.setItem('fixture:managed-projects',JSON.stringify(managed)); return { directory:`/projects/${args.project.id}`, savedAt:new Date().toISOString() } }
          if (command === 'list_managed_projects') return Object.values(managed).map(({project,duration}) => ({id:project.id,title:project.title,width:project.width,height:project.height,updatedAt:project.updatedAt,assetCount:project.assets.length,duration}))
          if (command === 'load_managed_project') return managed[args.projectId].project
          if (command === 'get_desktop_platform') return 'macos'
          if (command === 'get_runtime_status') return { ready: true, version: 'fixture', source: 'bundled' }
          if (command === 'get_media_jobs' || command === 'mcp_pending') return []
          if (command === 'ai_get_status') return { models: [], jobs: [], busy: false }
          if (command === 'list_stored_videos') return { directory: '/recordings', assets: [], warnings: [] }
          if (command === 'configure_screenshot_shortcut') return args.shortcut
          if (command === 'mcp_get_status') return { running: false, host: '127.0.0.1', port: 39861, url: null, pendingRequests: 0, connectedClients: 0 }
          if (command === 'plugin:event|listen') return 1
          if (command === 'plugin:event|unlisten' || command === 'complete_project_archive_import') return null
          if (command === 'open_project_archive') {
            fixture.opens++
            if (fixture.cancelOpen) return null
            return { name: fixture.fileName, path: `/projects/${fixture.fileName}`, token: 'fixture-project-target', project: structuredClone(fixture.project) }
          }
          if (command === 'save_project_archive') {
            fixture.saved = structuredClone(args.project)
            return { name: fixture.fileName, path: `/projects/${fixture.fileName}`, token: 'fixture-project-target' }
          }
          throw new Error(`Unexpected title fixture command: ${command}`)
        },
      }
      else {
        window.showOpenFilePicker = async () => {
          fixture.opens++
          if (fixture.cancelOpen) throw new DOMException('已取消', 'AbortError')
          return [await (await navigator.storage.getDirectory()).getFileHandle(fixture.fileName)]
        }
        window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle(fixture.fileName, { create: true })
      }
    }, native)
    await page.goto(url)
    await expect(page.getByTestId('create-project')).toBeEnabled()
    await page.getByTestId('nav-edit').click()
    const projects = await page.evaluate(async () => {
      const { createProject } = await import('/src/core/project.ts')
      const first = createProject('工程甲'), second = createProject('工程乙')
      return [first, second, { ...second, title: '相同 ID 的工程丙' }]
    })
    const select = async (project, fileName = 'selected.omedia') => {
      await page.evaluate(({ project, fileName }) => { window.titleFixture.project = project; window.titleFixture.fileName = fileName }, { project, fileName })
      if (!native) {
        const archive = zipSync({ 'project.json': strToU8(JSON.stringify({ format: 'open-media-project', version: 1, project })) }, { level: 0 })
        await page.evaluate(async ({ bytes, fileName }) => {
          const handle = await (await navigator.storage.getDirectory()).getFileHandle(fileName, { create: true })
          const writable = await handle.createWritable(); await writable.write(new Uint8Array(bytes)); await writable.close()
        }, { bytes: [...archive], fileName })
      }
    }
    const open = async project => {
      await select(project)
      await page.getByTestId('open-project').click()
      await expect(title(page)).toHaveText(project.title)
      await expect(page.getByTestId('open-project')).toBeEnabled()
    }
    await open(projects[0])
    await title(page).click()
    await renameField(page).fill('工程甲仍在输入的名称')
    await select(projects[1])
    await renameField(page).press('Control+o')
    await expect(title(page)).toHaveText('工程乙')
    await expect(renameField(page)).toHaveCount(0)
    await expect(page.getByTestId('open-project')).toBeEnabled()
    await page.locator('.timeline-footer').click()
    await expect(title(page)).toHaveText('工程乙')
    const oldDraftTitle = await page.evaluate(async ({id,native}) => {
      if(native) return (await (await import('/src/native-project-library.ts')).loadManagedProject(id)).title
      const { loadProject } = await import('/src/core/storage.ts')
      const draft = await loadProject(id)
      try { return draft.project.title } finally { draft.revoke() }
    }, {id:projects[0].id,native})
    assert.equal(oldDraftTitle, '工程甲仍在输入的名称', '切换前的名称输入属于原工程并应保留在其草稿中')
    console.log(`PASS ${native ? '桌面' : '网页'} Ctrl+O 提交当前工程名称，打开后标题同步且旧输入失焦不会改写新工程`)

    await title(page).click()
    await renameField(page).fill('工程乙待提交的旧输入')
    await select(projects[2])
    await renameField(page).press('Control+o')
    await expect(title(page)).toHaveText('相同 ID 的工程丙')
    await expect(renameField(page)).toHaveCount(0)
    await page.locator('.timeline-footer').click()
    await expect(title(page)).toHaveText('相同 ID 的工程丙')
    console.log(`PASS ${native ? '桌面' : '网页'} 相同工程 ID 重新打开仍更新名称，文件名不会覆盖工程内部名称`)

    await title(page).click()
    await renameField(page).fill('保存快捷键提交的新名称')
    await renameField(page).press('Control+s')
    await expect(title(page)).toHaveText('保存快捷键提交的新名称')
    await expect(page.locator('.status-main')).toContainText('项目已保存')
    await expect(page.getByTestId('save-project')).toBeEnabled()
    const savedTitle = await page.evaluate(async native => {
      if (native) return window.titleFixture.saved.title
      const { importProjectFile } = await import('/src/core/project-file.ts')
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle('selected.omedia')).getFile()
      const imported = await importProjectFile(file)
      try { return imported.project.title } finally { imported.revoke() }
    }, native)
    assert.equal(savedTitle, '保存快捷键提交的新名称')
    console.log(`PASS ${native ? '桌面' : '网页'} Ctrl+S 保存当前未失焦的工程名称，显示与保存内容一致`)

    await title(page).click()
    await renameField(page).fill('不应写入新工程的旧名称')
    const staleInput = await renameField(page).elementHandle()
    await page.evaluate(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState
      await app.adoptProject({ ...app.project, title: '替换工程后的实际名称' })
    })
    await expect(title(page)).toHaveText('替换工程后的实际名称')
    await expect(renameField(page)).toHaveCount(0)
    await staleInput.evaluate(input => input.dispatchEvent(new FocusEvent('blur')))
    await expect(title(page)).toHaveText('替换工程后的实际名称')
    console.log(`PASS ${native ? '桌面' : '网页'} 工程替换主动关闭旧名称输入，延迟失焦不会重命名新工程`)

    for (const [storedTitle, fileName, expectedTitle] of [
      ['未命名项目', '秋季产品演示.omedia', '秋季产品演示'],
      ['', '空白名称恢复.omedia', '空白名称恢复'],
      ['   ', '演示.最终版本.OMEDIA', '演示.最终版本'],
    ]) {
      await select({ ...projects[0], title: storedTitle }, fileName)
      await page.getByTestId('open-project').click()
      await expect(title(page)).toHaveText(expectedTitle)
      await expect(page.getByTestId('open-project')).toBeEnabled()
      await expect(title(page).locator('i')).toHaveCount(0)
      await page.getByTestId('save-project').click()
      await expect(page.getByTestId('save-project')).toBeEnabled()
      const saved = await page.evaluate(async native => {
        if (native) return window.titleFixture.saved.title
        const { importProjectFile } = await import('/src/core/project-file.ts')
        const file = await (await (await navigator.storage.getDirectory()).getFileHandle(window.titleFixture.fileName)).getFile()
        const imported = await importProjectFile(file)
        try { return imported.project.title } finally { imported.revoke() }
      }, native)
      assert.equal(saved, expectedTitle, '文件名回填后，保存内容应保留实际工程名称')
    }
    console.log(`PASS ${native ? '桌面' : '网页'} 默认及空白名称按文件名恢复，不产生未保存提示，并写回工程内容`)

    await page.evaluate(async native => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState
      const { createProject } = await import('/src/core/project.ts')
      const { saveProject } = await import('/src/core/storage.ts')
      const { storeProjectSaveTarget } = await import('/src/core/project-save-targets.ts')
      const project = createProject(), fileName = '历史草稿的文件名称.omedia'
      const target = native ? { kind: 'native', target: { name: fileName, path: `/projects/${fileName}`, token: 'fixture-draft-target' } }
        : { kind: 'browser', handle: await (await navigator.storage.getDirectory()).getFileHandle(fileName, { create: true }) }
      if(native) { const {prepareProjectMedia,saveManagedProject} = await import('/src/native-project-library.ts'); await saveManagedProject(await prepareProjectMedia(project)) } else await saveProject(project)
      await storeProjectSaveTarget(project.id, target)
      await app.refreshRecent()
      app.view = 'home'
    }, native)
    await page.locator('.recent-item > button').filter({ hasText: '未命名项目' }).click()
    await expect(title(page)).toHaveText('历史草稿的文件名称')
    await expect(title(page).locator('i')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('create-project')).toBeEnabled()
    await page.getByTestId('nav-edit').click()
    await expect(title(page)).toHaveText('历史草稿的文件名称')
    await expect(title(page).locator('i')).toHaveCount(0)
    await page.getByTestId('new-project').click()
    await expect(title(page)).toHaveText('未命名项目')
    console.log(`PASS ${native ? '桌面' : '网页'} 最近项目和启动恢复使用已记住的文件名，新建未保存工程仍保留默认名`)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
  try {
    const url = `http://127.0.0.1:${server.httpServer.address().port}`
    await checks(browser, url, true)
    await checks(browser, url, false)
  } finally { await browser.close(); await server.close() }
}
main().catch(cause => { console.error(cause); process.exitCode = 1 })
