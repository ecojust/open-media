// Capture current application UI with a real, locally stored demonstration project.
// Desktop IPC is simulated only for window appearance and an inactive MCP configuration.
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '..')
const port = Number(process.env.SCREENSHOT_PORT || 5241)
const base = `http://127.0.0.1:${port}`
const output = path.join(root, 'docs/screenshots')

async function desktop(page) {
  await page.addInitScript(() => {
    localStorage.setItem('open-media:theme', 'dark')
    localStorage.setItem('open-media:autosave', 'false')
    const callbacks = new Map(), listeners = new Map(); let next = 1
    const status = { running: false, host: '127.0.0.1', port: 39861, url: null, pendingRequests: 0, connectedClients: 0 }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) { listeners.delete(id) } }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback) { const id = next++; callbacks.set(id, callback); return id },
      unregisterCallback(id) { callbacks.delete(id) }, convertFileSrc: value => value,
      invoke: async (command, args = {}) => {
        if (command === 'get_desktop_platform') return 'macos'
        if (command === 'plugin:event|listen') { const id = next++; listeners.set(id, args); return id }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null }
        if (command.includes('set_theme') || command.includes('set_background_color') || command.includes('set_webview_background_color')) return null
        if (command === 'configure_screenshot_shortcut') return args.shortcut
        if (command === 'get_media_jobs' || command === 'list_video_generation_jobs' || command === 'mcp_pending') return []
        if (command === 'ai_get_status') return { models: [], jobs: [], busy: false }
        if (command === 'get_video_generation_status') return { supported: false, runtimeReady: false, models: [] }
        if (command === 'get_runtime_status') return { ready: false }
        if (command === 'list_stored_videos') return { directory: '/example/recordings', assets: [], warnings: [] }
        if (command === 'mcp_get_config') return { host: '127.0.0.1', port: 39861, token: 'example-token-replace-with-your-local-token' }
        if (command === 'mcp_get_status' || command === 'mcp_stop') return status
        throw new Error(`Screenshot does not implement desktop operation: ${command}`)
      },
    }
  })
}

async function seedProject(page) {
  return page.evaluate(async () => {
    const { createProject, createTrack, createClip, createTextClip, validateProject } = await import('/src/core/project.ts')
    const { importMediaFile } = await import('/src/core/media-import.ts')
    const { saveProject } = await import('/src/core/storage.ts')
    const { VIDEO_SEGMENTS } = await import('/src/core/video-segment-catalog.ts')
    const { BACKGROUND_MUSIC } = await import('/src/core/background-music-catalog.ts')
    const { TRANSITION_SOUNDS } = await import('/src/core/transition-sound-catalog.ts')
    const { addTransition } = await import('/src/core/transitions.ts')
    const { addTransitionSound, findTransitionSoundCut } = await import('/src/core/transition-sound-track.ts')
    const blobs = new Map()
    async function asset(url, name, type) {
      const blob = await (await fetch(url)).blob()
      const item = await importMediaFile(new File([blob], name, { type }))
      item.addedAt = new Date().toISOString(); item.url = new URL(url, location.href).href; item.nativePath = item.url; blobs.set(item.id, blob); return item
    }
    const ids = ['science-orbital-atlas', 'science-spectrum-lab', 'science-molecular-chain', 'science-blueprint-launch', 'science-data-field', 'science-terrain-observer']
    const names = ['轨道与引力', '光谱实验', '分子世界', '工程蓝图', '数据流动', '地形观测']
    const videos = []
    for (let index = 0; index < ids.length; index++) {
      const source = VIDEO_SEGMENTS.find(item => item.id === ids[index])
      videos.push(await asset(source.url, `${String(index + 1).padStart(2, '0')} ${names[index]}.webm`, 'video/webm'))
    }
    const musicSource = BACKGROUND_MUSIC.find(item => item.id === 'stellar-drift')
    const music = await asset(musicSource.url, '星际漂流 · 环境氛围.mp3', 'audio/mpeg'); music.libraryRole = 'background-music'
    const sounds = []
    for (const id of ['air-sweep', 'sparkle', 'glitch']) {
      const source = TRANSITION_SOUNDS.find(item => item.id === id)
      const item = await asset(source.url, `${source.title}.wav`, 'audio/wav'); item.libraryRole = 'transition-sound'
      sounds.push({ item, source })
    }
    let project = createProject('科学之美 · 从轨道到微观', { width: 1920, height: 1080, fps: 30 })
    project.assets = [...videos, music]
    const title = createTrack('text', '章节标题'), label = createTrack('text', '知识标签'), subtitle = createTrack('text', '讲解字幕')
    const detail = createTrack('video', '细节画中画'), main = createTrack('video', '主画面'), score = createTrack('audio', '背景音乐')
    project.tracks = [title, label, subtitle, detail, main, score]
    for (let i = 0; i < 8; i++) {
      const video = videos[[0, 0, 1, 2, 3, 4, 5, 0][i]]
      main.clips.push(createClip(video, project, { id: `demo-main-${i}`, name: ['序章 · 仰望星空', '轨道与引力', '光谱的秘密', '微观结构', '工程之美', '数据的形状', '地貌与时间', '尾声 · 继续探索'][i], start: i * 5, trimOut: 5, volume: 0 }))
    }
    const headings = ['看见宇宙的秩序', '探索微观的结构', '让数据讲述故事', '每一次发现，都是新的开始']
    for (let i = 0; i < 4; i++) title.clips.push(createTextClip(project, { id: `demo-title-${i}`, textRole: 'watermark', name: headings[i], text: headings[i], start: i * 10, trimOut: 9.6, x: 110, y: 310, width: 1520, height: 150, fontSize: 100, fontWeight: 700, textAlign: 'left', color: '#f0f7ff', fadeIn: .5, fadeOut: .4 }))
    for (let i = 0; i < 8; i++) label.clips.push(createTextClip(project, { name: `章节 ${String(i + 1).padStart(2, '0')}`, text: `${String(i + 1).padStart(2, '0')} / ${names[[0, 0, 1, 2, 3, 4, 5, 0][i]]}    ·    SCIENCE NOTES`, textRole: 'watermark', start: i * 5, trimOut: 4.8, x: 112, y: 204, width: 1500, height: 66, fontSize: 32, fontWeight: 500, textAlign: 'left', color: '#83d5e2', fadeIn: .2, fadeOut: .2 }))
    const captions = ['从一条轨迹，发现自然的规律。', '微小的引力，描绘宏大的宇宙。', '让看不见的光，成为可理解的色彩。', '在微观尺度，寻找生命的答案。', '用结构连接想象与现实。', '数据有形，知识有光。', '地貌记录着时间的痕迹。', '保持好奇，探索永不停止。']
    for (let i = 0; i < captions.length; i++) subtitle.clips.push(createTextClip(project, { id: `demo-subtitle-${i}`, name: captions[i], text: captions[i], start: i * 5 + .3, trimOut: 4.4, x: 140, y: 916, width: 1640, height: 90, fontSize: 39, fontWeight: 500, background: '#132333', fadeIn: .15, fadeOut: .2 }))
    detail.clips.push(createClip(videos[2], project, { name: '分子细节', start: 12, trimOut: 4, x: 1390, y: 655, width: 430, height: 242, opacity: .92, fadeIn: .3, fadeOut: .3, volume: 0 }), createClip(videos[4], project, { name: '数据细节', start: 26, trimOut: 4, x: 1390, y: 655, width: 430, height: 242, opacity: .92, fadeIn: .3, fadeOut: .3, volume: 0 }))
    score.clips.push(createClip(music, project, { name: '星际漂流 · 配乐', trimOut: 40, volume: .22, fadeIn: 1.2, fadeOut: 2 }))
    for (let i = 1; i < 8; i++) project = addTransition(project, i * 5, ['zoom-fade', 'fragment-burst', 'glitch-slices', 'iris', 'pixel-wave', 'slice-stagger', 'defocus'][i - 1], .8)
    for (let i = 1; i < 8; i++) { const { item, source } = sounds[(i - 1) % sounds.length]; project = addTransitionSound(project, item, findTransitionSoundCut(project, i * 5), source.anchor).project }
    const transition = project.tracks.find(track => track.kind === 'transition')
    project.tracks = [...project.tracks.filter(track => track !== transition && track.name !== '背景音乐' && track.name !== '转场音效'), transition, ...project.tracks.filter(track => track.name === '转场音效'), ...project.tracks.filter(track => track.name === '背景音乐')]
    project.markers = [0,10,20,30].map((time,i) => ({id:`chapter-${i}`,time,label:['宇宙秩序','微观结构','数据之美','继续探索'][i],kind:'chapter',color:'#6baed6'}))
    project = validateProject(project, { trusted: true })
    await saveProject(project, blobs); localStorage.setItem('open-media:last-project', project.id)
    return { title: project.title, assets: project.assets.length, tracks: project.tracks.length, clips: project.tracks.reduce((sum,track) => sum + track.clips.length, 0), duration: 40 }
  })
}

