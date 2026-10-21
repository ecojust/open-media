const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

async function mount(page, url) {
  await page.route('**/__motion_style__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app,.app-shell{height:100%;margin:0}*{box-sizing:border-box}.fixture-workspace{height:100%;display:flex;flex-direction:column;background:var(--ui-bg);color:var(--ui-text)}.fixture-heading{display:flex;align-items:center;gap:14px;min-height:52px;padding:0 20px;border-bottom:1px solid var(--ui-line);font:13px sans-serif}.fixture-heading strong{font-size:15px}.fixture-heading span{opacity:.65}.fixture-workspace>.video-editor{flex:1;min-height:0}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${url}/__motion_style__`)
  await page.evaluate(async () => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/McpPanel.vue')).text()
    const vueURL = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h, shallowRef, ref, nextTick } = await import(vueURL)
    const { createProject, createClip, createTextClip, createTrack, validateProject } = await import('/src/core/project.ts')
    const { addTransition } = await import('/src/core/transitions.ts')
    const { normalizeMcpMotion, getMcpMotionBrief } = await import('/src/core/mcp-motion.ts')
    const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
    const { BACKGROUND_MUSIC } = await import('/src/core/background-music-catalog.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const videoBytes = await (await fetch(VIDEO_SEGMENTS[0].url)).blob()
    const video = await importMediaFile(new File([videoBytes], '产品演示.webm', { type: 'video/webm' })); video.id = 'source-video'
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
    const ctx = canvas.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, 640, 360)
    gradient.addColorStop(0, '#5299c9'); gradient.addColorStop(1, '#d3e6bb'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 360)
    ctx.fillStyle = '#18364b'; ctx.font = 'bold 48px sans-serif'; ctx.fillText('OPEN MEDIA', 80, 185)
    const photoBytes = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const photo = await importMediaFile(new File([photoBytes], '封面图片.png', { type: 'image/png' })); photo.id = 'source-photo'
    const musicBytes = await (await fetch(BACKGROUND_MUSIC[0].url)).blob()
    const music = await importMediaFile(new File([musicBytes], '柔和配乐.mp3', { type: 'audio/mpeg' })); music.id = 'source-music'
    const fixture = window.motionStyle = { current: shallowRef(createProject()), editor: ref(), theme: ref('dark'), native: ref(false), open: ref(false), editingBusy: ref(false), jobs: ref([]), events: [], calls: [], toolCalls: [], captures: 0, imports: 0, commits: 0, pendingRequests: 0, connectedClients: 1, running: true, config: { host: '127.0.0.1', port: 39861, token: 'example-local-access-token' } }
    const commit = next => { fixture.current.value = validateProject(next, { trusted: true }); fixture.commits++ }
    fixture.motionChange = config => { const next = JSON.parse(JSON.stringify(fixture.current.value)); next.mcpMotion = normalizeMcpMotion(config); commit(next); fixture.events.push(JSON.parse(JSON.stringify(config))) }
    fixture.brief = () => getMcpMotionBrief(fixture.current.value)
    fixture.empty = () => { fixture.current.value = createProject('新的空白工程', { width: 640, height: 360, fps: 24 }) }
    fixture.populate = async () => {
      let project = createProject('产品故事 · 素材二创', { width: 640, height: 360, fps: 24 })
      project.assets.push(video, photo, music)
      project.assets.push({ ...photo, id: 'hidden-bundled-art', name: '内部包装图层', libraryRole: 'motion-style' })
      const titleTrack = createTrack('text', '章节标题')
      for (let index = 0; index < 10; index++) {
        project.tracks.find(track => track.kind === 'video').clips.push(createClip(video, project, { id: `video-${index}`, name: ['开篇展示', '操作演示', '局部特写'][index % 3], start: index * 2, trimOut: 2 }))
        project.tracks.find(track => track.kind === 'text').clips.push(createTextClip(project, { id: `caption-${index}`, text: ['用素材讲述一个故事', '把复杂的步骤讲清楚', '从细节到完整的表达'][index % 3], name: `讲解字幕 ${index + 1}`, start: index * 2, trimOut: 2, fontSize: 22, y: 285, height: 45, background: '#162134', fadeIn: .15, fadeOut: .15 }))
        if (index % 2 === 0) titleTrack.clips.push(createTextClip(project, { id: `title-${index}`, text: ['01 创作起点', '02 细节表达', '03 画面节奏'][index / 2 % 3], name: `章节标题 ${index / 2 + 1}`, start: index * 2, trimOut: 3, textRole: 'watermark', fontSize: 30, y: 25, height: 45, textAlign: 'left' }))
      }
      project.tracks.unshift(titleTrack)
      project.tracks.find(track => track.kind === 'audio').clips.push(createClip(music, project, { name: '轻快背景音乐', trimOut: 20, volume: .2 }))
      project.markers = [{ id: 'chapter-one', time: 0, label: '开篇', kind: 'chapter', color: '#55bbc5' }, { id: 'chapter-two', time: 8, label: '细节', kind: 'chapter', color: '#a99cf0' }]
      project = addTransition(project, 4, 'zoom-fade', .8)
      project = addTransition(project, 8, 'fragment-burst', .8)
      project = addTransition(project, 12, 'slide-left', .8)
      fixture.current.value = validateProject(project, { trusted: true }); await nextTick(); await fixture.editor.value.setPlayback({ time: 1 })
    }
    fixture.addSources = () => {
      const next = JSON.parse(JSON.stringify(fixture.current.value))
      for (let index = 1; index <= 16; index++) next.assets.push({ ...photo, id: `extra-${index}`, name: `演示画面 ${String(index).padStart(2, '0')}.png` })
      commit(next)
    }
    fixture.removeSource = id => { const next = JSON.parse(JSON.stringify(fixture.current.value)); next.assets = next.assets.filter(asset => asset.id !== id); commit(next) }
    navigator.mediaDevices.getUserMedia = async () => { fixture.captures++; throw new Error('This configuration test must not capture media') }
    const Editor = (await import('/src/components/VideoEditor.vue')).default
    const Panel = (await import('/src/components/McpPanel.vue')).default
    fixture.app = createApp({ render: () => h('div', { class: 'app-shell fixture-workspace', 'data-theme': fixture.theme.value }, [
      h('header', { class: 'fixture-heading' }, [h('strong', 'Open Media'), h('span', fixture.current.value.title)]),
      h(Editor, { ref: fixture.editor, project: fixture.current.value, runTool: async (...args) => { fixture.toolCalls.push(args); throw new Error('Configuration must never generate media') }, onChange: commit, onOpenMcp: () => { fixture.open.value = true }, onImport: () => fixture.imports++, mcpConnected: true }),
      h(Panel, { open: fixture.open.value, native: fixture.native.value, project: fixture.current.value, editingBusy: fixture.editingBusy.value, jobs: fixture.jobs.value, onClose: () => { fixture.open.value = false }, onMotionChange: fixture.motionChange }),
    ]) })
    fixture.app.mount('#app')
    // Only the MCP service bridge is simulated. Sources and the editor preview
    // are real media; this suite verifies configuration and never renders output.
    window.__TAURI_INTERNALS__ = { invoke: async command => {
      fixture.calls.push(command)
      if (command === 'mcp_get_config') return { ...fixture.config }
      if (command === 'mcp_get_status') return { running: fixture.running, host: fixture.config.host, port: fixture.config.port, url: fixture.running ? 'http://127.0.0.1:39861/mcp' : null, pendingRequests: fixture.pendingRequests, connectedClients: fixture.connectedClients }
      throw new Error(`Unexpected native operation: ${command}`)
    } }
    fixture.native.value = true
  })
}

