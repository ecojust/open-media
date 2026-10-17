const assert = require('node:assert/strict')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { chromium, expect } = require('@playwright/test')
const { unzipSync, strFromU8 } = require('fflate')

const artifacts = process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'watermark-catalog') : '/tmp/open-media-watermark-catalog'
const categories = ['互动贴纸', '装饰动效', '提示标注', '字幕标签', '可编辑文字']
const dialog = page => page.getByRole('dialog', { name: '添加水印', exact: true })
const cards = page => page.locator('[data-watermark-id]')

async function projectState(page) {
  return page.evaluate(async () => {
    const { loadProject } = await import('/src/core/storage.ts')
    const loaded = await loadProject(localStorage.getItem('open-media:last-project'))
    try { return loaded.project } finally { loaded.revoke() }
  })
}
async function textClip(page, id) {
  return (await projectState(page)).tracks.flatMap(track => track.clips).find(clip => clip.id === id)
}
async function seek(page, seconds) {
  await page.locator('.timeline-scroll').evaluate(element => { element.scrollLeft = 0 })
  await page.locator('.timeline-ruler').click({ position: { x: seconds * 44, y: 8 } })
}
async function installProject(page, url) {
  await page.addInitScript(() => {
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('text-watermarks.omedia', { create: true })
    window.showOpenFilePicker = async () => [(await (await navigator.storage.getDirectory()).getFileHandle('text-watermarks.omedia'))]
  })
  await page.goto(url)
  await expect(page.getByTestId('home-workspace')).toBeVisible()
  await page.evaluate(async () => {
    const { createProject, createTextClip } = await import('/src/core/project.ts')
    const { saveProject } = await import('/src/core/storage.ts')
    const project = createProject('可编辑文字水印验收', { width: 640, height: 360, fps: 20, background: '#102030' })
    project.tracks[0].clips.push(createTextClip(project, { id: 'original-subtitle', text: '原有字幕', trimOut: 10, x: 8, y: 8, width: 140, height: 24, fontSize: 15 }))
    await saveProject(project, new Map())
    localStorage.setItem('open-media:last-project', project.id)
    localStorage.setItem('open-media:autosave', 'true')
  })
  await page.reload()
  await expect(page.getByTestId('home-workspace')).toBeVisible()
  await page.getByTestId('nav-edit').click()
  await expect(page.locator('.timeline-clip[data-clip-id="original-subtitle"]')).toBeVisible()
}

async function allPageIds(page, expectedCount) {
  const result = []
  for (let pageNumber = 1; ; pageNumber++) {
    const ids = await cards(page).evaluateAll(elements => elements.map(element => element.dataset.watermarkId))
    assert(ids.length > 0 && ids.length <= 24)
    assert.equal(ids.length, Math.min(24, expectedCount - result.length), '每一页只显示剩余的实际素材，不能丢项或补重复占位')
    const posters = await cards(page).locator('img').evaluateAll(async images => Promise.all(images.map(async image => {
      image.loading = 'eager'; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight, src: image.getAttribute('src') }
    })))
    assert.equal(posters.length, ids.length)
    assert(posters.every(image => image.width > 0 && image.height > 0), '所有分页缩略图都必须可实际解码，不允许空图占位')
    result.push(...ids)
    if (expectedCount > 24) await expect(page.getByTestId('watermark-pagination')).toContainText(String(pageNumber))
    const next = page.getByTestId('watermark-next-page')
    if (result.length === expectedCount) { if (expectedCount > 24) await expect(next).toBeDisabled(); break }
    await next.click()
  }
  assert.equal(result.length, expectedCount)
  assert.equal(new Set(result).size, expectedCount, '跨页不能重复素材')
  return result
}

