const assert = require('node:assert/strict')
const { existsSync, mkdirSync } = require('node:fs')
const { chromium, expect } = require('@playwright/test')
// Mount actual application workspaces and dialogs; no capture or production build is started.
const checks = []
async function inspect(page, label, min = 1) {
  const values = await page.locator('select:visible').evaluateAll(elements => elements.map(element => {
    const css = getComputedStyle(element)
    return { label: element.getAttribute('aria-label') || element.closest('label')?.textContent?.slice(0, 30), height: element.getBoundingClientRect().height, appearance: css.appearance, font: css.fontSize, top: css.paddingTop, bottom: css.paddingBottom, left: css.paddingLeft, right: css.paddingRight, radius: css.borderRadius, image: css.backgroundImage, disabled: element.matches(':disabled'), opacity: css.opacity, cursor: css.cursor, background: css.backgroundColor, color: css.color }
  }))
  assert(values.length >= min, `${label}: expected at least ${min} controls, got ${values.length}`)
  for (const value of values) {
    assert.equal(value.height, 32, `${label} height ${JSON.stringify(value)}`)
    assert.equal(value.appearance, 'none', `${label} appearance`)
    assert.equal(value.font, '12px', `${label} font ${JSON.stringify(value)}`)
    assert.equal(value.top, '0px', `${label} padding top`)
    assert.equal(value.bottom, '0px', `${label} padding bottom`)
    assert.equal(value.left, '9px', `${label} padding left`)
    assert.equal(value.right, '30px', `${label} padding right`)
    assert.equal(value.radius, '6px', `${label} border radius`)
    assert.match(value.image, /data:image\/svg\+xml/, `${label} SVG arrow`)
    if (value.disabled) { assert.equal(value.opacity, '0.6'); assert.equal(value.cursor, 'not-allowed') }
  }
  const editorControls = page.locator('dialog[open] select:visible:enabled, .export-dialog select:visible:enabled, [data-testid="image-crop-panel"] select:visible:enabled, [data-testid="image-annotations-panel"] select:visible:enabled')
  const focusable = await editorControls.count() ? editorControls.first() : page.locator('select:visible:enabled').first()
  if (await focusable.count()) {
    await focusable.focus()
    const outline = await focusable.evaluate(element => { const s = getComputedStyle(element); return [s.outlineWidth, s.outlineStyle] })
    assert.deepEqual(outline, ['2px', 'solid'], `${label} focus indicator`)
  }
  checks.push({ label, count: values.length, colors: [...new Set(values.map(v => `${v.color}/${v.background}`))] })
}
async function mount(page, base, component, props, theme = 'light') {
  await page.goto(`${base}/__controls__`)
  await page.evaluate(async ({ component, props, theme }) => {
    await import('/src/style.css')
    const source = await (await fetch('/src/components/' + component + '.vue')).text()
    const vueImport = source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const { createApp, h } = await import(vueImport)
    const Component = (await import('/src/components/' + component + '.vue')).default
    if (component === 'ExportPanel') props.project = (await import('/src/core/project.ts')).createProject()
    createApp({ render: () => h('div', { class: 'app-shell', 'data-theme': theme }, [h(Component, props)]) }).mount('#app')
  }, { component, props, theme })
}
async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(10000)
    mkdirSync('test-results/browser', { recursive: true })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__controls__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>' }))
    for (const theme of ['light', 'dark']) {
      await page.goto(base)
      await page.evaluate(theme => { localStorage.clear(); localStorage.setItem('open-media:theme', theme) }, theme)
      await page.reload()
      await page.getByTestId('create-record').waitFor()
      const order = ['record', 'gif', 'edit', 'generate', 'video', 'image']
      assert.deepEqual(await page.locator('[data-testid^="nav-"]').evaluateAll(nodes => nodes.map(n => n.dataset.testid.replace('nav-', ''))), order)
      assert.deepEqual(await page.locator('.workspace-cards [data-testid^="create-"]').evaluateAll(nodes => nodes.map(n => n.dataset.testid.replace('create-', ''))), order)
      for (const workspace of ['record', 'gif', 'video', 'image']) {
        await page.getByTestId(`nav-${workspace}`).click()
        await inspect(page, `${theme} ${workspace}`)
      }
      const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
        const context = canvas.getContext('2d'); context.fillStyle = '#f14354'; context.fillRect(0, 0, 160, 90)
        return canvas.toDataURL('image/png').split(',')[1]
      })
      await page.getByTestId('media-input').setInputFiles({ name: '样式检查.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') })
      await page.getByTestId('image-crop-open').click()
      const cropPanel = page.getByRole('region', { name: '框选裁剪', exact: true })
      await expect(cropPanel).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      assert.equal(await cropPanel.evaluate(element => !!element.closest('.convert-preview .preview-stage')), true, '裁剪控件应位于当前图片预览内')
      await inspect(page, `${theme} image crop inline editor`, 4)
      await page.setViewportSize({ width: 420, height: 900 })
      await inspect(page, `${theme} image crop inline editor width 420`, 2)
      await expect(cropPanel).toBeVisible()
      await cropPanel.getByRole('button', { name: '取消', exact: true }).click()
      await expect(cropPanel).toHaveCount(0)
      await expect(page.locator('.source-cropped')).toHaveCount(0)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.getByTestId('nav-edit').click()
      await page.locator('.asset-card').first().dblclick()
      await inspect(page, `${theme} editor image`, 2)
      await page.getByTitle('添加字幕', { exact: true }).click()
      await inspect(page, `${theme} editor text`, 4)
      await page.mouse.move(0, 0)
      const themeColors = await page.locator('.app-shell').evaluate(element => {
        const css = getComputedStyle(element)
        const toRgb = variable => { const span = document.createElement('span'); span.style.color = css.getPropertyValue(variable); element.append(span); const result = getComputedStyle(span).color; span.remove(); return result }
        return { text: toRgb('--ui-text'), accent: toRgb('--ui-accent') }
      })
      await expect(page.locator('.app-shell')).toHaveCSS('color', themeColors.text)
      await expect(page.getByTestId('save-project')).toHaveCSS('color', themeColors.text)
      await expect(page.locator('.editor-tools').getByRole('button', { name: '文字转语音', exact: true })).toHaveCSS('color', themeColors.text)
      await expect(page.locator('.editor-tools').getByRole('button', { name: '导入素材', exact: true })).toHaveCSS('color', themeColors.accent)
      await expect(page.locator('.track-subtitle-warning')).toHaveCSS('color', theme === 'dark' ? 'rgb(255, 208, 128)' : 'rgb(163, 91, 8)')

      await page.getByRole('button', { name: '项目设置', exact: true }).click()
      await inspect(page, `${theme} project dialog`, 6)
      await page.getByRole('button', { name: '关闭项目设置', exact: true }).click()
      await page.getByTestId('export-project').click()
      await inspect(page, `${theme} export dialog`, 6)
      await page.screenshot({ path: `test-results/browser/workspace-controls-${theme}.png` })
      for (const width of [800, 420]) {
        await page.setViewportSize({ width, height: 900 })
        await inspect(page, `${theme} export dialog width ${width}`, 2)
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await mount(page, base, 'ConvertWorkspace', { assets: [], mode: 'video', native: true }, theme)
      await inspect(page, `${theme} native video settings`, 6)
      await mount(page, base, 'ExportPanel', { open: true, native: true }, theme)
      await inspect(page, `${theme} native export settings`, 3)
      await mount(page, base, 'CaptureSelectionOverlay', { embedded: true, context: { requestId: 'style-check', displayId: 'screen:1', display: { id: 'screen:1', name: '屏幕', logicalWidth: 1280, logicalHeight: 800, pixelWidth: 1280, pixelHeight: 800 }, targets: [{ id: 'screen:1', name: '屏幕', kind: 'screen', rect: { x: 0, y: 0, width: 1280, height: 800 }, sourceWidth: 1280, sourceHeight: 800 }], preferences: { mode: 'region' } } }, theme)
      await inspect(page, `${theme} capture overlay`, 1)
    }
    const narration = await page.evaluate(async () => {
      const { createProject, createClip, validateProject } = await import('/src/core/project.ts')
      const project = createProject('配音来源标签')
      const samples = 40000, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer)
      const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i) }
      ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVEfmt '); view.setUint32(16, 16, true)
      view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples * 2, true)
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
      const asset = { id: 'narration-fixture', name: '配音.wav', kind: 'audio', url: `data:audio/wav;base64,${btoa(binary)}`, duration: 5, width: 0, height: 0, mime: 'audio/wav', size: bytes.length }
      project.assets.push(asset)
      const track = project.tracks.find(track => track.kind === 'audio')
      for (const [index, voiceId] of ['matcha_zh_en_female', 'zipvoice_zh_female', 'zipvoice_zh_male', 'f5_zh_female', 'f5_zh_male', 'qwen3_serena', 'qwen3_uncle_fu', 'unknown-legacy-model', undefined].entries()) {
        track.clips.push(createClip(asset, project, { name: `片段 ${index + 1}`, start: index * 5, generatedAt: '2026-10-18T10:20:30.000Z', speech: voiceId ? { text: '字幕内容', voiceId, rate: 1 } : undefined }))
      }
      return validateProject(JSON.parse(JSON.stringify(project)))
    })
    await mount(page, base, 'VideoEditor', { project: narration }, 'dark')
    await expect(page.getByTestId('clip-speech-model')).toHaveText(['Matcha 中英', 'ZipVoice Distill FP32', 'ZipVoice Distill FP32', 'F5-TTS v1 Base FP32', 'F5-TTS v1 Base FP32', 'Qwen3-TTS 1.7B BF16', 'Qwen3-TTS 1.7B BF16', '未知模型'])
    await expect(page.getByTestId('clip-generated-time')).toHaveCount(9)
    await expect(page.locator('.timeline-clip.audio').last().getByTestId('clip-speech-model')).toHaveCount(0)
    await expect(page.getByTestId('clip-speech-model').last()).toHaveAttribute('title', '配音模型：未知模型 · unknown-legacy-model')
    await expect(page.locator('.timeline-clip.audio').first()).toHaveAttribute('title', /最近生成：.*\n配音模型：Matcha 中英 · matcha_zh_en_female/)
    const metadata = await page.locator('.timeline-clip.audio').first().evaluate(clip => {
      const clipRect = clip.getBoundingClientRect(), row = clip.querySelector('.clip-metadata').getBoundingClientRect()
      return { right: clipRect.right - row.right, bottom: clipRect.bottom - row.bottom }
    })
    assert(metadata.right >= 0 && metadata.right < 15 && metadata.bottom >= 0 && metadata.bottom < 10, '模型来源与生成时间在片段右下角')
    await page.screenshot({ path: 'test-results/browser/editor-narration-models.png' })
    for (const duration of [0.5, 1 / 30]) {
      const narrowProject = structuredClone(narration)
      const firstClip = narrowProject.tracks.find(track => track.kind === 'audio').clips[0]
      firstClip.trimOut = duration
      firstClip.speech.voiceId = 'qwen3_uncle_fu'
      await mount(page, base, 'VideoEditor', { project: narrowProject }, 'dark')
      const narrowClip = page.locator('.timeline-clip.audio').first()
      await expect(narrowClip.getByTestId('clip-speech-model')).toHaveText('Qwen3-TTS 1.7B BF16')
      await expect(narrowClip.getByTestId('clip-generated-time')).toHaveAttribute('datetime', '2026-10-18T10:20:30.000Z')
      const dimensions = await narrowClip.evaluate(clip => {
        const bounds = clip.getBoundingClientRect()
        return [...clip.querySelectorAll('.clip-metadata, .clip-speech-model, .clip-generated-time')].map(element => {
          const rect = element.getBoundingClientRect(), css = getComputedStyle(element)
          return { name: element.className, contained: rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom, width: rect.width, clipWidth: bounds.width, overflow: css.overflow, textOverflow: css.textOverflow }
        })
      })
      for (const dimensionsItem of dimensions) {
        assert(dimensionsItem.contained, `${duration}s 配音的模型名、时间和容器应实际收缩到片段内：${JSON.stringify(dimensionsItem)}`)
        assert.equal(dimensionsItem.overflow, 'hidden')
        if (dimensionsItem.name !== 'clip-metadata') assert.equal(dimensionsItem.textOverflow, 'ellipsis')
      }
    }

    console.log('PASS 深浅主题顶部按钮颜色不受字幕警告污染；配音来源按持久化音色显示模型，普通音频不误标，生成时间保留')
    assert.deepEqual(errors, [])
    console.log(`PASS 首页与侧栏顺序一致；${checks.length} 组实际工作区、弹窗与采集覆盖页样式检查，共 ${checks.reduce((sum, row) => sum + row.count, 0)} 个控件采样，覆盖明暗主题、窄屏、禁用和键盘焦点`)
  } finally { await browser?.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