async function main() {
  const output = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'motion-style') : '/tmp/open-media-motion-style'
  fs.mkdirSync(output, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }), errors = []
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000)
    await mount(page, `http://127.0.0.1:${server.httpServer.address().port}`)
    await expect(page.getByTestId('motion-style-open')).toHaveCount(0)
    await expect(page.getByTestId('effect-clip-panel')).toHaveCount(0)
    await expect(page.getByTestId('asset-effect-selection-open')).toHaveCount(0)
    await page.getByTestId('editor-mcp-open').click()
    const dialog = page.getByRole('dialog', { name: 'MCP 服务', exact: true }), section = page.getByTestId('mcp-motion-config')
    const toggle = section.getByRole('switch', { name: '素材二创', exact: true })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(toggle).toBeEnabled()
    await expect(section.locator('[data-motion-style-id]')).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.motionStyle.current.value.mcpMotion), undefined, '打开配置不能写入工程')
    await toggle.click()
    await expect(section).toContainText('需先在工程导入素材')
    await expect(section.locator('[data-motion-style-id]')).toHaveCount(15)
    await expect(section.locator('input[type=file]')).toHaveCount(0)
    await expect(section.getByRole('button', { name: /生成|导入/ })).toHaveCount(0)
    await expect(section).toContainText('由外部 Agent 读取配置并编排、生成与剪辑')
    await section.getByRole('button', { name: '柔光立体', exact: true }).click()
    await expect(section).toContainText('不包含真实三维建模或物理模拟')
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible(); await expect(page.getByTestId('editor-mcp-open')).toBeFocused()
    console.log('PASS MCP默认关闭、空工程指引、15风格；界面仅配置，无导入/生成入口')

    await page.evaluate(() => window.motionStyle.populate())
    const card = id => page.locator(`[data-source-asset-id="${id}"]`)
    await card('source-video').click({ button: 'right' })
    await expect(page.getByRole('menu', { name: '素材操作', exact: true })).not.toContainText('生成效果片段')
    await page.keyboard.press('Escape')
    await page.locator('.timeline-clip[data-clip-id="video-0"]').click({ button: 'right' })
    await expect(page.getByRole('menu', { name: '片段操作', exact: true })).not.toContainText('生成效果片段')
    await page.keyboard.press('Escape')
    await expect(card('source-video')).not.toHaveAttribute('aria-pressed', /./)
    await page.getByTestId('editor-mcp-open').click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    const source = id => section.locator(`[data-motion-asset-id="${id}"]`)
    await expect(section.getByRole('checkbox')).toHaveCount(2)
    await expect(section).not.toContainText('柔和配乐.mp3')
    await expect(section).not.toContainText('内部包装图层')
    const snapshot = await page.evaluate(() => JSON.parse(JSON.stringify(window.motionStyle.current.value)))
    await source('source-video').click(); await source('source-photo').click()
    await section.getByRole('button', { name: '科技视窗', exact: true }).click()
    const prompt = section.getByLabel('二创创作要求')
    await prompt.fill('用这两份素材制作产品故事，突出操作步骤与最终效果。\n标题简洁，保持清晰的讲解节奏。')
    await expect(section).toContainText('配置已就绪，请在连接的 Agent 中发起二创任务')
    const configured = await page.evaluate(() => ({ project: JSON.parse(JSON.stringify(window.motionStyle.current.value)), brief: window.motionStyle.brief(), tools: window.motionStyle.toolCalls }))
    assert.deepEqual(configured.project.assets, snapshot.assets); assert.deepEqual(configured.project.tracks, snapshot.tracks)
    assert.deepEqual(configured.project.mcpMotion.assetIds, ['source-video', 'source-photo']); assert.equal(configured.project.mcpMotion.styleId, 'tech-hud')
    assert.equal(configured.brief.ready, true); assert.equal(configured.tools.length, 0)
    await prompt.press('End'); await prompt.press('Space'); await prompt.press('Space')
    assert.ok((await page.evaluate(() => window.motionStyle.current.value.mcpMotion.prompt)).endsWith('  '), '自动保存保留输入中的空格')
    await prompt.fill('以现有演示视频和封面图片制作 20 秒介绍，突出操作步骤与最终效果。\n科技感画面，标题简洁，节奏清晰。')
    await dialog.locator('.editor-dialog-content').evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: path.join(output, 'mcp-motion-config-dark.png'), fullPage: true })
    await page.evaluate(() => { window.motionStyle.theme.value = 'light' })
    await page.screenshot({ path: path.join(output, 'mcp-motion-config-light.png'), fullPage: true })
    console.log('PASS 当前工程视觉素材选择、完整配置即时保存；未触发生成，不改源素材与时间线')

    await page.getByRole('button', { name: '关闭MCP 服务', exact: true }).click()
    await page.getByTestId('editor-mcp-open').click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(source('source-video')).toHaveAttribute('aria-checked', 'true')
    await expect(section.getByRole('button', { name: '科技视窗', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => { window.motionStyle.editingBusy.value = true })
    await expect(toggle).toBeDisabled(); await expect(source('source-photo')).toBeDisabled(); await expect(prompt).toBeDisabled()
    await expect(section).toContainText('正在处理任务')
    await page.evaluate(() => { window.motionStyle.editingBusy.value = false; window.motionStyle.jobs.value = [{ id: 'motion-job', name: '素材二创', state: 'running' }] })
    await expect(toggle).toBeDisabled(); await expect(section.getByRole('button', { name: '纸感手绘', exact: true })).toBeDisabled()
    await page.evaluate(() => { window.motionStyle.jobs.value = [{ id: 'motion-job', name: '素材二创', state: 'completed' }]; window.motionStyle.pendingRequests = 1 })
    await expect.poll(() => page.evaluate(() => window.motionStyle.calls.filter(command => command === 'mcp_get_status').length)).toBeGreaterThan(1)
    await expect(toggle).toBeDisabled()
    await page.evaluate(() => { window.motionStyle.pendingRequests = 0 })
    await expect(toggle).toBeEnabled()
    const last = await page.evaluate(() => JSON.parse(JSON.stringify(window.motionStyle.current.value.mcpMotion)))
    await toggle.click()
    await expect(section.locator('[data-motion-style-id]')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.motionStyle.current.value.mcpMotion), { ...last, enabled: false })
    await toggle.click()
    await expect(source('source-video')).toHaveAttribute('aria-checked', 'true')
    console.log('PASS 关闭重开保持工程配置；本地/MCP任务与待执行请求期间禁止修改；关闭开关保留选择')

    await page.evaluate(() => window.motionStyle.addSources())
    for (let index = 1; index <= 14; index++) await source(`extra-${index}`).click()
    await expect(source('extra-15')).toBeDisabled(); await expect(section).toContainText('已达到 16 个素材上限')
    assert.equal(await page.evaluate(() => window.motionStyle.current.value.mcpMotion.assetIds.length), 16)
    await source('extra-14').click(); await expect(source('extra-15')).toBeEnabled()
    await section.getByLabel('筛选二创素材').fill('画面 15')
    await expect(section.getByRole('checkbox')).toHaveCount(1)
    await source('extra-15').click()
    await section.getByLabel('筛选二创素材').fill('')
    await page.evaluate(() => window.motionStyle.removeSource('extra-15'))
    await expect(section).toContainText('已从当前工程移除')
    await section.getByRole('button', { name: '清除失效选择', exact: true }).click()
    await expect(section.getByRole('button', { name: '清除失效选择', exact: true })).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.motionStyle.brief().ready), true)
    await page.setViewportSize({ width: 390, height: 740 })
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1), false)
    await prompt.scrollIntoViewIfNeeded(); await expect(prompt).toBeVisible()
    await page.screenshot({ path: path.join(output, 'mcp-motion-config-narrow.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect(page.getByRole('button', { name: '关闭MCP 服务', exact: true })).toBeInViewport()
    await page.evaluate(() => window.motionStyle.empty())
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click(); await expect(section).toContainText('需先在工程导入素材')
    assert.equal(await page.evaluate(() => window.motionStyle.current.value.mcpMotion.styleId), '')
    assert.equal(await page.evaluate(() => window.motionStyle.toolCalls.length), 0)
    assert.equal(await page.evaluate(() => window.motionStyle.captures), 0)
    assert.deepEqual(errors, [])
    console.log('PASS 16素材上限、搜索、失效选择修复、项目切换隔离、窄屏滚动，无媒体生成或设备采集')
    console.log(`截图：${output}`)
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