async function catalogChecks(page) {
  const catalog = await page.evaluate(async () => (await import('/src/core/watermark-library.ts')).WATERMARK_MATERIALS)
  assert.equal(catalog.length, 500)
  assert.equal(new Set(catalog.map(item => item.id)).size, 500)
  const legacy = ['thumb-pulse', 'star-save', 'follow-pop', 'share-plane', 'heart-wave', 'celebrate', 'sparkle-trail', 'ripple-rings', 'corner-frame', 'loading-dots', 'rec-label', 'notice-bubble', 'cursor-click', 'point-arrow', 'focus-circle', 'chapter-card', 'note-strip', 'thanks-card']
  for (const id of legacy) assert(catalog.some(item => item.id === id && item.kind === 'video'), `旧素材 ${id} 必须保留`)
  await page.getByTestId('watermark-open').click()
  await expect(page.locator('[data-watermark-category="全部"]')).toContainText('500')
  const allIds = await allPageIds(page, 500)
  assert.deepEqual(allIds, catalog.map(item => item.id))
  for (const category of categories) {
    const expected = catalog.filter(item => item.category === category)
    assert.equal(expected.length, 100)
    const button = page.locator(`[data-watermark-category="${category}"]`)
    await expect(button).toContainText('100')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('watermark-previous-page')).toBeDisabled()
    const ids = await allPageIds(page, 100)
    assert.deepEqual(ids, expected.map(item => item.id))
    await expect(page.locator(`[data-watermark-add="${expected.at(-1).id}"]`)).toBeVisible()
    await page.getByTestId('watermark-previous-page').click()
    await expect(cards(page)).toHaveCount(24)
  }
  await page.locator('[data-watermark-category="全部"]').click()
  const text = catalog.find(item => item.kind === 'text' && item.textTemplate?.text && item.textTemplate.text.length >= 3)
  assert(text)
  for (const keyword of [text.textTemplate.text.split('\n')[0], '旅行', '早餐', '游戏']) {
    await page.getByTestId('watermark-search').fill(keyword)
    const expected = catalog.filter(item => [item.name, item.category, ...item.tags, item.textTemplate?.text || ''].join(' ').toLocaleLowerCase().includes(keyword.toLocaleLowerCase()))
    assert(expected.length > 0, `目录应提供可搜索的中文题材 ${keyword}`)
    const ids = await allPageIds(page, expected.length)
    assert.deepEqual(ids, expected.map(item => item.id), `搜索 ${keyword} 应包含全部匹配项`)
    await expect(page.locator('.library-summary')).toContainText(String(expected.length))
  }
  await page.getByTestId('watermark-search').fill('不存在的题材内容xyz')
  await expect(cards(page)).toHaveCount(0)
  await expect(dialog(page).getByText('没有找到匹配的素材')).toBeVisible()
  await dialog(page).getByRole('button', { name: '查看全部素材' }).click()
  await expect(cards(page)).toHaveCount(24)
  await page.locator('[data-watermark-category="可编辑文字"]').click()
  await cards(page).locator('img').evaluateAll(async images => Promise.all(images.map(async image => { image.loading = 'eager'; await image.decode() })))
  await page.screenshot({ path: path.join(artifacts, 'editable-text-library.png') })
  await expandedAnimationPreview(page, catalog)
  console.log('PASS 全部 500 项与 5 类各 100 项逐页可达且不重复；旧 18 项保留，中文文字与题材搜索数量及分页完整')
  return { text, catalog }
}