async function main() {
  const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' })
  let browser
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).ok) break } catch {} await new Promise(resolve => setTimeout(resolve, 100)) }
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
    const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 })
    page.setDefaultTimeout(20000); page.on('pageerror', error => console.error(error.message))
    await desktop(page); await page.goto(base); await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 30000 })
    const project = await seedProject(page); console.log(JSON.stringify(project))
    await page.reload(); await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 30000 }); await page.getByTestId('nav-edit').click()
    await expect(page.getByTestId('video-editor')).toBeVisible({ timeout: 30000 }); await expect(page.locator('.project-title')).toHaveText(project.title)
    await page.getByRole('button', { name: '已导入', exact: true }).click()
    await page.getByTitle('适应全部片段', { exact: true }).click()
    const divider = page.getByTestId('timeline-divider'); const bounds = await divider.boundingBox()
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 4); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 105, { steps: 10 }); await page.mouse.up()
    await page.locator('[data-clip-id="demo-main-1"]').click()
    await page.evaluate(() => {
      let instance = document.querySelector('[data-testid="video-editor"]').__vueParentComponent
      while (instance && !instance.exposed?.seek) instance = instance.parent
      window.screenshotEditor = instance.exposed; instance.exposed.seek(7.2)
    })
    await page.waitForTimeout(1200)
    await fs.mkdir(output, { recursive: true })
    for (const theme of ['light', 'dark']) {
      await page.getByTestId(`theme-${theme}`).click(); await page.mouse.move(1670, 1040); await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(output, `editor-${theme}.png`) })
      await page.getByTestId('transition-open').click(); await page.getByTestId('transition-sound-tab').click()
      await page.locator('[data-sound-id="sparkle"] .sound-choice').click(); await expect(page.getByTestId('transition-sound-item')).toHaveCount(10)
      await page.mouse.move(1670, 1040); await page.screenshot({ path: path.join(output, `transition-sounds-${theme}.png`) }); await page.keyboard.press('Escape')
      await page.getByTestId('editor-mcp-open').click(); await expect(page.getByLabel('MCP 连接地址')).toHaveValue('http://127.0.0.1:39861/mcp')
      await page.mouse.move(1670, 1040); await page.screenshot({ path: path.join(output, `mcp-${theme}.png`) }); await page.keyboard.press('Escape')
    }
  } finally { await browser?.close(); server.kill() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