async function expandedAnimationPreview(page, catalog) {
  if (!(await dialog(page).count())) await page.getByTestId('watermark-open').click()
  const animation = catalog.findLast(item => item.kind === 'video' && item.id === 'motion-farewell')
  assert(animation, '扩展目录应包含新的真实动画')
  assert.equal(animation.spillSuppression, true, '新增绿幕动效应默认启用去溢色')
  await page.locator('[data-watermark-category="全部"]').click()
  await page.getByTestId('watermark-search').fill(animation.name)
  const card = page.locator(`[data-watermark-id="${animation.id}"]`)
  await card.locator('.material-preview').hover()
  await expect(card.locator('canvas.ready')).toBeVisible()
  const frame = () => card.locator('canvas').evaluate(canvas => {
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let hash = 0, transparent = 0, opaque = 0, unexpectedGreen = 0
    for (let i = 0; i < bytes.length; i += 4) { hash = (hash * 31 + bytes[i] * 3 + bytes[i + 1] * 5 + bytes[i + 2] * 7 + bytes[i + 3]) >>> 0; if (bytes[i + 3] < 5) transparent++; if (bytes[i + 3] > 250) opaque++; if (bytes[i + 3] > 50 && bytes[i + 1] > bytes[i] + 25 && bytes[i + 1] > bytes[i + 2] + 25) unexpectedGreen++ }
    return { hash, transparent, opaque, unexpectedGreen }
  })
  await expect.poll(async () => (await frame()).opaque).toBeGreaterThan(100)
  const firstFrame = await frame()
  assert(firstFrame.transparent > 500 && firstFrame.opaque > 100, '新动效预览应有真实图案且去除绿幕')
  await expect.poll(async () => (await frame()).hash).not.toBe(firstFrame.hash)
  await page.screenshot({ path: path.join(artifacts, 'expanded-animation-preview.png') })
  assert(firstFrame.unexpectedGreen <= 16, `暖白橙色动效预览不能出现绿色染边：${firstFrame.unexpectedGreen} 个绿偏像素`)
  await dialog(page).getByRole('button', { name: '关闭添加水印' }).click()
  console.log('PASS 新动效真实预览帧持续变化，透明底和柔光边缘没有绿色染边')
}

async function canvasSnapshot(page) {
  return page.getByTestId('video-preview').evaluate(canvas => {
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let hash = 0, magenta = 0, red = 0
    for (let i = 0; i < bytes.length; i += 4) {
      hash = (hash * 31 + bytes[i] * 3 + bytes[i + 1] * 5 + bytes[i + 2] * 7 + bytes[i + 3]) >>> 0
      if (bytes[i] > 190 && bytes[i + 1] < 90 && bytes[i + 2] > 190) magenta++
      if (bytes[i] > 160 && bytes[i + 1] < 100 && bytes[i + 2] < 100) red++
    }
    return { hash, magenta, red }
  })
}
async function setField(page, locator, value) {
  await locator.fill(value)
  await locator.press('Tab')
}
async function editableChecks(page, material) {
  const original = await projectState(page)
  await seek(page, 3.25)
  await page.getByTestId('watermark-open').click()
  await page.locator('[data-watermark-category="可编辑文字"]').click()
  await page.getByTestId('watermark-search').fill(material.name)
  await page.locator(`[data-watermark-add="${material.id}"]`).click()
  await expect(dialog(page)).not.toBeVisible()
  await expect(page.getByTestId('clip-text-content')).toBeVisible()
  await expect(page.getByTestId('clip-text-content')).toHaveValue(material.textTemplate.text)
  await expect(page.getByTestId('clip-text-content')).toBeFocused()
  await expect.poll(async () => (await projectState(page)).tracks.some(track => track.name === '文字水印轨道')).toBe(true)
  let project = await projectState(page)
  const track = project.tracks.find(item => item.name === '文字水印轨道'), added = track.clips[0], id = added.id
  assert.equal(track.kind, 'text'); assert.equal(added.start, 3.25)
  assert.equal(added.text, material.textTemplate.text)
  assert.equal(added.assetId, undefined)
  assert.deepEqual(project.assets, original.assets, '文字水印不能导入缩略图或烘焙图片素材')
  for (const before of original.tracks) assert.deepEqual(project.tracks.find(item => item.id === before.id), before)
  await expect(page.getByTestId('preview-selected-clip')).toHaveAttribute('data-preview-clip-id', id)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.locator(`.timeline-clip[data-clip-id="${id}"]`)).toHaveCount(0)
  await expect.poll(async () => (await projectState(page)).tracks.length).toBe(original.tracks.length)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(page.locator(`.timeline-clip[data-clip-id="${id}"]`)).toBeVisible()
  await page.locator(`.timeline-clip[data-clip-id="${id}"]`).click()
  await seek(page, 3.5)
  const beforeText = await canvasSnapshot(page)
  await setField(page, page.getByTestId('clip-text-content'), '我们的旅行记录\n下一站见')
  await expect.poll(async () => (await textClip(page, id))?.text).toBe('我们的旅行记录\n下一站见')
  await expect.poll(async () => (await canvasSnapshot(page)).hash).not.toBe(beforeText.hash)
  await setField(page, page.getByLabel('颜色', { exact: true }), '#ff00ff')
  await expect.poll(async () => (await textClip(page, id))?.color).toBe('#ff00ff')
  await expect.poll(async () => (await canvasSnapshot(page)).magenta).toBeGreaterThan(30)
  const small = await canvasSnapshot(page)
  await setField(page, page.getByLabel('字号', { exact: true }), '48')
  await expect.poll(async () => (await textClip(page, id))?.fontSize).toBe(48)
  await expect.poll(async () => (await canvasSnapshot(page)).hash).not.toBe(small.hash)
  await setField(page, page.getByLabel('文字底色', { exact: true }), '#cc2233')
  await expect.poll(async () => (await canvasSnapshot(page)).red).toBeGreaterThan(100)
  const old = await textClip(page, id)
  const rect = await page.getByTestId('video-preview').boundingBox(), scale = rect.width / 640
  const x = rect.x + (old.x + old.width / 2) * scale, y = rect.y + (old.y + old.height / 2) * scale
  await page.mouse.move(x, y); await page.mouse.down(); await page.keyboard.down('Alt')
  await page.mouse.move(x - 35 * scale, y - 20 * scale, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Alt')
  await expect.poll(async () => Math.round((await textClip(page, id))?.x)).toBe(Math.round(old.x - 35))
  await expect.poll(async () => Math.round((await textClip(page, id))?.y)).toBe(Math.round(old.y - 20))
  await page.screenshot({ path: path.join(artifacts, 'edited-text-timeline.png') })
  project = await projectState(page)
  const expectedText = project.tracks.flatMap(item => item.clips).find(item => item.id === id)
  await page.getByTestId('save-project').click()
  await expect(page.locator('.status-main')).toContainText('项目已保存')
  const archive = Buffer.from(await page.evaluate(async () => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle('text-watermarks.omedia')).getFile()
    return [...new Uint8Array(await file.arrayBuffer())]
  }))
  writeFileSync(path.join(artifacts, 'editable-watermarks.omedia'), archive)
  const entries = unzipSync(archive), manifest = JSON.parse(strFromU8(entries['project.json']))
  assert.deepEqual(manifest.project.assets, [])
  assert(!Object.keys(entries).some(name => name.startsWith('media/')), '可编辑文字项目不应烘焙任何媒体文件')
  assert.deepEqual(manifest.project.tracks.flatMap(item => item.clips).find(item => item.id === id), expectedText)
  await page.reload(); await expect(page.getByTestId('home-workspace')).toBeVisible(); await page.getByTestId('nav-edit').click()
  await expect(page.locator(`.timeline-clip[data-clip-id="${id}"]`)).toBeVisible()
  await page.keyboard.press('Control+o')
  await expect(page.locator('.status-main')).toContainText('已打开')
  await expect.poll(async () => (await textClip(page, id))?.text).toBe(expectedText.text)
  assert.deepEqual(await textClip(page, id), expectedText)
  await page.locator(`.timeline-clip[data-clip-id="${id}"]`).click(); await seek(page, 3.5)
  await expect(page.getByTestId('clip-text-content')).toHaveValue(expectedText.text)
  await expect.poll(async () => (await canvasSnapshot(page)).magenta).toBeGreaterThan(30)
  console.log('PASS 文字水印从当前 3.25 秒插入原生文字轨道；撤销/重做、文案/颜色/字号编辑真实更新预览，拖动位置和保存重开完整保留且无烘焙媒体')
}

async function textAppearanceChecks(page, catalog) {
  const texts = catalog.filter(item => item.kind === 'text')
  const samples = [...new Map([
    texts.find(item => item.textTemplate.fontFamily === 'serif' && item.textTemplate.text.includes('\n')),
    texts.find(item => item.textTemplate.fontFamily === 'monospace'),
    texts.find(item => item.textTemplate.fontFamily === 'sans-serif' && item.textTemplate.background === '#171b24'),
    texts.find(item => item.textTemplate.fontFamily === 'serif' && item.textTemplate.textAlign === 'right'),
  ].map(item => { assert(item, '目录应有衬线、等宽、多行、深底与右对齐文字样式'); return [item.id, item] })).values()]
  for (const material of samples) {
    await seek(page, 0.5)
    await page.getByTestId('watermark-open').click()
    await page.locator('[data-watermark-category="可编辑文字"]').click()
    await page.getByTestId('watermark-search').fill(material.name)
    await page.locator(`[data-watermark-add="${material.id}"]`).click()
    await expect(dialog(page)).not.toBeVisible()
    await expect(page.getByTestId('clip-text-content')).toHaveValue(material.textTemplate.text)
    const id = await page.getByTestId('preview-selected-clip').getAttribute('data-preview-clip-id')
    await expect.poll(async () => (await textClip(page, id))?.text).toBe(material.textTemplate.text)
    const inserted = await textClip(page, id), template = material.textTemplate
    for (const name of ['text', 'color', 'background', 'fontFamily', 'fontWeight', 'textAlign', 'fontSize']) assert.equal(inserted[name], template[name], `${material.id} 插入后应保留 ${name}`)
    const comparison = await page.getByTestId('video-preview').evaluate(async (preview, { template, inserted, poster }) => {
      const image = new Image(); image.src = poster; await image.decode()
      const read = (source, x, y, width, height) => {
        const canvas = document.createElement('canvas'); canvas.width = template.width; canvas.height = template.height
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height)
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        const rgb = value => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16))
        const foreground = rgb(template.color), background = rgb(template.background)
        let count = 0, minX = canvas.width, maxX = -1, minY = canvas.height, maxY = -1
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const index = (y * canvas.width + x) * 4
          if (data[index + 3] < 240) continue
          if (foreground.every((value, channel) => Math.abs(data[index + channel] - value) < 45) && background.some((value, channel) => Math.abs(data[index + channel] - value) > 45)) {
            count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
          }
        }
        return { background: [...ctx.getImageData(4, 4, 1, 1).data], count, minX, maxX, minY, maxY }
      }
      const scale = preview.width / 640
      return {
        poster: read(image, (640 - template.width) / 2, (360 - template.height) / 2, template.width, template.height),
        actual: read(preview, inserted.x * scale, inserted.y * scale, inserted.width * scale, inserted.height * scale),
      }
    }, { template, inserted, poster: material.poster })
    const expectedBackground = [1, 3, 5].map(index => parseInt(template.background.slice(index, index + 2), 16))
    for (const image of [comparison.poster, comparison.actual]) {
      assert(image.background.slice(0, 3).every((value, index) => Math.abs(value - expectedBackground[index]) < 12), `${material.id} 缩略图和预览应使用模板背景色`)
      assert(image.count > 30, `${material.id} 文字必须以模板颜色实际显示`)
    }
    const { poster, actual } = comparison
    assert(actual.count / poster.count > 0.35 && actual.count / poster.count < 2.8, `${material.id} 预览文字面积应与缩略图同量级`)
    assert(Math.abs((actual.minY + actual.maxY) - (poster.minY + poster.maxY)) / 2 < template.fontSize, `${material.id} 多行文字竖向排布应与缩略图对应`)
    assert(Math.abs((actual.minX + actual.maxX) - (poster.minX + poster.maxX)) / 2 < template.fontSize * 1.4, `${material.id} 文字对齐与缩略图对应`)
    await page.screenshot({ path: path.join(artifacts, `${material.id}-inserted.png`) })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.locator(`.timeline-clip[data-clip-id="${id}"]`)).toHaveCount(0)
  }
  console.log('PASS 衬线、等宽、多行、深色底与右对齐文字从真实UI插入，原生属性、文字颜色、背景和排布与缩略图一致')
}

async function expandedAnimationExport(page, catalog) {
  const material = catalog.findLast(item => item.kind === 'video' && item.id.startsWith('motion-'))
  await seek(page, 0)
  await page.getByTestId('watermark-open').click()
  await page.getByTestId('watermark-search').fill(material.name)
  await page.locator(`[data-watermark-add="${material.id}"]`).click()
  await expect(dialog(page)).not.toBeVisible()
  const id = await page.getByTestId('preview-selected-clip').getAttribute('data-preview-clip-id')
  await expect.poll(async () => Boolean((await textClip(page, id))?.assetId)).toBe(true)
  const exported = await page.evaluate(async id => {
    const { loadProject } = await import('/src/core/storage.ts')
    const { exportTimelineWebM } = await import('/src/core/browser-export.ts')
    const loaded = await loadProject(localStorage.getItem('open-media:last-project'))
    try {
      const project = loaded.project, source = project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)
      const track = project.tracks.find(track => track.clips.some(clip => clip.id === id))
      project.tracks = [{ ...track, clips: [{ ...source, start: 0, trimIn: 0, trimOut: 1 }] }]
      const blob = await exportTimelineWebM(project, { width: 320, height: 180, fps: 20 })
      const url = URL.createObjectURL(blob), video = document.createElement('video')
      video.muted = true; video.src = url
      try {
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject })
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
        const ctx = canvas.getContext('2d', { willReadFrequently: true }), frames = []
        for (const time of [0.2, 0.75]) {
          await new Promise(resolve => { video.onseeked = resolve; video.currentTime = time })
          ctx.drawImage(video, 0, 0, 320, 180)
          frames.push([...ctx.getImageData(0, 0, 320, 180).data])
        }
        return { bytes: [...new Uint8Array(await blob.arrayBuffer())], frames, clip: source }
      } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url) }
    } finally { loaded.revoke() }
  }, id)
  assert(exported.bytes.length > 1000); assert.deepEqual(exported.bytes.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3])
  assert.equal(exported.clip.chromaKey.enabled, true)
  assert.equal(exported.clip.chromaKey.spillSuppression, true, '去溢色应保存到实际片段并用于导出')
  writeFileSync(path.join(artifacts, 'expanded-watermark-export.webm'), Buffer.from(exported.bytes))
  for (const frame of exported.frames) {
    let unexpectedGreen = 0
    for (let i = 0; i < frame.length; i += 4) if (frame[i + 1] > frame[i] + 25 && frame[i + 1] > frame[i + 2] + 25) unexpectedGreen++
    assert(unexpectedGreen <= 8, `暖白橙色动效实际导出不能残留绿色染边：${unexpectedGreen} 个绿偏像素`)
    const index = (Math.floor((exported.clip.y + 2) / 2) * 320 + Math.floor((exported.clip.x + 2) / 2)) * 4
    const color = frame.slice(index, index + 3)
    assert(color.every((value, channel) => Math.abs(value - [16, 32, 48][channel]) < 16), `新动效导出须透出背景，不能残留绿色：${color}`)
  }
  let different = 0
  for (let index = 0; index < exported.frames[0].length; index += 4) if (Math.abs(exported.frames[0][index] - exported.frames[1][index]) > 18) different++
  assert(different > 15, `新动画实际导出解码后画面应随时间改变：${different}`)
  console.log('PASS 新动效导入真实素材后导出 1 秒 WebM，再解码两帧验证动态变化及去绿底颜色')
}

async function main() {
  mkdirSync(artifacts, { recursive: true })
  const { createServer } = await import('vite')
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const csp = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false, headers: { 'Content-Security-Policy': csp } } })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }), page = await context.newPage(), errors = []
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message))
  try {
    await installProject(page, `http://127.0.0.1:${port}`)
    if (process.env.WATERMARK_CHECK === 'animation') {
      const catalog = await page.evaluate(async () => (await import('/src/core/watermark-library.ts')).WATERMARK_MATERIALS)
      await expandedAnimationPreview(page, catalog)
      await expandedAnimationExport(page, catalog)
    } else {
      const { text, catalog } = await catalogChecks(page)
      await editableChecks(page, text)
      await textAppearanceChecks(page, catalog)
      await expandedAnimationExport(page, catalog)
    }
    assert.deepEqual(errors, [])
  } catch (error) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {}); throw error }
  finally { await context.close(); await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
